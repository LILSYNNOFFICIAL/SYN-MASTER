import test from 'node:test';
import assert from 'node:assert/strict';
import { createProcessorModule } from '../dsp/chainValidation.ts';
import type { ProcessorModule } from '../types/mastering.ts';
import {
  diffChains,
  describeBand,
  diffEntryStatus,
  formatDiffValue,
  humanizeKey,
  modulesEquivalent,
  reapplyDiffEntry,
  revertAllDiffEntries,
  revertDiffEntry,
} from './chainDiff.ts';

const clone = <T,>(v: T): T => structuredClone(v);

function baseChain(): ProcessorModule[] {
  return [
    createProcessorModule('parametric-eq', { id: 'eq' }),
    createProcessorModule('compressor', { id: 'comp' }),
    createProcessorModule('limiter', { id: 'lim' }),
  ];
}

function withParams(mod: ProcessorModule, patch: Record<string, unknown>): ProcessorModule {
  return { ...mod, params: { ...(mod.params as object), ...patch } as unknown as ProcessorModule["params"] };
}

test('identical chains produce no entries; UI-only fields are ignored', () => {
  const before = baseChain();
  const after = clone(before).map((m) => ({ ...m, expanded: !m.expanded }));
  assert.deepEqual(diffChains(before, after), []);
});

test('detects added, removed and changed modules with before→after values', () => {
  const before = baseChain();
  const after = clone(before);
  after[1] = withParams(after[1], { thresholdDb: -24 });
  after[1].outputGainDb = 1.5;
  after.splice(0, 1); // remove EQ
  after.splice(1, 0, createProcessorModule('saturation', { id: 'sat' }));

  const entries = diffChains(before, after);
  const kinds = entries.map((e) => `${e.kind}:${e.type}`).sort();
  assert.deepEqual(kinds, ['added:saturation', 'changed:compressor', 'removed:parametric-eq']);

  const changed = entries.find((e) => e.kind === 'changed')!;
  const thr = changed.changes.find((c) => c.path === 'params.thresholdDb')!;
  assert.equal(thr.after, -24);
  assert.equal(thr.before, (before[1].params as unknown as Record<string, unknown>).thresholdDb);
  assert.ok(changed.changes.some((c) => c.path === 'outputGainDb' && c.after === 1.5));

  const added = entries.find((e) => e.kind === 'added')!;
  assert.ok(added.changes.length > 0, 'added module lists its key params');
});

test('EQ band lists read as one line per band (fresh ids paired by type)', () => {
  const eqBefore = withParams(createProcessorModule('parametric-eq', { id: 'user-eq' }), { bands: [{ id: 'b1', enabled: true, shape: 'bell', freq: 300, gain: -1, q: 1.4 }] });
  const eqAfter = withParams(createProcessorModule('parametric-eq', { id: 'ai-eq' }), {
    bands: [
      { id: 'b1', enabled: true, shape: 'bell', subtype: 'proportional', freq: 300, gain: -1.5, q: 1.8 },
      { id: 'b-side', enabled: true, shape: 'highpass', subtype: 'flat', slope: 24, channel: 'side', freq: 115, gain: 0, q: 0.71 },
    ],
  });
  const entries = diffChains([eqBefore], [eqAfter]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'changed');
  const bandLines = entries[0].changes.filter((c) => c.label.startsWith('Band'));
  assert.equal(bandLines.length, 2);
  assert.match(bandLines[0].afterText!, /Proportional Q bell · 300 Hz · −1.5 dB/);
  assert.equal(bandLines[1].beforeText, '—');
  assert.match(bandLines[1].afterText!, /Flat high-pass · 115 Hz · 24 dB\/oct · Side/);
  const reverted = revertDiffEntry([eqAfter], entries[0], [eqBefore]);
  assert.ok(modulesEquivalent(reverted[0], eqBefore));
});

test('UI-only band solo is not a change; dynamic bands are described', () => {
  const band = { id: 'b1', enabled: true, shape: 'bell', freq: 1000, gain: 1, q: 1 };
  const eq = withParams(createProcessorModule('parametric-eq', { id: 'eq' }), { bands: [band] });
  const eqUi = withParams({ ...eq, expanded: !eq.expanded }, { bands: [{ ...band, solo: true }] });
  assert.deepEqual(diffChains([eq], [eqUi]), []);
  assert.equal(
    describeBand({ id: 'd1', enabled: true, type: 'high-shelf', freq: 5600, q: 0.71, thresholdDb: -20, maxCutDb: -3, kneeDb: 4, channel: 'mid' }),
    'Dynamic high shelf · 5.6 kHz · −3 dB max · @ −20 dB · knee 4 dB · Mid',
  );
  assert.equal(describeBand({ id: 'x', enabled: false, shape: 'bell', freq: 100, gain: 1, q: 1 }), 'Off');
});

test('a removed module is reinserted next to type-matched survivors with fresh ids', () => {
  const before = [
    createProcessorModule('restore', { id: 'user-restore' }),
    createProcessorModule('parametric-eq', { id: 'user-eq' }),
    createProcessorModule('maximizer', { id: 'user-max' }),
  ];
  const after = [withParams(createProcessorModule('parametric-eq', { id: 'ai-eq' }), { tiltDb: 0.5 }), createProcessorModule('maximizer', { id: 'ai-max' })];
  const entries = diffChains(before, after);
  const removed = entries.find((e) => e.kind === 'removed')!;
  assert.equal(removed.type, 'restore');
  const next = revertDiffEntry(after, removed, before);
  assert.deepEqual(next.map((m) => m.id), ['user-restore', 'ai-eq', 'ai-max']);
});

test('unknown future module types diff and revert generically', () => {
  const alien = (id: string, params: Record<string, unknown>): ProcessorModule =>
    ({ ...createProcessorModule('compressor', { id }), type: 'spectral-tilt-x' as ProcessorModule['type'], name: 'Tilt X', params } as unknown as ProcessorModule);
  const before = [alien('t1', { tiltDb: 0, pivotHz: 1000, nested: { modes: [{ on: true }] } })];
  const after = [alien('t1', { tiltDb: -1.5, pivotHz: 1000, nested: { modes: [{ on: false }] }, newKnob: 2 })];
  const entries = diffChains(before, after);
  assert.equal(entries.length, 1);
  const paths = entries[0].changes.map((c) => c.path).sort();
  assert.deepEqual(paths, ['params.nested.modes[0].on', 'params.newKnob', 'params.tiltDb']);
  const reverted = revertDiffEntry(after, entries[0], before);
  assert.ok(modulesEquivalent(reverted[0], before[0]));
});

test('pairs retuned modules by type when the planner minted new ids', () => {
  const before = baseChain();
  const after = clone(before).map((m) => ({ ...m, id: `${m.id}-new` }));
  after[2] = withParams(after[2], { ceilingDb: -1.2 });
  const entries = diffChains(before, after);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'changed');
  assert.equal(entries[0].type, 'limiter');
});

test('revert / reapply each entry kind and track status in the current chain', () => {
  const before = baseChain();
  const after = clone(before);
  after[1] = withParams(after[1], { ratio: 6 });
  after.splice(0, 1);
  after.splice(1, 0, createProcessorModule('clipper', { id: 'clip' }));
  const entries = diffChains(before, after);

  for (const e of entries) {
    assert.equal(diffEntryStatus(after, e), 'applied');
    const reverted = revertDiffEntry(after, e, before);
    assert.notEqual(reverted, after);
    assert.equal(diffEntryStatus(reverted, e), 'reverted', `${e.kind} reverted`);
    // Only that module moved; the others are untouched.
    const others = entries.filter((x) => x !== e);
    for (const o of others) assert.equal(diffEntryStatus(reverted, o), 'applied');
    const reapplied = reapplyDiffEntry(reverted, e, after);
    assert.equal(diffEntryStatus(reapplied, e), 'applied', `${e.kind} reapplied`);
    // Idempotent: reverting a reverted entry is a no-op.
    assert.equal(revertDiffEntry(reverted, e, before), reverted);
  }

  const removed = entries.find((e) => e.kind === 'removed')!;
  const back = revertDiffEntry(after, removed, before);
  assert.equal(back[0].id, 'eq', 'removed module goes back to its original slot');
});

test('undo all restores the pre-run chain and keeps later manual additions', () => {
  const before = baseChain();
  const after = clone(before);
  after[0] = withParams(after[0], { outputTrimDb: -0.5 });
  after[1].intensity = 80;
  after.splice(2, 1);
  after.push(createProcessorModule('maximizer', { id: 'max' }));
  const entries = diffChains(before, after);

  const all = revertAllDiffEntries(after, entries, before);
  assert.deepEqual(all.map((m) => m.id), before.map((m) => m.id));
  all.forEach((m, i) => assert.ok(modulesEquivalent(m, before[i])));
  for (const e of entries) assert.equal(diffEntryStatus(all, e), 'reverted');

  const manual = createProcessorModule('dither', { id: 'dither' });
  const edited = [...after, manual];
  const kept = revertAllDiffEntries(edited, entries, before);
  assert.ok(kept.some((m) => m.id === 'dither'));
});

test('reordering is reported as a move and reverts to the original slot', () => {
  const before = baseChain();
  const after = [before[1], before[0], before[2]].map(clone);
  const entries = diffChains(before, after);
  assert.ok(entries.length >= 1);
  assert.ok(entries.every((e) => e.kind === 'changed' && e.moved));
  const all = revertAllDiffEntries(after, entries, before);
  assert.deepEqual(all.map((m) => m.id), ['eq', 'comp', 'lim']);
});

test('external VST3 session state is not a change', () => {
  const vst = createProcessorModule('external-vst3', { id: 'v' });
  const a = clone(vst);
  (a.params as unknown as Record<string, unknown>).instanceId = 'abc';
  (a.params as unknown as Record<string, unknown>).status = 'loaded';
  assert.deepEqual(diffChains([vst], [a]), []);
});

test('formatting helpers', () => {
  assert.equal(humanizeKey('outputGainDb'), 'Output gain dB');
  assert.equal(humanizeKey('freqHz'), 'Freq Hz');
  assert.equal(formatDiffValue(-1.234, 'params.ceilingDb'), '-1.23 dB');
  assert.equal(formatDiffValue(12000, 'params.freqHz'), '12 kHz');
  assert.equal(formatDiffValue(3150, 'params.freqHz'), '3.15 kHz');
  assert.equal(formatDiffValue(true, 'bypassed'), 'bypassed');
  assert.equal(formatDiffValue(undefined), '—');
});
