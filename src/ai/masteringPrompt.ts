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
  VocalBalanceVerification,
} from '../types/mastering.ts';
import { validateChainAgainstInventory } from '../director/processorInventory.ts';
import { summarizeVocalBalanceForPrompt, type VocalBalanceContext } from './vocalBalancePrompt.ts';
import { formatPlatformHintsForPrompt } from '../dsp/platformRules.ts';
import type { MasterTargetGate } from '../director/masterTargets.ts';

export interface StrategyPromptInput {
  analysis: AudioAnalysis;
  mode: MasteringMode;
  objective?: MasteringObjectiveId;
  customObjective?: Partial<CustomObjectiveSpec> | null;
  operatingMode?: DirectorOperatingMode;
  targetLufs?: number;
  userGenreOverride?: string;
  referenceAnalysis?: AudioAnalysis | null;
  vocalBalanceVerification?: VocalBalanceVerification;
  availablePlugins?: Array<{ name: string; role: string; manufacturer: string }>;
  /** Vocal Rebalance context: whether stems are cached and the measured vocal balance. */
  vocalBalance?: VocalBalanceContext | null;
}

export interface RefinePromptInput {
  preAnalysis: AudioAnalysis;
  postAnalysis: AudioAnalysis;
  currentChain: ProcessorModule[];
  referenceAnalysis?: AudioAnalysis | null;
  vocalBalanceVerification?: VocalBalanceVerification;
  remainingFindings?: Array<{
    findingId: string;
    title: string;
    status: string;
    detail: string;
    recommendedAction?: string;
    measurementReliable: boolean;
  }>;
  targetLufs: number;
  targetTruePeakDb: number;
  preserveDynamics: boolean;
  qcReport?: QCReport | null;
  targetGate?: MasterTargetGate | null;
  vocalBalance?: VocalBalanceContext | null;
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
Never invent fake numbers—reference only the actual measured telemetry provided. When an OBJECTIVE GATE is supplied, treat every FAIL as blocking: explicitly correct each reversible failed check, preserve already-passing checks, and never claim success unless the rendered audio passes the gate.
Supported Mastering Objectives: streaming, commercial-loudness, dynamic, cinematic, electronic, hip-hop, pop, acoustic, vocal-focused, transparent, punchy, warm, custom.
AI-generated sources (Suno/Udio) often carry clicks, transient spikes and metallic high-frequency shimmer: when clickCount > 0 put "restore" first with declick enabled.
Distinguish intentional artistic tonal/stereo character from technical defects (clipping, DC offset, low-end phase cancellation, elevated noise floor, narrow painful resonances).
Use ONLY needed processors; keep EQ moves surgical (+/- 4 dB max unless correcting severe imbalance) and protect musical transients.

PROCESSOR SELECTION IS PART OF THE TASK, NOT AN OPTIONAL SUGGESTION:
- All 16 supported native processors below are available choices, not a required rack template. Select only tools justified by this track's measurements; do not omit a suitable tool just because it was not used in a prior run.
- On every refinement, compare the latest rendered measurements with the current chain and its settings. Retune the relevant existing processor when it has not met its measured target, remove it when evidence no longer supports it, or select a different complementary tool when that better addresses the remaining evidence. Never repeat unchanged settings when the same measured failure persists, and never call a track mastered because a processor was merely added.
- Select and configure Dynamic EQ when measurements show frequency-dependent problems that vary over time (isolated resonances, sibilance, or low-mid buildup that appears only in dense passages). Set detector threshold, maxCutDb, ratio, attack and release from the measured severity; do not add empty/default Dynamic EQ bands.
- Select Match EQ only when a real, analyzed reference track/profile is supplied and the measured tonal difference is meaningful. Configure amount, smoothing, frequency limits and channel from that reference. Never invent a reference or use Match EQ as a generic tone control.
- Select Vocal Rebalance only when vocal stems are present or the measured/diagnosed vocal-to-music balance requires stem-level gain correction. If the diagnosis requires it but stems are not yet available, request/trigger stem separation before applying the processor; do not silently discard the correction or claim it was applied.
- Combine processors when they address distinct measured defects (for example, Dynamic EQ for time-varying harshness plus Match EQ for broad reference-relative tonal balance). Avoid duplicate stages that solve the same problem, and explain why each selected processor is needed.
- Do not equate adding a processor with fixing a defect. Every correction must be checked against fresh post-render measurements; if the evidence is missing or the target remains unmet, report it as unverified or unresolved.

Valid paramsJson schemas by processor type:
1. "parametric-eq": {"phaseMode":"minimum"|"linear","msMode":"stereo"|"mid-side","tiltDb":number,"autoGain"?:boolean,"bands":[{"id":"b1","enabled":true,"shape":"bell"|"lowshelf"|"highshelf"|"lowpass"|"highpass"|"notch"|"bandpass"|"tilt","subtype"?:string,"slope"?:6|12|18|24|36|48|72|96,"channel"?:"stereo"|"mid"|"side"|"left"|"right","freq":number,"gain":number,"q":number}]} (max 8 bands; gain -12..12 dB; q 0.25..12. subtype by shape: bell -> "bell" (default) | "proportional" (Q narrows as gain rises: wide gentle moves, narrow deep cuts) | "band-shelf" (flat-top band); lowshelf/highshelf -> "analog" (default) | "baxandall" (gentle wide tone shelf) | "vintage" (Pultec-style shelf with opposite dip) | "resonant" (shelf with overshoot); lowpass/highpass -> "flat" (default Butterworth) | "resonant" (peak at cutoff) | "brickwall" (very steep, fixed). slope: pass flat 6-96, pass resonant 12-96, shelf analog 6|12|24, shelf resonant 12|24; omit for the 12 dB/oct default. channel overrides msMode per band: e.g. "side" highpass ~100-150 Hz to mono the lows, "mid" bell for vocal presence. autoGain trims output to cancel the curve's loudness change; omit to keep level changes. Omit optional fields you do not need.)
2. "dynamic-eq": {"bands":[{"id":"d1","enabled":true,"type"?:"bell"|"proportional"|"band-shelf"|"baxandall-bass"|"baxandall-treble"|"low-shelf"|"high-shelf","freq":number,"q":number,"thresholdDb":number,"maxCutDb":number,"ratio":number,"mode":"cut"|"boost","kneeDb"?:number,"attackMs":number,"releaseMs":number,"channel"?:"stereo"|"mid"|"side"|"left"|"right","sidechain"?:{"mode":"band"|"custom","freq":number,"q":number},"lookaheadMs"?:number}]} (max 8 bands; maxCutDb is the range: -12..0 for cut, 0..12 for boost; ratio 1-20; kneeDb 0-24; lookaheadMs 0-10; sidechain "custom" lets the detector listen at its own freq/Q, e.g. duck 2-4 kHz on the mid only when sibilance at 6-8 kHz fires.)
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
14. "dither": {"bitDepth":16|20|24,"shape":"tpdf"|"tpdf-hp"|"shaped","autoBlank":true} (always LAST; only when delivering below 32-bit float)
15. "match-eq": {"amount":0-100,"smoothing":1|2|3|6|12|24,"maxBoostDb":0-12,"maxCutDb":0-12,"lowHz":20-2000,"highHz":1000-20000,"channel":"stereo"|"mid"|"side","phase":"linear"|"minimum"} (Ozone-style Match EQ: the engine learns the long-term average spectrum of the source and of the loaded REFERENCE track and applies amount% of the smoothed difference, limited to maxBoostDb / maxCutDb and faded out below lowHz / above highHz; it matches tonal shape, not loudness. ONLY when the prompt says Match EQ is AVAILABLE; at most one; place it early (after restore, before other EQ and dynamics). Stay conservative: amount 30-60, smoothing 3 or wider (1/3 octave or 1/1-1/2 for broad tilt), maxBoostDb/maxCutDb 1.5-3, lowHz >= 30, highHz <= 16000, "stereo" unless the reference differs mainly in side/mid balance. Never send learned spectra; the engine supplies them.)
16. "vocal-rebalance": {"vocalGainDb":-12..6,"bassEnabled":boolean,"bassGainDb":-12..6,"drumsEnabled":boolean,"drumsGainDb":-12..6,"sensitivity":0..100,"smoothingMs":5..500} (Ozone Master Rebalance style: raises/lowers the vocal, and optionally bass/drums, inside the finished mix using cached AI stems; phase-preserving, 0 dB = untouched. Use ONLY when the VOCAL REBALANCE block says stems are cached and the vocal is buried or too loud for the objective; keep moves small; always FIRST in the chain.)`;

/** What each user-selected Mode asks of the strategy. Sent as its own line next to the Objective. */
export const MODE_MEANINGS: Record<MasteringMode, string> = {
  'ai-auto': 'fully automatic; the AI chooses every setting',
  manual: 'the user drives the controls; propose conservative, easily adjustable moves',
  hybrid: 'AI sets a solid starting master that the user will fine-tune by hand; keep moves clear and editable',
  transparent: 'minimal, transparent processing; preserve the original tone and dynamics',
  loudness: 'prioritise competitive loudness and density within the true-peak ceiling',
  analog: 'add analog-style warmth and harmonic character (saturation, gentle glue)',
  dynamic: 'preserve dynamics and transients; avoid heavy compression and limiting',
  reference: 'match the tonal balance, loudness and width of the reference track',
  streaming: 'optimise for streaming platform normalisation and translation',
  custom: 'follow the custom objective constraints',
};

export function formatModeLine(mode: MasteringMode): string {
  return `Mode: ${mode} — ${MODE_MEANINGS[mode] ?? 'user-selected mastering mode'}`;
}

/** Match EQ needs a learned reference spectrum; the app learns one whenever a reference track is loaded. */
export function formatMatchEqAvailability(referenceLoaded: boolean): string {
  return referenceLoaded
    ? 'Match EQ: AVAILABLE (reference long-term spectrum learned). You may add one conservative "match-eq" to move the tonal balance toward the reference.'
    : 'Match EQ: NOT AVAILABLE (no reference track loaded). Do not use "match-eq".';
}

function formatVocalBalanceVerification(verification?: VocalBalanceVerification): string {
  if (!verification) return '';
  const measured = (value: number | null) => value === null ? 'unavailable' : `${value.toFixed(1)} dB`;
  return [
    'VOCAL-FOCUSED PRE-CHAIN VERIFICATION:',
    `- Status: ${verification.status}. Source ${measured(verification.sourceBalanceDb)}; reference ${measured(verification.referenceBalanceDb)}; independently rendered ${measured(verification.postRenderBalanceDb)}; applied gain ${verification.appliedGainDb >= 0 ? '+' : ''}${verification.appliedGainDb.toFixed(1)} dB.`,
    `- ${verification.summary}`,
    verification.status === 'verified' || verification.status === 'not-needed'
      ? 'This preparation has already been measured; do not duplicate the correction.'
      : 'This preparation was not verified; do not claim it fixed vocal balance. Any further Vocal Rebalance requires valid stems and evidence.',
  ].join('\n');
}

/** Chain JSON for prompts: Match EQ learned spectra (hundreds of numbers) are summarised, not sent. */
export function chainForPrompt(chain: ProcessorModule[]) {
  return chain.map((m) => {
    let params: unknown = m.params;
    if (m.type === 'match-eq' && params && typeof params === 'object') {
      const { source, reference, ...rest } = params as unknown as Record<string, unknown>;
      params = { ...rest, learned: Boolean(source && reference) };
    }
    return { type: m.type, name: m.name, intensity: m.intensity, wetDry: m.wetDry, params };
  });
}

export function buildStrategyUserPrompt(input: StrategyPromptInput): string {
  const promptParts = [
    summarizeAnalysisForPrompt('SOURCE TRACK MEASUREMENTS', input.analysis),
    `Mastering Objective: ${(input.objective ?? input.mode).toUpperCase()} | Operating Mode: ${input.operatingMode ?? 'autonomous'}`,
    formatModeLine(input.mode),
    input.customObjective ? `Custom Objective Constraints: ${JSON.stringify(input.customObjective)}` : '',
    input.targetLufs ? `Requested Target Loudness: ${input.targetLufs} LUFS` : '',
    input.userGenreOverride ? `User Genre Classification: ${input.userGenreOverride}` : '',
    input.availablePlugins && input.availablePlugins.length > 0
      ? `Connected Third-Party VST3 Inventory (available on host): ${input.availablePlugins.map((p) => `${p.name} (${p.manufacturer}, ${p.role})`).join('; ')}`
      : 'External VST3 Inventory: None connected (use native SYN-DSP processors only).',
    input.referenceAnalysis
      ? summarizeAnalysisForPrompt('REFERENCE TRACK MEASUREMENTS', input.referenceAnalysis)
      : '',
    formatMatchEqAvailability(Boolean(input.referenceAnalysis)),
    formatVocalBalanceVerification(input.vocalBalanceVerification),
    input.vocalBalance !== undefined ? summarizeVocalBalanceForPrompt(input.vocalBalance) : '',
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
  const objectiveGateSummary = input.targetGate
    ? `OBJECTIVE GATE: ${input.targetGate.passed ? 'PASS' : 'FAIL'}\n` +
      input.targetGate.checks
        .map((check) => `- ${check.status.toUpperCase()} [${check.label}]: measured ${check.measured}; target ${check.target}${check.fix ? ` -> ${check.fix}` : ''}`)
        .join('\n')
    : 'OBJECTIVE GATE: not supplied. Use the measured telemetry and stated mastering objectives.';
  const findingsSummary = input.remainingFindings
    ? `REMAINING TECHNICAL FINDINGS:\n${input.remainingFindings.length > 0
      ? input.remainingFindings.map((finding) =>
          `- ${finding.findingId} [${finding.status}; ${finding.measurementReliable ? 'reliable' : 'unverified'}]: ${finding.title}. ${finding.detail}${finding.recommendedAction ? ` Next action: ${finding.recommendedAction}` : ''}`,
        ).join('\n')
      : 'None currently active or newly introduced.'}`
    : '';

  const prompt = [
    summarizeAnalysisForPrompt('ORIGINAL SOURCE', input.preAnalysis),
    summarizeAnalysisForPrompt('CURRENT PROCESSED PASS', input.postAnalysis),
    input.referenceAnalysis ? summarizeAnalysisForPrompt('REFERENCE TRACK MEASUREMENTS', input.referenceAnalysis) : '',
    formatMatchEqAvailability(Boolean(input.referenceAnalysis)),
    formatVocalBalanceVerification(input.vocalBalanceVerification),
    findingsSummary,
    `INDEPENDENT SYN-QC EVALUATION:\n${qcSummary}`,
    objectiveGateSummary,
    formatPlatformHintsForPrompt(input.qcReport?.platformHints),
    `Current Chain JSON:\n${JSON.stringify(chainForPrompt(input.currentChain))}`,
    `Objectives: Target LUFS=${input.targetLufs}, Max True Peak=${input.targetTruePeakDb} dBTP, Preserve Dynamics=${input.preserveDynamics}`,
    ...(input.vocalBalance !== undefined ? [summarizeVocalBalanceForPrompt(input.vocalBalance)] : []),
    'Resolve every FAIL in OBJECTIVE GATE and every blocking QC failure. All 16 supported native processors in the system schema are available; select only those that fit this track\'s evidence. Compare every current processor and setting with the latest render: retune it when its target remains unmet, remove it when no longer justified, or add a different complementary tool when measurements support that choice. Preserve passing targets, output the complete refined chain, and never repeat unchanged settings for a persistent failure or substitute generic tone shaping for a named failed gate.',
  ].filter(Boolean).join('\n\n');
  return prompt;
}

/** Standard JSON Schema for the strategy object (OpenAI json_schema, Anthropic tool input, Gemini REST). */
export const PROCESSOR_JSON_SCHEMA = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      description:
        'Must be one of: parametric-eq, dynamic-eq, compressor, multiband-comp, saturation, stereo-imager, restore, bass-enhancer, limiter, maximizer, transient-shaper, clipper, multiband-maximizer, dither, match-eq, vocal-rebalance',
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
