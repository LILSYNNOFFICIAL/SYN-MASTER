import test from 'node:test';
import assert from 'node:assert/strict';
import { resampleStereoChannels } from './stemSeparation.ts';

test('resampling at the current session rate preserves the original stereo buffers', async () => {
  const channels: [Float32Array, Float32Array] = [
    new Float32Array([0.1, -0.2, 0.3]),
    new Float32Array([-0.1, 0.2, -0.3]),
  ];
  const result = await resampleStereoChannels(channels, 44_100, 44_100);
  assert.equal(result[0], channels[0]);
  assert.equal(result[1], channels[1]);
});

test('stereo resampling rejects empty or mismatched channel buffers', async () => {
  await assert.rejects(
    resampleStereoChannels([new Float32Array(0), new Float32Array(0)], 44_100, 48_000),
    RangeError,
  );
  await assert.rejects(
    resampleStereoChannels([new Float32Array(4), new Float32Array(3)], 44_100, 48_000),
    RangeError,
  );
});

test('stereo resampling rejects unsupported source and target sample rates', async () => {
  const channels: [Float32Array, Float32Array] = [new Float32Array([0]), new Float32Array([0])];
  await assert.rejects(resampleStereoChannels(channels, 7_999, 48_000), RangeError);
  await assert.rejects(resampleStereoChannels(channels, 44_100, 384_001), RangeError);
});
