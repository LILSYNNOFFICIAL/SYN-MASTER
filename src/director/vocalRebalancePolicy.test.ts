import test from 'node:test';
import assert from 'node:assert/strict';
import { createProcessorModule } from '../dsp/chainValidation';
import { fingerprintStereo, type RebalanceStemSet } from '../dsp/vocalRebalance';
import type { ProcessorModule, VocalRebalanceParams } from '../types/mastering';
import {
  allowedVocalWindow,
  gateVocalRebalanceChain,
  measureVocalBalance,
  planLocalVocalRebalance,
  summarizeVocalBalanceForPrompt,
  vocalBalanceRange,
  withLocalVocalRebalance,
  type VocalBalanceContext,
} from './vocalRebalancePolicy';
import { buildRefineUserPrompt, buildStrategyUserPrompt, parseAiChain, SYSTEM_PROMPT } from '../ai/masteringPrompt';
import { sanitizeVocalBalance } from '../server/aiPayloadValidation';
import { analyzeAudioBuffer } from '../dsp/analyzer';

const SR = 48000;

function stems(vocalLevel: number): { set: RebalanceStemSet; mix: [Float32Array, Float32Array] } {
  const n = SR * 2;
  const mk = () => [new Float32Array(n), new Float32Array(n)] as [Float32Array, Float32Array];
  const v = mk();
  const b = mk();
  const d = mk();
  const o = mk();
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const vs = vocalLevel * Math.sin(2 * Math.PI * 700 * t);
    v[0][i] = vs; v[1][i] = vs;
    const bs = 0.3 * Math.sin(2 * Math.PI * 50 * t);
    b[0][i] = bs; b[1][i] = bs;
    const ds = 0.05 * Math.sin(2 * Math.PI * 3000 * t);
    d[0][i] = ds; d[1][i] = ds;
    const os = 0.1 * Math.sin(2 * Math.PI * 1200 * t);
    o[0][i] = os; o[1][i] = os;
  }
  const mix = mk();
  for (let c = 0; c < 2; c++) for (let i = 0; i < n; i++) mix[c][i] = v[c][i] + b[c][i] + d[c][i] + o[c][i];
  return { mix, set: { fingerprint: fingerprintStereo(mix[0], mix[1], SR), sampleRate: SR, length: n, stems: { vocals: v, bass: b, drums: d } } };
}

const ctxWith = (vocalToMusicDb: number | null, stemsCached = true): VocalBalanceContext => ({
  stemsCached,
  measurement: vocalToMusicDb === null ? null : { vocalToMusicDb, vocalActiveRatio: 0.8, bassToMixDb: -4, drumsToMixDb: -12 },
  range: vocalBalanceRange('pop'),
});

const vr = (params: Partial<VocalRebalanceParams>, extra: Partial<ProcessorModule> = {}) =>
  createProcessorModule('vocal-rebalance', { params: params as VocalRebalanceParams, ...extra });

test('measures the vocal-to-music ratio above 150 Hz on vocal-active frames', () => {
  // Above 150 Hz the accompaniment is drums (0.05) + other (0.1) plus the 50 Hz bass left after a
  // 2nd-order 150 Hz high-pass (about -19 dB -> 0.034): vocal 0.1 vs that -> about -1.35 dB.
  const { set, mix } = stems(0.1);
  const m = measureVocalBalance(set, mix[0], mix[1]);
  assert.ok(m);
  const bassLeft = 0.3 * (50 / 150) ** 2 / Math.sqrt(1 + (50 / 150) ** 4);
  assert.ok(Math.abs(m.vocalToMusicDb - 20 * Math.log10(0.1 / Math.hypot(0.05, 0.1, bassLeft))) < 0.2, String(m.vocalToMusicDb));
  assert.ok(m.vocalActiveRatio > 0.9);
  const quiet = stems(0.02);
  const mq = measureVocalBalance(quiet.set, quiet.mix[0], quiet.mix[1]);
  assert.ok(mq && mq.vocalToMusicDb < m.vocalToMusicDb - 10);
  const none = stems(0);
  assert.equal(measureVocalBalance(none.set, none.mix[0], none.mix[1]), null, 'instrumental: no vocal measurement');
});

test('local Director only moves a clearly buried / loud vocal, by at most 3 dB, and only with stems cached', () => {
  assert.equal(planLocalVocalRebalance(ctxWith(-9, false)), null);
  assert.equal(planLocalVocalRebalance(ctxWith(null)), null);
  assert.equal(planLocalVocalRebalance(ctxWith(-5.5)), null, 'within the 1 dB margin of the pop range');
  assert.equal(planLocalVocalRebalance(ctxWith(0)), null, 'in range');
  assert.equal(planLocalVocalRebalance(ctxWith(-7))?.vocalGainDb, 2.5);
  assert.equal(planLocalVocalRebalance(ctxWith(-15))?.vocalGainDb, 3);
  assert.equal(planLocalVocalRebalance(ctxWith(6))?.vocalGainDb, -3);
  const p = planLocalVocalRebalance(ctxWith(-15))!;
  assert.equal(p.bassEnabled, false);
  assert.equal(p.drumsEnabled, false);
  const chain = withLocalVocalRebalance([createProcessorModule('limiter')], p);
  assert.deepEqual(chain.map((m) => m.type), ['vocal-rebalance', 'limiter']);
});

test('gate: removed without stems, clamped, direction-checked, never past the far edge, hoisted first', () => {
  const lim = createProcessorModule('limiter');
  const noStems = gateVocalRebalanceChain([lim, vr({ vocalGainDb: 3 })], ctxWith(-9, false));
  assert.deepEqual(noStems.chain.map((m) => m.type), ['limiter']);
  assert.match(noStems.notes[0], /no cached stems/);

  // Buried (-9 vs pop -5..+2): a cut is the wrong direction -> removed.
  const wrongWay = gateVocalRebalanceChain([vr({ vocalGainDb: -3 }), lim], ctxWith(-9));
  assert.deepEqual(wrongWay.chain.map((m) => m.type), ['limiter']);

  // Buried: +6 requested -> AI cap +3 dB; placed first.
  const boost = gateVocalRebalanceChain([lim, vr({ vocalGainDb: 6 })], ctxWith(-9));
  assert.deepEqual(boost.chain.map((m) => m.type), ['vocal-rebalance', 'limiter']);
  assert.equal((boost.chain[0].params as VocalRebalanceParams).vocalGainDb, 3);

  // Slightly buried (-5.5): may not overshoot past +2 -> window [0, 3] (high - v = 7.5, capped 3).
  assert.deepEqual(allowedVocalWindow(ctxWith(-5.5)), [0, 3]);
  // Too loud (+4): window [max(-4, -9), 0] = [-4, 0].
  assert.deepEqual(allowedVocalWindow(ctxWith(4)), [-4, 0]);
  // Near the top edge (+1.5, in range): trim limited to [-1.5, 0.5].
  assert.deepEqual(allowedVocalWindow(ctxWith(1.5)), [-1.5, 0.5]);
  // No vocal detected: vocal stays at 0.
  assert.deepEqual(allowedVocalWindow(ctxWith(null)), [0, 0]);

  // Intensity is folded in, bass/drums clamped to +/-3 dB, module normalised.
  const mixed = gateVocalRebalanceChain(
    [vr({ vocalGainDb: 4, bassEnabled: true, bassGainDb: -10, drumsEnabled: true, drumsGainDb: 0 }, { intensity: 50, wetDry: 40, outputGainDb: 3 })],
    ctxWith(-9),
  );
  const m = mixed.chain[0];
  const p = m.params as VocalRebalanceParams;
  assert.equal(p.vocalGainDb, 2);
  assert.equal(p.bassGainDb, -3);
  assert.equal(p.bassEnabled, true);
  assert.equal(p.drumsEnabled, false);
  assert.equal(m.intensity, 100);
  assert.equal(m.wetDry, 100);
  assert.equal(m.outputGainDb, 0);

  // Chains without the module are untouched (same array).
  const plain = [lim];
  assert.equal(gateVocalRebalanceChain(plain, ctxWith(-9)).chain, plain);
});

test('AI prompt: schema documents the processor; the balance block appears only when supplied', () => {
  assert.match(SYSTEM_PROMPT, /"vocal-rebalance": \{"vocalGainDb":-12\.\.6/);
  const { mix } = stems(0.1);
  const analysis = analyzeAudioBuffer([mix[0].slice(0, SR), mix[1].slice(0, SR)], SR);
  const without = buildStrategyUserPrompt({ analysis, mode: 'ai-auto', objective: 'pop' });
  assert.doesNotMatch(without, /VOCAL REBALANCE/);
  const withBlock = buildStrategyUserPrompt({ analysis, mode: 'ai-auto', objective: 'pop', vocalBalance: ctxWith(-9) });
  assert.match(withBlock, /VOCAL REBALANCE \(stems cached for this track\)/);
  assert.match(withBlock, /-9 dB .* BURIED/);
  const refine = buildRefineUserPrompt({
    preAnalysis: analysis, postAnalysis: analysis, currentChain: [], targetLufs: -14, targetTruePeakDb: -1, preserveDynamics: true, vocalBalance: ctxWith(4),
  });
  assert.match(refine, /TOO LOUD/);
  assert.match(summarizeVocalBalanceForPrompt(ctxWith(-9, false)), /NOT cached/);
  assert.match(summarizeVocalBalanceForPrompt(ctxWith(null)), /no lead vocal/);
});

test('AI output with vocal-rebalance validates through the shared inventory and is hoisted', () => {
  const { chain } = parseAiChain([
    { type: 'limiter', name: 'Lim', intensity: 100, wetDry: 100, reason: 'ceiling', paramsJson: '{"ceilingDb":-1}' },
    { type: 'vocal-rebalance', name: 'Vox', intensity: 100, wetDry: 100, reason: 'vocal buried at -9 dB', paramsJson: '{"vocalGainDb":2.5,"sensitivity":30}' },
  ]);
  assert.deepEqual(chain.map((m) => m.type), ['vocal-rebalance', 'limiter']);
  assert.equal((chain[0].params as VocalRebalanceParams).vocalGainDb, 2.5);
  assert.throws(() => parseAiChain([
    { type: 'vocal-rebalance', name: 'Vox', intensity: 100, wetDry: 100, reason: 'x', paramsJson: '{"vocalGainDb":1e999}' },
  ]));
});

test('server sanitises the vocal balance context', () => {
  assert.equal(sanitizeVocalBalance(undefined), undefined);
  assert.deepEqual(sanitizeVocalBalance('junk'), { stemsCached: false, measurement: null, range: { low: -7, high: 2 } });
  assert.deepEqual(
    sanitizeVocalBalance({ stemsCached: true, measurement: { vocalToMusicDb: -9.123, vocalActiveRatio: 0.7, bassToMixDb: -4, drumsToMixDb: -11 }, range: { low: -5, high: 2 }, extra: 'x' }),
    { stemsCached: true, measurement: { vocalToMusicDb: -9.12, vocalActiveRatio: 0.7, bassToMixDb: -4, drumsToMixDb: -11 }, range: { low: -5, high: 2 } },
  );
  assert.equal(sanitizeVocalBalance({ stemsCached: true, measurement: { vocalToMusicDb: Number.NaN }, range: { low: -5, high: 2 } })?.measurement, null);
  assert.equal(sanitizeVocalBalance({ stemsCached: true, range: { low: 5, high: 2 } })?.stemsCached, false);
});
