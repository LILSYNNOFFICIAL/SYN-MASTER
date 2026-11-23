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
    return { clickCount: 0, clicksPerMinute: 0, clickTimesSec: [], worstRatio: 0 };
  }
  const refractory = Math.max(1, Math.round(sampleRate * 0.002));
  // ~5 ms smoothing for the local second-difference level.
  const alpha = 1 - Math.exp(-1 / Math.max(1, sampleRate * 0.005));
  const flagged = new Uint8Array(Math.ceil(length / refractory) + 1);
  let worstRatio = 0;
  // Look-ahead window used to tell an isolated spike from a transient onset.
  const after = Math.max(8, Math.round(sampleRate * 0.003));

  for (const ch of channels) {
    let env = 0;
    // Prime the envelope with the first few ms so the first samples are not false hits.
    const prime = Math.min(length, Math.round(sampleRate * 0.01));
    for (let i = 2; i < prime; i++) env += Math.abs(ch[i] - 2 * ch[i - 1] + ch[i - 2]);
    env = prime > 2 ? env / (prime - 2) : 0;
    for (let i = 2; i < length; i++) {
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
