import test from 'node:test';
import assert from 'node:assert/strict';
import type { DirectorCheckpoint } from '../types/mastering';
import { selectBestSafeFallbackCheckpoint } from './safeCandidateFallback';

function checkpoint(
  passNumber: number,
  fit: number,
  qcFailures: number,
  objectiveFailures: number,
  clickCount = 0,
  objectiveOffset = 0,
): DirectorCheckpoint {
  return {
    id: `cp-${passNumber}`,
    passNumber,
    label: `Pass ${passNumber}`,
    timestamp: passNumber,
    chain: [],
    analysis: { clickCount } as unknown as DirectorCheckpoint['analysis'],
    qcReport: { failCount: qcFailures } as unknown as DirectorCheckpoint['qcReport'],
    multiObjective: { engineeringFitIndex: fit } as unknown as DirectorCheckpoint['multiObjective'],
    targetGate: {
      passed: objectiveFailures === 0,
      checks: [],
      failed: Array.from(
        { length: objectiveFailures },
        (_, index) => ({ id: `objective-${index + objectiveOffset}` }),
      ),
      summary: '',
    } as unknown as NonNullable<DirectorCheckpoint['targetGate']>,
  } as unknown as DirectorCheckpoint;
}

test('safe fallback selects objective progress when primary retention rejects every candidate', () => {
  const baseline = checkpoint(0, 80, 3, 5);
  const objectiveImprovement = checkpoint(1, 78.8, 3, 3);
  const qcImprovement = checkpoint(2, 79.5, 2, 4);
  const hardRegression = checkpoint(3, 80, 0, 0);
  const outsideFitTolerance = checkpoint(4, 78.4, 3, 2);
  const qcRegression = checkpoint(5, 81, 4, 1);
  const newObjectiveFailureDespiteQcGain = checkpoint(6, 81, 1, 6, 0, 0);

  const selected = selectBestSafeFallbackCheckpoint(baseline, [
    { checkpoint: qcRegression, hardRegressionReasons: [] },
    { checkpoint: newObjectiveFailureDespiteQcGain, hardRegressionReasons: [] },
    { checkpoint: hardRegression, hardRegressionReasons: ['new transient loss'] },
    { checkpoint: qcImprovement, hardRegressionReasons: [] },
    { checkpoint: outsideFitTolerance, hardRegressionReasons: [] },
    { checkpoint: objectiveImprovement, hardRegressionReasons: [] },
  ]);

  assert.equal(selected, objectiveImprovement);
  assert.equal(selected?.targetGate?.passed, false);
});

test('safe fallback keeps the source baseline when no candidate meets all safeguards', () => {
  const baseline = checkpoint(0, 80, 3, 5);
  const hardRegression = checkpoint(1, 83, 0, 0);
  const noProgress = checkpoint(2, 79.5, 3, 5);
  const outsideTolerance = checkpoint(3, 78, 0, 0);

  const selected = selectBestSafeFallbackCheckpoint(baseline, [
    { checkpoint: hardRegression, hardRegressionReasons: ['new clipping'] },
    { checkpoint: noProgress, hardRegressionReasons: [] },
    { checkpoint: outsideTolerance, hardRegressionReasons: [] },
  ]);

  assert.equal(selected, null);
});
