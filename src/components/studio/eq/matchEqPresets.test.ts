import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMatchEqPreset, deleteMatchEqPreset, listMatchEqPresets, saveMatchEqPreset } from './matchEqPresets';
import { createDefaultParams } from '../../../dsp/chainValidation';
import { MATCH_EQ_GRID_POINTS, computeMatchEqCurve } from '../../../dsp/matchEq';
import type { MatchEqParams, MatchEqSpectrumSet } from '../../../types/mastering';

const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }; };
const set = (f: (i: number) => number): MatchEqSpectrumSet => ({ stereo: Array.from({ length: MATCH_EQ_GRID_POINTS }, (_, i) => f(i)), mid: Array.from({ length: MATCH_EQ_GRID_POINTS }, (_, i) => f(i)), side: Array.from({ length: MATCH_EQ_GRID_POINTS }, (_, i) => f(i)) });

test('learned curve saves as a preset and reloads against a new source', () => {
  const kv = mem();
  const params: MatchEqParams = { ...(createDefaultParams('match-eq') as MatchEqParams), amount: 55, source: set(() => 0), reference: set((i) => i / 24), referenceName: 'Ref A' };
  assert.equal(saveMatchEqPreset('x', createDefaultParams('match-eq') as MatchEqParams, kv), null, 'unlearned cannot be saved');
  const saved = saveMatchEqPreset('My curve', params, kv)!;
  assert.equal(listMatchEqPresets(kv).length, 1);
  const same = applyMatchEqPreset(saved, null);
  assert.equal(same.amount, 55);
  const a = computeMatchEqCurve(same).correctionDb, b = computeMatchEqCurve(params).correctionDb;
  a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 0.02, 'saved curve (0.01 dB rounding) reproduces the learned curve'));
  const other = applyMatchEqPreset(saved, set((i) => i / 48));
  assert.ok(Math.abs(other.reference!.stereo[100] - params.reference!.stereo[100]) < 0.01);
  assert.equal(other.source!.stereo[48], 1);
  deleteMatchEqPreset(saved.id, kv);
  assert.equal(listMatchEqPresets(kv).length, 0);
});
