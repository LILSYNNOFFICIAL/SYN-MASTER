import React, { useState } from 'react';
import { Plus, RotateCcw, Save } from 'lucide-react';
import type {
  ExternalPluginRecord,
  ExternalVST3Params,
  ProcessorModule,
  ProcessorType,
} from '../types/mastering';
import type { ProcessorMeterTelemetry } from '../dsp/offlineDsp';
import { PROCESSOR_DEFAULT_NAMES, createProcessorModule } from '../dsp/chainValidation';
import { ProcessorModuleCard } from './ProcessorModuleCard';
import { BypassButton } from './controls';

interface Props {
  chain: ProcessorModule[];
  chainBypassed: boolean;
  telemetry: ProcessorMeterTelemetry[];
  guidedMode: boolean;
  externalPlugins?: ExternalPluginRecord[];
  hostConnected?: boolean;
  onChangeChain: (next: ProcessorModule[]) => void;
  onToggleChainBypass: () => void;
  onSaveChain: (name: string) => void;
  onResetChain: () => void;
  onAddExternalPlugin?: (plugin: ExternalPluginRecord) => void | Promise<void>;
  onLoadExternalInstance?: (module: ProcessorModule) => void | Promise<void>;
  onSetExternalParam?: (module: ProcessorModule, paramId: number, valueNormalized: number) => void | Promise<void>;
  onToggleExternalEditor?: (module: ProcessorModule) => void | Promise<void>;
  onToggleExternalBypass?: (module: ProcessorModule) => void | Promise<void>;
}

const NATIVE_PROCESSOR_TYPES: ProcessorType[] = [
  'parametric-eq',
  'dynamic-eq',
  'compressor',
  'multiband-comp',
  'saturation',
  'stereo-imager',
  'restore',
  'bass-enhancer',
  'limiter',
  'maximizer',
];

export const MasteringRack: React.FC<Props> = ({
  chain,
  chainBypassed,
  telemetry,
  guidedMode,
  externalPlugins = [],
  hostConnected = false,
  onChangeChain,
  onToggleChainBypass,
  onSaveChain,
  onResetChain,
  onAddExternalPlugin,
  onLoadExternalInstance,
  onSetExternalParam,
  onToggleExternalEditor,
  onToggleExternalBypass,
}) => {
  const [selectedToAdd, setSelectedToAdd] = useState<string>('parametric-eq');
  const [chainNameInput, setChainNameInput] = useState('');
  const [showSaveInput, setShowSaveInput] = useState(false);

  const availableVst3 = externalPlugins.filter(
    (p) => p.status === 'available' && !p.disabledByUser && p.format === 'vst3',
  );

  const handleAdd = () => {
    if (selectedToAdd.startsWith('vst3::')) {
      const idx = Number(selectedToAdd.slice(6));
      const plugin = availableVst3[idx];
      if (plugin && onAddExternalPlugin) {
        void onAddExternalPlugin(plugin);
      }
      return;
    }
    const mod = createProcessorModule(selectedToAdd as ProcessorType, { expanded: true });
    onChangeChain([...chain, mod]);
  };

  const handleUpdate = (idx: number, updated: ProcessorModule) => {
    const next = [...chain];
    next[idx] = updated;
    onChangeChain(next);
  };

  const handleMove = (idx: number, dir: -1 | 1) => {
    const target = idx + dir;
    if (target < 0 || target >= chain.length) return;
    const next = [...chain];
    const tmp = next[idx];
    next[idx] = next[target];
    next[target] = tmp;
    onChangeChain(next);
  };

  const handleDuplicate = (idx: number) => {
    const src = chain[idx];
    const clonedParams = structuredClone(src.params);
    if (src.type === 'external-vst3') {
      // Duplicate creates a fresh unloaded slot to spawn a dedicated isolated instance
      (clonedParams as ExternalVST3Params).instanceId = null;
      (clonedParams as ExternalVST3Params).status = 'unloaded';
      (clonedParams as ExternalVST3Params).editorOpen = false;
    }
    const copy: ProcessorModule = {
      ...src,
      id: `${src.type}-${Math.random().toString(36).slice(2, 8)}`,
      name: `${src.name} (Copy)`,
      params: clonedParams,
    };
    const next = [...chain];
    next.splice(idx + 1, 0, copy);
    onChangeChain(next);
  };

  const handleRemove = (idx: number) => {
    onChangeChain(chain.filter((_, i) => i !== idx));
  };

  return (
    <aside
      aria-label="Mastering Chain Rack"
      className="w-full lg:w-[384px] shrink-0 bg-[#0D0E13] border-t lg:border-t-0 lg:border-l border-[#222530] flex flex-col lg:h-full overflow-visible lg:overflow-hidden"
    >
      {/* Rack Header */}
      <div className="px-3.5 py-3 border-b border-[#222530] flex items-center justify-between gap-2 bg-[#111217]">
        <div>
          <h2 className="text-xs font-bold tracking-wider uppercase text-[#F2CA52]">
            Mastering Chain Rack
          </h2>
          <p className="text-[11px] text-[#9CA3AF]">
            {chain.filter((m) => m.enabled && !m.bypassed).length} of {chain.length} active stages
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <BypassButton
            active={!chainBypassed}
            showStateText
            accent="gold"
            label={chainBypassed ? 'Enable Entire Chain' : 'Bypass Entire Chain'}
            onToggle={onToggleChainBypass}
          />
          <button
            type="button"
            onClick={() => setShowSaveInput((s) => !s)}
            aria-label="Save Chain Preset"
            className="p-1.5 rounded bg-[#181A22] border border-[#2B2E3A] text-[#C5CDD8] hover:border-[#D4AF37] hover:text-[#F2CA52]"
          >
            <Save className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onResetChain}
            aria-label="Reset Chain"
            className="p-1.5 rounded bg-[#181A22] border border-[#2B2E3A] text-[#C5CDD8] hover:border-[#D4AF37] hover:text-[#F2CA52]"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Save Chain Inline Drawer */}
      {showSaveInput && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!chainNameInput.trim()) return;
            onSaveChain(chainNameInput.trim());
            setChainNameInput('');
            setShowSaveInput(false);
          }}
          className="px-3.5 py-2.5 bg-[#151720] border-b border-[#D4AF37]/30 flex items-center gap-2"
        >
          <input
            type="text"
            value={chainNameInput}
            onChange={(e) => setChainNameInput(e.target.value)}
            placeholder="Chain preset name..."
            aria-label="Chain preset name"
            className="flex-1 bg-[#090A0E] border border-[#2B2E3A] rounded px-2 py-1 text-xs text-[#F7F8FA] focus:outline-none focus:border-[#D4AF37]"
          />
          <button
            type="submit"
            className="px-2.5 py-1 rounded bg-[#D4AF37] text-[#070709] text-xs font-semibold hover:bg-[#F2CA52]"
          >
            Save
          </button>
        </form>
      )}

      {/* Add Processor Control (Native DSP + External VST3) */}
      <div className="px-3.5 py-2.5 border-b border-[#222530] bg-[#101116] flex items-center gap-2">
        <select
          aria-label="Select processor to add"
          value={selectedToAdd}
          onChange={(e) => setSelectedToAdd(e.target.value)}
          className="flex-1 bg-[#181A22] border border-[#2B2E3A] rounded px-2 py-1.5 text-xs text-[#F7F8FA] focus:outline-none focus:border-[#D4AF37]"
        >
          <optgroup label="SYN MASTER Native DSP">
            {NATIVE_PROCESSOR_TYPES.map((t) => (
              <option key={t} value={t}>
                {PROCESSOR_DEFAULT_NAMES[t]}
              </option>
            ))}
          </optgroup>
          <optgroup label={hostConnected ? `External VST3 (${availableVst3.length})` : 'External VST3 (Host Offline)'}>
            {availableVst3.length > 0 ? (
              availableVst3.map((p, i) => (
                <option key={`${p.uid}::${p.bundlePath}`} value={`vst3::${i}`}>
                  [VST3] {p.name} ({p.manufacturer})
                </option>
              ))
            ) : (
              <option value="vst3::none" disabled>
                {hostConnected ? 'No available VST3 plugins scanned' : 'Connect host on Plugins tab'}
              </option>
            )}
          </optgroup>
        </select>
        <button
          type="button"
          onClick={handleAdd}
          disabled={selectedToAdd === 'vst3::none'}
          className="px-2.5 py-1.5 rounded bg-[#D4AF37] text-[#070709] text-xs font-semibold hover:bg-[#F2CA52] disabled:opacity-40 flex items-center gap-1 whitespace-nowrap shrink-0"
        >
          <Plus className="w-3.5 h-3.5" />
          Add
        </button>
      </div>

      {/* Signal Flow Modules */}
      <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2.5">
        {chain.length === 0 ? (
          <div className="p-6 rounded border border-dashed border-[#2A2D39] text-center flex flex-col items-center gap-2">
            <p className="text-xs font-medium text-[#F7F8FA]">Mastering chain is empty</p>
            <p className="text-[11px] text-[#9CA3AF]">
              Add a processor above, pick a preset, or run SYN-MASTER AI to build a custom chain.
            </p>
          </div>
        ) : (
          chain.map((mod, idx) => (
            <React.Fragment key={mod.id}>
              <ProcessorModuleCard
                module={mod}
                index={idx}
                total={chain.length}
                telemetry={telemetry.find((t) => t.id === mod.id)}
                guidedMode={guidedMode}
                hostConnected={hostConnected}
                onUpdate={(u) => handleUpdate(idx, u)}
                onMove={handleMove}
                onDuplicate={handleDuplicate}
                onRemove={handleRemove}
                onLoadExternalInstance={onLoadExternalInstance}
                onSetExternalParam={onSetExternalParam}
                onToggleExternalEditor={onToggleExternalEditor}
                onToggleExternalBypass={onToggleExternalBypass}
              />
              {idx < chain.length - 1 && (
                <div className="flex justify-center -my-1.5">
                  <div className="w-px h-3 bg-[#D4AF37]/40" />
                </div>
              )}
            </React.Fragment>
          ))
        )}
      </div>
    </aside>
  );
};
