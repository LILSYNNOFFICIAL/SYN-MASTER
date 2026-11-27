import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAudioBuffer } from '../dsp/analyzer';
import { createProcessorModule } from '../dsp/chainValidation';
import { parseAiChain } from '../ai/masteringPrompt';
import { clearAiChainProvenance, recordAiChainProvenance } from '../ai/aiProvenance';
import type { AiPassTrace, DirectorCheckpoint, MasterFinalReport, ProcessorModule } from '../types/mastering';
import { deriveGateRepairCommands, resolveObjectiveTarget, runAutonomousDirectorLoop } from './directorEngine';
import { evaluateMasterTargets } from './masterTargets';
import { buildDiagnosticLog, diagnosticLogToText } from './diagnosticLog';
import { OVERRIDE_REASONS } from './directorOverrides';

const SR = 44100;

function quietMix(seconds = 1.2, gain = 0.05): Float32Array[] {
  const n = Math.floor(SR * seconds);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = 0.65 + 0.35 * Math.sin(2 * Math.PI * 2 * t);
    const body = 0.48 * Math.sin(2 * Math.PI * 65 * t) + 0.32 * Math.sin(2 * Math.PI * 220 * t) + 0.24 * Math.sin(2 * Math.PI * 880 * t) + 0.16 * Math.sin(2 * Math.PI * 2800 * t);
    const side = 0.08 * Math.sin(2 * Math.PI * 950 * t + 0.4);
    L[i] = gain * env * (body + side);
    R[i] = gain * env * (body - side);
  }
  return [L, R];
}

function subDominantMix(seconds = 1.2): Float32Array[] {
  const n = Math.floor(SR * seconds);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const v = 0.46 * Math.sin(2 * Math.PI * 40 * t) + 0.045 * Math.sin(2 * Math.PI * 110 * t) + 0.07 * Math.sin(2 * Math.PI * 1000 * t);
    left[i] = v;
    right[i] = v;
  }
  return [left, right];
}

function aiTrace(over: Partial<AiPassTrace> = {}): AiPassTrace {
  return {
    pass: 0, stage: 'strategy', source: 'byo-provider', fallbackReason: null, modelName: 'mock', responseTimeMs: 1, promptChars: 1,
    timeoutHit: null, aiReturnedModules: [], finalRenderedModules: [], ...over,
  };
}

function aiChain(processors: Array<{ type: string; name: string; params: unknown; wetDry?: number }>): ProcessorModule[] {
  const { chain, paramCorrections } = parseAiChain(processors.map((p) => ({
    type: p.type, name: p.name, intensity: 100, wetDry: p.wetDry ?? 100, reason: 'mock AI', paramsJson: JSON.stringify(p.params),
  })));
  recordAiChainProvenance(chain, paramCorrections); // what masteringClient does when the AI answers
  return chain;
}

test('E4 (a): with no failing gate the AI values reach the render unchanged and no override is logged; every AI tool is listed with its final settings', async () => {
  clearAiChainProvenance();
  const chain = aiChain([
    { type: 'parametric-eq', name: 'AI EQ', params: { phaseMode: 'minimum', msMode: 'stereo', tiltDb: 0, bands: [{ id: 'b1', enabled: true, shape: 'bell', freq: 2800, gain: -1.5, q: 1.4 }] } },
    { type: 'compressor', name: 'AI Glue', params: { mode: 'downward', thresholdDb: -22, ratio: 1.8, attackMs: 30, releaseMs: 180, kneeDb: 6, makeupDb: 1, scHpfHz: 90 } },
    { type: 'limiter', name: 'AI Limiter', params: { ceilingDb: -1, thresholdDb: -6, releaseMs: 80, lookaheadMs: 5, truePeak: true, oversampling: 4 } },
  ]);
  const aiParams = new Map(chain.map((m) => [m.id, structuredClone(m.params)] as const));
  const report = await runAutonomousDirectorLoop({
    sourceChannels: quietMix(), sampleRate: SR, operatingMode: 'autonomous', objectiveId: 'streaming',
    initialChain: chain, initialAiTrace: aiTrace({ aiReturnedModules: chain.map((m) => m.type) }), maxIterations: 1, maxCpuBudgetMs: 60_000,
  });
  const pass1 = report.checkpoints.find((c) => c.passNumber === 1)!;
  for (const [id, params] of aiParams) {
    const rendered = pass1.chain.find((m) => m.id === id);
    assert.ok(rendered, `AI module ${id} rendered`);
    assert.deepEqual(rendered.params, params, `AI values for ${rendered.type} survive to the render`);
  }
  const strategy = report.aiPasses?.[0];
  assert.ok(strategy);
  assert.equal(strategy.directorOverrides, undefined, 'nothing overridden, nothing logged');
  assert.deepEqual(strategy.aiChosenTools?.map((t) => t.name), ['AI EQ', 'AI Glue', 'AI Limiter']);
  const log = buildDiagnosticLog({ trackName: 't', objective: report.objective, source: report.preAnalysis, findings: [], chain: [], report });
  assert.match(log.aiPasses[0].aiChosenTools![1].settings ?? '', /thresholdDb=-22/);
  assert.equal(log.aiPasses[0].aiChosenTools![1].module, undefined, 'export carries the settings line, not the raw module');
  const text = diagnosticLogToText(log);
  assert.match(text, /== Director overrides ==\n  none/);
  assert.match(text, /AI-chosen tools as rendered:\n      - AI EQ \(parametric-eq\)/);

  // Gate-repair with no failed check proposes nothing, so a refined AI chain is never touched.
  const gate = evaluateMasterTargets(pass1.analysis, report.objective, { preAnalysis: report.preAnalysis });
  const noFail = { ...gate, passed: true, failed: [] };
  assert.deepEqual(deriveGateRepairCommands(noFail, pass1.chain, pass1.analysis).commands, []);
});

async function runSubExcessScenario(record: boolean): Promise<MasterFinalReport> {
  clearAiChainProvenance();
  return runAutonomousDirectorLoop({
    sourceChannels: subDominantMix(), sampleRate: SR, operatingMode: 'autonomous', objectiveId: 'streaming',
    initialChain: [createProcessorModule('parametric-eq')], maxIterations: 2, maxCpuBudgetMs: 60_000,
    aiRefineCallback: async (ctx) => {
      const { chain, paramCorrections } = parseAiChain([
        ...ctx.currentChain.map((m) => ({ type: m.type, name: m.name, intensity: m.intensity, wetDry: m.wetDry, reason: 'keep', paramsJson: JSON.stringify(m.params) })),
        { type: 'bass-enhancer', name: 'AI Sub Lift', intensity: 100, wetDry: 100, reason: 'mock AI wants more sub', paramsJson: JSON.stringify({ subFreqHz: 50, subGainDb: 4, harmonicDrive: 20, tightness: 50, monoFocus: true }) },
      ]);
      if (record) recordAiChainProvenance(chain, paramCorrections);
      return { chain, producedBy: 'mock AI', trace: { source: 'byo-provider', modelName: 'mock' } };
    },
  });
}

test('E4 (b)+(c): a failing gate still overrides the AI (logged with reason); logging never changes a gate verdict', async () => {
  const logged = await runSubExcessScenario(true);
  const refine = logged.aiPasses?.find((a) => a.stage === 'refine');
  assert.ok(refine, 'refine trace recorded');
  const sub = refine.directorOverrides?.find((o) => o.moduleType === 'bass-enhancer' && o.parameter === 'params.subGainDb');
  assert.ok(sub, `gate repair override logged: ${JSON.stringify(refine.directorOverrides)}`);
  assert.equal(sub.stage, 'objective-gate-repair');
  assert.equal(sub.aiValue, '4');
  assert.equal(sub.finalValue, '0');
  assert.match(sub.reason, /Objective gate failed on the Pass 1 render/);
  assert.match(sub.reason, /Sub\/Bass/);
  const pass2 = logged.checkpoints.find((c) => c.passNumber === 2);
  assert.equal((pass2?.chain.find((m) => m.type === 'bass-enhancer')?.params as { subGainDb: number }).subGainDb, 0, 'the override still happens');
  const text = diagnosticLogToText(buildDiagnosticLog({ trackName: 't', objective: logged.objective, source: logged.preAnalysis, findings: [], chain: [], report: logged }));
  assert.match(text, /== Director overrides ==\n  #1 \[objective-gate-repair\] AI Sub Lift \(bass-enhancer\) params\.subGainDb: AI 4 → final 0 \(override\)/);

  // (c) the same run without any provenance logging reaches identical verdicts.
  const plain = await runSubExcessScenario(false);
  const verdicts = (r: MasterFinalReport) => r.checkpoints.map((c: DirectorCheckpoint) => [c.passNumber, c.targetGate?.passed ?? null, c.iterationSummary?.outcome ?? null]);
  assert.deepEqual(verdicts(logged), verdicts(plain));
  assert.equal(logged.targetGate?.passed, plain.targetGate?.passed);
  assert.equal(logged.bestPassNumber, plain.bestPassNumber);
  assert.equal(logged.status, plain.status);
  for (const cp of logged.checkpoints) {
    if (cp.iterationSummary?.outcome === 'regressed') assert.ok(cp.iterationSummary.rejectionReasons?.length, `pass ${cp.passNumber} records why it was rejected`);
  }
});

test('E4: Match EQ guard and the Vocal Rebalance policy gate are logged as overrides of AI values', async () => {
  clearAiChainProvenance();
  const chain = aiChain([
    { type: 'vocal-rebalance', name: 'AI Vox', params: { vocalGainDb: 3, bassGainDb: 0, drumsGainDb: 0, sensitivity: 50, smoothingMs: 40 } },
    { type: 'match-eq', name: 'AI Match', params: { amount: 80 } },
    { type: 'limiter', name: 'AI Limiter', params: { ceilingDb: -1, thresholdDb: -4, releaseMs: 80, lookaheadMs: 5, truePeak: true, oversampling: 4 } },
  ]);
  // The app's Vocal Rebalance gate (App.tsx) lowers the move before the Director gets the chain.
  const gated = chain.map((m) => m.type === 'vocal-rebalance' ? { ...m, params: { ...(m.params as object), vocalGainDb: 1 } as ProcessorModule['params'] } : m);
  const report = await runAutonomousDirectorLoop({
    sourceChannels: quietMix(), sampleRate: SR, operatingMode: 'autonomous', objectiveId: 'streaming',
    initialChain: gated, initialAiTrace: aiTrace(), maxIterations: 1, maxCpuBudgetMs: 60_000,
  });
  const overrides = report.aiPasses?.[0].directorOverrides ?? [];
  const vox = overrides.find((o) => o.stage === 'before-director' && o.parameter === 'params.vocalGainDb');
  assert.ok(vox, JSON.stringify(overrides));
  assert.equal(vox.aiValue, '3');
  assert.equal(vox.finalValue, '1');
  assert.match(vox.reason, /Vocal Rebalance policy gate/);
  const match = overrides.find((o) => o.stage === 'match-eq-guard' && o.moduleType === 'match-eq');
  assert.ok(match, 'unlearned Match EQ removal is logged');
  assert.equal(match.action, 'drop');
  assert.equal(match.reason, OVERRIDE_REASONS.matchEqDropped);
});

test('B2: export records each rejected pass reason and says clearly when the result rolled back to pass 0', () => {
  const sr = 48000;
  const ch = new Float32Array(sr).map((_, i) => 0.1 * Math.sin((2 * Math.PI * 440 * i) / sr));
  const analysis = analyzeAudioBuffer([ch, ch], sr);
  const objective = resolveObjectiveTarget('streaming');
  const gate = evaluateMasterTargets(analysis, objective, { preAnalysis: analysis });
  const cp = (passNumber: number, outcome: 'regressed' | 'baseline', rejectionReasons?: string[], detectedIssue = 'Within target tolerances') => ({
    passNumber, analysis, targetGate: { ...gate, passed: passNumber === 2 },
    iterationSummary: { activeProcessor: 'x', detectedIssue, measuredValue: '', targetValue: '', outcome, ...(rejectionReasons ? { rejectionReasons } : {}) },
  });
  const report = {
    checkpoints: [
      cp(1, 'regressed', ['Regression guard rejected: level-matched noise-floor regression'], 'level-matched noise-floor regression'),
      cp(2, 'regressed', ['Regression guard rejected: transient detail regression'], 'transient detail regression'),
    ],
    bestPassNumber: 0,
    iterationsExecuted: 2,
    finalChain: [],
    postFixVerification: { analysisFresh: false, postAnalysis: null, verificationError: 'Post-fix analysis is not tied to a completed render; a ready render status is required.', activeFindings: [], resolvedFindings: [] },
  } as unknown as MasterFinalReport;
  const log = buildDiagnosticLog({ trackName: 't', objective, source: analysis, findings: [], chain: [], report });
  assert.equal(log.rolledBackToSource, true);
  assert.equal(log.master, null, 'verdict/gate logic unchanged: no fresh render, no master');
  assert.equal(log.gate, null);
  assert.equal(log.passes[1].rejectionReason, 'Regression guard rejected: transient detail regression');
  assert.equal(log.passes[1].gatePassed, true, 'gate PASS is still shown next to the rejection');
  assert.match(log.verdict, /^NOT FULLY VERIFIED: No processed pass was retained: all 2 rendered pass\(es\) were rejected/);
  assert.match(log.verdict, /pass 1: Regression guard rejected: level-matched noise-floor regression/);
  assert.match(log.verdict, /rolled back to Pass 0, so the delivered audio is the original, unprocessed source/);
  assert.doesNotMatch(log.verdict, /not tied to a completed render/);
  const text = diagnosticLogToText(log);
  assert.match(text, /#2: .*gate PASS \(regressed\)\n      not retained: Regression guard rejected: transient detail regression/);
  assert.match(text, /Result: rolled back to Pass 0 \(original source\)/);

  // Older reports without recorded reasons still say something useful.
  const legacy = { ...report, checkpoints: [cp(1, 'regressed', undefined, 'transient detail regression')] } as unknown as MasterFinalReport;
  const legacyLog = buildDiagnosticLog({ trackName: 't', objective, source: analysis, findings: [], chain: [], report: legacy });
  assert.match(legacyLog.passes[0].rejectionReason ?? '', /not recorded by this version; Director finding for this pass: transient detail regression/);
});
