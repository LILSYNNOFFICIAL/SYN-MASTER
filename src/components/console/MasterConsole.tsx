import React, { useEffect, useMemo, useState } from 'react';
import { BrainCircuit, Download, MessageSquareText, Pause, Play, Plus, SkipBack, SkipForward, Square, Upload } from 'lucide-react';
import type {
  AudioAnalysis,
  CompressorParams,
  DynamicEQParams,
  MatchEqParams,
  LimiterParams,
  MasterFinalReport,
  MasteringPreset,
  MaximizerParams,
  MultibandMaximizerParams,
  ParametricEQParams,
  ProcessorModule,
  ProcessorType,
  SaturationParams,
  TransientShaperParams,
  VocalRebalanceParams,
} from '../../types/mastering';
import type { DynamicEqTrace, ProcessorMeterTelemetry } from '../../dsp/offlineDsp';
import { LOUDNESS_TARGET_PRESETS } from '../../dsp/loudnessTargets';
import type { FadeSettings } from '../../dsp/fades';
import { MODULE_CATALOG } from '../studio/moduleCatalog';
import { ParametricEQ2 } from '../studio/ParametricEQ2';
// Loaded when the Dynamic EQ tab is first opened (keeps the initial bundle in budget).
const loadDynamicEQPanel = () => import('../studio/DynamicEQPanel');
const DynamicEQPanel = React.lazy(() => loadDynamicEQPanel().then(({ DynamicEQPanel }) => ({ default: DynamicEQPanel })));
const MatchEQPanel = React.lazy(() => import('../studio/MatchEQPanel'));
const VocalRebalancePanel = React.lazy(() => import('../studio/VocalRebalancePanel'));
import { SpectrumAndEQCanvas } from '../CanvasVisualizers';
import { ArcKnob } from './ArcKnob';
import { GlowFader } from './GlowFader';
import { LightRibbons } from './LightRibbons';
import { StereoMeters, StereoScope } from './StereoScope';
import { telemetryStore, type RuntimeTelemetryState } from '../../engine/telemetryStore';
import { isMasterFullyVerified } from '../../director/postFixVerification';
import { ProgressRing, type ProgressRingState } from '../ui/ProgressRing';
import { clampPercent, fixAllPercent, fixAllStageLabel, nextMonotonicPercent } from '../ui/progressMath';

/**
 * SYN-MASTER console (reference-mockup layout). A presentation layer only: every control
 * edits the real processing chain through `onChangeChain` (the same path as the rack), and
 * every readout is a measured analysis value. Controls whose processor is not in the chain
 * offer to insert that processor from the module catalog instead of showing a dead knob.
 */
export interface MasterConsoleProps {
  chain: ProcessorModule[];
  stageTelemetry?: ProcessorMeterTelemetry[];
  chainBypassed: boolean;
  onChangeChain: (next: ProcessorModule[]) => void;
  sampleRate: number;
  source: AudioAnalysis | null;
  master: AudioAnalysis | null;
  referenceAnalysis: AudioAnalysis | null;
  scopeChannels: Float32Array[] | null;
  waveformPeaks: number[];
  fades: FadeSettings;
  onFadesChange: (next: FadeSettings) => void;
  durationSec: number;
  hasTrack: boolean;
  running: boolean;
  stage: string;
  pass: number;
  maxPasses: number;
  report: MasterFinalReport | null;
  onFix: () => void;
  onStop: () => void;
  /** Error from the last FIX ALL run (shown as the ring's error state when the run ends without a report). */
  fixError?: string | null;
  onDemo: () => void;
  onImport: (file: File) => void;
  targetPresetId: string | null;
  targetLabel: string;
  targetLufs: number;
  maxTruePeakDb: number;
  onTargetPreset: (id: string) => void;
  presets: MasteringPreset[];
  onApplyPreset: (preset: MasteringPreset) => void;
  onOpenRack: () => void;
  onOpenStereoLab: () => void;
  /** Latest app status notice (also shown in the session ribbon on very wide screens). */
  notice?: string | null;
  /** Friendly AI notice shown under FIX ALL (e.g. cloud AI limit reached, local planner used). */
  aiNotice?: string | null;
  /** Visible banner shown whenever Cloud AI was not used / fell back during a FIX ALL pass. */
  aiFallbackBanner?: string | null;
  /** "What AI changed" list rendered under FIX ALL after a run. */
  aiChanges?: React.ReactNode;
  /** Peaks of the processed preview render (falls back to the source); drawn as the glowing blanket behind the EQ curve. */
  blanketPeaks?: number[] | null;
  /** Transport/fade controls rendered inside the unified waveform + EQ canvas. */
  timeline?: React.ReactNode;
  /** Compact transport controls shown in the EQ header beside the view selector. */
  timelineTransport?: React.ReactNode;
  /** Opens the AI Assistant (Mastering Director) workspace. Planning / explanations, not the one-click fix. */
  onAskAi?: () => void;
  /** Opens the Export Master dialog (step 4 of the guided flow). */
  onExport?: () => void;
  /** Seek the shared playback position (live spectrum / spectrogram playhead drag). */
  onSeek?: (sec: number) => void;
  isPlaying: boolean;
  onTogglePlay: () => void;
  /** Session "Mode" from the ribbon (MasteringMode). Shown on the console and used to suggest a preset. */
  mode?: string;
  /** Drag the target marker on the loudness meter: sets a custom integrated-loudness target. */
  onTargetLufs?: (lufs: number) => void;
  /** Dynamic EQ detector / gain traces from the last preview render (threshold meter, live curve). */
  dynamicEqTraces?: DynamicEqTrace[];
}

/**
 * What the ribbon Mode does today: it is saved with the project and passed to the AI strategy
 * request as context; Target / Objective drive the actual processing. The console reflects it by
 * labelling it and pre-selecting a matching preset (nothing is applied until "Load preset chain").
 */
export const MODE_INFO: Record<string, { label: string; hint: string; preset?: string }> = {
  'ai-auto': { label: 'AI Automatic', hint: 'Use FIX ALL AI for a fully automatic, verified master.' },
  hybrid: { label: 'Hybrid', hint: 'FIX ALL AI first, then fine-tune the knobs and EQ by hand.' },
  manual: { label: 'Manual', hint: 'You drive every control; FIX ALL stays available.' },
  transparent: { label: 'Transparent', hint: 'Minimal colour, streaming-safe loudness.', preset: 'phil-transparent' },
  loudness: { label: 'Loudness Max', hint: 'Club-level loudness with tight limiting.', preset: 'genre-electronic' },
  analog: { label: 'Analog Character', hint: 'Warm console saturation and glue.', preset: 'phil-warm' },
  dynamic: { label: 'Dynamic Preservation', hint: 'Keep transients and range; gentle limiting.', preset: 'genre-acoustic' },
  reference: { label: 'Reference Match', hint: 'Load a reference track in the library, then match it.' },
  streaming: { label: 'Streaming Delivery', hint: 'Aim for -14 LUFS / -1 dBTP platform targets.', preset: 'phil-transparent' },
  custom: { label: 'Custom', hint: 'Your own objective.' },
};

const LOUDNESS_STAGES: ProcessorType[] = ['limiter', 'maximizer', 'multiband-maximizer', 'clipper', 'dither'];
const CATALOG_FOR: Partial<Record<ProcessorType, string>> = {
  'parametric-eq': 'peq',
  'transient-shaper': 'transient',
  compressor: 'comp',
  saturation: 'saturation',
  maximizer: 'maximizer',
};
const LABEL_FOR: Partial<Record<ProcessorType, string>> = {
  'parametric-eq': 'Parametric EQ',
  'transient-shaper': 'Transient shaper',
  compressor: 'Compressor',
  saturation: 'Saturation',
  maximizer: 'Maximizer',
};

/** Insert a catalog processor before the loudness/delivery stages (limiter, maximizer, dither stay last). */
export function insertBeforeLoudnessStages(chain: ProcessorModule[], mod: ProcessorModule): ProcessorModule[] {
  if (LOUDNESS_STAGES.includes(mod.type)) {
    const ditherAt = chain.findIndex((m) => m.type === 'dither');
    if (ditherAt < 0) return [...chain, mod];
    return [...chain.slice(0, ditherAt), mod, ...chain.slice(ditherAt)];
  }
  const at = chain.findIndex((m) => LOUDNESS_STAGES.includes(m.type));
  if (at < 0) return [...chain, mod];
  return [...chain.slice(0, at), mod, ...chain.slice(at)];
}

const fmtSigned = (v: number, d = 1) => `${v > 0 ? '+' : ''}${v.toFixed(d)}`;

const Card: React.FC<{ title: string; className?: string; children: React.ReactNode; area?: string }> = ({ title, className = '', children, area }) => (
  <section className={`syn-card ${area ? `syn-area-${area} ` : ''}${className}`} aria-label={title}>
    <h3 className="syn-card-title">{title}</h3>
    {children}
  </section>
);

const AddModule: React.FC<{ type: ProcessorType; onAdd: (t: ProcessorType) => void }> = ({ type, onAdd }) => (
  <button type="button" className="syn-card-add" onClick={() => onAdd(type)}>
    <Plus className="w-3.5 h-3.5" /> Add {LABEL_FOR[type] ?? type}
  </button>
);

/** Live short-window RMS / peak from the playback analyser (honestly labelled: not LUFS). */
const LiveLevel: React.FC = () => {
  const ref = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    let sm = -90;
    const update = (snap: RuntimeTelemetryState) => {
      const el = ref.current;
      if (!el) return;
      const live = snap.isPlaying ? snap.live : null;
      if (!live) {
        el.dataset.live = 'false';
        el.textContent = 'Live level: press play';
        return;
      }
      const rms = Math.max(live.rmsL, live.rmsR);
      const pk = Math.max(live.peakL, live.peakR);
      sm = sm * 0.75 + (Number.isFinite(rms) ? rms : -90) * 0.25;
      el.dataset.live = 'true';
      el.textContent = `Live RMS ${sm.toFixed(1)} dBFS · peak ${Number.isFinite(pk) ? pk.toFixed(1) : '-inf'} dBFS · GR ${live.gainReductionDb.toFixed(1)} dB`;
    };
    update(telemetryStore.getSnapshot());
    return telemetryStore.subscribe(update);
  }, []);
  return <div ref={ref} className="syn-loud-live" aria-live="off" />;
};

const LOUD_MIN = -30;
const LOUD_MAX = -5;
const loudPct = (v: number) => Math.max(0, Math.min(100, ((v - LOUD_MIN) / (LOUD_MAX - LOUD_MIN)) * 100));

/** Read-only integrated-loudness meter with a draggable target thumb (when onTarget is given). */
const LoudnessBar: React.FC<{ lufs: number | null; targetLufs: number; disabled?: boolean; onTarget?: (v: number) => void }> = ({ lufs, targetLufs, disabled, onTarget }) => {
  const trackRef = React.useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const shownTarget = drag ?? targetLufs;
  const fromX = (clientX: number) => {
    const r = trackRef.current!.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    return Math.round((LOUD_MIN + t * (LOUD_MAX - LOUD_MIN)) * 2) / 2;
  };
  const editable = Boolean(onTarget) && !disabled;
  return (
    <div className="syn-loud-meter">
      <div ref={trackRef} className="syn-loud-bar" role="meter" aria-label="Integrated loudness" aria-valuemin={LOUD_MIN} aria-valuemax={LOUD_MAX} aria-valuenow={lufs ?? LOUD_MIN}>
        <span style={{ width: `${lufs !== null ? loudPct(lufs) : 0}%` }} />
      </div>
      <button
        type="button"
        className={`syn-loud-thumb${editable ? '' : ' is-static'}`}
        style={{ left: `${loudPct(shownTarget)}%` }}
        role="slider"
        aria-label="Loudness target (drag or use arrow keys)"
        aria-valuemin={LOUD_MIN}
        aria-valuemax={LOUD_MAX}
        aria-valuenow={shownTarget}
        aria-valuetext={`${shownTarget} LUFS target`}
        disabled={!editable}
        onPointerDown={(e) => {
          if (!editable) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          setDrag(fromX(e.clientX));
        }}
        onPointerMove={(e) => {
          if (drag !== null) setDrag(fromX(e.clientX));
        }}
        onPointerUp={() => {
          if (drag !== null && onTarget && drag !== targetLufs) onTarget(drag);
          setDrag(null);
        }}
        onPointerCancel={() => setDrag(null)}
        onKeyDown={(e) => {
          if (!editable || !onTarget) return;
          const d = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 0.5 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -0.5 : 0;
          if (d) {
            e.preventDefault();
            onTarget(Math.max(LOUD_MIN, Math.min(LOUD_MAX, targetLufs + d)));
          }
        }}
      >
        <span>{shownTarget}</span>
      </button>
      <div className="syn-loud-scale" aria-hidden="true"><span>-30</span><span>-20</span><span>-14</span><span>-9</span><span>-5</span></div>
    </div>
  );
};

const StepLabel: React.FC<{ n: number; text: string; hint?: string; className?: string }> = ({ n, text, hint, className = '' }) => (
  <div className={`syn-step-label ${className}`}>
    <span className="syn-step-num" aria-hidden="true">{n}</span>
    <span className="syn-step-text"><span className="sr-only">Step {n}: </span>{text}</span>
    {hint && <small className="syn-step-hint">{hint}</small>}
  </div>
);

export const MasterConsole: React.FC<MasterConsoleProps> = (p) => {
  const [eqView, setEqView] = useState<'eq' | 'dyneq' | 'matcheq' | 'spectrum' | 'spectrogram' | 'vocal'>('eq');
  // Prefetch the code-split Dynamic EQ editor after first paint so the tab opens instantly.
  useEffect(() => {
    const t = window.setTimeout(() => { void loadDynamicEQPanel(); }, 300);
    return () => window.clearTimeout(t);
  }, []);
  const [presetId, setPresetId] = useState<string>(p.presets[0]?.id ?? '');
  // FIX ALL ring: driven only by the Director's own stage/pass events (no timers).
  // Monotonic while running, eases toward 95, 100 only on completion.
  const [fixProgress, setFixProgress] = useState<number>(0);
  const [fixRingState, setFixRingState] = useState<ProgressRingState>('idle');
  const wasRunningRef = React.useRef(false);
  useEffect(() => {
    if (p.running) {
      const target = fixAllPercent(p.stage, p.pass);
      const fresh = !wasRunningRef.current;
      wasRunningRef.current = true;
      setFixRingState('running');
      setFixProgress((prev) => nextMonotonicPercent(prev, target, fresh));
      return undefined;
    }
    if (!wasRunningRef.current) return undefined;
    wasRunningRef.current = false;
    const stopped = p.report?.status === 'stopped-by-user' || /stop/i.test(p.stage ?? '');
    let next: ProgressRingState;
    let holdMs: number;
    if (p.report && !stopped) {
      next = 'running';
      holdMs = 900;
      setFixProgress(100);
    } else if (stopped) {
      next = 'stopped';
      holdMs = 1600;
    } else if (p.fixError) {
      next = 'error';
      holdMs = 3000;
    } else {
      next = 'idle';
      holdMs = 0;
    }
    setFixRingState(next);
    const resetTimer = window.setTimeout(() => {
      setFixRingState('idle');
      setFixProgress(0);
    }, holdMs);
    return () => window.clearTimeout(resetTimer);
  }, [p.running, p.pass, p.stage, p.report, p.fixError]);
  const modeInfo = p.mode ? MODE_INFO[p.mode] : undefined;
  const suggestedPreset = modeInfo?.preset && p.presets.some((x) => x.id === modeInfo.preset) ? modeInfo.preset : null;
  useEffect(() => {
    if (suggestedPreset) setPresetId(suggestedPreset);
  }, [suggestedPreset]);
  const chain = p.chain;
  const find = (type: ProcessorType) => chain.find((m) => m.type === type && m.enabled);
  const patch = (id: string, next: Partial<ProcessorModule>) =>
    p.onChangeChain(chain.map((m) => (m.id === id ? { ...m, ...next } : m)));
  function setParams<T>(mod: ProcessorModule, next: Partial<T>) {
    patch(mod.id, { params: { ...(mod.params as T), ...next } as unknown as ProcessorModule['params'] });
  }
  const add = (type: ProcessorType) => {
    const item = MODULE_CATALOG.find((c) => c.id === CATALOG_FOR[type]) ?? MODULE_CATALOG.find((c) => c.type === type);
    if (!item) return;
    p.onChangeChain(insertBeforeLoudnessStages(chain, { ...item.build(), expanded: false }));
  };

  const eq = find('parametric-eq');
  const dynEq = chain.find((m) => m.type === 'dynamic-eq');
  const matchEq = chain.find((m) => m.type === 'match-eq');
  // Match EQ goes early (after repair stages), not just before loudness like other tools.
  const addMatchEq = () => {
    const item = MODULE_CATALOG.find((c) => c.type === 'match-eq');
    if (!item) return;
    const at = chain.findIndex((m) => m.type !== 'restore');
    const next = [...chain];
    next.splice(at < 0 ? chain.length : at, 0, { ...item.build(), expanded: false });
    p.onChangeChain(next);
  };
  const vocalRb = chain.find((m) => m.type === 'vocal-rebalance');
  // Vocal Rebalance works on source stems, so it always goes first.
  const addVocalRebalance = () => {
    const item = MODULE_CATALOG.find((c) => c.type === 'vocal-rebalance');
    if (item) p.onChangeChain([{ ...item.build(), expanded: false }, ...chain]);
  };
  const ts = find('transient-shaper');
  const comp = find('compressor');
  const sat = find('saturation');
  const ceilingMod = find('maximizer') ?? find('limiter') ?? find('multiband-maximizer');
  const firstStage = chain.find((m) => m.enabled);

  const shown = p.master ?? p.source;
  const lufs = shown?.integratedLufs ?? null;
  const tp = shown?.truePeakDb ?? null;
  const peakStageTelemetry = (p.stageTelemetry ?? []).filter((entry) => {
    const module = chain.find((candidate) => candidate.id === entry.id);
    return module && ['limiter', 'maximizer', 'multiband-maximizer', 'clipper'].includes(module.type);
  });
  const peakStageInputDb = peakStageTelemetry.length
    ? Math.max(...peakStageTelemetry.map((entry) => entry.inputPeakDb))
    : null;
  const peakStageOutputDb = peakStageTelemetry.length
    ? Math.max(...peakStageTelemetry.map((entry) => entry.outputPeakDb))
    : null;
  const peakStageGainReductionDb = peakStageTelemetry.length
    ? Math.max(...peakStageTelemetry.map((entry) => entry.gainReductionDb))
    : null;
  const gate = p.report?.targetGate ?? null;
  const pct = p.running ? Math.min(100, Math.round((Math.max(0, p.pass) / Math.max(1, p.maxPasses)) * 100)) : p.report ? 100 : 0;

  const tonal = useMemo(() => {
    const z = shown?.zoneEnergyDb;
    if (!z) return null;
    const low = (z.sub + z.bass) / 2;
    const mid = (z.lowMid + z.mid) / 2;
    const high = (z.highMid + z.presence + z.air) / 3;
    const mean = (low + mid + high) / 3;
    return { low: low - mean, mid: mid - mean, high: high - mean };
  }, [shown]);

  const statusLine = p.running
    ? `${p.stage || 'Working'} · pass ${p.pass}/${p.maxPasses}`
    : gate
      ? isMasterFullyVerified(p.report)
        ? 'Verified · every target met'
        : 'Not fully verified · see details'
      : p.master
        ? 'Master measured'
        : p.hasTrack
          ? 'Ready to fix'
          : 'Load a track to begin';

  const ceiling = (() => {
    if (!ceilingMod) return null;
    const prm = ceilingMod.params as MaximizerParams | LimiterParams | MultibandMaximizerParams;
    const min = ceilingMod.type === 'limiter' ? -6 : -3;
    return { mod: ceilingMod, value: prm.ceilingDb, min };
  })();

  const inputKnob = (size: number, label: string) =>
    firstStage ? (
      <ArcKnob label={label} value={firstStage.inputGainDb} min={-12} max={12} step={0.1} defaultValue={0} unit="dB" signed bipolar accent="blue" size={size}
        rangeLabels={['-12', '+12']} caption={`Trim into ${firstStage.name}`} onChange={(v) => patch(firstStage.id, { inputGainDb: v })} />
    ) : (
      <AddModule type="parametric-eq" onAdd={add} />
    );

  const outputKnob = (size: number, label: string) =>
    ceiling ? (
      <ArcKnob label={label} value={ceiling.value} min={ceiling.min} max={-0.1} step={0.1} defaultValue={-1} unit="dBTP" accent="gold" size={size}
        caption={`${ceiling.mod.name} ceiling`} onChange={(v) => setParams<MaximizerParams>(ceiling.mod, { ceilingDb: v })} />
    ) : (
      <AddModule type="maximizer" onAdd={add} />
    );

  const progressPercent = Math.round(clampPercent(fixProgress));
  const isFilling = p.running || fixRingState !== 'idle';
  const fixStageText = p.running ? fixAllStageLabel(p.stage, p.pass) : fixRingState === 'stopped' ? 'Stopped' : fixRingState === 'error' ? 'Error' : progressPercent >= 100 ? 'Done' : '';

  const fixButton = (
    <div className="syn2-fix-centerpiece syn-fixai-wrap">
      <div className="syn-fixai-ringbox">
      <button
        type="button"
        className={`syn-fixai${p.running ? ' is-running' : ''}`}
        onClick={p.onFix}
        disabled={!p.hasTrack || p.running}
        aria-describedby="syn-fixai-status"
        aria-label={p.running ? 'Fix All with AI is running' : 'Fix All with AI: analyze, fix, render and verify the master'}
        style={{
          boxShadow: isFilling
            ? '0 0 0 6px rgba(5,7,13,0.9), 0 0 28px rgba(56,189,248,0.45)'
            : undefined,
        }}
      >
        <span className="syn-fixai-ring" aria-hidden="true" />
        <BrainCircuit className="syn-fixai-icon" aria-hidden="true" />
        <span className="syn-fixai-text">
          <span>FIX ALL</span>
          <strong>AI</strong>
          {isFilling && <small className="syn-fixai-pct">{fixRingState === 'error' ? '!' : `${progressPercent}%`}</small>}
        </span>
        <svg className="syn-fixai-wave" viewBox="0 0 60 16" aria-hidden="true">
          <path d="M0 8 L8 8 L11 3 L14 13 L17 1 L20 15 L23 5 L26 11 L29 7 L32 9 L35 4 L38 12 L41 6 L44 10 L47 8 L60 8" />
        </svg>
      </button>
      {isFilling && (
        <ProgressRing
          className="syn-fixai-progress"
          percent={progressPercent}
          size={180}
          state={fixRingState}
          working={p.running && /think|stem/i.test(p.stage ?? '')}
          label={fixStageText}
          ariaLabel="Fix All with AI progress"
          hideText
        />
      )}
      </div>
      <div id="syn-fixai-status" className="syn-fixai-status" role="status" aria-live="polite">
        {p.running ? `${fixStageText} · ${progressPercent}%` : fixRingState === 'stopped' ? 'Stopped · nothing more will be changed' : fixRingState === 'error' ? `Fix All failed${p.fixError ? `: ${p.fixError}` : ''}` : p.hasTrack ? 'AI POWERED · ADAPTIVE · VERIFIED' : 'IMPORT A TRACK TO ENABLE'}
      </div>
      {p.onAskAi && (
        <button type="button" className="syn-askai" onClick={p.onAskAi} aria-label="Ask AI: open the AI Assistant to plan, explain and review changes step by step">
          <MessageSquareText className="w-4 h-4" aria-hidden="true" /> Ask AI
          <small>Assistant · plan &amp; explain</small>
        </button>
      )}
      {p.running && (
        <button type="button" className="syn-fixai-stop" onClick={p.onStop}>
          <Square className="w-3 h-3" /> Stop
        </button>
      )}
      {p.aiFallbackBanner && (
        <p className="syn-fixai-notice" role="status" data-testid="console-ai-fallback-banner">{p.aiFallbackBanner}</p>
      )}
      {p.aiNotice && (
        <p className="syn-fixai-notice" role="status" data-testid="console-ai-limit-notice">{p.aiNotice}</p>
      )}
      {p.aiChanges}
    </div>
  );

  return (
    <section className="syn-console" aria-label="SYN-MASTER console" data-testid="syn-console" data-mode={p.mode}>
      <LightRibbons className="syn-console-ribbons" />

      <div className="syn-flow-top">
        <section className="syn-card syn-eq-panel syn-area-eq" data-testid="central-spectrum" aria-label="Master EQ and spectrum">
          <StepLabel n={1} text="Import & EQ" hint="Waveform timeline behind the live EQ response" className="syn-eq-step-label" />
          <div className="syn-eq-head">
            <div>
              <h2 className="syn-eq-title">SYN EQ</h2>
              <p className="syn-eq-sub">{eq ? eq.name : 'Precision · Color · Balance'}{p.sampleRate ? ` · ${(p.sampleRate / 1000).toFixed(1)} kHz` : ''}</p>
            </div>
            <div className="syn-seg" role="group" aria-label="EQ view">
              {([['eq', 'EQ'], ['dyneq', 'Dynamic EQ'], ['matcheq', 'Match EQ'], ['vocal', 'Vocal'], ['spectrum', 'Live spectrum'], ['spectrogram', 'Spectrogram']] as const).map(([id, label]) => (
                <button key={id} type="button" aria-pressed={eqView === id} className={eqView === id ? 'is-on' : ''} onClick={() => setEqView(id)}>{label}</button>
              ))}
            </div>
            {p.timelineTransport}
          </div>
          {eqView === 'matcheq' ? (
            <React.Suspense fallback={<div className="syn-eq-empty" role="status"><p>Loading Match EQ…</p></div>}>
              <MatchEQPanel
                module={matchEq}
                onAdd={addMatchEq}
                onChange={(next) => { if (matchEq) setParams<MatchEqParams>(matchEq, next); }}
                onToggle={(on) => { if (matchEq) patch(matchEq.id, { enabled: true, bypassed: !on }); }}
              />
            </React.Suspense>
          ) : eqView === 'vocal' ? (
            <React.Suspense fallback={<div className="syn-eq-empty" role="status"><p>Loading Vocal Rebalance…</p></div>}>
              <VocalRebalancePanel
                module={vocalRb}
                onAdd={addVocalRebalance}
                onChange={(next) => { if (vocalRb) setParams<VocalRebalanceParams>(vocalRb, next); }}
                onToggle={(on) => { if (vocalRb) patch(vocalRb.id, { enabled: true, bypassed: !on }); }}
              />
            </React.Suspense>
          ) : eqView === 'dyneq' ? (
            <React.Suspense fallback={<div className="syn-eq-empty" role="status"><p>Loading Dynamic EQ…</p></div>}>
            <DynamicEQPanel
              module={dynEq}
              sampleRate={p.sampleRate}
              preSpectrum={p.source}
              postSpectrum={p.master}
              trace={p.dynamicEqTraces?.find((item) => item.moduleId === dynEq?.id)}
              waveformPeaks={p.blanketPeaks ?? p.waveformPeaks}
              durationSec={p.durationSec}
              onSeek={p.onSeek}
              fades={p.fades}
              onFadesChange={p.onFadesChange}
              onAdd={() => add('dynamic-eq')}
              onChange={(next) => { if (dynEq) setParams<DynamicEQParams>(dynEq, next); }}
              onToggle={(on) => { if (dynEq) patch(dynEq.id, { enabled: true, bypassed: !on }); }}
            />
            </React.Suspense>
          ) : eqView === 'eq' ? (
            eq ? (
              <ParametricEQ2
                variant="console"
                params={eq.params as ParametricEQParams}
                sampleRate={p.sampleRate}
                spectrum={p.master ?? p.source}
                waveformPeaks={p.blanketPeaks ?? p.waveformPeaks}
                durationSec={p.durationSec}
                onSeek={p.onSeek}
                fades={p.fades}
                onFadesChange={p.onFadesChange}
                preSpectrum={p.source}
                postSpectrum={p.master}
                outputGainDb={eq.outputGainDb}
                onOutputGainDb={(db) => patch(eq.id, { outputGainDb: db })}
                onChange={(next) => setParams<ParametricEQParams>(eq, next)}
              />
            ) : (
              <div className="syn-eq-empty"><AddModule type="parametric-eq" onAdd={add} /></div>
            )
          ) : (
            <SpectrumAndEQCanvas
              preAnalysis={p.source}
              postAnalysis={p.master}
              referenceAnalysis={p.referenceAnalysis}
              chain={p.chainBypassed ? [] : chain}
              sampleRate={p.sampleRate}
              mode={eqView === 'spectrogram' ? 'spectrogram' : 'spectrum'}
              waveformPeaks={p.waveformPeaks}
              durationSec={p.durationSec}
              onSeek={p.onSeek}
              heightClass="h-64"
            />
          )}
          {p.timeline}
        </section>
        <div className="syn-flow-step syn-flow-fix syn-area-fix">
          <StepLabel n={2} text="Fix with AI" hint="One press: analyze, fix, verify" />
          {fixButton}
        </div>
      </div>
      <StepLabel n={3} text="Master it yourself" hint="EQ, dynamics, tone, width and loudness: every change redraws the visuals" className="syn-area-step3 syn-step-wide" />

      <div className="syn-console-col syn-console-left">
        <Card title="Input" area="input" className="syn-card-knob">{inputKnob(116, 'Input trim')}</Card>
        <Card title="Transient" area="transient" className="syn-card-knob syn-only-desktop">
          {ts ? (
            <ArcKnob label="Attack" value={(ts.params as TransientShaperParams).attackDb} min={-12} max={12} step={0.1} defaultValue={2} unit="dB" signed bipolar accent="blue" size={116}
              rangeLabels={['-12', '+12']} onChange={(v) => setParams<TransientShaperParams>(ts, { attackDb: v })} />
          ) : (
            <AddModule type="transient-shaper" onAdd={add} />
          )}
        </Card>
        <Card title="Stereo Image" area="stereo" className="syn-card-stereo">
          <button type="button" className="syn-scope-btn" onClick={p.onOpenStereoLab} aria-label="Open the stereo analysis workspace">
            <StereoScope channels={p.scopeChannels} size={128} />
          </button>
          <StereoMeters correlation={shown ? shown.phaseCorrelation : null} balanceDb={shown ? shown.lrBalanceDb : null} />
          <dl className="syn-readouts">
            <div><dt>Width</dt><dd>{shown ? `${Math.round(shown.stereoWidth * 100)}%` : '—'}</dd></div>
            <div><dt>Mono</dt><dd>{shown ? `${Math.round(shown.monoCompatibilityScore)}` : '—'}</dd></div>
            <div><dt>Low corr</dt><dd>{shown ? fmtSigned(shown.lowEndCorrelation, 2) : '—'}</dd></div>
          </dl>
          {shown?.stereoBandCorrelation && (
            <dl className="syn-readouts syn-band-readouts" aria-label="Per-band correlation">
              <div><dt>Low</dt><dd>{fmtSigned(shown.stereoBandCorrelation.low, 2)}</dd></div>
              <div><dt>Mid</dt><dd>{fmtSigned(shown.stereoBandCorrelation.mid, 2)}</dd></div>
              <div><dt>High</dt><dd>{fmtSigned(shown.stereoBandCorrelation.high, 2)}</dd></div>
            </dl>
          )}
        </Card>
      </div>

      <div className="syn-console-col syn-console-center">
        <div className="syn-console-bottom">
          <Card title="Global" area="global" className="syn-card-global">
            <label className="syn-field">
              <span>Target</span>
              <select value={p.targetPresetId ?? ''} onChange={(e) => p.onTargetPreset(e.target.value)} disabled={p.running} aria-label="Loudness target">
                {p.targetPresetId === null && <option value="">{p.targetLabel}</option>}
                {LOUDNESS_TARGET_PRESETS.map((t) => (
                  <option key={t.id} value={t.id}>{t.label} ({t.targetLufs} LUFS)</option>
                ))}
              </select>
            </label>
            {modeInfo && (
              <div className="syn-mode-chip" title={modeInfo.hint}>
                <span>Mode</span><b>{modeInfo.label}</b>
                <small>{modeInfo.hint}</small>
              </div>
            )}
            <div className={`syn-global-status${gate ? (gate.passed ? ' is-pass' : ' is-fail') : ''}`}>{statusLine}</div>
            {p.notice && <div className="syn-global-notice" title={p.notice}>{p.notice}</div>}
            <div className="syn-progress" aria-hidden="true"><span style={{ width: `${Math.max(p.running ? 6 : 0, pct)}%` }} /></div>
            {!p.hasTrack && (
              <div className="syn-global-actions">
                <label className="syn-btn-ghost syn-file-btn">
                  <Upload className="w-3.5 h-3.5" /> Import
                  <input type="file" accept="audio/*,.wav,.flac,.mp3,.aac,.m4a,.ogg,.aiff,.aif" onChange={(e) => { const f = e.target.files?.[0]; if (f) p.onImport(f); e.target.value = ''; }} />
                </label>
                <button type="button" className="syn-btn-ghost" onClick={p.onDemo}>Load demo session</button>
              </div>
            )}
          </Card>
          <div className="syn-export-step syn-area-export">
            <StepLabel n={4} text="Export" />
            <button type="button" className="syn-export-master" onClick={p.onExport} disabled={!p.hasTrack || !p.onExport || p.running}
              aria-label="Export Master: choose format and render the final master">
              <Download className="w-5 h-5" aria-hidden="true" />
              <span>Export Master</span>
            </button>
          </div>
          <Card title="Presets" area="presets" className="syn-card-presets">
            <select value={presetId} onChange={(e) => setPresetId(e.target.value)} aria-label="Mastering preset" className="syn-preset-select">
              {p.presets.map((pr) => (
                <option key={pr.id} value={pr.id}>{pr.name}</option>
              ))}
            </select>
            {suggestedPreset === presetId && modeInfo && <div className="syn-preset-suggest">Suggested for {modeInfo.label} mode</div>}
            <p className="syn-preset-desc">{p.presets.find((x) => x.id === presetId)?.description}</p>
            <button type="button" className="syn-btn-ghost" disabled={p.running} onClick={() => { const pr = p.presets.find((x) => x.id === presetId); if (pr) p.onApplyPreset(pr); }}>
              Load preset chain
            </button>
          </Card>
        </div>
      </div>

      <div className="syn-console-col syn-console-right">
        <Card title="Dynamics" area="dynk" className="syn-card-knob syn-only-desktop">
          {comp ? (
            <ArcKnob label="Threshold" value={(comp.params as CompressorParams).thresholdDb} min={-40} max={0} step={0.5} defaultValue={-16} unit="dB" accent="gold" size={116}
              caption={`Ratio ${(comp.params as CompressorParams).ratio.toFixed(1)}:1`} onChange={(v) => setParams<CompressorParams>(comp, { thresholdDb: v })} />
          ) : (
            <AddModule type="compressor" onAdd={add} />
          )}
        </Card>
        <Card title="Color & Tone" area="color" className="syn-card-knob syn-only-desktop">
          {sat ? (
            <ArcKnob label="Drive" value={(sat.params as SaturationParams).drive} min={0} max={100} step={1} defaultValue={22} unit="%" precision={0} accent="gold" size={116}
              caption={`${(sat.params as SaturationParams).flavor} saturation`} onChange={(v) => setParams<SaturationParams>(sat, { drive: v })} />
          ) : (
            <AddModule type="saturation" onAdd={add} />
          )}
        </Card>
        <Card title="Output" area="output" className="syn-card-knob syn-card-output">{outputKnob(116, 'Ceiling')}</Card>
        <Card title="Loudness" area="loud" className="syn-card-loud">
          <div className="syn-loud-value"><strong>{lufs !== null ? lufs.toFixed(1) : '—'}</strong> <span>LUFS</span></div>
          <div className="syn-loud-target">Target {p.targetLufs} LUFS · TP {tp !== null ? tp.toFixed(2) : '—'} / {p.maxTruePeakDb} dBTP</div>
          <LoudnessBar lufs={lufs} targetLufs={p.targetLufs} disabled={p.running} onTarget={p.onTargetLufs} />
          <LiveLevel />
          {peakStageTelemetry.length > 0 && (
            <div className="syn-loud-src" data-testid="render-peak-telemetry">
              Last render · peak stage {peakStageInputDb!.toFixed(1)} → {peakStageOutputDb!.toFixed(1)} dBFS · GR {peakStageGainReductionDb!.toFixed(1)} dB
            </div>
          )}
          <div className="syn-loud-src">{p.master ? 'Measured on the rendered master' : p.source ? 'Source measurement' : 'No signal'}</div>
        </Card>
      </div>

      <Card title="Dynamics" area="dynf" className="syn-card-faders syn-only-mobile">
        <div className="syn-fader-row">
          {ts ? (
            <>
              <GlowFader label="Transient" value={(ts.params as TransientShaperParams).attackDb} min={-12} max={12} step={0.1} defaultValue={2} unit="dB" signed onChange={(v) => setParams<TransientShaperParams>(ts, { attackDb: v })} />
              <GlowFader label="Sustain" value={(ts.params as TransientShaperParams).sustainDb} min={-12} max={12} step={0.1} defaultValue={0} unit="dB" signed onChange={(v) => setParams<TransientShaperParams>(ts, { sustainDb: v })} />
            </>
          ) : (
            <AddModule type="transient-shaper" onAdd={add} />
          )}
          {find('maximizer') && (
            <GlowFader label="Punch" value={(find('maximizer')!.params as MaximizerParams).transientEmphasis} min={0} max={100} step={1} defaultValue={25} unit="%" precision={0}
              onChange={(v) => setParams<MaximizerParams>(find('maximizer')!, { transientEmphasis: v })} />
          )}
        </div>
      </Card>
      <Card title="Tonal Balance" area="tonal" className="syn-card-faders syn-only-mobile">
        <div className="syn-fader-row">
          {tonal ? (
            <>
              <GlowFader readOnly label="Low" value={tonal.low} min={-12} max={12} accent="gold" valueText={`${fmtSigned(tonal.low)} dB`} />
              <GlowFader readOnly label="Mid" value={tonal.mid} min={-12} max={12} accent="blue" valueText={`${fmtSigned(tonal.mid)} dB`} />
              <GlowFader readOnly label="High" value={tonal.high} min={-12} max={12} accent="blue" valueText={`${fmtSigned(tonal.high)} dB`} />
            </>
          ) : (
            <p className="syn-card-note">Measured after import</p>
          )}
        </div>
      </Card>
    </section>
  );
};
