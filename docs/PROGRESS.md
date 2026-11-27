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

## 2026-11-26 — Part E1 + E3: prompt coverage test and prompt rewrite

**What changed (plain language)**
- **New safety-net test (E1)** `src/ai/promptCoverage.test.ts`. It treats the limits table (`PROCESSOR_PARAM_LIMITS`) as the single source of truth and fails if: a processor or setting the validator reads has no entry in the limits table; the AI instructions (`SYSTEM_PROMPT`) leave out any processor, any setting, or any option (Dynamic EQ band type, mode, channel, sidechain mode/freq/Q, lookahead, knee all included); a range or option list in the instructions differs from the limits; a validator clamp uses its own numbers instead of the table; or any processor the AI may return is rejected by `validateChainAgainstInventory`. A few fields are excluded on purpose and listed in the test with the reason (band `solo`, band `id`, Match EQ learned spectra, which the engine supplies). I checked the test really bites by temporarily breaking the prompt/validator six ways (removed autoGain, hard-coded a knee range, removed Dynamic EQ lookahead, removed the "vintage" shelf, removed Dynamic EQ band mode, added a literal clamp + new field): each made it fail.
- **Prompt rewrite (E3)** in `src/ai/masteringPrompt.ts`. "Use ONLY needed processors / surgical" is gone. The AI is now told to consider every processor, enable one only when measurements or musical goals justify it, set precise values (not just on/off), give each module a short rationale, name in the summary any tool it deliberately left unused and why, and that the chain will be rendered and re-measured so values should stay conservative where nothing is wrong. Added a short **"measured problem → tool"** map (clicks → restore declick/decrackle/spikeRepair, shimmer → deShimmer, sub/bass excess → Dynamic EQ low band, harshness/sibilance → Dynamic EQ high-mid, loudness short → maximizer, true peak over → limiter, reference gap → Match EQ, buried vocal → Vocal Rebalance, and so on, covering all 16 tools). The objectives list is now generated from `MASTERING_OBJECTIVE_IDS`; the processor count comes from the limits table.
- **Wiring gaps fixed:** (1) the prompt never told the AI the 12-module chain cap, but `validateChainAgainstInventory` rejects a 13-module answer outright (the whole AI chain is thrown away and the local planner takes over) — risky now that the AI is asked to consider all 16 tools; the cap is now stated (`AI_MAX_CHAIN_STAGES = 12`) and tested against the validator. (2) "put restore first" contradicted "Vocal Rebalance always FIRST"; now "restore first (after any vocal-rebalance)". No range/option mismatches were found between the prompt and the limits table.
- **Prompt length (measured with the same sample analysis):** system prompt 9,522 → 10,990 chars; strategy call total (system + user) 10,865 → 12,305 (+1,440, about +13%, almost all of it the problem→tool map the owner asked for); refine total 12,201 → 13,678.
- `PROCESSOR_JSON_SCHEMA` and `parseAiChain` were not touched (another agent owns E2).

**Tests:** `masteringPrompt.test.ts` — one assertion updated for the intended new refine wording ("select only those that fit…" → "consider each and enable only those…"), one new E3 test. New `promptCoverage.test.ts` (6 tests). Nothing skipped or removed.

**Checks run 2026-11-26:** `npm run lint` pass · `npm test` 463/463 pass · `npm run build` pass (main chunk `index-*.js` 838.83 kB raw) · `NODE_ENV=production PORT=3457 npm start` → `/api/health` `{"ok":true,"aiConfigured":false}`.

**Not verified:** a live Gemini call with the new prompt (no `GEMINI_API_KEY` here), so the real effect on strategy-call time (~17 s before) and on tool choice is unmeasured.

**Next:** E2 (schema) and E4 (merge-rule logging) by the other agents; then a live run to compare strategy-call time and chosen tools.
