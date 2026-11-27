import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  Maximize2,
  Menu,
  Minimize2,
  Pause,
  Play,
  Plug,
  Redo2,
  Repeat,
  Save,
  Settings,
  Sparkles,
  Square,
  Undo2,
  Upload,
} from 'lucide-react';
import type {
  AiChainLifecycleState,
  AIMasteringStrategy,
  AiPassTrace,
  AppliedCorrectionRecord,
  AppSettings,
  AudioAnalysis,
  AudioTrackAsset,
  BattleCandidate,
  CustomObjectiveSpec,
  DirectorActivityEntry,
  DirectorCheckpoint,
  DirectorOperatingMode,
  DirectorRecommendation,
  ExportConfig,
  ExternalPluginRecord,
  ExternalVST3Params,
  IterationPass,
  MasterFinalReport,
  MasteringMode,
  MasteringObjectiveId,
  MasteringPreset,
  LabSubTab,
  ProcessorModule,
  ProcessorType,
  ProjectRecord,
  SavedChainRecord,
  WorkspaceTab,
  VocalBalanceVerification,
} from './types/mastering';
import { analyzeAudioBuffer, extractWaveformPeaks } from './dsp/analyzer';
import { createProcessorModule, hoistVocalRebalance, validateChain } from './dsp/chainValidation';
import { generateDemoMasterStem } from './dsp/demoAudio';
import {
  renderMixedChain,
  type ExternalPluginProcessCallback,
} from './dsp/mixedChainRenderer';
import { type DynamicEqTrace, type ProcessorMeterTelemetry } from './dsp/offlineDsp';
import { chainHasSoloedBand } from './dsp/eqDesign';
import { renderAndAnalyzeOffThread } from './dsp/workerClient';
import { ProgressRing } from './components/ui/ProgressRing';
import { IMPORT_STAGE_LABELS, importStagePercent, type ImportStage } from './components/ui/progressMath';
import { getActiveRebalanceStems, getRebalanceStemState, separateActiveRebalanceStems, setActiveRebalanceSource, subscribeRebalanceStems } from './services/rebalanceStemStore';
import type { VocalBalanceContext } from './ai/vocalBalancePrompt';
import { filterSourceTransientClickAnalysis } from './dsp/clickDetect';
import { MASTERING_PRESETS } from './dsp/presets';
import { QC_TARGET_PROFILES, runQualityControl } from './dsp/qc';
import {
  buildBattleCandidatesIntelligent,
  buildExplainableMasterPlan,
  compareReferenceIntelligent,
  alignQcProfileToObjective,
  resolveObjectiveTarget,
  runAutonomousDirectorLoop,
  type ExplainableMasterPlan,
} from './director/directorEngine';
import { DEFAULT_DIRECTOR_OPERATING_MODE } from './director/operatingModeDefaults';
import { analyzeTrackIntelligence } from './director/analyzeIntelligence';
import {
  computeChainFingerprint,
  isMasterFullyVerified,
  verifyPostFixAnalysis,
} from './director/postFixVerification';
import { applyStructuredChainCommands } from './director/chainCommands';
import { inspectPluginInventory } from './director/pluginIntelligence';
import { validateChainAgainstInventory } from './director/processorInventory';
import { encodeWavBlob } from './dsp/wavEncoder';
import { DEFAULT_EXPORT_CONFIG } from './dsp/exportDefaults';
import {
  createTemporaryMasteringWorkspace,
  listMasteringDiagnosticRuns,
  loadMasteringDiagnosticBundle,
  type MasteringDiagnosticBundle,
  type MasteringDiagnosticRunSummary,
} from './director/tempMasteringWorkspace';
import { SynAudioEngine, type AuditionTarget, type AudioEngineInfo } from './engine/audioEngine';
import { telemetryStore } from './engine/telemetryStore';
import { matchEqStore } from './engine/matchEqStore';
import { SynHostBridge, type HostBridgeSnapshot } from './services/hostBridge';
import {
  listProjects,
  listSavedChains,
  loadAppSettings,
  removeChainRecord,
  removeProject,
  saveAppSettings,
  saveChainRecord,
  saveProject,
} from './storage/projectDb';
import { LeftLibraryPanel } from './components/LeftLibraryPanel';
// Rack UIs are split out of the initial bundle (budget); the in-page rack is prefetched on mount
// so it is ready by the time a track is loaded, and the floating window loads when first opened.
const loadMasteringRack = () => import('./components/MasteringRack');
const MasteringRack = React.lazy(() => loadMasteringRack().then(({ MasteringRack }) => ({ default: MasteringRack })));
const MeterBridge = React.lazy(() => import('./components/MeterBridge').then(({ MeterBridge }) => ({ default: MeterBridge })));
const WaveformTimelineCanvas = React.lazy(() => import('./components/CanvasVisualizers').then(({ WaveformTimelineCanvas }) => ({ default: WaveformTimelineCanvas })));
const SpectrumAndEQCanvas = React.lazy(() => import('./components/CanvasVisualizers').then(({ SpectrumAndEQCanvas }) => ({ default: SpectrumAndEQCanvas })));

const SynLabView = React.lazy(() =>
  import('./components/SynLabView').then(({ SynLabView }) => ({ default: SynLabView })),
);
const StemIntelligencePanel = React.lazy(() =>
  import('./components/StemIntelligencePanel').then(({ StemIntelligencePanel }) => ({ default: StemIntelligencePanel })),
);
const AiMasterView = React.lazy(() =>
  import('./components/AiMasterView').then(({ AiMasterView }) => ({ default: AiMasterView })),
);
const BattleModeView = React.lazy(() =>
  import('./components/BattleModeView').then(({ BattleModeView }) => ({ default: BattleModeView })),
);
const ReferenceMatchView = React.lazy(() =>
  import('./components/ReferenceAndQcViews').then(({ ReferenceMatchView }) => ({ default: ReferenceMatchView })),
);
const QualityControlView = React.lazy(() =>
  import('./components/ReferenceAndQcViews').then(({ QualityControlView }) => ({ default: QualityControlView })),
);
const PlatformPreviewPanel = React.lazy(() => import('./components/platform/PlatformPreviewPanel'));
const PluginManagerView = React.lazy(() =>
  import('./components/PluginManagerView').then(({ PluginManagerView }) => ({ default: PluginManagerView })),
);
const ExportModal = React.lazy(() => import('./components/Modals').then(({ ExportModal }) => ({ default: ExportModal })));
const SettingsModal = React.lazy(() => import('./components/Modals').then(({ SettingsModal }) => ({ default: SettingsModal })));
import { WorkspaceNavigation } from './components/WorkspaceNavigation';
import { WorkspaceHero } from './components/WorkspaceHero';
import { MasterConsole } from './components/console/MasterConsole';
import { Portal } from './ui/Portal';
// Shown only after a track is loaded and a run produced a diagnostic log (D2: off the main chunk).
const FixItStage = React.lazy(() => import('./components/studio/FixItStage').then(({ FixItStage }) => ({ default: FixItStage })));
const WhatAiChangedPanel = React.lazy(() => import('./components/studio/WhatAiChangedPanel').then(({ WhatAiChangedPanel }) => ({ default: WhatAiChangedPanel })));
const FxRackWindow = React.lazy(() => import('./components/studio/FxRackWindow').then(({ FxRackWindow }) => ({ default: FxRackWindow })));
import { TimelinePlayer } from './components/studio/TimelinePlayer';
import { usePlatformPreviewSelection } from './components/platform/usePlatformPreviewSelection';
const PlatformPreviewSelector = React.lazy(() => import('./components/platform/PlatformPreviewSelector'));
import { compressorMakeupDb, getPlatformRule, predictForPlatform, type MasterLevels } from './dsp/platformRules';
import { hasFades, NO_FADES, type FadeSettings } from './dsp/fades';
import { registerWaveformSource } from './components/studio/eq/waveformSource';
import { LOUDNESS_TARGET_PRESETS } from './dsp/loudnessTargets';
import { buildDiagnosticLog, summarizeAiFallbackBanner } from './director/diagnosticLog';
import { BUILTIN_LABEL, requestRefine, requestStrategy } from './ai/masteringClient';
import { SYSTEM_PROMPT, buildRefineUserPrompt, buildStrategyUserPrompt } from './ai/masteringPrompt';
import { AiProviderChip, AiProviderPanel } from './components/AiProviderPanel';
import { describeProvider } from './ai/providerAdapters';
import { getActiveAiCall, getActiveProviderConfig, getBuiltinAccessHeaders, runProviderCall } from './ai/providerStore';
import {
  getOrCreateVocalBalancePreparation,
  prepareVocalBalanceAgainstReference,
  requiresVocalBalancePreparation,
  type VocalBalancePreparation,
} from './director/vocalBalance';
import {
  CLOUD_AI_TIMEOUT_MS,
  CloudAiRateLimitError,
  assertCloudAiAvailable,
  classifyBuiltinAiError,
  createCloudAiRequestSignal,
  friendlyCloudAiLimitNotice,
  readBuiltinAiResponse,
} from './ai/cloudRateLimit';

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec % 1) * 10);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${ms}`;
}

const TransportTimeReadout: React.FC<{ durationSec: number; className?: string }> = React.memo(
  ({ durationSec, className = '' }) => {
    const spanRef = useRef<HTMLSpanElement | null>(null);
    useEffect(() => {
      const update = (sec: number) => {
        if (spanRef.current) {
          spanRef.current.textContent = `${formatTime(sec)} / ${formatTime(durationSec)}`;
        }
      };
      update(telemetryStore.getSnapshot().currentTimeSec);
      return telemetryStore.subscribe((snap) => update(snap.currentTimeSec));
    }, [durationSec]);

    return (
      <span ref={spanRef} className={`font-mono-tabular text-[#9CA3AF] ${className}`}>
        00:00.0 / {formatTime(durationSec)}
      </span>
    );
  },
);

const DEFAULT_SETTINGS: AppSettings = {
  audioLatencyMode: 'balanced',
  audioOutputDeviceId: '',
  density: 'compact',
  experienceMode: 'engineering',
  accentIntensity: 'standard',
  loudnessMatchAB: true,
  autoSaveEnabled: true,
  fftSize: 2048,
};

function createStarterChain(): ProcessorModule[] {
  return [
    createProcessorModule('parametric-eq', { expanded: false }),
    createProcessorModule('compressor', { expanded: false }),
    createProcessorModule('maximizer', { expanded: false }),
  ];
}

export default function App() {
  const engineRef = useRef<SynAudioEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = new SynAudioEngine();
  }
  const hostBridgeRef = useRef<SynHostBridge | null>(null);
  if (!hostBridgeRef.current) {
    hostBridgeRef.current = new SynHostBridge();
  }

  // Raw PCM audio buffers kept in refs to avoid React re-render overhead
  const sourceChannelsRef = useRef<Float32Array[] | null>(null);
  const postChannelsRef = useRef<Float32Array[] | null>(null);
  const referenceChannelsRef = useRef<Float32Array[] | null>(null);
  const vocalSourceOverrideRef = useRef<{
    trackId: string;
    referenceTrackId: string;
    revision: number;
    channels: [Float32Array, Float32Array];
    verification: VocalBalanceVerification;
  } | null>(null);
  const vocalPreparationCacheRef = useRef(new Map<string, Promise<VocalBalancePreparation>>());
  const vocalPreparationAbortRef = useRef<AbortController | null>(null);
  const externalParamLatestRef = useRef<Map<string, number>>(new Map());
  const externalParamInFlightRef = useRef<Set<string>>(new Set());

  const [activeTab, setActiveTab] = useState<WorkspaceTab>('studio');
  const [labDefaultSubTab, setLabDefaultSubTab] = useState<LabSubTab>('frequency');
  const [hostSnapshot, setHostSnapshot] = useState<HostBridgeSnapshot>(() =>
    hostBridgeRef.current!.getSnapshot(),
  );
  const [spectrumMode, setSpectrumMode] = useState<'spectrum' | 'spectrogram'>('spectrum');
  const [fullscreenWorkspace, setFullscreenWorkspace] = useState(false);
  // New one-button flow: import screen first, then the Fix-It stage.
  const [showWorkstationWithoutTrack, setShowWorkstationWithoutTrack] = useState(() => typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches);
  const [fades, setFades] = useState<FadeSettings>(NO_FADES);
  const [targetPresetId, setTargetPresetId] = useState<string | null>(null);
  const [postPeaksHi, setPostPeaksHi] = useState<number[] | null>(null);
  const [rackWindowOpen, setRackWindowOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  // Esc closes the drawer wherever focus is (the toggle keeps focus after opening it).
  useEffect(() => {
    if (!libraryOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setLibraryOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [libraryOpen]);

  const [projectId, setProjectId] = useState(() => `proj-${Date.now()}`);
  const [projectName, setProjectName] = useState('Untitled Mastering Session');
  const [mode, setMode] = useState<MasteringMode>('ai-auto');
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [savedChains, setSavedChains] = useState<SavedChainRecord[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [audioOutputDevices, setAudioOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioEngineInfo, setAudioEngineInfo] = useState<AudioEngineInfo>(() => engineRef.current!.getAudioEngineInfo());

  const [activeTrack, setActiveTrack] = useState<AudioTrackAsset | null>(null);
  const [referenceTrack, setReferenceTrack] = useState<AudioTrackAsset | null>(null);
  const referenceTrackIdRef = useRef<string | null>(null);
  referenceTrackIdRef.current = referenceTrack?.id ?? null;
  const [postAnalysis, setPostAnalysis] = useState<AudioAnalysis | null>(null);
  const [postAnalysisState, setPostAnalysisState] = useState<{
    status: 'idle' | 'processing' | 'ready' | 'failed';
    analysisId: string;
    chainFingerprint: string;
    error: string | null;
    timestamp: number;
  }>({
    status: 'idle',
    analysisId: 'none',
    chainFingerprint: 'dry:0',
    error: null,
    timestamp: 0,
  });
  const [sourceRenderRevision, setSourceRenderRevision] = useState(0);
  const [appliedCorrections, setAppliedCorrections] = useState<AppliedCorrectionRecord[]>([]);
  const [postPeaks, setPostPeaks] = useState<number[] | null>(null);
  const [stageTelemetry, setStageTelemetry] = useState<ProcessorMeterTelemetry[]>([]);
  const [dynamicEqTraces, setDynamicEqTraces] = useState<DynamicEqTrace[]>([]);

  // Chain & Undo/Redo history
  const [chain, setChain] = useState<ProcessorModule[]>(createStarterChain);
  const [undoStack, setUndoStack] = useState<ProcessorModule[][]>([]);
  const [redoStack, setRedoStack] = useState<ProcessorModule[][]>([]);
  const [chainBypassed, setChainBypassed] = useState(false);

  // Playback & monitoring state (high-frequency meters/time live in telemetryStore, NOT React state)
  const [isPlaying, setIsPlaying] = useState(false);
  const [loopEnabled, setLoopEnabled] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [monitorVolume, setMonitorVolume] = useState(0.85);
  const [auditionTarget, setAuditionTarget] = useState<AuditionTarget>('mastered');

  // AI, Mastering Director, Iterative, Battle, QC, Export states
  const [operatingMode, setOperatingMode] = useState<DirectorOperatingMode>(DEFAULT_DIRECTOR_OPERATING_MODE);
  const [objectiveId, setObjectiveId] = useState<MasteringObjectiveId>('streaming');
  const objectiveIdRef = useRef<MasteringObjectiveId>(objectiveId);
  objectiveIdRef.current = objectiveId;
  const [customObjective, setCustomObjective] = useState<CustomObjectiveSpec>({
    targetLufs: -13.0,
    maxTruePeakDb: -1.0,
    minDynamicRangeDb: 7.5,
    tonalBias: 'neutral',
    stereoPreference: 'preserve',
    preserveTransients: true,
  });
  // Cloud AI reasoning is on by default (owner decision 2026-11-25); the user's own choice in
  // AI Director → Safeguards & Cloud is remembered. Failures fall back to the local DSP planner.
  const [useGeminiCloud, setUseGeminiCloudState] = useState<boolean>(() => {
    try {
      const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('syn.useCloudAi') : null;
      return saved === null ? true : saved === '1';
    } catch {
      return true;
    }
  });
  const setUseGeminiCloud = useCallback((value: boolean) => {
    setUseGeminiCloudState(value);
    try { localStorage.setItem('syn.useCloudAi', value ? '1' : '0'); } catch { /* storage unavailable */ }
  }, []);
  const [maxIterations, setMaxIterations] = useState(10);
  const [convergenceThreshold, setConvergenceThreshold] = useState(0.8);
  const [directorPlan, setDirectorPlan] = useState<ExplainableMasterPlan | null>(null);
  const [directorReport, setDirectorReport] = useState<MasterFinalReport | null>(null);
  const [directorActivityLog, setDirectorActivityLog] = useState<DirectorActivityEntry[]>([]);
  const [directorCheckpoints, setDirectorCheckpoints] = useState<DirectorCheckpoint[]>([]);
  const [directorRunning, setDirectorRunning] = useState(false);
  const [directorPaused, setDirectorPaused] = useState(false);
  const [directorStage, setDirectorStage] = useState('');
  const [directorPass, setDirectorPass] = useState(0);
  const [aiLifecycleState, setAiLifecycleState] = useState<AiChainLifecycleState>('Ready');
  const [preAiChainSnapshot, setPreAiChainSnapshot] = useState<ProcessorModule[] | null>(null);
  /** Before/after chains of the last AI run that delivered a chain: drives the "What AI changed" list. */
  const [aiChangeBase, setAiChangeBase] = useState<{ before: ProcessorModule[]; after: ProcessorModule[] } | null>(null);
  const [aiChainAccepted, setAiChainAccepted] = useState<boolean | null>(null);
  const directorPauseRef = useRef(false);
  const directorStopRef = useRef(false);
  const directorRunningRef = useRef(false);
  const directorRunIdRef = useRef(0);
  const activeTrackIdRef = useRef<string | null>(null);
  const offlineRenderSeqRef = useRef(0);
  const sourceUploadSeqRef = useRef(0);
  const referenceUploadSeqRef = useRef(0);

  const [aiStrategy, setAiStrategy] = useState<AIMasteringStrategy | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  // Friendly, non-error notice (for example the cloud AI spend limit: FIX ALL fell back to the local planner).
  const [aiNotice, setAiNotice] = useState<string | null>(null);
  const [aiFallbackBanner, setAiFallbackBanner] = useState<string | null>(null);
  const [iterations, setIterations] = useState<IterationPass[]>([]);
  const [battleCandidates, setBattleCandidates] = useState<BattleCandidate[]>([]);
  const [battleGenerating, setBattleGenerating] = useState(false);
  const [qcTargetId, setQcTargetId] = useState('streaming');

  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [exportConfig, setExportConfig] = useState<ExportConfig>(DEFAULT_EXPORT_CONFIG);
  const [renderingExport, setRenderingExport] = useState(false);
  const [exportDownloadUrl, setExportDownloadUrl] = useState<string | null>(null);
  const [exportDownloadName, setExportDownloadName] = useState<string | null>(null);
  const [exportDeliveryCheck, setExportDeliveryCheck] = useState<{ text: string; warning: boolean } | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportProgress, setExportProgress] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [diagnosticRuns, setDiagnosticRuns] = useState<MasteringDiagnosticRunSummary[]>([]);
  const [latestDiagnosticRun, setLatestDiagnosticRun] = useState<MasteringDiagnosticRunSummary | null>(null);
  const [latestDiagnosticBundle, setLatestDiagnosticBundle] = useState<MasteringDiagnosticBundle | null>(null);
  const [diagnosticArchiveStatus, setDiagnosticArchiveStatus] = useState<
    'loading' | 'idle' | 'saving' | 'saved' | 'session-only' | 'failed'
  >('loading');
  // Import overlay: real staged progress (no timers). null = hidden.
  const [importProgress, setImportProgress] = useState<{
    kind: 'source' | 'reference';
    fileName: string;
    stage: ImportStage;
    percent: number;
    /** The current stage reports no granular progress: hold the value and pulse. */
    working: boolean;
    error: string | null;
  } | null>(null);
  const importAbortRef = useRef<AbortController | null>(null);
  const [fileDragActive, setFileDragActive] = useState(false);
  /** High-res (1600-bin) source peaks computed in the import worker job, keyed by track id. */
  const importPeaksHiRef = useRef<{ trackId: string; peaks: number[] } | null>(null);



  // Subscribe to SynHostBridge and load IndexedDB projects, chains & settings on mount
  useEffect(() => {
    const bridge = hostBridgeRef.current!;
    const unsub = bridge.subscribe(setHostSnapshot);
    void bridge.tryRestoreOrPairFromLocation();
    void (async () => {
      const [loadedProjs, loadedChains, loadedSettings] = await Promise.all([
        listProjects(),
        listSavedChains(),
        loadAppSettings(),
      ]);
      setProjects(loadedProjs);
      setSavedChains(loadedChains);
      if (loadedSettings) {
        const restoredSettings = { ...DEFAULT_SETTINGS, ...loadedSettings };
        setSettings(restoredSettings);
        void engineRef.current!.setLatencyMode(restoredSettings.audioLatencyMode);
        if (restoredSettings.audioOutputDeviceId) {
          void engineRef.current!.setOutputDevice(restoredSettings.audioOutputDeviceId).catch(() => undefined);
        }
      }
    })();
    return () => {
      unsub();
      void engineRef.current!.dispose();
    };
  }, []);

  useEffect(() => {
    if (!settingsModalOpen) return;
    let active = true;
    setAudioEngineInfo(engineRef.current!.getAudioEngineInfo());
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.enumerateDevices) {
      setAudioOutputDevices([]);
      return () => { active = false; };
    }
    void mediaDevices.enumerateDevices().then((devices) => {
      if (active) setAudioOutputDevices(devices.filter((device) => device.kind === 'audiooutput'));
    }).catch(() => {
      if (active) setAudioOutputDevices([]);
    });
    return () => { active = false; };
  }, [settingsModalOpen]);

  // Restore the latest persistent Fix All diagnostic bundle on app startup.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const runs = await listMasteringDiagnosticRuns();
      if (cancelled) return;
      setDiagnosticRuns(runs);
      if (runs.length === 0) {
        setDiagnosticArchiveStatus('idle');
        return;
      }
      const latest = await loadMasteringDiagnosticBundle(runs[0].runId);
      if (cancelled) return;
      if (latest) {
        setLatestDiagnosticRun(runs[0]);
        setLatestDiagnosticBundle(latest);
        setDiagnosticArchiveStatus('saved');
      } else {
        setDiagnosticArchiveStatus('failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const processExternalStage = useCallback<ExternalPluginProcessCallback>(
    async (channels, sampleRate, mod) => {
      const bridge = hostBridgeRef.current!;
      const ext = mod.params as ExternalVST3Params;
      if (bridge.getSnapshot().status !== 'connected') {
        throw new Error(`External plugin "${ext.pluginName}" requires a connected SYN-PLUGIN HOST companion.`);
      }
      if (!ext.instanceId || ext.status !== 'active') {
        throw new Error(
          `External plugin "${ext.pluginName}" worker instance is not loaded. Click Load on its rack card.`,
        );
      }
      const res = await bridge.processAudioOffline([ext.instanceId], sampleRate, channels);
      return { channels: res.channels, latencySamples: res.totalLatencySamples };
    },
    [],
  );

  // Source used for every render (preview, Fix-All, battle, export): the imported audio
  // with the timeline fades applied, so what is verified is exactly what is exported.
  const fadesRef = useRef(fades);
  fadesRef.current = fades;
  const sourceRateRef = useRef(44100);
  // Fades are no longer baked into the source: every render applies them AFTER the
  // chain (postFades) so the limiter sees the unfaded signal.
  const getRenderSource = useCallback((): Float32Array[] | null => {
    const override = vocalSourceOverrideRef.current;
    if (
      objectiveIdRef.current === 'vocal-focused' &&
      override &&
      override.trackId === activeTrackIdRef.current &&
      override.referenceTrackId === referenceTrackIdRef.current &&
      override.revision === sourceRenderRevision
    ) {
      return override.channels;
    }
    return sourceChannelsRef.current;
  }, [sourceRenderRevision]);
  const getPostFades = useCallback((): FadeSettings | null => (hasFades(fadesRef.current) ? fadesRef.current : null), []);

  const prePeaksHi = useMemo(() => {
    if (!activeTrack || !sourceChannelsRef.current) return [];
    // Imported files bring their 1600-bin peaks from the worker job (no UI-thread pass).
    const cached = importPeaksHiRef.current;
    const peaks = cached && cached.trackId === activeTrack.id ? cached.peaks : extractWaveformPeaks(sourceChannelsRef.current, 1600);
    // Lets the EQ waveform layer recompute detail when zoomed (dry source: no fades in it).
    registerWaveformSource(peaks, { channels: sourceChannelsRef.current, sampleRate: activeTrack.sampleRate, includesFades: false });
    return peaks;
  }, [activeTrack]);

  // Vocal Rebalance stem cache follows the active source; a new stem set re-runs the preview render.
  const rebalanceStemState = useSyncExternalStore(subscribeRebalanceStems, getRebalanceStemState, getRebalanceStemState);
  useEffect(() => {
    setActiveRebalanceSource(activeTrack ? sourceChannelsRef.current : null, activeTrack?.sampleRate ?? 0);
  }, [activeTrack]);

  // Prefetch the split-out rack UI right after first paint.
  useEffect(() => {
    const t = window.setTimeout(() => { void loadMasteringRack(); }, 0);
    return () => window.clearTimeout(t);
  }, []);

  // Recompute offline DSP analysis off the main UI thread (debounced 60ms; the EQ blanket holds the prior completed render meanwhile)
  useEffect(() => {
    const src = getRenderSource();
    const track = activeTrack;
    if (!src || !track) return;

    let cancelled = false;
    const seq = ++offlineRenderSeqRef.current;
    const targetFp = computeChainFingerprint(chain, chainBypassed);
    setPostAnalysisState((prev) => ({
      ...prev,
      status: 'processing',
      error: null,
    }));

    const timer = window.setTimeout(() => {
      const effectiveChain = chainBypassed ? [] : chain;
      void (async () => {
        try {
          // D1: with an empty or bypassed rack, no fades and the plain imported source, the
          // preview render is the identity (processChainOffline returns its input untouched),
          // so reuse the import's own analysis and peaks instead of measuring the same audio
          // a second time. Numbers are identical by construction (see analysisIdentity.test.ts).
          const cachedHi = importPeaksHiRef.current;
          const canReuseImport =
            effectiveChain.length === 0 &&
            !getPostFades() &&
            src === sourceChannelsRef.current &&
            cachedHi !== null &&
            cachedHi.trackId === track.id;
          const result = canReuseImport
            ? {
                channels: src,
                telemetry: [],
                analysis: track.analysis,
                peaks: track.peaks,
                peaksHi: cachedHi.peaks,
                dynamicEqTraces: undefined,
              }
            : await renderAndAnalyzeOffThread({
            sourceChannels: src,
            sampleRate: track.sampleRate,
            chain: effectiveChain,
            includePeaks: true,
            peakBins: 400,
            hiPeakBins: 1600,
            externalProcessor: processExternalStage,
            postFades: getPostFades(),
            // Preview only: band solo (listen) and Dynamic EQ traces. Export / Fix All never set these.
            audition: chainHasSoloedBand(effectiveChain),
            collectDynamicEqTraces: effectiveChain.some((m) => m.type === 'dynamic-eq' && m.enabled && !m.bypassed),
          });
          if (cancelled || offlineRenderSeqRef.current !== seq) return;
          const displayedAnalysis = filterSourceTransientClickAnalysis(
            src,
            result.channels,
            track.sampleRate,
            track.analysis,
            result.analysis,
          );
          postChannelsRef.current = result.channels;
          const nextPeaksHi = result.peaksHi ?? extractWaveformPeaks(result.channels, 1600);
          registerWaveformSource(nextPeaksHi, {
            channels: result.channels,
            sampleRate: track.sampleRate,
            includesFades: Boolean(getPostFades()) && !canReuseImport,
          });
          setPostPeaksHi(nextPeaksHi);
          setStageTelemetry(result.telemetry);
          setDynamicEqTraces(result.dynamicEqTraces ?? []);
          setPostPeaks(result.peaks ?? null);
          setPostAnalysis(displayedAnalysis);
          setPostAnalysisState({
            status: 'ready',
            analysisId: `post-${seq}-${Date.now()}`,
            chainFingerprint: targetFp,
            error: null,
            timestamp: Date.now(),
          });
          // VERIFY FIX: "Mastered" playback now plays the exact offline render that was
          // measured and verified (and that export uses), instead of the approximate realtime
          // Web Audio graph, which could sound different from what passed verification.
          if (effectiveChain.length > 0 || getPostFades()) {
            // Timeline fades are independent of the rack: retain the exact offline preview
            // buffer even with an empty or bypassed chain so playback matches export.
            engineRef.current!.setOverrideBuffer('mastered-external', result.channels, track.sampleRate);
          } else {
            engineRef.current!.clearOverrideBuffer('mastered-external');
          }
        } catch (err) {
          if (cancelled || offlineRenderSeqRef.current !== seq) return;
          const errMsg = err instanceof Error ? err.message : 'Audio chain analysis failed.';
          postChannelsRef.current = null;
          setPostAnalysis(null);
          setPostPeaks(null);
          setPostAnalysisState({
            status: 'failed',
            analysisId: `failed-${seq}`,
            chainFingerprint: targetFp,
            error: errMsg,
            timestamp: Date.now(),
          });
          engineRef.current!.clearOverrideBuffer('mastered-external');
          setStatusNotice(errMsg);
        }
      })();
    }, 60);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [chain, chainBypassed, activeTrack, hostSnapshot.status, processExternalStage, fades, getRenderSource, rebalanceStemState.version]);

  // Sync live Web Audio chain
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.setChain(chain);
    engine.setChainBypassed(chainBypassed);
  }, [chain, chainBypassed]);

  // Real-time 30fps meter & playhead animation loop writing to external telemetryStore (zero React re-renders)
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.setOnEnded(() => {
      setIsPlaying(false);
      telemetryStore.publish({ isPlaying: false, currentTimeSec: 0, live: null });
    });

    if (!isPlaying) {
      telemetryStore.publish({ isPlaying: false, live: null });
      return;
    }

    telemetryStore.publish({ isPlaying: true });
    let rafId = 0;
    let lastTick = 0;
    const tick = (now: number) => {
      if (now - lastTick >= 33) {
        lastTick = now;
        telemetryStore.publish({
          isPlaying: true,
          currentTimeSec: engine.getCurrentTimeSec(),
          live: engine.getLiveTelemetry(),
        });
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isPlaying]);

  const recordCorrection = useCallback(
    (
      label: string,
      targetChain: ProcessorModule[],
      opts?: { findingId?: string; bypassed?: boolean; coalesceManual?: boolean },
    ) => {
      const fp = computeChainFingerprint(targetChain, opts?.bypassed ?? chainBypassed);
      const types = targetChain.filter((m) => m.enabled && !m.bypassed).map((m) => m.type);
      const entry: AppliedCorrectionRecord = {
        id: `corr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        timestamp: Date.now(),
        label,
        findingId: opts?.findingId,
        processorTypes: types,
        chainFingerprint: fp,
      };
      setAppliedCorrections((prev) => {
        if (opts?.coalesceManual && prev.length > 0 && prev[prev.length - 1].id.startsWith('manual-')) {
          return [...prev.slice(0, -1), { ...entry, id: `manual-${Date.now()}` }];
        }
        return [
          ...prev.slice(-14),
          opts?.coalesceManual ? { ...entry, id: `manual-${Date.now()}` } : entry,
        ];
      });
    },
    [chainBypassed],
  );

  const updateChainWithHistory = useCallback(
    (nextChain: ProcessorModule[], correctionLabel?: string) => {
      const bridge = hostBridgeRef.current;
      if (bridge && bridge.getSnapshot().status === 'connected') {
        const remainingIds = new Set(
          nextChain
            .filter((m) => m.type === 'external-vst3')
            .map((m) => (m.params as ExternalVST3Params).instanceId)
            .filter((id): id is string => Boolean(id)),
        );
        for (const mod of chain) {
          if (mod.type === 'external-vst3') {
            const instId = (mod.params as ExternalVST3Params).instanceId;
            if (instId && !remainingIds.has(instId)) {
              void bridge.unloadPluginInstance(instId).catch(() => undefined);
            }
          }
        }
      }
      const undoSnapshot = chain.map((m) =>
        m.type === 'external-vst3'
          ? {
              ...m,
              params: {
                ...(m.params as ExternalVST3Params),
                instanceId: null,
                status: 'unloaded' as const,
                editorOpen: false,
              },
            }
          : m,
      );
      setUndoStack((u) => [...u.slice(-24), undoSnapshot]);
      setRedoStack([]);
      // Vocal Rebalance works on source stems, so it always stays first (no-op for other chains).
      const ordered = hoistVocalRebalance(nextChain);
      setChain(ordered);
      if (correctionLabel) {
        recordCorrection(correctionLabel, ordered);
      }
    },
    [chain, recordCorrection],
  );

  // External VST3 Plugin Instance Handlers (Milestone 2)
  const handleInsertExternalPlugin = useCallback(
    async (plugin: ExternalPluginRecord) => {
      const bridge = hostBridgeRef.current!;
      const mod = createProcessorModule('external-vst3', {
        name: plugin.name,
        expanded: true,
        params: {
          uid: plugin.uid,
          bundlePath: plugin.bundlePath,
          pluginName: plugin.name,
          manufacturer: plugin.manufacturer,
          version: plugin.version,
          format: plugin.format,
          instanceId: null,
          latencySamples: plugin.latencySamples,
          hasEditor: plugin.hasEditor,
          editorOpen: false,
          status: 'unloaded',
          lastError: '',
          stateBase64: '',
          parameters: plugin.parameters.map((p) => ({
            id: p.id,
            name: p.name,
            label: p.label,
            valueNormalized: p.defaultValueNormalized,
            defaultValueNormalized: p.defaultValueNormalized,
            stepCount: p.stepCount,
            isAutomatable: p.isAutomatable,
            isReadOnly: p.isReadOnly,
            isBypass: p.isBypass,
            displayValue: '',
          })),
        } satisfies ExternalVST3Params,
      });

      const ext = mod.params as ExternalVST3Params;
      if (bridge.getSnapshot().status === 'connected') {
        try {
          const info = await bridge.loadPluginInstance({
            uid: plugin.uid,
            bundlePath: plugin.bundlePath,
            sampleRate: activeTrack?.sampleRate ?? 48000,
            blockSize: 512,
            channels: 2,
          });
          ext.instanceId = info.instanceId;
          ext.status = 'active';
          ext.latencySamples = info.latencySamples;
          ext.hasEditor = info.hasEditor;
          ext.parameters = info.parameters.map((p) => ({ ...p }));
          ext.lastError = '';
          void bridge.setPluginPreference(plugin.uid, plugin.bundlePath, { lastUsedAt: Date.now() });
        } catch (err) {
          ext.status = 'error';
          ext.lastError = err instanceof Error ? err.message : 'Failed to load isolated plugin worker';
        }
      }

      updateChainWithHistory([...chain, mod]);
      setActiveTab('studio');
      setStatusNotice(
        ext.status === 'active'
          ? `Inserted & loaded VST3 "${plugin.name}" (isolated worker).`
          : `Inserted "${plugin.name}" in rack (${ext.lastError || 'connect host to load worker'}).`,
      );
    },
    [activeTrack?.sampleRate, chain, updateChainWithHistory],
  );

  const handleLoadExternalInstance = useCallback(
    async (mod: ProcessorModule) => {
      const bridge = hostBridgeRef.current!;
      const ext = mod.params as ExternalVST3Params;
      try {
        const info = await bridge.loadPluginInstance({
          uid: ext.uid,
          bundlePath: ext.bundlePath,
          sampleRate: activeTrack?.sampleRate ?? 48000,
          blockSize: 512,
          channels: 2,
        });
        let syncedParams = info.parameters.map((p) => ({ ...p }));
        if (ext.stateBase64) {
          await bridge.setPluginState(info.instanceId, ext.stateBase64).catch(() => undefined);
          syncedParams = await bridge.getPluginParameters(info.instanceId).catch(() => syncedParams);
        }
        if (mod.bypassed) {
          await bridge.setPluginBypass(info.instanceId, true).catch(() => undefined);
        }
        setChain((prev) =>
          prev.map((m) => {
            if (m.id !== mod.id) return m;
            return {
              ...m,
              params: {
                ...(m.params as ExternalVST3Params),
                instanceId: info.instanceId,
                status: 'active',
                latencySamples: info.latencySamples,
                hasEditor: info.hasEditor,
                editorOpen: false,
                parameters: syncedParams,
                lastError: '',
              } satisfies ExternalVST3Params,
            };
          }),
        );
        setStatusNotice(`Loaded isolated worker for "${ext.pluginName}".`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to load plugin worker';
        setChain((prev) =>
          prev.map((m) =>
            m.id === mod.id
              ? {
                  ...m,
                  params: { ...(m.params as ExternalVST3Params), instanceId: null, status: 'error', lastError: msg },
                }
              : m,
          ),
        );
        setStatusNotice(msg);
      }
    },
    [activeTrack?.sampleRate],
  );

  const handleSetExternalParam = useCallback(
    async (mod: ProcessorModule, paramId: number, valueNormalized: number) => {
      const ext = mod.params as ExternalVST3Params;
      if (!ext.instanceId || hostBridgeRef.current!.getSnapshot().status !== 'connected') {
        setStatusNotice(`Cannot set "${ext.pluginName}" parameter: companion host disconnected.`);
        return;
      }

      const key = `${mod.id}:${paramId}`;
      externalParamLatestRef.current.set(key, valueNormalized);
      if (externalParamInFlightRef.current.has(key)) {
        return;
      }

      externalParamInFlightRef.current.add(key);
      try {
        while (externalParamLatestRef.current.has(key)) {
          const targetVal = externalParamLatestRef.current.get(key)!;
          externalParamLatestRef.current.delete(key);

          const updated = await hostBridgeRef.current!.setPluginParameter(ext.instanceId, paramId, targetVal);

          setChain((prev) =>
            prev.map((m) => {
              if (m.id !== mod.id) return m;
              const p = m.params as ExternalVST3Params;
              return {
                ...m,
                params: {
                  ...p,
                  lastError: '',
                  parameters: p.parameters.map((param) =>
                    param.id === paramId
                      ? { ...param, valueNormalized: updated.valueNormalized, displayValue: updated.displayValue }
                      : param,
                  ),
                },
              };
            }),
          );
        }

        // Snapshot opaque VST3 state chunk once queued parameter drags settle
        const stateB64 = await hostBridgeRef.current!.getPluginState(ext.instanceId).catch(() => '');
        if (stateB64) {
          setChain((prev) =>
            prev.map((m) =>
              m.id === mod.id
                ? {
                    ...m,
                    params: {
                      ...(m.params as ExternalVST3Params),
                      stateBase64: stateB64,
                    },
                  }
                : m,
            ),
          );
        }
      } catch (err) {
        externalParamLatestRef.current.delete(key);
        const msg = err instanceof Error ? err.message : 'VST3 parameter update failed';
        setChain((prev) =>
          prev.map((m) => {
            if (m.id !== mod.id) return m;
            return {
              ...m,
              params: {
                ...(m.params as ExternalVST3Params),
                lastError: msg,
              },
            };
          }),
        );
        setStatusNotice(msg);
      } finally {
        externalParamInFlightRef.current.delete(key);
      }
    },
    [],
  );

  const chainRef = useRef(chain);
  chainRef.current = chain;
  const hasOpenVst3Editor = chain.some(
    (m) =>
      m.type === 'external-vst3' &&
      (m.params as ExternalVST3Params).editorOpen &&
      Boolean((m.params as ExternalVST3Params).instanceId),
  );

  // Bidirectional parameter sync while a native VST3 editor window is open
  useEffect(() => {
    if (hostSnapshot.status !== 'connected' || !hasOpenVst3Editor) return;

    const timer = window.setInterval(() => {
      const bridge = hostBridgeRef.current;
      if (!bridge || bridge.getSnapshot().status !== 'connected') return;
      const openModules = chainRef.current.filter(
        (m) =>
          m.type === 'external-vst3' &&
          (m.params as ExternalVST3Params).editorOpen &&
          Boolean((m.params as ExternalVST3Params).instanceId),
      );
      for (const mod of openModules) {
        const ext = mod.params as ExternalVST3Params;
        if (!ext.instanceId) continue;
        const instanceId = ext.instanceId;
        void bridge
          .getPluginParameters(instanceId)
          .then(async (freshParams) => {
            if (!freshParams || freshParams.length === 0) return;

            let detectedChange = false;
            setChain((prev) =>
              prev.map((m) => {
                if (m.id !== mod.id) return m;
                const curr = m.params as ExternalVST3Params;
                const mergedParams = freshParams.map((fp, idx) => {
                  const key = `${m.id}:${fp.id}`;
                  if (
                    externalParamInFlightRef.current.has(key) ||
                    externalParamLatestRef.current.has(key)
                  ) {
                    return curr.parameters.find((cp) => cp.id === fp.id) ?? curr.parameters[idx] ?? fp;
                  }
                  return fp;
                });
                const changed =
                  mergedParams.length !== curr.parameters.length ||
                  mergedParams.some(
                    (fp, i) =>
                      Math.abs(fp.valueNormalized - (curr.parameters[i]?.valueNormalized ?? -1)) > 1e-4 ||
                      fp.displayValue !== curr.parameters[i]?.displayValue,
                  );
                if (!changed) return m;
                detectedChange = true;
                return {
                  ...m,
                  params: {
                    ...curr,
                    parameters: mergedParams,
                  },
                };
              }),
            );

            if (detectedChange) {
              const stateB64 = await bridge.getPluginState(instanceId).catch(() => '');
              if (stateB64) {
                setChain((prev) =>
                  prev.map((m) =>
                    m.id === mod.id
                      ? { ...m, params: { ...(m.params as ExternalVST3Params), stateBase64: stateB64 } }
                      : m,
                  ),
                );
              }
            }
          })
          .catch(() => undefined);
      }
    }, 900);

    return () => window.clearInterval(timer);
  }, [hostSnapshot.status, hasOpenVst3Editor]);

  const handleToggleExternalEditor = useCallback(async (mod: ProcessorModule) => {
    const bridge = hostBridgeRef.current!;
    const ext = mod.params as ExternalVST3Params;
    if (!ext.instanceId) return;
    try {
      if (ext.editorOpen) {
        await bridge.closePluginEditor(ext.instanceId);
        const [syncedParams, syncedState] = await Promise.all([
          bridge.getPluginParameters(ext.instanceId).catch(() => ext.parameters),
          bridge.getPluginState(ext.instanceId).catch(() => ext.stateBase64),
        ]);
        setChain((prev) =>
          prev.map((m) =>
            m.id === mod.id
              ? {
                  ...m,
                  params: {
                    ...(m.params as ExternalVST3Params),
                    editorOpen: false,
                    parameters: syncedParams,
                    stateBase64: syncedState || ext.stateBase64,
                  },
                }
              : m,
          ),
        );
      } else {
        await bridge.openPluginEditor(ext.instanceId);
        setChain((prev) =>
          prev.map((m) =>
            m.id === mod.id
              ? { ...m, params: { ...(m.params as ExternalVST3Params), editorOpen: true } }
              : m,
          ),
        );
      }
    } catch (err) {
      setStatusNotice(err instanceof Error ? err.message : 'Failed to toggle native plugin editor');
    }
  }, []);

  const handleToggleExternalBypass = useCallback(
    async (mod: ProcessorModule) => {
      const nextBypassed = !mod.bypassed;
      const ext = mod.params as ExternalVST3Params;
      updateChainWithHistory(chain.map((m) => (m.id === mod.id ? { ...m, bypassed: nextBypassed } : m)));
      if (ext.instanceId && hostBridgeRef.current!.getSnapshot().status === 'connected') {
        await hostBridgeRef.current!.setPluginBypass(ext.instanceId, nextBypassed).catch(() => undefined);
      }
    },
    [chain, updateChainWithHistory],
  );

  const handleStartWasapiAudition = useCallback(
    async (deviceId: string) => {
      const src = getRenderSource();
      if (!src || !activeTrack) {
        throw new Error('Load an audio track before starting native WASAPI audition.');
      }
      const effectiveChain = chainBypassed ? [] : chain;
      const rendered = await renderMixedChain(src, activeTrack.sampleRate, effectiveChain, processExternalStage, getPostFades());
      const status = await hostBridgeRef.current!.startWasapiAudition(
        rendered.channels,
        activeTrack.sampleRate,
        deviceId,
        true,
      );
      setStatusNotice(
        status.active
          ? `WASAPI audition active (${status.sampleRate ?? activeTrack.sampleRate} Hz).`
          : 'WASAPI audition stopped.',
      );
    },
    [activeTrack, chain, chainBypassed, processExternalStage],
  );

  const handleStopWasapiAudition = useCallback(async () => {
    await hostBridgeRef.current!.stopWasapiAudition();
    setStatusNotice('Stopped native host audio audition.');
  }, []);

  const handleUndo = useCallback(() => {
    if (undoStack.length === 0) return;
    const prev = undoStack[undoStack.length - 1];
    setRedoStack((r) => [...r, chain]);
    setUndoStack((u) => u.slice(0, -1));
    setChain(prev);
  }, [undoStack, chain]);

  const handleRedo = useCallback(() => {
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    setUndoStack((u) => [...u, chain]);
    setRedoStack((r) => r.slice(0, -1));
    setChain(next);
  }, [redoStack, chain]);

  const loadChannelsAsSource = useCallback(
    (
      channels: Float32Array[],
      sampleRate: number,
      name: string,
      fileSizeBytes: number,
      format: string,
      isDemo = false,
      precomputed?: { analysis: AudioAnalysis; peaks: number[]; peaksHi?: number[]; playbackBuffer?: AudioBuffer | null },
    ) => {
      // Cancel any in-flight CHAIN WITH AI run targeting the previous source track
      vocalPreparationAbortRef.current?.abort();
      vocalPreparationAbortRef.current = null;
      vocalPreparationCacheRef.current.clear();
      vocalSourceOverrideRef.current = null;
      setSourceRenderRevision((revision) => revision + 1);
      if (directorRunningRef.current) {
        directorStopRef.current = true;
        getActiveAiCall()?.cancel();
        directorPauseRef.current = false;
        directorRunningRef.current = false;
      }
      directorRunIdRef.current += 1;
      setDirectorRunning(false);
      setDirectorPaused(false);
      // A stale Gemini request intentionally cannot clear its own loading state.
      // Reset request UI here when the source changes so the new track is never left blocked.
      setAiLoading(false);
      setAiError(null);
      setAiStrategy(null);
      setAiLifecycleState('Ready');
      setPreAiChainSnapshot(null);
      setAiChangeBase(null);
      setAiChainAccepted(null);

      engineRef.current!.clearOverrideBuffer('mastered-external');
      engineRef.current!.clearOverrideBuffer('iteration');
      for (const key of Array.from(engineRef.current!.getOverrideBufferKeys())) {
        if (key.startsWith('candidate-')) engineRef.current!.clearOverrideBuffer(key);
      }
      engineRef.current!.setAuditionTarget('mastered', 0);

      const engine = engineRef.current!;
      sourceChannelsRef.current = channels;
      sourceRateRef.current = sampleRate;
      matchEqStore.setSource(channels, sampleRate);
      setFades(NO_FADES);
      setPostPeaksHi(null);
      engine.setSourceChannels(channels, sampleRate, precomputed?.playbackBuffer ?? null);
      setIsPlaying(false);
      telemetryStore.reset();
      setAuditionTarget('mastered');

      const analysis = precomputed?.analysis ?? analyzeAudioBuffer(channels, sampleRate);
      const peaks = precomputed?.peaks ?? extractWaveformPeaks(channels, 400);
      const trackId = `trk-${Date.now()}`;
      activeTrackIdRef.current = trackId;
      importPeaksHiRef.current = precomputed?.peaksHi ? { trackId, peaks: precomputed.peaksHi } : null;
      const asset: AudioTrackAsset = {
        id: trackId,
        name,
        fileSizeBytes,
        format,
        sampleRate,
        channels: channels.length,
        durationSec: analysis.durationSec,
        bitDepthLabel: '32-bit Float Internal',
        peaks,
        analysis,
        isDemo,
      };
      setActiveTrack(asset);
      setPostAnalysis(null);
      setPostPeaks(null);
      setAppliedCorrections([]);
      setPostAnalysisState({
        status: 'idle',
        analysisId: 'none',
        chainFingerprint: 'dry:0',
        error: null,
        timestamp: 0,
      });
      setDirectorPlan(null);
      setDirectorReport(null);
      setDirectorActivityLog([]);
      setDirectorCheckpoints([]);
      setExportConfig((prev) => ({
        ...prev,
        filename: name.replace(/\.[^/.]+$/, '') + '_SYN_MASTER',
        sampleRate: ([44100, 48000, 88200, 96000].includes(sampleRate) ? sampleRate : 48000) as ExportConfig['sampleRate'],
      }));
      setStatusNotice(`Loaded "${name}" (${analysis.integratedLufs.toFixed(1)} LUFS pre-master)`);
    },
    [],
  );

  const handleLoadDemoSource = useCallback(
    (variant: 'main-mix' | 'sine-sweep') => {
      sourceUploadSeqRef.current += 1;
      const stem = generateDemoMasterStem(variant, 44100, variant === 'sine-sweep' ? 8 : 14);
      loadChannelsAsSource(stem.channels, stem.sampleRate, stem.name, stem.channels[0].byteLength * 2, 'WAV (Synth)', true);
    },
    [loadChannelsAsSource],
  );

  // No automatic demo load: generating and analysing the 14 s demo mix runs on the main thread (about 0.8 s on a
  // fast desktop, several seconds on a phone) and re-ran every time the track was closed. The workstation opens
  // straight into the console with Import ("Load demo session" stays available as an explicit button).

  /**
   * Shared import pipeline with REAL staged progress: read (FileReader bytes) -> decode
   * (browser decoder, no granular progress: hold + pulse) -> analyze (worker posts progress
   * between measurement sections) -> waveform (worker) -> finishing. The decoded channels are
   * transferred to the worker (no clone) and come back untouched (empty chain, no fades).
   * Cancel aborts reading / drops the decode / terminates the worker job.
   */
  const runImportPipeline = useCallback(
    async (file: File, kind: 'source' | 'reference', isCurrent: () => boolean) => {
      importAbortRef.current?.abort();
      const controller = new AbortController();
      importAbortRef.current = controller;
      const update = (stage: ImportStage, fraction: number, working = false) => {
        if (!isCurrent() || controller.signal.aborted) return;
        const percent = importStagePercent(stage, fraction);
        setImportProgress((prev) => ({
          kind,
          fileName: file.name,
          stage,
          percent: prev && prev.kind === kind && prev.fileName === file.name ? Math.max(prev.percent, percent) : percent,
          working,
          error: null,
        }));
      };
      update('reading', 0);
      // Let the overlay paint before any heavy work starts.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      // A decoder that never answers (seen on Android) must end in an error, not a hang.
      const decodeWatchdogMs = Math.min(300_000, Math.max(60_000, (file.size / 1_048_576) * 2_000));
      let watchdog: number | undefined;
      const decoded = await Promise.race([
        engineRef.current!.decodeFile(file, {
          signal: controller.signal,
          onReadProgress: (f) => update('reading', f),
          onDecodeStart: () => update('decoding', 0, true),
        }),
        new Promise<never>((_, reject) => {
          watchdog = window.setTimeout(() => {
            const err = new Error('decode-timeout');
            err.name = 'DecodeTimeout';
            reject(err);
          }, decodeWatchdogMs);
        }),
      ]).finally(() => window.clearTimeout(watchdog));
      update('decoding', 1);
      if (!isCurrent() || controller.signal.aborted) return null;
      const playbackBuffer = decoded.buffer;
      const offThread = await renderAndAnalyzeOffThread({
        sourceChannels: decoded.channels,
        sampleRate: decoded.sampleRate,
        chain: [],
        includePeaks: true,
        peakBins: 400,
        hiPeakBins: kind === 'source' ? 1600 : undefined,
        transferSource: true,
        signal: controller.signal,
        onProgress: (stage, fraction) => {
          if (stage === 'analyzing') update('analyzing', fraction);
          else if (stage === 'waveform') update('waveform', fraction);
          else update('analyzing', 0);
        },
      });
      if (!isCurrent() || controller.signal.aborted) return null;
      update('finishing', 0);
      // The worker hands back the very same samples (identity render): use them as the source.
      return { offThread, channels: offThread.channels, sampleRate: decoded.sampleRate, playbackBuffer };
    },
    [],
  );

  const describeImportError = useCallback((err: unknown, fileName: string): string => {
    const name = err instanceof Error ? err.name : '';
    const msg = err instanceof Error ? err.message : '';
    if (name === 'DecodeTimeout') {
      return `"${fileName}" took too long to decode on this device. Try a shorter file or a WAV/MP3 export.`;
    }
    if (name === 'NotReadableError') return `"${fileName}" could not be read. Check the file and try again.`;
    if (name === 'RangeError' && /memory|allocation|array buffer/i.test(msg)) {
      return `"${fileName}" is too large for this device's memory. Try a shorter file or a lower sample rate.`;
    }
    if (/memory|allocation/i.test(msg)) {
      return `"${fileName}" is too large for this device's memory. Try a shorter file or a lower sample rate.`;
    }
    if (/Off-thread DSP|DSP worker/.test(msg)) {
      return `"${fileName}" was decoded but could not be analyzed (${msg.slice(0, 140)}).`;
    }
    return `Could not decode "${fileName}". It may be unsupported or damaged. Supported: WAV, MP3, FLAC, AAC/M4A, OGG, AIFF.`;
  }, []);

  const showImportError = useCallback((kind: 'source' | 'reference', fileName: string, message: string) => {
    setImportProgress((prev) => ({
      kind,
      fileName,
      stage: prev?.stage ?? 'decoding',
      percent: prev?.percent ?? 0,
      working: false,
      error: message,
    }));
    setStatusNotice(message);
  }, []);

  const handleCancelImport = useCallback(() => {
    importAbortRef.current?.abort();
    importAbortRef.current = null;
    // Invalidate both pipelines; a late result is ignored by its sequence check.
    sourceUploadSeqRef.current += 1;
    referenceUploadSeqRef.current += 1;
    setImportProgress(null);
    setStatusNotice('Import cancelled.');
  }, []);

  const handleUploadSourceFile = useCallback(
    async (file: File) => {
      const uploadSeq = ++sourceUploadSeqRef.current;
      const isCurrent = () => uploadSeq === sourceUploadSeqRef.current;
      try {
        const done = await runImportPipeline(file, 'source', isCurrent);
        if (!done || !isCurrent()) return;
        const ext = file.name.split('.').pop()?.toUpperCase() ?? 'AUDIO';
        loadChannelsAsSource(
          done.channels,
          done.sampleRate,
          file.name,
          file.size,
          ext,
          false,
          {
            analysis: done.offThread.analysis,
            peaks: done.offThread.peaks ?? extractWaveformPeaks(done.channels, 400),
            peaksHi: done.offThread.peaksHi,
            playbackBuffer: done.playbackBuffer,
          },
        );
        setImportProgress((prev) => (prev ? { ...prev, stage: 'finishing', percent: 100, working: false } : prev));
        window.setTimeout(() => {
          if (isCurrent()) setImportProgress((prev) => (prev && !prev.error ? null : prev));
        }, 320);
      } catch (err) {
        if (!isCurrent()) return;
        if (err instanceof Error && err.name === 'AbortError') {
          setImportProgress(null);
          return;
        }
        showImportError('source', file.name, describeImportError(err, file.name));
      }
    },
    [loadChannelsAsSource, runImportPipeline, describeImportError, showImportError],
  );

  const handleLoadDemoReference = useCallback(() => {
    referenceUploadSeqRef.current += 1;
    const stem = generateDemoMasterStem('reference-bright', 44100, 14);
    vocalPreparationAbortRef.current?.abort();
    vocalPreparationAbortRef.current = null;
    vocalPreparationCacheRef.current.clear();
    vocalSourceOverrideRef.current = null;
    setSourceRenderRevision((revision) => revision + 1);
    referenceChannelsRef.current = stem.channels;
    engineRef.current!.setReferenceChannels(stem.channels, stem.sampleRate);
    matchEqStore.setReference(stem.channels, stem.sampleRate, stem.name);
    const analysis = analyzeAudioBuffer(stem.channels, stem.sampleRate);
    const referenceId = `ref-${Date.now()}`;
    referenceTrackIdRef.current = referenceId;
    setReferenceTrack({
      id: referenceId,
      name: stem.name,
      fileSizeBytes: stem.channels[0].byteLength * 2,
      format: 'WAV (Ref)',
      sampleRate: stem.sampleRate,
      channels: 2,
      durationSec: analysis.durationSec,
      bitDepthLabel: '32-bit Float',
      peaks: extractWaveformPeaks(stem.channels, 400),
      analysis,
      isDemo: true,
    });
    setStatusNotice(`Loaded reference "${stem.name}" (${analysis.integratedLufs.toFixed(1)} LUFS)`);
  }, []);

  const handleUploadReferenceFile = useCallback(async (file: File) => {
    const uploadSeq = ++referenceUploadSeqRef.current;
    const isCurrent = () => uploadSeq === referenceUploadSeqRef.current;
    try {
      const done = await runImportPipeline(file, 'reference', isCurrent);
      if (!done || !isCurrent()) return;
      const decoded = { channels: done.channels, sampleRate: done.sampleRate };
      const offThread = done.offThread;
      vocalPreparationAbortRef.current?.abort();
      vocalPreparationAbortRef.current = null;
      vocalPreparationCacheRef.current.clear();
      vocalSourceOverrideRef.current = null;
      setSourceRenderRevision((revision) => revision + 1);
      referenceChannelsRef.current = decoded.channels;
      engineRef.current!.setReferenceChannels(decoded.channels, decoded.sampleRate, done.playbackBuffer);
      matchEqStore.setReference(decoded.channels, decoded.sampleRate, file.name);
      const analysis = offThread.analysis;
      const peaks = offThread.peaks ?? extractWaveformPeaks(decoded.channels, 400);
      const referenceId = `ref-${Date.now()}`;
      referenceTrackIdRef.current = referenceId;
      setReferenceTrack({
        id: referenceId,
        name: file.name,
        fileSizeBytes: file.size,
        format: file.name.split('.').pop()?.toUpperCase() ?? 'AUDIO',
        sampleRate: decoded.sampleRate,
        channels: decoded.channels.length,
        durationSec: analysis.durationSec,
        bitDepthLabel: '32-bit Float',
        peaks,
        analysis,
      });
      setImportProgress((prev) => (prev ? { ...prev, stage: 'finishing', percent: 100, working: false } : prev));
      window.setTimeout(() => {
        if (isCurrent()) setImportProgress((prev) => (prev && !prev.error ? null : prev));
      }, 320);
      setStatusNotice(`Loaded reference "${file.name}"`);
    } catch (err) {
      if (!isCurrent()) return;
      if (err instanceof Error && err.name === 'AbortError') {
        setImportProgress(null);
        return;
      }
      showImportError('reference', file.name, `Reference: ${describeImportError(err, file.name)}`);
    }
  }, [runImportPipeline, describeImportError, showImportError]);

  const switchAuditionTarget = useCallback(
    (target: AuditionTarget, customTrimDb?: number) => {
      const engine = engineRef.current!;
      let trimDb = customTrimDb ?? 0;

      if (customTrimDb === undefined && settings.loudnessMatchAB && activeTrack && postAnalysis) {
        if (target === 'original') {
          trimDb = postAnalysis.integratedLufs - activeTrack.analysis.integratedLufs;
          trimDb = Math.max(-12, Math.min(12, trimDb));
        } else if (target === 'reference' && referenceTrack) {
          trimDb = postAnalysis.integratedLufs - referenceTrack.analysis.integratedLufs;
          trimDb = Math.max(-14, Math.min(14, trimDb));
        }
      }

      setAuditionTarget(target);
      engine.setAuditionTarget(target, trimDb);
    },
    [settings.loudnessMatchAB, activeTrack, postAnalysis, referenceTrack],
  );

  /** One shared playback position: every seekable view (timeline, live spectrum) goes through here. */
  const seekTo = useCallback((sec: number) => {
    engineRef.current?.seek(sec);
    telemetryStore.publish({ currentTimeSec: sec });
  }, []);

  const togglePlay = useCallback(() => {
    const engine = engineRef.current!;
    if (!activeTrack) return;
    if (isPlaying) {
      engine.pause();
      setIsPlaying(false);
      telemetryStore.publish({
        isPlaying: false,
        currentTimeSec: engine.getCurrentTimeSec(),
        live: null,
      });
    } else {
      engine.play();
      setIsPlaying(true);
      telemetryStore.publish({
        isPlaying: true,
        currentTimeSec: engine.getCurrentTimeSec(),
      });
    }
  }, [activeTrack, isPlaying]);

  // Keyboard shortcuts: Space play/pause, B bypass, A toggle Original/Mastered
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const role = target?.getAttribute('role');
      if (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        role === 'slider' ||
        role === 'switch'
      ) {
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
      } else if (e.key.toLowerCase() === 'b') {
        setChainBypassed((b) => !b);
      } else if (e.key.toLowerCase() === 'a') {
        switchAuditionTarget(auditionTarget === 'original' ? 'mastered' : 'original');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [togglePlay, switchAuditionTarget, auditionTarget]);

  const handleSaveProject = async () => {
    const rec: ProjectRecord = {
      id: projectId,
      name: projectName,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      mode,
      trackName: activeTrack?.name,
      chain,
      aiStrategy,
      iterations,
      qcTargetId,
      exportConfig,
    };
    await saveProject(rec);
    const updated = await listProjects();
    setProjects(updated);
    setStatusNotice(`Saved project "${projectName}" to IndexedDB.`);
  };

  // QC loudness / true-peak limits always follow the selected mastering objective, so the
  // QC panel, the Fix-All loop and post-fix verification judge against the SAME target.
  const activeQcProfile = useMemo(
    () =>
      alignQcProfileToObjective(
        QC_TARGET_PROFILES.find((p) => p.id === qcTargetId) ?? QC_TARGET_PROFILES[0],
        resolveObjectiveTarget(objectiveId, customObjective, referenceTrack?.analysis ?? null),
      ),
    [qcTargetId, objectiveId, customObjective, referenceTrack],
  );

  const qcReport = useMemo(() => {
    if (!activeTrack || !postAnalysis || postAnalysisState.status === 'failed') return null;
    return runQualityControl(activeTrack.analysis, postAnalysis, activeQcProfile, exportConfig);
  }, [activeTrack, postAnalysis, postAnalysisState.status, activeQcProfile, exportConfig]);
  // QC workspace only: while the master render is pending (or failed), validate the source so
  // the QC page is never empty with a track loaded. Other consumers keep the master-only report.
  const qcViewReport = useMemo(() => {
    if (qcReport || !activeTrack) return qcReport;
    return runQualityControl(activeTrack.analysis, activeTrack.analysis, activeQcProfile, exportConfig);
  }, [qcReport, activeTrack, activeQcProfile, exportConfig]);

  // Platform Preview (monitoring only): the playback gain a streaming platform would apply to the
  // master. It sits on the playback bus after the chain and never touches render, Fix All or export.
  const platformSelection = usePlatformPreviewSelection();
  const platformLevels = useMemo<MasterLevels | null>(() => {
    const a = postAnalysisState.status === 'ready' && postAnalysis ? postAnalysis : activeTrack?.analysis ?? null;
    return a ? { integratedLufs: a.integratedLufs, truePeakDb: a.truePeakDb, samplePeakDb: a.samplePeakDb } : null;
  }, [postAnalysis, postAnalysisState.status, activeTrack]);
  useEffect(() => {
    const prediction = platformLevels
      ? predictForPlatform(platformLevels, platformSelection.platformId, platformSelection.spotifyLevel)
      : null;
    const rule = getPlatformRule(platformSelection.platformId, platformSelection.spotifyLevel);
    engineRef.current?.setPlatformPreview(
      prediction?.gainDb ?? 0,
      rule.limiter && prediction?.limiterEngaged
        ? {
            thresholdDb: rule.limiter.thresholdDbfs,
            attackMs: rule.limiter.attackMs,
            releaseMs: rule.limiter.releaseMs,
            makeupDb: compressorMakeupDb(rule.limiter.thresholdDbfs, 20),
          }
        : null,
    );
  }, [platformLevels, platformSelection]);
  const getPlatformMasterAudio = useCallback(() => {
    const channels = postChannelsRef.current ?? sourceChannelsRef.current;
    return channels && activeTrack ? { channels, sampleRate: activeTrack.sampleRate } : null;
  }, [activeTrack]);

  const currentChainFingerprint = useMemo(
    () => computeChainFingerprint(chain, chainBypassed),
    [chain, chainBypassed],
  );

  const baselineDiagnosis = useMemo(() => {
    if (!activeTrack) return null;
    return (
      directorPlan?.diagnosis ??
      analyzeTrackIntelligence(
        activeTrack.analysis,
        objectiveId,
        referenceTrack?.analysis ?? null,
      )
    );
  }, [activeTrack, directorPlan, objectiveId, referenceTrack]);

  const postFixVerification = useMemo(() => {
    if (!activeTrack) return null;
    const objectiveTarget = resolveObjectiveTarget(
      objectiveId,
      customObjective,
      referenceTrack?.analysis ?? null,
    );
    return verifyPostFixAnalysis({
      baselineAnalysis: activeTrack.analysis,
      baselineDiagnosis,
      postAnalysis: postAnalysisState.status === 'ready' ? postAnalysis : null,
      objective: objectiveTarget,
      referenceAnalysis: referenceTrack?.analysis ?? null,
      baselineAnalysisId: activeTrack.id,
      postAnalysisId: postAnalysisState.analysisId,
      currentChainFingerprint,
      postChainFingerprint: postAnalysisState.chainFingerprint,
      postProcessingStatus: postAnalysisState.status,
      postProcessingError: postAnalysisState.error,
      appliedCorrections,
    });
  }, [
    activeTrack,
    baselineDiagnosis,
    postAnalysis,
    postAnalysisState,
    objectiveId,
    customObjective,
    referenceTrack,
    currentChainFingerprint,
    appliedCorrections,
  ]);

  const referenceComparison = useMemo(() => {
    if (!activeTrack || !referenceTrack) return null;
    return compareReferenceIntelligent(
      activeTrack.analysis,
      postAnalysis ?? activeTrack.analysis,
      referenceTrack.analysis,
    );
  }, [activeTrack, postAnalysis, referenceTrack]);

  const handleAnalyzeTrack = useCallback(() => {
    if (!activeTrack) return;
    setAiError(null);
    const plan = buildExplainableMasterPlan({
      analysis: activeTrack.analysis,
      objectiveId,
      customSpec: customObjective,
      referenceAnalysis: referenceTrack?.analysis ?? null,
      matchEqProfile: referenceTrack ? matchEqStore.getProfile() : null,
      externalPlugins: hostSnapshot.plugins,
      hostConnected: hostSnapshot.status === 'connected',
    });
    setDirectorPlan(plan);
    setAiStrategy(plan.strategy);
    setStatusNotice(
      `SYN-ANALYZE complete (${plan.diagnosis.findings.filter((f) => f.kind === 'technical-problem').length} technical issue(s), ${plan.recommendations.length}-stage plan ready).`,
    );
  }, [activeTrack, objectiveId, customObjective, referenceTrack, hostSnapshot.plugins, hostSnapshot.status]);

  const handleApplyRecommendation = useCallback(
    (rec: DirectorRecommendation) => {
      if (rec.commands.length === 0) return;
      const res = applyStructuredChainCommands(chain, rec.commands);
      const findingMap: Record<string, string> = {
        'rec-eq': 'diag-mud',
        'rec-dyn-eq': 'diag-harsh',
        'rec-restore': 'diag-noise',
        'rec-imager': 'diag-phase',
        'rec-maximizer': 'diag-clipping',
        'rec-limiter': 'diag-clipping',
      };
      updateChainWithHistory(res.chain);
      recordCorrection(
        `Applied Stage: ${rec.pluginName ?? rec.selectedProcessor} (${rec.proposedParamsSummary})`,
        res.chain,
        { findingId: findingMap[rec.id] },
      );
      setDirectorPlan((prev) =>
        prev
          ? {
              ...prev,
              recommendations: prev.recommendations.map((r) =>
                r.id === rec.id ? { ...r, applied: true } : r,
              ),
            }
          : prev,
      );
      setStatusNotice(`Applied recommendation: ${rec.pluginName ?? rec.selectedProcessor}. Reanalyzing resulting audio...`);
    },
    [chain, updateChainWithHistory, recordCorrection],
  );

  const handleAcceptAiChain = useCallback(() => {
    if (directorReport?.finalChain && directorReport.finalChain.length > 0) {
      updateChainWithHistory(structuredClone(directorReport.finalChain));
    }
    setAiChainAccepted(true);
    setStatusNotice('Accepted AI-optimized mastering chain in Mastering Rack.');
  }, [directorReport, updateChainWithHistory]);

  const handleRestorePreAiChain = useCallback(() => {
    if (!preAiChainSnapshot) return;
    updateChainWithHistory(structuredClone(preAiChainSnapshot));
    setAiChainAccepted(false);
    switchAuditionTarget('mastered', 0);
    setStatusNotice('Restored previous mastering chain from before CHAIN WITH AI run.');
  }, [preAiChainSnapshot, updateChainWithHistory, switchAuditionTarget]);

  const handleRunMasterDirector = useCallback(async (forceAutonomous = false) => {
    const runOperatingMode: DirectorOperatingMode = forceAutonomous ? 'autonomous' : operatingMode;
    let src = getRenderSource();
    if (!src || !activeTrack || directorRunningRef.current) return;

    const runId = ++directorRunIdRef.current;
    const sourceTrackId = activeTrack.id;
    const sourceReferenceTrackId = referenceTrack?.id ?? null;
    const diagnosticCreatedAt = Date.now();
    const diagnosticRunId = `fix-all-${sourceTrackId}-${diagnosticCreatedAt}`;
    const isStale = () =>
      directorRunIdRef.current !== runId ||
      activeTrackIdRef.current !== sourceTrackId ||
      referenceTrackIdRef.current !== sourceReferenceTrackId;
    const releaseCurrentRun = () => {
      if (directorRunIdRef.current === runId) {
        directorRunningRef.current = false;
        directorPauseRef.current = false;
        setDirectorRunning(false);
        setDirectorPaused(false);
        const stoppedByUser = directorStopRef.current;
        setAiLifecycleState(stoppedByUser ? 'Stopped' : 'Ready');
        setDirectorStage(stoppedByUser ? 'Stopped' : 'Ready');
        setStatusNotice(
          stoppedByUser
            ? 'Vocal stem preparation was stopped; no vocal correction was applied.'
            : 'Vocal stem preparation was cancelled because the source or reference changed.',
        );
      }
    };
    let vocalBalanceVerification: VocalBalanceVerification | undefined;

    directorRunningRef.current = true;
    setAiError(null);
    setAiNotice(null);
    setAiFallbackBanner(null);
    setAiChainAccepted(null);
    const preRunChain = structuredClone(chain);
    setPreAiChainSnapshot(preRunChain);
    setDirectorRunning(true);
    setDiagnosticArchiveStatus('saving');
    setDirectorPaused(false);
    directorPauseRef.current = false;
    directorStopRef.current = false;
    setDirectorActivityLog([]);
    setDirectorCheckpoints([]);
    setAiLifecycleState('Analyzing');
    setDirectorStage('Analyzing');
    setDirectorPass(0);

    if (requiresVocalBalancePreparation(objectiveId)) {
      const cacheKey = `${sourceTrackId}:${sourceReferenceTrackId ?? 'no-reference'}`;
      const currentOverride = vocalSourceOverrideRef.current;
      const currentReferenceChannels = referenceChannelsRef.current;
      if (
        currentOverride &&
        currentOverride.trackId === sourceTrackId &&
        currentOverride.referenceTrackId === sourceReferenceTrackId
      ) {
        vocalBalanceVerification = currentOverride.verification;
        src = currentOverride.channels;
      } else {
        setDirectorStage('Preparing vocal stems');
        setStatusNotice('Preparing source and reference vocal stems for measured vocal-balance correction…');
        let controller: AbortController | null = null;
        const preparation = getOrCreateVocalBalancePreparation(
          vocalPreparationCacheRef.current,
          cacheKey,
          () => {
            controller = new AbortController();
            vocalPreparationAbortRef.current = controller;
            return prepareVocalBalanceAgainstReference({
              source: {
                channels: sourceChannelsRef.current ?? [],
                sampleRate: activeTrack.sampleRate,
                durationSec: activeTrack.durationSec,
                fileSizeBytes: activeTrack.fileSizeBytes,
              },
              reference: referenceTrack && currentReferenceChannels
                ? {
                    channels: currentReferenceChannels,
                    sampleRate: referenceTrack.sampleRate,
                    durationSec: referenceTrack.durationSec,
                    fileSizeBytes: referenceTrack.fileSizeBytes,
                  }
                : null,
              signal: controller.signal,
              onProgress: (label, progress) => {
                if (!isStale()) {
                  setStatusNotice(
                    `${label === 'source' ? 'Source' : 'Reference'} vocal separation: ${progress.stage} (${Math.round(progress.progress * 100)}%).`,
                  );
                }
              },
            });
          },
        );
        try {
          const result = await preparation;
          if (isStale()) {
            releaseCurrentRun();
            return;
          }
          vocalBalanceVerification = result.verification;
          if (result.channels && result.verification.status === 'verified' && referenceTrack && sourceReferenceTrackId) {
            src = result.channels;
            vocalSourceOverrideRef.current = {
              trackId: sourceTrackId,
              referenceTrackId: sourceReferenceTrackId,
              revision: sourceRenderRevision + 1,
              channels: result.channels,
              verification: result.verification,
            };
            setSourceRenderRevision((revision) => revision + 1);
          } else if (result.verification.status === 'verified') {
            vocalBalanceVerification = {
              ...result.verification,
              status: 'unverified',
              summary: 'The reference track became unavailable before the verified vocal correction could be installed.',
            };
            vocalPreparationCacheRef.current.delete(cacheKey);
            setStatusNotice(vocalBalanceVerification.summary);
          } else if (result.verification.status === 'unverified' || result.verification.status === 'unresolved') {
            setStatusNotice(`Vocal correction not applied: ${result.verification.summary}`);
          }
          if (
            result.verification.status === 'unverified' ||
            result.verification.status === 'unresolved'
          ) {
            vocalPreparationCacheRef.current.delete(cacheKey);
          }
        } catch (error) {
          if (isStale() || (error instanceof DOMException && error.name === 'AbortError')) {
            releaseCurrentRun();
            return;
          }
          const detail = error instanceof Error ? error.message : 'Unknown stem-separation failure.';
          vocalBalanceVerification = {
            status: 'unverified',
            sourceBalanceDb: null,
            referenceBalanceDb: null,
            postRenderBalanceDb: null,
            appliedGainDb: 0,
            summary: `Vocal correction could not be verified: ${detail}`,
          };
          vocalPreparationCacheRef.current.delete(cacheKey);
          setStatusNotice(vocalBalanceVerification.summary);
        } finally {
          if (controller && vocalPreparationAbortRef.current === controller) {
            vocalPreparationAbortRef.current = null;
          }
        }
      }
    }

    if (isStale()) {
      releaseCurrentRun();
      return;
    }
    const runSourceAnalysis =
      src === sourceChannelsRef.current ? activeTrack.analysis : analyzeAudioBuffer(src, activeTrack.sampleRate);
    const plan = buildExplainableMasterPlan({
      analysis: runSourceAnalysis,
      objectiveId,
      customSpec: customObjective,
      referenceAnalysis: referenceTrack?.analysis ?? null,
      matchEqProfile: referenceTrack ? matchEqStore.getProfile() : null,
      externalPlugins: hostSnapshot.plugins,
      hostConnected: hostSnapshot.status === 'connected',
    });
    if (isStale()) return;
    setDirectorPlan(plan);
    setAiStrategy(plan.strategy);

    // Vocal Rebalance: AI may use it (and the local Director may add a small vocal move) only
    // when stems are already cached for this track; every proposal passes the policy gate.
    // Loaded on demand (keeps the initial bundle in budget).
    const { gateVocalRebalanceChain, measureVocalBalance, planLocalVocalRebalance, vocalBalanceRange } =
      await import('./director/vocalRebalancePolicy');
    if (isStale()) return;
    const rebalanceStemSet = getActiveRebalanceStems();
    let vocalBalance: VocalBalanceContext = {
      stemsCached: Boolean(rebalanceStemSet),
      measurement: rebalanceStemSet ? measureVocalBalance(rebalanceStemSet, src[0], src[1] ?? src[0]) : null,
      range: vocalBalanceRange(objectiveId),
    };
    const rebalanceNotes: string[] = [];
    const gateRebalance = (proposed: ProcessorModule[]): ProcessorModule[] => {
      const gated = gateVocalRebalanceChain(proposed, vocalBalance);
      rebalanceNotes.push(...gated.notes);
      return gated.chain;
    };

    // Optional cloud AI (active provider; built-in Gemini by default) initial strategy in Autonomous/Assisted when user opted in
    const aiProviderLog: string[] = [];
    const aiProviderUsed = describeProvider(getActiveProviderConfig());
    let geminiInitialChain: ProcessorModule[] | undefined;

    // The local diagnosis can warrant stem-level balance correction even when cloud AI
    // reasoning is disabled. Vocal-focused mastering or an explicit vocal-level finding
    // is sufficient; mere midrange energy is not treated as proof of a vocal.
    const diagnosisRequestsVocalBalance = objectiveId === 'vocal-focused' || plan.diagnosis.findings.some((finding) =>
      /vocal.*(balance|level|quiet|loud|buried|forward)|(?:balance|level).*(vocal|lead)/i.test(
        `${finding.title} ${finding.explanation} ${finding.recommendedAction ?? ''}`,
      ),
    );
    if (diagnosisRequestsVocalBalance && !vocalBalance.stemsCached) {
      aiProviderLog.push('Vocal Rebalance: the local diagnosis warrants stem-level vocal balance analysis; starting resource-gated separation.');
      try {
        await separateActiveRebalanceStems();
      } catch (separationError) {
        aiProviderLog.push(`Vocal Rebalance: automatic stem separation failed: ${separationError instanceof Error ? separationError.message : 'unknown separation error'}.`);
      }
      if (isStale()) return;
      const separatedStems = getActiveRebalanceStems();
      if (separatedStems) {
        vocalBalance = {
          stemsCached: true,
          measurement: measureVocalBalance(separatedStems, src[0], src[1] ?? src[0]),
          range: vocalBalanceRange(objectiveId),
        };
        aiProviderLog.push('Vocal Rebalance: stem analysis is ready; local and AI proposals will be gated against measured vocal balance.');
      } else {
        const separationState = getRebalanceStemState();
        aiProviderLog.push(`Vocal Rebalance unavailable: ${separationState.error ?? separationState.assessment?.message ?? 'stem separation did not produce usable stems'}; no vocal correction will be claimed.`);
      }
    }
    let initialAiTrace: AiPassTrace | undefined =
      !useGeminiCloud && runOperatingMode !== 'manual'
        ? {
            pass: 0,
            stage: 'strategy',
            source: 'local-dsp-planner',
            fallbackReason: 'user-disabled',
            fallbackDetail: 'Cloud AI is turned off',
            modelName: null,
            responseTimeMs: null,
            promptChars: null,
            timeoutHit: null,
            aiReturnedModules: [],
            finalRenderedModules: [],
          }
        : undefined;

    if (useGeminiCloud && runOperatingMode !== 'manual') {
      setAiLoading(true);
      setAiLifecycleState('Planning');
      setDirectorStage('AI is thinking…');
      const pluginSummary = inspectPluginInventory(
        hostSnapshot.plugins,
        hostSnapshot.status === 'connected',
        runSourceAnalysis,
        plan.objective,
      );
      const strategyInput = {
        analysis: runSourceAnalysis,
        mode,
        objective: objectiveId,
        customObjective,
        operatingMode: runOperatingMode,
        targetLufs: plan.objective.targetLufs,
        referenceAnalysis: referenceTrack?.analysis ?? null,
        vocalBalanceVerification,
        availablePlugins: pluginSummary.matches.map((m) => ({
          name: m.name,
          role: m.role,
          manufacturer: m.manufacturer,
        })),
        // Only sent when stems are cached, so prompts for tracks without stems are unchanged.
        ...(vocalBalance.stemsCached ? { vocalBalance } : {}),
      };
      const strategyPromptChars = SYSTEM_PROMPT.length + buildStrategyUserPrompt(strategyInput).length;
      const builtinStrategyAttempt: {
        current: {
          modelName: string | null;
          responseTimeMs: number | null;
          promptChars: number;
          aiReturnedModules: ProcessorType[];
          timedOut: boolean;
        } | null;
      } = { current: null };
      try {
        // Built-in Gemini (default): client timeout (CLOUD_AI_TIMEOUT_MS) exceeds the server's Gemini timeout,
        // and clicking Stop cancels the active request immediately.
        const builtinStrategy = async (cancelSignal?: AbortSignal) => {
          const startedMs = performance.now();
          let timedOut = false;
          builtinStrategyAttempt.current = {
            modelName: 'gemini-4-hydrogen',
            responseTimeMs: null,
            promptChars: strategyPromptChars,
            aiReturnedModules: [],
            timedOut: false,
          };
          assertCloudAiAvailable();
          const headers = { 'Content-Type': 'application/json', ...await getBuiltinAccessHeaders() };
          if (cancelSignal?.aborted || directorStopRef.current) {
            throw new DOMException('Cancelled.', 'AbortError');
          }
          const req = createCloudAiRequestSignal(CLOUD_AI_TIMEOUT_MS, cancelSignal);
          try {
            const res = await fetch('/api/ai/master', {
              method: 'POST',
              headers,
              signal: req.signal,
              body: JSON.stringify(strategyInput),
            });
            const data = await readBuiltinAiResponse(res);
            const meta = (data.meta ?? null) as {
              modelName?: string;
              responseTimeMs?: number;
              promptChars?: number;
              aiReturnedModules?: string[];
            } | null;
            builtinStrategyAttempt.current = {
              modelName: typeof meta?.modelName === 'string' ? meta.modelName : 'gemini-4-hydrogen',
              responseTimeMs: typeof meta?.responseTimeMs === 'number'
                ? meta.responseTimeMs
                : Math.max(0, Math.round(performance.now() - startedMs)),
              promptChars: typeof meta?.promptChars === 'number' ? meta.promptChars : strategyPromptChars,
              aiReturnedModules: Array.isArray(meta?.aiReturnedModules)
                ? (meta.aiReturnedModules.filter(Boolean) as ProcessorType[])
                : [],
              timedOut: false,
            };
            return data.strategy;
          } finally {
            timedOut = req.timedOut();
            if (builtinStrategyAttempt.current) {
              builtinStrategyAttempt.current.timedOut = timedOut;
              if (builtinStrategyAttempt.current.responseTimeMs === null) {
                builtinStrategyAttempt.current.responseTimeMs = Math.max(0, Math.round(performance.now() - startedMs));
              }
            }
            req.cleanup();
          }
        };
        const providerRun = await runProviderCall('strategy', (opts) =>
          requestStrategy(getActiveProviderConfig(), strategyInput, () => builtinStrategy(opts.signal), opts),
        );
        if (isStale()) return;
        aiProviderLog.push(...providerRun.notices.map((n) => `Plan: ${n}`));
        if (providerRun.producedBy) aiProviderLog.push(`Plan: initial strategy produced by ${providerRun.producedBy}.`);
        if (!providerRun.result) {
          if (providerRun.cancelled || directorStopRef.current) {
            setDirectorStage('Stopped');
            setAiLifecycleState('Stopped');
            setStatusNotice('Stopped by engineer during AI planning.');
            return;
          }
          throw new Error(providerRun.notices[0] ?? 'AI strategy skipped.');
        }
        const strat = providerRun.result as unknown as AIMasteringStrategy;
        // If the AI diagnosis explicitly selects Vocal Rebalance, create the missing source
        // stems now rather than silently dropping the requested processor. Separation is
        // resource-gated by the stem store and only runs for this warranted case.
        const aiRequestsVocalBalance = Array.isArray(strat.chain) && strat.chain.some((m) => m.type === 'vocal-rebalance') || (strat.issuesDetected ?? []).some((issue) => /vocal.*(balance|level|quiet|loud|buried|forward)|(?:balance|level).*(vocal|lead)/i.test(issue));
        if (aiRequestsVocalBalance && !vocalBalance.stemsCached) {
          aiProviderLog.push('Vocal Rebalance: AI selected stem-level vocal correction; starting automatic stem separation.');
          try {
            await separateActiveRebalanceStems();
          } catch (separationError) {
            aiProviderLog.push(`Vocal Rebalance: automatic stem separation failed: ${separationError instanceof Error ? separationError.message : 'unknown separation error'}.`);
          }
          if (isStale()) return;
          const separatedStems = getActiveRebalanceStems();
          if (separatedStems) {
            vocalBalance = {
              stemsCached: true,
              measurement: measureVocalBalance(separatedStems, src[0], src[1] ?? src[0]),
              range: vocalBalanceRange(objectiveId),
            };
            aiProviderLog.push('Vocal Rebalance: stems are ready; the proposed correction will be checked against measured vocal balance.');
          } else {
            const separationState = getRebalanceStemState();
            aiProviderLog.push(`Vocal Rebalance unavailable: ${separationState.error ?? separationState.assessment?.message ?? 'stem separation did not produce usable stems'}; the vocal processor will be withheld.`);
          }
        }
        const usedBuiltin = providerRun.producedBy === BUILTIN_LABEL;
        const resolvedModel = usedBuiltin
          ? (builtinStrategyAttempt.current?.modelName ?? 'gemini-4-hydrogen')
          : (providerRun.meta?.modelName ?? aiProviderUsed.model);
        const resolvedTimeMs = usedBuiltin
          ? (builtinStrategyAttempt.current?.responseTimeMs ?? providerRun.meta?.responseTimeMs ?? null)
          : (providerRun.meta?.responseTimeMs ?? null);
        const resolvedPromptChars = usedBuiltin
          ? (builtinStrategyAttempt.current?.promptChars ?? providerRun.meta?.promptChars ?? strategyPromptChars)
          : (providerRun.meta?.promptChars ?? strategyPromptChars);
        const rawReturnedModules: ProcessorType[] = usedBuiltin && (builtinStrategyAttempt.current?.aiReturnedModules.length ?? 0) > 0
          ? builtinStrategyAttempt.current!.aiReturnedModules
          : ((providerRun.meta?.aiReturnedModules.length ?? 0) > 0
            ? providerRun.meta!.aiReturnedModules
            : (strat.chain ?? []).map((m) => m.type));

        const invCheck = validateChainAgainstInventory(strat.chain);
        if (invCheck.valid && invCheck.sanitizedChain.length > 0) {
          strat.chain = gateRebalance(invCheck.sanitizedChain);
          geminiInitialChain = strat.chain;
          setAiStrategy(strat);
          initialAiTrace = {
            pass: 0,
            stage: 'strategy',
            source: usedBuiltin ? 'gemini-cloud' : 'byo-provider',
            fallbackReason: null,
            ...(providerRun.fellBack && providerRun.notices[0] ? { fallbackDetail: providerRun.notices[0] } : {}),
            modelName: resolvedModel,
            responseTimeMs: resolvedTimeMs,
            promptChars: resolvedPromptChars,
            timeoutHit: null,
            aiReturnedModules: rawReturnedModules,
            finalRenderedModules: strat.chain.map((m) => m.type),
          };
        } else {
          const reasonDetail = invCheck.errors[0] ?? 'empty chain';
          setAiError(
            `Cloud AI response failed inventory validation (${reasonDetail}); using local DSP planner.`,
          );
          initialAiTrace = {
            pass: 0,
            stage: 'strategy',
            source: 'local-dsp-planner',
            fallbackReason: 'validation',
            fallbackDetail: reasonDetail,
            modelName: resolvedModel,
            responseTimeMs: resolvedTimeMs,
            promptChars: resolvedPromptChars,
            timeoutHit: null,
            aiReturnedModules: rawReturnedModules,
            finalRenderedModules: [],
          };
        }
      } catch (err) {
        if (!isStale()) {
          if (directorStopRef.current) {
            setDirectorStage('Stopped');
            setAiLifecycleState('Stopped');
            setStatusNotice('Stopped by engineer during AI planning.');
            return;
          }
          const classified = classifyBuiltinAiError(err, builtinStrategyAttempt.current?.timedOut ?? false);
          initialAiTrace = {
            pass: 0,
            stage: 'strategy',
            source: 'local-dsp-planner',
            fallbackReason: classified.fallbackReason,
            fallbackDetail: classified.fallbackDetail,
            modelName: builtinStrategyAttempt.current?.modelName ?? null,
            responseTimeMs: builtinStrategyAttempt.current?.responseTimeMs ?? null,
            promptChars: builtinStrategyAttempt.current?.promptChars ?? strategyPromptChars,
            timeoutHit: classified.timeoutHit,
            timeoutMs: classified.timeoutMs,
            aiReturnedModules: [],
            finalRenderedModules: [],
          };
          if (err instanceof CloudAiRateLimitError) {
            // Not an error for the user: the run continues on the local DSP planner.
            const notice = friendlyCloudAiLimitNotice(err);
            setAiNotice(notice);
            aiProviderLog.push(`Plan: ${notice}`);
          } else {
            setAiError(err instanceof Error ? err.message : 'Cloud Gemini request failed');
          }
        }
      } finally {
        if (!isStale()) setAiLoading(false);
      }
      if (directorStopRef.current && !isStale()) {
        setDirectorStage('Stopped');
        setAiLifecycleState('Stopped');
        setStatusNotice('Stopped by engineer during AI planning.');
        return;
      }
    }

    if (initialAiTrace?.fallbackReason && !isStale()) {
      const banner = summarizeAiFallbackBanner([initialAiTrace]);
      if (banner) setAiFallbackBanner(banner);
    }

    // Local Director: a conservative vocal-only move when stems are cached and the measured
    // balance is clearly outside the objective range (never used when the AI planned the chain).
    const aiAlreadyRebalancesVocals = Boolean(geminiInitialChain?.some((m) => m.type === 'vocal-rebalance'));
    const localRebalance = !aiAlreadyRebalancesVocals && runOperatingMode !== 'assisted' ? planLocalVocalRebalance(vocalBalance) : null;
    const leadModules = localRebalance
      ? gateRebalance([createProcessorModule('vocal-rebalance', { params: localRebalance })]).filter((m) => m.type === 'vocal-rebalance')
      : [];
    if (localRebalance && leadModules.length > 0) {
      aiProviderLog.push(`Vocal Rebalance: measured vocal-to-music ${vocalBalance.measurement?.vocalToMusicDb} dB vs range ${vocalBalance.range.low}..${vocalBalance.range.high} dB; local Director proposes ${localRebalance.vocalGainDb > 0 ? '+' : ''}${localRebalance.vocalGainDb} dB on the vocal stem.`);
    }
    aiProviderLog.push(...rebalanceNotes.splice(0));

    if (aiProviderLog.length > 0 && !isStale()) {
      const planEntries: DirectorActivityEntry[] = aiProviderLog.map((message, idx) => ({
        id: `act-ai-provider-${Date.now()}-${idx}`,
        timestamp: Date.now(),
        passNumber: 0,
        phase: 'plan',
        kind: /fail|cancel|skipp/i.test(message) ? 'warning' : 'observation',
        message,
      }));
      setDirectorActivityLog((prev) => [...prev, ...planEntries]);
    }

    let tempWorkspace: Awaited<ReturnType<typeof createTemporaryMasteringWorkspace>> | null = null;
    let tempWriteQueue: Promise<void> = Promise.resolve();
    const runActivityLog: DirectorActivityEntry[] = [];
    const runCheckpoints: DirectorCheckpoint[] = [];
    const writeTempNote = (relativePath: string, value: unknown) => {
      if (!tempWorkspace) return;
      tempWriteQueue = tempWriteQueue
        .then(async () => { if (tempWorkspace) await tempWorkspace.writeJson(relativePath, value); })
        .catch(() => undefined);
    };
    try {
      tempWorkspace = await createTemporaryMasteringWorkspace(diagnosticRunId);
      writeTempNote('session.json', {
        trackId: sourceTrackId,
        trackName: activeTrack.name,
        createdAt: new Date(diagnosticCreatedAt).toISOString(),
        objectiveId,
        operatingMode: runOperatingMode,
        scratchStorage: tempWorkspace.storage,
      });
      writeTempNote('baseline/analysis.json', runSourceAnalysis);
      writeTempNote('baseline/diagnosis.json', plan.diagnosis);
      writeTempNote('proposed/initial-chain.json', geminiInitialChain ?? plan.chain);
    } catch {
      tempWorkspace = null;
    }

    try {
      const report = await runAutonomousDirectorLoop({
        sourceChannels: src,
        sampleRate: activeTrack.sampleRate,
        operatingMode: runOperatingMode,
        objectiveId,
        mode,
        customSpec: customObjective,
        qcProfile: activeQcProfile,
        exportConfig,
        referenceAnalysis: referenceTrack?.analysis ?? null,
        verificationBaselineAnalysis: runSourceAnalysis,
        verificationBaselineDiagnosis: plan.diagnosis,
        vocalBalanceVerification,
        matchEqReference: referenceTrack && matchEqStore.getSnapshot().reference
          ? { spectra: matchEqStore.getSnapshot().reference!, name: referenceTrack.name }
          : null,
        externalPlugins: hostSnapshot.plugins,
        hostConnected: hostSnapshot.status === 'connected',
        initialChain: geminiInitialChain ?? (runOperatingMode === 'assisted' ? chain : undefined),
        leadModules,
        externalProcessor: processExternalStage,
        postFades: getPostFades(),
        initialAiTrace,
        maxIterations: forceAutonomous ? 10 : maxIterations,
        maxCpuBudgetMs: forceAutonomous ? 120_000 : 60_000,
        convergenceThreshold,
        isPaused: () => directorPauseRef.current,
        shouldStop: () => directorStopRef.current || isStale(),
        aiRefineCallback:
          useGeminiCloud && runOperatingMode === 'autonomous'
            ? async (ctx) => {
                const refineCtx = {
                  ...ctx,
                  objective: ctx.objective ?? objectiveId,
                  mode: ctx.mode ?? mode,
                  ...(vocalBalance.stemsCached ? { vocalBalance } : {}),
                  ...(vocalBalanceVerification ? { vocalBalanceVerification } : {}),
                };
                const refinePromptChars = SYSTEM_PROMPT.length + buildRefineUserPrompt(refineCtx).length;
                const builtinRefineAttempt: {
                  current: {
                    modelName: string | null;
                    responseTimeMs: number | null;
                    promptChars: number;
                    aiReturnedModules: ProcessorType[];
                    timedOut: boolean;
                  } | null;
                } = { current: null };
                if (!isStale()) {
                  setAiLoading(true);
                  setDirectorStage('AI is thinking…');
                }
                const builtinRefine = async (cancelSignal?: AbortSignal) => {
                  const startedMs = performance.now();
                  builtinRefineAttempt.current = {
                    modelName: 'gemini-4-hydrogen',
                    responseTimeMs: null,
                    promptChars: refinePromptChars,
                    aiReturnedModules: [],
                    timedOut: false,
                  };
                  assertCloudAiAvailable();
                  const headers = { 'Content-Type': 'application/json', ...await getBuiltinAccessHeaders() };
                  if (cancelSignal?.aborted || directorStopRef.current) {
                    throw new DOMException('Cancelled.', 'AbortError');
                  }
                  const req = createCloudAiRequestSignal(CLOUD_AI_TIMEOUT_MS, cancelSignal);
                  try {
                    const res = await fetch('/api/ai/refine', {
                      method: 'POST',
                      headers,
                      signal: req.signal,
                      body: JSON.stringify(refineCtx),
                    });
                    const data = await readBuiltinAiResponse(res);
                    const meta = (data.meta ?? null) as {
                      modelName?: string;
                      responseTimeMs?: number;
                      promptChars?: number;
                      aiReturnedModules?: string[];
                    } | null;
                    builtinRefineAttempt.current = {
                      modelName: typeof meta?.modelName === 'string' ? meta.modelName : 'gemini-4-hydrogen',
                      responseTimeMs: typeof meta?.responseTimeMs === 'number'
                        ? meta.responseTimeMs
                        : Math.max(0, Math.round(performance.now() - startedMs)),
                      promptChars: typeof meta?.promptChars === 'number' ? meta.promptChars : refinePromptChars,
                      aiReturnedModules: Array.isArray(meta?.aiReturnedModules)
                        ? (meta.aiReturnedModules.filter(Boolean) as ProcessorType[])
                        : [],
                      timedOut: false,
                    };
                    return data.refined;
                  } finally {
                    const didTimeOut = req.timedOut();
                    if (builtinRefineAttempt.current) {
                      builtinRefineAttempt.current.timedOut = didTimeOut;
                      if (builtinRefineAttempt.current.responseTimeMs === null) {
                        builtinRefineAttempt.current.responseTimeMs = Math.max(0, Math.round(performance.now() - startedMs));
                      }
                    }
                    req.cleanup();
                  }
                };
                let run: Awaited<ReturnType<typeof requestRefine>>;
                try {
                  run = await runProviderCall('refine', (opts) =>
                    requestRefine(getActiveProviderConfig(), refineCtx, () => builtinRefine(opts.signal), opts),
                  );
                } catch (err) {
                  if (directorStopRef.current || isStale()) {
                    return { chain: null, producedBy: null, notices: [] };
                  }
                  const classified = classifyBuiltinAiError(err, builtinRefineAttempt.current?.timedOut ?? false);
                  const notice = err instanceof CloudAiRateLimitError
                    ? friendlyCloudAiLimitNotice(err)
                    : classified.fallbackDetail;
                  if (err instanceof CloudAiRateLimitError) {
                    setAiNotice(notice);
                  }
                  const refineFallbackBanner = summarizeAiFallbackBanner([{
                    pass: 1,
                    stage: 'refine',
                    source: 'deterministic-director',
                    fallbackReason: classified.fallbackReason,
                    fallbackDetail: classified.fallbackDetail,
                    modelName: builtinRefineAttempt.current?.modelName ?? null,
                    responseTimeMs: builtinRefineAttempt.current?.responseTimeMs ?? null,
                    promptChars: builtinRefineAttempt.current?.promptChars ?? refinePromptChars,
                    timeoutHit: classified.timeoutHit,
                    timeoutMs: classified.timeoutMs,
                    aiReturnedModules: [],
                    finalRenderedModules: [],
                  }]);
                  if (refineFallbackBanner) {
                    setAiFallbackBanner((prev) => prev ?? refineFallbackBanner);
                  }
                  return {
                    chain: null,
                    producedBy: null,
                    notices: [notice],
                    trace: {
                      source: 'deterministic-director',
                      fallbackReason: classified.fallbackReason,
                      fallbackDetail: classified.fallbackDetail,
                      modelName: builtinRefineAttempt.current?.modelName ?? null,
                      responseTimeMs: builtinRefineAttempt.current?.responseTimeMs ?? null,
                      promptChars: builtinRefineAttempt.current?.promptChars ?? refinePromptChars,
                      timeoutHit: classified.timeoutHit,
                      timeoutMs: classified.timeoutMs,
                      aiReturnedModules: [],
                    },
                  };
                } finally {
                  if (!isStale()) setAiLoading(false);
                }
                aiProviderLog.push(...run.notices.map((n) => `Refine: ${n}`));
                if (run.producedBy) aiProviderLog.push(`Refine: suggestion produced by ${run.producedBy}.`);
                const refinedChain = run.result?.chain ? gateRebalance(run.result.chain) : null;
                const gateNotices = rebalanceNotes.splice(0);
                const usedBuiltin = run.producedBy === BUILTIN_LABEL;
                const resolvedModel = usedBuiltin
                  ? (builtinRefineAttempt.current?.modelName ?? 'gemini-4-hydrogen')
                  : (run.meta?.modelName ?? aiProviderUsed.model);
                const resolvedTimeMs = usedBuiltin
                  ? (builtinRefineAttempt.current?.responseTimeMs ?? run.meta?.responseTimeMs ?? null)
                  : (run.meta?.responseTimeMs ?? null);
                const resolvedPromptChars = usedBuiltin
                  ? (builtinRefineAttempt.current?.promptChars ?? run.meta?.promptChars ?? refinePromptChars)
                  : (run.meta?.promptChars ?? refinePromptChars);
                const rawReturnedModules: ProcessorType[] = usedBuiltin && (builtinRefineAttempt.current?.aiReturnedModules.length ?? 0) > 0
                  ? builtinRefineAttempt.current!.aiReturnedModules
                  : ((run.meta?.aiReturnedModules.length ?? 0) > 0
                    ? run.meta!.aiReturnedModules
                    : (run.result?.chain ?? []).map((m) => m.type));
                return {
                  chain: refinedChain,
                  producedBy: run.producedBy,
                  notices: [...run.notices, ...gateNotices],
                  trace: {
                    source: usedBuiltin ? 'gemini-cloud' : 'byo-provider',
                    fallbackReason: null,
                    ...(run.fellBack && run.notices[0] ? { fallbackDetail: run.notices[0] } : {}),
                    modelName: resolvedModel,
                    responseTimeMs: resolvedTimeMs,
                    promptChars: resolvedPromptChars,
                    timeoutHit: null,
                    aiReturnedModules: rawReturnedModules,
                  },
                };
              }
            : undefined,
        onProgress: (upd) => {
          if (isStale()) return;
          if (upd.lifecycle) setAiLifecycleState(upd.lifecycle);
          setDirectorStage(upd.stage);
          setDirectorPass(upd.passNumber);
          if (upd.activityEntry) {
            runActivityLog.push(upd.activityEntry);
            setDirectorActivityLog((prev) => [...prev, upd.activityEntry!]);
            writeTempNote('activity/' + String(upd.activityEntry.timestamp) + '-' + upd.activityEntry.id + '.json', upd.activityEntry);
          }
          if (upd.checkpoint) {
            runCheckpoints.push(upd.checkpoint);
            setDirectorCheckpoints((prev) => [...prev, upd.checkpoint!]);
            writeTempNote('passes/pass-' + String(upd.checkpoint.passNumber).padStart(2, '0') + '.json', upd.checkpoint);
          }
        },
      });

      if (isStale()) return;
      if (vocalBalanceVerification) report.vocalBalanceVerification = vocalBalanceVerification;

      writeTempNote('final/verification.json', {
        status: report.status,
        stopReason: report.stopReason,
        bestPassNumber: report.bestPassNumber,
        iterationsExecuted: report.iterationsExecuted,
        preAnalysis: report.preAnalysis,
        postAnalysis: report.postAnalysis,
        qualityControl: report.qcReport,
        postFixVerification: report.postFixVerification,
        vocalBalanceVerification: report.vocalBalanceVerification,
      });
      writeTempNote('final/report.json', report);

      const diagnosticSummary: MasteringDiagnosticRunSummary = {
        runId: tempWorkspace?.runId ?? diagnosticRunId,
        createdAt: diagnosticCreatedAt,
        trackName: activeTrack.name,
        objectiveId,
        operatingMode: runOperatingMode,
        status: report.status,
        storage: tempWorkspace?.storage ?? 'memory',
      };
      const diagnosticBundle: MasteringDiagnosticBundle = {
        schemaVersion: 1,
        summary: diagnosticSummary,
        session: {
          source: {
            trackId: sourceTrackId,
            trackName: activeTrack.name,
            sampleRate: activeTrack.sampleRate,
            baselineAnalysis: report.preAnalysis,
          },
          objective: report.objective,
          baselineDiagnosis: report.diagnosis,
          initialPlan: {
            chain: plan.chain,
            recommendations: plan.recommendations,
            strategy: plan.strategy,
            geminiInitialChain: geminiInitialChain ?? null,
          },
          finalChain: report.finalChain,
          checkpoints: report.checkpoints,
          activityLog: report.activityLog,
          qualityControl: report.qcReport,
          postFixVerification: report.postFixVerification,
          vocalBalanceVerification: report.vocalBalanceVerification,
          report,
          runConfiguration: {
            forceAutonomous,
            operatingMode: runOperatingMode,
            objectiveId,
            customObjective,
            maxIterations: forceAutonomous ? 10 : maxIterations,
            maxCpuBudgetMs: forceAutonomous ? 120_000 : 60_000,
            convergenceThreshold,
            exportConfig,
            useGeminiCloud,
            aiProvider: useGeminiCloud
              ? { ...aiProviderUsed, log: aiProviderLog, aiPasses: report.aiPasses ?? [], aiFallbackBanner: summarizeAiFallbackBanner(report.aiPasses) }
              : { log: aiProviderLog, aiPasses: report.aiPasses ?? [], aiFallbackBanner: summarizeAiFallbackBanner(report.aiPasses) },
            referenceAnalysis: referenceTrack?.analysis ?? null,
            externalPlugins: hostSnapshot.plugins,
          },
        },
      };
      setLatestDiagnosticRun(diagnosticSummary);
      setLatestDiagnosticBundle(diagnosticBundle);

      let diagnosticNotice = 'Diagnostic bundle is available for download.';
      try {
        await tempWriteQueue.catch(() => undefined);
        const archived = tempWorkspace
          ? await tempWorkspace.complete(diagnosticSummary, diagnosticBundle)
          : { persisted: false };
        if (archived.persisted) {
          setDiagnosticRuns(await listMasteringDiagnosticRuns());
          setDiagnosticArchiveStatus('saved');
          diagnosticNotice = 'Full diagnostic bundle saved locally.';
        } else {
          setDiagnosticArchiveStatus('session-only');
          diagnosticNotice = 'Diagnostic bundle is downloadable now, but persistent browser storage was unavailable.';
        }
      } catch {
        setDiagnosticArchiveStatus('failed');
        diagnosticNotice = 'Mastering finished, but the diagnostic archive could not be saved. Download the in-session bundle before leaving this page.';
      }

      const finalBanner = summarizeAiFallbackBanner(report.aiPasses);
      if (finalBanner) setAiFallbackBanner(finalBanner);
      setDirectorReport(report);
      setDirectorCheckpoints(report.checkpoints);
      setDirectorActivityLog(report.activityLog);
      setAiLifecycleState(report.status === 'stopped-by-user' ? 'Stopped' : 'Completed');

      if (runOperatingMode !== 'manual' && report.finalChain.length > 0) {
        // The delivered chain must be audible and re-measured exactly as the loop verified it.
        setChainBypassed(false);
        updateChainWithHistory(structuredClone(report.finalChain));
        setAiChangeBase({ before: preRunChain, after: structuredClone(report.finalChain) });
        recordCorrection(
          `CHAIN WITH AI (${report.objective.label} · Pass #${report.bestPassNumber})`,
          report.finalChain,
        );
      }

      const passHistory: IterationPass[] = report.checkpoints
        .filter((cp) => cp.passNumber > 0)
        .map((cp) => ({
          passNumber: cp.passNumber,
          label: cp.label,
          timestamp: cp.timestamp,
          chain: cp.chain,
          postAnalysis: cp.analysis,
          score: Math.round(cp.multiObjective.engineeringFitIndex),
          notes: `LUFS ${cp.analysis.integratedLufs.toFixed(1)} · TP ${cp.analysis.truePeakDb.toFixed(2)} dBTP · QC ${cp.qcReport.overallStatus.toUpperCase()}`,
          improvements: [],
          warnings: cp.multiObjective.limitingFactors,
        }));
      setIterations(passHistory);

      setStatusNotice(
        `${runOperatingMode === 'manual'
          ? 'Manual Mode: Explainable mastering plan generated without altering rack.'
          : `CHAIN WITH AI ${isMasterFullyVerified(report) ? 'PASSED' : 'NOT FULLY VERIFIED'}: Best Pass #${report.bestPassNumber} (${report.postAnalysis.integratedLufs.toFixed(1)} LUFS, QC ${report.qcReport.overallStatus.toUpperCase()}). ${report.stopReason}`} ${diagnosticNotice}`,
      );
    } catch (err) {
      const failureMessage = err instanceof Error ? err.message : 'Mastering Director execution failed';
      if (!isStale()) {
        setAiLifecycleState('Failed');
        setAiError(failureMessage);
      }
      if (tempWorkspace && !isStale()) {
        const failureSummary: MasteringDiagnosticRunSummary = {
          runId: tempWorkspace.runId,
          createdAt: diagnosticCreatedAt,
          trackName: activeTrack.name,
          objectiveId,
          operatingMode: runOperatingMode,
          status: 'failed',
          storage: tempWorkspace.storage,
        };
        const failureBundle: MasteringDiagnosticBundle = {
          schemaVersion: 1,
          summary: failureSummary,
          session: {
            source: {
              trackId: sourceTrackId,
              trackName: activeTrack.name,
              sampleRate: activeTrack.sampleRate,
              baselineAnalysis: runSourceAnalysis,
            },
            objectiveId,
            customObjective,
            baselineDiagnosis: plan.diagnosis,
            initialPlan: {
              chain: plan.chain,
              recommendations: plan.recommendations,
              strategy: plan.strategy,
              geminiInitialChain: geminiInitialChain ?? null,
            },
            activityLog: runActivityLog,
            checkpoints: runCheckpoints,
            error: failureMessage,
            runConfiguration: {
              operatingMode: runOperatingMode,
              maxIterations: forceAutonomous ? 10 : maxIterations,
              maxCpuBudgetMs: forceAutonomous ? 120_000 : 60_000,
              convergenceThreshold,
              exportConfig,
              useGeminiCloud,
            },
          },
        };
        setLatestDiagnosticRun(failureSummary);
        setLatestDiagnosticBundle(failureBundle);
        try {
          writeTempNote('final/error.json', { message: failureMessage, createdAt: diagnosticCreatedAt });
          await tempWriteQueue.catch(() => undefined);
          const archived = await tempWorkspace.complete(failureSummary, failureBundle);
          if (archived.persisted) {
            setDiagnosticRuns(await listMasteringDiagnosticRuns());
            setDiagnosticArchiveStatus('saved');
          } else {
            setDiagnosticArchiveStatus('session-only');
          }
        } catch {
          setDiagnosticArchiveStatus('failed');
        }
      } else if (!isStale()) {
        setDiagnosticArchiveStatus('session-only');
      }
    } finally {
      await tempWriteQueue.catch(() => undefined);
      if (directorRunIdRef.current === runId) {
        directorRunningRef.current = false;
        setDirectorRunning(false);
        setDirectorPaused(false);
        directorPauseRef.current = false;
      }
    }
  }, [
    activeTrack,
    getRenderSource,
    sourceRenderRevision,
    chain,
    objectiveId,
    customObjective,
    referenceTrack,
    hostSnapshot.plugins,
    hostSnapshot.status,
    useGeminiCloud,
    operatingMode,
    mode,
    activeQcProfile,
    exportConfig,
    processExternalStage,
    maxIterations,
    convergenceThreshold,
    updateChainWithHistory,
    recordCorrection,
  ]);


  const handleDownloadDiagnosticRun = useCallback(async (runId: string) => {
    try {
      const bundle =
        latestDiagnosticBundle?.summary.runId === runId
          ? latestDiagnosticBundle
          : await loadMasteringDiagnosticBundle(runId);
      if (!bundle) {
        setStatusNotice('The selected diagnostic archive is unavailable in this browser storage.');
        return;
      }
      const safeTrackName = bundle.summary.trackName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60) || 'Track';
      const timestamp = new Date(bundle.summary.createdAt).toISOString().replace(/[:.]/g, '-');
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = `SYN-MASTER-${safeTrackName}-${timestamp}-DIAGNOSTICS.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (error) {
      setStatusNotice(error instanceof Error ? error.message : 'Could not export the mastering diagnostic bundle.');
    }
  }, [latestDiagnosticBundle]);

  const handleGenerateBattle = useCallback(async () => {
    const src = getRenderSource();
    const track = activeTrack;
    if (!src || !track) return;
    setBattleGenerating(true);

    try {
      const specs = buildBattleCandidatesIntelligent(track.analysis);
      const built: BattleCandidate[] = [];
      for (const s of specs) {
        const res = await renderAndAnalyzeOffThread({
          sourceChannels: src,
          sampleRate: track.sampleRate,
          chain: s.chain,
          postFades: getPostFades(),
        });
        if (activeTrackIdRef.current !== track.id) return;
        engineRef.current!.setOverrideBuffer(`candidate-${s.id.toLowerCase()}`, res.channels, track.sampleRate);
        built.push({
          id: s.id,
          blindLabel: `Candidate ${s.id}`,
          title: s.title,
          philosophy: s.philosophy,
          chain: s.chain,
          postAnalysis: res.analysis,
          loudnessTrimDb: Number((-14.0 - res.analysis.integratedLufs).toFixed(2)),
        });
      }

      setBattleCandidates(built);
      setStatusNotice('Generated 3 objective-calibrated Battle Mode masters ready for blind A/B/C auditioning.');
    } catch (err) {
      setStatusNotice(err instanceof Error ? err.message : 'Battle candidate generation failed.');
    } finally {
      setBattleGenerating(false);
    }
  }, [activeTrack]);

  const handleMatchReference = () => {
    if (!activeTrack || !referenceTrack) return;
    const plan = buildExplainableMasterPlan({
      analysis: activeTrack.analysis,
      objectiveId: 'custom',
      customSpec: {
        ...customObjective,
        targetLufs: Math.max(-18, Math.min(-8, referenceTrack.analysis.integratedLufs)),
      },
      referenceAnalysis: referenceTrack.analysis,
      matchEqProfile: matchEqStore.getProfile(),
      externalPlugins: hostSnapshot.plugins,
      hostConnected: hostSnapshot.status === 'connected',
    });
    updateChainWithHistory(plan.chain, 'Applied Reference Match Chain');
    setStatusNotice('Applied weighted EQ contour, stereo focus, and loudness calibration from reference track.');
  };

  const handleAutoFixQc = () => {
    if (!activeTrack) return;
    const next = structuredClone(chain);
    const hasLimiterOrMax = next.some((m) => m.type === 'maximizer' || m.type === 'limiter');
    if (!hasLimiterOrMax) {
      next.push(
        createProcessorModule('maximizer', {
          params: {
            character: 'transparent',
            targetLufs: activeQcProfile.targetLufs,
            ceilingDb: activeQcProfile.maxTruePeakDb,
            transientEmphasis: 25,
            truePeak: true,
          },
        }),
      );
    } else {
      for (const mod of next) {
        if (mod.type === 'maximizer') {
          (mod.params as { targetLufs: number; ceilingDb: number }).targetLufs = activeQcProfile.targetLufs;
          (mod.params as { ceilingDb: number }).ceilingDb = activeQcProfile.maxTruePeakDb;
        }
        if (mod.type === 'limiter') {
          (mod.params as { ceilingDb: number }).ceilingDb = activeQcProfile.maxTruePeakDb;
        }
        if (mod.type === 'stereo-imager') {
          (mod.params as { monoBassBelowHz: number }).monoBassBelowHz = 100;
        }
      }
    }
    const validated = validateChain(next);
    updateChainWithHistory(validated, `Applied SYN-QC Auto-Fix (${activeQcProfile.name})`);
    setStatusNotice(`Adjusted chain ceiling & loudness targets for ${activeQcProfile.name}.`);
  };

  const handleSettingsChange = (next: AppSettings) => {
    const previous = settings;
    setSettings(next);
    void saveAppSettings(next);
    if (next.audioLatencyMode !== previous.audioLatencyMode) {
      void engineRef.current!.setLatencyMode(next.audioLatencyMode).then(() => {
        setAudioEngineInfo(engineRef.current!.getAudioEngineInfo());
        setStatusNotice('Audio latency mode changed to ' + next.audioLatencyMode + '.');
      }).catch((error) => {
        const reverted = { ...next, audioLatencyMode: previous.audioLatencyMode };
        setSettings(reverted);
        void saveAppSettings(reverted);
        setStatusNotice(error instanceof Error ? error.message : 'Could not change audio latency mode.');
      });
    }
    if ((next.audioOutputDeviceId ?? '') !== (previous.audioOutputDeviceId ?? '')) {
      void engineRef.current!.setOutputDevice(next.audioOutputDeviceId ?? '').then((supported) => {
        setAudioEngineInfo(engineRef.current!.getAudioEngineInfo());
        if (!supported) {
          const reverted = { ...next, audioOutputDeviceId: previous.audioOutputDeviceId ?? '' };
          setSettings(reverted);
          void saveAppSettings(reverted);
          setStatusNotice('This browser does not support programmatic audio output selection. The system default remains active.');
        } else {
          setStatusNotice('Audio output device updated.');
        }
      }).catch((error) => {
        const reverted = { ...next, audioOutputDeviceId: previous.audioOutputDeviceId ?? '' };
        setSettings(reverted);
        void saveAppSettings(reverted);
        setStatusNotice(error instanceof Error ? error.message : 'Could not change audio output device.');
      });
    }
  };

  const handleRenderExport = async () => {
    const src = getRenderSource();
    if (!src || !activeTrack) {
      const message = 'Load an audio track before starting an export.';
      setExportError(message);
      setStatusNotice(message);
      return;
    }
    if (renderingExport) return;

    setRenderingExport(true);
    setExportError(null);
    setExportProgress('Preparing export package...');
    setExportDeliveryCheck(null);
    try {
      const safeStem = (exportConfig.filename.trim() || 'SYN_Master').replace(/[<>:"/\\|?*]/g, '_').replace(/^\.+$/, 'SYN_Master');
      type SynSaveFileHandle = {
        createWritable: () => Promise<{
          write: (data: Blob) => Promise<void>;
          close: () => Promise<void>;
          abort?: () => Promise<void>;
        }>;
      };
      type SynSavePickerWindow = Window & {
        showSaveFilePicker?: (options: {
          suggestedName: string;
          types: Array<{ description: string; accept: Record<string, string[]> }>;
        }) => Promise<SynSaveFileHandle>;
      };
      let saveFileHandle: SynSaveFileHandle | null = null;
      const pickerWindow = window as SynSavePickerWindow;
      if (typeof pickerWindow.showSaveFilePicker === 'function') {
        try {
          // Request the native Save As destination from the Export click, before
          // asynchronous rendering consumes the browser's transient user activation.
          saveFileHandle = await pickerWindow.showSaveFilePicker({
            suggestedName: safeStem + '.zip',
            types: [{ description: 'SYN MASTER export package', accept: { 'application/zip': ['.zip'] } }],
          });
        } catch (pickerError) {
          if ((pickerError as { name?: string })?.name === 'AbortError') {
            setStatusNotice('Export canceled.');
            return;
          }
          throw pickerError;
        }
      }
      const selectedFormats = Array.from(new Set(
        (exportConfig.selectedFormats?.length ? exportConfig.selectedFormats : [exportConfig.format])
          .filter((format) => ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'mid', 'webm-opus'].includes(format)),
      ));
      if (selectedFormats.length === 0) throw new Error('Select at least one output format.');

      type ZipFileEntry = { name: string; data: Blob | Uint8Array | ArrayBuffer | string };
      const entries: ZipFileEntry[] = [];
      const outputManifest: Array<{ file: string; format: string; bytes: number; integratedLufs?: number | null; truePeakDbtp?: number | null }> = [];
      const deliveryMessages: string[] = [];
      const failures: string[] = [];
      const audioFormats = selectedFormats.filter((format) => format !== 'mid');

      if (selectedFormats.includes('mid')) {
        const { encodeMidiTempoFile } = await import('./dsp/midiEncoder');
        const midiBlob = encodeMidiTempoFile(safeStem, activeTrack.durationSec, exportConfig.midiTempoBpm ?? 120, exportConfig.saveLoopMarkers ?? true);
        const midiName = safeStem + '.mid';
        entries.push({ name: safeStem + '/' + midiName, data: midiBlob });
        outputManifest.push({ file: midiName, format: 'MIDI', bytes: midiBlob.size });
      }

      if (audioFormats.length > 0) {
        // Render the active mastering chain exactly once. Every codec is encoded from
        // this identical 32-bit float intermediate so format selection cannot alter DSP.
        setExportProgress('Rendering the mastering chain once...');
        const effectiveChain = exportConfig.includeMasteringChain !== false && !chainBypassed ? chain : [];
        const processed = await renderMixedChain(src, activeTrack.sampleRate, effectiveChain, processExternalStage, getPostFades());
        const intermediateConfig: ExportConfig = {
          ...exportConfig,
          format: 'wav',
          wavBitDepth: 32,
          sampleRate: activeTrack.sampleRate as ExportConfig['sampleRate'],
          dither: 'none',
        };
        const intermediateWav = encodeWavBlob(processed.channels, activeTrack.sampleRate, intermediateConfig);

        for (let formatIndex = 0; formatIndex < audioFormats.length; formatIndex++) {
          const format = audioFormats[formatIndex];
          setExportProgress('Encoding ' + format.toUpperCase() + ' (' + (formatIndex + 1) + '/' + audioFormats.length + ')...');
          try {
          const params = new URLSearchParams({
            format,
            sampleRate: String(exportConfig.sampleRate),
            channels: exportConfig.channels,
            wavBitDepth: String(exportConfig.wavBitDepth),
            flacBitDepth: String(exportConfig.flacBitDepth ?? 24),
            flacCompression: String(exportConfig.flacCompression ?? 5),
            mp3BitrateKbps: String(exportConfig.mp3BitrateKbps ?? 320),
            oggBitrateKbps: String(exportConfig.oggBitrateKbps ?? 192),
            aacBitrateKbps: String(exportConfig.aacBitrateKbps ?? 320),
            opusBitrateKbps: String(exportConfig.opusBitrateKbps ?? 192),
            // A Dither module in the rack already dithered the master: never dither twice.
            dither: effectiveChain.some((m) => m.type === 'dither' && m.enabled && !m.bypassed) ? 'none' : exportConfig.dither,
            metadataTitle: exportConfig.metadataTitle ?? '',
            metadataArtist: exportConfig.metadataArtist ?? '',
            ceilingDb: String(exportConfig.ceilingDb),
            normalizeToTarget: String(exportConfig.normalizeToTarget),
            targetLufs: String(exportConfig.targetLufs),
            // Fades in the render: normalize with one constant gain so they are not undone.
            preserveFades: String(Boolean(getPostFades())),
          });
          const response = await fetch('/api/export/encode?' + params.toString(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: intermediateWav,
          });
          if (!response.ok) {
            const payload = await response.json().catch(() => ({})) as { error?: string };
            throw new Error((payload.error || 'Audio export failed (HTTP ' + response.status + ').') + ' [' + format.toUpperCase() + ']');
          }

          const blob = await response.blob();
          if (blob.size === 0) throw new Error(format.toUpperCase() + ' encoder returned an empty file.');
          const extension = format === 'webm-opus' ? 'webm' : format;
          const fileName = safeStem + '.' + extension;
          entries.push({ name: safeStem + '/' + fileName, data: blob });

          const measuredLufsHeader = response.headers.get('X-Syn-Integrated-Lufs');
          const measuredTpHeader = response.headers.get('X-Syn-True-Peak-Dbtp');
          const measuredLufs = measuredLufsHeader === null ? null : Number(measuredLufsHeader);
          const measuredTp = measuredTpHeader === null ? null : Number(measuredTpHeader);
          const hasPeak = measuredTp !== null && Number.isFinite(measuredTp);
          const overCeiling = hasPeak && measuredTp! > exportConfig.ceilingDb + 0.05;
          if (!hasPeak) {
            deliveryMessages.push(format.toUpperCase() + ': encoded file could not be measured.');
          } else {
            deliveryMessages.push(
              format.toUpperCase() + ': ' +
              (measuredLufs !== null && Number.isFinite(measuredLufs) ? measuredLufs.toFixed(1) + ' LUFS, ' : '') +
              measuredTp!.toFixed(1) + ' dBTP' +
              (overCeiling ? ' (over ceiling).' : ' (within ceiling).'),
            );
          }
          outputManifest.push({
            file: fileName,
            format: format.toUpperCase(),
            bytes: blob.size,
            integratedLufs: measuredLufs !== null && Number.isFinite(measuredLufs) ? measuredLufs : null,
            truePeakDbtp: hasPeak ? measuredTp : null,
          });
          } catch (formatError) {
            const message = formatError instanceof Error ? formatError.message : 'Unknown encoder error.';
            failures.push(format.toUpperCase() + ': ' + message);
            deliveryMessages.push(format.toUpperCase() + ': FAILED. ' + message);
          }
        }
      }

      if (outputManifest.length === 0) {
        throw new Error('No selected format could be rendered. ' + failures.join(' '));
      }
      setExportProgress('Building ZIP archive and render manifest...');
      const manifest = {
        application: 'SYN MASTER',
        package: safeStem,
        createdAt: new Date().toISOString(),
        source: { name: activeTrack.name, durationSec: activeTrack.durationSec, sampleRate: activeTrack.sampleRate },
        render: {
          sampleRate: exportConfig.sampleRate,
          channels: exportConfig.channels,
          resampler: exportConfig.resampler ?? 'sinc-512',
          masteringChainIncluded: exportConfig.includeMasteringChain !== false && !chainBypassed,
          dither: exportConfig.dither,
          truePeakCeilingDbtp: exportConfig.ceilingDb,
          normalizeToTarget: exportConfig.normalizeToTarget,
          targetIntegratedLufs: exportConfig.normalizeToTarget ? exportConfig.targetLufs : null,
          metadataTitle: exportConfig.metadataTitle ?? '',
          metadataArtist: exportConfig.metadataArtist ?? '',
        },
        outputs: outputManifest,
        failures,
      };
      entries.push({ name: safeStem + '/render-manifest.json', data: JSON.stringify(manifest, null, 2) });

      const { createZipBlob } = await import('./dsp/zipArchive');
      const zipBlob = await createZipBlob(entries);
      if (zipBlob.size < 22) throw new Error('ZIP packaging failed: archive is unexpectedly small.');
      const zipHeader = new Uint8Array(await zipBlob.slice(0, 4).arrayBuffer());
      if (zipHeader[0] !== 0x50 || zipHeader[1] !== 0x4b || zipHeader[2] !== 0x03 || zipHeader[3] !== 0x04) {
        throw new Error('ZIP packaging failed: archive signature is invalid.');
      }

      if (exportDownloadUrl) URL.revokeObjectURL(exportDownloadUrl);
      const url = URL.createObjectURL(zipBlob);
      const zipName = safeStem + '.zip';
      setExportDownloadUrl(url);
      setExportDownloadName(zipName);
      setExportDeliveryCheck({
        warning: failures.length > 0 || deliveryMessages.some((message) => message.includes('could not be measured') || message.includes('(over ceiling).')),
        text: deliveryMessages.length ? deliveryMessages.join('  ') : 'MIDI conductor file packaged successfully.',
      });

      setExportProgress(saveFileHandle ? 'Writing ZIP to the selected destination...' : 'Starting ZIP download...');
      if (saveFileHandle) {
        const writable = await saveFileHandle.createWritable();
        try {
          await writable.write(zipBlob);
          await writable.close();
        } catch (writeError) {
          await writable.abort?.().catch(() => undefined);
          throw writeError;
        }
        setStatusNotice('Saved ' + outputManifest.length + ' output file(s)' + (failures.length ? '; ' + failures.length + ' format(s) failed' : '') + ' in "' + zipName + '".');
      } else {
        // Automatic download fallback for browsers without the native file picker.
        // The visible link remains available if the browser blocks this click.
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = zipName;
        anchor.style.display = 'none';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setStatusNotice('Packaged ' + outputManifest.length + ' output file(s)' + (failures.length ? '; ' + failures.length + ' format(s) failed' : '') + ' in "' + zipName + '".');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Master export failed.';
      setExportError(message);
      setStatusNotice(message);
    } finally {
      setRenderingExport(false);
      setExportProgress(null);
    }
  };

  const handleApplyPreset = useCallback(
    (p: MasteringPreset) => {
      updateChainWithHistory(structuredClone(p.chain), `Loaded preset "${p.name}"`);
      setStatusNotice(`Loaded preset "${p.name}".`);
    },
    [updateChainWithHistory],
  );

  const handleApplySavedChain = useCallback(
    (c: SavedChainRecord) => {
      updateChainWithHistory(structuredClone(c.chain), `Loaded saved chain "${c.name}"`);
      setStatusNotice(`Loaded chain "${c.name}".`);
    },
    [updateChainWithHistory],
  );

  const handleDeleteSavedChain = useCallback(async (id: string) => {
    await removeChainRecord(id);
    setSavedChains(await listSavedChains());
  }, []);

  const handleOpenProject = useCallback((proj: ProjectRecord) => {
    setProjectId(proj.id);
    setProjectName(proj.name);
    setMode(proj.mode);
    const validated = validateChain(proj.chain).map((m) =>
      m.type === 'external-vst3'
        ? {
            ...m,
            params: {
              ...(m.params as ExternalVST3Params),
              instanceId: null,
              status: 'unloaded' as const,
              editorOpen: false,
            },
          }
        : m,
    );
    setChain(validated);
    setAppliedCorrections([]);
    setDirectorPlan(null);
    setDirectorReport(null);
    setAiStrategy(proj.aiStrategy ?? null);
    setIterations(proj.iterations ?? []);
    setQcTargetId(proj.qcTargetId ?? 'streaming');
    setStatusNotice(`Opened project "${proj.name}".`);
  }, []);

  const handleDeleteProject = useCallback(async (id: string) => {
    await removeProject(id);
    setProjects(await listProjects());
  }, []);

  const handleToggleChainBypass = useCallback(() => {
    setChainBypassed((b) => {
      const next = !b;
      recordCorrection(next ? 'Master Chain Bypassed (Dry)' : 'Master Chain Engaged', chainRef.current, {
        bypassed: next,
      });
      return next;
    });
  }, [recordCorrection]);

  const handleSaveChainPreset = useCallback(
    async (name: string) => {
      await saveChainRecord({
        id: `chain-${Date.now()}`,
        name,
        createdAt: Date.now(),
        chain: structuredClone(chainRef.current),
      });
      setSavedChains(await listSavedChains());
      setStatusNotice(`Saved chain "${name}".`);
    },
    [],
  );

  const handleResetChain = useCallback(() => updateChainWithHistory(createStarterChain()), [updateChainWithHistory]);

  const handleChangeMonitorVolume = useCallback((v: number) => {
    setMonitorVolume(v);
    engineRef.current!.setMonitorVolume(v);
  }, []);

  const activeObjective = resolveObjectiveTarget(objectiveId, customObjective, referenceTrack?.analysis ?? null);
  const targetLabel = targetPresetId
    ? LOUDNESS_TARGET_PRESETS.find((t) => t.id === targetPresetId)?.label ?? activeObjective.label
    : `${activeObjective.label} (${activeObjective.targetLufs} LUFS)`;
  const diagnosticLog = activeTrack
    ? buildDiagnosticLog({
        trackName: activeTrack.name,
        objective: directorReport?.objective ?? activeObjective,
        source: directorReport?.preAnalysis ?? activeTrack.analysis,
        findings: (directorReport?.diagnosis ?? baselineDiagnosis)?.findings ?? [],
        chain,
        report: directorReport,
        referenceAnalysis: referenceTrack?.analysis ?? null,
      })
    : null;

  const handleTargetPreset = (id: string) => {
    const preset = LOUDNESS_TARGET_PRESETS.find((t) => t.id === id);
    if (!preset) return;
    setTargetPresetId(id);
    setCustomObjective((prev) => ({
      ...prev,
      targetLufs: preset.targetLufs,
      maxTruePeakDb: preset.maxTruePeakDb,
      minDynamicRangeDb: preset.minDynamicRangeDb,
    }));
    setObjectiveId('custom');
    setStatusNotice(`Target set to ${preset.label}: ${preset.targetLufs} LUFS / ${preset.maxTruePeakDb} dBTP.`);
  };

  const handleNewTrack = () => {
    sourceUploadSeqRef.current += 1;
    referenceUploadSeqRef.current += 1;
    vocalPreparationAbortRef.current?.abort();
    vocalPreparationAbortRef.current = null;
    vocalPreparationCacheRef.current.clear();
    vocalSourceOverrideRef.current = null;
    directorStopRef.current = true;
    getActiveAiCall()?.cancel();
    directorRunIdRef.current += 1;
    activeTrackIdRef.current = null;
    sourceChannelsRef.current = null;
    postChannelsRef.current = null;
    referenceChannelsRef.current = null;
    referenceTrackIdRef.current = null;
    engineRef.current?.stop();
    engineRef.current?.clearSourceAndReference();
    setReferenceTrack(null);
    setAuditionTarget('original');
    engineRef.current?.clearOverrideBuffer('mastered-external');
    engineRef.current?.clearOverrideBuffer('iteration');
    for (const key of Array.from(engineRef.current?.getOverrideBufferKeys() ?? [])) {
      if (key.startsWith('candidate-')) engineRef.current?.clearOverrideBuffer(key);
    }
    setIsPlaying(false);
    telemetryStore.publish({ isPlaying: false, currentTimeSec: 0, live: null });
    setActiveTrack(null);
    setDirectorReport(null);
    setAiFallbackBanner(null);
    setShowWorkstationWithoutTrack(typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches);
  };

  // Desktop-style menubar: click opens, hover switches while one is open, outside click /
  // Escape / choosing an item closes, arrow keys move between menus and items.
  const MENU_ORDER = ['File', 'Edit', 'Workspace', 'View', 'Tools'] as const;
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const menubarRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!openMenu) return;
    const onDown = (e: PointerEvent) => {
      if (menubarRef.current && !menubarRef.current.contains(e.target as Node)) setOpenMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenMenu(null);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [openMenu]);
  const handleMenubarKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    const target = e.target as HTMLElement;
    const group = target.closest<HTMLElement>('[data-menu]');
    if (!group) return;
    const name = group.dataset.menu as (typeof MENU_ORDER)[number];
    const idx = MENU_ORDER.indexOf(name);
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const next = MENU_ORDER[(idx + (e.key === 'ArrowRight' ? 1 : MENU_ORDER.length - 1)) % MENU_ORDER.length];
      if (openMenu) setOpenMenu(next);
      menubarRef.current?.querySelector<HTMLElement>(`[data-menu="${next}"] > summary`)?.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (openMenu !== name) setOpenMenu(name);
      window.requestAnimationFrame(() => {
        const items = Array.from(group.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
        if (!items.length) return;
        const at = items.indexOf(target as HTMLButtonElement);
        const nextAt = at < 0 ? (e.key === 'ArrowDown' ? 0 : items.length - 1) : (at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
        items[nextAt].focus();
      });
    } else if (e.key === 'Escape') {
      setOpenMenu(null);
      group.querySelector<HTMLElement>('summary')?.focus();
    }
  };

  const renderAiChanges = (idPrefix: string) =>
    aiChangeBase && !directorRunning ? (
      <React.Suspense fallback={null}>
        <WhatAiChangedPanel
          idPrefix={idPrefix}
          before={aiChangeBase.before}
          after={aiChangeBase.after}
          current={chain}
          disabled={directorRunning}
          onApplyChain={(next, label) => {
            updateChainWithHistory(next, label);
            recordCorrection(label, next);
            setStatusNotice(`${label}. Reanalyzing resulting audio...`);
          }}
        />
      </React.Suspense>
    ) : null;

  const masterConsole = (
    <MasterConsole
      chain={chain}
      stageTelemetry={stageTelemetry}
      dynamicEqTraces={dynamicEqTraces}
      chainBypassed={chainBypassed}
      onChangeChain={(next) => {
        updateChainWithHistory(next);
        recordCorrection('Console Edit', next, { coalesceManual: true });
      }}
      sampleRate={activeTrack?.sampleRate ?? 48000}
      source={activeTrack?.analysis ?? null}
      master={postAnalysisState.status === 'ready' ? postAnalysis : null}
      referenceAnalysis={referenceTrack?.analysis ?? null}
      scopeChannels={postChannelsRef.current}
      waveformPeaks={activeTrack?.peaks ?? []}
      durationSec={activeTrack?.durationSec ?? 0}
      hasTrack={Boolean(activeTrack)}
      running={directorRunning}
      stage={directorStage}
      pass={directorPass}
      maxPasses={10}
      report={directorReport}
      onFix={() => { setOperatingMode('autonomous'); void handleRunMasterDirector(true); }}
      onStop={() => {
        directorStopRef.current = true;
        vocalPreparationAbortRef.current?.abort();
        getActiveAiCall()?.cancel();
      }}
      fixError={aiError}
      onDemo={() => handleLoadDemoSource('main-mix')}
      onImport={handleUploadSourceFile}
      targetPresetId={targetPresetId}
      targetLabel={targetLabel}
      targetLufs={activeObjective.targetLufs}
      maxTruePeakDb={activeObjective.maxTruePeakDb}
      onTargetPreset={handleTargetPreset}
      presets={MASTERING_PRESETS}
      onApplyPreset={handleApplyPreset}
      onOpenRack={() => setRackWindowOpen(true)}
      onOpenStereoLab={() => { setLabDefaultSubTab('stereo'); setActiveTab('lab'); }}
      notice={statusNotice}
      aiNotice={aiNotice}
      aiFallbackBanner={summarizeAiFallbackBanner(directorReport?.aiPasses) ?? aiFallbackBanner}
      aiChanges={renderAiChanges('console')}
      onAskAi={() => setActiveTab('ai')}
      onExport={() => setExportModalOpen(true)}
      onSeek={seekTo}
      isPlaying={isPlaying}
      onTogglePlay={togglePlay}
      mode={mode}
      fades={fades}
      onFadesChange={setFades}
      onTargetLufs={(lufs) => {
        setTargetPresetId(null);
        setCustomObjective((prev) => ({ ...prev, targetLufs: lufs }));
        setObjectiveId('custom');
        setStatusNotice(`Custom loudness target: ${lufs} LUFS.`);
      }}
      blanketPeaks={chainBypassed || auditionTarget === 'original' ? prePeaksHi : postPeaksHi ?? prePeaksHi}
      timelineTransport={
        <TimelinePlayer
          durationSec={activeTrack?.durationSec ?? 0}
          isPlaying={isPlaying}
          fades={fades}
          onFadesChange={setFades}
          onSeek={seekTo}
          onTogglePlay={togglePlay}
          onImport={handleUploadSourceFile}
          integrated
          transportOnly
        />
      }
      timeline={
        <TimelinePlayer
          durationSec={activeTrack?.durationSec ?? 0}
          isPlaying={isPlaying}
          fades={fades}
          onFadesChange={setFades}
          onSeek={seekTo}
          onTogglePlay={togglePlay}
          onImport={handleUploadSourceFile}
          integrated
          hideTransport
          extra={<React.Suspense fallback={null}><PlatformPreviewSelector levels={platformLevels} onOpenPanel={() => setActiveTab('qc')} /></React.Suspense>}
        />
      }
    />
  );

  return (
    <div
      className="syn-workstation min-h-screen lg:h-screen w-full flex flex-col bg-[#070709] text-[#F7F8FA] lg:overflow-hidden"
      onDragOver={(e) => {
        // Drag-and-drop import anywhere on the workstation (inner drop zones handle their own drops).
        if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          if (!fileDragActive) setFileDragActive(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node | null)) setFileDragActive(false);
      }}
      onDrop={(e) => {
        setFileDragActive(false);
        if (e.defaultPrevented) return;
        const file = Array.from(e.dataTransfer?.files ?? []).find((f) => f.type.startsWith('audio/') || /\.(wav|flac|mp3|aac|m4a|ogg|aiff?|opus|webm)$/i.test(f.name));
        if (!file) return;
        e.preventDefault();
        void handleUploadSourceFile(file);
      }}
    >
      {fileDragActive && (
        <div className="fixed inset-0 z-40 pointer-events-none flex items-center justify-center border-4 border-dashed border-[#38BDF8] bg-[#05070D]/70" data-testid="drop-hint">
          <p className="font-display text-lg text-[#F3D58A]">Drop your track to import</p>
        </div>
      )}
      {importProgress !== null && (
        <div
          className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/85 backdrop-blur-md p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="syn-import-overlay-title"
          data-testid="import-overlay"
        >
          <div className="syn-import-overlay-card">
            <ProgressRing
              percent={importProgress.percent}
              size={144}
              label={importProgress.error ? 'Failed' : IMPORT_STAGE_LABELS[importProgress.stage]}
              state={importProgress.error ? 'error' : 'running'}
              working={importProgress.working}
              ariaLabel={importProgress.kind === 'reference' ? 'Importing reference track' : 'Importing track'}
            />
            <p id="syn-import-overlay-title" className="font-display text-sm text-[#F5EEDC] tracking-wide">
              {importProgress.error
                ? 'Import failed'
                : `${importProgress.kind === 'reference' ? 'Importing reference' : 'Importing'} · ${IMPORT_STAGE_LABELS[importProgress.stage]}…`}
            </p>
            <p className="text-xs text-[#9AA3B2]" title={importProgress.fileName}>{importProgress.fileName}</p>
            {importProgress.error && (
              <p className="text-xs text-[#FCA5A5]" role="alert" data-testid="import-error">{importProgress.error}</p>
            )}
            <div className="syn-import-overlay-actions">
              {importProgress.error ? (
                <button type="button" className="border border-[#D4A84A] text-[#F3D58A]" onClick={() => setImportProgress(null)} autoFocus>
                  Dismiss
                </button>
              ) : (
                <button type="button" className="border border-[#F0475A] text-[#FCA5A5]" onClick={handleCancelImport} data-testid="import-cancel">
                  Cancel
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {/* Zone 3-Part Top Bar Contract */}
      <header className="syn-app-header h-14 shrink-0 px-4 border-b border-[#242732] bg-[#0B0C10] flex items-center justify-between gap-8">
        {/* Zone 1: Library drawer toggle + serif wordmark (reference-mockup lockup) */}
        <div className="syn-brand-zone">
          <button
            type="button"
            className="syn-icon-btn syn-library-toggle"
            aria-label={libraryOpen ? 'Close menu' : 'Open menu: workspaces, audio library, presets, chains and projects'}
            aria-expanded={libraryOpen}
            aria-controls="syn-library-drawer"
            onClick={() => setLibraryOpen((v) => !v)}
          >
            <Menu className="w-5 h-5" />
          </button>
          <div className="syn-wordmark" aria-label="SYN-MASTER Web Mastering Suite">
            <span className="syn-wordmark-row">
              <img src="brand/syn-master-mark.webp" alt="" width={256} height={256} decoding="async" className="syn-wordmark-mark" />
              <span className="syn-wordmark-name">SYN-MASTER</span>
            </span>
            <span className="syn-wordmark-sub"><span className="syn-wordmark-sub-web">WEB </span>MASTERING SUITE</span>
          </div>
        </div>

        {/* BlueNote-grade command menu: grouped actions, keyboard-friendly native disclosure menus */}
        <div className="syn-mobile-command-menu">
          <input type="checkbox" id="syn-mobile-menu-toggle" className="syn-mobile-menu-toggle" aria-label="Application menu" aria-controls="syn-application-menu" />
          <label htmlFor="syn-mobile-menu-toggle" className="syn-mobile-menu-trigger">Menu</label>
          <nav id="syn-application-menu" ref={menubarRef} aria-label="Application Menu" className="syn-menubar" onKeyDown={handleMenubarKeyDown} onClick={(event) => { if ((event.target as HTMLElement).closest("button")) { const toggle = event.currentTarget.parentElement?.querySelector<HTMLInputElement>(".syn-mobile-menu-toggle"); if (toggle) toggle.checked = false; } }}>
          <details className="syn-menu-group" open={openMenu === 'File'} data-menu="File" onMouseEnter={() => { if (openMenu && openMenu !== 'File') setOpenMenu('File'); }}>
            <summary aria-haspopup="menu" aria-expanded={openMenu === 'File'} onClick={(e) => { e.preventDefault(); setOpenMenu((m) => (m === 'File' ? null : 'File')); }}>File</summary>
            <div className="syn-menu-panel" role="menu" aria-label="File">
              <button role="menuitem" type="button" onClick={(event) => { void handleSaveProject(); setOpenMenu(null); }}>Save Project <kbd>Ctrl+S</kbd></button>
              <button role="menuitem" type="button" onClick={(event) => { setExportModalOpen(true); setOpenMenu(null); }}>Export Master</button>
            </div>
          </details>
          <details className="syn-menu-group" open={openMenu === 'Edit'} data-menu="Edit" onMouseEnter={() => { if (openMenu && openMenu !== 'Edit') setOpenMenu('Edit'); }}>
            <summary aria-haspopup="menu" aria-expanded={openMenu === 'Edit'} onClick={(e) => { e.preventDefault(); setOpenMenu((m) => (m === 'Edit' ? null : 'Edit')); }}>Edit</summary>
            <div className="syn-menu-panel" role="menu" aria-label="Edit">
              <button role="menuitem" type="button" disabled={undoStack.length === 0} onClick={(event) => { handleUndo(); setOpenMenu(null); }}>Undo <kbd>Ctrl+Z</kbd></button>
              <button role="menuitem" type="button" disabled={redoStack.length === 0} onClick={(event) => { handleRedo(); setOpenMenu(null); }}>Redo <kbd>Ctrl+Y</kbd></button>
              <button role="menuitem" type="button" onClick={(event) => { handleToggleChainBypass(); setOpenMenu(null); }}>Toggle Chain Bypass</button>
              <button role="menuitem" type="button" onClick={(event) => { handleResetChain(); setOpenMenu(null); }}>Reset Processing Chain</button>
            </div>
          </details>
          <details className="syn-menu-group" open={openMenu === 'Workspace'} data-menu="Workspace" onMouseEnter={() => { if (openMenu && openMenu !== 'Workspace') setOpenMenu('Workspace'); }}>
            <summary aria-haspopup="menu" aria-expanded={openMenu === 'Workspace'} onClick={(e) => { e.preventDefault(); setOpenMenu((m) => (m === 'Workspace' ? null : 'Workspace')); }}>Workspace</summary>
            <div className="syn-menu-panel" role="menu" aria-label="Workspace">
              {([
                { id: 'studio', label: 'Mastering Workspace' },
                { id: 'ai', label: 'AI Director' },
                { id: 'lab', label: 'Analysis Lab' },
                { id: 'stems', label: 'Stem Studio' },
                { id: 'reference', label: 'Reference Match' },
                { id: 'battle', label: 'A/B Battle' },
                { id: 'qc', label: 'Quality Check' },
                { id: 'plugins', label: 'Plugins & Host' },
              ] as const).map((item) => (
                <button key={item.id} role="menuitem" type="button" aria-current={activeTab === item.id ? 'page' : undefined} onClick={(event) => { setActiveTab(item.id); setOpenMenu(null); }}>
                  {item.label}{activeTab === item.id ? <span aria-hidden="true">✓</span> : null}
                </button>
              ))}
            </div>
          </details>
          <details className="syn-menu-group" open={openMenu === 'View'} data-menu="View" onMouseEnter={() => { if (openMenu && openMenu !== 'View') setOpenMenu('View'); }}>
            <summary aria-haspopup="menu" aria-expanded={openMenu === 'View'} onClick={(e) => { e.preventDefault(); setOpenMenu((m) => (m === 'View' ? null : 'View')); }}>View</summary>
            <div className="syn-menu-panel" role="menu" aria-label="View">
              <button role="menuitem" type="button" onClick={(event) => { setFullscreenWorkspace((value) => !value); setOpenMenu(null); }}>{fullscreenWorkspace ? 'Exit Fullscreen' : 'Fullscreen Workspace'}</button>
              <button role="menuitem" type="button" onClick={(event) => { setSettingsModalOpen(true); setOpenMenu(null); }}>Preferences & Settings</button>
            </div>
          </details>
          <details className="syn-menu-group" open={openMenu === 'Tools'} data-menu="Tools" onMouseEnter={() => { if (openMenu && openMenu !== 'Tools') setOpenMenu('Tools'); }}>
            <summary aria-haspopup="menu" aria-expanded={openMenu === 'Tools'} onClick={(e) => { e.preventDefault(); setOpenMenu((m) => (m === 'Tools' ? null : 'Tools')); }}>Tools</summary>
            <div className="syn-menu-panel" role="menu" aria-label="Tools">
              <button role="menuitem" type="button" onClick={(event) => { setActiveTab('plugins'); setOpenMenu(null); }}>VST3 Plugin Manager</button>
              <button role="menuitem" type="button" onClick={(event) => { setActiveTab('stems'); setOpenMenu(null); }}>Stem Intelligence</button>
              <button role="menuitem" type="button" onClick={(event) => { setActiveTab('lab'); setOpenMenu(null); }}>Spectral Analysis</button>
            </div>
          </details>
          </nav>
        </div>

        {/* Zone 3: session readout + primary CTA */}
        <div className="syn-header-right flex items-center shrink-0">
          <div className="syn-header-session" aria-label="Session">
            <span className="syn-header-project">PROJECT: {projectName}</span>
            <span className="syn-header-lufs">
              {(postAnalysisState.status === 'ready' && postAnalysis ? postAnalysis : activeTrack?.analysis)?.integratedLufs.toFixed(1) ?? '--.-'} LUFS
            </span>
          </div>
          <button type="button" aria-label="Open Settings" onClick={() => setSettingsModalOpen(true)} className="syn-icon-btn syn-header-settings">
            <Settings className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => setExportModalOpen(true)}
            className="syn-header-export px-4 py-1.5 rounded bg-[#D4AF37] text-[#070709] text-xs font-bold hover:bg-[#F2CA52] whitespace-nowrap shrink-0"
          >
            <span className="hidden sm:inline">Export Master</span><span className="sm:hidden">Export</span>
          </button>
        </div>
      </header>

      {/* Secondary Workstation Control Ribbon */}
      <div
        role="toolbar"
        aria-label="Session Controls"
        className="syn-session-ribbon px-4 py-2 border-b border-[#222530] bg-[#101116] flex flex-wrap items-center justify-between gap-3 shrink-0"
      >
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <input
            type="text"
            aria-label="Project Name"
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            className="bg-[#090A0E] border border-[#262934] rounded px-2.5 py-1 text-xs font-semibold text-[#F7F8FA] w-44 sm:w-52 focus:outline-none focus:border-[#D4AF37]"
          />
          <button
            type="button"
            onClick={handleSaveProject}
            className="px-2.5 py-1 rounded bg-[#181A22] border border-[#2B2E3A] text-xs text-[#F7F8FA] hover:border-[#D4AF37] flex items-center gap-1 whitespace-nowrap"
          >
            <Save className="w-3.5 h-3.5 text-[#D4AF37]" />
            Save
          </button>
          <button
            type="button"
            aria-label="Undo Chain Change"
            disabled={undoStack.length === 0}
            onClick={handleUndo}
            className="p-1.5 rounded bg-[#181A22] border border-[#2B2E3A] text-[#C5CDD8] hover:border-[#D4AF37] disabled:opacity-35"
          >
            <Undo2 className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            aria-label="Redo Chain Change"
            disabled={redoStack.length === 0}
            onClick={handleRedo}
            className="p-1.5 rounded bg-[#181A22] border border-[#2B2E3A] text-[#C5CDD8] hover:border-[#D4AF37] disabled:opacity-35"
          >
            <Redo2 className="w-3.5 h-3.5" />
          </button>
          {/* Import track: compact gold pill in the session ribbon (pulses until a track is loaded). */}
          <label
            className={`syn-ribbon-import${activeTrack ? '' : ' is-empty'}`}
            title="Import a track (WAV, FLAC, MP3, AIFF, M4A, OGG) - or drop a file anywhere"
            data-testid="ribbon-import"
          >
            <Upload className="w-3.5 h-3.5" aria-hidden="true" />
            <span className="syn-ribbon-import-text">Import track</span>
            <input
              type="file"
              aria-label="Import track"
              accept="audio/*,.wav,.flac,.mp3,.aac,.m4a,.ogg,.aiff,.aif"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleUploadSourceFile(f); e.target.value = ''; }}
            />
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {statusNotice && (
            <span className="hidden 2xl:inline text-[11px] text-[#D4AF37] truncate max-w-xs">
              {statusNotice}
            </span>
          )}
          <label className="flex items-center gap-1.5 text-[11px] text-[#9CA3AF]">
            Mode:
            <select
              aria-label="Mastering Mode"
              title="Session mode: shown on the console and suggests a preset. Saved with the project and sent to the AI as context; Target and Objective drive processing."
              value={mode}
              onChange={(e) => setMode(e.target.value as MasteringMode)}
              className="bg-[#181A22] border border-[#2B2E3A] rounded px-2 py-1 text-xs text-[#F7F8FA]"
            >
              <option value="ai-auto">AI Automatic</option>
              <option value="hybrid">Hybrid (AI + Manual)</option>
              <option value="manual">Manual Control</option>
              <option value="transparent">Transparent</option>
              <option value="loudness">Loudness Maximization</option>
              <option value="analog">Analog Character</option>
              <option value="dynamic">Dynamic Preservation</option>
              <option value="reference">Reference Match</option>
              <option value="streaming">Streaming Delivery</option>
            </select>
          </label>
          <button
            type="button"
            onClick={() => setActiveTab('plugins')}
            aria-label="Native Plugin Host Status"
            className={`px-2.5 py-1 rounded border text-[11px] font-semibold flex items-center gap-1.5 whitespace-nowrap ${
              hostSnapshot.status === 'connected'
                ? 'bg-[#10B981]/15 border-[#10B981]/40 text-[#34D399]'
                : 'bg-[#181A22] border-[#2B2E3A] text-[#C5CDD8] hover:border-[#D4AF37]'
            }`}
          >
            <Plug className="w-3 h-3" />
            {hostSnapshot.status === 'connected'
              ? `Host (${hostSnapshot.plugins.length})`
              : 'Host: Browser-Only'}
          </button>
          <AiProviderChip onOpen={() => setSettingsModalOpen(true)} />
          <button
            type="button"
            aria-label="Open Settings"
            onClick={() => setSettingsModalOpen(true)}
            className="p-1.5 rounded bg-[#181A22] border border-[#2B2E3A] text-[#C5CDD8] hover:border-[#D4AF37]"
          >
            <Settings className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            aria-label="Toggle Fullscreen Workspace"
            onClick={() => setFullscreenWorkspace((f) => !f)}
            className="p-1.5 rounded bg-[#181A22] border border-[#2B2E3A] text-[#C5CDD8] hover:border-[#D4AF37]"
          >
            {fullscreenWorkspace ? (
              <Minimize2 className="w-3.5 h-3.5" />
            ) : (
              <Maximize2 className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      </div>

      {/* Main 3-Column Workstation Body */}
      <div className={`syn-daw-body flex-1 lg:min-h-0 flex flex-col lg:flex-row lg:overflow-hidden${fullscreenWorkspace ? ' is-fullscreen' : ''}`}>
        <Portal>
        {libraryOpen && (
          <button type="button" className="syn-library-backdrop" aria-label="Close audio library" onClick={() => setLibraryOpen(false)} />
        )}
        {(
          <div id="syn-library-drawer" className="syn-library-drawer" data-open={libraryOpen ? 'true' : 'false'}
            onKeyDown={(e) => { if (e.key === 'Escape') setLibraryOpen(false); }}>
          <nav className="syn-drawer-nav" aria-label="Workspaces">
            <div className="syn-drawer-nav-title">Navigate</div>
            <div className="syn-drawer-nav-grid">
              {([
                { id: 'studio', label: 'Dashboard' },
                { id: 'reference', label: 'Reference Match' },
                { id: 'ai', label: 'AI Director' },
                { id: 'lab', label: 'Analysis Lab' },
                { id: 'stems', label: 'Stem Studio' },
                { id: 'qc', label: 'Quality Check' },
                { id: 'battle', label: 'A/B Battle' },
                { id: 'plugins', label: 'Plugins & Host' },
              ] as const).map((item) => (
                <button key={item.id} type="button" className="syn-drawer-nav-item" aria-current={activeTab === item.id ? 'page' : undefined}
                  onClick={() => { setActiveTab(item.id); setLibraryOpen(false); }}>{item.label}</button>
              ))}
              <button type="button" className="syn-drawer-nav-item" onClick={() => { setLibraryOpen(false); setExportModalOpen(true); }}>Export</button>
              <button type="button" className="syn-drawer-nav-item" onClick={() => { setLibraryOpen(false); setSettingsModalOpen(true); }}>Settings</button>
            </div>
            <div className="syn-drawer-nav-title">Library</div>
          </nav>
          <LeftLibraryPanel
            activeTrack={activeTrack}
            referenceTrack={referenceTrack}
            presets={MASTERING_PRESETS}
            savedChains={savedChains}
            projects={projects}
            activeProjectId={projectId}
            onUploadSourceFile={handleUploadSourceFile}
            onUploadReferenceFile={handleUploadReferenceFile}
            onLoadDemoSource={handleLoadDemoSource}
            onLoadDemoReference={handleLoadDemoReference}
            onApplyPreset={handleApplyPreset}
            onApplySavedChain={handleApplySavedChain}
            onDeleteSavedChain={handleDeleteSavedChain}
            onOpenProject={handleOpenProject}
            onDeleteProject={handleDeleteProject}
          />
          </div>
        )}
        </Portal>

        {/* Center Mastering Stage */}
        <main data-layout={activeTab} data-syn-skin={activeTab === 'studio' ? 'studio' : 'instrument'} data-workspace={activeTab} className="syn-daw-main lg:flex-1 shrink-0 lg:shrink min-w-0 lg:overflow-y-auto p-4 flex flex-col gap-4 bg-[#070709] order-first lg:order-none">
          {activeTrack && activeTab !== 'studio' && (
            <section data-testid="mastering-control-desk" aria-label="Mastering Control Desk"
              className="syn-control-desk rounded-xl border border-[#D4AF37]/65 bg-gradient-to-br from-[#151006] via-[#0D0B06] to-[#070604] p-3.5 shadow-[0_12px_32px_rgba(0,0,0,.35)]">
              <div className="syn-control-desk-layout flex flex-wrap items-center justify-between gap-3">
                <div className="syn-control-desk-info min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[10px] font-black uppercase tracking-[.18em] text-[#F2CA52]">Mastering Control Desk</span>
                    <span className={`rounded border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${directorRunning ? 'border-[#D4AF37] bg-[#D4AF37]/15 text-[#F2CA52]' : postAnalysisState.status === 'ready' ? 'border-[#8B6A1B] bg-[#D4AF37]/10 text-[#E8C85A]' : 'border-[#4A3917] text-[#B6A780]'}`}>
                      {directorRunning ? (directorStage || 'PROCESSING') + ' · PASS ' + directorPass + '/10' : postAnalysisState.status === 'ready' ? 'MASTER ANALYSIS READY' : postAnalysisState.status === 'processing' ? 'ANALYZING MASTER' : 'READY TO ANALYZE'}
                    </span>
                  </div>
                  <div className="syn-control-desk-track mt-1 text-xs font-semibold text-[#F6EED8]">{activeTrack.name}</div>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[10px] font-mono-tabular text-[#B6A780]">
                    <span>Source {activeTrack.analysis.integratedLufs.toFixed(1)} LUFS</span>
                    <span>Master {postAnalysisState.status === 'ready' && postAnalysis ? postAnalysis.integratedLufs.toFixed(1) + ' LUFS' : 'Not verified'}</span>
                    <span>True Peak {postAnalysisState.status === 'ready' && postAnalysis ? postAnalysis.truePeakDb.toFixed(2) + ' dBTP' : '—'}</span>
                    <span>Objective {objectiveId.toUpperCase()}</span>
                  </div>
                </div>
                <div className="syn-control-desk-actions flex flex-wrap items-center gap-2">
                  <button type="button" disabled={directorRunning} onClick={handleAnalyzeTrack}
                    className="rounded-md border border-[#8B6A1B] bg-[#171208] px-3 py-2 text-[11px] font-bold text-[#E8C85A] hover:border-[#F2CA52] disabled:opacity-45">
                    ANALYZE TRACK
                  </button>
                  <button type="button" disabled={directorRunning || aiLoading}
                    onClick={() => { setOperatingMode('autonomous'); void handleRunMasterDirector(true); }}
                    className="rounded-md bg-[#D4AF37] px-4 py-2 text-[11px] font-black tracking-wide text-[#090704] shadow-[0_4px_18px_rgba(212,175,55,.18)] hover:bg-[#F2CA52] disabled:opacity-45">
                    {directorRunning ? 'FIXING & VERIFYING…' : 'FIX ALL & VERIFY'}
                  </button>
                  <button type="button" onClick={() => setExportModalOpen(true)}
                    className="rounded-md border border-[#8B6A1B] bg-[#171208] px-3 py-2 text-[11px] font-bold text-[#E8C85A] hover:bg-[#D4AF37]/10">
                    EXPORT MASTER
                  </button>
                </div>
              </div>
            </section>
          )}



          {/* Transport & Waveform Stage (Full waveform on Studio & Reference; compact transport bar on other tabs) */}
          {!activeTrack && (activeTab === 'plugins' || activeTab === 'stems') ? null : !activeTrack && activeTab === 'studio' ? (
            masterConsole
          ) : !activeTrack ? null : activeTab === 'studio' ? null : activeTab === 'reference' ? (
            <section className="p-3.5 rounded bg-[#111217] border border-[#242732] flex flex-col gap-3">
              {/* Track Metadata + A/B Switch */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs min-w-0">
                  <span className="font-bold text-[#F7F8FA] truncate">{activeTrack.name}</span>
                  <span className="text-[#6B7280]" aria-hidden="true">·</span>
                  <span className="font-mono-tabular text-[#9CA3AF]">
                    {(activeTrack.sampleRate / 1000).toFixed(1)} kHz
                  </span>
                  <span className="text-[#6B7280]" aria-hidden="true">·</span>
                  <TransportTimeReadout durationSec={activeTrack.durationSec} />
                </div>

                {/* Original vs Mastered A/B Audition */}
                <div className="flex items-center gap-1 p-0.5 rounded bg-[#090A0E] border border-[#242732]">
                  <button
                    type="button"
                    onClick={() => switchAuditionTarget('original')}
                    className={`px-2.5 py-1 rounded text-[11px] font-semibold transition-colors ${
                      auditionTarget === 'original'
                        ? 'bg-[#C5CDD8] text-[#070709]'
                        : 'text-[#9CA3AF] hover:text-[#F7F8FA]'
                    }`}
                  >
                    Original (A)
                  </button>
                  <button
                    type="button"
                    onClick={() => switchAuditionTarget('mastered')}
                    className={`px-2.5 py-1 rounded text-[11px] font-semibold transition-colors ${
                      auditionTarget === 'mastered'
                        ? 'bg-[#D4AF37] text-[#070709]'
                        : 'text-[#9CA3AF] hover:text-[#F7F8FA]'
                    }`}
                  >
                    Mastered (B)
                  </button>
                  {referenceTrack && (
                    <button
                      type="button"
                      onClick={() => switchAuditionTarget('reference')}
                      className={`px-2.5 py-1 rounded text-[11px] font-semibold transition-colors ${
                        auditionTarget === 'reference'
                          ? 'bg-[#34D399] text-[#070709]'
                          : 'text-[#9CA3AF] hover:text-[#34D399]'
                      }`}
                    >
                      Ref
                    </button>
                  )}
                </div>
              </div>

              <React.Suspense fallback={null}><WaveformTimelineCanvas
                prePeaks={activeTrack.peaks}
                postPeaks={postPeaks}
                durationSec={activeTrack.durationSec}
                loopEnabled={loopEnabled}
                loopStartSec={0}
                loopEndSec={activeTrack.durationSec}
                showPostOverlay={auditionTarget !== 'original' && !chainBypassed}
                onSeek={(sec) => {
                  engineRef.current!.seek(sec);
                  telemetryStore.publish({ currentTimeSec: sec });
                }}
              /></React.Suspense>

              {/* Transport Controls */}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={togglePlay}
                    aria-label={isPlaying ? 'Pause Playback' : 'Start Playback'}
                    className="px-3.5 py-1.5 rounded bg-[#D4AF37] text-[#070709] text-xs font-bold hover:bg-[#F2CA52] flex items-center gap-1.5"
                  >
                    {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                    {isPlaying ? 'Pause' : 'Play'}
                  </button>
                  <button
                    type="button"
                    aria-label="Stop Playback"
                    onClick={() => {
                      engineRef.current!.stop();
                      setIsPlaying(false);
                      telemetryStore.publish({ isPlaying: false, currentTimeSec: 0, live: null });
                    }}
                    className="p-1.5 rounded bg-[#181A22] border border-[#2B2E3A] text-[#F7F8FA] hover:border-[#D4AF37]"
                  >
                    <Square className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label="Toggle Loop Playback"
                    onClick={() => {
                      const next = !loopEnabled;
                      setLoopEnabled(next);
                      engineRef.current!.setLoop(next, 0, activeTrack.durationSec);
                    }}
                    className={`p-1.5 rounded border ${
                      loopEnabled
                        ? 'bg-[#D4AF37]/20 border-[#D4AF37] text-[#F2CA52]'
                        : 'bg-[#181A22] border-[#2B2E3A] text-[#9CA3AF]'
                    }`}
                  >
                    <Repeat className="w-3.5 h-3.5" />
                  </button>
                  <select
                    aria-label="Playback Speed"
                    value={playbackRate}
                    onChange={(e) => {
                      const r = Number(e.target.value);
                      setPlaybackRate(r);
                      engineRef.current!.setPlaybackRate(r);
                    }}
                    className="bg-[#181A22] border border-[#2B2E3A] rounded px-2 py-1 text-xs font-mono-tabular text-[#C5CDD8]"
                  >
                    <option value={0.75}>0.75x</option>
                    <option value={1}>1.0x</option>
                    <option value={1.25}>1.25x</option>
                  </select>
                </div>

                {/* Pre vs Post Delta Summary */}
                {postAnalysis && (
                  <div className="flex flex-wrap items-center gap-4 text-[11px] font-mono-tabular">
                    <span>
                      <span className="text-[#9CA3AF]">Pre: </span>
                      <span className="text-[#C5CDD8]">{activeTrack.analysis.integratedLufs.toFixed(1)} LUFS</span>
                    </span>
                    <span>
                      <span className="text-[#9CA3AF]">Master: </span>
                      <span className="text-[#F2CA52] font-semibold">
                        {postAnalysis.integratedLufs.toFixed(1)} LUFS
                      </span>
                    </span>
                    <span>
                      <span className="text-[#9CA3AF]">True Peak: </span>
                      <span className="text-[#F7F8FA]">{postAnalysis.truePeakDb.toFixed(2)} dBTP</span>
                    </span>
                    <span>
                      <span className="text-[#9CA3AF]">DR: </span>
                      <span className="text-[#F7F8FA]">{postAnalysis.dynamicRangeDb.toFixed(1)} dB</span>
                    </span>
                  </div>
                )}
              </div>
            </section>
          ) : (
            <section className="px-3.5 py-2.5 rounded bg-[#111217] border border-[#242732] flex flex-wrap items-center justify-between gap-2.5">
              <div className="flex items-center gap-2 min-w-0">
                <button
                  type="button"
                  onClick={togglePlay}
                  aria-label={isPlaying ? 'Pause Playback' : 'Start Playback'}
                  className="px-3 py-1 rounded bg-[#D4AF37] text-[#070709] text-xs font-bold hover:bg-[#F2CA52] flex items-center gap-1 shrink-0"
                >
                  {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                  {isPlaying ? 'Pause' : 'Play'}
                </button>
                <button
                  type="button"
                  aria-label="Stop Playback"
                  onClick={() => {
                    engineRef.current!.stop();
                    setIsPlaying(false);
                    telemetryStore.publish({ isPlaying: false, currentTimeSec: 0, live: null });
                  }}
                  className="p-1 rounded bg-[#181A22] border border-[#2B2E3A] text-[#F7F8FA] hover:border-[#D4AF37] shrink-0"
                >
                  <Square className="w-3.5 h-3.5" />
                </button>
                <span className="text-xs font-bold text-[#F7F8FA] truncate max-w-[200px]">
                  {activeTrack.name}
                </span>
                <TransportTimeReadout
                  durationSec={activeTrack.durationSec}
                  className="text-[11px] whitespace-nowrap"
                />
              </div>

              <div className="flex flex-wrap items-center gap-3">
                {postAnalysis && (
                  <div className="hidden xl:flex items-center gap-3 text-[11px] font-mono-tabular">
                    <span>
                      <span className="text-[#9CA3AF]">Pre: </span>
                      <span className="text-[#C5CDD8]">{activeTrack.analysis.integratedLufs.toFixed(1)}</span>
                    </span>
                    <span>
                      <span className="text-[#9CA3AF]">Master: </span>
                      <span className="text-[#F2CA52] font-semibold">
                        {postAnalysis.integratedLufs.toFixed(1)} LUFS
                      </span>
                    </span>
                    <span>
                      <span className="text-[#9CA3AF]">TP: </span>
                      <span className="text-[#F7F8FA]">{postAnalysis.truePeakDb.toFixed(2)} dBTP</span>
                    </span>
                  </div>
                )}

                <div className="flex items-center gap-1 p-0.5 rounded bg-[#090A0E] border border-[#242732]">
                  <button
                    type="button"
                    onClick={() => switchAuditionTarget('original')}
                    className={`px-2 py-0.5 rounded text-[11px] font-semibold transition-colors ${
                      auditionTarget === 'original'
                        ? 'bg-[#C5CDD8] text-[#070709]'
                        : 'text-[#9CA3AF] hover:text-[#F7F8FA]'
                    }`}
                  >
                    Original (A)
                  </button>
                  <button
                    type="button"
                    onClick={() => switchAuditionTarget('mastered')}
                    className={`px-2 py-0.5 rounded text-[11px] font-semibold transition-colors ${
                      auditionTarget === 'mastered'
                        ? 'bg-[#D4AF37] text-[#070709]'
                        : 'text-[#9CA3AF] hover:text-[#F7F8FA]'
                    }`}
                  >
                    Mastered (B)
                  </button>
                  {referenceTrack && (
                    <button
                      type="button"
                      onClick={() => switchAuditionTarget('reference')}
                      className={`px-2 py-0.5 rounded text-[11px] font-semibold transition-colors ${
                        auditionTarget === 'reference'
                          ? 'bg-[#34D399] text-[#070709]'
                          : 'text-[#9CA3AF] hover:text-[#34D399]'
                      }`}
                    >
                      Ref
                    </button>
                  )}
                </div>
              </div>
            </section>
          )}

          {/* Active Workspace Tab Content */}
          <React.Suspense
            fallback={
              <div
                role="status"
                className="rounded border border-[#242732] bg-[#111217] px-4 py-6 text-center text-xs text-[#9CA3AF]"
              >
                Loading workspace…
              </div>
            }
          >
          {activeTab === 'studio' && activeTrack && masterConsole}

          {activeTab === 'studio' && activeTrack && diagnosticLog && (
            <React.Suspense fallback={null}>
            <FixItStage
              trackName={activeTrack.name}
              durationSec={activeTrack.durationSec}
              sampleRate={activeTrack.sampleRate}
              source={activeTrack.analysis}
              master={postAnalysisState.status === 'ready' ? postAnalysis : null}
              prePeaks={prePeaksHi}
              postPeaks={postPeaksHi}
              isPlaying={isPlaying}
              onTogglePlay={togglePlay}
              auditionTarget={auditionTarget}
              onAudition={(t) => switchAuditionTarget(t)}
              fades={fades}
              onFadesChange={setFades}
              onSeek={(sec) => {
                engineRef.current!.seek(sec);
                telemetryStore.publish({ currentTimeSec: sec });
              }}
              running={directorRunning}
              stage={directorStage}
              pass={directorPass}
              maxPasses={10}
              lastActivity={directorActivityLog.length > 0 ? directorActivityLog[directorActivityLog.length - 1].message : null}
              report={directorReport}
              log={diagnosticLog}
              targetPresetId={targetPresetId}
              targetLabel={targetLabel}
              onTargetPreset={handleTargetPreset}
              onFix={() => { setOperatingMode('autonomous'); void handleRunMasterDirector(true); }}
              onOpenRack={() => setRackWindowOpen(true)}
              onNewTrack={handleNewTrack}
              hideCenterpiece
            />
            </React.Suspense>
          )}

          {activeTab === 'studio' && activeTrack && (
            <section data-testid="central-mastering-rack" className="rounded-xl border border-[#D4AF37]/45 bg-[#0D0B06] p-2.5">
              <div className="mb-2 flex items-center justify-between gap-2 px-1">
                <h2 className="text-[11px] font-black uppercase tracking-[.16em] text-[#F2CA52]">Effects Rack / Processing Chain</h2>
                <span className="text-[9px] font-mono-tabular uppercase tracking-wider text-[#A99A74]">Visible rack · Offline DSP / VST3</span>
              </div>
              <React.Suspense fallback={<div className="p-3 text-[11px] text-[#A99A74]" role="status">Loading rack…</div>}>
              <MasteringRack
                chain={chain}
                chainBypassed={chainBypassed}
                telemetry={stageTelemetry}
                guidedMode={settings.experienceMode === 'guided'}
                externalPlugins={hostSnapshot.plugins}
                hostConnected={hostSnapshot.status === 'connected'}
                hasTrack={Boolean(activeTrack)}
                aiRunning={directorRunning}
                aiLifecycleState={aiLifecycleState}
                onRunChainWithAi={handleRunMasterDirector}
                onChangeChain={(next) => {
                  updateChainWithHistory(next);
                  recordCorrection('Manual Mastering Rack Edit', next, { coalesceManual: true });
                }}
                onToggleChainBypass={handleToggleChainBypass}
                onSaveChain={handleSaveChainPreset}
                onResetChain={handleResetChain}
                onAddExternalPlugin={handleInsertExternalPlugin}
                onLoadExternalInstance={handleLoadExternalInstance}
                onSetExternalParam={handleSetExternalParam}
                onToggleExternalEditor={handleToggleExternalEditor}
                onToggleExternalBypass={handleToggleExternalBypass}
              />
              </React.Suspense>
            </section>
          )}

          {activeTab !== 'studio' && activeTab !== 'ai' && activeTab !== 'qc' && <WorkspaceHero workspace={activeTab} hasTrack={Boolean(activeTrack)} />}

          {activeTab === 'stems' && <StemIntelligencePanel />}

          {activeTab === 'lab' && (
            <SynLabView
              preAnalysis={activeTrack?.analysis ?? null}
              postAnalysis={postAnalysis}
              chain={chainBypassed ? [] : chain}
              postChannels={postChannelsRef.current}
              sampleRate={activeTrack?.sampleRate ?? 44100}
              defaultSubTab={labDefaultSubTab}
              onSubTabChange={setLabDefaultSubTab}
            />
          )}

          {activeTab === 'ai' && (
            <AiMasterView
              preAnalysis={activeTrack?.analysis ?? null}
              postAnalysis={postAnalysis}
              postAnalysisStatus={postAnalysisState.status}
              postAnalysisError={postAnalysisState.error}
              baselineDiagnosis={baselineDiagnosis}
              postFixVerification={postFixVerification}
              referenceAnalysis={referenceTrack?.analysis ?? null}
              operatingMode={operatingMode}
              objectiveId={objectiveId}
              customObjective={customObjective}
              useGeminiCloud={useGeminiCloud}
              canUndo={undoStack.length > 0}
              hasPreAiSnapshot={preAiChainSnapshot !== null}
              aiChainAccepted={aiChainAccepted}
              aiLifecycleState={aiLifecycleState}
              aiStrategy={aiStrategy}
              directorPlan={directorPlan}
              directorReport={directorReport}
              qcReport={qcReport}
              iterations={iterations}
              activityLog={directorActivityLog}
              checkpoints={directorCheckpoints}
              diagnosticRuns={diagnosticRuns}
              latestDiagnosticRun={latestDiagnosticRun}
              diagnosticArchiveStatus={diagnosticArchiveStatus}
              diagnosticBundleAvailable={Boolean(latestDiagnosticBundle)}
              onDownloadDiagnosticRun={handleDownloadDiagnosticRun}
              directorRunning={directorRunning}
              directorPaused={directorPaused}
              directorStage={directorStage}
              directorPass={directorPass}
              maxIterations={maxIterations}
              convergenceThreshold={convergenceThreshold}
              aiLoading={aiLoading}
              aiError={aiError}
              aiNotice={aiNotice}
              aiFallbackBanner={summarizeAiFallbackBanner(directorReport?.aiPasses) ?? aiFallbackBanner}
              aiChanges={renderAiChanges('assistant')}
              onChangeOperatingMode={setOperatingMode}
              onChangeObjectiveId={setObjectiveId}
              onChangeCustomObjective={setCustomObjective}
              onChangeUseGeminiCloud={setUseGeminiCloud}
              onChangeMaxIterations={setMaxIterations}
              onChangeConvergenceThreshold={setConvergenceThreshold}
              onAnalyzeTrack={handleAnalyzeTrack}
              onRunMasterDirector={handleRunMasterDirector}
              onFixAllProblems={() => { setOperatingMode('autonomous'); void handleRunMasterDirector(true); }}
              onPauseToggle={() => {
                const next = !directorPauseRef.current;
                directorPauseRef.current = next;
                setDirectorPaused(next);
              }}
              onStopDirector={() => {
                directorStopRef.current = true;
                vocalPreparationAbortRef.current?.abort();
                getActiveAiCall()?.cancel();
                directorPauseRef.current = false;
                setDirectorPaused(false);
              }}
              onUndoLast={handleUndo}
              onAcceptAiChain={handleAcceptAiChain}
              onRestorePreAiChain={handleRestorePreAiChain}
              onApplyChain={(c) => {
                const cloned = structuredClone(c);
                updateChainWithHistory(cloned, 'Applied Explainable Mastering Plan');
                setStatusNotice('Loaded Mastering Director chain into Mastering Rack. Reanalyzing audio...');
              }}
              onApplyRecommendation={handleApplyRecommendation}
              onAuditionCheckpoint={async (cp) => {
                const src = getRenderSource();
                if (!src || !activeTrack) return;
                const checkpointTrackId = activeTrack.id;
                const res = await renderAndAnalyzeOffThread({
                  sourceChannels: src,
                  sampleRate: activeTrack.sampleRate,
                  chain: cp.chain,
                  postFades: getPostFades(),
                });
                if (activeTrackIdRef.current !== checkpointTrackId) return;
                engineRef.current!.setOverrideBuffer('iteration', res.channels, activeTrack.sampleRate);
                switchAuditionTarget('iteration', settings.loudnessMatchAB ? -14 - cp.analysis.integratedLufs : 0);
                if (!isPlaying) {
                  engineRef.current!.play();
                  setIsPlaying(true);
                }
              }}
              onRestoreCheckpoint={(cp) => {
                updateChainWithHistory(structuredClone(cp.chain));
                switchAuditionTarget('mastered', 0);
                setStatusNotice(`Restored checkpoint Pass #${cp.passNumber} into Mastering Rack.`);
              }}
            />
          )}

          {activeTab === 'battle' && (
            <BattleModeView
              preAnalysis={activeTrack?.analysis ?? null}
              candidates={battleCandidates}
              activeAudition={auditionTarget}
              generating={battleGenerating}
              sampleRate={activeTrack?.sampleRate ?? 44100}
              onGenerateBattle={handleGenerateBattle}
              onAuditionCandidate={(id, match) => {
                const cand = battleCandidates.find((c) => c.id === id);
                if (!cand) return;
                const key = `candidate-${id.toLowerCase()}` as AuditionTarget;
                switchAuditionTarget(key, match ? cand.loudnessTrimDb : 0);
                if (!isPlaying) {
                  engineRef.current!.play();
                  setIsPlaying(true);
                }
              }}
              onSelectWinner={(cand) => {
                updateChainWithHistory(structuredClone(cand.chain));
                switchAuditionTarget('mastered', 0);
                setActiveTab('studio');
                setStatusNotice(`Selected Battle Winner "${cand.title}" and loaded into Mastering Rack.`);
              }}
            />
          )}

          {activeTab === 'reference' && (
            <ReferenceMatchView
              activeTrack={activeTrack}
              postAnalysis={postAnalysis}
              referenceTrack={referenceTrack}
              referenceComparison={referenceComparison}
              chain={chainBypassed ? [] : chain}
              auditionTarget={auditionTarget}
              onLoadDemoReference={handleLoadDemoReference}
              onUploadReferenceFile={handleUploadReferenceFile}
              onAuditionReference={() => {
                switchAuditionTarget('reference');
                if (!isPlaying) {
                  engineRef.current!.play();
                  setIsPlaying(true);
                }
              }}
              onAuditionMastered={() => {
                switchAuditionTarget('mastered');
                if (!isPlaying) {
                  engineRef.current!.play();
                  setIsPlaying(true);
                }
              }}
              onMatchReference={handleMatchReference}
            />
          )}

          {activeTab === 'qc' && (
            <QualityControlView
              qcReport={qcViewReport}
              qcBasis={qcReport ? 'master' : 'source'}
              preAnalysis={activeTrack?.analysis ?? null}
              postAnalysis={postAnalysisState.status === 'failed' ? null : postAnalysis}
              durationSec={activeTrack?.durationSec ?? 0}
              onSeek={seekTo}
              profiles={QC_TARGET_PROFILES}
              selectedProfileId={qcTargetId}
              onSelectProfile={setQcTargetId}
              onAutoFixQc={handleAutoFixQc}
              platformPanel={
                <React.Suspense fallback={null}>
                  <PlatformPreviewPanel
                    levels={platformLevels}
                    getMasterAudio={getPlatformMasterAudio}
                    engine={engineRef.current}
                    onPauseMain={() => {
                      if (isPlaying) {
                        engineRef.current?.pause();
                        setIsPlaying(false);
                        telemetryStore.publish({ isPlaying: false });
                      }
                    }}
                  />
                </React.Suspense>
              }
            />
          )}

          {activeTab === 'plugins' && (
            <PluginManagerView
              snapshot={hostSnapshot}
              hasTrack={Boolean(activeTrack)}
              onConnect={(opts) => hostBridgeRef.current!.connectAndPair(opts)}
              onDisconnect={() => hostBridgeRef.current!.disconnect()}
              onScan={(scanMode) => hostBridgeRef.current!.triggerScan(scanMode)}
              onRetryPlugin={(uid, bundlePath) => hostBridgeRef.current!.retryPlugin(uid, bundlePath)}
              onAddDirectory={(dir) => hostBridgeRef.current!.addCustomDirectory(dir)}
              onRemoveDirectory={(dir) => hostBridgeRef.current!.removeCustomDirectory(dir)}
              onToggleFavorite={(p: ExternalPluginRecord) =>
                hostBridgeRef.current!.setPluginPreference(p.uid, p.bundlePath, {
                  favorite: !p.favorite,
                })
              }
              onToggleDisabled={(p: ExternalPluginRecord) =>
                hostBridgeRef.current!.setPluginPreference(p.uid, p.bundlePath, {
                  disabledByUser: !p.disabledByUser,
                })
              }
              onInsertInChain={handleInsertExternalPlugin}
              onStartWasapiAudition={handleStartWasapiAudition}
              onStopWasapiAudition={handleStopWasapiAudition}
            />
          )}
          </React.Suspense>
        </main>

      </div>

      {/* Bottom tab bar (fixed on touch layouts) */}
      <div className="syn-daw-global-tabs syn-bottom-tabs">
            <WorkspaceNavigation
              activeTab={activeTab}
              onSelect={setActiveTab}
              onOpenRack={() => setRackWindowOpen(true)}
              onExport={() => setExportModalOpen(true)}
              onSettings={() => setSettingsModalOpen(true)}
              onStereoWorkspace={() => { setLabDefaultSubTab('stereo'); setActiveTab('lab'); }}
            />
      </div>

      {/* Bottom Meter Bridge */}
      <React.Suspense fallback={null}><MeterBridge
        postAnalysis={auditionTarget === 'original' ? activeTrack?.analysis ?? null : postAnalysis}
        qcReport={qcReport}
        monitorVolume={monitorVolume}
        auditionLabel={auditionTarget.toUpperCase()}
        onChangeMonitorVolume={handleChangeMonitorVolume}
      /></React.Suspense>

      {/* Export & Settings Modals */}
      {rackWindowOpen && Boolean(activeTrack) && (
      <React.Suspense fallback={null}>
      <FxRackWindow
        open={rackWindowOpen && Boolean(activeTrack)}
        onClose={() => setRackWindowOpen(false)}
        chain={chain}
        chainBypassed={chainBypassed}
        telemetry={stageTelemetry}
        onChangeChain={(next) => {
          updateChainWithHistory(next);
          recordCorrection('FX Rack Edit', next, { coalesceManual: true });
        }}
        onToggleChainBypass={handleToggleChainBypass}
        onAiSetAll={() => { setOperatingMode('autonomous'); void handleRunMasterDirector(true); }}
        aiRunning={directorRunning}
        sampleRate={activeTrack?.sampleRate ?? 48000}
        spectrum={postAnalysisState.status === 'ready' ? postAnalysis : activeTrack?.analysis ?? null}
      />
      </React.Suspense>
      )}
      {exportModalOpen && (
        <React.Suspense fallback={null}>
          <ExportModal
            open={true}
            config={exportConfig}
            rendering={renderingExport}
            downloadUrl={exportDownloadUrl}
            downloadFilename={exportDownloadName}
            deliveryCheck={exportDeliveryCheck}
            renderError={exportError}
            renderProgress={exportProgress}
            hasTrack={Boolean(activeTrack)}
            onChange={setExportConfig}
            onRender={handleRenderExport}
            onClose={() => setExportModalOpen(false)}
          />
        </React.Suspense>
      )}
      {settingsModalOpen && (
        <React.Suspense fallback={null}>
          <SettingsModal
            open={true}
            settings={settings}
            onChange={handleSettingsChange}
            onClose={() => setSettingsModalOpen(false)}
          >
            <section className="p-3 rounded bg-[#0C0D12] border border-[#5A4519] flex flex-col gap-3">
              <div>
                <div className="font-semibold text-[#D4AF37] mb-1">Audio Engine</div>
                <p className="text-[10px] text-[#A99A74]">Live monitoring uses the browser Web Audio engine. These controls do not change export sample rate or codec quality.</p>
              </div>
              <label className="flex flex-col gap-1 text-[#C7B98F]">
                Output Device
                <select
                  value={settings.audioOutputDeviceId ?? ''}
                  disabled={!audioEngineInfo.supportsOutputDeviceSelection}
                  onChange={(event) => handleSettingsChange({ ...settings, audioOutputDeviceId: event.target.value })}
                  className="bg-[#090704] border border-[#5A4519] rounded px-2.5 py-1.5 text-xs text-[#F7F1E2] disabled:opacity-50"
                >
                  <option value="">System Default</option>
                  {audioOutputDevices.filter((device) => device.deviceId && device.deviceId !== 'default').map((device, index) => (
                    <option key={device.deviceId} value={device.deviceId}>{device.label || 'Audio output ' + (index + 1)}</option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-[#C7B98F]">
                Latency Mode
                <select
                  value={settings.audioLatencyMode}
                  onChange={(event) => handleSettingsChange({ ...settings, audioLatencyMode: event.target.value as AppSettings['audioLatencyMode'] })}
                  className="bg-[#090704] border border-[#5A4519] rounded px-2.5 py-1.5 text-xs text-[#F7F1E2]"
                >
                  <option value="interactive">Interactive · lower monitoring latency</option>
                  <option value="balanced">Balanced · recommended</option>
                  <option value="playback">Playback · stability / power efficiency</option>
                </select>
              </label>
              <div className="grid grid-cols-2 gap-2 text-[10px] text-[#C7B98F]">
                <div className="rounded border border-[#3D3015] p-2">Engine: <strong className="text-[#F2CA52]">{audioEngineInfo.state}</strong></div>
                <div className="rounded border border-[#3D3015] p-2">Sample rate: <strong className="text-[#F2CA52]">{audioEngineInfo.sampleRate ? (audioEngineInfo.sampleRate / 1000).toFixed(1) + ' kHz' : 'Not initialized'}</strong></div>
                <div className="rounded border border-[#3D3015] p-2">Base latency: <strong className="text-[#F2CA52]">{audioEngineInfo.baseLatency !== null ? (audioEngineInfo.baseLatency * 1000).toFixed(1) + ' ms' : 'Unavailable'}</strong></div>
                <div className="rounded border border-[#3D3015] p-2">Output latency: <strong className="text-[#F2CA52]">{audioEngineInfo.outputLatency !== null ? (audioEngineInfo.outputLatency * 1000).toFixed(1) + ' ms' : 'Unavailable'}</strong></div>
              </div>
              {!audioEngineInfo.supportsOutputDeviceSelection && (
                <p className="text-[10px] text-[#A99A74]">This browser does not expose AudioContext output routing. Select the output device in your browser or operating-system sound settings.</p>
              )}
              <p className="text-[10px] text-[#A99A74]">Browser applications cannot take exclusive control of native ASIO or bypass the Windows audio stack. The displayed sample rate and latency are the actual values reported by the browser.</p>
            </section>
            <AiProviderPanel />
          </SettingsModal>
        </React.Suspense>
      )}
    </div>
  );
}
