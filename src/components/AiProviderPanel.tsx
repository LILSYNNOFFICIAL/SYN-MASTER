import React, { useEffect, useMemo, useState } from 'react';
import { Bot, Eye, EyeOff, Loader2, RotateCcw, Sparkles, X } from 'lucide-react';
import {
  BUILTIN_PROVIDER_ID,
  MAX_AGENT_TIMEOUT_SEC,
  MIN_TIMEOUT_SEC,
  PROVIDER_GROUP_LABELS,
  PROVIDER_PRESETS,
  getPreset,
  type ProviderGroup,
} from '../ai/providerPresets';
import { effectiveTimeoutSec, listModels, maskKey } from '../ai/providerAdapters';
import { testProviderConnection } from '../ai/masteringClient';
import {
  clearProviderKey,
  getActiveProviderConfig,
  resetProviderSettings,
  setProviderSettings,
  useProviderSettings,
} from '../ai/providerStore';

const CORS_NOTE: Record<string, string> = {
  yes: 'Direct browser calls supported.',
  unverified: 'Browser (CORS) support not confirmed. If Test connection says "Network / CORS blocked", use this model through OpenRouter or a local gateway.',
  local: 'Runs on your machine. It must allow this app\u2019s origin (CORS); a hosted HTTPS page calling http://127.0.0.1 can be blocked by the browser\u2019s private-network rules.',
  'n/a': '',
};

const inputCls = 'bg-[#090A0E] border border-[#2B2E3A] rounded px-2.5 py-1.5 text-[#F7F8FA] focus:border-[#D4AF37] outline-none';

/** "AI Provider" section (Settings). Bring your own key; default stays built-in Gemini. */
export const AiProviderPanel: React.FC = () => {
  const settings = useProviderSettings();
  const preset = getPreset(settings.presetId);
  const config = getActiveProviderConfig(settings);
  const isBuiltin = preset.id === BUILTIN_PROVIDER_ID;
  const editable = preset.adapter === 'openai-compatible' || preset.adapter === 'webhook';
  const supportsAgentic = preset.adapter === 'openai-compatible' || preset.adapter === 'webhook';

  const [keyDraft, setKeyDraft] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [models, setModels] = useState<string[]>([]);

  useEffect(() => {
    setKeyDraft('');
    setTestResult(null);
    setModels([]);
  }, [preset.id]);

  // Prefill the model list from GET {base}/models where the preset supports it (OpenClaw, Ollama, ...).
  useEffect(() => {
    if (!preset.discoverModels) return;
    let cancelled = false;
    const controller = new AbortController();
    const t = setTimeout(() => {
      listModels(getActiveProviderConfig(), { signal: controller.signal })
        .then((list) => {
          if (cancelled) return;
          setModels(list);
          const current = getActiveProviderConfig().model;
          if (list.length > 0 && (!current || current === preset.defaultModel) && !list.includes(current)) {
            updateOverride({ model: list[0] });
          }
        })
        .catch(() => undefined);
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset.id, config.baseUrl, Boolean(config.apiKey)]);

  const grouped = useMemo(() => {
    const out = new Map<ProviderGroup, typeof PROVIDER_PRESETS>();
    for (const p of PROVIDER_PRESETS) out.set(p.group, [...(out.get(p.group) ?? []), p]);
    return [...out.entries()];
  }, []);

  function updateOverride(patch: { model?: string; baseUrl?: string; agentic?: boolean; timeoutSec?: number }) {
    setProviderSettings((prev) => ({
      ...prev,
      overrides: { ...prev.overrides, [prev.presetId]: { ...prev.overrides[prev.presetId], ...patch } },
    }));
  }

  function saveKey() {
    const k = keyDraft.trim();
    if (!k) return;
    setProviderSettings((prev) => ({ ...prev, keys: { ...prev.keys, [prev.presetId]: k } }));
    setKeyDraft('');
    setShowKey(false);
  }

  async function runTest() {
    setTesting(true);
    setTestResult(null);
    const r = await testProviderConnection(getActiveProviderConfig());
    setTestResult(r);
    setTesting(false);
  }

  return (
    <section aria-label="AI Provider" className="flex flex-col gap-2.5 p-3 rounded bg-[#0C0D12] border border-[#D4AF37]/30">
      <div className="flex items-center justify-between">
        <div className="font-semibold text-[#D4AF37] flex items-center gap-1.5">
          <Bot className="w-3.5 h-3.5" /> AI Provider
        </div>
        <button
          type="button"
          onClick={() => resetProviderSettings()}
          className="text-[10px] px-2 py-0.5 rounded border border-[#2B2E3A] text-[#C5CDD8] hover:border-[#D4AF37] flex items-center gap-1"
          title="Built-in Gemini, all saved keys removed"
        >
          <RotateCcw className="w-3 h-3" /> Reset to default
        </button>
      </div>

      <label className="flex flex-col gap-1 text-[#9CA3AF]">
        Provider for mastering decisions
        <select
          value={preset.id}
          onChange={(e) => setProviderSettings((prev) => ({ ...prev, presetId: e.target.value }))}
          className={inputCls}
        >
          {grouped.map(([group, list]) => (
            <optgroup key={group} label={PROVIDER_GROUP_LABELS[group]}>
              {list.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>

      {isBuiltin ? (
        <div id="cloud-ai-help" className="flex flex-col gap-2 text-[11px] text-[#9CA3AF]">
          <p><strong className="text-[#E5E7EB]">Cloud AI is provided by SYN-MASTER.</strong> No Google AI Studio account, Gemini API key, GitHub account, operator token, or account setup is required. The app creates an anonymous guest session automatically.</p>
          <p>To keep the service available, short-term and daily fair-use limits apply per guest session and IP. If a limit is reached, SYN-MASTER explains when to retry.</p>
          <p>Your audio is still mastered locally by SYN-DSP. If Cloud AI is unavailable or a usage limit is reached, local mastering continues and your work is not blocked.</p>
          <a href="https://github.com/LILSYNNOFFICIAL/SYN-MASTER#cloud-ai" target="_blank" rel="noreferrer" className="text-[#3FE0FF] underline underline-offset-2">Cloud AI help and usage limits</a>
        </div>
      ) : (
        <>
          {editable && (
            <label className="flex flex-col gap-1 text-[#9CA3AF]">
              {preset.adapter === 'webhook' ? 'Webhook URL' : 'Base URL'}
              <input
                type="url"
                spellCheck={false}
                value={config.baseUrl}
                placeholder={preset.defaultBaseUrl}
                onChange={(e) => updateOverride({ baseUrl: e.target.value })}
                className={inputCls + ' font-mono-tabular'}
              />
            </label>
          )}

          {preset.adapter !== 'webhook' && (
            <label className="flex flex-col gap-1 text-[#9CA3AF]">
              Model
              <input
                list={models.length ? `models-${preset.id}` : undefined}
                spellCheck={false}
                value={config.model}
                placeholder={preset.defaultModel || 'model name'}
                onChange={(e) => updateOverride({ model: e.target.value })}
                className={inputCls + ' font-mono-tabular'}
              />
              {models.length > 0 && (
                <datalist id={`models-${preset.id}`}>
                  {models.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              )}
            </label>
          )}

          {preset.key !== 'none' && (
            <div className="flex flex-col gap-1 text-[#9CA3AF]">
              <span>
                {preset.keyLabel ?? 'API key'}
                {preset.key === 'optional' ? ' (optional)' : ''}
              </span>
              {config.apiKey ? (
                <div className="flex items-center gap-2">
                  <span className="flex-1 px-2.5 py-1.5 rounded bg-[#090A0E] border border-[#2B2E3A] font-mono-tabular text-[#F2CA52]">
                    {maskKey(config.apiKey)}
                  </span>
                  <button
                    type="button"
                    onClick={() => clearProviderKey(preset.id)}
                    className="px-2 py-1.5 rounded border border-[#2B2E3A] text-[#C5CDD8] hover:border-[#F87171] hover:text-[#F87171] flex items-center gap-1"
                  >
                    <X className="w-3 h-3" /> Clear key
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <input
                    type={showKey ? 'text' : 'password'}
                    autoComplete="off"
                    spellCheck={false}
                    value={keyDraft}
                    onChange={(e) => setKeyDraft(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && saveKey()}
                    placeholder="Paste key"
                    className={inputCls + ' flex-1 font-mono-tabular'}
                  />
                  <button
                    type="button"
                    aria-label={showKey ? 'Hide key' : 'Show key'}
                    onClick={() => setShowKey((v) => !v)}
                    className="p-1.5 rounded border border-[#2B2E3A] text-[#C5CDD8] hover:border-[#D4AF37]"
                  >
                    {showKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                  <button
                    type="button"
                    onClick={saveKey}
                    disabled={!keyDraft.trim()}
                    className="px-2.5 py-1.5 rounded bg-[#D4AF37] text-[#070709] font-bold disabled:opacity-40"
                  >
                    Save
                  </button>
                </div>
              )}
              <label className="flex items-center gap-1.5 text-[11px] text-[#C5CDD8] mt-0.5">
                <input
                  type="checkbox"
                  checked={settings.remember}
                  onChange={(e) => setProviderSettings((prev) => ({ ...prev, remember: e.target.checked }))}
                  className="accent-[#D4AF37]"
                />
                Remember on this device (otherwise cleared when this tab closes)
              </label>
            </div>
          )}

          {supportsAgentic && (
            <div className="flex flex-wrap items-center gap-3 text-[#C5CDD8]">
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={config.agentic}
                  onChange={(e) => updateOverride({ agentic: e.target.checked, timeoutSec: e.target.checked ? Math.max(config.timeoutSec, 120) : config.timeoutSec })}
                  className="accent-[#D4AF37]"
                />
                Agentic mode
              </label>
              <label className="flex items-center gap-1.5">
                Timeout
                <input
                  type="number"
                  min={MIN_TIMEOUT_SEC}
                  max={config.agentic ? MAX_AGENT_TIMEOUT_SEC : 120}
                  value={config.timeoutSec}
                  onChange={(e) => updateOverride({ timeoutSec: Number(e.target.value) })}
                  className={inputCls + ' w-16 py-1 font-mono-tabular'}
                />
                s
              </label>
              <span className="text-[10px] text-[#9CA3AF]">effective {effectiveTimeoutSec(config)} s</span>
            </div>
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={runTest}
              disabled={testing}
              className="px-3 py-1.5 rounded border border-[#D4AF37]/60 text-[#F2CA52] hover:bg-[#D4AF37] hover:text-[#070709] font-semibold flex items-center gap-1.5 disabled:opacity-50"
            >
              {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
              Test connection
            </button>
            {testResult && (
              <span role="status" className={`text-[11px] ${testResult.ok ? 'text-[#34D399]' : 'text-[#F87171]'}`}>
                {testResult.message}
              </span>
            )}
          </div>

          {(preset.setupNote || CORS_NOTE[preset.browserCors]) && (
            <div className="text-[11px] text-[#9CA3AF] leading-snug space-y-1">
              {preset.setupNote && <p>{preset.setupNote}</p>}
              {CORS_NOTE[preset.browserCors] && <p>{CORS_NOTE[preset.browserCors]}</p>}
            </div>
          )}
          {preset.warning && <p className="text-[11px] text-[#FBBF24]">⚠ {preset.warning}</p>}
        </>
      )}

      <p className="text-[10px] text-[#9CA3AF] border-t border-[#222530] pt-2 leading-snug">
        Keys stay in this browser (never sent to the SYN MASTER server, Gemini, logs or telemetry). Usage is billed to your own
        provider account. The AI only suggests settings: every pass is still rendered, re-measured and judged against the
        objective targets, and if a provider&rsquo;s reply fails validation that pass falls back to built-in Gemini.
        Switching applies to the next AI call; no reload needed.
      </p>
    </section>
  );
};

// The top-bar chip lives in its own file so this Settings-only panel can be code-split (bundle budget).
export { AiProviderChip } from './AiProviderChip';
