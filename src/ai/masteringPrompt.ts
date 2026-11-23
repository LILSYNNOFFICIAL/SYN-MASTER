/**
 * Provider-independent mastering prompt, JSON schema and response validation.
 * Shared by the server's built-in Gemini route (src/server/aiMastering.ts) and the
 * browser-side bring-your-own-AI adapters (src/ai/providerAdapters.ts), so every provider
 * gets the SAME system prompt, the SAME user prompt and the SAME validation.
 * Isomorphic: no Node or @google/genai imports here.
 */
import type {
  AudioAnalysis,
  CustomObjectiveSpec,
  DirectorOperatingMode,
  MasteringMode,
  MasteringObjectiveId,
  ProcessorModule,
  QCReport,
} from '../types/mastering.ts';
import { validateChainAgainstInventory } from '../director/processorInventory.ts';

export interface StrategyPromptInput {
  analysis: AudioAnalysis;
  mode: MasteringMode;
  objective?: MasteringObjectiveId;
  customObjective?: Partial<CustomObjectiveSpec> | null;
  operatingMode?: DirectorOperatingMode;
  targetLufs?: number;
  userGenreOverride?: string;
  referenceAnalysis?: AudioAnalysis | null;
  availablePlugins?: Array<{ name: string; role: string; manufacturer: string }>;
}

export interface RefinePromptInput {
  preAnalysis: AudioAnalysis;
  postAnalysis: AudioAnalysis;
  currentChain: ProcessorModule[];
  targetLufs: number;
  targetTruePeakDb: number;
  preserveDynamics: boolean;
  qcReport?: QCReport | null;
}

export function summarizeAnalysisForPrompt(label: string, a: AudioAnalysis): string {
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

export const SYSTEM_PROMPT = `You are SYN-MASTER AI | Mastering Director, an elite mastering engineer controlling a real DSP engine.
You receive real ITU-R BS.1770 loudness, dynamics, spectral zone energies, resonances, THD, noise floor, L/R balance, and stereo phase diagnostics.
Never invent fake numbers—reference only the actual measured telemetry provided.
Supported Mastering Objectives: streaming, commercial-loudness, dynamic, cinematic, electronic, hip-hop, pop, acoustic, vocal-focused, transparent, punchy, warm, custom.
AI-generated sources (Suno/Udio) often carry clicks, transient spikes and metallic high-frequency shimmer: when clickCount > 0 put "restore" first with declick enabled.
Distinguish intentional artistic tonal/stereo character from technical defects (clipping, DC offset, low-end phase cancellation, elevated noise floor, narrow painful resonances).
Use ONLY needed processors; keep EQ moves surgical (+/- 4 dB max unless correcting severe imbalance) and protect musical transients.

Valid paramsJson schemas by processor type:
1. "parametric-eq": {"phaseMode":"minimum"|"linear","msMode":"stereo"|"mid-side","tiltDb":number,"bands":[{"id":"b1","enabled":true,"shape":"highpass"|"lowshelf"|"bell"|"highshelf"|"lowpass"|"notch","freq":number,"gain":number,"q":number}]}
2. "dynamic-eq": {"bands":[{"id":"d1","enabled":true,"freq":number,"q":number,"thresholdDb":number,"maxCutDb":number,"attackMs":number,"releaseMs":number}]}
3. "compressor": {"mode":"downward"|"upward"|"parallel","thresholdDb":number,"ratio":number,"attackMs":number,"releaseMs":number,"kneeDb":number,"makeupDb":number,"scHpfHz":number}
4. "multiband-comp": {"lowCrossHz":number,"highCrossHz":number,"low":{"thresholdDb":number,"ratio":number,"attackMs":number,"releaseMs":number,"gainDb":number,"bypass":false},"mid":{"thresholdDb":number,"ratio":number,"attackMs":number,"releaseMs":number,"gainDb":number,"bypass":false},"high":{"thresholdDb":number,"ratio":number,"attackMs":number,"releaseMs":number,"gainDb":number,"bypass":false}}
5. "saturation": {"flavor":"tube"|"tape"|"soft-clip"|"hard-clip"|"exciter","drive":number,"tone":number,"harmonics":"even"|"odd"|"balanced","oversampling":2}
6. "stereo-imager": {"lowWidth":number,"midWidth":number,"highWidth":number,"lowCrossHz":number,"highCrossHz":number,"monoBassBelowHz":number,"lrBalanceDb":number,"midSideGainDb":number}
7. "restore": {"dcOffset":boolean,"humRemovalHz":0|50|60,"hissReduction":number,"deEssAmount":number,"deEssFreqHz":number,"resonanceSuppress":number,"mode":"conservative"|"aggressive","declick":0-100,"decrackle":0-100,"spikeRepair":boolean,"deShimmer":0-100} (declick/decrackle/spikeRepair fix measured clickCount; deShimmer reduces metallic AI-generation artifacts above 9 kHz)
8. "bass-enhancer": {"subFreqHz":number,"subGainDb":number,"harmonicDrive":number,"tightness":number,"monoFocus":boolean}
9. "limiter": {"ceilingDb":number,"thresholdDb":number,"releaseMs":number,"lookaheadMs":number,"truePeak":true,"oversampling":4}
10. "maximizer": {"character":"transparent"|"punchy"|"aggressive"|"smooth","targetLufs":number,"ceilingDb":number,"transientEmphasis":number,"truePeak":true}
11. "transient-shaper": {"attackDb":-12..12,"sustainDb":-12..12,"speedMs":2..60,"lowCutHz":20..300}
12. "clipper": {"ceilingDb":-6..0,"driveDb":0..12,"softness":0..100,"oversampling":1|2|4} (place before the limiter)
13. "multiband-maximizer": {"lowCrossHz":number,"highCrossHz":number,"low":{"preGainDb":number,"thresholdDb":number,"ratio":number,"attackMs":number,"releaseMs":number,"postGainDb":number,"bypass":false},"mid":{...same},"high":{...same},"ceilingDb":number,"releaseMs":number}
14. "dither": {"bitDepth":16|20|24,"shape":"tpdf"|"tpdf-hp"|"shaped","autoBlank":true} (always LAST; only when delivering below 32-bit float)`;

export function buildStrategyUserPrompt(input: StrategyPromptInput): string {
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
  return promptParts.join('\n\n');
}

export function buildRefineUserPrompt(input: RefinePromptInput): string {
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
  return prompt;
}

/** Standard JSON Schema for the strategy object (OpenAI json_schema, Anthropic tool input, Gemini REST). */
export const PROCESSOR_JSON_SCHEMA = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      description:
        'Must be one of: parametric-eq, dynamic-eq, compressor, multiband-comp, saturation, stereo-imager, restore, bass-enhancer, limiter, maximizer, transient-shaper, clipper, multiband-maximizer, dither',
    },
    name: { type: 'string' },
    intensity: { type: 'number', description: '0 to 100' },
    wetDry: { type: 'number', description: '0 to 100' },
    inputGainDb: { type: 'number', description: '-12 to +12' },
    outputGainDb: { type: 'number', description: '-12 to +12' },
    reason: { type: 'string', description: 'Engineering justification referencing measured metrics & tradeoffs' },
    paramsJson: {
      type: 'string',
      description:
        'Valid JSON string matching the exact parameter object schema for the chosen processor type.',
    },
  },
  required: ['type', 'name', 'intensity', 'wetDry', 'reason', 'paramsJson'],
} as const;

export const STRATEGY_JSON_SCHEMA = {
  type: 'object',
  properties: {
    genre: { type: 'string' },
    musicalStyle: { type: 'string' },
    instrumentationSummary: { type: 'string' },
    vocalPresence: { type: 'string' },
    tonalCharacteristics: { type: 'string' },
    issuesDetected: { type: 'array', items: { type: 'string' } },
    strategySummary: { type: 'string' },
    targetLufs: { type: 'number' },
    targetTruePeakDb: { type: 'number' },
    processors: { type: 'array', items: PROCESSOR_JSON_SCHEMA },
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
} as const;

/** Gemini REST (`generationConfig.responseSchema`) uses upper-case OpenAPI type names. */
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    out[k] = k === 'type' && typeof v === 'string' ? v.toUpperCase() : toGeminiSchema(v);
  }
  return out;
}

export class AiValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiValidationError';
  }
}

export function parseAiChain(
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
  if (rawProcessors.length === 0) {
    return { chain: [], reasoning: [] };
  }

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

  const inventoryCheck = validateChainAgainstInventory(parsed);
  if (!inventoryCheck.valid) {
    throw new AiValidationError(
      `AI generated invalid processor chain: ${inventoryCheck.errors[0] ?? 'Inventory verification failed'}`,
    );
  }

  const chain = inventoryCheck.sanitizedChain;
  const reasoning = rawProcessors
    .slice(0, chain.length)
    .map((p, idx) => ({
      processorType: chain[idx].type,
      reason: String(p.reason || '').slice(0, 400),
    }));

  return { chain, reasoning };
}

type RawStrategy = Record<string, unknown> & { processors?: unknown };

function rawProcessorsOf(data: RawStrategy): Parameters<typeof parseAiChain>[0] {
  const list = data.processors;
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new AiValidationError('AI response "processors" must be an array.');
  return list.map((p, i) => {
    if (!p || typeof p !== 'object') throw new AiValidationError(`AI response processors[${i}] must be an object.`);
    const r = p as Record<string, unknown>;
    return {
      type: String(r.type ?? ''),
      name: String(r.name ?? ''),
      intensity: Number(r.intensity),
      wetDry: Number(r.wetDry),
      inputGainDb: r.inputGainDb === undefined ? undefined : Number(r.inputGainDb),
      outputGainDb: r.outputGainDb === undefined ? undefined : Number(r.outputGainDb),
      reason: String(r.reason ?? ''),
      // Some providers return params as an object instead of a JSON string.
      paramsJson: typeof r.paramsJson === 'string' ? r.paramsJson : JSON.stringify(r.paramsJson ?? r.params ?? {}),
    };
  });
}

/** Same normalization the built-in Gemini route applies to its strategy response. */
export function normalizeStrategyResponse(data: RawStrategy, input: Pick<StrategyPromptInput, 'objective' | 'mode' | 'targetLufs'>) {
  const { chain, reasoning } = parseAiChain(rawProcessorsOf(data));
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

/** Same normalization the built-in Gemini route applies to its refine response. */
export function normalizeRefineResponse(data: RawStrategy, currentChain: ProcessorModule[]) {
  const { chain, reasoning } = parseAiChain(rawProcessorsOf(data));
  return {
    strategySummary: String(data.strategySummary || 'Refined mastering pass parameters.'),
    issuesDetected: Array.isArray(data.issuesDetected) ? data.issuesDetected.map(String) : [],
    reasoningPerProcessor: reasoning,
    chain: chain.length > 0 ? chain : currentChain,
  };
}
