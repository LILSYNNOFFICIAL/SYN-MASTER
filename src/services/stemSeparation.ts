export interface SeparatedAudioStem {
  id: 'drums' | 'bass' | 'other' | 'vocals';
  label: string;
  channels: [Float32Array, Float32Array];
}

export interface StemSeparationProgress {
  stage: 'loading-model' | 'initializing' | 'separating' | 'resampling';
  progress: number;
  completedChunks?: number;
  totalChunks?: number;
  executionProvider?: string;
}

type StoredStemDescriptor = { id: SeparatedAudioStem['id']; label: string; length: number; leftFile: string; rightFile: string };

type WorkerResponse =
  | { type: 'progress'; jobId: string; stage: StemSeparationProgress['stage']; progress: number; completedChunks?: number; totalChunks?: number; executionProvider?: string }
  | { type: 'result'; jobId: string; directoryName: string; stems: StoredStemDescriptor[] }
  | { type: 'cancelled'; jobId: string }
  | { type: 'error'; jobId: string; message: string };

export interface StemSeparationResourceInput {
  durationSec: number;
  sampleRate: number;
  fileSizeBytes: number;
}

export function estimateStemSeparationOutputBytes(durationSec: number, sampleRate: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0 ||
    !Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 384000) {
    throw new RangeError('Stem separation requires a valid duration and sample rate.');
  }
  return Math.ceil(durationSec * Math.max(44_100, sampleRate) * 8 * Float32Array.BYTES_PER_ELEMENT);
}

/** Preflight browser resources before launching a stem-separation job. */
export async function assessStemSeparationResources(inputs: StemSeparationResourceInput[]): Promise<void> {
  if (inputs.length === 0) throw new RangeError('At least one track is required for stem separation.');
  for (const input of inputs) {
    if (!Number.isFinite(input.fileSizeBytes) || input.fileSizeBytes < 0 || input.fileSizeBytes > 512 * 1024 * 1024) {
      throw new Error('A source or reference file exceeds the 512 MB browser separation limit.');
    }
  }
  const estimatedBytes = inputs.reduce(
    (sum, input) => sum + estimateStemSeparationOutputBytes(input.durationSec, input.sampleRate),
    0,
  );
  const deviceMemoryGb = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
  const memoryBudgetBytes = Math.min(2_048, Math.max(768, deviceMemoryGb * 512)) * 1024 * 1024;
  if (estimatedBytes > memoryBudgetBytes) {
    throw new Error(
      `Source/reference stem separation needs about ${Math.ceil(estimatedBytes / (1024 * 1024))} MB, above this device's estimated ${Math.floor(memoryBudgetBytes / (1024 * 1024))} MB safe working budget.`,
    );
  }
  if (!navigator.storage?.getDirectory || !navigator.storage?.estimate) {
    throw new Error('This browser does not support the temporary disk storage required for safe stem separation.');
  }
  const storageEstimate = await navigator.storage.estimate();
  const requiredStorageBytes = Math.ceil(
    Math.max(...inputs.map((input) => estimateStemSeparationOutputBytes(input.durationSec, input.sampleRate))) * 1.15,
  );
  const availableStorageBytes = Math.max(0, (storageEstimate.quota ?? 0) - (storageEstimate.usage ?? 0));
  if (availableStorageBytes < requiredStorageBytes) {
    throw new Error(
      `Not enough browser temporary storage for source/reference stem separation. About ${Math.ceil(requiredStorageBytes / (1024 * 1024))} MB is required, but only ${Math.floor(availableStorageBytes / (1024 * 1024))} MB is available.`,
    );
  }
}

async function cleanupTemporaryStems(jobId: string): Promise<void> {
  try {
    const storage = await navigator.storage?.getDirectory?.();
    if (!storage) return;
    const directoryName = `syn-master-stems-${jobId.replace(/[^a-zA-Z0-9-]/g, '')}`;
    await storage.removeEntry(directoryName, { recursive: true }).catch(() => undefined);
  } catch {
    // Temporary cleanup is best-effort after worker failure or cancellation.
  }
}

async function loadTemporaryStems(directoryName: string, descriptors: StoredStemDescriptor[]): Promise<SeparatedAudioStem[]> {
  const storage = await navigator.storage?.getDirectory?.();
  if (!storage) throw new Error('OPFS temporary storage became unavailable before stem import.');
  const directory = await storage.getDirectoryHandle(directoryName);
  try {
    const stems: SeparatedAudioStem[] = [];
    for (const descriptor of descriptors) {
      const leftHandle = await directory.getFileHandle(descriptor.leftFile);
      const rightHandle = await directory.getFileHandle(descriptor.rightFile);
      const [leftFile, rightFile] = await Promise.all([leftHandle.getFile(), rightHandle.getFile()]);
      const expectedBytes = descriptor.length * Float32Array.BYTES_PER_ELEMENT;
      if (leftFile.size !== expectedBytes || rightFile.size !== expectedBytes) {
        throw new Error(`Temporary ${descriptor.label} stem is incomplete. Expected ${expectedBytes} bytes per channel.`);
      }
      const [leftBytes, rightBytes] = await Promise.all([leftFile.arrayBuffer(), rightFile.arrayBuffer()]);
      stems.push({
        id: descriptor.id,
        label: descriptor.label,
        channels: [new Float32Array(leftBytes), new Float32Array(rightBytes)],
      });
    }
    return stems;
  } finally {
    await storage.removeEntry(directoryName, { recursive: true }).catch(() => undefined);
  }
}

/** Resample separated stereo stems to the active SYN-MASTER session rate. */
export async function resampleStereoChannels(
  channels: [Float32Array, Float32Array],
  sourceSampleRate: number,
  targetSampleRate: number,
): Promise<[Float32Array, Float32Array]> {
  if (channels[0].length < 1 || channels[0].length !== channels[1].length) {
    throw new RangeError('Stereo resampling requires two non-empty, equal-length channels.');
  }
  for (const rate of [sourceSampleRate, targetSampleRate]) {
    if (!Number.isFinite(rate) || rate < 8_000 || rate > 384_000) {
      throw new RangeError('Audio sample rates must be between 8000 and 384000 Hz.');
    }
  }
  if (sourceSampleRate === targetSampleRate) return channels;

  const outputLength = Math.max(1, Math.ceil(channels[0].length * targetSampleRate / sourceSampleRate));
  const offline = new OfflineAudioContext(2, outputLength, targetSampleRate);
  const input = offline.createBuffer(2, channels[0].length, sourceSampleRate);
  input.copyToChannel(channels[0] as Float32Array<ArrayBuffer>, 0);
  input.copyToChannel(channels[1] as Float32Array<ArrayBuffer>, 1);
  const source = offline.createBufferSource();
  source.buffer = input;
  source.connect(offline.destination);
  source.start(0);
  const rendered = await offline.startRendering();
  return [rendered.getChannelData(0).slice(), rendered.getChannelData(1).slice()];
}

export function separateWithDemucs(
  channels: [Float32Array, Float32Array],
  signal: AbortSignal,
  onProgress: (progress: StemSeparationProgress) => void,
  options: { highQuality?: boolean; timeoutMs?: number } = {},
): Promise<SeparatedAudioStem[]> {
  if (signal.aborted) return Promise.reject(new DOMException('Separation cancelled.', 'AbortError'));
  if (channels[0].length < 1 || channels[0].length !== channels[1].length) {
    return Promise.reject(new Error('A non-empty stereo audio buffer is required.'));
  }

  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/demucsSeparation.worker.ts', import.meta.url), { type: 'module' });
    const jobId = globalThis.crypto?.randomUUID?.() ?? `demucs-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let settled = false;
    const timeoutMs = Math.max(1_000, options.timeoutMs ?? 600_000);
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout !== null) clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      worker.terminate();
      callback();
    };
    const abort = () => worker.postMessage({ type: 'cancel', jobId });

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.jobId !== jobId) return;
      if (message.type === 'progress') {
        onProgress({
          stage: message.stage,
          progress: message.progress,
          completedChunks: message.completedChunks,
          totalChunks: message.totalChunks,
          executionProvider: message.executionProvider,
        });
      } else if (message.type === 'result') {
        finish(() => {
          void loadTemporaryStems(message.directoryName, message.stems).then(resolve, reject);
        });
      } else if (message.type === 'cancelled') {
        finish(() => {
          void cleanupTemporaryStems(jobId).finally(() => reject(new DOMException('Separation cancelled.', 'AbortError')));
        });
      } else {
        finish(() => {
          void cleanupTemporaryStems(jobId).finally(() => reject(new Error(message.message)));
        });
      }
    };

    worker.onerror = (event) => finish(() => {
      void cleanupTemporaryStems(jobId).finally(() => reject(new Error(event.message || 'The separation worker crashed.')));
    });
    signal.addEventListener('abort', abort, { once: true });
    timeout = setTimeout(() => finish(() => {
      void cleanupTemporaryStems(jobId).finally(() =>
        reject(new Error(`Stem separation timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`)),
      );
    }), timeoutMs);
    if (signal.aborted) {
      finish(() => reject(new DOMException('Separation cancelled.', 'AbortError')));
      return;
    }
    worker.postMessage(
      { type: 'start', jobId, channels, shifts: options.highQuality ? 2 : 1 },
      [channels[0].buffer, channels[1].buffer],
    );
  });
}
