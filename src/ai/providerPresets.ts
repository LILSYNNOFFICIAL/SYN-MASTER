/**
 * Bring-your-own-AI provider presets (data only).
 *
 * To add a provider: append one entry to PROVIDER_PRESETS. Pick the adapter that speaks its API:
 *   - 'openai-compatible' for anything with POST {baseUrl}/chat/completions (most services, local
 *     servers, agent gateways). Set agentic: true for agent runtimes (longer timeout, tolerant JSON).
 *   - 'webhook' for a custom URL that takes the SYN MASTER request JSON and returns the suggestion JSON.
 *   - 'gemini' / 'openai' / 'anthropic' are the native adapters.
 * Nothing else needs to change: the settings panel, the adapters and the tests read this list.
 *
 * browserCors is what we know about direct browser calls (no server proxy is shipped on purpose):
 *   'yes'        documented to allow browser calls
 *   'unverified' may or may not send CORS headers; if the browser blocks it, use OpenRouter or a local gateway
 *   'local'      a server on the user's machine; it must allow this app's origin (see the preset's setupNote)
 *   'n/a'        built-in (goes through this app's own server)
 */

export type ProviderAdapterKind = 'builtin-gemini' | 'gemini' | 'openai' | 'anthropic' | 'openai-compatible' | 'webhook';
export type JsonMode = 'json_schema' | 'json_object' | 'none';
export type ProviderGroup = 'default' | 'native' | 'cloud' | 'local' | 'agent';

export interface ProviderPreset {
  id: string;
  label: string;
  group: ProviderGroup;
  adapter: ProviderAdapterKind;
  defaultModel: string;
  /** Base URL for openai-compatible presets, or the URL for webhook presets. */
  defaultBaseUrl?: string;
  baseUrlEditable: boolean;
  key: 'none' | 'optional' | 'required';
  keyLabel?: string;
  /** How the adapter asks for JSON. Falls back to prompt-only JSON if the server rejects response_format. */
  jsonMode: JsonMode;
  /** Agent runtimes: longer timeout, "agent is working" state, tolerant JSON extraction. */
  agentic: boolean;
  defaultTimeoutSec: number;
  /** Try GET {baseUrl}/models to prefill the model field. */
  discoverModels?: boolean;
  browserCors: 'yes' | 'unverified' | 'local' | 'n/a';
  setupNote?: string;
  warning?: string;
}

export const BUILTIN_PROVIDER_ID = 'builtin-gemini';
export const MAX_AGENT_TIMEOUT_SEC = 180;
export const MIN_TIMEOUT_SEC = 10;

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: BUILTIN_PROVIDER_ID,
    label: 'Built-in Gemini (default)',
    group: 'default',
    adapter: 'builtin-gemini',
    defaultModel: '(server default)',
    baseUrlEditable: false,
    key: 'none',
    jsonMode: 'json_schema',
    agentic: false,
    defaultTimeoutSec: 12,
    browserCors: 'n/a',
    setupNote: "Uses this app's server and its own Gemini key. Nothing to set up.",
  },
  // ---- Native adapters -------------------------------------------------------------------
  {
    id: 'gemini',
    label: 'Google Gemini (your key)',
    group: 'native',
    adapter: 'gemini',
    defaultModel: 'gemini-2.5-pro',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    baseUrlEditable: false,
    key: 'required',
    keyLabel: 'Gemini API key',
    jsonMode: 'json_schema',
    agentic: false,
    defaultTimeoutSec: 60,
    browserCors: 'yes',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    group: 'native',
    adapter: 'openai',
    defaultModel: 'gpt-4.1',
    defaultBaseUrl: 'https://api.openai.com/v1',
    baseUrlEditable: false,
    key: 'required',
    keyLabel: 'OpenAI API key',
    jsonMode: 'json_schema',
    agentic: false,
    defaultTimeoutSec: 60,
    browserCors: 'yes',
  },
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    group: 'native',
    adapter: 'anthropic',
    defaultModel: 'claude-sonnet-4-5',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    baseUrlEditable: false,
    key: 'required',
    keyLabel: 'Anthropic API key',
    jsonMode: 'json_schema',
    agentic: false,
    defaultTimeoutSec: 60,
    browserCors: 'yes',
    setupNote: 'Sent with the anthropic-dangerous-direct-browser-access header, which Anthropic requires for browser calls.',
  },
  // ---- Cloud services via the OpenAI-compatible adapter ----------------------------------
  { id: 'openrouter', label: 'OpenRouter', group: 'cloud', adapter: 'openai-compatible', defaultModel: 'openai/gpt-4.1', defaultBaseUrl: 'https://openrouter.ai/api/v1', baseUrlEditable: true, key: 'required', jsonMode: 'json_object', agentic: false, defaultTimeoutSec: 60, browserCors: 'yes', setupNote: 'One key for many models. Also the easiest route to a provider that blocks browser calls.' },
  { id: 'groq', label: 'Groq', group: 'cloud', adapter: 'openai-compatible', defaultModel: 'llama-3.3-70b-versatile', defaultBaseUrl: 'https://api.groq.com/openai/v1', baseUrlEditable: true, key: 'required', jsonMode: 'json_object', agentic: false, defaultTimeoutSec: 60, browserCors: 'unverified' },
  { id: 'mistral', label: 'Mistral', group: 'cloud', adapter: 'openai-compatible', defaultModel: 'mistral-large-latest', defaultBaseUrl: 'https://api.mistral.ai/v1', baseUrlEditable: true, key: 'required', jsonMode: 'json_object', agentic: false, defaultTimeoutSec: 60, browserCors: 'unverified' },
  { id: 'xai', label: 'xAI (Grok)', group: 'cloud', adapter: 'openai-compatible', defaultModel: 'grok-4', defaultBaseUrl: 'https://api.x.ai/v1', baseUrlEditable: true, key: 'required', jsonMode: 'json_object', agentic: false, defaultTimeoutSec: 90, browserCors: 'unverified' },
  { id: 'deepseek', label: 'DeepSeek', group: 'cloud', adapter: 'openai-compatible', defaultModel: 'deepseek-chat', defaultBaseUrl: 'https://api.deepseek.com/v1', baseUrlEditable: true, key: 'required', jsonMode: 'json_object', agentic: false, defaultTimeoutSec: 90, browserCors: 'unverified' },
  { id: 'together', label: 'Together AI', group: 'cloud', adapter: 'openai-compatible', defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', defaultBaseUrl: 'https://api.together.xyz/v1', baseUrlEditable: true, key: 'required', jsonMode: 'json_object', agentic: false, defaultTimeoutSec: 60, browserCors: 'unverified' },
  { id: 'fireworks', label: 'Fireworks', group: 'cloud', adapter: 'openai-compatible', defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct', defaultBaseUrl: 'https://api.fireworks.ai/inference/v1', baseUrlEditable: true, key: 'required', jsonMode: 'json_object', agentic: false, defaultTimeoutSec: 60, browserCors: 'unverified' },
  { id: 'perplexity', label: 'Perplexity', group: 'cloud', adapter: 'openai-compatible', defaultModel: 'sonar-pro', defaultBaseUrl: 'https://api.perplexity.ai', baseUrlEditable: true, key: 'required', jsonMode: 'json_schema', agentic: false, defaultTimeoutSec: 90, browserCors: 'unverified', setupNote: 'Perplexity may not allow browser calls; if Test connection reports a network/CORS block, use its models through OpenRouter.' },
  { id: 'cerebras', label: 'Cerebras', group: 'cloud', adapter: 'openai-compatible', defaultModel: 'llama-3.3-70b', defaultBaseUrl: 'https://api.cerebras.ai/v1', baseUrlEditable: true, key: 'required', jsonMode: 'json_object', agentic: false, defaultTimeoutSec: 60, browserCors: 'unverified' },
  {
    id: 'openai-compatible',
    label: 'Custom OpenAI-compatible',
    group: 'cloud',
    adapter: 'openai-compatible',
    defaultModel: '',
    defaultBaseUrl: 'https://',
    baseUrlEditable: true,
    key: 'optional',
    jsonMode: 'json_object',
    agentic: false,
    defaultTimeoutSec: 60,
    discoverModels: true,
    browserCors: 'unverified',
    setupNote: 'Any server with POST {base URL}/chat/completions.',
  },
  // ---- Local servers -----------------------------------------------------------------------
  { id: 'ollama', label: 'Ollama (local)', group: 'local', adapter: 'openai-compatible', defaultModel: 'llama3.1', defaultBaseUrl: 'http://127.0.0.1:11434/v1', baseUrlEditable: true, key: 'none', jsonMode: 'json_object', agentic: false, defaultTimeoutSec: 120, discoverModels: true, browserCors: 'local', setupNote: "Ollama only accepts localhost origins by default. For the hosted app set OLLAMA_ORIGINS to this site's origin and restart Ollama." },
  { id: 'lmstudio', label: 'LM Studio (local)', group: 'local', adapter: 'openai-compatible', defaultModel: 'local-model', defaultBaseUrl: 'http://127.0.0.1:1234/v1', baseUrlEditable: true, key: 'none', jsonMode: 'json_schema', agentic: false, defaultTimeoutSec: 120, discoverModels: true, browserCors: 'local', setupNote: 'Start the LM Studio server and turn on "Enable CORS" in its server settings.' },
  // ---- Agents ------------------------------------------------------------------------------
  {
    id: 'openclaw',
    label: 'OpenClaw (agentic)',
    group: 'agent',
    adapter: 'openai-compatible',
    defaultModel: 'openclaw',
    defaultBaseUrl: 'http://127.0.0.1:18789/v1',
    baseUrlEditable: true,
    key: 'required',
    keyLabel: 'Gateway token or password',
    jsonMode: 'none',
    agentic: true,
    defaultTimeoutSec: 120,
    discoverModels: true,
    browserCors: 'local',
    setupNote:
      'Enable the endpoint in your OpenClaw config: gateway.http.endpoints.chatCompletions.enabled = true (it is off by default). The gateway listens on loopback port 18789. A hosted HTTPS page calling a local gateway can be blocked by the browser (CORS / private-network rules) unless the gateway allows this app\'s origin or is exposed over HTTPS (for example Tailscale serve).',
    warning: 'The gateway token grants full operator access to your agent. It stays in this browser only.',
  },
  {
    id: 'custom-agent',
    label: 'Custom agent (OpenAI-compatible)',
    group: 'agent',
    adapter: 'openai-compatible',
    defaultModel: '',
    defaultBaseUrl: 'http://127.0.0.1:8000/v1',
    baseUrlEditable: true,
    key: 'optional',
    keyLabel: 'Bearer token (optional)',
    jsonMode: 'none',
    agentic: true,
    defaultTimeoutSec: 180,
    discoverModels: true,
    browserCors: 'local',
    setupNote: 'Any agent runtime that serves POST {base URL}/chat/completions. It must allow this app\'s origin (CORS).',
  },
  {
    id: 'webhook-agent',
    label: 'Custom webhook agent',
    group: 'agent',
    adapter: 'webhook',
    defaultModel: '',
    defaultBaseUrl: 'https://',
    baseUrlEditable: true,
    key: 'optional',
    keyLabel: 'Bearer token (optional)',
    jsonMode: 'json_schema',
    agentic: true,
    defaultTimeoutSec: 180,
    browserCors: 'unverified',
    setupNote:
      'SYN MASTER POSTs {kind, systemPrompt, userPrompt, measurements, responseSchema} to your URL and expects the suggestion JSON back (n8n, Make, LangGraph/LangServe, Flowise, your own agent). The URL must allow this app\'s origin (CORS).',
  },
];

export function getPreset(id: string | undefined | null): ProviderPreset {
  return PROVIDER_PRESETS.find((p) => p.id === id) ?? PROVIDER_PRESETS[0];
}

export const PROVIDER_GROUP_LABELS: Record<ProviderGroup, string> = {
  default: 'Default',
  native: 'Native',
  cloud: 'Cloud (OpenAI-compatible)',
  local: 'Local',
  agent: 'Agents',
};
