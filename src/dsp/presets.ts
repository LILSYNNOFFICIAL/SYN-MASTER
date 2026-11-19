import type {
  AIMasteringStrategy,
  AudioAnalysis,
  MasteringMode,
  MasteringPreset,
  ProcessorModule,
} from '../types/mastering';
import { createProcessorModule } from './chainValidation';

export const MASTERING_PRESETS: MasteringPreset[] = [
  {
    id: 'genre-pop',
    name: 'Modern Pop Polish',
    category: 'genre',
    description: 'Clean sub control, vocal midrange presence, glue compression, and -11 LUFS punch.',
    targetLufs: -11,
    chain: [
      createProcessorModule('parametric-eq', {
        name: 'Surgical Tonal EQ',
        params: {
          phaseMode: 'minimum',
          msMode: 'stereo',
          tiltDb: 0.4,
          bands: [
            { id: 'b1', enabled: true, shape: 'highpass', freq: 30, gain: 0, q: 0.71 },
            { id: 'b2', enabled: true, shape: 'lowshelf', freq: 90, gain: 0.8, q: 0.71 },
            { id: 'b3', enabled: true, shape: 'bell', freq: 290, gain: -1.4, q: 1.5 },
            { id: 'b4', enabled: true, shape: 'bell', freq: 3200, gain: 1.3, q: 1.1 },
            { id: 'b5', enabled: true, shape: 'highshelf', freq: 11000, gain: 1.6, q: 0.71 },
          ],
        },
      }),
      createProcessorModule('compressor', {
        name: 'Bus Glue Compressor',
        params: {
          mode: 'downward',
          thresholdDb: -16,
          ratio: 2.2,
          attackMs: 18,
          releaseMs: 120,
          kneeDb: 4,
          makeupDb: 1.2,
          scHpfHz: 85,
        },
      }),
      createProcessorModule('stereo-imager', {
        name: 'Stereo Stage',
        params: {
          lowWidth: 80,
          midWidth: 112,
          highWidth: 125,
          lowCrossHz: 160,
          highCrossHz: 3500,
          monoBassBelowHz: 95,
          lrBalanceDb: 0,
          midSideGainDb: 0.3,
        },
      }),
      createProcessorModule('maximizer', {
        name: 'Commercial Maximizer',
        params: {
          character: 'punchy',
          targetLufs: -11,
          ceilingDb: -1.0,
          transientEmphasis: 30,
          truePeak: true,
        },
      }),
    ],
  },
  {
    id: 'genre-hiphop',
    name: 'Hip-Hop / Trap Impact',
    category: 'genre',
    description: 'Tight mono sub-80Hz weight, harmonic 808 punch, crisp transient snap, -9.5 LUFS.',
    targetLufs: -9.5,
    chain: [
      createProcessorModule('bass-enhancer', {
        name: '808 Sub Weight',
        params: { subFreqHz: 52, subGainDb: 2.0, harmonicDrive: 34, tightness: 68, monoFocus: true },
      }),
      createProcessorModule('multiband-comp', {
        name: '3-Band Punch Control',
        params: {
          lowCrossHz: 140,
          highCrossHz: 3400,
          low: { thresholdDb: -17, ratio: 2.8, attackMs: 28, releaseMs: 140, gainDb: 0.5, bypass: false },
          mid: { thresholdDb: -18, ratio: 2.0, attackMs: 15, releaseMs: 110, gainDb: 0.2, bypass: false },
          high: { thresholdDb: -19, ratio: 2.3, attackMs: 8, releaseMs: 70, gainDb: 0.6, bypass: false },
        },
      }),
      createProcessorModule('saturation', {
        name: 'Tape Punch',
        params: { flavor: 'tape', drive: 26, tone: 10, harmonics: 'balanced', oversampling: 2 },
      }),
      createProcessorModule('maximizer', {
        name: 'Loudness Maximizer',
        params: {
          character: 'punchy',
          targetLufs: -9.5,
          ceilingDb: -0.8,
          transientEmphasis: 40,
          truePeak: true,
        },
      }),
    ],
  },
  {
    id: 'genre-electronic',
    name: 'Electronic / EDM Club',
    category: 'genre',
    description: 'High headroom clarity, wide synth top-end, tight low-end mono lock, -9 LUFS.',
    targetLufs: -9,
    chain: [
      createProcessorModule('parametric-eq', {
        name: 'Club Contour EQ',
        params: {
          phaseMode: 'minimum',
          msMode: 'stereo',
          tiltDb: 0.5,
          bands: [
            { id: 'b1', enabled: true, shape: 'highpass', freq: 32, gain: 0, q: 0.71 },
            { id: 'b2', enabled: true, shape: 'lowshelf', freq: 75, gain: 1.5, q: 0.71 },
            { id: 'b3', enabled: true, shape: 'bell', freq: 250, gain: -2.0, q: 1.6 },
            { id: 'b4', enabled: true, shape: 'bell', freq: 3600, gain: 1.0, q: 1.2 },
            { id: 'b5', enabled: true, shape: 'highshelf', freq: 10500, gain: 1.8, q: 0.71 },
          ],
        },
      }),
      createProcessorModule('stereo-imager', {
        name: 'Wide Club Imager',
        params: {
          lowWidth: 70,
          midWidth: 116,
          highWidth: 132,
          lowCrossHz: 150,
          highCrossHz: 3200,
          monoBassBelowHz: 110,
          lrBalanceDb: 0,
          midSideGainDb: 0.5,
        },
      }),
      createProcessorModule('limiter', {
        name: 'Brickwall True Peak Limiter',
        params: {
          ceilingDb: -0.6,
          thresholdDb: -5.5,
          releaseMs: 65,
          lookaheadMs: 3.5,
          truePeak: true,
          oversampling: 4,
        },
      }),
    ],
  },
  {
    id: 'genre-rock',
    name: 'Rock / Indie Energy',
    category: 'genre',
    description: 'Tube warmth, controlled 300Hz boxiness, drum transient preservation.',
    targetLufs: -11.5,
    chain: [
      createProcessorModule('parametric-eq', {
        name: 'Mix De-Mud EQ',
        params: {
          phaseMode: 'minimum',
          msMode: 'stereo',
          tiltDb: 0.2,
          bands: [
            { id: 'b1', enabled: true, shape: 'highpass', freq: 28, gain: 0, q: 0.71 },
            { id: 'b2', enabled: true, shape: 'bell', freq: 310, gain: -1.8, q: 1.3 },
            { id: 'b3', enabled: true, shape: 'bell', freq: 2400, gain: 1.4, q: 1.1 },
            { id: 'b4', enabled: true, shape: 'highshelf', freq: 9500, gain: 1.2, q: 0.71 },
          ],
        },
      }),
      createProcessorModule('saturation', {
        name: 'Console Tube Warmth',
        params: { flavor: 'tube', drive: 28, tone: -8, harmonics: 'even', oversampling: 2 },
      }),
      createProcessorModule('compressor', {
        name: 'SSL-Style Bus Comp',
        params: {
          mode: 'downward',
          thresholdDb: -15,
          ratio: 2.5,
          attackMs: 30,
          releaseMs: 110,
          kneeDb: 3,
          makeupDb: 1.5,
          scHpfHz: 90,
        },
      }),
      createProcessorModule('limiter', {
        name: 'True Peak Limiter',
        params: {
          ceilingDb: -1.0,
          thresholdDb: -3.5,
          releaseMs: 90,
          lookaheadMs: 3,
          truePeak: true,
          oversampling: 4,
        },
      }),
    ],
  },
  {
    id: 'genre-acoustic',
    name: 'Acoustic / Classical Transparent',
    category: 'genre',
    description: 'Minimal coloration, wide dynamic preservation, -16 LUFS audiophile delivery.',
    targetLufs: -16,
    chain: [
      createProcessorModule('restore', {
        name: 'Gentle Noise & DC Cleanup',
        params: {
          dcOffset: true,
          humRemovalHz: 0,
          hissReduction: 10,
          deEssAmount: 8,
          deEssFreqHz: 6500,
          resonanceSuppress: 10,
          mode: 'conservative',
        },
      }),
      createProcessorModule('parametric-eq', {
        name: 'Transparent Air EQ',
        params: {
          phaseMode: 'linear',
          msMode: 'stereo',
          tiltDb: 0.2,
          bands: [
            { id: 'b1', enabled: true, shape: 'highpass', freq: 24, gain: 0, q: 0.71 },
            { id: 'b2', enabled: true, shape: 'highshelf', freq: 12000, gain: 1.0, q: 0.71 },
          ],
        },
      }),
      createProcessorModule('limiter', {
        name: 'Safety Peak Limiter',
        params: {
          ceilingDb: -1.2,
          thresholdDb: -1.8,
          releaseMs: 180,
          lookaheadMs: 4,
          truePeak: true,
          oversampling: 4,
        },
      }),
    ],
  },
  {
    id: 'phil-transparent',
    name: 'Transparent Streaming',
    category: 'philosophy',
    description: 'Preserve original mix balance while meeting -14 LUFS / -1.0 dBTP streaming spec.',
    targetLufs: -14,
    chain: [
      createProcessorModule('parametric-eq', {
        name: 'Subsonic Cleanup EQ',
        params: {
          phaseMode: 'minimum',
          msMode: 'stereo',
          tiltDb: 0,
          bands: [{ id: 'b1', enabled: true, shape: 'highpass', freq: 26, gain: 0, q: 0.71 }],
        },
      }),
      createProcessorModule('maximizer', {
        name: 'Transparent Maximizer',
        params: {
          character: 'transparent',
          targetLufs: -14,
          ceilingDb: -1.0,
          transientEmphasis: 20,
          truePeak: true,
        },
      }),
    ],
  },
  {
    id: 'phil-warm',
    name: 'Warm Analog Console',
    category: 'philosophy',
    description: 'Rich even-order tube harmonics, smooth top-end, and velvety bus compression.',
    targetLufs: -13.5,
    chain: [
      createProcessorModule('saturation', {
        name: 'Tube Console Stage',
        params: { flavor: 'tube', drive: 34, tone: -18, harmonics: 'even', oversampling: 2 },
      }),
      createProcessorModule('compressor', {
        name: 'Smooth Optical Glue',
        params: {
          mode: 'downward',
          thresholdDb: -17,
          ratio: 1.8,
          attackMs: 25,
          releaseMs: 210,
          kneeDb: 8,
          makeupDb: 1.2,
          scHpfHz: 70,
        },
      }),
      createProcessorModule('maximizer', {
        name: 'Smooth Maximizer',
        params: {
          character: 'smooth',
          targetLufs: -13.5,
          ceilingDb: -1.0,
          transientEmphasis: 15,
          truePeak: true,
        },
      }),
    ],
  },
];

/**
 * Deterministic Algorithmic Mastering Strategy Generator
 * Used when Gemini API is unavailable or when user runs offline algorithmic mastering.
 * Always computes real adjustments directly from measured AudioAnalysis values.
 */
export function buildAlgorithmicStrategy(
  analysis: AudioAnalysis,
  mode: MasteringMode,
  targetLufsOverride?: number,
  referenceAnalysis?: AudioAnalysis | null,
): AIMasteringStrategy {
  const targetLufs =
    targetLufsOverride ??
    (mode === 'loudness'
      ? -9.5
      : mode === 'dynamic' || mode === 'transparent'
        ? -15.0
        : mode === 'streaming'
          ? -14.0
          : -13.0);
  const targetTp = mode === 'loudness' ? -0.6 : -1.0;

  const issues: string[] = [];
  const chain: ProcessorModule[] = [];
  const reasoning: AIMasteringStrategy['reasoningPerProcessor'] = [];

  // 1. Restoration if needed
  if (analysis.dcOffset > 0.004 || analysis.resonances.length > 0) {
    issues.push(
      analysis.dcOffset > 0.004
        ? `DC offset measured at ${(analysis.dcOffset * 100).toFixed(2)}%`
        : `${analysis.resonances.length} spectral resonance peak(s) detected`,
    );
    chain.push(
      createProcessorModule('restore', {
        name: 'SYN-Restore Cleanup',
        params: {
          dcOffset: true,
          humRemovalHz: 0,
          hissReduction: analysis.zoneEnergyDb.air > -45 ? 14 : 6,
          deEssAmount: analysis.zoneEnergyDb.presence > analysis.zoneEnergyDb.mid - 4 ? 22 : 10,
          deEssFreqHz: 6800,
          resonanceSuppress: 18,
          mode: 'conservative',
        },
      }),
    );
    reasoning.push({
      processorType: 'restore',
      reason: 'Removes subsonic DC asymmetry and gently tames upper-band sibilance.',
    });
  }

  // 2. Parametric EQ derived from actual spectral balance or reference delta
  const bassDiff = referenceAnalysis
    ? referenceAnalysis.zoneEnergyDb.bass - analysis.zoneEnergyDb.bass
    : analysis.zoneEnergyDb.bass - analysis.zoneEnergyDb.mid > 7
      ? -1.8
      : 0.6;
  const lowMidMud = analysis.zoneEnergyDb.lowMid - analysis.zoneEnergyDb.mid;
  const lowMidCut = lowMidMud > 3.5 ? -Math.min(3.0, (lowMidMud - 2.5) * 0.6) : -0.6;
  const airBoost = referenceAnalysis
    ? Math.max(-2.5, Math.min(3.5, (referenceAnalysis.zoneEnergyDb.air - analysis.zoneEnergyDb.air) * 0.4))
    : analysis.spectralSlopeDbPerOct < -2.2
      ? 1.8
      : 0.8;

  if (lowMidMud > 4.0) {
    issues.push(`Low-mid buildup around 250–450 Hz (+${lowMidMud.toFixed(1)} dB over midrange)`);
  }
  if (analysis.spectralSlopeDbPerOct < -2.4) {
    issues.push(`Dark spectral tilt (${analysis.spectralSlopeDbPerOct.toFixed(1)} dB/oct)`);
  }

  chain.push(
    createProcessorModule('parametric-eq', {
      name: 'Adaptive Master EQ',
      params: {
        phaseMode: mode === 'transparent' ? 'linear' : 'minimum',
        msMode: 'stereo',
        tiltDb: mode === 'analog' ? -0.3 : 0.2,
        bands: [
          { id: 'b1', enabled: true, shape: 'highpass', freq: 28, gain: 0, q: 0.71 },
          {
            id: 'b2',
            enabled: true,
            shape: 'lowshelf',
            freq: 88,
            gain: Number(Math.max(-3.5, Math.min(3.5, bassDiff * 0.5)).toFixed(1)),
            q: 0.71,
          },
          {
            id: 'b3',
            enabled: true,
            shape: 'bell',
            freq: 310,
            gain: Number(lowMidCut.toFixed(1)),
            q: 1.4,
          },
          {
            id: 'b4',
            enabled: true,
            shape: 'bell',
            freq: analysis.resonances[0]?.freqHz ?? 3400,
            gain: analysis.resonances[0] ? -Math.min(3.0, analysis.resonances[0].excessDb * 0.35) : 0.8,
            q: analysis.resonances[0] ? 2.4 : 1.1,
          },
          {
            id: 'b5',
            enabled: true,
            shape: 'highshelf',
            freq: 11500,
            gain: Number(airBoost.toFixed(1)),
            q: 0.71,
          },
        ],
      },
    }),
  );
  reasoning.push({
    processorType: 'parametric-eq',
    reason: `Corrects measured spectral slope (${analysis.spectralSlopeDbPerOct} dB/oct) and low-mid density.`,
  });

  // 3. Dynamic control
  if (analysis.dynamicRangeDb > 10 || mode !== 'transparent') {
    chain.push(
      createProcessorModule('compressor', {
        name: 'Master Bus Glue',
        params: {
          mode: mode === 'dynamic' ? 'parallel' : 'downward',
          thresholdDb: Number(Math.max(-24, Math.min(-10, analysis.rmsDb + 3.5)).toFixed(1)),
          ratio: mode === 'transparent' ? 1.6 : mode === 'loudness' ? 2.8 : 2.1,
          attackMs: mode === 'dynamic' ? 35 : 18,
          releaseMs: 130,
          kneeDb: 5,
          makeupDb: 0.8,
          scHpfHz: 85,
        },
      }),
    );
    reasoning.push({
      processorType: 'compressor',
      reason: `Tames ${analysis.crestFactorDb.toFixed(1)} dB crest factor smoothly with 85 Hz sidechain HPF.`,
    });
  }

  // 4. Harmonic coloration for analog/loudness/hybrid
  if (mode === 'analog' || mode === 'loudness' || mode === 'hybrid' || mode === 'ai-auto') {
    chain.push(
      createProcessorModule('saturation', {
        name: mode === 'analog' ? 'Warm Tube Stage' : 'Tape Harmonic Glue',
        params: {
          flavor: mode === 'analog' ? 'tube' : 'tape',
          drive: mode === 'analog' ? 32 : 18,
          tone: mode === 'analog' ? -12 : 6,
          harmonics: mode === 'analog' ? 'even' : 'balanced',
          oversampling: 2,
        },
      }),
    );
    reasoning.push({
      processorType: 'saturation',
      reason: 'Adds cohesive harmonic density to reduce peak-to-average stress before limiting.',
    });
  }

  // 5. Stereo Imager based on measured phase correlation & width
  if (analysis.stereoWidth < 0.75 || analysis.lowEndCorrelation < 0.85) {
    if (analysis.lowEndCorrelation < 0.85) {
      issues.push(`Low-end correlation (${analysis.lowEndCorrelation.toFixed(2)}) benefits from mono focus`);
    }
    chain.push(
      createProcessorModule('stereo-imager', {
        name: 'Multiband Stereo Focus',
        params: {
          lowWidth: 78,
          midWidth: analysis.stereoWidth < 0.55 ? 114 : 104,
          highWidth: analysis.stereoWidth < 0.65 ? 124 : 112,
          lowCrossHz: 150,
          highCrossHz: 3500,
          monoBassBelowHz: 95,
          lrBalanceDb: Number((-analysis.lrBalanceDb * 0.5).toFixed(2)),
          midSideGainDb: 0,
        },
      }),
    );
    reasoning.push({
      processorType: 'stereo-imager',
      reason: `Tightens sub-95 Hz mono correlation (${analysis.lowEndCorrelation.toFixed(2)}) and balances stereo width.`,
    });
  }

  // 6. Final Maximizer / Limiter
  chain.push(
    createProcessorModule('maximizer', {
      name: 'True Peak Finalizer',
      params: {
        character:
          mode === 'loudness'
            ? 'punchy'
            : mode === 'analog'
              ? 'smooth'
              : 'transparent',
        targetLufs,
        ceilingDb: targetTp,
        transientEmphasis: mode === 'dynamic' ? 40 : 25,
        truePeak: true,
      },
    }),
  );
  reasoning.push({
    processorType: 'maximizer',
    reason: `Targets ${targetLufs} LUFS while protecting ${targetTp} dBTP inter-sample ceiling.`,
  });

  if (issues.length === 0) {
    issues.push('Source mix has balanced dynamics; subtle tonal polish and loudness calibration applied.');
  }

  return {
    id: `strat-${Date.now()}`,
    timestamp: Date.now(),
    source: 'algorithmic',
    genre: analysis.zoneEnergyDb.sub > analysis.zoneEnergyDb.mid - 4 ? 'Electronic / Modern Bass' : 'Contemporary Mix',
    musicalStyle: `${mode.toUpperCase()} Profile`,
    instrumentationSummary: `Centroid ${analysis.spectralCentroidHz} Hz, Transient Density ${(analysis.transientDensity * 100).toFixed(0)}%`,
    vocalPresence: analysis.zoneEnergyDb.mid > analysis.zoneEnergyDb.bass - 5 ? 'Forward / Present' : 'Balanced in Mix',
    tonalCharacteristics: `Slope ${analysis.spectralSlopeDbPerOct} dB/oct, Width ${(analysis.stereoWidth * 100).toFixed(0)}%`,
    issuesDetected: issues,
    strategySummary: `Built a ${chain.length}-stage DSP chain calibrated from ${analysis.integratedLufs.toFixed(1)} LUFS / ${analysis.dynamicRangeDb.toFixed(1)} dB DR toward ${targetLufs} LUFS (${targetTp} dBTP).`,
    targetLufs,
    targetTruePeakDb: targetTp,
    reasoningPerProcessor: reasoning,
    chain,
  };
}
