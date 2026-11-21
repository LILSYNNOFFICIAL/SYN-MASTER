import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accumulateDemucsChunk,
  accumulateDemucsWeights,
  createDemucsChunkWindow,
  getDemucsChunkCount,
  normalizeDemucsOutput,
  normalizeDemucsRange,
  shiftDemucsAccumulator,
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

test('disk-streamed overlap-add matches full-buffer overlap-add across multiple chunks', () => {
  const segment = 8;
  const overlap = 2;
  const stride = segment - overlap;
  const total = 19;
  const source = Float32Array.from({ length: total }, (_, i) => Math.sin(i * 0.31) * 0.7 + i * 0.002);
  const starts = Array.from({ length: Math.ceil(Math.max(0, total - segment) / stride) + 1 }, (_, i) => i * stride);
  const expected = new Float32Array(total);
  const expectedWeights = new Float32Array(total);
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i];
    const valid = Math.min(segment, total - start);
    const chunk = new Float32Array(segment);
    chunk.set(source.subarray(start, start + valid));
    const window = createDemucsChunkWindow(segment, overlap, i > 0, i < starts.length - 1);
    accumulateDemucsChunk(expected, chunk, start, valid, window);
    accumulateDemucsWeights(expectedWeights, start, valid, window);
  }
  normalizeDemucsOutput(expected, expectedWeights);

  const streamed = new Float32Array(total);
  const ring = new Float32Array(segment);
  const ringWeights = new Float32Array(segment);
  let flushed = 0;
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i];
    const valid = Math.min(segment, total - start);
    const chunk = new Float32Array(segment);
    chunk.set(source.subarray(start, start + valid));
    const window = createDemucsChunkWindow(segment, overlap, i > 0, i < starts.length - 1);
    accumulateDemucsChunk(ring, chunk, 0, valid, window);
    accumulateDemucsWeights(ringWeights, 0, valid, window);
    const safeCount = i === starts.length - 1 ? total - flushed : Math.min(stride, total - flushed);
    streamed.set(normalizeDemucsRange(ring, ringWeights, safeCount), flushed);
    flushed += safeCount;
    if (safeCount < segment) shiftDemucsAccumulator([ring], ringWeights, safeCount);
  }
  assert.equal(flushed, total);
  for (let i = 0; i < total; i += 1) assert.ok(Math.abs(streamed[i] - expected[i]) < 1e-6, `sample ${i} differs`);
});

test('streaming accumulator rejects invalid finalized ranges', () => {
  assert.throws(() => normalizeDemucsRange(new Float32Array(4), new Float32Array(4), 5), RangeError);
  assert.throws(() => shiftDemucsAccumulator([new Float32Array(3)], new Float32Array(4), 1), RangeError);
});

test('chunk accumulation rejects out-of-range buffers', () => {
  assert.throws(() => accumulateDemucsChunk(
    new Float32Array(4), new Float32Array(4), 2, 4, new Float32Array(4),
  ), RangeError);
  assert.throws(() => accumulateDemucsWeights(
    new Float32Array(4), 2, 4, new Float32Array(4),
  ), RangeError);
});
