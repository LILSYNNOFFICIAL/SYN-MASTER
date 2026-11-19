import React, { useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Check,
  CheckCircle2,
  Cpu,
  Pause,
  Play,
  Plug,
  RotateCcw,
  ScanSearch,
  Sliders,
  Sparkles,
  Square,
  Undo2,
  XCircle,
} from 'lucide-react';
import type {
  AIMasteringStrategy,
  AudioAnalysis,
  CustomObjectiveSpec,
  DirectorActivityEntry,
  DirectorCheckpoint,
  DirectorOperatingMode,
  DirectorRecommendation,
  IterationPass,
  MasterFinalReport,
  MasteringObjectiveId,
  ProcessorModule,
  QCReport,
} from '../types/mastering';
import type { ExplainableMasterPlan } from '../director/directorEngine';

interface Props {
  preAnalysis: AudioAnalysis | null;
  postAnalysis: AudioAnalysis | null;
  referenceAnalysis: AudioAnalysis | null;
  operatingMode: DirectorOperatingMode;
  objectiveId: MasteringObjectiveId;
  customObjective: CustomObjectiveSpec;
  useGeminiCloud: boolean;
  canUndo: boolean;
  aiStrategy: AIMasteringStrategy | null;
  directorPlan: ExplainableMasterPlan | null;
  directorReport: MasterFinalReport | null;
  qcReport: QCReport | null;
  iterations: IterationPass[];
  activityLog: DirectorActivityEntry[];
  checkpoints: DirectorCheckpoint[];
  directorRunning: boolean;
  directorPaused: boolean;
  directorStage: string;
  directorPass: number;
  maxIterations: number;
  convergenceThreshold: number;
  aiLoading: boolean;
  aiError: string | null;
  onChangeOperatingMode: (mode: DirectorOperatingMode) => void;
  onChangeObjectiveId: (id: MasteringObjectiveId) => void;
  onChangeCustomObjective: (spec: CustomObjectiveSpec) => void;
  onChangeUseGeminiCloud: (enabled: boolean) => void;
  onChangeMaxIterations: (max: number) => void;
  onChangeConvergenceThreshold: (val: number) => void;
  onAnalyzeTrack: () => void;
  onRunMasterDirector: () => void;
  onPauseToggle: () => void;
  onStopDirector: () => void;
  onUndoLast: () => void;
  onApplyChain: (chain: ProcessorModule[]) => void;
  onApplyRecommendation: (rec: DirectorRecommendation) => void;
  onAuditionCheckpoint: (cp: DirectorCheckpoint) => void;
  onRestoreCheckpoint: (cp: DirectorCheckpoint) => void;
}

const MODE_LABELS: Array<{ id: DirectorOperatingMode; label: string; desc: string }> = [
  { id: 'manual', label: 'Manual', desc: 'Analyze & explain plan only. Zero automatic rack edits.' },
  { id: 'assisted', label: 'Assisted', desc: 'Approve individual recommendations or single verified pass.' },
  { id: 'autonomous', label: 'Autonomous', desc: 'Closed-loop MASTER -> Render -> Analyze -> QC -> Refine.' },
];

const OBJECTIVE_LABELS: Array<{ id: MasteringObjectiveId; label: string }> = [
  { id: 'transparent', label: 'Transparent' },
  { id: 'punchy', label: 'Punchy' },
  { id: 'warm', label: 'Warm' },
  { id: 'streaming', label: 'Streaming' },
  { id: 'custom', label: 'Custom' },
];

export const AiMasterView: React.FC<Props> = ({
  preAnalysis,
  postAnalysis,
  referenceAnalysis,
  operatingMode,
  objectiveId,
  customObjective,
  useGeminiCloud,
  canUndo,
  aiStrategy,
  directorPlan,
  directorReport,
  qcReport,
  activityLog,
  checkpoints,
  directorRunning,
  directorPaused,
  directorStage,
  directorPass,
  maxIterations,
  convergenceThreshold,
  aiLoading,
  aiError,
  onChangeOperatingMode,
  onChangeObjectiveId,
  onChangeCustomObjective,
  onChangeUseGeminiCloud,
  onChangeMaxIterations,
  onChangeConvergenceThreshold,
  onAnalyzeTrack,
  onRunMasterDirector,
  onPauseToggle,
  onStopDirector,
  onUndoLast,
  onApplyChain,
  onApplyRecommendation,
  onAuditionCheckpoint,
  onRestoreCheckpoint,
}) => {
  const [showAdvanced, setShowAdvanced] = useState(false);

  if (!preAnalysis) {
    return (
      <div className="p-8 rounded bg-[#111217] border border-[#242732] text-center">
        <p className="text-sm font-semibold text-[#F7F8FA]">SYN MASTER AI | Mastering Director</p>
        <p className="mt-1 text-xs text-[#9CA3AF]">
          Load a track first to enable autonomous analysis, explainable mastering plans, multi-objective evaluation, and closed-loop DSP refinement.
        </p>
      </div>
    );
  }

  const activeDiagnosis = directorReport?.diagnosis ?? directorPlan?.diagnosis ?? null;
  const activeRecommendations = directorReport?.recommendations ?? directorPlan?.recommendations ?? [];
  const activePluginSummary = directorReport?.pluginSummary ?? directorPlan?.pluginSummary ?? null;
  const activeEval = directorReport?.multiObjective ?? null;
  const effectivePost = directorReport?.postAnalysis ?? postAnalysis ?? preAnalysis;

  return (
    <div className="flex flex-col gap-4">
      {/* Director Control Header */}
      <div className="p-4 rounded bg-[#111217] border border-[#D4AF37]/35 flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-[11px] font-mono-tabular uppercase tracking-wider text-[#D4AF37]">
              Autonomous Mastering Intelligence
            </div>
            <h2 className="text-base font-bold text-[#F7F8FA]">
              SYN MASTER AI | Mastering Director
            </h2>
            <p className="text-xs text-[#9CA3AF]">
              Analyzes real audio telemetry, executes structured DSP/VST3 commands, evaluates results via independent SYN-QC, and refines cleanly within safeguards.
            </p>
          </div>

          {/* Primary Actions */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={directorRunning}
              onClick={onAnalyzeTrack}
              className="px-3 py-2 rounded bg-[#181A22] border border-[#2F3340] text-xs font-semibold text-[#F7F8FA] hover:border-[#D4AF37] disabled:opacity-50 flex items-center gap-1.5"
            >
              <ScanSearch className="w-3.5 h-3.5 text-[#38BDF8]" />
              Analyze
            </button>
            <button
              type="button"
              disabled={directorRunning || aiLoading}
              onClick={onRunMasterDirector}
              data-testid="director-master-button"
              className="px-4 py-2 rounded bg-[#D4AF37] text-[#070709] text-xs font-extrabold tracking-wide hover:bg-[#F2CA52] disabled:opacity-50 flex items-center gap-1.5"
            >
              <Sparkles className="w-3.5 h-3.5" />
              {directorRunning
                ? `${directorStage || 'Mastering'}...`
                : operatingMode === 'manual'
                  ? 'Generate Plan (Manual)'
                  : operatingMode === 'assisted'
                    ? 'MASTER (Assisted Pass)'
                    : 'MASTER'}
            </button>
            {directorRunning && (
              <>
                <button
                  type="button"
                  onClick={onPauseToggle}
                  className="px-2.5 py-2 rounded bg-[#181A22] border border-[#F59E0B]/50 text-xs font-semibold text-[#F59E0B] hover:bg-[#F59E0B]/10 flex items-center gap-1"
                >
                  {directorPaused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
                  {directorPaused ? 'Resume' : 'Pause'}
                </button>
                <button
                  type="button"
                  onClick={onStopDirector}
                  className="px-2.5 py-2 rounded bg-[#181A22] border border-[#EF4444]/60 text-xs font-semibold text-[#FCA5A5] hover:bg-[#EF4444]/15 flex items-center gap-1"
                >
                  <Square className="w-3.5 h-3.5" />
                  Stop
                </button>
              </>
            )}
            <button
              type="button"
              disabled={!canUndo || directorRunning}
              onClick={onUndoLast}
              className="px-2.5 py-2 rounded bg-[#181A22] border border-[#2F3340] text-xs text-[#C5CDD8] hover:border-[#D4AF37] disabled:opacity-35 flex items-center gap-1"
            >
              <Undo2 className="w-3.5 h-3.5" />
              Undo
            </button>
          </div>
        </div>

        {/* Operating Mode & Mastering Objective Controls */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 pt-2 border-t border-[#222530]">
          {/* Operating Mode */}
          <div className="flex flex-col gap-1.5">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-[#9CA3AF]">
              Operating Mode
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {MODE_LABELS.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => onChangeOperatingMode(m.id)}
                  className={`p-2 rounded border text-left transition-colors ${
                    operatingMode === m.id
                      ? 'bg-[#D4AF37]/15 border-[#D4AF37] text-[#F2CA52]'
                      : 'bg-[#0C0D12] border-[#242732] text-[#C5CDD8] hover:border-[#3A3F50]'
                  }`}
                >
                  <div className="text-xs font-bold">{m.label}</div>
                  <div className="text-[10px] text-[#9CA3AF] leading-tight mt-0.5">{m.desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Mastering Objective */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-[#9CA3AF]">
                Mastering Objective {referenceAnalysis ? '· Reference Loaded' : ''}
              </span>
              <button
                type="button"
                onClick={() => setShowAdvanced((s) => !s)}
                className="text-[11px] text-[#38BDF8] hover:underline flex items-center gap-1"
              >
                <Sliders className="w-3 h-3" />
                {showAdvanced ? 'Hide Safeguards' : 'Safeguards & Cloud'}
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {OBJECTIVE_LABELS.map((obj) => (
                <button
                  key={obj.id}
                  type="button"
                  onClick={() => onChangeObjectiveId(obj.id)}
                  className={`px-3 py-1.5 rounded border text-xs font-semibold ${
                    objectiveId === obj.id
                      ? 'bg-[#D4AF37] text-[#070709] border-[#F2CA52]'
                      : 'bg-[#0C0D12] border-[#262934] text-[#C5CDD8] hover:border-[#D4AF37]/60'
                  }`}
                >
                  {obj.label}
                </button>
              ))}
            </div>

            {objectiveId === 'custom' && (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 p-2.5 rounded bg-[#0C0D12] border border-[#242732] text-[11px]">
                <label className="flex flex-col gap-0.5 text-[#9CA3AF]">
                  Target LUFS
                  <input
                    type="number"
                    step={0.5}
                    min={-24}
                    max={-6}
                    value={customObjective.targetLufs}
                    onChange={(e) =>
                      onChangeCustomObjective({ ...customObjective, targetLufs: Number(e.target.value) })
                    }
                    className="bg-[#161820] border border-[#2B2E3A] rounded px-2 py-1 text-xs font-mono-tabular text-[#F7F8FA]"
                  />
                </label>
                <label className="flex flex-col gap-0.5 text-[#9CA3AF]">
                  Max True Peak (dBTP)
                  <input
                    type="number"
                    step={0.1}
                    min={-3.0}
                    max={-0.1}
                    value={customObjective.maxTruePeakDb}
                    onChange={(e) =>
                      onChangeCustomObjective({ ...customObjective, maxTruePeakDb: Number(e.target.value) })
                    }
                    className="bg-[#161820] border border-[#2B2E3A] rounded px-2 py-1 text-xs font-mono-tabular text-[#F7F8FA]"
                  />
                </label>
                <label className="flex flex-col gap-0.5 text-[#9CA3AF]">
                  Min DR (dB)
                  <input
                    type="number"
                    step={0.5}
                    min={4}
                    max={16}
                    value={customObjective.minDynamicRangeDb}
                    onChange={(e) =>
                      onChangeCustomObjective({
                        ...customObjective,
                        minDynamicRangeDb: Number(e.target.value),
                      })
                    }
                    className="bg-[#161820] border border-[#2B2E3A] rounded px-2 py-1 text-xs font-mono-tabular text-[#F7F8FA]"
                  />
                </label>
                <label className="flex flex-col gap-0.5 text-[#9CA3AF]">
                  Tonal Bias
                  <select
                    value={customObjective.tonalBias}
                    onChange={(e) =>
                      onChangeCustomObjective({
                        ...customObjective,
                        tonalBias: e.target.value as CustomObjectiveSpec['tonalBias'],
                      })
                    }
                    className="bg-[#161820] border border-[#2B2E3A] rounded px-2 py-1 text-xs text-[#F7F8FA]"
                  >
                    <option value="warm">Warm</option>
                    <option value="neutral">Neutral</option>
                    <option value="bright">Bright</option>
                  </select>
                </label>
                <label className="flex flex-col gap-0.5 text-[#9CA3AF]">
                  Stereo Preference
                  <select
                    value={customObjective.stereoPreference}
                    onChange={(e) =>
                      onChangeCustomObjective({
                        ...customObjective,
                        stereoPreference: e.target.value as CustomObjectiveSpec['stereoPreference'],
                      })
                    }
                    className="bg-[#161820] border border-[#2B2E3A] rounded px-2 py-1 text-xs text-[#F7F8FA]"
                  >
                    <option value="narrow">Focused / Narrow</option>
                    <option value="preserve">Preserve Source</option>
                    <option value="wide">Wide Stage</option>
                  </select>
                </label>
                <label className="flex items-center gap-1.5 text-[#C5CDD8] mt-3">
                  <input
                    type="checkbox"
                    checked={customObjective.preserveTransients}
                    onChange={(e) =>
                      onChangeCustomObjective({ ...customObjective, preserveTransients: e.target.checked })
                    }
                    className="accent-[#D4AF37]"
                  />
                  Preserve Transients
                </label>
              </div>
            )}

            {showAdvanced && (
              <div className="flex flex-wrap items-center gap-4 p-2.5 rounded bg-[#0C0D12] border border-[#242732] text-xs">
                <label className="flex items-center gap-1.5 text-[#C5CDD8]">
                  Max Iterations:
                  <select
                    aria-label="Max Autonomous Iterations"
                    value={maxIterations}
                    onChange={(e) => onChangeMaxIterations(Number(e.target.value))}
                    className="bg-[#161820] border border-[#2B2E3A] rounded px-2 py-1 font-mono-tabular text-[#F7F8FA]"
                  >
                    <option value={2}>2</option>
                    <option value={3}>3</option>
                    <option value={4}>4</option>
                    <option value={5}>5</option>
                  </select>
                </label>
                <label className="flex items-center gap-1.5 text-[#C5CDD8]">
                  Convergence Δ:
                  <input
                    type="number"
                    step={0.2}
                    min={0.2}
                    max={3.0}
                    value={convergenceThreshold}
                    onChange={(e) => onChangeConvergenceThreshold(Number(e.target.value))}
                    className="w-16 bg-[#161820] border border-[#2B2E3A] rounded px-2 py-1 font-mono-tabular text-[#F7F8FA]"
                  />
                </label>
                <label className="flex items-center gap-1.5 text-[#C5CDD8]">
                  <input
                    type="checkbox"
                    checked={useGeminiCloud}
                    onChange={(e) => onChangeUseGeminiCloud(e.target.checked)}
                    className="accent-[#D4AF37]"
                  />
                  Include Cloud Gemini Reasoning (when configured)
                </label>
              </div>
            )}
          </div>
        </div>

        {/* Live Progress Strip */}
        {(directorRunning || directorReport) && (
          <div className="p-2.5 rounded bg-[#0C0D12] border border-[#232632] flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-2">
              <Activity className={`w-4 h-4 ${directorRunning ? 'text-[#38BDF8] animate-pulse' : 'text-[#34D399]'}`} />
              <span className="font-semibold text-[#F7F8FA]">
                {directorRunning
                  ? `Stage: ${directorStage} (Pass ${directorPass} / ${maxIterations})${directorPaused ? ' · PAUSED' : ''}`
                  : `Director Status: ${directorReport?.status.toUpperCase()} — ${directorReport?.stopReason}`}
              </span>
            </div>
            {directorReport && (
              <div className="font-mono-tabular text-[#F2CA52]">
                Best Pass #{directorReport.bestPassNumber} · Fit {directorReport.multiObjective.engineeringFitIndex.toFixed(1)}/100
                {directorReport.rolledBack ? ' (Rolled Back to Best)' : ''}
              </div>
            )}
          </div>
        )}

        {aiError && (
          <div className="p-2.5 rounded bg-[#EF4444]/10 border border-[#EF4444]/40 text-xs text-[#FCA5A5]">
            {aiError} — Deterministic DSP Director remains fully functional locally.
          </div>
        )}
      </div>

      {/* Section 1: SYN-ANALYZE Intelligence + SYN-PLUGIN Inventory */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 p-4 rounded bg-[#111217] border border-[#242732] flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold uppercase tracking-wider text-[#D4AF37]">
              SYN-ANALYZE Track Diagnosis
            </h3>
            <span className="text-[11px] font-mono-tabular text-[#9CA3AF]">
              {activeDiagnosis?.artisticProfile ?? 'Click Analyze to inspect audio profile'}
            </span>
          </div>

          {activeDiagnosis ? (
            <div className="flex flex-col gap-2.5 text-xs">
              {activeDiagnosis.workingWell.length > 0 && (
                <div className="p-2.5 rounded bg-[#10B981]/10 border border-[#10B981]/30">
                  <div className="font-semibold text-[#34D399] mb-1">Working Well in Source</div>
                  <ul className="list-disc list-inside text-[#C5CDD8] flex flex-col gap-0.5">
                    {activeDiagnosis.workingWell.map((w, idx) => (
                      <li key={idx}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {activeDiagnosis.findings.map((f) => (
                  <div
                    key={f.id}
                    className={`p-2.5 rounded border ${
                      f.kind === 'technical-problem'
                        ? 'bg-[#EF4444]/8 border-[#EF4444]/35'
                        : f.kind === 'artistic-choice'
                          ? 'bg-[#38BDF8]/8 border-[#38BDF8]/30'
                          : 'bg-[#0C0D12] border-[#222530]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-bold text-[#F7F8FA]">{f.title}</span>
                      <span
                        className={`text-[10px] font-mono-tabular uppercase px-1.5 py-0.5 rounded ${
                          f.kind === 'technical-problem'
                            ? 'bg-[#EF4444]/20 text-[#FCA5A5]'
                            : f.kind === 'artistic-choice'
                              ? 'bg-[#38BDF8]/20 text-[#38BDF8]'
                              : 'bg-[#262934] text-[#C5CDD8]'
                        }`}
                      >
                        {f.kind.replace('-', ' ')}
                      </span>
                    </div>
                    <div className="text-[11px] font-mono-tabular text-[#F2CA52] mt-1">
                      {f.evidence.join(' · ')}
                    </div>
                    <p className="text-[11px] text-[#9CA3AF] mt-1">{f.explanation}</p>
                    {f.recommendedAction && (
                      <p className="text-[11px] text-[#D4AF37] mt-1">Action: {f.recommendedAction}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-xs text-[#9CA3AF]">
              Click <strong className="text-[#F2CA52]">Analyze</strong> or <strong className="text-[#F2CA52]">MASTER</strong> to diagnose loudness, spectral tilt, resonances, phase coherence, distortion, and noise floor.
            </p>
          )}
        </div>

        {/* SYN-PLUGIN Intelligence */}
        <div className="p-4 rounded bg-[#111217] border border-[#242732] flex flex-col gap-2.5">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold uppercase tracking-wider text-[#38BDF8] flex items-center gap-1.5">
              <Plug className="w-3.5 h-3.5" />
              SYN-PLUGIN Intelligence
            </h3>
            <span className="text-[10px] font-mono-tabular text-[#9CA3AF]">
              {activePluginSummary?.hostConnected ? 'HOST CONNECTED' : 'NATIVE ONLY'}
            </span>
          </div>
          <p className="text-xs text-[#C5CDD8]">
            {activePluginSummary?.statusSummary ??
              'Inspects only verified connected host VST3 inventory; never fabricates offline plugin execution.'}
          </p>
          {activePluginSummary?.matches.map((m) => (
            <div key={m.uid} className="p-2 rounded bg-[#0C0D12] border border-[#232632] text-[11px]">
              <div className="font-bold text-[#F7F8FA]">
                {m.name} <span className="text-[#38BDF8] font-mono-tabular">({m.role.toUpperCase()})</span>
              </div>
              <div className="text-[#9CA3AF]">{m.reason}</div>
              {m.recommendedParams.length > 0 && (
                <div className="mt-1 text-[#F2CA52] font-mono-tabular">
                  {m.recommendedParams.map((rp) => `${rp.paramName}=${rp.normalizedValue.toFixed(2)}`).join(' · ')}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Section 2: Before vs After + Multi-Objective Evaluation */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="p-4 rounded bg-[#111217] border border-[#242732] flex flex-col gap-3">
          <h3 className="text-xs font-bold uppercase tracking-wider text-[#D4AF37]">
            Measured Before vs After Telemetry
          </h3>
          <div className="grid grid-cols-3 gap-2 text-xs font-mono-tabular">
            {[
              {
                label: 'Integrated LUFS',
                pre: `${preAnalysis.integratedLufs.toFixed(1)}`,
                post: `${effectivePost.integratedLufs.toFixed(1)}`,
              },
              {
                label: 'True Peak (dBTP)',
                pre: `${preAnalysis.truePeakDb.toFixed(2)}`,
                post: `${effectivePost.truePeakDb.toFixed(2)}`,
              },
              {
                label: 'Dynamic Range',
                pre: `${preAnalysis.dynamicRangeDb.toFixed(1)} dB`,
                post: `${effectivePost.dynamicRangeDb.toFixed(1)} dB`,
              },
              {
                label: 'Crest Factor',
                pre: `${preAnalysis.crestFactorDb.toFixed(1)} dB`,
                post: `${effectivePost.crestFactorDb.toFixed(1)} dB`,
              },
              {
                label: 'Stereo / Low Corr',
                pre: `${preAnalysis.phaseCorrelation.toFixed(2)} / ${preAnalysis.lowEndCorrelation.toFixed(2)}`,
                post: `${effectivePost.phaseCorrelation.toFixed(2)} / ${effectivePost.lowEndCorrelation.toFixed(2)}`,
              },
              {
                label: 'THD / Noise Floor',
                pre: `${preAnalysis.thdEstimatePercent.toFixed(2)}% / ${(preAnalysis.noiseFloorDb ?? -72).toFixed(0)}dB`,
                post: `${effectivePost.thdEstimatePercent.toFixed(2)}% / ${(effectivePost.noiseFloorDb ?? -72).toFixed(0)}dB`,
              },
            ].map((row) => (
              <div key={row.label} className="p-2 rounded bg-[#0C0D12] border border-[#21242F]">
                <div className="text-[10px] text-[#9CA3AF] font-sans">{row.label}</div>
                <div className="text-[11px] text-[#9CA3AF] mt-0.5">Pre: {row.pre}</div>
                <div className="text-xs font-bold text-[#F2CA52]">Post: {row.post}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Multi-Objective Breakdown */}
        <div className="p-4 rounded bg-[#111217] border border-[#242732] flex flex-col gap-2.5">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold uppercase tracking-wider text-[#D4AF37]">
              Multi-Objective Evaluation
            </h3>
            {activeEval && (
              <span className="text-xs font-mono-tabular font-bold text-[#34D399]">
                Telemetry Fit: {activeEval.engineeringFitIndex.toFixed(1)} / 100
              </span>
            )}
          </div>
          {activeEval ? (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 text-[11px]">
                {activeEval.dimensions.map((d) => (
                  <div key={d.key} className="p-2 rounded bg-[#0C0D12] border border-[#21242F]">
                    <div className="flex items-center justify-between gap-1">
                      <span className="font-semibold text-[#F7F8FA] truncate">{d.label}</span>
                      <span
                        className={`font-mono-tabular text-[10px] uppercase ${
                          d.status === 'optimal'
                            ? 'text-[#34D399]'
                            : d.status === 'acceptable'
                              ? 'text-[#38BDF8]'
                              : d.status === 'attention'
                                ? 'text-[#F59E0B]'
                                : d.status === 'critical'
                                  ? 'text-[#EF4444]'
                                  : 'text-[#6B7280]'
                        }`}
                      >
                        {d.status === 'not-applicable' ? 'N/A' : `${d.score}%`}
                      </span>
                    </div>
                    <div className="text-[10px] font-mono-tabular text-[#9CA3AF] truncate mt-0.5">
                      {d.measuredSummary}
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-[10px] text-[#9CA3AF] italic">{activeEval.nonMeasurableNote}</p>
            </>
          ) : (
            <p className="text-xs text-[#9CA3AF]">
              Run MASTER to evaluate loudness, headroom, dynamics, transients, spectral balance, stereo integrity, THD, noise, and clipping independently.
            </p>
          )}
        </div>
      </div>

      {/* Section 3: Explainable Mastering Plan */}
      {(activeRecommendations.length > 0 || aiStrategy) && (
        <div className="p-4 rounded bg-[#111217] border border-[#242732] flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-xs font-bold uppercase tracking-wider text-[#D4AF37]">
                Explainable Mastering Plan ({activeRecommendations.length} Proposed Stage(s))
              </h3>
              {aiStrategy && (
                <p className="text-xs text-[#C5CDD8] mt-0.5">{aiStrategy.strategySummary}</p>
              )}
            </div>
            {(directorPlan?.chain.length ?? aiStrategy?.chain.length ?? 0) > 0 && (
              <button
                type="button"
                onClick={() => onApplyChain(directorPlan?.chain ?? aiStrategy!.chain)}
                className="px-3 py-1.5 rounded bg-[#D4AF37]/15 border border-[#D4AF37] text-xs font-semibold text-[#F2CA52] hover:bg-[#D4AF37] hover:text-[#070709]"
              >
                Apply Complete Plan to Rack
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
            {activeRecommendations.map((rec) => (
              <div
                key={rec.id}
                className="p-3 rounded bg-[#0C0D12] border border-[#222530] flex flex-col gap-1.5 text-xs"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-bold text-[#F2CA52] font-mono-tabular">
                    {rec.pluginName ?? rec.selectedProcessor}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-[#1D202A] text-[#C5CDD8]">
                      {rec.priority} · {rec.statementType}
                    </span>
                    {rec.commands.length > 0 && (
                      <button
                        type="button"
                        onClick={() => onApplyRecommendation(rec)}
                        className="px-2 py-0.5 rounded bg-[#D4AF37]/20 border border-[#D4AF37]/50 text-[10px] font-bold text-[#F2CA52] hover:bg-[#D4AF37] hover:text-[#070709]"
                      >
                        Apply Stage
                      </button>
                    )}
                  </div>
                </div>
                <div className="text-[#F7F8FA] font-semibold">{rec.characteristic}</div>
                <div className="text-[11px] font-mono-tabular text-[#38BDF8]">
                  Evidence: {rec.supportingMeasurements.join(' | ')}
                </div>
                <div className="text-[11px] text-[#C5CDD8]">Correction: {rec.proposedCorrection}</div>
                <div className="text-[11px] font-mono-tabular text-[#9CA3AF]">
                  Params: {rec.proposedParamsSummary}
                </div>
                <div className="text-[11px] text-[#34D399]">Expected: {rec.expectedResult}</div>
                <div className="text-[11px] text-[#F59E0B]">Tradeoffs: {rec.potentialTradeoffs}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Section 4: Iteration Checkpoints, QC Summary & Activity Log */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Iteration Checkpoints */}
        <div className="p-4 rounded bg-[#111217] border border-[#242732] flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold uppercase tracking-wider text-[#D4AF37]">
              Iteration Checkpoints &amp; Rollback ({checkpoints.length})
            </h3>
            {qcReport && (
              <span
                className={`text-[11px] font-mono-tabular font-bold flex items-center gap-1 ${
                  qcReport.overallStatus === 'pass'
                    ? 'text-[#34D399]'
                    : qcReport.overallStatus === 'warning'
                      ? 'text-[#F59E0B]'
                      : 'text-[#EF4444]'
                }`}
              >
                {qcReport.overallStatus === 'pass' ? (
                  <CheckCircle2 className="w-3.5 h-3.5" />
                ) : qcReport.overallStatus === 'warning' ? (
                  <AlertTriangle className="w-3.5 h-3.5" />
                ) : (
                  <XCircle className="w-3.5 h-3.5" />
                )}
                QC {qcReport.overallStatus.toUpperCase()} ({qcReport.passedCount}/{qcReport.checks.length})
              </span>
            )}
          </div>

          {checkpoints.length === 0 ? (
            <p className="text-xs text-[#9CA3AF]">
              Checkpoints appear after each closed-loop render &amp; QC verification pass.
            </p>
          ) : (
            <div className="flex flex-col gap-2 max-h-72 overflow-y-auto pr-1">
              {checkpoints.map((cp) => (
                <div
                  key={cp.id}
                  className={`p-2.5 rounded border flex flex-col gap-1.5 text-xs ${
                    cp.isBest
                      ? 'bg-[#D4AF37]/10 border-[#D4AF37]'
                      : 'bg-[#0C0D12] border-[#222530]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold text-[#F7F8FA]">
                      Pass {cp.passNumber}: {cp.label}{' '}
                      {cp.isBest && <span className="text-[#F2CA52]">(BEST)</span>}
                    </span>
                    <span className="font-mono-tabular text-[11px] text-[#34D399]">
                      Fit {cp.multiObjective.engineeringFitIndex.toFixed(1)} · QC {cp.qcReport.overallStatus.toUpperCase()}
                    </span>
                  </div>
                  <div className="text-[11px] font-mono-tabular text-[#9CA3AF] flex flex-wrap gap-3">
                    <span>LUFS {cp.analysis.integratedLufs.toFixed(1)}</span>
                    <span>TP {cp.analysis.truePeakDb.toFixed(2)}</span>
                    <span>DR {cp.analysis.dynamicRangeDb.toFixed(1)} dB</span>
                    <span>THD {cp.analysis.thdEstimatePercent.toFixed(2)}%</span>
                  </div>
                  <div className="flex gap-2 pt-0.5">
                    <button
                      type="button"
                      onClick={() => onAuditionCheckpoint(cp)}
                      className="px-2.5 py-1 rounded bg-[#181A22] border border-[#2B2E3A] text-[11px] text-[#F7F8FA] hover:border-[#D4AF37] flex items-center gap-1"
                    >
                      <Play className="w-3 h-3" />
                      Audition
                    </button>
                    <button
                      type="button"
                      onClick={() => onRestoreCheckpoint(cp)}
                      className="px-2.5 py-1 rounded bg-[#D4AF37]/20 border border-[#D4AF37]/60 text-[11px] text-[#F2CA52] hover:bg-[#D4AF37] hover:text-[#070709] flex items-center gap-1"
                    >
                      <RotateCcw className="w-3 h-3" />
                      Restore Checkpoint
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Autonomous Activity Log */}
        <div className="p-4 rounded bg-[#111217] border border-[#242732] flex flex-col gap-3">
          <h3 className="text-xs font-bold uppercase tracking-wider text-[#D4AF37] flex items-center gap-1.5">
            <Cpu className="w-3.5 h-3.5" />
            Director Activity Log (Observations vs Hypotheses vs Verified Results)
          </h3>
          {activityLog.length === 0 ? (
            <p className="text-xs text-[#9CA3AF]">
              Chronological telemetry observations, chain commands, QC findings, and rollbacks appear here.
            </p>
          ) : (
            <div className="flex flex-col gap-1.5 max-h-72 overflow-y-auto pr-1 text-[11px]">
              {activityLog.map((entry) => (
                <div
                  key={entry.id}
                  className="p-2 rounded bg-[#0C0D12] border border-[#20232E] flex flex-col gap-0.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={`font-mono-tabular uppercase text-[10px] font-bold ${
                        entry.kind === 'verified-result'
                          ? 'text-[#34D399]'
                          : entry.kind === 'hypothesis'
                            ? 'text-[#38BDF8]'
                            : entry.kind === 'command'
                              ? 'text-[#F2CA52]'
                              : entry.kind === 'warning'
                                ? 'text-[#F59E0B]'
                                : 'text-[#C5CDD8]'
                      }`}
                    >
                      [P{entry.passNumber} · {entry.phase.toUpperCase()} · {entry.kind.toUpperCase()}]
                    </span>
                    <span className="font-mono-tabular text-[10px] text-[#6B7280]">
                      {new Date(entry.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                  <div className="text-[#F7F8FA]">{entry.message}</div>
                  {entry.details && <div className="text-[#9CA3AF] font-mono-tabular">{entry.details}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Section 5: Final Mastering Report Summary */}
      {directorReport && (
        <div className="p-4 rounded bg-[#111217] border border-[#34D399]/35 flex flex-col gap-2 text-xs">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold uppercase tracking-wider text-[#34D399] flex items-center gap-1.5">
              <Check className="w-4 h-4" />
              Final Mastering Report ({directorReport.objective.label} · {directorReport.iterationsExecuted} Pass(es))
            </h3>
            <span className="font-mono-tabular text-[#9CA3AF]">
              Best Pass #{directorReport.bestPassNumber} · QC {directorReport.qcReport.overallStatus.toUpperCase()}
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="p-2.5 rounded bg-[#0C0D12] border border-[#1E222B]">
              <div className="font-semibold text-[#34D399] mb-1">Verified Before/After Delta</div>
              <ul className="list-disc list-inside text-[#C5CDD8] flex flex-col gap-0.5">
                {directorReport.verifiedImprovements.map((imp, i) => (
                  <li key={i}>{imp}</li>
                ))}
              </ul>
            </div>
            <div className="p-2.5 rounded bg-[#0C0D12] border border-[#1E222B]">
              <div className="font-semibold text-[#F2CA52] mb-1">Remaining Tradeoffs &amp; Notes</div>
              <ul className="list-disc list-inside text-[#C5CDD8] flex flex-col gap-0.5">
                {directorReport.remainingTradeoffs.map((tr, i) => (
                  <li key={i}>{tr}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
