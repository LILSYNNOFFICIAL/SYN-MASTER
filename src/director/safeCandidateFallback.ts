import type { DirectorCheckpoint } from '../types/mastering';

export interface SafeFallbackCandidate {
  checkpoint: DirectorCheckpoint;
  hardRegressionReasons: readonly string[];
}

/**
 * Select a conservative fallback when the primary retention score rejects every pass.
 * Candidates must have no hard-regression reasons, stay within 1.5 fit points of the
 * source baseline, never increase QC failures, and reduce objective failures or QC
 * failures without introducing a new objective-gate failure.
 *
 * The selected checkpoint retains its own targetGate. It is not a pass unless the
 * measured gate on its rendered audio actually passed.
 */
export function selectBestSafeFallbackCheckpoint(
  baseline: DirectorCheckpoint,
  candidates: readonly SafeFallbackCandidate[],
): DirectorCheckpoint | null {
  const baselineFit = baseline.multiObjective.engineeringFitIndex;
  const baselineQcFailures = baseline.qcReport.failCount;
  const baselineFailedIds = baseline.targetGate?.failed.map((check) => check.id);

  if (
    !Number.isFinite(baselineFit) ||
    !Number.isFinite(baselineQcFailures) ||
    baselineFailedIds === undefined
  ) {
    return null;
  }

  const eligible = candidates.filter(({ checkpoint, hardRegressionReasons }) => {
    const fit = checkpoint.multiObjective.engineeringFitIndex;
    const qcFailures = checkpoint.qcReport.failCount;
    const candidateFailedIds = checkpoint.targetGate?.failed.map((check) => check.id);

    if (
      checkpoint.passNumber <= 0 ||
      hardRegressionReasons.length > 0 ||
      !Number.isFinite(fit) ||
      !Number.isFinite(qcFailures) ||
      candidateFailedIds === undefined
    ) {
      return false;
    }

    const objectiveDoesNotRegress = candidateFailedIds.every((id) => baselineFailedIds.includes(id));
    const objectiveProgress =
      objectiveDoesNotRegress && candidateFailedIds.length < baselineFailedIds.length;
    const qcProgress =
      objectiveDoesNotRegress &&
      candidateFailedIds.length <= baselineFailedIds.length &&
      qcFailures < baselineQcFailures;
    return (
      fit >= baselineFit - 1.5 &&
      qcFailures <= baselineQcFailures &&
      (objectiveProgress || qcProgress)
    );
  });

  eligible.sort((a, b) => {
    const aGateFailures = a.checkpoint.targetGate!.failed.length;
    const bGateFailures = b.checkpoint.targetGate!.failed.length;
    if (aGateFailures !== bGateFailures) return aGateFailures - bGateFailures;

    const aQcFailures = a.checkpoint.qcReport.failCount;
    const bQcFailures = b.checkpoint.qcReport.failCount;
    if (aQcFailures !== bQcFailures) return aQcFailures - bQcFailures;

    const fitDelta =
      b.checkpoint.multiObjective.engineeringFitIndex -
      a.checkpoint.multiObjective.engineeringFitIndex;
    if (Math.abs(fitDelta) > 1e-9) return fitDelta;

    const aClicks = a.checkpoint.analysis.clickCount ?? 0;
    const bClicks = b.checkpoint.analysis.clickCount ?? 0;
    if (aClicks !== bClicks) return aClicks - bClicks;

    return a.checkpoint.passNumber - b.checkpoint.passNumber;
  });

  return eligible[0]?.checkpoint ?? null;
}
