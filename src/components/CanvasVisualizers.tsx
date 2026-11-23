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
        ctx.strokeStyle = '#F2CA52';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(px, 0);
        ctx.lineTo(px, h);
        ctx.stroke();

        ctx.fillStyle = '#F2CA52';
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

      ctx.fillStyle = '#090A0E';
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
        ctx.fillStyle = 'rgba(212, 175, 55, 0.11)';
        ctx.fillRect(lx1, 0, Math.max(2, lx2 - lx1), h);
        ctx.strokeStyle = 'rgba(242, 202, 82, 0.55)';
        ctx.beginPath();
        ctx.moveTo(lx1, 0);
        ctx.lineTo(lx1, h);
        ctx.moveTo(lx2, 0);
        ctx.lineTo(lx2, h);
        ctx.stroke();
      }

      if (prePeaks.length > 0) {
        const barW = w / prePeaks.length;
        ctx.fillStyle =
          showPostOverlay && postPeaks ? 'rgba(180, 188, 202, 0.28)' : 'rgba(212, 175, 55, 0.78)';
        for (let i = 0; i < prePeaks.length; i++) {
          const amp = Math.min(1, prePeaks[i]) * (h * 0.44);
          const x = i * barW;
          ctx.fillRect(x, midY - amp, Math.max(1, barW - 0.6), Math.max(1.5, amp * 2));
        }
      }

      if (showPostOverlay && postPeaks && postPeaks.length > 0) {
        const barW = w / postPeaks.length;
        ctx.fillStyle = 'rgba(212, 175, 55, 0.85)';
        for (let i = 0; i < postPeaks.length; i++) {
          const amp = Math.min(1, postPeaks[i]) * (h * 0.44);
          const x = i * barW;
          ctx.fillRect(x, midY - amp, Math.max(1, barW - 0.8), Math.max(1.5, amp * 2));
        }
      }

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
}

const SPECTRO_COLS = 160;

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
  }) => {
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

    // Pre-allocated scratch buffers for live FFT curve coordinates
    const liveXRef = useRef<Float32Array>(new Float32Array(0));
    const liveYRef = useRef<Float32Array>(new Float32Array(0));

    const modeRef = useRef(mode);
    modeRef.current = mode;
    const sampleRateRef = useRef(sampleRate);
    sampleRateRef.current = sampleRate;
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
      const minF = 24;
      const maxF = 20000;
      const logSpan = Math.log10(maxF / minF);
      const sr = sampleRateRef.current;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      if (modeRef.current === 'spectrogram') {
        const ring = ringRef.current;
        if (ring.count > 1) {
          const cols = ring.count;
          const colW = plotW / cols;
          const startIdx = ring.count < SPECTRO_COLS ? 0 : ring.head;
          for (let c = 0; c < cols; c++) {
            const rowIdx = (startIdx + c) % SPECTRO_COLS;
            const bins = ring.rows[rowIdx];
            const binHz = sr / (bins.length * 2);
            for (let y = 0; y < plotH; y += 3) {
              const normY = 1 - y / plotH;
              const freq = minF * Math.pow(maxF / minF, normY);
              const binIdx = Math.min(bins.length - 1, Math.max(0, Math.round(freq / binHz)));
              const val = bins[binIdx] / 255;
              if (val > 0.05) {
                const r = Math.round(val * 242);
                const g = Math.round(val * val * 195);
                const b = Math.round(val * 55);
                ctx.fillStyle = `rgb(${r},${g},${b})`;
                ctx.fillRect(padL + c * colW, padT + y, Math.ceil(colW) + 1, 3);
              }
            }
          }
        }
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
          ctx.fillStyle = 'rgba(242, 202, 82, 0.08)';
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
      const minF = 24;
      const maxF = 20000;
      const freqToX = (f: number) =>
        padL + (Math.log10(Math.max(minF, Math.min(maxF, f)) / minF) / Math.log10(maxF / minF)) * plotW;
      const dbToY = (db: number) => {
        const clamped = Math.max(-68, Math.min(6, db));
        return padT + ((6 - clamped) / 74) * plotH;
      };

      ctx.fillStyle = '#090A0E';
      ctx.fillRect(0, 0, w, h);

      if (mode === 'spectrogram' && (postAnalysis ?? preAnalysis)) {
        const src = (postAnalysis ?? preAnalysis)!;
        for (let x = 0; x < plotW; x += 4) {
          const ratio = x / plotW;
          const idx = Math.min(src.spectrumBinsDb.length - 1, Math.floor(ratio * src.spectrumBinsDb.length));
          const norm = Math.max(0, Math.min(1, (src.spectrumBinsDb[idx] + 72) / 68));
          ctx.fillStyle = `rgba(212, 175, 55, ${norm * 0.25})`;
          ctx.fillRect(padL + x, padT + (1 - norm) * plotH, 3, norm * plotH);
        }
      }

      const freqMarkers = [30, 60, 100, 250, 500, 1000, 2000, 5000, 10000, 16000];
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      for (const fm of freqMarkers) {
        const x = freqToX(fm);
        ctx.strokeStyle = 'rgba(255,255,255,0.06)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, padT);
        ctx.lineTo(x, padT + plotH);
        ctx.stroke();

        ctx.fillStyle = '#7B8291';
        ctx.fillText(fm >= 1000 ? `${fm / 1000}k` : `${fm}`, x, h - 6);
      }

      const dbMarkers = [0, -12, -24, -36, -48, -60];
      ctx.textAlign = 'right';
      for (const dm of dbMarkers) {
        const y = dbToY(dm);
        ctx.strokeStyle = dm === 0 ? 'rgba(212, 175, 55, 0.25)' : 'rgba(255,255,255,0.06)';
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(padL + plotW, y);
        ctx.stroke();
        ctx.fillStyle = '#7B8291';
        ctx.fillText(`${dm}`, padL - 5, y + 3);
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
          ctx.stroke();

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
            'rgba(212, 175, 55, 0.48)',
            undefined,
            true,
          );
        }

        if (postAnalysis) {
          drawSpectrumCurve(
            postAnalysis.spectrumBinsFreq,
            postAnalysis.spectrumBinsDb,
            '#D4AF37',
            'rgba(212, 175, 55, 0.14)',
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
          ctx.strokeStyle = '#F2CA52';
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
    }, [preAnalysis, postAnalysis, referenceAnalysis, chain, sampleRate, mode]);

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
      const freqHz = Math.round(24 * Math.pow(20000 / 24, x / plotW));
      const normY = Math.max(0, Math.min(1, (e.clientY - rect.top - 12) / Math.max(1, rect.height - 34)));
      const db = Number((6 - normY * 74).toFixed(1));
      setHoverInfo({ freqHz, db });
    };

    return (
      <div className="relative">
        <canvas
          ref={canvasRef}
          data-testid="spectrum-canvas"
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setHoverInfo(null)}
          className={`w-full ${heightClass} rounded border border-[#262934] cursor-crosshair block`}
        />
        {hoverInfo && (
          <div className="pointer-events-none absolute top-2 right-3 px-2 py-0.5 rounded bg-[#070709]/85 border border-[#D4AF37]/30 text-[11px] font-mono-tabular text-[#F2CA52]">
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
      ctx.fillStyle = 'rgba(242, 202, 82, 0.7)';
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

    ctx.fillStyle = '#090A0E';
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.moveTo(cx - radius, cy);
    ctx.lineTo(cx + radius, cy);
    ctx.moveTo(cx, cy - radius);
    ctx.lineTo(cx, cy + radius);
    ctx.stroke();

    const diag = radius * 0.707;
    ctx.strokeStyle = 'rgba(212, 175, 55, 0.16)';
    ctx.beginPath();
    ctx.moveTo(cx - diag, cy + diag);
    ctx.lineTo(cx + diag, cy - diag);
    ctx.moveTo(cx - diag, cy - diag);
    ctx.lineTo(cx + diag, cy + diag);
    ctx.stroke();

    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.fillStyle = '#9CA3AF';
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
      className="w-full h-56 rounded border border-[#262934] block"
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
    ctx.fillStyle = '#090A0E';
    ctx.fillRect(0, 0, w, h);

    const dbToY = (lufs: number) => {
      const c = Math.max(-42, Math.min(-2, lufs));
      return 12 + ((-2 - c) / 40) * (h - 28);
    };

    for (const ref of [-9, -14, -23, -32]) {
      const y = dbToY(ref);
      ctx.strokeStyle = ref === -14 ? 'rgba(212,175,55,0.28)' : 'rgba(255,255,255,0.07)';
      ctx.beginPath();
      ctx.moveTo(34, y);
      ctx.lineTo(w - 8, y);
      ctx.stroke();
      ctx.fillStyle = '#7B8291';
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

    plotLine(preHistory, 'rgba(180,188,202,0.5)', true);
    plotLine(postHistory, '#D4AF37', false);
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
      className="w-full h-48 rounded border border-[#262934] block"
    />
  );
});
