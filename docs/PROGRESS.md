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

## 2026-11-26 — Part E2 + E4 + B2 follow-up (AI schema, AI corrections, Director overrides log)

**What changed (plain language)**
- **E2 – the AI's answer format.** Both answer formats (server Gemini and the shared one used by every other AI provider) now list the allowed processor types as a fixed list built from the validator's limits table, and accept `enabled`, `bypassed` and a short `rationale` per module (`reason` still works). `paramsJson` stays a JSON string. When the AI switches a stage off or bypasses it, that is now honored.
- **No more silent fixes.** If the AI sends broken `paramsJson`, a value out of range (clamped), an unknown option (reset) or a parameter name the tool does not have (dropped), it is recorded with module, parameter, AI value and final value. The diagnostic log shows it under **"== AI parameter corrections =="** (text and JSON). Validation and clamping themselves are unchanged.
- `/api/ai/master` now uses the same objective/mode allowlist as `/api/ai/refine`.
- **E4 – Director overrides (log only).** Every AI value the Director changes before a render is now logged with the reason under **"== Director overrides =="**: the app's Vocal Rebalance policy gate, the 12-stage safety limit, the Match EQ guard (no learned reference / conservative ceiling) and objective-gate repairs (for example "Bass Enhancer sub gain set to 0 dB because the Sub/Bass gate failed"). I checked each override: all of them already only happen for a failing objective gate or a protective guard, so **no merge rule was changed** (nothing loosened). Tests prove AI values survive untouched when no gate fails, overrides still happen and are logged when one fails, and gate verdicts are identical with and without logging.
- Per AI pass the log now lists **every tool the AI chose with the settings actually rendered**.
- **B2 follow-up.** Each rejected pass now records why (for example "Regression guard rejected: transient detail regression") and the export shows it next to the pass. When every pass was rejected, the verdict now says plainly: no processed pass was kept, the result rolled back to Pass 0 and the delivered audio is the original source (instead of only "not tied to a completed render"). Wording/logging only; gate and verdict logic unchanged.

**Files:** `src/ai/aiParamCorrections.ts` (new), `src/ai/aiProvenance.ts` (new), `src/director/directorOverrides.ts` (new), `src/ai/masteringPrompt.ts` (schema block + parseAiChain/normalize only), `src/ai/masteringClient.ts`, `src/server/aiMastering.ts`, `server.ts`, `src/types/mastering.ts` (optional fields only), `src/director/directorEngine.ts`, `src/director/diagnosticLog.ts`; tests `src/ai/aiParamCorrections.test.ts`, `src/director/directorOverrides.test.ts` (new).

**Checks run 2026-11-26 (after rebasing onto the C/D1, D2/D3 and E1/E3 commits):** `npm run lint` pass · `npm test` 483/483 pass · `npm run build` pass · `npm run check:bundle` pass (main chunk `index-*.js` 811.1 kB raw = 792.1 KiB, under the 800 KiB budget; upstream before my commits measured 800.2 kB, so this part adds about 11 kB) · `NODE_ENV=production PORT=3458 npm start` → `/api/health` `{"ok":true,"aiConfigured":false}`.

**Not verified:** a live Gemini call with the new enum schema (no API key here). The Vocal Rebalance gate runs in App.tsx (other agent's file), so its changes are detected by comparing the AI's answer with what the Director receives, not inside App.tsx.

**Next:** end-to-end proof test that every AI parameter reaches the render and changes the audio.

## 2026-11-26 — AI drives every tool: end-to-end parameter proof

**What changed (plain language)**
- New test `src/director/aiParamEndToEnd.test.ts`. For **all 16 processor types and every parameter in the limits table** (153 cases, including Dynamic EQ bands/threshold/ratio/attack/release/knee/mode/channel/sidechain, parametric EQ bands/shapes/subtypes/slopes/channels, multiband compressor and multiband maximizer per band, maximizer, limiter, clipper, restore, Match EQ, Vocal Rebalance with stems, dither, plus the on/off switches and the module mix/intensity/gain controls) a mocked AI answer goes through the same path Fix All uses: AI answer → validation → Director merge → Match EQ guard → the real offline render.
- It checks two things for every setting: (a) the rendered chain really holds the AI's value, or the change is recorded in the log (never silent), and (b) changing that one value really changes the rendered audio.
- **Result: no setting is silently dropped and none is ignored by the audio engine.** Only Match EQ amount / max boost / max cut get capped (the Director's safety ceiling for AI-proposed Match EQ), and that cap is now logged. The full table is in `docs/AI_PARAMETER_PROOF.md`.
- While building the test, a few settings first looked "dead". Each one was a test-signal issue, not a wiring bug:
  - Proportional Q is identical to a normal bell at exactly 6 dB, by design.
  - Dynamic EQ boost only works when the band is above its threshold.
  - De-crackle and spike repair have nothing left to fix once De-click already removed the clicks.
  - The multiband maximizer's high band was below its threshold, and its output limiter was never reached.
  
  The test now uses settings where each control has something to act on. No DSP code was changed.
- Small latency-safe tweak: the schema now tells the AI to send *either* `rationale` or `reason`, not both, so the answer does not grow.

**Checks run 2026-11-26:** `npm run lint` pass · `npm test` 485/485 pass · `npm run build` pass · `npm run check:bundle` pass (main chunk 792.1 KiB raw / 242.8 KiB gzip, unchanged by this test-only step) · `NODE_ENV=production PORT=3458 npm start` → `/api/health` `{"ok":true,"aiConfigured":false}`.

**Timeout ideas noted, not shipped:** see the final report (the prompt builders belong to the E1/E3 work).

## 2026-11-26 — Waveform part 1/4: fade bug fix (export)
- Bug found: with a delivery profile that normalizes loudness (Streaming / Club / Broadcast), the server ran FFmpeg's single-pass `loudnorm` AFTER the faded render. Single-pass loudnorm is a dynamic AGC: it turned the quiet fade regions back up (measured ~+4 dB lift inside a 3 s fade, and overshoot near its end), so exported fades did not fade properly even though the preview render was correct.
- Fix: the client sends `preserveFades=true` when timeline fades exist; the server then measures the render (ebur128) and applies ONE constant gain toward the LUFS target, capped so true peak stays under the ceiling. A single gain keeps every fade shape and true silence. Exports without fades are unchanged.
- Verified (already correct, now covered by tests): gain law reaches exact 0 at fade-in start / fade-out end, linear/exp/S-curve midpoints and quarter points, sample-accurate edges, fades applied after the limiter, export render == preview render.
- Tests: src/dsp/fadeGainLaw.test.ts (4), new export integration test (fade levels preserved through normalized export).
- Next: smooth fade drawing + attenuation shading.
