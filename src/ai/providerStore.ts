/**
 * Browser-only storage for the bring-your-own-AI provider choice and keys.
 *
 * - Default (nothing stored): built-in Gemini, exactly today's behaviour.
 * - sessionStorage by default; localStorage only when the user ticks "Remember on this device".
 * - Keys are kept per preset so switching back and forth does not lose them.
 * - Nothing here is ever sent to the app server, Gemini, telemetry or the diagnostic bundle.
 */
import { useSyncExternalStore } from 'react';
import { BUILTIN_PROVIDER_ID, getPreset } from './providerPresets.ts';
import { describeProvider, type ProviderConfig } from './providerAdapters.ts';

export interface ProviderSettings {
  presetId: string;
  /** Per-preset model / base URL / agent options the user edited. */
  overrides: Record<string, { model?: string; baseUrl?: string; agentic?: boolean; timeoutSec?: number }>;
  /** Per-preset keys. Browser storage only. */
  keys: Record<string, string>;
  remember: boolean;
}

export interface ActiveAiCall {
  kind: 'strategy' | 'refine';
  label: string;
  agentic: boolean;
  startedAt: number;
  cancel: () => void;
}

const STORAGE_KEY = 'syn-master.ai-provider.v1';

export const DEFAULT_PROVIDER_SETTINGS: ProviderSettings = {
  presetId: BUILTIN_PROVIDER_ID,
  overrides: {},
  keys: {},
  remember: false,
};

function safeStorage(kind: 'session' | 'local'): Storage | null {
  try {
    return typeof window === 'undefined' ? null : kind === 'session' ? window.sessionStorage : window.localStorage;
  } catch {
    return null;
  }
}

function load(): ProviderSettings {
  for (const kind of ['session', 'local'] as const) {
    const raw = safeStorage(kind)?.getItem(STORAGE_KEY);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as Partial<ProviderSettings>;
      return {
        presetId: getPreset(parsed.presetId).id,
        overrides: parsed.overrides && typeof parsed.overrides === 'object' ? parsed.overrides : {},
        keys: parsed.keys && typeof parsed.keys === 'object' ? parsed.keys : {},
        remember: kind === 'local',
      };
    } catch {
      /* corrupt entry: ignore */
    }
  }
  return DEFAULT_PROVIDER_SETTINGS;
}

let settings: ProviderSettings = load();
let activeCall: ActiveAiCall | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

function persist(next: ProviderSettings) {
  const session = safeStorage('session');
  const local = safeStorage('local');
  const isDefault = next.presetId === BUILTIN_PROVIDER_ID && Object.keys(next.keys).length === 0 && Object.keys(next.overrides).length === 0;
  try {
    if (isDefault) {
      session?.removeItem(STORAGE_KEY);
      local?.removeItem(STORAGE_KEY);
      return;
    }
    const raw = JSON.stringify({ presetId: next.presetId, overrides: next.overrides, keys: next.keys });
    if (next.remember) {
      local?.setItem(STORAGE_KEY, raw);
      session?.removeItem(STORAGE_KEY);
    } else {
      session?.setItem(STORAGE_KEY, raw);
      local?.removeItem(STORAGE_KEY);
    }
  } catch {
    /* storage full / blocked: keep in memory for this tab */
  }
}

export function getProviderSettings(): ProviderSettings {
  return settings;
}

export function setProviderSettings(update: (prev: ProviderSettings) => ProviderSettings) {
  settings = update(settings);
  persist(settings);
  notify();
}

export function clearProviderKey(presetId: string) {
  setProviderSettings((prev) => {
    const keys = { ...prev.keys };
    delete keys[presetId];
    return { ...prev, keys };
  });
}

/** "Reset to default": built-in Gemini, all keys and overrides removed from both storages. */
export function resetProviderSettings() {
  settings = DEFAULT_PROVIDER_SETTINGS;
  persist(settings);
  notify();
}

/** The config the next AI call uses (read at call time, so a switch applies mid-session). */
export function getActiveProviderConfig(s: ProviderSettings = settings): ProviderConfig {
  const preset = getPreset(s.presetId);
  const o = s.overrides[preset.id] ?? {};
  return {
    presetId: preset.id,
    model: o.model ?? preset.defaultModel,
    baseUrl: o.baseUrl ?? preset.defaultBaseUrl ?? '',
    apiKey: s.keys[preset.id] ?? '',
    agentic: o.agentic ?? preset.agentic,
    timeoutSec: o.timeoutSec ?? preset.defaultTimeoutSec,
  };
}

export function setActiveAiCall(call: ActiveAiCall | null) {
  activeCall = call;
  notify();
}

/**
 * Run one AI suggestion call with a cancel handle and the "agent is working" state the top-bar
 * chip shows. Cancelling aborts only this provider request; the deterministic engine carries on.
 */
export async function runProviderCall<T>(kind: 'strategy' | 'refine', fn: (opts: { signal: AbortSignal }) => Promise<T>): Promise<T> {
  const d = describeProvider(getActiveProviderConfig());
  const controller = new AbortController();
  const call: ActiveAiCall = { kind, label: d.label, agentic: d.agentic, startedAt: Date.now(), cancel: () => controller.abort() };
  setActiveAiCall(call);
  try {
    return await fn({ signal: controller.signal });
  } finally {
    if (activeCall === call) setActiveAiCall(null);
  }
}

export function getActiveAiCall(): ActiveAiCall | null {
  return activeCall;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useProviderSettings(): ProviderSettings {
  return useSyncExternalStore(subscribe, getProviderSettings, getProviderSettings);
}

export function useActiveAiCall(): ActiveAiCall | null {
  return useSyncExternalStore(subscribe, getActiveAiCall, getActiveAiCall);
}
