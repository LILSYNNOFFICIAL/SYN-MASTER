/**
 * Deterministic Synthesized Musical Mastering Test Signals
 * Produces rich, multi-layered stereo audio buffers (kick, sub-bass, chord pad, lead arp, hi-hats)
 * so users can immediately audition real DSP processing, FFT analysis, LUFS meters, and A/B mastering.
 */

export function generateDemoMasterStem(
  variant: 'main-mix' | 'reference-bright' | 'sine-sweep' = 'main-mix',
  sampleRate = 44100,
  durationSec = 14,
): { channels: [Float32Array, Float32Array]; sampleRate: number; name: string } {
  const length = Math.round(sampleRate * durationSec);
  const left = new Float32Array(length);
  const right = new Float32Array(length);

  if (variant === 'sine-sweep') {
    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      const freq = 30 * Math.pow(16000 / 30, t / durationSec);
      const phase = (2 * Math.PI * 30 * durationSec * (Math.pow(16000 / 30, t / durationSec) - 1)) / Math.log(16000 / 30);
      const val = 0.35 * Math.sin(phase);
      left[i] = val;
      right[i] = val;
    }
    return { channels: [left, right], sampleRate, name: 'Calibration_Log_Sweep_30Hz-16kHz.wav' };
  }

  const isRef = variant === 'reference-bright';
  const bpm = isRef ? 124 : 118;
  const beatSec = 60 / bpm;
  const chordRoots = isRef ? [110, 130.81, 146.83, 164.81] : [98.0, 116.54, 130.81, 146.83];

  // Deterministic pseudo-random generator for hi-hat/snare noise bursts
  let seed = isRef ? 918273 : 133742;
  const nextRand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed / 4294967296) * 2 - 1;
  };

  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    const beatPos = t / beatSec;
    const beatIdx = Math.floor(beatPos);
    const beatFrac = beatPos - beatIdx;
    const barIdx = Math.floor(beatIdx / 4) % chordRoots.length;
    const rootHz = chordRoots[barIdx];

    // 1. Punchy Kick on every quarter note
    const kickEnv = Math.exp(-beatFrac * 14);
    const kickFreq = 48 + 115 * Math.exp(-beatFrac * 34);
    const kick = Math.sin(2 * Math.PI * kickFreq * (beatFrac * beatSec)) * kickEnv * (isRef ? 0.42 : 0.34);

    // 2. Sub-bass & warm harmonic bass (root + octave)
    const bassSidechain = 1 - 0.72 * Math.exp(-beatFrac * 9);
    const bass =
      (Math.sin(2 * Math.PI * (rootHz * 0.5) * t) * 0.22 +
        Math.sin(2 * Math.PI * rootHz * t) * 0.14 +
        Math.sin(2 * Math.PI * rootHz * 2 * t) * 0.04) *
      bassSidechain;

    // 3. Stereo Detuned Chord Pad (warm in main mix, brighter in reference)
    const padL =
      (Math.sin(2 * Math.PI * (rootHz * 2) * t) +
        0.7 * Math.sin(2 * Math.PI * (rootHz * 2.502) * t + 0.4) +
        0.55 * Math.sin(2 * Math.PI * (rootHz * 3.003) * t + 1.1)) *
      0.085;
    const padR =
      (Math.sin(2 * Math.PI * (rootHz * 1.997) * t + 0.7) +
        0.7 * Math.sin(2 * Math.PI * (rootHz * 2.497) * t + 1.3) +
        0.55 * Math.sin(2 * Math.PI * (rootHz * 2.996) * t + 2.0)) *
      0.085;

    // 4. Melodic Pluck Arp on 8th notes
    const eighthPos = (t / (beatSec * 0.5));
    const eighthIdx = Math.floor(eighthPos);
    const eighthFrac = eighthPos - eighthIdx;
    const arpMults = [2, 3, 4, 3, 5, 4, 3, 2.5];
    const arpFreq = rootHz * arpMults[eighthIdx % arpMults.length];
    const arpEnv = Math.exp(-eighthFrac * 7.5);
    const arpPan = ((eighthIdx % 4) - 1.5) * 0.28;
    const arpSig =
      (Math.sin(2 * Math.PI * arpFreq * t) * 0.7 +
        Math.sin(2 * Math.PI * arpFreq * 2 * t) * (isRef ? 0.35 : 0.18)) *
      arpEnv *
      0.13;

    // 5. Snare on beats 2 & 4 + crisp 16th hi-hats & air shimmer
    const snareHit = beatIdx % 2 === 1 ? Math.exp(-beatFrac * 22) * 0.24 : 0;
    const sixteenthFrac = (t / (beatSec * 0.25)) % 1;
    const hatEnv = Math.exp(-sixteenthFrac * 30) * (isRef ? 0.16 : 0.11);
    const noise = nextRand();
    const hat = noise * hatEnv;
    const shimmer = Math.sin(2 * Math.PI * (arpFreq * 4) * t) * arpEnv * 0.045;
    const snareBody = beatIdx % 2 === 1 ? Math.sin(2 * Math.PI * 185 * (beatFrac * beatSec)) * Math.exp(-beatFrac * 24) * 0.16 : 0;

    // Mix together (main mix intentionally leaves ~ -18.5 LUFS / -5 dBFS headroom for real mastering!)
    const mixGain = isRef ? 0.92 : 0.58;
    const fade = Math.min(1, t / 0.05) * Math.min(1, (durationSec - t) / 0.15);

    left[i] = (kick + bass + padL + arpSig * (1 - arpPan) + shimmer + snareBody + noise * snareHit * 0.8 + hat * 0.85) * mixGain * fade;
    right[i] = (kick + bass + padR + arpSig * (1 + arpPan) + shimmer + snareBody + noise * snareHit * 0.95 + hat * 1.05) * mixGain * fade;
  }

  return {
    channels: [left, right],
    sampleRate,
    name: isRef
      ? 'Reference_Commercial_Master_124BPM.wav'
      : 'SYN_Demo_Unmastered_Mix_118BPM.wav',
  };
}
