import type { MatchEqParams, MatchEqSpectrumSet } from '../../../types/mastering';
import { isValidSpectrumSet } from '../../../dsp/matchEq';
import { validateProcessorParams } from '../../../dsp/chainValidation';

/**
 * Saved Match EQ "learned curves": the reference spectrum (the tonal target), the source it was
 * learned against and the settings. Loading one onto another song keeps the target and
 * re-learns the source from the current track when one is loaded, so the curve adapts to it.
 * Stored in browser localStorage (small: ~10 KB per preset, capped at MAX_PRESETS).
 */
export interface MatchEqPreset {
  id: string;
  name: string;
  createdAt: number;
  referenceName?: string;
  source: MatchEqSpectrumSet;
  reference: MatchEqSpectrumSet;
  settings: Omit<MatchEqParams, 'source' | 'reference' | 'referenceName'>;
}

export const MATCH_EQ_PRESETS_KEY = 'syn-master.matchEqPresets.v1';
export const MAX_PRESETS = 24;

type KV = Pick<Storage, 'getItem' | 'setItem'>;

function storage(): KV | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

const round = (set: MatchEqSpectrumSet): MatchEqSpectrumSet => ({
  stereo: set.stereo.map((v) => Math.round(v * 100) / 100),
  mid: set.mid.map((v) => Math.round(v * 100) / 100),
  side: set.side.map((v) => Math.round(v * 100) / 100),
});

function sanitize(raw: unknown): MatchEqPreset | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.name !== 'string') return null;
  if (!isValidSpectrumSet(o.source) || !isValidSpectrumSet(o.reference)) return null;
  const settings = validateProcessorParams('match-eq', o.settings) as MatchEqParams;
  return {
    id: o.id,
    name: o.name.slice(0, 80),
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : 0,
    ...(typeof o.referenceName === 'string' ? { referenceName: o.referenceName.slice(0, 160) } : {}),
    source: o.source,
    reference: o.reference,
    settings,
  };
}

export function listMatchEqPresets(kv: KV | null = storage()): MatchEqPreset[] {
  if (!kv) return [];
  try {
    const parsed = JSON.parse(kv.getItem(MATCH_EQ_PRESETS_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.map(sanitize).filter((p): p is MatchEqPreset => p !== null) : [];
  } catch {
    return [];
  }
}

function write(list: MatchEqPreset[], kv: KV | null): boolean {
  if (!kv) return false;
  try {
    kv.setItem(MATCH_EQ_PRESETS_KEY, JSON.stringify(list.slice(0, MAX_PRESETS)));
    return true;
  } catch {
    return false;
  }
}

/** Save the module's learned curve. Returns the preset, or null when nothing is learned / storage failed. */
export function saveMatchEqPreset(name: string, params: MatchEqParams, kv: KV | null = storage()): MatchEqPreset | null {
  if (!isValidSpectrumSet(params.source) || !isValidSpectrumSet(params.reference)) return null;
  const { source, reference, referenceName, ...settings } = params;
  const trimmed = name.trim().slice(0, 80) || referenceName || 'Match EQ curve';
  const preset: MatchEqPreset = {
    id: `meq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: trimmed,
    createdAt: Date.now(),
    ...(referenceName ? { referenceName } : {}),
    source: round(source),
    reference: round(reference),
    settings,
  };
  const list = [preset, ...listMatchEqPresets(kv).filter((p) => p.name !== trimmed)];
  return write(list, kv) ? preset : null;
}

export function deleteMatchEqPreset(id: string, kv: KV | null = storage()): void {
  write(listMatchEqPresets(kv).filter((p) => p.id !== id), kv);
}

/** Params for a loaded preset: its target and settings, against the current source when available. */
export function applyMatchEqPreset(preset: MatchEqPreset, currentSource: MatchEqSpectrumSet | null): MatchEqParams {
  return validateProcessorParams('match-eq', {
    ...preset.settings,
    source: currentSource ?? preset.source,
    reference: preset.reference,
    referenceName: preset.referenceName ?? preset.name,
  }) as MatchEqParams;
}
