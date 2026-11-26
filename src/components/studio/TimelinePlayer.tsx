import React, { useEffect, useRef } from 'react';
import { Pause, Play, SkipBack, SkipForward, Upload } from 'lucide-react';
import { telemetryStore } from '../../engine/telemetryStore';
import type { FadeCurve, FadeSettings } from '../../dsp/fades';
import { TimelineWaveform } from './TimelineWaveform';

/**
 * Overview player under the EQ: glowing blue waveform (original vs processed), playhead,
 * click/drag to seek, FL-style fade-in / fade-out handles at the two ends. The fades are the
 * app's real FadeSettings (applied after the chain on preview, Fix-All verification and export).
 */
interface Props {
  prePeaks: number[];
  postPeaks: number[] | null;
  durationSec: number;
  showPost: boolean;
  isPlaying: boolean;
  fades: FadeSettings;
  onFadesChange: (f: FadeSettings) => void;
  onSeek: (sec: number) => void;
  onTogglePlay: () => void;
  onImport: (file: File) => void;
  disabled?: boolean;
  /** Render only transport/fade controls; the waveform is already overlaid behind the EQ graph. */
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
  { id: 'scurve', label: 'S-curve' },
  { id: 'linear', label: 'Linear' },
  { id: 'exp', label: 'Exponential' },
];

export const TimelinePlayer: React.FC<Props> = (p) => {
  const hasTrack = p.durationSec > 0;
  const transport = (
    <div className="syn-player-transport" role="group" aria-label="Transport">
        <button type="button" className="syn-player-btn syn-player-icon" onClick={() => p.onSeek(0)} disabled={!hasTrack} aria-label="Jump to start">
            <SkipBack className="w-3.5 h-3.5" />
          </button>
          <button type="button" className="syn-player-play" onClick={p.onTogglePlay} disabled={!hasTrack} aria-label={p.isPlaying ? 'Pause' : 'Play'} title={p.isPlaying ? 'Pause' : 'Play'}>
            {p.isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
          </button>
        <button type="button" className="syn-player-btn syn-player-icon" onClick={() => p.onSeek(Math.max(0, p.durationSec - 0.05))} disabled={!hasTrack} aria-label="Jump to end">
            <SkipForward className="w-3.5 h-3.5" />
          </button>
      </div>
  );
  if (p.transportOnly) return transport;
  return (      {!p.hideTransport && transport}
      {p.extra}
      <div className="syn-player-controls">
        <label className="syn-player-btn syn-player-import">
          <Upload className="w-4 h-4" aria-hidden="true" /> Import Track
          <input
            type="file"
            accept="audio/*,.wav,.flac,.mp3,.aac,.m4a,.ogg,.aiff,.aif"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) p.onImport(f);
              e.target.value = '';
            }}
          />
        </label>
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
