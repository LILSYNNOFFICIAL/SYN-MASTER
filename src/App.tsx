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
  AIMasteringStrategy,
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
import { validateChainAgainstInventory } from './director/processorInventory';
import { generateDemoMasterStem } from './dsp/demoAudio';
import { type ExternalPluginProcessCallback } from './dsp/mixedChainRenderer';
import { type ProcessorMeterTelemetry } from './dsp/offlineDsp';
import { renderAndAnalyzeOffThread } from './dsp/workerClient';
import { MASTERING_PRESETS } from './dsp/presets';
import { QC_TARGET_PROFILES, runQualityControl } from './dsp/qc';
import {
  buildBattleCandidatesIntelligent,
  buildExplainableMasterPlan,
  compareReferenceIntelligent,
  runAutonomousDirectorLoop,
  type ExplainableMasterPlan,
} from './director/directorEngine';
import { applyStructuredChainCommands } from './director/chainCommands';
import { inspectPluginInventory } from './director/pluginIntelligence';
import { encodeWavBlob } from './dsp/wavEncoder';
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
import { SynLabView } from './components/SynLabView';
import { AiMasterView } from './components/AiMasterView';
import { BattleModeView } from './components/BattleModeView';
import { QualityControlView, ReferenceMatchView } from './components/ReferenceAndQcViews';
import { PluginManagerView } from './components/PluginManagerView';
import { ExportModal, SettingsModal } from './components/Modals';

function formatTime(sec: number): string {
  const safe = Number.isFinite(sec) ? Math.max(0, sec) : 0;
  const m = Math.floor(safe / 60);
  const s = Math.floor(safe % 60);
  const ms = Math.floor((safe % 1) * 10);
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
      return telemetryStore.subscribe((snapshot) => update(snapshot.currentTimeSec));
    }, [durationSec]);
    return (
      <span ref={spanRef} className={`font-mono-tabular text-[#9CA3AF] ${className}`}>
        00:00.0 / {formatTime(durationSec)}
      </span>
    );
  },
);

const DEFAULT_EXPORT_CONFIG: ExportConfig = {
  filename: 'SYN_Master_Output',
  format: 'wav',
  wavBitDepth: 24,
  sampleRate: 44100,
  channels: 'stereo',
  dither: 'tpdf',
  normalizeToTarget: false,
  targetLufs: -14,
  ceilingDb: -1.0,
  deliveryProfile: 'streaming',
  metadataTitle: 'Untitled Master',
  metadataArtist: 'SYN MASTER',
};

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

  const [projectId, setProjectId] = useState(() => `proj-${Date.now()}`);
  const [projectName, setProjectName] = useState('Untitled Mastering Session');
  const [mode, setMode] = useState<MasteringMode>('hybrid');
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [savedChains, setSavedChains] = useState<SavedChainRecord[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);

  const [activeTrack, setActiveTrack] = useState<AudioTrackAsset | null>(null);
  const [referenceTrack, setReferenceTrack] = useState<AudioTrackAsset | null>(null);
  const [postAnalysis, setPostAnalysis] = useState<AudioAnalysis | null>(null);
  const [postPeaks, setPostPeaks] = useState<number[] | null>(null);
  const [stageTelemetry, setStageTelemetry] = useState<ProcessorMeterTelemetry[]>([]);

  // Chain & Undo/Redo history
  const [chain, setChain] = useState<ProcessorModule[]>(createStarterChain);
  const [undoStack, setUndoStack] = useState<ProcessorModule[][]>([]);
  const [redoStack, setRedoStack] = useState<ProcessorModule[][]>([]);
  const [chainBypassed, setChainBypassed] = useState(false);

  // Playback & monitoring state
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
  const [maxIterations, setMaxIterations] = useState(3);
  const [convergenceThreshold, setConvergenceThreshold] = useState(0.8);
  const [directorPlan, setDirectorPlan] = useState<ExplainableMasterPlan | null>(null);
  const [directorReport, setDirectorReport] = useState<MasterFinalReport | null>(null);
  const [directorActivityLog, setDirectorActivityLog] = useState<DirectorActivityEntry[]>([]);
  const [directorCheckpoints, setDirectorCheckpoints] = useState<DirectorCheckpoint[]>([]);
  const [directorRunning, setDirectorRunning] = useState(false);
  const [directorPaused, setDirectorPaused] = useState(false);
  const [directorStage, setDirectorStage] = useState('');
  const [directorPass, setDirectorPass] = useState(0);
  const directorPauseRef = useRef(false);
  const directorStopRef = useRef(false);

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
  const [statusNotice, setStatusNotice] = useState<string | null>(null);

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

  // Recompute the mastering preview off the UI thread when the native DSP path is available.
  useEffect(() => {
    const src = sourceChannelsRef.current;
    const track = activeTrack;
    if (!src || !track) return;

    let cancelled = false;
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
          });
          if (cancelled) return;
          postChannelsRef.current = result.channels;
          setStageTelemetry(result.telemetry);
          setPostPeaks(result.peaks ?? null);
          setPostAnalysis(result.analysis);
          if (result.usedExternalHost) {
            engineRef.current!.setOverrideBuffer('mastered-external', result.channels, track.sampleRate);
          } else {
            engineRef.current!.clearOverrideBuffer('mastered-external');
          }
        } catch (err) {
          if (cancelled) return;
          engineRef.current!.clearOverrideBuffer('mastered-external');
          setStatusNotice(err instanceof Error ? err.message : 'Audio chain analysis failed.');
        }
      })();
    }, 120);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [chain, chainBypassed, activeTrack, processExternalStage]);

  // Sync live Web Audio chain
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.setChain(chain);
    engine.setChainBypassed(chainBypassed);
  }, [chain, chainBypassed]);

  // Publish high-frequency playback telemetry outside React state.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.setOnEnded(() => {
      setIsPlaying(false);
      telemetryStore.reset();
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

  const updateChainWithHistory = useCallback(
    (nextChain: ProcessorModule[]) => {
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
    },
    [chain],
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
      const src = sourceChannelsRef.current;
      if (!src || !activeTrack) {
        throw new Error('Load an audio track before starting native WASAPI audition.');
      }
      const track = activeTrack;
      const effectiveChain = chainBypassed ? [] : chain;
      const rendered = await renderAndAnalyzeOffThread({
        sourceChannels: src,
        sampleRate: track.sampleRate,
        chain: effectiveChain,
        externalProcessor: processExternalStage,
      });
      if (activeTrack?.id !== track.id) return;
      const status = await hostBridgeRef.current!.startWasapiAudition(
        rendered.channels,
        track.sampleRate,
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
      const engine = engineRef.current!;
      sourceChannelsRef.current = channels;
      engine.setSourceChannels(channels, sampleRate);
      setIsPlaying(false);
      telemetryStore.reset();
      setAuditionTarget('mastered');

      const analysis = analyzeAudioBuffer(channels, sampleRate);
      const peaks = extractWaveformPeaks(channels, 400);
      const asset: AudioTrackAsset = {
        id: `trk-${Date.now()}`,
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
      setDirectorPlan(null);
      setDirectorReport(null);
      setDirectorActivityLog([]);
      setDirectorCheckpoints([]);
      setExportConfig((prev) => ({
        ...prev,
        filename: name.replace(/\.[^/.]+$/, '') + '_SYN_MASTER',
        sampleRate: ([44100, 48000, 88200, 96000].includes(sampleRate) ? sampleRate : 44100) as ExportConfig['sampleRate'],
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
      telemetryStore.publish({ isPlaying: false, currentTimeSec: engine.getCurrentTimeSec(), live: null });
    } else {
      engine.play();
      setIsPlaying(true);
      telemetryStore.publish({ isPlaying: true, currentTimeSec: engine.getCurrentTimeSec() });
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

  const activeQcProfile = useMemo(
    () => QC_TARGET_PROFILES.find((p) => p.id === qcTargetId) ?? QC_TARGET_PROFILES[0],
    [qcTargetId],
  );

  const qcReport = useMemo(() => {
    if (!activeTrack || !postAnalysis) return null;
    return runQualityControl(activeTrack.analysis, postAnalysis, activeQcProfile, exportConfig);
  }, [activeTrack, postAnalysis, activeQcProfile, exportConfig]);

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
      updateChainWithHistory(res.chain);
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
      setStatusNotice(`Applied recommendation: ${rec.pluginName ?? rec.selectedProcessor}.`);
    },
    [chain, updateChainWithHistory],
  );

  const handleRunMasterDirector = async () => {
    const src = sourceChannelsRef.current;
    if (!src || !activeTrack) return;

    setAiError(null);
    setDirectorRunning(true);
    setDirectorPaused(false);
    directorPauseRef.current = false;
    directorStopRef.current = false;
    setDirectorActivityLog([]);
    setDirectorCheckpoints([]);
    setDirectorStage('SYN-ANALYZE');
    setDirectorPass(0);

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

    // Optional Cloud Gemini initial strategy in Autonomous/Assisted when user opted in
    let geminiInitialChain: ProcessorModule[] | undefined;
    if (useGeminiCloud && operatingMode !== 'manual') {
      setAiLoading(true);
      try {
        const pluginSummary = inspectPluginInventory(
          hostSnapshot.plugins,
          hostSnapshot.status === 'connected',
          activeTrack.analysis,
          plan.objective,
        );
        const res = await fetch('/api/ai/master', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(30_000),
          body: JSON.stringify({
            analysis: activeTrack.analysis,
            mode,
            objective: objectiveId,
            customObjective,
            operatingMode,
            targetLufs: plan.objective.targetLufs,
            referenceAnalysis: referenceTrack?.analysis ?? null,
            availablePlugins: pluginSummary.matches.map((m) => ({
              name: m.name,
              role: m.role,
              manufacturer: m.manufacturer,
            })),
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Server responded ${res.status}`);
        const strat = data.strategy as AIMasteringStrategy;
        const inventoryCheck = validateChainAgainstInventory(strat?.chain);
        if (inventoryCheck.valid && inventoryCheck.sanitizedChain.length > 0) {
          strat.chain = inventoryCheck.sanitizedChain;
          geminiInitialChain = strat.chain;
          setAiStrategy(strat);
        } else {
          setAiError(
            `Cloud AI response failed processor inventory validation (${inventoryCheck.errors[0] ?? 'empty chain'}); using the local DSP planner.`,
          );
        }
      } catch (err) {
        setAiError(err instanceof Error ? err.message : 'Cloud Gemini request failed');
      } finally {
        setAiLoading(false);
      }
    }

    try {
      const report = await runAutonomousDirectorLoop({
        sourceChannels: src,
        sampleRate: activeTrack.sampleRate,
        operatingMode,
        objectiveId,
        customSpec: customObjective,
        qcProfile: activeQcProfile,
        exportConfig,
        referenceAnalysis: referenceTrack?.analysis ?? null,
        externalPlugins: hostSnapshot.plugins,
        hostConnected: hostSnapshot.status === 'connected',
        initialChain: geminiInitialChain ?? (operatingMode === 'assisted' ? chain : undefined),
        externalProcessor: processExternalStage,
        maxIterations,
        convergenceThreshold,
        isPaused: () => directorPauseRef.current,
        shouldStop: () => directorStopRef.current,
        aiRefineCallback:
          useGeminiCloud && operatingMode === 'autonomous'
            ? async (ctx) => {
                const res = await fetch('/api/ai/refine', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  signal: AbortSignal.timeout(30_000),
                  body: JSON.stringify(ctx),
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || `Refine error ${res.status}`);
                return data.refined?.chain ?? null;
              }
            : undefined,
        onProgress: (upd) => {
          setDirectorStage(upd.stage);
          setDirectorPass(upd.passNumber);
          if (upd.activityEntry) {
            setDirectorActivityLog((prev) => [...prev, upd.activityEntry!]);
          }
          if (upd.checkpoint) {
            setDirectorCheckpoints((prev) => [...prev, upd.checkpoint!]);
          }
        },
      });

      setDirectorReport(report);
      setDirectorCheckpoints(report.checkpoints);
      setDirectorActivityLog(report.activityLog);

      if (operatingMode !== 'manual' && report.finalChain.length > 0) {
        updateChainWithHistory(structuredClone(report.finalChain));
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
        operatingMode === 'manual'
          ? 'Manual Mode: Explainable mastering plan generated without altering rack.'
          : `Director ${report.status}: Best Pass #${report.bestPassNumber} (${report.postAnalysis.integratedLufs.toFixed(1)} LUFS, QC ${report.qcReport.overallStatus.toUpperCase()}).`,
      );
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'Mastering Director execution failed');
    } finally {
      setDirectorRunning(false);
      setDirectorPaused(false);
      directorPauseRef.current = false;
    }
  };

  const handleGenerateBattle = async () => {
    const src = sourceChannelsRef.current;
    const track = activeTrack;
    if (!src || !track) return;
    setBattleGenerating(true);

    try {
      const specs = buildBattleCandidatesIntelligent(track.analysis);
      const built: BattleCandidate[] = [];
      for (const candidate of specs) {
        const result = await renderAndAnalyzeOffThread({
          sourceChannels: src,
          sampleRate: track.sampleRate,
          chain: candidate.chain,
        });
        if (activeTrack?.id !== track.id) return;
        engineRef.current!.setOverrideBuffer(
          `candidate-${candidate.id.toLowerCase()}`,
          result.channels,
          track.sampleRate,
        );
        built.push({
          id: candidate.id,
          blindLabel: `Candidate ${candidate.id}`,
          title: candidate.title,
          philosophy: candidate.philosophy,
          chain: candidate.chain,
          postAnalysis: result.analysis,
          loudnessTrimDb: Number((-14.0 - result.analysis.integratedLufs).toFixed(2)),
        });
      }
      setBattleCandidates(built);
      setStatusNotice('Generated 3 objective-calibrated Battle Mode masters ready for blind A/B/C auditioning.');
    } catch (err) {
      setStatusNotice(err instanceof Error ? err.message : 'Battle candidate generation failed.');
    } finally {
      setBattleGenerating(false);
    }
  };

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
    updateChainWithHistory(plan.chain);
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
    updateChainWithHistory(validateChain(next));
    setStatusNotice(`Adjusted chain ceiling & loudness targets for ${activeQcProfile.name}.`);
  };

  const handleRenderExport = async () => {
    const src = sourceChannelsRef.current;
    if (!src || !activeTrack) return;
    setRenderingExport(true);
    try {
      const track = activeTrack;
      const effectiveChain = chainBypassed ? [] : chain;
      const processed = await renderAndAnalyzeOffThread({
        sourceChannels: src,
        sampleRate: track.sampleRate,
        chain: effectiveChain,
        externalProcessor: processExternalStage,
      });
      if (activeTrack?.id !== track.id) return;
      const blob = encodeWavBlob(processed.channels, track.sampleRate, exportConfig);
      if (exportDownloadUrl) URL.revokeObjectURL(exportDownloadUrl);
      const url = URL.createObjectURL(blob);
      const safeName = (exportConfig.filename.trim() || 'SYN_Master') + '.wav';
      setExportDownloadUrl(url);
      setExportDownloadName(safeName);
      setStatusNotice(`Rendered WAV master "${safeName}".`);
    } catch (err) {
      setStatusNotice(err instanceof Error ? err.message : 'WAV export render failed');
    } finally {
      setRenderingExport(false);
    }
  };

  return (
    <div className="min-h-screen lg:h-screen w-full flex flex-col bg-[#070709] text-[#F7F8FA] lg:overflow-hidden">
      {/* Zone 3-Part Top Bar Contract */}
      <header className="h-14 shrink-0 px-4 border-b border-[#242732] bg-[#0B0C10] flex items-center justify-between gap-8">
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

        {/* Zone 2: Clean Single-Line Navigation Tabs */}
        <nav aria-label="Workspace Sections" className="hidden md:flex items-center gap-6 overflow-x-auto">
          {(
            [
              { id: 'studio', label: 'Studio' },
              { id: 'lab', label: 'SYN-Lab' },
              { id: 'ai', label: 'AI Master' },
              { id: 'battle', label: 'Battle Mode' },
              { id: 'reference', label: 'Reference' },
              { id: 'qc', label: 'SYN-QC' },
              { id: 'plugins', label: 'Plugins' },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveTab(item.id)}
              className={`py-1 text-xs font-semibold whitespace-nowrap shrink-0 border-b-2 transition-colors ${
                activeTab === item.id
                  ? 'border-[#F2CA52] text-[#F2CA52]'
                  : 'border-transparent text-[#9CA3AF] hover:text-[#F7F8FA]'
              }`}
            >
              {item.label}
            </button>
          ))}
        </nav>

        {/* Zone 3: Primary CTA */}
        <div className="flex items-center shrink-0">
          <button
            type="button"
            onClick={() => setExportModalOpen(true)}
            className="px-4 py-1.5 rounded bg-[#D4AF37] text-[#070709] text-xs font-bold hover:bg-[#F2CA52] whitespace-nowrap shrink-0"
          >
            Export Master
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
      <div className="flex-1 lg:min-h-0 flex flex-col lg:flex-row lg:overflow-hidden">
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
            onApplyPreset={(p: MasteringPreset) => {
              updateChainWithHistory(structuredClone(p.chain));
              setStatusNotice(`Loaded preset "${p.name}".`);
            }}
            onApplySavedChain={(c: SavedChainRecord) => {
              updateChainWithHistory(structuredClone(c.chain));
              setStatusNotice(`Loaded chain "${c.name}".`);
            }}
            onDeleteSavedChain={async (id) => {
              await removeChainRecord(id);
              setSavedChains(await listSavedChains());
            }}
            onOpenProject={(proj) => {
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
              setAiStrategy(proj.aiStrategy ?? null);
              setIterations(proj.iterations ?? []);
              setQcTargetId(proj.qcTargetId ?? 'streaming');
              setStatusNotice(`Opened project "${proj.name}".`);
            }}
            onDeleteProject={async (id) => {
              await removeProject(id);
              setProjects(await listProjects());
            }}
          />
        )}

        {/* Center Mastering Stage */}
        <main className="lg:flex-1 shrink-0 lg:shrink min-w-0 lg:overflow-y-auto p-4 flex flex-col gap-4 bg-[#070709] order-first lg:order-none">
          {/* Mobile Tab Strip */}
          <div className="flex md:hidden items-center gap-1 overflow-x-auto pb-1">
            {(
              [
                { id: 'studio', label: 'Studio' },
                { id: 'lab', label: 'Lab' },
                { id: 'ai', label: 'AI Master' },
                { id: 'battle', label: 'Battle' },
                { id: 'reference', label: 'Ref' },
                { id: 'qc', label: 'QC' },
                { id: 'plugins', label: 'Plugins' },
              ] as const
            ).map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`px-2.5 py-1 rounded text-xs font-semibold whitespace-nowrap ${
                  activeTab === item.id
                    ? 'bg-[#D4AF37] text-[#070709]'
                    : 'bg-[#14161D] text-[#9CA3AF]'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>

          {/* Transport & Waveform Stage (Full waveform on Studio & Reference; compact transport bar on other tabs) */}
          {!activeTrack && activeTab === 'plugins' ? null : !activeTrack ? (
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
          ) : activeTab === 'studio' || activeTab === 'reference' ? (
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
                  <span className="font-mono-tabular text-[#9CA3AF]">
                    <TransportTimeReadout durationSec={activeTrack.durationSec} />
                  </span>
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
                <span className="text-[11px] font-mono-tabular text-[#9CA3AF] whitespace-nowrap">
                  <TransportTimeReadout durationSec={activeTrack.durationSec} />
                </span>
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
          {activeTab === 'studio' && activeTrack && (
            <section className="p-3.5 rounded bg-[#111217] border border-[#242732] flex flex-col gap-3">
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
                allowLiveTelemetry={isPlaying}
                sampleRate={activeTrack.sampleRate}
                mode={spectrumMode}
                heightClass="h-64"
              />
            </section>
          )}

          {activeTab === 'lab' && (
            <SynLabView
              preAnalysis={activeTrack?.analysis ?? null}
              postAnalysis={postAnalysis}
              chain={chainBypassed ? [] : chain}
              allowLiveTelemetry={isPlaying}
              postChannels={postChannelsRef.current}
              sampleRate={activeTrack?.sampleRate ?? 44100}
            />
          )}

          {activeTab === 'ai' && (
            <AiMasterView
              preAnalysis={activeTrack?.analysis ?? null}
              postAnalysis={postAnalysis}
              referenceAnalysis={referenceTrack?.analysis ?? null}
              operatingMode={operatingMode}
              objectiveId={objectiveId}
              customObjective={customObjective}
              useGeminiCloud={useGeminiCloud}
              canUndo={undoStack.length > 0}
              aiStrategy={aiStrategy}
              directorPlan={directorPlan}
              directorReport={directorReport}
              qcReport={qcReport}
              iterations={iterations}
              activityLog={directorActivityLog}
              checkpoints={directorCheckpoints}
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
              onApplyChain={(c) => {
                updateChainWithHistory(structuredClone(c));
                setStatusNotice('Loaded Mastering Director chain into Mastering Rack.');
              }}
              onApplyRecommendation={handleApplyRecommendation}
              onAuditionCheckpoint={async (cp) => {
                const src = sourceChannelsRef.current;
                const track = activeTrack;
                if (!src || !track) return;
                const res = await renderAndAnalyzeOffThread({
                  sourceChannels: src,
                  sampleRate: track.sampleRate,
                  chain: cp.chain,
                });
                if (activeTrack?.id !== track.id) return;
                engineRef.current!.setOverrideBuffer('iteration', res.channels, track.sampleRate);
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
        </main>

        {/* Right Sidebar: Modular Mastering Chain Rack */}
        {!fullscreenWorkspace && (
          <MasteringRack
            chain={chain}
            chainBypassed={chainBypassed}
            telemetry={stageTelemetry}
            guidedMode={settings.experienceMode === 'guided'}
            externalPlugins={hostSnapshot.plugins}
            hostConnected={hostSnapshot.status === 'connected'}
            onChangeChain={updateChainWithHistory}
            onToggleChainBypass={() => setChainBypassed((b) => !b)}
            onSaveChain={async (name) => {
              await saveChainRecord({
                id: `chain-${Date.now()}`,
                name,
                createdAt: Date.now(),
                chain: structuredClone(chain),
              });
              setSavedChains(await listSavedChains());
              setStatusNotice(`Saved chain "${name}".`);
            }}
            onResetChain={() => updateChainWithHistory(createStarterChain())}
            onAddExternalPlugin={handleInsertExternalPlugin}
            onLoadExternalInstance={handleLoadExternalInstance}
            onSetExternalParam={handleSetExternalParam}
            onToggleExternalEditor={handleToggleExternalEditor}
            onToggleExternalBypass={handleToggleExternalBypass}
          />
        )}
      </div>

      {/* Bottom Meter Bridge */}
      <MeterBridge
        postAnalysis={auditionTarget === 'original' ? activeTrack?.analysis ?? null : postAnalysis}
        qcReport={qcReport}
        monitorVolume={monitorVolume}
        auditionLabel={auditionTarget.toUpperCase()}
        onChangeMonitorVolume={(v) => {
          setMonitorVolume(v);
          engineRef.current!.setMonitorVolume(v);
        }}
      />

      {/* Export & Settings Modals */}
      <ExportModal
        open={exportModalOpen}
        config={exportConfig}
        rendering={renderingExport}
        downloadUrl={exportDownloadUrl}
        downloadFilename={exportDownloadName}
        hasTrack={Boolean(activeTrack)}
        onChange={setExportConfig}
        onRender={handleRenderExport}
        onClose={() => setExportModalOpen(false)}
      />
      <SettingsModal
        open={settingsModalOpen}
        settings={settings}
        onChange={(next) => {
          setSettings(next);
          void saveAppSettings(next);
        }}
        onClose={() => setSettingsModalOpen(false)}
      />
    </div>
  );
}
