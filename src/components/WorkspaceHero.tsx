import React from 'react';
import type { WorkspaceTab } from '../types/mastering';

type Workspace = Exclude<WorkspaceTab, 'studio' | 'ai'>;
type WorkspaceHeroProps = { workspace: Workspace; hasTrack: boolean };

const COPY: Record<Workspace, { index: string; eyebrow: string; title: string; subtitle: string; detail: string }> = {
  lab: { index: '02', eyebrow: 'SIGNAL ANALYSIS', title: 'ANALYSIS LAB', subtitle: 'MEASURE · INSPECT · UNDERSTAND', detail: 'Frequency, dynamics, stereo image and distortion diagnostics.' },
  stems: { index: '03', eyebrow: 'MULTITRACK INTELLIGENCE', title: 'STEM STUDIO', subtitle: 'SEPARATE · PROCESS · REBUILD', detail: 'Isolate, shape and recombine the elements of your mix.' },
  battle: { index: '04', eyebrow: 'MASTERING A/B EVALUATION', title: 'A/B BATTLE', subtitle: 'THREE MASTERS · ONE WINNER', detail: 'Compare independent mastering approaches with loudness-matched auditioning.' },
  reference: { index: '05', eyebrow: 'REFERENCE ENGINE', title: 'REFERENCE MATCH', subtitle: 'YOUR MIX / YOUR TARGET', detail: 'Compare tonal balance, loudness, dynamics and stereo against a trusted reference.' },
  qc: { index: '06', eyebrow: 'DELIVERY INTEGRITY', title: 'QUALITY CONTROL', subtitle: 'MEASURE · VALIDATE · DELIVER', detail: 'Verify true peak, loudness, dynamics, clipping and mono compatibility.' },
  plugins: { index: '07', eyebrow: 'EXTENSION SYSTEM', title: 'PLUGIN MANAGER', subtitle: 'VST3 / NATIVE HOST BRIDGE', detail: 'Discover, inspect and manage real external plugins through the Windows companion.' },
};

function InstrumentGraphic({ workspace }: { workspace: Workspace }) {
  const grid = Array.from({ length: 7 }, (_, i) => i);
  if (workspace === 'lab') return (
    <svg viewBox="0 0 360 170" role="img" aria-label="Spectrum and frequency analysis illustration">
      {grid.map(i => <g key={i}><line x1="18" y1={20+i*20} x2="342" y2={20+i*20} stroke="#54758c" strokeOpacity=".22" strokeDasharray="3 5"/><line x1={25+i*50} y1="12" x2={25+i*50} y2="150" stroke="#54758c" strokeOpacity=".16"/></g>)}
      <path d="M18 130 C45 128 52 116 65 110 S88 90 104 100 S127 125 145 97 S171 40 190 55 S220 100 239 83 S265 72 279 88 S315 112 342 103" fill="none" stroke="#58c4ff" strokeWidth="2.5"/>
      <path d="M18 130 C45 128 52 116 65 110 S88 90 104 100 S127 125 145 97 S171 40 190 55 S220 100 239 83 S265 72 279 88 S315 112 342 103 L342 150H18Z" fill="#299bd2" fillOpacity=".12"/>
      <path d="M18 112 C55 110 80 108 105 95 S147 85 175 92 S216 115 242 96 S292 80 342 84" fill="none" stroke="#e1bf76" strokeWidth="1.6" strokeDasharray="5 4"/>
      <g fill="#8ca9bd" fontSize="8" fontFamily="monospace"><text x="18" y="163">20 Hz</text><text x="164" y="163">1 kHz</text><text x="307" y="163">20 kHz</text></g>
    </svg>
  );
  if (workspace === 'stems') return (
    <svg viewBox="0 0 360 170" role="img" aria-label="Four separated audio stem lanes illustration">
      {['DRUMS','BASS','MUSIC','VOCALS'].map((name,row)=><g key={name}>
        <text x="8" y={31+row*34} fill="#8da8bb" fontSize="8" fontFamily="monospace">{name}</text>
        <rect x="66" y={17+row*34} width="278" height="19" rx="3" fill="#142536" stroke="#35536a"/>
        {Array.from({length:38},(_,i)=><rect key={i} x={72+i*7} y={19+row*34+(i%3)*2} width="3" height={5+((i*13+row*7)%12)} rx="1" fill={['#55bff4','#d9b66c','#77d9b1','#a4a7ff'][row]} fillOpacity=".8"/>)}
      </g>)}
      <path d="M67 154H344" stroke="#54758c" strokeOpacity=".5"/>
    </svg>
  );
  if (workspace === 'battle') return (
    <svg viewBox="0 0 360 170" role="img" aria-label="Three mastering candidate waveforms illustration">
      {['A','B','C'].map((id,row)=><g key={id}>
        <rect x="12" y={13+row*49} width="336" height="39" rx="5" fill="#101f2d" stroke="#35536a"/>
        <text x="23" y={36+row*49} fill="#e0c27a" fontSize="11" fontFamily="monospace" fontWeight="bold">{id}</text>
        {Array.from({length:68},(_,i)=><line key={i} x1={52+i*4.1} x2={52+i*4.1} y1={32+row*49-((i*17+row*9)%19)} y2={32+row*49+((i*11+row*13)%19)} stroke={['#62c9ff','#e1c27b','#80dcb5'][row]} strokeWidth="1.5" strokeOpacity=".85"/>)}
      </g>)}
    </svg>
  );
  if (workspace === 'reference') return (
    <svg viewBox="0 0 360 170" role="img" aria-label="Two overlaid reference spectrum curves illustration">
      {grid.map(i => <g key={i}><line x1="18" y1={20+i*20} x2="342" y2={20+i*20} stroke="#54758c" strokeOpacity=".2"/><line x1={25+i*50} y1="12" x2={25+i*50} y2="150" stroke="#54758c" strokeOpacity=".14"/></g>)}
      <path d="M18 127 C50 127 60 110 80 104 S113 75 137 82 S167 112 191 88 S225 40 249 56 S290 93 342 76" fill="none" stroke="#55c4ff" strokeWidth="2.5"/>
      <path d="M18 118 C50 118 60 101 80 96 S113 82 137 88 S167 99 191 79 S225 52 249 64 S290 83 342 86" fill="none" stroke="#e4bf70" strokeWidth="2" strokeDasharray="5 4"/>
      <g fill="#9db5c7" fontSize="8" fontFamily="monospace"><text x="22" y="160">SOURCE</text><text x="286" y="160">REFERENCE</text></g>
    </svg>
  );
  if (workspace === 'qc') return (
    <svg viewBox="0 0 360 170" role="img" aria-label="Loudness and peak quality control instrument illustration">
      <path d="M40 132 A90 90 0 0 1 220 132" fill="none" stroke="#28475d" strokeWidth="12" strokeLinecap="round"/>
      <path d="M40 132 A90 90 0 0 1 178 52" fill="none" stroke="#55bfff" strokeWidth="5" strokeLinecap="round"/>
      <path d="M130 132L178 65" stroke="#e4c477" strokeWidth="2.5"/><circle cx="130" cy="132" r="6" fill="#e4c477"/>
      <g fill="#8fa9bb" fontSize="8" fontFamily="monospace"><text x="32" y="149">-24</text><text x="119" y="34">-14</text><text x="222" y="149">0 LUFS</text></g>
      {Array.from({length:12},(_,i)=><rect key={i} x={250+i*7} y={125-(i%4)*7} width="4" height={15+(i%4)*7} rx="1" fill={i>9?'#d8b66a':'#52bdf3'} fillOpacity=".85"/>)}
      <text x="252" y="151" fill="#8fa9bb" fontSize="8" fontFamily="monospace">TRUE PEAK</text>
    </svg>
  );
  return (
    <svg viewBox="0 0 360 170" role="img" aria-label="Native plugin host processor chip illustration">
      <rect x="116" y="29" width="128" height="108" rx="10" fill="#13283a" stroke="#5abce9" strokeWidth="1.5"/>
      <rect x="135" y="47" width="90" height="72" rx="5" fill="#091521" stroke="#d7b66d" strokeOpacity=".7"/>
      <path d="M151 94V73L163 61L175 73V94M185 94V67H207V94" fill="none" stroke="#6ccaff" strokeWidth="2"/>
      {Array.from({length:8},(_,i)=><g key={i}><path d={'M'+(130+i*14)+' 29V15M'+(130+i*14)+' 137V151'} stroke="#5abce9" strokeWidth="2"/><path d={'M116 '+(40+i*13)+'H101M244 '+(40+i*13)+'H259'} stroke="#5abce9" strokeWidth="2"/></g>)}
      <g fill="#91b1c8" fontSize="8" fontFamily="monospace"><text x="12" y="82">VST3</text><text x="277" y="82">HOST</text></g>
      <path d="M46 78H99M260 78H314" stroke="#4aa9d7" strokeDasharray="4 5"/>
    </svg>
  );
}

export const WorkspaceHero: React.FC<WorkspaceHeroProps> = ({ workspace, hasTrack }) => {
  const copy = COPY[workspace];
  const sourceIndependent = workspace === 'plugins';
  const status = sourceIndependent ? 'SYSTEM WORKSPACE' : hasTrack ? 'SOURCE LOADED' : 'AWAITING SOURCE AUDIO';
  return (
    <header className={'syn-workspace-hero syn-workspace-hero-' + workspace} data-testid="workspace-hero" data-workspace={workspace}>
      <div className="syn-workspace-hero-copy">
        <div className="syn-workspace-hero-eyebrow"><span>{copy.index}</span>{copy.eyebrow}</div>
        <h1>{copy.title}</h1>
        <div className="syn-workspace-hero-subtitle">{copy.subtitle}</div>
        <p>{copy.detail}</p>
        <div className={'syn-workspace-hero-status ' + (hasTrack || sourceIndependent ? 'is-ready' : '')}><i/>{status}</div>
      </div>
      <div className="syn-workspace-hero-art" data-testid="workspace-hero-graphic">
        <InstrumentGraphic workspace={workspace}/>
        <span>INSTRUMENT GRAPHIC · NOT MEASURED SOURCE DATA</span>
      </div>
      <div className="syn-workspace-hero-index">SYN / {copy.index}</div>
    </header>
  );
};
