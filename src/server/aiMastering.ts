import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import type {
  AudioAnalysis,
  CustomObjectiveSpec,
  DirectorOperatingMode,
  MasteringMode,
  MasteringObjectiveId,
  ProcessorModule,
  QCReport,
} from '../types/mastering.ts';
import { validateChain } from '../dsp/chainValidation.ts';

function getAiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured in server secrets.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function summarizeAnalysisForPrompt(label: string, a: AudioAnalysis): string {
  return [
    `${label}:`,
    `- Duration: ${a.durationSec}s | SampleRate: ${a.sampleRate}Hz | Channels: ${a.channels}`,
    `- Integrated LUFS: ${a.integratedLufs} | Short-Term Max: ${a.shortTermLufsMax} | LRA: ${a.loudnessRangeLu} LU`,
    `- Sample Peak: ${a.samplePeakDb} dBFS | True Peak: ${a.truePeakDb} dBTP | RMS: ${a.rmsDb} dBFS`,
    `- Dynamic Range: ${a.dynamicRangeDb} dB | Crest Factor: ${a.crestFactorDb} dB | PLR: ${a.plrDb} dB | Transient Density: ${a.transientDensity}`,
    `- Spectral Centroid: ${a.spectralCentroidHz} Hz | Spectral Slope: ${a.spectralSlopeDbPerOct} dB/oct`,
    `- Zones (dB): Sub=${a.zoneEnergyDb.sub}, Bass=${a.zoneEnergyDb.bass}, LowMid=${a.zoneEnergyDb.lowMid}, Mid=${a.zoneEnergyDb.mid}, HighMid=${a.zoneEnergyDb.highMid}, Presence=${a.zoneEnergyDb.presence}, Air=${a.zoneEnergyDb.air}`,
    `- Detected Resonances: ${a.resonances.length ? a.resonances.map((r) => `${r.freqHz}Hz (+${r.excessDb}dB)`).join(', ') : 'None significant'}`,
    `- Stereo Width: ${a.stereoWidth} | M/S Ratio: ${a.midSideRatioDb} dB | Phase Corr: ${a.phaseCorrelation} | Low-End Corr: ${a.lowEndCorrelation} | L/R Balance: ${a.lrBalanceDb} dB | Mono Score: ${a.monoCompatibilityScore}/100`,
    `- Integrity & Noise: Clipped=${a.clippedSamples} | ISP=${a.interSamplePeaks} | THD=${a.thdEstimatePercent}% | NoiseFloor=${a.noiseFloorDb ?? -72} dBFS | DC Offset=${a.dcOffset}`,
  ].join('\n');
}

const PROCESSOR_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    type: {
      type: Type.STRING,
      description:
        'Must be one of: parametric-eq, dynamic-eq, compressor, multiband-comp, saturation, stereo-imager, restore, bass-enhancer, limiter, maximizer',
    },
    name: { type: Type.STRING },
    intensity: { type: Type.NUMBER, description: '0 to 100' },
    wetDry: { type: Type.NUMBER, description: '0 to 100' },
    inputGainDb: { type: Type.NUMBER, description: '-12 to +12' },
    outputGainDb: { type: Type.NUMBER, description: '-12 to +12' },
    reason: { type: Type.STRING, description: 'Engineering justification referencing measured metrics & tradeoffs' },
    paramsJson: {
      type: Type.STRING,
      description:
        'Valid JSON string matching the exact parameter object schema for the chosen processor type.',
    },
  },
  required: ['type', 'name', 'intensity', 'wetDry', 'reason', 'paramsJson'],
};

const STRATEGY_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    genre: { type: Type.STRING },
    musicalStyle: { type: Type.STRING },
    instrumentationSummary: { type: Type.STRING },
    vocalPresence: { type: Type.STRING },
    tonalCharacteristics: { type: Type.STRING },
    issuesDetected: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    strategySummary: { type: Type.STRING },
    targetLufs: { type: Type.NUMBER },
    targetTruePeakDb: { type: Type.NUMBER },
    processors: {
      type: Type.ARRAY,
      items: PROCESSOR_SCHEMA,
    },
  },
  required: [
    'genre',
    'musicalStyle',
    'instrumentationSummary',
    'vocalPresence',
    'tonalCharacteristics',
    'issuesDetected',
    'strategySummary',
    'targetLufs',
    'targetTruePeakDb',
    'processors',
  ],
};

const SYSTEM_PROMPT = `You are SYN-MASTER AI | Mastering Director, an elite mastering engineer controlling a real DSP engine.
You receive real ITU-R BS.1770 loudness, dynamics, spectral zone energies, resonances, THD, noise floor, L/R balance, and stereo phase diagnostics.
Never invent fake numbers—reference only the actual measured telemetry provided.
Distinguish intentional artistic tonal/stereo character from technical defects (clipping, DC offset, low-end phase cancellation, elevated noise floor, narrow painful resonances).
Use ONLY needed processors; keep EQ moves surgical (+/- 4 dB max unless correcting severe imbalance) and protect musical transients.

Valid paramsJson schemas by processor type:
1. "parametric-eq": {"phaseMode":"minimum"|"linear","msMode":"stereo"|"mid-side","tiltDb":number,"bands":[{"id":"b1","enabled":true,"shape":"highpass"|"lowshelf"|"bell"|"highshelf"|"lowpass"|"notch","freq":number,"gain":number,"q":number}]}
2. "dynamic-eq": {"bands":[{"id":"d1","enabled":true,"freq":number,"q":number,"thresholdDb":number,"maxCutDb":number,"attackMs":number,"releaseMs":number}]}
3. "compressor": {"mode":"downward"|"upward"|"parallel","thresholdDb":number,"ratio":number,"attackMs":number,"releaseMs":number,"kneeDb":number,"makeupDb":number,"scHpfHz":number}
4. "multiband-comp": {"lowCrossHz":number,"highCrossHz":number,"low":{"thresholdDb":number,"ratio":number,"attackMs":number,"releaseMs":number,"gainDb":number,"bypass":false},"mid":{"thresholdDb":number,"ratio":number,"attackMs":number,"releaseMs":number,"gainDb":number,"bypass":false},"high":{"thresholdDb":number,"ratio":number,"attackMs":number,"releaseMs":number,"gainDb":number,"bypass":false}}
5. "saturation": {"flavor":"tube"|"tape"|"soft-clip"|"hard-clip"|"exciter","drive":number,"tone":number,"harmonics":"even"|"odd"|"balanced","oversampling":2}
6. "stereo-imager": {"lowWidth":number,"midWidth":number,"highWidth":number,"lowCrossHz":number,"highCrossHz":number,"monoBassBelowHz":number,"lrBalanceDb":number,"midSideGainDb":number}
7. "restore": {"dcOffset":boolean,"humRemovalHz":0|50|60,"hissReduction":number,"deEssAmount":number,"deEssFreqHz":number,"resonanceSuppress":number,"mode":"conservative"|"aggressive"}
8. "bass-enhancer": {"subFreqHz":number,"subGainDb":number,"harmonicDrive":number,"tightness":number,"monoFocus":boolean}
9. "limiter": {"ceilingDb":number,"thresholdDb":number,"releaseMs":number,"lookaheadMs":number,"truePeak":true,"oversampling":4}
10. "maximizer": {"character":"transparent"|"punchy"|"aggressive"|"smooth","targetLufs":number,"ceilingDb":number,"transientEmphasis":number,"truePeak":true}`;

function parseAiChain(
  rawProcessors: Array<{
    type: string;
    name: string;
    intensity: number;
    wetDry: number;
    inputGainDb?: number;
    outputGainDb?: number;
    reason: string;
    paramsJson: string;
  }>,
): {
  chain: ProcessorModule[];
  reasoning: Array<{ processorType: ProcessorModule['type']; reason: string }>;
} {
  const parsed = rawProcessors.map((p) => {
    let paramsObj: unknown = {};
    try {
      paramsObj = JSON.parse(p.paramsJson);
    } catch {
      paramsObj = {};
    }
    return {
      type: p.type,
      name: p.name,
      intensity: p.intensity,
      wetDry: p.wetDry,
      inputGainDb: p.inputGainDb ?? 0,
      outputGainDb: p.outputGainDb ?? 0,
      params: paramsObj,
    };
  });

  const chain = validateChain(parsed);
  const reasoning = rawProcessors
    .slice(0, chain.length)
    .map((p, idx) => ({
      processorType: chain[idx].type,
      reason: p.reason,
    }));

  return { chain, reasoning };
}

export async function generateGeminiMasterStrategy(input: {
  analysis: AudioAnalysis;
  mode: MasteringMode;
  objective?: MasteringObjectiveId;
  customObjective?: Partial<CustomObjectiveSpec> | null;
  operatingMode?: DirectorOperatingMode;
  targetLufs?: number;
  userGenreOverride?: string;
  referenceAnalysis?: AudioAnalysis | null;
  availablePlugins?: Array<{ name: string; role: string; manufacturer: string }>;
}) {
  const ai = getAiClient();
  const promptParts = [
    summarizeAnalysisForPrompt('SOURCE TRACK MEASUREMENTS', input.analysis),
    `Mastering Objective: ${(input.objective ?? input.mode).toUpperCase()} | Operating Mode: ${input.operatingMode ?? 'autonomous'}`,
    input.customObjective ? `Custom Objective Constraints: ${JSON.stringify(input.customObjective)}` : '',
    input.targetLufs ? `Requested Target Loudness: ${input.targetLufs} LUFS` : '',
    input.userGenreOverride ? `User Genre Classification: ${input.userGenreOverride}` : '',
    input.availablePlugins && input.availablePlugins.length > 0
      ? `Connected Third-Party VST3 Inventory (available on host): ${input.availablePlugins.map((p) => `${p.name} (${p.manufacturer}, ${p.role})`).join('; ')}`
      : 'External VST3 Inventory: None connected (use native SYN-DSP processors only).',
    input.referenceAnalysis
      ? summarizeAnalysisForPrompt('REFERENCE TRACK MEASUREMENTS', input.referenceAnalysis)
      : '',
    'Design an optimal, explainable surgical mastering chain ending with a limiter or maximizer, explicitly stating supporting telemetry and potential tradeoffs in each processor reason.',
  ].filter(Boolean);

  const response = await ai.models.generateContent({
    model: 'gemini-4-hydrogen',
    contents: promptParts.join('\n\n'),
    config: {
      systemInstruction: SYSTEM_PROMPT,
      thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
      responseMimeType: 'application/json',
      responseSchema: STRATEGY_SCHEMA,
    },
  });

  const rawText = (response.text ?? '{}').trim();
  const data = JSON.parse(rawText);
  const { chain, reasoning } = parseAiChain(data.processors ?? []);

  return {
    id: `ai-${Date.now()}`,
    timestamp: Date.now(),
    source: 'gemini-ai' as const,
    genre: String(data.genre || 'Contemporary Mix'),
    musicalStyle: String(data.musicalStyle || input.objective || input.mode),
    instrumentationSummary: String(data.instrumentationSummary || ''),
    vocalPresence: String(data.vocalPresence || ''),
    tonalCharacteristics: String(data.tonalCharacteristics || ''),
    issuesDetected: Array.isArray(data.issuesDetected) ? data.issuesDetected.map(String) : [],
    strategySummary: String(data.strategySummary || ''),
    targetLufs: Number(data.targetLufs ?? input.targetLufs ?? -14),
    targetTruePeakDb: Number(data.targetTruePeakDb ?? -1.0),
    reasoningPerProcessor: reasoning,
    chain,
  };
}

export async function refineGeminiIteration(input: {
  preAnalysis: AudioAnalysis;
  postAnalysis: AudioAnalysis;
  currentChain: ProcessorModule[];
  targetLufs: number;
  targetTruePeakDb: number;
  preserveDynamics: boolean;
  qcReport?: QCReport | null;
}) {
  const ai = getAiClient();
  const qcSummary = input.qcReport
    ? `QC Overall: ${input.qcReport.overallStatus.toUpperCase()}\n` +
      input.qcReport.checks
        .filter((c) => c.status !== 'pass')
        .map((c) => `- ${c.status.toUpperCase()} [${c.label}]: measured ${c.measuredValue}, target ${c.targetValue} -> ${c.suggestedFix ?? c.explanation}`)
        .join('\n')
    : 'QC report not supplied.';

  const prompt = [
    summarizeAnalysisForPrompt('ORIGINAL SOURCE', input.preAnalysis),
    summarizeAnalysisForPrompt('CURRENT PROCESSED PASS', input.postAnalysis),
    `INDEPENDENT SYN-QC EVALUATION:\n${qcSummary}`,
    `Current Chain JSON:\n${JSON.stringify(input.currentChain.map((m) => ({ type: m.type, name: m.name, intensity: m.intensity, wetDry: m.wetDry, params: m.params })))}`,
    `Objectives: Target LUFS=${input.targetLufs}, Max True Peak=${input.targetTruePeakDb} dBTP, Preserve Dynamics=${input.preserveDynamics}`,
    'Evaluate unintended degradation (excessive limiting, distortion/THD, phase loss, L/R imbalance, noise floor, LUFS miss) and output a refined chain resolving QC warnings/failures without degrading dynamics.',
  ].join('\n\n');

  const response = await ai.models.generateContent({
    model: 'gemini-4-hydrogen',
    contents: prompt,
    config: {
      systemInstruction: SYSTEM_PROMPT,
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      responseMimeType: 'application/json',
      responseSchema: STRATEGY_SCHEMA,
    },
  });

  const data = JSON.parse((response.text ?? '{}').trim());
  const { chain, reasoning } = parseAiChain(data.processors ?? []);

  return {
    strategySummary: String(data.strategySummary || 'Refined mastering pass parameters.'),
    issuesDetected: Array.isArray(data.issuesDetected) ? data.issuesDetected.map(String) : [],
    reasoningPerProcessor: reasoning,
    chain: chain.length > 0 ? chain : input.currentChain,
  };
}
