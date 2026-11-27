import { useEffect } from 'react';
import { telemetryStore, type RuntimeTelemetryState } from '../../engine/telemetryStore';

/**
 * Audio-reactive glow (display only). Publishes the live playback level as the CSS variable
 * `--syn-level` (0..1) on <html>, plus `data-syn-playing` while audio plays. Any stylesheet can
 * use it (EQ curve/nodes, panel edges). Never touches audio, analysis or the chain.
 * Writes at most once per animation frame and only when the value moved visibly.
 */

const FLOOR_DB = -48;
const CEIL_DB = -6;

/** Map an RMS level in dBFS to a 0..1 glow amount (NaN / -inf / silence -> 0). */
export function levelFromDb(db: number): number {
  if (!Number.isFinite(db)) return 0;
  const t = (db - FLOOR_DB) / (CEIL_DB - FLOOR_DB);
  return Math.max(0, Math.min(1, t));
}

/** Fast-attack, slow-release smoothing so the glow follows hits without flicker. */
export function smoothLevel(prev: number, next: number): number {
  const k = next > prev ? 0.6 : 0.12;
  return prev + (next - prev) * k;
}

export function useLevelGlow(): void {
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const root = document.documentElement;
    let target = 0;
    let shown = 0;
    let written = -1;
    let raf = 0;
    let playing = false;
    const tick = () => {
      raf = 0;
      shown = smoothLevel(shown, target);
      if (Math.abs(shown - written) > 0.01) {
        written = shown;
        root.style.setProperty('--syn-level', shown.toFixed(3));
      }
      if (playing || shown > 0.01) raf = requestAnimationFrame(tick);
      else root.style.setProperty('--syn-level', '0');
    };
    const onTelemetry = (snap: RuntimeTelemetryState) => {
      const live = snap.isPlaying ? snap.live : null;
      playing = Boolean(live);
      target = live ? levelFromDb(Math.max(live.rmsL, live.rmsR)) : 0;
      if (playing) root.dataset.synPlaying = 'true';
      else delete root.dataset.synPlaying;
      if (!raf) raf = requestAnimationFrame(tick);
    };
    root.style.setProperty('--syn-level', '0');
    onTelemetry(telemetryStore.getSnapshot());
    const unsubscribe = telemetryStore.subscribe(onTelemetry);
    return () => {
      unsubscribe();
      if (raf) cancelAnimationFrame(raf);
      root.style.setProperty('--syn-level', '0');
      delete root.dataset.synPlaying;
    };
  }, []);
}
