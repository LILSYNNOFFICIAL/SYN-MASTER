import React, { useRef, useState } from 'react';
import {
  AudioLines,
  FolderOpen,
  Layers,
  PlusCircle,
  Sliders,
  Trash2,
  Upload,
} from 'lucide-react';
import type {
  AudioTrackAsset,
  MasteringPreset,
  ProjectRecord,
  SavedChainRecord,
} from '../types/mastering';

interface Props {
  activeTrack: AudioTrackAsset | null;
  referenceTrack: AudioTrackAsset | null;
  presets: MasteringPreset[];
  savedChains: SavedChainRecord[];
  projects: ProjectRecord[];
  activeProjectId: string;
  onUploadSourceFile: (file: File) => void;
  onUploadReferenceFile: (file: File) => void;
  onLoadDemoSource: (variant: 'main-mix' | 'sine-sweep') => void;
  onLoadDemoReference: () => void;
  onApplyPreset: (preset: MasteringPreset) => void;
  onApplySavedChain: (chain: SavedChainRecord) => void;
  onDeleteSavedChain: (id: string) => void;
  onOpenProject: (project: ProjectRecord) => void;
  onDeleteProject: (id: string) => void;
}

type LibraryTab = 'audio' | 'presets' | 'chains' | 'projects';

export const LeftLibraryPanel: React.FC<Props> = React.memo(({
  activeTrack,
  referenceTrack,
  presets,
  savedChains,
  projects,
  activeProjectId,
  onUploadSourceFile,
  onUploadReferenceFile,
  onLoadDemoSource,
  onLoadDemoReference,
  onApplyPreset,
  onApplySavedChain,
  onDeleteSavedChain,
  onOpenProject,
  onDeleteProject,
}) => {
  const [tab, setTab] = useState<LibraryTab>('audio');
  const [dragOver, setDragOver] = useState(false);
  const srcInputRef = useRef<HTMLInputElement | null>(null);
  const refInputRef = useRef<HTMLInputElement | null>(null);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) onUploadSourceFile(file);
  };

  return (
    <aside
      aria-label="Audio Library and Presets"
      data-syn-skin="instrument"
      data-workspace="library"
      className="syn-library-shell w-full lg:w-[272px] shrink-0 bg-[#0D0E13] border-b lg:border-b-0 lg:border-r border-[#222530] flex flex-col lg:h-full overflow-visible lg:overflow-hidden"
    >
      {/* Library Tabs */}
      <div className="grid grid-cols-4 border-b border-[#222530] bg-[#111217]">
        {(
          [
            { id: 'audio', label: 'Audio', Icon: AudioLines },
            { id: 'presets', label: 'Presets', Icon: Sliders },
            { id: 'chains', label: 'Chains', Icon: Layers },
            { id: 'projects', label: 'Projects', Icon: FolderOpen },
          ] as const
        ).map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            aria-pressed={tab === id}
            data-active={tab === id ? 'true' : 'false'}
            className={`syn-library-tab py-2.5 px-1 flex flex-col items-center gap-1 text-[10px] font-semibold border-b-2 transition-colors ${
              tab === id
                ? 'border-[#D4AF37] text-[#F2CA52] bg-[#161820]'
                : 'border-transparent text-[#9CA3AF] hover:text-[#F7F8FA]'
            }`}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-3">
        {tab === 'audio' && (
          <>
            {/* Drag and drop zone */}
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              className={`p-3.5 rounded border border-dashed transition-colors text-center flex flex-col items-center gap-2 ${
                dragOver
                  ? 'border-[#F2CA52] bg-[#D4AF37]/10'
                  : 'border-[#2D313E] bg-[#12141B]'
              }`}
            >
              <Upload className="w-4 h-4 text-[#D4AF37]" />
              <div className="text-xs font-medium text-[#F7F8FA]">
                Import Master Source
              </div>
              <p className="text-[11px] text-[#9CA3AF]">
                WAV, FLAC, MP3, AAC, M4A, OGG, AIFF
              </p>
              <input
                ref={srcInputRef}
                type="file"
                accept="audio/*,.wav,.flac,.mp3,.aac,.m4a,.ogg,.aiff"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) onUploadSourceFile(file);
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                onClick={() => srcInputRef.current?.click()}
                className="w-full py-1.5 px-3 rounded bg-[#D4AF37] text-[#070709] text-xs font-semibold hover:bg-[#F2CA52]"
              >
                Browse Audio File
              </button>
            </div>

            {/* Instant Demo Stems */}
            <div className="p-3 rounded bg-[#12141B] border border-[#222530] flex flex-col gap-2">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-[#D4AF37]">
                Studio Test Stems
              </div>
              <button
                type="button"
                onClick={() => onLoadDemoSource('main-mix')}
                className="w-full py-1.5 px-2.5 rounded bg-[#181A22] border border-[#2E3240] text-left text-xs text-[#F7F8FA] hover:border-[#D4AF37] flex items-center justify-between"
              >
                <span>Load Demo Mix (118 BPM)</span>
                <PlusCircle className="w-3.5 h-3.5 text-[#D4AF37] shrink-0" />
              </button>
              <button
                type="button"
                onClick={() => onLoadDemoSource('sine-sweep')}
                className="w-full py-1.5 px-2.5 rounded bg-[#181A22] border border-[#2E3240] text-left text-xs text-[#F7F8FA] hover:border-[#D4AF37] flex items-center justify-between"
              >
                <span>Load Log Sweep (30Hz–16kHz)</span>
                <PlusCircle className="w-3.5 h-3.5 text-[#9CA3AF] shrink-0" />
              </button>
            </div>

            {/* Active Source Metadata */}
            {activeTrack && (
              <div className="p-3 rounded bg-[#12141B] border border-[#D4AF37]/30 flex flex-col gap-1.5">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-[#F2CA52]">
                  Active Source File
                </div>
                <div className="text-xs font-semibold text-[#F7F8FA] truncate" title={activeTrack.name}>
                  {activeTrack.name}
                </div>
                <div className="text-[11px] font-mono-tabular text-[#9CA3AF] flex flex-wrap gap-x-2 gap-y-0.5">
                  <span>{activeTrack.format}</span>
                  <span>·</span>
                  <span>{(activeTrack.sampleRate / 1000).toFixed(1)} kHz</span>
                  <span>·</span>
                  <span>{activeTrack.channels === 1 ? 'Mono' : 'Stereo'}</span>
                  <span>·</span>
                  <span>{activeTrack.durationSec.toFixed(1)}s</span>
                </div>
                <div className="pt-1.5 mt-1 border-t border-[#222530] grid grid-cols-2 gap-1.5 text-[11px] font-mono-tabular">
                  <div>
                    <span className="text-[#9CA3AF]">Pre LUFS: </span>
                    <span className="text-[#F7F8FA]">{activeTrack.analysis.integratedLufs.toFixed(1)}</span>
                  </div>
                  <div>
                    <span className="text-[#9CA3AF]">Peak: </span>
                    <span className="text-[#F7F8FA]">{activeTrack.analysis.samplePeakDb.toFixed(1)} dB</span>
                  </div>
                </div>
              </div>
            )}

            {/* Reference Track Slot */}
            <div className="p-3 rounded bg-[#12141B] border border-[#222530] flex flex-col gap-2">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-[#D4AF37]">
                Reference Track
              </div>
              <input
                ref={refInputRef}
                type="file"
                accept="audio/*,.wav,.flac,.mp3,.aac,.m4a,.ogg,.aiff"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) onUploadReferenceFile(file);
                  e.target.value = '';
                }}
              />
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() => refInputRef.current?.click()}
                  className="flex-1 py-1.5 px-2 rounded bg-[#181A22] border border-[#2E3240] text-[11px] font-medium text-[#F7F8FA] hover:border-[#D4AF37]"
                >
                  Upload Ref
                </button>
                <button
                  type="button"
                  onClick={onLoadDemoReference}
                  className="flex-1 py-1.5 px-2 rounded bg-[#181A22] border border-[#2E3240] text-[11px] font-medium text-[#F2CA52] hover:border-[#D4AF37]"
                >
                  Demo Ref
                </button>
              </div>
              {referenceTrack && (
                <div className="text-[11px] text-[#34D399] truncate font-mono-tabular">
                  Loaded: {referenceTrack.name} ({referenceTrack.analysis.integratedLufs.toFixed(1)} LUFS)
                </div>
              )}
            </div>
          </>
        )}

        {tab === 'presets' && (
          <div className="flex flex-col gap-2">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-[#D4AF37]">
              Starting Mastering Presets
            </div>
            {presets.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => onApplyPreset(p)}
                className="p-2.5 rounded bg-[#12141B] border border-[#242732] hover:border-[#D4AF37] text-left flex flex-col gap-1 transition-colors"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-[#F7F8FA]">{p.name}</span>
                  <span className="text-[10px] font-mono-tabular text-[#D4AF37]">
                    {p.targetLufs} LUFS
                  </span>
                </div>
                <span className="text-[11px] text-[#9CA3AF] leading-snug">{p.description}</span>
              </button>
            ))}
          </div>
        )}

        {tab === 'chains' && (
          <div className="flex flex-col gap-2">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-[#D4AF37]">
              Saved Mastering Chains
            </div>
            {savedChains.length === 0 ? (
              <p className="text-xs text-[#9CA3AF] p-3 rounded bg-[#12141B] border border-[#222530]">
                No custom chains saved yet. Click the Save icon in the Mastering Chain Rack to store a chain.
              </p>
            ) : (
              savedChains.map((c) => (
                <div
                  key={c.id}
                  className="p-2.5 rounded bg-[#12141B] border border-[#242732] flex items-center justify-between gap-2"
                >
                  <button
                    type="button"
                    onClick={() => onApplySavedChain(c)}
                    className="text-left flex-1 min-w-0"
                  >
                    <div className="text-xs font-semibold text-[#F7F8FA] truncate">{c.name}</div>
                    <div className="text-[10px] font-mono-tabular text-[#9CA3AF]">
                      {c.chain.length} stages · {new Date(c.createdAt).toLocaleDateString()}
                    </div>
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete chain ${c.name}`}
                    onClick={() => onDeleteSavedChain(c.id)}
                    className="p-1 text-[#9CA3AF] hover:text-[#EF4444]"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>
        )}

        {tab === 'projects' && (
          <div className="flex flex-col gap-2">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-[#D4AF37]">
              Local IndexedDB Projects
            </div>
            {projects.length === 0 ? (
              <p className="text-xs text-[#9CA3AF] p-3 rounded bg-[#12141B] border border-[#222530]">
                Save your current session from the top workstation bar to store it locally in IndexedDB.
              </p>
            ) : (
              projects.map((proj) => (
                <div
                  key={proj.id}
                  className={`p-2.5 rounded border flex items-center justify-between gap-2 ${
                    proj.id === activeProjectId
                      ? 'bg-[#181A22] border-[#D4AF37]'
                      : 'bg-[#12141B] border-[#242732]'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onOpenProject(proj)}
                    className="text-left flex-1 min-w-0"
                  >
                    <div className="text-xs font-semibold text-[#F7F8FA] truncate">{proj.name}</div>
                    <div className="text-[10px] font-mono-tabular text-[#9CA3AF]">
                      {proj.chain.length} DSP · {new Date(proj.updatedAt).toLocaleTimeString()}
                    </div>
                  </button>
                  {projects.length > 1 && (
                    <button
                      type="button"
                      aria-label={`Delete project ${proj.name}`}
                      onClick={() => onDeleteProject(proj.id)}
                      className="p-1 text-[#9CA3AF] hover:text-[#EF4444]"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </aside>
  );
});
