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
): Promise<SeparatedAudioStem[]> {
  if (signal.aborted) return Promise.reject(new DOMException('Separation cancelled.', 'AbortError'));
  if (channels[0].length < 1 || channels[0].length !== channels[1].length) {
    return Promise.reject(new Error('A non-empty stereo audio buffer is required.'));
  }

  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/demucsSeparation.worker.ts', import.meta.url), { type: 'module' });
    const jobId = globalThis.crypto?.randomUUID?.() ?? `demucs-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
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
    if (signal.aborted) {
      finish(() => reject(new DOMException('Separation cancelled.', 'AbortError')));
      return;
    }
    worker.postMessage({ type: 'start', jobId, channels }, [channels[0].buffer, channels[1].buffer]);
  });
}
