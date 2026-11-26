import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getOrCreateVocalBalancePreparation,
  recommendVocalRebalanceGain,
  requiresVocalBalancePreparation,
  renderVocalBalanceMix,
  vocalBalanceCorrectionTriggered,
  vocalRebalanceVerified,
  type VocalBalancePreparation,
  type VocalBalanceMeasurement,
} from './vocalBalance';

function balance(balanceDb: number): VocalBalanceMeasurement {
  return {
    vocalLufs: -24,
    nonVocalLufs: -24 - balanceDb,
    balanceDb,
  };
}

test('stem preparation is requested only for the Vocal-Focused objective', () => {
  assert.equal(requiresVocalBalancePreparation('vocal-focused'), true);
  assert.equal(requiresVocalBalancePreparation('streaming'), false);
  assert.equal(requiresVocalBalancePreparation('custom'), false);
});

test('completed and in-progress vocal preparation is reused instead of launching duplicate jobs', async () => {
  const cache = new Map<string, Promise<VocalBalancePreparation>>();
  const prepared: VocalBalancePreparation = {
    channels: null,
    verification: {
      status: 'not-needed',
      sourceBalanceDb: -2,
      referenceBalanceDb: -1,
      postRenderBalanceDb: -2,
      appliedGainDb: 0,
      summary: 'The trigger was not crossed.',
    },
  };
  let createCount = 0;
  const create = async () => {
    createCount += 1;
    await Promise.resolve();
    return prepared;
  };

  const first = getOrCreateVocalBalancePreparation(cache, 'track-a:ref-a', create);
  const concurrent = getOrCreateVocalBalancePreparation(cache, 'track-a:ref-a', create);
  assert.equal(first, concurrent);
  assert.equal(await first, prepared);
  assert.equal(getOrCreateVocalBalancePreparation(cache, 'track-a:ref-a', create), first);
  assert.equal(createCount, 1);
});

test('vocal rebalance only triggers below -3 dB and caps the requested boost at +3 dB', () => {
  assert.equal(vocalBalanceCorrectionTriggered(balance(-3)), false);
  assert.equal(vocalBalanceCorrectionTriggered(balance(-3.01)), true);
  assert.equal(recommendVocalRebalanceGain(balance(-3), balance(0)), 0);
  assert.equal(recommendVocalRebalanceGain(balance(-2), balance(0)), 0);
  assert.equal(recommendVocalRebalanceGain(balance(-4), balance(-1)), 3);
  assert.equal(recommendVocalRebalanceGain(balance(-7), balance(-5)), 2);
  assert.equal(recommendVocalRebalanceGain(balance(-4), balance(-8)), 0);
});

test('verification requires measurable movement toward the reference and a <= 3 dB residual', () => {
  assert.equal(vocalRebalanceVerified(balance(-7), balance(-4), balance(-2)), true);
  assert.equal(vocalRebalanceVerified(balance(-7), balance(-4), balance(1)), false);
  assert.equal(vocalRebalanceVerified(balance(-7), balance(-8), balance(-2)), false);
});

test('rendering boosts the vocal stem coherently in stereo without changing accompaniment', () => {
  const vocal: [Float32Array, Float32Array] = [
    new Float32Array([0.1, -0.1]),
    new Float32Array([0.2, -0.2]),
  ];
  const accompaniment: [Float32Array, Float32Array] = [
    new Float32Array([0.3, 0.3]),
    new Float32Array([-0.3, -0.3]),
  ];
  const rendered = renderVocalBalanceMix(vocal, accompaniment, 3);
  const gain = 10 ** (3 / 20);
  assert.ok(Math.abs(rendered[0][0] - (0.3 + 0.1 * gain)) < 1e-6);
  assert.ok(Math.abs(rendered[0][1] - (0.3 - 0.1 * gain)) < 1e-6);
  assert.ok(Math.abs(rendered[1][0] - (-0.3 + 0.2 * gain)) < 1e-6);
  assert.ok(Math.abs(rendered[1][1] - (-0.3 - 0.2 * gain)) < 1e-6);
  assert.ok(Array.from(accompaniment[0]).every((sample) => Math.abs(sample - 0.3) < 1e-7));
  assert.ok(Array.from(accompaniment[1]).every((sample) => Math.abs(sample + 0.3) < 1e-7));
});
