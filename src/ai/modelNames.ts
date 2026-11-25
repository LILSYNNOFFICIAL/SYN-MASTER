/**
 * Model-name sanity check for the bring-your-own-AI providers.
 *
 * Catches the mistakes that otherwise surface as an opaque HTTP 400/404 from the provider:
 * a blank or malformed name, an API key or URL pasted into the model field, a model from a
 * different provider (e.g. "gpt-…" on the Anthropic preset), and model ids the provider has
 * retired or deprecated. Retired ids are blocked with the documented replacement; deprecated ids
 * still run but produce a warning notice.
 *
 * Lifecycle data (checked 2026-11-25; re-check when providers announce retirements):
 *   Anthropic  https://docs.claude.com/en/docs/about-claude/model-deprecations
 *   OpenAI     https://developers.openai.com/api/docs/deprecations
 *   Gemini     https://ai.google.dev/gemini-api/docs/models
 *   xAI        https://docs.x.ai/developers/migration/may-15-retirement
 *
 * This only reads names. It never changes the built-in Gemini route (server default model).
 */
import { getPreset } from './providerPresets.ts';

export type ModelCheckLevel = 'ok' | 'warning' | 'error';

export interface ModelCheck {
  level: ModelCheckLevel;
  /** The name that will actually be sent (trimmed, preset default when blank). */
  model: string;
  message?: string;
  /** Documented replacement, when there is one. */
  suggestion?: string;
}

/** Provider families the check knows. openai-compatible gateways are free-form. */
type Family = 'anthropic' | 'openai' | 'gemini' | 'xai';

interface LifecycleEntry {
  family: Family;
  /** Exact id or a regex over the id. */
  match: string | RegExp;
  /** ISO date (UTC) the provider stops serving / redirects the id. */
  retiresOn: string;
  replacement: string;
  /** What happens after retiresOn: requests fail (error) or are silently redirected (warning). */
  after: 'fails' | 'redirects';
  note?: string;
  /** The provider lists the id as shut down without one exact date (retiresOn is a safe past bound). */
  dateUnknown?: true;
}

const LIFECYCLE: LifecycleEntry[] = [
  // Anthropic: retired models return 404 not_found_error.
  { family: 'anthropic', match: /^claude-sonnet-4-5(-20250929)?$/, retiresOn: '2026-11-30', replacement: 'claude-sonnet-5-5', after: 'fails' },
  { family: 'anthropic', match: /^claude-opus-4-5(-20251101)?$/, retiresOn: '2027-01-22', replacement: 'claude-opus-5-5', after: 'fails' },
  { family: 'anthropic', match: /^claude-opus-4-1(-20250805)?$/, retiresOn: '2026-08-05', replacement: 'claude-opus-4-8', after: 'fails' },
  { family: 'anthropic', match: /^claude-(sonnet-4|sonnet-4-0|sonnet-4-20250514)$/, retiresOn: '2026-06-15', replacement: 'claude-sonnet-5-5', after: 'fails' },
  { family: 'anthropic', match: /^claude-(opus-4|opus-4-0|opus-4-20250514)$/, retiresOn: '2026-06-15', replacement: 'claude-opus-4-8', after: 'fails' },
  { family: 'anthropic', match: /^claude-(3[-.]|2\.|2$|instant|1\.)/, retiresOn: '2026-04-20', replacement: 'claude-sonnet-5-5', after: 'fails', dateUnknown: true },
  // OpenAI.
  { family: 'openai', match: /^gpt-4\.1(-2025-04-14)?$/, retiresOn: '2027-01-14', replacement: 'gpt-6-luna', after: 'fails' },
  { family: 'openai', match: /^gpt-4\.1-mini(-2025-04-14)?$/, retiresOn: '2027-01-14', replacement: 'gpt-6-luna', after: 'fails' },
  { family: 'openai', match: /^gpt-4o(-mini)?(-2024-(07-18|08-06|11-20))?$/, retiresOn: '2027-01-14', replacement: 'gpt-6-luna', after: 'fails' },
  { family: 'openai', match: /^o3(-2025-04-16)?$/, retiresOn: '2026-12-11', replacement: 'gpt-6.1-sol', after: 'fails' },
  { family: 'openai', match: /^(gpt-4-turbo.*|gpt-4\.1-nano.*|o1|o1-2024-12-17|o1-pro.*|o3-mini.*|gpt-4o-2024-05-13|chatgpt-4o-latest|gpt-4-0314|gpt-4-0125-preview)$/, retiresOn: '2026-10-23', replacement: 'gpt-6.2-sol', after: 'fails' },
  // Gemini: 2.5 Pro / Flash route to a newer model on 2026-12-01; several older ids are shut down.
  { family: 'gemini', match: 'gemini-2.5-pro', retiresOn: '2026-12-01', replacement: 'gemini-3.8-flash', after: 'redirects', note: 'API access is limited to existing users' },
  { family: 'gemini', match: 'gemini-2.5-flash', retiresOn: '2026-12-01', replacement: 'gemini-3.5-flash-lite', after: 'redirects', note: 'API access is limited to existing users' },
  { family: 'gemini', match: /^gemini-(1\.0|1\.5|2\.0-flash(-lite)?$|3-pro-preview$|3\.1-flash-lite-preview$|2\.5-computer-use)/, retiresOn: '2026-01-01', replacement: 'gemini-4-hydrogen', after: 'fails', dateUnknown: true },
  // xAI: retired slugs keep resolving but are served (and billed) as grok-4.3.
  {
    family: 'xai',
    match: /^(grok-4|grok-4-0709|grok-4-fast-(non-)?reasoning|grok-4-1-fast-(non-)?reasoning|grok-3|grok-code-fast-1)$/,
    retiresOn: '2026-05-15',
    replacement: 'grok-4.7',
    after: 'redirects',
    note: 'xAI redirects these slugs to grok-4.3 and bills at grok-4.3 rates',
  },
];

const FAMILY_PREFIX: Record<Family, { re: RegExp; example: string; label: string }> = {
  anthropic: { re: /^claude-/, example: 'claude-sonnet-5-5', label: 'Anthropic' },
  gemini: { re: /^(gemini|gemma|learnlm)-/, example: 'gemini-4-hydrogen', label: 'Gemini' },
  xai: { re: /^grok-/, example: 'grok-4.7', label: 'xAI' },
  openai: { re: /^(gpt-|o\d|chatgpt-|ft:|codex-|computer-use)/, example: 'gpt-6.2-sol', label: 'OpenAI' },
};

/** Which native family a preset talks to (null for free-form OpenAI-compatible gateways/locals). */
export function presetFamily(presetId: string): Family | null {
  const preset = getPreset(presetId);
  if (preset.adapter === 'anthropic') return 'anthropic';
  if (preset.adapter === 'gemini') return 'gemini';
  if (preset.adapter === 'openai') return 'openai';
  if (preset.id === 'xai') return 'xai';
  return null;
}

const KEY_LIKE = /^(sk-|sk_|AIza|xai-|gsk_|pplx-|r8_|hf_)[A-Za-z0-9_-]{8,}/;

function otherFamilyOf(name: string, own: Family): Family | null {
  for (const fam of Object.keys(FAMILY_PREFIX) as Family[]) {
    if (fam === own || fam === 'openai') continue;
    if (FAMILY_PREFIX[fam].re.test(name)) return fam;
  }
  if (own !== 'openai' && /^(gpt-|o\d-|chatgpt-)/.test(name)) return 'openai';
  return null;
}

/**
 * Check the model name the user entered for a preset.
 * @param now injectable clock for tests; lifecycle dates are compared in UTC.
 */
export function checkModelName(presetId: string, rawModel: string, now: Date = new Date()): ModelCheck {
  const preset = getPreset(presetId);
  if (preset.adapter === 'builtin-gemini' || preset.adapter === 'webhook') return { level: 'ok', model: rawModel.trim() };
  const typed = String(rawModel ?? '').trim();
  let model = typed || preset.defaultModel;
  if (!model) return { level: 'error', model, message: `Enter a model name for ${preset.label}.` };

  if (KEY_LIKE.test(model)) {
    // Never echo something that looks like a secret.
    return { level: 'error', model: '', message: 'The model field contains what looks like an API key. Put the key in the key field and a model name (for example ' + (preset.defaultModel || 'the provider\'s model id') + ') here.' };
  }
  if (/^[a-z]+:\/\//i.test(model)) {
    return { level: 'error', model, message: 'The model field contains a URL. Put URLs in Base URL and only the model id here.' };
  }
  if (/\s/.test(model) || model.length > 200 || /[\u0000-\u001f"'<>`]/.test(model)) {
    return { level: 'error', model, message: `"${model.slice(0, 60)}" is not a valid model id (no spaces or quotes; copy the id exactly from the provider's model list).` };
  }

  const family = presetFamily(preset.id);
  if (!family) return { level: 'ok', model };

  if (family === 'gemini' && model.startsWith('models/')) model = model.slice('models/'.length);
  const fam = FAMILY_PREFIX[family];
  const foreign = otherFamilyOf(model, family);
  if (foreign) {
    return {
      level: 'error',
      model,
      suggestion: fam.example,
      message: `"${model}" is a ${FAMILY_PREFIX[foreign].label} model, but this preset talks to ${fam.label}. Use a ${fam.label} model such as ${fam.example}, or switch provider.`,
    };
  }
  if (family !== 'openai' && !fam.re.test(model)) {
    return { level: 'error', model, suggestion: fam.example, message: `${fam.label} model ids start with "${fam.example.split('-')[0]}-" (for example ${fam.example}); "${model}" is not one.` };
  }

  const entry = LIFECYCLE.find((e) => e.family === family && (typeof e.match === 'string' ? e.match === model : e.match.test(model)));
  if (entry) {
    const past = now.getTime() >= Date.parse(`${entry.retiresOn}T00:00:00Z`);
    const extra = entry.note ? ` (${entry.note})` : '';
    if (past && entry.after === 'fails') {
      const when = entry.dateUnknown ? '' : ` on ${entry.retiresOn}`;
      return { level: 'error', model, suggestion: entry.replacement, message: `${fam.label} retired "${model}"${when}; requests to it fail. Use ${entry.replacement} instead.` };
    }
    if (past) {
      return { level: 'warning', model, suggestion: entry.replacement, message: `"${model}" was retired on ${entry.retiresOn}${extra}. Switch to ${entry.replacement}.` };
    }
    return {
      level: 'warning',
      model,
      suggestion: entry.replacement,
      message: `${fam.label} has deprecated "${model}"; it ${entry.after === 'fails' ? 'stops working' : 'is redirected to another model'} on ${entry.retiresOn}${extra}. Switch to ${entry.replacement}.`,
    };
  }
  return { level: 'ok', model };
}
