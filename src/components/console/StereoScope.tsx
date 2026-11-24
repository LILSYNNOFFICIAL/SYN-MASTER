import React, { useEffect, useRef } from 'react';
import { telemetryStore, type RuntimeTelemetryState } from '../../engine/telemetryStore';

/**
 * Circular mid/side stereo scope for the console. Plots the live analyser buffers while
 * playing, otherwise a decimated snapshot of the rendered (or source) channels.
 * Redraws only on telemetry updates; no animation loop of its own.
 */
export const StereoScope: React.FC<{ channels?: Float32Array[] | null; size?: number; label?: string }> = ({
  channels,
  size = 150,
  label = 'Stereo image scope',
}) => {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const channelsRef = useRef(channels);
  channelsRef.current = channels;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    const draw = (snap: RuntimeTelemetryState) => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const c = size / 2;
      const r = c - 4;
      ctx.clearRect(0, 0, size, size);
      const bg = ctx.createRadialGradient(c, c, 4, c, c, r);
      bg.addColorStop(0, 'rgba(47,139,255,0.22)');
      bg.addColorStop(1, 'rgba(5,7,13,0.95)');
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.arc(c, c, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(94,200,255,0.18)';
      ctx.lineWidth = 1;
      for (const k of [0.33, 0.66, 1]) {
        ctx.beginPath();
        ctx.arc(c, c, r * k, 0, Math.PI * 2);
        ctx.stroke();
      }
      for (let a = 0; a < 8; a++) {
        const t = (a * Math.PI) / 4;
        ctx.beginPath();
        ctx.moveTo(c, c);
        ctx.lineTo(c + Math.cos(t) * r, c + Math.sin(t) * r);
        ctx.stroke();
      }
      const ch = channelsRef.current;
      const live = snap.isPlaying ? snap.live : null;
      const left = live?.timeDomainL ?? ch?.[0];
      const right = live?.timeDomainR ?? ch?.[1] ?? ch?.[0];
      if (!left || !right || left.length === 0) return;
      const n = Math.min(left.length, right.length);
      const step = Math.max(1, Math.floor(n / 1400));
      ctx.save();
      ctx.beginPath();
      ctx.arc(c, c, r, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = 'rgba(120,200,255,0.55)';
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < n; i += step) {
        const side = (left[i] - right[i]) * 0.707;
        const mid = (left[i] + right[i]) * 0.707;
        ctx.fillRect(c - side * r * 1.1, c - mid * r * 1.1, 1.4, 1.4);
      }
      ctx.restore();
    };
    draw(telemetryStore.getSnapshot());
    let wasPlaying = telemetryStore.getSnapshot().isPlaying;
    return telemetryStore.subscribe((snap) => {
      if (snap.isPlaying || wasPlaying) draw(snap);
      wasPlaying = snap.isPlaying;
    });
  }, [size, channels]);

  return <canvas ref={ref} className="syn-scope" style={{ width: size, height: size }} role="img" aria-label={label} />;
};
