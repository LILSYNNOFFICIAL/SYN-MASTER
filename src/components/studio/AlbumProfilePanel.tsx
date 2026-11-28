import React, { useRef, useState } from 'react';
import { CheckCircle2, Loader2, Upload, XCircle } from 'lucide-react';
import type { AudioAnalysis } from '../../types/mastering';
import { renderAndAnalyzeOffThread } from '../../dsp/workerClient';
import { buildAlbumMasteringProfile, type AlbumMasteringProfile } from '../../director/albumProfile';

interface Props {
  profile: AlbumMasteringProfile | null;
  active: boolean;
  onChange: (profile: AlbumMasteringProfile | null) => void;
  onActivate: (active: boolean) => void;
}

const supportedAudio = 'audio/*,.wav,.flac,.mp3,.aac,.m4a,.ogg,.aiff';

export const AlbumProfilePanel: React.FC<Props> = ({ profile, active, onChange, onActivate }) => {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [trackRows, setTrackRows] = useState<Array<{ name: string; analysis: AudioAnalysis }>>([]);

  const loadFiles = async (files: File[]) => {
    if (files.length < 2) { setError('Choose at least two album tracks.'); return; }
    if (files.length > 12) { setError('Album profile supports up to 12 tracks per analysis.'); return; }
    setBusy(true); setError(''); setProgress('');
    const context = new AudioContext();
    const rows: Array<{ name: string; analysis: AudioAnalysis }> = [];
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        setProgress(`Analyzing ${i + 1} of ${files.length}: ${file.name}`);
        const buffer = await context.decodeAudioData(await file.arrayBuffer());
        const left = buffer.getChannelData(0).slice();
        const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1).slice() : left.slice();
        const result = await renderAndAnalyzeOffThread({
          sourceChannels: [left, right],
          sampleRate: buffer.sampleRate,
          chain: [],
          transferSource: true,
        });
        rows.push({ name: file.name, analysis: result.analysis });
      }
      const next = buildAlbumMasteringProfile(rows);
      if (!next) throw new Error('The tracks did not produce compatible, reliable analysis grids.');
      setTrackRows(rows);
      onChange(next);
      setProgress(`Profile ready from ${next.trackCount} tracks.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Album analysis failed.');
    } finally {
      await context.close().catch(() => undefined);
      setBusy(false);
    }
  };

  return (
    <section className="p-4 rounded bg-[#111217] border border-[#D4AF37]/30 flex flex-col gap-3" data-testid="album-profile-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-[#F7F8FA]">Album Consistency Profile</h3>
          <p className="mt-1 text-xs text-[#9CA3AF] max-w-3xl">
            Analyze 2–12 tracks locally. The profile uses median loudness, dynamics, stereo and per-band tone as a shared reference; FIX ALL still makes track-specific decisions.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={() => inputRef.current?.click()}
            className="px-3 py-1.5 rounded bg-[#181A22] border border-[#2E3240] text-xs font-semibold text-[#F7F8FA] hover:border-[#D4AF37] disabled:opacity-50">
            <Upload className="inline w-3.5 h-3.5 mr-1.5" />{profile ? 'Replace album tracks' : 'Analyze album tracks'}
          </button>
          {profile && <button type="button" onClick={() => onActivate(!active)}
            className={`px-3 py-1.5 rounded text-xs font-bold border ${active ? 'bg-[#D4AF37] text-[#070709] border-[#F2CA52]' : 'bg-[#181A22] text-[#F2CA52] border-[#D4AF37]/50'}`}>
            {active ? 'Using album profile in AI / FIX ALL' : 'Use album profile in AI / FIX ALL'}
          </button>}
          {profile && <button type="button" aria-label="Clear album profile" onClick={() => { onChange(null); onActivate(false); setTrackRows([]); setProgress(''); }}>
            <XCircle className="w-4 h-4 text-[#9CA3AF]" />
          </button>}
        </div>
        <input ref={inputRef} type="file" multiple accept={supportedAudio} className="hidden"
          onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void loadFiles(files); }} />
      </div>
      {busy && <div className="flex items-center gap-2 text-xs text-[#F2CA52]" role="status"><Loader2 className="w-4 h-4 animate-spin" />{progress}</div>}
      {!busy && progress && <div className="text-xs text-[#34D399]" role="status"><CheckCircle2 className="inline w-4 h-4 mr-1" />{progress}</div>}
      {error && <p className="text-xs text-[#F87171]" role="alert">{error}</p>}
      {profile && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {[
              ['Tracks', String(profile.trackCount)],
              ['Median LUFS', profile.analysis.integratedLufs.toFixed(1)],
              ['Median Dynamics', `${profile.analysis.dynamicRangeDb.toFixed(1)} dB`],
              ['Median Width', `${(profile.analysis.stereoWidth * 100).toFixed(0)}%`],
            ].map(([label, value]) => <div key={label} className="p-2 rounded bg-[#10131B] border border-[#242732]">
              <div className="text-[10px] uppercase text-[#9CA3AF]">{label}</div><div className="text-sm font-mono-tabular font-bold text-[#F2CA52]">{value}</div>
            </div>)}
          </div>
          <div className="text-[11px] text-[#9CA3AF]">
            Track spans: {profile.integratedLufsRange[0].toFixed(1)}–{profile.integratedLufsRange[1].toFixed(1)} LUFS · {profile.dynamicRangeRangeDb[0].toFixed(1)}–{profile.dynamicRangeRangeDb[1].toFixed(1)} dB dynamics.
          </div>
          <ul className="grid sm:grid-cols-2 gap-1 text-[11px] text-[#C5CDD8]">
            {(trackRows.length ? trackRows : profile.tracks).map((track) => <li key={track.name} className="truncate">{track.name} · {track.analysis.integratedLufs.toFixed(1)} LUFS · {track.analysis.dynamicRangeDb.toFixed(1)} dB DR</li>)}
          </ul>
          <p className="text-[11px] text-[#9CA3AF]">Album references are measurement profiles; no audio is uploaded, and no single track’s master settings are copied to the others.</p>
        </>
      )}
    </section>
  );
};
