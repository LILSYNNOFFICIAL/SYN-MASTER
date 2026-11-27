import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AudioAnalysis, DynamicEQBandType, DynamicEQParams, EQChannel, ProcessorModule } from '../../types/mastering';
import type { DynamicEqTrace } from '../../dsp/offlineDsp';
import {
  CHANNEL_LABELS, DYNAMIC_EQ_TYPES, DYNAMIC_TYPE_LABELS, EQ_CHANNELS,
  designDynamicSections, freqToNote, sectionsMagnitudeDb,
} from '../../dsp/eqDesign';
import { MAX_DYNAMIC_EQ_BANDS } from '../../dsp/chainValidation';
import type { FadeSettings } from '../../dsp/fades';
import { telemetryStore } from '../../engine/telemetryStore';
import { EqGraph, type AnalyzerMode, type EqGraphNode } from './eq/EqGraph';
import { EqBandPopover, NumField, SelField } from './eq/EqBandPopover';
import { EqTypeMenu } from './eq/EqTypeMenu';
import { CurveIcon } from './eq/CurveIcon';
import { BAND_COLORS, H, W, curveFreqs, fToX, fmtHz, gToY } from './eq/graphMath';

type Band = DynamicEQParams['bands'][number];
const LEGACY_RATIO = 20 / 7;
const FREQS = curveFreqs(240);
const TYPE_OPTIONS = DYNAMIC_EQ_TYPES.map((type) => ({ value: type, label: DYNAMIC_TYPE_LABELS[type], icon: type }));

interface Props {
  module: ProcessorModule | undefined;
  sampleRate: number;
  preSpectrum: AudioAnalysis | null;
  postSpectrum: AudioAnalysis | null;
  waveformPeaks?: number[] | null;
  durationSec?: number;
  onSeek?: (sec: number) => void;
  fades?: FadeSettings;
  onFadesChange?: React.Dispatch<React.SetStateAction<FadeSettings>>;
  trace?: DynamicEqTrace;
  onAdd: () => void;
  onChange: (next: DynamicEQParams) => void;
  onToggle: (on: boolean) => void;
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const modeOf = (b: Band): 'cut' | 'boost' => b.mode === 'boost' ? 'boost' : 'cut';
const rangeOf = (b: Band) => modeOf(b) === 'boost' ? Math.max(0, b.maxCutDb) : Math.min(0, b.maxCutDb);

function readTrace(trace: DynamicEqTrace | undefined, id: string, timeSec: number) {
  const band = trace?.bands.find((item) => item.id === id);
  if (!trace || !band || !band.gainDb.length) return null;
  const at = clamp(Math.floor(Math.max(0, timeSec) * trace.sampleRate / trace.hopSamples), 0, band.gainDb.length - 1);
  return { detectorDb: band.detectorDb[at] ?? -120, gainDb: band.gainDb[at] ?? 0 };
}

function bandCurve(bands: Band[], sampleRate: number, gain: (band: Band) => number): number[][] {
  return bands.map((band) => {
    if (!band.enabled) return FREQS.map(() => 0);
    const sections = designDynamicSections(band.type, band.freq, band.q, gain(band), sampleRate);
    return FREQS.map((freq) => sectionsMagnitudeDb(sections, freq, sampleRate));
  });
}

function sumCurves(curves: number[][]): number[] {
  return FREQS.map((_, i) => curves.reduce((sum, curve) => sum + (curve[i] ?? 0), 0));
}

const ThresholdMeter: React.FC<{ detectorDb: number; thresholdDb: number; hasTrace: boolean }> = ({ detectorDb, thresholdDb, hasTrace }) => {
  const level = clamp(((detectorDb + 60) / 60) * 100, 0, 100);
  const threshold = clamp(((thresholdDb + 60) / 60) * 100, 0, 100);
  return (
    <div className="syn-eqx-thr" aria-label="Dynamic EQ detector meter">
      <div className="syn-eqx-thr-meter" role="img" aria-label={hasTrace ? 'Detector ' + detectorDb.toFixed(1) + ' dBFS, threshold ' + thresholdDb.toFixed(1) + ' dBFS' : 'Detector trace appears after a preview render'}>
        <div className="syn-eqx-thr-track" style={{ left: '20px' }} />
        <div className="syn-eqx-thr-level" style={{ left: '20px', height: level + '%' }} />
        <div className="syn-eqx-thr-line" style={{ bottom: threshold + '%' }} />
      </div>
      <div className="syn-eqx-thr-read">
        <span>DETECTOR</span>
        <b className={hasTrace ? 'is-live' : ''}>{hasTrace ? detectorDb.toFixed(1) + ' dBFS' : '—'}</b>
        <span>THRESHOLD</span>
        <b>{thresholdDb.toFixed(1) + ' dB'}</b>
      </div>
    </div>
  );
};

/** Shared Ozone-style graph/popover with a stronger cyan/purple glow and real preview traces. */
export const DynamicEQPanel: React.FC<Props> = ({ module, sampleRate, preSpectrum, postSpectrum, waveformPeaks, durationSec = 0, onSeek, fades, onFadesChange, trace, onAdd, onChange, onToggle }) => {
  const [draft, setDraft] = useState<DynamicEQParams | null>(null);
  const params = module?.params as DynamicEQParams | undefined;
  const view = draft ?? params;
  const viewRef = useRef(view);
  viewRef.current = view;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [analyzer, setAnalyzer] = useState<AnalyzerMode>('post');
  const [timeSec, setTimeSec] = useState(() => telemetryStore.getSnapshot().currentTimeSec);

  useEffect(() => telemetryStore.subscribe((s) => setTimeSec(s.currentTimeSec)), []);
  useEffect(() => setDraft(null), [params]);
  useEffect(() => {
    if (selectedId && !params?.bands.some((b) => b.id === selectedId)) setSelectedId(null);
  }, [params, selectedId]);

  const commit = useCallback((next: DynamicEQParams) => {
    setDraft(null);
    onChange(next);
  }, [onChange]);

  const patchBand = useCallback((id: string, patch: Partial<Band>, phase: 'move' | 'end' = 'end') => {
    const current = viewRef.current;
    if (!current) return;
    const next = { ...current, bands: current.bands.map((b) => b.id === id ? { ...b, ...patch } : b) };
    if (phase === 'move') setDraft(next);
    else commit(next);
  }, [commit]);

  const removeBand = useCallback((id: string) => {
    const current = viewRef.current;
    if (!current) return;
    commit({ ...current, bands: current.bands.filter((b) => b.id !== id) });
    setSelectedId(null);
  }, [commit]);

  const addBand = useCallback((freq?: number, gainDb = -3) => {
    const current = viewRef.current;
    if (!current || current.bands.length >= MAX_DYNAMIC_EQ_BANDS) return;
    const used = new Set(current.bands.map((b) => b.id));
    let n = current.bands.length + 1;
    while (used.has('d' + n)) n++;
    const preferredFreqs = [1200, 500, 3000, 200, 7000, 80, 1600, 10000];
    const separatedFreq = preferredFreqs.find((candidate) => current.bands.every((band) => Math.max(candidate, band.freq) / Math.min(candidate, band.freq) > 1.5));
    const distanceFromBands = (candidate: number) => current.bands.length
      ? Math.min(...current.bands.map((band) => Math.abs(Math.log2(candidate / band.freq))))
      : Number.POSITIVE_INFINITY;
    const fallbackFreq = preferredFreqs.reduce((best, candidate) => distanceFromBands(candidate) > distanceFromBands(best) ? candidate : best, preferredFreqs[0]);
    const nextFreq = freq ?? separatedFreq ?? fallbackFreq;
    const mode = gainDb > 0 ? 'boost' : 'cut';
    const rangeDb = gainDb > 0 ? Math.max(0.05, gainDb) : Math.min(-0.05, gainDb);
    const nextBand: Band = {
      id: 'd' + n, enabled: true, freq: clamp(nextFreq, 30, 16000), q: 2,
      thresholdDb: -20, maxCutDb: rangeDb, ratio: LEGACY_RATIO, mode,
      attackMs: 10, releaseMs: 110,
    };
    commit({ ...current, bands: [...current.bands, nextBand] });
    setSelectedId(nextBand.id);
  }, [commit]);

  const toggleSolo = useCallback((id: string) => {
    const current = viewRef.current;
    if (!current) return;
    const enable = !current.bands.find((b) => b.id === id)?.solo;
    commit({
      ...current,
      bands: current.bands.map((b) => {
        if (b.id === id) return enable ? { ...b, solo: true } : (({ solo: _solo, ...rest }) => rest)(b);
        if (enable && b.solo) return (({ solo: _solo, ...rest }) => rest)(b);
        return b;
      }),
    });
  }, [commit]);

  const bands = view?.bands ?? [];
  const maxCurves = useMemo(() => bandCurve(bands, sampleRate, rangeOf), [bands, sampleRate]);
  const liveCurves = useMemo(
    () => bandCurve(bands, sampleRate, (b) => readTrace(trace, b.id, timeSec)?.gainDb ?? 0),
    [bands, sampleRate, trace, timeSec],
  );
  const liveAvailable = Boolean(trace?.bands.some((t) => bands.some((b) => b.id === t.id)));
  const curves = useMemo(() => ({
    freqs: FREQS,
    main: sumCurves(maxCurves),
    perBand: maxCurves,
    live: liveAvailable ? sumCurves(liveCurves) : null,
  }), [maxCurves, liveCurves, liveAvailable]);

  const nodes: EqGraphNode[] = bands.map((b, i) => ({
    id: b.id, freq: b.freq, yDb: rangeOf(b), yMode: 'gain', q: b.q, enabled: b.enabled,
    color: BAND_COLORS[i % BAND_COLORS.length], label: String(i + 1),
    description: 'Band ' + (i + 1) + ': ' + DYNAMIC_TYPE_LABELS[b.type ?? 'bell'] + ', ' + fmtHz(b.freq) + ', Q ' + b.q.toFixed(2) + ', ' + modeOf(b) + (b.enabled ? '' : ', off') + (b.solo ? ', soloed' : ''),
    showQ: true, solo: b.solo,
  }));

  const selected = bands.find((b) => b.id === selectedId) ?? null;
  const selectedIndex = selected ? bands.indexOf(selected) : -1;
  const popover = selected && (() => {
    const b = selected;
    const i = selectedIndex;
    const mode = modeOf(b);
    const range = rangeOf(b);
    const sample = readTrace(trace, b.id, timeSec);
    const sc = b.sidechain ?? { mode: 'band' as const, freq: b.freq, q: b.q };
    const note = freqToNote(b.freq);
    return (
      <EqBandPopover
        anchorX={fToX(b.freq) / W}
        anchorY={gToY(0) / H}
        color={BAND_COLORS[i % BAND_COLORS.length]}
        title={'Band ' + (i + 1)}
        enabled={b.enabled}
        solo={Boolean(b.solo)}
        onToggleEnabled={() => patchBand(b.id, { enabled: !b.enabled })}
        onToggleSolo={() => toggleSolo(b.id)}
        onDelete={() => removeBand(b.id)}
        onClose={() => setSelectedId(null)}
        typeMenu={
          <EqTypeMenu
            ariaLabel={'Band ' + (i + 1) + ' type'}
            label={DYNAMIC_TYPE_LABELS[b.type ?? 'bell']}
            icon={b.type ?? 'bell'}
            options={TYPE_OPTIONS}
            activeValue={b.type ?? 'bell'}
            onSelect={(value) => patchBand(b.id, { type: value as DynamicEQBandType })}
          />
        }
        side={<ThresholdMeter detectorDb={sample?.detectorDb ?? -120} thresholdDb={b.thresholdDb} hasTrace={Boolean(sample)} />}
        advanced={
          <>
            <NumField label="Ratio" value={b.ratio ?? LEGACY_RATIO} min={1} max={20} step={0.1} log decimals={1} unit=":1" onChange={(v, phase) => patchBand(b.id, { ratio: v }, phase)} />
            <NumField label="Attack" value={b.attackMs} min={1} max={100} step={1} log decimals={0} unit="ms" onChange={(v, phase) => patchBand(b.id, { attackMs: v }, phase)} />
            <NumField label="Release" value={b.releaseMs} min={20} max={600} step={1} log decimals={0} unit="ms" onChange={(v, phase) => patchBand(b.id, { releaseMs: v }, phase)} />
            <NumField label="Knee" value={b.kneeDb ?? 0} min={0} max={24} step={0.5} decimals={1} unit="dB" onChange={(v, phase) => patchBand(b.id, { kneeDb: v }, phase)} />
            <SelField label="Channel" value={b.channel ?? 'stereo'} options={EQ_CHANNELS.map((channel) => ({ value: channel, label: CHANNEL_LABELS[channel] }))} onChange={(v) => patchBand(b.id, { channel: v as EQChannel })} />
            <SelField label="Detector" value={sc.mode} options={[{ value: 'band', label: 'Follow band' }, { value: 'custom', label: 'Custom sidechain' }]} onChange={(v) => patchBand(b.id, { sidechain: { mode: v as 'band' | 'custom', freq: b.freq, q: b.q } })} />
            {sc.mode === 'custom' && (
              <>
                <NumField label="SC Freq" unit="Hz" value={sc.freq} min={30} max={16000} step={1} log decimals={0} onChange={(v, phase) => patchBand(b.id, { sidechain: { ...sc, freq: v } }, phase)} />
                <NumField label="SC Q" value={sc.q} min={0.3} max={10} step={0.05} log decimals={2} onChange={(v, phase) => patchBand(b.id, { sidechain: { ...sc, q: v } }, phase)} />
              </>
            )}
            <NumField label="Lookahead" value={b.lookaheadMs ?? 0} min={0} max={10} step={0.1} decimals={1} unit="ms" onChange={(v, phase) => patchBand(b.id, { lookaheadMs: v }, phase)} />
          </>
        }
      >
        <NumField label="Freq" unit="Hz" value={b.freq} min={30} max={16000} step={1} log decimals={b.freq < 100 ? 1 : 0} onChange={(v, phase) => patchBand(b.id, { freq: v }, phase)} />
        <span className="syn-eqx-note" aria-label="Nearest note">{note.note} {note.cents >= 0 ? '+' : ''}{note.cents}¢</span>
        <NumField label="Range" unit="dB" value={range} min={mode === 'boost' ? 0.05 : -12} max={mode === 'boost' ? 12 : -0.05} step={0.1} decimals={1} onChange={(v, phase) => patchBand(b.id, { maxCutDb: v }, phase)} />
        <NumField label="Q" value={b.q} min={0.5} max={10} step={0.01} log decimals={2} onChange={(v, phase) => patchBand(b.id, { q: v }, phase)} />
        <SelField label="Mode" value={mode} options={[{ value: 'cut', label: 'Cut' }, { value: 'boost', label: 'Boost' }]} onChange={(v) => patchBand(b.id, { mode: v as 'cut' | 'boost', maxCutDb: v === 'boost' ? Math.max(0.5, Math.abs(b.maxCutDb)) : -Math.max(0.5, Math.abs(b.maxCutDb)) })} />
        <NumField label="Threshold" unit="dB" value={b.thresholdDb} min={-45} max={0} step={0.5} decimals={1} onChange={(v, phase) => patchBand(b.id, { thresholdDb: v }, phase)} />
      </EqBandPopover>
    );
  })();

  if (!module || !params) {
    return (
      <div className="syn-deq syn-deq-empty">
        <p>Dynamic EQ moves a selected frequency band only when its detector crosses the threshold. Add it to control harshness, resonances, boomy notes or presence without applying static EQ all the time.</p>
        <button type="button" className="syn-deq-add" onClick={onAdd}>+ Add Dynamic EQ</button>
      </div>
    );
  }

  const on = module.enabled && !module.bypassed;
  return (
    <div className="syn-deq" data-on={on ? 'true' : 'false'} data-testid="dynamic-eq-editor">
      <div className="syn-deq-head">
        <button type="button" className="syn-deq-power" aria-pressed={on} onClick={() => onToggle(!on)}>{on ? 'ON' : 'BYPASSED'}</button>
        <span className="syn-deq-note">Dynamic response · live detector · preview and export</span>
        <button type="button" className="syn-deq-addband" onClick={() => addBand()} disabled={bands.length >= MAX_DYNAMIC_EQ_BANDS}>+ Band</button>
      </div>
      <div className="syn-deq-toolbar">
        <div className="syn-eqx-toolbar" role="group" aria-label="Dynamic EQ analyser">
          {(['pre', 'post', 'both', 'off'] as const).map((mode) => (
            <button key={mode} type="button" className={'syn-eqx-chip' + (analyzer === mode ? ' is-on' : '')} aria-pressed={analyzer === mode} onClick={() => setAnalyzer(mode)}>{mode.toUpperCase()}</button>
          ))}
        </div>
        <span className="syn-deq-live-label">{trace ? 'LIVE TRACE AVAILABLE' : 'LIVE TRACE AFTER PREVIEW'}</span>
      </div>
      <EqGraph
        nodes={nodes}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onNodeChange={(id, patch, phase) => {
          const band = bands.find((item) => item.id === id);
          if (!band) return;
          if (patch.yDb !== undefined) {
            const { yDb, ...bandPatch } = patch;
            const mode = yDb > 0 ? 'boost' : 'cut';
            patchBand(id, { ...bandPatch, mode, maxCutDb: yDb > 0 ? Math.max(0.05, yDb) : Math.min(-0.05, yDb) }, phase);
          } else {
            patchBand(id, patch, phase);
          }
        }}
        onAdd={(freq, gainDb) => addBand(freq, gainDb)}
        onDelete={removeBand}
        onToggleSolo={toggleSolo}
        curves={curves}
        preSpectrum={preSpectrum}
        postSpectrum={postSpectrum}
        analyzer={analyzer}
        waveformPeaks={waveformPeaks}
        durationSec={durationSec}
        onSeek={onSeek}
        fades={fades}
        onFadesChange={onFadesChange}
        ariaLabel="Dynamic EQ frequency response graph. Click or drag the waveform background to seek; focus the graph background and use Left/Right to seek (Shift for 1-second steps, Home/End for start/end). Drag a node horizontally to change frequency and vertically to set its maximum cut or boost; use the handles or mouse wheel to change Q, and double-click to add a band."
        className="syn-deq-graph"
      >
        {popover}
      </EqGraph>
      <div className="syn-eqx-bands" role="group" aria-label="Dynamic EQ bands">
        {bands.map((b, i) => {
          const sample = readTrace(trace, b.id, timeSec);
          return (
            <button
              key={b.id}
              type="button"
              className={'syn-eqx-band' + (b.id === selectedId ? ' is-sel' : '') + (b.enabled ? '' : ' is-off') + (b.solo ? ' is-solo' : '')}
              style={{ ['--band-color' as string]: BAND_COLORS[i % BAND_COLORS.length] }}
              aria-label={'Band ' + (i + 1) + ': ' + DYNAMIC_TYPE_LABELS[b.type ?? 'bell'] + ', ' + fmtHz(b.freq) + ', ' + modeOf(b) + ', threshold ' + b.thresholdDb.toFixed(1) + ' dB'}
              aria-pressed={b.id === selectedId}
              onClick={() => setSelectedId(b.id === selectedId ? null : b.id)}
            >
              <b>{i + 1}</b>
              <CurveIcon kind={b.type ?? 'bell'} />
              <span>{fmtHz(b.freq)}</span>
              <span>{sample ? sample.gainDb.toFixed(1) + ' dB' : modeOf(b).toUpperCase()}</span>
              <i className="syn-eqx-gr" style={{ width: clamp(Math.abs(sample?.gainDb ?? 0) / 12, 0, 1) * 100 + '%' }} />
            </button>
          );
        })}
      </div>
      <p className="syn-deq-footnote">The cyan curve follows the last completed preview render. Band solo is audition-only and never changes export or FIX ALL.</p>
    </div>
  );
};
