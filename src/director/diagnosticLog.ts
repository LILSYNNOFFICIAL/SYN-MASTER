import type {
  AiCallSource,
  AiFallbackReason,
  AiPassTrace,
  AiTimeoutHit,
  AnalysisFinding,
  AudioAnalysis,
  MasterFinalReport,
  ProcessorModule,
  ProcessorType,
  ResolvedObjectiveTarget,
} from '../types/mastering';
export type { AiCallSource, AiFallbackReason, AiPassTrace, AiTimeoutHit };
import { evaluateMasterTargets, type MasterTargetGate } from './masterTargets';
import { hasFreshPostFixVerification, isMasterFullyVerified } from './postFixVerification';

/**
 * Mastering diagnostic log: every problem measured on the track, its target, which
 * tool fixes it and the exact settings that tool has in the chain. Downloadable as
 * JSON or plain text from the Fix-It stage.
 */

export interface DiagnosticLogEntry {
  id: string;
  issue: string;
  category: string;
  severity: 'info' | 'low' | 'moderate' | 'high';
  measured: string;
  target: string;
  tools: ProcessorType[];
  /** Exact settings of the matching modules in the chain, e.g. "SYN-Restore: declick=55, ..." */
  settings: string[];
  status: 'open' | 'fixed' | 'not-fixed' | 'improved' | 'partially-resolved' | 'unverified' | 'advisory';
}

export interface DiagnosticLog {
  createdAt: string;
  trackName: string;
  objective: { id: string; label: string; targetLufs: number; maxTruePeakDb: number };
  phase: 'pre-fix' | 'post-fix';
  source: Record<string, number | string>;
  master: Record<string, number | string> | null;
  gate: MasterTargetGate | null;
  passes: Array<{ pass: number; lufs: number; truePeakDb: number; clicks: number; gatePassed: boolean | null; outcome: string }>;
  aiPasses: AiPassTrace[];
  aiFallbackBanner: string | null;
  entries: DiagnosticLogEntry[];
  chain: Array<{ name: string; type: ProcessorType; bypassed: boolean; settings: string }>;
  verdict: string;
}

export function formatFallbackReasonText(reason: AiFallbackReason, detail?: string): string {
  const base: Record<AiFallbackReason, string> = {
    '429': 'Cloud AI rate or spend limit reached (HTTP 429)',
    'guest-session': 'Cloud AI guest session setup or validation failed',
    timeout: 'Cloud AI request timed out',
    'missing-key': 'Cloud AI API key is not configured on this server',
    'server-error': 'Cloud AI server returned an error',
    parse: 'Cloud AI returned malformed JSON',
    validation: 'Cloud AI returned an invalid or empty processor chain',
    'user-disabled': 'Cloud AI is turned off in settings',
  };
  const label = base[reason] ?? reason;
  const trimmed = detail?.trim();
  if (!trimmed || trimmed.toLowerCase() === label.toLowerCase()) return label;
  return `${label} (${trimmed})`;
}

export function summarizeAiFallbackBanner(aiPasses?: AiPassTrace[] | null): string | null {
  if (!aiPasses || aiPasses.length === 0) return null;
  const fallbacks = aiPasses.filter((p): p is AiPassTrace & { fallbackReason: AiFallbackReason } => p.fallbackReason !== null);
  if (fallbacks.length === 0) return null;
  const uniqueReasons: string[] = [];
  for (const fb of fallbacks) {
    const reasonText = formatFallbackReasonText(fb.fallbackReason, fb.fallbackDetail);
    if (!uniqueReasons.includes(reasonText)) uniqueReasons.push(reasonText);
  }
  return `Cloud AI was not used for this pass because: ${uniqueReasons.join('; ')}.`;
}

/** Map verification evidence to a display status. Missing evidence is never a successful fix. */
export function diagnosticStatusForFinding(
  report: Pick<MasterFinalReport, 'postFixVerification'> | null | undefined,
  findingId: string,
): DiagnosticLogEntry['status'] {
  const verification = report?.postFixVerification;
  if (!verification || !verification.analysisFresh || !verification.postAnalysis) return report ? 'unverified' : 'open';
  if (verification.resolvedFindings.some((f) => f.originalFinding.id === findingId && f.status === 'RESOLVED' && f.measurementReliable)) {
    return 'fixed';
  }
  const active = verification.activeFindings.find((f) => f.originalFinding.id === findingId);
  if (!active) return 'unverified';
  switch (active.status) {
    case 'IMPROVED': return 'improved';
    case 'PARTIALLY_RESOLVED': return 'partially-resolved';
    case 'UNVERIFIED': return 'unverified';
    case 'ACTIVE':
    case 'UNRESOLVED':
    default: return 'not-fixed';
  }
}

const FINDING_TOOLS: Record<string, ProcessorType[]> = {
  'diag-clipping': ['limiter', 'maximizer'],
  'diag-dc': ['restore'],
  'diag-clicks': ['restore'],
  'diag-noise': ['restore'],
  'diag-phase': ['stereo-imager'],
  'diag-lr-skew': ['stereo-imager'],
  'diag-mud': ['parametric-eq', 'dynamic-eq'],
  'diag-bass-heavy-clean': ['parametric-eq', 'bass-enhancer'],
  'diag-hollow-lowmid': ['parametric-eq'],
  'diag-harsh': ['dynamic-eq', 'restore'],
  'diag-overcompressed': ['compressor', 'maximizer'],
  'diag-thd': ['saturation', 'limiter'],
};

function fmtVal(v: unknown): string {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (typeof v === 'string') return v;
  return '';
}

/** One-line summary of every parameter of a module. */
export function describeModuleSettings(mod: ProcessorModule): string {
  const parts: string[] = [];
  const p = mod.params as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(p ?? {})) {
    if (k === 'bands' && Array.isArray(v)) {
      const bands = (v as Array<Record<string, unknown>>)
        .filter((b) => b.enabled !== false)
        .map((b) => {
          const f = Number(b.freq ?? 0);
          const g = b.gain !== undefined ? `${Number(b.gain) >= 0 ? '+' : ''}${Number(b.gain).toFixed(1)}dB` : b.maxCutDb !== undefined ? `max ${Number(b.maxCutDb).toFixed(1)}dB @thr ${Number(b.thresholdDb ?? 0).toFixed(0)}` : '';
          return `${b.shape ?? 'band'} ${f >= 1000 ? (f / 1000).toFixed(2) + 'k' : f.toFixed(0)}Hz ${g} Q${Number(b.q ?? 0).toFixed(2)}`;
        });
      parts.push(`bands=[${bands.join('; ')}]`);
    } else if (v && typeof v === 'object') {
      const inner = Object.entries(v as Record<string, unknown>).map(([ik, iv]) => `${ik}=${fmtVal(iv)}`).join(',');
      parts.push(`${k}{${inner}}`);
    } else if (fmtVal(v) !== '') {
      parts.push(`${k}=${fmtVal(v)}`);
    }
  }
  parts.push(`mix=${mod.wetDry}%`, `intensity=${mod.intensity}%`);
  if (Math.abs(mod.inputGainDb) > 0.01) parts.push(`in=${mod.inputGainDb.toFixed(1)}dB`);
  if (Math.abs(mod.outputGainDb) > 0.01) parts.push(`out=${mod.outputGainDb.toFixed(1)}dB`);
  return parts.join(', ');
}

function settingsFor(chain: ProcessorModule[], tools: ProcessorType[]): string[] {
  const mods = chain.filter((m) => tools.includes(m.type) && m.enabled && !m.bypassed);
  if (mods.length === 0) return [`No ${tools.join(' / ')} in the chain yet`];
  return mods.map((m) => `${m.name}: ${describeModuleSettings(m)}`);
}

function metricsOf(a: AudioAnalysis): Record<string, number | string> {
  return {
    integratedLufs: a.integratedLufs,
    truePeakDbtp: a.truePeakDb,
    samplePeakDb: a.samplePeakDb,
    loudnessRangeLu: a.loudnessRangeLu,
    dynamicRangeDb: a.dynamicRangeDb,
    crestFactorDb: a.crestFactorDb,
    clippedSamples: a.clippedSamples,
    interSamplePeaks: a.interSamplePeaks,
    clicks: a.clickCount ?? 0,
    dcOffset: a.dcOffset,
    phaseCorrelation: a.phaseCorrelation,
    lowEndCorrelation: a.lowEndCorrelation,
    stereoWidth: a.stereoWidth,
    thdPercent: a.thdEstimatePercent,
    noiseFloorDb: a.noiseFloorDb,
    spectralCentroidHz: Math.round(a.spectralCentroidHz),
  };
}

export function buildDiagnosticLog(input: {
  trackName: string;
  objective: ResolvedObjectiveTarget;
  source: AudioAnalysis;
  findings: AnalysisFinding[];
  chain: ProcessorModule[];
  report?: MasterFinalReport | null;
  referenceAnalysis?: AudioAnalysis | null;
  aiPasses?: AiPassTrace[];
}): DiagnosticLog {
  const { source, objective, report } = input;
  const isFresh = hasFreshPostFixVerification(report?.postFixVerification);
  const master = isFresh ? report?.postAnalysis ?? null : null;
  const chain = report?.finalChain?.length ? report.finalChain : input.chain;
  const sourceGate = evaluateMasterTargets(source, objective, { preAnalysis: source, referenceAnalysis: input.referenceAnalysis });
  const gate = isFresh
    ? report?.targetGate ?? (master ? evaluateMasterTargets(master, objective, { preAnalysis: source, referenceAnalysis: input.referenceAnalysis }) : null)
    : null;
  const entries: DiagnosticLogEntry[] = [];
  const statusFromGate = (checkId: string): DiagnosticLogEntry['status'] => {
    if (!isFresh) return report ? 'unverified' : 'open';
    if (!gate) return 'open';
    const c = gate.checks.find((x) => x.id === checkId);
    if (!c) return 'open';
    return c.status === 'pass' ? 'fixed' : c.status === 'advisory' ? 'advisory' : 'not-fixed';
  };

  // Objective gate checks that fail on the SOURCE are the core "what's wrong" list.
  const toolByCheck: Record<string, ProcessorType[]> = {
    lufs: ['maximizer', 'limiter'],
    'true-peak': ['limiter', 'maximizer'],
    clipping: ['limiter', 'maximizer'],
    clicks: ['restore'],
    'dc-offset': ['restore'],
    phase: ['stereo-imager'],
    'low-end-phase': ['stereo-imager', 'bass-enhancer'],
    'sub-excess': ['parametric-eq', 'bass-enhancer'],
    lra: ['compressor', 'maximizer'],
    crest: ['limiter', 'maximizer'],
    'spectral-balance': ['parametric-eq'],
  };
  for (const c of sourceGate.checks) {
    if (c.status === 'pass') continue;
    const after = gate?.checks.find((x) => x.id === c.id);
    entries.push({
      id: `gate-${c.id}`,
      issue: c.label,
      category: 'Objective target',
      severity: c.status === 'fail' ? 'high' : 'low',
      measured: after ? `${c.measured} → ${after.measured}` : c.measured,
      target: c.target,
      tools: toolByCheck[c.id] ?? [],
      settings: [...(c.fix ? [`Recommended: ${c.fix}`] : []), ...settingsFor(chain, toolByCheck[c.id] ?? [])],
      status: statusFromGate(c.id),
    });
  }

  // Engineering findings (harshness, mud, sibilance, phase, noise, distortion, ...)
  for (const f of input.findings) {
    if (f.kind !== 'technical-problem') continue;
    if (entries.some((e) => e.id === `finding-${f.id}`)) continue;
    const tools = FINDING_TOOLS[f.id] ?? [];
    entries.push({
      id: `finding-${f.id}`,
      issue: f.title,
      category: f.category,
      severity: f.severity,
      measured: f.evidence.join(' · '),
      target: f.recommendedAction ?? '-',
      tools,
      settings: settingsFor(chain, tools),
  status: !report ? 'open' : !isFresh ? 'unverified' : diagnosticStatusForFinding(report, f.id),
    });
  }

  // Sibilance: presence vs mid energy (measured)
  const sib = source.zoneEnergyDb.presence - source.zoneEnergyDb.mid;
  if (sib > -4) {
    entries.push({
      id: 'sibilance',
      issue: 'Sibilance / upper presence build-up',
      category: 'Spectral',
      severity: sib > -1 ? 'moderate' : 'low',
      measured: `Presence ${sib >= 0 ? '+' : ''}${sib.toFixed(1)} dB vs mid`,
      target: '≤ -4 dB vs mid (genre dependent)',
      tools: ['restore', 'dynamic-eq'],
      settings: settingsFor(chain, ['restore', 'dynamic-eq']),
      status: !report
        ? 'open'
        : !isFresh || !master
          ? 'unverified'
          : master.zoneEnergyDb.presence - master.zoneEnergyDb.mid <= -4
            ? 'fixed'
            : master.zoneEnergyDb.presence - master.zoneEnergyDb.mid <= sib - 0.5
              ? 'improved'
              : 'not-fixed',
    });
  }

  // AI shimmer / metallic artifacts: measured (src/dsp/shimmerDetect.ts). Older analyses
  // without the measurement fall back to the high-band correlation heuristic.
  const sh = source.shimmer;
  if (sh && sh.score >= 0.35) {
    const msh = master?.shimmer;
    const reducedDb = msh && sh.sideHfRatio > 0 && msh.sideHfRatio > 0 ? 10 * Math.log10(msh.sideHfRatio / sh.sideHfRatio) : null;
    entries.push({
      id: 'ai-shimmer',
      issue: sh.confidence >= 0.6 ? 'AI shimmer / metallic high-end (measured, confident)' : 'Possible AI shimmer / metallic high-end (measured, low confidence)',
      category: 'Artifacts',
      severity: sh.confidence >= 0.6 ? 'moderate' : 'low',
      measured: `confidence ${sh.confidence.toFixed(2)} · side/mid 9-16 kHz ${sh.sideHfRatio.toFixed(2)} · side independence ${sh.fluxRatio.toFixed(2)} · tonality ${sh.tonality.toFixed(2)}`,
      target: 'confidence < 0.60, or side HF reduced ≥ 1 dB after de-shimmer',
      tools: ['restore'],
      settings: [...settingsFor(chain, ['restore']), sh.confidence >= 0.6 ? 'Auto: SYN-Restore deShimmer on (30–80% by confidence)' : 'Suggested if audible: SYN-Restore deShimmer 30–50%'],
      status: !report
        ? 'open'
        : !isFresh || !master
          ? 'unverified'
          : reducedDb !== null && reducedDb <= -1
            ? 'fixed'
            : reducedDb !== null && reducedDb < 0
              ? 'improved'
              : reducedDb !== null
                ? 'not-fixed'
                : 'unverified',
    });
  } else if (!sh) {
    const hiCorr = source.stereoBandCorrelation?.high;
    const air = source.zoneEnergyDb.air - source.zoneEnergyDb.mid;
    if (typeof hiCorr === 'number' && hiCorr < 0.55 && air > -18) {
      entries.push({
        id: 'ai-shimmer',
        issue: 'Possible AI shimmer / metallic high-end (heuristic)',
        category: 'Artifacts',
        severity: hiCorr < 0.3 ? 'moderate' : 'low',
        measured: `High-band correlation ${hiCorr.toFixed(2)}, air ${air.toFixed(1)} dB vs mid`,
        target: 'Listen: swirly / phasey cymbals and vocal air',
        tools: ['restore', 'stereo-imager'],
        settings: [...settingsFor(chain, ['restore']), 'Suggested: SYN-Restore deShimmer 30–50%'],
        status: 'advisory',
      });
    }
  }

  const vocalBalance = report?.vocalBalanceVerification;
  if (vocalBalance) {
    entries.push({
      id: 'vocal-balance',
      issue: 'Vocal balance vs reference',
      category: 'Spectral',
      severity: vocalBalance.status === 'unverified' ? 'moderate' : 'low',
      measured: vocalBalance.sourceBalanceDb === null
        ? 'UNVERIFIED'
        : `${vocalBalance.sourceBalanceDb.toFixed(1)} dB source · ${vocalBalance.referenceBalanceDb?.toFixed(1) ?? 'n/a'} dB reference · ${vocalBalance.postRenderBalanceDb?.toFixed(1) ?? 'n/a'} dB rendered`,
      target: 'Vocal-Focused objective only · source vocal more than 3 dB below accompaniment · maximum +3 dB · rendered balance within 3 dB of reference',
      tools: [],
      settings: [`Vocal Rebalance: +${vocalBalance.appliedGainDb.toFixed(1)} dB`, vocalBalance.summary],
      status: vocalBalance.status === 'verified'
        ? 'fixed'
        : vocalBalance.status === 'not-needed'
          ? 'advisory'
          : vocalBalance.status === 'unresolved'
            ? 'not-fixed'
            : 'unverified',
    });
  }

  // Sub/Bass excess is emitted by the objective gate above. The gate owns the single <= 0 dB verdict.

  const passes = (report?.checkpoints ?? []).map((cp) => ({
    pass: cp.passNumber,
    lufs: cp.analysis.integratedLufs,
    truePeakDb: cp.analysis.truePeakDb,
    clicks: cp.analysis.clickCount ?? 0,
    gatePassed: cp.targetGate ? cp.targetGate.passed : null,
    outcome: cp.iterationSummary?.outcome ?? '',
  }));

  const outstanding = entries.filter((entry) => !['fixed', 'advisory'].includes(entry.status)).length;
  const verdict = !report
    ? `${entries.length} issue(s) measured. Press FIX IT ALL WITH AI to correct and verify.`
    : isMasterFullyVerified(report) && outstanding === 0
      ? `PASSED: the delivered master was re-measured and meets every objective target (pass ${report.bestPassNumber} of ${report.iterationsExecuted}).`
      : gate?.passed && outstanding > 0
        ? `NOT FULLY VERIFIED: OBJECTIVE TARGETS MET, BUT ${outstanding} technical issue(s) remain unresolved or unverified. Review the individual evidence below (pass ${report.bestPassNumber} of ${report.iterationsExecuted}).`
        : `NOT FULLY VERIFIED: ${gate?.summary ?? report.postFixVerification?.verificationError ?? 'no fresh verified render'} — see unresolved or unverified entries.`;

  const aiPasses = report?.aiPasses
    ? structuredClone(report.aiPasses)
    : input.aiPasses
      ? structuredClone(input.aiPasses)
      : [];
  const aiFallbackBanner = summarizeAiFallbackBanner(aiPasses);

  return {
    createdAt: new Date().toISOString(),
    trackName: input.trackName,
    objective: { id: objective.id, label: objective.label, targetLufs: objective.targetLufs, maxTruePeakDb: objective.maxTruePeakDb },
    phase: report ? 'post-fix' : 'pre-fix',
    source: metricsOf(source),
    master: master ? metricsOf(master) : null,
    gate,
    passes,
    aiPasses,
    aiFallbackBanner,
    entries,
    chain: chain.map((m) => ({ name: m.name, type: m.type, bypassed: m.bypassed || !m.enabled, settings: describeModuleSettings(m) })),
    verdict,
  };
}

export function diagnosticLogToText(log: DiagnosticLog): string {
  const L: string[] = [];
  L.push(`SYN MASTER — Mastering Diagnostic Log`);
  L.push(`Track: ${log.trackName}`);
  L.push(`Created: ${log.createdAt}`);
  L.push(`Objective: ${log.objective.label} (${log.objective.targetLufs} LUFS / ${log.objective.maxTruePeakDb} dBTP)`);
  L.push(`Phase: ${log.phase}`);
  L.push('');
  L.push(`VERDICT: ${log.verdict}`);
  L.push('');
  L.push('== Measurements (source → master) ==');
  for (const [k, v] of Object.entries(log.source)) {
    const m = log.master ? log.master[k] : undefined;
    L.push(`  ${k.padEnd(20)} ${String(v).padStart(10)}${m !== undefined ? `  →  ${m}` : ''}`);
  }
  if (log.gate) {
    L.push('');
    L.push('== Objective gate (rendered master) ==');
    for (const c of log.gate.checks) L.push(`  [${c.status.toUpperCase().padEnd(8)}] ${c.label}: ${c.measured} (target ${c.target})`);
  }
  if (log.passes.length > 0) {
    L.push('');
    L.push('== Passes ==');
    for (const p of log.passes) L.push(`  #${p.pass}: ${p.lufs.toFixed(1)} LUFS, ${p.truePeakDb.toFixed(2)} dBTP, clicks ${p.clicks}, gate ${p.gatePassed === null ? '-' : p.gatePassed ? 'PASS' : 'FAIL'} (${p.outcome})`);
  }
  if (log.aiPasses.length > 0 || log.aiFallbackBanner) {
    L.push('');
    L.push('== AI & Fallback Provenance ==');
    if (log.aiFallbackBanner) L.push(`  Notice: ${log.aiFallbackBanner}`);
    for (const a of log.aiPasses) {
      const label = a.stage === 'strategy' ? 'Strategy (Pass #0 → #1)' : `Refine (after Pass #${a.pass})`;
      const timeStr = a.responseTimeMs !== null ? `${a.responseTimeMs} ms` : 'n/a';
      const promptStr = a.promptChars !== null ? `${a.promptChars} chars` : 'n/a';
      const modelStr = a.modelName ?? 'none';
      const timeoutStr = a.timeoutHit ?? 'none';
      const fbStr = a.fallbackReason ? `${a.fallbackReason}${a.fallbackDetail ? ` (${a.fallbackDetail})` : ''}` : 'none';
      const aiMods = a.aiReturnedModules.join(', ') || 'none';
      const finalMods = a.finalRenderedModules.join(', ') || 'none';
      L.push(`  ${label}: source=${a.source} | model=${modelStr} | responseTime=${timeStr} | prompt=${promptStr} | timeoutHit=${timeoutStr} | fallback=${fbStr}`);
      L.push(`    AI returned:    [${aiMods}]`);
      L.push(`    Final rendered: [${finalMods}]`);
    }
  }
  L.push('');
  L.push('== Issues and fixes ==');
  for (const e of log.entries) {
    L.push(`* [${e.status.toUpperCase()}] ${e.issue} (${e.category}, ${e.severity})`);
    L.push(`    measured: ${e.measured}`);
    L.push(`    target:   ${e.target}`);
    L.push(`    tools:    ${e.tools.join(', ') || '-'}`);
    for (const s of e.settings) L.push(`    setting:  ${s}`);
  }
  L.push('');
  L.push('== Chain ==');
  log.chain.forEach((m, i) => L.push(`  ${i + 1}. ${m.name}${m.bypassed ? ' (bypassed)' : ''}: ${m.settings}`));
  return L.join('\n');
}
