import type { EQBand, ParametricEQParams } from '../../../types/mastering';
import { createDefaultParams, validateProcessorParams } from '../../../dsp/chainValidation';

export interface EqPreset {
  id: string;
  name: string;
  params: ParametricEQParams;
}

const b = (id: string, band: Omit<EQBand, 'id' | 'enabled'>): EQBand => ({ id, enabled: true, ...band });

/** Built-in starting curves. Applying one goes through validation and the normal undo history. */
export const BUILTIN_EQ_PRESETS: EqPreset[] = [
  { id: 'flat', name: 'Flat (default bands)', params: createDefaultParams('parametric-eq') as ParametricEQParams },
  {
    id: 'low-end-tidy', name: 'Low-end tidy (mono lows)', params: { phaseMode: 'minimum', msMode: 'stereo', tiltDb: 0, bands: [
      b('b1', { shape: 'highpass', subtype: 'flat', slope: 24, freq: 28, gain: 0, q: 0.71 }),
      b('b2', { shape: 'highpass', subtype: 'flat', slope: 12, channel: 'side', freq: 120, gain: 0, q: 0.71 }),
      b('b3', { shape: 'bell', subtype: 'proportional', freq: 260, gain: -1.5, q: 1.2 }),
    ] },
  },
  {
    id: 'air-presence', name: 'Air & presence', params: { phaseMode: 'minimum', msMode: 'stereo', tiltDb: 0, bands: [
      b('b1', { shape: 'highpass', subtype: 'flat', slope: 12, freq: 25, gain: 0, q: 0.71 }),
      b('b2', { shape: 'bell', subtype: 'proportional', channel: 'mid', freq: 3200, gain: 1.5, q: 1 }),
      b('b3', { shape: 'highshelf', subtype: 'baxandall', freq: 10000, gain: 2, q: 0.71 }),
    ] },
  },
  {
    id: 'vintage-warmth', name: 'Vintage warmth', params: { phaseMode: 'minimum', msMode: 'stereo', tiltDb: 0, bands: [
      b('b1', { shape: 'lowshelf', subtype: 'vintage', freq: 60, gain: 2, q: 0.71 }),
      b('b2', { shape: 'bell', subtype: 'band-shelf', freq: 1800, gain: -0.8, q: 0.8 }),
      b('b3', { shape: 'highshelf', subtype: 'vintage', freq: 12000, gain: 1.5, q: 0.71 }),
    ] },
  },
  {
    id: 'brickwall-guard', name: 'Brickwall guard (sub + ultrasonic)', params: { phaseMode: 'minimum', msMode: 'stereo', tiltDb: 0, bands: [
      b('b1', { shape: 'highpass', subtype: 'brickwall', freq: 22, gain: 0, q: 0.71 }),
      b('b2', { shape: 'lowpass', subtype: 'brickwall', freq: 19500, gain: 0, q: 0.71 }),
    ] },
  },
];

const USER_KEY = 'syn-master.eq-presets.v1';

export function loadUserEqPresets(): EqPreset[] {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(USER_KEY) : null;
    if (!raw) return [];
    const list = JSON.parse(raw) as Array<{ id: string; name: string; params: unknown }>;
    return list.slice(0, 50).map((p) => ({ id: String(p.id), name: String(p.name).slice(0, 60), params: validateProcessorParams('parametric-eq', p.params) as ParametricEQParams }));
  } catch {
    return [];
  }
}

export function saveUserEqPreset(name: string, params: ParametricEQParams): EqPreset[] {
  const list = loadUserEqPresets().filter((p) => p.name !== name);
  // Solo is a listening state, never part of a preset.
  const clean: ParametricEQParams = { ...params, bands: params.bands.map(({ solo: _solo, ...rest }) => rest) };
  const next = [...list, { id: `user-${Date.now().toString(36)}`, name: name.slice(0, 60), params: clean }];
  try {
    localStorage.setItem(USER_KEY, JSON.stringify(next));
  } catch {
    /* storage full or disabled: keep in memory only */
  }
  return next;
}

export function deleteUserEqPreset(id: string): EqPreset[] {
  const next = loadUserEqPresets().filter((p) => p.id !== id);
  try {
    localStorage.setItem(USER_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  return next;
}
