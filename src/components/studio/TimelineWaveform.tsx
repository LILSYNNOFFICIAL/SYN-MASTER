import React, { useCallback, useEffect, useRef, useState } from 'react';
import { telemetryStore } from '../../engine/telemetryStore';
import { fadeGain, type FadeSettings } from '../../dsp/fades';

interface Props {
  prePeaks: number[];
  postPeaks: number[] | null;
  durationSec: number;
  showPost: boolean;
  fades: FadeSettings;
  onFadesChange: (next: FadeSettings) => void;
  onSeek: (sec: number) => void;
  heightPx?: number;
}

const RULER_H = 22;
const HANDLE_R = 7;

function niceStep(durationSec: number, widthPx: number): number {
  const target = durationSec / Math.max(1, widthPx / 90);
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  return steps.find((s) => s >= target) ?? 600;
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(s % 1 ? 1 : 0)}`;
}

/**
 * Waveform with a time ruler and grid, original vs mastered overlay, a playhead and
 * FL Studio style fade-in / fade-out handles: drag the gold squares at the top corners.
 */
export const TimelineWaveform: React.FC<Props> = ({
  prePeaks,
  postPeaks,
  durationSec,
  showPost,
  fades,
  onFadesChange,
  onSeek,
  heightPx = 220,
}) => {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const playheadRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(800);
  const dragRef = useRef<null | 'in' | 'out' | 'seek'>(null);
  const lastSeekRef = useRef(0);
  const fadesRef = useRef(fades);
  fadesRef.current = fades;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(200, el.clientWidth)));
    ro.observe(el);
    setWidth(Math.max(200, el.clientWidth));
    return () => ro.disconnect();
  }, []);

  // Draw
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const h = heightPx;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, h);

    // Background
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#071222');
    bg.addColorStop(1, '#03070F');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, h);

    const top = RULER_H;
    const waveH = h - RULER_H;
    const mid = top + waveH / 2;

    // Grid + ruler
    const step = niceStep(durationSec, width);
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textBaseline = 'middle';
    for (let t = 0; t <= durationSec + 1e-6; t += step) {
      const x = (t / durationSec) * width;
      ctx.strokeStyle = 'rgba(46,168,255,0.10)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, top);
      ctx.lineTo(Math.round(x) + 0.5, h);
      ctx.stroke();
      // minor ticks
      for (let k = 1; k < 4; k++) {
        const xm = ((t + (k * step) / 4) / durationSec) * width;
        if (xm > width) break;
        ctx.strokeStyle = 'rgba(63,224,255,0.25)';
        ctx.beginPath();
        ctx.moveTo(Math.round(xm) + 0.5, RULER_H - 5);
        ctx.lineTo(Math.round(xm) + 0.5, RULER_H);
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(63,224,255,0.6)';
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, RULER_H - 10);
      ctx.lineTo(Math.round(x) + 0.5, RULER_H);
      ctx.stroke();
      if (x < width - 24) {
        ctx.fillStyle = '#8FC9F2';
        ctx.fillText(fmt(t), x + 4, RULER_H / 2 - 1);
      }
    }
    ctx.strokeStyle = 'rgba(46,168,255,0.4)';
    ctx.beginPath();
    ctx.moveTo(0, RULER_H + 0.5);
    ctx.lineTo(width, RULER_H + 0.5);
    ctx.stroke();
    // amplitude grid (-6 dB lines and center)
    for (const g of [0.5, 1]) {
      const dy = (waveH / 2 - 6) * g;
      ctx.strokeStyle = g === 1 ? 'rgba(46,168,255,0.08)' : 'rgba(46,168,255,0.06)';
      ctx.setLineDash([3, 5]);
      ctx.beginPath();
      ctx.moveTo(0, mid - dy);
      ctx.lineTo(width, mid - dy);
      ctx.moveTo(0, mid + dy);
      ctx.lineTo(width, mid + dy);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(63,224,255,0.22)';
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(width, mid);
    ctx.stroke();

    const drawPeaks = (peaks: number[], fill: string | CanvasGradient) => {
      if (!peaks.length) return;
      const amp = waveH / 2 - 6;
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.moveTo(0, mid);
      for (let i = 0; i < peaks.length; i++) {
        const x = (i / (peaks.length - 1)) * width;
        ctx.lineTo(x, mid - Math.min(1, peaks[i]) * amp);
      }
      for (let i = peaks.length - 1; i >= 0; i--) {
        const x = (i / (peaks.length - 1)) * width;
        ctx.lineTo(x, mid + Math.min(1, peaks[i]) * amp);
      }
      ctx.closePath();
      ctx.fill();
    };

    const preFill = ctx.createLinearGradient(0, top, 0, h);
    preFill.addColorStop(0, 'rgba(90,120,170,0.35)');
    preFill.addColorStop(0.5, 'rgba(60,90,140,0.55)');
    preFill.addColorStop(1, 'rgba(90,120,170,0.35)');
    drawPeaks(prePeaks, preFill);
    if (showPost && postPeaks && postPeaks.length) {
      const postFill = ctx.createLinearGradient(0, top, 0, h);
      postFill.addColorStop(0, 'rgba(63,224,255,0.9)');
      postFill.addColorStop(0.5, 'rgba(46,120,255,0.8)');
      postFill.addColorStop(1, 'rgba(63,224,255,0.9)');
      ctx.shadowColor = 'rgba(46,168,255,0.85)';
      ctx.shadowBlur = 10;
      ctx.globalAlpha = 0.85;
      drawPeaks(postPeaks, postFill);
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
    }

    // Fade overlays
    const inX = (fades.inSec / durationSec) * width;
    const outX = width - (fades.outSec / durationSec) * width;
    ctx.fillStyle = 'rgba(2,6,14,0.6)';
    if (inX > 1) {
      ctx.beginPath();
      ctx.moveTo(0, top);
      for (let i = 0; i <= 40; i++) {
        const x = (i / 40) * inX;
        ctx.lineTo(x, h - fadeGain(i / 40, fades.inCurve) * waveH);
      }
      ctx.lineTo(0, h);
      ctx.closePath();
      ctx.fill();
    }
    if (outX < width - 1) {
      ctx.beginPath();
      ctx.moveTo(width, top);
      for (let i = 0; i <= 40; i++) {
        const x = width - (i / 40) * (width - outX);
        ctx.lineTo(x, h - fadeGain(i / 40, fades.outCurve) * waveH);
      }
      ctx.lineTo(width, h);
      ctx.closePath();
      ctx.fill();
    }
    ctx.strokeStyle = '#E040FB';
    ctx.lineWidth = 2;
    ctx.shadowColor = 'rgba(224,64,251,0.9)';
    ctx.shadowBlur = 8;
    if (inX > 1) {
      ctx.beginPath();
      for (let i = 0; i <= 40; i++) {
        const x = (i / 40) * inX;
        const y = h - fadeGain(i / 40, fades.inCurve) * waveH;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    if (outX < width - 1) {
      ctx.beginPath();
      for (let i = 0; i <= 40; i++) {
        const x = width - (i / 40) * (width - outX);
        const y = h - fadeGain(i / 40, fades.outCurve) * waveH;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
    // handles (FL-style fade knobs at the top corners)
    const handle = (x: number) => {
      ctx.shadowColor = 'rgba(63,224,255,0.95)';
      ctx.shadowBlur = 10;
      ctx.fillStyle = '#3FE0FF';
      ctx.strokeStyle = '#02060C';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, top + 2 + HANDLE_R, HANDLE_R, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.shadowBlur = 0;
    };
    handle(Math.max(HANDLE_R, inX));
    handle(Math.min(width - HANDLE_R, outX));
  }, [prePeaks, postPeaks, showPost, durationSec, fades, width, heightPx]);

  // Playhead
  useEffect(() => {
    const update = (sec: number) => {
      if (!playheadRef.current || durationSec <= 0) return;
      playheadRef.current.style.transform = `translateX(${Math.max(0, Math.min(1, sec / durationSec)) * width}px)`;
    };
    update(telemetryStore.getSnapshot().currentTimeSec);
    return telemetryStore.subscribe((snap) => update(snap.currentTimeSec));
  }, [durationSec, width]);

  const xToSec = useCallback(
    (clientX: number) => {
      const rect = wrapRef.current!.getBoundingClientRect();
      return Math.max(0, Math.min(durationSec, ((clientX - rect.left) / rect.width) * durationSec));
    },
    [durationSec],
  );

  const onPointerDown = (e: React.PointerEvent) => {
    const rect = wrapRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const inX = Math.max(HANDLE_R, (fades.inSec / durationSec) * rect.width);
    const outX = Math.min(rect.width - HANDLE_R, rect.width - (fades.outSec / durationSec) * rect.width);
    const nearTop = y >= RULER_H - 4 && y <= RULER_H + HANDLE_R * 2 + 8;
    if (nearTop && Math.abs(x - inX) <= HANDLE_R + 5) dragRef.current = 'in';
    else if (nearTop && Math.abs(x - outX) <= HANDLE_R + 5) dragRef.current = 'out';
    else {
      dragRef.current = 'seek';
      lastSeekRef.current = performance.now();
      onSeek(xToSec(e.clientX));
    }
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const sec = xToSec(e.clientX);
    if (dragRef.current === 'seek') {
      // Move the playhead immediately, restart audio at most every 80 ms while scrubbing.
      telemetryStore.publish({ currentTimeSec: sec });
      const now = performance.now();
      if (now - lastSeekRef.current > 80) {
        lastSeekRef.current = now;
        onSeek(sec);
      }
      return;
    }
    const f = fadesRef.current;
    const maxLen = durationSec * 0.5;
    if (dragRef.current === 'in') onFadesChange({ ...f, inSec: Number(Math.min(maxLen, sec).toFixed(2)) });
    else onFadesChange({ ...f, outSec: Number(Math.min(maxLen, durationSec - sec).toFixed(2)) });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (dragRef.current === 'seek') onSeek(xToSec(e.clientX));
    dragRef.current = null;
  };
  const onPointerCancel = () => {
    dragRef.current = null;
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const now = telemetryStore.getSnapshot().currentTimeSec;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      onSeek(Math.max(0, Math.min(durationSec, now + (e.key === 'ArrowRight' ? 5 : -5))));
    } else if (e.key === 'Home') {
      e.preventDefault();
      onSeek(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      onSeek(Math.max(0, durationSec - 0.05));
    }
  };

  return (
    <div
      ref={wrapRef}
      className="syn2-wave"
      style={{ height: heightPx }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onKeyDown={onKeyDown}
      role="slider"
      aria-label="Track timeline: click to seek, drag the glowing corner handles to set fade-in and fade-out"
      aria-valuemin={0}
      aria-valuemax={durationSec}
      tabIndex={0}
    >
      <canvas ref={canvasRef} />
      <div ref={playheadRef} className="syn2-playhead" aria-hidden="true" />
    </div>
  );
};
