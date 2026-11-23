import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAudioBuffer } from './analyzer.ts';
import { processChainOffline } from './offlineDsp.ts';
import { createDspWorkerClient } from './workerClient.ts';
import type { DspWorkerRequest, DspWorkerSuccessResponse } from './dspWorker.ts';

function makeSource(length = 4096): Float32Array[] {
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  for (let i = 0; i < left.length; i++) {
    const sample = 0.2 * Math.sin((2 * Math.PI * 440 * i) / 44100);
    left[i] = sample;
    right[i] = sample * 0.9;
  }
  return [left, right];
}

class FakeWorker {
  onmessage: ((event: MessageEvent<DspWorkerSuccessResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  terminated = false;
  respond = true;
  reusedTransferredBuffers = false;

  postMessage(message: DspWorkerRequest): void {
    if (!this.respond) return;
    const processed = processChainOffline(message.channels, message.sampleRate, message.chain, null, { takeOwnership: true });
    this.reusedTransferredBuffers = processed.channels[0] === message.channels[0] && processed.channels[1] === message.channels[1];
    const response: DspWorkerSuccessResponse = {
      id: message.id,
      ok: true,
      channels: processed.channels,
      telemetry: processed.telemetry,
      analysis: analyzeAudioBuffer(processed.channels, message.sampleRate),
    };
    queueMicrotask(() => this.onmessage?.({ data: response } as MessageEvent<DspWorkerSuccessResponse>));
  }

  terminate(): void {
    this.terminated = true;
  }
}

test('falls back to main-thread DSP when Web Workers are unavailable without detaching source audio', async () => {
  const source = makeSource();
  const before = source[0][32];
  const client = createDspWorkerClient({ workerFactory: () => null });
  const result = await client.renderAndAnalyzeOffThread({
    sourceChannels: source,
    sampleRate: 44100,
    chain: [],
    includePeaks: true,
  });

  assert.equal(result.usedWorker, false);
  assert.equal(result.usedExternalHost, false);
  assert.equal(result.channels.length, 2);
  assert.ok(result.analysis.integratedLufs < 0);
  assert.ok(result.peaks && result.peaks.length > 0);
  assert.equal(source[0][32], before);
  client.dispose();
});

test('uses worker results and keeps transferred input clones separate from the source', async () => {
  const source = makeSource();
  const before = source[0][32];
  const worker = new FakeWorker();
  const client = createDspWorkerClient({ workerFactory: () => worker as unknown as Worker });
  const result = await client.renderAndAnalyzeOffThread({
    sourceChannels: source,
    sampleRate: 44100,
    chain: [],
  });

  assert.equal(result.usedWorker, true);
  assert.equal(result.channels.length, 2);
  assert.equal(source[0][32], before);
  assert.equal(worker.reusedTransferredBuffers, true, 'The worker renderer must consume transferred buffers without another full-track copy');
  assert.equal(worker.terminated, false);
  client.dispose();
  assert.equal(worker.terminated, true);
});

test('terminates a timed-out worker and falls back for short audio instead of leaving a pending job', async () => {
  const source = makeSource();
  const worker = new FakeWorker();
  worker.respond = false;
  const client = createDspWorkerClient({
    workerFactory: () => worker as unknown as Worker,
    workerTimeoutMs: 5,
  });
  const result = await client.renderAndAnalyzeOffThread({
    sourceChannels: source,
    sampleRate: 44100,
    chain: [],
  });

  assert.equal(result.usedWorker, false);
  assert.equal(result.channels.length, 2);
  assert.equal(worker.terminated, true);
  client.dispose();
});

test('does not run a long-form DSP fallback on the UI thread when the worker is unavailable', async () => {
  const source = makeSource(31 * 44100);
  const client = createDspWorkerClient({ workerFactory: () => null });
  await assert.rejects(
    client.renderAndAnalyzeOffThread({ sourceChannels: source, sampleRate: 44100, chain: [] }),
    /Main-thread fallback was skipped to prevent the interface from freezing.*Web Worker is unavailable/,
  );
  client.dispose();
});

test('does not run a long-form DSP fallback on the UI thread after a worker timeout', async () => {
  const source = makeSource(31 * 44100);
  const worker = new FakeWorker();
  worker.respond = false;
  const client = createDspWorkerClient({
    workerFactory: () => worker as unknown as Worker,
    workerTimeoutMs: 5,
  });
  await assert.rejects(
    client.renderAndAnalyzeOffThread({ sourceChannels: source, sampleRate: 44100, chain: [] }),
    /Main-thread fallback was skipped to prevent the interface from freezing.*timed out after 5 ms/,
  );
  assert.equal(worker.terminated, true);
  assert.equal(client.getPendingJobCount(), 0);
  client.dispose();
});
