export type ProcessorType =
  | 'parametric-eq'
  | 'dynamic-eq'
  | 'compressor'
  | 'multiband-comp'
  | 'saturation'
  | 'stereo-imager'
  | 'restore'
  | 'bass-enhancer'
  | 'limiter'
  | 'maximizer'
  | 'external-vst3';

export type MasteringMode =
  | 'ai-auto'
  | 'manual'
  | 'hybrid'
  | 'transparent'
  | 'loudness'
  | 'analog'
  | 'dynamic'
  | 'reference'
  | 'streaming'
  | 'custom';

export type WorkspaceTab =
  | 'studio'
  | 'lab'
  | 'ai'
  | 'stems'
  | 'battle'
  | 'reference'
  | 'qc'
  | 'plugins';

export type LabSubTab = 'frequency' | 'dynamics' | 'stereo' | 'distortion';

export type EQBandShape = 'highpass' | 'lowshelf' | 'bell' | 'highshelf' | 'lowpass' | 'notch';

export interface EQBand {
  id: string;
  enabled: boolean;
  shape: EQBandShape;
  freq: number;
  gain: number;
  q: number;
  dynamicThresholdDb?: number;
  dynamicRangeDb?: number;
}

export interface ParametricEQParams {
  phaseMode: 'minimum' | 'linear';
  msMode: 'stereo' | 'mid-side';
  tiltDb: number;
  bands: EQBand[];
}

export interface DynamicEQParams {
  bands: Array<{
    id: string;
    enabled: boolean;
    freq: number;
    q: number;
    thresholdDb: number;
    maxCutDb: number;
    attackMs: number;
    releaseMs: number;
  }>;
}

export interface CompressorParams {
  mode: 'downward' | 'upward' | 'parallel';
  thresholdDb: number;
  ratio: number;
  attackMs: number;
  releaseMs: number;
  kneeDb: number;
  makeupDb: number;
  scHpfHz: number;
}

export interface MultibandBandParams {
  thresholdDb: number;
  ratio: number;
  attackMs: number;
  releaseMs: number;
  gainDb: number;
  bypass: boolean;
}

export interface MultibandCompParams {
  lowCrossHz: number;
  highCrossHz: number;
  low: MultibandBandParams;
  mid: MultibandBandParams;
  high: MultibandBandParams;
}

export interface SaturationParams {
  flavor: 'tube' | 'tape' | 'soft-clip' | 'hard-clip' | 'exciter';
  drive: number; // 0 to 100
  tone: number; // -100 (warm/dark) to +100 (bright/air)
  harmonics: 'even' | 'odd' | 'balanced';
  oversampling: 1 | 2 | 4;
}

export interface StereoImagerParams {
  lowWidth: number; // 0 to 200%
  midWidth: number; // 0 to 200%
  highWidth: number; // 0 to 200%
  lowCrossHz: number;
  highCrossHz: number;
  monoBassBelowHz: number;
  lrBalanceDb: number; // -6 to +6
  midSideGainDb: number; // -6 to +6
}

export interface RestoreParams {
  dcOffset: boolean;
  humRemovalHz: 0 | 50 | 60;
  hissReduction: number; // 0 to 100
  deEssAmount: number; // 0 to 100
  deEssFreqHz: number; // 4000 to 10000
  resonanceSuppress: number; // 0 to 100
  mode: 'conservative' | 'aggressive';
}

export interface BassEnhancerParams {
  subFreqHz: number; // 35 to 90
  subGainDb: number; // 0 to 8
  harmonicDrive: number; // 0 to 100
  tightness: number; // 0 to 100
  monoFocus: boolean;
}

export interface LimiterParams {
  ceilingDb: number; // -6.0 to -0.1
  thresholdDb: number; // -20.0 to 0.0
  releaseMs: number; // 10 to 500
  lookaheadMs: number; // 0 to 10
  truePeak: boolean;
  oversampling: 1 | 2 | 4;
}

export interface MaximizerParams {
  character: 'transparent' | 'punchy' | 'aggressive' | 'smooth';
  targetLufs: number; // -24 to -5
  ceilingDb: number; // -3.0 to -0.1
  transientEmphasis: number; // 0 to 100
  truePeak: boolean;
}

export interface ExternalPluginParamValue {
  id: number;
  name: string;
  label: string;
  valueNormalized: number;
  defaultValueNormalized: number;
  stepCount: number;
  isAutomatable: boolean;
  isReadOnly: boolean;
  isBypass: boolean;
  displayValue?: string;
}

export interface ExternalVST3Params {
  uid: string;
  bundlePath: string;
  pluginName: string;
  manufacturer: string;
  version: string;
  format: PluginFormat;
  instanceId: string | null;
  latencySamples: number;
  hasEditor: boolean;
  editorOpen: boolean;
  status: 'unloaded' | 'loading' | 'active' | 'crashed' | 'host-offline' | 'error';
  lastError: string;
  stateBase64: string;
  parameters: ExternalPluginParamValue[];
}

export type ProcessorParams =
  | { type: 'parametric-eq'; data: ParametricEQParams }
  | { type: 'dynamic-eq'; data: DynamicEQParams }
  | { type: 'compressor'; data: CompressorParams }
  | { type: 'multiband-comp'; data: MultibandCompParams }
  | { type: 'saturation'; data: SaturationParams }
  | { type: 'stereo-imager'; data: StereoImagerParams }
  | { type: 'restore'; data: RestoreParams }
  | { type: 'bass-enhancer'; data: BassEnhancerParams }
  | { type: 'limiter'; data: LimiterParams }
  | { type: 'maximizer'; data: MaximizerParams }
  | { type: 'external-vst3'; data: ExternalVST3Params };

export interface ProcessorModule {
  id: string;
  type: ProcessorType;
  name: string;
  enabled: boolean;
  bypassed: boolean;
  intensity: number; // 0 - 100
  wetDry: number; // 0 - 100
  inputGainDb: number; // -12 to +12
  outputGainDb: number; // -12 to +12
  expanded: boolean;
  presetName?: string;
  group?: string;
  params: ProcessorParams['data'];
}

export interface ResonancePeak {
  freqHz: number;
  excessDb: number;
  severity: 'low' | 'moderate' | 'high';
}

export interface SpectralBandEnergy {
  sub: number; // 20-60 Hz
  bass: number; // 60-250 Hz
  lowMid: number; // 250-500 Hz
  mid: number; // 500-2000 Hz
  highMid: number; // 2000-6000 Hz
  presence: number; // 6000-12000 Hz
  air: number; // 12000-20000 Hz
}

export interface AudioAnalysis {
  durationSec: number;
  sampleRate: number;
  channels: number;
  integratedLufs: number;
  shortTermLufsMax: number;
  momentaryLufsMax: number;
  loudnessRangeLu: number;
  rmsDb: number;
  samplePeakDb: number;
  truePeakDb: number;
  dynamicRangeDb: number;
  crestFactorDb: number;
  plrDb: number;
  transientDensity: number; // 0 - 1
  spectralCentroidHz: number;
  spectralSlopeDbPerOct: number;
  zoneEnergyDb: SpectralBandEnergy;
  spectrumBinsFreq: number[];
  spectrumBinsDb: number[];
  resonances: ResonancePeak[];
  stereoWidth: number; // 0 - 2
  midSideRatioDb: number;
  phaseCorrelation: number; // -1 to +1
  lowEndCorrelation: number; // -1 to +1
  lrBalanceDb: number;
  monoCompatibilityScore: number; // 0 to 100
  clippedSamples: number;
  interSamplePeaks: number;
  thdEstimatePercent: number;
  noiseFloorDb: number;
  dcOffset: number;
  loudnessHistoryLufs: number[];
}

export interface AudioTrackAsset {
  id: string;
  name: string;
  fileSizeBytes: number;
  format: string;
  sampleRate: number;
  channels: number;
  durationSec: number;
  bitDepthLabel: string;
  peaks: number[]; // downsampled waveform min/max envelope
  analysis: AudioAnalysis;
  isDemo?: boolean;
}

export interface AIMasteringStrategy {
  id: string;
  timestamp: number;
  source: 'gemini-ai' | 'algorithmic';
  genre: string;
  musicalStyle: string;
  instrumentationSummary: string;
  vocalPresence: string;
  tonalCharacteristics: string;
  issuesDetected: string[];
  strategySummary: string;
  targetLufs: number;
  targetTruePeakDb: number;
  reasoningPerProcessor: Array<{
    processorType: ProcessorType;
    reason: string;
  }>;
  chain: ProcessorModule[];
}

export interface IterationPass {
  passNumber: number;
  label: string;
  timestamp: number;
  chain: ProcessorModule[];
  postAnalysis: AudioAnalysis;
  score: number;
  notes: string;
  improvements: string[];
  warnings: string[];
}

export interface BattleCandidate {
  id: 'A' | 'B' | 'C';
  blindLabel: string;
  title: string;
  philosophy: string;
  chain: ProcessorModule[];
  postAnalysis: AudioAnalysis;
  loudnessTrimDb: number;
}

export interface QCTargetProfile {
  id: string;
  name: string;
  targetLufs: number;
  lufsTolerance: number;
  maxTruePeakDb: number;
  minDynamicRangeDb: number;
  minPhaseCorrelation: number;
  maxClippingSamples: number;
}

export interface QCCheckItem {
  id: string;
  category: 'Loudness' | 'Headroom' | 'Dynamics' | 'Stereo' | 'Spectral' | 'Integrity';
  label: string;
  status: 'pass' | 'warning' | 'fail';
  measuredValue: string;
  targetValue: string;
  explanation: string;
  suggestedFix?: string;
}

export interface QCReport {
  overallStatus: 'pass' | 'warning' | 'fail';
  passedCount: number;
  warningCount: number;
  failCount: number;
  checks: QCCheckItem[];
}

export type ExportAudioFormat = 'wav' | 'mp3' | 'ogg' | 'flac' | 'm4a' | 'mid' | 'webm-opus';

export interface ExportConfig {
  filename: string;
  format: ExportAudioFormat;
  wavBitDepth: 16 | 24 | 32;
  flacBitDepth?: 16 | 24;
  flacCompression?: number;
  mp3BitrateKbps?: 128 | 192 | 256 | 320;
  oggBitrateKbps?: 96 | 128 | 160 | 192 | 256 | 320;
  aacBitrateKbps?: 128 | 192 | 256 | 320;
  opusBitrateKbps?: 96 | 128 | 160 | 192 | 256;
  sampleRate: 44100 | 48000 | 88200 | 96000;
  channels: 'stereo' | 'mono';
  dither: 'none' | 'tpdf';
  resampler?: 'sinc-512';
  includeMasteringChain?: boolean;
  saveLoopMarkers?: boolean;
  midiTempoBpm?: number;
  normalizeToTarget: boolean;
  targetLufs: number;
  ceilingDb: number;
  deliveryProfile: string;
  metadataTitle: string;
  metadataArtist: string;
}

export interface MasteringPreset {
  id: string;
  name: string;
  category: 'genre' | 'philosophy' | 'user';
  description: string;
  targetLufs: number;
  chain: ProcessorModule[];
}

export interface SavedChainRecord {
  id: string;
  name: string;
  createdAt: number;
  chain: ProcessorModule[];
}

export interface ProjectRecord {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  mode: MasteringMode;
  trackName?: string;
  chain: ProcessorModule[];
  aiStrategy?: AIMasteringStrategy | null;
  iterations: IterationPass[];
  qcTargetId: string;
  exportConfig: ExportConfig;
  notes?: string;
}

export interface AppSettings {
  density: 'compact' | 'comfortable';
  experienceMode: 'engineering' | 'guided';
  accentIntensity: 'standard' | 'vivid';
  loudnessMatchAB: boolean;
  autoSaveEnabled: boolean;
  fftSize: 2048 | 4096 | 8192;
}

export type PluginFormat = 'vst3' | 'clap' | 'au' | 'lv2';

export type PluginStatus =
  | 'available'
  | 'missing'
  | 'incompatible'
  | 'scan_failed'
  | 'quarantined'
  | 'disabled';

export type PluginBinaryArch = 'x64' | 'x86' | 'arm64' | 'unknown';

export interface PluginParameterInfo {
  id: number;
  name: string;
  label: string;
  defaultValueNormalized: number;
  stepCount: number;
  isAutomatable: boolean;
  isReadOnly: boolean;
  isBypass: boolean;
}

export interface PluginBusConfiguration {
  layoutName: string;
  mainInputChannels: number;
  mainOutputChannels: number;
  sidechainInputChannels: number;
}

export interface ExternalPluginRecord {
  uid: string;
  format: PluginFormat;
  name: string;
  manufacturer: string;
  version: string;
  sdkVersion: string;
  category: string;
  subCategories: string[];
  bundlePath: string;
  binaryPath: string;
  arch: PluginBinaryArch;
  status: PluginStatus;
  statusReason: string;
  hasEditor: boolean;
  latencySamples: number;
  busConfigs: PluginBusConfiguration[];
  parameterCount: number;
  parameters: PluginParameterInfo[];
  fileMtimeNs: number;
  fileSizeBytes: number;
  fileHashSha256: string;
  failCount: number;
  lastScannedAt: number;
  favorite: boolean;
  lastUsedAt: number;
  disabledByUser: boolean;
}

export interface ScanHistoryRecord {
  id: number;
  startedAt: number;
  finishedAt: number;
  mode: string;
  totalBundles: number;
  discoveredPlugins: number;
  failedBundles: number;
  skippedUnchanged: number;
  summary: string;
}

export type HostConnectionStatus =
  | 'browser-only'
  | 'connecting'
  | 'pairing-required'
  | 'connected'
  | 'disconnected'
  | 'unavailable';

export interface HostInfo {
  hostVersion: string;
  os: string;
  milestone: number;
  formatsSupported: string[];
  audioEngineActive: boolean;
  standardDirectories: string[];
  customDirectories: string[];
}

export interface ScanProgressEvent {
  completed: number;
  total: number;
  currentBundle: string;
  status: string;
}

export interface ExternalPluginInstanceInfo {
  instanceId: string;
  uid: string;
  bundlePath: string;
  name: string;
  manufacturer: string;
  sampleRate: number;
  blockSize: number;
  channels: number;
  latencySamples: number;
  bypassed: boolean;
  hasEditor: boolean;
  editorOpen: boolean;
  active: boolean;
  crashed: boolean;
  workerEngine: string;
  lastError: string;
  parameters: ExternalPluginParamValue[];
}

export interface AudioDeviceInfo {
  id: string;
  name: string;
  driverType: string;
  maxOutputChannels: number;
  supportedSampleRates: number[];
  defaultBufferSize: number;
  isDefault: boolean;
}

export interface WasapiAuditionStatus {
  active: boolean;
  deviceName?: string;
  driverType?: string;
  sampleRate?: number;
  bufferSize?: number;
  totalFrames?: number;
  playedFrames?: number;
  underruns?: number;
  lastError?: string;
}

export type DirectorOperatingMode = 'manual' | 'assisted' | 'autonomous';

export type MasteringObjectiveId =
  | 'streaming'
  | 'commercial-loudness'
  | 'dynamic'
  | 'cinematic'
  | 'electronic'
  | 'hip-hop'
  | 'pop'
  | 'acoustic'
  | 'vocal-focused'
  | 'transparent'
  | 'punchy'
  | 'warm'
  | 'custom';

export type AiChainLifecycleState =
  | 'Ready'
  | 'Analyzing'
  | 'Planning'
  | 'Building chain'
  | 'Processing'
  | 'Measuring'
  | 'Optimizing'
  | 'Validating'
  | 'Completed'
  | 'Stopped'
  | 'Failed';

export interface CustomObjectiveSpec {
  targetLufs: number;
  maxTruePeakDb: number;
  minDynamicRangeDb: number;
  tonalBias: 'warm' | 'neutral' | 'bright';
  stereoPreference: 'narrow' | 'preserve' | 'wide';
  preserveTransients: boolean;
}

export interface ResolvedObjectiveTarget extends CustomObjectiveSpec {
  id: MasteringObjectiveId;
  label: string;
  lufsTolerance: number;
  saturationAllowance: 'none' | 'subtle' | 'moderate' | 'rich';
  description: string;
}

export type DiagnosticEvidenceStrength = 'single' | 'multiple' | 'convergent';

export interface AnalysisFinding {
  id: string;
  kind: 'observation' | 'artistic-choice' | 'technical-problem';
  category: 'Loudness' | 'Dynamics' | 'Spectral' | 'Stereo' | 'Distortion' | 'Noise' | 'Integrity';
  title: string;
  severity: 'info' | 'low' | 'moderate' | 'high';
  evidence: string[];
  explanation: string;
  recommendedAction?: string;
  evidenceStrength?: DiagnosticEvidenceStrength;
  metrics?: Record<string, number>;
}

export interface DirectorDiagnosisReport {
  workingWell: string[];
  artisticProfile: string;
  findings: AnalysisFinding[];
}

export type FindingVerificationStatus =
  | 'ACTIVE'
  | 'RESOLVED'
  | 'IMPROVED'
  | 'PARTIALLY_RESOLVED'
  | 'UNRESOLVED'
  | 'UNVERIFIED';

export interface FindingMetricComparison {
  key: string;
  label: string;
  unit: string;
  beforeValue: number | null;
  afterValue: number | null;
  delta: number | null;
  beforeFormatted: string;
  afterFormatted: string;
  thresholdFormatted?: string;
  improved: boolean | null;
  meetsThreshold: boolean | null;
}

export interface AppliedCorrectionRecord {
  id: string;
  timestamp: number;
  label: string;
  findingId?: string;
  processorTypes: ProcessorType[];
  chainFingerprint: string;
}

export interface VerifiedFindingState {
  findingId: string;
  originalFinding: AnalysisFinding;
  postFinding: AnalysisFinding | null;
  status: FindingVerificationStatus;
  updatedSeverity: AnalysisFinding['severity'] | 'none';
  beforeMeasurements: FindingMetricComparison[];
  afterMeasurements: FindingMetricComparison[];
  verificationSummary: string;
  remainingDeviation?: string;
  nextRecommendedAction?: string;
  appliedCorrections: string[];
  measurementReliable: boolean;
}

export interface PostFixVerificationReport {
  id: string;
  timestamp: number;
  chainFingerprint: string;
  baselineAnalysisId: string;
  postAnalysisId: string;
  baselineAnalysis: AudioAnalysis;
  postAnalysis: AudioAnalysis | null;
  analysisFresh: boolean;
  verificationError?: string;
  appliedCorrections: AppliedCorrectionRecord[];
  activeFindings: VerifiedFindingState[];
  resolvedFindings: VerifiedFindingState[];
  artisticAndObservations: AnalysisFinding[];
  newlyIntroducedFindings: AnalysisFinding[];
  postDiagnosis: DirectorDiagnosisReport | null;
  affectedMetricsSummary: {
    integratedLufsBefore: number;
    integratedLufsAfter: number | null;
    shortTermLufsMaxBefore: number;
    shortTermLufsMaxAfter: number | null;
    rmsDbBefore: number;
    rmsDbAfter: number | null;
    samplePeakDbBefore: number;
    samplePeakDbAfter: number | null;
    truePeakDbBefore: number;
    truePeakDbAfter: number | null;
    crestFactorDbBefore: number;
    crestFactorDbAfter: number | null;
    plrDbBefore: number;
    plrDbAfter: number | null;
    dynamicRangeDbBefore: number;
    dynamicRangeDbAfter: number | null;
    spectralSlopeBefore: number;
    spectralSlopeAfter: number | null;
    spectralCentroidBefore: number;
    spectralCentroidAfter: number | null;
    region150To400DbBefore: number | null;
    region150To400DbAfter: number | null;
  };
}

export type ChainCommand =
  | {
      op: 'add';
      processorType: ProcessorType;
      name?: string;
      position?: number;
      params?: Partial<ProcessorModule['params']>;
      wetDry?: number;
      intensity?: number;
      rationale: string;
    }
  | {
      op: 'remove';
      targetId?: string;
      processorType?: ProcessorType;
      rationale: string;
    }
  | {
      op: 'reorder';
      order: ProcessorType[];
      rationale: string;
    }
  | {
      op: 'configure';
      targetId?: string;
      processorType: ProcessorType;
      paramsPatch: Record<string, unknown>;
      rationale: string;
    }
  | {
      op: 'gain-stage';
      targetId?: string;
      processorType: ProcessorType;
      inputGainDb?: number;
      outputGainDb?: number;
      rationale: string;
    }
  | {
      op: 'wet-dry';
      targetId?: string;
      processorType: ProcessorType;
      wetDry: number;
      intensity?: number;
      rationale: string;
    }
  | {
      op: 'bypass';
      targetId?: string;
      processorType: ProcessorType;
      bypassed: boolean;
      rationale: string;
    };

export interface DirectorRecommendation {
  id: string;
  characteristic: string;
  supportingMeasurements: string[];
  proposedCorrection: string;
  selectedProcessor: ProcessorType;
  pluginName?: string;
  proposedParamsSummary: string;
  commands: ChainCommand[];
  expectedResult: string;
  potentialTradeoffs: string;
  priority: 'critical' | 'recommended' | 'optional';
  statementType: 'hypothesis';
  applied?: boolean;
}

export interface MultiObjectiveDimension {
  key:
    | 'tonalBalance'
    | 'dynamicIntegrity'
    | 'loudness'
    | 'truePeakSafety'
    | 'transientPreservation'
    | 'stereoIntegrity'
    | 'distortion'
    | 'noise'
    | 'clipping'
    | 'musicalTransparency'
    | 'referenceSimilarity';
  label: string;
  status: 'optimal' | 'acceptable' | 'attention' | 'critical' | 'not-applicable';
  score: number; // 0-100 objective engineering score for this single dimension
  measuredSummary: string;
  targetSummary: string;
  note: string;
}

export interface MultiObjectiveEvaluation {
  dimensions: MultiObjectiveDimension[];
  engineeringFitIndex: number; // Weighted telemetry alignment index (explicitly NOT subjective musicality)
  limitingFactors: string[];
  nonMeasurableNote: string;
}

export interface PluginCapabilityMatch {
  uid: string;
  name: string;
  manufacturer: string;
  format: PluginFormat;
  role: 'eq' | 'dynamics' | 'limiter' | 'stereo' | 'saturation' | 'restore' | 'utility';
  available: boolean;
  reason: string;
  recommendedParams: Array<{
    paramId: number;
    paramName: string;
    normalizedValue: number;
    rationale: string;
  }>;
}

export interface PluginIntelligenceSummary {
  hostConnected: boolean;
  discoveredCount: number;
  compatibleAvailableCount: number;
  statusSummary: string;
  matches: PluginCapabilityMatch[];
}

export interface DirectorActivityEntry {
  id: string;
  timestamp: number;
  passNumber: number;
  phase:
    | 'analyze'
    | 'plan'
    | 'chain'
    | 'plugin'
    | 'render'
    | 'evaluate'
    | 'qc'
    | 'refine'
    | 'rollback'
    | 'complete'
    | 'halted';
  kind: 'observation' | 'hypothesis' | 'command' | 'verified-result' | 'warning';
  message: string;
  details?: string;
}

export interface DirectorCheckpoint {
  id: string;
  passNumber: number;
  label: string;
  timestamp: number;
  chain: ProcessorModule[];
  analysis: AudioAnalysis;
  qcReport: QCReport;
  multiObjective: MultiObjectiveEvaluation;
  isBest?: boolean;
  iterationSummary?: {
    activeProcessor: string;
    detectedIssue: string;
    measuredValue: string;
    targetValue: string;
    previousValue?: string;
    outcome: 'improved' | 'regressed' | 'baseline' | 'converged';
  };
}

export interface ReferenceComparisonReport {
  lufsDelta: number;
  dynamicRangeDeltaDb: number;
  crestDeltaDb: number;
  transientDensityDelta: number;
  spectralSlopeDelta: number;
  stereoWidthDelta: number;
  zoneDeltasDb: SpectralBandEnergy;
  suggestedActions: string[];
  cautionNote: string;
}

export interface StemIntelligenceReport {
  sampleRate: number;
  durationSec: number;
  stemCount: number;
  stems: Array<{
    id: string;
    name: string;
    role: 'vocals' | 'bass' | 'drums' | 'instruments' | 'other';
    offsetSamples: number;
    integratedLufs: number;
    truePeakDb: number;
    stereoWidth: number;
    processed: boolean;
    processors: string[];
  }>;
  overlaps: Array<{
    stemAId: string;
    stemBId: string;
    band: keyof SpectralBandEnergy;
    differenceDb: number;
    confidence: 'low' | 'moderate';
  }>;
  warnings: string[];
  processingChains: Record<string, string[]>;
}

export interface MasterFinalReport {
  id: string;
  createdAt: number;
  operatingMode: DirectorOperatingMode;
  objective: ResolvedObjectiveTarget;
  status: 'completed' | 'converged' | 'stopped-by-user' | 'budget-reached' | 'rolled-back';
  stopReason: string;
  iterationsExecuted: number;
  bestPassNumber: number;
  rolledBack: boolean;
  preAnalysis: AudioAnalysis;
  postAnalysis: AudioAnalysis;
  qcReport: QCReport;
  multiObjective: MultiObjectiveEvaluation;
  diagnosis: DirectorDiagnosisReport;
  recommendations: DirectorRecommendation[];
  pluginSummary: PluginIntelligenceSummary;
  finalChain: ProcessorModule[];
  checkpoints: DirectorCheckpoint[];
  activityLog: DirectorActivityEntry[];
  verifiedImprovements: string[];
  remainingTradeoffs: string[];
  resolvedProblems: string[];
  partiallyResolvedProblems: string[];
  preservedCharacteristics: string[];
  postFixVerification?: PostFixVerificationReport;
  stemIntelligence?: StemIntelligenceReport;
}

