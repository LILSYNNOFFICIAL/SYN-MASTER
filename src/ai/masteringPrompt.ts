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
import { MASTERING_OBJECTIVE_IDS } from '../types/mastering.ts';
import { validateChainAgainstInventory } from '../director/processorInventory.ts';
import { PROCESSOR_PARAM_LIMITS } from '../dsp/chainValidation.ts';
import { summarizeVocalBalanceForPrompt, type VocalBalanceContext } from './vocalBalancePrompt.ts';
import { formatPlatformHintsForPrompt } from '../dsp/platformRules.ts';
import type { MasterTargetGate } from '../director/masterTargets.ts';
import { collectModuleCorrections, MAX_AI_PARAM_CORRECTIONS, type AiParamCorrection } from './aiParamCorrections.ts';
import { formatGuardFeedbackForPrompt, type GuardFeedback } from '../director/guardFeedback.ts';

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
  mode?: MasteringMode;
  objective?: MasteringObjectiveId;
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
  guardFeedback?: GuardFeedback;
  vocalBalance?: VocalBalanceContext | null;
}

export function summarizeAnalysisForPrompt(label: string, a: AudioAnalysis): string {
  const bandCorrObj =
    a.stereoBandCorrelation && typeof a.stereoBandCorrelation === 'object'
      ? a.stereoBandCorrelation
      : null;
  const bandCorrSummary = bandCorrObj
    ? `low=${bandCorrObj.low}, mid=${bandCorrObj.mid}, high=${bandCorrObj.high}`
    : 'unavailable';
  const clickCountText =
    typeof a.clickCount === 'number' && Number.isFinite(a.clickCount)
      ? String(a.clickCount)
      : 'unavailable';
  const clickTimes = Array.isArray(a.clickTimesSec)
    ? a.clickTimesSec.filter((t) => typeof t === 'number' && Number.isFinite(t))
    : [];
  const clickTimesText = clickTimes.length > 0
    ? ` (timestamps: ${clickTimes.slice(0, 12).map((t) => `${t.toFixed(2)}s`).join(', ')}${clickTimes.length > 12 ? `, +${clickTimes.length - 12} more` : ''})`
    : '';
  const shimmerSummary =
    a.shimmer && typeof a.shimmer === 'object'
      ? `score=${a.shimmer.score}, confidence=${a.shimmer.confidence}`
      : 'unavailable';

  return [
    `${label}:`,
    `- Duration: ${a.durationSec}s | SampleRate: ${a.sampleRate}Hz | Channels: ${a.channels}`,
    `- Integrated LUFS: ${a.integratedLufs} | Short-Term Max: ${a.shortTermLufsMax} | Momentary Max: ${a.momentaryLufsMax} | LRA: ${a.loudnessRangeLu} LU`,
    `- Sample Peak: ${a.samplePeakDb} dBFS | True Peak: ${a.truePeakDb} dBTP | RMS: ${a.rmsDb} dBFS`,
    `- Dynamic Range: ${a.dynamicRangeDb} dB | Crest Factor: ${a.crestFactorDb} dB | PLR: ${a.plrDb} dB | Transient Density: ${a.transientDensity}`,
    `- Spectral Centroid: ${a.spectralCentroidHz} Hz | Spectral Slope: ${a.spectralSlopeDbPerOct} dB/oct`,
    `- Zones (dB): Sub=${a.zoneEnergyDb.sub}, Bass=${a.zoneEnergyDb.bass}, LowMid=${a.zoneEnergyDb.lowMid}, Mid=${a.zoneEnergyDb.mid}, HighMid=${a.zoneEnergyDb.highMid}, Presence=${a.zoneEnergyDb.presence}, Air=${a.zoneEnergyDb.air}`,
    `- Detected Resonances: ${a.resonances.length ? a.resonances.map((r) => `${r.freqHz}Hz (+${r.excessDb}dB)`).join(', ') : 'None significant'}`,
    `- Stereo Width: ${a.stereoWidth} | M/S Ratio: ${a.midSideRatioDb} dB | Phase Corr: ${a.phaseCorrelation} | Low-End Corr: ${a.lowEndCorrelation} | Band Corr (low/mid/high): ${bandCorrSummary} | L/R Balance: ${a.lrBalanceDb} dB | Mono Score: ${a.monoCompatibilityScore}/100`,
    `- Integrity & Noise: Clipped=${a.clippedSamples} | ISP=${a.interSamplePeaks} | THD=${a.thdEstimatePercent}% | NoiseFloor=${a.noiseFloorDb ?? -72} dBFS | DC Offset=${a.dcOffset}`,
    `- Artifacts & Restoration Telemetry: clickCount=${clickCountText}${clickTimesText} | shimmer: ${shimmerSummary}`,
  ].join('\n');
}

function fmtRange([min, max]: readonly [number, number]): string {
  return `${min}..${max}`;
}

function fmtEnum(values: readonly (string | number)[]): string {
  return values.map((v) => (typeof v === 'string' ? `"${v}"` : String(v))).join('|');
}

function buildProcessorSchemasPrompt(): string {
  const L = PROCESSOR_PARAM_LIMITS;
  const peq = L['parametric-eq'];
  const deq = L['dynamic-eq'];
  const comp = L.compressor;
  const mbComp = L['multiband-comp'];
  const sat = L.saturation;
  const img = L['stereo-imager'];
  const res = L.restore;
  const bass = L['bass-enhancer'];
  const lim = L.limiter;
  const max = L.maximizer;
  const tr = L['transient-shaper'];
  const clip = L.clipper;
  const mbMax = L['multiband-maximizer'];
  const dith = L.dither;
  const meq = L['match-eq'];
  const vox = L['vocal-rebalance'];

  const mbCompBand = `{"thresholdDb":${fmtRange(mbComp.band.thresholdDb)},"ratio":${fmtRange(mbComp.band.ratio)},"attackMs":${fmtRange(mbComp.band.attackMs)},"releaseMs":${fmtRange(mbComp.band.releaseMs)},"gainDb":${fmtRange(mbComp.band.gainDb)},"bypass":boolean}`;
  const mbMaxBand = `{"preGainDb":${fmtRange(mbMax.band.preGainDb)},"thresholdDb":${fmtRange(mbMax.band.thresholdDb)},"ratio":${fmtRange(mbMax.band.ratio)},"attackMs":${fmtRange(mbMax.band.attackMs)},"releaseMs":${fmtRange(mbMax.band.releaseMs)},"postGainDb":${fmtRange(mbMax.band.postGainDb)},"bypass":boolean}`;

  return [
    `1. "parametric-eq": {"phaseMode":${fmtEnum(peq.phaseMode)},"msMode":${fmtEnum(peq.msMode)},"tiltDb":${fmtRange(peq.tiltDb)},"autoGain"?:boolean,"bands":[{"id":string,"enabled":boolean,"shape":${fmtEnum(peq.band.shape)},"subtype"?:string,"slope"?:${fmtEnum(peq.band.slope)},"channel"?:${fmtEnum(peq.band.channel)},"freq":${fmtRange(peq.band.freq)},"gain":${fmtRange(peq.band.gain)},"q":${fmtRange(peq.band.q)}}]} (max ${peq.maxBands} bands. subtype by shape: bell -> "bell" (default) | "proportional" (Q narrows as gain rises: wide gentle moves, narrow deep cuts) | "band-shelf" (flat-top band); lowshelf/highshelf -> "analog" (default) | "baxandall" (gentle wide tone shelf) | "vintage" (Pultec-style shelf with opposite dip) | "resonant" (shelf with overshoot); lowpass/highpass -> "flat" (default Butterworth) | "resonant" (peak at cutoff) | "brickwall" (very steep, fixed). slope: pass flat 6-96, pass resonant 12-96, shelf analog 6|12|24, shelf resonant 12|24; omit for the 12 dB/oct default. channel overrides msMode per band: e.g. "side" highpass ~100-150 Hz to mono the lows, "mid" bell for vocal presence. autoGain trims output to cancel the curve's loudness change; omit to keep level changes. Omit optional fields you do not need.)`,
    `2. "dynamic-eq": {"bands":[{"id":string,"enabled":boolean,"type"?:${fmtEnum(deq.band.type)},"freq":${fmtRange(deq.band.freq)},"q":${fmtRange(deq.band.q)},"thresholdDb":${fmtRange(deq.band.thresholdDb)},"maxCutDb":${fmtRange(deq.band.maxCutDbCut)} (cut) | ${fmtRange(deq.band.maxCutDbBoost)} (boost),"ratio":${fmtRange(deq.band.ratio)},"mode":${fmtEnum(deq.band.mode)},"kneeDb"?:${fmtRange(deq.band.kneeDb)},"attackMs":${fmtRange(deq.band.attackMs)},"releaseMs":${fmtRange(deq.band.releaseMs)},"channel"?:${fmtEnum(deq.band.channel)},"sidechain"?:{"mode":${fmtEnum(deq.band.sidechainMode)},"freq":${fmtRange(deq.band.sidechainFreq)},"q":${fmtRange(deq.band.sidechainQ)}},"lookaheadMs"?:${fmtRange(deq.band.lookaheadMs)}}]} (max ${deq.maxBands} bands; maxCutDb is ${fmtRange(deq.band.maxCutDbCut)} for cut, ${fmtRange(deq.band.maxCutDbBoost)} for boost; sidechain "custom" lets the detector listen at its own freq/Q, e.g. duck 2-4 kHz on the mid only when sibilance at 6-8 kHz fires.)`,
    `3. "compressor": {"mode":${fmtEnum(comp.mode)},"thresholdDb":${fmtRange(comp.thresholdDb)},"ratio":${fmtRange(comp.ratio)},"attackMs":${fmtRange(comp.attackMs)},"releaseMs":${fmtRange(comp.releaseMs)},"kneeDb":${fmtRange(comp.kneeDb)},"makeupDb":${fmtRange(comp.makeupDb)},"scHpfHz":${fmtRange(comp.scHpfHz)}}`,
    `4. "multiband-comp": {"lowCrossHz":${fmtRange(mbComp.lowCrossHz)},"highCrossHz":${mbComp.lowCrossHz[0] + mbComp.highCrossMinOffsetHz}..${mbComp.highCrossMaxHz} (min lowCrossHz+${mbComp.highCrossMinOffsetHz}),"low":${mbCompBand},"mid":${mbCompBand},"high":${mbCompBand}}`,
    `5. "saturation": {"flavor":${fmtEnum(sat.flavor)},"drive":${fmtRange(sat.drive)},"tone":${fmtRange(sat.tone)},"harmonics":${fmtEnum(sat.harmonics)},"oversampling":${fmtEnum(sat.oversampling)}}`,
    `6. "stereo-imager": {"lowWidth":${fmtRange(img.lowWidth)},"midWidth":${fmtRange(img.midWidth)},"highWidth":${fmtRange(img.highWidth)},"lowCrossHz":${fmtRange(img.lowCrossHz)},"highCrossHz":${img.lowCrossHz[0] + img.highCrossMinOffsetHz}..${img.highCrossMaxHz} (min lowCrossHz+${img.highCrossMinOffsetHz}),"monoBassBelowHz":${fmtRange(img.monoBassBelowHz)},"lrBalanceDb":${fmtRange(img.lrBalanceDb)},"midSideGainDb":${fmtRange(img.midSideGainDb)}}`,
    `7. "restore": {"dcOffset":boolean,"humRemovalHz":${fmtEnum(res.humRemovalHz)},"hissReduction":${fmtRange(res.hissReduction)},"deEssAmount":${fmtRange(res.deEssAmount)},"deEssFreqHz":${fmtRange(res.deEssFreqHz)},"resonanceSuppress":${fmtRange(res.resonanceSuppress)},"mode":${fmtEnum(res.mode)},"declick":${fmtRange(res.declick)},"decrackle":${fmtRange(res.decrackle)},"spikeRepair":boolean,"deShimmer":${fmtRange(res.deShimmer)}} (declick/decrackle/spikeRepair fix measured clickCount; deShimmer reduces metallic AI-generation artifacts above 9 kHz)`,
    `8. "bass-enhancer": {"subFreqHz":${fmtRange(bass.subFreqHz)},"subGainDb":${fmtRange(bass.subGainDb)},"harmonicDrive":${fmtRange(bass.harmonicDrive)},"tightness":${fmtRange(bass.tightness)},"monoFocus":boolean}`,
    `9. "limiter": {"ceilingDb":${fmtRange(lim.ceilingDb)},"thresholdDb":${fmtRange(lim.thresholdDb)},"releaseMs":${fmtRange(lim.releaseMs)},"lookaheadMs":${fmtRange(lim.lookaheadMs)},"truePeak":boolean,"oversampling":${fmtEnum(lim.oversampling)}}`,
    `10. "maximizer": {"character":${fmtEnum(max.character)},"targetLufs":${fmtRange(max.targetLufs)},"ceilingDb":${fmtRange(max.ceilingDb)},"transientEmphasis":${fmtRange(max.transientEmphasis)},"truePeak":boolean}`,
    `11. "transient-shaper": {"attackDb":${fmtRange(tr.attackDb)},"sustainDb":${fmtRange(tr.sustainDb)},"speedMs":${fmtRange(tr.speedMs)},"lowCutHz":${fmtRange(tr.lowCutHz)}}`,
    `12. "clipper": {"ceilingDb":${fmtRange(clip.ceilingDb)},"driveDb":${fmtRange(clip.driveDb)},"softness":${fmtRange(clip.softness)},"oversampling":${fmtEnum(clip.oversampling)}} (place before the limiter)`,
    `13. "multiband-maximizer": {"lowCrossHz":${fmtRange(mbMax.lowCrossHz)},"highCrossHz":${mbMax.lowCrossHz[0] + mbMax.highCrossMinOffsetHz}..${mbMax.highCrossMaxHz} (min lowCrossHz+${mbMax.highCrossMinOffsetHz}),"low":${mbMaxBand},"mid":${mbMaxBand},"high":${mbMaxBand},"ceilingDb":${fmtRange(mbMax.ceilingDb)},"releaseMs":${fmtRange(mbMax.releaseMs)}}`,
    `14. "dither": {"bitDepth":${fmtEnum(dith.bitDepth)},"shape":${fmtEnum(dith.shape)},"autoBlank":boolean} (always LAST; only when delivering below 32-bit float)`,
    `15. "match-eq": {"amount":${fmtRange(meq.amount)},"smoothing":${fmtEnum(meq.smoothing)},"maxBoostDb":${fmtRange(meq.maxBoostDb)},"maxCutDb":${fmtRange(meq.maxCutDb)},"lowHz":${fmtRange(meq.lowHz)},"highHz":${fmtRange(meq.highHz)} (min max(${meq.highHz[0]}, 2*lowHz)),"channel":${fmtEnum(meq.channel)},"phase":${fmtEnum(meq.phase)}} (Ozone-style Match EQ: the engine learns the long-term average spectrum of the source and of the loaded REFERENCE track and applies amount% of the smoothed difference, limited to maxBoostDb / maxCutDb and faded out below lowHz / above highHz; it matches tonal shape, not loudness. ONLY when the prompt says Match EQ is AVAILABLE; at most one; place it early (after restore, before other EQ and dynamics). Stay conservative: amount 30-60, smoothing 3 or wider (1/3 octave or 1/1-1/2 for broad tilt), maxBoostDb/maxCutDb 1.5-3, lowHz >= 30, highHz <= 16000, "stereo" unless the reference differs mainly in side/mid balance. Never send learned spectra; the engine supplies them.)`,
    `16. "vocal-rebalance": {"vocalGainDb":${fmtRange(vox.vocalGainDb)},"bassEnabled":boolean,"bassGainDb":${fmtRange(vox.bassGainDb)},"drumsEnabled":boolean,"drumsGainDb":${fmtRange(vox.drumsGainDb)},"sensitivity":${fmtRange(vox.sensitivity)},"smoothingMs":${fmtRange(vox.smoothingMs)}} (Ozone Master Rebalance style: raises/lowers the vocal, and optionally bass/drums, inside the finished mix using cached AI stems; phase-preserving, 0 dB = untouched. Use ONLY when the VOCAL REBALANCE block says stems are cached and the vocal is buried or too loud for the objective; keep moves small; always FIRST in the chain.)`,
  ].join('\n');
}

/** Native processor types the AI may return: every PROCESSOR_PARAM_LIMITS key except the module-level entry. */
export const AI_PROCESSOR_TYPES = Object.keys(PROCESSOR_PARAM_LIMITS).filter((k) => k !== 'module') as Array<
  Exclude<keyof typeof PROCESSOR_PARAM_LIMITS, 'module'>
>;

/** Most stages a chain may hold; validateChainAgainstInventory rejects a longer AI chain outright. */
export const AI_MAX_CHAIN_STAGES = 12;

export const SYSTEM_PROMPT = `You are SYN-MASTER AI | Mastering Director, an elite mastering engineer controlling a real DSP engine.
You receive real ITU-R BS.1770 loudness, dynamics, spectral zone energies, resonances, THD, noise floor, L/R balance, and stereo phase diagnostics.
Never invent fake numbers—reference only the actual measured telemetry provided. When an OBJECTIVE GATE is supplied, treat every FAIL as blocking: explicitly correct each reversible failed check, preserve already-passing checks, and never claim success unless the rendered audio passes the gate.
Supported Mastering Objectives: ${MASTERING_OBJECTIVE_IDS.join(', ')}.
AI-generated sources (Suno/Udio) often carry clicks, transient spikes and metallic high-frequency shimmer: when clickCount > 0 put "restore" first (after any "vocal-rebalance") with declick enabled.
Distinguish intentional artistic tonal/stereo character from technical defects (clipping, DC offset, low-end phase cancellation, elevated noise floor, narrow painful resonances).
Consider every available processor, but enable a tool only when measurements or musical goals justify it. Set precise parameter values, not just on/off; keep EQ moves within +/- 4 dB unless correcting severe imbalance, and protect musical transients. Give each module a short rationale citing its measurement, and in strategySummary name any available tool deliberately left unused and why.
The chain will be rendered and re-measured, so keep values conservative where measurement shows no problem.

PROCESSOR SELECTION IS PART OF THE TASK, NOT AN OPTIONAL SUGGESTION:
- All ${AI_PROCESSOR_TYPES.length} native processors below are available choices, not a required rack template (at most ${AI_MAX_CHAIN_STAGES} modules per chain). Do not omit a suitable tool just because it was not used in a prior run.
- On every refinement, compare the latest rendered measurements with the current chain and its settings. Retune the relevant existing processor when it has not met its measured target, remove it when evidence no longer supports it, or select a different complementary tool when that better addresses the remaining evidence. Never repeat unchanged settings when the same measured failure persists, and never call a track mastered because a processor was merely added.
- Select and configure Dynamic EQ when measurements show frequency-dependent problems that vary over time (isolated resonances, sibilance, or low-mid buildup that appears only in dense passages). Set detector threshold, maxCutDb, ratio, attack and release from the measured severity; do not add empty/default Dynamic EQ bands.
- Select Match EQ only when a real, analyzed reference track/profile is supplied and the measured tonal difference is meaningful. Configure amount, smoothing, frequency limits and channel from that reference. Never invent a reference or use Match EQ as a generic tone control.
- Select Vocal Rebalance only when vocal stems are present or the measured/diagnosed vocal-to-music balance requires stem-level gain correction. If the diagnosis requires it but stems are not yet available, request/trigger stem separation before applying the processor; do not silently discard the correction or claim it was applied.
- Combine processors when they address distinct measured defects (for example, Dynamic EQ for time-varying harshness plus Match EQ for broad reference-relative tonal balance). Avoid duplicate stages that solve the same problem.
- Do not equate adding a processor with fixing a defect. Every correction must be checked against fresh post-render measurements; if the evidence is missing or the target remains unmet, report it as unverified or unresolved.

MEASURED PROBLEM -> TOOL (starting points; set every relevant option from the schema):
- clickCount > 0 / spikes -> "restore" declick, decrackle, spikeRepair; metallic HF shimmer -> restore deShimmer; hum, hiss, DC offset -> restore humRemovalHz, hissReduction, dcOffset.
- Sub/bass excess or boom in dense passages -> "dynamic-eq" low band (cut, low-shelf or bell); harshness or sibilance 2-8 kHz -> dynamic-eq high-mid band (or restore deEss); narrow resonances -> dynamic-eq bell or parametric-eq notch/bell; static tonal imbalance or tilt -> "parametric-eq".
- Wide LRA or uneven dynamics -> "compressor" or "multiband-comp"; weak or smeared transients -> "transient-shaper"; thin or dull -> "saturation" or "bass-enhancer".
- Low-end phase or poor mono score -> "stereo-imager" monoBassBelowHz (or parametric-eq side highpass); L/R imbalance -> stereo-imager lrBalanceDb.
- Loudness short of target -> "maximizer" (or "clipper" then "limiter", or "multiband-maximizer"); true peak over ceiling -> limiter truePeak.
- Reference tonal gap -> "match-eq"; buried or loud vocal with stems cached -> "vocal-rebalance"; delivery below 32-bit float -> "dither".

Valid paramsJson schemas by processor type (module intensity=${fmtRange(PROCESSOR_PARAM_LIMITS.module.intensity)}, wetDry=${fmtRange(PROCESSOR_PARAM_LIMITS.module.wetDry)}, inputGainDb=${fmtRange(PROCESSOR_PARAM_LIMITS.module.inputGainDb)}, outputGainDb=${fmtRange(PROCESSOR_PARAM_LIMITS.module.outputGainDb)}):
${buildProcessorSchemasPrompt()}`;

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
    'Design an optimal, explainable mastering chain ending with a limiter or maximizer; each module\'s rationale states its supporting telemetry and tradeoffs.',
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

  const objectiveLabel = input.objective ?? input.mode;
  const prompt = [
    objectiveLabel ? `Mastering Objective: ${objectiveLabel.toUpperCase()}` : '',
    input.mode ? formatModeLine(input.mode) : '',
    summarizeAnalysisForPrompt('ORIGINAL SOURCE', input.preAnalysis),
    summarizeAnalysisForPrompt('CURRENT PROCESSED PASS', input.postAnalysis),
    input.referenceAnalysis ? summarizeAnalysisForPrompt('REFERENCE TRACK MEASUREMENTS', input.referenceAnalysis) : '',
    formatMatchEqAvailability(Boolean(input.referenceAnalysis)),
    formatVocalBalanceVerification(input.vocalBalanceVerification),
    findingsSummary,
    formatGuardFeedbackForPrompt(input.guardFeedback),
    `INDEPENDENT SYN-QC EVALUATION:\n${qcSummary}`,
    objectiveGateSummary,
    formatPlatformHintsForPrompt(input.qcReport?.platformHints),
    `Current Chain JSON:\n${JSON.stringify(chainForPrompt(input.currentChain))}`,
    `Objectives: Target LUFS=${input.targetLufs}, Max True Peak=${input.targetTruePeakDb} dBTP, Preserve Dynamics=${input.preserveDynamics}`,
    ...(input.vocalBalance !== undefined ? [summarizeVocalBalanceForPrompt(input.vocalBalance)] : []),
    `Resolve every FAIL in OBJECTIVE GATE and every blocking QC failure. All ${AI_PROCESSOR_TYPES.length} native processors in the system schema are available; consider each and enable only those this track's evidence justifies. Compare every current processor and setting with the latest render: retune it when its target remains unmet, remove it when no longer justified, or add a different complementary tool when measurements support that choice. Preserve passing targets, output the complete refined chain, and never repeat unchanged settings for a persistent failure or substitute generic tone shaping for a named failed gate.`,
  ].filter(Boolean).join('\n\n');
  return prompt;
}

/** Standard JSON Schema for the strategy object (OpenAI json_schema, Anthropic tool input, Gemini REST). */
export const PROCESSOR_JSON_SCHEMA = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      enum: AI_PROCESSOR_TYPES,
      description:
        'Must be one of: parametric-eq, dynamic-eq, compressor, multiband-comp, saturation, stereo-imager, restore, bass-enhancer, limiter, maximizer, transient-shaper, clipper, multiband-maximizer, dither, match-eq, vocal-rebalance',
    },
    name: { type: 'string' },
    enabled: { type: 'boolean', description: 'false = stage kept in the chain but switched off (default true)' },
    bypassed: { type: 'boolean', description: 'true = stage bypassed (default false)' },
    intensity: { type: 'number', description: '0 to 100' },
    wetDry: { type: 'number', description: '0 to 100' },
    inputGainDb: { type: 'number', description: '-12 to +12' },
    outputGainDb: { type: 'number', description: '-12 to +12' },
    rationale: { type: 'string', description: 'Optional short rationale citing the measurement; same meaning as reason, so send one of them, not both' },
    reason: { type: 'string', description: 'Engineering justification referencing measured metrics & tradeoffs (alias of rationale)' },
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

export interface RawAiProcessor {
  type: string;
  name: string;
  intensity: number;
  wetDry: number;
  inputGainDb?: number;
  outputGainDb?: number;
  enabled?: boolean;
  bypassed?: boolean;
  reason: string;
  rationale?: string;
  paramsJson: string;
}

export function parseAiChain(
  rawProcessors: RawAiProcessor[],
): {
  chain: ProcessorModule[];
  reasoning: Array<{ processorType: ProcessorModule['type']; reason: string; rationale?: string }>;
  /** Every AI value that validation changed or dropped (empty when everything survived). */
  paramCorrections: AiParamCorrection[];
} {
  if (rawProcessors.length === 0) {
    return { chain: [], reasoning: [], paramCorrections: [] };
  }

  const malformed: Array<string | undefined> = [];
  const parsed = rawProcessors.map((p, i) => {
    let paramsObj: unknown = {};
    malformed[i] = undefined;
    try {
      paramsObj = JSON.parse(p.paramsJson);
    } catch {
      paramsObj = {};
      malformed[i] = typeof p.paramsJson === 'string' ? p.paramsJson : String(p.paramsJson);
    }
    return {
      // Temporary id in the validator's own format so each validated module can be traced
      // back to the AI entry that produced it (the validator may reorder, e.g. Vocal Rebalance).
      id: `${p.type}-${Math.random().toString(36).slice(2, 8)}${i}`,
      type: p.type,
      name: p.name,
      intensity: p.intensity,
      wetDry: p.wetDry,
      inputGainDb: p.inputGainDb ?? 0,
      outputGainDb: p.outputGainDb ?? 0,
      ...(typeof p.enabled === 'boolean' ? { enabled: p.enabled } : {}),
      ...(typeof p.bypassed === 'boolean' ? { bypassed: p.bypassed } : {}),
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
  const byId = new Map(chain.map((m) => [m.id, m] as const));
  const reasoning: Array<{ processorType: ProcessorModule['type']; reason: string; rationale?: string }> = [];
  const paramCorrections: AiParamCorrection[] = [];
  rawProcessors.forEach((p, i) => {
    const validated = byId.get(parsed[i].id);
    const rationale = typeof p.rationale === 'string' && p.rationale.trim() ? p.rationale.slice(0, 400) : undefined;
    if (validated) {
      reasoning.push({
        processorType: validated.type,
        reason: String(rationale ?? p.reason ?? '').slice(0, 400),
        ...(rationale ? { rationale } : {}),
      });
    }
    if (paramCorrections.length < MAX_AI_PARAM_CORRECTIONS) {
      paramCorrections.push(
        ...collectModuleCorrections(
          {
            type: p.type,
            name: p.name,
            intensity: p.intensity,
            wetDry: p.wetDry,
            inputGainDb: p.inputGainDb,
            outputGainDb: p.outputGainDb,
            enabled: p.enabled,
            bypassed: p.bypassed,
            params: parsed[i].params,
            ...(malformed[i] !== undefined ? { malformedParamsJson: malformed[i] } : {}),
          },
          validated,
          i,
        ),
      );
    }
  });

  return { chain, reasoning, paramCorrections: paramCorrections.slice(0, MAX_AI_PARAM_CORRECTIONS) };
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
      ...(typeof r.enabled === 'boolean' ? { enabled: r.enabled } : {}),
      ...(typeof r.bypassed === 'boolean' ? { bypassed: r.bypassed } : {}),
      reason: String(r.reason ?? ''),
      ...(typeof r.rationale === 'string' ? { rationale: r.rationale } : {}),
      // Some providers return params as an object instead of a JSON string.
      paramsJson: typeof r.paramsJson === 'string' ? r.paramsJson : JSON.stringify(r.paramsJson ?? r.params ?? {}),
    };
  });
}

/** Same normalization the built-in Gemini route applies to its strategy response. */
export function normalizeStrategyResponse(data: RawStrategy, input: Pick<StrategyPromptInput, 'objective' | 'mode' | 'targetLufs'>) {
  const { chain, reasoning, paramCorrections } = parseAiChain(rawProcessorsOf(data));
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
    ...(paramCorrections.length > 0 ? { paramCorrections } : {}),
  };
}

/** Same normalization the built-in Gemini route applies to its refine response. */
export function normalizeRefineResponse(data: RawStrategy, currentChain: ProcessorModule[]) {
  const { chain, reasoning, paramCorrections } = parseAiChain(rawProcessorsOf(data));
  return {
    strategySummary: String(data.strategySummary || 'Refined mastering pass parameters.'),
    issuesDetected: Array.isArray(data.issuesDetected) ? data.issuesDetected.map(String) : [],
    reasoningPerProcessor: reasoning,
    chain: chain.length > 0 ? chain : currentChain,
    ...(paramCorrections.length > 0 ? { paramCorrections } : {}),
  };
}
