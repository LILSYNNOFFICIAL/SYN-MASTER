import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { MatchEqChannel, MatchEqParams, MatchEqSmoothing, ProcessorModule } from '../../types/mastering';
import {
  MATCH_EQ_GRID_HZ,
  MATCH_EQ_SMOOTHING_OPTIONS,
  computeMatchEqCurve,
  interpolateCurveDb,
  isMatchEqLearned,
} from '../../dsp/matchEq';
import { matchEqStore } from '../../engine/matchEqStore';
import { EqGraph, type EqGraphNode } from './eq/EqGraph';
import { NumField, SelField } from './eq/EqBandPopover';
import { curveFreqs, fmtHz } from './eq/graphMath';
import {
  applyMatchEqPreset,
  deleteMatchEqPreset,
  listMatchEqPresets,
  saveMatchEqPreset,
  type MatchEqPreset,
} from './eq/matchEqPresets';

const FREQS = curveFreqs(240);
const SOURCE_COLOR = '#3FE0FF';
const REFERENCE_COLOR = '#F2CA52';
const LIMIT_COLOR = '#8B5CF6';
const SMOOTHING_LABEL = (n: MatchEqSmoothing) => `1/${n} oct`;
const CHANNEL_LABEL: Record<MatchEqChannel, string> = { stereo: 'Stereo', mid: 'Mid', side: 'Side' };

interface Props {
  module: ProcessorModule | undefined;
  /** Console only: add a Match EQ when the chain has none. */
  onAdd?: () => void;
  onChange: (next: MatchEqParams) => void;
  onToggle?: (on: boolean) => void;
  /** Compact layout inside the floating rack. */
  variant?: 'console' | 'rack';
}

/**
 * Match EQ editor: the learned source spectrum (cyan), the reference spectrum (gold) and the
 * correction curve on the shared EQ graph, with Amount / Smoothing / limits / range /
 * Stereo-Mid-Side / phase controls, Learn and saved learned-curve presets.
 */
export const MatchEQPanel: React.FC<Props> = ({ module, onAdd, onChange, onToggle, variant = 'console' }) => {
  const learn = useSyncExternalStore(matchEqStore.subscribe, matchEqStore.getSnapshot, matchEqStore.getSnapshot);
  const params = module?.params as MatchEqParams | undefined;
  const [draft, setDraft] = useState<MatchEqParams | null>(null);
  const view = draft ?? params;
  const viewRef = useRef(view);
  viewRef.current = view;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [presets, setPresets] = useState<MatchEqPreset[]>(() => listMatchEqPresets());
  const [presetName, setPresetName] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => setDraft(null), [params]);

  const commit = useCallback((next: MatchEqParams) => {
    setDraft(null);
    onChange(next);
  }, [onChange]);
  const patch = useCallback((p: Partial<MatchEqParams>, phase: 'move' | 'end' = 'end') => {
    const cur = viewRef.current;
    if (!cur) return;
    const next = { ...cur, ...p };
    if (phase === 'move') setDraft(next);
    else commit(next);
  }, [commit]);

  const intensity = module ? Math.max(0, Math.min(1, module.intensity / 100)) : 1;
  const curve = useMemo(() => (view ? computeMatchEqCurve(view, intensity) : null), [view, intensity]);
  const learned = Boolean(view && isMatchEqLearned(view));
  const peak = curve ? curve.correctionDb.reduce((m, c) => Math.max(m, Math.abs(c)), 0) : 0;

  const graphCurves = useMemo(() => {
    const main = curve ? FREQS.map((f) => interpolateCurveDb(curve.correctionDb, f)) : FREQS.map(() => 0);
    const spectra = curve && curve.learned
      ? [
          { key: 'source', freqs: MATCH_EQ_GRID_HZ, values: curve.sourceDb, color: SOURCE_COLOR, fill: true },
          { key: 'reference', freqs: MATCH_EQ_GRID_HZ, values: curve.referenceDb, color: REFERENCE_COLOR },
        ]
      : [];
    return { freqs: FREQS, main, spectra };
  }, [curve]);

  const nodes: EqGraphNode[] = view
    ? [
        { id: 'low', freq: view.lowHz, yDb: -15, q: 1, enabled: true, color: LIMIT_COLOR, label: 'L', yMode: 'none', showQ: false,
          description: `Low frequency limit ${fmtHz(view.lowHz)}. Arrow keys move it.` },
        { id: 'high', freq: view.highHz, yDb: -15, q: 1, enabled: true, color: LIMIT_COLOR, label: 'H', yMode: 'none', showQ: false,
          description: `High frequency limit ${fmtHz(view.highHz)}. Arrow keys move it.` },
      ]
    : [];

  const doLearn = () => {
    const profile = matchEqStore.getProfile();
    if (!profile) {
      setNotice(learn.reference ? 'Load a source track to learn from.' : 'Load a reference track (Reference Match) first.');
      return;
    }
    patch({ source: profile.source, reference: profile.reference, ...(profile.referenceName ? { referenceName: profile.referenceName } : {}) });
    setNotice(`Learned the source and "${profile.referenceName ?? 'reference'}".`);
  };
  const doClear = () => {
    const cur = viewRef.current;
    if (!cur) return;
    const { source: _s, reference: _r, referenceName: _n, ...rest } = cur;
    commit(rest);
    setNotice('Learned spectra cleared: Match EQ now passes audio through unchanged.');
  };
  const doSave = () => {
    if (!view) return;
    const saved = saveMatchEqPreset(presetName || view.referenceName || 'Match EQ curve', view);
    if (saved) {
      setPresets(listMatchEqPresets());
      setPresetName('');
      setNotice(`Saved learned curve "${saved.name}".`);
    } else {
      setNotice('Could not save: learn a curve first (or browser storage is full).');
    }
  };
  const doLoad = (id: string) => {
    const preset = presets.find((p) => p.id === id);
    if (!preset) return;
    commit(applyMatchEqPreset(preset, matchEqStore.getSourceSpectrum()));
    setNotice(`Loaded "${preset.name}"${matchEqStore.getSnapshot().hasSource ? ' against the current track' : ''}.`);
  };
  const doDelete = (id: string) => {
    deleteMatchEqPreset(id);
    setPresets(listMatchEqPresets());
  };

  if (!module || !view) {
    return (
      <div className="syn-meq syn-deq syn-deq-empty" data-testid="match-eq-editor-empty">
        <p>Match EQ learns the long-term tonal balance of your track and of a reference track, then applies a smoothed, limited correction so your master moves toward the reference.</p>
        {!learn.reference && <p className="syn-meq-hint">Load a reference track in Reference Match to learn from it.</p>}
        {onAdd && <button type="button" className="syn-deq-add" onClick={onAdd}>+ Add Match EQ</button>}
      </div>
    );
  }

  const on = module.enabled && !module.bypassed;
  return (
    <div className={`syn-meq syn-deq syn-meq-${variant}`} data-on={on ? 'true' : 'false'} data-testid="match-eq-editor">
      <div className="syn-deq-head">
        {onToggle && <button type="button" className="syn-deq-power" aria-pressed={on} onClick={() => onToggle(!on)}>{on ? 'ON' : 'BYPASSED'}</button>}
        <span className="syn-deq-note" role="status">
          {learned ? `Matching to ${view.referenceName ? `"${view.referenceName}"` : 'reference'} · peak ${peak.toFixed(1)} dB` : 'Not learned · passes audio through'}
        </span>
        <div className="syn-meq-actions">
          <button type="button" className="syn-deq-addband" onClick={doLearn} disabled={!learn.reference} title={learn.reference ? 'Learn the source and reference spectra' : 'Load a reference track first'}>
            {learned ? 'Re-learn' : 'Learn'}
          </button>
          {learned && <button type="button" className="syn-deq-addband" onClick={doClear}>Clear</button>}
        </div>
      </div>
      <div className="syn-deq-toolbar syn-meq-legend" aria-hidden="true">
        <span><i style={{ background: SOURCE_COLOR }} />Source</span>
        <span><i style={{ background: REFERENCE_COLOR }} />Reference</span>
        <span><i className="syn-meq-legend-curve" />Correction</span>
        <span><i style={{ background: LIMIT_COLOR }} />Limits</span>
      </div>
      <EqGraph
        nodes={nodes}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onNodeChange={(id, p, phase) => {
          if (p.freq === undefined) return;
          const cur = viewRef.current!;
          if (id === 'low') patch({ lowHz: Math.max(20, Math.min(2000, Math.min(p.freq, cur.highHz / 2))) }, phase);
          else patch({ highHz: Math.max(1000, Math.min(20000, Math.max(p.freq, cur.lowHz * 2))) }, phase);
        }}
        curves={graphCurves}
        analyzer="off"
        ariaLabel="Match EQ graph: source spectrum, reference spectrum and correction curve. Drag L and H to set the frequency limits."
        className="syn-deq-graph syn-meq-graph"
      />
      <div className="syn-meq-controls" role="group" aria-label="Match EQ settings">
        <NumField label="Amount" unit="%" value={view.amount} min={0} max={100} step={1} decimals={0} onChange={(v, phase) => patch({ amount: v }, phase)} />
        <SelField label="Smoothing" value={String(view.smoothing)} options={MATCH_EQ_SMOOTHING_OPTIONS.map((n) => ({ value: String(n), label: SMOOTHING_LABEL(n) }))} onChange={(v) => patch({ smoothing: Number(v) as MatchEqSmoothing })} />
        <NumField label="Max boost" unit="dB" value={view.maxBoostDb} min={0} max={12} step={0.1} decimals={1} onChange={(v, phase) => patch({ maxBoostDb: v }, phase)} />
        <NumField label="Max cut" unit="dB" value={view.maxCutDb} min={0} max={12} step={0.1} decimals={1} onChange={(v, phase) => patch({ maxCutDb: v }, phase)} />
        <NumField label="Low limit" unit="Hz" value={view.lowHz} min={20} max={2000} step={1} log decimals={0} onChange={(v, phase) => patch({ lowHz: Math.min(v, view.highHz / 2) }, phase)} />
        <NumField label="High limit" unit="Hz" value={view.highHz} min={1000} max={20000} step={10} log decimals={0} onChange={(v, phase) => patch({ highHz: Math.max(v, view.lowHz * 2) }, phase)} />
        <div className="syn-eqx-num syn-meq-seg-field">
          <span className="syn-eqx-num-label" id={`${module.id}-meq-ch`}>Channel</span>
          <div className="syn-seg" role="group" aria-labelledby={`${module.id}-meq-ch`}>
            {(['stereo', 'mid', 'side'] as const).map((ch) => (
              <button key={ch} type="button" aria-pressed={view.channel === ch} className={view.channel === ch ? 'is-on' : ''} onClick={() => patch({ channel: ch })}>{CHANNEL_LABEL[ch]}</button>
            ))}
          </div>
        </div>
        <SelField label="Phase" value={view.phase} options={[{ value: 'linear', label: 'Linear phase' }, { value: 'minimum', label: 'Minimum phase' }]} onChange={(v) => patch({ phase: v === 'minimum' ? 'minimum' : 'linear' })} />
      </div>
      <div className="syn-meq-presets" role="group" aria-label="Saved learned curves">
        <label className="syn-eqx-num syn-meq-name">
          <span className="syn-eqx-num-label">Curve name</span>
          <input type="text" value={presetName} maxLength={80} placeholder={view.referenceName ?? 'My reference curve'} onChange={(e) => setPresetName(e.target.value)} aria-label="Name for the saved learned curve" />
        </label>
        <button type="button" className="syn-deq-addband" onClick={doSave} disabled={!learned}>Save curve</button>
        {presets.length > 0 && (
          <SelField
            label="Load curve"
            value=""
            options={[{ value: '', label: 'Choose…' }, ...presets.map((p) => ({ value: p.id, label: p.name }))]}
            onChange={(v) => { if (v) doLoad(v); }}
          />
        )}
        {presets.length > 0 && (
          <details className="syn-meq-manage">
            <summary>Manage ({presets.length})</summary>
            <ul>
              {presets.map((p) => (
                <li key={p.id}>
                  <span>{p.name}</span>
                  <button type="button" onClick={() => doDelete(p.id)} aria-label={`Delete saved curve ${p.name}`}>Delete</button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
      {notice && <p className="syn-meq-notice" role="status">{notice}</p>}
      <p className="syn-deq-footnote">
        Matches tonal shape, not loudness. Renders offline as a {view.phase === 'linear' ? 'linear-phase (latency-compensated)' : 'minimum-phase'} FIR in preview, FIX ALL and export; live playback before a render uses a minimum-phase approximation.
      </p>
    </div>
  );
};

export default MatchEQPanel;
