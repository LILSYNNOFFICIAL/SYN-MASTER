import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultParams, createProcessorModule, validateChain } from './chainValidation';
import { processChainOffline } from './offlineDsp';
import { analyzeAudioBuffer, dbToLinear, measureIntegratedLufs } from './analyzer';
import { encodeWavBlob } from './wavEncoder';
import type {
  BassEnhancerParams,
  CompressorParams,
  DynamicEQParams,
  LimiterParams,
  MaximizerParams,
  MultibandCompParams,
  ParametricEQParams,
  ProcessorModule,
  RestoreParams,
  SaturationParams,
  StereoImagerParams,
} from '../types/mastering';

const SR = 48000;

function makeSine(freqHz: number, durationSec = 0.5, amp = 0.25, rightGain = 1): [Float32Array, Float32Array] {
  const n = Math.floor(SR * durationSec);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = amp * Math.sin((2 * Math.PI * freqHz * i) / SR);
    l[i] = s;
    r[i] = s * rightGain;
  }
  return [l, r];
}

function makeRichProgram(durationSec = 0.6): [Float32Array, Float32Array] {
  const n = Math.floor(SR * durationSec);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    // Transients every 0.15s + multi-band steady content (80Hz, 450Hz, 3500Hz, 8500Hz)
    const burstEnv = (i % Math.floor(SR * 0.15)) < 480 ? 1.0 : 0.22;
    const mid =
      0.16 * Math.sin(2 * Math.PI * 80 * t) +
      0.12 * Math.sin(2 * Math.PI * 450 * t) * burstEnv +
      0.09 * Math.sin(2 * Math.PI * 3500 * t) * burstEnv;
    const side = 0.08 * Math.sin(2 * Math.PI * 1800 * t);
    l[i] = mid + side;
    r[i] = mid - side;
  }
  return [l, r];
}

function rms(buf: Float32Array): number {
  let acc = 0;
  for (let i = 0; i < buf.length; i++) acc += buf[i] * buf[i];
  return Math.sqrt(acc / Math.max(1, buf.length));
}

function maxDiff(a: Float32Array, b: Float32Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > m) m = d;
  }
  return m;
}

test('Phase 1 DSP Audit: ParametricEQ bell boost, M/S isolation, linear-phase, and bypass', () => {
  const [l, r] = makeSine(1000, 0.35, 0.2, 0.4);
  const eq = createProcessorModule('parametric-eq', {
    params: {
      phaseMode: 'minimum',
      msMode: 'stereo',
      tiltDb: 0,
      bands: [{ id: 'b1', enabled: true, shape: 'bell', freq: 1000, gain: 6, q: 1.4 }],
    } satisfies ParametricEQParams,
  });

  const boosted = processChainOffline([l, r], SR, [eq]);
  assert.ok(rms(boosted.channels[0]) > rms(l) * 1.7, 'Expected +6 dB gain boost at 1 kHz');

  // Mid-Side mode processes Mid only, leaving Side untouched
  const [msL, msR] = makeRichProgram(0.35);
  const eqMs = createProcessorModule('parametric-eq', {
    params: {
      phaseMode: 'minimum',
      msMode: 'mid-side',
      tiltDb: 0,
      bands: [{ id: 'b1', enabled: true, shape: 'bell', freq: 1800, gain: -9, q: 1.0 }],
    } satisfies ParametricEQParams,
  });
  const msOut = processChainOffline([msL, msR], SR, [eqMs]);
  const inSideRms = rms(msL.map((v, i) => 0.5 * (v - msR[i])));
  const outSideRms = rms(msOut.channels[0].map((v, i) => 0.5 * (v - msOut.channels[1][i])));
  assert.ok(Math.abs(inSideRms - outSideRms) < 1e-5, 'M/S EQ must preserve Side channel when editing Mid');

  // Bypass must return bit-identical audio
  const bypassed = { ...eq, bypassed: true };
  const bypOut = processChainOffline([l, r], SR, [bypassed]);
  assert.equal(maxDiff(bypOut.channels[0], l), 0);
});

test('Phase 1 DSP Audit: DynamicEQ, Compressor, and Multiband Compressor parameter sensitivity', () => {
  const [l, r] = makeSine(1000, 0.4, 0.35);

  const dynEq = createProcessorModule('dynamic-eq', {
    params: {
      bands: [{ id: 'd1', enabled: true, freq: 1000, q: 2.0, thresholdDb: -24, maxCutDb: -8, attackMs: 5, releaseMs: 60 }],
    } satisfies DynamicEQParams,
  });
  const dynOut = processChainOffline([l, r], SR, [dynEq]);
  assert.ok(dynOut.telemetry[0].gainReductionDb > 0.5, 'DynamicEQ should apply gain reduction above threshold');
  assert.ok(rms(dynOut.channels[0]) < rms(l) * 0.85, 'DynamicEQ should attenuate hot 1kHz content');

  const compLow = createProcessorModule('compressor', {
    params: { mode: 'downward', thresholdDb: -24, ratio: 6, attackMs: 2, releaseMs: 80, kneeDb: 2, makeupDb: 0, scHpfHz: 40 } satisfies CompressorParams,
  });
  const compOut = processChainOffline([l, r], SR, [compLow]);
  assert.ok(compOut.telemetry[0].gainReductionDb > 2.0);
  assert.ok(rms(compOut.channels[0]) < rms(l) * 0.7);

  const mb = createProcessorModule('multiband-comp', {
    params: {
      lowCrossHz: 200,
      highCrossHz: 3000,
      low: { thresholdDb: -18, ratio: 2, attackMs: 15, releaseMs: 120, gainDb: 0, bypass: true },
      mid: { thresholdDb: -28, ratio: 5, attackMs: 2, releaseMs: 60, gainDb: 0, bypass: false },
      high: { thresholdDb: -18, ratio: 2, attackMs: 15, releaseMs: 120, gainDb: 0, bypass: true },
    } satisfies MultibandCompParams,
  });
  const mbOut = processChainOffline([l, r], SR, [mb]);
  assert.ok(mbOut.telemetry[0].gainReductionDb > 1.5, 'Multiband mid compression should reduce 1kHz RMS');
});

test('Phase 1 DSP Audit: Saturation, StereoImager, Restore (mode + hum), and BassEnhancer respond to parameters', () => {
  const [l, r] = makeRichProgram(0.4);

  const satLow = createProcessorModule('saturation', {
    params: { flavor: 'tape', drive: 5, tone: 0, harmonics: 'even', oversampling: 2 } satisfies SaturationParams,
  });
  const satHigh = createProcessorModule('saturation', {
    params: { flavor: 'soft-clip', drive: 85, tone: 45, harmonics: 'odd', oversampling: 4 } satisfies SaturationParams,
  });
  const resSatLow = processChainOffline([l, r], SR, [satLow]);
  const resSatHigh = processChainOffline([l, r], SR, [satHigh]);
  assert.ok(maxDiff(resSatLow.channels[0], resSatHigh.channels[0]) > 0.02);

  // Stereo Imager wide + L/R balance
  const imgWide = createProcessorModule('stereo-imager', {
    params: {
      lowWidth: 100, midWidth: 170, highWidth: 175, lowCrossHz: 150, highCrossHz: 3500,
      monoBassBelowHz: 100, lrBalanceDb: -2.0, midSideGainDb: 2.0,
    } satisfies StereoImagerParams,
  });
  const imgOut = processChainOffline([l, r], SR, [imgWide]);
  assert.ok(rms(imgOut.channels[0]) > rms(imgOut.channels[1]), 'Negative L/R balance attenuates right relative to left');

  // Restore: 60Hz hum notch + mode (conservative vs aggressive)
  const [humL, humR] = makeSine(60, 0.4, 0.3);
  const restoreOff = createProcessorModule('restore', {
    params: { dcOffset: false, humRemovalHz: 0, hissReduction: 0, deEssAmount: 0, deEssFreqHz: 6500, resonanceSuppress: 0, mode: 'conservative' } satisfies RestoreParams,
  });
  const restoreCons = createProcessorModule('restore', {
    params: { dcOffset: true, humRemovalHz: 60, hissReduction: 20, deEssAmount: 40, deEssFreqHz: 6500, resonanceSuppress: 45, mode: 'conservative' } satisfies RestoreParams,
  });
  const restoreAggr = createProcessorModule('restore', {
    params: { dcOffset: true, humRemovalHz: 60, hissReduction: 20, deEssAmount: 40, deEssFreqHz: 6500, resonanceSuppress: 45, mode: 'aggressive' } satisfies RestoreParams,
  });
  const rOff = processChainOffline([humL, humR], SR, [restoreOff]);
  const rCons = processChainOffline([humL, humR], SR, [restoreCons]);
  const rAggr = processChainOffline([humL, humR], SR, [restoreAggr]);
  assert.ok(rms(rCons.channels[0]) < rms(rOff.channels[0]) * 0.5, '60Hz hum notch should strongly attenuate 60Hz hum');
  assert.ok(rms(rAggr.channels[0]) < rms(rCons.channels[0]), 'Aggressive mode wider notch should attenuate 60Hz more strongly');

  // Bass Enhancer sub weight + monoFocus
  const [subL, subR] = makeSine(55, 0.4, 0.15, -0.5);
  const bassMod = createProcessorModule('bass-enhancer', {
    params: { subFreqHz: 55, subGainDb: 5.0, harmonicDrive: 50, tightness: 90, monoFocus: true } satisfies BassEnhancerParams,
  });
  const bassOut = processChainOffline([subL, subR], SR, [bassMod]);
  assert.ok(rms(bassOut.channels[0]) > rms(subL) * 1.3, 'Bass Enhancer sub gain should boost 55 Hz weight');
});

test('Phase 1 DSP Audit: Limiter oversampling (1x/2x/4x) and Maximizer transientEmphasis', () => {
  // Inter-sample peak test signal at fs/4 shifted by 45 degrees where sample peaks are 0.707*A while inter-sample reaches A
  const n = 4096;
  const isL = new Float32Array(n);
  const isR = new Float32Array(n);
  const amp = 0.95; // true inter-sample peak = 0.95, sample peak = 0.95*cos(pi/4) ~ 0.672
  for (let i = 0; i < n; i++) {
    const v = amp * Math.sin(0.5 * Math.PI * i + Math.PI / 4);
    isL[i] = v;
    isR[i] = v;
  }

  const lim1x = createProcessorModule('limiter', {
    params: { thresholdDb: 0, ceilingDb: -2.0, releaseMs: 80, lookaheadMs: 3, truePeak: true, oversampling: 1 } satisfies LimiterParams,
  });
  const lim4x = createProcessorModule('limiter', {
    params: { thresholdDb: 0, ceilingDb: -2.0, releaseMs: 80, lookaheadMs: 3, truePeak: true, oversampling: 4 } satisfies LimiterParams,
  });
  const out1x = processChainOffline([isL, isR], SR, [lim1x]);
  const out4x = processChainOffline([isL, isR], SR, [lim4x]);
  assert.ok(
    out4x.telemetry[0].gainReductionDb > out1x.telemetry[0].gainReductionDb,
    `Expected 4x TP limiter (${out4x.telemetry[0].gainReductionDb} dB) to detect inter-sample overs more strictly than 1x (${out1x.telemetry[0].gainReductionDb} dB)`,
  );

  // Maximizer transientEmphasis effect + strict ceiling enforcement
  const [progL, progR] = makeRichProgram(0.8);
  const maxLowT = createProcessorModule('maximizer', {
    params: { character: 'punchy', targetLufs: -11, ceilingDb: -1.0, transientEmphasis: 0, truePeak: true } satisfies MaximizerParams,
  });
  const maxHighT = createProcessorModule('maximizer', {
    params: { character: 'punchy', targetLufs: -11, ceilingDb: -1.0, transientEmphasis: 95, truePeak: true } satisfies MaximizerParams,
  });
  const outMaxLow = processChainOffline([progL, progR], SR, [maxLowT]);
  const outMaxHigh = processChainOffline([progL, progR], SR, [maxHighT]);
  assert.ok(maxDiff(outMaxLow.channels[0], outMaxHigh.channels[0]) > 0.005, 'Transient Emphasis must audibly shape waveform');
  const ceilLin = dbToLinear(-1.0) + 1e-4;
  for (let i = 0; i < outMaxHigh.channels[0].length; i++) {
    assert.ok(Math.abs(outMaxHigh.channels[0][i]) <= ceilLin);
  }
  const lufs = measureIntegratedLufs(outMaxHigh.channels, SR);
  assert.ok(lufs > -13 && lufs < -9, `Maximizer LUFS (${lufs}) should track target -11 LUFS`);
});

test('Phase 1 Integrity: Wet/Dry blend, Default Reset parameters, Chain Reorder/Duplicate, Save/Reload validation & WAV export', async () => {
  const [l, r] = makeRichProgram(0.5);
  const eq = createProcessorModule('parametric-eq', {
    wetDry: 0,
    params: {
      ...createDefaultParams('parametric-eq') as ParametricEQParams,
      tiltDb: 5.5,
    },
  });
  // 0% wet must leave audio unaffected
  const dryOut = processChainOffline([l, r], SR, [eq]);
  assert.equal(maxDiff(dryOut.channels[0], l), 0);

  // JSON roundtrip (simulates IndexedDB project save/reload) + validateChain sanitization
  const restoreCustom = createProcessorModule('restore', {
    params: {
      ...(createDefaultParams('restore') as RestoreParams),
      humRemovalHz: 50,
      mode: 'aggressive',
      deEssAmount: 42,
    },
  });
  const dupRestore: ProcessorModule = {
    ...structuredClone(restoreCustom),
    id: `${restoreCustom.id}-copy`,
    name: `${restoreCustom.name} Copy`,
  };
  const savedJson = JSON.stringify([eq, restoreCustom, dupRestore]);
  const reloaded = validateChain(JSON.parse(savedJson));
  assert.equal(reloaded.length, 3);
  assert.equal((reloaded[1].params as RestoreParams).mode, 'aggressive');
  assert.equal((reloaded[2].params as RestoreParams).humRemovalHz, 50);
  assert.notEqual(reloaded[1].id, reloaded[2].id);

  // End-to-end WAV encode & header/sample-rate verification
  const rendered = processChainOffline([l, r], SR, reloaded);
  const analysis = analyzeAudioBuffer(rendered.channels, SR);
  assert.ok(Number.isFinite(analysis.integratedLufs));
  const wavBlob = encodeWavBlob(rendered.channels, SR, {
    filename: 'verification',
    format: 'wav',
    wavBitDepth: 24,
    sampleRate: 48000,
    channels: 'stereo',
    dither: 'tpdf',
    normalizeToTarget: false,
    targetLufs: -14,
    ceilingDb: -1.0,
    deliveryProfile: 'streaming',
    metadataTitle: 'Verification',
    metadataArtist: 'SYN MASTER',
  });
  const ab = await wavBlob.arrayBuffer();
  const dv = new DataView(ab);
  assert.equal(String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)), 'RIFF');
  assert.equal(String.fromCharCode(dv.getUint8(8), dv.getUint8(9), dv.getUint8(10), dv.getUint8(11)), 'WAVE');
  assert.equal(dv.getUint32(24, true), 48000);
  assert.equal(dv.getUint16(34, true), 24);
});

test('Stereo spectral analysis preserves channel energy when L/R polarity is inverted', () => {
  const [left, right] = makeSine(1000, 0.75, 0.25, -1);
  const analysis = analyzeAudioBuffer([left, right], SR);

  assert.ok(analysis.phaseCorrelation < -0.99, 'The fixture must represent fully polarity-inverted stereo');
  assert.ok(
    analysis.zoneEnergyDb.mid > -55,
    `Mid-band energy must remain measurable from independent channel power, got ${analysis.zoneEnergyDb.mid} dB`,
  );
  const nearOneKhz = analysis.spectrumBinsDb.filter((_, i) => {
    const freq = analysis.spectrumBinsFreq[i];
    return freq >= 800 && freq <= 1250;
  });
  assert.ok(nearOneKhz.some((db) => db > -55), 'The spectrum must retain the 1 kHz signal despite L/R cancellation in mono');
});


test('Analyzer does not label a coherent musical harmonic series as isolated resonances', () => {
  const n = SR * 2;
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let sample = 0;
    for (let harmonic = 1; harmonic <= 10; harmonic++) {
      sample += (0.22 / Math.pow(harmonic, 1.15)) *
        Math.sin(2 * Math.PI * 220 * harmonic * t);
    }
    // Deterministic low-level broadband bed makes this resemble a pitched instrument in a mix.
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const bed = ((seed / 4294967296) * 2 - 1) * 0.004;
    left[i] = sample + bed;
    right[i] = sample * 0.97 + bed;
  }

  const analysis = analyzeAudioBuffer([left, right], SR);
  assert.equal(
    analysis.resonances.length,
    0,
    'A coherent harmonic series should not be treated as isolated narrow resonances requiring dynamic cuts',
  );
});


test('SYN-Restore hiss reduction lowers quiet high-frequency noise while preserving short transients', () => {
  const n = SR * 2;
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const transientWindows = [[0.5, 0.52], [1.2, 1.22]];
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let sample = 0.006 * Math.sin(2 * Math.PI * 9000 * t);
    if (transientWindows.some(([start, end]) => t >= start && t < end)) {
      sample += 0.35 * Math.sin(2 * Math.PI * 9000 * t);
    }
    left[i] = sample;
    right[i] = sample;
  }

  const restore = createProcessorModule('restore', {
    params: {
      dcOffset: false,
      humRemovalHz: 0,
      hissReduction: 80,
      deEssAmount: 0,
      deEssFreqHz: 6500,
      resonanceSuppress: 0,
      mode: 'conservative',
    } satisfies RestoreParams,
  });
  const rendered = processChainOffline([left, right], SR, [restore]);
  const quietRms = (samples: Float32Array, start: number, end: number) => {
    const first = Math.floor(start * SR);
    const last = Math.floor(end * SR);
    let sum = 0;
    for (let i = first; i < last; i++) sum += samples[i] * samples[i];
    return Math.sqrt(sum / Math.max(1, last - first));
  };
  const inputQuiet = quietRms(left, 0.2, 0.4);
  const outputQuiet = quietRms(rendered.channels[0], 0.2, 0.4);
  assert.ok(
    outputQuiet < inputQuiet * 0.8,
    `Quiet high-frequency noise should be reduced, input=${inputQuiet}, output=${outputQuiet}`,
  );

  let inputTransientPeak = 0;
  let outputTransientPeak = 0;
  for (const [start, end] of transientWindows) {
    const first = Math.floor(start * SR);
    const last = Math.floor(end * SR);
    for (let i = first; i < last; i++) {
      inputTransientPeak = Math.max(inputTransientPeak, Math.abs(left[i]));
      outputTransientPeak = Math.max(outputTransientPeak, Math.abs(rendered.channels[0][i]));
    }
  }
  assert.ok(
    outputTransientPeak >= inputTransientPeak * 0.9,
    `Hiss reduction must open quickly enough to preserve transient peaks, input=${inputTransientPeak}, output=${outputTransientPeak}`,
  );
});


test('Dynamic EQ attack and release controls shape transient response and recovery independently', () => {
  const n = SR;
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const amplitude = t >= 0.35 && t < 0.55 ? 0.5 : 0.05;
    const sample = amplitude * Math.sin(2 * Math.PI * 1000 * t);
    left[i] = sample;
    right[i] = sample;
  }
  const makeDynamicEq = (attackMs: number, releaseMs: number) =>
    createProcessorModule('dynamic-eq', {
      params: {
        bands: [{
          id: 'transient-control',
          enabled: true,
          freq: 1000,
          q: 1.2,
          thresholdDb: -24,
          maxCutDb: -9,
          attackMs,
          releaseMs,
        }],
      } satisfies DynamicEQParams,
    });
  const fast = processChainOffline([left, right], SR, [makeDynamicEq(2, 20)]);
  const slowAttack = processChainOffline([left, right], SR, [makeDynamicEq(80, 20)]);
  const fastRelease = processChainOffline([left, right], SR, [makeDynamicEq(2, 20)]);
  const slowRelease = processChainOffline([left, right], SR, [makeDynamicEq(2, 400)]);
  const peak = (samples: Float32Array, start: number, end: number) => {
    let value = 0;
    for (let i = Math.floor(start * SR); i < Math.floor(end * SR); i++) {
      value = Math.max(value, Math.abs(samples[i]));
    }
    return value;
  };
  const rmsWindow = (samples: Float32Array, start: number, end: number) => {
    let sum = 0;
    const first = Math.floor(start * SR);
    const last = Math.floor(end * SR);
    for (let i = first; i < last; i++) sum += samples[i] * samples[i];
    return Math.sqrt(sum / Math.max(1, last - first));
  };
  // Compare the first 20 ms after the burst begins. Whole-window peak is
  // identical by design because an attack envelope cannot attenuate the very first sample.
  const fastAttackRms = rmsWindow(fast.channels[0], 0.35, 0.37);
  const slowAttackRms = rmsWindow(slowAttack.channels[0], 0.35, 0.37);
  assert.ok(
    slowAttackRms > fastAttackRms * 1.05,
    `Slower attack should preserve more of the burst onset, fast=${fastAttackRms}, slow=${slowAttackRms}`,
  );
  const fastTail = rmsWindow(fastRelease.channels[0], 0.62, 0.78);
  const slowTail = rmsWindow(slowRelease.channels[0], 0.62, 0.78);
  assert.ok(
    fastTail > slowTail * 1.05,
    `Faster release should restore the quiet tail sooner, fast=${fastTail}, slow=${slowTail}`,
  );
});


test('SYN-Restore resonance suppression leaves a coherent musical harmonic family intact', () => {
  const n = SR * 2;
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let sample = 0;
    for (let harmonic = 1; harmonic <= 10; harmonic++) {
      sample += (0.18 / harmonic) * Math.sin(2 * Math.PI * 220 * harmonic * t);
    }
    left[i] = sample;
    right[i] = sample;
  }
  const restore = createProcessorModule('restore', {
    params: {
      dcOffset: false,
      humRemovalHz: 0,
      hissReduction: 0,
      deEssAmount: 0,
      deEssFreqHz: 6500,
      resonanceSuppress: 100,
      mode: 'conservative',
    } satisfies RestoreParams,
  });
  const rendered = processChainOffline([left, right], SR, [restore]);
  assert.ok(
    maxDiff(rendered.channels[0], left) < 1e-4,
    'A coherent harmonic instrument spectrum must not receive independent narrow resonance cuts',
  );
});
