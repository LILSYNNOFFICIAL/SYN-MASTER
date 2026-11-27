import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clampPercent,
  fixAllPercent,
  fixAllStageLabel,
  importStagePercent,
  nextMonotonicPercent,
  stagePercent,
} from './progressMath';

test('ProgressRing: clampPercent keeps values finite and inside 0..100', () => {
  assert.equal(clampPercent(-5), 0);
  assert.equal(clampPercent(150), 100);
  assert.equal(clampPercent(42.5), 42.5);
  assert.equal(clampPercent(Number.NaN), 0);
  assert.equal(clampPercent(Number.POSITIVE_INFINITY), 0);
  assert.equal(clampPercent(undefined), 0);
  assert.equal(clampPercent(null), 0);
});

test('ProgressRing: monotonic progress never moves backwards until reset', () => {
  let v = 0;
  for (const incoming of [10, 30, 25, 5, 60, 59, 200, 40]) {
    const next = nextMonotonicPercent(v, incoming);
    assert.ok(next >= v, `went backwards ${v} -> ${next}`);
    v = next;
  }
  assert.equal(v, 100);
  assert.equal(nextMonotonicPercent(80, 3, true), 3, 'reset starts again');
  assert.equal(nextMonotonicPercent(80, -10, true), 0, 'reset value is clamped');
});

test('ProgressRing: stage windows map fractions inside their range', () => {
  assert.equal(stagePercent(30, 90, 0), 30);
  assert.equal(stagePercent(30, 90, 1), 90);
  assert.equal(stagePercent(30, 90, 0.5), 60);
  assert.equal(stagePercent(30, 90, 7), 90);
  assert.equal(stagePercent(30, 90, Number.NaN), 30);
  assert.equal(importStagePercent('reading', 0), 0);
  assert.equal(importStagePercent('finishing', 1), 100);
  assert.ok(importStagePercent('decoding', 1) <= importStagePercent('analyzing', 0));
  assert.ok(importStagePercent('analyzing', 1) <= importStagePercent('waveform', 0));
});

test('FIX ALL progress: monotonic over a realistic Director event sequence, eases below 95, 100 only on completion', () => {
  const events: Array<[string, number]> = [
    ['Analyzing', 0], ['Preparing vocal stems', 0], ['Planning', 0], ['AI is thinking…', 0],
  ];
  for (let pass = 1; pass <= 10; pass++) {
    events.push(['Processing', pass], ['Measuring', pass], ['Optimizing', pass], ['AI is thinking…', pass]);
  }
  let prev = 0;
  for (const [stage, pass] of events) {
    const raw = fixAllPercent(stage, pass);
    assert.ok(raw <= 95, `${stage}/${pass} exceeded 95: ${raw}`);
    const shown = nextMonotonicPercent(prev, raw);
    assert.ok(shown >= prev);
    prev = shown;
  }
  assert.ok(prev > 90 && prev <= 95, `after 10 passes ~95, got ${prev}`);
  assert.ok(fixAllPercent('AI is thinking…', 0) >= 10 && fixAllPercent('AI is thinking…', 0) <= 25);
  assert.ok(fixAllPercent('Analyzing', 0) <= 10);
  assert.equal(fixAllPercent('Completed', 3, true), 100);
  assert.equal(fixAllStageLabel('Processing', 2), 'Rendering pass 2');
  assert.equal(fixAllStageLabel('Measuring', 2), 'Verifying pass 2');
  assert.equal(fixAllStageLabel('AI is thinking…', 1), 'AI is thinking…');
});
