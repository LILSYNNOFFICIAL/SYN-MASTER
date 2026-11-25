import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultParams, createProcessorModule } from './chainValidation';
import { renderMixedChain } from './mixedChainRenderer';
import { processChainOffline } from './offlineDsp';
import { encodeWavBlob } from './wavEncoder';
import { DEFAULT_EXPORT_CONFIG } from './exportDefaults';
import { applyFades, fadeGain, type FadeSettings } from './fades';
import { createDspWorkerClient } from './workerClient';
import type { DynamicEQParams, ExportConfig, LimiterParams, ProcessorModule } from '../types/mastering';

// Verification for the full WAV export with timeline fades and an enabled Dynamic EQ that
// both cuts and boosts. The export (renderMixedChain -> encodeWavBlob, the path App's export
// uses) must be the same render as the preview / Fix-All path (the DSP worker running
// processChainOffline with transferred buffers), fades must be applied after the chain, and
// the encoded file must be a well-formed RIFF/WAVE container.

const SR = 48000;
const SECONDS = 1.5;
const FADES: FadeSettings = { inSec: 0.2, outSec: 0.3, inCurve: 'scurve', outCurve: 'linear' };

function source(): Float32Array[] {
  const n = Math.floor(SR * SECONDS);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  let seed = 12345;
  const noise = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32 - 0.5;
  };
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    // loud 1 kHz (Dynamic EQ cut target), quiet 5 kHz (boost target), low pad and a little noise
    const base = 0.55 * Math.sin(2 * Math.PI * 1000 * t) + 0.12 * Math.sin(2 * Math.PI * 5000 * t) + 0.2 * Math.sin(2 * Math.PI * 110 * t);
    l[i] = base + 0.02 * noise();
    r[i] = 0.95 * base + 0.02 * noise();
  }
  return [l, r];
}

function chain(): ProcessorModule[] {
  const deq: DynamicEQParams = {
    bands: [
      { id: 'cut', enabled: true, freq: 1000, q: 2, thresholdDb: -30, maxCutDb: -6, ratio: 4, mode: 'cut', attackMs: 5, releaseMs: 80 },
      { id: 'boost', enabled: true, freq: 5000, q: 2, thresholdDb: -40, maxCutDb: 4, ratio: 3, mode: 'boost', attackMs: 5, releaseMs: 80 },
    ],
  };
  const limiter = createDefaultParams('limiter') as LimiterParams;
  return [
    createProcessorModule('dynamic-eq', { id: 'deq', params: deq }),
    createProcessorModule('limiter', { id: 'lim', params: limiter, inputGainDb: 6 }),
  ];
}

/** Goertzel power (dB) of one frequency over a window. */
function toneDb(x: Float32Array, freq: number, from: number, to: number): number {
  const k = 2 * Math.cos((2 * Math.PI * freq) / SR);
  let s1 = 0;
  let s2 = 0;
  for (let i = from; i < to; i++) {
    const s0 = x[i] + k * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const p = s1 * s1 + s2 * s2 - k * s1 * s2;
  return 10 * Math.log10(p / (to - from) ** 2 + 1e-30);
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

test('WAV export with fades + cut/boost Dynamic EQ is bit-identical to the preview worker render', async () => {
  const src = source();
  const before = src.map((c) => new Float32Array(c));
  const { client, posted, restore } = await makeInProcessWorkerClient();
  let preview;
  try {
    preview = await client.renderAndAnalyzeOffThread({ sourceChannels: src, sampleRate: SR, chain: chain(), includePeaks: true, postFades: FADES });
  } finally {
    client.dispose();
    restore();
  }
  assert.equal(preview.usedWorker, true, 'preview must go through the DSP worker path');
  assert.equal(posted(), 1);
  assert.deepEqual(src, before, 'preview must not mutate the main-thread source');

  // Export path from App.handleExport: renderMixedChain(..., getPostFades()) -> 32-bit float intermediate
  const exported = await renderMixedChain(src, SR, chain(), undefined, FADES);
  assert.deepEqual(src, before, 'export render must not mutate the source');
  const cfg: ExportConfig = { ...DEFAULT_EXPORT_CONFIG, format: 'wav', wavBitDepth: 32, sampleRate: SR as ExportConfig['sampleRate'], dither: 'none', channels: 'stereo', ceilingDb: 0 };
  const wav = parseWav(new Uint8Array(await encodeWavBlob(exported.channels, SR, cfg).arrayBuffer()));
  assert.equal(wav.channels, 2);
  assert.equal(wav.sampleRate, SR);
  assert.equal(wav.frames, src[0].length, 'exported WAV must contain every source frame');
  for (let c = 0; c < 2; c++) {
    assert.deepEqual(Array.from(exported.channels[c]), Array.from(preview.channels[c]), `export render == preview render (ch ${c})`);
    assert.deepEqual(Array.from(wav.samples[c]), Array.from(preview.channels[c]), `encoded 32-bit WAV == preview render (ch ${c})`);
  }
  assert.deepEqual(exported.telemetry, preview.telemetry, 'per-module meter telemetry must match between export and preview');
});

test('fades are applied after the chain: limiter sees the unfaded signal', () => {
  const src = source();
  const faded = processChainOffline(src, SR, chain(), FADES);
  const unfaded = processChainOffline(src, SR, chain(), null);
  // Every module (Dynamic EQ and limiter) saw identical input with and without fades.
  assert.deepEqual(faded.telemetry, unfaded.telemetry, 'chain telemetry must not change when fades are added');
  const limiterGr = unfaded.telemetry.find((t) => t.id === 'lim')?.gainReductionDb ?? 0;
  assert.ok(Math.abs(limiterGr) > 0.5, `limiter should be working on this source (GR ${limiterGr.toFixed(2)} dB)`);
  const reference = applyFades(unfaded.channels, SR, FADES);
  for (let c = 0; c < 2; c++) {
    assert.deepEqual(Array.from(faded.channels[c]), Array.from(reference[c]), `faded render == fades(chain(source)) (ch ${c})`);
  }
  const n = src[0].length;
  const inN = Math.round(FADES.inSec * SR);
  const outN = Math.round(FADES.outSec * SR);
  assert.equal(Math.abs(faded.channels[0][0]), 0, 'first sample silent');
  assert.equal(Math.abs(faded.channels[0][n - 1]), 0, 'last sample silent');
  const mid = Math.floor(inN / 2);
  assert.ok(Math.abs(faded.channels[0][mid] - unfaded.channels[0][mid] * fadeGain(mid / inN, 'scurve')) < 1e-7);
  const tail = Math.floor(outN / 3);
  assert.ok(Math.abs(faded.channels[1][n - 1 - tail] - unfaded.channels[1][n - 1 - tail] * fadeGain(tail / outN, 'linear')) < 1e-7);

  // Fading the source first would let the limiter react to the fade: it must not equal the real render.
  const preFaded = processChainOffline(applyFades(src, SR, FADES), SR, chain(), null);
  let maxDiff = 0;
  for (let i = 0; i < inN; i++) maxDiff = Math.max(maxDiff, Math.abs(preFaded.channels[0][i] - faded.channels[0][i]));
  assert.ok(maxDiff > 1e-3, `pre-chain fading would differ from post-chain fading (max diff ${maxDiff})`);
});

test('enabled Dynamic EQ cuts the loud band and boosts the quiet band in the export', async () => {
  const src = source();
  const withDeq = await renderMixedChain(src, SR, chain(), undefined, FADES);
  const withoutDeq = await renderMixedChain(src, SR, chain().filter((m) => m.type !== 'dynamic-eq'), undefined, FADES);
  const from = Math.floor(0.5 * SR);
  const to = Math.floor(1.0 * SR);
  const cut = toneDb(withDeq.channels[0], 1000, from, to) - toneDb(withoutDeq.channels[0], 1000, from, to);
  const boost = toneDb(withDeq.channels[0], 5000, from, to) - toneDb(withoutDeq.channels[0], 5000, from, to);
  assert.ok(cut < -1.5, `1 kHz must be cut (got ${cut.toFixed(2)} dB)`);
  assert.ok(boost > 0.5, `5 kHz must be boosted relative to the 1 kHz-dominated limiter (got ${boost.toFixed(2)} dB)`);
  const bypassed = chain().map((m) => (m.type === 'dynamic-eq' ? { ...m, bypassed: true } : m));
  const bypassOut = await renderMixedChain(src, SR, bypassed, undefined, FADES);
  assert.deepEqual(Array.from(bypassOut.channels[0]), Array.from(withoutDeq.channels[0]), 'bypassed Dynamic EQ is bit-identical to no Dynamic EQ');
});

test('16- and 24-bit PCM exports are valid and match the float render within one LSB', async () => {
  const src = source();
  const exported = await renderMixedChain(src, SR, chain(), undefined, FADES);
  for (const bits of [16, 24] as const) {
    const cfg: ExportConfig = { ...DEFAULT_EXPORT_CONFIG, format: 'wav', wavBitDepth: bits, sampleRate: SR as ExportConfig['sampleRate'], dither: 'none', channels: 'stereo', ceilingDb: 0 };
    const bytes = new Uint8Array(await encodeWavBlob(exported.channels, SR, cfg).arrayBuffer());
    const wav = parseWav(bytes);
    assert.equal(wav.bitsPerSample, bits);
    assert.equal(wav.frames, src[0].length);
    const lsb = bits === 24 ? 1 / 8388607 : 1 / 32767;
    let worst = 0;
    for (let c = 0; c < 2; c++) {
      for (let i = 0; i < wav.frames; i++) worst = Math.max(worst, Math.abs(wav.samples[c][i] - Math.max(-1, Math.min(1, exported.channels[c][i]))));
    }
    assert.ok(worst <= lsb * 0.51, `${bits}-bit quantisation error ${worst} must be within half an LSB`);
  }
});

function hasFfprobe(): boolean {
  try {
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('ffprobe accepts the exported WAV (format, channels, rate, duration)', { skip: hasFfprobe() ? false : 'ffprobe is not installed' }, async () => {
  const src = source();
  const exported = await renderMixedChain(src, SR, chain(), undefined, FADES);
  const dir = mkdtempSync(join(tmpdir(), 'syn-export-'));
  try {
    for (const bits of [16, 24, 32] as const) {
      const cfg: ExportConfig = { ...DEFAULT_EXPORT_CONFIG, format: 'wav', wavBitDepth: bits, sampleRate: SR as ExportConfig['sampleRate'], dither: 'none', channels: 'stereo', ceilingDb: 0 };
      const file = join(dir, `out${bits}.wav`);
      writeFileSync(file, new Uint8Array(await encodeWavBlob(exported.channels, SR, cfg).arrayBuffer()));
      const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8' }));
      const stream = probe.streams[0];
      assert.equal(stream.codec_name, bits === 32 ? 'pcm_f32le' : bits === 24 ? 'pcm_s24le' : 'pcm_s16le');
      assert.equal(stream.channels, 2);
      assert.equal(Number(stream.sample_rate), SR);
      assert.ok(Math.abs(Number(probe.format.duration) - SECONDS) < 1e-3, `duration ${probe.format.duration}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
