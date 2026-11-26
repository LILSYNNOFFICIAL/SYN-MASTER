import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSharedStemSeparationService,
  estimateStemSeparationOutputBytes,
  resampleStereoChannels,
  separateWithDemucs,
  type SeparatedAudioStem,
  type SharedStemSeparationRequest,
  type StemSeparationProgress,
} from './stemSeparation.ts';

test('stem-separation resource estimate accounts for four stereo float stems', () => {
  assert.equal(estimateStemSeparationOutputBytes(1, 44_100), 44_100 * 8 * Float32Array.BYTES_PER_ELEMENT);
  assert.throws(() => estimateStemSeparationOutputBytes(0, 44_100), /valid duration and sample rate/);
});

test('a non-responsive separation worker times out explicitly and is terminated', async () => {
  const originalWorker = globalThis.Worker;
  let terminated = false;
  class HangingWorker {
    onmessage: Worker['onmessage'] = null;
    onerror: Worker['onerror'] = null;
    postMessage(): void {}
    terminate(): void {
      terminated = true;
    }
  }
  globalThis.Worker = HangingWorker as unknown as typeof Worker;

  try {
    await assert.rejects(
      separateWithDemucs(
        [new Float32Array([0.1]), new Float32Array([0.1])],
        new AbortController().signal,
        () => {},
        { timeoutMs: 1_000 },
      ),
      /Stem separation timed out after 1 seconds/,
    );
    assert.equal(terminated, true);
  } finally {
    globalThis.Worker = originalWorker;
  }
});

test('resampling at the current session rate preserves the original stereo buffers', async () => {
  const channels: [Float32Array, Float32Array] = [
    new Float32Array([0.1, -0.2, 0.3]),
    new Float32Array([-0.1, 0.2, -0.3]),
  ];
  const result = await resampleStereoChannels(channels, 44_100, 44_100);
  assert.equal(result[0], channels[0]);
  assert.equal(result[1], channels[1]);
});

test('stereo resampling rejects empty or mismatched channel buffers', async () => {
  await assert.rejects(
    resampleStereoChannels([new Float32Array(0), new Float32Array(0)], 44_100, 48_000),
    RangeError,
  );
  await assert.rejects(
    resampleStereoChannels([new Float32Array(4), new Float32Array(3)], 44_100, 48_000),
    RangeError,
  );
});

test('stereo resampling rejects unsupported source and target sample rates', async () => {
  const channels: [Float32Array, Float32Array] = [new Float32Array([0]), new Float32Array([0])];
  await assert.rejects(resampleStereoChannels(channels, 7_999, 48_000), RangeError);
  await assert.rejects(resampleStereoChannels(channels, 44_100, 384_001), RangeError);
});

const resource = { durationSec: 1, sampleRate: 44_100, fileSizeBytes: 8 };

function makeChannels(value = 0.2): [Float32Array, Float32Array] {
  return [new Float32Array([value, -value]), new Float32Array([value / 2, -value / 2])];
}

function makeStemSet(channels: [Float32Array, Float32Array]): SeparatedAudioStem[] {
  return [
    { id: 'drums', label: 'Drums', channels: [channels[0].map((x) => x * 0.25), channels[1].map((x) => x * 0.25)] },
    { id: 'bass', label: 'Bass', channels: [channels[0].map((x) => x * 0.25), channels[1].map((x) => x * 0.25)] },
    { id: 'other', label: 'Other', channels: [channels[0].map((x) => x * 0.25), channels[1].map((x) => x * 0.25)] },
    { id: 'vocals', label: 'Vocals', channels: [channels[0].map((x) => x * 0.25), channels[1].map((x) => x * 0.25)] },
  ];
}

function createRequest(
  channels = makeChannels(),
  options: Partial<Pick<SharedStemSeparationRequest, 'highQuality' | 'signal' | 'onProgress'>> = {},
): SharedStemSeparationRequest {
  return {
    channels,
    sampleRate: 44_100,
    resource: { ...resource, durationSec: channels[0].length / 44_100 },
    signal: options.signal ?? new AbortController().signal,
    highQuality: options.highQuality,
    onProgress: options.onProgress,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('Stem Studio starts separation and Fix All reuses its in-progress job', async () => {
  const started = deferred<void>();
  const completion = deferred<SeparatedAudioStem[]>();
  let runCount = 0;
  const service = createSharedStemSeparationService({
    assessResources: async () => {},
    runSeparation: async () => {
      runCount += 1;
      started.resolve();
      return completion.promise;
    },
  });

  const studioRequest = service.separate(createRequest());
  await started.promise;
  const fixAllRequest = service.separate(createRequest());
  assert.equal(runCount, 1);
  completion.resolve(makeStemSet(makeChannels()));
  const [studio, fixAll] = await Promise.all([studioRequest, fixAllRequest]);
  assert.equal(studio, fixAll);
  assert.equal(studio.stems.length, 4);
});

test('Fix All starts separation and Stem Studio reuses its in-progress job', async () => {
  const started = deferred<void>();
  const completion = deferred<SeparatedAudioStem[]>();
  let runCount = 0;
  const service = createSharedStemSeparationService({
    assessResources: async () => {},
    runSeparation: async () => {
      runCount += 1;
      started.resolve();
      return completion.promise;
    },
  });

  const fixAllRequest = service.separate(createRequest());
  await started.promise;
  const studioRequest = service.separate(createRequest());
  assert.equal(runCount, 1);
  completion.resolve(makeStemSet(makeChannels()));
  const [fixAll, studio] = await Promise.all([fixAllRequest, studioRequest]);
  assert.equal(fixAll, studio);
});

test('simultaneous consumers share one separation run', async () => {
  let preflightCount = 0;
  let runCount = 0;
  const service = createSharedStemSeparationService({
    assessResources: async () => {
      preflightCount += 1;
    },
    runSeparation: async (channels) => {
      runCount += 1;
      await Promise.resolve();
      return makeStemSet(channels);
    },
  });

  const results = await Promise.all([
    service.separate(createRequest()),
    service.separate(createRequest()),
    service.separate(createRequest()),
  ]);
  assert.equal(runCount, 1);
  assert.equal(preflightCount, 1);
  assert.equal(results[0], results[1]);
  assert.equal(results[1], results[2]);
});

test('valid completed stems are reused but changed source audio and quality settings are not', async () => {
  let runCount = 0;
  const service = createSharedStemSeparationService({
    assessResources: async () => {},
    runSeparation: async (channels) => {
      runCount += 1;
      return makeStemSet(channels);
    },
  });

  const initial = await service.separate(createRequest());
  assert.equal(await service.separate(createRequest()), initial);
  await service.separate(createRequest(makeChannels(0.21)));
  await service.separate(createRequest(makeChannels(), { highQuality: true }));
  assert.equal(runCount, 3);
});

test('one consumer cancelling does not interrupt another consumer of the same job', async () => {
  const started = deferred<void>();
  const secondJoined = deferred<void>();
  const completion = deferred<SeparatedAudioStem[]>();
  let sharedSignal: AbortSignal | undefined;
  const service = createSharedStemSeparationService({
    assessResources: async () => {},
    onConsumerAdded: (count) => {
      if (count === 2) secondJoined.resolve();
    },
    runSeparation: async (_channels, signal) => {
      sharedSignal = signal;
      started.resolve();
      return completion.promise;
    },
  });
  const cancelledConsumer = new AbortController();
  const remainingConsumer = new AbortController();
  const first = service.separate(createRequest(makeChannels(), { signal: cancelledConsumer.signal }));
  await started.promise;
  const second = service.separate(createRequest(makeChannels(), { signal: remainingConsumer.signal }));

  await secondJoined.promise;
  cancelledConsumer.abort();
  await assert.rejects(first, { name: 'AbortError' });
  assert.equal(sharedSignal?.aborted, false);
  completion.resolve(makeStemSet(makeChannels()));
  assert.equal((await second).stems.length, 4);
});

test('failed jobs are removed and can be retried without reusing stale results', async () => {
  let runCount = 0;
  const service = createSharedStemSeparationService({
    assessResources: async () => {},
    runSeparation: async (channels) => {
      runCount += 1;
      if (runCount === 1) throw new Error('injected worker failure');
      return makeStemSet(channels);
    },
  });

  await assert.rejects(service.separate(createRequest()), /injected worker failure/);
  const retried = await service.separate(createRequest());
  assert.equal(retried.stems.length, 4);
  assert.equal(runCount, 2);
});

test('resource failures do not start a worker and a later request can retry', async () => {
  let preflightCount = 0;
  let runCount = 0;
  const service = createSharedStemSeparationService({
    assessResources: async () => {
      preflightCount += 1;
      if (preflightCount === 1) throw new Error('temporary resource shortage');
    },
    runSeparation: async (channels) => {
      runCount += 1;
      return makeStemSet(channels);
    },
  });

  await assert.rejects(service.separate(createRequest()), /temporary resource shortage/);
  assert.equal(runCount, 0);
  await service.separate(createRequest());
  assert.equal(runCount, 1);
});

test('incomplete or mismatched stems fail explicitly and are never cached', async () => {
  let runCount = 0;
  const service = createSharedStemSeparationService({
    assessResources: async () => {},
    runSeparation: async (channels) => {
      runCount += 1;
      const stems = makeStemSet(channels);
      if (runCount === 1) stems[0].channels[0] = new Float32Array(1);
      return stems;
    },
  });

  await assert.rejects(service.separate(createRequest()), /incomplete or mismatched stem set/);
  assert.equal((await service.separate(createRequest())).stems.length, 4);
  assert.equal(runCount, 2);
});

test('timeout errors never produce a reusable successful result', async () => {
  let runCount = 0;
  const service = createSharedStemSeparationService({
    assessResources: async () => {},
    runSeparation: async (channels) => {
      runCount += 1;
      if (runCount === 1) throw new Error('Stem separation timed out.');
      return makeStemSet(channels);
    },
  });

  await assert.rejects(service.separate(createRequest()), /timed out/);
  assert.equal((await service.separate(createRequest())).stems.length, 4);
  assert.equal(runCount, 2);
});

test('completed cache stays within its configured memory budget', async () => {
  let runCount = 0;
  const service = createSharedStemSeparationService({
    assessResources: async () => {},
    runSeparation: async (channels) => {
      runCount += 1;
      return makeStemSet(channels);
    },
    maxCachedBytes: 1,
  });

  await service.separate(createRequest());
  await service.separate(createRequest());
  assert.equal(runCount, 2);
});

test('progress is delivered to every active separation consumer', async () => {
  const secondJoined = deferred<void>();
  const completion = deferred<SeparatedAudioStem[]>();
  const progressCallback = deferred<(progress: StemSeparationProgress) => void>();
  const service = createSharedStemSeparationService({
    assessResources: async () => {},
    onConsumerAdded: (count) => {
      if (count === 2) secondJoined.resolve();
    },
    runSeparation: async (_channels, _signal, onProgress) => {
      progressCallback.resolve(onProgress);
      return completion.promise;
    },
  });
  const progressEvents: StemSeparationProgress[] = [];
  const secondProgressEvents: StemSeparationProgress[] = [];
  const first = service.separate(createRequest(makeChannels(), { onProgress: (progress) => progressEvents.push(progress) }));
  const publishProgress = await progressCallback.promise;
  const second = service.separate(createRequest(makeChannels(), { onProgress: (progress) => secondProgressEvents.push(progress) }));
  await secondJoined.promise;
  assert.ok(publishProgress);
  publishProgress({ stage: 'separating', progress: 0.5 });
  completion.resolve(makeStemSet(makeChannels()));
  await Promise.all([first, second]);
  assert.equal(progressEvents[0]?.progress, 0.5);
  assert.equal(secondProgressEvents[0]?.progress, 0.5);
});
