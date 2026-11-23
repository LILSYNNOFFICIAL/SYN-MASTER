/**
 * Objective click / pop detector.
 *
 * Uses the second difference (a discrete "acceleration") of each channel, which is
 * near zero for band-limited music and spikes on discontinuities: clicks, pops,
 * crackle, hard edit points and transient spikes typical of AI-generated audio
 * (Suno, Udio, etc.). A sample is flagged when its second difference exceeds both
 * an absolute floor and a multiple of the local (slowly tracked) second-difference
 * level, so loud drums do not count as clicks but an isolated spike does.
 */

export interface ClickDetection {
  /** Number of separate click events (a 2 ms refractory window groups samples). */
  clickCount: number;
  /** Click events per minute of audio. */
  clicksPerMinute: number;
  /** Times (seconds) of the first clicks found, capped at 64 entries. */
  clickTimesSec: number[];
  /** Largest second-difference ratio found (strength of the worst click). */
  worstRatio: number;
  /** A click/discontinuity in the first ~3 ms (incl. a file that starts on a non-zero sample). */
  startClick: boolean;
  /** A click/discontinuity in the last ~3 ms (incl. a file that is cut off mid-waveform). */
  endClick: boolean;
  /** Size of the jump from silence into the first sample / out of the last sample (max over channels). */
  startStep: number;
  endStep: number;
}

/** Minimum |d2| for a click at the file edges; edges sit next to silence, so this is lower. */
export const EDGE_CLICK_FLOOR = 0.01;

/**
 * Edge click test for the first (or, with reverse=true, last) `edgeLen` samples of a channel.
 * The audio before the file start and after its end is treated as digital silence, so a file
 * that starts (or stops) on a large non-zero sample counts as a click: that is what a player
 * produces. Returns the index (from the edge) of the last flagged sample, or -1.
 */
export function findEdgeClick(ch: Float32Array, sampleRate: number, reverse: boolean, ratio = 14): { index: number; step: number } {
  const n = ch.length;
  const edgeLen = Math.min(n, Math.max(8, Math.round(sampleRate * 0.003)));
  const bgLen = Math.min(n, edgeLen + Math.round(sampleRate * 0.01));
  const at = (k: number) => (k < 0 ? 0 : reverse ? ch[n - 1 - k] : ch[k]);
  // Background roughness right after the edge window (3-13 ms in), median-robust mean.
  const bg: number[] = [];
  for (let k = edgeLen; k < bgLen; k++) bg.push(Math.abs(at(k) - 2 * at(k - 1) + at(k - 2)));
  bg.sort((a, b) => a - b);
  const local = (bg.length ? bg[Math.floor(bg.length / 2)] : 0) + 1e-6;
  let index = -1;
  for (let k = 0; k < edgeLen; k++) {
    const d = Math.abs(at(k) - 2 * at(k - 1) + at(k - 2));
    if (d > EDGE_CLICK_FLOOR && d > ratio * local) index = k;
  }
  return { index, step: Math.abs(at(0)) };
}

export interface ClickDetectOptions {
  /** Ratio over the local second-difference level that counts as a click. Default 14. */
  sensitivityRatio?: number;
  /** Absolute floor for |d2| (full scale = 1). Default 0.04. */
  absoluteFloor?: number;
}

export function detectClicks(
  channels: Float32Array[],
  sampleRate: number,
  options: ClickDetectOptions = {},
): ClickDetection {
  const ratio = options.sensitivityRatio ?? 14;
  const floor = options.absoluteFloor ?? 0.04;
  const length = channels[0]?.length ?? 0;
  if (length < 8 || sampleRate <= 0) {
    return { clickCount: 0, clicksPerMinute: 0, clickTimesSec: [], worstRatio: 0, startClick: false, endClick: false, startStep: 0, endStep: 0 };
  }
  const refractory = Math.max(1, Math.round(sampleRate * 0.002));
  // ~5 ms smoothing for the local second-difference level.
  const alpha = 1 - Math.exp(-1 / Math.max(1, sampleRate * 0.005));
  const flagged = new Uint8Array(Math.ceil(length / refractory) + 1);
  let worstRatio = 0;
  // Look-ahead window used to tell an isolated spike from a transient onset.
  const after = Math.max(8, Math.round(sampleRate * 0.003));

  const edgeLen = Math.min(length, Math.max(8, Math.round(sampleRate * 0.003)));
  let startClick = false;
  let endClick = false;
  let startStep = 0;
  let endStep = 0;
  for (const ch of channels) {
    // Edges: the first and last ~3 ms are judged against silence outside the file and
    // the roughness just inside it (AI renders often click at 0:00 or end mid-waveform).
    const s0 = findEdgeClick(ch, sampleRate, false, ratio);
    const e0 = findEdgeClick(ch, sampleRate, true, ratio);
    startStep = Math.max(startStep, s0.step);
    endStep = Math.max(endStep, e0.step);
    if (s0.index >= 0) { startClick = true; flagged[Math.floor(s0.index / refractory)] = 1; }
    if (e0.index >= 0) { endClick = true; flagged[Math.floor((length - 1 - e0.index) / refractory)] = 1; }
    let env = 0;
    // Prime the envelope from the audio just AFTER the edge window (3-13 ms), so a click
    // at the very start cannot inflate it and hide itself.
    const primeEnd = Math.min(length, edgeLen + Math.round(sampleRate * 0.01));
    for (let i = edgeLen; i < primeEnd; i++) env += Math.abs(ch[i] - 2 * ch[i - 1] + ch[i - 2]);
    env = primeEnd - edgeLen > 0 ? env / (primeEnd - edgeLen) : 0;
    for (let i = Math.max(2, edgeLen); i < length - edgeLen; i++) {
      const d2 = Math.abs(ch[i] - 2 * ch[i - 1] + ch[i - 2]);
      const local = env + 1e-6;
      if (d2 > floor && d2 > ratio * local && isIsolatedSpike(ch, i, local, ratio, after)) {
        flagged[Math.floor(i / refractory)] = 1;
        const r = d2 / local;
        if (r > worstRatio) worstRatio = r;
        // Do not let the spike itself pull the envelope up.
        continue;
      }
      env += alpha * (d2 - env);
    }
  }

  const clickTimesSec: number[] = [];
  let clickCount = 0;
  let prevFlag = false;
  for (let b = 0; b < flagged.length; b++) {
    if (flagged[b] && !prevFlag) {
      clickCount++;
      if (clickTimesSec.length < 64) clickTimesSec.push(Number(((b * refractory) / sampleRate).toFixed(3)));
    }
    prevFlag = flagged[b] === 1;
  }
  const minutes = length / sampleRate / 60;
  return {
    clickCount,
    clicksPerMinute: minutes > 0 ? Number((clickCount / minutes).toFixed(2)) : 0,
    clickTimesSec,
    worstRatio: Number(worstRatio.toFixed(1)),
    startClick,
    endClick,
    startStep: Number(startStep.toFixed(5)),
    endStep: Number(endStep.toFixed(5)),
  };
}

/**
 * A click is a short spike after which the signal's roughness drops back near the
 * level it had before. A drum or hi-hat onset keeps the second difference high for
 * several milliseconds, so it is not counted.
 */
function isIsolatedSpike(
  ch: Float32Array,
  index: number,
  localBefore: number,
  ratio: number,
  after: number,
): boolean {
  const start = index + 4;
  const end = Math.min(ch.length, start + after);
  if (end - start < 4) return true;
  let sum = 0;
  for (let j = start; j < end; j++) sum += Math.abs(ch[j] - 2 * ch[j - 1] + ch[j - 2]);
  const meanAfter = sum / (end - start);
  return meanAfter < localBefore * 2;
}
