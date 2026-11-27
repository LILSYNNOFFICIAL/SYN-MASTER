/**
 * Styles for the EQ graph's waveform timeline layer (fades, zoom bar, neon envelope).
 * Kept in their own module and injected once at runtime instead of a `.css` import, so the
 * components stay importable by the Node test runner (MasterConsole -> EqGraph is
 * rendered in node tests, which cannot load .css files). Never collides with skin CSS.
 */
export const WAVEFORM_CSS = `
/* Waveform timeline layer of the EQ graph: fades, zoom bar, neon envelope.
   Injected once by ensureWaveformStyles(). */

/* ---- Fades: smooth gain-law lines + attenuation shading ---- */
.syn-wf-fade-shade { pointer-events: none; }
.syn-wf-fade-region { fill: rgba(224, 64, 251, 0.05) !important; stroke: none; }
.syn-wf-fade-line {
  fill: none; stroke: #E040FB; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
}
.syn-wf-fade-glow {
  fill: none; stroke: #E040FB; stroke-opacity: 0.28; stroke-width: 7; stroke-linecap: round; stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
}
.syn-wf-fade-handle {
  fill: #3FE0FF; stroke: #07111C; stroke-width: 2; cursor: ew-resize;
  filter: drop-shadow(0 0 4px rgba(63, 224, 255, 0.8));
}
/* ---- FL Studio style zoom / scroll bar ---- */
.syn-wfzoom { display: flex; align-items: center; gap: 6px; margin: 0 0 4px 30px; min-width: 0; }
.syn-deq .syn-wfzoom { margin-left: 22px; }
.syn-wfzoom-track {
  position: relative; flex: 1 1 auto; min-width: 0; height: 12px; border-radius: 6px; cursor: pointer;
  background: rgba(3, 8, 16, 0.75); border: 1px solid rgba(94, 200, 255, 0.18);
  touch-action: none; user-select: none; -webkit-user-select: none; outline: none;
}
.syn-wfzoom-track:focus-visible { box-shadow: 0 0 0 2px rgba(63, 224, 255, 0.55); }
.syn-wfzoom-handle {
  position: absolute; top: 1px; bottom: 1px; min-width: 18px; border-radius: 5px; cursor: grab;
  background: linear-gradient(90deg, rgba(63, 224, 255, 0.38), rgba(139, 92, 246, 0.42));
  border: 1px solid rgba(63, 224, 255, 0.55); box-sizing: border-box;
}
.syn-wfzoom[data-zoomed="false"] .syn-wfzoom-handle { opacity: 0.55; }
.syn-wfzoom-handle:active { cursor: grabbing; }
.syn-wfzoom-grip { position: absolute; top: -2px; bottom: -2px; width: 8px; cursor: ew-resize; }
.syn-wfzoom-grip.is-left { left: -3px; border-left: 2px solid rgba(232, 246, 255, 0.85); }
.syn-wfzoom-grip.is-right { right: -3px; border-right: 2px solid rgba(232, 246, 255, 0.85); }
.syn-wfzoom-readout { flex: 0 0 auto; min-width: 30px; text-align: right; font: 9px var(--syn-font-mono, monospace); color: rgba(143, 163, 191, 0.9); }
@media (pointer: coarse) {
  .syn-wfzoom-track { height: 20px; border-radius: 10px; }
  .syn-wfzoom-handle { border-radius: 9px; min-width: 32px; }
  .syn-wfzoom-grip { width: 14px; }
  .syn-wfzoom-grip.is-left { left: -6px; }
  .syn-wfzoom-grip.is-right { right: -6px; }
}
/* ---- FL Studio style zoom / scroll bar ---- */
.syn-wfzoom { display: flex; align-items: center; gap: 6px; margin: 0 0 4px 30px; min-width: 0; }
.syn-deq .syn-wfzoom { margin-left: 22px; }
.syn-wfzoom-track {
  position: relative; flex: 1 1 auto; min-width: 0; height: 12px; border-radius: 6px; cursor: pointer;
  background: rgba(3, 8, 16, 0.75); border: 1px solid rgba(94, 200, 255, 0.18);
  touch-action: none; user-select: none; -webkit-user-select: none; outline: none;
}
.syn-wfzoom-track:focus-visible { box-shadow: 0 0 0 2px rgba(63, 224, 255, 0.55); }
.syn-wfzoom-handle {
  position: absolute; top: 1px; bottom: 1px; min-width: 18px; border-radius: 5px; cursor: grab;
  background: linear-gradient(90deg, rgba(63, 224, 255, 0.38), rgba(139, 92, 246, 0.42));
  border: 1px solid rgba(63, 224, 255, 0.55); box-sizing: border-box;
}
.syn-wfzoom[data-zoomed="false"] .syn-wfzoom-handle { opacity: 0.55; }
.syn-wfzoom-handle:active { cursor: grabbing; }
.syn-wfzoom-grip { position: absolute; top: -2px; bottom: -2px; width: 8px; cursor: ew-resize; }
.syn-wfzoom-grip.is-left { left: -3px; border-left: 2px solid rgba(232, 246, 255, 0.85); }
.syn-wfzoom-grip.is-right { right: -3px; border-right: 2px solid rgba(232, 246, 255, 0.85); }
.syn-wfzoom-readout { flex: 0 0 auto; min-width: 30px; text-align: right; font: 9px var(--syn-font-mono, monospace); color: rgba(143, 163, 191, 0.9); }
@media (pointer: coarse) {
  .syn-wfzoom-track { height: 20px; border-radius: 10px; }
  .syn-wfzoom-handle { border-radius: 9px; min-width: 32px; }
  .syn-wfzoom-grip { width: 14px; }
  .syn-wfzoom-grip.is-left { left: -6px; }
  .syn-wfzoom-grip.is-right { right: -6px; }
}
/* ---- Neon upper envelope (analyser outline): cyan > violet > magenta > gold ---- */
.syn-wf-neon-line {
  stroke-width: 1.6; stroke-opacity: 0.78; stroke-linejoin: round; stroke-linecap: round;
  vector-effect: non-scaling-stroke;
}
/* Bloom = a wide translucent copy of the line (no blur filter on phones: cheap). */
.syn-wf-neon-bloom {
  stroke-width: 7; stroke-opacity: 0.16; stroke-linejoin: round; stroke-linecap: round;
  vector-effect: non-scaling-stroke;
}
@media (pointer: fine) and (min-width: 700px) {
  .syn-wf-neon-bloom { filter: blur(2.5px); stroke-opacity: 0.3; }
}
@media (prefers-reduced-motion: no-preference) and (pointer: fine) {
  .syn-wf-neon-bloom { animation: syn-wf-neon-breathe 4.8s ease-in-out infinite; }
}
/* ---- Frequency-colored neon fill + loudness tint (no blur: cheap on phones) ---- */
.syn-wf-neon-fill, .syn-wf-tint { pointer-events: none; }
/* ---- Fade length label on the fade curve (hover / drag) ---- */
.syn-wf-fade-label {
  position: absolute; z-index: 3; transform: translate(-50%, -135%); pointer-events: none; white-space: nowrap;
  padding: 2px 7px; border-radius: 7px; font: 600 10px/1.3 var(--syn-font-mono, monospace); color: #E8F6FF;
  background: rgba(3, 8, 16, 0.86); border: 1px solid rgba(224, 64, 251, 0.6); box-shadow: 0 0 8px rgba(224, 64, 251, 0.35);
}
.syn-wf-fade-label.is-below { transform: translate(-50%, 45%); }
.syn-wf-fade-label b { color: #3FE0FF; font-variant-numeric: tabular-nums; }
@keyframes syn-wf-neon-breathe { 0%, 100% { stroke-opacity: 0.22; } 50% { stroke-opacity: 0.36; } }
`;

let injected = false;
export function ensureWaveformStyles(): void {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const el = document.createElement('style');
  el.setAttribute('data-syn-waveform-styles', '');
  el.textContent = WAVEFORM_CSS;
  document.head.appendChild(el);
}
