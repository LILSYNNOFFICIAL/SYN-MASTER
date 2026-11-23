import React, { useCallback, useRef, useState } from 'react';
import { Upload, Music2, Sparkles, LayoutGrid } from 'lucide-react';

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
      <header className="syn2-import-brand">
        <img
          src="/assets/aistudio/SYN_MASTER_Neon_Chrome_Logo_533a2f19.png"
          alt=""
          referrerPolicy="no-referrer"
          className="h-9 w-auto object-contain mix-blend-screen"
        />
        <span>
          SYN <b>MASTER</b>
        </span>
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

        <ul className="syn2-import-steps">
          <li><b>1</b> Import</li>
          <li><b>2</b> Fix it all with AI</li>
          <li><b>3</b> Verified master → export</li>
        </ul>
      </main>
    </div>
  );
};
