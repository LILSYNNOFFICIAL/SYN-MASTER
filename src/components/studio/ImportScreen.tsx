import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Upload, Music2, Sparkles, LayoutGrid, X } from 'lucide-react';
import { Portal } from '../../ui/Portal';

interface Props {
  onFile: (file: File) => void | Promise<void>;
  onDemo: () => void;
  onOpenWorkstation: () => void;
  busy?: boolean;
}

const ACCEPT = '.wav,.wave,.mp3,.flac,.aac,.m4a,.ogg,.oga,.aif,.aiff,.webm,audio/*';

/** First screen: "Import your track" with drag-and-drop. */
export const ImportScreen: React.FC<Props> = ({ onFile, onDemo, onOpenWorkstation, busy = false }) => {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [cloudHelpOpen, setCloudHelpOpen] = useState(false);

  useEffect(() => {
    if (!cloudHelpOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setCloudHelpOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [cloudHelpOpen]);

  const take = useCallback(
    async (file: File | undefined | null) => {
      if (!file) return;
      setLoading(true);
      try {
        await onFile(file);
      } finally {
        setLoading(false);
      }
    },
    [onFile],
  );

  return (
    <div className="syn2-import">
      <div className="syn2-import-glow" aria-hidden="true" />
      <header className="syn2-import-brand syn-splash-brand">
        <img
          src="brand/syn-master-logo.webp"
          alt="SYN-MASTER"
          width={768}
          height={768}
          decoding="async"
          className="syn-splash-logo"
        />
        <span className="syn-splash-sub">MASTERING SUITE</span>
      </header>

      <main className="syn2-import-main">
        <h1 className="syn2-import-title">Import your track</h1>
        <p className="syn2-import-sub">
          Drop a mix. SYN MASTER measures everything wrong with it, fixes it, re-measures the result and only calls it done when it passes.
        </p>

        <button
          type="button"
          className={`syn2-dropzone ${dragging ? 'is-dragging' : ''}`}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void take(e.dataTransfer.files?.[0]);
          }}
          disabled={busy || loading}
          aria-label="Import your track: drop an audio file here or click to browse"
        >
          <span className="syn2-dropzone-icon">{loading ? <Music2 className="w-9 h-9 animate-pulse" /> : <Upload className="w-9 h-9" />}</span>
          <span className="syn2-dropzone-main">{loading ? 'Decoding & analyzing…' : 'Drag & drop your audio here'}</span>
          <span className="syn2-dropzone-hint">or click to browse · WAV · FLAC · MP3 · AIFF · M4A · OGG</span>
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => {
            void take(e.target.files?.[0]);
            e.target.value = '';
          }}
        />

        <div className="syn2-import-actions">
          <button type="button" className="syn2-btn-ghost" onClick={onDemo} disabled={busy || loading}>
            <Sparkles className="w-4 h-4" /> Try the demo mix
          </button>
          <button type="button" className="syn2-btn-ghost" onClick={onOpenWorkstation}>
            <LayoutGrid className="w-4 h-4" /> Open full workstation
          </button>
        </div>

        <button
          type="button"
          className="mt-5 text-[11px] font-semibold tracking-wide text-[#3FE0FF] underline underline-offset-4 hover:text-white"
          onClick={() => setCloudHelpOpen(true)}
          aria-haspopup="dialog"
        >
          Cloud AI is included · How it works
        </button>

        <ul className="syn2-import-steps">
          <li><b>1</b> Import</li>
          <li><b>2</b> Fix it all with AI</li>
          <li><b>3</b> Verified master → export</li>
        </ul>
      </main>
      {cloudHelpOpen && (
        <Portal>
          <div
            className="syn-modal-backdrop fixed inset-0 flex items-center justify-center p-4"
            role="presentation"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setCloudHelpOpen(false);
            }}
          >
            <section
              className="syn-modal w-full max-w-lg max-h-[90vh] overflow-y-auto"
              role="dialog"
              aria-modal="true"
              aria-labelledby="syn-cloud-ai-first-use-title"
            >
              <header className="flex items-center justify-between gap-4 border-b border-[#29435E] px-5 py-4">
                <div>
                  <h2 id="syn-cloud-ai-first-use-title" className="text-base font-black tracking-wide text-[#EAF6FF]">Cloud AI is included</h2>
                  <p className="mt-1 text-[11px] text-[#9BB4CC]">No personal API key or account setup required</p>
                </div>
                <button type="button" aria-label="Close Cloud AI help" onClick={() => setCloudHelpOpen(false)} className="rounded-lg border border-[#35516E] p-2 text-[#BBD8F2] hover:bg-[#16304B]">
                  <X className="h-4 w-4" />
                </button>
              </header>
              <div className="flex flex-col gap-3 p-5 text-sm leading-relaxed text-[#C8D9E8]">
                <p><strong className="text-white">Built-in Cloud AI is provided by SYN-MASTER.</strong> You do not need a Google AI Studio account, personal Gemini API key, GitHub account, or operator token. The app creates an anonymous guest session automatically.</p>
                <p>Cloud AI helps analyze the track and plan/refine processor settings. SYN-DSP still performs the audio rendering locally. If Cloud AI is unavailable or a fair-use limit is reached, local mastering continues.</p>
                <p>Short-term and daily usage limits protect service availability. The app explains when to retry, and your local mastering work is not blocked.</p>
                <a href="https://github.com/LILSYNNOFFICIAL/SYN-MASTER#cloud-ai" target="_blank" rel="noreferrer" className="font-semibold text-[#3FE0FF] underline underline-offset-4">Cloud AI help and usage limits</a>
                <button type="button" onClick={() => setCloudHelpOpen(false)} className="mt-2 self-end rounded-lg border border-[#3FE0FF]/50 bg-[#0B2940] px-5 py-2 text-xs font-bold tracking-wide text-[#EAF6FF] hover:bg-[#123B5C]">Got it</button>
              </div>
            </section>
          </div>
        </Portal>
      )}
    </div>
  );
};
