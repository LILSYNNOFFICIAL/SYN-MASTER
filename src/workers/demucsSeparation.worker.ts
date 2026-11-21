/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web/webgpu';
import { fixOnnxFloat64 } from '../dsp/onnxFloat64Fix';
import {
  accumulateDemucsChunk,
  accumulateDemucsWeights,
  createDemucsChunkWindow,
  DEMUCS_OVERLAP_SAMPLES,
  DEMUCS_SEGMENT_SAMPLES,
  DEMUCS_STEM_ROWS,
  DEMUCS_STRIDE_SAMPLES,
  getDemucsChunkCount,
  normalizeDemucsOutput,
} from '../dsp/stemSeparationMath';

const MODEL_URL = 'https://huggingface.co/StemSplitio/htdemucs-onnx/resolve/d54ed9eb60e258ea82131c6ee14578628816456a/htdemucs_fp16weights.onnx';
const MODEL_SHA256 = 'd05c269d0178d2a72ad484b10b11dd370193fc923201c3b27a99f848745db70a';

type StartMessage = { type: 'start'; jobId: string; channels: [Float32Array, Float32Array] };
type CancelMessage = { type: 'cancel'; jobId: string };
type WorkerRequest = StartMessage | CancelMessage;
type WorkerResponse =
  | { type: 'progress'; jobId: string; stage: 'loading-model' | 'initializing' | 'separating'; progress: number; completedChunks?: number; totalChunks?: number; executionProvider?: string }
  | { type: 'result'; jobId: string; stems: Array<{ id: string; label: string; channels: [Float32Array, Float32Array] }> }
  | { type: 'cancelled'; jobId: string }
  | { type: 'error'; jobId: string; message: string };

const cancelledJobs = new Set<string>();
const modelFetchControllers = new Map<string, AbortController>();

function post(message: WorkerResponse, transfer: Transferable[] = []): void {
  self.postMessage(message, { transfer });
}

async function fixAndVerifyModel(raw: Uint8Array, jobId: string, cache: Cache | null): Promise<Uint8Array> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Model integrity verification requires HTTPS or localhost. Open SYN-MASTER in a secure browser context.');
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', raw.buffer as ArrayBuffer);
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== MODEL_SHA256) {
    try { await cache?.delete(MODEL_URL); } catch { /* corrupted cache cleanup is best-effort */ }
    throw new Error('The downloaded HT-Demucs model failed its SHA-256 integrity check.');
  }

  const fixed = fixOnnxFloat64(raw);
  const fixedNodes = fixed.stats.tensors + fixed.stats.casts + fixed.stats.types;
  if (fixedNodes === 0) {
    try { await cache?.delete(MODEL_URL); } catch { /* corrupted cache cleanup is best-effort */ }
    throw new Error('The downloaded HT-Demucs graph did not contain the expected float64 nodes. The pinned model may have changed.');
  }
  post({ type: 'progress', jobId, stage: 'loading-model', progress: 1 });
  return fixed.bytes;
}

async function downloadAndPrepareModel(jobId: string, signal: AbortSignal): Promise<Uint8Array> {
  let cache: Cache | null = null;
  let cacheWrite: Promise<void> | null = null;
  let response: Response;
  try {
    cache = await caches.open('syn-master-models-v1');
    const cached = await cache.match(MODEL_URL);
    if (cached) response = cached;
    else {
      response = await fetch(MODEL_URL, { signal });
      if (response.ok) cacheWrite = cache.put(MODEL_URL, response.clone()).catch(() => undefined);
    }
  } catch {
    cache = null;
    response = await fetch(MODEL_URL, { cache: 'force-cache', signal });
  }
  if (!response.ok) throw new Error(`Unable to download the HT-Demucs model (HTTP ${response.status}).`);
  if (!response.body) {
    const raw = new Uint8Array(await response.arrayBuffer());
    await cacheWrite;
    return fixAndVerifyModel(raw, jobId, cache);
  }

  const contentLength = Number(response.headers.get('content-length')) || 0;
  let buffer = contentLength > 0 ? new Uint8Array(contentLength) : new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let received = 0;
  let lastProgressPercent = -1;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.length) continue;
    if (contentLength > 0) {
      if (received + value.length > buffer.length) {
        const expanded = new Uint8Array(Math.max(received + value.length, buffer.length * 2));
        expanded.set(buffer.subarray(0, received));
        buffer = expanded;
      }
      buffer.set(value, received);
    } else {
      chunks.push(value);
    }
    received += value.length;
    const progress = contentLength > 0 ? Math.min(0.99, received / contentLength) : 0;
    const progressPercent = Math.floor(progress * 100);
    if (progressPercent !== lastProgressPercent) {
      lastProgressPercent = progressPercent;
      post({ type: 'progress', jobId, stage: 'loading-model', progress });
    }
  }

  if (received === 0) throw new Error('The model download completed without any data.');
  let raw: Uint8Array;
  if (contentLength > 0) raw = buffer.subarray(0, received).slice();
  else {
    raw = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      raw.set(chunk, offset);
      offset += chunk.length;
    }
  }

  if (contentLength > 0 && received !== contentLength) {
    throw new Error(`The model download was incomplete (${received} of ${contentLength} bytes).`);
  }
  if (cancelledJobs.has(jobId)) throw new DOMException('Separation cancelled.', 'AbortError');
  await cacheWrite;
  return fixAndVerifyModel(raw, jobId, cache);
}

async function createSession(modelBytes: Uint8Array, preferWebGpu: boolean): Promise<{ session: ort.InferenceSession; provider: string }> {
  ort.env.wasm.numThreads = self.crossOriginIsolated
    ? Math.max(1, Math.min(4, self.navigator.hardwareConcurrency || 4))
    : 1;
  const sessionOptions = { graphOptimizationLevel: 'disabled' as const };

  if (preferWebGpu && 'gpu' in self.navigator) {
    try {
      const session = await ort.InferenceSession.create(modelBytes, {
        ...sessionOptions,
        executionProviders: ['webgpu', 'wasm'],
      });
      return { session, provider: 'WebGPU + WASM fallback' };
    } catch {
      // Some WebGPU implementations cannot compile every graph node; retry CPU/WASM only.
    }
  }

  const session = await ort.InferenceSession.create(modelBytes, {
    ...sessionOptions,
    executionProviders: ['wasm'],
  });
  return { session, provider: 'WASM' };
}

async function runChunks(
  session: ort.InferenceSession,
  channels: [Float32Array, Float32Array],
  jobId: string,
  provider: string,
): Promise<Array<{ id: string; label: string; channels: [Float32Array, Float32Array] }>> {
  const totalSamples = channels[0].length;
  const chunkCount = getDemucsChunkCount(totalSamples);
  const outputs = DEMUCS_STEM_ROWS.map(() => [
    new Float32Array(totalSamples),
    new Float32Array(totalSamples),
  ] as [Float32Array, Float32Array]);
  const weights = new Float32Array(totalSamples);
  const input = new Float32Array(2 * DEMUCS_SEGMENT_SAMPLES);
  const windowCache = new Map<string, Float32Array>();
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];

  if (session.inputNames.length !== 1 || session.outputNames.length !== 1) {
    throw new Error('The selected Demucs model has an unexpected input/output signature.');
  }

  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    if (cancelledJobs.has(jobId)) throw new DOMException('Separation cancelled.', 'AbortError');
    const start = chunkIndex * DEMUCS_STRIDE_SAMPLES;
    const end = Math.min(start + DEMUCS_SEGMENT_SAMPLES, totalSamples);
    const validSamples = end - start;
    input.fill(0);
    input.set(channels[0].subarray(start, end), 0);
    input.set(channels[1].subarray(start, end), DEMUCS_SEGMENT_SAMPLES);

    const result = await session.run({
      [inputName]: new ort.Tensor('float32', input, [1, 2, DEMUCS_SEGMENT_SAMPLES]),
    });
    if (cancelledJobs.has(jobId)) throw new DOMException('Separation cancelled.', 'AbortError');

    const tensor = result[outputName];
    if (!tensor || tensor.dims.length !== 4 ||
        tensor.dims[0] !== 1 || tensor.dims[1] !== DEMUCS_STEM_ROWS.length ||
        tensor.dims[2] !== 2 || tensor.dims[3] !== DEMUCS_SEGMENT_SAMPLES ||
        !(tensor.data instanceof Float32Array)) {
      throw new Error('The Demucs model returned an unsupported tensor layout. Expected [1, 4, 2, 343980].');
    }

    const windowKey = `${chunkIndex > 0}:${chunkIndex < chunkCount - 1}`;
    let window = windowCache.get(windowKey);
    if (!window) {
      window = createDemucsChunkWindow(
        DEMUCS_SEGMENT_SAMPLES,
        DEMUCS_OVERLAP_SAMPLES,
        chunkIndex > 0,
        chunkIndex < chunkCount - 1,
      );
      windowCache.set(windowKey, window);
    }

    const data = tensor.data;
    const rowSize = 2 * DEMUCS_SEGMENT_SAMPLES;
    for (let stemIndex = 0; stemIndex < DEMUCS_STEM_ROWS.length; stemIndex += 1) {
      const rowOffset = stemIndex * rowSize;
      for (let channelIndex = 0; channelIndex < 2; channelIndex += 1) {
        const channelOffset = rowOffset + channelIndex * DEMUCS_SEGMENT_SAMPLES;
        const channelData = data.subarray(channelOffset, channelOffset + DEMUCS_SEGMENT_SAMPLES);
        accumulateDemucsChunk(outputs[stemIndex][channelIndex], channelData, start, validSamples, window);
      }
    }
    accumulateDemucsWeights(weights, start, validSamples, window);

    post({
      type: 'progress',
      jobId,
      stage: 'separating',
      progress: (chunkIndex + 1) / chunkCount,
      completedChunks: chunkIndex + 1,
      totalChunks: chunkCount,
      executionProvider: provider,
    });
  }

  return outputs.map((stem, index) => {
    normalizeDemucsOutput(stem[0], weights);
    normalizeDemucsOutput(stem[1], weights);
    for (const channel of stem) {
      for (let sample = 0; sample < channel.length; sample += 1) {
        if (!Number.isFinite(channel[sample])) {
          throw new Error(`The model produced a non-finite sample in the ${DEMUCS_STEM_ROWS[index].label} stem.`);
        }
      }
    }
    return { id: DEMUCS_STEM_ROWS[index].id, label: DEMUCS_STEM_ROWS[index].label, channels: stem };
  });
}

async function separate(job: StartMessage): Promise<void> {
  const { jobId, channels } = job;
  let session: ort.InferenceSession | null = null;
  const fetchController = new AbortController();
  modelFetchControllers.set(jobId, fetchController);
  try {
    if (channels[0].length < 1 || channels[0].length !== channels[1].length) {
      throw new Error('The stereo input buffers are empty or have different lengths.');
    }
    if (cancelledJobs.has(jobId)) throw new DOMException('Separation cancelled.', 'AbortError');

    post({ type: 'progress', jobId, stage: 'loading-model', progress: 0 });
    const modelBytes = await downloadAndPrepareModel(jobId, fetchController.signal);
    modelFetchControllers.delete(jobId);
    // Yield once so a cancel request sent from the final download-progress event
    // is observed before the comparatively expensive ONNX session initialization.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (cancelledJobs.has(jobId)) throw new DOMException('Separation cancelled.', 'AbortError');

    post({ type: 'progress', jobId, stage: 'initializing', progress: 0 });
    let created = await createSession(modelBytes, true);
    session = created.session;
    if (cancelledJobs.has(jobId)) throw new DOMException('Separation cancelled.', 'AbortError');

    let stems;
    try {
      stems = await runChunks(session, channels, jobId, created.provider);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
      if (created.provider === 'WASM') throw cause;
      await session.release();
      session = null;
      if (cancelledJobs.has(jobId)) throw new DOMException('Separation cancelled.', 'AbortError');
      post({ type: 'progress', jobId, stage: 'initializing', progress: 0 });
      created = await createSession(modelBytes, false);
      session = created.session;
      stems = await runChunks(session, channels, jobId, created.provider);
    }

    if (cancelledJobs.has(jobId)) throw new DOMException('Separation cancelled.', 'AbortError');
    const transfer = stems.flatMap((stem) => [stem.channels[0].buffer, stem.channels[1].buffer]);
    post({ type: 'result', jobId, stems }, transfer);
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') {
      post({ type: 'cancelled', jobId });
    } else {
      post({
        type: 'error',
        jobId,
        message: cause instanceof Error ? cause.message : 'The Demucs separation engine failed.',
      });
    }
  } finally {
    modelFetchControllers.delete(jobId);
    cancelledJobs.delete(jobId);
    if (session) {
      try { await session.release(); } catch { /* release is best-effort */ }
    }
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if (message.type === 'cancel') {
    cancelledJobs.add(message.jobId);
    modelFetchControllers.get(message.jobId)?.abort();
    return;
  }
  void separate(message);
};

export {};
