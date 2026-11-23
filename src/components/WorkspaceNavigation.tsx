import React, { useEffect, useState } from 'react';
import { AudioLines, BrainCircuit, ChartNoAxesCombined, Equal, GitCompareArrows, Layers3, Menu, PanelLeftClose, ShieldCheck, X } from 'lucide-react';
import type { WorkspaceTab } from '../types/mastering';

type Props = { activeTab: WorkspaceTab; onSelect: (tab: WorkspaceTab) => void };
const GROUPS: { label: string; items: { id: WorkspaceTab; label: string; detail: string; icon: React.ElementType }[] }[] = [
  { label: 'Production', items: [
    { id: 'studio', label: 'Mastering Studio', detail: 'Playback, processing and mastering rack', icon: AudioLines },
    { id: 'ai', label: 'AI Director', detail: 'Intelligent mastering plans and execution', icon: BrainCircuit },
    { id: 'battle', label: 'A/B Battle', detail: 'Compare alternate mastering candidates', icon: GitCompareArrows },
  ]},
  { label: 'Analysis & Quality', items: [
    { id: 'lab', label: 'Analysis Lab', detail: 'Waveform, spectrum and diagnostics', icon: ChartNoAxesCombined },
    { id: 'stems', label: 'Stem Studio', detail: 'Stem intelligence and processing', icon: Layers3 },
    { id: 'reference', label: 'Reference Match', detail: 'Compare against a reference master', icon: Equal },
    { id: 'qc', label: 'Quality Control', detail: 'Delivery targets and verification', icon: ShieldCheck },
  ]},
  { label: 'System', items: [
    { id: 'plugins', label: 'Plugin Manager', detail: 'Windows VST3 companion and plugins', icon: PanelLeftClose },
  ]},
];

export const WorkspaceNavigation: React.FC<Props> = ({ activeTab, onSelect }) => {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKeyDown);
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener('keydown', onKeyDown); };
  }, [open]);
  const activeItem = GROUPS.flatMap(group => group.items).find(item => item.id === activeTab);
  return <>
    <div className="flex items-center justify-between gap-3 pb-1">
      <button type="button" className="syn-workspace-menu-trigger" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open}>
        <Menu size={15} /><span>WORKSPACE</span><span aria-hidden="true" className="text-white/45">/</span><span>{activeItem?.label ?? 'Mastering Studio'}</span>
      </button>
      <span className="hidden sm:block text-[10px] font-mono-tabular uppercase tracking-[.16em] text-[#777]">SYN MASTER · AUDIO WORKSTATION</span>
    </div>
    {open && <>
      <button type="button" className="syn-workspace-menu-backdrop" aria-label="Close workspace menu" onClick={() => setOpen(false)} />
      <aside className="syn-workspace-menu" role="dialog" aria-modal="true" aria-label="SYN MASTER workspace menu">
        <div className="syn-workspace-menu-header">
          <div><div className="syn-workspace-menu-brand">SYN MASTER</div><div className="syn-workspace-menu-caption">Precision audio workstation</div></div>
          <button type="button" className="syn-workspace-menu-close" aria-label="Close menu" onClick={() => setOpen(false)}><X size={16}/></button>
        </div>
        <nav className="syn-workspace-menu-content" aria-label="Workspace sections">
          {GROUPS.map(group => <section className="syn-workspace-menu-group" key={group.label}>
            <h2 className="syn-workspace-menu-label">{group.label}</h2>
            {group.items.map(item => {
              const Icon = item.icon;
              const active = activeTab === item.id;
              return <button key={item.id} type="button" className="syn-workspace-menu-item" aria-current={active ? 'page' : undefined}
                onClick={() => { onSelect(item.id); setOpen(false); }}>
                <Icon size={17} strokeWidth={1.9}/>
                <span className="min-w-0 flex-1"><span className="block">{item.label}</span><span className={`block mt-0.5 text-[10px] font-normal ${active ? 'text-black/60' : 'text-[#777]'}`}>{item.detail}</span></span>
                {active && <span aria-hidden="true" className="text-xs">●</span>}
              </button>;
            })}
          </section>)}
        </nav>
        <div className="syn-workspace-menu-footer">MAIN WORKSPACE · SESSION CONTROLS</div>
      </aside>
    </>}
  </>;
};
