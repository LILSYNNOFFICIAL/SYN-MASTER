import React, { useState } from 'react';
import type { AudioAnalysis, LabSubTab, ProcessorModule } from '../types/mastering';
import {
  LoudnessHistoryCanvas,
  SpectrumAndEQCanvas,
  VectorscopeCanvas,
} from './CanvasVisualizers';

interface Props {
  preAnalysis: AudioAnalysis | null;
  postAnalysis: AudioAnalysis | null;
  chain: ProcessorModule[];
  postChannels: Float32Array[] | null;
  sampleRate: number;
  defaultSubTab?: LabSubTab;
  /** Reports the chosen sub-lab so the parent can restore it when the view remounts. */
  onSubTabChange?: (tab: LabSubTab) => void;
}

const MetricCard: React.FC<{ label: string; value: string; delta?: string }> = ({
  label,
  value,
  delta,
}) => (
  <div className="syn-lab-metric p-3 rounded bg-[#111217] border border-[#232632]">
    <div className="syn-lab-metric-label text-[11px] uppercase tracking-wider text-[#9CA3AF]">{label}</div>
    <div className="mt-1 text-lg font-bold font-mono-tabular text-[#F7F8FA]">{value}</div>
    {delta && <div className="syn-lab-metric-delta text-[11px] font-mono-tabular text-[#D4AF37]">{delta}</div>}
  </div>
);

export const SynLabView: React.FC<Props> = React.memo(({
  preAnalysis,
  postAnalysis,
  chain,
  postChannels,
  sampleRate,
  defaultSubTab = 'frequency',
  onSubTabChange,
}) => {
  const [subTab, setSubTabState] = useState<LabSubTab>(defaultSubTab);
  const setSubTab = (t: LabSubTab) => { setSubTabState(t); onSubTabChange?.(t); };
  React.useEffect(() => setSubTabState(defaultSubTab), [defaultSubTab]);
  const active = postAnalysis ?? preAnalysis;

  if (!active || !preAnalysis) {
    return (
      <div data-testid="workspace-empty-state" data-workspace="lab" data-syn-skin="instrument" className="syn-workspace-empty p-8 rounded bg-[#111217] border border-[#242732] text-center">
        <p className="text-sm font-semibold text-[#F7F8FA]">SYN MASTER LAB</p>
        <p className="mt-1 text-xs text-[#9CA3AF]">
          Import an audio file or load the Demo Mix to inspect Frequency, Dynamics, Stereo, and Distortion diagnostics.
        </p>
      </div>
    );
  }

  const zoneEntries = [
    { label: 'Sub (20–60 Hz)', pre: preAnalysis.zoneEnergyDb.sub, post: active.zoneEnergyDb.sub },
    { label: 'Bass (60–250 Hz)', pre: preAnalysis.zoneEnergyDb.bass, post: active.zoneEnergyDb.bass },
    { label: 'Low-Mid (250–500 Hz)', pre: preAnalysis.zoneEnergyDb.lowMid, post: active.zoneEnergyDb.lowMid },
    { label: 'Mid (500–2k Hz)', pre: preAnalysis.zoneEnergyDb.mid, post: active.zoneEnergyDb.mid },
    { label: 'High-Mid (2k–6k Hz)', pre: preAnalysis.zoneEnergyDb.highMid, post: active.zoneEnergyDb.highMid },
    { label: 'Presence (6k–12k Hz)', pre: preAnalysis.zoneEnergyDb.presence, post: active.zoneEnergyDb.presence },
    { label: 'Air (12k–20k Hz)', pre: preAnalysis.zoneEnergyDb.air, post: active.zoneEnergyDb.air },
  ];

  return (
    <div data-syn-skin="instrument" data-workspace="lab" className="syn-lab-workspace flex flex-col gap-4" data-lab={subTab}>
      {/* Sub-lab selector */}
      <div className="syn-lab-tab-nav flex items-center gap-1 p-1 rounded bg-[#111217] border border-[#242732] w-fit">
        {(
          [
            { id: 'frequency', label: 'Frequency Lab' },
            { id: 'dynamics', label: 'Dynamics Lab' },
            { id: 'stereo', label: 'Stereo Lab' },
            { id: 'distortion', label: 'Distortion Lab' },
          ] as const
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setSubTab(t.id)}
            data-active={subTab === t.id ? 'true' : 'false'}
            data-lab-id={t.id}
            className={`syn-lab-tab px-3 py-1.5 rounded text-xs font-semibold transition-colors whitespace-nowrap ${
              subTab === t.id
                ? 'bg-[#D4AF37] text-[#070709]'
                : 'text-[#9CA3AF] hover:text-[#F7F8FA]'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {subTab === 'frequency' && (
        <div className="flex flex-col gap-4">
          <SpectrumAndEQCanvas
            preAnalysis={preAnalysis}
            postAnalysis={postAnalysis}
            chain={chain}
            sampleRate={sampleRate}
            mode="spectrum"
            heightClass="h-64"
          />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="p-3.5 rounded bg-[#111217] border border-[#232632]">
              <h3 className="text-xs font-bold uppercase tracking-wider text-[#D4AF37] mb-2.5">
                Spectral Zone Balance (Pre vs Master)
              </h3>
              <div className="syn-lab-zone-key" aria-hidden="true"><i className="syn-lab-zone-key-post" />Master <i className="syn-lab-zone-key-pre" />Pre</div>
              <div className="flex flex-col gap-2">
                {zoneEntries.map((z) => {
                  const pct = Math.max(5, Math.min(100, ((z.post + 60) / 55) * 100));
                  const prePct = Math.max(0, Math.min(100, ((z.pre + 60) / 55) * 100));
                  const delta = z.post - z.pre;
                  return (
                    <div key={z.label} className="flex flex-col gap-1">
                      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-3 text-[11px] font-mono-tabular min-w-0">
                        <span className="min-w-0 break-words text-[#C5CDD8]">{z.label}</span>
                        <span className="text-right whitespace-nowrap text-[#F7F8FA]">
                          {z.post.toFixed(1)} dB ({delta >= 0 ? `+${delta.toFixed(1)}` : delta.toFixed(1)})
                        </span>
                      </div>
                      <div className="syn-lab-zone-bar h-1.5 rounded bg-[#1B1D26]" title={`Pre ${z.pre.toFixed(1)} dB · Master ${z.post.toFixed(1)} dB`}>
                        <div className="syn-lab-zone-fill h-full bg-[#D4AF37]" style={{ width: `${pct}%` }} />
                        <i className="syn-lab-zone-pre" style={{ left: `${prePct}%` }} aria-hidden="true" />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="p-3.5 rounded bg-[#111217] border border-[#232632]">
              <h3 className="text-xs font-bold uppercase tracking-wider text-[#D4AF37] mb-2.5">
                Detected Resonances & Tilt
              </h3>
              <div className="text-xs text-[#9CA3AF] mb-2 font-mono-tabular">
                Centroid: <span className="text-[#F7F8FA]">{active.spectralCentroidHz} Hz</span> · Slope:{' '}
                <span className="text-[#F7F8FA]">{active.spectralSlopeDbPerOct} dB/oct</span>
              </div>
              {active.resonances.length === 0 ? (
                <p className="text-xs text-[#34D399]">No severe narrow-band resonances detected.</p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {active.resonances.map((r, i) => (
                    <div
                      key={`${r.freqHz}-${i}`}
                      className="grid grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-1 text-xs font-mono-tabular py-1 border-b border-[#1D202A]"
                    >
                      <span className="min-w-0 whitespace-nowrap text-[#F7F8FA]">{r.freqHz} Hz</span>
                      <span className="syn-lab-res-peak whitespace-nowrap text-right text-[#F59E0B]">+{r.excessDb} dB peak</span>
                      <span className="col-span-2 sm:col-span-1 text-right uppercase text-[10px] text-[#9CA3AF]">{r.severity}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {subTab === 'dynamics' && (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <MetricCard
              label="Integrated LUFS"
              value={`${active.integratedLufs.toFixed(1)} LUFS`}
              delta={`Pre: ${preAnalysis.integratedLufs.toFixed(1)} LUFS`}
            />
            <MetricCard
              label="Dynamic Range"
              value={`${active.dynamicRangeDb.toFixed(1)} dB`}
              delta={`LRA: ${active.loudnessRangeLu.toFixed(1)} LU`}
            />
            <MetricCard
              label="Crest Factor"
              value={`${active.crestFactorDb.toFixed(1)} dB`}
              delta={`PLR: ${active.plrDb.toFixed(1)} dB`}
            />
            <MetricCard
              label="Short-Term Max"
              value={`${active.shortTermLufsMax.toFixed(1)} LUFS`}
              delta={`Momentary: ${active.momentaryLufsMax.toFixed(1)}`}
            />
          </div>
          <div className="p-3.5 rounded bg-[#111217] border border-[#232632]">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-bold uppercase tracking-wider text-[#D4AF37]">
                Loudness History (Short-Term LUFS Timeline)
              </h3>
              <span className="text-[11px] font-mono-tabular text-[#9CA3AF]">
                <span className="syn-lab-legend-pre">Dashed: Pre-Master</span> · <span className="syn-lab-legend-post">Solid: Mastered</span>
              </span>
            </div>
            <LoudnessHistoryCanvas
              preHistory={preAnalysis.loudnessHistoryLufs}
              postHistory={active.loudnessHistoryLufs}
            />
          </div>
        </div>
      )}

      {subTab === 'stereo' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="p-3.5 rounded bg-[#111217] border border-[#232632]">
            <h3 className="text-xs font-bold uppercase tracking-wider text-[#D4AF37] mb-2">
              Goniometer Vectorscope (M/S Phase Polarity)
            </h3>
            <VectorscopeCanvas
              channels={postChannels ?? undefined}
            />
          </div>
          <div className="grid grid-cols-2 gap-3 content-start">
            <MetricCard
              label="Phase Correlation"
              value={`${active.phaseCorrelation >= 0 ? '+' : ''}${active.phaseCorrelation.toFixed(3)}`}
              delta={active.phaseCorrelation > 0.25 ? 'Phase Coherent' : 'Watch Mono Cancel'}
            />
            <MetricCard
              label="Stereo Width"
              value={`${(active.stereoWidth * 100).toFixed(0)}%`}
              delta={`M/S Ratio: ${active.midSideRatioDb.toFixed(1)} dB`}
            />
            <MetricCard
              label="Low-End (<120Hz) Corr"
              value={`${active.lowEndCorrelation.toFixed(3)}`}
              delta={active.lowEndCorrelation > 0.7 ? 'Tight Mono Sub' : 'Consider Mono Bass'}
            />
            <MetricCard
              label="Mono Compatibility"
              value={`${active.monoCompatibilityScore}/100`}
              delta={`L/R Bal: ${active.lrBalanceDb.toFixed(2)} dB`}
            />
          </div>
        </div>
      )}

      {subTab === 'distortion' && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <MetricCard
            label="True Peak"
            value={`${active.truePeakDb.toFixed(2)} dBTP`}
            delta={`Sample Peak: ${active.samplePeakDb.toFixed(2)} dBFS`}
          />
          <MetricCard
            label="Clipped Samples"
            value={`${active.clippedSamples}`}
            delta={active.clippedSamples === 0 ? 'Zero Digital Clipping' : 'Hard Clipping Detected'}
          />
          <MetricCard
            label="Inter-Sample Peaks"
            value={`${active.interSamplePeaks}`}
            delta="4x Catmull-Rom Check"
          />
          <MetricCard
            label="DC Offset / Distortion"
            value={`${(active.dcOffset * 100).toFixed(3)}%`}
            delta={`THD Proxy: ${active.thdEstimatePercent.toFixed(2)}%`}
          />
        </div>
      )}

    </div>
  );
});
