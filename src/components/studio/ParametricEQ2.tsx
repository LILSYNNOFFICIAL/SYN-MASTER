import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AudioAnalysis, EQBand, EQBandShape, EQBandSubtype, EQChannel, EQSlope, ParametricEQParams } from '../../types/mastering';
import {
  CHANNEL_LABELS,
  DEFAULT_SUBTYPE,
  EQ_CHANNELS,
  EQ_SUBTYPES,
  SHAPE_LABELS,
  SUBTYPE_LABELS,
  allowedSlopes,
  bandChannel,
  designBandSections,
  eqDisplayCurves,
  freqToNote,
  resolveSlope,
  resolveSubtype,
  sectionsMagnitudeDb,
  usesGain,
} from '../../dsp/eqDesign';
import { MAX_EQ_BANDS, validateProcessorParams } from '../../dsp/chainValidation';
import type { FadeSettings } from '../../dsp/fades';
import { EqGraph, type AnalyzerMode, type EqGraphNode } from './eq/EqGraph';
import { EqBandPopover, NumField, SelField } from './eq/EqBandPopover';
import { EqTypeMenu, type TypeMenuOption } from './eq/EqTypeMenu';
import { CurveIcon } from './eq/CurveIcon';
import { BAND_COLORS, F_MAX, F_MIN, G_MAX, H, W, curveFreqs, fToX, fmtHz, gToY } from './eq/graphMath';
import { BUILTIN_EQ_PRESETS, deleteUserEqPreset, loadUserEqPresets, saveUserEqPreset, type EqPreset } from './eq/eqPresets';

/**
 * SYN EQ: Ozone / FL Studio Parametric EQ 2-class editor.
 *  - Graph: pre/post analyser, per-band fills, mid curve plus dashed side / left / right curves,
 *    draggable nodes (drag = freq/gain, Shift = fine, wheel or diamond handles = Q, double-click
 *    empty space = add band, double-click node = reset gain), keyboard nudges.
 *  - Per-band popover: power / S (listen) / X, cascading Type menu (Bell, shelves, passes with
 *    subtypes; Notch, Band-Pass, Tilt), numeric freq (with note) / gain / Q, slope, channel.
 *  - Global: phase mode, analyser mode, auto-gain, output gain, tilt, A/B snapshots, presets.
 * The curve uses the same section designs as the offline render and the realtime graph.
 * Edits stream locally while dragging and commit once on release (one undo step per gesture).
 */
interface Props {
  params: ParametricEQParams;
  sampleRate: number;
  /** Analysis for the analyser when pre/post are not given separately. */
  spectrum: AudioAnalysis | null;
  onChange: (next: ParametricEQParams) => void;
  variant?: 'classic' | 'console';
  waveformPeaks?: number[] | null;
  durationSec?: number;
  /** Seek the shared track timeline from the overlaid waveform. */
  onSeek?: (sec: number) => void;
  /** Fade curves are rendered over the same waveform blanket. */
  fades?: FadeSettings;
  onFadesChange?: (next: FadeSettings | ((current: FadeSettings) => FadeSettings)) => void;
  /** Source (pre-chain) analysis. */
  preSpectrum?: AudioAnalysis | null;
  /** Rendered (post-chain) analysis. */
  postSpectrum?: AudioAnalysis | null;
  /** Module output gain (dB), shown as the EQ's global output. */
  outputGainDb?: number;
  onOutputGainDb?: (db: number) => void;
}

const PASS_SHAPES: EQBandShape[] = ['lowpass', 'highpass'];

function iconFor(b: Pick<EQBand, 'shape' | 'subtype'>): string {
  const sub = resolveSubtype(b);
  if (b.shape === 'bell') return sub === 'bell' || !sub ? 'bell' : sub;
  if (sub && (b.shape.endsWith('shelf') || PASS_SHAPES.includes(b.shape))) return `${b.shape}-${sub}`;
  return b.shape;
}

const TYPE_OPTIONS: TypeMenuOption[] = (['bell', 'lowshelf', 'highshelf', 'lowpass', 'highpass', 'notch', 'bandpass', 'tilt'] as EQBandShape[]).map((shape) => ({
  value: shape,
  label: SHAPE_LABELS[shape],
  icon: shape,
  children: EQ_SUBTYPES[shape].length
    ? EQ_SUBTYPES[shape].map((sub) => ({ value: sub, label: SUBTYPE_LABELS[sub], icon: iconFor({ shape, subtype: sub }) }))
    : undefined,
}));

/** Does Q change this band's curve? */
function qMatters(b: EQBand): boolean {
  const sub = resolveSubtype(b);
  if (b.shape === 'tilt') return false;
  if (sub === 'baxandall' || sub === 'brickwall') return false;
  if ((b.shape === 'lowshelf' || b.shape === 'highshelf') && resolveSlope(b) === 6) return false;
  if (PASS_SHAPES.includes(b.shape) && resolveSlope(b) === 6) return false;
  return true;
}

function nodeY(b: EQBand): { yDb: number; yMode: EqGraphNode['yMode'] } {
  if (usesGain(b.shape)) return { yDb: b.gain, yMode: 'gain' };
  if (PASS_SHAPES.includes(b.shape) && qMatters(b)) return { yDb: Math.max(-G_MAX, Math.min(G_MAX, 6 * Math.log2(b.q / 0.707))), yMode: 'q' };
  return { yDb: 0, yMode: 'none' };
}

function bandTitle(b: EQBand, i: number): string {
  const sub = resolveSubtype(b);
  const def = DEFAULT_SUBTYPE[b.shape];
  return `Band ${i + 1}: ${SHAPE_LABELS[b.shape]}${sub && sub !== def ? ` ${SUBTYPE_LABELS[sub]}` : ''}`;
}

function bandDescription(b: EQBand, i: number, msMode: ParametricEQParams['msMode']): string {
  return `${bandTitle(b, i)}, ${fmtHz(b.freq)}${usesGain(b.shape) ? `, ${b.gain.toFixed(1)} dB` : ''}${qMatters(b) ? `, Q ${b.q.toFixed(2)}` : ''}, ${CHANNEL_LABELS[bandChannel(b, msMode)]}${b.enabled ? '' : ', off'}${b.solo ? ', soloed' : ''}`;
}

function readAnalyzer(): AnalyzerMode {
  try {
    const v = localStorage.getItem('syn-master.eq-analyzer');
    if (v === 'off' || v === 'pre' || v === 'post' || v === 'both') return v;
  } catch { /* ignore */ }
  return 'post';
}

export const ParametricEQ2: React.FC<Props> = ({
  params, sampleRate, spectrum, onChange, variant = 'classic', waveformPeaks = null, durationSec = 0, onSeek, fades, onFadesChange,
  preSpectrum, postSpectrum, outputGainDb, onOutputGainDb,
}) => {
  const isConsole = variant === 'console';
  const [draft, setDraft] = useState<ParametricEQParams | null>(null);
  const view = draft ?? params;
  const viewRef = useRef(view);
  viewRef.current = view;
  const [sel, setSel] = useState<string | null>(null);
  const [analyzer, setAnalyzerState] = useState<AnalyzerMode>(readAnalyzer);
  const setAnalyzer = (m: AnalyzerMode) => {
    setAnalyzerState(m);
    try { localStorage.setItem('syn-master.eq-analyzer', m); } catch { /* ignore */ }
  };
  const [slots, setSlots] = useState<{ active: 'A' | 'B'; other: ParametricEQParams | null }>({ active: 'A', other: null });
  const [userPresets, setUserPresets] = useState<EqPreset[]>(() => loadUserEqPresets());
  const bands = view.bands;

  // A committed change from outside (undo/redo, AI, preset) drops any stale drag draft.
  useEffect(() => setDraft(null), [params]);
  useEffect(() => {
    if (sel && !params.bands.some((b) => b.id === sel)) setSel(null);
  }, [params, sel]);

  const commit = useCallback((next: ParametricEQParams) => {
    setDraft(null);
    onChange(next);
  }, [onChange]);

  const patchBand = useCallback((id: string, patch: Partial<EQBand>, phase: 'move' | 'end' = 'end') => {
    const cur = viewRef.current;
    const next = { ...cur, bands: cur.bands.map((b) => (b.id === id ? { ...b, ...patch } : b)) };
    if (phase === 'move') setDraft(next);
    else commit(next);
  }, [commit]);

  const removeBand = (id: string) => {
    commit({ ...viewRef.current, bands: viewRef.current.bands.filter((b) => b.id !== id) });
    setSel(null);
  };

  const addBand = (freq = 1000, gain = 0) => {
    const cur = viewRef.current;
    if (cur.bands.length >= MAX_EQ_BANDS) return;
    const used = new Set(cur.bands.map((b) => b.id));
    let n = cur.bands.length + 1;
    while (used.has(`b${n}`)) n++;
    const nb: EQBand = { id: `b${n}`, enabled: true, shape: 'bell', subtype: 'bell', freq, gain, q: 1 };
    commit({ ...cur, bands: [...cur.bands, nb] });
    setSel(nb.id);
  };

  const toggleSolo = (id: string) => {
    const cur = viewRef.current;
    const on = !cur.bands.find((b) => b.id === id)?.solo;
    commit({ ...cur, bands: cur.bands.map((b) => {
      if (b.id === id) return on ? { ...b, solo: true } : (({ solo: _s, ...rest }) => rest)(b);
      if (on && b.solo) return (({ solo: _s, ...rest }) => rest)(b);
      return b;
    }) });
  };

  const setType = (b: EQBand, value: string, parent?: string) => {
    const shape = (parent ?? value) as EQBandShape;
    const subtype = parent ? (value as EQBandSubtype) : DEFAULT_SUBTYPE[shape] ?? undefined;
    const next: EQBand = { ...b, shape };
    if (subtype) next.subtype = subtype;
    else delete next.subtype;
    const slopes = allowedSlopes(shape, resolveSubtype(next));
    if (next.slope !== undefined && !slopes.includes(next.slope)) delete next.slope;
    if (PASS_SHAPES.includes(shape) && !PASS_SHAPES.includes(b.shape)) next.q = 0.71;
    patchBand(b.id, next);
  };

  // Curves (same designs as the renderer)
  const freqs = useMemo(() => curveFreqs(240), []);
  const curves = useMemo(() => {
    const c = eqDisplayCurves(view, sampleRate, freqs);
    const perBand = view.bands.map((b) => (b.enabled ? freqs.map((f) => sectionsMagnitudeDb(designBandSections(b, sampleRate, 1), f, sampleRate)) : null));
    const extras = [
      c.side && { key: 'side', label: 'Side', values: c.side, color: '#E040FB' },
      c.left && { key: 'left', label: 'Left', values: c.left, color: '#7BE0A0' },
      c.right && { key: 'right', label: 'Right', values: c.right, color: '#FF8A5B' },
    ].filter(Boolean) as Array<{ key: string; label: string; values: number[]; color: string }>;
    return { freqs, main: c.main, perBand, extras, autoGainDb: c.autoGainDb };
  }, [view, sampleRate, freqs]);

  const nodes: EqGraphNode[] = bands.map((b, i) => {
    const { yDb, yMode } = nodeY(b);
    return {
      id: b.id,
      freq: b.freq,
      yDb,
      yMode,
      q: b.q,
      enabled: b.enabled,
      color: BAND_COLORS[i % BAND_COLORS.length],
      label: String(i + 1),
      description: bandDescription(b, i, view.msMode),
      showQ: (b.shape === 'bell' || b.shape === 'notch' || b.shape === 'bandpass') && qMatters(b),
      solo: b.solo,
    };
  });

  const onNodeChange = (id: string, patch: { freq?: number; yDb?: number; q?: number }, phase: 'move' | 'end') => {
    const b = viewRef.current.bands.find((x) => x.id === id);
    if (!b) return;
    const out: Partial<EQBand> = {};
    if (patch.freq !== undefined) out.freq = patch.freq;
    if (patch.q !== undefined && qMatters(b)) out.q = patch.q;
    if (patch.yDb !== undefined) {
      const { yMode } = nodeY(b);
      if (yMode === 'gain') out.gain = patch.yDb;
      if (yMode === 'q') out.q = Number(Math.max(0.3, Math.min(12, 0.707 * Math.pow(2, patch.yDb / 6))).toFixed(2));
    }
    if (Object.keys(out).length) patchBand(id, out, phase);
  };

  const selected = bands.find((b) => b.id === sel) ?? null;
  const selIdx = selected ? bands.indexOf(selected) : -1;
  const soloIdx = bands.findIndex((b) => b.solo);

  const pre = preSpectrum !== undefined ? preSpectrum : spectrum;
  const post = postSpectrum !== undefined ? postSpectrum : spectrum;

  const applyPreset = (p: EqPreset) => commit(validateProcessorParams('parametric-eq', p.params) as ParametricEQParams);
  const switchAB = (to: 'A' | 'B') => {
    if (to === slots.active) return;
    const current = viewRef.current;
    const target = slots.other ?? current;
    setSlots({ active: to, other: current });
    if (target !== current) commit(target);
  };

  const popover = selected && (() => {
    const b = selected;
    const i = selIdx;
    const sub = resolveSubtype(b);
    const slopes = allowedSlopes(b.shape, sub);
    const note = freqToNote(b.freq);
    const { yDb } = nodeY(b);
    return (
      <EqBandPopover
        anchorX={fToX(b.freq) / W}
        anchorY={gToY(Math.max(-G_MAX, Math.min(G_MAX, yDb))) / H}
        color={BAND_COLORS[i % BAND_COLORS.length]}
        title={`Band ${i + 1}`}
        enabled={b.enabled}
        solo={Boolean(b.solo)}
        onToggleEnabled={() => patchBand(b.id, { enabled: !b.enabled })}
        onToggleSolo={() => toggleSolo(b.id)}
        onDelete={() => removeBand(b.id)}
        onClose={() => setSel(null)}
        typeMenu={
          <EqTypeMenu
            ariaLabel={`Band ${i + 1} type`}
            label={sub && sub !== DEFAULT_SUBTYPE[b.shape] ? `${SHAPE_LABELS[b.shape]} · ${SUBTYPE_LABELS[sub]}` : SHAPE_LABELS[b.shape]}
            icon={iconFor(b)}
            options={TYPE_OPTIONS}
            activeParent={b.shape}
            activeValue={sub ?? b.shape}
            onSelect={(v, parent) => setType(b, v, parent)}
          />
        }
      >
        <NumField label="Freq" unit="Hz" value={b.freq} min={F_MIN} max={F_MAX} step={1} log decimals={b.freq < 100 ? 1 : 0} onChange={(v, ph) => patchBand(b.id, { freq: v }, ph)} />
        <span className="syn-eqx-note" aria-label="Nearest note">{note.note} {note.cents >= 0 ? '+' : ''}{note.cents}¢</span>
        <NumField label="Gain" unit="dB" value={b.gain} min={-G_MAX} max={G_MAX} step={0.1} decimals={1} disabled={!usesGain(b.shape)} onChange={(v, ph) => patchBand(b.id, { gain: v }, ph)} />
        <NumField label="Q" value={b.q} min={0.1} max={18} step={0.01} log decimals={2} disabled={!qMatters(b)} onChange={(v, ph) => patchBand(b.id, { q: v }, ph)} />
        {slopes.length > 0 && (
          <SelField label="Slope" value={String(resolveSlope(b))} options={slopes.map((s) => ({ value: String(s), label: `${s} dB/oct` }))}
            onChange={(v) => patchBand(b.id, { slope: Number(v) as EQSlope })} />
        )}
        <SelField label="Channel" value={bandChannel(b, view.msMode)} options={EQ_CHANNELS.map((c) => ({ value: c, label: CHANNEL_LABELS[c] }))}
          onChange={(v) => patchBand(b.id, { channel: v as EQChannel })} />
      </EqBandPopover>
    );
  })();

  return (
    <div className={`syn-ceq syn-eqx${isConsole ? ' is-console' : ' is-compact'}`}>
      <div className="syn-eqx-toolbar" role="toolbar" aria-label="EQ settings">
        <SelField label="Phase" value={view.phaseMode} options={[{ value: 'minimum', label: 'Minimum' }, { value: 'linear', label: 'Linear' }]} onChange={(v) => commit({ ...view, phaseMode: v as ParametricEQParams['phaseMode'] })} />
        <SelField label="Analyser" value={analyzer} options={[{ value: 'post', label: 'Post' }, { value: 'pre', label: 'Pre' }, { value: 'both', label: 'Pre + Post' }, { value: 'off', label: 'Off' }]} onChange={(v) => setAnalyzer(v as AnalyzerMode)} />
        <button type="button" className={`syn-eqx-chip${view.autoGain ? ' is-on' : ''}`} aria-pressed={Boolean(view.autoGain)} onClick={() => {
          const next = { ...view };
          if (view.autoGain) delete next.autoGain;
          else next.autoGain = true;
          commit(next);
        }} title="Trim output to cancel the curve's loudness change">
          Auto gain{view.autoGain ? ` ${curves.autoGainDb >= 0 ? '+' : ''}${curves.autoGainDb.toFixed(1)} dB` : ''}
        </button>
        {onOutputGainDb && (
          <NumField label="Output" unit="dB" value={outputGainDb ?? 0} min={-12} max={12} step={0.1} decimals={1} onChange={(v, ph) => { if (ph === 'end') onOutputGainDb(v); }} />
        )}
        <NumField label="Tilt" unit="dB" value={view.tiltDb} min={-6} max={6} step={0.1} decimals={1} onChange={(v, ph) => (ph === 'move' ? setDraft({ ...viewRef.current, tiltDb: v }) : commit({ ...viewRef.current, tiltDb: v }))} />
        <div className="syn-eqx-ab" role="group" aria-label="A/B snapshots">
          {(['A', 'B'] as const).map((s) => (
            <button key={s} type="button" aria-pressed={slots.active === s} className={slots.active === s ? 'is-on' : ''} onClick={() => switchAB(s)}>{s}</button>
          ))}
          <button type="button" title="Copy the current curve to the other slot" onClick={() => setSlots((p) => ({ ...p, other: viewRef.current }))}>{slots.active}→{slots.active === 'A' ? 'B' : 'A'}</button>
        </div>
        <label className="syn-eqx-num syn-eqx-sel">
          <span className="syn-eqx-num-label">Preset</span>
          <select aria-label="EQ preset" value="" onChange={(e) => {
            const v = e.target.value;
            if (v === '__save') {
              const name = typeof window !== 'undefined' ? window.prompt('Save EQ preset as:', 'My EQ') : null;
              if (name) setUserPresets(saveUserEqPreset(name, viewRef.current));
            } else if (v.startsWith('__del:')) {
              setUserPresets(deleteUserEqPreset(v.slice(6)));
            } else {
              const p = [...BUILTIN_EQ_PRESETS, ...userPresets].find((x) => x.id === v);
              if (p) applyPreset(p);
            }
          }}>
            <option value="" disabled>Load / save…</option>
            <optgroup label="Built-in">{BUILTIN_EQ_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>
            {userPresets.length > 0 && <optgroup label="Saved">{userPresets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>}
            <option value="__save">Save current as…</option>
            {userPresets.length > 0 && <optgroup label="Delete saved">{userPresets.map((p) => <option key={`d-${p.id}`} value={`__del:${p.id}`}>Delete “{p.name}”</option>)}</optgroup>}
          </select>
        </label>
        <button type="button" className="syn-eqx-chip" disabled={bands.length >= MAX_EQ_BANDS} onClick={() => addBand()}>+ Band</button>
      </div>
      {soloIdx >= 0 && (
        <div className="syn-eqx-solo-note" role="status">Listening to band {soloIdx + 1} only (preview). Export and Fix All ignore solo.</div>
      )}
      <EqGraph
        nodes={nodes}
        selectedId={sel}
        onSelect={setSel}
        onNodeChange={onNodeChange}
        onAdd={bands.length < MAX_EQ_BANDS ? (f, g) => addBand(f, g) : undefined}
        onDelete={removeBand}
        onResetGain={(id) => { const b = bands.find((x) => x.id === id); if (b && usesGain(b.shape)) patchBand(id, { gain: 0 }); }}
        onToggleSolo={toggleSolo}
        curves={curves}
        preSpectrum={pre}
        postSpectrum={post}
        analyzer={analyzer}
        waveformPeaks={isConsole ? waveformPeaks : null}
        durationSec={isConsole ? durationSec : 0}
        onSeek={isConsole ? onSeek : undefined}
        fades={isConsole ? fades : undefined}
        onFadesChange={isConsole ? onFadesChange : undefined}
        ariaLabel="Parametric EQ. Click or drag the waveform background to seek; focus the graph background and use Left/Right to seek (Shift for 1-second steps, Home/End for start/end). Tab to a band node; arrow keys move frequency and gain, plus and minus change Q, S solos, Delete removes, Escape closes. Drag nodes, wheel or the diamond handles for Q, double-click to add a band."
      >
        {popover}
      </EqGraph>
      {curves.extras.length > 0 && (
        <div className="syn-eqx-legend" aria-hidden="true">
          <span style={{ color: '#3FE0FF' }}>━ Mid / mono</span>
          {curves.extras.map((x) => <span key={x.key} style={{ color: x.color }}>┅ {x.label}</span>)}
        </div>
      )}
      <div className="syn-eqx-bands" role="list" aria-label="EQ bands">
        {bands.map((b, i) => (
          <button
            key={b.id}
            type="button"
            role="listitem"
            className={`syn-eqx-band${b.id === sel ? ' is-sel' : ''}${b.enabled ? '' : ' is-off'}${b.solo ? ' is-solo' : ''}`}
            style={{ ['--band-color' as string]: BAND_COLORS[i % BAND_COLORS.length] }}
            aria-pressed={b.id === sel}
            aria-label={bandDescription(b, i, view.msMode)}
            onClick={() => setSel(b.id === sel ? null : b.id)}
          >
            <b>{i + 1}</b>
            <CurveIcon kind={iconFor(b)} />
            <span>{fmtHz(b.freq)}</span>
            {usesGain(b.shape) && <span>{b.gain > 0 ? '+' : ''}{b.gain.toFixed(1)}</span>}
            {bandChannel(b, view.msMode) !== 'stereo' && <em>{CHANNEL_LABELS[bandChannel(b, view.msMode)][0]}</em>}
          </button>
        ))}
      </div>
    </div>
  );
};
