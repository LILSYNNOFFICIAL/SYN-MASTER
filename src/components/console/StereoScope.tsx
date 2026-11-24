import React, { useEffect, useRef } from 'react';
import { telemetryStore, type RuntimeTelemetryState } from '../../engine/telemetryStore';

/**
 * Ozone-style polar sample vectorscope (half circle). Each L/R sample pair is converted to
 * mid/side and folded into the upper half: mono sits on the vertical axis, hard-left / hard-right
 * on the 45-degree L / R guides, out-of-phase energy spreads towards the horizontal baseline.
 * Plots the live analyser buffers while playing (with a short glow trail), otherwise a decimated
 * snapshot of the rendered (or source) channels. Redraws only on telemetry updates.
 */
export const StereoScope: React.FC<{ channels?: Float32Array[] | null; size?: number; label?: string }> = ({
  channels,
  size = 150,
  label = 'Polar stereo vectorscope',
}) => {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const channelsRef = useRef(channels);
  channelsRef.current = channels;
  const W = Math.round(size * 1.45);
  const H = Math.round(size * 0.82);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    const cx = W / 2;
    const base = H - 6;
    const r = Math.min(W / 2 - 4, H - 12);

    const grid = (ctx: CanvasRenderingContext2D) => {
      const bg = ctx.createRadialGradient(cx, base, 2, cx, base, r);
      bg.addColorStop(0, 'rgba(46,168,255,0.26)');
      bg.addColorStop(1, 'rgba(4,8,16,0.0)');
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.moveTo(cx - r, base);
      ctx.arc(cx, base, r, Math.PI, 0);
      ctx.closePath();
      ctx.fill();
      ctx.lineWidth = 1;
      for (const k of [0.25, 0.5, 0.75, 1]) {
        ctx.strokeStyle = k === 1 ? 'rgba(63,224,255,0.55)' : 'rgba(46,168,255,0.16)';
        ctx.beginPath();
        ctx.arc(cx, base, r * k, Math.PI, 0);
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(46,168,255,0.22)';
      for (const deg of [45, 90, 135]) {
        const t = (deg * Math.PI) / 180;
        ctx.beginPath();
        ctx.moveTo(cx, base);
        ctx.lineTo(cx + Math.cos(t) * r, base - Math.sin(t) * r);
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(63,224,255,0.4)';
      ctx.beginPath();
      ctx.moveTo(cx - r, base + 0.5);
      ctx.lineTo(cx + r, base + 0.5);
      ctx.stroke();
      ctx.fillStyle = 'rgba(160,215,255,0.75)';
      ctx.font = '700 8px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('L', cx - r * 0.74, base - r * 0.74 - 3);
      ctx.fillText('R', cx + r * 0.74, base - r * 0.74 - 3);
      ctx.fillText('M', cx, base - r - 2 < 8 ? 8 : base - r - 2);
      ctx.fillText('+S', cx - r + 7, base - 3);
      ctx.fillText('-S', cx + r - 7, base - 3);
    };

    const draw = (snap: RuntimeTelemetryState, trail: boolean) => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (trail) {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.fillStyle = 'rgba(0,0,0,0.42)';
        ctx.fillRect(0, 0, W, H);
        ctx.globalCompositeOperation = 'source-over';
      } else {
        ctx.clearRect(0, 0, W, H);
      }
      grid(ctx);
      const ch = channelsRef.current;
      const live = snap.isPlaying ? snap.live : null;
      const left = live?.timeDomainL ?? ch?.[0];
      const right = live?.timeDomainR ?? ch?.[1] ?? ch?.[0];
      if (!left || !right || left.length === 0) return;
      const n = Math.min(left.length, right.length);
      const step = Math.max(1, Math.floor(n / 1600));
      // Auto-gain so quiet material still fills the display (peak of this frame).
      let peak = 1e-4;
      for (let i = 0; i < n; i += step) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
      const gain = Math.min(6, 0.7 / peak);
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(cx - r, base + 1);
      ctx.arc(cx, base, r, Math.PI, 0);
      ctx.closePath();
      ctx.clip();
      ctx.globalCompositeOperation = 'lighter';
      for (let pass = 0; pass < 2; pass++) {
        ctx.fillStyle = pass === 0 ? 'rgba(46,168,255,0.10)' : 'rgba(150,230,255,0.75)';
        const d = pass === 0 ? 3.2 : 1.2;
        for (let i = 0; i < n; i += step) {
          let mid = (left[i] + right[i]) * 0.7071 * gain;
          let side = (left[i] - right[i]) * 0.7071 * gain;
          if (mid < 0) {
            mid = -mid;
            side = -side;
          }
          const x = cx - side * r;
          const y = base - mid * r;
          ctx.fillRect(x - d / 2, y - d / 2, d, d);
        }
      }
      ctx.restore();
    };
    draw(telemetryStore.getSnapshot(), false);
    let wasPlaying = telemetryStore.getSnapshot().isPlaying;
    return telemetryStore.subscribe((snap) => {
      if (snap.isPlaying) draw(snap, true);
      else if (wasPlaying) draw(snap, false);
      wasPlaying = snap.isPlaying;
    });
  }, [W, H, channels]);

  return <canvas ref={ref} className="syn-scope syn-vectorscope" style={{ width: W, height: H }} role="img" aria-label={label} />;
};

/**
 * Live correlation and L/R balance meters. While playing they read the analyser
 * (telemetry.live.correlation, rmsL/rmsR); otherwise they show the measured analysis values.
 */
export const StereoMeters: React.FC<{ correlation: number | null; balanceDb: number | null }> = ({ correlation, balanceDb }) => {
  const corrFill = useRef<HTMLSpanElement | null>(null);
  const corrText = useRef<HTMLElement | null>(null);
  const balFill = useRef<HTMLSpanElement | null>(null);
  const balText = useRef<HTMLElement | null>(null);
  const staticRef = useRef({ correlation, balanceDb });
  staticRef.current = { correlation, balanceDb };

  useEffect(() => {
    let smC = 0;
    let smB = 0;
    const paint = (c: number | null, b: number | null) => {
      if (corrFill.current) {
        const v = c ?? 0;
        const left = v >= 0 ? 50 : 50 + v * 50;
        corrFill.current.style.left = `${left}%`;
        corrFill.current.style.width = `${Math.abs(v) * 50}%`;
        corrFill.current.dataset.neg = v < 0 ? 'true' : 'false';
      }
      if (corrText.current) corrText.current.textContent = c === null ? '—' : `${c > 0 ? '+' : ''}${c.toFixed(2)}`;
      if (balFill.current) {
        const v = Math.max(-6, Math.min(6, b ?? 0)) / 6;
        balFill.current.style.left = `${v >= 0 ? 50 : 50 + v * 50}%`;
        balFill.current.style.width = `${Math.abs(v) * 50}%`;
      }
      if (balText.current) balText.current.textContent = b === null ? '—' : `${b > 0 ? 'R ' : b < 0 ? 'L ' : ''}${Math.abs(b).toFixed(2)} dB`;
    };
    const update = (snap: RuntimeTelemetryState) => {
      const live = snap.isPlaying ? snap.live : null;
      if (live) {
        // Positive balance = right louder (same sign convention as lrBalanceDb: R - L).
        const bal = Number.isFinite(live.rmsR - live.rmsL) ? live.rmsR - live.rmsL : 0;
        smC = smC * 0.7 + live.correlation * 0.3;
        smB = smB * 0.7 + bal * 0.3;
        paint(smC, smB);
      } else {
        paint(staticRef.current.correlation, staticRef.current.balanceDb);
      }
    };
    update(telemetryStore.getSnapshot());
    return telemetryStore.subscribe(update);
  }, [correlation, balanceDb]);

  return (
    <div className="syn-stmeters">
      <div className="syn-stmeter">
        <div className="syn-stmeter-head"><span>Correlation</span><b ref={corrText as React.RefObject<HTMLElement>}>—</b></div>
        <div className="syn-stmeter-track"><span ref={corrFill} /><i /></div>
        <div className="syn-stmeter-scale"><span>-1</span><span>0</span><span>+1</span></div>
      </div>
      <div className="syn-stmeter">
        <div className="syn-stmeter-head"><span>L / R balance</span><b ref={balText as React.RefObject<HTMLElement>}>—</b></div>
        <div className="syn-stmeter-track is-bal"><span ref={balFill} /><i /></div>
        <div className="syn-stmeter-scale"><span>L</span><span>C</span><span>R</span></div>
      </div>
    </div>
  );
};
