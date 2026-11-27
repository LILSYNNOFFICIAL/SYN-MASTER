/**
 * E1 coverage test: PROCESSOR_PARAM_LIMITS (src/dsp/chainValidation.ts) is the source of truth.
 * Fails when
 *  - a processor type or parameter the validator reads is missing from the limits table,
 *  - the generated SYSTEM_PROMPT is missing a processor type, parameter name or option,
 *  - a prompt range/enum differs from the limits,
 *  - a processor type the AI may return is rejected by validateChainAgainstInventory.
 * Exclusions are listed explicitly below with their reason; nothing else is skipped.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  AI_MAX_CHAIN_STAGES,
  AI_PROCESSOR_TYPES,
  PROCESSOR_JSON_SCHEMA,
  SYSTEM_PROMPT,
} from './masteringPrompt.ts';
import {
  PROCESSOR_DEFAULT_NAMES,
  PROCESSOR_PARAM_LIMITS,
  createDefaultParams,
} from '../dsp/chainValidation.ts';
import {
  VERIFIED_NATIVE_PROCESSOR_INVENTORY,
  validateChainAgainstInventory,
} from '../director/processorInventory.ts';
import { MASTERING_OBJECTIVE_IDS, type ProcessorType } from '../types/mastering.ts';

type Limits = typeof PROCESSOR_PARAM_LIMITS;
type AiType = Exclude<keyof Limits, 'module'>;

const readSrc = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const chainValidationSrc = readSrc('../dsp/chainValidation.ts');
const vocalRebalanceSrc = readSrc('../dsp/vocalRebalance.ts');

/**
 * Validator fields the AI must NOT set, so they are deliberately absent from the prompt and limits:
 * - solo: UI monitoring toggle on EQ bands.
 * - source / reference / referenceName: Match EQ learned spectra; the engine supplies them and the
 *   prompt tells the AI never to send them.
 * - id: free-form band identifier (a string, no range).
 */
const NOT_FOR_AI = new Set(['solo', 'source', 'reference', 'referenceName', 'id']);
/** Container fields: their children are checked instead. */
const CONTAINERS = new Set(['bands', 'low', 'mid', 'high', 'sidechain']);
/** Validator field name -> limits key(s) when they are not named identically. */
const LIMIT_ALIASES: Record<string, string[]> = {
  maxCutDb: ['maxCutDbCut', 'maxCutDbBoost'],
  // highCrossHz is bounded by lowCrossHz + highCrossMinOffsetHz .. highCrossMaxHz.
  highCrossHz: ['highCrossMinOffsetHz', 'highCrossMaxHz'],
  'sc.mode': ['sidechainMode'],
  'sc.freq': ['sidechainFreq'],
  'sc.q': ['sidechainQ'],
};

/** Body of each `case '<type>'` inside validateProcessorParams (vocal-rebalance delegates to its sanitizer). */
function validatorCaseBodies(): Map<string, string> {
  const start = chainValidationSrc.indexOf('export function validateProcessorParams(');
  assert.ok(start >= 0, 'validateProcessorParams found');
  const end = chainValidationSrc.indexOf('\nconst VALID_TYPES', start);
  const fn = chainValidationSrc.slice(start, end);
  const parts = fn.split(/\n {4}case '/).slice(1);
  const out = new Map<string, string>();
  for (const part of parts) {
    const type = part.slice(0, part.indexOf("'"));
    out.set(type, part);
  }
  const vStart = vocalRebalanceSrc.indexOf('export function sanitizeVocalRebalanceParams(');
  assert.ok(vStart >= 0, 'sanitizeVocalRebalanceParams found');
  out.set('vocal-rebalance', vocalRebalanceSrc.slice(vStart, vocalRebalanceSrc.indexOf('\n}\n', vStart)));
  return out;
}

/** Parameter fields a validator body reads, e.g. `src.thresholdDb`, `bo.freq`, `sc.mode` (prefixed as sc.*). */
function fieldsRead(body: string): string[] {
  const fields = new Set<string>();
  for (const m of body.matchAll(/\b(src|bo|b|sc)\.([A-Za-z]+)\b/g)) {
    if (m[2] === 'stereo' || m[2] === 'mid' || m[2] === 'side') {
      // src.source.stereo etc. (learned spectra internals) are not parameters.
      if (/\.(source|reference)\.$/.test(body.slice(Math.max(0, m.index! - 12), m.index! + m[1].length + 1))) continue;
    }
    fields.add(m[1] === 'sc' ? `sc.${m[2]}` : m[2]);
  }
  return [...fields];
}

function isBooleanField(body: string, field: string): boolean {
  const f = field.replace(/^sc\./, '');
  return new RegExp(`\\b(?:src|bo|b)\\.${f}\\s*(?:===|!==)\\s*(?:true|false)\\b`).test(body)
    || new RegExp(`typeof\\s+(?:src|bo|b)\\.${f}\\s*===\\s*'boolean'`).test(body);
}

/** Finds a limits entry for a field anywhere in the processor's limits (top level or band). */
function findLimit(limits: Record<string, unknown>, key: string): unknown {
  if (key in limits) return limits[key];
  const band = limits.band as Record<string, unknown> | undefined;
  if (band && key in band) return band[key];
  return undefined;
}

function promptLine(type: string): string {
  const line = SYSTEM_PROMPT.split('\n').find((l) => new RegExp(`^\\d+\\. "${type}":`).test(l));
  assert.ok(line, `SYSTEM_PROMPT has a schema line for "${type}"`);
  return line;
}

const fmtRange = ([a, b]: readonly [number, number]) => `${a}..${b}`;
const fmtEnum = (vals: readonly (string | number)[]) =>
  vals.map((v) => (typeof v === 'string' ? `"${v}"` : String(v))).join('|');
const hasField = (line: string, key: string, value: string) =>
  line.includes(`"${key}":${value}`) || line.includes(`"${key}"?:${value}`);

test('processor types: limits table, validator, inventory, prompt and response schema all agree', () => {
  const validatorTypes = (Object.keys(PROCESSOR_DEFAULT_NAMES) as ProcessorType[]).filter((t) => t !== 'external-vst3');
  const limitTypes = Object.keys(PROCESSOR_PARAM_LIMITS).filter((k) => k !== 'module');
  const caseTypes = [...validatorCaseBodies().keys()].filter((t) => t !== 'external-vst3');

  assert.deepEqual([...limitTypes].sort(), [...validatorTypes].sort(), 'every validator type has a limits entry');
  assert.deepEqual([...caseTypes].sort(), [...validatorTypes].sort(), 'validateProcessorParams handles every type');
  assert.deepEqual([...AI_PROCESSOR_TYPES].sort(), [...limitTypes].sort());
  assert.deepEqual(Object.keys(VERIFIED_NATIVE_PROCESSOR_INVENTORY).sort(), [...limitTypes].sort());

  const promptTypes = SYSTEM_PROMPT.split('\n')
    .map((l) => /^\d+\. "([a-z0-9-]+)":/.exec(l)?.[1])
    .filter((t): t is string => Boolean(t));
  assert.deepEqual([...promptTypes].sort(), [...limitTypes].sort(), 'SYSTEM_PROMPT lists each processor exactly once');

  const schemaType = JSON.stringify(PROCESSOR_JSON_SCHEMA.properties.type);
  for (const t of limitTypes) assert.ok(schemaType.includes(t), `response schema "type" names ${t}`);
});

test('every parameter the validator reads is in PROCESSOR_PARAM_LIMITS (or is boolean) and in the prompt', () => {
  const gaps: string[] = [];
  for (const [type, body] of validatorCaseBodies()) {
    if (type === 'external-vst3') continue;
    const limits = PROCESSOR_PARAM_LIMITS[type as AiType] as unknown as Record<string, unknown>;
    const fullLine = promptLine(type);
    // Sidechain fields are looked up inside the sidechain object; every other field outside it, so a
    // sidechain "mode" cannot stand in for the band "mode".
    const scMatch = /"sidechain"\??:\{[^}]*\}/.exec(fullLine);
    const scPart = scMatch?.[0] ?? '';
    const mainPart = scMatch ? fullLine.replace(scMatch[0], '"sidechain":{}') : fullLine;
    for (const field of fieldsRead(body)) {
      const name = field.replace(/^sc\./, '');
      if (NOT_FOR_AI.has(name)) continue;
      const line = field.startsWith('sc.') ? scPart : mainPart;
      if (!new RegExp(`"${name}"\\??:`).test(line)) gaps.push(`${type}.${field}: missing from SYSTEM_PROMPT`);
      if (CONTAINERS.has(name)) continue;
      if (isBooleanField(body, field)) {
        if (!new RegExp(`"${name}"\\??:boolean`).test(line)) gaps.push(`${type}.${field}: prompt must type it as boolean`);
        continue;
      }
      // A same-named limits entry wins; aliases apply only when there is none.
      const keys = findLimit(limits, name) !== undefined ? [name] : (LIMIT_ALIASES[field] ?? LIMIT_ALIASES[name] ?? [name]);
      for (const k of keys) {
        if (findLimit(limits, k) === undefined) gaps.push(`${type}.${field}: no PROCESSOR_PARAM_LIMITS entry "${k}"`);
      }
    }
  }
  assert.deepEqual(gaps, [], `wiring gaps:\n${gaps.join('\n')}`);
});

test('validator clamps and enum checks use the limits table, not their own literals', () => {
  const gaps: string[] = [];
  for (const [type, body] of validatorCaseBodies()) {
    if (type === 'external-vst3') continue;
    const limits = PROCESSOR_PARAM_LIMITS[type as AiType] as unknown as Record<string, unknown>;
    for (const m of body.matchAll(/clamp(?:Num)?\((?:Math\.abs\()?(?:Number\()?(?:src|bo|b|sc)\.([A-Za-z]+)[^\n]*/g)) {
      if (!/\b(lim|L)\./.test(m[0])) gaps.push(`${type}.${m[1]}: clamped with literal bounds`);
    }
    // Literal comparisons (e.g. src.phaseMode === 'linear') must name a value the limits enum allows.
    for (const m of body.matchAll(/(?<!typeof\s)\b(src|bo|b|sc)\.([A-Za-z]+)\s*===\s*'([^']+)'/g)) {
      const field = m[1] === 'sc' ? `sc.${m[2]}` : m[2];
      const keys = LIMIT_ALIASES[field] ?? [m[2]];
      const ok = keys.some((k) => {
        const e = findLimit(limits, k);
        return Array.isArray(e) && (e as unknown[]).includes(m[3]);
      });
      if (!ok) gaps.push(`${type}.${field}: compared with '${m[3]}' which is not in its limits enum`);
    }
  }
  assert.deepEqual(gaps, [], `wiring gaps:\n${gaps.join('\n')}`);
});

test('SYSTEM_PROMPT carries every range and every option exactly as PROCESSOR_PARAM_LIMITS defines it', () => {
  const gaps: string[] = [];
  const mod = PROCESSOR_PARAM_LIMITS.module;
  for (const [k, r] of Object.entries(mod)) {
    if (!SYSTEM_PROMPT.includes(`${k}=${fmtRange(r)}`)) gaps.push(`module.${k}: expected ${k}=${fmtRange(r)}`);
  }

  for (const type of AI_PROCESSOR_TYPES) {
    const line = promptLine(type);
    const limits = PROCESSOR_PARAM_LIMITS[type] as unknown as Record<string, unknown>;
    const check = (entries: Record<string, unknown>, where: string, parent: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(entries)) {
        const id = `${type}.${where}${key}`;
        if (key === 'band') {
          check(value as Record<string, unknown>, 'band.', parent);
        } else if (key === 'maxBands') {
          if (!line.includes(`max ${value} bands`)) gaps.push(`${id}: expected "max ${value} bands"`);
        } else if (key === 'highCrossMinOffsetHz' || key === 'highCrossMaxHz') {
          const low = parent.lowCrossHz as readonly [number, number];
          const expected = `"highCrossHz":${low[0] + (parent.highCrossMinOffsetHz as number)}..${parent.highCrossMaxHz}`;
          if (!line.includes(expected)) gaps.push(`${id}: expected ${expected}`);
          if (!line.includes(`min lowCrossHz+${parent.highCrossMinOffsetHz}`)) gaps.push(`${id}: expected min offset note`);
        } else if (key === 'maxCutDbCut' || key === 'maxCutDbBoost') {
          const tag = key === 'maxCutDbCut' ? 'cut' : 'boost';
          if (!line.includes(`${fmtRange(value as [number, number])} (${tag})`)) gaps.push(`${id}: expected ${fmtRange(value as [number, number])} (${tag})`);
        } else if (key === 'sidechainMode' || key === 'sidechainFreq' || key === 'sidechainQ') {
          const sc = line.slice(line.indexOf('"sidechain"'));
          const sub = key === 'sidechainMode' ? 'mode' : key === 'sidechainFreq' ? 'freq' : 'q';
          const expected = key === 'sidechainMode' ? fmtEnum(value as string[]) : fmtRange(value as [number, number]);
          if (!line.includes('"sidechain"') || !hasField(sc, sub, expected)) gaps.push(`${id}: expected sidechain "${sub}":${expected}`);
        } else if (key === 'subtype') {
          for (const [shape, subtypes] of Object.entries(value as Record<string, readonly string[]>)) {
            if (!line.includes(shape)) gaps.push(`${id}: shape ${shape} not mentioned`);
            for (const st of subtypes) if (!line.includes(`"${st}"`)) gaps.push(`${id}: subtype "${st}" (${shape}) missing`);
          }
        } else if (Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === 'number')) {
          if (!hasField(line, key, fmtRange(value as [number, number]))) gaps.push(`${id}: expected "${key}":${fmtRange(value as [number, number])}`);
        } else if (Array.isArray(value)) {
          if (!hasField(line, key, fmtEnum(value as (string | number)[]))) gaps.push(`${id}: expected "${key}":${fmtEnum(value as (string | number)[])}`);
        } else {
          gaps.push(`${id}: limits entry of an unknown shape; teach the prompt and this test about it`);
        }
      }
    };
    check(limits, '', limits);
  }
  assert.deepEqual(gaps, [], `prompt/limits mismatches:\n${gaps.join('\n')}`);
});

test('every processor type the AI may return passes validateChainAgainstInventory; the prompt states the stage cap', () => {
  for (const type of AI_PROCESSOR_TYPES) {
    const result = validateChainAgainstInventory([
      { type, name: PROCESSOR_DEFAULT_NAMES[type], intensity: 100, wetDry: 100, params: createDefaultParams(type) },
    ]);
    assert.ok(result.valid, `${type} rejected: ${result.errors.join('; ')}`);
    assert.equal(result.sanitizedChain[0]?.type, type);
  }
  const stage = (i: number) => ({ type: AI_PROCESSOR_TYPES[i % AI_PROCESSOR_TYPES.length], name: 'x', intensity: 50, wetDry: 100, params: {} });
  const atCap = Array.from({ length: AI_MAX_CHAIN_STAGES }, (_, i) => stage(i));
  assert.ok(validateChainAgainstInventory(atCap).valid, `${AI_MAX_CHAIN_STAGES} stages accepted`);
  assert.ok(!validateChainAgainstInventory([...atCap, stage(AI_MAX_CHAIN_STAGES)]).valid, 'one more stage rejected');
  assert.ok(SYSTEM_PROMPT.includes(`at most ${AI_MAX_CHAIN_STAGES} modules`), 'prompt tells the AI the stage cap');
});

test('prompt maps measured problems to every tool and lists objectives from MASTERING_OBJECTIVE_IDS', () => {
  const start = SYSTEM_PROMPT.indexOf('MEASURED PROBLEM -> TOOL');
  assert.ok(start >= 0, 'problem -> tool mapping present');
  const mapping = SYSTEM_PROMPT.slice(start, SYSTEM_PROMPT.indexOf('Valid paramsJson schemas', start));
  for (const type of AI_PROCESSOR_TYPES) assert.ok(mapping.includes(`"${type}"`), `mapping names "${type}"`);
  assert.ok(SYSTEM_PROMPT.includes(`Supported Mastering Objectives: ${MASTERING_OBJECTIVE_IDS.join(', ')}.`));
});
