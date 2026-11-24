import React, { useState } from 'react';
import { Check, Eye, EyeOff, Play, Shuffle, Swords } from 'lucide-react';
import type { AudioAnalysis, BattleCandidate, ProcessorModule } from '../types/mastering';
import { SpectrumAndEQCanvas } from './CanvasVisualizers';

interface Props {
  preAnalysis: AudioAnalysis | null;
  candidates: BattleCandidate[];
  activeAudition: 'mastered' | 'original' | 'reference' | 'candidate-a' | 'candidate-b' | 'candidate-c' | 'iteration';
  generating: boolean;
  sampleRate: number;
  onGenerateBattle: () => void;
  onAuditionCandidate: (id: 'A' | 'B' | 'C', loudnessMatched: boolean) => void;
  onSelectWinner: (candidate: BattleCandidate) => void;
}

export const BattleModeView: React.FC<Props> = ({
  preAnalysis,
  candidates,
  activeAudition,
  generating,
  sampleRate,
  onGenerateBattle,
  onAuditionCandidate,
  onSelectWinner,
}) => {
  const [blindMode, setBlindMode] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [loudnessMatch, setLoudnessMatch] = useState(true);
  const [order, setOrder] = useState<Array<'A' | 'B' | 'C'>>(['A', 'B', 'C']);
  const [focusedId, setFocusedId] = useState<'A' | 'B' | 'C'>('A');

  const shuffleOrder = () => {
    const arr: Array<'A' | 'B' | 'C'> = ['A', 'B', 'C'];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    setOrder(arr);
  };

  if (!preAnalysis) {
    return (
      <div data-testid="workspace-empty-state" data-workspace="battle" className="syn-workspace-empty p-8 rounded bg-[#111217] border border-[#242732] text-center">
        <p className="text-sm font-semibold text-[#F7F8FA]">SYN MASTER Battle Mode</p>
        <p className="mt-1 text-xs text-[#9CA3AF]">
          Load an audio track to generate three independently configured mastering philosophies (Transparent, Commercial Punch, Warm Analog).
        </p>
      </div>
    );
  }

  const orderedCandidates = order
    .map((id) => candidates.find((c) => c.id === id))
    .filter((c): c is BattleCandidate => Boolean(c));

  const focusedCandidate =
    candidates.find((c) => c.id === focusedId) ?? candidates[0] ?? null;

  return (
    <div className="flex flex-col gap-4">
      {/* Header Controls */}
      <div className="p-4 rounded bg-[#111217] border border-[#D4AF37]/30 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-[#F7F8FA]">
            SYN MASTER Battle Mode (A / B / C)
          </h3>
          <p className="text-xs text-[#9CA3AF]">
            Builds three completely independent DSP chains tailored to your source audio and renders real offline masters for blind loudness-matched auditioning.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-[#C5CDD8] px-2.5 py-1.5 rounded bg-[#181A22] border border-[#2B2E3A]">
            <input
              type="checkbox"
              checked={loudnessMatch}
              onChange={(e) => setLoudnessMatch(e.target.checked)}
              className="accent-[#D4AF37]"
            />
            Loudness Match (-14 LUFS)
          </label>
          <button
            type="button"
            onClick={() => {
              setBlindMode((b) => !b);
              setRevealed(false);
            }}
            className={`px-2.5 py-1.5 rounded text-xs font-medium border flex items-center gap-1.5 ${
              blindMode
                ? 'bg-[#D4AF37]/20 border-[#D4AF37] text-[#F2CA52]'
                : 'bg-[#181A22] border-[#2B2E3A] text-[#C5CDD8]'
            }`}
          >
            {blindMode ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            Blind Mode
          </button>
          <button
            type="button"
            onClick={shuffleOrder}
            className="px-2.5 py-1.5 rounded bg-[#181A22] border border-[#2B2E3A] text-xs text-[#C5CDD8] hover:border-[#D4AF37] flex items-center gap-1"
          >
            <Shuffle className="w-3.5 h-3.5" />
            Randomize
          </button>
          <button
            type="button"
            disabled={generating}
            onClick={() => {
              setRevealed(false);
              onGenerateBattle();
            }}
            className="px-3.5 py-1.5 rounded bg-[#D4AF37] text-[#070709] text-xs font-bold hover:bg-[#F2CA52] disabled:opacity-50 flex items-center gap-1.5"
          >
            <Swords className="w-3.5 h-3.5" />
            {generating ? 'Rendering 3 Masters...' : 'Generate A/B/C Masters'}
          </button>
        </div>
      </div>

      {candidates.length === 0 ? (
        <div className="p-8 rounded bg-[#111217] border border-dashed border-[#2A2D39] text-center">
          <p className="text-xs text-[#9CA3AF]">
            Click <strong className="text-[#F2CA52]">Generate A/B/C Masters</strong> to process your source track through three distinct mastering philosophies.
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {orderedCandidates.map((cand, idx) => {
              const targetKey = `candidate-${cand.id.toLowerCase()}` as
                | 'candidate-a'
                | 'candidate-b'
                | 'candidate-c';
              const isPlayingThis = activeAudition === targetKey;
              const hideIdentity = blindMode && !revealed;

              return (
                <div
                  key={cand.id}
                  className={`p-4 rounded border flex flex-col gap-3 transition-colors ${
                    isPlayingThis
                      ? 'bg-[#171922] border-[#F2CA52]'
                      : 'bg-[#111217] border-[#252834]'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-[11px] font-mono-tabular uppercase text-[#D4AF37]">
                        {hideIdentity ? `Blind Slot #${idx + 1}` : `Master ${cand.id}`}
                      </div>
                      <h4 className="text-sm font-bold text-[#F7F8FA]">
                        {hideIdentity ? `Mystery Candidate ${idx + 1}` : cand.title}
                      </h4>
                    </div>
                    {isPlayingThis && (
                      <span className="text-[10px] font-mono-tabular uppercase px-1.5 py-0.5 rounded bg-[#D4AF37] text-[#070709] font-bold">
                        Auditioning
                      </span>
                    )}
                  </div>

                  <p className="text-xs text-[#9CA3AF] min-h-[34px]">
                    {hideIdentity
                      ? 'Blind listening mode active. Audition by ear before revealing chain identity.'
                      : cand.philosophy}
                  </p>

                  {!hideIdentity && (
                    <div className="grid grid-cols-2 gap-1.5 p-2.5 rounded bg-[#0B0C10] border border-[#1E212B] text-[11px] font-mono-tabular">
                      <div className="whitespace-nowrap">
                        <span className="text-[#9CA3AF]">LUFS: </span>
                        <span className="text-[#F7F8FA]">{cand.postAnalysis.integratedLufs.toFixed(1)}</span>
                      </div>
                      <div className="whitespace-nowrap">
                        <span className="text-[#9CA3AF]">TP: </span>
                        <span className="text-[#F7F8FA]">{cand.postAnalysis.truePeakDb.toFixed(2)}</span>
                      </div>
                      <div className="whitespace-nowrap">
                        <span className="text-[#9CA3AF]">DR: </span>
                        <span className="text-[#F7F8FA]">{cand.postAnalysis.dynamicRangeDb.toFixed(1)} dB</span>
                      </div>
                      <div className="whitespace-nowrap">
                        <span className="text-[#9CA3AF]">Width: </span>
                        <span className="text-[#F7F8FA]">{(cand.postAnalysis.stereoWidth * 100).toFixed(0)}%</span>
                      </div>
                    </div>
                  )}

                  <div className="flex gap-2 mt-auto pt-1">
                    <button
                      type="button"
                      onClick={() => {
                        setFocusedId(cand.id);
                        onAuditionCandidate(cand.id, loudnessMatch);
                      }}
                      className={`flex-1 py-1.5 px-2.5 rounded text-xs font-semibold border flex items-center justify-center gap-1.5 ${
                        isPlayingThis
                          ? 'bg-[#D4AF37] text-[#070709] border-[#F2CA52]'
                          : 'bg-[#181A22] border-[#2E3240] text-[#F7F8FA] hover:border-[#D4AF37]'
                      }`}
                    >
                      <Play className="w-3.5 h-3.5" />
                      Audition
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setRevealed(true);
                        onSelectWinner(cand);
                      }}
                      className="flex-1 py-1.5 px-2.5 rounded bg-[#D4AF37]/15 border border-[#D4AF37]/60 text-xs font-semibold text-[#F2CA52] hover:bg-[#D4AF37] hover:text-[#070709] flex items-center justify-center gap-1"
                    >
                      <Check className="w-3.5 h-3.5" />
                      Pick Winner
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {blindMode && !revealed && (
            <div className="flex justify-center">
              <button
                type="button"
                onClick={() => setRevealed(true)}
                className="px-4 py-1.5 rounded bg-[#181A22] border border-[#D4AF37]/50 text-xs font-semibold text-[#F2CA52] hover:bg-[#D4AF37]/15"
              >
                Reveal Candidate Identities &amp; Telemetry
              </button>
            </div>
          )}

          {focusedCandidate && (!blindMode || revealed) && (
            <div className="p-3.5 rounded bg-[#111217] border border-[#242732]">
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-xs font-bold uppercase tracking-wider text-[#D4AF37]">
                  Spectrum Comparison: Pre-Master (Dashed) vs {focusedCandidate.title} (Gold)
                </h4>
                <span className="text-[11px] font-mono-tabular text-[#9CA3AF]">
                  {focusedCandidate.chain.length} DSP stages
                </span>
              </div>
              <SpectrumAndEQCanvas
                preAnalysis={preAnalysis}
                postAnalysis={focusedCandidate.postAnalysis}
                chain={focusedCandidate.chain as ProcessorModule[]}
                allowLiveTelemetry={false}
                sampleRate={sampleRate}
                mode="spectrum"
                heightClass="h-48"
              />
            </div>
          )}
        </>
      )}
    </div>
  );
};
