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
.syn-wf-fade-region { fill: rgba(224, 64, 251, 0.05); stroke: none; }
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
