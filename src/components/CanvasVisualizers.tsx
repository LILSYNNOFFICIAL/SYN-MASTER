import React, { useEffect, useRef, useState } from 'react';
import type { AudioAnalysis, ParametricEQParams, ProcessorModule } from '../types/mastering';
import {
  designHighPass,
  designHighShelf,
  designLowPass,
  designLowShelf,
  designNotch,
  designPeakingEQ,
  evaluateBiquadMagnitudeDb,
} from '../dsp/biquad';
import { telemetryStore, type RuntimeTelemetryState } from '../engine/telemetryStore';
import { buildWaveformOverlayPoints } from '../dsp/waveformOverlay';

interface CanvasMetrics {
  cssWidth: number;
  cssHeight: number;
  dpr: number;
}

function attachResizeObserver(
  canvas: HTMLCanvasElement,
  onResize: (metrics: CanvasMetrics) => void,
): () => void {
  const measure = () => {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = Math.max(0, Math.round(rect.width));
    const cssHeight = Math.max(0, Math.round(rect.height));
    if (cssWidth === 0 || cssHeight === 0) return;
    const targetW = Math.round(cssWidth * dpr);
    const targetH = Math.round(cssHeight * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    onResize({ cssWidth, cssHeight, dpr });
  };

  measure();
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => measure());
    ro.observe(canvas);
    return () => ro.disconnect();
  }
  window.addEventListener('resize', measure);
  return () => window.removeEventListener('resize', measure);
}

interface WaveformProps {
  prePeaks: number[];
  postPeaks: number[] | null;
  durationSec: number;
  loopEnabled: boolean;
  loopStartSec: number;
  loopEndSec: number;
  showPostOverlay: boolean;
  onSeek: (sec: number) => void;
}

export const WaveformTimelineCanvas: React.FC<WaveformProps> = React.memo(
  ({
    prePeaks,
    postPeaks,
    durationSec,
    loopEnabled,
    loopStartSec,
    loopEndSec,
    showPostOverlay,
    onSeek,
  }) => {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const staticCacheRef = useRef<HTMLCanvasElement | null>(null);
    const metricsRef = useRef<CanvasMetrics>({ cssWidth: 0, cssHeight: 0, dpr: 1 });
    const durationRef = useRef(durationSec);
    durationRef.current = durationSec;

    const renderFrame = (timeSec: number) => {
      const canvas = canvasRef.current;
      const staticCache = staticCacheRef.current;
      if (!canvas || !staticCache) return;
      const { cssWidth: w, cssHeight: h, dpr } = metricsRef.current;
      if (w === 0 || h === 0 || staticCache.width === 0 || staticCache.height === 0) return;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(staticCache, 0, 0);

      const dur = durationRef.current;
      if (dur > 0) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const px = Math.max(0, Math.min(w, (timeSec / dur) * w));
        ctx.strokeStyle = '#3FE0FF';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(px, 0);
        ctx.lineTo(px, h);
        ctx.stroke();

        ctx.fillStyle = '#3FE0FF';
        ctx.beginPath();
        ctx.moveTo(px - 5, 0);
        ctx.lineTo(px + 5, 0);
        ctx.lineTo(px, 7);
        ctx.closePath();
        ctx.fill();
      }
    };

    const rebuildStaticLayer = () => {
      const { cssWidth: w, cssHeight: h, dpr } = metricsRef.current;
      if (w === 0 || h === 0) return;
      if (!staticCacheRef.current) {
        staticCacheRef.current = document.createElement('canvas');
      }
      const off = staticCacheRef.current;
      const targetW = Math.round(w * dpr);
      const targetH = Math.round(h * dpr);
      if (off.width !== targetW || off.height !== targetH) {
        off.width = targetW;
        off.height = targetH;
      }
      const ctx = off.getContext('2d');
      if (!ctx) return;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const midY = h * 0.5;

      ctx.fillStyle = '#050B16';
      ctx.fillRect(0, 0, w, h);

      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.lineWidth = 1;
      for (let i = 1; i < 4; i++) {
        const y = (h / 4) * i;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      if (loopEnabled && durationSec > 0) {
        const lx1 = (loopStartSec / durationSec) * w;
        const lx2 = (loopEndSec / durationSec) * w;
        ctx.fillStyle = 'rgba(46, 168, 255, 0.11)';
        ctx.fillRect(lx1, 0, Math.max(2, lx2 - lx1), h);
        ctx.strokeStyle = 'rgba(63, 224, 255, 0.55)';
        ctx.beginPath();
        ctx.moveTo(lx1, 0);
        ctx.lineTo(lx1, h);
        ctx.moveTo(lx2, 0);
        ctx.lineTo(lx2, h);
        ctx.stroke();
      }

      ctx.shadowColor = 'rgba(46,168,255,0.7)';
      ctx.shadowBlur = 6;
      if (prePeaks.length > 0) {
        const barW = w / prePeaks.length;
        ctx.fillStyle =
          showPostOverlay && postPeaks ? 'rgba(180, 188, 202, 0.28)' : 'rgba(46, 168, 255, 0.85)';
        for (let i = 0; i < prePeaks.length; i++) {
          const amp = Math.min(1, prePeaks[i]) * (h * 0.44);
          const x = i * barW;
          ctx.fillRect(x, midY - amp, Math.max(1, barW - 0.6), Math.max(1.5, amp * 2));
        }
      }

      if (showPostOverlay && postPeaks && postPeaks.length > 0) {
        const barW = w / postPeaks.length;
        ctx.fillStyle = 'rgba(63, 224, 255, 0.9)';
        for (let i = 0; i < postPeaks.length; i++) {
          const amp = Math.min(1, postPeaks[i]) * (h * 0.44);
          const x = i * barW;
          ctx.fillRect(x, midY - amp, Math.max(1, barW - 0.8), Math.max(1.5, amp * 2));
        }
      }

      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.beginPath();
      ctx.moveTo(0, midY);
      ctx.lineTo(w, midY);
      ctx.stroke();

      renderFrame(telemetryStore.getSnapshot().currentTimeSec);
    };

    const rebuildRef = useRef(rebuildStaticLayer);
    rebuildRef.current = rebuildStaticLayer;

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      return attachResizeObserver(canvas, (m) => {
        metricsRef.current = m;
        rebuildRef.current();
      });
    }, []);

    useEffect(() => {
      rebuildStaticLayer();
    }, [prePeaks, postPeaks, durationSec, loopEnabled, loopStartSec, loopEndSec, showPostOverlay]);

    useEffect(() => {
      let pendingRaf = 0;
      let latestTime = telemetryStore.getSnapshot().currentTimeSec;
      const unsub = telemetryStore.subscribe((snap: RuntimeTelemetryState) => {
        latestTime = snap.currentTimeSec;
        if (pendingRaf) return;
        pendingRaf = requestAnimationFrame(() => {
          pendingRaf = 0;
          renderFrame(latestTime);
        });
      });
      return () => {
        unsub();
        if (pendingRaf) cancelAnimationFrame(pendingRaf);
      };
    }, []);

    const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (durationSec <= 0) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      onSeek(ratio * durationSec);
    };

    return (
      <canvas
        ref={canvasRef}
        data-testid="waveform-canvas"
        onClick={handleClick}
        className="w-full h-28 cursor-pointer rounded border border-[#262934] block"
      />
    );
  },
);

interface SpectrumCanvasProps {
  preAnalysis: AudioAnalysis | null;
  postAnalysis: AudioAnalysis | null;
  referenceAnalysis?: AudioAnalysis | null;
  chain: ProcessorModule[];
  sampleRate: number;
  mode: 'spectrum' | 'spectrogram';
  heightClass?: string;
  allowLiveTelemetry?: boolean;
  waveformPeaks?: number[];
  durationSec?: number;
  /** When set, the playhead line is click/drag seekable (shared playback position). */
  onSeek?: (sec: number) => void;
}

const SPECTRO_COLS = 320;

/** Spectrogram colour map: deep navy → purple → electric blue → cyan → ice white (256 RGB triples). */
const SPECTRO_LUT: Uint8ClampedArray = (() => {
  const stops: Array<[number, number, number, number]> = [
    [0, 3, 6, 14],
    [0.18, 18, 12, 58],
    [0.38, 76, 29, 149],
    [0.58, 46, 168, 255],
    [0.8, 63, 224, 255],
    [1, 236, 252, 255],
  ];
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const [t0, r0, g0, b0] = stops[k];
    const [t1, r1, g1, b1] = stops[k + 1];
    const u = Math.max(0, Math.min(1, (t - t0) / (t1 - t0)));
    lut[i * 3] = r0 + (r1 - r0) * u;
    lut[i * 3 + 1] = g0 + (g1 - g0) * u;
    lut[i * 3 + 2] = b0 + (b1 - b0) * u;
  }
  return lut;
})();

export const SpectrumAndEQCanvas: React.FC<SpectrumCanvasProps> = React.memo(
  ({
    preAnalysis,
    postAnalysis,
    referenceAnalysis,
    chain,
    sampleRate,
    mode,
    heightClass = 'h-60',
    allowLiveTelemetry = true,
    waveformPeaks = [],
    durationSec = 0,
    onSeek,
  }) => {
    const onSeekRef = useRef(onSeek);
    onSeekRef.current = onSeek;
    const seekDragRef = useRef(false);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const staticCacheRef = useRef<HTMLCanvasElement | null>(null);
    const metricsRef = useRef<CanvasMetrics>({ cssWidth: 0, cssHeight: 0, dpr: 1 });
    const [hoverInfo, setHoverInfo] = useState<{ freqHz: number; db: number } | null>(null);

    // Circular spectrogram ring buffer (zero per-frame heap allocation or array shift)
    const ringRef = useRef<{
      binsPerCol: number;
      rows: Uint8Array[];
      head: number;
      count: number;
    }>({
      binsPerCol: 0,
      rows: [],
      head: 0,
      count: 0,
    });

    const spectroRef = useRef<{
      canvas: HTMLCanvasElement | null;
      img: ImageData | null;
      lo: Float32Array | null;
      hi: Float32Array | null;
      mapH: number;
      mapBins: number;
      mapSr: number;
    }>({ canvas: null, img: null, lo: null, hi: null, mapH: 0, mapBins: 0, mapSr: 0 });

    // Pre-allocated scratch buffers for live FFT curve coordinates
    const liveXRef = useRef<Float32Array>(new Float32Array(0));
    const liveYRef = useRef<Float32Array>(new Float32Array(0));

    const modeRef = useRef(mode);
    modeRef.current = mode;
    const sampleRateRef = useRef(sampleRate);
    sampleRateRef.current = sampleRate;
    const waveformPeaksRef = useRef(waveformPeaks);
    waveformPeaksRef.current = waveformPeaks;
    const durationSecRef = useRef(durationSec);
    durationSecRef.current = durationSec;
    const allowLiveRef = useRef(allowLiveTelemetry);
    allowLiveRef.current = allowLiveTelemetry;

    const pushSpectroColumn = (bins: Uint8Array) => {
      const ring = ringRef.current;
      if (ring.binsPerCol !== bins.length) {
        ring.binsPerCol = bins.length;
        ring.rows = Array.from({ length: SPECTRO_COLS }, () => new Uint8Array(bins.length));
        ring.head = 0;
        ring.count = 0;
      }
      ring.rows[ring.head].set(bins);
      ring.head = (ring.head + 1) % SPECTRO_COLS;
      if (ring.count < SPECTRO_COLS) ring.count++;
    };

    const drawFrame = (snap: RuntimeTelemetryState) => {
      const canvas = canvasRef.current;
      const staticCache = staticCacheRef.current;
      if (!canvas || !staticCache) return;
      const { cssWidth: w, cssHeight: h, dpr } = metricsRef.current;
      if (w === 0 || h === 0 || staticCache.width === 0 || staticCache.height === 0) return;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(staticCache, 0, 0);

      const live = allowLiveRef.current && snap.isPlaying ? snap.live : null;
      const fftBins = live?.fftBins;
      const padL = 36;
      const padR = 14;
      const padT = 12;
      const padB = 22;
      const plotW = w - padL - padR;
      const plotH = h - padT - padB;
      const minF = 20;
      const maxF = 20000;
      const logSpan = Math.log10(maxF / minF);
      const sr = sampleRateRef.current;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Playback cursor follows engine telemetry over the composite waveform/EQ view.
      if (modeRef.current !== 'spectrogram' && waveformPeaksRef.current.length > 0 && durationSecRef.current > 0) {
        const progress = Math.max(0, Math.min(1, snap.currentTimeSec / durationSecRef.current));
        const playheadX = padL + progress * plotW;
        ctx.save();
        ctx.strokeStyle = 'rgba(74,207,255,0.92)';
        ctx.lineWidth = 1.25;
        ctx.shadowColor = 'rgba(32,191,255,0.9)';
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.moveTo(playheadX, padT);
        ctx.lineTo(playheadX, padT + plotH);
        ctx.stroke();
        if (onSeekRef.current) {
          // Grab handle: shows the line is draggable.
          ctx.fillStyle = '#3FE0FF';
          ctx.beginPath();
          ctx.moveTo(playheadX - 6, padT - 2);
          ctx.lineTo(playheadX + 6, padT - 2);
          ctx.lineTo(playheadX, padT + 7);
          ctx.closePath();
          ctx.fill();
        }
        ctx.restore();
      }

      if (modeRef.current === 'spectrogram') {
        const ring = ringRef.current;
        const pxH = Math.max(1, Math.round(plotH * dpr));
        if (ring.count > 0 && ring.binsPerCol > 0) {
          const cols = SPECTRO_COLS;
          const sg = spectroRef.current;
          if (!sg.canvas) sg.canvas = document.createElement('canvas');
          const off = sg.canvas;
          if (off.width !== cols || off.height !== pxH) {
            off.width = cols;
            off.height = pxH;
            sg.img = null;
          }
          const octx = off.getContext('2d');
          if (octx) {
            if (!sg.img) sg.img = octx.createImageData(cols, pxH);
            // Row → FFT-bin map on a log axis, one entry per device-pixel row. Low rows that
            // fall inside one bin interpolate; high rows spanning many bins take the max.
            if (sg.mapH !== pxH || sg.mapBins !== ring.binsPerCol || sg.mapSr !== sr) {
              sg.lo = new Float32Array(pxH);
              sg.hi = new Float32Array(pxH);
              const binHz = sr / (ring.binsPerCol * 2);
              for (let y = 0; y < pxH; y++) {
                const fTop = minF * Math.pow(maxF / minF, 1 - y / pxH);
                const fBot = minF * Math.pow(maxF / minF, 1 - (y + 1) / pxH);
                sg.lo[y] = Math.max(0, Math.min(ring.binsPerCol - 1, fBot / binHz));
                sg.hi[y] = Math.max(0, Math.min(ring.binsPerCol - 1, fTop / binHz));
              }
              sg.mapH = pxH;
              sg.mapBins = ring.binsPerCol;
              sg.mapSr = sr;
            }
            const data = sg.img.data;
            const lo = sg.lo!;
            const hi = sg.hi!;
            const filled = ring.count;
            const startIdx = ring.count < SPECTRO_COLS ? 0 : ring.head;
            const firstCol = cols - filled;
            for (let c = 0; c < cols; c++) {
              const bins = c >= firstCol ? ring.rows[(startIdx + (c - firstCol)) % SPECTRO_COLS] : null;
              for (let y = 0; y < pxH; y++) {
                let v = 0;
                if (bins) {
                  const a = lo[y];
                  const b = hi[y];
                  if (b - a < 1) {
                    const m = (a + b) * 0.5;
                    const i0 = Math.floor(m);
                    const i1 = Math.min(bins.length - 1, i0 + 1);
                    v = bins[i0] + (bins[i1] - bins[i0]) * (m - i0);
                  } else {
                    for (let k = Math.floor(a); k <= Math.ceil(b); k++) if (bins[k] > v) v = bins[k];
                  }
                }
                // Contrast curve: pushes the noise floor down so partials read clearly.
                const li = Math.max(0, Math.min(255, Math.round(255 * Math.pow(v / 255, 1.6))));
                const o = (y * cols + c) * 4;
                data[o] = SPECTRO_LUT[li * 3];
                data[o + 1] = SPECTRO_LUT[li * 3 + 1];
                data[o + 2] = SPECTRO_LUT[li * 3 + 2];
                data[o + 3] = 255;
              }
            }
            octx.putImageData(sg.img, 0, 0);
            ctx.save();
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(off, padL, padT, plotW, plotH);
            ctx.restore();
          }
        } else {
          ctx.fillStyle = '#7FB8E6';
          ctx.font = '11px "JetBrains Mono", monospace';
          ctx.textAlign = 'center';
          ctx.fillText('Press play to draw the spectrogram', padL + plotW / 2, padT + plotH / 2);
        }
        // Log-frequency axis on top of the image.
        ctx.font = w < 420 ? '8px "JetBrains Mono", monospace' : '10px "JetBrains Mono", monospace';
        ctx.textAlign = 'right';
        for (const fm of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
          const y = Math.round(padT + (1 - Math.log10(fm / minF) / logSpan) * plotH) + 0.5;
          ctx.strokeStyle = 'rgba(160,220,255,0.16)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(padL, y);
          ctx.lineTo(padL + plotW, y);
          ctx.stroke();
          ctx.fillStyle = '#8FC8F0';
          ctx.fillText(fm >= 1000 ? `${fm / 1000}k` : `${fm}`, padL - 4, y + 3);
        }
        ctx.textAlign = 'left';
        ctx.fillStyle = '#5F8FB8';
        ctx.fillText('time →', padL + 2, h - 6);
        return;
      }

      // Live real-time FFT overlay using pre-allocated typed scratch arrays
      if (fftBins && fftBins.length > 0) {
        const binHz = sr / (fftBins.length * 2);
        if (liveXRef.current.length < fftBins.length) {
          liveXRef.current = new Float32Array(fftBins.length);
          liveYRef.current = new Float32Array(fftBins.length);
        }
        const xs = liveXRef.current;
        const ys = liveYRef.current;
        let count = 0;

        for (let i = 1; i < fftBins.length; i++) {
          const f = i * binHz;
          if (f >= minF && f <= maxF) {
            const db = -66 + (fftBins[i] / 255) * 66;
            const clampedDb = db < -68 ? -68 : db > 6 ? 6 : db;
            xs[count] = padL + (Math.log10(f / minF) / logSpan) * plotW;
            ys[count] = padT + ((6 - clampedDb) / 74) * plotH;
            count++;
          }
        }

        if (count > 1) {
          ctx.beginPath();
          ctx.moveTo(xs[0], ys[0]);
          for (let i = 1; i < count; i++) {
            ctx.lineTo(xs[i], ys[i]);
          }
          ctx.strokeStyle = 'rgba(247, 248, 250, 0.9)';
          ctx.lineWidth = 1.6;
          ctx.stroke();

          ctx.lineTo(xs[count - 1], padT + plotH);
          ctx.lineTo(xs[0], padT + plotH);
          ctx.closePath();
          ctx.fillStyle = 'rgba(63, 224, 255, 0.08)';
          ctx.fill();
        }
      }
    };

    const rebuildStaticLayer = () => {
      const { cssWidth: w, cssHeight: h, dpr } = metricsRef.current;
      if (w === 0 || h === 0) return;
      if (!staticCacheRef.current) {
        staticCacheRef.current = document.createElement('canvas');
      }
      const off = staticCacheRef.current;
      const targetW = Math.round(w * dpr);
      const targetH = Math.round(h * dpr);
      if (off.width !== targetW || off.height !== targetH) {
        off.width = targetW;
        off.height = targetH;
      }
      const ctx = off.getContext('2d');
      if (!ctx) return;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const padL = 36;
      const padR = 14;
      const padT = 12;
      const padB = 22;
      const plotW = w - padL - padR;
      const plotH = h - padT - padB;
      const minF = 20;
      const maxF = 20000;
      const freqToX = (f: number) =>
        padL + (Math.log10(Math.max(minF, Math.min(maxF, f)) / minF) / Math.log10(maxF / minF)) * plotW;
      const dbToY = (db: number) => {
        const clamped = Math.max(-68, Math.min(6, db));
        return padT + ((6 - clamped) / 74) * plotH;
      };

      ctx.fillStyle = '#050B16';
      ctx.fillRect(0, 0, w, h);

      if (mode === 'spectrogram') {
        // Spectrogram: the image, log-frequency axis and labels are drawn per frame.
        ctx.fillStyle = '#03060E';
        ctx.fillRect(padL, padT, plotW, plotH);
        drawFrame(telemetryStore.getSnapshot());
        return;
      }

      const freqMarkers = [20, 30, 60, 100, 250, 500, 1000, 2000, 5000, 10000, 20000];
      ctx.font = w < 420 ? '8px "JetBrains Mono", monospace' : '10px "JetBrains Mono", monospace';
      for (const fm of freqMarkers) {
        const x = freqToX(fm);
        ctx.strokeStyle = 'rgba(255,255,255,0.06)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, padT);
        ctx.lineTo(x, padT + plotH);
        ctx.stroke();

        ctx.fillStyle = '#6F9CC4';
        ctx.textAlign = fm === 30 ? 'left' : fm === 20000 ? 'right' : 'center';
        ctx.fillText(fm === 20 ? '20 Hz' : fm >= 1000 ? `${fm / 1000}k` : `${fm}`, x, h - 6);
        ctx.textAlign = 'center';
      }

      const dbMarkers = [0, -12, -24, -36, -48, -60];
      ctx.textAlign = 'right';
      for (const dm of dbMarkers) {
        const y = dbToY(dm);
        ctx.strokeStyle = dm === 0 ? 'rgba(63, 224, 255, 0.3)' : 'rgba(255,255,255,0.06)';
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(padL + plotW, y);
        ctx.stroke();
        ctx.fillStyle = '#6F9CC4';
        ctx.fillText(`${dm}`, padL - 5, y + 3);
      }

      // Source waveform is a time-domain amplitude envelope. It is deliberately
      // translucent and centered behind the frequency-domain spectrum/EQ curves.
      if (waveformPeaks.length > 0) {
        const points = buildWaveformOverlayPoints(waveformPeaks, plotW, padT + plotH * 0.5, plotH * 0.34);
        ctx.save();
        ctx.globalAlpha = 0.38;
        ctx.strokeStyle = '#20BFFF';
        ctx.lineWidth = 1.15;
        ctx.shadowColor = 'rgba(32,191,255,0.85)';
        ctx.shadowBlur = 7;
        ctx.beginPath();
        for (const point of points) {
          ctx.moveTo(padL + point.x, point.top);
          ctx.lineTo(padL + point.x, point.bottom);
        }
        ctx.stroke();
        ctx.restore();
      }

      if (mode === 'spectrum') {
        const drawSpectrumCurve = (
          freqs: number[],
          dbs: number[],
          stroke: string,
          fill?: string,
          dashed = false,
        ) => {
          if (freqs.length === 0) return;
          ctx.save();
          if (dashed) ctx.setLineDash([4, 4]);
          ctx.beginPath();
          for (let i = 0; i < freqs.length; i++) {
            const x = freqToX(freqs[i]);
            const y = dbToY(dbs[i]);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.strokeStyle = stroke;
          ctx.lineWidth = 1.6;
          if (!dashed) { ctx.shadowColor = 'rgba(46,168,255,0.85)'; ctx.shadowBlur = 9; }
          ctx.stroke();
          ctx.shadowBlur = 0;

          if (fill) {
            ctx.lineTo(freqToX(freqs[freqs.length - 1]), padT + plotH);
            ctx.lineTo(freqToX(freqs[0]), padT + plotH);
            ctx.closePath();
            ctx.fillStyle = fill;
            ctx.fill();
          }
          ctx.restore();
        };

        if (preAnalysis) {
          drawSpectrumCurve(
            preAnalysis.spectrumBinsFreq,
            preAnalysis.spectrumBinsDb,
            'rgba(200, 206, 218, 0.45)',
            undefined,
            true,
          );
        }

        if (referenceAnalysis) {
          drawSpectrumCurve(
            referenceAnalysis.spectrumBinsFreq,
            referenceAnalysis.spectrumBinsDb,
            'rgba(139, 92, 246, 0.8)',
            undefined,
            true,
          );
        }

        if (postAnalysis) {
          drawSpectrumCurve(
            postAnalysis.spectrumBinsFreq,
            postAnalysis.spectrumBinsDb,
            '#3FE0FF',
            'rgba(46, 168, 255, 0.16)',
          );
        }

        // Composite EQ Transfer Curve Overlay from active Parametric EQ modules
        const activeEqs = chain.filter(
          (m) => m.type === 'parametric-eq' && m.enabled && !m.bypassed && m.wetDry > 0,
        );
        if (activeEqs.length > 0) {
          const eqZeroY = padT + plotH * 0.38;
          ctx.beginPath();
          const steps = 120;
          for (let i = 0; i <= steps; i++) {
            const freq = minF * Math.pow(maxF / minF, i / steps);
            let totalDb = 0;
            for (const mod of activeEqs) {
              const p = mod.params as ParametricEQParams;
              const scale = (mod.intensity / 100) * (mod.wetDry / 100);
              for (const b of p.bands) {
                if (!b.enabled) continue;
                let c;
                if (b.shape === 'highpass') c = designHighPass(b.freq, b.q, sampleRate);
                else if (b.shape === 'lowpass') c = designLowPass(b.freq, b.q, sampleRate);
                else if (b.shape === 'lowshelf') c = designLowShelf(b.freq, b.gain * scale, b.q, sampleRate);
                else if (b.shape === 'highshelf') c = designHighShelf(b.freq, b.gain * scale, b.q, sampleRate);
                else if (b.shape === 'notch') c = designNotch(b.freq, b.q, sampleRate);
                else c = designPeakingEQ(b.freq, b.gain * scale, b.q, sampleRate);
                totalDb += evaluateBiquadMagnitudeDb(c, freq, sampleRate);
              }
            }
            const x = freqToX(freq);
            const y = Math.max(padT, Math.min(padT + plotH, eqZeroY - totalDb * 4.5));
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.strokeStyle = '#E040FB';
          ctx.shadowColor = 'rgba(224,64,251,0.8)';
          ctx.shadowBlur = 8;
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }

      drawFrame(telemetryStore.getSnapshot());
    };

    const rebuildRef = useRef(rebuildStaticLayer);
    rebuildRef.current = rebuildStaticLayer;

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      return attachResizeObserver(canvas, (m) => {
        metricsRef.current = m;
        rebuildRef.current();
      });
    }, []);

    useEffect(() => {
      rebuildStaticLayer();
    }, [preAnalysis, postAnalysis, referenceAnalysis, chain, sampleRate, mode, waveformPeaks]);

    useEffect(() => {
      if (!allowLiveTelemetry) {
        drawFrame(telemetryStore.getSnapshot());
        return;
      }
      let pendingRaf = 0;
      let latestSnap = telemetryStore.getSnapshot();
      const unsub = telemetryStore.subscribe((snap) => {
        latestSnap = snap;
        if (modeRef.current === 'spectrogram' && snap.isPlaying && snap.live?.fftBins) {
          pushSpectroColumn(snap.live.fftBins);
        }
        if (pendingRaf) return;
        pendingRaf = requestAnimationFrame(() => {
          pendingRaf = 0;
          drawFrame(latestSnap);
        });
      });
      return () => {
        unsub();
        if (pendingRaf) cancelAnimationFrame(pendingRaf);
      };
    }, [allowLiveTelemetry]);

    const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const padL = 36;
      const padR = 14;
      const plotW = Math.max(1, rect.width - padL - padR);
      const x = Math.max(0, Math.min(plotW, e.clientX - rect.left - padL));
      const freqHz = Math.round(20 * Math.pow(20000 / 20, x / plotW));
      const normY = Math.max(0, Math.min(1, (e.clientY - rect.top - 12) / Math.max(1, rect.height - 34)));
      const db = Number((6 - normY * 74).toFixed(1));
      setHoverInfo({ freqHz, db });
    };

    const canSeek = Boolean(onSeek) && durationSec > 0 && waveformPeaks.length > 0 && mode !== 'spectrogram';
    const seekFromEvent = (e: React.PointerEvent<HTMLCanvasElement>) => {
      const fn = onSeekRef.current;
      const dur = durationSecRef.current;
      if (!fn || !(dur > 0)) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const padL = 36;
      const padR = 14;
      const plotW = Math.max(1, rect.width - padL - padR);
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left - padL) / plotW));
      fn(ratio * dur);
    };

    return (
      <div className="relative">
        <canvas
          ref={canvasRef}
          data-testid="spectrum-canvas"
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setHoverInfo(null)}
          onPointerDown={canSeek ? (e) => { seekDragRef.current = true; e.currentTarget.setPointerCapture(e.pointerId); seekFromEvent(e); } : undefined}
          onPointerMove={canSeek ? (e) => { if (seekDragRef.current) seekFromEvent(e); } : undefined}
          onPointerUp={canSeek ? (e) => { seekDragRef.current = false; e.currentTarget.releasePointerCapture?.(e.pointerId); } : undefined}
          onPointerCancel={canSeek ? () => { seekDragRef.current = false; } : undefined}
          title={canSeek ? 'Click or drag to move the playhead' : undefined}
          style={canSeek ? { touchAction: 'pan-y' } : undefined}
          className={`w-full ${heightClass} rounded border border-[#262934] ${canSeek ? 'cursor-ew-resize' : 'cursor-crosshair'} block`}
        />
        {hoverInfo && (
          <div className="pointer-events-none absolute top-2 right-3 px-2 py-0.5 rounded bg-[#070709]/85 border border-[#2EA8FF]/40 text-[11px] font-mono-tabular text-[#3FE0FF]">
            {hoverInfo.freqHz >= 1000
              ? `${(hoverInfo.freqHz / 1000).toFixed(2)} kHz`
              : `${hoverInfo.freqHz} Hz`}{' '}
            · {hoverInfo.db > 0 ? `+${hoverInfo.db}` : hoverInfo.db} dB
          </div>
        )}
      </div>
    );
  },
);

export const VectorscopeCanvas: React.FC<{
  channels?: Float32Array[];
}> = React.memo(({ channels }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const staticCacheRef = useRef<HTMLCanvasElement | null>(null);
  const metricsRef = useRef<CanvasMetrics>({ cssWidth: 0, cssHeight: 0, dpr: 1 });
  const channelsRef = useRef(channels);
  channelsRef.current = channels;

  const drawFrame = (snap: RuntimeTelemetryState) => {
    const canvas = canvasRef.current;
    const staticCache = staticCacheRef.current;
    if (!canvas || !staticCache) return;
    const { cssWidth: w, cssHeight: h, dpr } = metricsRef.current;
    if (w === 0 || h === 0 || staticCache.width === 0 || staticCache.height === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(staticCache, 0, 0);

    const ch = channelsRef.current;
    const live = snap.isPlaying ? snap.live : null;
    const left = live?.timeDomainL ?? ch?.[0];
    const right = live?.timeDomainR ?? ch?.[1] ?? ch?.[0];
    if (left && right && left.length > 0) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const cx = w * 0.5;
      const cy = h * 0.5;
      const radius = Math.min(cx, cy) - 14;
      const step = Math.max(1, Math.floor(left.length / 280));
      ctx.fillStyle = 'rgba(63, 224, 255, 0.8)';
      ctx.shadowColor = 'rgba(46, 168, 255, 0.9)';
      ctx.shadowBlur = 6;
      for (let i = 0; i < left.length; i += step) {
        const l = left[i];
        const r = right[i];
        const side = (l - r) * 0.707;
        const mid = (l + r) * 0.707;
        const x = cx - side * radius * 1.15;
        const y = cy - mid * radius * 1.15;
        ctx.fillRect(x, y, 1.8, 1.8);
      }
    }
  };

  const rebuildStaticLayer = () => {
    const { cssWidth: w, cssHeight: h, dpr } = metricsRef.current;
    if (w === 0 || h === 0) return;
    if (!staticCacheRef.current) {
      staticCacheRef.current = document.createElement('canvas');
    }
    const off = staticCacheRef.current;
    const targetW = Math.round(w * dpr);
    const targetH = Math.round(h * dpr);
    if (off.width !== targetW || off.height !== targetH) {
      off.width = targetW;
      off.height = targetH;
    }
    const ctx = off.getContext('2d');
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cx = w * 0.5;
    const cy = h * 0.5;
    const radius = Math.min(cx, cy) - 14;

    const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.6);
    bg.addColorStop(0, '#0A1A30');
    bg.addColorStop(1, '#03070F');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // Blue glowing scope circle
    ctx.save();
    ctx.strokeStyle = 'rgba(46, 168, 255, 0.85)';
    ctx.shadowColor = 'rgba(46, 168, 255, 0.9)';
    ctx.shadowBlur = 12;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = 'rgba(63, 224, 255, 0.18)';
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 0.5, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(46, 168, 255, 0.16)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - radius, cy);
    ctx.lineTo(cx + radius, cy);
    ctx.moveTo(cx, cy - radius);
    ctx.lineTo(cx, cy + radius);
    ctx.stroke();

    const diag = radius * 0.707;
    ctx.strokeStyle = 'rgba(139, 92, 246, 0.35)';
    ctx.beginPath();
    ctx.moveTo(cx - diag, cy + diag);
    ctx.lineTo(cx + diag, cy - diag);
    ctx.moveTo(cx - diag, cy - diag);
    ctx.lineTo(cx + diag, cy + diag);
    ctx.stroke();

    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.fillStyle = '#8FC8F0';
    ctx.fillText('M (+)', cx - 12, cy - radius - 3);
    ctx.fillText('L', cx - diag - 10, cy - diag);
    ctx.fillText('R', cx + diag + 4, cy - diag);

    drawFrame(telemetryStore.getSnapshot());
  };

  const rebuildRef = useRef(rebuildStaticLayer);
  rebuildRef.current = rebuildStaticLayer;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    return attachResizeObserver(canvas, (m) => {
      metricsRef.current = m;
      rebuildRef.current();
    });
  }, []);

  useEffect(() => {
    drawFrame(telemetryStore.getSnapshot());
  }, [channels]);

  useEffect(() => {
    let pendingRaf = 0;
    let latestSnap = telemetryStore.getSnapshot();
    const unsub = telemetryStore.subscribe((snap) => {
      latestSnap = snap;
      if (pendingRaf) return;
      pendingRaf = requestAnimationFrame(() => {
        pendingRaf = 0;
        drawFrame(latestSnap);
      });
    });
    return () => {
      unsub();
      if (pendingRaf) cancelAnimationFrame(pendingRaf);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      data-testid="vectorscope-canvas"
      className="syn-lab-canvas w-full h-56 rounded border border-[#262934] block"
    />
  );
});

export const LoudnessHistoryCanvas: React.FC<{
  preHistory: number[];
  postHistory: number[];
}> = React.memo(({ preHistory, postHistory }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const metricsRef = useRef<CanvasMetrics>({ cssWidth: 0, cssHeight: 0, dpr: 1 });

  const draw = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { cssWidth: w, cssHeight: h, dpr } = metricsRef.current;
    if (w === 0 || h === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#050B16';
    ctx.fillRect(0, 0, w, h);

    const dbToY = (lufs: number) => {
      const c = Math.max(-42, Math.min(-2, lufs));
      return 12 + ((-2 - c) / 40) * (h - 28);
    };

    for (const ref of [-9, -14, -23, -32]) {
      const y = dbToY(ref);
      ctx.strokeStyle = ref === -14 ? 'rgba(63,224,255,0.35)' : 'rgba(46,168,255,0.1)';
      ctx.beginPath();
      ctx.moveTo(34, y);
      ctx.lineTo(w - 8, y);
      ctx.stroke();
      ctx.fillStyle = '#6F9CC4';
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.fillText(`${ref}`, 4, y + 3);
    }

    const plotLine = (vals: number[], color: string, dashed: boolean) => {
      if (vals.length < 2) return;
      ctx.save();
      if (dashed) ctx.setLineDash([4, 4]);
      ctx.beginPath();
      for (let i = 0; i < vals.length; i++) {
        const x = 36 + (i / (vals.length - 1)) * (w - 46);
        const y = dbToY(vals[i]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    };

    plotLine(preHistory, 'rgba(139,92,246,0.7)', true);
    plotLine(postHistory, '#3FE0FF', false);
  };

  const drawRef = useRef(draw);
  drawRef.current = draw;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    return attachResizeObserver(canvas, (m) => {
      metricsRef.current = m;
      drawRef.current();
    });
  }, []);

  useEffect(() => {
    draw();
  }, [preHistory, postHistory]);

  return (
    <canvas
      ref={canvasRef}
      data-testid="loudness-history-canvas"
      className="syn-lab-canvas w-full h-48 rounded border border-[#262934] block"
    />
  );
});
