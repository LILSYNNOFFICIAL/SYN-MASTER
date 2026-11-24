import React from 'react';
import { Activity, AudioWaveform, ArrowUpRight, Bot, FileAudio2, Gauge, SlidersHorizontal, Sparkles, Upload } from 'lucide-react';

interface Props {
  projectCount: number;
  processorCount: number;
  presetCount: number;
  onDemo: () => void;
  onCalibration: () => void;
  onOpenAI: () => void;
}

/** Desktop-first landing workspace. The signal artwork is an idle-state illustration,
 * not a measurement; live audio data replaces it in the analysis workspaces. */
export const StudioWelcome: React.FC<Props> = ({
  projectCount, processorCount, presetCount, onDemo, onCalibration, onOpenAI,
}) => (
  <section className="syn-dashboard-welcome" aria-labelledby="syn-dashboard-title">
    <div className="syn-dashboard-topline">
      <div><span className="syn-eyebrow">PROFESSIONAL AUDIO MASTERING SUITE</span><span className="syn-online"><i /> ENGINE READY</span></div>
      <span className="syn-dashboard-version">SYN / MASTERING ENVIRONMENT</span>
    </div>

    <div className="syn-dashboard-hero">
      <div className="syn-dashboard-copy">
        <div className="syn-dashboard-kicker"><span className="syn-kicker-mark">S</span> INTELLIGENT AUDIO ENGINEERING</div>
        <h1 id="syn-dashboard-title">Make every<br/><em>frequency</em> count.</h1>
        <p>Precision mastering. Measurable decisions. Total control. Bring a mix into SYN MASTER and shape it with a complete, non-destructive mastering environment.</p>
        <div className="syn-dashboard-actions">
          <button type="button" className="syn-dashboard-primary" onClick={onDemo}><Upload size={16}/> LOAD DEMO SESSION <ArrowUpRight size={15}/></button>
          <button type="button" className="syn-dashboard-secondary" onClick={onOpenAI}><Sparkles size={16}/> AI MASTERING ASSISTANT</button>
        </div>
        <div className="syn-dashboard-footnote"><span className="syn-pulse-dot"/> AUDIO ENGINE STANDING BY <b>·</b> IMPORT FROM THE LIBRARY TO BEGIN</div>
      </div>

      <div className="syn-dashboard-visual" aria-label="Decorative signal visualization, awaiting imported audio">
        <div className="syn-visual-top"><span>01 / SIGNAL ANALYSIS</span><span>STEREO · 20 Hz—20 kHz</span></div>
        <div className="syn-visual-main">
          <div className="syn-visual-orbit syn-orbit-one"/><div className="syn-visual-orbit syn-orbit-two"/>
          <svg className="syn-signal-art" viewBox="0 0 760 300" role="img" aria-label="Abstract blue audio waveform and gold frequency response illustration">
            <defs>
              <linearGradient id="synWaveFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#42B9FF" stopOpacity=".58"/><stop offset="1" stopColor="#1267B7" stopOpacity="0"/></linearGradient>
              <linearGradient id="synGoldLine" x1="0" x2="1"><stop stopColor="#9B762B"/><stop offset=".48" stopColor="#FFE39A"/><stop offset="1" stopColor="#D39B32"/></linearGradient>
              <filter id="synBlueGlow"><feGaussianBlur stdDeviation="5"/></filter>
            </defs>
            {Array.from({length:9},(_,i)=><line key={'h'+i} x1="0" y1={22+i*31} x2="760" y2={22+i*31} stroke="#6F91B3" strokeOpacity=".16" strokeDasharray="3 7"/>)}
            {Array.from({length:17},(_,i)=><line key={'v'+i} x1={i*47.5} y1="8" x2={i*47.5} y2="285" stroke="#6F91B3" strokeOpacity=".13"/>)}
            <path d="M0 151 L18 145 34 160 49 133 64 174 81 104 98 188 115 119 132 155 149 143 166 159 183 126 200 170 217 113 234 181 251 137 268 155 285 128 302 170 319 107 336 184 353 117 370 162 387 143 404 158 421 122 438 176 455 112 472 184 489 133 506 161 523 140 540 154 557 126 574 172 591 115 608 181 625 132 642 158 659 141 676 154 693 134 710 166 727 143 744 154 760 149 L760 285 L0 285Z" fill="url(#synWaveFill)" opacity=".62"/>
            <path d="M0 151 L18 145 34 160 49 133 64 174 81 104 98 188 115 119 132 155 149 143 166 159 183 126 200 170 217 113 234 181 251 137 268 155 285 128 302 170 319 107 336 184 353 117 370 162 387 143 404 158 421 122 438 176 455 112 472 184 489 133 506 161 523 140 540 154 557 126 574 172 591 115 608 181 625 132 642 158 659 141 676 154 693 134 710 166 727 143 744 154 760 149" fill="none" stroke="#40B8FF" strokeWidth="2.5" filter="url(#synBlueGlow)" opacity=".8"/>
            <path d="M0 151 L18 145 34 160 49 133 64 174 81 104 98 188 115 119 132 155 149 143 166 159 183 126 200 170 217 113 234 181 251 137 268 155 285 128 302 170 319 107 336 184 353 117 370 162 387 143 404 158 421 122 438 176 455 112 472 184 489 133 506 161 523 140 540 154 557 126 574 172 591 115 608 181 625 132 642 158 659 141 676 154 693 134 710 166 727 143 744 154 760 149" fill="none" stroke="#72CEFF" strokeWidth="1.6"/>
            <path d="M0 213 C75 213 82 208 125 201 S205 175 245 166 S310 175 348 154 S420 89 464 105 S520 160 559 145 S640 115 680 128 S725 155 760 151" fill="none" stroke="url(#synGoldLine)" strokeWidth="3"/>
            <path d="M0 213 C75 213 82 208 125 201 S205 175 245 166 S310 175 348 154 S420 89 464 105 S520 160 559 145 S640 115 680 128 S725 155 760 151" fill="none" stroke="#F4D88E" strokeWidth="8" opacity=".12" filter="url(#synBlueGlow)"/>
            {[125,245,348,464,559,680].map((x,i)=><g key={x}><circle cx={x} cy={[201,166,154,105,145,128][i]} r="7" fill="#101925" stroke="#F0CA70" strokeWidth="2"/><circle cx={x} cy={[201,166,154,105,145,128][i]} r="2" fill="#FFF0C5"/></g>)}
          </svg>
          <div className="syn-visual-freq"><span>20 Hz</span><span>1 kHz</span><span>20 kHz</span></div>
        </div>
        <div className="syn-visual-bottom"><span><i className="syn-legend-blue"/> SIGNAL / WAVEFORM</span><span><i className="syn-legend-gold"/> EQ RESPONSE</span><span className="syn-visual-idle">IDLE PREVIEW · NOT SOURCE DATA</span></div>
      </div>
    </div>

    <div className="syn-dashboard-metrics">
      <div className="syn-dashboard-metric"><span><Gauge size={15}/> MASTERING ENGINE</span><strong>READY</strong><small>Non-destructive signal chain</small></div>
      <div className="syn-dashboard-metric"><span><SlidersHorizontal size={15}/> PROCESSORS</span><strong>{processorCount.toString().padStart(2,'0')}</strong><small>Available in current rack</small></div>
      <div className="syn-dashboard-metric"><span><FileAudio2 size={15}/> PROJECTS</span><strong>{projectCount.toString().padStart(2,'0')}</strong><small>Saved local sessions</small></div>
      <div className="syn-dashboard-metric"><span><Activity size={15}/> PRESETS</span><strong>{presetCount.toString().padStart(2,'0')}</strong><small>Starting points, not limits</small></div>
    </div>

    <div className="syn-dashboard-bottom">
      <div className="syn-dashboard-section-title"><span>MASTERING WORKFLOW</span><span>FROM SOURCE TO VERIFIED MASTER</span></div>
      <div className="syn-dashboard-workflow">
        <div><b>01</b><FileAudio2/><strong>IMPORT</strong><small>Load your mix</small></div>
        <i/>
        <div><b>02</b><Activity/><strong>ANALYZE</strong><small>Measure the signal</small></div>
        <i/>
        <div><b>03</b><Bot/><strong>OPTIMIZE</strong><small>AI + hands-on DSP</small></div>
        <i/>
        <div><b>04</b><AudioWaveform/><strong>VERIFY</strong><small>Listen, measure, export</small></div>
      </div>
      <div className="syn-dashboard-utility"><button type="button" onClick={onCalibration}>RUN CALIBRATION SWEEP <ArrowUpRight size={13}/></button><span>Import audio from the left library, or start with a generated demo mix.</span></div>
    </div>
  </section>
);
