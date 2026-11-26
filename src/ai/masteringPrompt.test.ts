import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRefineUserPrompt, buildStrategyUserPrompt, formatModeLine, MODE_MEANINGS, PROCESSOR_JSON_SCHEMA, SYSTEM_PROMPT } from './masteringPrompt.ts';
import type { AudioAnalysis, MasteringMode } from '../types/mastering.ts';
import { VERIFIED_NATIVE_PROCESSOR_INVENTORY } from '../director/processorInventory.ts';

// Minimal analysis stub: summarizeAnalysisForPrompt only reads numeric fields; missing ones print as undefined.
const analysis = new Proxy({}, { get: (_t, k) => (k === 'zoneEnergyDb' ? {} : k === 'spectrumBinsFreq' || k === 'spectrumBinsDb' ? [] : 0) }) as unknown as AudioAnalysis;

test('strategy prompt always carries the selected Mode as its own line, alongside the Objective', () => {
  const p = buildStrategyUserPrompt({ analysis, mode: 'analog', objective: 'streaming' });
  assert.match(p, /Mastering Objective: STREAMING/);
  assert.ok(p.includes(`Mode: analog — ${MODE_MEANINGS.analog}`), 'mode line present even when an Objective is set');
});

test('Objective still falls back to Mode when no Objective is given; Mode line is still added', () => {
  const p = buildStrategyUserPrompt({ analysis, mode: 'dynamic' });
  assert.match(p, /Mastering Objective: DYNAMIC/);
  assert.ok(p.includes(formatModeLine('dynamic')));
});

test('every MasteringMode has a meaning', () => {
  const modes: MasteringMode[] = ['ai-auto', 'manual', 'hybrid', 'transparent', 'loudness', 'analog', 'dynamic', 'reference', 'streaming', 'custom'];
  for (const m of modes) assert.ok(MODE_MEANINGS[m] && MODE_MEANINGS[m].length > 8, m);
});

test('strategy and refinement prompts expose every supported processor and require track-specific retuning', () => {
  const schemaDescription = PROCESSOR_JSON_SCHEMA.properties.type.description;
  const refinePrompt = buildRefineUserPrompt({
    preAnalysis: analysis,
    postAnalysis: analysis,
    currentChain: [],
    targetLufs: -14,
    targetTruePeakDb: -1,
    preserveDynamics: true,
  });
  for (const type of Object.keys(VERIFIED_NATIVE_PROCESSOR_INVENTORY)) {
    assert.ok(schemaDescription.includes(type), `schema lists ${type}`);
    assert.ok(SYSTEM_PROMPT.includes(`"${type}"`), `system prompt lists ${type}`);
  }
  assert.match(SYSTEM_PROMPT, /never repeat unchanged settings when the same measured failure persists/i);
  assert.match(refinePrompt, /retune it when its target remains unmet/i);
  assert.match(refinePrompt, /select only those that fit this track's evidence/i);
});

test('refinement receives the reference and the latest unresolved findings', () => {
  const prompt = buildRefineUserPrompt({
    preAnalysis: analysis,
    postAnalysis: analysis,
    currentChain: [],
    referenceAnalysis: analysis,
    remainingFindings: [{
      findingId: 'diag-resonance',
      title: 'Unresolved upper-mid resonance',
      status: 'ACTIVE',
      detail: 'The 6.2 kHz resonance remains 5 dB above its limit after render.',
      recommendedAction: 'Retune the Dynamic EQ threshold or range and remeasure.',
      measurementReliable: true,
    }],
    targetLufs: -14,
    targetTruePeakDb: -1,
    preserveDynamics: true,
  });
  assert.match(prompt, /REFERENCE TRACK MEASUREMENTS/);
  assert.match(prompt, /Match EQ: AVAILABLE/);
  assert.match(prompt, /diag-resonance \[ACTIVE; reliable\]/);
  assert.match(prompt, /Retune the Dynamic EQ threshold or range and remeasure/);
});

test('AI is told when Vocal-Focused correction was already verified or was not applied', () => {
  const verified = buildStrategyUserPrompt({
    analysis,
    mode: 'ai-auto',
    objective: 'vocal-focused',
    vocalBalanceVerification: {
      status: 'verified',
      sourceBalanceDb: -5,
      referenceBalanceDb: 0,
      postRenderBalanceDb: -2,
      appliedGainDb: 3,
      summary: 'The rendered vocal balance moved toward the reference.',
    },
  });
  assert.match(verified, /VOCAL-FOCUSED PRE-CHAIN VERIFICATION/);
  assert.match(verified, /Status: verified/);
  assert.match(verified, /do not duplicate the correction/);

  const unverified = buildRefineUserPrompt({
    preAnalysis: analysis,
    postAnalysis: analysis,
    currentChain: [],
    vocalBalanceVerification: {
      status: 'unverified',
      sourceBalanceDb: -5,
      referenceBalanceDb: null,
      postRenderBalanceDb: null,
      appliedGainDb: 0,
      summary: 'Reference stems were unavailable.',
    },
    targetLufs: -14,
    targetTruePeakDb: -1,
    preserveDynamics: true,
  });
  assert.match(unverified, /This preparation was not verified/);
  assert.match(unverified, /do not claim it fixed vocal balance/);
});
