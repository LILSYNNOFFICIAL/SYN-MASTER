/**
 * Log-first record of every AI-provided value the Director changes before rendering.
 *
 * Nothing here changes a chain. Each helper compares a chain before and after one Director step
 * (inventory re-validation, required-module merge, Match EQ guard, objective-gate repair) and
 * records, for modules the AI proposed, which parameter changed, the AI's value, the final value
 * and the reason. The result is shown in the diagnostic log under "== Director overrides ==".
 */
import type { DirectorOverride, ProcessorModule } from '../types/mastering';
import { collectModuleCorrections, type AiParamCorrection } from '../ai/aiParamCorrections';

export const MAX_DIRECTOR_OVERRIDES_PER_PASS = 120;

const ACTION_BY_KIND: Record<AiParamCorrection['kind'], DirectorOverride['action']> = {
  'malformed-json': 'override',
  clamped: 'clamp',
  reset: 'override',
  dropped: 'drop',
};

/** Stages that only bound a value (a numeric change there is a clamp, elsewhere an override). */
const CLAMP_STAGES = new Set<DirectorOverride['stage']>(['inventory-validation', 'match-eq-guard']);

function moduleAsRaw(m: ProcessorModule) {
  return {
    type: m.type,
    name: m.name,
    intensity: m.intensity,
    wetDry: m.wetDry,
    inputGainDb: m.inputGainDb,
    outputGainDb: m.outputGainDb,
    enabled: m.enabled,
    bypassed: m.bypassed,
    params: m.params,
  };
}

/**
 * Compare `before` and `after` for the modules in `aiIds` and append one override per changed
 * or removed AI value. `reasonFor` gives the reason (it may depend on the module).
 * When `logAdditions` is set, stages present in `after` but not in `before` are logged as "add".
 */
export function recordStageOverrides(
  out: DirectorOverride[],
  input: {
    pass: number;
    stage: DirectorOverride['stage'];
    before: ProcessorModule[];
    after: ProcessorModule[];
    aiIds: ReadonlySet<string>;
    reasonFor: (module: ProcessorModule, removed: boolean) => string;
    logAdditions?: boolean;
  },
): void {
  const afterById = new Map(input.after.map((m) => [m.id, m] as const));
  input.before.forEach((m, index) => {
    if (!input.aiIds.has(m.id)) return;
    const final = afterById.get(m.id);
    const diffs = collectModuleCorrections(moduleAsRaw(m), final, index);
    for (const d of diffs) {
      if (out.length >= MAX_DIRECTOR_OVERRIDES_PER_PASS) return;
      out.push({
        pass: input.pass,
        stage: input.stage,
        module: `${m.name} (${m.type})`,
        moduleType: m.type,
        moduleId: m.id,
        parameter: d.parameter,
        aiValue: d.aiValue,
        finalValue: d.finalValue,
        action: !final ? 'drop' : d.kind === 'clamped' && !CLAMP_STAGES.has(input.stage) ? 'override' : ACTION_BY_KIND[d.kind],
        reason: input.reasonFor(m, !final),
      });
    }
  });
  if (input.logAdditions) {
    const beforeIds = new Set(input.before.map((m) => m.id));
    for (const m of input.after) {
      if (beforeIds.has(m.id) || out.length >= MAX_DIRECTOR_OVERRIDES_PER_PASS) continue;
      out.push({
        pass: input.pass,
        stage: input.stage,
        module: `${m.name} (${m.type})`,
        moduleType: m.type,
        moduleId: m.id,
        parameter: '(stage)',
        aiValue: '(not in AI chain)',
        finalValue: 'added',
        action: 'add',
        reason: input.reasonFor(m, false),
      });
    }
  }
}

/**
 * Values changed between what the AI proposed (snapshots recorded when the AI answered) and the
 * chain the Director received, i.e. by the app's own policy gates (Vocal Rebalance) or caller.
 */
export function recordPreDirectorOverrides(
  out: DirectorOverride[],
  pass: number,
  snapshots: ReadonlyMap<string, ProcessorModule>,
  received: ProcessorModule[],
): void {
  const before = [...snapshots.values()];
  recordStageOverrides(out, {
    pass,
    stage: 'before-director',
    before,
    after: received,
    aiIds: new Set(snapshots.keys()),
    reasonFor: (m, removed) =>
      m.type === 'vocal-rebalance'
        ? `Vocal Rebalance policy gate (stems must be cached and the move must stay inside the objective's vocal window)${removed ? '; stage removed' : ''}`
        : `Changed by the app before the Director received the AI chain${removed ? ' (stage removed)' : ''}`,
  });
}

export const OVERRIDE_REASONS = {
  inventory: 'Inventory re-validation (values clamped to the processor limits)',
  merge: '12-stage safety limit: a required lead module was prepended, so the lowest-priority non-protected stage was dropped',
  matchEqDropped: 'Match EQ needs a learned reference spectrum; none is loaded, so the AI\'s Match EQ stage cannot run and was removed',
  matchEqCeiling: 'Match EQ proposed by the AI is held to the Director\'s conservative ceiling (amount, max boost/cut, smoothing)',
} as const;

export function formatDirectorOverride(o: DirectorOverride): string {
  return `#${o.pass} [${o.stage}] ${o.module} ${o.parameter}: AI ${o.aiValue} → final ${o.finalValue} (${o.action}) — ${o.reason}`;
}
