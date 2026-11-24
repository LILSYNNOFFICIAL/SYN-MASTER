import React from 'react';
import { Activity, AudioWaveform, ArrowUpRight, Bot, FileAudio2, Gauge, Radio, SlidersHorizontal, Sparkles, Upload } from 'lucide-react';

interface Props {
  projectCount: number;
  processorCount: number;
  presetCount: number;
  onDemo: () => void;
  onCalibration: () => void;
  onOpenAI: () => void;
}

/** Desktop-first mastering cockpit. Idle instruments are explicitly labelled as previews,
 * never presented as measurements from a source that has not been imported. */
export const StudioWelcome: React.FC<Props> = ({
  projectCount, processorCount, presetCount, onDemo, onCalibration, onOpenAI,
}) => (
  <section className="syn-dashboard-welcome" aria-labelledby="syn-dashboard-title">
    <header className="syn-dashboard-topline">
      <div className="syn-dashboard-lockup">
        <span className="syn-dashboard-emblem">S</span>
        <span><b>SYN MASTER</b><small>PROFESSIONAL AUDIO MASTERING SUITE</small></span>
      </div>
      <div className="syn-dashboard-topstatus"><span className="syn-online"><i/> ENGINE READY</span><span className="syn-dashboard-version">MASTERING CONTROL ROOM / 01</span></div>
    </header>

    <div className="syn-dashboard-heading">
      <div><span className="syn-eyebrow">SESSION OVERVIEW</span><h1 id="syn-dashboard-title">MASTERING <em>CONTROL ROOM</em></h1><p>Import a mix to activate live analysis, precision processing and verified mastering.</p></div>
      <div className="syn-dashboard-actions">
        <button type="button" className="syn-dashboard-primary" onClick={onDemo}><Upload size={15}/> LOAD DEMO SESSION <ArrowUpRight size={14}/></button>
        <button type="button" className="syn-dashboard-secondary" onClick={onOpenAI}><Sparkles size={15}/> AI ASSISTANT</button>
      </div>
    </div>

    <div className="syn-dashboard-console-grid">
      <section className="syn-dashboard-panel syn-dashboard-eq" aria-label="Pragmatic EQ idle visualization">
        <div className="syn-panel-heading"><div><span className="syn-panel-index">01</span><b>PRAGMATIC EQ</b><small>FREQUENCY RESPONSE / SPECTRUM</small></div><span className="syn-panel-state">AWAITING AUDIO</span></div>
        <div className="syn-dashboard-visual">
          <svg className="syn-signal-art" viewBox="0 0 760 300" role="img" aria-label="Idle waveform and equalizer response preview">
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
        <div className="syn-visual-bottom"><span><i className="syn-legend-blue"/> WAVEFORM PREVIEW</span><span><i className="syn-legend-gold"/> EQ RESPONSE</span><span className="syn-visual-idle">IDLE / NOT SOURCE DATA</span></div>
      </section>

      <section className="syn-dashboard-panel syn-dashboard-fix">
        <div className="syn-panel-heading"><div><span className="syn-panel-index">02</span><b>FIX ALL</b><small>INTELLIGENT MASTERING</small></div><span className="syn-ai-chip"><Sparkles size={11}/> AI</span></div>
        <div className="syn-fix-orbit" aria-hidden="true"><div className="syn-fix-ring"/><div className="syn-fix-ring ring-inner"/><div className="syn-fix-core"><Bot size={30}/><b>AI</b></div></div>
        <h2>ANALYZE <i>·</i> BALANCE <i>·</i> ENHANCE</h2>
        <p>Measurement-driven corrections with real DSP processing and independent verification.</p>
        <div className="syn-fix-status"><span/> WAITING FOR SOURCE AUDIO</div>
        <button type="button" className="syn-fix-open" onClick={onOpenAI}>OPEN AI ASSISTANT <ArrowUpRight size={13}/></button>
      </section>

      <section className="syn-dashboard-panel syn-dashboard-meters">
        <div className="syn-panel-heading"><div><span className="syn-panel-index">03</span><b>I/O METERS</b><small>STEREO OUTPUT</small></div><span className="syn-panel-state">NO SIGNAL</span></div>
        <div className="syn-meter-instrument">
          <div className="syn-meter-scale"><span>0</span><span>-6</span><span>-12</span><span>-24</span><span>-48</span></div>
          {['L','R'].map(channel=><div className="syn-meter-column" key={channel}><div className="syn-meter-track"><i/></div><b>{channel}</b></div>)}
          <div className="syn-meter-scale"><span>0</span><span>-6</span><span>-12</span><span>-24</span><span>-48</span></div>
        </div>
        <div className="syn-meter-readout"><span>PEAK <b>-- dBFS</b></span><span>RMS <b>-- dB</b></span></div>
      </section>
    </div>

    <div className="syn-dashboard-instrument-row">
      <section className="syn-dashboard-panel syn-dashboard-loudness">
        <div className="syn-panel-heading"><div><span className="syn-panel-index">04</span><b>LOUDNESS</b><small>DELIVERY MONITOR</small></div><Gauge size={16}/></div>
        <div className="syn-loudness-readouts"><div><small>INTEGRATED</small><strong>--.- <i>LUFS</i></strong></div><div><small>TRUE PEAK</small><strong>--.- <i>dBTP</i></strong></div></div>
        <div className="syn-loudness-target"><span>STREAMING TARGET</span><b>−14 LUFS <i>/</i> −1 dBTP</b></div>
      </section>

      <section className="syn-dashboard-panel syn-dashboard-stereo">
        <div className="syn-panel-heading"><div><span className="syn-panel-index">05</span><b>STEREO IMAGE</b><small>PHASE / CORRELATION</small></div><Radio size={16}/></div>
        <svg className="syn-vectorscope" viewBox="0 0 220 112" role="img" aria-label="Idle stereo vectorscope display">
          <ellipse cx="110" cy="56" rx="90" ry="42" fill="none" stroke="#31536c" strokeWidth="1"/>
          <ellipse cx="110" cy="56" rx="60" ry="28" fill="none" stroke="#31536c" strokeWidth="1"/>
          <ellipse cx="110" cy="56" rx="30" ry="14" fill="none" stroke="#31536c" strokeWidth="1"/>
          <path d="M20 56H200 M110 12V100 M46 25L174 87 M46 87L174 25" stroke="#28455a" strokeWidth="1"/>
          <path d="M110 56 C84 33 65 39 60 56 C71 74 91 77 110 56 C129 35 149 39 160 56 C150 75 130 77 110 56Z" fill="rgba(59,177,240,.13)" stroke="#52bfff" strokeWidth="1.6" opacity=".55"/>
          <circle cx="110" cy="56" r="2.5" fill="#e5c16f"/>
        </svg>
        <div className="syn-stereo-footer"><span>WIDTH <b>--%</b></span><span>CORRELATION <b>--</b></span><span className="syn-visual-idle">IDLE</span></div>
      </section>

      <section className="syn-dashboard-panel syn-dashboard-chain">
        <div className="syn-panel-heading"><div><span className="syn-panel-index">06</span><b>PROCESSING CHAIN</b><small>STARTER SIGNAL FLOW</small></div><SlidersHorizontal size={16}/></div>
        <div className="syn-chain-flow"><span>EQ</span><i/><span>COMP</span><i/><span>LIMIT</span></div>
        <div className="syn-chain-meta"><span>{processorCount} ACTIVE MODULES</span><span>NON-DESTRUCTIVE</span></div>
        <div className="syn-dashboard-stats"><span>PROJECTS <b>{projectCount}</b></span><span>PRESETS <b>{presetCount}</b></span></div>
      </section>
    </div>

    <footer className="syn-dashboard-utility"><button type="button" onClick={onCalibration}>RUN CALIBRATION SWEEP <ArrowUpRight size={13}/></button><span>Import audio from the left library or load the demo session to activate live meters, spectrum and stereo analysis.</span></footer>
  </section>
);
