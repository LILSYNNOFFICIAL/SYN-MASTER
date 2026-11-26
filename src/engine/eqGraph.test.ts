import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExtendedEqGraph } from './eqGraph';
import { channelGroups, computeAutoGainDb } from '../dsp/eqDesign';
import { computeChainFingerprint } from '../director/postFixVerification';
import { createProcessorModule } from '../dsp/chainValidation';
import type { ParametricEQParams } from '../types/mastering';

/** Minimal Web Audio stand-in that records nodes, IIR coefficients and connections. */
function mockCtx(sampleRate = 48000) {
  const iirs: Array<{ ff: number[]; fb: number[] }> = [];
  const edges: Array<[string, string]> = [];
  let n = 0;
  const node = (kind: string, extra: Record<string, unknown> = {}) => {
    const self = {
      kind,
      name: `${kind}#${n++}`,
      ...extra,
      connect(to: { name: string }) {
        edges.push([self.name, to.name]);
        return to;
      },
    };
    return self;
  };
  const ctx = {
    sampleRate,
    createIIRFilter(ff: number[], fb: number[]) {
      iirs.push({ ff, fb });
      return node('iir');
    },
    createGain() {
      return node('gain', { gain: { value: 1 } });
    },
    createChannelSplitter() {
      return node('split');
    },
    createChannelMerger() {
      return node('merge');
    },
  };
  return { ctx: ctx as unknown as BaseAudioContext, iirs, edges };
}

const PARAMS: ParametricEQParams = {
  phaseMode: 'minimum', msMode: 'stereo', tiltDb: 0, autoGain: true,
  bands: [
    { id: 'a', enabled: true, shape: 'highpass', subtype: 'flat', slope: 24, freq: 30, gain: 0, q: 0.71 },
    { id: 'b', enabled: true, shape: 'bell', subtype: 'proportional', freq: 2000, gain: 3, q: 1, channel: 'mid' },
    { id: 'c', enabled: true, shape: 'highpass', subtype: 'flat', freq: 120, gain: 0, q: 0.71, channel: 'side' },
    { id: 'd', enabled: true, shape: 'highshelf', subtype: 'baxandall', freq: 9000, gain: 2, q: 0.71, channel: 'left' },
  ],
};

test('realtime graph uses exactly the offline section designs, one IIR per section', () => {
  const { ctx, iirs, edges } = mockCtx();
  const input = { name: 'in', connect() { return undefined; } } as unknown as AudioNode;
  const output = { name: 'out' } as unknown as AudioNode;
  const nodes = buildExtendedEqGraph(ctx, PARAMS, 1, input, output);
  const g = channelGroups(PARAMS, 48000, 1);
  const expected = [...g.stereo, ...g.mid, ...g.side, ...g.left, ...g.right];
  assert.equal(iirs.length, expected.length);
  expected.forEach((c, i) => {
    assert.deepEqual(iirs[i].ff, [c.b0, c.b1, c.b2]);
    assert.deepEqual(iirs[i].fb, [1, c.a1, c.a2]);
  });
  // The auto-gain trim is the last node and feeds the output.
  const trim = nodes[nodes.length - 1] as unknown as { name: string; gain: { value: number } };
  assert.ok(Math.abs(trim.gain.value - Math.pow(10, computeAutoGainDb(PARAMS, 48000, 1) / 20)) < 1e-12);
  assert.deepEqual(edges[edges.length - 1], [trim.name, 'out']);
});

test('fingerprints: legacy chains unchanged, new EQ fields change the fingerprint', () => {
  const legacy = createProcessorModule('parametric-eq', { id: 'e' });
  const bands = (legacy.params as ParametricEQParams).bands.map((b) => ({ ...b, gain: b.shape === 'bell' ? 2 : b.gain }));
  const base = { ...legacy, params: { ...(legacy.params as ParametricEQParams), bands } };
  const fp = computeChainFingerprint([base]);
  // Values produced by the pre-overhaul fingerprint code (eb48f52).
  assert.equal(fp, 'active:1:a0b0e03e-6f971eda');
  const withSub = { ...base, params: { ...base.params, bands: bands.map((b) => (b.shape === 'bell' ? { ...b, subtype: 'proportional' as const } : b)) } };
  const withChan = { ...base, params: { ...base.params, bands: bands.map((b) => (b.shape === 'bell' ? { ...b, channel: 'side' as const } : b)) } };
  const withAuto = { ...base, params: { ...base.params, autoGain: true } };
  assert.notEqual(computeChainFingerprint([withSub]), fp);
  assert.notEqual(computeChainFingerprint([withChan]), fp);
  assert.notEqual(computeChainFingerprint([withAuto]), fp);
  const deq = createProcessorModule('dynamic-eq', { id: 'd' });
  const dfp = computeChainFingerprint([deq]);
  assert.equal(dfp, 'active:1:bbd7fff6-4fd69664');
  const typed = { ...deq, params: { bands: (deq.params as unknown as { bands: Array<Record<string, unknown>> }).bands.map((b) => ({ ...b, type: 'baxandall-bass' })) } } as typeof deq;
  assert.notEqual(computeChainFingerprint([typed]), dfp);
});
