import React, { useEffect, useRef } from 'react';
import { Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import { telemetryStore } from '../../engine/telemetryStore';
import type { FadeCurve, FadeSettings } from '../../dsp/fades';

interface Props {
  durationSec: number;
  isPlaying: boolean;
  fades: FadeSettings;
  onFadesChange: (f: FadeSettings | ((current: FadeSettings) => FadeSettings)) => void;
  onSeek: (sec: number) => void;
  onTogglePlay: () => void;
  onImport: (file: File) => void;
  disabled?: boolean;
  /** Render the timeline readout and fade controls beneath the existing EQ waveform. */
  integrated?: boolean;
  /** Render only the transport controls for placement in the EQ header. */
  transportOnly?: boolean;
  /** Hide the transport here when a header-mounted copy is rendered. */
  hideTransport?: boolean;
  /** Optional compact control rendered under the transport (Platform Preview selector). */
  extra?: React.ReactNode;
}

function fmt(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`;
}

const TimeReadout: React.FC<{ durationSec: number }> = ({ durationSec }) => {
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const update = (sec: number) => {
      if (ref.current) ref.current.textContent = `${fmt(sec)} / ${fmt(durationSec)}`;
    };
    update(telemetryStore.getSnapshot().currentTimeSec);
    return telemetryStore.subscribe((snap) => update(snap.currentTimeSec));
  }, [durationSec]);
  return <span ref={ref} className="syn-player-time" aria-live="off">0:00.0 / {fmt(durationSec)}</span>;
};

const CURVES: { id: FadeCurve; label: string }[] = [
  { id: 'linear', label: 'Linear' },
  { id: 'scurve', label: 'S-Curve' },
  { id: 'exp', label: 'Exponential' },
];

const TransportControls: React.FC<Props> = (p) => {
  const hasTrack = p.durationSec > 0;
  return (
    <div className="syn-player-transport" role="group" aria-label="Transport">
      <button type="button" className="syn-player-btn syn-player-icon" onClick={() => p.onSeek(0)} disabled={!hasTrack || p.disabled} aria-label="Jump to start" title="Jump to start">
        <SkipBack className="w-3 h-3" />
      </button>
      <button type="button" className="syn-player-play" onClick={p.onTogglePlay} disabled={!hasTrack || p.disabled} aria-label={p.isPlaying ? 'Pause' : 'Play'} title={p.isPlaying ? 'Pause' : 'Play'}>
        {p.isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
      </button>
      <button type="button" className="syn-player-btn syn-player-icon" onClick={() => p.onSeek(Math.max(0, p.durationSec - 0.05))} disabled={!hasTrack || p.disabled} aria-label="Jump to end" title="Jump to end">
        <SkipForward className="w-3 h-3" />
      </button>
    </div>
  );
};

export const TimelinePlayer: React.FC<Props> = (p) => {
  if (p.transportOnly) return <TransportControls {...p} />;
  return (
    <section className={`syn-card syn-player syn-area-player${p.integrated ? ' syn-player-integrated' : ''}`} aria-label="Fade controls for the existing EQ waveform">
      <div className="syn-player-integrated-readout">
        <span>FADES · EXISTING EQ WAVEFORM</span>
        <TimeReadout durationSec={p.durationSec} />
      </div>
      <p className="syn-player-hint">Drag the cyan fade handles on the EQ waveform above. Choose the fade curves here.</p>
      {!p.hideTransport && <TransportControls {...p} />}
      {p.extra}
      <div className="syn-player-controls">
        <div className="syn-player-fades" role="group" aria-label="Fades">
          <label>
            <span>Fade in <b>{p.fades.inSec.toFixed(2)}s</b></span>
            <select value={p.fades.inCurve} onChange={(e) => p.onFadesChange({ ...p.fades, inCurve: e.target.value as FadeCurve })} aria-label="Fade-in curve">
              {CURVES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </label>
          <label>
            <span>Fade out <b>{p.fades.outSec.toFixed(2)}s</b></span>
            <select value={p.fades.outCurve} onChange={(e) => p.onFadesChange({ ...p.fades, outCurve: e.target.value as FadeCurve })} aria-label="Fade-out curve">
              {CURVES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </label>
          {(p.fades.inSec > 0 || p.fades.outSec > 0) && (
            <button type="button" className="syn-player-clear" onClick={() => p.onFadesChange({ ...p.fades, inSec: 0, outSec: 0 })}>Clear fades</button>
          )}
        </div>
      </div>
    </section>
  );
};
