import React, { useEffect, useRef } from 'react';
import type { AudioAnalysis } from '../../types/mastering';
import { telemetryStore } from '../../engine/telemetryStore';

/**
 * QC live loudness: the measured short-term LUFS timeline (analyzer `loudnessHistoryLufs`,
 * BS.1770 K-weighted) of the source and the rendered master, with a playhead that follows
 * playback. The "Now" readout is the master's measured short-term LUFS at the playhead, so it
 * updates in real time while playing; the live sample peak comes from the playback analyser.
 * Click or drag the graph to seek. Everything shown is measured; nothing is simulated.
 */
interface Props {
  pre: AudioAnalysis;
  post: AudioAnalysis | null;
  durationSec: number;
  targetLufs?: number;
  maxTruePeakDb?: number;
  onSeek?: (sec: number) => void;
}

const LO = -40;
const HI = -4;

function historyAt(h: number[], ratio: number): number | null {
  if (!h || h.length === 0) return null;
  const x = Math.max(0, Math.min(h.length - 1, ratio * h.length - 0.5));
  const i0 = Math.floor(x);
  const i1 = Math.min(h.length - 1, i0 + 1);
  return h[i0] + (h[i1] - h[i0]) * (x - i0);
}

const fmt = (v: number | null | undefined, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(d));

export const LiveLoudnessPanel: React.FC<Props> = ({ pre, post, durationSec, targetLufs, maxTruePeakDb, onSeek }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const nowRef = useRef<HTMLSpanElement | null>(null);
  const peakRef = useRef<HTMLSpanElement | null>(null);
  const timeRef = useRef<HTMLSpanElement | null>(null);
  const dragRef = useRef(false);
  const active = post ?? pre;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const draw = (sec: number, playing: boolean, peakDb: number | null) => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth || 600;
      const h = canvas.clientHeight || 180;
      if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr);
      if (canvas.height !== Math.round(h * dpr)) canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const padL = 34, padR = 10, padT = 10, padB = 18;
      const pw = w - padL - padR;
      const ph = h - padT - padB;
      const yOf = (l: number) => padT + (1 - (Math.max(LO, Math.min(HI, l)) - LO) / (HI - LO)) * ph;
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.textAlign = 'right';
      for (const g of [-36, -30, -24, -18, -14, -9, -6]) {
        const y = Math.round(yOf(g)) + 0.5;
        ctx.strokeStyle = 'rgba(46,168,255,0.12)';
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + pw, y); ctx.stroke();
        ctx.fillStyle = '#6F9CC4';
        ctx.fillText(String(g), padL - 4, y + 3);
      }
      if (targetLufs !== undefined) {
        const y = Math.round(yOf(targetLufs)) + 0.5;
        ctx.save();
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = 'rgba(224,64,251,0.8)';
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + pw, y); ctx.stroke();
        ctx.restore();
        ctx.textAlign = 'left';
        ctx.fillStyle = '#E040FB';
        ctx.fillText(`target ${targetLufs}`, padL + 4, y - 4);
      }
      const line = (hist: number[], stroke: string, glow: string, dashed: boolean, fill: boolean) => {
        if (!hist || hist.length < 2) return;
        ctx.save();
        if (dashed) ctx.setLineDash([4, 4]);
        ctx.beginPath();
        hist.forEach((v, i) => {
          const x = padL + ((i + 0.5) / hist.length) * pw;
          const y = yOf(v);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.strokeStyle = stroke;
        ctx.lineWidth = dashed ? 1.2 : 2;
        ctx.shadowColor = glow;
        ctx.shadowBlur = dashed ? 0 : 10;
        ctx.stroke();
        if (fill) {
          ctx.lineTo(padL + ((hist.length - 0.5) / hist.length) * pw, padT + ph);
          ctx.lineTo(padL + (0.5 / hist.length) * pw, padT + ph);
          ctx.closePath();
          const gr = ctx.createLinearGradient(0, padT, 0, padT + ph);
          gr.addColorStop(0, 'rgba(63,224,255,0.28)');
          gr.addColorStop(1, 'rgba(139,92,246,0.02)');
          ctx.fillStyle = gr;
          ctx.shadowBlur = 0;
          ctx.fill();
        }
        ctx.restore();
      };
      line(pre.loudnessHistoryLufs, 'rgba(139,92,246,0.75)', 'transparent', true, false);
      if (post) line(post.loudnessHistoryLufs, '#3FE0FF', 'rgba(46,168,255,0.9)', false, true);
      const ratio = durationSec > 0 ? Math.max(0, Math.min(1, sec / durationSec)) : 0;
      const x = padL + ratio * pw;
      ctx.save();
      ctx.strokeStyle = '#E8FBFF';
      ctx.shadowColor = 'rgba(63,224,255,1)';
      ctx.shadowBlur = 10;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ph); ctx.stroke();
      const now = historyAt(active.loudnessHistoryLufs, ratio);
      if (now !== null) {
        ctx.fillStyle = '#3FE0FF';
        ctx.beginPath(); ctx.arc(x, yOf(now), 4, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
      if (nowRef.current) nowRef.current.textContent = fmt(now);
      if (peakRef.current) peakRef.current.textContent = playing && peakDb !== null ? fmt(peakDb) : '—';
      if (timeRef.current) {
        const m = Math.floor(sec / 60);
        timeRef.current.textContent = `${m}:${(sec - m * 60).toFixed(1).padStart(4, '0')}`;
      }
    };
    const snap = telemetryStore.getSnapshot();
    const peakOf = (s: typeof snap) => (s.live ? Math.max(s.live.peakL, s.live.peakR) : null);
    draw(snap.currentTimeSec, snap.isPlaying, peakOf(snap));
    let raf = 0;
    let latest = snap;
    const unsub = telemetryStore.subscribe((s) => {
      latest = s;
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; draw(latest.currentTimeSec, latest.isPlaying, peakOf(latest)); });
    });
    const onResize = () => draw(latest.currentTimeSec, latest.isPlaying, peakOf(latest));
    window.addEventListener('resize', onResize);
    return () => { unsub(); if (raf) cancelAnimationFrame(raf); window.removeEventListener('resize', onResize); };
  }, [pre, post, active, durationSec, targetLufs]);

  const seek = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!onSeek || !(durationSec > 0)) return;
    const r = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - r.left - 34) / Math.max(1, r.width - 44)));
    onSeek(ratio * durationSec);
  };

  const tpOver = maxTruePeakDb !== undefined && active.truePeakDb > maxTruePeakDb;
  return (
    <section className="syn-qc-live" aria-label="Live loudness and technical validation">
      <div className="syn-qc-live-head">
        <h3>Live Loudness</h3>
        <span className="syn-qc-live-src">{post ? 'Rendered master (cyan) vs source (purple, dashed)' : 'Source measurement (master render pending)'} · BS.1770 short-term LUFS</span>
      </div>
      <div className="syn-qc-live-readouts">
        <div className="is-now"><small>Now · short-term</small><b><span ref={nowRef}>—</span></b><i>LUFS @ <span ref={timeRef}>0:00.0</span></i></div>
        <div><small>Integrated</small><b>{fmt(active.integratedLufs)}</b><i>LUFS</i></div>
        <div><small>Short-term max</small><b>{fmt(active.shortTermLufsMax)}</b><i>LUFS</i></div>
        <div><small>Momentary max</small><b>{fmt(active.momentaryLufsMax)}</b><i>LUFS</i></div>
        <div><small>Loudness range</small><b>{fmt(active.loudnessRangeLu)}</b><i>LU</i></div>
        <div className={tpOver ? 'is-bad' : ''}><small>True peak</small><b>{fmt(active.truePeakDb, 2)}</b><i>dBTP{maxTruePeakDb !== undefined ? ` · max ${maxTruePeakDb}` : ''}</i></div>
        <div className={active.clippedSamples > 0 ? 'is-bad' : ''}><small>Clipped samples</small><b>{active.clippedSamples}</b><i>{active.interSamplePeaks} inter-sample</i></div>
        <div><small>Live sample peak</small><b><span ref={peakRef}>—</span></b><i>dBFS · while playing</i></div>
      </div>
      <canvas
        ref={canvasRef}
        className="syn-qc-live-graph"
        style={{ width: '100%', height: 180, display: 'block', touchAction: 'pan-y', cursor: onSeek ? 'ew-resize' : 'default' }}
        role="img"
        aria-label="Short-term loudness over the track with the playback position"
        title={onSeek ? 'Click or drag to seek' : undefined}
        onPointerDown={(e) => { dragRef.current = true; e.currentTarget.setPointerCapture(e.pointerId); seek(e); }}
        onPointerMove={(e) => { if (dragRef.current) seek(e); }}
        onPointerUp={() => { dragRef.current = false; }}
        onPointerCancel={() => { dragRef.current = false; }}
      />
    </section>
  );
};
