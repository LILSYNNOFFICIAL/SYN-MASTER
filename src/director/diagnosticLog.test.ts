import test from 'node:test';
import assert from 'node:assert/strict';
import type { MasterFinalReport, VerifiedFindingState } from '../types/mastering';
import { diagnosticStatusForFinding } from './diagnosticLog';

function state(status: VerifiedFindingState['status'], measurementReliable = true): VerifiedFindingState {
  return {
    findingId: 'diag-mud',
    originalFinding: { id: 'diag-mud' } as VerifiedFindingState['originalFinding'],
    postFinding: null,
    status,
    updatedSeverity: 'low',
    beforeMeasurements: [],
    afterMeasurements: [],
    verificationSummary: 'test',
    appliedCorrections: [],
    measurementReliable,
  };
}

function report(activeFindings: VerifiedFindingState[], resolvedFindings: VerifiedFindingState[] = []): MasterFinalReport {
  return { postFixVerification: { activeFindings, resolvedFindings, analysisFresh: true, postAnalysis: {} } } as unknown as MasterFinalReport;
}

test('diagnostic status never turns missing verification evidence green', () => {
  assert.equal(diagnosticStatusForFinding(null, 'diag-mud'), 'open');
  assert.equal(diagnosticStatusForFinding(report([], []), 'diag-mud'), 'unverified');
});

test('diagnostic status reflects measured partial and unresolved outcomes', () => {
  assert.equal(diagnosticStatusForFinding(report([state('IMPROVED')]), 'diag-mud'), 'improved');
  assert.equal(diagnosticStatusForFinding(report([state('PARTIALLY_RESOLVED')]), 'diag-mud'), 'partially-resolved');
  assert.equal(diagnosticStatusForFinding(report([state('UNRESOLVED')]), 'diag-mud'), 'not-fixed');
  assert.equal(diagnosticStatusForFinding(report([state('UNVERIFIED', false)]), 'diag-mud'), 'unverified');
});

test('only a reliable RESOLVED finding receives fixed status', () => {
  assert.equal(diagnosticStatusForFinding(report([], [state('RESOLVED', true)]), 'diag-mud'), 'fixed');
  assert.equal(diagnosticStatusForFinding(report([], [state('RESOLVED', false)]), 'diag-mud'), 'unverified');
});
