import React from 'react';
import { Volume2 } from 'lucide-react';
import type { AudioAnalysis, QCReport } from '../types/mastering';
import type { LiveMeterSnapshot } from '../engine/audioEngine';
import { HorizontalSlider } from './controls';

interface Props {
  postAnalysis: AudioAnalysis | null;
  liveTelemetry: LiveMeterSnapshot | null;
  isPlaying: boolean;
  qcReport: QCReport | null;
  monitorVolume: number;
  auditionLabel: string;
  onChangeMonitorVolume: (val: number) => void;
}

function dbToPercent(db: number): number {
  const clamped = Math.max(-60, Math.min(0, db));
  return ((clamped + 60) / 60) * 100;
}

export const MeterBridge: React.FC<Props> = ({
  postAnalysis,
  liveTelemetry,
  isPlaying,
  qcReport,
  monitorVolume,
  auditionLabel,
  onChangeMonitorVolume,
}) => {
  const peakL = isPlaying && liveTelemetry ? liveTelemetry.peakL : postAnalysis?.samplePeakDb ?? -60;
  const peakR = isPlaying && liveTelemetry ? liveTelemetry.peakR : postAnalysis?.samplePeakDb ?? -60;
  const corr = isPlaying && liveTelemetry ? liveTelemetry.correlation : postAnalysis?.phaseCorrelation ?? 1;
  const gr = isPlaying && liveTelemetry ? liveTelemetry.gainReductionDb : 0;

  return (
    <footer
      aria-label="Master Output Meter Bridge"
      className="h-auto lg:h-[84px] shrink-0 bg-[#0B0C10] border-t border-[#242732] px-3 lg:px-4 py-1.5 lg:py-2 flex flex-wrap items-center justify-between gap-2.5 lg:gap-4"
    >
      {/* L / R Stereo Output Bars */}
      <div className="flex flex-col gap-1 w-full sm:w-auto sm:min-w-[200px] sm:flex-1 sm:max-w-xs">
        <div className="flex items-center justify-between text-[10px] font-mono-tabular text-[#9CA3AF]">
          <span className="uppercase tracking-wider text-[#D4AF37] font-semibold">
            Master Out ({auditionLabel})
          </span>
          <span>
            L {peakL > -59 ? peakL.toFixed(1) : '-∞'} / R {peakR > -59 ? peakR.toFixed(1) : '-∞'} dBFS
          </span>
        </div>
        <div className="flex flex-col gap-1">
          {[
            { ch: 'L', db: peakL },
            { ch: 'R', db: peakR },
          ].map((m) => {
            const pct = dbToPercent(m.db);
            const isHot = m.db > -0.3;
            return (
              <div key={m.ch} className="flex items-center gap-1.5">
                <span className="text-[10px] font-mono-tabular text-[#9CA3AF] w-3">{m.ch}</span>
                <div className="flex-1 h-2 rounded-sm bg-[#161820] border border-[#242732] overflow-hidden">
                  <div
                    className={`h-full transition-[width] duration-75 ${
                      isHot
                        ? 'bg-[#EF4444]'
                        : 'bg-gradient-to-r from-[#9C7C1E] via-[#D4AF37] to-[#F2CA52]'
                    }`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Primary Calibrated Telemetry Readouts */}
      <div className="grid grid-cols-4 sm:flex sm:flex-wrap items-center gap-2 sm:gap-5 font-mono-tabular w-full sm:w-auto">
        <div>
          <div className="text-[9px] sm:text-[10px] uppercase text-[#9CA3AF]">Integrated</div>
          <div className="text-xs sm:text-sm font-bold text-[#F2CA52]">
            {postAnalysis ? `${postAnalysis.integratedLufs.toFixed(1)} LUFS` : '--.- LUFS'}
          </div>
        </div>
        <div>
          <div className="text-[9px] sm:text-[10px] uppercase text-[#9CA3AF]">True Peak</div>
          <div
            className={`text-xs sm:text-sm font-bold ${
              postAnalysis && postAnalysis.truePeakDb > -0.2
                ? 'text-[#EF4444]'
                : 'text-[#F7F8FA]'
            }`}
          >
            {postAnalysis ? `${postAnalysis.truePeakDb.toFixed(2)} dBTP` : '--.-- dBTP'}
          </div>
        </div>
        <div>
          <div className="text-[9px] sm:text-[10px] uppercase text-[#9CA3AF]">Dyn Range</div>
          <div className="text-xs sm:text-sm font-bold text-[#F7F8FA]">
            {postAnalysis ? `${postAnalysis.dynamicRangeDb.toFixed(1)} dB` : '--.- dB'}
          </div>
        </div>
        <div>
          <div className="text-[9px] sm:text-[10px] uppercase text-[#9CA3AF]">Gain Red.</div>
          <div className="text-xs sm:text-sm font-bold text-[#F59E0B]">
            -{gr.toFixed(1)} dB
          </div>
        </div>
      </div>

      {/* Phase Correlation Bar */}
      <div className="flex flex-col gap-1 min-w-[130px]">
        <div className="flex justify-between text-[10px] font-mono-tabular text-[#9CA3AF]">
          <span>Phase Corr</span>
          <span className={corr < 0.2 ? 'text-[#F59E0B]' : 'text-[#34D399]'}>
            {corr >= 0 ? `+${corr.toFixed(2)}` : corr.toFixed(2)}
          </span>
        </div>
        <div className="h-2 rounded-sm bg-[#161820] border border-[#242732] relative">
          <div className="absolute left-1/2 top-0 bottom-0 w-px bg-[#4B5563]" />
          <div
            className="absolute top-0 bottom-0 w-2 rounded-sm bg-[#F2CA52]"
            style={{ left: `calc(${((corr + 1) / 2) * 100}% - 4px)` }}
          />
        </div>
      </div>

      {/* QC Status + Independent Monitor Level Control */}
      <div className="flex items-center gap-4">
        {qcReport && (
          <div className="text-[11px] font-mono-tabular">
            <span className="text-[#9CA3AF]">QC: </span>
            <span
              className={
                qcReport.overallStatus === 'pass'
                  ? 'text-[#34D399] font-bold'
                  : qcReport.overallStatus === 'warning'
                    ? 'text-[#F59E0B] font-bold'
                    : 'text-[#EF4444] font-bold'
              }
            >
              {qcReport.overallStatus.toUpperCase()}
            </span>
          </div>
        )}

        <div className="flex items-center gap-2 w-36">
          <Volume2 className="w-3.5 h-3.5 text-[#38BDF8] shrink-0" />
          <div className="flex-1 min-w-0">
            <HorizontalSlider
              label="Monitor Volume"
              value={Math.round(monitorVolume * 100)}
              min={0}
              max={100}
              step={1}
              defaultValue={85}
              unit="%"
              precision={0}
              compact
              onChange={(pct) => onChangeMonitorVolume(pct / 100)}
              testId="meter-bridge-monitor-volume"
            />
          </div>
        </div>
      </div>
    </footer>
  );
};
