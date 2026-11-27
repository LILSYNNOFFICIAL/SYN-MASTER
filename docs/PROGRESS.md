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

## 2026-11-26 — Parts C + D1: real progress rings, import overlay, faster import

**What changed (plain language)**
- **One progress ring for everything (C2).** New `src/components/ui/ProgressRing.tsx`: gold base ring, electric-blue fill, % in the middle, optional stage text, states idle / running / stopped / error. It is a real `role="progressbar"` with `aria-valuenow/min/max`, it never moves backwards while a job runs, and animation turns off under "reduce motion". The maths lives in `src/components/ui/progressMath.ts` with unit tests (clamping, never-backwards, stage windows, FIX ALL mapping).
- **Import overlay shows real progress (C3).** The fake timers are gone. The ring now follows the actual work: Reading file 0–5 % (real byte progress), Decoding audio 5–30 % (the browser gives no detail here, so the ring holds and pulses), Analyzing 30–90 % (the background worker reports after each measurement section), Building waveform 90–96 %, Preparing playback 96–100 %. There is a **Cancel** button. If decoding fails, or takes too long on a phone (watchdog: 60 s minimum, about 2 s per MB, max 5 min), you get a clear error with a Dismiss button instead of a hang. (Nothing is saved to storage during import, so the last stage is called "Preparing playback", not "Saving".)
- **FIX ALL ring (C4).** Same ring around the gold button, driven only by the Director's own stage/pass events: analysis 0–10, AI strategy 10–25, then passes ease toward 95; 100 only when the run finishes. Stage text: "AI is thinking…", "Rendering pass N", "Verifying pass N". Stop stays visible while running; on Stop the ring turns to a stopped state, on a failed run to an error state, then it resets cleanly. The "Cloud AI was not used because…" banner is unchanged.
- **Drag-and-drop anywhere (C1 check).** You can now drop an audio file anywhere on the workstation. The empty-state Import button / file picker and "Load demo session" were already there.
- **Faster, lighter import (D1).**
  - The decoded song is **handed** to the worker instead of copied (one ~138 MB copy fewer for a 6-min song), and the playback buffer reuses the browser's decoded audio instead of building another copy (one more copy fewer, stereo files).
  - The 1600-point waveforms (before and after) are now built in the worker, not on the screen thread.
  - The worker's watchdog now resets every time the worker reports progress, so a long song on a slow phone is not killed at a flat 120 s while it is still working; only a silent worker is stopped.
  - When the rack is empty or bypassed (no fades), the preview reuses the import's measurement instead of measuring the same audio twice. **Note:** the app starts with a starter chain (EQ, compressor, maximizer switched on), so on a normal import the second pass is a real render of that chain, not a duplicate; the saving applies when the rack is empty/bypassed.
- **Numbers unchanged.** New `src/dsp/analysisIdentity.test.ts` proves analysis is identical with and without the progress hook, that the import "identity render" returns the exact same samples, and that worker-built peaks equal the old ones. A one-off run on the real 6-min `Shadows_Opening_Click_Repair.wav` also compared the new analyzer against the original file: identical JSON.

**Files:** `src/components/ui/ProgressRing.tsx` (new), `src/components/ui/progressMath.ts` (new), `src/components/ui/progressMath.test.ts` (new), `src/dsp/analysisIdentity.test.ts` (new), `src/dsp/analyzer.ts` (optional progress callback only, no maths changed), `src/dsp/dspWorker.ts`, `src/dsp/workerClient.ts`, `src/engine/audioEngine.ts`, `src/App.tsx`, `src/components/console/MasterConsole.tsx`, `src/index.css`.

**Tests:** one existing test's error-message regex is still matched (message now "timed out after N ms without progress"); nothing skipped or weakened.

**Checks run 2026-11-26:** `npm run lint` pass · `npm test` 465/465 pass · `npm run build` pass (main chunk 845.68 kB raw / 825.9 KiB; still over the 800 KiB budget, D2 next) · `NODE_ENV=production PORT=3456 npm start` → `/api/health` `{"ok":true,"aiConfigured":false}`.

**Not verified:** real Android Chrome behaviour (no device here).

**Next:** D2 lazy-loading to get the main chunk under budget, then D3 mobile checks.

## 2026-11-26 — Parts D2 + D3: smaller first load, mobile checks

**What changed (plain language)**
- **Main app file is now under the size budget (D2).** Two views that are not on screen when the app opens now load only when needed: the Spectrum/Spectrogram view in the EQ panel (not the default tab) and the "Fix It" stage panel (only shown after a run has a diagnostic log, together with its diagnostic-log panel). No vite config or budget changes.
  - Main chunk before: **837.27 kB / 817.7 KiB raw, 250.2 KiB gzip** (Part A build) → after C+D1: 845.68 kB / 825.9 KiB → **after D2: 800.16 kB / 781.4 KiB raw, 239.3 KiB gzip**.
  - `npm run check:bundle`: **passes** (limits 800 KiB raw / 250 KiB gzip). Rollup now also puts the shared analyzer (16.6 KiB) in its own small chunk; it is still loaded at start because the main app needs it, so the real first-load saving is about 28 KiB.
- **Mobile checks (D3).** Playwright + Chromium headless were installed in the sandbox only (not added to the project).
  - `scripts/mobile-emulation-check.mjs`: **passed** at 412×915 and 390×844 (touch seek, menus stay on screen, drawer, reduced motion). This is Chromium emulation, not a real phone.
  - `scripts/responsive-layout-check.mjs`: **fails at its first step, for a reason that predates this work.** It looks for the "Cloud AI is included" help button on the old Import start screen, which no longer exists since the start screen was removed (d92598e). That help dialog is now only reachable from the unused `ImportScreen.tsx`. I did not edit the check (that would drop an assertion). Decision needed: put the Cloud AI help button somewhere in the workstation, or update the check.

**Files:** `src/App.tsx` (FixItStage lazy), `src/components/console/MasterConsole.tsx` (Spectrum view lazy).

**Checks run 2026-11-26:** `npm run lint` pass · `npm test` 472/472 pass · `npm run build` pass · `npm run check:bundle` pass · `NODE_ENV=production PORT=3456 node server.ts` → `/api/health` `{"ok":true,"aiConfigured":false}`.

**Not verified:** a real Android phone (import overlay, Cancel, decode errors, memory use on a long WAV).
