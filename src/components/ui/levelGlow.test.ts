import { test } from 'node:test';
import assert from 'node:assert/strict';
import { levelFromDb, smoothLevel } from './levelGlow';

test('levelFromDb maps dBFS to 0..1 and clamps', () => {
  assert.equal(levelFromDb(-Infinity), 0);
  assert.equal(levelFromDb(Number.NaN), 0);
  assert.equal(levelFromDb(-90), 0);
  assert.equal(levelFromDb(-48), 0);
  assert.equal(levelFromDb(-6), 1);
  assert.equal(levelFromDb(3), 1);
  assert.ok(Math.abs(levelFromDb(-27) - 0.5) < 1e-9);
});

test('smoothLevel attacks fast and releases slowly, staying in range', () => {
  const up = smoothLevel(0, 1);
  const down = smoothLevel(1, 0);
  assert.ok(up > 0.5 && up <= 1);
  assert.ok(down < 1 && down > 0.8);
  let v = 0;
  for (let i = 0; i < 200; i++) v = smoothLevel(v, 0.4);
  assert.ok(Math.abs(v - 0.4) < 1e-6);
});
