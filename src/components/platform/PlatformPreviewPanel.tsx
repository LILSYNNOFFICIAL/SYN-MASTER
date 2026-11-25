import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Headphones, Loader2, Square } from 'lucide-react';
import {
  CODEC_OPTIONS,
  PLATFORM_CODEC_NOTES,
  PLATFORM_RULE_NOTES,
  PLATFORM_PROFILES,
  buildCodecEncodeParams,
  codecMatchTrimDb,
  describePlatformGain,
  detectCodecClipping,
  encodeFloatWav,
  getCodecOption,
  getPlatformProfile,
  predictForPlatform,
  sliceSnippet,
  type CodecClippingReport,
  type CodecId,
  type MasterLevels,
  type PlatformId,
  type SpotifyLevel,
} from '../../dsp/platformPreview';
import { platformPreviewStore } from '../../engine/platformPreviewStore';
import { telemetryStore } from '../../engine/telemetryStore';
import type { SynAudioEngine } from '../../engine/audioEngine';
import { usePlatformPreviewSelection } from './usePlatformPreviewSelection';
import { SnippetPlayer } from './snippetPlayer';
import './platformPreview.css';

interface Props {
  /** Measurements of the master that plays (rendered master, or the source before a render). */
  levels: MasterLevels | null;
  /** Rendered master channels for the codec snippet (null until a render exists). */
  getMasterAudio: () => { channels: Float32Array[]; sampleRate: number } | null;
  engine: SynAudioEngine | null;
  /** Called before a snippet plays so the app can reflect that the main transport paused. */
  onPauseMain?: () => void;
}

interface CodecResult {
  codec: CodecId;
  startSec: number;
  lengthSec: number;
  decodedClipping: CodecClippingReport;
  sourceTruePeakDb: number;
  serverTruePeakDb: number | null;
  serverLufs: number | null;
  matchTrimDb: number;
}

const fmtDb = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(1)}`;
const SNIPPET_LENGTHS = [10, 20, 30];

export const PlatformPreviewPanel: React.FC<Props> = ({ levels, getMasterAudio, engine, onPauseMain }) => {
  const sel = usePlatformPreviewSelection();
  const profile = getPlatformProfile(sel.platformId);
  const selected = levels ? predictForPlatform(levels, sel.platformId, sel.spotifyLevel) : null;
  const rows = useMemo(() => {
    if (!levels) return [];
    const out: Array<{ key: string; id: PlatformId; level: SpotifyLevel; p: ReturnType<typeof predictForPlatform> }> = [];
    for (const pr of PLATFORM_PROFILES) {
      if (pr.id === 'off') continue;
      const levelsFor: SpotifyLevel[] = pr.id === 'spotify' ? ['normal', 'loud', 'quiet'] : ['normal'];
      for (const level of levelsFor) out.push({ key: pr.id + level, id: pr.id, level, p: predictForPlatform(levels, pr.id, level) });
    }
    return out;
  }, [levels]);

  const [codec, setCodec] = useState<CodecId>(profile.defaultCodec ?? 'aac-256');
  useEffect(() => { if (profile.defaultCodec) setCodec(profile.defaultCodec); }, [profile.defaultCodec]);
  const [lengthSec, setLengthSec] = useState(20);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CodecResult | null>(null);
  const [playing, setPlaying] = useState<'a' | 'b' | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const playerRef = useRef<SnippetPlayer | null>(null);

  useEffect(() => {
    if (!engine) return;
    const player = new SnippetPlayer(engine);
    player.onEnded = () => setPlaying(null);
    playerRef.current = player;
    // Main transport starting stops the snippet; reflect that in the A/B buttons.
    engine.onMainPlay = () => { player.stop(); setPlaying(null); };
    return () => {
      player.dispose();
      playerRef.current = null;
      abortRef.current?.abort();
    };
  }, [engine]);

  const encode = useCallback(async () => {
    const master = getMasterAudio();
    if (!engine || !master || master.channels.length === 0) {
      setError('Render or import a track first: the codec audition encodes the rendered master.');
      return;
    }
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy(true);
    setError(null);
    playerRef.current?.stop();
    setPlaying(null);
    try {
      const start = telemetryStore.getSnapshot().currentTimeSec;
      const snip = sliceSnippet(master.channels, master.sampleRate, start, lengthSec);
      const stereo = snip.channels.length === 1 ? [snip.channels[0], snip.channels[0]] : snip.channels.slice(0, 2);
      const params = new URLSearchParams(buildCodecEncodeParams(codec, master.sampleRate));
      const response = await fetch('/api/export/encode?' + params.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Blob([encodeFloatWav(stereo, master.sampleRate)], { type: 'audio/wav' }),
        signal: ac.signal,
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error || `Codec encode failed (HTTP ${response.status}).`);
      }
      const serverTp = response.headers.get('X-Syn-True-Peak-Dbtp');
      const serverLufs = response.headers.get('X-Syn-Integrated-Lufs');
      const blob = await response.blob();
      const opt = getCodecOption(codec);
      const ext = opt.format === 'webm-opus' ? 'webm' : opt.format;
      let decoded: { channels: Float32Array[]; sampleRate: number };
      try {
        decoded = await engine.decodeFile(new File([blob], 'snippet.' + ext, { type: blob.type }));
      } catch {
        throw new Error(`This browser cannot decode ${opt.label}. Try another codec (AAC plays everywhere).`);
      }
      if (ac.signal.aborted) return;
      const decodedClipping = detectCodecClipping(decoded.channels, selected?.gainDb ?? 0);
      const matchTrimDb = codecMatchTrimDb(stereo, decoded.channels, master.sampleRate, decoded.sampleRate);
      playerRef.current?.load(
        { channels: stereo, sampleRate: master.sampleRate, trimDb: 0 },
        { channels: decoded.channels, sampleRate: decoded.sampleRate, trimDb: matchTrimDb },
      );
      const sourceTp = levels?.truePeakDb ?? NaN;
      const parsedTp = serverTp === null ? null : Number(serverTp);
      const parsedLufs = serverLufs === null ? null : Number(serverLufs);
      setResult({
        codec,
        startSec: snip.startSec,
        lengthSec: stereo[0].length / master.sampleRate,
        decodedClipping,
        sourceTruePeakDb: sourceTp,
        serverTruePeakDb: parsedTp !== null && Number.isFinite(parsedTp) ? parsedTp : null,
        serverLufs: parsedLufs !== null && Number.isFinite(parsedLufs) ? parsedLufs : null,
        matchTrimDb,
      });
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Codec audition failed.');
    } finally {
      if (abortRef.current === ac) setBusy(false);
    }
  }, [codec, engine, getMasterAudio, lengthSec, levels, selected?.gainDb]);

  const play = (which: 'a' | 'b') => {
    onPauseMain?.();
    if (playerRef.current?.play(which)) setPlaying(which);
  };
  const stop = () => {
    playerRef.current?.stop();
    setPlaying(null);
  };

  // Recompute the after-gain verdict when the platform changes after an encode.
  // Same platform model as the master prediction (incl. Spotify Loud's limiter), fed the decoded peaks.
  const clippingNow = result && levels
    ? {
        ...result.decodedClipping,
        truePeakAfterGainDb: predictForPlatform(
          { integratedLufs: levels.integratedLufs, truePeakDb: result.decodedClipping.truePeakDb, samplePeakDb: result.decodedClipping.samplePeakDb },
          sel.platformId,
          sel.spotifyLevel,
        ).predictedTruePeakDb,
      }
    : null;
  const codecTp = result ? (result.serverTruePeakDb ?? result.decodedClipping.truePeakDb) : null;
  const codecClips = result ? (result.decodedClipping.clipping || (result.serverTruePeakDb !== null && result.serverTruePeakDb > 0)) : false;

  return (
    <section className="syn-card syn-pp-panel" aria-labelledby="syn-pp-title" data-testid="platform-preview-panel">
      <header className="syn-pp-head">
        <div>
          <h3 id="syn-pp-title" className="syn-card-title"><Headphones className="w-4 h-4" aria-hidden="true" /> Platform Preview</h3>
          <p className="syn-pp-sub">Hear and measure the master the way streaming platforms play it. Monitoring only: it never changes the render or the export.</p>
        </div>
        <div className="syn-pp-pickers">
          <label>
            <span>Platform</span>
            <select value={sel.platformId} onChange={(e) => platformPreviewStore.set({ platformId: e.target.value as PlatformId })}>
              {PLATFORM_PROFILES.map((pr) => <option key={pr.id} value={pr.id}>{pr.label}</option>)}
            </select>
          </label>
          {sel.platformId === 'spotify' && (
            <label>
              <span>Volume level</span>
              <select value={sel.spotifyLevel} onChange={(e) => platformPreviewStore.set({ spotifyLevel: e.target.value as SpotifyLevel })}>
                <option value="normal">Normal (−14 LUFS)</option>
                <option value="loud">Loud (−11 LUFS)</option>
                <option value="quiet">Quiet (−19 LUFS)</option>
              </select>
            </label>
          )}
        </div>
      </header>

      {!levels ? (
        <p className="syn-pp-empty">Import a track to predict platform playback.</p>
      ) : (
        <>
          {selected && (
            <div className={`syn-pp-verdict risk-${selected.risk}`} aria-live="polite">
              <p className="syn-pp-sentence">{describePlatformGain(selected)}</p>
              {sel.platformId !== 'off' && (
                <dl className="syn-pp-stats">
                  <div><dt>Playback gain</dt><dd>{fmtDb(selected.gainDb)} dB</dd></div>
                  <div><dt>Plays at</dt><dd>{selected.predictedLufs.toFixed(1)} LUFS</dd></div>
                  <div><dt>Predicted true peak</dt><dd>{selected.predictedTruePeakDb.toFixed(1)} dBTP</dd></div>
                  <div><dt>Limiter</dt><dd>{selected.limiterEngaged ? `−${selected.limiterReductionDb.toFixed(1)} dB peaks` : 'not engaged'}</dd></div>
                </dl>
              )}
              {selected.deliveryAdvice && <p className="syn-pp-advice"><AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" /> {selected.deliveryAdvice}</p>}
              {sel.platformId !== 'off' && <p className="syn-pp-note">{PLATFORM_RULE_NOTES[selected.label]}{selected.confidence === 'reported' ? ' (reported, not published by the platform)' : ''}</p>}
            </div>
          )}

          <div className="syn-pp-table" role="group" aria-label="Predicted playback per platform (choose one to hear it)">
            <div className="syn-pp-row syn-pp-row-head" aria-hidden="true">
              <span>Platform</span>
              <span>Gain</span>
              <span>True peak after</span>
              <span>Why</span>
            </div>
            {rows.map(({ key, id, level, p }) => (
              <button
                key={key}
                type="button"
                className={`syn-pp-row risk-${p.risk}${sel.platformId === id && (id !== 'spotify' || sel.spotifyLevel === level) ? ' is-selected' : ''}`}
                aria-pressed={sel.platformId === id && (id !== 'spotify' || sel.spotifyLevel === level)}
                onClick={() => platformPreviewStore.set(id === 'spotify' ? { platformId: id, spotifyLevel: level } : { platformId: id })}
                aria-label={`Hear as ${p.label}: ${fmtDb(p.gainDb)} dB, true peak ${p.predictedTruePeakDb.toFixed(1)} dBTP`}
              >
                <span className="syn-pp-name">{p.label}{p.confidence === 'reported' && <i title="Reported by independent measurement, not published by the platform"> *</i>}</span>
                <span>{fmtDb(p.gainDb)} dB</span>
                <span>{p.predictedTruePeakDb.toFixed(1)} dBTP</span>
                <span className="syn-pp-why">
                  {p.limiterEngaged ? 'limiter engages' : p.limitedBy === 'turn-down-only' ? 'never turned up' : p.limitedBy === 'peak-headroom' ? 'peak headroom caps gain' : p.direction === 'none' ? 'at reference' : 'normalised'}
                </span>
              </button>
            ))}
          </div>
          <p className="syn-pp-foot">* Reported by independent measurement; the platform does not publish the number. Track (shuffle) normalisation modelled; album mode can differ.</p>

          <div className="syn-pp-codec" aria-labelledby="syn-pp-codec-title">
            <h4 id="syn-pp-codec-title">Codec audition</h4>
            <p className="syn-pp-sub">{PLATFORM_CODEC_NOTES[sel.platformId]}</p>
            <div className="syn-pp-codec-controls">
              <label>
                <span>Codec</span>
                <select value={codec} onChange={(e) => setCodec(e.target.value as CodecId)}>
                  {CODEC_OPTIONS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                </select>
              </label>
              <label>
                <span>Snippet</span>
                <select value={lengthSec} onChange={(e) => setLengthSec(Number(e.target.value))}>
                  {SNIPPET_LENGTHS.map((s) => <option key={s} value={s}>{s} s from playhead</option>)}
                </select>
              </label>
              <button type="button" className="syn-player-btn syn-pp-encode" onClick={encode} disabled={busy || !engine}>
                {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : null}
                {busy ? 'Encoding…' : 'Encode snippet'}
              </button>
            </div>
            {error && <p className="syn-pp-error" role="alert">{error}</p>}
            {result && clippingNow && (
              <div className="syn-pp-codec-result" aria-live="polite">
                <p className={codecClips ? 'syn-pp-flag is-bad' : 'syn-pp-flag is-good'}>
                  {codecClips ? <AlertTriangle className="w-4 h-4" aria-hidden="true" /> : <CheckCircle2 className="w-4 h-4" aria-hidden="true" />}
                  {codecClips
                    ? `Codec clipping: ${getCodecOption(result.codec).label} decodes to ${codecTp!.toFixed(2)} dBTP (inter-sample peaks over 0 dBTP).`
                    : `No codec clipping: ${getCodecOption(result.codec).label} decodes to ${codecTp!.toFixed(2)} dBTP.`}
                </p>
                <dl className="syn-pp-stats">
                  <div><dt>Master true peak</dt><dd>{Number.isFinite(result.sourceTruePeakDb) ? result.sourceTruePeakDb.toFixed(2) : '—'} dBTP</dd></div>
                  <div><dt>Decoded (FFmpeg)</dt><dd>{result.serverTruePeakDb !== null ? `${result.serverTruePeakDb.toFixed(2)} dBTP` : '—'}</dd></div>
                  <div><dt>Decoded (browser)</dt><dd>{result.decodedClipping.truePeakDb.toFixed(2)} dBTP</dd></div>
                  <div><dt>After platform gain</dt><dd>{clippingNow.truePeakAfterGainDb.toFixed(2)} dBTP</dd></div>
                </dl>
                <p className="syn-pp-note">
                  Snippet {result.startSec.toFixed(1)}–{(result.startSec + result.lengthSec).toFixed(1)} s. B is loudness-matched to A ({fmtDb(result.matchTrimDb)} dB); both play through the {sel.platformId === 'off' ? 'unnormalised' : profile.label} playback gain.
                </p>
                <div className="syn-pp-ab" role="group" aria-label="Codec A/B">
                  <button type="button" className={`syn-player-btn${playing === 'a' ? ' is-on' : ''}`} aria-pressed={playing === 'a'} onClick={() => play('a')}>A · Master</button>
                  <button type="button" className={`syn-player-btn${playing === 'b' ? ' is-on' : ''}`} aria-pressed={playing === 'b'} onClick={() => play('b')}>B · {getCodecOption(result.codec).label}</button>
                  <button type="button" className="syn-player-btn syn-player-icon" onClick={stop} disabled={!playing} aria-label="Stop snippet"><Square className="w-3.5 h-3.5" /></button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
};

export default PlatformPreviewPanel;
