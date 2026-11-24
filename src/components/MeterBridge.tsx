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
        phaseValueRef.current.className = 'syn-meter-value syn-meter-phase-value ' + (corr < 0.2 ? 'is-warning' : 'is-good');
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
      <footer aria-label="Master Output Meter Bridge" className="syn-meter-bridge">
        <section className="syn-meter-stereo" aria-label="Stereo output levels">
          <div className="syn-meter-stereo-main">
            <div className="syn-meter-stereo-head">
              <span className="syn-meter-kicker">Master Out ({auditionLabel})</span>
              <span ref={lrReadoutRef} className="syn-meter-live-readout">L -∞ / R -∞ dBFS</span>
              {qcReport && (
                <span className="syn-meter-qc">
                  QC <strong className={qcReport.overallStatus === 'pass' ? 'is-pass' : qcReport.overallStatus === 'warning' ? 'is-warning' : 'is-fail'}>{qcReport.overallStatus.toUpperCase()}</strong>
                </span>
              )}
            </div>
            <div className="syn-meter-stereo-bars">
              <div className="syn-meter-bar-row">
                <span>L</span>
                <div className="syn-meter-bar-track"><div ref={barLRef} className={NORMAL_CLASS} style={{ width: '0%' }} /></div>
              </div>
              <div className="syn-meter-bar-row">
                <span>R</span>
                <div className="syn-meter-bar-track"><div ref={barRRef} className={NORMAL_CLASS} style={{ width: '0%' }} /></div>
              </div>
            </div>
          </div>
          <div className="syn-meter-monitor">
            <Volume2 className="w-3.5 h-3.5 text-[#F2CA52] shrink-0" />
            <div className="min-w-0 flex-1">
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
        </section>

        <section className="syn-meter-readouts" aria-label="Master output measurements">
          <div className="syn-meter-metric">
            <span className="syn-meter-label">Integrated</span>
            <strong className="syn-meter-value is-primary">{postAnalysis ? `${postAnalysis.integratedLufs.toFixed(1)} LUFS` : '--.- LUFS'}</strong>
          </div>
          <div className="syn-meter-metric">
            <span className="syn-meter-label">True Peak</span>
            <strong className="syn-meter-value">{postAnalysis ? `${postAnalysis.truePeakDb.toFixed(2)} dBTP` : '--.-- dBTP'}</strong>
          </div>
          <div className="syn-meter-metric">
            <span className="syn-meter-label">Dyn Range</span>
            <strong className="syn-meter-value">{postAnalysis ? `${postAnalysis.dynamicRangeDb.toFixed(1)} dB` : '--.- dB'}</strong>
          </div>
          <div className="syn-meter-metric">
            <span className="syn-meter-label">Gain Red.</span>
            <div ref={grReadoutRef} className="syn-meter-value">0.0 dB</div>
          </div>
          <div className="syn-meter-metric syn-meter-phase">
            <div className="syn-meter-phase-head">
              <span className="syn-meter-label">Phase</span>
              <span ref={phaseValueRef} className="syn-meter-value syn-meter-phase-value is-good">+1.00</span>
            </div>
            <div className="syn-meter-phase-track">
              <span className="syn-meter-phase-center" />
              <span ref={phaseMarkerRef} className="syn-meter-phase-marker" style={{ left: 'calc(100% - 4px)' }} />
            </div>
          </div>
        </section>
      </footer>
    );
  },
);
