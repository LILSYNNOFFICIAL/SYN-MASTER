import React from 'react';
import { Download, X } from 'lucide-react';
import type { AppSettings, ExportConfig } from '../types/mastering';
import { Portal } from '../ui/Portal';
import { changeViewMode, parseViewMode, readViewMode } from '../ui/viewMode';

interface ExportModalProps {
  open: boolean;
  config: ExportConfig;
  rendering: boolean;
  downloadUrl: string | null;
  downloadFilename: string | null;
  deliveryCheck?: { text: string; warning: boolean } | null;
  renderError?: string | null;
  renderProgress?: string | null;
  hasTrack: boolean;
  onChange: (next: ExportConfig) => void;
  onRender: () => void;
  onClose: () => void;
}

export const ExportModal: React.FC<ExportModalProps> = ({
  open, config, rendering, downloadUrl, downloadFilename, deliveryCheck, renderError, renderProgress, hasTrack, onChange, onRender, onClose,
}) => {
  if (!open) return null;
  const fieldClass = "bg-[#090704] border border-[#5A4519] focus:border-[#D4AF37] rounded px-2.5 py-1.5 text-xs text-[#F7F1E2]";
  const labelClass = "flex flex-col gap-1 text-[11px] text-[#C7B98F]";
  const extensions: Record<ExportConfig['format'], string> = {
    wav: 'WAV', mp3: 'MP3', ogg: 'OGG', flac: 'FLAC', m4a: 'M4A', mid: 'MIDI', 'webm-opus': 'WEBM',
  };
  const formatOptions: Array<{ value: ExportConfig['format']; label: string }> = [
    { value: 'wav', label: 'WAV · PCM / Float' },
    { value: 'flac', label: 'FLAC · Lossless' },
    { value: 'mp3', label: 'MP3 · LAME' },
    { value: 'ogg', label: 'OGG · Vorbis' },
    { value: 'm4a', label: 'M4A · AAC' },
    { value: 'webm-opus', label: 'WebM · Opus' },
    { value: 'mid', label: 'MIDI · Tempo / markers' },
  ];
  const selectedFormats = config.selectedFormats?.length ? config.selectedFormats : [config.format];
  const toggleFormat = (format: ExportConfig['format'], checked: boolean) => {
    const next = checked
      ? Array.from(new Set([...selectedFormats, format]))
      : selectedFormats.filter((item) => item !== format);
    if (next.length > 0) onChange({ ...config, selectedFormats: next });
  };

  return (
    <Portal>
    <div role="dialog" aria-modal="true" aria-label="Export Master Audio"
      className="syn-modal-backdrop syn-export-backdrop fixed inset-0 bg-black/85 flex items-center justify-center p-4"
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
      <div className="syn-modal syn-export-modal w-full max-w-2xl max-h-[92vh] overflow-y-auto rounded-xl bg-[#090806] border border-[#D4AF37]/70 shadow-[0_24px_90px_rgba(0,0,0,.8)]">
        <div className="sticky top-0 z-10 px-5 py-4 border-b border-[#5A4519] flex items-center justify-between bg-[#100D06]">
          <div>
            <h2 className="text-sm font-black text-[#F2CA52] uppercase tracking-[.16em]">SYN-RENDER · High-Quality Export</h2>
            <p className="mt-1 text-[10px] text-[#A99A74]">Full-song offline mastering render</p>
          </div>
          <button type="button" aria-label="Close Export Modal" onClick={onClose}
            className="p-2 rounded border border-[#4A3917] text-[#D4AF37] hover:bg-[#D4AF37]/15"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-5 flex flex-col gap-4">
          <section className="rounded-lg border border-[#D4AF37]/50 bg-[#100D06] p-3 flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[10px] font-black uppercase tracking-[.14em] text-[#F2CA52]">Package formats</div>
              <span className="text-[10px] text-[#A99A74]">{selectedFormats.length} selected · ZIP delivery</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {formatOptions.map((option) => (
                <label key={option.value} className="flex items-center gap-2 text-[11px] text-[#E8D9AF] rounded border border-[#4A3917] px-2 py-2 hover:border-[#D4AF37]/70">
                  <input
                    type="checkbox"
                    checked={selectedFormats.includes(option.value)}
                    onChange={(event) => toggleFormat(option.value, event.target.checked)}
                    className="accent-[#D4AF37]"
                  />
                  {option.label}
                </label>
              ))}
            </div>
            <p className="text-[10px] text-[#A99A74]">Every checked format is rendered from the same processed master and included in one ZIP. Codec settings below apply to the format selected in the settings preview.</p>
          </section>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <label className="flex flex-col gap-1 text-[11px] text-[#C7B98F] sm:col-span-2 lg:col-span-2">
              Output Filename
              <input type="text" value={config.filename}
                onChange={(e) => onChange({ ...config, filename: e.target.value })} className={fieldClass} />
            </label>
            <label className={labelClass}>
              Codec Settings Preview
              <select value={config.format}
                onChange={(e) => onChange({ ...config, format: e.target.value as ExportConfig['format'] })} className={fieldClass}>
                <option value="wav">WAV — PCM / Float</option>
                <option value="mp3">MP3 — 320 kbps</option>
                <option value="ogg">OGG — Vorbis</option>
                <option value="flac">FLAC — Lossless</option>
                <option value="m4a">M4A — AAC</option>
                <option value="webm-opus">WEBM — Opus</option>
                <option value="mid">MID — Tempo / Loop Metadata</option>
              </select>
            </label>

            {config.format === 'wav' && (
              <label className={labelClass}>WAV Bit Depth
                <select value={config.wavBitDepth} onChange={(e) => onChange({ ...config, wavBitDepth: Number(e.target.value) as 16 | 24 | 32 })} className={fieldClass}>
                  <option value={16}>16-bit PCM</option><option value={24}>24-bit PCM</option><option value={32}>32-bit IEEE Float</option>
                </select>
              </label>
            )}
            {config.format === 'mp3' && (
              <label className={labelClass}>MP3 Bitrate
                <select value={config.mp3BitrateKbps ?? 320} onChange={(e) => onChange({ ...config, mp3BitrateKbps: Number(e.target.value) as ExportConfig['mp3BitrateKbps'] })} className={fieldClass}>
                  <option value={128}>128 kbps</option><option value={192}>192 kbps</option><option value={256}>256 kbps</option><option value={320}>320 kbps (Maximum)</option>
                </select>
              </label>
            )}
            {config.format === 'ogg' && (
              <label className={labelClass}>OGG Bitrate
                <select value={config.oggBitrateKbps ?? 192} onChange={(e) => onChange({ ...config, oggBitrateKbps: Number(e.target.value) as ExportConfig['oggBitrateKbps'] })} className={fieldClass}>
                  <option value={96}>96 kbps</option><option value={128}>128 kbps</option><option value={160}>160 kbps</option><option value={192}>192 kbps</option><option value={256}>256 kbps</option><option value={320}>320 kbps</option>
                </select>
              </label>
            )}
            {config.format === 'flac' && <>
              <label className={labelClass}>FLAC Bit Depth
                <select value={config.flacBitDepth ?? 24} onChange={(e) => onChange({ ...config, flacBitDepth: Number(e.target.value) as 16 | 24 })} className={fieldClass}>
                  <option value={16}>16-bit</option><option value={24}>24-bit lossless</option>
                </select>
              </label>
              <label className={labelClass}>FLAC Compression
                <select value={config.flacCompression ?? 5} onChange={(e) => onChange({ ...config, flacCompression: Number(e.target.value) })} className={fieldClass}>
                  {Array.from({ length: 9 }, (_, i) => <option key={i} value={i}>Level {i}</option>)}
                </select>
              </label>
            </>}
            {config.format === 'm4a' && (
              <label className={labelClass}>AAC Bitrate
                <select value={config.aacBitrateKbps ?? 320} onChange={(e) => onChange({ ...config, aacBitrateKbps: Number(e.target.value) as ExportConfig['aacBitrateKbps'] })} className={fieldClass}>
                  <option value={128}>128 kbps</option><option value={192}>192 kbps</option><option value={256}>256 kbps</option><option value={320}>320 kbps</option>
                </select>
              </label>
            )}
            {config.format === 'webm-opus' && (
              <label className={labelClass}>Opus Bitrate
                <select value={config.opusBitrateKbps ?? 192} onChange={(e) => onChange({ ...config, opusBitrateKbps: Number(e.target.value) as ExportConfig['opusBitrateKbps'] })} className={fieldClass}>
                  <option value={96}>96 kbps</option><option value={128}>128 kbps</option><option value={160}>160 kbps</option><option value={192}>192 kbps</option><option value={256}>256 kbps</option>
                </select>
              </label>
            )}
            {config.format !== 'mid' && <>
              <label className={labelClass}>Title (metadata)
                <input type="text" value={config.metadataTitle ?? ''} placeholder="Leave blank to omit"
                  onChange={(e) => onChange({ ...config, metadataTitle: e.target.value })} className={fieldClass} />
              </label>
              <label className={labelClass}>Artist (metadata)
                <input type="text" value={config.metadataArtist ?? ''} placeholder="Leave blank to omit"
                  onChange={(e) => onChange({ ...config, metadataArtist: e.target.value })} className={fieldClass} />
              </label>
            </>}
            {config.format !== 'mid' && <>
              <label className={labelClass}>Sample Rate
                <select value={config.sampleRate} onChange={(e) => onChange({ ...config, sampleRate: Number(e.target.value) as ExportConfig['sampleRate'] })} className={fieldClass}>
                  <option value={44100}>44.1 kHz</option><option value={48000}>48 kHz</option><option value={88200}>88.2 kHz</option><option value={96000}>96 kHz</option>
                </select>
              </label>
              <label className={labelClass}>Channels
                <select value={config.channels} onChange={(e) => onChange({ ...config, channels: e.target.value as 'stereo' | 'mono' })} className={fieldClass}>
                  <option value="stereo">Stereo</option><option value="mono">Mono Fold-Down</option>
                </select>
              </label>
              <label className={labelClass}>Resampling
                <div className={fieldClass + " text-[#F2CA52]"}>512-point windowed sinc</div>
              </label>
              {(config.format === 'wav' || config.format === 'flac') && (
                <label className={labelClass}>Dithering
                  <select value={config.dither} onChange={(e) => onChange({ ...config, dither: e.target.value as 'none' | 'tpdf' })} className={fieldClass}>
                    <option value="none">None (default)</option><option value="tpdf">TPDF Triangular Dither</option>
                  </select>
                </label>
              )}
              <label className={labelClass}>True-Peak Ceiling
                <input type="number" min={-3} max={-0.1} step={0.1} value={config.ceilingDb}
                  onChange={(e) => onChange({ ...config, ceilingDb: Number(e.target.value) })} className={fieldClass} />
              </label>
            </>}
            {config.format !== 'mid' && <>
              <label className={labelClass}>Delivery Objective
                <select
                  value={config.deliveryProfile}
                  onChange={(e) => {
                    const profile = e.target.value;
                    const presets: Record<string, Partial<ExportConfig>> = {
                      streaming: { normalizeToTarget: true, targetLufs: -14, ceilingDb: -1 },
                      club: { normalizeToTarget: true, targetLufs: -9, ceilingDb: -0.5 },
                      broadcast: { normalizeToTarget: true, targetLufs: -23, ceilingDb: -1 },
                      archive: { normalizeToTarget: false, targetLufs: -14, ceilingDb: -1 },
                    };
                    onChange({ ...config, deliveryProfile: profile, ...(presets[profile] ?? {}) });
                  }}
                  className={fieldClass}
                >
                  <option value="streaming">Streaming · -14 LUFS / -1 dBTP</option>
                  <option value="club">Club / EDM · -9 LUFS / -0.5 dBTP</option>
                  <option value="broadcast">Broadcast · -23 LUFS / -1 dBTP</option>
                  <option value="archive">Full Dynamic Archive · normalization off</option>
                  <option value="custom">Custom</option>
                </select>
              </label>
              <label className="flex items-center gap-2 text-xs text-[#D8C58C]">
                <input
                  type="checkbox"
                  checked={config.normalizeToTarget}
                  onChange={(e) => onChange({ ...config, deliveryProfile: 'custom', normalizeToTarget: e.target.checked })}
                  className="accent-[#D4AF37]"
                />
                Normalize to target integrated loudness
              </label>
              {config.normalizeToTarget && (
                <label className={labelClass}>Target Integrated Loudness (LUFS)
                  <input
                    type="number"
                    min={-36}
                    max={-5}
                    step={0.1}
                    value={config.targetLufs}
                    onChange={(e) => onChange({ ...config, deliveryProfile: 'custom', targetLufs: Number(e.target.value) })}
                    className={fieldClass}
                  />
                </label>
              )}
            </>}
            {config.format === 'mid' && <>
              <label className={labelClass}>Tempo (BPM)
                <input type="number" min={20} max={300} step={1} value={config.midiTempoBpm ?? 120}
                  onChange={(e) => onChange({ ...config, midiTempoBpm: Number(e.target.value) })} className={fieldClass} />
              </label>
              <label className="flex items-center gap-2 text-xs text-[#D8C58C] self-end pb-2">
                <input type="checkbox" checked={config.saveLoopMarkers ?? true} onChange={(e) => onChange({ ...config, saveLoopMarkers: e.target.checked })} className="accent-[#D4AF37]" />
                Save full-song loop markers
              </label>
            </>}
          </div>

          {config.format !== 'mid' && (
            <div className="rounded-lg border border-[#5A4519] bg-[#100D06] p-3 flex flex-col gap-3">
              <div className="text-[10px] font-black uppercase tracking-[.14em] text-[#F2CA52]">Render Options</div>
              <label className="flex items-center gap-2 text-xs text-[#E8D9AF]">
                <input type="checkbox" checked={config.includeMasteringChain !== false} onChange={(e) => onChange({ ...config, includeMasteringChain: e.target.checked })} className="accent-[#D4AF37]" />
                Apply the active mastering chain and enabled VST3 effects
              </label>
              <p className="text-[10px] text-[#A99A74]">The high-quality offline render path is used for the active SYN-DSP and loaded VST3 chain. Plugin-specific oversampling / HQ modes remain controlled by each plugin.</p>
            </div>
          )}

          <div className="rounded-lg border border-[#3D3015] bg-[#0B0905] p-3 text-[10px] leading-relaxed text-[#B6A780]">
            <p><strong className="text-[#F2CA52]">Full song:</strong> SYN MASTER renders the complete imported track and preserves its full source duration. It does not synthesize an effect tail beyond the source file.</p>
            {config.format !== 'mid' && (
              <p className="mt-1"><strong className="text-[#F2CA52]">Codec service:</strong> full-song audio rendering, 512-point sinc resampling and final PCM / codec encoding require FFmpeg installed on the SYN MASTER server.</p>
            )}
            {config.format === 'mid' && (
              <p className="mt-1"><strong className="text-[#F2CA52]">MIDI limitation:</strong> An audio master has no note events to export. This creates a tempo / marker conductor track only; it does not contain audio or invented MIDI notes.</p>
            )}
            <p className="mt-1">Playlist / note markers, synth polyphony and PDC-silence trimming are DAW / instrument features and are not applicable to this single-file audio mastering project.</p>
          </div>

          {renderProgress && (
            <div role="status" aria-live="polite" className="p-3 rounded-lg border border-[#5A4519] bg-[#100D06] text-[11px] text-[#F2CA52]">
              {renderProgress}
            </div>
          )}
          {renderError && (
            <div role="alert" className="p-3 rounded-lg border border-red-500/60 bg-red-500/10 text-[11px] leading-relaxed text-red-200">
              <strong className="block mb-1">Export could not be completed</strong>
              {renderError}
            </div>
          )}
          {downloadUrl && downloadFilename && (
            <div className="p-3 rounded-lg bg-[#D4AF37]/10 border border-[#D4AF37]/55 flex items-center justify-between gap-3">
              <span className="text-xs text-[#F2CA52] font-semibold truncate">Rendered: {downloadFilename}</span>
              <a href={downloadUrl} download={downloadFilename}
                className="px-3 py-1.5 rounded bg-[#D4AF37] text-[#080704] text-xs font-bold flex items-center gap-1.5 whitespace-nowrap shrink-0">
                <Download className="w-3.5 h-3.5" /> Download ZIP
              </a>
            </div>
          )}
          {downloadUrl && deliveryCheck && (
            <div className={'p-2.5 rounded-lg text-[11px] border ' + (deliveryCheck.warning ? 'border-red-500/60 bg-red-500/10 text-red-200' : 'border-[#5A4519] bg-[#100D06] text-[#E8D9AF]')}>
              {deliveryCheck.text}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2 border-t border-[#5A4519]">
            <button type="button" onClick={onClose} className="px-3.5 py-2 rounded bg-[#171208] border border-[#4A3917] text-xs font-semibold text-[#D8C58C] hover:border-[#D4AF37]">Cancel</button>
            <button type="button" disabled={!hasTrack || rendering} onClick={onRender}
              className="px-4 py-2 rounded bg-[#D4AF37] text-[#080704] text-xs font-extrabold hover:bg-[#F2CA52] disabled:opacity-50">
              {rendering ? 'Rendering / Packaging…' : 'Render ZIP Package'}
            </button>
          </div>
        </div>
      </div>
    </div>
    </Portal>
  );
};

interface SettingsModalProps {
  open: boolean;
  settings: AppSettings;
  onChange: (next: AppSettings) => void;
  onClose: () => void;
  /** Extra sections (e.g. the AI Provider panel). */
  children?: React.ReactNode;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  open,
  settings,
  onChange,
  onClose,
  children,
}) => {
  if (!open) return null;

  return (
    <Portal>
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Workstation Settings"
      className="syn-modal-backdrop syn-settings-backdrop fixed inset-0 bg-black/75 flex items-center justify-center p-4"
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
    >
      <div className="syn-modal syn-settings-modal w-full max-w-lg max-h-[92vh] overflow-y-auto rounded bg-[#111217] border border-[#D4AF37]/45 shadow-2xl">
        <div className="px-5 py-3.5 border-b border-[#242732] flex items-center justify-between bg-[#151720]">
          <h2 className="text-sm font-bold text-[#F2CA52] uppercase tracking-wider">
            Workstation Preferences
          </h2>
          <button
            type="button"
            aria-label="Close Settings Modal"
            onClick={onClose}
            className="p-1 text-[#9CA3AF] hover:text-[#F7F8FA]"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 flex flex-col gap-3.5 text-xs">
          <label className="flex flex-col gap-1 text-[#9CA3AF]">
            Interface Mode
            <select
              value={settings.experienceMode}
              onChange={(e) =>
                onChange({ ...settings, experienceMode: e.target.value as 'engineering' | 'guided' })
              }
              className="bg-[#090A0E] border border-[#2B2E3A] rounded px-2.5 py-1.5 text-[#F7F8FA]"
            >
              <option value="engineering">Engineering Mode (Full Technical)</option>
              <option value="guided">Guided Mode (Contextual DSP Explanations)</option>
            </select>
          </label>

          <label className="flex flex-col gap-1 text-[#9CA3AF]">
            Layout (Desktop / Mobile view)
            <select
              aria-label="Layout view"
              defaultValue={readViewMode()}
              onChange={(e) => changeViewMode(parseViewMode(e.target.value))}
              className="bg-[#090A0E] border border-[#2B2E3A] rounded px-2.5 py-1.5 text-[#F7F8FA] min-h-[40px]"
            >
              <option value="auto">Automatic (by screen size)</option>
              <option value="desktop">Desktop view</option>
              <option value="mobile">Mobile view</option>
            </select>
            <span className="text-[10px] text-[#6B7280]">Saved on this device. The page reloads to apply it; your session is kept by auto-save.</span>
          </label>

          <label className="flex items-center justify-between text-[#F7F8FA]">
            <span>Loudness-Match A/B Auditioning</span>
            <input
              type="checkbox"
              checked={settings.loudnessMatchAB}
              onChange={(e) => onChange({ ...settings, loudnessMatchAB: e.target.checked })}
              className="accent-[#D4AF37]"
            />
          </label>

          <label className="flex items-center justify-between text-[#F7F8FA]">
            <span>IndexedDB Auto-Save Session</span>
            <input
              type="checkbox"
              checked={settings.autoSaveEnabled}
              onChange={(e) => onChange({ ...settings, autoSaveEnabled: e.target.checked })}
              className="accent-[#D4AF37]"
            />
          </label>

          {children}

          <div className="p-3 rounded bg-[#0C0D12] border border-[#222530] text-[11px] text-[#9CA3AF]">
            <div className="font-semibold text-[#D4AF37] mb-1">Keyboard Shortcuts</div>
            <div>Space: Play / Pause · B: Bypass Chain · A: Toggle Original/Mastered</div>
          </div>

          <div className="flex justify-end pt-2 border-t border-[#222530]">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-1.5 rounded bg-[#D4AF37] text-[#070709] font-bold"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
    </Portal>
  );
};
