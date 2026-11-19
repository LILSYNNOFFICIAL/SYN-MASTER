import React, { useEffect, useRef, useState } from 'react';
import type { AudioAnalysis, ParametricEQParams, ProcessorModule } from '../types/mastering';
import type { LiveMeterSnapshot } from '../engine/audioEngine';
import {
  designHighPass,
  designHighShelf,
  designLowPass,
  designLowShelf,
  designNotch,
  designPeakingEQ,
  evaluateBiquadMagnitudeDb,
} from '../dsp/biquad';

interface WaveformProps {
  prePeaks: number[];
  postPeaks: number[] | null;
  durationSec: number;
  currentTimeSec: number;
  loopEnabled: boolean;
  loopStartSec: number;
  loopEndSec: number;
  showPostOverlay: boolean;
  onSeek: (sec: number) => void;
}

export const WaveformTimelineCanvas: React.FC<WaveformProps> = ({
  prePeaks,
  postPeaks,
  durationSec,
  currentTimeSec,
  loopEnabled,
  loopStartSec,
  loopEndSec,
  showPostOverlay,
  onSeek,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.scale(dpr, dpr);
    const w = rect.width;
    const h = rect.height;
    const midY = h * 0.5;

    ctx.fillStyle = '#090A0E';
    ctx.fillRect(0, 0, w, h);

    // Grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = (h / 4) * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // Loop region highlight
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

    // Pre-master waveform (muted silver)
    if (prePeaks.length > 0) {
      const barW = w / prePeaks.length;
      ctx.fillStyle = showPostOverlay && postPeaks ? 'rgba(180, 188, 202, 0.28)' : 'rgba(212, 175, 55, 0.78)';
      for (let i = 0; i < prePeaks.length; i++) {
        const amp = Math.min(1, prePeaks[i]) * (h * 0.44);
        const x = i * barW;
        ctx.fillRect(x, midY - amp, Math.max(1, barW - 0.6), Math.max(1.5, amp * 2));
      }
    }

    // Post-master waveform overlay (brushed gold)
    if (showPostOverlay && postPeaks && postPeaks.length > 0) {
      const barW = w / postPeaks.length;
      ctx.fillStyle = 'rgba(212, 175, 55, 0.85)';
      for (let i = 0; i < postPeaks.length; i++) {
        const amp = Math.min(1, postPeaks[i]) * (h * 0.44);
        const x = i * barW;
        ctx.fillRect(x, midY - amp, Math.max(1, barW - 0.8), Math.max(1.5, amp * 2));
      }
    }

    // Center zero line
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(w, midY);
    ctx.stroke();

    // Playhead
    if (durationSec > 0) {
      const px = Math.max(0, Math.min(w, (currentTimeSec / durationSec) * w));
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
  }, [prePeaks, postPeaks, durationSec, currentTimeSec, loopEnabled, loopStartSec, loopEndSec, showPostOverlay]);

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
};

interface SpectrumCanvasProps {
  preAnalysis: AudioAnalysis | null;
  postAnalysis: AudioAnalysis | null;
  referenceAnalysis?: AudioAnalysis | null;
  chain: ProcessorModule[];
  liveTelemetry: LiveMeterSnapshot | null;
  sampleRate: number;
  mode: 'spectrum' | 'spectrogram';
  heightClass?: string;
}

export const SpectrumAndEQCanvas: React.FC<SpectrumCanvasProps> = ({
  preAnalysis,
  postAnalysis,
  referenceAnalysis,
  chain,
  liveTelemetry,
  sampleRate,
  mode,
  heightClass = 'h-60',
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const spectroHistoryRef = useRef<Uint8Array[]>([]);
  const [hoverInfo, setHoverInfo] = useState<{ freqHz: number; db: number } | null>(null);

  useEffect(() => {
    if (mode === 'spectrogram' && liveTelemetry?.fftBins) {
      spectroHistoryRef.current.push(new Uint8Array(liveTelemetry.fftBins));
      if (spectroHistoryRef.current.length > 160) {
        spectroHistoryRef.current.shift();
      }
    }
  }, [liveTelemetry, mode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;
    const padL = 36;
    const padR = 14;
    const padT = 12;
    const padB = 22;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    ctx.fillStyle = '#090A0E';
    ctx.fillRect(0, 0, w, h);

    const minF = 24;
    const maxF = 20000;
    const freqToX = (f: number) =>
      padL + (Math.log10(Math.max(minF, Math.min(maxF, f)) / minF) / Math.log10(maxF / minF)) * plotW;

    if (mode === 'spectrogram') {
      // Render STFT Spectrogram Waterfall (or static spectrum heatmap when paused)
      const cols = Math.max(1, spectroHistoryRef.current.length);
      if (cols > 1) {
        const colW = plotW / cols;
        for (let c = 0; c < cols; c++) {
          const bins = spectroHistoryRef.current[c];
          const binHz = sampleRate / (bins.length * 2);
          for (let y = 0; y < plotH; y += 2) {
            const normY = 1 - y / plotH;
            const freq = minF * Math.pow(maxF / minF, normY);
            const binIdx = Math.min(bins.length - 1, Math.max(0, Math.round(freq / binHz)));
            const val = bins[binIdx] / 255;
            if (val > 0.04) {
              const r = Math.round(val * 242);
              const g = Math.round(val * val * 195);
              const b = Math.round(val * 55);
              ctx.fillStyle = `rgb(${r},${g},${b})`;
              ctx.fillRect(padL + c * colW, padT + y, Math.ceil(colW) + 1, 2);
            }
          }
        }
      } else if (postAnalysis ?? preAnalysis) {
        // Draw static spectral density heatmap bar across time when not playing
        const src = postAnalysis ?? preAnalysis!;
        for (let x = 0; x < plotW; x += 4) {
          const ratio = x / plotW;
          const idx = Math.min(src.spectrumBinsDb.length - 1, Math.floor(ratio * src.spectrumBinsDb.length));
          const norm = Math.max(0, Math.min(1, (src.spectrumBinsDb[idx] + 72) / 68));
          ctx.fillStyle = `rgba(212, 175, 55, ${norm * 0.45})`;
          ctx.fillRect(padL + x, padT + (1 - norm) * plotH, 3, norm * plotH);
        }
      }
    }

    // Frequency & dB grid
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
    const dbToY = (db: number) => {
      const clamped = Math.max(-68, Math.min(6, db));
      return padT + ((6 - clamped) / 74) * plotH;
    };

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

      // Pre-master baseline
      if (preAnalysis) {
        drawSpectrumCurve(
          preAnalysis.spectrumBinsFreq,
          preAnalysis.spectrumBinsDb,
          'rgba(200, 206, 218, 0.45)',
          undefined,
          true,
        );
      }

      // Reference overlay
      if (referenceAnalysis) {
        drawSpectrumCurve(
          referenceAnalysis.spectrumBinsFreq,
          referenceAnalysis.spectrumBinsDb,
          'rgba(52, 211, 153, 0.72)',
          undefined,
          true,
        );
      }

      // Post-master analyzed curve
      if (postAnalysis) {
        drawSpectrumCurve(
          postAnalysis.spectrumBinsFreq,
          postAnalysis.spectrumBinsDb,
          '#D4AF37',
          'rgba(212, 175, 55, 0.14)',
        );
      }

      // Live real-time FFT overlay while playing
      if (liveTelemetry?.fftBins && liveTelemetry.fftBins.length > 0) {
        const bins = liveTelemetry.fftBins;
        const binHz = sampleRate / (bins.length * 2);
        const liveFreqs: number[] = [];
        const liveDbs: number[] = [];
        for (let i = 1; i < bins.length; i++) {
          const f = i * binHz;
          if (f >= minF && f <= maxF) {
            liveFreqs.push(f);
            liveDbs.push(-66 + (bins[i] / 255) * 66);
          }
        }
        drawSpectrumCurve(liveFreqs, liveDbs, 'rgba(247, 248, 250, 0.9)', 'rgba(242, 202, 82, 0.08)');
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
  }, [preAnalysis, postAnalysis, referenceAnalysis, chain, liveTelemetry, sampleRate, mode]);

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
};

export const VectorscopeCanvas: React.FC<{
  liveTelemetry: LiveMeterSnapshot | null;
  channels?: Float32Array[];
}> = ({ liveTelemetry, channels }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;
    const cx = w * 0.5;
    const cy = h * 0.5;
    const radius = Math.min(cx, cy) - 14;

    ctx.fillStyle = '#090A0E';
    ctx.fillRect(0, 0, w, h);

    // Polar goniometer axes
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.moveTo(cx - radius, cy);
    ctx.lineTo(cx + radius, cy);
    ctx.moveTo(cx, cy - radius);
    ctx.lineTo(cx, cy + radius);
    ctx.stroke();

    // L / R 45-degree guide lines
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

    // Draw real L/R samples rotated into Mid/Side vector space
    const left = liveTelemetry?.timeDomainL ?? channels?.[0];
    const right = liveTelemetry?.timeDomainR ?? channels?.[1] ?? channels?.[0];
    if (left && right && left.length > 0) {
      const step = Math.max(1, Math.floor(left.length / 450));
      ctx.fillStyle = 'rgba(242, 202, 82, 0.65)';
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
  }, [liveTelemetry, channels]);

  return (
    <canvas
      ref={canvasRef}
      data-testid="vectorscope-canvas"
      className="w-full h-56 rounded border border-[#262934] block"
    />
  );
};

export const LoudnessHistoryCanvas: React.FC<{
  preHistory: number[];
  postHistory: number[];
}> = ({ preHistory, postHistory }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;
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
  }, [preHistory, postHistory]);

  return (
    <canvas
      ref={canvasRef}
      data-testid="loudness-history-canvas"
      className="w-full h-48 rounded border border-[#262934] block"
    />
  );
};
