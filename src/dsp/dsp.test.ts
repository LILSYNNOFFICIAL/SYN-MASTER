import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMagnitudeSpectrumDb } from './fft';
import { analyzeAudioBuffer, dbToLinear, linearToDb, maxInterSampleAbsAt, measureIntegratedLufs } from './analyzer';
import { createProcessorModule, validateChain } from './chainValidation';
import { processChainOffline } from './offlineDsp';
import { QC_TARGET_PROFILES, runQualityControl } from './qc';
import { encodeWavBlob } from './wavEncoder';
import { generateDemoMasterStem } from './demoAudio';
import { buildAlgorithmicStrategy } from './presets';

function makeSineStereo(
  freqHz: number,
  amp: number,
  durationSec: number,
  sampleRate = 48000,
): [Float32Array, Float32Array] {
  const n = Math.round(sampleRate * durationSec);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = amp * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
    l[i] = v;
    r[i] = v;
  }
  return [l, r];
}

test('FFT detects exact frequency bin for 1000 Hz sine wave', () => {
  const sr = 48000;
  const fftSize = 4096;
  const [sine] = makeSineStereo(1000, 0.5, 0.2, sr);
  const magDb = computeMagnitudeSpectrumDb(sine.subarray(0, fftSize), fftSize);

  let peakBin = 0;
  let peakVal = -Infinity;
  for (let i = 1; i < magDb.length; i++) {
    if (magDb[i] > peakVal) {
      peakVal = magDb[i];
      peakBin = i;
    }
  }
  const detectedHz = (peakBin * sr) / fftSize;
  assert.ok(Math.abs(detectedHz - 1000) < 15, `Expected ~1000Hz, got ${detectedHz}`);
});

test('ITU-R BS.1770 LUFS & True Peak measurement on calibrated 1kHz sine', () => {
  const sr = 48000;
  const amp = dbToLinear(-18);
  const [l, r] = makeSineStereo(1000, amp, 2.0, sr);
  const analysis = analyzeAudioBuffer([l, r], sr);

  // Stereo correlated -18 dBFS sine: RMS is -18.0 - 3.01 = -21.01 dB per ch, stereo sum power is 2x (+3dB)
  // Minus 0.691 + K-weighting (~0dB @ 1kHz) -> ~ -18.7 LUFS
  assert.ok(
    analysis.integratedLufs > -20.5 && analysis.integratedLufs < -16.5,
    `Unexpected LUFS: ${analysis.integratedLufs}`,
  );
  assert.ok(
    Math.abs(analysis.samplePeakDb - -18.0) < 0.2,
    `Expected -18.0 dBFS peak, got ${analysis.samplePeakDb}`,
  );
  assert.ok(Math.abs(analysis.phaseCorrelation - 1.0) < 0.01);
});

test('Analyzer detects phase cancellation isolated to the high-frequency band', () => {
  const sr = 48000;
  const durationSec = 1.5;
  const n = Math.round(sr * durationSec);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const low = 0.22 * Math.sin((2 * Math.PI * 80 * i) / sr);
    const mid = 0.18 * Math.sin((2 * Math.PI * 1000 * i) / sr);
    const high = 0.16 * Math.sin((2 * Math.PI * 8000 * i) / sr);
    left[i] = low + mid + high;
    right[i] = low + mid - high;
  }

  const analysis = analyzeAudioBuffer([left, right], sr);
  assert.ok(analysis.phaseCorrelation > 0.2, 'Global correlation should hide this band-limited fault');
  assert.ok(analysis.lowEndCorrelation > 0.8, 'Low-frequency mono compatibility should remain healthy');
  assert.ok(
    analysis.stereoBandCorrelation,
    'Analyzer must expose separate low, mid, and high band correlation measurements',
  );
  assert.ok(analysis.stereoBandCorrelation.low > 0.8);
  assert.ok(analysis.stereoBandCorrelation.mid > 0.8);
  assert.ok(analysis.stereoBandCorrelation.high < -0.7);
  assert.ok(
    analysis.monoCompatibilityScore < 80,
    'Mono compatibility score must reflect severe localized high-band cancellation even when global correlation is positive',
  );
  const qc = runQualityControl(analysis, analysis, QC_TARGET_PROFILES[0]);
  const phaseCheck = qc.checks.find((check) => check.id === 'qc-phase');
  assert.equal(phaseCheck?.status, 'warning', 'Localized anti-phase high-frequency content must be surfaced for listening review');
  assert.match(phaseCheck?.explanation ?? '', /frequency band|band-limited/i);
});

test('Parametric EQ Bell Boost increases 1kHz level while HPF attenuates 40Hz', () => {
  const sr = 48000;
  const [l1k, r1k] = makeSineStereo(1000, 0.1, 1.0, sr);
  const [l40, r40] = makeSineStereo(40, 0.1, 1.0, sr);

  const eqMod = createProcessorModule('parametric-eq', {
    params: {
      phaseMode: 'minimum',
      msMode: 'stereo',
      tiltDb: 0,
      bands: [
        { id: 'hp', enabled: true, shape: 'highpass', freq: 150, gain: 0, q: 0.71 },
        { id: 'pk', enabled: true, shape: 'bell', freq: 1000, gain: 6.0, q: 1.4 },
      ],
    },
  });

  const out1k = processChainOffline([l1k, r1k], sr, [eqMod]);
  const a1k = analyzeAudioBuffer(out1k.channels, sr);
  const in1k = analyzeAudioBuffer([l1k, r1k], sr);
  assert.ok(
    a1k.rmsDb - in1k.rmsDb > 5.0 && a1k.rmsDb - in1k.rmsDb < 7.0,
    `Expected ~+6dB boost @ 1kHz, got ${a1k.rmsDb - in1k.rmsDb}`,
  );

  const out40 = processChainOffline([l40, r40], sr, [eqMod]);
  const a40 = analyzeAudioBuffer(out40.channels, sr);
  const in40 = analyzeAudioBuffer([l40, r40], sr);
  assert.ok(
    a40.rmsDb - in40.rmsDb < -12,
    `Expected strong 40Hz attenuation from 150Hz HPF, got ${a40.rmsDb - in40.rmsDb}`,
  );
});

test('True Peak Limiter clamps output strictly below ceiling dBTP', () => {
  const sr = 48000;
  const [l, r] = makeSineStereo(440, 0.9, 1.0, sr);
  const limiter = createProcessorModule('limiter', {
    params: {
      ceilingDb: -1.5,
      thresholdDb: -8.0,
      releaseMs: 80,
      lookaheadMs: 3,
      truePeak: true,
      oversampling: 4,
    },
  });

  const res = processChainOffline([l, r], sr, [limiter]);
  const post = analyzeAudioBuffer(res.channels, sr);
  assert.ok(
    post.truePeakDb <= -1.4,
    `Expected True Peak <= -1.4 dBTP, got ${post.truePeakDb}`,
  );
  assert.equal(post.clippedSamples, 0);
  assert.ok(res.telemetry[0].gainReductionDb > 2.0);
});

test('Stereo Imager mono width (0%) collapses stereo difference to mono', () => {
  const sr = 48000;
  const n = sr;
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    l[i] = 0.3 * Math.sin((2 * Math.PI * 500 * i) / sr);
    r[i] = 0.3 * Math.cos((2 * Math.PI * 750 * i) / sr);
  }
  const imager = createProcessorModule('stereo-imager', {
    params: {
      lowWidth: 0,
      midWidth: 0,
      highWidth: 0,
      lowCrossHz: 150,
      highCrossHz: 3500,
      monoBassBelowHz: 100,
      lrBalanceDb: 0,
      midSideGainDb: 0,
    },
  });

  const res = processChainOffline([l, r], sr, [imager]);
  const post = analyzeAudioBuffer(res.channels, sr);
  assert.ok(post.phaseCorrelation > 0.99, `Expected correlation ~1.0, got ${post.phaseCorrelation}`);
});

test('Stereo Imager width processing preserves intended L/R energy balance', () => {
  const sr = 44100;
  const n = Math.floor(sr * 1.2);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const subL = 0.55 * Math.sin(2 * Math.PI * 62 * t);
    const subR = 0.55 * Math.sin(2 * Math.PI * 62 * t + 2.25);
    const mids = 0.24 * Math.sin(2 * Math.PI * 820 * t) + 0.14 * Math.sin(2 * Math.PI * 2600 * t);
    left[i] = 0.32 * (subL + mids);
    right[i] = 0.32 * (subR + mids);
  }
  const imager = createProcessorModule('stereo-imager', {
    params: {
      lowWidth: 55,
      midWidth: 114,
      highWidth: 124,
      lowCrossHz: 150,
      highCrossHz: 3500,
      monoBassBelowHz: 115,
      lrBalanceDb: 0,
      midSideGainDb: 0,
    },
  });
  const result = processChainOffline([left, right], sr, [imager]);
  const post = analyzeAudioBuffer(result.channels, sr);
  assert.ok(
    Math.abs(post.lrBalanceDb) <= 0.15,
    `Stereo width processing introduced unintended L/R skew: ${post.lrBalanceDb.toFixed(2)} dB`,
  );
});

test('Bypass & 0% Wet/Dry preserve original audio bit-identically', () => {
  const sr = 44100;
  const stem = generateDemoMasterStem('main-mix', sr, 2);
  const compBypassed = createProcessorModule('compressor', { bypassed: true });
  const satDry = createProcessorModule('saturation', { wetDry: 0 });

  const res = processChainOffline(stem.channels, sr, [compBypassed, satDry]);
  let maxDiff = 0;
  for (let i = 0; i < stem.channels[0].length; i++) {
    maxDiff = Math.max(maxDiff, Math.abs(res.channels[0][i] - stem.channels[0][i]));
  }
  assert.ok(maxDiff < 1e-6, `Expected zero difference when bypassed/dry, got ${maxDiff}`);
});

test('Chain validator clamps unsafe AI parameters and rejects unknown types', () => {
  const dirty = [
    { type: 'unknown-fake-plugin', params: {} },
    {
      type: 'parametric-eq',
      intensity: 999,
      inputGainDb: 80,
      params: {
        bands: [{ shape: 'bell', freq: 50000, gain: 45, q: 0.01 }],
      },
    },
    {
      type: 'limiter',
      params: { ceilingDb: 6.0, thresholdDb: -99 },
    },
  ];
  const clean = validateChain(dirty);
  assert.equal(clean.length, 2);
  assert.equal(clean[0].intensity, 100);
  assert.equal(clean[0].inputGainDb, 12);
  const eqBands = (clean[0].params as { bands: Array<{ freq: number; gain: number; q: number }> }).bands;
  assert.ok(eqBands[0].freq <= 19500);
  assert.ok(eqBands[0].gain <= 12);
  assert.ok(eqBands[0].q >= 0.25);
  const lim = clean[1].params as { ceilingDb: number; thresholdDb: number };
  assert.ok(lim.ceilingDb <= -0.1);
  assert.ok(lim.thresholdDb >= -18);
});

test('Maximizer attenuates sources already louder than the requested LUFS target', () => {
  const sr = 48000;
  const [left, right] = makeSineStereo(1000, 0.5, 2.0, sr);
  const before = analyzeAudioBuffer([left, right], sr);
  const targetLufs = before.integratedLufs - 8;
  const maximizer = createProcessorModule('maximizer', {
    params: {
      character: 'transparent',
      targetLufs,
      ceilingDb: -1,
      transientEmphasis: 0,
      truePeak: true,
    },
  });

  const rendered = processChainOffline([left, right], sr, [maximizer]);
  const after = analyzeAudioBuffer(rendered.channels, sr);

  assert.ok(
    after.integratedLufs < before.integratedLufs - 7.5,
    `Expected maximizer to attenuate by about 8 LU, got ${(after.integratedLufs - before.integratedLufs).toFixed(2)} LU`,
  );
  assert.ok(
    Math.abs(after.integratedLufs - targetLufs) < 0.5,
    `Expected ${targetLufs.toFixed(1)} LUFS, got ${after.integratedLufs.toFixed(1)} LUFS`,
  );
  assert.ok(after.truePeakDb <= -0.95, `True peak exceeded ceiling: ${after.truePeakDb} dBTP`);
  assert.equal(after.clippedSamples, 0);
});

test('Algorithmic mastering + SYN-QC + 24-bit WAV export pipeline succeeds end-to-end', () => {
  const stem = generateDemoMasterStem('main-mix', 44100, 3);
  const preAnalysis = analyzeAudioBuffer(stem.channels, stem.sampleRate);
  const strategy = buildAlgorithmicStrategy(preAnalysis, 'streaming', -14);
  const processed = processChainOffline(stem.channels, stem.sampleRate, strategy.chain);
  const postAnalysis = analyzeAudioBuffer(processed.channels, stem.sampleRate);

  // Post-master should be louder than unmastered demo and free of clipping
  assert.ok(postAnalysis.integratedLufs > preAnalysis.integratedLufs);
  assert.equal(postAnalysis.clippedSamples, 0);
  assert.ok(postAnalysis.truePeakDb <= -0.9);

  const qc = runQualityControl(preAnalysis, postAnalysis, QC_TARGET_PROFILES[0]);
  assert.ok(qc.passedCount >= 5, `Expected >=5 QC passes, got ${qc.passedCount}`);

  const wavBlob = encodeWavBlob(processed.channels, stem.sampleRate, {
    filename: 'test-master',
    format: 'wav',
    wavBitDepth: 24,
    sampleRate: 44100,
    channels: 'stereo',
    dither: 'tpdf',
    normalizeToTarget: false,
    targetLufs: -14,
    ceilingDb: -1.0,
    deliveryProfile: 'streaming',
    metadataTitle: 'Test',
    metadataArtist: 'SYN',
  });
  // 44-byte RIFF header + 3s * 44100 * 2ch * 3bytes = 793844 bytes
  assert.equal(wavBlob.size, 44 + stem.channels[0].length * 2 * 3);
});

test('optimized true-peak candidate pruning matches exhaustive scanning at reported precision', () => {
  const sr = 48000;
  const length = 24000;
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  let state = 0x12345678;
  for (let i = 0; i < length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    left[i] = ((state >>> 0) / 0xffffffff) * 1.8 - 0.9;
    right[i] = 0.72 * Math.sin((2 * Math.PI * 0.247 * i)) + 0.025 * left[i];
  }

  const referenceChannel = (samples: Float32Array): { peak: number; interSamplePeaks: number } => {
    let peak = 0;
    let interSamplePeaks = 0;
    for (let i = 0; i < samples.length; i++) {
      peak = Math.max(peak, Math.abs(samples[i]));
      if (i + 1 < samples.length) {
        const interpolated = maxInterSampleAbsAt(samples, i);
        peak = Math.max(peak, interpolated);
        if (interpolated > 1 && Math.max(Math.abs(samples[i]), Math.abs(samples[i + 1])) <= 1) {
          interSamplePeaks++;
        }
      }
    }
    return { peak, interSamplePeaks };
  };

  const expectedLeft = referenceChannel(left);
  const expectedRight = referenceChannel(right);
  const expected = Math.max(expectedLeft.peak, expectedRight.peak);
  const actual = analyzeAudioBuffer([left, right], sr);
  const expectedDb = linearToDb(expected);
  assert.ok(
    Math.abs(actual.truePeakDb - expectedDb) < 0.0051,
    `Optimized true peak ${actual.truePeakDb} dBTP differed from full scan ${expectedDb} dBTP`,
  );
  assert.equal(
    actual.interSamplePeaks,
    expectedLeft.interSamplePeaks + expectedRight.interSamplePeaks,
    'Inter-sample peak event count must match exhaustive polyphase scanning',
  );
});


test('stereo analyzer bounds full-track Float32 scratch allocations', () => {
  const sr = 48000;
  const length = sr;
  const [left, right] = makeSineStereo(1000, dbToLinear(-18), 1, sr);
  const OriginalFloat32Array = globalThis.Float32Array;
  let fullTrackAllocations = 0;

  globalThis.Float32Array = new Proxy(OriginalFloat32Array, {
    construct(target, args, newTarget) {
      if (args[0] === length) fullTrackAllocations++;
      return Reflect.construct(target, args, newTarget);
    },
  });

  let analysis: ReturnType<typeof analyzeAudioBuffer>;
  try {
    analysis = analyzeAudioBuffer([left, right], sr);
  } finally {
    globalThis.Float32Array = OriginalFloat32Array;
  }

  assert.ok(
    fullTrackAllocations <= 2,
    `Expected at most two full-track Float32 scratch buffers, allocated ${fullTrackAllocations}`,
  );
  assert.ok(
    analysis.integratedLufs > -20.5 && analysis.integratedLufs < -16.5,
    `Scratch reuse changed calibrated LUFS: ${analysis.integratedLufs}`,
  );
  assert.ok(Math.abs(analysis.phaseCorrelation - 1) < 0.01);
});


test('standalone integrated loudness measurement bounds full-track Float32 scratch allocations', () => {
  const sr = 48000;
  const length = sr;
  const [left, right] = makeSineStereo(1000, dbToLinear(-18), 1, sr);
  const OriginalFloat32Array = globalThis.Float32Array;
  let fullTrackAllocations = 0;

  globalThis.Float32Array = new Proxy(OriginalFloat32Array, {
    construct(target, args, newTarget) {
      if (args[0] === length) fullTrackAllocations++;
      return Reflect.construct(target, args, newTarget);
    },
  });

  let integratedLufs: number;
  try {
    integratedLufs = measureIntegratedLufs([left, right], sr);
  } finally {
    globalThis.Float32Array = OriginalFloat32Array;
  }

  assert.ok(
    fullTrackAllocations <= 2,
    `Expected at most two full-track Float32 scratch buffers, allocated ${fullTrackAllocations}`,
  );
  assert.ok(
    integratedLufs > -20.5 && integratedLufs < -16.5,
    `Scratch reuse changed calibrated integrated LUFS: ${integratedLufs}`,
  );
});

test('Click detector covers the first and last ~3 ms; de-click repairs edge clicks with a micro-fade', async () => {
  const { detectClicks } = await import('./clickDetect');
  const { applyRepair } = await import('./repair');
  const sr = 48000;
  const n = sr;
  const mk = () => {
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = 0.2 * Math.sin((2 * Math.PI * 220 * i) / sr + 0.3);
    return a;
  };
  const L = mk();
  const R = mk();
  L[48] += 0.4; // click 1 ms in
  R[48] += 0.4;
  const before = detectClicks([L, R], sr);
  assert.equal(before.startClick, true);
  assert.equal(before.endClick, true, 'file cut off mid-waveform must count as an end click');
  applyRepair(L, R, sr, { declick: 80 });
  const after = detectClicks([L, R], sr);
  assert.equal(after.startClick, false);
  assert.equal(after.endClick, false);
  assert.equal(after.clickCount, 0);
});
test('Lookahead limiter bounded-window deque matches the previous sample-peak reference render', () => {
  const sr = 48000;
  const [sourceL, sourceR] = makeSineStereo(440, 0.72, 0.4, sr);
  for (let i = 0; i < sourceL.length; i++) {
    const transient = i % 4096 < 18 ? 0.22 : 0;
    sourceL[i] += transient;
    sourceR[i] -= transient * 0.83;
  }
  const ceilingDb = -1.5;
  const thresholdDb = -6;
  const releaseMs = 65;
  const lookaheadMs = 2.5;
  const ceilingLin = dbToLinear(ceilingDb);
  const driveLin = dbToLinear(-thresholdDb);
  const n = sourceL.length;
  const drivenL = new Float32Array(n);
  const drivenR = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    drivenL[i] = sourceL[i] * driveLin;
    drivenR[i] = sourceR[i] * driveLin;
  }
  const required = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const peak = Math.max(Math.abs(drivenL[i]), Math.abs(drivenR[i]));
    required[i] = peak > ceilingLin ? ceilingLin / peak : 1;
  }
  const lookSamples = Math.max(1, Math.min(512, Math.round((lookaheadMs / 1000) * sr)));
  const held = new Float64Array(n);
  const deque = new Int32Array(n + lookSamples);
  let head = 0;
  let tail = 0;
  for (let j = 0; j < n + lookSamples - 1; j++) {
    if (j < n) {
      while (tail > head && required[deque[tail - 1]] >= required[j]) tail--;
      deque[tail++] = j;
    }
    const i = j - lookSamples + 1;
    if (i >= 0 && i < n) {
      while (deque[head] < i) head++;
      held[i] = required[deque[head]];
    }
  }
  const expectedL = new Float32Array(n);
  const expectedR = new Float32Array(n);
  const relCoeff = Math.exp(-1 / Math.max(1, (releaseMs / 1000) * sr));
  let runSum = 0;
  let gain = 1;
  for (let i = 0; i < n; i++) {
    runSum += held[i];
    if (i >= lookSamples) runSum -= held[i - lookSamples];
    const count = Math.min(i + 1, lookSamples);
    const attackGain = (runSum + (lookSamples - count) * held[0]) / lookSamples;
    const target = attackGain;
    gain = target < gain ? target : Math.min(target, gain * relCoeff + target * (1 - relCoeff));
    expectedL[i] = Math.max(-ceilingLin, Math.min(ceilingLin, drivenL[i] * gain));
    expectedR[i] = Math.max(-ceilingLin, Math.min(ceilingLin, drivenR[i] * gain));
  }

  const limiter = createProcessorModule('limiter', {
    params: { ceilingDb, thresholdDb, releaseMs, lookaheadMs, truePeak: false, oversampling: 1 },
  });
  const actual = processChainOffline([sourceL, sourceR], sr, [limiter]).channels;
  let maxDiff = 0;
  for (let i = 0; i < n; i++) {
    maxDiff = Math.max(maxDiff, Math.abs(actual[0][i] - expectedL[i]), Math.abs(actual[1][i] - expectedR[i]));
  }
  assert.ok(maxDiff <= 1e-7, `Bounded lookahead implementation diverged from reference by ${maxDiff}`);
});


test('Zero-wet multiband and limiter modules still receive their required reusable scratch buffers', () => {
  const sr = 44100;
  const [left, right] = makeSineStereo(220, 0.55, 0.15, sr);
  const zeroWetMultiband = createProcessorModule('multiband-comp', { wetDry: 0 });
  const zeroWetMultibandMax = createProcessorModule('multiband-maximizer', { wetDry: 0 });
  const zeroWetLimiter = createProcessorModule('limiter', { wetDry: 0 });

  assert.doesNotThrow(() => processChainOffline([left, right], sr, [zeroWetMultiband]));
  assert.doesNotThrow(() => processChainOffline([left, right], sr, [zeroWetMultibandMax]));
  assert.doesNotThrow(() => processChainOffline([left, right], sr, [zeroWetLimiter]));
});

test('Multiband compressor and maximizer process multiple bounded chunks without boundary artifacts', () => {
  const sr = 48000;
  const [left, right] = makeSineStereo(330, 0.42, 1.25, sr);
  for (let i = 0; i < left.length; i++) {
    const t = i / sr;
    const bass = 0.12 * Math.sin(2 * Math.PI * 72 * t);
    const air = 0.07 * Math.sin(2 * Math.PI * 5400 * t);
    left[i] += bass + air;
    right[i] += bass * 0.96 + air * 0.91;
  }

  for (const module of [
    createProcessorModule('multiband-comp'),
    createProcessorModule('multiband-maximizer'),
  ]) {
    const first = processChainOffline([left, right], sr, [module]).channels;
    const second = processChainOffline([left, right], sr, [module]).channels;
    assert.equal(first[0].length, left.length);
    assert.equal(first[1].length, right.length);

    for (let i = 0; i < left.length; i++) {
      assert.ok(Number.isFinite(first[0][i]) && Number.isFinite(first[1][i]), 'Output samples must remain finite');
      assert.equal(first[0][i], second[0][i], 'Repeated left-channel renders must be deterministic');
      assert.equal(first[1][i], second[1][i], 'Repeated right-channel renders must be deterministic');
    }

    for (let boundary = 8192; boundary < left.length; boundary += 8192) {
      const leftStep = Math.abs(first[0][boundary] - first[0][boundary - 1]);
      const rightStep = Math.abs(first[1][boundary] - first[1][boundary - 1]);
      assert.ok(leftStep < 0.5, `Unexpected left discontinuity at chunk boundary ${boundary}: ${leftStep}`);
      assert.ok(rightStep < 0.5, `Unexpected right discontinuity at chunk boundary ${boundary}: ${rightStep}`);
    }
  }
});


test('Limiter wet/dry blending keeps a separate dry snapshot while reusing its limiter scratch pair', () => {
  const sr = 48000;
  const [left, right] = makeSineStereo(440, 0.92, 0.35, sr);
  const params = { ceilingDb: -1.5, thresholdDb: -7, releaseMs: 70, lookaheadMs: 3, truePeak: false, oversampling: 1 };
  const wet = processChainOffline([left, right], sr, [
    createProcessorModule('limiter', { params, wetDry: 100 }),
  ]).channels;
  const half = processChainOffline([left, right], sr, [
    createProcessorModule('limiter', { params, wetDry: 50 }),
  ]).channels;

  for (let i = 0; i < left.length; i++) {
    assert.ok(Math.abs(half[0][i] - (left[i] * 0.5 + wet[0][i] * 0.5)) < 1e-7);
    assert.ok(Math.abs(half[1][i] - (right[i] * 0.5 + wet[1][i] * 0.5)) < 1e-7);
  }
});
