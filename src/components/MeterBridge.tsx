import React, { useEffect, useRef } from 'react';
import { Volume2 } from 'lucide-react';
import type { AudioAnalysis, QCReport } from '../types/mastering';
import { HorizontalSlider } from './controls';
import { telemetryStore, type RuntimeTelemetryState } from '../engine/telemetryStore';

interface Props {
  postAnalysis: AudioAnalysis | null;
  qcReport: QCReport | null;
  monitorVolume: number;
  auditionLabel: string;
  onChangeMonitorVolume: (val: number) => void;
}

function dbToPercent(db: number): number {
  const clamped = Math.max(-60, Math.min(0, db));
  return ((clamped + 60) / 60) * 100;
}

const HOT_CLASS = 'h-full bg-[#EF4444]';
const NORMAL_CLASS = 'h-full bg-gradient-to-r from-[#9C7C1E] via-[#D4AF37] to-[#F2CA52]';

export const MeterBridge: React.FC<Props> = React.memo(
  ({ postAnalysis, qcReport, monitorVolume, auditionLabel, onChangeMonitorVolume }) => {
    const barLRef = useRef<HTMLDivElement | null>(null);
    const barRRef = useRef<HTMLDivElement | null>(null);
    const lrReadoutRef = useRef<HTMLSpanElement | null>(null);
    const grReadoutRef = useRef<HTMLDivElement | null>(null);
    const phaseValueRef = useRef<HTMLSpanElement | null>(null);
    const phaseMarkerRef = useRef<HTMLDivElement | null>(null);

    const postRef = useRef(postAnalysis);
    postRef.current = postAnalysis;

    const applyTelemetryToDom = (snap: RuntimeTelemetryState) => {
      const post = postRef.current;
      const live = snap.isPlaying ? snap.live : null;
      const peakL = live ? live.peakL : post?.samplePeakDb ?? -60;
      const peakR = live ? live.peakR : post?.samplePeakDb ?? -60;
      const corr = live ? live.correlation : post?.phaseCorrelation ?? 1;
      const gr = live ? live.gainReductionDb : 0;

      if (barLRef.current) {
        barLRef.current.style.width = `${dbToPercent(peakL)}%`;
        barLRef.current.className = peakL > -0.3 ? HOT_CLASS : NORMAL_CLASS;
      }
      if (barRRef.current) {
        barRRef.current.style.width = `${dbToPercent(peakR)}%`;
        barRRef.current.className = peakR > -0.3 ? HOT_CLASS : NORMAL_CLASS;
      }
      if (lrReadoutRef.current) {
        lrReadoutRef.current.textContent = `L ${peakL > -59 ? peakL.toFixed(1) : '-∞'} / R ${
          peakR > -59 ? peakR.toFixed(1) : '-∞'
        } dBFS`;
      }
      if (grReadoutRef.current) {
        grReadoutRef.current.textContent = Math.abs(gr) < 0.05 ? '0.0 dB' : `-${gr.toFixed(1)} dB`;
      }
      if (phaseValueRef.current) {
        phaseValueRef.current.textContent = corr >= 0 ? `+${corr.toFixed(2)}` : corr.toFixed(2);
        phaseValueRef.current.className = corr < 0.2 ? 'text-[#F59E0B]' : 'text-[#34D399]';
      }
      if (phaseMarkerRef.current) {
        phaseMarkerRef.current.style.left = `calc(${((corr + 1) / 2) * 100}% - 4px)`;
      }
    };

    useEffect(() => {
      applyTelemetryToDom(telemetryStore.getSnapshot());
    }, [postAnalysis]);

    useEffect(() => {
      let pendingRaf = 0;
      let latestSnap = telemetryStore.getSnapshot();
      const unsub = telemetryStore.subscribe((snap) => {
        latestSnap = snap;
        if (pendingRaf) return;
        pendingRaf = requestAnimationFrame(() => {
          pendingRaf = 0;
          applyTelemetryToDom(latestSnap);
        });
      });
      return () => {
        unsub();
        if (pendingRaf) cancelAnimationFrame(pendingRaf);
      };
    }, []);

    return (
      <footer
        aria-label="Master Output Meter Bridge"
        className="h-auto lg:h-[84px] shrink-0 bg-[#0B0C10] border-t border-[#242732] px-3 lg:px-4 py-1.5 lg:py-2 flex flex-wrap items-center justify-between gap-2.5 lg:gap-4"
      >
        {/* L / R Stereo Output Bars (updated imperatively without React re-renders) */}
        <div className="flex flex-col gap-1 w-full sm:w-auto sm:min-w-[200px] sm:flex-1 sm:max-w-xs">
          <div className="flex items-center justify-between text-[10px] font-mono-tabular text-[#9CA3AF]">
            <span className="uppercase tracking-wider text-[#D4AF37] font-semibold">
              Master Out ({auditionLabel})
            </span>
            <span ref={lrReadoutRef}>L -∞ / R -∞ dBFS</span>
          </div>
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-mono-tabular text-[#9CA3AF] w-3">L</span>
              <div className="flex-1 h-2 rounded-sm bg-[#161820] border border-[#242732] overflow-hidden">
                <div ref={barLRef} className={NORMAL_CLASS} style={{ width: '0%' }} />
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-mono-tabular text-[#9CA3AF] w-3">R</span>
              <div className="flex-1 h-2 rounded-sm bg-[#161820] border border-[#242732] overflow-hidden">
                <div ref={barRRef} className={NORMAL_CLASS} style={{ width: '0%' }} />
              </div>
            </div>
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
            <div ref={grReadoutRef} className="text-xs sm:text-sm font-bold text-[#F59E0B]">
              0.0 dB
            </div>
          </div>
        </div>

        {/* Phase Correlation Bar */}
        <div className="flex flex-col gap-1 min-w-[130px]">
          <div className="flex justify-between text-[10px] font-mono-tabular text-[#9CA3AF]">
            <span>Phase Corr</span>
            <span ref={phaseValueRef} className="text-[#34D399]">
              +1.00
            </span>
          </div>
          <div className="h-2 rounded-sm bg-[#161820] border border-[#242732] relative">
            <div className="absolute left-1/2 top-0 bottom-0 w-px bg-[#4B5563]" />
            <div
              ref={phaseMarkerRef}
              className="absolute top-0 bottom-0 w-2 rounded-sm bg-[#F2CA52]"
              style={{ left: 'calc(100% - 4px)' }}
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
  },
);
