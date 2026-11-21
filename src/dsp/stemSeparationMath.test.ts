import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accumulateDemucsChunk,
  accumulateDemucsWeights,
  createDemucsChunkWindow,
  getDemucsChunkCount,
  normalizeDemucsOutput,
} from './stemSeparationMath.ts';

test('Demucs chunk count covers short, exact, and multi-segment audio', () => {
  assert.equal(getDemucsChunkCount(1), 1);
  assert.equal(getDemucsChunkCount(343_980), 1);
  assert.equal(getDemucsChunkCount(343_981), 2);
  assert.equal(getDemucsChunkCount(343_980 + 257_985), 2);
  assert.equal(getDemucsChunkCount(343_980 + 257_986), 3);
});

test('chunk count rejects empty and unsafe sample lengths', () => {
  assert.throws(() => getDemucsChunkCount(0), RangeError);
  assert.throws(() => getDemucsChunkCount(Number.MAX_SAFE_INTEGER + 1), RangeError);
});

test('outer edges remain fully weighted while internal overlap crossfades linearly', () => {
  const first = createDemucsChunkWindow(8, 2, false, true);
  const second = createDemucsChunkWindow(8, 2, true, false);
  assert.deepEqual(Array.from(first), [1, 1, 1, 1, 1, 1, 1, 0.5]);
  assert.deepEqual(Array.from(second), [0, 0.5, 1, 1, 1, 1, 1, 1]);
  for (let i = 0; i < 2; i += 1) {
    assert.ok(Math.abs(first[6 + i] + second[i] - 1) < 1e-6);
  }
});

test('overlap-add normalization reconstructs a constant signal without boundary dips', () => {
  const segment = 8;
  const overlap = 2;
  const stride = segment - overlap;
  const total = 14;
  const output = new Float32Array(total);
  const weights = new Float32Array(total);
  const source = new Float32Array(total).fill(0.375);
  const chunks = [0, stride];
  chunks.forEach((start, index) => {
    const window = createDemucsChunkWindow(segment, overlap, index > 0, index < chunks.length - 1);
    const chunk = new Float32Array(segment);
    chunk.set(source.subarray(start, Math.min(total, start + segment)));
    const valid = Math.min(segment, total - start);
    accumulateDemucsChunk(output, chunk, start, valid, window);
    accumulateDemucsWeights(weights, start, valid, window);
  });
  normalizeDemucsOutput(output, weights);
  for (const sample of output) assert.ok(Math.abs(sample - 0.375) < 1e-6);
});

test('chunk accumulation rejects out-of-range buffers', () => {
  assert.throws(() => accumulateDemucsChunk(
    new Float32Array(4), new Float32Array(4), 2, 4, new Float32Array(4),
  ), RangeError);
  assert.throws(() => accumulateDemucsWeights(
    new Float32Array(4), 2, 4, new Float32Array(4),
  ), RangeError);
});
