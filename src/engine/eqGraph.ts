import type { ParametricEQParams } from '../types/mastering';
import type { BiquadCoeffs } from '../dsp/biquad';
import { channelGroups, computeAutoGainDb } from '../dsp/eqDesign';

/**
 * Realtime Web Audio graph for the extended parametric EQ. Every biquad section from
 * `channelGroups` (the same designs the offline renderer and the drawn curve use) becomes an
 * IIRFilterNode, so the low-latency preview has the exact magnitude response of the render.
 * Order matches the offline renderer: stereo bands -> mid/side bands -> left/right bands -> auto-gain.
 * Band solo is not applied here; mastered playback uses the offline (audition) render.
 * Returns every node it created so the engine can disconnect them.
 */
export function buildExtendedEqGraph(
  ctx: BaseAudioContext,
  params: ParametricEQParams,
  intensity: number,
  input: AudioNode,
  output: AudioNode,
): AudioNode[] {
  const nodes: AudioNode[] = [];
  const sr = ctx.sampleRate;
  const groups = channelGroups(params, sr, intensity);
  const iir = (c: BiquadCoeffs) => {
    const n = ctx.createIIRFilter([c.b0, c.b1, c.b2], [1, c.a1, c.a2]);
    nodes.push(n);
    return n;
  };
  const chain = (from: AudioNode, sections: BiquadCoeffs[]): AudioNode => {
    let cur = from;
    for (const s of sections) {
      const n = iir(s);
      cur.connect(n);
      cur = n;
    }
    return cur;
  };
  const gain = (v: number) => {
    const g = ctx.createGain();
    g.gain.value = v;
    nodes.push(g);
    return g;
  };

  let cursor: AudioNode = chain(input, groups.stereo);

  if (groups.mid.length || groups.side.length) {
    const split = ctx.createChannelSplitter(2);
    const merge = ctx.createChannelMerger(2);
    nodes.push(split, merge);
    const lHalf = gain(0.5);
    const rHalf = gain(0.5);
    const rNegHalf = gain(-0.5);
    const mid = gain(1);
    const side = gain(1);
    cursor.connect(split);
    split.connect(lHalf, 0);
    split.connect(rHalf, 1);
    split.connect(rNegHalf, 1);
    lHalf.connect(mid);
    rHalf.connect(mid);
    lHalf.connect(side);
    rNegHalf.connect(side);
    const midOut = chain(mid, groups.mid);
    const sideOut = chain(side, groups.side);
    const sideNeg = gain(-1);
    midOut.connect(merge, 0, 0);
    midOut.connect(merge, 0, 1);
    sideOut.connect(merge, 0, 0);
    sideOut.connect(sideNeg);
    sideNeg.connect(merge, 0, 1);
    cursor = merge;
  }

  if (groups.left.length || groups.right.length) {
    const split = ctx.createChannelSplitter(2);
    const merge = ctx.createChannelMerger(2);
    nodes.push(split, merge);
    cursor.connect(split);
    const l = gain(1);
    const r = gain(1);
    split.connect(l, 0);
    split.connect(r, 1);
    chain(l, groups.left).connect(merge, 0, 0);
    chain(r, groups.right).connect(merge, 0, 1);
    cursor = merge;
  }

  const trim = gain(params.autoGain ? Math.pow(10, computeAutoGainDb(params, sr, intensity) / 20) : 1);
  cursor.connect(trim);
  trim.connect(output);
  return nodes;
}
