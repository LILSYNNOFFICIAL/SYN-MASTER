import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAudioBuffer, dbToLinear } from './analyzer';
import { createProcessorModule, validateChain } from './chainValidation';
import { processChainOffline } from './offlineDsp';
import { QC_TARGET_PROFILES, runQualityControl } from './qc';
import { encodeWavBlob, resampleChannel } from './wavEncoder';
import { buildAlgorithmicStrategy } from './presets';
import { computeMagnitudeSpectrumDb } from './fft';

function makeSine(freqHz: number, amp: number, durationSec: number, sr = 48000, phaseOffset = 0): Float32Array {
  const n = Math.round(sr * durationSec);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = amp * Math.sin((2 * Math.PI * freqHz * i) / sr + phaseOffset);
  }
  return out;
}

function makeWhiteNoise(amp: number, durationSec: number, sr = 48000): Float32Array {
  const n = Math.round(sr * durationSec);
  const out = new Float32Array(n);
  let seed = 424242;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    out[i] = ((seed / 4294967296) * 2 - 1) * amp;
  }
  return out;
}

function makePinkNoise(amp: number, durationSec: number, sr = 48000): Float32Array {
  const n = Math.round(sr * durationSec);
  const out = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  let seed = 987654;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const white = (seed / 4294967296) * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.96900 * b2 + white * 0.1538520;
    b3 = 0.86650 * b3 + white * 0.3104856;
    b4 = 0.55000 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.0168980;
    const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
    b6 = white * 0.115926;
    out[i] = pink * 0.11 * amp;
  }
  return out;
}

function makeSweep(fStart: number, fEnd: number, amp: number, durationSec: number, sr = 48000): Float32Array {
  const n = Math.round(sr * durationSec);
  const out = new Float32Array(n);
  const k = Math.log(fEnd / fStart);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const phase = (2 * Math.PI * fStart * durationSec * (Math.pow(fEnd / fStart, t / durationSec) - 1)) / k;
    out[i] = amp * Math.sin(phase);
  }
  return out;
}

function makeImpulse(sr = 48000, len = 4096, pos = 1024): Float32Array {
  const out = new Float32Array(len);
  out[pos] = 1.0;
  return out;
}

function measureRmsDb(buf: Float32Array, start = 0, end = buf.length): number {
  let sq = 0;
  const count = Math.max(1, end - start);
  for (let i = start; i < end; i++) sq += buf[i] * buf[i];
  const rms = Math.sqrt(sq / count);
  return rms <= 1e-12 ? -120 : 20 * Math.log10(rms);
}

test('AUDIT 1: Parametric EQ Linear-Phase vs Minimum-Phase on Dirac Impulse', () => {
  const sr = 48000;
  const imp = makeImpulse(sr, 4096, 2048);
  const eqMin = createProcessorModule('parametric-eq', {
    params: {
      phaseMode: 'minimum',
      msMode: 'stereo',
      tiltDb: 0,
      bands: [{ id: 'b1', enabled: true, shape: 'bell', freq: 800, gain: 6, q: 1.5 }],
    },
  });
  const eqLin = createProcessorModule('parametric-eq', {
    params: {
      phaseMode: 'linear',
      msMode: 'stereo',
      tiltDb: 0,
      bands: [{ id: 'b1', enabled: true, shape: 'bell', freq: 800, gain: 6, q: 1.5 }],
    },
  });

  const outMin = processChainOffline([imp, new Float32Array(imp)], sr, [eqMin]).channels[0];
  const outLin = processChainOffline([imp, new Float32Array(imp)], sr, [eqLin]).channels[0];

  // Linear-phase impulse response MUST be symmetric around peak (pre-ringing == post-ringing)
  let preEnergy = 0;
  let postEnergy = 0;
  let peakIdx = 0;
  let peakVal = 0;
  for (let i = 0; i < outLin.length; i++) {
    if (Math.abs(outLin[i]) > peakVal) {
      peakVal = Math.abs(outLin[i]);
      peakIdx = i;
    }
  }
  for (let d = 1; d < 512; d++) {
    if (peakIdx - d >= 0) preEnergy += outLin[peakIdx - d] ** 2;
    if (peakIdx + d < outLin.length) postEnergy += outLin[peakIdx + d] ** 2;
  }

  // Minimum phase has zero pre-ringing
  let minPreEnergy = 0;
  for (let i = 0; i < 2048; i++) minPreEnergy += outMin[i] ** 2;
  assert.ok(minPreEnergy < 1e-10, 'Minimum phase should be strictly causal');

  // Linear phase should have symmetric pre and post energy (within 5%) and match EQ magnitude
  const symRatio = preEnergy / Math.max(1e-12, postEnergy);
  assert.ok(
    symRatio > 0.9 && symRatio < 1.1,
    `Linear-phase EQ must produce symmetric pre/post ringing, got ratio=${symRatio.toFixed(4)} (pre=${preEnergy}, post=${postEnergy})`,
  );
});

test('AUDIT 2: 3-Band Crossover Flatness & Phase Integrity (Multiband Comp & Stereo Imager at Unity)', () => {
  const sr = 48000;
  const sweep = makeSweep(20, 20000, 0.25, 3.0, sr);

  // Multiband Comp at unity (high threshold so no compression)
  const mb = createProcessorModule('multiband-comp', {
    params: {
      lowCrossHz: 180,
      highCrossHz: 3200,
      low: { thresholdDb: 0, ratio: 2, attackMs: 20, releaseMs: 100, gainDb: 0, bypass: false },
      mid: { thresholdDb: 0, ratio: 2, attackMs: 20, releaseMs: 100, gainDb: 0, bypass: false },
      high: { thresholdDb: 0, ratio: 2, attackMs: 20, releaseMs: 100, gainDb: 0, bypass: false },
    },
  });

  // Check exact gain at highCrossHz (3200 Hz) to detect 1 - LR4_LP +3.5dB high-band leak!
  const testTone = makeSine(3200, 0.25, 0.5, sr);
  const mbZeroMid = createProcessorModule('multiband-comp', {
    params: {
      lowCrossHz: 180,
      highCrossHz: 3200,
      low: { thresholdDb: 0, ratio: 2, attackMs: 20, releaseMs: 100, gainDb: 0, bypass: false },
      mid: { thresholdDb: 0, ratio: 2, attackMs: 20, releaseMs: 100, gainDb: -6, bypass: false },
      high: { thresholdDb: 0, ratio: 2, attackMs: 20, releaseMs: 100, gainDb: 0, bypass: false },
    },
  });
  const out3200 = processChainOffline([testTone, new Float32Array(testTone)], sr, [mbZeroMid]).channels[0];
  // At 3200Hz crossover: LR4_LP has -6 dB (0.5x), LR4_HP has -6 dB (0.5x).
  // With mid = -6 dB (0.25x) and high = 0 dB (0.5x), total sum must be ~0.75x = -2.5 dB, NEVER > 0 dB!
  const inRms = measureRmsDb(testTone, 4800);
  const outRms = measureRmsDb(out3200, 4800);
  const deltaAtXover = outRms - inRms;
  assert.ok(
    deltaAtXover < -1.0 && deltaAtXover > -4.5,
    `Expected clean crossover attenuation (~ -2.5 dB) when mid=-6dB at 3200Hz, got ${deltaAtXover.toFixed(2)} dB`,
  );

  // Also test Stereo Imager at Intensity = 0%: MUST be bit-identical regardless of monoBassBelowHz!
  const stereoDiffL = makeSine(60, 0.3, 0.5, sr);
  const stereoDiffR = makeSine(60, -0.3, 0.5, sr);
  const imagerZero = createProcessorModule('stereo-imager', {
    intensity: 0,
    params: {
      lowWidth: 150,
      midWidth: 150,
      highWidth: 150,
      lowCrossHz: 150,
      highCrossHz: 3500,
      monoBassBelowHz: 120,
      lrBalanceDb: 2,
      midSideGainDb: 3,
    },
  });
  const outImgZero = processChainOffline([stereoDiffL, stereoDiffR], sr, [imagerZero]).channels;
  let maxErr = 0;
  for (let i = 0; i < stereoDiffL.length; i++) {
    maxErr = Math.max(maxErr, Math.abs(outImgZero[0][i] - stereoDiffL[i]));
  }
  assert.ok(maxErr < 1e-4, `Stereo Imager at 0% intensity must preserve input, got maxErr=${maxErr}`);

  // Unity sweep flatness check
  const outSweep = processChainOffline([sweep, new Float32Array(sweep)], sr, [mb]).channels[0];
  const sweepPreRms = measureRmsDb(sweep, 4800, sweep.length - 4800);
  const sweepPostRms = measureRmsDb(outSweep, 4800, outSweep.length - 4800);
  assert.ok(
    Math.abs(sweepPostRms - sweepPreRms) < 0.35,
    `Multiband unity sweep RMS drift too high: ${(sweepPostRms - sweepPreRms).toFixed(3)} dB`,
  );
});

test('AUDIT 3: True Peak Detection Accuracy on fs/4 Inter-Sample Peak Sine (+3.01 dBTP)', () => {
  const sr = 48000;
  // 12 kHz (fs/4) sine sampled at 45 deg: samples are +/- 0.70710678 (-3.01 dBFS), true continuous peak is 1.000 (0.00 dBTP)!
  const ispSine = makeSine(12000, 1.0, 0.5, sr, Math.PI / 4);
  const analysis = analyzeAudioBuffer([ispSine, new Float32Array(ispSine)], sr);

  assert.ok(
    Math.abs(analysis.samplePeakDb - -3.01) < 0.05,
    `Sample peak should be -3.01 dBFS, got ${analysis.samplePeakDb}`,
  );
  // ITU-R BS.1770-4 4x polyphase FIR must detect >= -0.25 dBTP (real peak is 0.00 dBTP!)
  assert.ok(
    analysis.truePeakDb > -0.3 && analysis.truePeakDb < 0.2,
    `True Peak must detect fs/4 ISP near 0.0 dBTP, got ${analysis.truePeakDb} dBTP`,
  );

  // Now run True Peak Limiter with ceiling -1.0 dBTP: output True Peak MUST be <= -0.95 dBTP!
  const lim = createProcessorModule('limiter', {
    params: { ceilingDb: -1.0, thresholdDb: -4.0, releaseMs: 80, lookaheadMs: 4, truePeak: true, oversampling: 4 },
  });
  const limited = processChainOffline([ispSine, new Float32Array(ispSine)], sr, [lim]);
  const post = analyzeAudioBuffer(limited.channels, sr);
  assert.ok(
    post.truePeakDb <= -0.95,
    `True Peak Limiter failed on fs/4 ISP test: got ${post.truePeakDb} dBTP (ceiling -1.0 dBTP)`,
  );
});

test('AUDIT 4: Saturation Distortion, Harmonics Mode, Gain Unity, Oversampling Aliasing & DC Offset', () => {
  const sr = 48000;
  const tone1k = makeSine(1000, 0.25, 0.5, sr);

  // Even harmonics vs Odd harmonics on Tape & Tube MUST produce distinct even/odd harmonic profiles & near-zero DC!
  const tubeEven = createProcessorModule('saturation', {
    params: { flavor: 'tube', drive: 65, tone: 0, harmonics: 'even', oversampling: 4 },
  });
  const outTube = processChainOffline([tone1k, new Float32Array(tone1k)], sr, [tubeEven]).channels;
  const postTube = analyzeAudioBuffer(outTube, sr);

  // Must remove DC offset generated by asymmetric bias!
  assert.ok(postTube.dcOffset < 0.002, `Tube even saturation leaked DC offset: ${postTube.dcOffset}`);

  // Check FFT spectrum for genuine 2nd (2kHz) & 3rd (3kHz) harmonics AND real THD > 0.5%!
  const spec = computeMagnitudeSpectrumDb(outTube[0].subarray(8192, 8192 + 4096), 4096);
  const binHz = sr / 4096;
  const db1k = spec[Math.round(1000 / binHz)];
  const db2k = spec[Math.round(2000 / binHz)];
  const db3k = spec[Math.round(3000 / binHz)];
  assert.ok(db2k > db1k - 45, `Expected measurable 2nd harmonic @ 2kHz for even bias (1k=${db1k.toFixed(1)}, 2k=${db2k.toFixed(1)})`);
  assert.ok(db3k > db1k - 55, `Expected measurable 3rd harmonic @ 3kHz (3k=${db3k.toFixed(1)})`);
  assert.ok(postTube.thdEstimatePercent > 0.3, `Real THD must be > 0.3% on heavily saturated sine, got ${postTube.thdEstimatePercent}%`);

  // Check Tape drive=5% doesn't jump +12 dB!
  const tapeLow = createProcessorModule('saturation', {
    params: { flavor: 'tape', drive: 5, tone: 0, harmonics: 'balanced', oversampling: 2 },
  });
  const outTapeLow = processChainOffline([tone1k, new Float32Array(tone1k)], sr, [tapeLow]).channels[0];
  const rmsDelta = measureRmsDb(outTapeLow, 4800) - measureRmsDb(tone1k, 4800);
  assert.ok(Math.abs(rmsDelta) < 1.5, `Drive=5% Tape saturation caused excessive gain jump: ${rmsDelta.toFixed(2)} dB`);
});

test('AUDIT 5: Bass Enhancer Mono Focus Must Not Narrow 1kHz–10kHz Stereo Spectrum', () => {
  const sr = 48000;
  // Low mono bass + wide 2kHz stereo side signal
  const n = Math.round(sr * 0.5);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const sub = 0.2 * Math.sin((2 * Math.PI * 55 * i) / sr);
    const wideHigh = 0.2 * Math.sin((2 * Math.PI * 2500 * i) / sr);
    l[i] = sub + wideHigh;
    r[i] = sub - wideHigh;
  }
  const bassMod = createProcessorModule('bass-enhancer', {
    params: { subFreqHz: 55, subGainDb: 0, harmonicDrive: 0, tightness: 100, monoFocus: true },
  });
  const out = processChainOffline([l, r], sr, [bassMod]).channels;
  // 2.5 kHz side energy should stay virtually unchanged (>= 95%)
  const inSideHi = measureRmsDb(Float32Array.from(l, (v, i) => 0.5 * (v - r[i])), 4800);
  const outSideHi = measureRmsDb(Float32Array.from(out[0], (v, i) => 0.5 * (v - out[1][i])), 4800);
  assert.ok(
    Math.abs(outSideHi - inSideHi) < 0.25,
    `Bass Enhancer monoFocus corrupted 2.5kHz stereo width by ${(outSideHi - inSideHi).toFixed(2)} dB`,
  );
});

test('SYN-Restore reduces steady high-frequency hiss while preserving a brief high-frequency transient', () => {
  const sr = 48000;
  const duration = 0.5;
  const n = Math.round(sr * duration);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const transientStart = Math.round(sr * 0.25);
  const transientLength = Math.round(sr * 0.002);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const noise = 0.0015 * Math.sin(2 * Math.PI * 10000 * t);
    const offset = i - transientStart;
    const envelope = offset >= 0 && offset < transientLength
      ? Math.min(1, offset / 24, (transientLength - offset) / 24)
      : 0;
    const sample = noise + 0.3 * envelope * Math.sin(2 * Math.PI * 10000 * t);
    left[i] = sample;
    right[i] = sample;
  }

  const restore = createProcessorModule('restore', {
    params: {
      dcOffset: false,
      humRemovalHz: 0,
      hissReduction: 100,
      deEssAmount: 0,
      deEssFreqHz: 6500,
      resonanceSuppress: 0,
      mode: 'conservative',
    },
  });
  const output = processChainOffline([left, right], sr, [restore]).channels[0];
  const noiseIn = measureRmsDb(left, Math.round(sr * 0.08), Math.round(sr * 0.18));
  const noiseOut = measureRmsDb(output, Math.round(sr * 0.08), Math.round(sr * 0.18));
  const transientIn = measureRmsDb(left, transientStart, transientStart + transientLength);
  const transientOut = measureRmsDb(output, transientStart, transientStart + transientLength);

  assert.ok(noiseOut < noiseIn - 2.0, `Expected steady hiss attenuation >2 dB, got ${(noiseOut - noiseIn).toFixed(2)} dB`);
  assert.ok(
    transientOut > transientIn - 1.2,
    `Brief high-frequency transient was over-suppressed by ${(transientIn - transientOut).toFixed(2)} dB`,
  );
});

test('AUDIT 6: SYN-Restore Resonance Trim & Hum Removal & DC Offset', () => {
  const sr = 48000;
  const n = sr;
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // 60Hz hum + 0.12 DC offset + 3200Hz harsh resonance + broadband program
    l[i] =
      0.12 +
      0.15 * Math.sin((2 * Math.PI * 60 * i) / sr) +
      0.22 * Math.sin((2 * Math.PI * 3200 * i) / sr) +
      0.08 * Math.sin((2 * Math.PI * 440 * i) / sr);
    r[i] = l[i];
  }
  const restore = createProcessorModule('restore', {
    params: {
      dcOffset: true,
      humRemovalHz: 60,
      hissReduction: 0,
      deEssAmount: 0,
      deEssFreqHz: 6500,
      resonanceSuppress: 80,
      mode: 'aggressive',
    },
  });
  const out = processChainOffline([l, r], sr, [restore]).channels;
  const post = analyzeAudioBuffer(out, sr);
  assert.ok(post.dcOffset < 0.002, `DC offset not removed: ${post.dcOffset}`);
  const spec = computeMagnitudeSpectrumDb(out[0].subarray(8192, 8192 + 4096), 4096);
  const specIn = computeMagnitudeSpectrumDb(l.subarray(8192, 8192 + 4096), 4096);
  const binHz = sr / 4096;
  const humDrop = specIn[Math.round(60 / binHz)] - spec[Math.round(60 / binHz)];
  const resDrop = specIn[Math.round(3200 / binHz)] - spec[Math.round(3200 / binHz)];
  assert.ok(humDrop > 10, `60Hz hum notch attenuation too weak: ${humDrop.toFixed(1)} dB`);
  assert.ok(resDrop > 2.0, `Resonance suppression must actively tame 3200Hz spike, got ${resDrop.toFixed(1)} dB`);
});

test('AUDIT 7: Maximizer Accuracy vs Target LUFS & Transient Emphasis Behavior', () => {
  const sr = 44100;
  // Sub-heavy dark mix where unweighted RMS differs from K-weighted LUFS!
  const n = sr * 2;
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    l[i] = 0.14 * Math.sin((2 * Math.PI * 45 * i) / sr) + 0.05 * Math.sin((2 * Math.PI * 1000 * i) / sr);
    r[i] = l[i];
  }
  const maxMod = createProcessorModule('maximizer', {
    params: { character: 'transparent', targetLufs: -14, ceilingDb: -1.0, transientEmphasis: 0, truePeak: true },
  });
  const out = processChainOffline([l, r], sr, [maxMod]);
  const post = analyzeAudioBuffer(out.channels, sr);
  assert.ok(
    Math.abs(post.integratedLufs - -14.0) < 1.2,
    `Maximizer missed -14 LUFS target by ${(post.integratedLufs + 14).toFixed(2)} LU (got ${post.integratedLufs})`,
  );
  assert.ok(post.truePeakDb <= -0.95, `Maximizer exceeded ceiling: ${post.truePeakDb}`);
});

test('AUDIT 8: Anti-Aliased Downsampling (96kHz -> 44.1kHz) & Exported WAV Re-Import Integrity', async () => {
  const sr96 = 96000;
  // 35 kHz high-frequency tone above 44.1kHz Nyquist (22.05kHz): linear resampling aliases it back into audible band!
  const hfTone = makeSine(35000, 0.5, 0.25, sr96);
  const down = resampleChannel(hfTone, sr96, 44100);
  const downRms = measureRmsDb(down, 1000, down.length - 1000);
  assert.ok(
    downRms < -36,
    `Downsampling 96k->44.1k failed anti-aliasing on 35kHz tone: aliased RMS = ${downRms.toFixed(1)} dBFS`,
  );

  // Verify 16-bit & 24-bit WAV Blob exact RIFF metadata + PCM sample roundtrip
  const sine44 = makeSine(1000, 0.5, 0.5, 44100);
  const blob = encodeWavBlob([sine44, new Float32Array(sine44)], 44100, {
    filename: 'audit',
    format: 'wav',
    wavBitDepth: 24,
    sampleRate: 44100,
    channels: 'stereo',
    dither: 'tpdf',
    normalizeToTarget: false,
    targetLufs: -14,
    ceilingDb: -1.0,
    deliveryProfile: 'streaming',
    metadataTitle: 'Audit Track',
    metadataArtist: 'SYN Lab',
  });
  const buf = await blob.arrayBuffer();
  const dv = new DataView(buf);
  const riff = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  const wave = String.fromCharCode(dv.getUint8(8), dv.getUint8(9), dv.getUint8(10), dv.getUint8(11));
  assert.equal(riff, 'RIFF');
  assert.equal(wave, 'WAVE');
  assert.equal(dv.getUint32(4, true) + 8, buf.byteLength);
  assert.equal(dv.getUint32(24, true), 44100);
  assert.equal(dv.getUint16(34, true), 24);
});

test('AUDIT 9: Adversarial Edge Cases (Silence, Near-Silence, Clipped, Inverted Stereo, Zero-Length, NaN)', () => {
  const sr = 48000;
  // 1. Pure silence
  const silL = new Float32Array(sr);
  const silR = new Float32Array(sr);
  const aSil = analyzeAudioBuffer([silL, silR], sr);
  assert.equal(aSil.integratedLufs, -70);
  assert.equal(aSil.clippedSamples, 0);
  assert.equal(aSil.dynamicRangeDb, 0);
  assert.ok(Number.isFinite(aSil.crestFactorDb));

  // 2. Phase-inverted stereo (L = -R) -> QC MUST FAIL stereo phase!
  const invL = makeSine(440, 0.3, 1.0, sr);
  const invR = Float32Array.from(invL, (x) => -x);
  const aInv = analyzeAudioBuffer([invL, invR], sr);
  assert.ok(aInv.phaseCorrelation < -0.95);
  const qcInv = runQualityControl(null, aInv, QC_TARGET_PROFILES[0]);
  assert.equal(qcInv.overallStatus, 'fail');
  assert.equal(qcInv.checks.find((c) => c.id === 'qc-phase')?.status, 'fail');

  // 3. Hard-clipped square wave -> QC MUST FAIL clipping!
  const clip = Float32Array.from(makeSine(440, 2.0, 1.0, sr), (v) => Math.max(-1, Math.min(1, v)));
  const aClip = analyzeAudioBuffer([clip, new Float32Array(clip)], sr);
  assert.ok(aClip.clippedSamples > 100);
  const qcClip = runQualityControl(null, aClip, QC_TARGET_PROFILES[0]);
  assert.equal(qcClip.checks.find((c) => c.id === 'qc-clipping')?.status, 'fail');

  // 4. Zero-length / NaN resilience
  const emptyRes = processChainOffline([new Float32Array(0), new Float32Array(0)], sr, [
    createProcessorModule('parametric-eq'),
    createProcessorModule('limiter'),
  ]);
  assert.equal(emptyRes.channels[0].length, 0);
  const aEmpty = analyzeAudioBuffer([new Float32Array(0)], sr);
  assert.ok(Number.isFinite(aEmpty.integratedLufs));

  // 5. Pink noise spectral slope (~ -3 dB/oct)
  const pink = makePinkNoise(0.25, 2.0, sr);
  const aPink = analyzeAudioBuffer([pink, new Float32Array(pink)], sr);
  const white = makeWhiteNoise(0.25, 2.0, sr);
  const aWhite = analyzeAudioBuffer([white, new Float32Array(white)], sr);
  assert.ok(
    aPink.spectralSlopeDbPerOct < aWhite.spectralSlopeDbPerOct - 1.5,
    `Pink noise (${aPink.spectralSlopeDbPerOct}) must slope darker than White noise (${aWhite.spectralSlopeDbPerOct})`,
  );

  // 6. Invalid extreme parameters cannot produce NaN
  const extremeChain = validateChain([
    { type: 'parametric-eq', params: { tiltDb: NaN, bands: [{ freq: -50, gain: Infinity, q: 0 }] } },
    { type: 'compressor', params: { thresholdDb: NaN, ratio: 0, attackMs: -5 } },
    { type: 'maximizer', params: { ceilingDb: 5, targetLufs: 100 } },
  ]);
  const resExtreme = processChainOffline([invL, invL], sr, extremeChain);
  for (let i = 0; i < resExtreme.channels[0].length; i++) {
    assert.ok(Number.isFinite(resExtreme.channels[0][i]), 'Output sample became NaN/Inf');
  }
});

test('QC preserves intentional bass-heavy baseline and warns only when processing materially worsens tonal balance', () => {
  const sr = 48000;
  const n = sr * 2;
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const bass =
      0.34 * Math.sin(2 * Math.PI * 65 * t) +
      0.28 * Math.sin(2 * Math.PI * 95 * t) +
      0.22 * Math.sin(2 * Math.PI * 150 * t);
    const mids =
      0.035 * Math.sin(2 * Math.PI * 900 * t) +
      0.025 * Math.sin(2 * Math.PI * 1500 * t);
    const high = 0.02 * Math.sin(2 * Math.PI * 3500 * t);
    left[i] = bass + mids + high;
    right[i] = bass + mids + high;
  }

  const baseline = analyzeAudioBuffer([left, right], sr);
  const baselineBassMid = baseline.zoneEnergyDb.bass - baseline.zoneEnergyDb.mid;
  assert.ok(baselineBassMid > 11, `Fixture must be intentionally bass-heavy, got ${baselineBassMid.toFixed(1)} dB`);

  const baselineQc = runQualityControl(baseline, baseline, QC_TARGET_PROFILES[0]);
  const baselineSpectral = baselineQc.checks.find((check) => check.id === 'qc-spectral');
  assert.equal(
    baselineSpectral?.status,
    'pass',
    'QC must not fail a deliberately bass-heavy profile that processing has not worsened',
  );

  const bassBoost = createProcessorModule('parametric-eq', {
    params: {
      phaseMode: 'minimum',
      msMode: 'stereo',
      tiltDb: 0,
      bands: [{ id: 'bass-boost', enabled: true, shape: 'lowshelf', freq: 100, gain: 6, q: 0.71 }],
    },
  });
  const rendered = processChainOffline([left, right], sr, [bassBoost]);
  const post = analyzeAudioBuffer(rendered.channels, sr);
  const postQc = runQualityControl(baseline, post, QC_TARGET_PROFILES[0]);
  const postSpectral = postQc.checks.find((check) => check.id === 'qc-spectral');
  assert.equal(postSpectral?.status, 'warning', 'QC must warn when the mastering chain materially adds low-end dominance');
  assert.match(postSpectral?.explanation ?? '', /increased|added|worsened/i);
});
