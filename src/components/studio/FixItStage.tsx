import React, { useEffect, useState } from 'react';
import { Sparkles, SlidersHorizontal, RotateCcw, ChevronDown, ChevronUp, Wand2 } from 'lucide-react';
import type { AudioAnalysis, MasterFinalReport } from '../../types/mastering';
import type { FadeSettings } from '../../dsp/fades';
import { LOUDNESS_TARGET_PRESETS } from '../../dsp/loudnessTargets';
import type { DiagnosticLog } from '../../director/diagnosticLog';
import { DiagnosticLogPanel } from './DiagnosticLogPanel';

interface Props {
  trackName: string;
  durationSec: number;
  sampleRate: number;
  source: AudioAnalysis;
  master: AudioAnalysis | null;
  prePeaks: number[];
  postPeaks: number[] | null;
  isPlaying: boolean;
  onTogglePlay: () => void;
  auditionTarget: string;
  onAudition: (t: 'original' | 'mastered') => void;
  fades: FadeSettings;
  onFadesChange: React.Dispatch<React.SetStateAction<FadeSettings>>;
  onSeek: (sec: number) => void;
  running: boolean;
  stage: string;
  pass: number;
  maxPasses: number;
  lastActivity: string | null;
  report: MasterFinalReport | null;
  log: DiagnosticLog;
  targetPresetId: string | null;
  targetLabel: string;
  onTargetPreset: (id: string) => void;
  onFix: () => void;
  onOpenRack: () => void;
  onNewTrack: () => void;
  /** The console renders the FIX ALL AI centerpiece; the stage then only shows run state and details. */
  hideCenterpiece?: boolean;
}

const Stat: React.FC<{ label: string; src: string; out?: string | null; good?: boolean | null }> = ({ label, src, out, good }) => (
  <div className="syn2-stat">
    <div className="syn2-stat-label">{label}</div>
    <div className="syn2-stat-val">
      <span className="syn2-stat-src">{src}</span>
      {out != null && (
        <>
          <span className="syn2-stat-arrow">→</span>
          <span className={`syn2-stat-out ${good === true ? 'is-good' : good === false ? 'is-bad' : ''}`}>{out}</span>
        </>
      )}
    </div>
  </div>
);

/** One-button mastering stage: waveform + grid, big FIX IT ALL WITH AI, technical details on demand. */
export const FixItStage: React.FC<Props> = (p) => {
  const [showDetails, setShowDetails] = useState(false);
  const pressed = p.running || p.report !== null;
  useEffect(() => {
    if (p.running) setShowDetails(true);
  }, [p.running]);

  const gate = p.report?.targetGate ?? null;
  const check = (id: string) => gate?.checks.find((c) => c.id === id);
  const m = p.master;
  const s = p.source;
  const pct = p.running ? Math.min(100, Math.round((Math.max(0, p.pass) / Math.max(1, p.maxPasses)) * 100)) : p.report ? 100 : 0;

  return (
    <section className="syn2-stage" aria-label="Fix it all with AI">
      <div className="syn2-stage-head">
        <div className="min-w-0">
          <div className="syn2-eyebrow">Now mastering</div>
          <div className="syn2-track">{p.trackName}</div>
          <div className="syn2-track-meta">
            {(p.sampleRate / 1000).toFixed(1)} kHz · {Math.floor(p.durationSec / 60)}:{String(Math.round(p.durationSec % 60)).padStart(2, '0')} · Target {p.targetLabel}
          </div>
        </div>
        <div className="syn2-stage-tools">
          <label className="syn2-select">
            <span>Target</span>
            <select value={p.targetPresetId ?? ''} onChange={(e) => p.onTargetPreset(e.target.value)} disabled={p.running} aria-label="Loudness target">
              {p.targetPresetId === null && <option value="">{p.targetLabel}</option>}
              {LOUDNESS_TARGET_PRESETS.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label} ({t.targetLufs} LUFS / {t.maxTruePeakDb} dBTP)
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="syn2-btn-ghost" onClick={p.onOpenRack}>
            <SlidersHorizontal className="w-4 h-4" /> FX Rack
          </button>
          <button type="button" className="syn2-btn-ghost" onClick={p.onNewTrack} disabled={p.running}>
            New track
          </button>
        </div>
      </div>

      {!pressed && !p.hideCenterpiece && (
        <div className="syn2-fix-centerpiece">
          <button type="button" className="syn2-fix-btn" onClick={p.onFix}>
            <Sparkles className="w-6 h-6" />
            <span className="syn2-fix-label"><span>FIX ALL</span><small>AI</small></span>
          </button>
          <div className="syn2-fix-hint">ANALYZE · BALANCE · ENHANCE</div>
        </div>
      )}

      {p.running && (
        <div className="syn2-run-panel" role="status" aria-live="polite">
          <div className="syn2-run-stage">{p.stage || 'Working'} · pass {p.pass}/{p.maxPasses}</div>
          <div className="syn2-progress"><span style={{ width: `${Math.max(6, pct)}%` }} /></div>
          {p.lastActivity && <div className="syn2-run-msg">{p.lastActivity}</div>}
        </div>
      )}

      <div className="syn2-transport">
        <div className="syn2-ab" role="group" aria-label="A/B compare">
          <button type="button" className={p.auditionTarget === 'original' ? 'is-on' : ''} onClick={() => p.onAudition('original')}>A · Original</button>
          <button type="button" className={p.auditionTarget === 'mastered' ? 'is-on' : ''} onClick={() => p.onAudition('mastered')}>B · Master</button>
        </div>
        {p.report && !p.running && (
          <button type="button" className="syn2-btn-gold" onClick={p.onFix}>
            <RotateCcw className="w-4 h-4" /> Fix again
          </button>
        )}
      </div>

      {p.report && !p.running && (
        <div className={`syn2-result ${gate?.passed ? 'is-pass' : 'is-fail'}`}>
          <Wand2 className="w-5 h-5 shrink-0" />
          <div className="min-w-0">
            <div className="syn2-result-title">{gate?.passed ? 'Verified master: every target passed' : 'Master not fully verified'}</div>
            <div className="syn2-result-sub">{p.report.stopReason}</div>
          </div>
        </div>
      )}

      <div className="syn2-stats">
        <Stat label="Loudness" src={`${s.integratedLufs.toFixed(1)} LUFS`} out={m ? `${m.integratedLufs.toFixed(1)}` : null} good={check('lufs') ? check('lufs')!.status === 'pass' : null} />
        <Stat label="True peak" src={`${s.truePeakDb.toFixed(2)} dBTP`} out={m ? `${m.truePeakDb.toFixed(2)}` : null} good={check('true-peak') ? check('true-peak')!.status === 'pass' : null} />
        <Stat label="Clips" src={String(s.clippedSamples)} out={m ? String(m.clippedSamples) : null} good={check('clipping') ? check('clipping')!.status === 'pass' : null} />
        <Stat label="Clicks" src={String(s.clickCount ?? 0)} out={m ? String(m.clickCount ?? 0) : null} good={check('clicks') ? check('clicks')!.status === 'pass' : null} />
        <Stat label="LRA" src={`${s.loudnessRangeLu.toFixed(1)} LU`} out={m ? `${m.loudnessRangeLu.toFixed(1)}` : null} />
        <Stat label="Crest" src={`${s.crestFactorDb.toFixed(1)} dB`} out={m ? `${m.crestFactorDb.toFixed(1)}` : null} good={check('crest') ? check('crest')!.status === 'pass' : null} />
        <Stat label="Phase" src={s.phaseCorrelation.toFixed(2)} out={m ? m.phaseCorrelation.toFixed(2) : null} good={check('phase') ? check('phase')!.status === 'pass' : null} />
        <Stat label="DC" src={s.dcOffset.toFixed(4)} out={m ? m.dcOffset.toFixed(4) : null} good={check('dc-offset') ? check('dc-offset')!.status === 'pass' : null} />
      </div>

      <button type="button" className="syn2-details-toggle" onClick={() => setShowDetails((v) => !v)} aria-expanded={showDetails}>
        {showDetails ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        {showDetails ? 'Hide technical details' : 'Show technical details & diagnostic log'}
      </button>
      {showDetails && <DiagnosticLogPanel log={p.log} />}
    </section>
  );
};
