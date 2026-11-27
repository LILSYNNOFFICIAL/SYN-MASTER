/**
 * Safe short codes describing why a built-in cloud AI (Gemini) call failed upstream.
 * The server sends one of these as `fallbackDetail`; the client only accepts values from
 * this allowlist, so no raw upstream text, request body, stack trace or API key can reach
 * the banner or the diagnostic log through this field. Pure module (no imports) so it is
 * safe to load from server.ts under plain Node 22.
 */
export const AI_UPSTREAM_FAILURE_CODES = [
  'upstream-429',
  'upstream-5xx',
  'upstream-timeout',
  'upstream-safety-block',
  'empty-response',
  'json-parse',
  'schema-validation',
  'unknown',
] as const;

export type AiUpstreamFailureCode = (typeof AI_UPSTREAM_FAILURE_CODES)[number];

export function isAiUpstreamFailureCode(value: unknown): value is AiUpstreamFailureCode {
  return typeof value === 'string' && (AI_UPSTREAM_FAILURE_CODES as readonly string[]).includes(value);
}
