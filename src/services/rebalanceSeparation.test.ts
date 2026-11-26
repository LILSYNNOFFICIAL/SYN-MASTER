import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMixtureConsistency } from '../dsp/stemSeparationMath.ts';
import type { SeparatedAudioStem, SharedStemSeparationRequest, SharedStemSeparationResult } from './stemSeparation.ts';
import { separateForRebalance } from './rebalanceSeparation.ts';

const SAMPLE_RATE = 44_100;

function makeSource(): [Float32Array, Float32Array] {
  const left = new Float32Array(4096);
  const right = new Float32Array(4096);
  for (let i = 0; i < left.length; i++) {
    left[i] = Math.sin(i * 0.03) * 0.2;
    right[i] = Math.cos(i * 0.02) * 0.15;
  }
  return [left, right];
}

function makeStems(source: [Float32Array, Float32Array]): SeparatedAudioStem[] {
  return (['drums', 'bass', 'other', 'vocals'] as const).map((id) => ({
    id,
    label: id,
    channels: [source[0].map((sample) => sample / 4), source[1].map((sample) => sample / 4)],
  }));
}

test('vocal rebalance separation requests shared stems and never mutates cached samples', async () => {
  const source = makeSource();
  const cachedStems = makeStems(source);
  const snapshots = cachedStems.map((stem) => [stem.channels[0].slice(), stem.channels[1].slice()]);
  const serviceStems = makeStems(source);
  const sharedConsistency = applyMixtureConsistency(source, serviceStems.map((stem) => stem.channels));
  let requestCount = 0;
  const requests: SharedStemSeparationRequest[] = [];
  const progress: Array<{ stage: string; overall: number }> = [];

  const result = await separateForRebalance(
    source[0],
    source[1],
    SAMPLE_RATE,
    new AbortController().signal,
    (update) => progress.push({ stage: update.stage, overall: update.overall }),
    { highQuality: true },
    async (request): Promise<SharedStemSeparationResult> => {
      requestCount += 1;
      requests.push(request);
      request.onProgress?.({ stage: 'separating', progress: 0.5 });
      return { stems: cachedStems, mixtureConsistency: sharedConsistency };
    },
  );

  assert.equal(requestCount, 1);
  const captured = requests[0] as SharedStemSeparationRequest;
  assert.equal(captured.sampleRate, SAMPLE_RATE);
  assert.equal(captured.resource.durationSec, source[0].length / SAMPLE_RATE);
  assert.equal(captured.resource.fileSizeBytes, source[0].byteLength + source[1].byteLength);
  assert.equal(captured.highQuality, true);
  assert.equal(progress.some((update) => update.stage === 'separating' && update.overall === 0.475), true);
  assert.equal(result.fingerprint.length > 0, true);
  assert.equal(result.stems.vocals[0].length, source[0].length);
  assert.deepEqual(cachedStems.map((stem) => stem.channels), snapshots, 'mixture consistency does not mutate shared cached stems');
});