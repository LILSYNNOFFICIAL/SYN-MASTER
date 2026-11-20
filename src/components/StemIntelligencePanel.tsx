import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, AudioLines, FileAudio, Layers3, Loader2, Plus, ScanSearch, Trash2 } from 'lucide-react';
import {
  analyzeStemSet,
  type StemInput,
  type StemRole,
  type StemSetAnalysis,
} from '../dsp/stemAnalysis';

interface LoadedStem extends StemInput {
  fileName: string;
}

const ROLE_OPTIONS: Array<{ value: StemRole; label: string }> = [
  { value: 'vocals', label: 'Vocals' },
  { value: 'bass', label: 'Bass' },
  { value: 'drums', label: 'Drums' },
  { value: 'instruments', label: 'Instruments' },
  { value: 'other', label: 'Other' },
];

function inferRole(fileName: string): StemRole {
  const name = fileName.toLowerCase();
  if (/vocal|voice|vox|lead/.test(name)) return 'vocals';
  if (/bass|sub|808/.test(name)) return 'bass';
  if (/drum|kick|snare|percussion/.test(name)) return 'drums';
  if (/instrument|music|guitar|keys|piano|synth/.test(name)) return 'instruments';
  return 'other';
}

function makeStemId(): string {
  return `stem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const BAND_LABELS: Record<string, string> = {
  sub: 'Sub 20–60 Hz',
  bass: 'Bass 60–250 Hz',
  lowMid: 'Low-mid 250–500 Hz',
  mid: 'Mid 500 Hz–2 kHz',
  highMid: 'High-mid 2–6 kHz',
  presence: 'Presence 6–12 kHz',
  air: 'Air 12–20 kHz',
};

export const StemIntelligencePanel: React.FC = () => {
  const contextRef = useRef<AudioContext | null>(null);
  const [stems, setStems] = useState<LoadedStem[]>([]);
  const [analysis, setAnalysis] = useState<StemSetAnalysis | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);\n  const [chainsByStemId, setChainsByStemId] = useState<Record<string, ProcessorModule[]>>({});\n  const [processedMix, setProcessedMix] = useState<StemBusMixResult | null>(null);\n  const [rendering, setRendering] = useState(false);

  useEffect(() => () => {
    if (contextRef.current && contextRef.current.state !== 'closed') {
      void contextRef.current.close();
    }
  }, []);

  const importFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    setAnalysis(null);
    try {
      const context = contextRef.current ?? new AudioContext();
      contextRef.current = context;
      const imported: LoadedStem[] = [];
      for (const file of Array.from(files)) {
        const decoded = await context.decodeAudioData(await file.arrayBuffer());
        if (decoded.numberOfChannels > 2) {
          throw new Error(`${file.name}: ${decoded.numberOfChannels}-channel files are not supported. Export this stem as mono or stereo first.`);
        }
        const channels = Array.from(
          { length: decoded.numberOfChannels },
          (_, channel) => decoded.getChannelData(channel).slice(),
        );
        imported.push({
          id: makeStemId(),
          name: file.name.replace(/\\.[^.]+$/, ''),
          fileName: file.name,
          role: inferRole(file.name),
          channels,
          sampleRate: decoded.sampleRate,
          offsetSamples: 0,
        });
      }
      setStems((current) => [...current, ...imported]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to decode one or more audio files.');
    } finally {
      setBusy(false);
    }
  };

  const updateStem = (id: string, patch: Partial<Pick<LoadedStem, 'role' | 'offsetSamples'>>) => {
    setStems((current) => current.map((stem) => stem.id === id ? { ...stem, ...patch } : stem));
    setAnalysis(null);
    setProcessedMix(null);
  };

  const removeStem = (id: string) => {
    setStems((current) => current.filter((stem) => stem.id !== id));
    setChainsByStemId((current) => { const next = { ...current }; delete next[id]; return next; });
    setAnalysis(null);
    setProcessedMix(null);
  };

  const addProcessor = (stemId: string, type: ProcessorType) => {
    const module = createProcessorModule(type);
    setChainsByStemId((current) => ({
      ...current,
      [stemId]: [...(current[stemId] ?? []), module],
    }));
    setProcessedMix(null);
  };

  const updateProcessor = (stemId: string, moduleId: string, patch: Partial<ProcessorModule>) => {
    setChainsByStemId((current) => ({
      ...current,
      [stemId]: (current[stemId] ?? []).map((module) => module.id === moduleId ? { ...module, ...patch } : module),
    }));
    setProcessedMix(null);
  };

  const removeProcessor = (stemId: string, moduleId: string) => {
    setChainsByStemId((current) => ({
      ...current,
      [stemId]: (current[stemId] ?? []).filter((module) => module.id !== moduleId),
    }));
    setProcessedMix(null);
  };

  const updateEqBand = (stemId: string, moduleId: string, bandIndex: number, patch: Partial<ParametricEQParams['bands'][number]>) => {
    setChainsByStemId((current) => ({
      ...current,
      [stemId]: (current[stemId] ?? []).map((module) => {
        if (module.id !== moduleId || module.type !== 'parametric-eq') return module;
        const params = module.params as ParametricEQParams;
        return {
          ...module,
          params: {
            ...params,
            bands: params.bands.map((band, index) => index === bandIndex ? { ...band, ...patch } : band),
          },
        };
      }),
    }));
    setProcessedMix(null);
  };

  const renderProcessedMix = async () => {
    if (stems.length === 0) return;
    setRendering(true);
    setError(null);
    setProcessedMix(null);
    try {
      const sampleRate = stems[0].sampleRate ?? 0;
      const result = await renderStemBusMix(stems, sampleRate, { chainsByStemId });
      setProcessedMix(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Stem bus render failed.');
    } finally {
      setRendering(false);
    }
  };

  const playProcessedMix = () => {
    if (!processedMix || !contextRef.current) return;
    const context = contextRef.current;
    void context.resume();
    const buffer = context.createBuffer(2, processedMix.mixChannels[0].length, processedMix.sampleRate);
    buffer.copyToChannel(processedMix.mixChannels[0], 0);
    buffer.copyToChannel(processedMix.mixChannels[1], 1);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start();
  };

  const runAnalysis = () => {
    setError(null);
    setAnalysis(null);
    try {
      if (stems.length === 0) throw new Error('Import at least one stem to begin analysis.');
      const sampleRate = stems[0].sampleRate ?? 0;
      const result = analyzeStemSet(stems, sampleRate);
      setAnalysis(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Stem analysis failed.');
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-lg border border-[#292D38] bg-[#111217] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="rounded-md border border-[#D4AF37]/30 bg-[#D4AF37]/10 p-2 text-[#D4AF37]">
              <Layers3 size={18} />
            </div>
            <div>
              <h3 className="text-sm font-bold tracking-wide text-[#F7F8FA]">STEM INTELLIGENCE</h3>
              <p className="text-xs text-[#9CA3AF]">Analyze separated sources on a shared timeline.</p>
            </div>
          </div>
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-[#3B4150] bg-[#1B1E27] px-3 py-2 text-xs font-semibold text-[#E5E7EB] hover:border-[#D4AF37]">
            <Plus size={14} />
            Import Stems
            <input
              type="file"
              multiple
              accept="audio/*,.wav,.mp3,.flac,.aiff,.m4a"
              className="hidden"
              disabled={busy}
              onChange={(event) => {
                void importFiles(event.currentTarget.files);
                event.currentTarget.value = '';
              }}
            />
          </label>
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-[#8B93A3]">
          Import mono or stereo WAV/audio stems. Files are decoded to one session sample rate.
          Imported stems start at sample 0; adjust offsets below when their timeline positions differ.
          This tool analyzes supplied stems. It does not separate a stereo mix into stems.
        </p>
      </section>

      {busy && (
        <div className="flex items-center gap-2 rounded border border-[#343A49] bg-[#171A22] p-3 text-xs text-[#D4AF37]">
          <Loader2 size={15} className="animate-spin" /> Decoding audio files…
        </div>
      )}

      {stems.length > 0 && (
        <section className="rounded-lg border border-[#292D38] bg-[#111217] p-4">
          <div className="mb-3 flex items-center justify-between">
            <h4 className="text-xs font-bold uppercase tracking-wider text-[#D4AF37]">Imported Sources</h4>
            <span className="font-mono-tabular text-[11px] text-[#9CA3AF]">{stems.length} stems · {stems[0].sampleRate?.toLocaleString()} Hz</span>
          </div>
          <div className="flex flex-col gap-2">
            {stems.map((stem) => (
              <div key={stem.id} className="grid grid-cols-1 gap-2 rounded border border-[#252A35] bg-[#171A22] p-3 md:grid-cols-[minmax(0,1fr)_150px_150px_32px] md:items-center">
                <div className="flex min-w-0 items-center gap-2">
                  <FileAudio size={15} className="shrink-0 text-[#D4AF37]" />
                  <div className="min-w-0">
                    <div className="truncate text-xs font-semibold text-[#F7F8FA]">{stem.name}</div>
                    <div className="text-[10px] text-[#7F8795]">{stem.channels.length === 1 ? 'Mono' : 'Stereo'} · {(stem.channels[0].length / (stem.sampleRate ?? 1)).toFixed(2)} sec</div>
                  </div>
                </div>
                <select
                  value={stem.role}
                  onChange={(event) => updateStem(stem.id, { role: event.target.value as StemRole })}
                  className="rounded border border-[#343A49] bg-[#0C0E13] px-2 py-1.5 text-xs text-[#E5E7EB]"
                  aria-label={`Role for ${stem.name}`}
                >
                  {ROLE_OPTIONS.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}
                </select>
                <label className="flex items-center gap-2 text-[10px] text-[#8B93A3]">
                  Offset
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={stem.offsetSamples ?? 0}
                    onChange={(event) => updateStem(stem.id, { offsetSamples: Math.max(0, Math.floor(Number(event.target.value) || 0)) })}
                    className="min-w-0 w-full rounded border border-[#343A49] bg-[#0C0E13] px-2 py-1.5 font-mono-tabular text-xs text-[#F7F8FA]"
                    aria-label={`Timeline offset in samples for ${stem.name}`}
                  />
                </label>
                <button type="button" onClick={() => removeStem(stem.id)} className="rounded p-2 text-[#8B93A3] hover:bg-red-500/10 hover:text-red-400" aria-label={`Remove ${stem.name}`}>
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              disabled={busy}
              onClick={runAnalysis}
              className="inline-flex items-center gap-2 rounded-md bg-[#D4AF37] px-4 py-2 text-xs font-bold text-[#08090B] hover:bg-[#E6C65C] disabled:opacity-50"
            >
              <ScanSearch size={14} /> Analyze Stem Set
            </button>
          </div>
        </section>
      )}

      {stems.length > 0 && (
        <section className="rounded-lg border border-[#292D38] bg-[#111217] p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h4 className="text-xs font-bold uppercase tracking-wider text-[#D4AF37]">Independent Stem Processing</h4>
              <p className="mt-1 text-[10px] text-[#8B93A3]">Each rack processes only its assigned stem. No master-bus correction is substituted.</p>
            </div>
            <button
              type="button"
              disabled={rendering || busy}
              onClick={() => void renderProcessedMix()}
              className="inline-flex items-center gap-2 rounded-md bg-[#D4AF37] px-4 py-2 text-xs font-bold text-[#08090B] hover:bg-[#E6C65C] disabled:opacity-50"
            >
              {rendering ? <Loader2 size={14} className="animate-spin" /> : <AudioLines size={14} />}
              {rendering ? 'Rendering Buses…' : 'Render Processed Mix'}
            </button>
          </div>
          <div className="flex flex-col gap-3">
            {stems.map((stem) => {
              const chain = chainsByStemId[stem.id] ?? [];
              return (
                <div key={stem.id} className="rounded border border-[#252A35] bg-[#171A22] p-3">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div className="text-xs font-semibold text-[#F7F8FA]">{stem.name} <span className="ml-1 text-[10px] font-normal uppercase text-[#8B93A3]">{stem.role} BUS</span></div>
                    <select
                      aria-label={`Add processor to ${stem.name}`}
                      value=""
                      onChange={(event) => {
                        if (event.target.value) addProcessor(stem.id, event.target.value as ProcessorType);
                        event.target.value = '';
                      }}
                      className="rounded border border-[#343A49] bg-[#0C0E13] px-2 py-1.5 text-[11px] text-[#E5E7EB]"
                    >
                      <option value="">+ Add processor…</option>
                      <option value="parametric-eq">Parametric EQ</option>
                      <option value="dynamic-eq">Dynamic EQ</option>
                      <option value="compressor">Compressor</option>
                      <option value="multiband-comp">Multiband Compressor</option>
                      <option value="stereo-imager">Stereo Imager</option>
                      <option value="saturation">Saturation</option>
                      <option value="limiter">Limiter</option>
                    </select>
                  </div>
                  {chain.length === 0 ? (
                    <p className="text-[10px] text-[#727B8B]">Dry bus · no processors assigned.</p>
                  ) : (
                    <div className="flex flex-col gap-3">
                      {chain.map((module) => (
                        <div key={module.id} className="rounded border border-[#303746] bg-[#10131A] p-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={!module.bypassed}
                                onChange={(event) => updateProcessor(stem.id, module.id, { bypassed: !event.target.checked })}
                                aria-label={`Enable ${module.name}`}
                              />
                              <span className="text-[11px] font-semibold text-[#E5E7EB]">{module.name}</span>
                              <span className="text-[9px] uppercase text-[#727B8B]">{module.type}</span>
                            </div>
                            <button type="button" onClick={() => removeProcessor(stem.id, module.id)} className="rounded px-2 py-1 text-[10px] text-[#9CA3AF] hover:bg-red-500/10 hover:text-red-300">Remove</button>
                          </div>
                          <div className="mt-2 grid grid-cols-2 gap-3 md:grid-cols-4">
                            <label className="text-[9px] text-[#8B93A3]">Intensity {module.intensity}%
                              <input type="range" min="0" max="100" value={module.intensity} onChange={(event) => updateProcessor(stem.id, module.id, { intensity: Number(event.target.value) })} className="mt-1 w-full" />
                            </label>
                            <label className="text-[9px] text-[#8B93A3]">Wet {module.wetDry}%
                              <input type="range" min="0" max="100" value={module.wetDry} onChange={(event) => updateProcessor(stem.id, module.id, { wetDry: Number(event.target.value) })} className="mt-1 w-full" />
                            </label>
                            <label className="text-[9px] text-[#8B93A3]">Input {module.inputGainDb.toFixed(1)} dB
                              <input type="range" min="-12" max="12" step="0.1" value={module.inputGainDb} onChange={(event) => updateProcessor(stem.id, module.id, { inputGainDb: Number(event.target.value) })} className="mt-1 w-full" />
                            </label>
                            <label className="text-[9px] text-[#8B93A3]">Output {module.outputGainDb.toFixed(1)} dB
                              <input type="range" min="-12" max="12" step="0.1" value={module.outputGainDb} onChange={(event) => updateProcessor(stem.id, module.id, { outputGainDb: Number(event.target.value) })} className="mt-1 w-full" />
                            </label>
                          </div>
                          {module.type === 'parametric-eq' && (
                            <div className="mt-3 flex flex-col gap-2">
                              {(module.params as ParametricEQParams).bands.map((band, index) => (
                                <div key={band.id} className="grid grid-cols-[28px_minmax(0,1fr)_90px_80px] items-center gap-2">
                                  <input type="checkbox" checked={band.enabled} onChange={(event) => updateEqBand(stem.id, module.id, index, { enabled: event.target.checked })} aria-label={`Enable EQ band ${band.id}`} />
                                  <span className="text-[9px] uppercase text-[#8B93A3]">{band.shape}</span>
                                  <label className="text-[9px] text-[#8B93A3]">Hz
                                    <input type="number" min="20" max="19500" value={band.freq} onChange={(event) => updateEqBand(stem.id, module.id, index, { freq: Number(event.target.value) })} className="mt-1 w-full rounded border border-[#343A49] bg-[#0C0E13] px-1.5 py-1 font-mono-tabular text-[10px] text-[#E5E7EB]" />
                                  </label>
                                  <label className="text-[9px] text-[#8B93A3]">dB
                                    <input type="number" min="-12" max="12" step="0.1" value={band.gain} onChange={(event) => updateEqBand(stem.id, module.id, index, { gain: Number(event.target.value) })} className="mt-1 w-full rounded border border-[#343A49] bg-[#0C0E13] px-1.5 py-1 font-mono-tabular text-[10px] text-[#E5E7EB]" />
                                  </label>
                                </div>
                              ))}
                            </div>
                          )}
                          {module.type === 'compressor' && (
                            <div className="mt-3 grid grid-cols-2 gap-3">
                              <label className="text-[9px] text-[#8B93A3]">Threshold {(module.params as CompressorParams).thresholdDb.toFixed(1)} dB
                                <input type="range" min="-40" max="0" step="0.5" value={(module.params as CompressorParams).thresholdDb} onChange={(event) => updateProcessor(stem.id, module.id, { params: { ...(module.params as CompressorParams), thresholdDb: Number(event.target.value) } })} className="mt-1 w-full" />
                              </label>
                              <label className="text-[9px] text-[#8B93A3]">Ratio {(module.params as CompressorParams).ratio.toFixed(1)}:1
                                <input type="range" min="1" max="10" step="0.1" value={(module.params as CompressorParams).ratio} onChange={(event) => updateProcessor(stem.id, module.id, { params: { ...(module.params as CompressorParams), ratio: Number(event.target.value) } })} className="mt-1 w-full" />
                              </label>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {processedMix && (
        <section className="rounded-lg border border-[#D4AF37]/30 bg-[#111217] p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h4 className="text-xs font-bold uppercase tracking-wider text-[#D4AF37]">Processed Stem Mix</h4>
              <p className="mt-1 text-[10px] text-[#8B93A3]">{processedMix.stems.length} independent buses · {processedMix.durationSec.toFixed(2)} sec · {processedMix.sampleRate.toLocaleString()} Hz</p>
            </div>
            <button type="button" onClick={playProcessedMix} className="rounded-md border border-[#D4AF37]/40 px-3 py-2 text-xs font-semibold text-[#E5E7EB] hover:bg-[#D4AF37]/10">▶ Preview Mix</button>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
            {[
              ['Integrated', `${processedMix.mixAnalysis.integratedLufs.toFixed(1)} LUFS`],
              ['True Peak', `${processedMix.mixAnalysis.truePeakDb.toFixed(2)} dBTP`],
              ['Sample Peak', `${processedMix.mixAnalysis.samplePeakDb.toFixed(2)} dBFS`],
              ['Clipped Samples', String(processedMix.mixAnalysis.clippedSamples)],
            ].map(([label, value]) => (
              <div key={label} className="rounded border border-[#292D38] bg-[#171A22] p-3">
                <div className="text-[10px] uppercase tracking-wider text-[#8B93A3]">{label}</div>
                <div className="mt-1 font-mono-tabular text-base font-bold text-[#F7F8FA]">{value}</div>
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-col gap-1">
            {processedMix.stems.map((stem) => (
              <div key={stem.id} className="flex items-center justify-between border-b border-[#252A35] py-2 text-[10px]">
                <span className="text-[#E5E7EB]">{stem.name} · {stem.chain.length} processor(s)</span>
                <span className="font-mono-tabular text-[#AAB2C0]">{stem.analysis.integratedLufs.toFixed(1)} LUFS · {stem.analysis.truePeakDb.toFixed(2)} dBTP</span>
              </div>
            ))}
          </div>
          {processedMix.warnings.map((warning) => (
            <div key={warning} className="mt-2 rounded border border-amber-500/30 bg-amber-500/5 p-2 text-[10px] text-amber-200">{warning}</div>
          ))}
        </section>
      )}

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded border border-red-500/30 bg-red-500/5 p-3 text-xs text-red-300">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}

      {analysis && (
        <>
          <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {[
              ['Timeline', `${analysis.durationSec.toFixed(2)} s`],
              ['Integrated', `${analysis.mixAnalysis.integratedLufs.toFixed(1)} LUFS`],
              ['True Peak', `${analysis.mixAnalysis.truePeakDb.toFixed(2)} dBTP`],
              ['Clipped Samples', String(analysis.mixAnalysis.clippedSamples)],
            ].map(([label, value]) => (
              <div key={label} className="rounded border border-[#292D38] bg-[#111217] p-3">
                <div className="text-[10px] uppercase tracking-wider text-[#8B93A3]">{label}</div>
                <div className="mt-1 font-mono-tabular text-lg font-bold text-[#F7F8FA]">{value}</div>
              </div>
            ))}
          </section>

          <section className="rounded-lg border border-[#292D38] bg-[#111217] p-4">
            <h4 className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[#D4AF37]">
              <AudioLines size={15} /> Per-Stem Analysis
            </h4>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-xs">
                <thead className="text-[10px] uppercase tracking-wider text-[#818A99]">
                  <tr><th className="pb-2">Source</th><th className="pb-2">Role</th><th className="pb-2">LUFS</th><th className="pb-2">Peak</th><th className="pb-2">Width</th><th className="pb-2">Offset</th></tr>
                </thead>
                <tbody>
                  {analysis.stems.map((stem) => (
                    <tr key={stem.id} className="border-t border-[#252A35]">
                      <td className="py-2 font-semibold text-[#E5E7EB]">{stem.name}</td>
                      <td className="py-2 capitalize text-[#AAB2C0]">{stem.role}</td>
                      <td className="py-2 font-mono-tabular text-[#E5E7EB]">{stem.analysis.integratedLufs.toFixed(1)}</td>
                      <td className="py-2 font-mono-tabular text-[#E5E7EB]">{stem.analysis.truePeakDb.toFixed(2)} dBTP</td>
                      <td className="py-2 font-mono-tabular text-[#E5E7EB]">{(stem.analysis.stereoWidth * 100).toFixed(0)}%</td>
                      <td className="py-2 font-mono-tabular text-[#E5E7EB]">{stem.offsetSamples.toLocaleString()} smp</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-lg border border-[#292D38] bg-[#111217] p-4">
            <div className="mb-3 flex items-center justify-between">
              <h4 className="text-xs font-bold uppercase tracking-wider text-[#D4AF37]">Spectral Overlap Candidates</h4>
              <span className="font-mono-tabular text-[11px] text-[#9CA3AF]">{analysis.overlaps.length} candidates</span>
            </div>
            {analysis.overlaps.length === 0 ? (
              <p className="text-xs text-[#8B93A3]">No significant same-band level overlaps were identified by this screening pass.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {analysis.overlaps.map((item, index) => (
                  <div key={`${item.stemAId}-${item.stemBId}-${item.band}-${index}`} className="flex flex-wrap items-center justify-between gap-2 rounded border border-[#252A35] bg-[#171A22] p-3">
                    <div>
                      <div className="text-xs font-semibold text-[#E5E7EB]">{item.stemAId} + {item.stemBId}</div>
                      <div className="mt-0.5 text-[10px] text-[#8B93A3]">{BAND_LABELS[item.band]} · {item.confidence} confidence</div>
                    </div>
                    <div className="font-mono-tabular text-xs text-[#D4AF37]">{item.differenceDb.toFixed(1)} dB apart</div>
                  </div>
                ))}
              </div>
            )}
            <p className="mt-3 text-[10px] leading-relaxed text-[#7F8795]">
              These are spectral coexistence candidates based on similar per-band energy. They do not establish audible masking. Confirm by listening in context before applying corrective EQ or dynamics.
            </p>
          </section>

          {analysis.warnings.map((warning) => (
            <div key={warning} className="flex items-start gap-2 rounded border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-200">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {warning}
            </div>
          ))}
        </>
      )}
    </div>
  );
};
