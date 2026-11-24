import React from 'react';
import type { DynamicEQParams, ProcessorModule } from '../../types/mastering';

/**
 * Skinned editor for the engine's existing Dynamic EQ ('dynamic-eq' processor: per-band
 * band-pass detector driving a peaking cut). It edits the module's params only; the DSP is
 * the same one used by the realtime preview graph, the offline preview render and export.
 * The engine's cut slope is fixed (0.65 dB of cut per dB over threshold, ≈2.9:1) and the
 * cut is limited by "Range" (maxCutDb), so ratio is shown as a fixed value, not a control.
 */
type Band = DynamicEQParams['bands'][number];

const COLORS = ['#2EA8FF', '#8B5CF6', '#3FE0FF', '#E040FB'];
const ENGINE_RATIO = 1 / (1 - 0.65);

interface Props {
  module: ProcessorModule | undefined;
  onAdd: () => void;
  onChange: (next: DynamicEQParams) => void;
  onToggle: (on: boolean) => void;
}

const fmtHz = (f: number) => (f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 1 : 2)} kHz` : `${Math.round(f)} Hz`);

const Field: React.FC<{
  label: string; value: number; min: number; max: number; step: number; unit: string;
  log?: boolean; display?: string; onChange: (v: number) => void; disabled?: boolean;
}> = ({ label, value, min, max, step, unit, log, display, onChange, disabled }) => {
  const toPos = (v: number) => (log ? Math.log(v / min) / Math.log(max / min) : (v - min) / (max - min));
  const fromPos = (p: number) => (log ? min * Math.pow(max / min, p) : min + p * (max - min));
  return (
    <label className="syn-deq-field">
      <span className="syn-deq-field-label">{label}</span>
      <input
        type="range"
        min={0}
        max={1000}
        step={1}
        value={Math.round(toPos(value) * 1000)}
        disabled={disabled}
        aria-label={label}
        aria-valuetext={display ?? `${value} ${unit}`}
        onChange={(e) => {
          const raw = fromPos(Number(e.target.value) / 1000);
          const snapped = Math.round(raw / step) * step;
          onChange(Number(Math.max(min, Math.min(max, snapped)).toFixed(3)));
        }}
      />
      <span className="syn-deq-field-value">{display ?? `${value} ${unit}`}</span>
    </label>
  );
};

export const DynamicEQPanel: React.FC<Props> = ({ module, onAdd, onChange, onToggle }) => {
  if (!module) {
    return (
      <div className="syn-deq syn-deq-empty">
        <p>Dynamic EQ cuts a band only when it gets louder than its threshold (harsh vocals, boomy notes, resonances). It is off until you add it, so your master is unchanged.</p>
        <button type="button" className="syn-deq-add" onClick={onAdd}>+ Add Dynamic EQ</button>
      </div>
    );
  }
  const params = module.params as DynamicEQParams;
  const on = module.enabled && !module.bypassed;
  const setBand = (id: string, patch: Partial<Band>) =>
    onChange({ ...params, bands: params.bands.map((b) => (b.id === id ? { ...b, ...patch } : b)) });
  const addBand = () => {
    if (params.bands.length >= 4) return;
    const used = new Set(params.bands.map((b) => b.id));
    let n = params.bands.length + 1;
    while (used.has(`d${n}`)) n++;
    onChange({ ...params, bands: [...params.bands, { id: `d${n}`, enabled: true, freq: 1200, q: 2, thresholdDb: -20, maxCutDb: -3, attackMs: 10, releaseMs: 110 }] });
  };
  const removeBand = (id: string) => onChange({ ...params, bands: params.bands.filter((b) => b.id !== id) });

  return (
    <div className="syn-deq" data-on={on ? 'true' : 'false'}>
      <div className="syn-deq-head">
        <button type="button" className="syn-deq-power" aria-pressed={on} onClick={() => onToggle(!on)}>
          {on ? 'ON' : 'BYPASSED'}
        </button>
        <span className="syn-deq-note">Cut-only · ratio ≈{ENGINE_RATIO.toFixed(1)}:1 (engine) · applied in preview and export</span>
        {params.bands.length < 4 && <button type="button" className="syn-deq-addband" onClick={addBand}>+ Band</button>}
      </div>
      <div className="syn-deq-bands">
        {params.bands.map((b, i) => (
          <div key={b.id} className="syn-deq-band" style={{ ['--band-color' as string]: COLORS[i % COLORS.length] }} data-enabled={b.enabled ? 'true' : 'false'}>
            <div className="syn-deq-band-head">
              <label className="syn-deq-band-toggle">
                <input type="checkbox" checked={b.enabled} onChange={(e) => setBand(b.id, { enabled: e.target.checked })} aria-label={`Band ${i + 1} enabled`} />
                <span>Band {i + 1}</span>
              </label>
              <b>{fmtHz(b.freq)}</b>
              {params.bands.length > 1 && (
                <button type="button" className="syn-deq-remove" onClick={() => removeBand(b.id)} aria-label={`Remove band ${i + 1}`}>×</button>
              )}
            </div>
            <Field label="Freq" value={b.freq} min={30} max={16000} step={1} unit="Hz" log display={fmtHz(b.freq)} onChange={(v) => setBand(b.id, { freq: v })} disabled={!b.enabled} />
            <Field label="Range" value={b.maxCutDb} min={-12} max={0} step={0.1} unit="dB" display={`${b.maxCutDb.toFixed(1)} dB`} onChange={(v) => setBand(b.id, { maxCutDb: v })} disabled={!b.enabled} />
            <Field label="Q" value={b.q} min={0.5} max={10} step={0.05} unit="" log display={b.q.toFixed(2)} onChange={(v) => setBand(b.id, { q: v })} disabled={!b.enabled} />
            <Field label="Threshold" value={b.thresholdDb} min={-45} max={0} step={0.5} unit="dB" display={`${b.thresholdDb.toFixed(1)} dB`} onChange={(v) => setBand(b.id, { thresholdDb: v })} disabled={!b.enabled} />
            <Field label="Attack" value={b.attackMs} min={1} max={100} step={1} unit="ms" log display={`${Math.round(b.attackMs)} ms`} onChange={(v) => setBand(b.id, { attackMs: v })} disabled={!b.enabled} />
            <Field label="Release" value={b.releaseMs} min={20} max={600} step={1} unit="ms" log display={`${Math.round(b.releaseMs)} ms`} onChange={(v) => setBand(b.id, { releaseMs: v })} disabled={!b.enabled} />
          </div>
        ))}
      </div>
    </div>
  );
};
