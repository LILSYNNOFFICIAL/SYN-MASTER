import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AlertTriangle, Loader2, Mic2, Plus, Scissors, X } from 'lucide-react';
import type { ProcessorModule, VocalRebalanceParams } from '../../types/mastering';
import {
  cancelRebalanceSeparation,
  getRebalanceStemState,
  separateActiveRebalanceStems,
  subscribeRebalanceStems,
} from '../../services/rebalanceStemStore';
import { REBALANCE_STEM_IDS, STEM_ENVELOPE_HOP_SEC, VOCAL_REBALANCE_LIMITS, type RebalanceStemId } from '../../dsp/vocalRebalance';
import { telemetryStore } from '../../engine/telemetryStore';

/**
 * Vocal Rebalance editor, shared by the rack card and the console "Vocal" tab. Gains edit the
 * real module; stems come from the per-track cache (separated on request, never automatically).
 * Meters show each stem's short-term level at the playhead with its gain applied.
 */
export interface VocalRebalancePanelProps {
  module: ProcessorModule | undefined;
  onChange: (next: Partial<VocalRebalanceParams>) => void;
  onToggle?: (on: boolean) => void;
  onAdd?: () => void;
  compact?: boolean;
}

const LABEL: Record<RebalanceStemId, string> = { vocals: 'Vocal', bass: 'Bass', drums: 'Drums' };
const STAGE: Record<string, string> = {
  preparing: 'Preparing audio',
  'loading-model': 'Loading HT-Demucs model',
  initializing: 'Starting separation engine',
  separating: 'Separating stems',
  resampling: 'Resampling stems',
  aligning: 'Aligning stems to the mix',
};

const fmt = (db: number) => `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;

const StemMeters: React.FC<{ gains: Record<RebalanceStemId, number>; envelopes: Record<RebalanceStemId, Float32Array> }> = ({ gains, envelopes }) => {
  const refs = useRef<Record<string, HTMLSpanElement | null>>({});
  useEffect(() => {
    const draw = (t: number) => {
      const i = Math.max(0, Math.floor(t / STEM_ENVELOPE_HOP_SEC));
      for (const id of REBALANCE_STEM_IDS) {
        const env = envelopes[id];
        const db = (env[Math.min(env.length - 1, i)] ?? -120) + gains[id];
        const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
        const el = refs.current[id];
        if (el) { el.style.width = `${pct}%`; el.title = `${LABEL[id]} ${db.toFixed(1)} dBFS`; }
      }
    };
    draw(telemetryStore.getSnapshot().currentTimeSec);
    return telemetryStore.subscribe((s) => draw(s.currentTimeSec));
  }, [gains, envelopes]);
  return (
    <div className="syn-vr-meters" aria-label="Stem levels at the playhead">
      {REBALANCE_STEM_IDS.map((id) => (
        <div key={id} className="syn-vr-meter">
          <span className="syn-vr-meter-label">{LABEL[id]}</span>
          <span className="syn-vr-meter-track"><span ref={(el) => { refs.current[id] = el; }} className={`syn-vr-meter-fill is-${id}`} /></span>
        </div>
      ))}
    </div>
  );
};

const GainRow: React.FC<{
  id: RebalanceStemId; value: number; enabled: boolean; optional?: boolean;
  onValue: (v: number) => void; onEnabled?: (on: boolean) => void;
}> = ({ id, value, enabled, optional, onValue, onEnabled }) => (
  <div className={`syn-vr-row${enabled ? '' : ' is-off'}`}>
    <label className="syn-vr-name">
      {optional && <input type="checkbox" checked={enabled} onChange={(e) => onEnabled?.(e.target.checked)} aria-label={`Rebalance ${LABEL[id]}`} />}
      {LABEL[id]}
    </label>
    <input
      type="range"
      min={VOCAL_REBALANCE_LIMITS.gainMinDb}
      max={VOCAL_REBALANCE_LIMITS.gainMaxDb}
      step={0.1}
      value={value}
      disabled={!enabled}
      onChange={(e) => onValue(Number(e.target.value))}
      onDoubleClick={() => onValue(0)}
      aria-label={`${LABEL[id]} gain`}
      aria-valuetext={fmt(value)}
    />
    <output className="syn-vr-value">{fmt(value)}</output>
  </div>
);

export const VocalRebalancePanel: React.FC<VocalRebalancePanelProps> = ({ module, onChange, onToggle, onAdd, compact }) => {
  const stems = useSyncExternalStore(subscribeRebalanceStems, getRebalanceStemState, getRebalanceStemState);
  const [hq, setHq] = useState(false);
  const [confirmWarn, setConfirmWarn] = useState(false);

  if (!module) {
    return (
      <div className="syn-vr syn-eq-empty">
        <p>Vocal Rebalance raises or lowers the vocal (and bass / drums) inside the finished mix, Ozone Master Rebalance style.</p>
        {onAdd && <button type="button" className="syn-card-add" onClick={onAdd}><Plus className="w-3.5 h-3.5" /> Add Vocal Rebalance</button>}
      </div>
    );
  }
  const p = module.params as VocalRebalanceParams;
  const on = module.enabled && !module.bypassed;
  const gains: Record<RebalanceStemId, number> = {
    vocals: on ? p.vocalGainDb : 0,
    bass: on && p.bassEnabled ? p.bassGainDb : 0,
    drums: on && p.drumsEnabled ? p.drumsGainDb : 0,
  };
  const a = stems.assessment;
  const startSeparation = () => {
    if (a?.level === 'warn' && !confirmWarn) { setConfirmWarn(true); return; }
    setConfirmWarn(false);
    void separateActiveRebalanceStems({ highQuality: hq });
  };

  return (
    <div className={`syn-vr${compact ? ' is-compact' : ''}`} data-testid="vocal-rebalance-panel">
      <div className="syn-vr-status" role="status" aria-live="polite">
        {stems.status === 'no-track' && <span>Import a track to use Vocal Rebalance.</span>}
        {stems.status === 'checking' && <span><Loader2 className="w-3.5 h-3.5 syn-spin" /> Looking for cached stems…</span>}
        {stems.status === 'ready' && <span className="is-ready"><Mic2 className="w-3.5 h-3.5" /> Stems cached for this track. Changes apply to preview, export and FIX ALL.</span>}
        {(stems.status === 'missing' || stems.status === 'error') && (
          <div className="syn-vr-need">
            <span>{stems.status === 'error' ? <><AlertTriangle className="w-3.5 h-3.5" /> {stems.error}</> : 'No stems yet: until they are separated this module passes audio through untouched.'}</span>
            {a && a.level !== 'ok' && <p className={`syn-vr-warn is-${a.level}`}><AlertTriangle className="w-3.5 h-3.5" /> {a.message}</p>}
            {a?.level !== 'block' && (
              <div className="syn-vr-actions">
                <button type="button" className="syn-btn-ghost" onClick={startSeparation}>
                  <Scissors className="w-3.5 h-3.5" /> {confirmWarn ? 'Separate anyway' : 'Separate stems'}
                </button>
                {confirmWarn && <button type="button" className="syn-btn-ghost" onClick={() => { setConfirmWarn(false); onToggle?.(false); }}>Skip on this device</button>}
                {!compact && (
                  <label className="syn-vr-hq"><input type="checkbox" checked={hq} onChange={(e) => setHq(e.target.checked)} /> High quality (2x slower)</label>
                )}
              </div>
            )}
            {a?.level === 'block' && onToggle && (
              <button type="button" className="syn-btn-ghost" onClick={() => onToggle(false)}>Skip Vocal Rebalance</button>
            )}
          </div>
        )}
        {stems.status === 'separating' && (
          <div className="syn-vr-progress">
            <span>{STAGE[stems.progress?.stage ?? 'preparing'] ?? 'Separating'}… {Math.round((stems.progress?.overall ?? 0) * 100)}%
              {stems.progress?.totalChunks ? ` (${stems.progress.completedChunks ?? 0}/${stems.progress.totalChunks})` : ''}</span>
            <span className="syn-progress" aria-hidden="true"><span style={{ width: `${Math.round((stems.progress?.overall ?? 0) * 100)}%` }} /></span>
            <button type="button" className="syn-btn-ghost" onClick={cancelRebalanceSeparation}><X className="w-3.5 h-3.5" /> Cancel</button>
          </div>
        )}
      </div>

      <GainRow id="vocals" value={p.vocalGainDb} enabled onValue={(v) => onChange({ vocalGainDb: v })} />
      <GainRow id="bass" optional value={p.bassGainDb} enabled={p.bassEnabled} onValue={(v) => onChange({ bassGainDb: v })} onEnabled={(b) => onChange({ bassEnabled: b })} />
      <GainRow id="drums" optional value={p.drumsGainDb} enabled={p.drumsEnabled} onValue={(v) => onChange({ drumsGainDb: v })} onEnabled={(b) => onChange({ drumsEnabled: b })} />
      <div className="syn-vr-row">
        <label className="syn-vr-name" htmlFor={`${module.id}-sens`}>Sensitivity</label>
        <input id={`${module.id}-sens`} type="range" min={0} max={100} step={1} value={p.sensitivity} onChange={(e) => onChange({ sensitivity: Number(e.target.value) })} />
        <output className="syn-vr-value">{Math.round(p.sensitivity)}%</output>
      </div>
      <div className="syn-vr-row">
        <label className="syn-vr-name" htmlFor={`${module.id}-smooth`}>Smoothing</label>
        <input id={`${module.id}-smooth`} type="range" min={5} max={500} step={5} value={p.smoothingMs} onChange={(e) => onChange({ smoothingMs: Number(e.target.value) })} />
        <output className="syn-vr-value">{Math.round(p.smoothingMs)} ms</output>
      </div>
      {stems.status === 'ready' && stems.envelopes && <StemMeters gains={gains} envelopes={stems.envelopes} />}
      <p className="syn-vr-note">Phase-preserving: only the gain difference is added, so 0 dB leaves the master bit-identical. Always first in the chain. Offline render only; playback uses the last render.</p>
    </div>
  );
};

export default VocalRebalancePanel;
