# SYN-MASTER progress log

Dated entries, newest last, so work can resume if a session is cut off.

## 2026-11-26 — Part A: timeouts and error visibility

**What changed (plain language)**
- **Timeouts (A1).** The server now waits up to **60 s** for Gemini (`GEMINI_TIMEOUT_MS = 60_000`, `src/server/aiMastering.ts`) and the browser waits up to **70 s** (`CLOUD_AI_TIMEOUT_MS = 70_000`, `src/ai/cloudRateLimit.ts`), so the browser always gives the server time to answer first. These are higher than the 50 s / 60 s in the work order on purpose (raised earlier and kept). A normal strategy call took about 17 s in the real runs, so 60 s leaves plenty of room.
- The timeout labels are now just **`server`** or **`client`** (no more `server-25s` / `client-30s`), and the actual limit in milliseconds is recorded next to it (`timeoutMs`). The diagnostic log shows, for example, `timeoutHit=server (60000 ms)`, and the panel shows `server timeout 60000 ms`.
- **Real failure reasons (A2).** When Gemini fails, the server now sorts the failure into one short, safe code and sends it as `fallbackDetail`: `upstream-429` (Google rate limit), `upstream-5xx` (Google server trouble), `upstream-timeout`, `upstream-safety-block`, `empty-response`, `json-parse`, `schema-validation` or `unknown`. That code appears in the "Cloud AI was not used because…" banner and in the diagnostic log (text and JSON) instead of only "AI mastering service could not complete the request."
- The server never sends the API key, request/response bodies or stack traces to the browser: the message is a fixed sentence, and the browser only accepts codes from a fixed allowlist (`src/ai/aiFailureCodes.ts`). The server console line is key-redacted and has no stack.
- An **empty** or **safety-blocked** Gemini answer is now reported as such. Before, an empty answer was silently treated as "no processors" (strategy) or "keep the current chain" (refine); now that call falls back to the local planner / Director with the reason shown. It does **not** trigger an extra call to the backup model.
- **No retries (A3).** No automatic retries were added. (The existing one-time switch to the backup model `gemini-3.1-flash-lite` when the main model is overloaded or rate-limited was already there and is unchanged.)

**Files:** `server.ts`, `src/server/aiErrorClassification.ts` (new), `src/server/aiErrorClassification.test.ts` (new), `src/ai/aiFailureCodes.ts` (new), `src/server/aiMastering.ts`, `src/ai/cloudRateLimit.ts`, `src/ai/cloudRateLimit.test.ts`, `src/types/mastering.ts`, `src/App.tsx` (only the AI error trace objects get `timeoutMs`, plus one comment; import path untouched), `src/director/directorEngine.ts` (passes `timeoutMs` through the refine trace), `src/director/diagnosticLog.ts`, `src/director/diagnosticLog.test.ts`, `src/director/fixAllMockedAi.test.ts`, `src/components/studio/DiagnosticLogPanel.tsx`.

**Tests:** updated expected values only for the label rename (`server-25s`→`server`, `client-30s`→`client`) and the new timeout ms; nothing skipped or removed. New tests cover classification of every code, HTTP status mapping, allowlisting on the client, and that keys/bodies/stacks never leak.

**Checks run 2026-11-26:** `npm run lint` pass · `npm test` 456/456 pass · `npm run build` pass (main chunk `index-*.js` 837.27 kB raw, unchanged area; budget not touched) · `NODE_ENV=production PORT=3456 npm start` → `/api/health` returned `{"ok":true,"aiConfigured":false}`.

**Not verified:** a live Gemini call (no `GEMINI_API_KEY` in this sandbox), so the codes were tested with simulated errors shaped like the `@google/genai` SDK's `ApiError` (numeric `status` + message).

**Next:** Part B (read-only investigations: import lag trace, "regressed" label / `master:null` export). Another agent is investigating the import path.
