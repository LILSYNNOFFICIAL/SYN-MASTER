/**
 * Records every place where a value the AI asked for did not survive validation unchanged:
 * malformed paramsJson, a number clamped into range, an unknown enum reset to a default, or a
 * field the validator does not know (silently dropped before this existed).
 *
 * Pure and isomorphic (no imports at runtime) so the server route (Node 22, plain `node
 * server.ts`) and the browser provider adapters can both use it. It never changes a value; it
 * only compares what the AI sent with what validation kept.
 */
import type { ProcessorModule } from '../types/mastering.ts';

export type AiParamCorrectionKind = 'malformed-json' | 'clamped' | 'reset' | 'dropped';

export interface AiParamCorrection {
  /** Readable module label, e.g. "dynamic-eq #2 (De-Harsh)". */
  module: string;
  moduleType: string;
  /** Id of the validated module the correction belongs to (when one was produced). */
  moduleId?: string;
  /** Path of the parameter, e.g. "params.bands[0].thresholdDb", "wetDry" or "paramsJson". */
  parameter: string;
  /** What the AI sent (stringified, truncated). */
  aiValue: string;
  /** What will actually be rendered (stringified, truncated). */
  finalValue: string;
  kind: AiParamCorrectionKind;
}

export const MAX_AI_PARAM_CORRECTIONS = 120;

const MODULE_FIELDS = ['intensity', 'wetDry', 'inputGainDb', 'outputGainDb', 'enabled', 'bypassed'] as const;

export function formatCorrectionValue(v: unknown): string {
  if (v === undefined) return '(none)';
  let s: string;
  if (typeof v === 'number') s = Number.isFinite(v) ? String(Math.round(v * 10000) / 10000) : String(v);
  else if (typeof v === 'string') s = JSON.stringify(v);
  else {
    try {
      s = JSON.stringify(v) ?? String(v);
    } catch {
      s = String(v);
    }
  }
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function numbersEqual(a: number, b: number): boolean {
  if (a === b) return true;
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

function compareLeaf(path: string, ai: unknown, final: unknown, push: (c: Omit<AiParamCorrection, 'module' | 'moduleType' | 'moduleId'>) => void): void {
  if (final === undefined) {
    push({ parameter: path, aiValue: formatCorrectionValue(ai), finalValue: '(dropped)', kind: 'dropped' });
    return;
  }
  if (typeof ai === 'number' && typeof final === 'number') {
    if (!numbersEqual(ai, final)) {
      push({ parameter: path, aiValue: formatCorrectionValue(ai), finalValue: formatCorrectionValue(final), kind: Number.isFinite(ai) ? 'clamped' : 'reset' });
    }
    return;
  }
  if (typeof ai === typeof final && ai === final) return;
  // A numeric string the validator coerced to the same number is not a correction.
  if (typeof ai === 'string' && typeof final === 'number' && ai.trim() !== '' && numbersEqual(Number(ai), final)) return;
  push({ parameter: path, aiValue: formatCorrectionValue(ai), finalValue: formatCorrectionValue(final), kind: 'reset' });
}

function walk(path: string, ai: unknown, final: unknown, push: (c: Omit<AiParamCorrection, 'module' | 'moduleType' | 'moduleId'>) => void): void {
  if (Array.isArray(ai)) {
    if (!Array.isArray(final)) {
      push({ parameter: path, aiValue: formatCorrectionValue(ai), finalValue: final === undefined ? '(dropped)' : formatCorrectionValue(final), kind: final === undefined ? 'dropped' : 'reset' });
      return;
    }
    // Long numeric arrays (spectra) are compared as a whole.
    if (ai.length > 32 && ai.every((x) => typeof x === 'number')) {
      if (JSON.stringify(ai) !== JSON.stringify(final)) {
        push({ parameter: path, aiValue: `[${ai.length} values]`, finalValue: `[${final.length} values]`, kind: 'reset' });
      }
      return;
    }
    const usedFinal = new Set<number>();
    ai.forEach((item, i) => {
      // Bands carry ids; match by id so a validator that reorders bands is not misreported.
      let j = i;
      if (isRecord(item) && typeof item.id === 'string') {
        const byId = final.findIndex((f, k) => !usedFinal.has(k) && isRecord(f) && f.id === item.id);
        if (byId >= 0) j = byId;
      }
      usedFinal.add(j);
      walk(`${path}[${i}]`, item, j < final.length ? final[j] : undefined, push);
    });
    return;
  }
  if (isRecord(ai)) {
    if (!isRecord(final)) {
      push({ parameter: path, aiValue: formatCorrectionValue(ai), finalValue: final === undefined ? '(dropped)' : formatCorrectionValue(final), kind: final === undefined ? 'dropped' : 'reset' });
      return;
    }
    for (const [k, v] of Object.entries(ai)) walk(`${path}.${k}`, v, final[k], push);
    return;
  }
  compareLeaf(path, ai, final, push);
}

export interface RawAiModuleForCorrections {
  type: string;
  name?: string;
  intensity?: unknown;
  wetDry?: unknown;
  inputGainDb?: unknown;
  outputGainDb?: unknown;
  enabled?: unknown;
  bypassed?: unknown;
  /** The params object the AI sent (after JSON.parse); null when paramsJson was malformed. */
  params: unknown;
  /** The raw paramsJson string when it could not be parsed. */
  malformedParamsJson?: string;
}

/**
 * Compare one AI module with the validated module that will be rendered. Only values the AI
 * actually sent are compared; defaults the validator fills in are not corrections.
 */
export function collectModuleCorrections(
  raw: RawAiModuleForCorrections,
  validated: ProcessorModule | undefined,
  index: number,
): AiParamCorrection[] {
  const label = `${raw.type} #${index + 1}${raw.name ? ` (${raw.name})` : ''}`;
  const out: AiParamCorrection[] = [];
  const push = (c: Omit<AiParamCorrection, 'module' | 'moduleType' | 'moduleId'>) => {
    out.push({ module: label, moduleType: raw.type, ...(validated ? { moduleId: validated.id } : {}), ...c });
  };
  if (!validated) {
    push({ parameter: '(module)', aiValue: formatCorrectionValue(raw.type), finalValue: '(dropped)', kind: 'dropped' });
    return out;
  }
  if (raw.malformedParamsJson !== undefined) {
    push({ parameter: 'paramsJson', aiValue: formatCorrectionValue(raw.malformedParamsJson), finalValue: 'processor defaults (paramsJson was not valid JSON)', kind: 'malformed-json' });
  }
  const finalModule = validated as unknown as Record<string, unknown>;
  for (const field of MODULE_FIELDS) {
    const v = raw[field];
    if (v === undefined || v === null) continue;
    compareLeaf(field, v, finalModule[field], push);
  }
  if (raw.malformedParamsJson === undefined && raw.params !== undefined && raw.params !== null) {
    if (isRecord(raw.params)) {
      for (const [k, v] of Object.entries(raw.params)) walk(`params.${k}`, v, (validated.params as unknown as Record<string, unknown>)[k], push);
    } else {
      push({ parameter: 'params', aiValue: formatCorrectionValue(raw.params), finalValue: 'processor defaults (params was not an object)', kind: 'reset' });
    }
  }
  return out;
}

/** "  dynamic-eq #2 (De-Harsh) params.bands[0].ratio: AI 40 → final 20 [clamped]" */
export function formatAiParamCorrection(c: AiParamCorrection): string {
  return `${c.module} ${c.parameter}: AI ${c.aiValue} → final ${c.finalValue} [${c.kind}]`;
}
