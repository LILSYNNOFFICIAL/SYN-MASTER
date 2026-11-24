import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  FolderPlus,
  History,
  Link2,
  Link2Off,
  Play,
  Plug,
  Plus,
  Power,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldAlert,
  Square,
  Star,
  Trash2,
  Volume2,
  Wrench,
} from 'lucide-react';
import type {
  ExternalPluginRecord,
  PluginFormat,
  PluginStatus,
} from '../types/mastering';
import type { HostBridgeSnapshot } from '../services/hostBridge';

interface PluginManagerViewProps {
  snapshot: HostBridgeSnapshot;
  hasTrack?: boolean;
  onConnect: (opts: { hostPort: number; pairingCode?: string }) => Promise<boolean>;
  onDisconnect: () => void;
  onScan: (mode: 'incremental' | 'full' | 'force') => Promise<void>;
  onRetryPlugin: (uid: string, bundlePath: string) => Promise<void>;
  onAddDirectory: (path: string) => Promise<void>;
  onRemoveDirectory: (path: string) => Promise<void>;
  onToggleFavorite: (plugin: ExternalPluginRecord) => Promise<void>;
  onToggleDisabled: (plugin: ExternalPluginRecord) => Promise<void>;
  onInsertInChain?: (plugin: ExternalPluginRecord) => Promise<void>;
  onStartWasapiAudition?: (deviceId: string) => Promise<void>;
  onStopWasapiAudition?: () => Promise<void>;
}

const FORMAT_LABELS: Array<{ id: 'all' | PluginFormat; label: string }> = [
  { id: 'all', label: 'All Formats' },
  { id: 'vst3', label: 'VST3' },
  { id: 'clap', label: 'CLAP (Future)' },
  { id: 'au', label: 'AU (macOS)' },
  { id: 'lv2', label: 'LV2 (Linux)' },
];

function statusBadgeStyle(status: PluginStatus, disabledByUser: boolean): {
  label: string;
  classes: string;
} {
  if (disabledByUser || status === 'disabled') {
    return {
      label: 'Disabled',
      classes: 'bg-[#20232E] text-[#9CA3AF] border-[#333848]',
    };
  }
  switch (status) {
    case 'available':
      return {
        label: 'Available',
        classes: 'bg-[#10B981]/15 text-[#34D399] border-[#10B981]/40',
      };
    case 'quarantined':
      return {
        label: 'Quarantined',
        classes: 'bg-[#EF4444]/15 text-[#F87171] border-[#EF4444]/40',
      };
    case 'scan_failed':
      return {
        label: 'Scan Failed',
        classes: 'bg-[#F59E0B]/15 text-[#FBBF24] border-[#F59E0B]/40',
      };
    case 'incompatible':
      return {
        label: 'Incompatible Arch',
        classes: 'bg-[#F97316]/15 text-[#FB923C] border-[#F97316]/40',
      };
    case 'missing':
      return {
        label: 'Missing on Disk',
        classes: 'bg-[#6B7280]/15 text-[#9CA3AF] border-[#6B7280]/40',
      };
    default:
      return {
        label: status,
        classes: 'bg-[#20232E] text-[#C5CDD8] border-[#333848]',
      };
  }
}

export const PluginManagerView: React.FC<PluginManagerViewProps> = ({
  snapshot,
  hasTrack = false,
  onConnect,
  onDisconnect,
  onScan,
  onRetryPlugin,
  onAddDirectory,
  onRemoveDirectory,
  onToggleFavorite,
  onToggleDisabled,
  onInsertInChain,
  onStartWasapiAudition,
  onStopWasapiAudition,
}) => {
  const [hostPortInput, setHostPortInput] = useState(String(snapshot.hostPort || 47832));
  const [pairingCodeInput, setPairingCodeInput] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [selectedWasapiDeviceId, setSelectedWasapiDeviceId] = useState('');

  const [newFolderInput, setNewFolderInput] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  // Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [formatFilter, setFormatFilter] = useState<'all' | PluginFormat>('all');
  const [manufacturerFilter, setManufacturerFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'available' | 'issues' | 'favorites' | 'recent'>('all');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const isConnected = snapshot.status === 'connected';

  const manufacturers = useMemo(() => {
    const set = new Set<string>();
    for (const p of snapshot.plugins) {
      if (p.manufacturer) set.add(p.manufacturer);
    }
    return ['all', ...Array.from(set).sort()];
  }, [snapshot.plugins]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const p of snapshot.plugins) {
      if (p.category) set.add(p.category);
    }
    return ['all', ...Array.from(set).sort()];
  }, [snapshot.plugins]);

  const counts = useMemo(() => {
    let available = 0;
    let issues = 0;
    let favorites = 0;
    for (const p of snapshot.plugins) {
      if (p.status === 'available' && !p.disabledByUser) available += 1;
      if (p.status === 'scan_failed' || p.status === 'quarantined' || p.status === 'incompatible' || p.status === 'missing') {
        issues += 1;
      }
      if (p.favorite) favorites += 1;
    }
    return { total: snapshot.plugins.length, available, issues, favorites };
  }, [snapshot.plugins]);

  const filteredPlugins = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const list = snapshot.plugins.filter((p) => {
      if (formatFilter !== 'all' && p.format !== formatFilter) return false;
      if (manufacturerFilter !== 'all' && p.manufacturer !== manufacturerFilter) return false;
      if (categoryFilter !== 'all' && p.category !== categoryFilter) return false;
      if (statusFilter === 'available' && (p.status !== 'available' || p.disabledByUser)) return false;
      if (
        statusFilter === 'issues' &&
        p.status !== 'scan_failed' &&
        p.status !== 'quarantined' &&
        p.status !== 'incompatible' &&
        p.status !== 'missing'
      ) {
        return false;
      }
      if (statusFilter === 'favorites' && !p.favorite) return false;
      if (statusFilter === 'recent' && (!p.lastUsedAt || p.lastUsedAt <= 0)) return false;
      if (q) {
        const hay = `${p.name} ${p.manufacturer} ${p.category} ${p.uid} ${p.bundlePath}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    if (statusFilter === 'recent') {
      return [...list].sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0));
    }
    return list;
  }, [
    snapshot.plugins,
    searchQuery,
    formatFilter,
    manufacturerFilter,
    categoryFilter,
    statusFilter,
  ]);

  const selectedPlugin = useMemo(() => {
    if (!selectedKey) return filteredPlugins[0] ?? null;
    return (
      snapshot.plugins.find((p) => `${p.uid}::${p.bundlePath}` === selectedKey) ??
      filteredPlugins[0] ??
      null
    );
  }, [selectedKey, snapshot.plugins, filteredPlugins]);

  const handleConnectSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionError(null);
    const port = Number(hostPortInput);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setActionError('Enter a valid localhost port (1-65535).');
      return;
    }
    setConnecting(true);
    try {
      await onConnect({
        hostPort: port,
        pairingCode: pairingCodeInput.trim() || undefined,
      });
    } finally {
      setConnecting(false);
    }
  };

  const handleAddFolder = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionError(null);
    const path = newFolderInput.trim();
    if (!path) return;
    try {
      await onAddDirectory(path);
      setNewFolderInput('');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to add scan directory');
    }
  };

  const progressPct =
    snapshot.scanProgress && snapshot.scanProgress.total > 0
      ? Math.round((snapshot.scanProgress.completed / snapshot.scanProgress.total) * 100)
      : 0;

  return (
    <div className="flex flex-col gap-4 pb-6">
      {/* Header & Milestone 1 Scope Banner */}
      <section className="p-4 rounded bg-[#111217] border border-[#242732] flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Plug className="w-4 h-4 text-[#F2CA52]" />
              <h1 className="font-display text-base font-bold text-[#F7F8FA]">
                SYN-PLUGIN HOST — Native Plugin Manager
              </h1>
              <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-[#D4AF37]/15 text-[#F2CA52] border border-[#D4AF37]/40">
                Milestone 2: VST3 Hosting &amp; Audio
              </span>
            </div>
            <p className="mt-1 text-xs text-[#9CA3AF]">
              Connects securely to the Windows 11 <span className="font-mono-tabular text-[#C5CDD8]">syn-plugin-host.exe</span> companion on <span className="font-mono-tabular text-[#C5CDD8]">127.0.0.1</span> for isolated out-of-process VST3 hosting, parameter control, native editor windows, and sequential mixed-chain mastering.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <span
              className={`px-2.5 py-1 rounded text-[11px] font-semibold border flex items-center gap-1.5 ${
                isConnected
                  ? 'bg-[#10B981]/15 text-[#34D399] border-[#10B981]/40'
                  : snapshot.status === 'pairing-required'
                  ? 'bg-[#F59E0B]/15 text-[#FBBF24] border-[#F59E0B]/40'
                  : 'bg-[#181A22] text-[#C5CDD8] border-[#2B2E3A]'
              }`}
            >
              {isConnected ? (
                <Link2 className="w-3.5 h-3.5" />
              ) : (
                <Link2Off className="w-3.5 h-3.5" />
              )}
              {isConnected
                ? `Host Connected (127.0.0.1:${snapshot.hostPort})`
                : snapshot.status === 'connecting'
                ? 'Connecting to Host...'
                : snapshot.status === 'pairing-required'
                ? 'Pairing Required'
                : snapshot.status === 'disconnected'
                ? 'Reconnecting...'
                : snapshot.status === 'unavailable'
                ? 'Host Unavailable'
                : 'Browser-Only Mode (No Host Paired)'}
            </span>

            {isConnected && (
              <button
                type="button"
                onClick={onDisconnect}
                className="px-2.5 py-1 rounded bg-[#181A22] border border-[#2B2E3A] text-xs text-[#F87171] hover:border-[#EF4444]"
              >
                Disconnect
              </button>
            )}
          </div>
        </div>

        {/* Connection & Pairing Form */}
        {!isConnected && (
          <form
            onSubmit={handleConnectSubmit}
            className="p-3 rounded bg-[#090A0E] border border-[#242732] flex flex-wrap items-end gap-3"
          >
            <label className="flex flex-col gap-1 text-[11px] text-[#9CA3AF]">
              Host Port (127.0.0.1)
              <input
                type="number"
                aria-label="Host Port"
                value={hostPortInput}
                onChange={(e) => setHostPortInput(e.target.value)}
                className="w-28 bg-[#111217] border border-[#2B2E3A] rounded px-2.5 py-1.5 text-xs font-mono-tabular text-[#F7F8FA] focus:outline-none focus:border-[#D4AF37]"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-[#9CA3AF] flex-1 min-w-[200px]">
              Pairing Code (shown by syn-plugin-host.exe on startup)
              <input
                type="text"
                aria-label="Pairing Code"
                placeholder="SYN-XXXX-XXXX"
                value={pairingCodeInput}
                onChange={(e) => setPairingCodeInput(e.target.value.toUpperCase())}
                className="bg-[#111217] border border-[#2B2E3A] rounded px-3 py-1.5 text-xs font-mono-tabular text-[#F7F8FA] focus:outline-none focus:border-[#D4AF37]"
              />
            </label>
            <button
              type="submit"
              disabled={connecting}
              className="px-4 py-1.5 rounded bg-[#D4AF37] text-[#070709] text-xs font-bold hover:bg-[#F2CA52] disabled:opacity-50"
            >
              {connecting ? 'Connecting...' : 'Pair & Connect Host'}
            </button>
          </form>
        )}

        {(snapshot.lastError || actionError) && (
          <div className="p-2.5 rounded bg-[#EF4444]/10 border border-[#EF4444]/40 text-xs text-[#FCA5A5] flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-[#F87171]" />
            <span>{actionError || snapshot.lastError}</span>
          </div>
        )}

        {snapshot.httpsPnaWarning && (
          <div className="p-2.5 rounded bg-[#D4AF37]/10 border border-[#D4AF37]/30 text-[11px] text-[#E5C76B]">
            <strong>HTTPS / Loopback Notice:</strong> {snapshot.httpsPnaWarning}
          </div>
        )}
      </section>

      {/* Browser-Only Honest Empty State */}
      {!isConnected && snapshot.plugins.length === 0 ? (
        <section data-testid="workspace-empty-state" data-workspace="plugins" className="syn-workspace-empty syn-workspace-empty-plugins p-6 rounded bg-[#111217] border border-[#242732] grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="flex flex-col gap-3">
            <h2 className="font-display text-sm font-bold text-[#F2CA52] uppercase tracking-wider">
              Windows 11 Companion Host Required for Native Plugins
            </h2>
            <p className="text-xs text-[#C5CDD8] leading-relaxed">
              Web browsers sandbox local filesystem access and cannot directly load native C++/COM <span className="font-mono-tabular">.vst3</span> binaries. SYN MASTER preserves 100% of its Web Audio DSP mastering chain in Browser-Only mode, while external third-party plugin discovery runs through the local Windows x64 companion (<span className="font-mono-tabular">syn-plugin-host.exe</span>).
            </p>
            <div className="p-3 rounded bg-[#090A0E] border border-[#242732] text-[11px] text-[#9CA3AF] space-y-1.5">
              <div className="font-semibold text-[#F7F8FA]">Quick Start on Windows 11 x64:</div>
              <div>1. Build <span className="font-mono-tabular text-[#D4AF37]">native/CMakeLists.txt</span> with Visual Studio 2022 (<span className="font-mono-tabular">cmake --preset windows-x64-release</span>).</div>
              <div>2. Launch <span className="font-mono-tabular text-[#D4AF37]">syn-plugin-host.exe</span> — it binds strictly to <span className="font-mono-tabular">127.0.0.1:47832</span> and prints a CSPRNG pairing code.</div>
              <div>3. Enter the pairing code above and click <strong>Pair &amp; Connect Host</strong> to scan your VST3 directories.</div>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <h2 className="font-display text-sm font-bold text-[#F7F8FA] uppercase tracking-wider">
              Milestone 2 Architecture Guarantees
            </h2>
            <ul className="space-y-2 text-xs text-[#9CA3AF]">
              <li className="flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 text-[#34D399] shrink-0 mt-0.5" />
                <span><strong className="text-[#F7F8FA]">Crash-Isolated Workers:</strong> Each VST3 instance runs inside an isolated <span className="font-mono-tabular">syn-plugin-worker.exe</span> child process under Win32 Job Objects so plugin faults never crash SYN MASTER.</span>
              </li>
              <li className="flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 text-[#34D399] shrink-0 mt-0.5" />
                <span><strong className="text-[#F7F8FA]">Mixed Mastering Chain:</strong> Insert scanned VST3 plugins alongside native SYN MASTER EQ/Comp/Limiter stages with latency compensation and WAV export integration.</span>
              </li>
              <li className="flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 text-[#34D399] shrink-0 mt-0.5" />
                <span><strong className="text-[#F7F8FA]">Zero Fabricated Audio:</strong> No simulated audio or fake third-party plugins are ever generated when no real companion host is connected.</span>
              </li>
            </ul>
          </div>
        </section>
      ) : (
        <>
          {/* Scan Controls & Directories Panel */}
          <section className="p-4 rounded bg-[#111217] border border-[#242732] flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={!isConnected || snapshot.isScanning}
                  onClick={() => void onScan('incremental')}
                  className="px-3.5 py-1.5 rounded bg-[#D4AF37] text-[#070709] text-xs font-bold hover:bg-[#F2CA52] disabled:opacity-50 flex items-center gap-1.5"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${snapshot.isScanning ? 'animate-spin' : ''}`} />
                  Scan New / Changed
                </button>
                <button
                  type="button"
                  disabled={!isConnected || snapshot.isScanning}
                  onClick={() => void onScan('full')}
                  className="px-3 py-1.5 rounded bg-[#181A22] border border-[#2B2E3A] text-xs font-semibold text-[#F7F8FA] hover:border-[#D4AF37] disabled:opacity-50"
                >
                  Rescan All
                </button>
                <button
                  type="button"
                  disabled={!isConnected || snapshot.isScanning}
                  onClick={() => void onScan('force')}
                  className="px-3 py-1.5 rounded bg-[#181A22] border border-[#2B2E3A] text-xs font-semibold text-[#C5CDD8] hover:border-[#D4AF37] disabled:opacity-50"
                >
                  Force Rescan (Clear Quarantine)
                </button>
                <button
                  type="button"
                  onClick={() => setShowHistory((h) => !h)}
                  className="px-3 py-1.5 rounded bg-[#181A22] border border-[#2B2E3A] text-xs font-semibold text-[#C5CDD8] hover:border-[#D4AF37] flex items-center gap-1.5"
                >
                  <History className="w-3.5 h-3.5 text-[#D4AF37]" />
                  Scan History ({snapshot.scanHistory.length})
                </button>
              </div>

              <div className="flex items-center gap-4 text-xs font-mono-tabular">
                <span className="text-[#9CA3AF]">
                  Total: <strong className="text-[#F7F8FA]">{counts.total}</strong>
                </span>
                <span className="text-[#34D399]">
                  Available: <strong>{counts.available}</strong>
                </span>
                <span className={counts.issues > 0 ? 'text-[#F87171]' : 'text-[#9CA3AF]'}>
                  Issues: <strong>{counts.issues}</strong>
                </span>
              </div>
            </div>

            {/* Live Scan Progress Bar */}
            {snapshot.scanProgress && (snapshot.isScanning || snapshot.scanProgress.total > 0) && (
              <div className="p-2.5 rounded bg-[#090A0E] border border-[#242732] flex flex-col gap-1.5">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-[#F2CA52] font-semibold truncate max-w-xl">
                    {snapshot.isScanning ? 'Scanning: ' : 'Last Scan: '}
                    {snapshot.scanProgress.currentBundle}
                  </span>
                  <span className="font-mono-tabular text-[#C5CDD8]">
                    {snapshot.scanProgress.completed} / {snapshot.scanProgress.total} ({progressPct}%) · {snapshot.scanProgress.status}
                  </span>
                </div>
                <div className="h-1.5 w-full rounded bg-[#181A22] overflow-hidden">
                  <div
                    className="h-full bg-[#D4AF37] transition-all duration-150"
                    style={{ width: `${snapshot.scanProgress.total > 0 ? progressPct : 100}%` }}
                  />
                </div>
              </div>
            )}

            {/* Scan Directories Management */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 pt-1">
              <div className="p-2.5 rounded bg-[#090A0E] border border-[#242732] flex flex-col gap-1.5">
                <span className="text-[11px] font-bold uppercase tracking-wider text-[#9CA3AF]">
                  Standard OS Plugin Directories
                </span>
                {(snapshot.hostInfo?.standardDirectories ?? []).length === 0 ? (
                  <span className="text-xs text-[#6B7280]">Reported upon host connection</span>
                ) : (
                  <ul className="space-y-1 text-[11px] font-mono-tabular text-[#C5CDD8]">
                    {snapshot.hostInfo?.standardDirectories.map((dir) => (
                      <li key={dir} className="truncate" title={dir}>
                        {dir}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="p-2.5 rounded bg-[#090A0E] border border-[#242732] flex flex-col gap-2">
                <span className="text-[11px] font-bold uppercase tracking-wider text-[#9CA3AF]">
                  Custom Scan Folders
                </span>
                <form onSubmit={handleAddFolder} className="flex items-center gap-2">
                  <input
                    type="text"
                    aria-label="Add Custom VST3 Folder"
                    placeholder="C:\Audio\CustomVST3"
                    value={newFolderInput}
                    onChange={(e) => setNewFolderInput(e.target.value)}
                    className="flex-1 bg-[#111217] border border-[#2B2E3A] rounded px-2.5 py-1 text-xs font-mono-tabular text-[#F7F8FA] focus:outline-none focus:border-[#D4AF37]"
                  />
                  <button
                    type="submit"
                    disabled={!isConnected}
                    className="px-2.5 py-1 rounded bg-[#181A22] border border-[#2B2E3A] text-xs font-semibold text-[#F2CA52] hover:border-[#D4AF37] flex items-center gap-1 disabled:opacity-40"
                  >
                    <FolderPlus className="w-3.5 h-3.5" />
                    Add
                  </button>
                </form>
                {(snapshot.hostInfo?.customDirectories ?? []).length > 0 && (
                  <ul className="space-y-1">
                    {snapshot.hostInfo?.customDirectories.map((dir) => (
                      <li
                        key={dir}
                        className="flex items-center justify-between gap-2 text-[11px] font-mono-tabular text-[#C5CDD8]"
                      >
                        <span className="truncate" title={dir}>{dir}</span>
                        <button
                          type="button"
                          aria-label={`Remove ${dir}`}
                          onClick={() => void onRemoveDirectory(dir)}
                          className="p-1 text-[#9CA3AF] hover:text-[#F87171]"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            {showHistory && (
              <div className="p-3 rounded bg-[#090A0E] border border-[#242732]">
                <h3 className="text-xs font-bold uppercase tracking-wider text-[#D4AF37] mb-2">
                  Recent Scan History
                </h3>
                {snapshot.scanHistory.length === 0 ? (
                  <p className="text-xs text-[#6B7280]">No scans recorded yet.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-[11px] font-mono-tabular">
                      <thead>
                        <tr className="text-[#9CA3AF] border-b border-[#242732]">
                          <th className="py-1 pr-3">Time</th>
                          <th className="py-1 pr-3">Mode</th>
                          <th className="py-1 pr-3">Bundles</th>
                          <th className="py-1 pr-3">Discovered</th>
                          <th className="py-1 pr-3">Skipped</th>
                          <th className="py-1 pr-3">Failed</th>
                          <th className="py-1">Summary</th>
                        </tr>
                      </thead>
                      <tbody>
                        {snapshot.scanHistory.map((h) => (
                          <tr key={h.id} className="border-b border-[#181A22] text-[#C5CDD8]">
                            <td className="py-1.5 pr-3 whitespace-nowrap">
                              {new Date(h.startedAt).toLocaleTimeString()}
                            </td>
                            <td className="py-1.5 pr-3 uppercase">{h.mode}</td>
                            <td className="py-1.5 pr-3">{h.totalBundles}</td>
                            <td className="py-1.5 pr-3 text-[#34D399]">{h.discoveredPlugins}</td>
                            <td className="py-1.5 pr-3">{h.skippedUnchanged}</td>
                            <td className={`py-1.5 pr-3 ${h.failedBundles > 0 ? 'text-[#F87171]' : ''}`}>
                              {h.failedBundles}
                            </td>
                            <td className="py-1.5">{h.summary}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* WASAPI Native Hardware Audition Bar */}
            {isConnected && (
              <div className="p-2.5 rounded bg-[#090A0E] border border-[#242732] flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-[11px]">
                  <Volume2 className="w-3.5 h-3.5 text-[#D4AF37]" />
                  <span className="font-bold text-[#F7F8FA]">Native Host Audio Output</span>
                  <span className="text-[#9CA3AF]">
                    ({snapshot.instances.length} loaded worker{snapshot.instances.length === 1 ? '' : 's'})
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <select
                    aria-label="WASAPI Audio Output Device"
                    value={selectedWasapiDeviceId}
                    onChange={(e) => setSelectedWasapiDeviceId(e.target.value)}
                    className="bg-[#111217] border border-[#2B2E3A] rounded px-2 py-1 text-xs text-[#F7F8FA] max-w-xs"
                  >
                    <option value="">
                      {snapshot.audioDevices.length > 0 ? 'System Default Output (WASAPI)' : 'No WASAPI output devices reported'}
                    </option>
                    {snapshot.audioDevices.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.driverType}: {d.name}
                      </option>
                    ))}
                  </select>
                  {onStartWasapiAudition && onStopWasapiAudition && (
                    snapshot.auditionStatus?.active ? (
                      <button
                        type="button"
                        onClick={() => void onStopWasapiAudition()}
                        className="px-2.5 py-1 rounded bg-[#EF4444]/15 border border-[#EF4444]/50 text-xs font-semibold text-[#FCA5A5] flex items-center gap-1"
                      >
                        <Square className="w-3 h-3" />
                        Stop Host Audio
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={!hasTrack || snapshot.audioDevices.length === 0}
                        onClick={() => {
                          setActionError(null);
                          void onStartWasapiAudition(selectedWasapiDeviceId).catch((err) => {
                            setActionError(err instanceof Error ? err.message : 'WASAPI audition failed');
                          });
                        }}
                        className="px-2.5 py-1 rounded bg-[#181A22] border border-[#D4AF37]/50 text-xs font-semibold text-[#F2CA52] hover:bg-[#D4AF37]/15 disabled:opacity-40 flex items-center gap-1"
                      >
                        <Play className="w-3 h-3" />
                        Audition via Host
                      </button>
                    )
                  )}
                </div>
              </div>
            )}
          </section>

          {/* Search & Filter Toolbar */}
          <section className="p-3 rounded bg-[#111217] border border-[#242732] flex flex-wrap items-center gap-2.5">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="w-3.5 h-3.5 text-[#6B7280] absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                aria-label="Search plugins"
                placeholder="Search by name, vendor, UID, or path..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-[#090A0E] border border-[#2B2E3A] rounded pl-8 pr-3 py-1.5 text-xs text-[#F7F8FA] focus:outline-none focus:border-[#D4AF37]"
              />
            </div>

            <select
              aria-label="Filter Format"
              value={formatFilter}
              onChange={(e) => setFormatFilter(e.target.value as 'all' | PluginFormat)}
              className="bg-[#090A0E] border border-[#2B2E3A] rounded px-2.5 py-1.5 text-xs text-[#F7F8FA]"
            >
              {FORMAT_LABELS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>

            <select
              aria-label="Filter Manufacturer"
              value={manufacturerFilter}
              onChange={(e) => setManufacturerFilter(e.target.value)}
              className="bg-[#090A0E] border border-[#2B2E3A] rounded px-2.5 py-1.5 text-xs text-[#F7F8FA]"
            >
              {manufacturers.map((m) => (
                <option key={m} value={m}>
                  {m === 'all' ? 'All Manufacturers' : m}
                </option>
              ))}
            </select>

            <select
              aria-label="Filter Category"
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="bg-[#090A0E] border border-[#2B2E3A] rounded px-2.5 py-1.5 text-xs text-[#F7F8FA]"
            >
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c === 'all' ? 'All Categories' : c}
                </option>
              ))}
            </select>

            <div className="flex items-center gap-1 p-0.5 rounded bg-[#090A0E] border border-[#242732]">
              {(
                [
                  { id: 'all', label: 'All' },
                  { id: 'available', label: 'Available' },
                  { id: 'issues', label: `Issues (${counts.issues})` },
                  { id: 'favorites', label: `Favorites (${counts.favorites})` },
                  { id: 'recent', label: 'Recent' },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setStatusFilter(tab.id)}
                  className={`px-2 py-1 rounded text-[11px] font-semibold transition-colors ${
                    statusFilter === tab.id
                      ? 'bg-[#D4AF37] text-[#070709]'
                      : 'text-[#9CA3AF] hover:text-[#F7F8FA]'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </section>

          {/* Two-Column Catalog List + Inspector */}
          <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
            {/* Plugin List */}
            <section className="xl:col-span-7 rounded bg-[#111217] border border-[#242732] overflow-hidden flex flex-col">
              <div className="px-3.5 py-2 border-b border-[#242732] bg-[#0B0C10] flex items-center justify-between text-xs font-bold text-[#D4AF37]">
                <span>DISCOVERED PLUGINS ({filteredPlugins.length})</span>
                <span className="text-[11px] font-normal text-[#9CA3AF]">
                  Select a plugin to inspect metadata &amp; parameters
                </span>
              </div>

              {filteredPlugins.length === 0 ? (
                <div className="p-8 text-center text-xs text-[#9CA3AF]">
                  {snapshot.plugins.length === 0
                    ? 'Connected host catalog is empty. Run "Scan New / Changed" to scan your VST3 folders.'
                    : 'No plugins match the active filter criteria.'}
                </div>
              ) : (
                <div className="divide-y divide-[#1C1F2A] max-h-[520px] overflow-y-auto">
                  {filteredPlugins.map((p) => {
                    const key = `${p.uid}::${p.bundlePath}`;
                    const isSelected = selectedPlugin && `${selectedPlugin.uid}::${selectedPlugin.bundlePath}` === key;
                    const badge = statusBadgeStyle(p.status, p.disabledByUser);

                    return (
                      <div
                        key={key}
                        role="button"
                        tabIndex={0}
                        onClick={() => setSelectedKey(key)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setSelectedKey(key);
                          }
                        }}
                        className={`px-3.5 py-2.5 flex items-center justify-between gap-3 cursor-pointer transition-colors ${
                          isSelected
                            ? 'bg-[#D4AF37]/10 border-l-2 border-l-[#F2CA52]'
                            : 'hover:bg-[#161821]'
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-bold text-[#F7F8FA] truncate">
                              {p.name}
                            </span>
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-mono-tabular uppercase bg-[#181A22] text-[#D4AF37] border border-[#2B2E3A]">
                              {p.format}
                            </span>
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-mono-tabular bg-[#181A22] text-[#9CA3AF]">
                              {p.arch}
                            </span>
                          </div>
                          <div className="mt-0.5 text-[11px] text-[#9CA3AF] truncate">
                            {p.manufacturer} · {p.category} · v{p.version || '—'} · {p.parameterCount} params
                          </div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          {p.status === 'available' && !p.disabledByUser && p.format === 'vst3' && onInsertInChain && (
                            <button
                              type="button"
                              aria-label={`Insert ${p.name} into Mastering Chain`}
                              onClick={(e) => {
                                e.stopPropagation();
                                void onInsertInChain(p);
                              }}
                              className="px-2 py-0.5 rounded bg-[#D4AF37] text-[#070709] text-[10px] font-bold hover:bg-[#F2CA52] flex items-center gap-1"
                            >
                              <Plus className="w-3 h-3" />
                              Insert
                            </button>
                          )}
                          <span className={`px-2 py-0.5 rounded text-[10px] font-semibold border ${badge.classes}`}>
                            {badge.label}
                          </span>
                          <button
                            type="button"
                            aria-label={p.favorite ? `Unfavorite ${p.name}` : `Favorite ${p.name}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              void onToggleFavorite(p);
                            }}
                            className={`p-1 rounded ${
                              p.favorite ? 'text-[#F2CA52]' : 'text-[#6B7280] hover:text-[#F2CA52]'
                            }`}
                          >
                            <Star className={`w-3.5 h-3.5 ${p.favorite ? 'fill-[#F2CA52]' : ''}`} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {/* Detailed Inspector Panel */}
            <section className="xl:col-span-5 rounded bg-[#111217] border border-[#242732] p-4 flex flex-col gap-3">
              {!selectedPlugin ? (
                <div className="py-12 text-center text-xs text-[#6B7280]">
                  Select a discovered plugin to inspect binary architecture, I/O bus layouts, parameters, and compatibility diagnostics.
                </div>
              ) : (
                <>
                  <div className="flex items-start justify-between gap-2 pb-2 border-b border-[#242732]">
                    <div className="min-w-0">
                      <h2 className="font-display text-sm font-bold text-[#F7F8FA] truncate">
                        {selectedPlugin.name}
                      </h2>
                      <p className="text-xs text-[#D4AF37]">
                        {selectedPlugin.manufacturer} · {selectedPlugin.format.toUpperCase()} v{selectedPlugin.version || '—'}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {selectedPlugin.status === 'available' && !selectedPlugin.disabledByUser && selectedPlugin.format === 'vst3' && onInsertInChain && (
                        <button
                          type="button"
                          onClick={() => void onInsertInChain(selectedPlugin)}
                          className="px-2.5 py-1 rounded bg-[#D4AF37] text-[#070709] text-[11px] font-bold hover:bg-[#F2CA52] flex items-center gap-1"
                        >
                          <Plus className="w-3 h-3" />
                          Insert in Rack
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void onToggleDisabled(selectedPlugin)}
                        className={`px-2.5 py-1 rounded text-[11px] font-semibold border flex items-center gap-1 ${
                          selectedPlugin.disabledByUser
                            ? 'bg-[#10B981]/15 border-[#10B981]/40 text-[#34D399]'
                            : 'bg-[#181A22] border-[#2B2E3A] text-[#C5CDD8] hover:border-[#D4AF37]'
                        }`}
                      >
                        <Power className="w-3 h-3" />
                        {selectedPlugin.disabledByUser ? 'Enable' : 'Disable'}
                      </button>
                      {(selectedPlugin.status === 'scan_failed' ||
                        selectedPlugin.status === 'quarantined' ||
                        selectedPlugin.status === 'missing') && (
                        <button
                          type="button"
                          onClick={() => void onRetryPlugin(selectedPlugin.uid, selectedPlugin.bundlePath)}
                          className="px-2.5 py-1 rounded bg-[#D4AF37] text-[#070709] text-[11px] font-bold hover:bg-[#F2CA52] flex items-center gap-1"
                        >
                          <RotateCcw className="w-3 h-3" />
                          Retry Scan
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Compatibility / Quarantine Troubleshooting */}
                  {selectedPlugin.status !== 'available' && (
                    <div className="p-2.5 rounded bg-[#F59E0B]/10 border border-[#F59E0B]/40 text-xs text-[#FDE68A] flex items-start gap-2">
                      <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5 text-[#FBBF24]" />
                      <div className="space-y-1">
                        <div className="font-bold">
                          Status: {statusBadgeStyle(selectedPlugin.status, selectedPlugin.disabledByUser).label} (Failures: {selectedPlugin.failCount})
                        </div>
                        <div className="text-[11px]">
                          {selectedPlugin.statusReason || 'Plugin could not be verified during out-of-process scan.'}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Metadata Grid */}
                  <dl className="grid grid-cols-2 gap-2 text-[11px]">
                    <div className="p-2 rounded bg-[#090A0E] border border-[#242732]">
                      <dt className="text-[#9CA3AF]">Plugin UID</dt>
                      <dd className="font-mono-tabular text-[#F7F8FA] truncate" title={selectedPlugin.uid}>
                        {selectedPlugin.uid}
                      </dd>
                    </div>
                    <div className="p-2 rounded bg-[#090A0E] border border-[#242732]">
                      <dt className="text-[#9CA3AF]">Architecture / Editor</dt>
                      <dd className="font-mono-tabular text-[#F7F8FA] flex items-center gap-1.5">
                        <Cpu className="w-3 h-3 text-[#D4AF37]" />
                        {selectedPlugin.arch.toUpperCase()} · {selectedPlugin.hasEditor ? 'Native GUI' : 'Headless'}
                      </dd>
                    </div>
                    <div className="p-2 rounded bg-[#090A0E] border border-[#242732]">
                      <dt className="text-[#9CA3AF]">Reported Latency</dt>
                      <dd className="font-mono-tabular text-[#F7F8FA]">
                        {selectedPlugin.latencySamples} samples
                      </dd>
                    </div>
                    <div className="p-2 rounded bg-[#090A0E] border border-[#242732]">
                      <dt className="text-[#9CA3AF]">SDK / Category</dt>
                      <dd className="font-mono-tabular text-[#F7F8FA] truncate">
                        {selectedPlugin.sdkVersion || 'VST3'} · {selectedPlugin.category}
                      </dd>
                    </div>
                  </dl>

                  <div className="p-2 rounded bg-[#090A0E] border border-[#242732] text-[11px]">
                    <div className="text-[#9CA3AF] mb-0.5">Bundle Install Path</div>
                    <div className="font-mono-tabular text-[#C5CDD8] break-all">
                      {selectedPlugin.bundlePath}
                    </div>
                    {selectedPlugin.fileHashSha256 && (
                      <div className="mt-1 text-[10px] font-mono-tabular text-[#6B7280] truncate" title={selectedPlugin.fileHashSha256}>
                        SHA-256: {selectedPlugin.fileHashSha256}
                      </div>
                    )}
                  </div>

                  {/* Audio Bus Configurations */}
                  <div>
                    <h3 className="text-[11px] font-bold uppercase tracking-wider text-[#9CA3AF] mb-1.5">
                      Audio Bus I/O Configurations
                    </h3>
                    <div className="flex flex-wrap gap-1.5">
                      {(selectedPlugin.busConfigs ?? []).length === 0 ? (
                        <span className="text-xs text-[#6B7280]">None reported</span>
                      ) : (
                        selectedPlugin.busConfigs.map((b, idx) => (
                          <span
                            key={`${b.layoutName}-${idx}`}
                            className="px-2 py-1 rounded bg-[#090A0E] border border-[#242732] text-[11px] font-mono-tabular text-[#C5CDD8]"
                          >
                            {b.layoutName}: {b.mainInputChannels} in / {b.mainOutputChannels} out
                            {b.sidechainInputChannels > 0 ? ` (+${b.sidechainInputChannels} SC)` : ''}
                          </span>
                        ))
                      )}
                    </div>
                  </div>

                  {/* Parameter Inspector */}
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <h3 className="text-[11px] font-bold uppercase tracking-wider text-[#9CA3AF] flex items-center gap-1">
                        <Wrench className="w-3 h-3 text-[#D4AF37]" />
                        Exposed Parameters ({selectedPlugin.parameterCount})
                      </h3>
                      <span className="text-[10px] text-[#6B7280]">Milestone 1 Read-Only Inspector</span>
                    </div>
                    {selectedPlugin.parameters.length === 0 ? (
                      <div className="p-3 rounded bg-[#090A0E] border border-[#242732] text-xs text-[#6B7280]">
                        No parameters enumerated.
                      </div>
                    ) : (
                      <div className="max-h-52 overflow-y-auto rounded bg-[#090A0E] border border-[#242732] divide-y divide-[#181A22]">
                        {selectedPlugin.parameters.map((param) => (
                          <div
                            key={param.id}
                            className="px-2.5 py-1.5 flex items-center justify-between gap-2 text-[11px]"
                          >
                            <div className="min-w-0">
                              <span className="font-mono-tabular text-[#6B7280] mr-1.5">
                                #{param.id}
                              </span>
                              <span className="text-[#F7F8FA] font-medium truncate">
                                {param.name}
                              </span>
                            </div>
                            <div className="flex items-center gap-2 shrink-0 font-mono-tabular text-[10px] text-[#9CA3AF]">
                              <span>def {param.defaultValueNormalized.toFixed(2)}</span>
                              {param.label && <span className="text-[#D4AF37]">{param.label}</span>}
                              {param.isBypass && (
                                <span className="px-1 rounded bg-[#D4AF37]/20 text-[#F2CA52]">BYPASS</span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
};
