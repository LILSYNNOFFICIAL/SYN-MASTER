import React from 'react';
import { AlertTriangle, CheckCircle2, Play, Sparkles, Upload, Wrench, XCircle } from 'lucide-react';
import type {
  AudioAnalysis,
  AudioTrackAsset,
  ProcessorModule,
  QCReport,
  QCTargetProfile,
  ReferenceComparisonReport,
} from '../types/mastering';
import { SpectrumAndEQCanvas } from './CanvasVisualizers';
import { LiveLoudnessPanel } from './qc/LiveLoudnessPanel';
import { AlbumProfilePanel } from './studio/AlbumProfilePanel';
import type { AlbumMasteringProfile } from '../director/albumProfile';

interface RefProps {
  activeTrack: AudioTrackAsset | null;
  postAnalysis: AudioAnalysis | null;
  referenceTrack: AudioTrackAsset | null;
  referenceComparison?: ReferenceComparisonReport | null;
  chain: ProcessorModule[];
  auditionTarget: string;
  onLoadDemoReference: () => void;
  onUploadReferenceFile: (file: File) => void;
  onAuditionReference: () => void;
  onAuditionMastered: () => void;
  onMatchReference: () => void;
  albumProfile: AlbumMasteringProfile | null;
  albumProfileActive: boolean;
  onAlbumProfileChange: (profile: AlbumMasteringProfile | null) => void;
  onAlbumProfileActiveChange: (active: boolean) => void;
}

export const ReferenceMatchView: React.FC<RefProps> = ({
  activeTrack,
  postAnalysis,
  referenceTrack,
  referenceComparison,
  chain,
  auditionTarget,
  onLoadDemoReference,
  onUploadReferenceFile,
  onAuditionReference,
  onAuditionMastered,
  onMatchReference,
  albumProfile,
  albumProfileActive,
  onAlbumProfileChange,
  onAlbumProfileActiveChange,
}) => {
  const refFileInput = React.useRef<HTMLInputElement | null>(null);
  const activePost = postAnalysis ?? activeTrack?.analysis ?? null;

  return (
    <div data-syn-skin="instrument" data-workspace="reference" className="syn-reference-workspace flex flex-col gap-4">
      <div className="p-4 rounded bg-[#111217] border border-[#D4AF37]/30 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-[#F7F8FA]">SYN-REFERENCE Comparison &amp; Matching</h3>
          <p className="text-xs text-[#9CA3AF]">
            Compare spectral balance, LUFS, dynamic range, transient density, and stereo width against a commercial reference with loudness-matched A/B auditioning.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={refFileInput}
            type="file"
            accept="audio/*,.wav,.flac,.mp3,.aac,.m4a,.ogg,.aiff"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onUploadReferenceFile(file);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            onClick={() => refFileInput.current?.click()}
            className="px-3 py-1.5 rounded bg-[#181A22] border border-[#2E3240] text-xs font-semibold text-[#F7F8FA] hover:border-[#D4AF37] flex items-center gap-1.5"
          >
            <Upload className="w-3.5 h-3.5" />
            Upload Reference
          </button>
          <button
            type="button"
            onClick={onLoadDemoReference}
            className="px-3 py-1.5 rounded bg-[#181A22] border border-[#D4AF37]/50 text-xs font-semibold text-[#F2CA52] hover:bg-[#D4AF37]/15"
          >
            Load Demo Reference
          </button>
          {referenceTrack && activeTrack && (
            <button
              type="button"
              onClick={onMatchReference}
              className="px-3.5 py-1.5 rounded bg-[#D4AF37] text-[#070709] text-xs font-bold hover:bg-[#F2CA52] flex items-center gap-1.5"
            >
              <Sparkles className="w-3.5 h-3.5" />
              Weighted Reference Match
            </button>
          )}
        </div>
      </div>

      <AlbumProfilePanel
        profile={albumProfile}
        active={albumProfileActive}
        onChange={onAlbumProfileChange}
        onActivate={onAlbumProfileActiveChange}
      />

      {!referenceTrack || !activePost ? (
        <div data-testid="workspace-empty-state" data-workspace="reference" className="syn-workspace-empty p-8 rounded bg-[#111217] border border-dashed border-[#2A2D39] text-center">
          <p className="text-xs text-[#9CA3AF]">
            Load both a source track and a reference track to view dual-spectrum deltas and loudness-matched A/B controls.
          </p>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onAuditionMastered}
              className={`px-3.5 py-1.5 rounded text-xs font-semibold border flex items-center gap-1.5 ${
                auditionTarget === 'mastered'
                  ? 'bg-[#D4AF37] text-[#070709] border-[#F2CA52]'
                  : 'bg-[#181A22] text-[#F7F8FA] border-[#2E3240]'
              }`}
            >
              <Play className="w-3.5 h-3.5" />
              Listen: Your Master ({activePost.integratedLufs.toFixed(1)} LUFS)
            </button>
            <button
              type="button"
              onClick={onAuditionReference}
              className={`px-3.5 py-1.5 rounded text-xs font-semibold border flex items-center gap-1.5 ${
                auditionTarget === 'reference'
                  ? 'bg-[#34D399] text-[#070709] border-[#34D399]'
                  : 'bg-[#181A22] text-[#34D399] border-[#34D399]/40'
              }`}
            >
              <Play className="w-3.5 h-3.5" />
              Listen: Reference Loudness-Matched ({referenceTrack.analysis.integratedLufs.toFixed(1)} LUFS)
            </button>
          </div>

          <div className="p-3.5 rounded bg-[#111217] border border-[#242732]">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold uppercase tracking-wider text-[#D4AF37]">
                Spectrum Overlay: Your Master (Gold) vs Reference (Emerald Dashed)
              </span>
            </div>
            <SpectrumAndEQCanvas
              preAnalysis={activeTrack?.analysis ?? null}
              postAnalysis={activePost}
              referenceAnalysis={referenceTrack.analysis}
              chain={chain}
              allowLiveTelemetry={false}
              sampleRate={activeTrack?.sampleRate ?? 44100}
              mode="spectrum"
              heightClass="h-56"
            />
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              {
                label: 'Integrated LUFS',
                yours: `${activePost.integratedLufs.toFixed(1)}`,
                ref: `${referenceTrack.analysis.integratedLufs.toFixed(1)}`,
                delta: activePost.integratedLufs - referenceTrack.analysis.integratedLufs,
                unit: 'LU',
              },
              {
                label: 'Dynamic Range',
                yours: `${activePost.dynamicRangeDb.toFixed(1)}`,
                ref: `${referenceTrack.analysis.dynamicRangeDb.toFixed(1)}`,
                delta: activePost.dynamicRangeDb - referenceTrack.analysis.dynamicRangeDb,
                unit: 'dB',
              },
              {
                label: 'Stereo Width',
                yours: `${(activePost.stereoWidth * 100).toFixed(0)}%`,
                ref: `${(referenceTrack.analysis.stereoWidth * 100).toFixed(0)}%`,
                delta: (activePost.stereoWidth - referenceTrack.analysis.stereoWidth) * 100,
                unit: '%',
              },
              {
                label: 'Bass vs Air Tilt',
                yours: `${activePost.spectralSlopeDbPerOct.toFixed(1)}`,
                ref: `${referenceTrack.analysis.spectralSlopeDbPerOct.toFixed(1)}`,
                delta: activePost.spectralSlopeDbPerOct - referenceTrack.analysis.spectralSlopeDbPerOct,
                unit: 'dB/oct',
              },
            ].map((m) => (
              <div key={m.label} className="p-3 rounded bg-[#111217] border border-[#242732]">
                <div className="text-[11px] uppercase text-[#9CA3AF]">{m.label}</div>
                <div className="mt-1 text-sm font-bold font-mono-tabular text-[#F7F8FA]">
                  {m.yours} <span className="text-[#9CA3AF] font-normal">vs</span>{' '}
                  <span className="text-[#34D399]">{m.ref}</span>
                </div>
                <div className="text-[11px] font-mono-tabular text-[#D4AF37]">
                  Delta: {m.delta >= 0 ? `+${m.delta.toFixed(1)}` : m.delta.toFixed(1)} {m.unit}
                </div>
              </div>
            ))}
          </div>

          {referenceComparison && (
            <div className="p-4 rounded bg-[#111217] border border-[#242732] flex flex-col gap-2 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-bold uppercase tracking-wider text-[#D4AF37]">
                  Intelligent Reference Analysis (Tone · Crest · Transients)
                </span>
                <span className="font-mono-tabular text-[#9CA3AF]">
                  Crest Δ {referenceComparison.crestDeltaDb >= 0 ? '+' : ''}
                  {referenceComparison.crestDeltaDb.toFixed(1)} dB · Transient Density Δ{' '}
                  {(referenceComparison.transientDensityDelta * 100).toFixed(0)}%
                </span>
              </div>
              <ul className="list-disc list-inside text-[#C5CDD8] flex flex-col gap-1">
                {referenceComparison.suggestedActions.map((act, i) => (
                  <li key={i}>{act}</li>
                ))}
              </ul>
              <p className="text-[11px] text-[#9CA3AF] italic">{referenceComparison.cautionNote}</p>
            </div>
          )}
        </>
      )}
    </div>
  );
};

interface QcProps {
  qcReport: QCReport | null;
  profiles: QCTargetProfile[];
  selectedProfileId: string;
  onSelectProfile: (id: string) => void;
  onAutoFixQc: () => void;
  /** Measurements for the live loudness panel (source, rendered master when available). */
  preAnalysis?: AudioAnalysis | null;
  postAnalysis?: AudioAnalysis | null;
  durationSec?: number;
  onSeek?: (sec: number) => void;
  /** 'source' when the report was run on the source because the master render is not ready. */
  qcBasis?: 'master' | 'source';
  /** Platform Preview panel (monitoring only), rendered under the live loudness panel. */
  platformPanel?: React.ReactNode;
}

export const QualityControlView: React.FC<QcProps> = ({
  qcReport,
  profiles,
  selectedProfileId,
  onSelectProfile,
  onAutoFixQc,
  preAnalysis = null,
  postAnalysis = null,
  durationSec = 0,
  onSeek,
  qcBasis = 'master',
  platformPanel,
}) => {
  const profile = profiles.find((p) => p.id === selectedProfileId);
  return (
    <div data-syn-skin="instrument" data-workspace="qc" className="syn-qc-workspace flex flex-col gap-4">
      <div className="p-4 rounded bg-[#111217] border border-[#D4AF37]/30 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-[#F7F8FA]">SYN-QC Mastering Quality Control</h3>
          <p className="text-xs text-[#9CA3AF]">
            Independent technical validation checking True Peak safety, clipping, loudness compliance, dynamics, and mono compatibility.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="QC Delivery Target Profile"
            value={selectedProfileId}
            onChange={(e) => onSelectProfile(e.target.value)}
            className="bg-[#181A22] border border-[#2E3240] rounded px-2.5 py-1.5 text-xs text-[#F7F8FA]"
          >
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {qcReport && qcReport.overallStatus !== 'pass' && (
            <button
              type="button"
              onClick={onAutoFixQc}
              className="px-3.5 py-1.5 rounded bg-[#D4AF37] text-[#070709] text-xs font-bold hover:bg-[#F2CA52] flex items-center gap-1.5"
            >
              <Wrench className="w-3.5 h-3.5" />
              Auto-Fix Compliance
            </button>
          )}
        </div>
      </div>

      {preAnalysis && (
        <LiveLoudnessPanel
          pre={preAnalysis}
          post={postAnalysis}
          durationSec={durationSec}
          targetLufs={profile?.targetLufs}
          maxTruePeakDb={profile?.maxTruePeakDb}
          onSeek={onSeek}
        />
      )}
      {platformPanel}
      {qcReport && qcBasis === 'source' && (
        <p className="syn-qc-basis text-[11px]">Checks below are run on the source; they switch to the rendered master as soon as it is ready.</p>
      )}

      {!qcReport ? (
        <div data-testid="workspace-empty-state" data-workspace="qc" className="syn-workspace-empty p-8 rounded bg-[#111217] border border-dashed border-[#2A2D39] text-center">
          <p className="text-xs text-[#9CA3AF]">Import a track (step 1 on the Dashboard, or the menu ☰ → Library) to run SYN-QC technical validation.</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="p-3 rounded bg-[#111217] border border-[#242732]">
              <div className="text-[11px] uppercase text-[#9CA3AF]">Overall Validation</div>
              <div
                className={`mt-1 text-base font-bold uppercase ${
                  qcReport.overallStatus === 'pass'
                    ? 'text-[#34D399]'
                    : qcReport.overallStatus === 'warning'
                      ? 'text-[#F59E0B]'
                      : 'text-[#EF4444]'
                }`}
              >
                {qcReport.overallStatus === 'pass'
                  ? 'PASS · Release Ready'
                  : qcReport.overallStatus === 'warning'
                    ? 'WARNING · Review Suggested'
                    : 'FAIL · Action Required'}
              </div>
            </div>
            <div className="p-3 rounded bg-[#111217] border border-[#242732]">
              <div className="text-[11px] uppercase text-[#9CA3AF]">Checks Passed</div>
              <div className="mt-1 text-base font-bold font-mono-tabular text-[#34D399]">
                {qcReport.passedCount} / {qcReport.checks.length}
              </div>
            </div>
            <div className="p-3 rounded bg-[#111217] border border-[#242732]">
              <div className="text-[11px] uppercase text-[#9CA3AF]">Warnings / Failures</div>
              <div className="mt-1 text-base font-bold font-mono-tabular text-[#F7F8FA]">
                {qcReport.warningCount} warn · {qcReport.failCount} fail
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            {qcReport.checks.map((item) => (
              <div
                key={item.id}
                className="p-3.5 rounded bg-[#111217] border border-[#232632] flex flex-col sm:flex-row sm:items-center justify-between gap-2"
              >
                <div className="flex items-start gap-2.5">
                  {item.status === 'pass' && (
                    <CheckCircle2 className="w-4 h-4 text-[#34D399] shrink-0 mt-0.5" />
                  )}
                  {item.status === 'warning' && (
                    <AlertTriangle className="w-4 h-4 text-[#F59E0B] shrink-0 mt-0.5" />
                  )}
                  {item.status === 'fail' && (
                    <XCircle className="w-4 h-4 text-[#EF4444] shrink-0 mt-0.5" />
                  )}
                  <div>
                    <div className="text-xs font-bold text-[#F7F8FA]">
                      {item.category} · {item.label}
                    </div>
                    <p className="text-xs text-[#9CA3AF] mt-0.5">{item.explanation}</p>
                    {item.suggestedFix && (
                      <p className="text-[11px] text-[#F2CA52] mt-1">
                        Recommended Fix: {item.suggestedFix}
                      </p>
                    )}
                  </div>
                </div>
                <div className="text-right font-mono-tabular shrink-0">
                  <div className="text-xs font-bold text-[#F7F8FA]">{item.measuredValue}</div>
                  <div className="text-[11px] text-[#9CA3AF]">Target: {item.targetValue}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
};
