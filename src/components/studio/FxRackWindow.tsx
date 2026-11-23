import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, GripVertical, Plus, Power, Sparkles, Trash2, Copy } from 'lucide-react';
import type { ParametricEQParams, ProcessorModule, ProcessorType } from '../../types/mastering';
import type { ProcessorMeterTelemetry } from '../../dsp/offlineDsp';
import { ProcessorModuleCard } from '../ProcessorModuleCard';
import { FloatingWindow } from './FloatingWindow';
import { CATALOG_CATEGORIES, MODULE_CATALOG } from './moduleCatalog';
import { ParametricEQ2 } from './ParametricEQ2';
import type { AudioAnalysis } from '../../types/mastering';

interface Props {
  open: boolean;
  onClose: () => void;
  chain: ProcessorModule[];
  chainBypassed: boolean;
  telemetry: ProcessorMeterTelemetry[];
  onChangeChain: (next: ProcessorModule[]) => void;
  onToggleChainBypass: () => void;
  onAiSetAll?: () => void;
  aiRunning?: boolean;
  sampleRate: number;
  spectrum?: AudioAnalysis | null;
}

const TYPE_BADGE: Record<ProcessorType, string> = {
  'parametric-eq': 'EQ',
  'dynamic-eq': 'DEQ',
  compressor: 'COMP',
  'multiband-comp': 'MB',
  saturation: 'SAT',
  'stereo-imager': 'IMG',
  restore: 'FIX',
  'bass-enhancer': 'BASS',
  limiter: 'LIM',
  maximizer: 'MAX',
  'external-vst3': 'VST3',
};

/** "Add module" dropdown: grouped catalog with descriptions. */
const AddModuleMenu: React.FC<{ onAdd: (m: ProcessorModule) => void }> = ({ onAdd }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="syn2-addmenu" ref={ref}>
      <button type="button" className="syn2-btn-gold" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
        <Plus className="w-4 h-4" /> Add module <ChevronDown className="w-3.5 h-3.5" />
      </button>
      {open && (
        <div className="syn2-addmenu-pop" role="menu">
          {CATALOG_CATEGORIES.map((cat) => (
            <div key={cat} className="syn2-addmenu-group">
              <div className="syn2-addmenu-cat">{cat}</div>
              {MODULE_CATALOG.filter((c) => c.category === cat).map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="menuitem"
                  className="syn2-addmenu-item"
                  onClick={() => {
                    onAdd(c.build());
                    setOpen(false);
                  }}
                >
                  <span className="syn2-addmenu-badge">{TYPE_BADGE[c.type]}</span>
                  <span className="min-w-0">
                    <span className="syn2-addmenu-label">{c.label}</span>
                    <span className="syn2-addmenu-desc">{c.description}</span>
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

/** Floating, chainable FX rack: reorder (drag or arrows), bypass, add/remove, per-module knobs. */
export const FxRackWindow: React.FC<Props> = ({
  open,
  onClose,
  chain,
  chainBypassed,
  telemetry,
  onChangeChain,
  onToggleChainBypass,
  onAiSetAll,
  aiRunning = false,
  sampleRate,
  spectrum,
}) => {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const chainRef = useRef(chain);
  chainRef.current = chain;
  const telemetryById = useMemo(() => new Map(telemetry.map((t) => [t.id, t] as const)), [telemetry]);

  const update = (idx: number, mod: ProcessorModule) => {
    const next = [...chainRef.current];
    next[idx] = mod;
    onChangeChain(next);
  };
  const moveTo = (from: number, to: number) => {
    if (from === to || to < 0 || to >= chainRef.current.length) return;
    const next = [...chainRef.current];
    const [m] = next.splice(from, 1);
    next.splice(to, 0, m);
    onChangeChain(next);
  };
  const remove = (idx: number) => onChangeChain(chainRef.current.filter((_, i) => i !== idx));
  const duplicate = (idx: number) => {
    const src = chainRef.current[idx];
    if (!src || src.type === 'external-vst3') return;
    const copy: ProcessorModule = { ...structuredClone(src), id: `${src.type}-${Math.random().toString(36).slice(2, 8)}`, name: `${src.name} (Copy)` };
    const next = [...chainRef.current];
    next.splice(idx + 1, 0, copy);
    onChangeChain(next);
  };

  const active = chain.filter((m) => m.enabled && !m.bypassed).length;

  return (
    <FloatingWindow
      id="fx-rack"
      open={open}
      onClose={onClose}
      title={<span>FX Rack <em className="syn2-float-sub">{active}/{chain.length} active</em></span>}
      initial={{ w: 560, h: 680 }}
      minW={380}
      minH={260}
    >
      <div className="syn2-rack-toolbar">
        <AddModuleMenu
          onAdd={(m) => {
            onChangeChain([...chainRef.current, m]);
            setExpandedId(m.id);
          }}
        />
        <button type="button" className={`syn2-btn-ghost ${chainBypassed ? 'is-warn' : ''}`} onClick={onToggleChainBypass}>
          <Power className="w-4 h-4" /> {chainBypassed ? 'Chain bypassed' : 'Bypass all'}
        </button>
        {onAiSetAll && (
          <button type="button" className="syn2-btn-ghost" onClick={onAiSetAll} disabled={aiRunning}>
            <Sparkles className="w-4 h-4" /> {aiRunning ? 'AI working…' : 'AI: set every module'}
          </button>
        )}
      </div>

      {chain.length === 0 && <div className="syn2-rack-empty">The chain is empty. Add a module, or let the AI build one.</div>}

      <ol className="syn2-rack-list">
        {chain.map((mod, idx) => {
          const t = telemetryById.get(mod.id);
          const on = mod.enabled && !mod.bypassed;
          const expanded = expandedId === mod.id;
          return (
            <li
              key={mod.id}
              className={`syn2-slot ${on ? '' : 'is-off'} ${overIdx === idx && dragIdx !== null && dragIdx !== idx ? 'is-over' : ''}`}
              onDragOver={(e) => {
                if (dragIdx === null) return;
                e.preventDefault();
                setOverIdx(idx);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragIdx !== null) moveTo(dragIdx, idx);
                setDragIdx(null);
                setOverIdx(null);
              }}
            >
              <div className="syn2-slot-row">
                <span
                  className="syn2-slot-grip"
                  draggable
                  onDragStart={(e) => {
                    setDragIdx(idx);
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', String(idx));
                  }}
                  onDragEnd={() => {
                    setDragIdx(null);
                    setOverIdx(null);
                  }}
                  title="Drag to reorder"
                  aria-label={`Reorder ${mod.name}`}
                >
                  <GripVertical className="w-4 h-4" />
                </span>
                <span className="syn2-slot-num">{idx + 1}</span>
                <span className="syn2-slot-badge">{TYPE_BADGE[mod.type]}</span>
                <button type="button" className="syn2-slot-name" onClick={() => setExpandedId(expanded ? null : mod.id)} aria-expanded={expanded}>
                  {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                  <span className="truncate">{mod.name}</span>
                </button>
                <span className="syn2-slot-meter" title="Gain reduction">
                  {t && t.gainReductionDb > 0.05 ? `-${t.gainReductionDb.toFixed(1)} dB` : ''}
                </span>
                <div className="syn2-slot-actions">
                  <button type="button" aria-label="Move up" disabled={idx === 0} onClick={() => moveTo(idx, idx - 1)}>▲</button>
                  <button type="button" aria-label="Move down" disabled={idx === chain.length - 1} onClick={() => moveTo(idx, idx + 1)}>▼</button>
                  <button type="button" aria-label="Duplicate" onClick={() => duplicate(idx)}><Copy className="w-3.5 h-3.5" /></button>
                  <button
                    type="button"
                    className={`syn2-slot-power ${on ? 'is-on' : ''}`}
                    aria-label={on ? `Bypass ${mod.name}` : `Enable ${mod.name}`}
                    aria-pressed={on}
                    onClick={() => update(idx, { ...mod, enabled: true, bypassed: on })}
                  >
                    <Power className="w-3.5 h-3.5" />
                  </button>
                  <button type="button" aria-label={`Remove ${mod.name}`} onClick={() => remove(idx)}><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              </div>
              {expanded && (
                <div className="syn2-slot-body">
                  {mod.type === 'parametric-eq' && (
                    <ParametricEQ2
                      params={mod.params as ParametricEQParams}
                      sampleRate={sampleRate}
                      spectrum={spectrum ?? null}
                      onChange={(params) => update(idx, { ...mod, params })}
                    />
                  )}
                  <ProcessorModuleCard
                    module={{ ...mod, expanded: true }}
                    index={idx}
                    total={chain.length}
                    telemetry={t}
                    onUpdateAt={(i, m) => update(i, { ...m, expanded: mod.expanded })}
                    onMove={(i, dir) => moveTo(i, i + dir)}
                    onDuplicate={duplicate}
                    onRemove={remove}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </FloatingWindow>
  );
};
