import React, { useEffect, useRef } from 'react';
import { telemetryStore } from '../../engine/telemetryStore';

/**
 * Real-time spectrum bars from the playback analyser (telemetryStore.live.fftBins, the same
 * AnalyserNode the meters use). Log-frequency bars, blue to magenta glow. Idle (flat, labelled)
 * when nothing is playing, so it never shows invented motion.
 */
export const LiveSpectrum: React.FC<{ bars?: number; height?: number; className?: string; sampleRate?: number }> = ({
  bars = 40,
  height = 64,
  className = '',
  sampleRate = 48000,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const idleRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const smooth = new Float32Array(bars);
    const draw = (bins: Uint8Array | null, playing: boolean) => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth || 300;
      const h = height;
      if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr);
      if (canvas.height !== Math.round(h * dpr)) canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const n = bins?.length ?? 0;
      const nyq = ((bins && bins.length ? telemetryStore.getSnapshot().live?.sampleRate : null) ?? sampleRate) / 2;
      const grad = ctx.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, '#2EA8FF');
      grad.addColorStop(0.5, '#3FE0FF');
      grad.addColorStop(0.8, '#8B5CF6');
      grad.addColorStop(1, '#E040FB');
      ctx.fillStyle = grad;
      ctx.shadowColor = 'rgba(46,168,255,0.9)';
      ctx.shadowBlur = 8;
      const gap = 2;
      const bw = Math.max(1, w / bars - gap);
      for (let i = 0; i < bars; i++) {
        let v = 0;
        if (bins && n && playing) {
          const f0 = 30 * Math.pow(16000 / 30, i / bars);
          const f1 = 30 * Math.pow(16000 / 30, (i + 1) / bars);
          const a = Math.max(0, Math.floor((f0 / nyq) * n));
          const b = Math.min(n, Math.max(a + 1, Math.ceil((f1 / nyq) * n)));
          for (let k = a; k < b; k++) if (bins[k] > v) v = bins[k];
          v /= 255;
        }
        smooth[i] = playing ? Math.max(v, smooth[i] * 0.82) : smooth[i] * 0.8;
        const bh = Math.max(1.5, smooth[i] * (h - 4));
        ctx.fillRect(i * (bw + gap), h - bh, bw, bh);
      }
      if (idleRef.current) idleRef.current.style.opacity = playing ? '0' : '1';
    };
    const snap = telemetryStore.getSnapshot();
    draw(snap.live?.fftBins ?? null, snap.isPlaying);
    return telemetryStore.subscribe((s) => draw(s.live?.fftBins ?? null, s.isPlaying && Boolean(s.live)));
  }, [bars, height, sampleRate]);

  return (
    <div className={`syn-livespec ${className}`} style={{ position: 'relative', height }}>
      <canvas ref={canvasRef} style={{ width: '100%', height, display: 'block' }} aria-hidden="true" />
      <span ref={idleRef} className="syn-livespec-idle">Press play to see the live signal</span>
    </div>
  );
};
