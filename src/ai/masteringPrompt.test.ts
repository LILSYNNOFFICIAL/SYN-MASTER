import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStrategyUserPrompt, formatModeLine, MODE_MEANINGS } from './masteringPrompt.ts';
import type { AudioAnalysis, MasteringMode } from '../types/mastering.ts';

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
