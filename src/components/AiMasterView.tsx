import React, { useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Check,
  CheckCircle2,
  Cpu,
  Download,
  Pause,
  Play,
  Plug,
  RotateCcw,
  ScanSearch,
  Sliders,
  ShieldCheck,
  Sparkles,
  Square,
  Undo2,
  XCircle,
} from 'lucide-react';
import type {
  AiChainLifecycleState,
  AIMasteringStrategy,
  AudioAnalysis,
  CustomObjectiveSpec,
  DirectorActivityEntry,
  DirectorCheckpoint,
  DirectorDiagnosisReport,
  DirectorOperatingMode,
  DirectorRecommendation,
  FindingVerificationStatus,
  IterationPass,
  MasterFinalReport,
  MasteringObjectiveId,
  PostFixVerificationReport,
  ProcessorModule,
  QCReport,
} from '../types/mastering';
import type { ExplainableMasterPlan } from '../director/directorEngine';
import { computeRegionEnergyDb } from '../director/analyzeIntelligence';
import { LiveSpectrum } from './console/LiveSpectrum';
import type { MasteringDiagnosticRunSummary } from '../director/tempMasteringWorkspace';

interface Props {
  preAnalysis: AudioAnalysis | null;
  postAnalysis: AudioAnalysis | null;
  postAnalysisStatus?: 'idle' | 'processing' | 'ready' | 'failed';
  postAnalysisError?: string | null;
  baselineDiagnosis?: DirectorDiagnosisReport | null;
  postFixVerification?: PostFixVerificationReport | null;
  referenceAnalysis: AudioAnalysis | null;
  operatingMode: DirectorOperatingMode;
  objectiveId: MasteringObjectiveId;
  customObjective: CustomObjectiveSpec;
  useGeminiCloud: boolean;
  canUndo: boolean;
  hasPreAiSnapshot: boolean;
  aiChainAccepted: boolean | null;
  aiLifecycleState: AiChainLifecycleState;
  aiStrategy: AIMasteringStrategy | null;
  directorPlan: ExplainableMasterPlan | null;
  directorReport: MasterFinalReport | null;
  qcReport: QCReport | null;
  iterations: IterationPass[];
  activityLog: DirectorActivityEntry[];
  checkpoints: DirectorCheckpoint[];
  diagnosticRuns: MasteringDiagnosticRunSummary[];
  latestDiagnosticRun: MasteringDiagnosticRunSummary | null;
  diagnosticArchiveStatus: 'loading' | 'idle' | 'saving' | 'saved' | 'session-only' | 'failed';
  diagnosticBundleAvailable: boolean;
  onDownloadDiagnosticRun: (runId: string) => void;
  directorRunning: boolean;
  directorPaused: boolean;
  directorStage: string;
  directorPass: number;
  maxIterations: number;
  convergenceThreshold: number;
  aiLoading: boolean;
  aiError: string | null;
  /** Friendly notice (e.g. cloud AI limit reached; FIX ALL used the local DSP planner). */
  aiNotice?: string | null;
  /** "What AI changed" list shown after a FIX ALL / CHAIN WITH AI run. */
  aiChanges?: React.ReactNode;
  onChangeOperatingMode: (mode: DirectorOperatingMode) => void;
  onChangeObjectiveId: (id: MasteringObjectiveId) => void;
  onChangeCustomObjective: (spec: CustomObjectiveSpec) => void;
  onChangeUseGeminiCloud: (enabled: boolean) => void;
  onChangeMaxIterations: (max: number) => void;
  onChangeConvergenceThreshold: (val: number) => void;
  onAnalyzeTrack: () => void;
  onRunMasterDirector: () => void;
  onFixAllProblems: () => void;
  onPauseToggle: () => void;
  onStopDirector: () => void;
  onUndoLast: () => void;
  onAcceptAiChain: () => void;
  onRestorePreAiChain: () => void;
  onApplyChain: (chain: ProcessorModule[]) => void;
  onApplyRecommendation: (rec: DirectorRecommendation) => void;
  onAuditionCheckpoint: (cp: DirectorCheckpoint) => void;
  onRestoreCheckpoint: (cp: DirectorCheckpoint) => void;
}

const MODE_LABELS: Array<{ id: DirectorOperatingMode; label: string; desc: string }> = [
  { id: 'manual', label: 'Manual', desc: 'Analyze & explain plan only. Zero automatic rack edits.' },
  { id: 'assisted', label: 'Assisted', desc: 'Single verified closed-loop pass with manual sign-off.' },
  { id: 'autonomous', label: 'Autonomous', desc: 'Closed-loop CHAIN WITH AI -> Render -> Measure -> Refine.' },
];

const OBJECTIVE_LABELS: Array<{ id: MasteringObjectiveId; label: string }> = [
  { id: 'streaming', label: 'Streaming' },
  { id: 'commercial-loudness', label: 'Commercial Loudness' },
  { id: 'dynamic', label: 'Dynamic' },
  { id: 'cinematic', label: 'Cinematic' },
  { id: 'electronic', label: 'Electronic' },
  { id: 'hip-hop', label: 'Hip-Hop' },
  { id: 'pop', label: 'Pop' },
  { id: 'acoustic', label: 'Acoustic' },
  { id: 'vocal-focused', label: 'Vocal-Focused' },
  { id: 'transparent', label: 'Transparent' },
  { id: 'punchy', label: 'Punchy' },
  { id: 'warm', label: 'Warm' },
  { id: 'custom', label: 'Custom' },
];

function isSourceLimitationFinding(findingId: string): boolean {
  // These defects are already baked into the premaster. The current stereo mastering
  // chain cannot reconstruct clipped peaks, restore dynamics removed upstream, or
  // prove source de-distortion. Keep them visible, but do not present them as a failed
  // mastering correction or invite the user to run the same repair repeatedly.
  return ['diag-clipping', 'diag-overcompressed', 'diag-thd'].includes(findingId);
}

function verificationBadgeClass(status: FindingVerificationStatus, sourceLimitation = false): string {
  if (sourceLimitation) return 'bg-[#F59E0B]/15 text-[#FBBF24] border border-[#F59E0B]/40';
  switch (status) {
    case 'RESOLVED':
      return 'bg-[#10B981]/20 text-[#34D399] border border-[#10B981]/40';
    case 'IMPROVED':
      return 'bg-[#38BDF8]/20 text-[#38BDF8] border border-[#38BDF8]/40';
    case 'PARTIALLY_RESOLVED':
      return 'bg-[#F59E0B]/20 text-[#F59E0B] border border-[#F59E0B]/40';
    case 'UNVERIFIED':
      return 'bg-[#9CA3AF]/20 text-[#E5E7EB] border border-[#6B7280]/50';
    case 'UNRESOLVED':
    case 'ACTIVE':
    default:
      return 'bg-[#EF4444]/20 text-[#FCA5A5] border border-[#EF4444]/40';
  }
}

function verificationCardClass(status: FindingVerificationStatus): string {
  switch (status) {
    case 'IMPROVED':
      return 'bg-[#38BDF8]/6 border-[#38BDF8]/35';
    case 'PARTIALLY_RESOLVED':
      return 'bg-[#F59E0B]/6 border-[#F59E0B]/35';
    case 'UNVERIFIED':
      return 'bg-[#9CA3AF]/6 border-[#6B7280]/45';
    case 'UNRESOLVED':
    case 'ACTIVE':
    default:
      return 'bg-[#EF4444]/8 border-[#EF4444]/35';
  }
}

export const AiMasterView: React.FC<Props> = ({
  preAnalysis,
  postAnalysis,
  postAnalysisStatus = 'idle',
  postAnalysisError = null,
  baselineDiagnosis = null,
  postFixVerification = null,
  referenceAnalysis,
  operatingMode,
  objectiveId,
  customObjective,
  useGeminiCloud,
  canUndo,
  hasPreAiSnapshot,
  aiChainAccepted,
  aiLifecycleState,
  aiStrategy,
  directorPlan,
  directorReport,
  qcReport,
  activityLog,
  checkpoints,
  diagnosticRuns,
  latestDiagnosticRun,
  diagnosticArchiveStatus,
  diagnosticBundleAvailable,
  onDownloadDiagnosticRun,
  directorRunning,
  directorPaused,
  directorStage,
  directorPass,
  maxIterations,
  convergenceThreshold,
  aiLoading,
  aiError,
  aiNotice,
  aiChanges,
  onChangeOperatingMode,
  onChangeObjectiveId,
  onChangeCustomObjective,
  onChangeUseGeminiCloud,
  onChangeMaxIterations,
  onChangeConvergenceThreshold,
  onAnalyzeTrack,
  onRunMasterDirector,
  onFixAllProblems,
  onPauseToggle,
  onStopDirector,
  onUndoLast,
  onAcceptAiChain,
  onRestorePreAiChain,
  onApplyChain,
  onApplyRecommendation,
  onAuditionCheckpoint,
  onRestoreCheckpoint,
}) => {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [selectedDiagnosticRunId, setSelectedDiagnosticRunId] = useState('');
  const availableDiagnosticRuns =
    latestDiagnosticRun && !diagnosticRuns.some((run) => run.runId === latestDiagnosticRun.runId)
      ? [latestDiagnosticRun, ...diagnosticRuns]
      : diagnosticRuns;
  const selectedDiagnosticRunIdValue = availableDiagnosticRuns.some(
    (run) => run.runId === selectedDiagnosticRunId,
  )
    ? selectedDiagnosticRunId
    : availableDiagnosticRuns[0]?.runId ?? '';

  const archiveStatusLabel = {
    loading: 'Checking local archive...',
    idle: 'No diagnostic runs saved yet.',
    saving: 'Writing diagnostic bundle...',
    saved: 'Persistent local archive available.',
    'session-only': 'Session-only fallback. Download before leaving this page.',
    failed: 'Archive index unavailable. The current bundle may still be downloadable.',
  }[diagnosticArchiveStatus];

  const diagnosticArchivePanel = (
    <section
      data-testid="diagnostic-archive-panel"
      className="p-3 rounded bg-[#111217] border border-[#38BDF8]/30 flex flex-col gap-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-xs font-bold uppercase tracking-wider text-[#38BDF8]">
            Fix All Diagnostic Archives
          </h3>
          <p className="text-[11px] text-[#9CA3AF]">
            Original measurements, diagnosis, processor settings, pass history, final QC, and unresolved findings.
          </p>
        </div>
        <span className="text-[10px] font-mono-tabular text-[#9CA3AF]">
          {diagnosticRuns.length} persistent run(s)
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {availableDiagnosticRuns.length > 0 ? (
          <select
            aria-label="Saved mastering diagnostic runs"
            value={selectedDiagnosticRunIdValue}
            onChange={(event) => setSelectedDiagnosticRunId(event.target.value)}
            className="min-w-0 flex-1 bg-[#0C0D12] border border-[#2B2E3A] rounded px-2 py-1.5 text-[11px] text-[#F7F8FA]"
          >
            {availableDiagnosticRuns.map((run) => (
              <option key={run.runId} value={run.runId}>
                {new Date(run.createdAt).toLocaleString()} · {run.trackName} · {run.status}
                {run.storage === 'memory' ? ' · SESSION ONLY' : ''}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-[11px] text-[#9CA3AF]">Run Fix All to create the first diagnostic bundle.</span>
        )}
        <button
          type="button"
          disabled={!selectedDiagnosticRunIdValue || (!diagnosticBundleAvailable && diagnosticRuns.length === 0)}
          onClick={() => {
            if (selectedDiagnosticRunIdValue) onDownloadDiagnosticRun(selectedDiagnosticRunIdValue);
          }}
          className="px-3 py-1.5 rounded bg-[#38BDF8]/15 border border-[#38BDF8]/50 text-[11px] font-bold text-[#7DD3FC] hover:bg-[#38BDF8]/25 disabled:opacity-40 flex items-center gap-1.5"
        >
          <Download className="w-3.5 h-3.5" />
          Download Diagnostic JSON
        </button>
      </div>
      <p className="text-[10px] text-[#9CA3AF]">{archiveStatusLabel}</p>
    </section>
  );

  if (!preAnalysis) {
    return (
      <div className="syn-ai-workspace" data-testid="workspace-empty-state" data-workspace="ai" data-syn-skin="instrument">
        <section className="syn-ai-hero" data-testid="workspace-hero" data-workspace="ai">
          <div className="syn-ai-hero-copy">
            <span className="syn-ai-eyebrow"><Sparkles size={14}/> SYN MASTER INTELLIGENCE</span>
            <h1>Mastering Director<span> / AI Assistant</span></h1>
            <p>Measurement-led mastering intelligence. Analyze the source, build a reasoned processing strategy, render through SYN-DSP, then independently verify the result.</p>
            <div className="syn-ai-state"><i/> WAITING FOR SOURCE AUDIO</div>
          </div>
          <div className="syn-ai-orb" data-testid="workspace-hero-graphic" aria-hidden="true">
            <div className="syn-ai-orb-ring ring-a"/><div className="syn-ai-orb-ring ring-b"/><div className="syn-ai-orb-core"><Sparkles size={42}/><b>SYN</b><small>AI ENGINE</small></div>
            <div className="syn-ai-orb-node node-a"/><div className="syn-ai-orb-node node-b"/><div className="syn-ai-orb-node node-c"/>
          </div>
          <div className="syn-ai-pipeline">
            <div className="is-ready"><span>01</span><b>ANALYZE</b><small>Audio measurements</small></div><i/>
            <div><span>02</span><b>PLAN</b><small>Explainable decisions</small></div><i/>
            <div><span>03</span><b>PROCESS</b><small>Real DSP execution</small></div><i/>
            <div><span>04</span><b>VERIFY</b><small>Independent QC</small></div>
          </div>
        </section>
        <div className="syn-ai-empty-grid">
          <div className="syn-ai-empty-card"><Activity/><b>Audio intelligence</b><p>Frequency balance, loudness, dynamics, stereo, transient integrity and distortion are measured from your imported source.</p></div>
          <div className="syn-ai-empty-card"><Sliders/><b>Explainable processing</b><p>Every proposed processor and parameter change includes a reason, an expected outcome and a way to verify it.</p></div>
          <div className="syn-ai-empty-card"><ShieldCheck/><b>Non-destructive control</b><p>Your source stays untouched. Review, audition, accept, undo or restore every AI-generated chain change.</p></div>
        </div>
        <div className="syn-ai-empty-note">IMPORT A TRACK IN THE LIBRARY TO ACTIVATE THE MASTERING DIRECTOR</div>
        <div className="mt-2 text-left">{diagnosticArchivePanel}</div>
      </div>
    );
  }

  const activeDiagnosis =
    baselineDiagnosis ?? directorReport?.diagnosis ?? directorPlan?.diagnosis ?? null;
  const activeRecommendations = directorReport?.recommendations ?? directorPlan?.recommendations ?? [];
  const activePluginSummary = directorReport?.pluginSummary ?? directorPlan?.pluginSummary ?? null;
  const activeEval = directorReport?.multiObjective ?? null;
  const effectiveVerification = postFixVerification ?? directorReport?.postFixVerification ?? null;
  const actionableActiveFindings = effectiveVerification?.activeFindings.filter(
    (finding) => !isSourceLimitationFinding(finding.findingId),
  ) ?? [];
  const sourceLimitations = effectiveVerification?.activeFindings.filter(
    (finding) => isSourceLimitationFinding(finding.findingId),
  ) ?? [];
  const effectivePost: AudioAnalysis | null = effectiveVerification
    ? effectiveVerification.analysisFresh && effectiveVerification.postAnalysis
      ? effectiveVerification.postAnalysis
      : null
    : postAnalysisStatus === 'ready' && postAnalysis
      ? postAnalysis
      : null;
  const preRegion150To400 = computeRegionEnergyDb(preAnalysis, 150, 400);
  const postRegion150To400 = effectivePost ? computeRegionEnergyDb(effectivePost, 150, 400) : null;
  const postFallbackLabel =
    postAnalysisStatus === 'processing'
      ? 'REANALYZING...'
      : postAnalysisStatus === 'failed' || effectiveVerification?.verificationError
        ? 'UNVERIFIED'
        : '—';

  return (
    <div className="syn-ai-workspace flex flex-col gap-4" data-syn-skin="instrument" data-workspace="ai">
      <section className="syn-ai-hero syn-ai-hero-compact" data-testid="workspace-hero" data-workspace="ai">
        <div className="syn-ai-hero-copy">
          <span className="syn-ai-eyebrow"><Sparkles size={14}/> SYN MASTER INTELLIGENCE</span>
          <h1>Mastering Director<span> / AI Assistant</span></h1>
          <p>Analyze. Decide. Process. Verify. Every mastering decision is tied to source measurements and checked against the rendered result.</p>
          <div className="syn-ai-state"><i className={directorRunning ? 'is-running' : ''}/>{directorRunning ? (directorStage || 'OPTIMIZATION IN PROGRESS').toUpperCase() : aiLifecycleState.toUpperCase()}</div>
        </div>
        <div className="syn-ai-mini-visual" data-testid="workspace-hero-graphic" aria-hidden="true">
          <LiveSpectrum bars={36} height={72} className="syn-ai-livespec" />
          <div className="syn-ai-mini-caption"><span>INPUT</span><b>AI / DSP / QC</b><span>OUTPUT</span></div>
        </div>
        <div className="syn-ai-pipeline">
          <div className={directorRunning ? 'is-ready is-active' : 'is-ready'}><span>01</span><b>ANALYZE</b><small>Audio measurements</small></div><i/>
          <div className={directorPlan ? 'is-ready' : ''}><span>02</span><b>PLAN</b><small>Explainable decisions</small></div><i/>
          <div className={directorRunning ? 'is-active' : directorReport ? 'is-ready' : ''}><span>03</span><b>PROCESS</b><small>Real DSP execution</small></div><i/>
          <div className={directorReport ? 'is-ready' : ''}><span>04</span><b>VERIFY</b><small>Independent QC</small></div>
        </div>
      </section>
      {/* Director Control Header */}
      <div className="p-4 rounded bg-[#111217] border border-[#D4AF37]/35 flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-mono-tabular uppercase tracking-wider text-[#D4AF37]">
                Autonomous Mastering Intelligence
              </span>
              <span
                data-testid="ai-lifecycle-badge"
                className={`px-2 py-0.5 rounded border text-[10px] font-mono-tabular font-bold uppercase ${
                  aiLifecycleState === 'Completed'
                    ? 'bg-[#10B981]/15 border-[#10B981]/40 text-[#34D399]'
                    : aiLifecycleState === 'Failed' || aiLifecycleState === 'Stopped'
                      ? 'bg-[#EF4444]/15 border-[#EF4444]/40 text-[#FCA5A5]'
                      : aiLifecycleState === 'Ready'
                        ? 'bg-[#181A22] border-[#2B2E3A] text-[#C5CDD8]'
                        : 'bg-[#38BDF8]/15 border-[#38BDF8]/40 text-[#38BDF8]'
                }`}
              >
                {aiLifecycleState}
              </span>
            </div>
            <h2 className="text-base font-bold text-[#F7F8FA] mt-0.5">
              SYN MASTER AI | Mastering Director
            </h2>
            <p className="text-xs text-[#9CA3AF]">
              Analyzes real audio telemetry, executes structured DSP/VST3 commands off-thread, evaluates results via independent SYN-QC, and refines cleanly within safeguards.
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
                ? `${aiLifecycleState || directorStage || 'Processing'}...`
                : operatingMode === 'manual'
                  ? 'CHAIN WITH AI (Plan Only)'
                  : operatingMode === 'assisted'
                    ? 'CHAIN WITH AI (Assisted)'
                    : 'CHAIN WITH AI'}
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
            {hasPreAiSnapshot && !directorRunning && (
              <button
                type="button"
                onClick={onRestorePreAiChain}
                className="px-2.5 py-2 rounded bg-[#181A22] border border-[#F59E0B]/40 text-xs text-[#F59E0B] hover:border-[#F59E0B] flex items-center gap-1"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Restore Previous
              </button>
            )}
          </div>
        </div>

        {/* Operating Mode & Mastering Objective Controls */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 pt-2 border-t border-[#222530]">
          {/* Operating Mode */}
          <div className="flex flex-col gap-1.5">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-[#9CA3AF]">
              Operating Mode
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
              {MODE_LABELS.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => onChangeOperatingMode(m.id)}
                  aria-pressed={operatingMode === m.id}
                  className={`syn-ai-mode-card p-2 rounded border text-left transition-colors ${
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
                  aria-pressed={objectiveId === obj.id}
                  className={`syn-ai-chip-btn px-2.5 py-1 rounded border text-[11px] font-semibold whitespace-nowrap ${
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
                  Max Passes:
                  <select
                    aria-label="Max Autonomous Iterations"
                    value={maxIterations}
                    onChange={(e) => onChangeMaxIterations(Number(e.target.value))}
                    className="bg-[#161820] border border-[#2B2E3A] rounded px-2 py-1 font-mono-tabular text-[#F7F8FA]"
                  >
                    <option value={4}>4</option>
                    <option value={6}>6</option>
                    <option value={8}>8</option>
                    <option value={10}>10</option>
                  </select>
                </label>
                <span className="text-[10px] text-[#B6A780]">FIX ALL runs up to 10 passes and stops on verified targets, a safe plateau, or its execution budget.</span>
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
                  Include cloud AI reasoning (provider: see AI chip in the top bar; built-in Gemini by default)
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

        {aiNotice && (
          <div role="status" data-testid="ai-cloud-limit-notice" className="p-2.5 rounded bg-[#F59E0B]/10 border border-[#F59E0B]/40 text-xs text-[#FCD34D]">
            {aiNotice}
          </div>
        )}

        {aiChanges && <div className="syn-aichg-host-wide">{aiChanges}</div>}

        {aiError && (
          <div className="p-2.5 rounded bg-[#EF4444]/10 border border-[#EF4444]/40 text-xs text-[#FCA5A5]">
            {aiError} — Deterministic DSP Director remains fully functional locally.
          </div>
        )}
      </div>

      {/* Section 1: SYN-ANALYZE Intelligence + Post-Fix Verification + SYN-PLUGIN Inventory */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div
          data-testid="syn-analyze-verification-panel"
          className="lg:col-span-2 p-4 rounded bg-[#111217] border border-[#242732] flex flex-col gap-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-xs font-bold uppercase tracking-wider text-[#D4AF37]">
                SYN-ANALYZE Track Diagnosis &amp; Post-Fix Verification
              </h3>
              <span
                data-testid="analysis-freshness-badge"
                className={`px-2 py-0.5 rounded text-[10px] font-mono-tabular font-bold uppercase border ${
                  postAnalysisStatus === 'processing'
                    ? 'bg-[#38BDF8]/15 border-[#38BDF8]/40 text-[#38BDF8]'
                    : postAnalysisStatus === 'failed' || (effectiveVerification && !effectiveVerification.analysisFresh && effectiveVerification.verificationError)
                      ? 'bg-[#EF4444]/15 border-[#EF4444]/40 text-[#FCA5A5]'
                      : effectiveVerification?.analysisFresh
                        ? 'bg-[#10B981]/15 border-[#10B981]/40 text-[#34D399]'
                        : 'bg-[#181A22] border-[#2B2E3A] text-[#C5CDD8]'
                }`}
              >
                {postAnalysisStatus === 'processing'
                  ? 'REANALYZING PROCESSED AUDIO...'
                  : postAnalysisStatus === 'failed'
                    ? 'UNVERIFIED — ANALYSIS FAILED'
                    : effectiveVerification?.analysisFresh
                      ? 'VERIFIED CURRENT AUDIO'
                      : 'BASELINE SOURCE ANALYSIS'}
              </span>
            </div>
            <span className="text-[11px] font-mono-tabular text-[#9CA3AF]">
              {(effectiveVerification?.postDiagnosis ?? activeDiagnosis)?.artisticProfile ??
                'Click Analyze to inspect audio profile'}
            </span>
          </div>

          {(postAnalysisError || effectiveVerification?.verificationError) && (
            <div
              data-testid="verification-error-banner"
              className="p-2.5 rounded bg-[#EF4444]/10 border border-[#EF4444]/40 text-xs text-[#FCA5A5]"
            >
              <strong>Verification Unverified:</strong>{' '}
              {postAnalysisError ?? effectiveVerification?.verificationError}
            </div>
          )}

          {effectiveVerification && effectiveVerification.appliedCorrections.length > 0 && (
            <div className="p-2 rounded bg-[#0C0D12] border border-[#242732] flex flex-wrap items-center gap-1.5 text-[11px]">
              <span className="font-bold uppercase tracking-wider text-[#9CA3AF] mr-1">
                Corrections Applied:
              </span>
              {effectiveVerification.appliedCorrections.slice(-4).map((corr) => (
                <span
                  key={corr.id}
                  className="px-2 py-0.5 rounded bg-[#D4AF37]/15 border border-[#D4AF37]/40 text-[#F2CA52] font-mono-tabular"
                >
                  {corr.label}
                </span>
              ))}
            </div>
          )}

          {effectiveVerification ? (
            <div className="flex flex-col gap-3 text-xs">
              {activeDiagnosis && activeDiagnosis.workingWell.length > 0 && (
                <div className="syn-ai-good p-2.5 rounded bg-[#10B981]/10 border border-[#10B981]/30">
                  <div className="font-semibold text-[#34D399] mb-1">Working Well in Source</div>
                  <ul className="list-disc list-inside text-[#C5CDD8] flex flex-col gap-0.5">
                    {activeDiagnosis.workingWell.map((w, idx) => (
                      <li key={idx}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Active Technical Findings (only unresolved / improved / partially resolved / unverified / active) */}
              <div data-testid="active-findings-section" className="flex flex-col gap-2">
                <p className="text-[10px] text-[#9CA3AF]">Run an autonomous repair pass against the original track. SYN-MASTER applies the best validated chain, then re-analyzes the result so unresolved issues stay visible.</p>
                <div className="text-[11px] font-bold uppercase tracking-wider text-[#F7F8FA] flex items-center justify-between">
                  <span>
                    Remaining Active Problems ({actionableActiveFindings.length})
                  </span>
                  {actionableActiveFindings.length > 0 && (
                    <button type="button" onClick={onFixAllProblems} disabled={directorRunning} className="syn-ai-fixall rounded-md bg-[#D4AF37] px-3 py-1.5 text-[10px] font-extrabold tracking-wide text-[#08090B] hover:bg-[#F2CA52] disabled:cursor-not-allowed disabled:opacity-50">
                      {directorRunning ? 'FIXING & VERIFYING…' : 'FIX ALL & VERIFY'}
                    </button>
                  )}
                  {actionableActiveFindings.length === 0 && (
                    <span className="text-[#34D399] font-mono-tabular">
                      0 ACTIONABLE MASTERING PROBLEMS
                    </span>
                  )}
                </div>

                {actionableActiveFindings.length > 0 && (
                  <div
                    className={`grid grid-cols-1 gap-2 ${
                      actionableActiveFindings.length > 1 ? 'md:grid-cols-2' : ''
                    }`}
                  >
                    {actionableActiveFindings.map((vf) => (
                      <div
                        key={vf.findingId}
                        data-testid={`active-finding-${vf.findingId}`}
                        className={`syn-ai-finding syn-ai-finding-open p-2.5 rounded border flex flex-col gap-1.5 ${verificationCardClass(vf.status)}`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="font-bold text-[#F7F8FA]">
                              {vf.originalFinding.title}
                            </div>
                            <div className="text-[10px] font-mono-tabular text-[#9CA3AF]">
                              Severity: {vf.updatedSeverity.toUpperCase()} · {vf.originalFinding.category}
                            </div>
                            {vf.originalFinding.evidenceStrength && (
                              <div className="text-[10px] font-mono-tabular text-[#93C5FD]">
                                Evidence: {vf.originalFinding.evidenceStrength} spectral indicators
                              </div>
                            )}
                          </div>
                          <span
                            className={`text-[10px] font-mono-tabular font-bold uppercase px-1.5 py-0.5 rounded whitespace-nowrap ${verificationBadgeClass(vf.status)}`}
                          >
                            {vf.status.replace('_', ' ')}
                          </span>
                        </div>

                        {vf.beforeMeasurements.length > 0 && (
                          <div className="grid grid-cols-2 gap-1 text-[10px] font-mono-tabular bg-[#0C0D12] p-1.5 rounded border border-[#222530]">
                            {vf.beforeMeasurements.map((m) => (
                              <div key={m.key} className="flex flex-col">
                                <span className="text-[#9CA3AF]">{m.label}</span>
                                <span className="text-[#E5E7EB]">
                                  Before: {m.beforeFormatted} → After:{' '}
                                  <strong
                                    className={
                                      m.meetsThreshold
                                        ? 'text-[#34D399]'
                                        : m.afterValue === null
                                          ? 'text-[#FCA5A5]'
                                          : 'text-[#F59E0B]'
                                    }
                                  >
                                    {m.afterFormatted}
                                  </strong>
                                </span>
                              </div>
                            ))}
                          </div>
                        )}

                        <p className="text-[11px] text-[#C5CDD8]">{vf.verificationSummary}</p>
                        {vf.remainingDeviation && (
                          <p className="text-[11px] font-mono-tabular text-[#F59E0B]">
                            Remaining: {vf.remainingDeviation}
                          </p>
                        )}
                        {vf.nextRecommendedAction && (
                          <p className="text-[11px] text-[#D4AF37]">
                            Next Action: {vf.nextRecommendedAction}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {sourceLimitations.length > 0 && (
                <div data-testid="source-limitations-section" className="flex flex-col gap-2">
                  <div className="text-[11px] font-bold uppercase tracking-wider text-[#FBBF24]">
                    Source Limitations ({sourceLimitations.length})
                  </div>
                  <p className="text-[11px] text-[#9CA3AF]">
                    These conditions were already present in the imported premaster. They remain visible because the current mastering chain cannot safely reconstruct missing or damaged source information. They are not failed FIX ALL corrections.
                  </p>
                  {sourceLimitations.map((vf) => (
                    <div key={vf.findingId} data-testid={`source-limitation-${vf.findingId}`} className="p-2.5 rounded border bg-[#F59E0B]/6 border-[#F59E0B]/35 flex flex-col gap-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-bold text-[#F7F8FA]">{vf.originalFinding.title}</span>
                        <span className={`text-[10px] font-mono-tabular font-bold uppercase px-1.5 py-0.5 rounded whitespace-nowrap ${verificationBadgeClass(vf.status, true)}`}>
                          SOURCE LIMITATION
                        </span>
                      </div>
                      <p className="text-[11px] text-[#C5CDD8]">{vf.verificationSummary}</p>
                      {vf.nextRecommendedAction && <p className="text-[11px] text-[#D4AF37]">Best next step: {vf.nextRecommendedAction}</p>}
                    </div>
                  ))}
                </div>
              )}

              {/* Verified Resolved Findings (Before/After proof + Status: RESOLVED) */}
              {effectiveVerification.resolvedFindings.length > 0 && (
                <div data-testid="resolved-findings-section" className="flex flex-col gap-2">
                  <div className="text-[11px] font-bold uppercase tracking-wider text-[#34D399]">
                    Verified Resolved Findings ({effectiveVerification.resolvedFindings.length})
                  </div>
                  <div
                    className={`grid grid-cols-1 gap-2 ${
                      effectiveVerification.resolvedFindings.length > 1 ? 'md:grid-cols-2' : ''
                    }`}
                  >
                    {effectiveVerification.resolvedFindings.map((vf) => (
                      <div
                        key={vf.findingId}
                        data-testid={`resolved-finding-${vf.findingId}`}
                        className="syn-ai-finding syn-ai-finding-resolved p-2.5 rounded border bg-[#10B981]/8 border-[#10B981]/35 flex flex-col gap-1.5"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <span className="font-bold text-[#F7F8FA]">
                            {vf.originalFinding.title}
                          </span>
                          <span
                            className={`text-[10px] font-mono-tabular font-bold uppercase px-1.5 py-0.5 rounded whitespace-nowrap ${verificationBadgeClass('RESOLVED')}`}
                          >
                            Status: RESOLVED
                          </span>
                        </div>
                        {vf.beforeMeasurements.length > 0 && (
                          <div className="grid grid-cols-2 gap-1 text-[10px] font-mono-tabular bg-[#0C0D12] p-1.5 rounded border border-[#1E2E28]">
                            {vf.beforeMeasurements.map((m) => (
                              <div key={m.key} className="flex flex-col">
                                <span className="text-[#9CA3AF]">{m.label}</span>
                                <span className="text-[#C5CDD8]">
                                  Before: {m.beforeFormatted} → After:{' '}
                                  <strong className="text-[#34D399]">{m.afterFormatted}</strong>
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                        <p className="text-[11px] text-[#A7F3D0]">{vf.verificationSummary}</p>
                        {vf.appliedCorrections.length > 0 && (
                          <div className="text-[10px] font-mono-tabular text-[#9CA3AF]">
                            Verified after: {vf.appliedCorrections.slice(-2).join(' · ')}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Newly Introduced Technical Issues */}
              {effectiveVerification.newlyIntroducedFindings.length > 0 && (
                <div data-testid="newly-introduced-findings-section" className="flex flex-col gap-2">
                  <div className="text-[11px] font-bold uppercase tracking-wider text-[#F59E0B]">
                    Newly Detected Issues After Processing ({effectiveVerification.newlyIntroducedFindings.length})
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {effectiveVerification.newlyIntroducedFindings.map((nf) => (
                      <div
                        key={nf.id}
                        className="p-2.5 rounded border bg-[#F59E0B]/10 border-[#F59E0B]/40 flex flex-col gap-1"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-bold text-[#F7F8FA]">{nf.title}</span>
                          <span className="text-[10px] font-mono-tabular uppercase px-1.5 py-0.5 rounded bg-[#F59E0B]/20 text-[#F59E0B]">
                            NEW {nf.severity}
                          </span>
                        </div>
                        <div className="text-[11px] font-mono-tabular text-[#F2CA52]">
                          {nf.evidence.join(' · ')}
                        </div>
                        <p className="text-[11px] text-[#C5CDD8]">{nf.explanation}</p>
                        {nf.recommendedAction && (
                          <p className="text-[11px] text-[#D4AF37]">Action: {nf.recommendedAction}</p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Artistic Choices & Program Observations */}
              {effectiveVerification.artisticAndObservations.length > 0 && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {effectiveVerification.artisticAndObservations.map((f) => (
                    <div
                      key={f.id}
                      className={`p-2.5 rounded border ${
                        f.kind === 'artistic-choice'
                          ? 'bg-[#38BDF8]/8 border-[#38BDF8]/30'
                          : 'bg-[#0C0D12] border-[#222530]'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-bold text-[#F7F8FA]">{f.title}</span>
                        <span
                          className={`text-[10px] font-mono-tabular uppercase px-1.5 py-0.5 rounded ${
                            f.kind === 'artistic-choice'
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
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <p className="text-xs text-[#9CA3AF]">
              Click <strong className="text-[#F2CA52]">Analyze</strong> or <strong className="text-[#F2CA52]">CHAIN WITH AI</strong> to diagnose loudness, spectral tilt, resonances, phase coherence, distortion, and noise floor.
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
        <div
          data-testid="measured-before-after-telemetry"
          className="p-4 rounded bg-[#111217] border border-[#242732] flex flex-col gap-3"
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <h3 className="text-xs font-bold uppercase tracking-wider text-[#D4AF37]">
              Measured Before vs After Telemetry
            </h3>
            <span className="text-[10px] font-mono-tabular text-[#9CA3AF]">
              {effectivePost ? 'Actual Reanalyzed Output' : postFallbackLabel}
            </span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs font-mono-tabular">
            {[
              {
                label: 'Integrated LUFS',
                pre: `${preAnalysis.integratedLufs.toFixed(1)}`,
                post: effectivePost ? `${effectivePost.integratedLufs.toFixed(1)}` : postFallbackLabel,
              },
              {
                label: 'Short-Term Max',
                pre: `${preAnalysis.shortTermLufsMax.toFixed(1)} LUFS`,
                post: effectivePost ? `${effectivePost.shortTermLufsMax.toFixed(1)} LUFS` : postFallbackLabel,
              },
              {
                label: 'RMS Level',
                pre: `${preAnalysis.rmsDb.toFixed(1)} dBFS`,
                post: effectivePost ? `${effectivePost.rmsDb.toFixed(1)} dBFS` : postFallbackLabel,
              },
              {
                label: 'Sample Peak',
                pre: `${preAnalysis.samplePeakDb.toFixed(2)} dBFS`,
                post: effectivePost ? `${effectivePost.samplePeakDb.toFixed(2)} dBFS` : postFallbackLabel,
              },
              {
                label: 'True Peak (dBTP)',
                pre: `${preAnalysis.truePeakDb.toFixed(2)}`,
                post: effectivePost ? `${effectivePost.truePeakDb.toFixed(2)}` : postFallbackLabel,
              },
              {
                label: 'Crest Factor / PLR',
                pre: `${preAnalysis.crestFactorDb.toFixed(1)} / ${preAnalysis.plrDb.toFixed(1)} dB`,
                post: effectivePost
                  ? `${effectivePost.crestFactorDb.toFixed(1)} / ${effectivePost.plrDb.toFixed(1)} dB`
                  : postFallbackLabel,
              },
              {
                label: 'Dynamic Range',
                pre: `${preAnalysis.dynamicRangeDb.toFixed(1)} dB`,
                post: effectivePost ? `${effectivePost.dynamicRangeDb.toFixed(1)} dB` : postFallbackLabel,
              },
              {
                label: '150–400 Hz Region',
                pre: preRegion150To400 !== null ? `${preRegion150To400.toFixed(1)} dB` : '—',
                post:
                  effectivePost && postRegion150To400 !== null
                    ? `${postRegion150To400.toFixed(1)} dB`
                    : postFallbackLabel,
              },
              {
                label: 'Spectral Slope / Centroid',
                pre: `${preAnalysis.spectralSlopeDbPerOct.toFixed(2)} / ${preAnalysis.spectralCentroidHz} Hz`,
                post: effectivePost
                  ? `${effectivePost.spectralSlopeDbPerOct.toFixed(2)} / ${effectivePost.spectralCentroidHz} Hz`
                  : postFallbackLabel,
              },
              {
                label: 'Stereo / Low Corr',
                pre: `${preAnalysis.phaseCorrelation.toFixed(2)} / ${preAnalysis.lowEndCorrelation.toFixed(2)}`,
                post: effectivePost
                  ? `${effectivePost.phaseCorrelation.toFixed(2)} / ${effectivePost.lowEndCorrelation.toFixed(2)}`
                  : postFallbackLabel,
              },
              {
                label: 'THD / Noise Floor',
                pre: `${preAnalysis.thdEstimatePercent.toFixed(2)}% / ${(preAnalysis.noiseFloorDb ?? -72).toFixed(0)}dB`,
                post: effectivePost
                  ? `${effectivePost.thdEstimatePercent.toFixed(2)}% / ${(effectivePost.noiseFloorDb ?? -72).toFixed(0)}dB`
                  : postFallbackLabel,
              },
            ].map((row) => (
              <div key={row.label} className="syn-ai-tile p-2 rounded bg-[#0C0D12] border border-[#21242F]">
                <div className="text-[10px] text-[#9CA3AF] font-sans">{row.label}</div>
                <div className="text-[11px] text-[#9CA3AF] mt-0.5">Pre: {row.pre}</div>
                <div
                  className={`text-xs font-bold ${
                    row.post === 'UNVERIFIED' ? 'text-[#FCA5A5]' : 'syn-ai-tile-post text-[#F2CA52]'
                  }`}
                >
                  Post: {row.post}
                </div>
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
                  {cp.iterationSummary && (
                    <div className="p-1.5 rounded bg-[#141720] border border-[#222634] text-[10px] font-mono-tabular flex flex-col gap-0.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[#E2E8F0] truncate">
                          Stage: {cp.iterationSummary.activeProcessor}
                        </span>
                        <span
                          className={`uppercase font-bold ${
                            cp.iterationSummary.outcome === 'converged' || cp.iterationSummary.outcome === 'improved'
                              ? 'text-[#34D399]'
                              : cp.iterationSummary.outcome === 'regressed'
                                ? 'text-[#F59E0B]'
                                : 'text-[#9CA3AF]'
                          }`}
                        >
                          {cp.iterationSummary.outcome}
                        </span>
                      </div>
                      <div className="text-[#9CA3AF] truncate">
                        Focus: {cp.iterationSummary.detectedIssue}
                      </div>
                      <div className="text-[#F2CA52]">
                        Measured: {cp.iterationSummary.measuredValue} | Target: {cp.iterationSummary.targetValue}
                      </div>
                      {cp.iterationSummary.previousValue && (
                        <div className="text-[#6B7280]">Previous: {cp.iterationSummary.previousValue}</div>
                      )}
                    </div>
                  )}
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

      {diagnosticArchivePanel}

      {/* Section 5: Final Optimization Report & Accept / Restore Workflow */}
      {directorReport && (
        <div
          data-testid="ai-optimization-report"
          className={`p-4 rounded bg-[#111217] border flex flex-col gap-3 text-xs ${directorReport.status === 'converged' && directorReport.qcReport.failCount === 0 && (directorReport.postFixVerification?.activeFindings ?? []).every((finding) => isSourceLimitationFinding(finding.findingId)) && (directorReport.postFixVerification?.newlyIntroducedFindings.length ?? 0) === 0 ? 'border-[#34D399]/35' : 'border-[#F59E0B]/45'}`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className={`text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 ${directorReport.status === 'converged' && directorReport.qcReport.failCount === 0 && (directorReport.postFixVerification?.activeFindings ?? []).every((finding) => isSourceLimitationFinding(finding.findingId)) && (directorReport.postFixVerification?.newlyIntroducedFindings.length ?? 0) === 0 ? 'text-[#34D399]' : 'text-[#F59E0B]'`}>
                {directorReport.status === 'converged' && directorReport.qcReport.failCount === 0 && (directorReport.postFixVerification?.activeFindings ?? []).every((finding) => isSourceLimitationFinding(finding.findingId)) && (directorReport.postFixVerification?.newlyIntroducedFindings.length ?? 0) === 0
                  ? <Check className="w-4 h-4" />
                  : <AlertTriangle className="w-4 h-4" />}
                Final Optimization Report ({directorReport.objective.label} · {directorReport.iterationsExecuted} Pass(es))
              </h3>
              <span className="font-mono-tabular text-[11px] text-[#9CA3AF]">
                Best Pass #{directorReport.bestPassNumber} · QC {directorReport.qcReport.overallStatus.toUpperCase()} · {directorReport.stopReason}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                data-testid="ai-accept-chain-btn"
                onClick={onAcceptAiChain}
                className={`px-3 py-1.5 rounded text-xs font-bold flex items-center gap-1.5 border ${
                  aiChainAccepted === true
                    ? 'bg-[#10B981]/20 border-[#34D399] text-[#34D399]'
                    : 'bg-[#D4AF37] border-[#F2CA52] text-[#070709] hover:bg-[#F2CA52]'
                }`}
              >
                <CheckCircle2 className="w-3.5 h-3.5" />
                {aiChainAccepted === true ? 'Chain Accepted' : 'Accept Final Chain'}
              </button>
              {hasPreAiSnapshot && (
                <button
                  type="button"
                  data-testid="ai-restore-previous-btn"
                  onClick={onRestorePreAiChain}
                  className="px-3 py-1.5 rounded bg-[#181A22] border border-[#F59E0B]/50 text-xs font-semibold text-[#F59E0B] hover:bg-[#F59E0B]/10 flex items-center gap-1.5"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  Restore Previous Chain
                </button>
              )}
              <button
                type="button"
                disabled={!canUndo}
                onClick={onUndoLast}
                className="px-2.5 py-1.5 rounded bg-[#181A22] border border-[#2B2E3A] text-xs text-[#C5CDD8] hover:border-[#D4AF37] disabled:opacity-35 flex items-center gap-1"
              >
                <Undo2 className="w-3.5 h-3.5" />
                Undo
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="p-2.5 rounded bg-[#0C0D12] border border-[#1E222B]">
              <div className="font-semibold text-[#34D399] mb-1">Problems Detected &amp; Resolved</div>
              <ul className="list-disc list-inside text-[#C5CDD8] flex flex-col gap-0.5">
                {(directorReport.resolvedProblems.length > 0
                  ? directorReport.resolvedProblems
                  : directorReport.verifiedImprovements
                ).map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>

            <div className="p-2.5 rounded bg-[#0C0D12] border border-[#1E222B]">
              <div className="font-semibold text-[#F59E0B] mb-1">Partially Resolved / Remaining Tradeoffs</div>
              <ul className="list-disc list-inside text-[#C5CDD8] flex flex-col gap-0.5">
                {[...directorReport.partiallyResolvedProblems, ...directorReport.remainingTradeoffs].map((tr, i) => (
                  <li key={i}>{tr}</li>
                ))}
              </ul>
            </div>

            <div className="p-2.5 rounded bg-[#0C0D12] border border-[#1E222B]">
              <div className="font-semibold text-[#38BDF8] mb-1">Preserved Original Character</div>
              <ul className="list-disc list-inside text-[#C5CDD8] flex flex-col gap-0.5">
                {directorReport.preservedCharacteristics.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>

            <div className="p-2.5 rounded bg-[#0C0D12] border border-[#1E222B]">
              <div className="font-semibold text-[#F2CA52] mb-1">Verified Before/After Telemetry</div>
              <ul className="list-disc list-inside text-[#C5CDD8] flex flex-col gap-0.5">
                {directorReport.verifiedImprovements.map((imp, i) => (
                  <li key={i}>{imp}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
