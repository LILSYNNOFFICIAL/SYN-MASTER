import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultParams, createProcessorModule } from './chainValidation';
import { renderMixedChain } from './mixedChainRenderer';
import { encodeWavBlob } from './wavEncoder';
import { DEFAULT_EXPORT_CONFIG } from './exportDefaults';
import type { FadeSettings } from './fades';
import { createDspWorkerClient } from './workerClient';
import { learnMatchEqSpectrum } from './matchEq';
import type { ExportConfig, LimiterParams, MatchEqParams, ProcessorModule } from '../types/mastering';

// Export == preview for Match EQ: the WAV export path (renderMixedChain -> 32-bit encodeWavBlob)
// must be bit-identical to the preview / Fix-All path (the real dspWorker module through the
// app's worker client), for linear- and minimum-phase Match EQ in stereo and mid modes.

const SR = 48000;
const SECONDS = 2;
const FADES: FadeSettings = { inSec: 0.1, outSec: 0.2, inCurve: 'scurve', outCurve: 'linear' };

function noise(seed: number, n: number, tiltDbPerOct = 0): Float32Array {
  let s = seed >>> 0;
  const out = new Float32Array(n);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const w = s / 2 ** 32 - 0.5;
    lp = lp * 0.9 + w * 0.1;
    out[i] = 0.3 * (tiltDbPerOct >= 0 ? w : lp) + 0.15 * Math.sin((2 * Math.PI * 220 * i) / SR);
  }
  return out;
}

function source(): Float32Array[] {
  const n = SR * SECONDS;
  return [noise(1, n, -1), noise(2, n, -1)];
}

function matchParams(phase: MatchEqParams['phase'], channel: MatchEqParams['channel']): MatchEqParams {
  const n = SR * SECONDS;
  const src = learnMatchEqSpectrum(source(), SR)!;
  const ref = learnMatchEqSpectrum([noise(7, n, 1), noise(8, n, 1)], SR)!;
  return { ...(createDefaultParams('match-eq') as MatchEqParams), amount: 80, phase, channel, source: src, reference: ref, referenceName: 'bright ref' };
}

function chain(phase: MatchEqParams['phase'], channel: MatchEqParams['channel']): ProcessorModule[] {
  return [
    createProcessorModule('match-eq', { id: 'meq', params: matchParams(phase, channel) }),
    createProcessorModule('limiter', { id: 'lim', params: createDefaultParams('limiter') as LimiterParams, inputGainDb: 4 }),
  ];
}

interface ParsedWav {
  formatTag: number;
  channels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
  frames: number;
  samples: Float32Array[];
}

function parseWav(bytes: Uint8Array): ParsedWav {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  assert.equal(ascii(0), 'RIFF');
  assert.equal(view.getUint32(4, true), bytes.length - 8, 'RIFF size must equal file length - 8');
  assert.equal(ascii(8), 'WAVE');
  let offset = 12;
  let fmt: Omit<ParsedWav, 'frames' | 'samples'> | null = null;
  let dataOffset = -1;
  let dataSize = 0;
  while (offset + 8 <= bytes.length) {
    const id = ascii(offset);
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ') {
      fmt = {
        formatTag: view.getUint16(offset + 8, true),
        channels: view.getUint16(offset + 10, true),
        sampleRate: view.getUint32(offset + 12, true),
        byteRate: view.getUint32(offset + 16, true),
        blockAlign: view.getUint16(offset + 20, true),
        bitsPerSample: view.getUint16(offset + 22, true),
      };
    } else if (id === 'data') {
      dataOffset = offset + 8;
      dataSize = size;
    }
    offset += 8 + size + (size & 1);
  }
  assert.ok(fmt, 'fmt chunk present');
  assert.ok(dataOffset > 0, 'data chunk present');
  assert.equal(dataOffset + dataSize, bytes.length, 'data chunk must end exactly at end of file');
  const bps = fmt.bitsPerSample / 8;
  assert.equal(fmt.blockAlign, fmt.channels * bps, 'blockAlign = channels * bytesPerSample');
  assert.equal(fmt.byteRate, fmt.sampleRate * fmt.blockAlign, 'byteRate = sampleRate * blockAlign');
  assert.equal(fmt.formatTag, fmt.bitsPerSample === 32 ? 3 : 1, 'format tag: 3 = IEEE float for 32-bit, 1 = PCM otherwise');
  assert.equal(dataSize % fmt.blockAlign, 0, 'data size must be a whole number of frames');
  const frames = dataSize / fmt.blockAlign;
  const samples = Array.from({ length: fmt.channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < fmt.channels; c++) {
      const o = dataOffset + i * fmt.blockAlign + c * bps;
      if (fmt.bitsPerSample === 32) samples[c][i] = view.getFloat32(o, true);
      else if (fmt.bitsPerSample === 24) {
        let v = bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16);
        if (v & 0x800000) v -= 0x1000000;
        samples[c][i] = v / 8388607;
      } else samples[c][i] = view.getInt16(o, true) / 32767;
    }
  }
  return { ...fmt, frames, samples };
}

/** The real dspWorker module, driven in-process through the same client the app uses. */
async function makeInProcessWorkerClient() {
  type Handler = (ev: { data: unknown }) => void;
  const fakeSelf: { onmessage: Handler | null; postMessage: (msg: unknown) => void } = { onmessage: null, postMessage: () => undefined };
  const g = globalThis as unknown as { self?: unknown };
  const previousSelf = g.self;
  g.self = fakeSelf;
  await import('./dspWorker');
  const handler = fakeSelf.onmessage;
  assert.ok(handler, 'dspWorker registers an onmessage handler');
  let posted = 0;
  const client = createDspWorkerClient({
    workerTimeoutMs: 20_000,
    workerFactory: () => {
      const worker = {
        onmessage: null as ((ev: MessageEvent) => void) | null,
        onerror: null,
        onmessageerror: null,
        postMessage(message: unknown) {
          posted++;
          fakeSelf.postMessage = (resp) => setTimeout(() => worker.onmessage?.({ data: resp } as MessageEvent), 0);
          setTimeout(() => handler({ data: message }), 0);
        },
        terminate() {},
      };
      return worker as never;
    },
  });
  // dspWorker reads the global `self` when it replies, so keep the fake installed until restore().
  return { client, posted: () => posted, restore: () => { g.self = previousSelf; } };
}


test('Match EQ WAV export is bit-identical to the preview worker render (linear/minimum phase, stereo/mid)', async () => {
  // dspWorker registers its handler once per process, so one in-process client serves every variant.
  const { client, restore } = await makeInProcessWorkerClient();
  try {
    for (const [phase, channel] of [['linear', 'stereo'], ['minimum', 'stereo'], ['linear', 'mid']] as const) {
      const src = source();
      const before = src.map((c) => new Float32Array(c));
      const preview = await client.renderAndAnalyzeOffThread({ sourceChannels: src, sampleRate: SR, chain: chain(phase, channel), includePeaks: true, postFades: FADES });
      assert.equal(preview.usedWorker, true, 'preview must go through the DSP worker path');
      assert.deepEqual(src, before, 'preview must not mutate the source');
      const exported = await renderMixedChain(src, SR, chain(phase, channel), undefined, FADES);
      const cfg: ExportConfig = { ...DEFAULT_EXPORT_CONFIG, format: 'wav', wavBitDepth: 32, sampleRate: SR as ExportConfig['sampleRate'], dither: 'none', channels: 'stereo', ceilingDb: 0 };
      const wav = parseWav(new Uint8Array(await encodeWavBlob(exported.channels, SR, cfg).arrayBuffer()));
      assert.equal(wav.frames, src[0].length);
      for (let c = 0; c < 2; c++) {
        assert.deepEqual(Array.from(exported.channels[c]), Array.from(preview.channels[c]), `${phase}/${channel}: export render == preview render (ch ${c})`);
        assert.deepEqual(Array.from(wav.samples[c]), Array.from(preview.channels[c]), `${phase}/${channel}: encoded WAV == preview render (ch ${c})`);
      }
      // And the Match EQ really acted: the render differs from the same chain without it.
      const without = await renderMixedChain(src, SR, chain(phase, channel).filter((m) => m.type !== 'match-eq'), undefined, FADES);
      let diff = 0;
      for (let i = 0; i < src[0].length; i += 31) diff = Math.max(diff, Math.abs(without.channels[0][i] - exported.channels[0][i]));
      assert.ok(diff > 1e-3, `${phase}/${channel}: Match EQ changes the export (max diff ${diff})`);
    }
  } finally {
    client.dispose();
    restore();
  }
});
