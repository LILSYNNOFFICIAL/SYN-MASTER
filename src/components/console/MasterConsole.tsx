import React, { useMemo, useState } from 'react';
import { BrainCircuit, Plus, Square, Upload } from 'lucide-react';
import type {
  AudioAnalysis,
  CompressorParams,
  LimiterParams,
  MasterFinalReport,
  MasteringPreset,
  MaximizerParams,
  MultibandMaximizerParams,
  ParametricEQParams,
  ProcessorModule,
  ProcessorType,
  SaturationParams,
  TransientShaperParams,
} from '../../types/mastering';
import { LOUDNESS_TARGET_PRESETS } from '../../dsp/loudnessTargets';
import { MODULE_CATALOG } from '../studio/moduleCatalog';
import { ParametricEQ2 } from '../studio/ParametricEQ2';
import { SpectrumAndEQCanvas } from '../CanvasVisualizers';
import { ArcKnob } from './ArcKnob';
import { GlowFader } from './GlowFader';
import { LightRibbons } from './LightRibbons';
import { StereoScope } from './StereoScope';

/**
 * SYN-MASTER console (reference-mockup layout). A presentation layer only: every control
 * edits the real processing chain through `onChangeChain` (the same path as the rack), and
 * every readout is a measured analysis value. Controls whose processor is not in the chain
 * offer to insert that processor from the module catalog instead of showing a dead knob.
 */
export interface MasterConsoleProps {
  chain: ProcessorModule[];
  chainBypassed: boolean;
  onChangeChain: (next: ProcessorModule[]) => void;
  sampleRate: number;
  source: AudioAnalysis | null;
  master: AudioAnalysis | null;
  referenceAnalysis: AudioAnalysis | null;
  scopeChannels: Float32Array[] | null;
  waveformPeaks: number[];
  durationSec: number;
  hasTrack: boolean;
  running: boolean;
  stage: string;
  pass: number;
  maxPasses: number;
  report: MasterFinalReport | null;
  onFix: () => void;
  onStop: () => void;
  onDemo: () => void;
  onImport: (file: File) => void;
  targetPresetId: string | null;
  targetLabel: string;
  targetLufs: number;
  maxTruePeakDb: number;
  onTargetPreset: (id: string) => void;
  presets: MasteringPreset[];
  onApplyPreset: (preset: MasteringPreset) => void;
  onOpenRack: () => void;
  onOpenStereoLab: () => void;
  /** Latest app status notice (also shown in the session ribbon on very wide screens). */
  notice?: string | null;
}

const LOUDNESS_STAGES: ProcessorType[] = ['limiter', 'maximizer', 'multiband-maximizer', 'clipper', 'dither'];
const CATALOG_FOR: Partial<Record<ProcessorType, string>> = {
  'parametric-eq': 'peq',
  'transient-shaper': 'transient',
  compressor: 'comp',
  saturation: 'saturation',
  maximizer: 'maximizer',
};
const LABEL_FOR: Partial<Record<ProcessorType, string>> = {
  'parametric-eq': 'Parametric EQ',
  'transient-shaper': 'Transient shaper',
  compressor: 'Compressor',
  saturation: 'Saturation',
  maximizer: 'Maximizer',
};

/** Insert a catalog processor before the loudness/delivery stages (limiter, maximizer, dither stay last). */
export function insertBeforeLoudnessStages(chain: ProcessorModule[], mod: ProcessorModule): ProcessorModule[] {
  if (LOUDNESS_STAGES.includes(mod.type)) {
    const ditherAt = chain.findIndex((m) => m.type === 'dither');
    if (ditherAt < 0) return [...chain, mod];
    return [...chain.slice(0, ditherAt), mod, ...chain.slice(ditherAt)];
  }
  const at = chain.findIndex((m) => LOUDNESS_STAGES.includes(m.type));
  if (at < 0) return [...chain, mod];
  return [...chain.slice(0, at), mod, ...chain.slice(at)];
}

const fmtSigned = (v: number, d = 1) => `${v > 0 ? '+' : ''}${v.toFixed(d)}`;

const Card: React.FC<{ title: string; className?: string; children: React.ReactNode; area?: string }> = ({ title, className = '', children, area }) => (
  <section className={`syn-card ${area ? `syn-area-${area} ` : ''}${className}`} aria-label={title}>
    <h3 className="syn-card-title">{title}</h3>
    {children}
  </section>
);

const AddModule: React.FC<{ type: ProcessorType; onAdd: (t: ProcessorType) => void }> = ({ type, onAdd }) => (
  <button type="button" className="syn-card-add" onClick={() => onAdd(type)}>
    <Plus className="w-3.5 h-3.5" /> Add {LABEL_FOR[type] ?? type}
  </button>
);

export const MasterConsole: React.FC<MasterConsoleProps> = (p) => {
  const [eqView, setEqView] = useState<'eq' | 'spectrum' | 'spectrogram'>('eq');
  const [presetId, setPresetId] = useState<string>(p.presets[0]?.id ?? '');
  const chain = p.chain;
  const find = (type: ProcessorType) => chain.find((m) => m.type === type && m.enabled);
  const patch = (id: string, next: Partial<ProcessorModule>) =>
    p.onChangeChain(chain.map((m) => (m.id === id ? { ...m, ...next } : m)));
  function setParams<T>(mod: ProcessorModule, next: Partial<T>) {
    patch(mod.id, { params: { ...(mod.params as T), ...next } as unknown as ProcessorModule['params'] });
  }
  const add = (type: ProcessorType) => {
    const item = MODULE_CATALOG.find((c) => c.id === CATALOG_FOR[type]) ?? MODULE_CATALOG.find((c) => c.type === type);
    if (!item) return;
    p.onChangeChain(insertBeforeLoudnessStages(chain, { ...item.build(), expanded: false }));
  };

  const eq = find('parametric-eq');
  const ts = find('transient-shaper');
  const comp = find('compressor');
  const sat = find('saturation');
  const ceilingMod = find('maximizer') ?? find('limiter') ?? find('multiband-maximizer');
  const firstStage = chain.find((m) => m.enabled);

  const shown = p.master ?? p.source;
  const lufs = shown?.integratedLufs ?? null;
  const tp = shown?.truePeakDb ?? null;
  const gate = p.report?.targetGate ?? null;
  const pct = p.running ? Math.min(100, Math.round((Math.max(0, p.pass) / Math.max(1, p.maxPasses)) * 100)) : p.report ? 100 : 0;

  const tonal = useMemo(() => {
    const z = shown?.zoneEnergyDb;
    if (!z) return null;
    const low = (z.sub + z.bass) / 2;
    const mid = (z.lowMid + z.mid) / 2;
    const high = (z.highMid + z.presence + z.air) / 3;
    const mean = (low + mid + high) / 3;
    return { low: low - mean, mid: mid - mean, high: high - mean };
  }, [shown]);

  const statusLine = p.running
    ? `${p.stage || 'Working'} · pass ${p.pass}/${p.maxPasses}`
    : gate
      ? gate.passed
        ? 'Verified · every target met'
        : 'Not fully verified · see details'
      : p.master
        ? 'Master measured'
        : p.hasTrack
          ? 'Ready to fix'
          : 'Load a track to begin';

  const ceiling = (() => {
    if (!ceilingMod) return null;
    const prm = ceilingMod.params as MaximizerParams | LimiterParams | MultibandMaximizerParams;
    const min = ceilingMod.type === 'limiter' ? -6 : -3;
    return { mod: ceilingMod, value: prm.ceilingDb, min };
  })();

  const inputKnob = (size: number, label: string) =>
    firstStage ? (
      <ArcKnob label={label} value={firstStage.inputGainDb} min={-12} max={12} step={0.1} defaultValue={0} unit="dB" signed bipolar accent="blue" size={size}
        rangeLabels={['-12', '+12']} caption={`Trim into ${firstStage.name}`} onChange={(v) => patch(firstStage.id, { inputGainDb: v })} />
    ) : (
      <AddModule type="parametric-eq" onAdd={add} />
    );

  const outputKnob = (size: number, label: string) =>
    ceiling ? (
      <ArcKnob label={label} value={ceiling.value} min={ceiling.min} max={-0.1} step={0.1} defaultValue={-1} unit="dBTP" accent="gold" size={size}
        caption={`${ceiling.mod.name} ceiling`} onChange={(v) => setParams<MaximizerParams>(ceiling.mod, { ceilingDb: v })} />
    ) : (
      <AddModule type="maximizer" onAdd={add} />
    );

  const fixButton = (
    <div className="syn2-fix-centerpiece syn-fixai-wrap syn-area-fix">
      <button
        type="button"
        className={`syn-fixai${p.running ? ' is-running' : ''}`}
        onClick={p.onFix}
        disabled={!p.hasTrack || p.running}
        aria-describedby="syn-fixai-status"
        aria-label={p.running ? 'Fix All with AI is running' : 'Fix All with AI: analyze, fix, render and verify the master'}
      >
        <span className="syn-fixai-ring" aria-hidden="true" />
        <BrainCircuit className="syn-fixai-icon" aria-hidden="true" />
        <span className="syn-fixai-text"><span>FIX ALL</span><strong>AI</strong></span>
        <svg className="syn-fixai-wave" viewBox="0 0 60 16" aria-hidden="true">
          <path d="M0 8 L8 8 L11 3 L14 13 L17 1 L20 15 L23 5 L26 11 L29 7 L32 9 L35 4 L38 12 L41 6 L44 10 L47 8 L60 8" />
        </svg>
      </button>
      <div id="syn-fixai-status" className="syn-fixai-status" role="status" aria-live="polite">
        {p.running ? statusLine : p.hasTrack ? 'AI POWERED · ADAPTIVE · VERIFIED' : 'IMPORT A TRACK TO ENABLE'}
      </div>
      {p.running && (
        <button type="button" className="syn-fixai-stop" onClick={p.onStop}>
          <Square className="w-3 h-3" /> Stop
        </button>
      )}
    </div>
  );

  return (
    <section className="syn-console" aria-label="SYN-MASTER console" data-testid="syn-console">
      <LightRibbons className="syn-console-ribbons" />

      <div className="syn-console-col syn-console-left">
        <Card title="Input" area="input" className="syn-card-knob">{inputKnob(116, 'Input trim')}</Card>
        <Card title="Transient" area="transient" className="syn-card-knob syn-only-desktop">
          {ts ? (
            <ArcKnob label="Attack" value={(ts.params as TransientShaperParams).attackDb} min={-12} max={12} step={0.1} defaultValue={2} unit="dB" signed bipolar accent="blue" size={116}
              rangeLabels={['-12', '+12']} onChange={(v) => setParams<TransientShaperParams>(ts, { attackDb: v })} />
          ) : (
            <AddModule type="transient-shaper" onAdd={add} />
          )}
        </Card>
        <Card title="Stereo Image" area="stereo" className="syn-card-stereo">
          <button type="button" className="syn-scope-btn" onClick={p.onOpenStereoLab} aria-label="Open the stereo analysis workspace">
            <StereoScope channels={p.scopeChannels} size={128} />
          </button>
          <dl className="syn-readouts">
            <div><dt>Width</dt><dd>{shown ? `${Math.round(shown.stereoWidth * 100)}%` : '—'}</dd></div>
            <div><dt>Balance</dt><dd>{shown ? fmtSigned(shown.lrBalanceDb, 2) : '—'}</dd></div>
            <div><dt>Correlation</dt><dd>{shown ? fmtSigned(shown.phaseCorrelation, 2) : '—'}</dd></div>
          </dl>
        </Card>
      </div>

      <div className="syn-console-col syn-console-center">
        <section className="syn-card syn-eq-panel syn-area-eq" data-testid="central-spectrum" aria-label="Master EQ and spectrum">
          <div className="syn-eq-head">
            <div>
              <h2 className="syn-eq-title">SYN EQ</h2>
              <p className="syn-eq-sub">{eq ? eq.name : 'Precision · Color · Balance'}{p.sampleRate ? ` · ${(p.sampleRate / 1000).toFixed(1)} kHz` : ''}</p>
            </div>
            <div className="syn-seg" role="group" aria-label="EQ view">
              {([['eq', 'EQ'], ['spectrum', 'Live spectrum'], ['spectrogram', 'Spectrogram']] as const).map(([id, label]) => (
                <button key={id} type="button" aria-pressed={eqView === id} className={eqView === id ? 'is-on' : ''} onClick={() => setEqView(id)}>{label}</button>
              ))}
            </div>
          </div>
          {eqView === 'eq' ? (
            eq ? (
              <ParametricEQ2
                variant="console"
                params={eq.params as ParametricEQParams}
                sampleRate={p.sampleRate}
                spectrum={p.master ?? p.source}
                onChange={(next) => setParams<ParametricEQParams>(eq, next)}
              />
            ) : (
              <div className="syn-eq-empty"><AddModule type="parametric-eq" onAdd={add} /></div>
            )
          ) : (
            <SpectrumAndEQCanvas
              preAnalysis={p.source}
              postAnalysis={p.master}
              referenceAnalysis={p.referenceAnalysis}
              chain={p.chainBypassed ? [] : chain}
              sampleRate={p.sampleRate}
              mode={eqView}
              waveformPeaks={p.waveformPeaks}
              durationSec={p.durationSec}
              heightClass="h-64"
            />
          )}
        </section>

        <div className="syn-console-bottom">
          <Card title="Global" area="global" className="syn-card-global">
            <label className="syn-field">
              <span>Target</span>
              <select value={p.targetPresetId ?? ''} onChange={(e) => p.onTargetPreset(e.target.value)} disabled={p.running} aria-label="Loudness target">
                {p.targetPresetId === null && <option value="">{p.targetLabel}</option>}
                {LOUDNESS_TARGET_PRESETS.map((t) => (
                  <option key={t.id} value={t.id}>{t.label} ({t.targetLufs} LUFS)</option>
                ))}
              </select>
            </label>
            <div className={`syn-global-status${gate ? (gate.passed ? ' is-pass' : ' is-fail') : ''}`}>{statusLine}</div>
            {p.notice && <div className="syn-global-notice" title={p.notice}>{p.notice}</div>}
            <div className="syn-progress" aria-hidden="true"><span style={{ width: `${Math.max(p.running ? 6 : 0, pct)}%` }} /></div>
            {!p.hasTrack && (
              <div className="syn-global-actions">
                <label className="syn-btn-ghost syn-file-btn">
                  <Upload className="w-3.5 h-3.5" /> Import
                  <input type="file" accept="audio/*,.wav,.flac,.mp3,.aac,.m4a,.ogg,.aiff,.aif" onChange={(e) => { const f = e.target.files?.[0]; if (f) p.onImport(f); e.target.value = ''; }} />
                </label>
                <button type="button" className="syn-btn-ghost" onClick={p.onDemo}>Load demo session</button>
              </div>
            )}
          </Card>
          {fixButton}
          <Card title="Presets" area="presets" className="syn-card-presets">
            <select value={presetId} onChange={(e) => setPresetId(e.target.value)} aria-label="Mastering preset" className="syn-preset-select">
              {p.presets.map((pr) => (
                <option key={pr.id} value={pr.id}>{pr.name}</option>
              ))}
            </select>
            <p className="syn-preset-desc">{p.presets.find((x) => x.id === presetId)?.description}</p>
            <button type="button" className="syn-btn-ghost" disabled={p.running} onClick={() => { const pr = p.presets.find((x) => x.id === presetId); if (pr) p.onApplyPreset(pr); }}>
              Load preset chain
            </button>
          </Card>
        </div>
      </div>

      <div className="syn-console-col syn-console-right">
        <Card title="Dynamics" area="dynk" className="syn-card-knob syn-only-desktop">
          {comp ? (
            <ArcKnob label="Threshold" value={(comp.params as CompressorParams).thresholdDb} min={-40} max={0} step={0.5} defaultValue={-16} unit="dB" accent="gold" size={116}
              caption={`Ratio ${(comp.params as CompressorParams).ratio.toFixed(1)}:1`} onChange={(v) => setParams<CompressorParams>(comp, { thresholdDb: v })} />
          ) : (
            <AddModule type="compressor" onAdd={add} />
          )}
        </Card>
        <Card title="Color & Tone" area="color" className="syn-card-knob syn-only-desktop">
          {sat ? (
            <ArcKnob label="Drive" value={(sat.params as SaturationParams).drive} min={0} max={100} step={1} defaultValue={22} unit="%" precision={0} accent="gold" size={116}
              caption={`${(sat.params as SaturationParams).flavor} saturation`} onChange={(v) => setParams<SaturationParams>(sat, { drive: v })} />
          ) : (
            <AddModule type="saturation" onAdd={add} />
          )}
        </Card>
        <Card title="Output" area="output" className="syn-card-knob syn-card-output">{outputKnob(116, 'Ceiling')}</Card>
        <Card title="Loudness" area="loud" className="syn-card-loud">
          <div className="syn-loud-value"><strong>{lufs !== null ? lufs.toFixed(1) : '—'}</strong> <span>LUFS</span></div>
          <div className="syn-loud-target">Target {p.targetLufs} LUFS · TP {tp !== null ? tp.toFixed(2) : '—'} / {p.maxTruePeakDb} dBTP</div>
          <div className="syn-loud-bar" role="meter" aria-label="Integrated loudness" aria-valuemin={-30} aria-valuemax={-5} aria-valuenow={lufs ?? -30}>
            <span style={{ width: `${lufs !== null ? Math.max(0, Math.min(100, ((lufs + 30) / 25) * 100)) : 0}%` }} />
            <i style={{ left: `${Math.max(0, Math.min(100, ((p.targetLufs + 30) / 25) * 100))}%` }} />
          </div>
          <div className="syn-loud-src">{p.master ? 'Measured on the rendered master' : p.source ? 'Source measurement' : 'No signal'}</div>
        </Card>
      </div>

      <Card title="Dynamics" area="dynf" className="syn-card-faders syn-only-mobile">
        <div className="syn-fader-row">
          {ts ? (
            <>
              <GlowFader label="Transient" value={(ts.params as TransientShaperParams).attackDb} min={-12} max={12} step={0.1} defaultValue={2} unit="dB" signed onChange={(v) => setParams<TransientShaperParams>(ts, { attackDb: v })} />
              <GlowFader label="Sustain" value={(ts.params as TransientShaperParams).sustainDb} min={-12} max={12} step={0.1} defaultValue={0} unit="dB" signed onChange={(v) => setParams<TransientShaperParams>(ts, { sustainDb: v })} />
            </>
          ) : (
            <AddModule type="transient-shaper" onAdd={add} />
          )}
          {find('maximizer') && (
            <GlowFader label="Punch" value={(find('maximizer')!.params as MaximizerParams).transientEmphasis} min={0} max={100} step={1} defaultValue={25} unit="%" precision={0}
              onChange={(v) => setParams<MaximizerParams>(find('maximizer')!, { transientEmphasis: v })} />
          )}
        </div>
      </Card>
      <Card title="Tonal Balance" area="tonal" className="syn-card-faders syn-only-mobile">
        <div className="syn-fader-row">
          {tonal ? (
            <>
              <GlowFader readOnly label="Low" value={tonal.low} min={-12} max={12} accent="gold" valueText={`${fmtSigned(tonal.low)} dB`} />
              <GlowFader readOnly label="Mid" value={tonal.mid} min={-12} max={12} accent="blue" valueText={`${fmtSigned(tonal.mid)} dB`} />
              <GlowFader readOnly label="High" value={tonal.high} min={-12} max={12} accent="blue" valueText={`${fmtSigned(tonal.high)} dB`} />
            </>
          ) : (
            <p className="syn-card-note">Measured after import</p>
          )}
        </div>
      </Card>
    </section>
  );
};
