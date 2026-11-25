import test from 'node:test';
import assert from 'node:assert/strict';
import { assessRebalanceResources } from './rebalanceStemCache';
import { overallSeparationProgress } from './rebalanceSeparation';

test('device assessment: ok on desktop, warns on mobile / low memory, blocks when far over budget', () => {
  const desktop = { deviceMemoryGb: 8, isMobile: false, hasOpfs: true, hasWorker: true };
  assert.equal(assessRebalanceResources(180, 48000, desktop).level, 'ok');
  const phone = { deviceMemoryGb: 4, isMobile: true, hasOpfs: true, hasWorker: true };
  const p = assessRebalanceResources(180, 48000, phone);
  assert.equal(p.level, 'warn');
  assert.match(p.message, /skip Vocal Rebalance/);
  // 10 minutes at 48 kHz on a 2 GB device: ~1760 MB peak vs 1024 MB budget -> blocked.
  assert.equal(assessRebalanceResources(600, 48000, { deviceMemoryGb: 2, isMobile: true, hasOpfs: true, hasWorker: true }).level, 'block');
  assert.equal(assessRebalanceResources(60, 48000, { ...desktop, hasOpfs: false }).level, 'block');
  assert.equal(assessRebalanceResources(60, 48000, { ...desktop, hasWorker: false }).level, 'block');
});

test('separation progress is monotonic across stages', () => {
  const seq = [
    overallSeparationProgress({ stage: 'loading-model', progress: 0 }),
    overallSeparationProgress({ stage: 'loading-model', progress: 1 }),
    overallSeparationProgress({ stage: 'initializing', progress: 0 }),
    overallSeparationProgress({ stage: 'separating', progress: 0.5 }),
    overallSeparationProgress({ stage: 'separating', progress: 1 }),
    overallSeparationProgress({ stage: 'resampling', progress: 1 }),
  ];
  for (let i = 1; i < seq.length; i++) assert.ok(seq[i] >= seq[i - 1]);
  assert.ok(seq[seq.length - 1] <= 1);
});
