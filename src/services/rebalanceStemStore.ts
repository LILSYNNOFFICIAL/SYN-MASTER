/**
 * Vocal Rebalance stem cache (per track): state + subscription (static, tiny).
 *
 * - The app tells the store which source is active (setActiveSource). Stems are keyed by the
 *   source fingerprint, so a re-import of the same audio finds them again.
 * - Stems live in the in-memory render registry (src/dsp/vocalRebalance.ts) and, best effort,
 *   in OPFS (`syn-master-rebalance-v1/`, latest two tracks) so a reload does not re-separate.
 * - Separation is explicit (the user presses "Separate stems" in the Vocal Rebalance panel):
 *   it is slow and memory hungry, so the store first assesses the device and warns or blocks
 *   on mobile / low-memory devices instead of starting a job that would evict the tab.
 * - Renders never wait for stems: without them the rebalance is a measured no-op.
 */
import {
  REBALANCE_STEM_IDS,
  computeStemEnvelopeDb,
  fingerprintStereo,
  getRebalanceStems,
  registerRebalanceStems,
  stereoRmsDb,
  type RebalanceStemId,
  type RebalanceStemSet,
} from '../dsp/vocalRebalance.ts';
import type { RebalanceSeparationProgress } from './rebalanceSeparation.ts';
import type { RebalanceResourceAssessment } from './rebalanceStemCache.ts';

export type { RebalanceResourceAssessment } from './rebalanceStemCache.ts';

const loadCache = () => import('./rebalanceStemCache.ts');

// ---------------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------------

export type RebalanceStemStatus = 'no-track' | 'checking' | 'missing' | 'separating' | 'ready' | 'error';

export interface RebalanceStemState {
  status: RebalanceStemStatus;
  fingerprint: string | null;
  durationSec: number;
  sampleRate: number;
  progress: RebalanceSeparationProgress | null;
  error: string | null;
  /** Whole-track RMS per stem (dBFS) and 50 ms envelopes for the level meters. */
  stemRmsDb: Record<RebalanceStemId, number> | null;
  envelopes: Record<RebalanceStemId, Float32Array> | null;
  assessment: RebalanceResourceAssessment | null;
  /** Bumps whenever stems become (un)available, so renders can re-run. */
  version: number;
}

const INITIAL: RebalanceStemState = {
  status: 'no-track',
  fingerprint: null,
  durationSec: 0,
  sampleRate: 0,
  progress: null,
  error: null,
  stemRmsDb: null,
  envelopes: null,
  assessment: null,
  version: 0,
};

let state: RebalanceStemState = INITIAL;
let activeSource: { left: Float32Array; right: Float32Array; sampleRate: number } | null = null;
let abortController: AbortController | null = null;
const listeners = new Set<() => void>();

function setState(patch: Partial<RebalanceStemState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function subscribeRebalanceStems(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getRebalanceStemState(): RebalanceStemState {
  return state;
}

function meterData(set: RebalanceStemSet) {
  const envelopes = {} as Record<RebalanceStemId, Float32Array>;
  const rms = {} as Record<RebalanceStemId, number>;
  for (const id of REBALANCE_STEM_IDS) {
    envelopes[id] = computeStemEnvelopeDb(set.stems[id], set.sampleRate);
    rms[id] = stereoRmsDb(set.stems[id]);
  }
  return { envelopes, stemRmsDb: rms };
}

function markReady(set: RebalanceStemSet): void {
  registerRebalanceStems(set);
  setState({ status: 'ready', progress: null, error: null, ...meterData(set), version: state.version + 1 });
}

/** The active track's stems, when cached in memory. */
export function getActiveRebalanceStems(): RebalanceStemSet | null {
  return state.fingerprint ? getRebalanceStems(state.fingerprint) : null;
}

/** Point the cache at the active source (null clears). Loads cached stems from memory or OPFS. */
export function setActiveRebalanceSource(channels: Float32Array[] | null, sampleRate: number): void {
  if (!channels || !channels[0] || channels[0].length === 0) {
    abortController?.abort();
    activeSource = null;
    setState({ ...INITIAL, version: state.version + 1 });
    return;
  }
  const left = channels[0];
  const right = channels[1] ?? channels[0];
  const fingerprint = fingerprintStereo(left, right, sampleRate);
  if (state.fingerprint === fingerprint && activeSource) return;
  if (state.status === 'separating') abortController?.abort();
  activeSource = { left, right, sampleRate };
  const durationSec = left.length / sampleRate;
  const inMemory = getRebalanceStems(fingerprint);
  setState({ ...INITIAL, fingerprint, durationSec, sampleRate, status: inMemory ? 'ready' : 'checking', version: state.version + 1 });
  if (inMemory) setState(meterData(inMemory));
  void loadCache().then(async ({ assessRebalanceResources, detectDevice, loadFromOpfs }) => {
    if (state.fingerprint !== fingerprint) return;
    setState({ assessment: assessRebalanceResources(durationSec, sampleRate, detectDevice()) });
    if (inMemory) return;
    const set = await loadFromOpfs(fingerprint, sampleRate, left.length);
    if (state.fingerprint !== fingerprint) return;
    if (set) markReady(set);
    else setState({ status: 'missing' });
  }).catch(() => {
    if (state.fingerprint === fingerprint && state.status === 'checking') setState({ status: 'missing' });
  });
}

/** Separate the active track into stems (slow). Resolves when ready, cancelled or failed. */
export async function separateActiveRebalanceStems(options: { highQuality?: boolean } = {}): Promise<void> {
  const source = activeSource;
  const fingerprint = state.fingerprint;
  if (!source || !fingerprint) return;
  if (state.status === 'separating') {
    // A user may already have started separation in the Vocal panel. Wait for that
    // same-track job rather than reporting "no stems" while it is still running.
    try {
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        let unsubscribe: () => void = () => {};
        const finish = (error?: Error) => {
          if (timer !== null) clearTimeout(timer);
          unsubscribe();
          if (error) reject(error);
          else resolve();
        };
        const check = () => {
          if (state.fingerprint !== fingerprint) finish(new Error('The active track changed during stem separation.'));
          else if (state.status !== 'separating') finish();
        };
        unsubscribe = subscribeRebalanceStems(check);
        timer = setTimeout(() => finish(new Error('The active stem-separation job timed out.')), 180000);
        check();
      });
    } catch (cause) {
      if (state.fingerprint === fingerprint) {
        setState({ status: 'error', error: cause instanceof Error ? cause.message : 'The active stem-separation job did not finish.' });
      }
    }
    return;
  }

  // FIX ALL may request separation immediately after import, while the asynchronous
  // device/memory assessment is still running. Never start the model before that gate.
  if (!state.assessment && state.status === 'checking') {
    try {
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        let unsubscribe: () => void = () => {};
        const finish = (error?: Error) => {
          if (timer !== null) clearTimeout(timer);
          unsubscribe();
          if (error) reject(error);
          else resolve();
        };
        const check = () => {
          if (state.fingerprint !== fingerprint) {
            finish(new Error('The active track changed before stem separation could start.'));
          } else if (state.assessment || state.status !== 'checking') {
            finish();
          }
        };
        unsubscribe = subscribeRebalanceStems(check);
        timer = setTimeout(() => finish(new Error('Stem-separation resource assessment timed out.')), 10000);
        check();
      });
    } catch (cause) {
      if (state.fingerprint === fingerprint) {
        setState({ status: 'error', error: cause instanceof Error ? cause.message : 'Stem-separation resource assessment failed.' });
      }
      return;
    }
  }
  if (state.fingerprint !== fingerprint || activeSource !== source) return;
  if (!state.assessment) {
    setState({ status: 'error', error: 'Stem separation was not started because device and memory safety could not be assessed.' });
    return;
  }
  if (state.assessment.level === 'block') {
    setState({ status: 'error', error: state.assessment.message });
    return;
  }
  const controller = new AbortController();
  abortController = controller;
  setState({ status: 'separating', error: null, progress: { stage: 'preparing', overall: 0 } });
  try {
    const { separateForRebalance } = await import('./rebalanceSeparation.ts');
    const set = await separateForRebalance(
      source.left,
      source.right,
      source.sampleRate,
      controller.signal,
      (progress) => { if (state.fingerprint === fingerprint) setState({ progress }); },
      options,
    );
    if (state.fingerprint !== fingerprint) return;
    markReady(set);
    void loadCache().then(({ saveToOpfs }) => saveToOpfs(set)).catch(() => undefined);
  } catch (cause) {
    if (state.fingerprint !== fingerprint) return;
    const cancelled = cause instanceof DOMException && cause.name === 'AbortError';
    setState({
      status: cancelled ? 'missing' : 'error',
      progress: null,
      error: cancelled ? null : cause instanceof Error ? cause.message : 'Stem separation failed.',
    });
  } finally {
    if (abortController === controller) abortController = null;
  }
}

export function cancelRebalanceSeparation(): void {
  abortController?.abort();
}
