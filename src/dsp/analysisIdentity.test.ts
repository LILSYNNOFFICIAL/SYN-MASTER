/**
 * D1 identity proof: the import/preview performance changes must not change a single number.
 *  - analyzeAudioBuffer with the new progress hook == without it (deep, exact equality).
 *  - The import "identity render" (empty chain, no fades, takeOwnership) hands back the very
 *    same arrays, so reusing the import analysis for an empty-rack preview equals re-analysis.
 *  - Waveform peaks computed in the worker job equal the old main-thread computation.
 *  - The worker client: progress re-arms the watchdog, transferSource is zero-copy, abort
 *    rejects without a UI-thread fallback.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAudioBuffer, extractWaveformPeaks } from './analyzer.ts';
import { processChainOffline } from './offlineDsp.ts';
import { createDspWorkerClient } from './workerClient.ts';
import type { DspWorkerProgressMessage, DspWorkerRequest, DspWorkerSuccessResponse } from './dspWorker.ts';

/** Deterministic music-like stereo test signal: tones, a kick-like transient train, LCG noise, a click. */
function makeSignal(seconds: number, sampleRate = 48000): Float32Array[] {
  const n = Math.round(seconds * sampleRate);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296 - 0.5;
  };
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const beat = t % 0.5;
    const kick = Math.exp(-beat * 30) * Math.sin(2 * Math.PI * (60 + 80 * Math.exp(-beat * 40)) * t);
    const pad = 0.2 * Math.sin(2 * Math.PI * 220 * t) + 0.1 * Math.sin(2 * Math.PI * 331 * t + 0.3);
    const hiss = 0.01 * rnd();
    l[i] = 0.45 * kick + pad + hiss;
    r[i] = 0.45 * kick + 0.9 * pad - hiss * 0.5;
  }
  l[Math.floor(n / 3)] += 0.6; // a click
  return [l, r];
}

const clone = (chs: Float32Array[]) => chs.map((c) => new Float32Array(c));

test('analysis identity: the progress hook never changes any analysis value', () => {
  const src = makeSignal(12);
  const plain = analyzeAudioBuffer(clone(src), 48000);
  const fractions: number[] = [];
  const hooked = analyzeAudioBuffer(clone(src), 48000, (f) => fractions.push(f));
  assert.deepStrictEqual(hooked, plain);
  assert.equal(JSON.stringify(hooked), JSON.stringify(plain));
  assert.ok(fractions.length >= 8, 'reports progress between measurement sections');
  for (let i = 1; i < fractions.length; i++) assert.ok(fractions[i] >= fractions[i - 1], 'progress is monotonic');
  assert.ok(fractions.every((f) => f > 0 && f < 1));
  // A throwing progress handler must not break or change the analysis.
  const throwing = analyzeAudioBuffer(clone(src), 48000, () => { throw new Error('ui went away'); });
  assert.deepStrictEqual(throwing, plain);
});

test('analysis identity: empty-chain import render is the identity, so reusing the import analysis equals a second pass', () => {
  const src = makeSignal(8);
  const input = clone(src);
  const processed = processChainOffline(input, 48000, [], null, { takeOwnership: true });
  assert.equal(processed.channels[0], input[0], 'same array handed back (zero copy)');
  assert.equal(processed.channels[1], input[1]);
  for (let ch = 0; ch < 2; ch++) {
    assert.ok(Buffer.from(processed.channels[ch].buffer).equals(Buffer.from(src[ch].buffer)), `channel ${ch} bit-identical`);
  }
  const importAnalysis = analyzeAudioBuffer(processed.channels, 48000);
  // Old behaviour: the preview effect re-rendered the empty chain on a clone and analysed again.
  const secondPass = processChainOffline(clone(processed.channels), 48000, [], null, { takeOwnership: true });
  const previewAnalysis = analyzeAudioBuffer(secondPass.channels, 48000);
  assert.deepStrictEqual(importAnalysis, previewAnalysis);
  assert.deepStrictEqual(extractWaveformPeaks(secondPass.channels, 400), extractWaveformPeaks(processed.channels, 400));
  assert.deepStrictEqual(extractWaveformPeaks(secondPass.channels, 1600), extractWaveformPeaks(src, 1600));
});

/** In-process fake of dspWorker.ts that mirrors its message protocol (progress + peaksHi). */
class ProgressFakeWorker {
  onmessage: ((event: MessageEvent<DspWorkerSuccessResponse | DspWorkerProgressMessage>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  terminated = false;
  received: Float32Array[] | null = null;
  /** Milliseconds between progress messages; total job time = steps * stepMs. */
  constructor(private steps = 0, private stepMs = 0, private respond = true) {}

  postMessage(message: DspWorkerRequest): void {
    this.received = message.channels;
    const finish = () => {
      if (this.terminated || !this.respond) return;
      const processed = processChainOffline(message.channels, message.sampleRate, message.chain, null, { takeOwnership: true });
      const response: DspWorkerSuccessResponse = {
        id: message.id,
        ok: true,
        channels: processed.channels,
        telemetry: processed.telemetry,
        analysis: analyzeAudioBuffer(processed.channels, message.sampleRate),
        peaks: extractWaveformPeaks(processed.channels, message.peakBins ?? 400),
        ...(message.hiPeakBins ? { peaksHi: extractWaveformPeaks(processed.channels, message.hiPeakBins) } : {}),
      };
      this.onmessage?.({ data: response } as MessageEvent<DspWorkerSuccessResponse>);
    };
    let step = 0;
    const tick = () => {
      if (this.terminated) return;
      if (step < this.steps) {
        step++;
        if (message.reportProgress) {
          const m: DspWorkerProgressMessage = { id: message.id, kind: 'progress', stage: 'analyzing', fraction: step / this.steps };
          this.onmessage?.({ data: m } as MessageEvent<DspWorkerProgressMessage>);
        }
        setTimeout(tick, this.stepMs);
        return;
      }
      finish();
    };
    setTimeout(tick, 0);
  }

  terminate(): void {
    this.terminated = true;
  }
}

test('worker client: progress messages re-arm the watchdog so a slow but alive job is not killed', async () => {
  const src = makeSignal(1);
  // Job takes ~10 x 30 ms = 300 ms total; watchdog is 100 ms of inactivity.
  const worker = new ProgressFakeWorker(10, 30);
  const client = createDspWorkerClient({ workerFactory: () => worker as unknown as Worker, workerTimeoutMs: 100 });
  const seen: number[] = [];
  const result = await client.renderAndAnalyzeOffThread({
    sourceChannels: src,
    sampleRate: 48000,
    chain: [],
    includePeaks: true,
    hiPeakBins: 1600,
    onProgress: (_stage, f) => seen.push(f),
  });
  assert.equal(result.usedWorker, true);
  assert.equal(worker.terminated, false);
  assert.equal(seen.length, 10);
  assert.deepStrictEqual(result.analysis, analyzeAudioBuffer(clone(src), 48000));
  assert.deepStrictEqual(result.peaksHi, extractWaveformPeaks(src, 1600));
  client.dispose();
});

test('worker client: transferSource hands the caller arrays over without a clone and returns identical samples', async () => {
  const reference = makeSignal(1);
  const src = clone(reference);
  const worker = new ProgressFakeWorker();
  const client = createDspWorkerClient({ workerFactory: () => worker as unknown as Worker });
  const result = await client.renderAndAnalyzeOffThread({
    sourceChannels: src,
    sampleRate: 48000,
    chain: [],
    includePeaks: true,
    transferSource: true,
  });
  assert.equal(worker.received?.[0], src[0], 'no clone: the worker received the caller array itself');
  for (let ch = 0; ch < 2; ch++) {
    assert.ok(Buffer.from(result.channels[ch].buffer).equals(Buffer.from(reference[ch].buffer)));
  }
  assert.deepStrictEqual(result.analysis, analyzeAudioBuffer(clone(reference), 48000));
  client.dispose();
});

test('worker client: abort rejects with AbortError, terminates the job and never falls back to the UI thread', async () => {
  const src = makeSignal(1);
  const worker = new ProgressFakeWorker(50, 20);
  const client = createDspWorkerClient({ workerFactory: () => worker as unknown as Worker });
  const controller = new AbortController();
  const pending = client.renderAndAnalyzeOffThread({
    sourceChannels: src,
    sampleRate: 48000,
    chain: [],
    signal: controller.signal,
    onProgress: () => undefined,
  });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, (err: Error) => err.name === 'AbortError');
  assert.equal(worker.terminated, true);
  assert.equal(client.getPendingJobCount(), 0);
  client.dispose();
});
