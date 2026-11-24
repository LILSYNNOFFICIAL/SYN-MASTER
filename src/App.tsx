import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Maximize2,
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
} from 'lucide-react';
import type {
  AiChainLifecycleState,
  AIMasteringStrategy,
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
  ProcessorModule,
  ProjectRecord,
  SavedChainRecord,
  WorkspaceTab,
} from './types/mastering';
import { analyzeAudioBuffer, extractWaveformPeaks } from './dsp/analyzer';
import { createProcessorModule, validateChain } from './dsp/chainValidation';
import { generateDemoMasterStem } from './dsp/demoAudio';
import {
  renderMixedChain,
  type ExternalPluginProcessCallback,
} from './dsp/mixedChainRenderer';
import { type ProcessorMeterTelemetry } from './dsp/offlineDsp';
import { renderAndAnalyzeOffThread } from './dsp/workerClient';
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
import { analyzeTrackIntelligence } from './director/analyzeIntelligence';
import { computeChainFingerprint, verifyPostFixAnalysis } from './director/postFixVerification';
import { applyStructuredChainCommands } from './director/chainCommands';
import { inspectPluginInventory } from './director/pluginIntelligence';
import { validateChainAgainstInventory } from './director/processorInventory';
import { encodeWavBlob } from './dsp/wavEncoder';
import { DEFAULT_EXPORT_CONFIG } from './dsp/exportDefaults';
import { encodeMidiTempoFile } from './dsp/midiEncoder';
import {
  createTemporaryMasteringWorkspace,
  listMasteringDiagnosticRuns,
  loadMasteringDiagnosticBundle,
  type MasteringDiagnosticBundle,
  type MasteringDiagnosticRunSummary,
} from './director/tempMasteringWorkspace';
import { SynAudioEngine, type AuditionTarget } from './engine/audioEngine';
import { telemetryStore } from './engine/telemetryStore';
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
import { MasteringRack } from './components/MasteringRack';
import { MeterBridge } from './components/MeterBridge';
import { SpectrumAndEQCanvas, WaveformTimelineCanvas } from './components/CanvasVisualizers';
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
const PluginManagerView = React.lazy(() =>
  import('./components/PluginManagerView').then(({ PluginManagerView }) => ({ default: PluginManagerView })),
);
const ExportModal = React.lazy(() => import('./components/Modals').then(({ ExportModal }) => ({ default: ExportModal })));
const SettingsModal = React.lazy(() => import('./components/Modals').then(({ SettingsModal }) => ({ default: SettingsModal })));
import { WorkspaceNavigation } from './components/WorkspaceNavigation';
import { ImportScreen } from './components/studio/ImportScreen';
import { FixItStage } from './components/studio/FixItStage';
import { FxRackWindow } from './components/studio/FxRackWindow';
import { hasFades, NO_FADES, type FadeSettings } from './dsp/fades';
import { LOUDNESS_TARGET_PRESETS } from './dsp/loudnessTargets';
import { buildDiagnosticLog } from './director/diagnosticLog';
import { requestRefine, requestStrategy } from './ai/masteringClient';
import { AiProviderChip, AiProviderPanel } from './components/AiProviderPanel';
import { describeProvider } from './ai/providerAdapters';
import { getActiveProviderConfig, getBuiltinAccessHeaders, runProviderCall } from './ai/providerStore';

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
  const externalParamLatestRef = useRef<Map<string, number>>(new Map());
  const externalParamInFlightRef = useRef<Set<string>>(new Set());

  const [activeTab, setActiveTab] = useState<WorkspaceTab>('studio');
  const [hostSnapshot, setHostSnapshot] = useState<HostBridgeSnapshot>(() =>
    hostBridgeRef.current!.getSnapshot(),
  );
  const [spectrumMode, setSpectrumMode] = useState<'spectrum' | 'spectrogram'>('spectrum');
  const [fullscreenWorkspace, setFullscreenWorkspace] = useState(false);
  // New one-button flow: import screen first, then the Fix-It stage.
  const [showWorkstationWithoutTrack, setShowWorkstationWithoutTrack] = useState(false);
  const [fades, setFades] = useState<FadeSettings>(NO_FADES);
  const [targetPresetId, setTargetPresetId] = useState<string | null>(null);
  const [postPeaksHi, setPostPeaksHi] = useState<number[] | null>(null);
  const [rackWindowOpen, setRackWindowOpen] = useState(false);

  const [projectId, setProjectId] = useState(() => `proj-${Date.now()}`);
  const [projectName, setProjectName] = useState('Untitled Mastering Session');
  const [mode, setMode] = useState<MasteringMode>('hybrid');
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [savedChains, setSavedChains] = useState<SavedChainRecord[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);

  const [activeTrack, setActiveTrack] = useState<AudioTrackAsset | null>(null);
  const [referenceTrack, setReferenceTrack] = useState<AudioTrackAsset | null>(null);
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
  const [appliedCorrections, setAppliedCorrections] = useState<AppliedCorrectionRecord[]>([]);
  const [postPeaks, setPostPeaks] = useState<number[] | null>(null);
  const [stageTelemetry, setStageTelemetry] = useState<ProcessorMeterTelemetry[]>([]);

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
  const [operatingMode, setOperatingMode] = useState<DirectorOperatingMode>('autonomous');
  const [objectiveId, setObjectiveId] = useState<MasteringObjectiveId>('streaming');
  const [customObjective, setCustomObjective] = useState<CustomObjectiveSpec>({
    targetLufs: -13.0,
    maxTruePeakDb: -1.0,
    minDynamicRangeDb: 7.5,
    tonalBias: 'neutral',
    stereoPreference: 'preserve',
    preserveTransients: true,
  });
  const [useGeminiCloud, setUseGeminiCloud] = useState(false);
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
  const [aiChainAccepted, setAiChainAccepted] = useState<boolean | null>(null);
  const directorPauseRef = useRef(false);
  const directorStopRef = useRef(false);
  const directorRunningRef = useRef(false);
  const directorRunIdRef = useRef(0);
  const activeTrackIdRef = useRef<string | null>(null);
  const offlineRenderSeqRef = useRef(0);

  const [aiStrategy, setAiStrategy] = useState<AIMasteringStrategy | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
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
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [diagnosticRuns, setDiagnosticRuns] = useState<MasteringDiagnosticRunSummary[]>([]);
  const [latestDiagnosticRun, setLatestDiagnosticRun] = useState<MasteringDiagnosticRunSummary | null>(null);
  const [latestDiagnosticBundle, setLatestDiagnosticBundle] = useState<MasteringDiagnosticBundle | null>(null);
  const [diagnosticArchiveStatus, setDiagnosticArchiveStatus] = useState<
    'loading' | 'idle' | 'saving' | 'saved' | 'session-only' | 'failed'
  >('loading');

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
      if (loadedSettings) setSettings(loadedSettings);
    })();
    return () => {
      unsub();
    };
  }, []);

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
  const getRenderSource = useCallback((): Float32Array[] | null => sourceChannelsRef.current, []);
  const getPostFades = useCallback((): FadeSettings | null => (hasFades(fadesRef.current) ? fadesRef.current : null), []);

  const prePeaksHi = useMemo(
    () => (activeTrack && sourceChannelsRef.current ? extractWaveformPeaks(sourceChannelsRef.current, 1600) : []),
    [activeTrack],
  );

  // Recompute offline DSP analysis off the main UI thread (debounced 120ms)
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
          const result = await renderAndAnalyzeOffThread({
            sourceChannels: src,
            sampleRate: track.sampleRate,
            chain: effectiveChain,
            includePeaks: true,
            peakBins: 400,
            externalProcessor: processExternalStage,
            postFades: getPostFades(),
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
          setPostPeaksHi(extractWaveformPeaks(result.channels, 1600));
          setStageTelemetry(result.telemetry);
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
          if (effectiveChain.length > 0) {
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
    }, 120);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [chain, chainBypassed, activeTrack, hostSnapshot.status, processExternalStage, fades, getRenderSource]);

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
      setChain(nextChain);
      if (correctionLabel) {
        recordCorrection(correctionLabel, nextChain);
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
    (channels: Float32Array[], sampleRate: number, name: string, fileSizeBytes: number, format: string, isDemo = false) => {
      // Cancel any in-flight CHAIN WITH AI run targeting the previous source track
      if (directorRunningRef.current) {
        directorStopRef.current = true;
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
      setAiChainAccepted(null);

      const engine = engineRef.current!;
      sourceChannelsRef.current = channels;
      sourceRateRef.current = sampleRate;
      setFades(NO_FADES);
      setPostPeaksHi(null);
      engine.setSourceChannels(channels, sampleRate);
      setIsPlaying(false);
      telemetryStore.reset();
      setAuditionTarget('mastered');

      const analysis = analyzeAudioBuffer(channels, sampleRate);
      const peaks = extractWaveformPeaks(channels, 400);
      const trackId = `trk-${Date.now()}`;
      activeTrackIdRef.current = trackId;
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
      const stem = generateDemoMasterStem(variant, 44100, variant === 'sine-sweep' ? 8 : 14);
      loadChannelsAsSource(stem.channels, stem.sampleRate, stem.name, stem.channels[0].byteLength * 2, 'WAV (Synth)', true);
    },
    [loadChannelsAsSource],
  );

  const handleUploadSourceFile = useCallback(
    async (file: File) => {
      try {
        const decoded = await engineRef.current!.decodeFile(file);
        const ext = file.name.split('.').pop()?.toUpperCase() ?? 'AUDIO';
        loadChannelsAsSource(decoded.channels, decoded.sampleRate, file.name, file.size, ext, false);
      } catch (err) {
        setStatusNotice(
          `Could not decode "${file.name}". Please ensure it is a valid WAV, MP3, FLAC, AAC, M4A, OGG, or AIFF audio file.`,
        );
      }
    },
    [loadChannelsAsSource],
  );

  const handleLoadDemoReference = useCallback(() => {
    const stem = generateDemoMasterStem('reference-bright', 44100, 14);
    referenceChannelsRef.current = stem.channels;
    engineRef.current!.setReferenceChannels(stem.channels, stem.sampleRate);
    const analysis = analyzeAudioBuffer(stem.channels, stem.sampleRate);
    setReferenceTrack({
      id: `ref-${Date.now()}`,
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
    try {
      const decoded = await engineRef.current!.decodeFile(file);
      referenceChannelsRef.current = decoded.channels;
      engineRef.current!.setReferenceChannels(decoded.channels, decoded.sampleRate);
      const analysis = analyzeAudioBuffer(decoded.channels, decoded.sampleRate);
      setReferenceTrack({
        id: `ref-${Date.now()}`,
        name: file.name,
        fileSizeBytes: file.size,
        format: file.name.split('.').pop()?.toUpperCase() ?? 'AUDIO',
        sampleRate: decoded.sampleRate,
        channels: decoded.channels.length,
        durationSec: analysis.durationSec,
        bitDepthLabel: '32-bit Float',
        peaks: extractWaveformPeaks(decoded.channels, 400),
        analysis,
      });
      setStatusNotice(`Loaded reference "${file.name}"`);
    } catch {
      setStatusNotice(`Failed to decode reference file "${file.name}".`);
    }
  }, []);

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
    const src = getRenderSource();
    if (!src || !activeTrack || directorRunningRef.current) return;

    const runId = ++directorRunIdRef.current;
    const sourceTrackId = activeTrack.id;
    const diagnosticCreatedAt = Date.now();
    const diagnosticRunId = `fix-all-${sourceTrackId}-${diagnosticCreatedAt}`;
    const isStale = () => directorRunIdRef.current !== runId || activeTrackIdRef.current !== sourceTrackId;

    directorRunningRef.current = true;
    setAiError(null);
    setAiChainAccepted(null);
    setPreAiChainSnapshot(structuredClone(chain));
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

    const plan = buildExplainableMasterPlan({
      analysis: activeTrack.analysis,
      objectiveId,
      customSpec: customObjective,
      referenceAnalysis: referenceTrack?.analysis ?? null,
      externalPlugins: hostSnapshot.plugins,
      hostConnected: hostSnapshot.status === 'connected',
    });
    if (isStale()) return;
    setDirectorPlan(plan);
    setAiStrategy(plan.strategy);

    // Optional cloud AI (active provider; built-in Gemini by default) initial strategy in Autonomous/Assisted when user opted in
    const aiProviderLog: string[] = [];
    const aiProviderUsed = describeProvider(getActiveProviderConfig());
    let geminiInitialChain: ProcessorModule[] | undefined;
    if (useGeminiCloud && runOperatingMode !== 'manual') {
      setAiLoading(true);
      setAiLifecycleState('Planning');
      try {
        const pluginSummary = inspectPluginInventory(
          hostSnapshot.plugins,
          hostSnapshot.status === 'connected',
          activeTrack.analysis,
          plan.objective,
        );
        const strategyInput = {
          analysis: activeTrack.analysis,
          mode,
          objective: objectiveId,
          customObjective,
          operatingMode: runOperatingMode,
          targetLufs: plan.objective.targetLufs,
          referenceAnalysis: referenceTrack?.analysis ?? null,
          availablePlugins: pluginSummary.matches.map((m) => ({
            name: m.name,
            role: m.role,
            manufacturer: m.manufacturer,
          })),
        };
        // Built-in Gemini (default): exactly the existing server call.
        const builtinStrategy = async () => {
          const res = await fetch('/api/ai/master', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...await getBuiltinAccessHeaders() },
            signal: AbortSignal.timeout(12_000),
            body: JSON.stringify(strategyInput),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || `Server responded ${res.status}`);
          return data.strategy;
        };
        const providerRun = await runProviderCall('strategy', (opts) =>
          requestStrategy(getActiveProviderConfig(), strategyInput, builtinStrategy, opts),
        );
        if (isStale()) return;
        aiProviderLog.push(...providerRun.notices.map((n) => `Plan: ${n}`));
        if (providerRun.producedBy) aiProviderLog.push(`Plan: initial strategy produced by ${providerRun.producedBy}.`);
        if (!providerRun.result) throw new Error(providerRun.notices[0] ?? 'AI strategy skipped.');
        const strat = providerRun.result as unknown as AIMasteringStrategy;
        const invCheck = validateChainAgainstInventory(strat.chain);
        if (invCheck.valid && invCheck.sanitizedChain.length > 0) {
          strat.chain = invCheck.sanitizedChain;
          geminiInitialChain = strat.chain;
          setAiStrategy(strat);
        } else {
          setAiError(
            `Cloud AI response failed inventory validation (${invCheck.errors[0] ?? 'empty chain'}); using local DSP planner.`,
          );
        }
      } catch (err) {
        if (!isStale()) {
          setAiError(err instanceof Error ? err.message : 'Cloud Gemini request failed');
        }
      } finally {
        if (!isStale()) setAiLoading(false);
      }
    }

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
      writeTempNote('baseline/analysis.json', activeTrack.analysis);
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
        customSpec: customObjective,
        qcProfile: activeQcProfile,
        exportConfig,
        referenceAnalysis: referenceTrack?.analysis ?? null,
        externalPlugins: hostSnapshot.plugins,
        hostConnected: hostSnapshot.status === 'connected',
        initialChain: geminiInitialChain ?? (runOperatingMode === 'assisted' ? chain : undefined),
        externalProcessor: processExternalStage,
        postFades: getPostFades(),
        maxIterations: forceAutonomous ? 10 : maxIterations,
        maxCpuBudgetMs: forceAutonomous ? 120_000 : 60_000,
        convergenceThreshold,
        isPaused: () => directorPauseRef.current,
        shouldStop: () => directorStopRef.current || isStale(),
        aiRefineCallback:
          useGeminiCloud && runOperatingMode === 'autonomous'
            ? async (ctx) => {
                const builtinRefine = async () => {
                  const res = await fetch('/api/ai/refine', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...await getBuiltinAccessHeaders() },
                    signal: AbortSignal.timeout(12_000),
                    body: JSON.stringify(ctx),
                  });
                  const data = await res.json();
                  if (!res.ok) throw new Error(data.error || `Refine error ${res.status}`);
                  return data.refined;
                };
                const run = await runProviderCall('refine', (opts) =>
                  requestRefine(getActiveProviderConfig(), ctx, builtinRefine, opts),
                );
                aiProviderLog.push(...run.notices.map((n) => `Refine: ${n}`));
                if (run.producedBy) aiProviderLog.push(`Refine: suggestion produced by ${run.producedBy}.`);
                return { chain: run.result?.chain ?? null, producedBy: run.producedBy, notices: run.notices };
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

      writeTempNote('final/verification.json', {
        status: report.status,
        stopReason: report.stopReason,
        bestPassNumber: report.bestPassNumber,
        iterationsExecuted: report.iterationsExecuted,
        preAnalysis: report.preAnalysis,
        postAnalysis: report.postAnalysis,
        qualityControl: report.qcReport,
        postFixVerification: report.postFixVerification,
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
            aiProvider: useGeminiCloud ? { ...aiProviderUsed, log: aiProviderLog } : null,
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

      setDirectorReport(report);
      setDirectorCheckpoints(report.checkpoints);
      setDirectorActivityLog(report.activityLog);
      setAiLifecycleState(report.status === 'stopped-by-user' ? 'Stopped' : 'Completed');

      if (runOperatingMode !== 'manual' && report.finalChain.length > 0) {
        // The delivered chain must be audible and re-measured exactly as the loop verified it.
        setChainBypassed(false);
        updateChainWithHistory(structuredClone(report.finalChain));
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
          : `CHAIN WITH AI ${report.status}: Best Pass #${report.bestPassNumber} (${report.postAnalysis.integratedLufs.toFixed(1)} LUFS, QC ${report.qcReport.overallStatus.toUpperCase()}).`} ${diagnosticNotice}`,
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
              baselineAnalysis: activeTrack.analysis,
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

  const handleRenderExport = async () => {
    const src = getRenderSource();
    if (!src || !activeTrack) return;
    setRenderingExport(true);
    try {
      const safeStem = (exportConfig.filename.trim() || 'SYN_Master').replace(/[<>:"/\\|?*]/g, '_');
      let blob: Blob;
      let extension: string;
      let deliveryCheck: { text: string; warning: boolean } | null = null;

      if (exportConfig.format === 'mid') {
        blob = encodeMidiTempoFile(safeStem, activeTrack.durationSec, exportConfig.midiTempoBpm ?? 120, exportConfig.saveLoopMarkers ?? true);
        extension = 'mid';
      } else {
        const effectiveChain = exportConfig.includeMasteringChain !== false && !chainBypassed ? chain : [];
        const processed = await renderMixedChain(src, activeTrack.sampleRate, effectiveChain, processExternalStage, getPostFades());

        // Pass an untouched 32-bit float source-rate WAV to FFmpeg. It performs the
        // selected 512-point sinc sample-rate conversion and final PCM/codec encoding.
        const intermediateConfig: ExportConfig = {
          ...exportConfig,
          format: 'wav',
          wavBitDepth: 32,
          sampleRate: activeTrack.sampleRate as ExportConfig['sampleRate'],
          dither: 'none',
        };
        const intermediateWav = encodeWavBlob(processed.channels, activeTrack.sampleRate, intermediateConfig);
        const params = new URLSearchParams({
          format: exportConfig.format,
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
        });
        const response = await fetch('/api/export/encode?' + params.toString(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: intermediateWav,
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({})) as { error?: string };
          throw new Error(payload.error || 'Audio export failed (HTTP ' + response.status + ').');
        }
        blob = await response.blob();
        // Delivery check: the server measures the encoded file itself, after resampling and codec.
        const measuredLufs = Number(response.headers.get('X-Syn-Integrated-Lufs'));
        const measuredTp = Number(response.headers.get('X-Syn-True-Peak-Dbtp'));
        if (response.headers.has('X-Syn-True-Peak-Dbtp') && Number.isFinite(measuredTp)) {
          const overCeiling = measuredTp > exportConfig.ceilingDb + 0.05;
          deliveryCheck = {
            warning: overCeiling,
            text:
              `Encoded file: ${Number.isFinite(measuredLufs) ? measuredLufs.toFixed(1) + ' LUFS integrated, ' : ''}${measuredTp.toFixed(1)} dBTP true peak` +
              (overCeiling
                ? ` (over the ${exportConfig.ceilingDb.toFixed(1)} dBTP ceiling after encoding; lower the ceiling or limiter output and re-render).`
                : ` (within the ${exportConfig.ceilingDb.toFixed(1)} dBTP ceiling).`),
          };
        } else {
          deliveryCheck = { warning: true, text: 'Encoded file could not be measured; check true peak before delivery.' };
        }
        extension = exportConfig.format === 'webm-opus' ? 'webm' : exportConfig.format;
      }

      if (exportDownloadUrl) URL.revokeObjectURL(exportDownloadUrl);
      const url = URL.createObjectURL(blob);
      const safeName = safeStem + '.' + extension;
      setExportDownloadUrl(url);
      setExportDownloadName(safeName);
      setExportDeliveryCheck(deliveryCheck);
      setStatusNotice('Rendered ' + exportConfig.format.toUpperCase() + ' master "' + safeName + '".');
    } catch (err) {
      setStatusNotice(err instanceof Error ? err.message : 'Master export failed');
    } finally {
      setRenderingExport(false);
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
    engineRef.current?.stop();
    setIsPlaying(false);
    telemetryStore.publish({ isPlaying: false, currentTimeSec: 0, live: null });
    setActiveTrack(null);
    setDirectorReport(null);
    setShowWorkstationWithoutTrack(false);
  };

  if (!activeTrack && !showWorkstationWithoutTrack) {
    return (
      <ImportScreen
        onFile={handleUploadSourceFile}
        onDemo={() => handleLoadDemoSource('main-mix')}
        onOpenWorkstation={() => setShowWorkstationWithoutTrack(true)}
      />
    );
  }

  return (
    <div className="syn-workstation min-h-screen lg:h-screen w-full flex flex-col bg-[#070709] text-[#F7F8FA] lg:overflow-hidden">
      {/* Zone 3-Part Top Bar Contract */}
      <header className="syn-app-header h-14 shrink-0 px-4 border-b border-[#242732] bg-[#0B0C10] flex items-center justify-between gap-8">
        {/* Zone 1: Single-line Brand Lockup */}
        <div className="flex items-center gap-2.5 whitespace-nowrap shrink-0">
          <img
            src="/assets/aistudio/SYN_MASTER_Neon_Chrome_Logo_533a2f19.png"
            alt="SYN MASTER Logo"
            referrerPolicy="no-referrer"
            className="h-8 w-auto object-contain rounded-sm"
          />
          <span className="font-display text-base font-extrabold tracking-tight text-[#F7F8FA]">
            SYN <span className="text-[#F2CA52]">MASTER</span>
          </span>
        </div>

        {/* BlueNote-grade command menu: grouped actions, keyboard-friendly native disclosure menus */}
        <details className="syn-mobile-command-menu"><summary>Menu</summary>
          <nav aria-label="Application Menu" className="syn-menubar">
          <details className="syn-menu-group">
            <summary>File</summary>
            <div className="syn-menu-panel" role="menu" aria-label="File">
              <button role="menuitem" type="button" onClick={(event) => { void handleSaveProject(); event.currentTarget.closest('details')?.removeAttribute('open'); }}>Save Project <kbd>Ctrl+S</kbd></button>
              <button role="menuitem" type="button" onClick={(event) => { setExportModalOpen(true); event.currentTarget.closest('details')?.removeAttribute('open'); }}>Export Master</button>
            </div>
          </details>
          <details className="syn-menu-group">
            <summary>Edit</summary>
            <div className="syn-menu-panel" role="menu" aria-label="Edit">
              <button role="menuitem" type="button" disabled={undoStack.length === 0} onClick={(event) => { handleUndo(); event.currentTarget.closest('details')?.removeAttribute('open'); }}>Undo <kbd>Ctrl+Z</kbd></button>
              <button role="menuitem" type="button" disabled={redoStack.length === 0} onClick={(event) => { handleRedo(); event.currentTarget.closest('details')?.removeAttribute('open'); }}>Redo <kbd>Ctrl+Y</kbd></button>
              <button role="menuitem" type="button" onClick={(event) => { handleToggleChainBypass(); event.currentTarget.closest('details')?.removeAttribute('open'); }}>Toggle Chain Bypass</button>
              <button role="menuitem" type="button" onClick={(event) => { handleResetChain(); event.currentTarget.closest('details')?.removeAttribute('open'); }}>Reset Processing Chain</button>
            </div>
          </details>
          <details className="syn-menu-group">
            <summary>Workspace</summary>
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
                <button key={item.id} role="menuitem" type="button" aria-current={activeTab === item.id ? 'page' : undefined} onClick={(event) => { setActiveTab(item.id); event.currentTarget.closest('details')?.removeAttribute('open'); }}>
                  {item.label}{activeTab === item.id ? <span aria-hidden="true">✓</span> : null}
                </button>
              ))}
            </div>
          </details>
          <details className="syn-menu-group">
            <summary>View</summary>
            <div className="syn-menu-panel" role="menu" aria-label="View">
              <button role="menuitem" type="button" onClick={(event) => { setFullscreenWorkspace((value) => !value); event.currentTarget.closest('details')?.removeAttribute('open'); }}>{fullscreenWorkspace ? 'Exit Fullscreen' : 'Fullscreen Workspace'}</button>
              <button role="menuitem" type="button" onClick={(event) => { setSettingsModalOpen(true); event.currentTarget.closest('details')?.removeAttribute('open'); }}>Preferences & Settings</button>
            </div>
          </details>
          <details className="syn-menu-group">
            <summary>Tools</summary>
            <div className="syn-menu-panel" role="menu" aria-label="Tools">
              <button role="menuitem" type="button" onClick={(event) => { setActiveTab('plugins'); event.currentTarget.closest('details')?.removeAttribute('open'); }}>VST3 Plugin Manager</button>
              <button role="menuitem" type="button" onClick={(event) => { setActiveTab('stems'); event.currentTarget.closest('details')?.removeAttribute('open'); }}>Stem Intelligence</button>
              <button role="menuitem" type="button" onClick={(event) => { setActiveTab('lab'); event.currentTarget.closest('details')?.removeAttribute('open'); }}>Spectral Analysis</button>
            </div>
          </details>
          </nav>
        </details>

        {/* Zone 3: Primary CTA */}
        <div className="flex items-center shrink-0">
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
        className="px-4 py-2 border-b border-[#222530] bg-[#101116] flex flex-wrap items-center justify-between gap-3 shrink-0"
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
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {statusNotice && (
            <span className="hidden xl:inline text-[11px] text-[#D4AF37] truncate max-w-xs">
              {statusNotice}
            </span>
          )}
          <label className="flex items-center gap-1.5 text-[11px] text-[#9CA3AF]">
            Mode:
            <select
              aria-label="Mastering Mode"
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
            onClick={() => setActiveTab('ai')}
            className="px-2.5 py-1 rounded bg-[#D4AF37]/15 border border-[#D4AF37]/50 text-xs font-semibold text-[#F2CA52] hover:bg-[#D4AF37] hover:text-[#070709] flex items-center gap-1 whitespace-nowrap"
          >
            <Sparkles className="w-3.5 h-3.5" />
            AI Assistant
          </button>
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
        {!fullscreenWorkspace && (
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
        )}

        {/* Center Mastering Stage */}
        <main data-layout={activeTab} className="syn-daw-main lg:flex-1 shrink-0 lg:shrink min-w-0 lg:overflow-y-auto p-4 flex flex-col gap-4 bg-[#070709] order-first lg:order-none">
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
                  <button type="button" disabled={directorRunning} onClick={handleAnalyzeTrack>
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
          <div className="syn-daw-global-tabs">
            <WorkspaceNavigation activeTab={activeTab} onSelect={setActiveTab} />
          </div>

          {activeTab === 'studio' && activeTrack && diagnosticLog && (
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
            />
          )}

          {/* Transport & Waveform Stage (Full waveform on Studio & Reference; compact transport bar on other tabs) */}
          {!activeTrack && (activeTab === 'plugins' || activeTab === 'stems') ? null : !activeTrack ? (
            <section className="p-8 rounded bg-[#111217] border border-[#D4AF37]/30 flex flex-col items-center text-center gap-4">
              <img
                src="/assets/aistudio/SYN_MASTER_Neon_Chrome_Logo_533a2f19.png"
                alt="SYN MASTER Workstation"
                referrerPolicy="no-referrer"
                className="h-24 w-auto object-contain mix-blend-screen"
              />
              <div className="max-w-xl">
                <h1 className="font-display text-2xl font-bold text-[#F7F8FA]">
                  Load Audio to Begin Mastering
                </h1>
                <p className="mt-1.5 text-sm text-[#9CA3AF]">
                  Import a WAV, FLAC, MP3, AAC, or OGG file from the left library, or load our synthesized 118 BPM multi-stem mix to test real-time DSP, ITU-R BS.1770 LUFS metering, and AI mastering immediately.
                </p>
              </div>
              <div className="flex flex-wrap justify-center gap-3">
                <button
                  type="button"
                  onClick={() => handleLoadDemoSource('main-mix')}
                  className="px-5 py-2.5 rounded bg-[#D4AF37] text-[#070709] text-xs font-bold hover:bg-[#F2CA52]"
                >
                  Load Demo Mix (118 BPM)
                </button>
                <button
                  type="button"
                  onClick={() => handleLoadDemoSource('sine-sweep')}
                  className="px-4 py-2.5 rounded bg-[#181A22] border border-[#2E3240] text-xs font-semibold text-[#F7F8FA] hover:border-[#D4AF37]"
                >
                  Load Calibration Sweep
                </button>
              </div>
            </section>
          ) : activeTab === 'studio' ? null : activeTab === 'reference' ? (
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

              <WaveformTimelineCanvas
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
              />

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
          {activeTab === 'studio' && activeTrack && (
            <section data-testid="central-spectrum" aria-label="Master spectrum and EQ"
              className="syn-daw-spectrum p-3.5 rounded bg-[#111217] border border-[#242732] flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-xs font-bold uppercase tracking-wider text-[#D4AF37]">
                    Real-Time FFT Spectrum &amp; Composite EQ Curve
                  </h2>
                  <p className="text-[11px] text-[#9CA3AF]">
                    Dashed Silver: Pre-Master · Gold Area: Mastered · Bright Gold Curve: Parametric EQ Response
                  </p>
                </div>
                <div className="flex items-center gap-1 p-0.5 rounded bg-[#090A0E] border border-[#242732]">
                  <button
                    type="button"
                    onClick={() => setSpectrumMode('spectrum')}
                    className={`px-2.5 py-1 rounded text-[11px] font-semibold ${
                      spectrumMode === 'spectrum'
                        ? 'bg-[#D4AF37] text-[#070709]'
                        : 'text-[#9CA3AF] hover:text-[#F7F8FA]'
                    }`}
                  >
                    Spectrum + EQ
                  </button>
                  <button
                    type="button"
                    onClick={() => setSpectrumMode('spectrogram')}
                    className={`px-2.5 py-1 rounded text-[11px] font-semibold ${
                      spectrumMode === 'spectrogram'
                        ? 'bg-[#D4AF37] text-[#070709]'
                        : 'text-[#9CA3AF] hover:text-[#F7F8FA]'
                    }`}
                  >
                    Spectrogram
                  </button>
                </div>
              </div>

              <SpectrumAndEQCanvas
                preAnalysis={activeTrack.analysis}
                postAnalysis={postAnalysis}
                referenceAnalysis={referenceTrack?.analysis ?? null}
                chain={chainBypassed ? [] : chain}
                sampleRate={activeTrack.sampleRate}
                mode={spectrumMode}
                heightClass="h-64"
              />
            </section>
          )}

          {activeTab === 'studio' && activeTrack && (
            <section data-testid="central-mastering-rack" className="rounded-xl border border-[#D4AF37]/45 bg-[#0D0B06] p-2.5">
              <div className="mb-2 flex items-center justify-between gap-2 px-1">
                <h2 className="text-[11px] font-black uppercase tracking-[.16em] text-[#F2CA52]">Mastering Chain · Main Workspace</h2>
                <span className="text-[9px] font-mono-tabular uppercase tracking-wider text-[#A99A74]">Visible rack · Offline DSP / VST3</span>
              </div>
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
            </section>
          )}

          {activeTab === 'stems' && <StemIntelligencePanel />}

          {activeTab === 'lab' && (
            <SynLabView
              preAnalysis={activeTrack?.analysis ?? null}
              postAnalysis={postAnalysis}
              chain={chainBypassed ? [] : chain}
              postChannels={postChannelsRef.current}
              sampleRate={activeTrack?.sampleRate ?? 44100}
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
                const res = await renderAndAnalyzeOffThread({
                  sourceChannels: src,
                  sampleRate: activeTrack.sampleRate,
                  chain: cp.chain,
                  postFades: getPostFades(),
                });
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
              qcReport={qcReport}
              profiles={QC_TARGET_PROFILES}
              selectedProfileId={qcTargetId}
              onSelectProfile={setQcTargetId}
              onAutoFixQc={handleAutoFixQc}
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

      {/* Bottom Meter Bridge */}
      <MeterBridge
        postAnalysis={auditionTarget === 'original' ? activeTrack?.analysis ?? null : postAnalysis}
        qcReport={qcReport}
        monitorVolume={monitorVolume}
        auditionLabel={auditionTarget.toUpperCase()}
        onChangeMonitorVolume={handleChangeMonitorVolume}
      />

      {/* Export & Settings Modals */}
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
      {exportModalOpen && (
        <React.Suspense fallback={null}>
          <ExportModal
            open={true}
            config={exportConfig}
            rendering={renderingExport}
            downloadUrl={exportDownloadUrl}
            downloadFilename={exportDownloadName}
            deliveryCheck={exportDeliveryCheck}
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
            onChange={(next) => {
              setSettings(next);
              void saveAppSettings(next);
            }}
            onClose={() => setSettingsModalOpen(false)}
          >
            <AiProviderPanel />
          </SettingsModal>
        </React.Suspense>
      )}
    </div>
  );
}
