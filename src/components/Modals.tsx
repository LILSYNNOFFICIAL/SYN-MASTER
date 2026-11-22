import React from 'react';
import { Download, X } from 'lucide-react';
import type { AppSettings, ExportConfig } from '../types/mastering';

interface ExportModalProps {
  open: boolean;
  config: ExportConfig;
  rendering: boolean;
  downloadUrl: string | null;
  downloadFilename: string | null;
  hasTrack: boolean;
  onChange: (next: ExportConfig) => void;
  onRender: () => void;
  onClose: () => void;
}

export const ExportModal: React.FC<ExportModalProps> = ({
  open,
  config,
  rendering,
  downloadUrl,
  downloadFilename,
  hasTrack,
  onChange,
  onRender,
  onClose,
}) => {
  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Export Master Audio"
      className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4"
    >
      <div className="w-full max-w-lg rounded bg-[#111217] border border-[#D4AF37]/45 shadow-2xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-[#242732] flex items-center justify-between bg-[#151720]">
          <h2 className="text-sm font-bold text-[#F2CA52] uppercase tracking-wider">
            SYN-RENDER · Offline Master Export
          </h2>
          <button
            type="button"
            aria-label="Close Export Modal"
            onClick={onClose}
            className="p-1 text-[#9CA3AF] hover:text-[#F7F8FA]"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 flex flex-col gap-3.5">
          <div className="grid grid-cols-2 gap-3">
            <label className="col-span-2 flex flex-col gap-1 text-xs text-[#9CA3AF]">
              Output Filename
              <input
                type="text"
                value={config.filename}
                onChange={(e) => onChange({ ...config, filename: e.target.value })}
                className="bg-[#090A0E] border border-[#2B2E3A] rounded px-3 py-1.5 text-xs text-[#F7F8FA]"
              />
            </label>

            <label className="flex flex-col gap-1 text-xs text-[#9CA3AF]">
              Bit Depth (PCM / Float)
              <select
                value={config.wavBitDepth}
                onChange={(e) =>
                  onChange({ ...config, wavBitDepth: Number(e.target.value) as 16 | 24 | 32 })
                }
                className="bg-[#090A0E] border border-[#2B2E3A] rounded px-2.5 py-1.5 text-xs text-[#F7F8FA]"
              >
                <option value={16}>16-bit PCM (CD / Streaming)</option>
                <option value={24}>24-bit PCM (Studio Master)</option>
                <option value={32}>32-bit IEEE Float (Archive)</option>
              </select>
            </label>

            <label className="flex flex-col gap-1 text-xs text-[#9CA3AF]">
              Sample Rate
              <select
                value={config.sampleRate}
                onChange={(e) =>
                  onChange({
                    ...config,
                    sampleRate: Number(e.target.value) as 44100 | 48000 | 88200 | 96000,
                  })
                }
                className="bg-[#090A0E] border border-[#2B2E3A] rounded px-2.5 py-1.5 text-xs text-[#F7F8FA]"
              >
                <option value={44100}>44.1 kHz</option>
                <option value={48000}>48.0 kHz</option>
                <option value={88200}>88.2 kHz</option>
                <option value={96000}>96.0 kHz</option>
              </select>
            </label>

            <label className="flex flex-col gap-1 text-xs text-[#9CA3AF]">
              Channels
              <select
                value={config.channels}
                onChange={(e) =>
                  onChange({ ...config, channels: e.target.value as 'stereo' | 'mono' })
                }
                className="bg-[#090A0E] border border-[#2B2E3A] rounded px-2.5 py-1.5 text-xs text-[#F7F8FA]"
              >
                <option value="stereo">Stereo</option>
                <option value="mono">Mono Fold-Down</option>
              </select>
            </label>

            <label className="flex flex-col gap-1 text-xs text-[#9CA3AF]">
              Dithering (16/24-bit)
              <select
                value={config.dither}
                onChange={(e) =>
                  onChange({ ...config, dither: e.target.value as 'none' | 'tpdf' })
                }
                className="bg-[#090A0E] border border-[#2B2E3A] rounded px-2.5 py-1.5 text-xs text-[#F7F8FA]"
              >
                <option value="tpdf">TPDF Triangular Dither</option>
                <option value="none">None (Truncate)</option>
              </select>
            </label>

            <label className="flex flex-col gap-1 text-xs text-[#9CA3AF]">
              True Peak Ceiling (dBTP)
              <input
                type="number"
                step={0.1}
                min={-3.0}
                max={-0.1}
                value={config.ceilingDb}
                onChange={(e) => onChange({ ...config, ceilingDb: Number(e.target.value) })}
                className="bg-[#090A0E] border border-[#2B2E3A] rounded px-2.5 py-1.5 text-xs font-mono-tabular text-[#F7F8FA]"
              />
            </label>

            <label className="flex flex-col gap-1 text-xs text-[#9CA3AF]">
              Delivery Profile
              <select
                value={config.deliveryProfile}
                onChange={(e) => onChange({ ...config, deliveryProfile: e.target.value })}
                className="bg-[#090A0E] border border-[#2B2E3A] rounded px-2.5 py-1.5 text-xs text-[#F7F8FA]"
              >
                <option value="streaming">Streaming (-14 LUFS / -1.0 dBTP)</option>
                <option value="club">Club / EDM (-9 LUFS / -0.5 dBTP)</option>
                <option value="broadcast">Broadcast EBU R128 (-23 LUFS)</option>
                <option value="archive">Full Dynamic Archive</option>
              </select>
            </label>
          </div>

          <p className="text-[11px] text-[#9CA3AF]">
            Offline render executes the exact SYN-DSP sample-by-sample chain (EQ, Dynamics, Saturation, Stereo M/S, Limiter/Maximizer) before encoding RIFF WAVE output.
          </p>

          {downloadUrl && downloadFilename && (
            <div className="p-3 rounded bg-[#34D399]/10 border border-[#34D399]/40 flex items-center justify-between gap-3">
              <span className="text-xs text-[#34D399] font-medium truncate">
                Rendered: {downloadFilename}
              </span>
              <a
                href={downloadUrl}
                download={downloadFilename}
                className="px-3 py-1.5 rounded bg-[#34D399] text-[#070709] text-xs font-bold flex items-center gap-1.5 whitespace-nowrap shrink-0"
              >
                <Download className="w-3.5 h-3.5" />
                Download WAV
              </a>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2 border-t border-[#222530]">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-2 rounded bg-[#181A22] border border-[#2B2E3A] text-xs font-semibold text-[#C5CDD8]"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!hasTrack || rendering}
              onClick={onRender}
              className="px-4 py-2 rounded bg-[#D4AF37] text-[#070709] text-xs font-bold hover:bg-[#F2CA52] disabled:opacity-50"
            >
              {rendering ? 'Rendering Offline DSP...' : 'Render Master WAV'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

interface SettingsModalProps {
  open: boolean;
  settings: AppSettings;
  onChange: (next: AppSettings) => void;
  onClose: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  open,
  settings,
  onChange,
  onClose,
}) => {
  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Workstation Settings"
      className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4"
    >
      <div className="w-full max-w-md rounded bg-[#111217] border border-[#D4AF37]/45 shadow-2xl overflow-hidden">
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
  );
};
