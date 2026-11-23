import type {
  AnalysisFinding,
  AudioAnalysis,
  MasterFinalReport,
  ProcessorModule,
  ProcessorType,
  ResolvedObjectiveTarget,
} from '../types/mastering';
import { evaluateMasterTargets, type MasterTargetGate } from './masterTargets';

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
  status: 'open' | 'fixed' | 'not-fixed' | 'advisory';
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
  entries: DiagnosticLogEntry[];
  chain: Array<{ name: string; type: ProcessorType; bypassed: boolean; settings: string }>;
  verdict: string;
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
}): DiagnosticLog {
  const { source, objective, report } = input;
  const master = report?.postAnalysis ?? null;
  const chain = report?.finalChain?.length ? report.finalChain : input.chain;
  const sourceGate = evaluateMasterTargets(source, objective, { preAnalysis: source, referenceAnalysis: input.referenceAnalysis });
  const gate = report?.targetGate ?? (master ? evaluateMasterTargets(master, objective, { preAnalysis: source, referenceAnalysis: input.referenceAnalysis }) : null);
  const entries: DiagnosticLogEntry[] = [];
  const statusFromGate = (checkId: string): DiagnosticLogEntry['status'] => {
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
  const postFindingIds = new Set(
    (report?.postFixVerification?.activeFindings ?? []).map((f) => f.originalFinding.id),
  );
  const resolvedIds = new Set(
    (report?.postFixVerification?.resolvedFindings ?? []).map((f) => f.originalFinding.id),
  );
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
      status: !report ? 'open' : resolvedIds.has(f.id) ? 'fixed' : postFindingIds.has(f.id) ? 'not-fixed' : 'fixed',
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
      status: master ? (master.zoneEnergyDb.presence - master.zoneEnergyDb.mid <= sib - 0.5 ? 'fixed' : 'advisory') : 'open',
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
      status: master ? (reducedDb !== null && reducedDb <= -1 ? 'fixed' : 'advisory') : 'open',
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

  // Low end
  if (source.zoneEnergyDb.sub - source.zoneEnergyDb.bass > 2) {
    entries.push({
      id: 'sub-excess',
      issue: 'Sub-bass excess / rumble',
      category: 'Low end',
      severity: 'moderate',
      measured: `Sub ${(source.zoneEnergyDb.sub - source.zoneEnergyDb.bass).toFixed(1)} dB over bass`,
      target: '≤ 0 dB over bass',
      tools: ['parametric-eq', 'bass-enhancer'],
      settings: settingsFor(chain, ['parametric-eq', 'bass-enhancer']),
      status: master ? (master.zoneEnergyDb.sub - master.zoneEnergyDb.bass <= 1 ? 'fixed' : 'not-fixed') : 'open',
    });
  }

  const passes = (report?.checkpoints ?? []).map((cp) => ({
    pass: cp.passNumber,
    lufs: cp.analysis.integratedLufs,
    truePeakDb: cp.analysis.truePeakDb,
    clicks: cp.analysis.clickCount ?? 0,
    gatePassed: cp.targetGate ? cp.targetGate.passed : null,
    outcome: cp.iterationSummary?.outcome ?? '',
  }));

  const verdict = !report
    ? `${entries.length} issue(s) measured. Press FIX IT ALL WITH AI to correct and verify.`
    : gate?.passed
      ? `PASSED: the delivered master was re-measured and meets every objective target (pass ${report.bestPassNumber} of ${report.iterationsExecuted}).`
      : `NOT PASSED: ${gate?.summary ?? 'no verified render'} — see entries marked not-fixed.`;

  return {
    createdAt: new Date().toISOString(),
    trackName: input.trackName,
    objective: { id: objective.id, label: objective.label, targetLufs: objective.targetLufs, maxTruePeakDb: objective.maxTruePeakDb },
    phase: report ? 'post-fix' : 'pre-fix',
    source: metricsOf(source),
    master: master ? metricsOf(master) : null,
    gate,
    passes,
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
