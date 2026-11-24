import React, { useEffect, useState } from 'react';
import {
  Activity,
  AudioWaveform,
  Download,
  Gauge,
  LayoutDashboard,
  MoreHorizontal,
  Settings,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import type { WorkspaceTab } from '../types/mastering';

type Props = {
  activeTab: WorkspaceTab;
  onSelect: (tab: WorkspaceTab) => void;
  onOpenRack: () => void;
  onExport: () => void;
  onSettings: () => void;
  onStereoWorkspace: () => void;
};

const ADVANCED_GROUPS: { label: string; items: { id: WorkspaceTab; label: string; detail: string }[] }[] = [
  { label: 'AI & Production', items: [
    { id: 'ai', label: 'AI Director', detail: 'Mastering plans, execution and diagnostics' },
    { id: 'battle', label: 'A/B Battle', detail: 'Compare alternate mastering candidates' },
    { id: 'stems', label: 'Stem Studio', detail: 'Stem intelligence and processing' },
  ]},
  { label: 'Analysis & Quality', items: [
    { id: 'lab', label: 'Analysis Lab', detail: 'Spectrum, dynamics and stereo analysis' },
    { id: 'reference', label: 'Reference Match', detail: 'Compare against a reference master' },
    { id: 'qc', label: 'Quality Control', detail: 'Delivery targets and verification' },
  ]},
  { label: 'System', items: [
    { id: 'plugins', label: 'Plugin Manager', detail: 'Windows VST3 companion and plugins' },
  ]},
];

const PRIMARY_ITEMS = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { key: 'equalizer', label: 'Equalizer', icon: SlidersHorizontal },
  { key: 'dynamics', label: 'Dynamics', icon: Activity },
  { key: 'stereo', label: 'Stereo', icon: AudioWaveform },
  { key: 'loudness', label: 'Loudness', icon: Gauge },
] as const;

export const WorkspaceNavigation: React.FC<Props> = ({
  activeTab,
  onSelect,
  onOpenRack,
  onExport,
  onSettings,
  onStereoWorkspace,
}) => {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [selectedPrimary, setSelectedPrimary] = useState<string>('dashboard');

  useEffect(() => {
    if (activeTab === 'lab') setSelectedPrimary('stereo');
    else if (activeTab === 'qc') setSelectedPrimary('loudness');
    else if (activeTab !== 'studio') setSelectedPrimary('more');
    else if (!['dashboard', 'equalizer', 'dynamics'].includes(selectedPrimary)) setSelectedPrimary('dashboard');

    if (activeTab === 'studio' && selectedPrimary === 'equalizer') {
      document.querySelector('[data-testid="central-spectrum"]')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [activeTab, selectedPrimary]);

  useEffect(() => {
    if (!advancedOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAdvancedOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [advancedOpen]);

  const choosePrimary = (key: string) => {
    setSelectedPrimary(key);
    if (key === 'stereo') onStereoWorkspace();
    else if (key === 'loudness') onSelect('qc');
    else {
      onSelect('studio');
      if (key === 'dynamics') onOpenRack();
    }
  };

  return (
    <div className="syn-primary-nav-wrap">
      <nav className="syn-primary-nav" aria-label="Mastering workspaces">
        {PRIMARY_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = selectedPrimary === item.key;
          return (
            <button
              key={item.key}
              type="button"
              className="syn-primary-nav-item"
              data-active={active ? 'true' : 'false'}
              aria-current={active ? 'page' : undefined}
              onClick={() => choosePrimary(item.key)}
            >
              <Icon size={15} strokeWidth={1.9} />
              <span>{item.label}</span>
            </button>
          );
        })}
        <button type="button" className="syn-primary-nav-item" onClick={onExport}>
          <Download size={15} strokeWidth={1.9} /><span>Export</span>
        </button>
        <button type="button" className="syn-primary-nav-item" onClick={onSettings}>
          <Settings size={15} strokeWidth={1.9} /><span>Settings</span>
        </button>
        <button
          type="button"
          className="syn-primary-nav-item syn-primary-nav-more"
          aria-haspopup="dialog"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen(true)}
        >
          <MoreHorizontal size={16} /><span>More</span>
        </button>
      </nav>

      {advancedOpen && (
        <>
          <button
            type="button"
            className="syn-workspace-menu-backdrop"
            aria-label="Close advanced workspace menu"
            onClick={() => setAdvancedOpen(false)}
          />
          <aside className="syn-workspace-menu" role="dialog" aria-modal="true" aria-label="Advanced SYN MASTER workspaces">
            <div className="syn-workspace-menu-header">
              <div>
                <div className="syn-workspace-menu-brand">SYN MASTER</div>
                <div className="syn-workspace-menu-caption">Advanced workspaces</div>
              </div>
              <button type="button" className="syn-workspace-menu-close" aria-label="Close menu" onClick={() => setAdvancedOpen(false)}>
                <X size={16} />
              </button>
            </div>
            <nav className="syn-workspace-menu-content" aria-label="Advanced workspace sections">
              {ADVANCED_GROUPS.map((group) => (
                <section className="syn-workspace-menu-group" key={group.label}>
                  <h2 className="syn-workspace-menu-label">{group.label}</h2>
                  {group.items.map((item) => {
                    const active = activeTab === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        className="syn-workspace-menu-item"
                        aria-current={active ? 'page' : undefined}
                        onClick={() => {
                          setSelectedPrimary('more');
                          onSelect(item.id);
                          setAdvancedOpen(false);
                        }}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block">{item.label}</span>
                          <span className={`block mt-0.5 text-[10px] font-normal ${active ? 'text-black/60' : 'text-[#9CB5C8]'}`}>{item.detail}</span>
                        </span>
                        {active && <span aria-hidden="true" className="text-xs">●</span>}
                      </button>
                    );
                  })}
                </section>
              ))}
            </nav>
            <div className="syn-workspace-menu-footer">ADVANCED TOOLS · SESSION WORKSPACES</div>
          </aside>
        </>
      )}
    </div>
  );
};
