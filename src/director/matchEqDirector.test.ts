import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAudioBuffer } from '../dsp/analyzer';
import { learnMatchEqSpectrum, isMatchEqLearned, computeMatchEqCurve } from '../dsp/matchEq';
import { createProcessorModule } from '../dsp/chainValidation';
import { buildExplainableMasterPlan, runAutonomousDirectorLoop } from './directorEngine';
import { MATCH_EQ_DIRECTOR_CEILING, directorMatchEqCommand, hydrateMatchEqChain } from './matchEqDirector';
import { validateChainAgainstInventory, VERIFIED_NATIVE_PROCESSOR_INVENTORY } from './processorInventory';
import {
  SYSTEM_PROMPT,
  buildRefineUserPrompt,
  buildStrategyUserPrompt,
  chainForPrompt,
  normalizeStrategyResponse,
} from '../ai/masteringPrompt';
import type { MatchEqParams, ProcessorModule } from '../types/mastering';

const SR = 44100;

function mix(seconds: number, bright: number, seed: number, gain = 0.08): Float32Array[] {
  const n = Math.floor(SR * seconds);
  let s = seed >>> 0;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const w = s / 2 ** 32 - 0.5;
    lp = lp * 0.95 + w * 0.05;
    const t = i / SR;
    const tone = 0.4 * Math.sin(2 * Math.PI * 110 * t) + 0.2 * Math.sin(2 * Math.PI * 440 * t);
    const x = gain * (tone + 2.5 * lp + bright * w);
    L[i] = x;
    R[i] = x * 0.96;
  }
  return [L, R];
}

const SRC = mix(2, 0.05, 1);
const REF = mix(2, 0.6, 2);
const srcAnalysis = analyzeAudioBuffer(SRC, SR);
const refAnalysis = analyzeAudioBuffer(REF, SR);
const profile = { source: learnMatchEqSpectrum(SRC, SR)!, reference: learnMatchEqSpectrum(REF, SR)!, referenceName: 'Bright Ref' };

test('local Director adds one conservative Match EQ only when a reference is learned', () => {
  const withRef = buildExplainableMasterPlan({ analysis: srcAnalysis, objectiveId: 'streaming', referenceAnalysis: refAnalysis, matchEqProfile: profile });
  const meqs = withRef.chain.filter((m) => m.type === 'match-eq');
  assert.equal(meqs.length, 1);
  const p = meqs[0].params as MatchEqParams;
  assert.ok(isMatchEqLearned(p));
  assert.ok(p.amount <= 50 && p.maxBoostDb <= 3 && p.maxCutDb <= 3 && p.smoothing <= 3, 'conservative settings');
  const peak = computeMatchEqCurve(p).correctionDb.reduce((m, c) => Math.max(m, Math.abs(c)), 0);
  assert.ok(peak <= 2.5 + 1e-9);
  // Early in the chain: nothing but restore precedes it.
  const at = withRef.chain.findIndex((m) => m.type === 'match-eq');
  assert.ok(withRef.chain.slice(0, at).every((m) => m.type === 'restore'));
  assert.ok(withRef.recommendations.some((r) => r.selectedProcessor === 'match-eq'));

  const noRef = buildExplainableMasterPlan({ analysis: srcAnalysis, objectiveId: 'streaming', matchEqProfile: profile });
  assert.equal(noRef.chain.filter((m) => m.type === 'match-eq').length, 0, 'no reference analysis -> no Match EQ');
  const noProfile = buildExplainableMasterPlan({ analysis: srcAnalysis, objectiveId: 'streaming', referenceAnalysis: refAnalysis });
  assert.equal(noProfile.chain.filter((m) => m.type === 'match-eq').length, 0, 'nothing learned -> no Match EQ');
  // Identical spectra = nothing to match.
  assert.equal(directorMatchEqCommand({ source: profile.source, reference: profile.source }), null);
});

test('hydration fills AI Match EQ from the profile, clamps it, and keeps user-learned modules', () => {
  const ai = createProcessorModule('match-eq', { params: { amount: 100, maxBoostDb: 12, maxCutDb: 12, smoothing: 24 } as MatchEqParams });
  const user = createProcessorModule('match-eq', { params: { amount: 100, maxBoostDb: 9, maxCutDb: 9, smoothing: 12, lowHz: 30, highHz: 18000, channel: 'stereo', phase: 'linear', source: profile.reference, reference: profile.source } });
  const out = hydrateMatchEqChain([ai, user], profile, { dropUnlearned: true, conservative: true });
  const a = out[0].params as MatchEqParams;
  assert.ok(isMatchEqLearned(a));
  assert.equal(a.amount, MATCH_EQ_DIRECTOR_CEILING.amount);
  assert.equal(a.maxBoostDb, MATCH_EQ_DIRECTOR_CEILING.maxBoostDb);
  assert.equal(a.smoothing, 6);
  assert.equal(a.referenceName, 'Bright Ref');
  assert.equal(out[1], user, 'user-learned Match EQ untouched');
  assert.deepEqual(hydrateMatchEqChain([ai], null, { dropUnlearned: true }), [], 'no reference: unlearned Match EQ dropped');
});

test('AI prompt documents match-eq, gates it on a reference and never ships spectra', () => {
  assert.match(SYSTEM_PROMPT, /"match-eq"/);
  assert.match(buildStrategyUserPrompt({ analysis: srcAnalysis, mode: 'reference', referenceAnalysis: refAnalysis }), /Match EQ: AVAILABLE/);
  assert.match(buildStrategyUserPrompt({ analysis: srcAnalysis, mode: 'ai-auto' }), /Match EQ: NOT AVAILABLE/);
  const learned = createProcessorModule('match-eq', { params: { ...(hydrateMatchEqChain([createProcessorModule('match-eq')], profile)[0].params as MatchEqParams) } });
  const json = JSON.stringify(chainForPrompt([learned]));
  assert.ok(json.length < 600, `prompt chain stays small (${json.length} chars)`);
  assert.match(json, /"learned":true/);
  const refine = buildRefineUserPrompt({ preAnalysis: srcAnalysis, postAnalysis: srcAnalysis, currentChain: [learned], targetLufs: -14, targetTruePeakDb: -1, preserveDynamics: true });
  assert.ok(!refine.includes(String(profile.source.stereo[100])), 'refine prompt does not include learned spectra');
  assert.ok(VERIFIED_NATIVE_PROCESSOR_INVENTORY['match-eq']);
  const strat = normalizeStrategyResponse(
    { processors: [{ type: 'match-eq', name: 'Match', intensity: 100, wetDry: 100, reason: 'tilt toward ref', paramsJson: JSON.stringify({ amount: 45, smoothing: 3, maxBoostDb: 2, maxCutDb: 2, lowHz: 40, highHz: 16000, channel: 'stereo', phase: 'linear' }) }] },
    { mode: 'reference' },
  );
  assert.equal(strat.chain[0].type, 'match-eq');
  assert.equal((strat.chain[0].params as MatchEqParams).amount, 45);
  assert.equal(validateChainAgainstInventory([{ type: 'match-eq', params: { amount: Infinity } }]).valid, false, 'non-finite rejected');
});

test('FIX ALL loop hydrates an AI Match EQ with a reference and drops it without one', async () => {
  const aiChain: ProcessorModule[] = [
    createProcessorModule('match-eq', { params: { amount: 90, maxBoostDb: 10, maxCutDb: 10, smoothing: 3, lowHz: 30, highHz: 18000, channel: 'stereo', phase: 'linear' } }),
    createProcessorModule('limiter'),
  ];
  const run = async (withRef: boolean) => {
    const chains: ProcessorModule[][] = [];
    await runAutonomousDirectorLoop({
      sourceChannels: SRC,
      sampleRate: SR,
      operatingMode: 'autonomous',
      objectiveId: 'streaming',
      initialChain: aiChain,
      referenceAnalysis: withRef ? refAnalysis : null,
      matchEqReference: withRef ? { spectra: profile.reference, name: 'Bright Ref' } : null,
      maxIterations: 1,
      renderPassFn: async (channels, sampleRate, chain) => {
        chains.push(chain);
        return { channels, analysis: analyzeAudioBuffer(channels, sampleRate) };
      },
    });
    return chains[0];
  };
  const hydrated = (await run(true)).find((m) => m.type === 'match-eq');
  assert.ok(hydrated, 'Match EQ kept with a reference');
  const hp = hydrated!.params as MatchEqParams;
  assert.ok(isMatchEqLearned(hp));
  assert.ok(hp.amount <= MATCH_EQ_DIRECTOR_CEILING.amount && hp.maxBoostDb <= MATCH_EQ_DIRECTOR_CEILING.maxBoostDb);
  assert.equal((await run(false)).some((m) => m.type === 'match-eq'), false, 'no reference -> dropped');
});
