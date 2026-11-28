import React from 'react';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Copy,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import type {
  VocalRebalanceParams,
  BassEnhancerParams,
  CompressorParams,
  DynamicEQParams,
  EQBandShape,
  ExternalVST3Params,
  LimiterParams,
  MaximizerParams,
  MultibandCompParams,
  ParametricEQParams,
  ProcessorModule,
  RestoreParams,
  SaturationParams,
  TransientShaperParams,
  ClipperParams,
  DitherParams,
  MatchEqParams,
  MultibandMaximizerParams,
  MultibandMaximizerBand,
  StereoImagerParams,
} from '../types/mastering';
import type { ProcessorMeterTelemetry } from '../dsp/offlineDsp';
import { createDefaultParams } from '../dsp/chainValidation';
import { isMatchEqLearned, matchEqPeakCorrectionDb } from '../dsp/matchEq';
import { VocalRebalancePanel } from './studio/VocalRebalancePanel';
import {
  BypassButton,
  HorizontalSlider,
  RotaryKnob,
  ToggleSwitch,
  VerticalFader,
  inferExternalVst3ControlSpec,
} from './controls';

interface Props {
  module: ProcessorModule;
  index: number;
  total: number;
  telemetry?: ProcessorMeterTelemetry;
  guidedMode?: boolean;
  hostConnected?: boolean;
  onUpdate?: (updated: ProcessorModule) => void;
  onUpdateAt?: (index: number, updated: ProcessorModule) => void;
  onMove: (index: number, dir: -1 | 1) => void;
  onDuplicate: (index: number) => void;
  onRemove: (index: number) => void;
  onLoadExternalInstance?: (module: ProcessorModule) => void | Promise<void>;
  onSetExternalParam?: (module: ProcessorModule, paramId: number, valueNormalized: number) => void | Promise<void>;
  onToggleExternalEditor?: (module: ProcessorModule) => void | Promise<void>;
  onToggleExternalBypass?: (module: ProcessorModule) => void | Promise<void>;
}

export const ProcessorModuleCard: React.FC<Props> = React.memo(({
  module,
  index,
  total,
  telemetry,
  guidedMode,
  hostConnected = false,
  onUpdate,
  onUpdateAt,
  onMove,
  onDuplicate,
  onRemove,
  onLoadExternalInstance,
  onSetExternalParam,
  onToggleExternalEditor,
  onToggleExternalBypass,
}) => {
  const isActive = module.enabled && !module.bypassed;

  const commitUpdate = (updated: ProcessorModule) => {
    if (onUpdateAt) onUpdateAt(index, updated);
    else onUpdate?.(updated);
  };

  const setParam = <T extends ProcessorModule['params']>(patch: Partial<T>) => {
    commitUpdate({
      ...module,
      params: { ...(module.params as T), ...patch },
    });
  };

  return (
    <div
      data-testid={`processor-card-${module.type}`}
      className={`rounded border transition-colors ${
        isActive
          ? 'bg-[#12141B] border-[#D4AF37]/35'
          : 'bg-[#0C0E13] border-[#222530] opacity-75'
      }`}
    >
      {/* Header Row */}
      <div className="flex items-center justify-between gap-1 px-2 py-1.5 border-b border-[#222530]">
        <div className="flex items-center gap-1 min-w-0 flex-1">
          <BypassButton
            active={isActive}
            compact
            accent="gold"
            label={isActive ? `Bypass ${module.name}` : `Enable ${module.name}`}
            onToggle={() => {
              if (module.type === 'external-vst3' && onToggleExternalBypass) {
                void onToggleExternalBypass(module);
              } else {
                commitUpdate({ ...module, bypassed: !module.bypassed });
              }
            }}
          />

          <button
            type="button"
            aria-label={`Toggle ${module.name} parameters`}
            aria-expanded={module.expanded}
            onClick={() => commitUpdate({ ...module, expanded: !module.expanded })}
            className="flex items-center gap-1 text-left min-w-0 flex-1"
          >
            {module.expanded ? (
              <ChevronDown className="w-3.5 h-3.5 text-[#D4AF37] shrink-0" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 text-[#9CA3AF] shrink-0" />
            )}
            <span className="text-[11.5px] font-semibold text-[#F7F8FA] truncate">
              {index + 1}. {module.name}
            </span>
          </button>
        </div>

        <div className="flex items-center gap-0 shrink-0">
          {telemetry && telemetry.gainReductionDb > 0.1 && (
            <span className="text-[10px] font-mono-tabular text-[#38BDF8] mr-1">
              -{telemetry.gainReductionDb.toFixed(1)}dB
            </span>
          )}
          <button
            type="button"
            aria-label={`Move ${module.name} up`}
            disabled={index === 0}
            onClick={() => onMove(index, -1)}
            className="p-0.5 text-[#9CA3AF] hover:text-[#F2CA52] disabled:opacity-30"
          >
            <ArrowUp className="w-3 h-3" />
          </button>
          <button
            type="button"
            aria-label={`Move ${module.name} down`}
            disabled={index === total - 1}
            onClick={() => onMove(index, 1)}
            className="p-0.5 text-[#9CA3AF] hover:text-[#F2CA52] disabled:opacity-30"
          >
            <ArrowDown className="w-3 h-3" />
          </button>
          <button
            type="button"
            aria-label={`Duplicate ${module.name}`}
            onClick={() => onDuplicate(index)}
            className="p-0.5 text-[#9CA3AF] hover:text-[#F2CA52]"
          >
            <Copy className="w-3 h-3" />
          </button>
          <button
            type="button"
            aria-label={`Reset ${module.name}`}
            onClick={() => {
              if (module.type === 'external-vst3') {
                const ep = module.params as ExternalVST3Params;
                commitUpdate({
                  ...module,
                  intensity: 100,
                  wetDry: 100,
                  inputGainDb: 0,
                  outputGainDb: 0,
                });
                if (onSetExternalParam && ep.instanceId && hostConnected && ep.status === 'active') {
                  ep.parameters.slice(0, 24).forEach((pr) => {
                    if (!pr.isReadOnly && !pr.isBypass) {
                      void onSetExternalParam(module, pr.id, pr.defaultValueNormalized);
                    }
                  });
                }
                return;
              }
              commitUpdate({
                ...module,
                intensity: 100,
                wetDry: 100,
                inputGainDb: 0,
                outputGainDb: 0,
                params: createDefaultParams(module.type),
              });
            }}
            className="p-0.5 text-[#9CA3AF] hover:text-[#F2CA52]"
          >
            <RotateCcw className="w-3 h-3" />
          </button>
          <button
            type="button"
            aria-label={`Remove ${module.name}`}
            onClick={() => onRemove(index)}
            className="p-0.5 text-[#9CA3AF] hover:text-[#EF4444]"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Compact Stage Strip: Intensity + Wet/Dry Mix */}
      <div className="px-3 py-2 grid grid-cols-2 gap-3 bg-[#0E1016]">
        <HorizontalSlider
          label="Intensity"
          value={module.intensity}
          min={0}
          max={100}
          step={1}
          defaultValue={100}
          unit="%"
          precision={0}
          compact
          onChange={(v) => commitUpdate({ ...module, intensity: v })}
        />
        <HorizontalSlider
          label="Wet / Dry Mix"
          value={module.wetDry}
          min={0}
          max={100}
          step={1}
          defaultValue={100}
          unit="%"
          precision={0}
          compact
          onChange={(v) => commitUpdate({ ...module, wetDry: v })}
        />
      </div>

      {/* Expanded Hardware Control Surface */}
      {module.expanded && (
        <div className="px-3 py-3 border-t border-[#222530] flex flex-col gap-3 bg-[#0A0C11]">
          {guidedMode && (
            <p className="text-[11px] text-[#9CA3AF] leading-relaxed">
              {module.type === 'parametric-eq' &&
                'Shapes tonal balance across sub, midrange presence, and air frequencies.'}
              {module.type === 'dynamic-eq' &&
                'Tames harsh resonances dynamically only when energy crosses threshold.'}
              {module.type === 'compressor' &&
                'Glues dynamic peaks smoothly; sidechain HPF prevents bass pumping.'}
              {module.type === 'multiband-comp' &&
                'Controls Low, Mid, and High frequency dynamics independently.'}
              {module.type === 'saturation' &&
                'Adds analog tube/tape harmonic density for perceived loudness.'}
              {module.type === 'stereo-imager' &&
                'Adjusts stereo width per band while keeping sub-bass mono-compatible.'}
              {module.type === 'restore' &&
                'Cleans DC offset, mains hum, sibilance, and high-frequency hiss.'}
              {module.type === 'bass-enhancer' &&
                'Reinforces sub-bass weight and low-end harmonic translation.'}
              {module.type === 'limiter' &&
                'Lookahead True Peak brickwall ceiling protecting against inter-sample clipping.'}
              {module.type === 'maximizer' &&
                'Targets integrated LUFS loudness transparently while honoring True Peak ceiling.'}
              {module.type === 'transient-shaper' &&
                'Adds or removes punch (attack) and body (sustain) from transients.'}
              {module.type === 'clipper' &&
                'Oversampled peak clipper that shaves transients before the limiter.'}
              {module.type === 'multiband-maximizer' &&
                'Maximus-style 3-band maximizer: per-band drive and compression into a true-peak ceiling.'}
              {module.type === 'match-eq' &&
                'Matches the long-term tonal balance of the loaded reference track with a smoothed, limited correction curve.'}
              {module.type === 'dither' &&
                'Quantizes the master to 16/20/24 bit with TPDF or noise-shaped dither. Keep it last in the chain.'}
              {module.type === 'external-vst3' &&
                'Processes audio through an isolated out-of-process Windows VST3 plugin worker.'}
            </p>
          )}

          {/* Stage I/O Console Trim Faders + Calibrated Telemetry */}
          <div className="p-2 rounded bg-[#0F1219] border border-[#202430] flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <VerticalFader
                label="In Trim"
                value={module.inputGainDb}
                min={-12}
                max={12}
                step={0.1}
                defaultValue={0}
                unit="dB"
                bipolar
                heightPx={76}
                onChange={(v) => commitUpdate({ ...module, inputGainDb: v })}
              />
              <VerticalFader
                label="Out Trim"
                value={module.outputGainDb}
                min={-12}
                max={12}
                step={0.1}
                defaultValue={0}
                unit="dB"
                bipolar
                heightPx={76}
                onChange={(v) => commitUpdate({ ...module, outputGainDb: v })}
              />
            </div>

            <div className="flex-1 min-w-0 flex flex-col gap-1.5 text-[10px] font-mono-tabular pl-2 border-l border-[#1E222E]">
              <div className="text-[9px] uppercase tracking-wider text-[#64748B] font-semibold">
                Stage Telemetry
              </div>
              {telemetry ? (
                <>
                  <div className="flex items-center justify-between">
                    <span className="text-[#94A3B8]">Input Peak</span>
                    <span className="text-[#E2E8F0]">{telemetry.inputPeakDb} dBFS</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[#94A3B8]">Output Peak</span>
                    <span className="text-[#E2E8F0]">{telemetry.outputPeakDb} dBFS</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[#94A3B8]">Gain Red.</span>
                    <span className="text-[#38BDF8]">-{telemetry.gainReductionDb.toFixed(1)} dB</span>
                  </div>
                </>
              ) : (
                <div className="text-[#64748B]">Load audio track for live stage peak &amp; GR telemetry.</div>
              )}
            </div>
          </div>

          {/* 1. PARAMETRIC EQ */}
          {module.type === 'parametric-eq' && (() => {
            const p = module.params as ParametricEQParams;
            return (
              <div className="flex flex-col gap-2.5">
                <div className="p-2 rounded bg-[#0F1219] border border-[#202430] grid grid-cols-3 gap-2 items-center">
                  <div className="col-span-2 flex flex-col gap-1.5">
                    <ToggleSwitch
                      label="Linear Phase"
                      compact
                      checked={p.phaseMode === 'linear'}
                      onChange={(checked) =>
                        setParam<ParametricEQParams>({ phaseMode: checked ? 'linear' : 'minimum' })
                      }
                    />
                    <ToggleSwitch
                      label="Mid / Side"
                      compact
                      checked={p.msMode === 'mid-side'}
                      onChange={(checked) =>
                        setParam<ParametricEQParams>({ msMode: checked ? 'mid-side' : 'stereo' })
                      }
                    />
                  </div>
                  <RotaryKnob
                    label="Tilt EQ"
                    value={p.tiltDb}
                    min={-6}
                    max={6}
                    step={0.1}
                    defaultValue={0}
                    unit="dB"
                    bipolar
                    size="sm"
                    onChange={(v) => setParam<ParametricEQParams>({ tiltDb: v })}
                  />
                </div>

                {p.bands.map((band, bIdx) => {
                  const gainDisabled =
                    band.shape === 'highpass' || band.shape === 'lowpass' || band.shape === 'notch';
                  return (
                    <div key={band.id} className="p-2 rounded bg-[#10131B] border border-[#222634] flex flex-col gap-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5">
                          <BypassButton
                            active={band.enabled}
                            compact
                            label={`Toggle Band ${bIdx + 1}`}
                            onToggle={() => {
                              const next = [...p.bands];
                              next[bIdx] = { ...band, enabled: !band.enabled };
                              setParam<ParametricEQParams>({ bands: next });
                            }}
                          />
                          <span className="text-[11px] font-semibold text-[#E2E8F0]">
                            Band {bIdx + 1}
                          </span>
                        </div>
                        <select
                          aria-label={`Band ${bIdx + 1} shape`}
                          value={band.shape}
                          onChange={(e) => {
                            const next = [...p.bands];
                            next[bIdx] = { ...band, shape: e.target.value as EQBandShape };
                            setParam<ParametricEQParams>({ bands: next });
                          }}
                          className="bg-[#161923] border border-[#2D3343] rounded px-1.5 py-0.5 text-[11px] text-[#F7F8FA]"
                        >
                          <option value="highpass">HPF</option>
                          <option value="lowshelf">Low Shelf</option>
                          <option value="bell">Bell</option>
                          <option value="highshelf">High Shelf</option>
                          <option value="bandpass">Band-Pass</option>
                          <option value="tilt">Tilt</option>
                          <option value="notch">Notch</option>
                          <option value="lowpass">LPF</option>
                        </select>
                      </div>

                      <div className="grid grid-cols-3 gap-2">
                        <RotaryKnob
                          label="Frequency"
                          value={band.freq}
                          min={20}
                          max={19500}
                          step={1}
                          defaultValue={bIdx === 0 ? 28 : bIdx === 1 ? 95 : bIdx === 2 ? 320 : bIdx === 3 ? 2800 : 11500}
                          unit="Hz"
                          scale="logarithmic"
                          precision={0}
                          size="xs"
                          disabled={!band.enabled}
                          onChange={(v) => {
                            const next = [...p.bands];
                            next[bIdx] = { ...band, freq: v };
                            setParam<ParametricEQParams>({ bands: next });
                          }}
                        />
                        <RotaryKnob
                          label="Gain"
                          value={band.gain}
                          min={-12}
                          max={12}
                          step={0.1}
                          defaultValue={0}
                          unit="dB"
                          bipolar
                          size="xs"
                          disabled={!band.enabled || gainDisabled}
                          onChange={(v) => {
                            const next = [...p.bands];
                            next[bIdx] = { ...band, gain: v };
                            setParam<ParametricEQParams>({ bands: next });
                          }}
                        />
                        <RotaryKnob
                          label="Q"
                          value={band.q}
                          min={0.25}
                          max={12}
                          step={0.05}
                          defaultValue={band.shape === 'bell' ? 1.2 : 0.71}
                          scale="logarithmic"
                          precision={2}
                          size="xs"
                          disabled={!band.enabled}
                          onChange={(v) => {
                            const next = [...p.bands];
                            next[bIdx] = { ...band, q: v };
                            setParam<ParametricEQParams>({ bands: next });
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}

          {/* 2. DYNAMIC EQ */}
          {module.type === 'dynamic-eq' && (() => {
            const p = module.params as DynamicEQParams;
            return (
              <div className="flex flex-col gap-2">
                {p.bands.map((band, bIdx) => (
                  <div key={band.id} className="p-2 rounded bg-[#10131B] border border-[#222634] flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <BypassButton
                          active={band.enabled}
                          compact
                          label={`Toggle Dynamic Band ${bIdx + 1}`}
                          onToggle={() => {
                            const next = [...p.bands];
                            next[bIdx] = { ...band, enabled: !band.enabled };
                            setParam<DynamicEQParams>({ bands: next });
                          }}
                        />
                        <span className="text-[11px] font-semibold text-[#E2E8F0]">
                          Dynamic Band {bIdx + 1}
                        </span>
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <RotaryKnob
                        label="Freq"
                        value={band.freq}
                        min={40}
                        max={14000}
                        step={5}
                        defaultValue={bIdx === 0 ? 260 : 3800}
                        unit="Hz"
                        scale="logarithmic"
                        precision={0}
                        size="xs"
                        disabled={!band.enabled}
                        onChange={(v) => {
                          const next = [...p.bands];
                          next[bIdx] = { ...band, freq: v };
                          setParam<DynamicEQParams>({ bands: next });
                        }}
                      />
                      <RotaryKnob
                        label="Threshold"
                        value={band.thresholdDb}
                        min={-40}
                        max={0}
                        step={0.5}
                        defaultValue={-20}
                        unit="dB"
                        size="xs"
                        disabled={!band.enabled}
                        onChange={(v) => {
                          const next = [...p.bands];
                          next[bIdx] = { ...band, thresholdDb: v };
                          setParam<DynamicEQParams>({ bands: next });
                        }}
                      />
                      <RotaryKnob
                        label="Max Cut"
                        value={band.mode === 'boost' ? Math.max(0, band.maxCutDb) : band.maxCutDb}
                        min={band.mode === 'boost' ? 0 : -12}
                        max={band.mode === 'boost' ? 12 : 0}
                        step={0.1}
                        defaultValue={-3}
                        unit="dB"
                        size="xs"
                        disabled={!band.enabled}
                        onChange={(v) => {
                          const next = [...p.bands];
                          next[bIdx] = { ...band, maxCutDb: v };
                          setParam<DynamicEQParams>({ bands: next });
                        }}
                      />
                      <button
                        type="button"
                        className="rounded border border-[#2B2E3A] px-2 py-1 text-[10px] text-[#E2E8F0]"
                        disabled={!band.enabled}
                        onClick={() => {
                          const next = [...p.bands];
                          next[bIdx] = { ...band, mode: band.mode === 'boost' ? 'cut' : 'boost', maxCutDb: band.mode === 'boost' ? -3 : 3 };
                          setParam<DynamicEQParams>({ bands: next });
                        }}
                      >
                        {band.mode === 'boost' ? 'BOOST' : 'CUT'}
                      </button>
                      <RotaryKnob
                        label="Ratio"
                        value={band.ratio ?? 20 / 7}
                        min={1}
                        max={20}
                        step={0.1}
                        defaultValue={20 / 7}
                        unit=":1"
                        size="xs"
                        disabled={!band.enabled}
                        onChange={(v) => {
                          const next = [...p.bands];
                          next[bIdx] = { ...band, ratio: v };
                          setParam<DynamicEQParams>({ bands: next });
                        }}
                      />
                      <RotaryKnob
                        label="Q"
                        value={band.q}
                        min={0.5}
                        max={8}
                        step={0.1}
                        defaultValue={2.2}
                        scale="logarithmic"
                        precision={1}
                        size="xs"
                        disabled={!band.enabled}
                        onChange={(v) => {
                          const next = [...p.bands];
                          next[bIdx] = { ...band, q: v };
                          setParam<DynamicEQParams>({ bands: next });
                        }}
                      />
                      <RotaryKnob
                        label="Attack"
                        value={band.attackMs}
                        min={1}
                        max={100}
                        step={1}
                        defaultValue={10}
                        unit="ms"
                        scale="logarithmic"
                        size="xs"
                        disabled={!band.enabled}
                        onChange={(v) => {
                          const next = [...p.bands];
                          next[bIdx] = { ...band, attackMs: v };
                          setParam<DynamicEQParams>({ bands: next });
                        }}
                      />
                      <RotaryKnob
                        label="Release"
                        value={band.releaseMs}
                        min={20}
                        max={600}
                        step={5}
                        defaultValue={110}
                        unit="ms"
                        scale="logarithmic"
                        size="xs"
                        disabled={!band.enabled}
                        onChange={(v) => {
                          const next = [...p.bands];
                          next[bIdx] = { ...band, releaseMs: v };
                          setParam<DynamicEQParams>({ bands: next });
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            );
          })()}

          {/* 3. COMPRESSOR */}
          {module.type === 'compressor' && (() => {
            const p = module.params as CompressorParams;
            return (
              <div className="flex flex-col gap-2.5">
                <label className="flex flex-col gap-1 text-[11px] text-[#9CA3AF]">
                  Topology
                  <select
                    aria-label="Compressor Mode"
                    value={p.mode}
                    onChange={(e) => setParam<CompressorParams>({ mode: e.target.value as CompressorParams['mode'] })}
                    className="bg-[#161923] border border-[#2D3343] rounded px-2 py-1 text-xs text-[#F7F8FA]"
                  >
                    <option value="downward">Downward Glue</option>
                    <option value="parallel">Parallel NY Smash</option>
                    <option value="upward">Upward Detail Recovery</option>
                  </select>
                </label>
                <div className="p-2.5 rounded bg-[#10131B] border border-[#222634] grid grid-cols-3 gap-x-2 gap-y-3">
                  <RotaryKnob
                    label="Threshold"
                    value={p.thresholdDb}
                    min={-40}
                    max={0}
                    step={0.5}
                    defaultValue={-16}
                    unit="dB"
                    size="sm"
                    showAdjustButtons
                    onChange={(v) => setParam<CompressorParams>({ thresholdDb: v })}
                  />
                  <RotaryKnob
                    label="Ratio"
                    value={p.ratio}
                    min={1}
                    max={10}
                    step={0.1}
                    defaultValue={2.2}
                    unit=":1"
                    size="sm"
                    onChange={(v) => setParam<CompressorParams>({ ratio: v })}
                  />
                  <RotaryKnob
                    label="Makeup"
                    value={p.makeupDb}
                    min={-4}
                    max={10}
                    step={0.1}
                    defaultValue={1.0}
                    unit="dB"
                    bipolar
                    size="sm"
                    onChange={(v) => setParam<CompressorParams>({ makeupDb: v })}
                  />
                  <RotaryKnob
                    label="Attack"
                    value={p.attackMs}
                    min={1}
                    max={120}
                    step={1}
                    defaultValue={18}
                    unit="ms"
                    scale="logarithmic"
                    size="xs"
                    onChange={(v) => setParam<CompressorParams>({ attackMs: v })}
                  />
                  <RotaryKnob
                    label="Release"
                    value={p.releaseMs}
                    min={20}
                    max={800}
                    step={5}
                    defaultValue={140}
                    unit="ms"
                    scale="logarithmic"
                    size="xs"
                    onChange={(v) => setParam<CompressorParams>({ releaseMs: v })}
                  />
                  <RotaryKnob
                    label="Knee"
                    value={p.kneeDb}
                    min={0}
                    max={12}
                    step={0.5}
                    defaultValue={4}
                    unit="dB"
                    size="xs"
                    onChange={(v) => setParam<CompressorParams>({ kneeDb: v })}
                  />
                  <div className="col-span-3 pt-1 border-t border-[#1C202B] flex items-center justify-center">
                    <RotaryKnob
                      label="SC HPF"
                      value={p.scHpfHz}
                      min={20}
                      max={220}
                      step={5}
                      defaultValue={75}
                      unit="Hz"
                      scale="logarithmic"
                      size="xs"
                      onChange={(v) => setParam<CompressorParams>({ scHpfHz: v })}
                    />
                  </div>
                </div>
              </div>
            );
          })()}

          {/* 4. MULTIBAND COMPRESSOR */}
          {module.type === 'multiband-comp' && (() => {
            const p = module.params as MultibandCompParams;
            return (
              <div className="flex flex-col gap-2.5">
                <div className="p-2 rounded bg-[#0F1219] border border-[#202430] grid grid-cols-2 gap-3">
                  <RotaryKnob
                    label="Low/Mid Xover"
                    value={p.lowCrossHz}
                    min={70}
                    max={450}
                    step={5}
                    defaultValue={180}
                    unit="Hz"
                    scale="logarithmic"
                    size="xs"
                    onChange={(v) => setParam<MultibandCompParams>({ lowCrossHz: v })}
                  />
                  <RotaryKnob
                    label="Mid/High Xover"
                    value={p.highCrossHz}
                    min={1000}
                    max={8500}
                    step={50}
                    defaultValue={3200}
                    unit="Hz"
                    scale="logarithmic"
                    size="xs"
                    onChange={(v) => setParam<MultibandCompParams>({ highCrossHz: v })}
                  />
                </div>
                {(['low', 'mid', 'high'] as const).map((bandKey) => {
                  const b = p[bandKey];
                  return (
                    <div key={bandKey} className="p-2 rounded bg-[#10131B] border border-[#222634] flex flex-col gap-2">
                      <div className="flex items-center justify-between text-[11px] font-semibold text-[#D4AF37]">
                        <span>{bandKey.toUpperCase()} BAND</span>
                        <BypassButton
                          active={!b.bypass}
                          compact
                          showStateText
                          label={`Toggle ${bandKey} band`}
                          onToggle={() =>
                            setParam<MultibandCompParams>({ [bandKey]: { ...b, bypass: !b.bypass } })
                          }
                        />
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        <RotaryKnob
                          label="Thresh"
                          value={b.thresholdDb}
                          min={-36}
                          max={0}
                          step={0.5}
                          defaultValue={-18}
                          unit="dB"
                          size="xs"
                          disabled={b.bypass}
                          onChange={(v) => setParam<MultibandCompParams>({ [bandKey]: { ...b, thresholdDb: v } })}
                        />
                        <RotaryKnob
                          label="Ratio"
                          value={b.ratio}
                          min={1}
                          max={8}
                          step={0.1}
                          defaultValue={2.2}
                          unit=":1"
                          size="xs"
                          disabled={b.bypass}
                          onChange={(v) => setParam<MultibandCompParams>({ [bandKey]: { ...b, ratio: v } })}
                        />
                        <RotaryKnob
                          label="Gain"
                          value={b.gainDb}
                          min={-5}
                          max={5}
                          step={0.1}
                          defaultValue={0}
                          unit="dB"
                          bipolar
                          size="xs"
                          disabled={b.bypass}
                          onChange={(v) => setParam<MultibandCompParams>({ [bandKey]: { ...b, gainDb: v } })}
                        />
                        <RotaryKnob
                          label="Attack"
                          value={b.attackMs}
                          min={1}
                          max={120}
                          step={1}
                          defaultValue={15}
                          unit="ms"
                          scale="logarithmic"
                          size="xs"
                          disabled={b.bypass}
                          onChange={(v) => setParam<MultibandCompParams>({ [bandKey]: { ...b, attackMs: v } })}
                        />
                        <RotaryKnob
                          label="Release"
                          value={b.releaseMs}
                          min={20}
                          max={800}
                          step={5}
                          defaultValue={120}
                          unit="ms"
                          scale="logarithmic"
                          size="xs"
                          disabled={b.bypass}
                          onChange={(v) => setParam<MultibandCompParams>({ [bandKey]: { ...b, releaseMs: v } })}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}

          {/* 5. SATURATION */}
          {module.type === 'saturation' && (() => {
            const p = module.params as SaturationParams;
            return (
              <div className="flex flex-col gap-2.5">
                <div className="grid grid-cols-2 gap-2">
                  <label className="flex flex-col gap-1 text-[11px] text-[#9CA3AF]">
                    Flavor
                    <select
                      aria-label="Saturation Flavor"
                      value={p.flavor}
                      onChange={(e) => setParam<SaturationParams>({ flavor: e.target.value as SaturationParams['flavor'] })}
                      className="bg-[#161923] border border-[#2D3343] rounded px-2 py-1 text-xs text-[#F7F8FA]"
                    >
                      <option value="tape">Analog Tape</option>
                      <option value="tube">Warm Vacuum Tube</option>
                      <option value="exciter">Harmonic Exciter</option>
                      <option value="soft-clip">Soft Clipper</option>
                      <option value="hard-clip">Hard Clipper</option>
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-[11px] text-[#9CA3AF]">
                    Harmonics
                    <select
                      aria-label="Harmonic Bias"
                      value={p.harmonics}
                      onChange={(e) => setParam<SaturationParams>({ harmonics: e.target.value as SaturationParams['harmonics'] })}
                      className="bg-[#161923] border border-[#2D3343] rounded px-2 py-1 text-xs text-[#F7F8FA]"
                    >
                      <option value="even">Even (Warm)</option>
                      <option value="balanced">Balanced</option>
                      <option value="odd">Odd (Aggressive)</option>
                    </select>
                  </label>
                </div>

                <div className="p-2.5 rounded bg-[#10131B] border border-[#222634] grid grid-cols-2 gap-3">
                  <RotaryKnob
                    label="Drive"
                    value={p.drive}
                    min={0}
                    max={100}
                    step={1}
                    defaultValue={22}
                    unit="%"
                    size="md"
                    showAdjustButtons
                    onChange={(v) => setParam<SaturationParams>({ drive: v })}
                  />
                  <RotaryKnob
                    label="Tonal Tilt"
                    value={p.tone}
                    min={-100}
                    max={100}
                    step={1}
                    defaultValue={0}
                    bipolar
                    precision={0}
                    size="md"
                    onChange={(v) => setParam<SaturationParams>({ tone: v })}
                  />
                </div>

                <label className="flex items-center justify-between text-[11px] text-[#9CA3AF] px-1">
                  Oversampling
                  <select
                    aria-label="Saturation Oversampling"
                    value={p.oversampling}
                    onChange={(e) => setParam<SaturationParams>({ oversampling: Number(e.target.value) as 1 | 2 | 4 })}
                    className="bg-[#161923] border border-[#2D3343] rounded px-2 py-1 text-xs text-[#F7F8FA]"
                  >
                    <option value={1}>1x (Zero Latency)</option>
                    <option value={2}>2x Oversampled</option>
                    <option value={4}>4x Mastering HQ</option>
                  </select>
                </label>
              </div>
            );
          })()}

          {/* 6. STEREO IMAGER */}
          {module.type === 'stereo-imager' && (() => {
            const p = module.params as StereoImagerParams;
            return (
              <div className="flex flex-col gap-2.5">
                <div className="p-2.5 rounded bg-[#10131B] border border-[#222634] grid grid-cols-3 gap-x-2 gap-y-3">
                  <RotaryKnob
                    label="Low Width"
                    value={p.lowWidth}
                    min={0}
                    max={160}
                    step={1}
                    defaultValue={85}
                    unit="%"
                    size="sm"
                    onChange={(v) => setParam<StereoImagerParams>({ lowWidth: v })}
                  />
                  <RotaryKnob
                    label="Mid Width"
                    value={p.midWidth}
                    min={0}
                    max={175}
                    step={1}
                    defaultValue={108}
                    unit="%"
                    size="sm"
                    onChange={(v) => setParam<StereoImagerParams>({ midWidth: v })}
                  />
                  <RotaryKnob
                    label="High Width"
                    value={p.highWidth}
                    min={0}
                    max={190}
                    step={1}
                    defaultValue={118}
                    unit="%"
                    size="sm"
                    onChange={(v) => setParam<StereoImagerParams>({ highWidth: v })}
                  />
                  <RotaryKnob
                    label="Low Xover"
                    value={p.lowCrossHz}
                    min={60}
                    max={500}
                    step={5}
                    defaultValue={160}
                    unit="Hz"
                    scale="logarithmic"
                    size="xs"
                    onChange={(v) => setParam<StereoImagerParams>({ lowCrossHz: v })}
                  />
                  <RotaryKnob
                    label="High Xover"
                    value={p.highCrossHz}
                    min={800}
                    max={12000}
                    step={50}
                    defaultValue={3500}
                    unit="Hz"
                    scale="logarithmic"
                    size="xs"
                    onChange={(v) => setParam<StereoImagerParams>({ highCrossHz: v })}
                  />
                  <RotaryKnob
                    label="Mono Bass <"
                    value={p.monoBassBelowHz}
                    min={0}
                    max={180}
                    step={5}
                    defaultValue={95}
                    unit="Hz"
                    size="xs"
                    onChange={(v) => setParam<StereoImagerParams>({ monoBassBelowHz: v })}
                  />
                </div>
                <div className="p-2 rounded bg-[#0F1219] border border-[#202430] grid grid-cols-2 gap-3 items-center">
                  <RotaryKnob
                    label="M/S Side Trim"
                    value={p.midSideGainDb}
                    min={-6}
                    max={6}
                    step={0.1}
                    defaultValue={0}
                    unit="dB"
                    bipolar
                    size="xs"
                    onChange={(v) => setParam<StereoImagerParams>({ midSideGainDb: v })}
                  />
                  <HorizontalSlider
                    label="L/R Balance"
                    value={p.lrBalanceDb}
                    min={-4}
                    max={4}
                    step={0.1}
                    defaultValue={0}
                    unit="dB"
                    bipolar
                    onChange={(v) => setParam<StereoImagerParams>({ lrBalanceDb: v })}
                  />
                </div>
              </div>
            );
          })()}

          {/* 7. SYN-RESTORE */}
          {module.type === 'restore' && (() => {
            const p = module.params as RestoreParams;
            return (
              <div className="flex flex-col gap-2.5">
                <div className="grid grid-cols-2 gap-2 items-center">
                  <ToggleSwitch
                    label="DC Offset"
                    compact
                    checked={p.dcOffset}
                    onChange={(checked) => setParam<RestoreParams>({ dcOffset: checked })}
                  />
                  <label className="flex flex-col gap-1 text-[11px] text-[#9CA3AF]">
                    Mains Hum Notch
                    <select
                      aria-label="Hum Removal Frequency"
                      value={p.humRemovalHz}
                      onChange={(e) => setParam<RestoreParams>({ humRemovalHz: Number(e.target.value) as 0 | 50 | 60 })}
                      className="bg-[#161923] border border-[#2D3343] rounded px-2 py-1 text-xs text-[#F7F8FA]"
                    >
                      <option value={0}>Off</option>
                      <option value={50}>50 Hz (EU/UK)</option>
                      <option value={60}>60 Hz (US)</option>
                    </select>
                  </label>
                </div>
                <label className="flex items-center justify-between gap-2 text-[11px] text-[#9CA3AF]">
                  <span>Cleanup Mode</span>
                  <select
                    aria-label="Restore Mode"
                    value={p.mode}
                    onChange={(e) => setParam<RestoreParams>({ mode: e.target.value as RestoreParams['mode'] })}
                    className="bg-[#161923] border border-[#2D3343] rounded px-2 py-1 text-xs text-[#F7F8FA]"
                  >
                    <option value="conservative">Conservative (Transparent)</option>
                    <option value="aggressive">Aggressive (Heavy Repair)</option>
                  </select>
                </label>
                <div className="p-2.5 rounded bg-[#10131B] border border-[#222634] grid grid-cols-2 gap-x-2 gap-y-3">
                  <RotaryKnob
                    label="De-Esser"
                    value={p.deEssAmount}
                    min={0}
                    max={100}
                    step={1}
                    defaultValue={18}
                    unit="%"
                    size="sm"
                    onChange={(v) => setParam<RestoreParams>({ deEssAmount: v })}
                  />
                  <RotaryKnob
                    label="De-Ess Freq"
                    value={p.deEssFreqHz}
                    min={3500}
                    max={10500}
                    step={50}
                    defaultValue={6500}
                    unit="Hz"
                    scale="logarithmic"
                    size="sm"
                    onChange={(v) => setParam<RestoreParams>({ deEssFreqHz: v })}
                  />
                  <RotaryKnob
                    label="Hiss Reduction"
                    value={p.hissReduction}
                    min={0}
                    max={100}
                    step={1}
                    defaultValue={12}
                    unit="%"
                    size="sm"
                    onChange={(v) => setParam<RestoreParams>({ hissReduction: v })}
                  />
                  <RotaryKnob
                    label="Resonance Trim"
                    value={p.resonanceSuppress}
                    min={0}
                    max={100}
                    step={1}
                    defaultValue={15}
                    unit="%"
                    size="sm"
                    onChange={(v) => setParam<RestoreParams>({ resonanceSuppress: v })}
                  />
                </div>
                <div className="p-2.5 rounded bg-[#10131B] border border-[#222634] flex flex-col gap-2.5">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-[#F2CA52]">AI-Audio Repair</div>
                  <ToggleSwitch
                    label="Transient Spike Repair"
                    compact
                    checked={Boolean(p.spikeRepair)}
                    onChange={(checked) => setParam<RestoreParams>({ spikeRepair: checked })}
                  />
                  <div className="grid grid-cols-3 gap-x-2 gap-y-3">
                    <RotaryKnob
                      label="De-Click"
                      value={p.declick ?? 0}
                      min={0}
                      max={100}
                      step={1}
                      defaultValue={0}
                      unit="%"
                      size="sm"
                      onChange={(v) => setParam<RestoreParams>({ declick: v })}
                    />
                    <RotaryKnob
                      label="De-Crackle"
                      value={p.decrackle ?? 0}
                      min={0}
                      max={100}
                      step={1}
                      defaultValue={0}
                      unit="%"
                      size="sm"
                      onChange={(v) => setParam<RestoreParams>({ decrackle: v })}
                    />
                    <RotaryKnob
                      label="De-Clip"
                      value={p.declip ?? 0}
                      min={0}
                      max={100}
                      step={1}
                      defaultValue={0}
                      unit="%"
                      size="sm"
                      onChange={(v) => setParam<RestoreParams>({ declip: v })}
                    />
                    <RotaryKnob
                      label="De-Shimmer"
                      value={p.deShimmer ?? 0}
                      min={0}
                      max={100}
                      step={1}
                      defaultValue={0}
                      unit="%"
                      size="sm"
                      onChange={(v) => setParam<RestoreParams>({ deShimmer: v })}
                    />
                  </div>
                </div>
              </div>
            );
          })()}

          {module.type === 'transient-shaper' && (() => {
            const p = module.params as TransientShaperParams;
            return (
              <div className="p-2.5 rounded bg-[#10131B] border border-[#222634] grid grid-cols-2 gap-x-2 gap-y-3">
                <RotaryKnob label="Attack" value={p.attackDb} min={-12} max={12} step={0.1} defaultValue={2} unit="dB" size="sm" onChange={(v) => setParam<TransientShaperParams>({ attackDb: v })} />
                <RotaryKnob label="Sustain" value={p.sustainDb} min={-12} max={12} step={0.1} defaultValue={0} unit="dB" size="sm" onChange={(v) => setParam<TransientShaperParams>({ sustainDb: v })} />
                <RotaryKnob label="Speed" value={p.speedMs} min={2} max={60} step={1} defaultValue={15} unit="ms" size="sm" onChange={(v) => setParam<TransientShaperParams>({ speedMs: v })} />
                <RotaryKnob label="Detector HPF" value={p.lowCutHz} min={20} max={300} step={1} defaultValue={80} unit="Hz" size="sm" scale="logarithmic" onChange={(v) => setParam<TransientShaperParams>({ lowCutHz: v })} />
              </div>
            );
          })()}

          {module.type === 'match-eq' && (() => {
            const p = module.params as MatchEqParams;
            const learned = isMatchEqLearned(p);
            const peak = matchEqPeakCorrectionDb(p, module.intensity / 100);
            return (
              <div className="flex flex-col gap-2.5" data-testid="match-eq-card">
                <p className="text-[11px] text-[#9CA3AF]">{learned ? `Learned · ${p.referenceName ?? 'reference'} · peak ${peak.toFixed(1)} dB` : 'Not learned (pass-through). Load a reference and press Learn in the Match EQ editor.'}</p>
                <div className="p-2.5 rounded bg-[#10131B] border border-[#222634] grid grid-cols-3 gap-x-2 gap-y-3">
                  <RotaryKnob label="Amount" value={p.amount} min={0} max={100} step={1} defaultValue={75} unit="%" size="sm" onChange={(v) => setParam<MatchEqParams>({ amount: v })} />
                  <RotaryKnob label="Max boost" value={p.maxBoostDb} min={0} max={12} step={0.1} defaultValue={6} unit="dB" size="sm" onChange={(v) => setParam<MatchEqParams>({ maxBoostDb: v })} />
                  <RotaryKnob label="Max cut" value={p.maxCutDb} min={0} max={12} step={0.1} defaultValue={6} unit="dB" size="sm" onChange={(v) => setParam<MatchEqParams>({ maxCutDb: v })} />
                </div>
                <label className="flex items-center justify-between gap-2 text-[11px] text-[#9CA3AF]">
                  <span>Smoothing</span>
                  <select aria-label="Match EQ smoothing" value={p.smoothing} onChange={(e) => setParam<MatchEqParams>({ smoothing: Number(e.target.value) as MatchEqParams['smoothing'] })} className="bg-[#161923] border border-[#2D3343] rounded px-2 py-1 text-xs text-[#F7F8FA]">
                    {[1, 2, 3, 6, 12, 24].map((n) => <option key={n} value={n}>1/{n} oct</option>)}
                  </select>
                </label>
                <label className="flex items-center justify-between gap-2 text-[11px] text-[#9CA3AF]">
                  <span>Channel</span>
                  <select aria-label="Match EQ channel" value={p.channel} onChange={(e) => setParam<MatchEqParams>({ channel: e.target.value as MatchEqParams['channel'] })} className="bg-[#161923] border border-[#2D3343] rounded px-2 py-1 text-xs text-[#F7F8FA]">
                    <option value="stereo">Stereo</option><option value="mid">Mid</option><option value="side">Side</option>
                  </select>
                </label>
                <label className="flex items-center justify-between gap-2 text-[11px] text-[#9CA3AF]">
                  <span>Phase</span>
                  <select aria-label="Match EQ phase" value={p.phase} onChange={(e) => setParam<MatchEqParams>({ phase: e.target.value === 'minimum' ? 'minimum' : 'linear' })} className="bg-[#161923] border border-[#2D3343] rounded px-2 py-1 text-xs text-[#F7F8FA]">
                    <option value="linear">Linear phase</option><option value="minimum">Minimum phase</option>
                  </select>
                </label>
              </div>
            );
          })()}
          {module.type === 'vocal-rebalance' && (
            <VocalRebalancePanel
              module={module}
              compact
              onChange={(next) => setParam<VocalRebalanceParams>(next)}
              onToggle={(on) => commitUpdate({ ...module, enabled: true, bypassed: !on })}
            />
          )}

          {module.type === 'dither' && (() => {
            const p = module.params as DitherParams;
            return (
              <div className="flex flex-col gap-2.5">
                <label className="flex items-center justify-between gap-2 text-[11px] text-[#9CA3AF]">
                  <span>Bit depth</span>
                  <select aria-label="Dither bit depth" value={p.bitDepth} onChange={(e) => setParam<DitherParams>({ bitDepth: Number(e.target.value) as 16 | 20 | 24 })} className="bg-[#161923] border border-[#2D3343] rounded px-2 py-1 text-xs text-[#F7F8FA]">
                    <option value={16}>16-bit</option><option value={20}>20-bit</option><option value={24}>24-bit</option>
                  </select>
                </label>
                <label className="flex items-center justify-between gap-2 text-[11px] text-[#9CA3AF]">
                  <span>Shape</span>
                  <select aria-label="Dither shape" value={p.shape} onChange={(e) => setParam<DitherParams>({ shape: e.target.value as DitherParams['shape'] })} className="bg-[#161923] border border-[#2D3343] rounded px-2 py-1 text-xs text-[#F7F8FA]">
                    <option value="tpdf">TPDF (flat)</option><option value="tpdf-hp">TPDF high-passed</option><option value="shaped">Noise-shaped</option>
                  </select>
                </label>
                <ToggleSwitch label="Auto-blank silence" compact checked={p.autoBlank} onChange={(checked) => setParam<DitherParams>({ autoBlank: checked })} />
                <p className="text-[10px] text-[#8F7D50]">Export skips its own dither when this module is active, so the master is never dithered twice.</p>
              </div>
            );
          })()}

          {module.type === 'clipper' && (() => {
            const p = module.params as ClipperParams;
            return (
              <div className="flex flex-col gap-2.5">
                <label className="flex items-center justify-between gap-2 text-[11px] text-[#9CA3AF]">
                  <span>Oversampling</span>
                  <select aria-label="Clipper oversampling" value={p.oversampling} onChange={(e) => setParam<ClipperParams>({ oversampling: Number(e.target.value) as 1 | 2 | 4 })} className="bg-[#161923] border border-[#2D3343] rounded px-2 py-1 text-xs text-[#F7F8FA]">
                    <option value={1}>1x</option><option value={2}>2x</option><option value={4}>4x</option>
                  </select>
                </label>
                <div className="p-2.5 rounded bg-[#10131B] border border-[#222634] grid grid-cols-3 gap-x-2 gap-y-3">
                  <RotaryKnob label="Drive" value={p.driveDb} min={0} max={12} step={0.1} defaultValue={1.5} unit="dB" size="sm" onChange={(v) => setParam<ClipperParams>({ driveDb: v })} />
                  <RotaryKnob label="Ceiling" value={p.ceilingDb} min={-6} max={0} step={0.1} defaultValue={-0.8} unit="dB" size="sm" onChange={(v) => setParam<ClipperParams>({ ceilingDb: v })} />
                  <RotaryKnob label="Softness" value={p.softness} min={0} max={100} step={1} defaultValue={60} unit="%" size="sm" onChange={(v) => setParam<ClipperParams>({ softness: v })} />
                </div>
              </div>
            );
          })()}

          {module.type === 'multiband-maximizer' && (() => {
            const p = module.params as MultibandMaximizerParams;
            const setBand = (key: 'low' | 'mid' | 'high', patch: Partial<MultibandMaximizerBand>) =>
              setParam<MultibandMaximizerParams>({ [key]: { ...p[key], ...patch } } as Partial<MultibandMaximizerParams>);
            return (
              <div className="flex flex-col gap-2.5">
                <div className="p-2.5 rounded bg-[#10131B] border border-[#222634] grid grid-cols-4 gap-x-2 gap-y-3">
                  <RotaryKnob label="Low X-over" value={p.lowCrossHz} min={40} max={600} step={1} defaultValue={150} unit="Hz" size="sm" scale="logarithmic" onChange={(v) => setParam<MultibandMaximizerParams>({ lowCrossHz: v })} />
                  <RotaryKnob label="High X-over" value={p.highCrossHz} min={800} max={12000} step={10} defaultValue={4000} unit="Hz" size="sm" scale="logarithmic" onChange={(v) => setParam<MultibandMaximizerParams>({ highCrossHz: v })} />
                  <RotaryKnob label="Ceiling" value={p.ceilingDb} min={-3} max={-0.1} step={0.1} defaultValue={-1} unit="dBTP" size="sm" onChange={(v) => setParam<MultibandMaximizerParams>({ ceilingDb: v })} />
                  <RotaryKnob label="Release" value={p.releaseMs} min={10} max={500} step={1} defaultValue={80} unit="ms" size="sm" onChange={(v) => setParam<MultibandMaximizerParams>({ releaseMs: v })} />
                </div>
                {(['low', 'mid', 'high'] as const).map((key) => (
                  <div key={key} className="p-2.5 rounded bg-[#10131B] border border-[#222634]">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-[#F2CA52]">{key} band</span>
                      <ToggleSwitch label="Bypass" compact checked={p[key].bypass} onChange={(checked) => setBand(key, { bypass: checked })} />
                    </div>
                    <div className="grid grid-cols-3 gap-x-2 gap-y-3">
                      <RotaryKnob label="Pre" value={p[key].preGainDb} min={-6} max={12} step={0.1} defaultValue={1.5} unit="dB" size="sm" onChange={(v) => setBand(key, { preGainDb: v })} />
                      <RotaryKnob label="Thresh" value={p[key].thresholdDb} min={-36} max={0} step={0.5} defaultValue={-18} unit="dB" size="sm" onChange={(v) => setBand(key, { thresholdDb: v })} />
                      <RotaryKnob label="Ratio" value={p[key].ratio} min={1} max={20} step={0.1} defaultValue={2.5} unit=":1" size="sm" onChange={(v) => setBand(key, { ratio: v })} />
                      <RotaryKnob label="Attack" value={p[key].attackMs} min={0.5} max={200} step={0.5} defaultValue={12} unit="ms" scale="logarithmic" size="sm" onChange={(v) => setBand(key, { attackMs: v })} />
                      <RotaryKnob label="Release" value={p[key].releaseMs} min={10} max={1000} step={1} defaultValue={120} unit="ms" scale="logarithmic" size="sm" onChange={(v) => setBand(key, { releaseMs: v })} />
                      <RotaryKnob label="Post" value={p[key].postGainDb} min={-12} max={6} step={0.1} defaultValue={0} unit="dB" size="sm" onChange={(v) => setBand(key, { postGainDb: v })} />
                    </div>
                  </div>
                ))}
              </div>
            );
          })()}

          {/* 8. BASS ENHANCER */}
          {module.type === 'bass-enhancer' && (() => {
            const p = module.params as BassEnhancerParams;
            return (
              <div className="flex flex-col gap-2.5">
                <ToggleSwitch
                  label="Low-End Mono Focus"
                  compact
                  checked={p.monoFocus}
                  onChange={(checked) => setParam<BassEnhancerParams>({ monoFocus: checked })}
                />
                <div className="p-2.5 rounded bg-[#10131B] border border-[#222634] grid grid-cols-2 gap-x-2 gap-y-3">
                  <RotaryKnob
                    label="Sub Frequency"
                    value={p.subFreqHz}
                    min={35}
                    max={90}
                    step={1}
                    defaultValue={55}
                    unit="Hz"
                    scale="logarithmic"
                    size="sm"
                    onChange={(v) => setParam<BassEnhancerParams>({ subFreqHz: v })}
                  />
                  <RotaryKnob
                    label="Sub Weight"
                    value={p.subGainDb}
                    min={0}
                    max={7}
                    step={0.1}
                    defaultValue={1.5}
                    unit="dB"
                    size="sm"
                    onChange={(v) => setParam<BassEnhancerParams>({ subGainDb: v })}
                  />
                  <RotaryKnob
                    label="Bass Harmonics"
                    value={p.harmonicDrive}
                    min={0}
                    max={100}
                    step={1}
                    defaultValue={24}
                    unit="%"
                    size="sm"
                    onChange={(v) => setParam<BassEnhancerParams>({ harmonicDrive: v })}
                  />
                  <RotaryKnob
                    label="Tightness"
                    value={p.tightness}
                    min={0}
                    max={100}
                    step={1}
                    defaultValue={55}
                    unit="%"
                    size="sm"
                    onChange={(v) => setParam<BassEnhancerParams>({ tightness: v })}
                  />
                </div>
              </div>
            );
          })()}

          {/* 9. LIMITER */}
          {module.type === 'limiter' && (() => {
            const p = module.params as LimiterParams;
            return (
              <div className="flex flex-col gap-2.5">
                <div className="grid grid-cols-2 gap-2 items-center">
                  <ToggleSwitch
                    label="True Peak"
                    compact
                    checked={p.truePeak}
                    onChange={(checked) => setParam<LimiterParams>({ truePeak: checked })}
                  />
                  <label className="flex items-center justify-between gap-1 text-[11px] text-[#9CA3AF]">
                    OS
                    <select
                      aria-label="Limiter Oversampling"
                      value={p.oversampling}
                      onChange={(e) => setParam<LimiterParams>({ oversampling: Number(e.target.value) as 1 | 2 | 4 })}
                      className="bg-[#161923] border border-[#2D3343] rounded px-2 py-1 text-xs text-[#F7F8FA]"
                    >
                      <option value={1}>1x</option>
                      <option value={2}>2x</option>
                      <option value={4}>4x TP</option>
                    </select>
                  </label>
                </div>
                <div className="p-2.5 rounded bg-[#10131B] border border-[#222634] grid grid-cols-2 gap-x-2 gap-y-3">
                  <RotaryKnob
                    label="Threshold / Drive"
                    value={p.thresholdDb}
                    min={-18}
                    max={0}
                    step={0.1}
                    defaultValue={-3.5}
                    unit="dB"
                    size="md"
                    showAdjustButtons
                    onChange={(v) => setParam<LimiterParams>({ thresholdDb: v })}
                  />
                  <RotaryKnob
                    label="Ceiling"
                    value={p.ceilingDb}
                    min={-6}
                    max={-0.1}
                    step={0.1}
                    defaultValue={-1.0}
                    unit="dBTP"
                    size="md"
                    showAdjustButtons
                    onChange={(v) => setParam<LimiterParams>({ ceilingDb: v })}
                  />
                  <RotaryKnob
                    label="Release"
                    value={p.releaseMs}
                    min={10}
                    max={500}
                    step={5}
                    defaultValue={90}
                    unit="ms"
                    scale="logarithmic"
                    size="sm"
                    onChange={(v) => setParam<LimiterParams>({ releaseMs: v })}
                  />
                  <RotaryKnob
                    label="Lookahead"
                    value={p.lookaheadMs}
                    min={0.5}
                    max={10}
                    step={0.5}
                    defaultValue={3}
                    unit="ms"
                    size="sm"
                    onChange={(v) => setParam<LimiterParams>({ lookaheadMs: v })}
                  />
                </div>
              </div>
            );
          })()}

          {/* 10. MAXIMIZER */}
          {module.type === 'maximizer' && (() => {
            const p = module.params as MaximizerParams;
            return (
              <div className="flex flex-col gap-2.5">
                <div className="grid grid-cols-2 gap-2 items-end">
                  <label className="flex flex-col gap-1 text-[11px] text-[#9CA3AF]">
                    Character Algorithm
                    <select
                      aria-label="Maximizer Character"
                      value={p.character}
                      onChange={(e) => setParam<MaximizerParams>({ character: e.target.value as MaximizerParams['character'] })}
                      className="bg-[#161923] border border-[#2D3343] rounded px-2 py-1 text-xs text-[#F7F8FA]"
                    >
                      <option value="transparent">Transparent (IRC Clean)</option>
                      <option value="punchy">Punchy (Transient Focus)</option>
                      <option value="smooth">Smooth (Warm Release)</option>
                      <option value="aggressive">Aggressive (Club Density)</option>
                    </select>
                  </label>
                  <ToggleSwitch
                    label="True Peak"
                    compact
                    checked={p.truePeak}
                    onChange={(checked) => setParam<MaximizerParams>({ truePeak: checked })}
                  />
                </div>
                <div className="p-2.5 rounded bg-[#10131B] border border-[#222634] grid grid-cols-3 gap-2">
                  <RotaryKnob
                    label="Target LUFS"
                    value={p.targetLufs}
                    min={-24}
                    max={-6}
                    step={0.5}
                    defaultValue={-14}
                    unit="LUFS"
                    size="sm"
                    onChange={(v) => setParam<MaximizerParams>({ targetLufs: v })}
                  />
                  <RotaryKnob
                    label="Ceiling"
                    value={p.ceilingDb}
                    min={-3}
                    max={-0.1}
                    step={0.1}
                    defaultValue={-1.0}
                    unit="dBTP"
                    size="sm"
                    onChange={(v) => setParam<MaximizerParams>({ ceilingDb: v })}
                  />
                  <RotaryKnob
                    label="Transients"
                    value={p.transientEmphasis}
                    min={0}
                    max={100}
                    step={1}
                    defaultValue={25}
                    unit="%"
                    size="sm"
                    onChange={(v) => setParam<MaximizerParams>({ transientEmphasis: v })}
                  />
                </div>
              </div>
            );
          })()}

          {/* 11. EXTERNAL VST3 PLUGIN CONTROLS */}
          {module.type === 'external-vst3' && (() => {
            const p = module.params as ExternalVST3Params;
            const instanceActive = Boolean(p.instanceId) && p.status === 'active' && hostConnected;
            const visibleParams = p.parameters.filter((pr) => !pr.isBypass).slice(0, 24);
            const switchParams = visibleParams.filter(
              (pr) => inferExternalVst3ControlSpec(pr).kind === 'toggle',
            );
            const rotaryParams = visibleParams.filter(
              (pr) => inferExternalVst3ControlSpec(pr).kind === 'knob',
            );

            return (
              <div className="flex flex-col gap-2.5">
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="text-[#C5CDD8] truncate">
                    {p.manufacturer} · {p.format.toUpperCase()} · Latency {p.latencySamples} smpl
                  </span>
                  <span
                    className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase ${
                      instanceActive
                        ? 'bg-[#10B981]/15 text-[#34D399]'
                        : p.status === 'crashed' || p.status === 'error'
                          ? 'bg-[#EF4444]/15 text-[#F87171]'
                          : 'bg-[#F59E0B]/15 text-[#FBBF24]'
                    }`}
                  >
                    {!hostConnected ? 'Host Offline' : p.status}
                  </span>
                </div>

                {(!hostConnected || !p.instanceId || p.status === 'crashed' || p.status === 'error') && (
                  <div className="p-2 rounded bg-[#EF4444]/10 border border-[#EF4444]/35 text-[11px] text-[#FCA5A5] flex flex-col gap-1.5">
                    <span>
                      {!hostConnected
                        ? 'Windows Companion Host disconnected. Parameter edits require an active host connection.'
                        : p.lastError || 'Plugin worker is unloaded or exited.'}
                    </span>
                    {hostConnected && onLoadExternalInstance && (
                      <button
                        type="button"
                        onClick={() => void onLoadExternalInstance(module)}
                        className="self-start px-2.5 py-1 rounded bg-[#D4AF37] text-[#070709] text-[11px] font-bold hover:bg-[#F2CA52]"
                      >
                        {p.instanceId ? 'Reload VST3 Worker' : 'Load VST3 Instance'}
                      </button>
                    )}
                  </div>
                )}

                {hostConnected && p.lastError && p.status === 'active' && (
                  <div className="p-2 rounded bg-[#F59E0B]/10 border border-[#F59E0B]/40 text-[11px] text-[#FDE68A]">
                    Parameter sync notice: {p.lastError}
                  </div>
                )}

                {instanceActive && p.hasEditor && onToggleExternalEditor && (
                  <button
                    type="button"
                    onClick={() => void onToggleExternalEditor(module)}
                    className="w-full py-1.5 rounded bg-[#181A22] border border-[#38BDF8]/50 text-xs font-semibold text-[#38BDF8] hover:bg-[#38BDF8]/10"
                  >
                    {p.editorOpen ? 'Close Native Plugin GUI' : 'Open Native Plugin GUI'}
                  </button>
                )}

                {visibleParams.length === 0 ? (
                  <div className="text-[11px] text-[#6B7280] py-1">
                    No automatable parameters reported by plugin. Use Open Native Plugin GUI if available.
                  </div>
                ) : (
                  <div className="flex flex-col gap-2 max-h-72 overflow-y-auto pr-0.5">
                    {switchParams.length > 0 && (
                      <div className="grid grid-cols-2 gap-2">
                        {switchParams.map((param) => (
                          <ToggleSwitch
                            key={param.id}
                            label={param.name}
                            compact
                            checked={param.valueNormalized >= 0.5}
                            disabled={!instanceActive}
                            readOnly={param.isReadOnly}
                            onLabel={param.displayValue || 'ON'}
                            offLabel={param.displayValue || 'OFF'}
                            onChange={(checked) => {
                              if (onSetExternalParam && instanceActive && !param.isReadOnly) {
                                void onSetExternalParam(module, param.id, checked ? 1 : 0);
                              }
                            }}
                          />
                        ))}
                      </div>
                    )}

                    {rotaryParams.length > 0 && (
                      <div className="p-2 rounded bg-[#10131B] border border-[#222634] grid grid-cols-2 sm:grid-cols-3 gap-x-2 gap-y-3">
                        {rotaryParams.map((param) => {
                          const spec = inferExternalVst3ControlSpec(param);
                          return (
                            <RotaryKnob
                              key={param.id}
                              label={param.name}
                              ariaLabel={`${p.pluginName} ${param.name}`}
                              value={param.valueNormalized}
                              min={spec.min}
                              max={spec.max}
                              step={spec.step}
                              defaultValue={param.defaultValueNormalized}
                              unit={spec.unit}
                              scale={spec.scale}
                              bipolar={spec.bipolar}
                              signed={spec.signed}
                              precision={spec.precision}
                              size="xs"
                              disabled={!instanceActive}
                              readOnly={param.isReadOnly}
                              formatValue={spec.formatValue}
                              displayValueOverride={param.displayValue || undefined}
                              onChange={(nextNorm) => {
                                if (onSetExternalParam && instanceActive && !param.isReadOnly) {
                                  void onSetExternalParam(module, param.id, nextNorm);
                                }
                              }}
                            />
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
});
