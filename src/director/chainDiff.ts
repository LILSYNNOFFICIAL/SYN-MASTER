/**
 * "What AI changed" diff: compares the chain from before a FIX ALL run with the retained
 * final chain and describes every module that was added, removed or changed, plus pure
 * helpers that revert / reapply one entry against whatever the chain is *now*.
 *
 * Everything here is generic over module type: params are walked structurally, so processors
 * added later (or unknown to this file) diff and revert without any per-type code.
 */
import type { ProcessorModule } from '../types/mastering';

export type ChainDiffKind = 'added' | 'removed' | 'changed';

export interface ChainParamChange {
  /** Dotted path inside the module, e.g. `params.bands[2].gainDb` or `outputGainDb`. */
  path: string;
  /** Human label, e.g. `Band 3 · Gain dB`. */
  label: string;
  before: unknown;
  after: unknown;
  /** Pre-formatted display (EQ / Dynamic EQ bands are described as one line each). */
  beforeText?: string;
  afterText?: string;
}

export interface ChainDiffEntry {
  /** Stable key for React lists and per-entry actions. */
  key: string;
  kind: ChainDiffKind;
  type: string;
  name: string;
  /** Module as it was before the run (absent for `added`). */
  before?: ProcessorModule;
  /** Module as the run left it (absent for `removed`). */
  after?: ProcessorModule;
  beforeIndex: number;
  afterIndex: number;
  /** Param / field changes (for `changed`; the module's key params for `added` / `removed`). */
  changes: ChainParamChange[];
  /** Set when a kept module moved relative to the other kept modules. */
  moved?: { from: number; to: number };
}

export type ChainDiffStatus = 'applied' | 'reverted' | 'diverged';

/** UI / host-session state that is not a sound decision and must never count as a change. */
const IGNORED_TOP_LEVEL = new Set(['id', 'expanded', 'type', 'name', 'presetName', 'group']);
const IGNORED_PARAM_KEYS = new Set(['instanceId', 'status', 'editorOpen', 'lastError', 'solo']);
const TOP_LEVEL_ORDER = ['enabled', 'bypassed', 'intensity', 'wetDry', 'inputGainDb', 'outputGainDb'];
const FLOAT_EPS = 1e-9;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
    return Math.abs(a - b) <= FLOAT_EPS * Math.max(1, Math.abs(a), Math.abs(b));
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => valuesEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (IGNORED_PARAM_KEYS.has(k)) continue;
      if (!valuesEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return a === b;
}

/** Sound-relevant equality of two modules (ignores id, UI expansion and VST3 session state). */
export function modulesEquivalent(a: ProcessorModule, b: ProcessorModule): boolean {
  if (a.type !== b.type) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (IGNORED_TOP_LEVEL.has(k)) continue;
    if (!valuesEqual((a as unknown as Record<string, unknown>)[k], (b as unknown as Record<string, unknown>)[k])) return false;
  }
  return true;
}

const WORD_FIXES: Record<string, string> = {
  db: 'dB', hz: 'Hz', khz: 'kHz', ms: 'ms', lufs: 'LUFS', dbtp: 'dBTP', q: 'Q', eq: 'EQ',
};

/** `outputGainDb` → `Output gain dB`, `bands[2]` → `Band 3`. */
export function humanizeKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((w) => WORD_FIXES[w.toLowerCase()] ?? w.toLowerCase());
  if (words.length === 0) return key;
  const first = words[0];
  words[0] = first === first.toLowerCase() ? first.charAt(0).toUpperCase() + first.slice(1) : first;
  return words.join(' ');
}

function singular(key: string): string {
  const h = humanizeKey(key);
  return h.endsWith('s') && h.length > 3 ? h.slice(0, -1) : h;
}


// EQ-style band lists (ported from the fixall3 WIP diff): one readable line per band.
function fmtNumber(value: number, unit: string): string {
  if (!Number.isFinite(value)) return String(value);
  if (unit === 'Hz' && Math.abs(value) >= 1000) {
    return `${Number((value / 1000).toFixed(2))} kHz`;
  }
  const rounded = Number(value.toFixed(Math.abs(value) >= 100 ? 0 : 2));
  const text = unit === 'dB' || unit === 'dBTP' ? (rounded > 0 ? `+${rounded}` : String(rounded)).replace('-', '−') : String(rounded).replace('-', '−');
  return unit ? (unit === '%' ? `${text}%` : `${text} ${unit}`) : text;
}


function isBandList(value: unknown): value is Array<Record<string, unknown>> {
  return Array.isArray(value) && value.length > 0 && value.every((b) => isPlainObject(b) && 'freq' in b);
}

const SUBTYPE_LABEL: Record<string, string> = {
  proportional: 'Proportional Q',
  bell: 'Bell',
  'band-shelf': 'Band shelf',
  analog: 'Analog',
  baxandall: 'Baxandall',
  vintage: 'Vintage',
  resonant: 'Resonant',
  flat: 'Flat',
  brickwall: 'Brickwall',
};
const SHAPE_LABEL: Record<string, string> = {
  highpass: 'high-pass',
  lowpass: 'low-pass',
  lowshelf: 'low shelf',
  highshelf: 'high shelf',
  bell: 'bell',
  notch: 'notch',
  bandpass: 'band-pass',
  tilt: 'tilt',
};

/** One-line description of an EQ / Dynamic EQ band. */
export function describeBand(band: Record<string, unknown> | undefined): string {
  if (!band) return '—';
  if (band.enabled === false) return 'Off';
  const parts: string[] = [];
  const freq = typeof band.freq === 'number' ? fmtNumber(band.freq, 'Hz') : '';
  if (typeof band.shape === 'string') {
    // Parametric EQ band
    const shape = SHAPE_LABEL[band.shape] ?? band.shape;
    const subtype = typeof band.subtype === 'string' ? SUBTYPE_LABEL[band.subtype] ?? band.subtype : '';
    const name = subtype && subtype.toLowerCase() !== shape ? `${subtype} ${shape}` : shape.charAt(0).toUpperCase() + shape.slice(1);
    parts.push(name.charAt(0).toUpperCase() + name.slice(1), freq);
    if ((band.shape === 'bell' || band.shape === 'lowshelf' || band.shape === 'highshelf' || band.shape === 'tilt') && typeof band.gain === 'number') {
      parts.push(fmtNumber(band.gain, 'dB'));
    }
    if (typeof band.slope === 'number') parts.push(`${band.slope} dB/oct`);
    if (band.shape === 'bell' || band.shape === 'notch' || band.shape === 'bandpass') {
      if (typeof band.q === 'number') parts.push(`Q ${Number(band.q.toFixed(2))}`);
    }
  } else {
    // Dynamic EQ band
    const type = typeof band.type === 'string' ? band.type.replace(/-/g, ' ') : 'bell';
    parts.push(`Dynamic ${type}`, freq);
    if (typeof band.maxCutDb === 'number') parts.push(`${fmtNumber(band.maxCutDb, 'dB')} max`);
    if (typeof band.thresholdDb === 'number') parts.push(`@ ${fmtNumber(band.thresholdDb, 'dB')}`);
    if (typeof band.kneeDb === 'number') parts.push(`knee ${band.kneeDb} dB`);
  }
  if (typeof band.channel === 'string' && band.channel !== 'stereo') {
    parts.push(band.channel.charAt(0).toUpperCase() + band.channel.slice(1));
  }
  return parts.filter(Boolean).join(' · ');
}


function diffBandLists(path: string, before: Array<Record<string, unknown>>, after: Array<Record<string, unknown>>, out: ChainParamChange[]): void {
  const keyOf = (band: Record<string, unknown>, i: number) => (typeof band.id === 'string' ? band.id : `#${i}`);
  const order: string[] = [];
  for (const [list] of [[before], [after]] as const) list.forEach((band, i) => { const k = keyOf(band, i); if (!order.includes(k)) order.push(k); });
  order.forEach((k, n) => {
    const bi = before.findIndex((band, i) => keyOf(band, i) === k);
    const ai = after.findIndex((band, i) => keyOf(band, i) === k);
    const b = bi >= 0 ? before[bi] : undefined;
    const a = ai >= 0 ? after[ai] : undefined;
    if (valuesEqual(b, a)) return;
    const beforeText = b ? describeBand(b) : '—';
    let afterText = a ? describeBand(a) : '—';
    if (a && afterText === beforeText) afterText = `${afterText} (edited)`;
    out.push({ path: `${path}[${ai >= 0 ? ai : bi}]`, label: `Band ${n + 1}`, before: b, after: a, beforeText, afterText });
  });
}

const UNIT_WORDS = new Set(['dB', 'Hz', 'kHz', 'ms', 'LUFS', 'dBTP']);

/** Label for a leaf key whose value is displayed with its unit: `thresholdDb` → `Threshold`. */
export function leafLabel(key: string): string {
  const words = humanizeKey(key).split(' ');
  if (words.length > 1 && UNIT_WORDS.has(words[words.length - 1])) words.pop();
  return words.join(' ');
}

function walk(
  a: unknown,
  b: unknown,
  path: string,
  labelParts: string[],
  out: ChainParamChange[],
): void {
  if (valuesEqual(a, b)) return;
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    for (const k of keys) {
      if (IGNORED_PARAM_KEYS.has(k)) continue;
      walk(a[k], b[k], path ? `${path}.${k}` : k, [...labelParts, leafLabel(k)], out);
    }
    return;
  }
  if (isBandList(a) && isBandList(b)) {
    diffBandLists(path, a, b, out);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b) && (a.some(isPlainObject) || b.some(isPlainObject))) {
    const parentKey = path.split('.').pop()?.replace(/\[\d+\]$/, '') ?? '';
    const itemLabel = singular(parentKey || 'item');
    const parentLabels = labelParts.slice(0, -1);
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      walk(a[i], b[i], `${path}[${i}]`, [...parentLabels, `${itemLabel} ${i + 1}`], out);
    }
    return;
  }
  out.push({ path, label: labelParts.join(' · ') || path, before: a, after: b });
}

/** Flat list of field changes between two versions of one module. */
export function diffModuleFields(before: ProcessorModule, after: ProcessorModule): ChainParamChange[] {
  const out: ChainParamChange[] = [];
  const b = before as unknown as Record<string, unknown>;
  const a = after as unknown as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((k) => !IGNORED_TOP_LEVEL.has(k));
  keys.sort((x, y) => {
    const ix = x === 'params' ? -1 : TOP_LEVEL_ORDER.indexOf(x);
    const iy = y === 'params' ? -1 : TOP_LEVEL_ORDER.indexOf(y);
    return (ix === -1 ? 999 : ix) - (iy === -1 ? 999 : iy);
  });
  for (const k of keys) {
    if (k === 'params') walk(b[k], a[k], 'params', [], out);
    else walk(b[k], a[k], k, [leafLabel(k)], out);
  }
  return out;
}

/** Key params of a module that was added or removed (scalar params, then gain staging). */
export function summarizeModuleParams(mod: ProcessorModule, limit = 8): ChainParamChange[] {
  const out: ChainParamChange[] = [];
  const visit = (v: unknown, path: string, labels: string[]) => {
    if (out.length >= limit) return;
    if (isPlainObject(v)) {
      for (const [k, child] of Object.entries(v)) {
        if (IGNORED_PARAM_KEYS.has(k)) continue;
        visit(child, `${path}.${k}`, [...labels, leafLabel(k)]);
      }
      return;
    }
    if (Array.isArray(v)) {
      if (isBandList(v)) {
        v.forEach((band, i) => { if (out.length < limit) out.push({ path: `${path}[${i}]`, label: `Band ${i + 1}`, before: undefined, after: band, beforeText: '—', afterText: describeBand(band) }); });
        return;
      }
      if (v.some(isPlainObject)) {
        out.push({ path, label: labels.join(' · '), before: undefined, after: `${v.length} ${v.length === 1 ? 'item' : 'items'}` });
      } else if (v.length <= 4) {
        out.push({ path, label: labels.join(' · '), before: undefined, after: v });
      }
      return;
    }
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') {
      out.push({ path, label: labels.join(' · '), before: undefined, after: v });
    }
  };
  visit(mod.params, 'params', []);
  if (mod.outputGainDb && out.length < limit) out.push({ path: 'outputGainDb', label: 'Output gain', before: undefined, after: mod.outputGainDb });
  if (mod.inputGainDb && out.length < limit) out.push({ path: 'inputGainDb', label: 'Input gain', before: undefined, after: mod.inputGainDb });
  return out;
}

/**
 * Pair modules across the two chains: same id first, then the remaining modules of the same
 * type in order of appearance (the planner may mint new ids for a module it only retuned).
 */
function pairModules(before: ProcessorModule[], after: ProcessorModule[]): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  const usedB = new Set<number>();
  const usedA = new Set<number>();
  const afterById = new Map<string, number>();
  after.forEach((m, i) => { if (!afterById.has(m.id)) afterById.set(m.id, i); });
  before.forEach((m, i) => {
    const j = afterById.get(m.id);
    if (j !== undefined && !usedA.has(j) && after[j].type === m.type) {
      pairs.push([i, j]); usedB.add(i); usedA.add(j);
    }
  });
  before.forEach((m, i) => {
    if (usedB.has(i)) return;
    const j = after.findIndex((n, k) => !usedA.has(k) && n.type === m.type);
    if (j !== -1) { pairs.push([i, j]); usedB.add(i); usedA.add(j); }
  });
  return pairs;
}

/** Diff the pre-run chain against the chain the run retained. Pure. */
export function diffChains(before: ProcessorModule[], after: ProcessorModule[]): ChainDiffEntry[] {
  const pairs = pairModules(before, after);
  const pairedB = new Map(pairs.map(([i, j]) => [i, j]));
  const pairedA = new Set(pairs.map(([, j]) => j));

  // Relative order among kept modules, to flag moves without counting insert/remove shifts.
  const keptByBefore = [...pairs].sort((x, y) => x[0] - y[0]);
  const keptByAfter = [...pairs].sort((x, y) => x[1] - y[1]);
  const rankAfter = new Map(keptByAfter.map(([i], r) => [i, r]));

  const entries: ChainDiffEntry[] = [];
  keptByBefore.forEach(([i, j], rankBefore) => {
    const b = before[i];
    const a = after[j];
    const changes = diffModuleFields(b, a);
    const ra = rankAfter.get(i)!;
    const moved = ra !== rankBefore ? { from: i + 1, to: j + 1 } : undefined;
    if (changes.length === 0 && !moved) return;
    entries.push({ key: `changed:${b.id}:${a.id}`, kind: 'changed', type: a.type, name: a.name || b.name, before: b, after: a, beforeIndex: i, afterIndex: j, changes, moved });
  });
  after.forEach((a, j) => {
    if (pairedA.has(j)) return;
    entries.push({ key: `added:${a.id}:${j}`, kind: 'added', type: a.type, name: a.name, after: a, beforeIndex: -1, afterIndex: j, changes: summarizeModuleParams(a) });
  });
  before.forEach((b, i) => {
    if (pairedB.has(i)) return;
    entries.push({ key: `removed:${b.id}:${i}`, kind: 'removed', type: b.type, name: b.name, before: b, beforeIndex: i, afterIndex: -1, changes: summarizeModuleParams(b) });
  });
  const pos = (e: ChainDiffEntry) => (e.afterIndex >= 0 ? e.afterIndex : e.beforeIndex - 0.5);
  return entries.sort((x, y) => pos(x) - pos(y));
}

function findById(chain: ProcessorModule[], id: string | undefined): number {
  return id === undefined ? -1 : chain.findIndex((m) => m.id === id);
}

/** Where one entry stands in the current chain (global undo/redo can move it either way). */
export function diffEntryStatus(current: ProcessorModule[], entry: ChainDiffEntry): ChainDiffStatus {
  if (entry.kind === 'added') return findById(current, entry.after!.id) >= 0 ? 'applied' : 'reverted';
  if (entry.kind === 'removed') return findById(current, entry.before!.id) >= 0 ? 'reverted' : 'applied';
  const idx = findById(current, entry.after!.id) >= 0 ? findById(current, entry.after!.id) : findById(current, entry.before!.id);
  if (idx < 0) return 'diverged';
  const mod = current[idx];
  const isAfter = modulesEquivalent(mod, entry.after!);
  const isBefore = modulesEquivalent(mod, entry.before!);
  if (isAfter && isBefore) {
    // Move-only entry: the slot decides.
    if (idx === entry.afterIndex) return 'applied';
    if (idx === entry.beforeIndex) return 'reverted';
    return 'diverged';
  }
  if (isAfter) return 'applied';
  if (isBefore) return 'reverted';
  return 'diverged';
}

/** Insert `mod` near where it sat in `reference`, anchored on neighbours still present in `chain`. */
function insertNear(chain: ProcessorModule[], mod: ProcessorModule, reference: ProcessorModule[], refIndex: number): ProcessorModule[] {
  const next = chain.slice();
  for (let k = refIndex - 1; k >= 0; k--) {
    const at = findById(next, reference[k]?.id);
    if (at >= 0) { next.splice(at + 1, 0, mod); return next; }
  }
  for (let k = refIndex + 1; k < reference.length; k++) {
    const at = findById(next, reference[k]?.id);
    if (at >= 0) { next.splice(at, 0, mod); return next; }
  }
  next.splice(Math.min(Math.max(refIndex, 0), next.length), 0, mod);
  return next;
}

/**
 * Restore one entry's module to its pre-run state in the current chain. Returns a new chain,
 * or the same array reference when there is nothing to do (already reverted / module gone).
 * Leaves every other module untouched, so manual edits made after the run survive.
 */
export function revertDiffEntry(
  current: ProcessorModule[],
  entry: ChainDiffEntry,
  beforeChain: ProcessorModule[],
): ProcessorModule[] {
  if (entry.kind === 'added') {
    const at = findById(current, entry.after!.id);
    return at < 0 ? current : current.filter((_, i) => i !== at);
  }
  if (entry.kind === 'removed') {
    if (findById(current, entry.before!.id) >= 0) return current;
    return insertNear(current, structuredClone(entry.before!), beforeChain, entry.beforeIndex);
  }
  let at = findById(current, entry.after!.id);
  if (at < 0) at = findById(current, entry.before!.id);
  if (at < 0) return current;
  if (diffEntryStatus(current, entry) === 'reverted') return current;
  const restored = structuredClone(entry.before!);
  if (!entry.moved) {
    const next = current.slice();
    next[at] = restored;
    return next;
  }
  const without = current.filter((_, i) => i !== at);
  return insertNear(without, restored, beforeChain, entry.beforeIndex);
}

/** Put one entry's AI version back (the inverse of {@link revertDiffEntry}). */
export function reapplyDiffEntry(
  current: ProcessorModule[],
  entry: ChainDiffEntry,
  afterChain: ProcessorModule[],
): ProcessorModule[] {
  if (entry.kind === 'removed') {
    const at = findById(current, entry.before!.id);
    return at < 0 ? current : current.filter((_, i) => i !== at);
  }
  if (entry.kind === 'added') {
    if (findById(current, entry.after!.id) >= 0) return current;
    return insertNear(current, structuredClone(entry.after!), afterChain, entry.afterIndex);
  }
  let at = findById(current, entry.before!.id);
  if (at < 0) at = findById(current, entry.after!.id);
  if (at < 0) return current;
  if (diffEntryStatus(current, entry) === 'applied') return current;
  const applied = structuredClone(entry.after!);
  if (!entry.moved) {
    const next = current.slice();
    next[at] = applied;
    return next;
  }
  const without = current.filter((_, i) => i !== at);
  return insertNear(without, applied, afterChain, entry.afterIndex);
}

/** Revert every still-applied entry in one step (one history snapshot for the caller). */
export function revertAllDiffEntries(
  current: ProcessorModule[],
  entries: ChainDiffEntry[],
  beforeChain: ProcessorModule[],
): ProcessorModule[] {
  let next = current;
  // Changed first, then removals re-inserted in pre-run order, so neighbours exist to anchor on.
  const ordered = [
    ...entries.filter((e) => e.kind === 'added'),
    ...entries.filter((e) => e.kind === 'changed'),
    ...entries.filter((e) => e.kind === 'removed').sort((a, b) => a.beforeIndex - b.beforeIndex),
  ];
  for (const e of ordered) {
    if (diffEntryStatus(next, e) === 'reverted') continue;
    next = revertDiffEntry(next, e, beforeChain);
  }
  return next;
}

const UNIT_SUFFIXES: Array<[RegExp, string]> = [
  [/dbtp$/i, ' dBTP'], [/lufs$/i, ' LUFS'], [/db$/i, ' dB'], [/khz$/i, ' kHz'], [/hz$/i, ' Hz'],
  [/ms$/i, ' ms'], [/(percent|pct|mix|wetdry|intensity|amount)$/i, '%'],
];

/** Compact display of a param value, with a unit inferred from its key. */
export function formatDiffValue(value: unknown, path = ''): string {
  if (value === undefined) return '—';
  if (value === null) return 'none';
  if (typeof value === 'boolean') {
    if (/bypass/i.test(path)) return value ? 'bypassed' : 'active';
    return value ? 'on' : 'off';
  }
  if (typeof value === 'number') {
    const key = path.split(/[.[\]]/).filter(Boolean).pop() ?? '';
    const unit = UNIT_SUFFIXES.find(([re]) => re.test(key))?.[1] ?? '';
    const abs = Math.abs(value);
    if (unit === ' Hz' && abs >= 1000) return `${(value / 1000).toFixed(abs >= 10000 ? 1 : 2).replace(/\.?0+$/, '')} kHz`;
    let s: string;
    if (Number.isInteger(value)) s = String(value);
    else s = String(Number(value.toFixed(abs >= 100 ? 0 : abs >= 10 ? 1 : 2)));
    s = s.replace('-', '−');
    return `${s}${unit}`;
  }
  if (typeof value === 'string') return value.length > 28 ? `${value.slice(0, 27)}…` : value;
  if (Array.isArray(value)) return value.length <= 4 && !value.some(isPlainObject) ? `[${value.map((v) => formatDiffValue(v)).join(', ')}]` : `${value.length} items`;
  return '{…}';
}
