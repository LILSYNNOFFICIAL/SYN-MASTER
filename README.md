# SYN MASTER

**Precision Engineering. Intelligent Mastering. Exceptional Sound.** The goal: *Ozone on steroids.*

SYN MASTER is an AI-assisted mastering workstation (React + TypeScript + Vite front end, an Express server that holds the Gemini key, offline Web Audio / SYN-DSP rendering, and an optional Windows VST3 companion host). It was created in **Google AI Studio** (published at https://syn-master.ai.studio/), edited with ChatGPT, and synced back into AI Studio through this GitHub repo.

> **Handoff note for ChatGPT / the next developer.** This README is the single source of truth for what the owner (LIL SYNN / LILSYNNOFFICIAL) wants. Read the *Vision / Spec* section, then pick up the first unticked item in the *Roadmap*. Tick items (`- [x]`) as you finish them and commit straight to `main` (the owner wants every commit pushed directly to `main`: no branches, no PRs). Commit small and often.

## AI Studio compatibility rules (do not break)

- Keep the entry files: `index.html` -> `src/main.tsx` -> `src/App.tsx`, `src/index.css`, `vite.config.ts`, `server.ts`, `metadata.json`.
- Keep the build setup: `npm run dev` (`tsx server.ts`), `npm run build` (`vite build`), Tailwind v4 via `@tailwindcss/vite`.
- The Gemini API key is read **only on the server** from `process.env.GEMINI_API_KEY` (see `server.ts` / `src/server/aiMastering.ts`). Never move it into client code or a `VITE_` variable.
- No new backend services. New DSP goes in the browser (Web Audio API / `OfflineAudioContext` / the existing `src/dsp/*` offline renderer).
- Minimal checks before pushing: `npm run lint` (tsc) and `npm run build`.

## Browser, Windows, and Android product requirements (owner confirmed Nov 23 2026)

The browser workstation is the primary product surface. Desktop should behave like a focused mastering DAW rather than a generic dashboard: a persistent project/audio library on the left, a full-width transport and Fix-It timeline across the top of the work area, spectrum/EQ in the central lane, a visible processor chain on the right, and a bottom stereo meter bridge. Preserve the black-and-gold identity, mastering controls, and existing workspace navigation.

Responsive behaviour is a product requirement:
- Desktop/laptop: docked library, central timeline/spectrum, right processor rack, persistent stereo meters, keyboard and mouse operation.
- Tablet/narrow browser: collapse rack below spectrum, preserve transport, allow independent panel scrolling.
- Android browser: one-column layout, large touch targets, no horizontal page scroll, touch-friendly waveform/EQ/rack interactions, safe-area-aware floating windows, and no hover-only controls. Keep import, playback, Fix All, diagnostics, and export reachable.
- Keep the hosted URL as the source of truth. A future Android wrapper can load that URL, in the same broad direction as SYN-SOUND, but it must not fork the product UI or move mastering authority into a WebView-only code path.
- A complete Windows desktop EXE is a future packaging milestone. The existing Windows workflow builds native VST3 plugin host/scanner/worker executables; those are not the complete SYN-MASTER workstation. After the browser workflow and host integration are stable, compare Electron (reuse of the current Node/Express runtime, larger footprint) with Tauri (smaller shell, but requires an explicit strategy for the existing server process). Do not mark the full application EXE complete until the UI, local API lifecycle, audio-device/host bridge, installer, signing, and upgrade path are verified on Windows.
- UI package decision: keep Tailwind CSS v4 + custom CSS and `lucide-react` for this pass. Do not add a heavyweight component library that would increase bundle cost and fight the purpose-built DAW controls. Evaluate a small headless primitive only when a real accessibility/interaction need appears.
- Do not introduce another backend service. Gemini credentials remain server-side. The same product must continue to run in AI Studio and as a browser-hosted URL.

## Vision / Spec

### 1. Core bug: Fix & Master must actually verify the master
The AI "fix and master" flow did not properly verify that the track was mastered correctly. The code and logic must be audited and fixed so that "passed" means the **rendered output** was re-measured and met its targets (see Roadmap for the root cause and fix status).

### 2. Mastering loop (analyze -> log -> fix -> render -> re-analyze -> repeat)
1. Analyze the track.
2. Write a **diagnostic log** (temp/log panel, downloadable as JSON and text) of everything wrong with it: clipping, true-peak overs, LUFS off target, clicks/pops, AI artifacts, harshness, mud, sibilance, stereo/phase problems, DC offset, low-end issues, etc., plus the **exact settings every tool needs** to fix each one.
3. Apply those settings (AI + algorithm), render, **re-analyze the rendered audio**, and repeat until the master passes its targets, with a **max-iteration cap**.
4. Goal: right on the first press, so a later analysis does not find new flaws.
5. Pass/fail uses **objective measured checks**, not AI opinion: integrated LUFS, true peak (dBTP), LRA, crest factor, clip count, click detection, spectral balance against a reference curve, phase correlation, DC offset.

### 3. AI-generated audio repair (Suno etc.)
De-click, de-crackle, transient spike repair, and AI-shimmer / metallic artifact reduction.

### 4. New UX
- First screen: **"Import your track"** (drag-and-drop upload).
- After import: the waveform with a time grid and a big **"FIX IT ALL WITH AI"** button in the center.
- Pressing it reveals the technical data/details and runs the full auto-master with one button.

### 5. Manual mode: a mini DAW built only for mastering
- Parametric EQ that looks and works like FL Studio's **Fruity Parametric EQ 2** (live spectrum, draggable band nodes, band types).
- The Parametric and Dynamic EQ views share one top-of-workspace canvas with the actual track waveform behind the EQ response and draggable band nodes in front; click/drag the background waveform to seek, while EQ nodes continue to edit their real DSP bands.
- **Fade-in / fade-out lines** you click and drag on the waveform (FL Studio style).
- Compression, multiband compression, limiter/maximizer, high-pass and low-pass filters, frequency splitters/crossovers, a **Maximus-style multiband maximizer**, stereo imager, saturation/exciter, de-esser, dynamic EQ, transient shaper, clipper, dither, loudness targets (Spotify / Apple Music / YouTube presets), **A/B compare**, and new innovative tools.
- Knobs, dials, and sliders.

### 6. Chainable FX rack
A channel/FX rack in a **floating window** you can drag and resize, with reorder, bypass, and add/remove modules through a nice dropdown menu.

### 7. AI controls every tool
The AI and the algorithm must be able to set every tool's parameters, since more tools means a better master.

### 8. Look and feel
Keep the **black and gold** look, with a docked DAW-style desktop layout and a touch-first responsive Android browser layout. Retain Tailwind v4, custom CSS, and Lucide icons for this phase. Reassess a headless primitive only when a specific accessibility/interaction need appears; do not replace the CSS system with a heavy dashboard kit.

## Roadmap

Priority order. Tick as done; note open problems inline.

- [x] Rewrite README with Vision / Spec + Roadmap (handoff note)
- [x] Audit + fix the Fix-All verify / re-analyze loop (root cause documented below)
- [x] New first screen: "Import your track" drag-and-drop (`src/components/studio/ImportScreen.tsx`)
- [x] Waveform with time grid + big centered "FIX IT ALL WITH AI" button that runs the full auto-master and reveals technical details (`FixItStage.tsx`, `TimelineWaveform.tsx`)
- [x] Diagnostic log panel (every issue + exact per-tool settings), downloadable as JSON and text (`src/director/diagnosticLog.ts`, `DiagnosticLogPanel.tsx`)
- [x] Iterative fix/verify engine on objective metrics (LUFS, dBTP, LRA, crest, clips, clicks, spectral balance vs reference curve, phase correlation, DC) with max-iteration cap (`src/director/masterTargets.ts`, gate wired into `runAutonomousDirectorLoop`, cap 10 passes / 120 s)
- [x] De-click / de-crackle / transient spike repair (`src/dsp/repair.ts`, detector `src/dsp/clickDetect.ts`, exposed as SYN-Restore params `declick`, `decrackle`, `spikeRepair`)
- [x] AI-shimmer / metallic artifact reduction (SYN-Restore `deShimmer`, dynamic 9 kHz+ band reduction weighted to the side channel)
- [x] New black + gold layout and CSS (SYN2 design system in `src/index.css`: import screen, Fix-It stage, floating rack, warm-black panels and gold hairlines across the whole workstation; studio tab rearranged to Import → Fix-It stage → spectrum → rack)
- [x] Floating draggable/resizable FX rack window with reorder (drag or arrows), bypass, duplicate, remove and a categorized "Add module" dropdown (`FxRackWindow.tsx`, `FloatingWindow.tsx`, `moduleCatalog.ts`)
- [x] FL-style parametric EQ (spectrum, coloured draggable nodes, wheel = Q, 6 band types, up to 8 bands) in `ParametricEQ2.tsx`, shown when an EQ slot is expanded in the FX rack
- [x] Dynamics modules with knobs (compressor, multiband, limiter/maximizer, dynamic EQ already existed; NEW `clipper` and `transient-shaper` processors in `src/dsp/extraProcessors.ts`; de-esser via SYN-Restore and the rack's De-esser template)
- [x] Draggable fade-in / fade-out lines on the waveform (gold corner handles; S-curve/linear/exponential; applied to every render and the export via `src/dsp/fades.ts`)
- [x] Maximus-style multiband maximizer (`multiband-maximizer`: LR4 3-band split, per-band pre-gain/threshold/ratio/attack/release/post, true-peak master ceiling)
- [x] Loudness target presets (Spotify / Spotify Loud / Apple / YouTube / Tidal / Amazon / SoundCloud / Club / EBU R128) in `src/dsp/loudnessTargets.ts`, selectable on the Fix-It stage
- [x] A/B compare (Original vs Master toggle on the Fix-It stage; loudness-matched when the Preferences option is on)
- [x] Remaining tools exposed in manual mode and controllable by the AI: HPF/LPF and mono-maker templates, multiband crossovers (multiband comp / maximizer), stereo imager, saturation/exciter, de-esser. Dither is now also a rack module (see below) besides Export settings

- [x] Dither module in the rack (`dither`: 16/20/24-bit, TPDF / high-passed TPDF / noise-shaped, auto-blank silence, fixed-seed so renders stay deterministic; `applyDither` in `src/dsp/extraProcessors.ts`). In the "Add module" dropdown under Loudness ("Dither", "Dither 16-bit (CD)"); keep it last. Export skips its own dither when an active Dither module is in the chain. AI schema + inventory updated.

### Verification bug: root cause (fixed)
Four problems combined so that "FIX ALL & VERIFY" could say a track was mastered when it was not:

1. **"Converged" was judged on a rejected pass.** The convergence check looked at the pass that had *just* been rendered, even when the regression guards had rejected that pass. The run then reported "Converged" while the chain actually delivered was an older pass that never met the targets. Convergence is now judged only on the retained best pass.
2. **Two different loudness targets.** The mastering objective (e.g. Electronic, -9.5 LUFS) and the QC profile (default Streaming, -14 LUFS) were chosen separately. The loop pushed toward one target while QC judged against the other, so a run could never truly pass, or passed against the wrong number. The objective is now the single source of truth for LUFS / true peak (`alignQcProfileToObjective`), in the loop and in the QC panel.
3. **No objective pass/fail gate.** "Done" leaned on a heuristic fit score (≥ 90) and QC. Now every pass's rendered audio is re-measured by `evaluateMasterTargets` (LUFS, dBTP, clipped samples, clicks, DC, phase, low-end phase, dynamics collapse, crest collapse, spectral balance vs reference). A gate-passing pass always beats a failing one, convergence requires the gate, plateaus no longer stop the loop while the gate fails, and the final report states plainly whether targets were met (`report.targetGate`). Clicks/pops were not measured at all before; they are now detected and fixed on the first pass.
4. **What you heard was not what was verified.** "Mastered" playback ran an approximate realtime Web Audio graph, while verification and export used the offline renderer. Playback now uses the exact verified offline render (hot-swapped after each re-render).

### Real-track findings: "Shadows" blind test (Nov 2026)
The owner's real Suno track *Shadows* (opening click-repair version) was run blind through the headless Fix-All runner and cross-checked with ffmpeg.

- **What was actually wrong with the source:** only low loudness, **-15.9 LUFS integrated / -4.4 dBTP**. No real clicks, no hiss, no clipping.
- **What the app got wrong (all fixed, see commits `1504c44`, `0b1d690`, `d5128dd`, `bbeacd1`, `7d7fe95`, `163e462`):**
  - 9 false "clicks" that were really drum hits -> click detector now uses a width + recovery test (real-track false positives 9 -> 0).
  - A false -30 dBFS "noise floor" finding on quiet musical passages, which inserted an unneeded hiss gate -> noise floor now needs noise-like quiet frames (HF share); plan and QC share the test.
  - True peak read up to 0.1 dB low on bright masters -> 16-tap Kaiser interpolator, now matches ffmpeg `ebur128`.
  - Hard-limited drum onsets in the render were counted as *new* clicks, which blocked every pass at -9.5 LUFS -> `filterIntroducedClicks` ignores render clicks that are source transients sharpened by gain/limiting.
- **Results after the fixes, measured independently by ffmpeg `ebur128=peak=true`:** Streaming objective **-14.05 LUFS / -0.99 dBTP**; Electronic objective **-9.82 LUFS / -0.79 dBTP**. Both pass the objective gate.

**Current owner-supplied source input (Nov 23, 2026):** `Shadows_Opening_Click_Repair.wav` is a 5:59.56 stereo, 48 kHz PCM source premaster. FFmpeg baseline: **-15.9 LUFS integrated, -4.4 dBTP, 9.4 LU LRA**, with negligible channel DC offset (approximately +0.00004 / -0.00002). These are source measurements, not a mastered result or objective pass. The exact file still needs to be run through the current pipeline and the retained WAV independently re-measured and auditioned.

**Reproduce / verify a master headlessly:**
```bash
npx tsx scripts/headless-master.ts input.wav streaming out_streaming.wav   # or electronic, pop, ...
ffmpeg -hide_banner -nostats -i out_streaming.wav -af ebur128=peak=true -f null - 2>&1 | tail -12   # I: LUFS, True peak dBFS
ffmpeg -hide_banner -i out_streaming.wav -af astats=metadata=0 -f null - 2>&1 | grep -E "Peak level|DC offset|Number of clips"
```
The runner prints a JSON summary (before/after LUFS, dBTP, LRA, crest, clicks with times, DC, gate verdict) and writes a 32-bit float WAV of the retained chain. It uses the deterministic engine only (no Gemini).

**Historical findings and current status:** the original post-analysis panel did not use the Fix-All source-transient filter, and a run whose primary retention score rejected every pass always returned the untouched source. Both code paths are addressed in the current work below: a shared click-classification helper now feeds the Director and visible post-render analysis, and a constrained safe-candidate fallback can retain measurable progress without bypassing hard regression guards. The source-click residual allowance remains at 25% until broader real-music calibration supports changing it. Shimmer thresholds still need real Suno/stem calibration.

**Priorities:** run the exact owner-supplied source through the rendered pipeline; complete long-track memory and Android Chrome stability checks; calibrate shimmer and audition preview approximations on real music; verify configured AI providers and hosted AI Studio behaviour.

### Where the new work lives (map for the next dev)
| Area | Files |
| --- | --- |
| Objective pass/fail gate | `src/director/masterTargets.ts` (used in `runAutonomousDirectorLoop`, `src/director/directorEngine.ts`) |
| Click detection / AI-audio repair | `src/dsp/clickDetect.ts`, `src/dsp/repair.ts` (SYN-Restore params `declick`, `decrackle`, `spikeRepair`, `deShimmer`) |
| New processors | `src/dsp/extraProcessors.ts` (transient shaper, clipper), `applyMultibandMaximizer` in `src/dsp/offlineDsp.ts` |
| Diagnostic log (JSON/text) | `src/director/diagnosticLog.ts`, `src/components/studio/DiagnosticLogPanel.tsx` |
| New UX | `src/components/studio/` (`ImportScreen`, `FixItStage`, `TimelineWaveform`, `FxRackWindow`, `FloatingWindow`, `ParametricEQ2`, `moduleCatalog`) wired in `src/App.tsx` |
| Fades / loudness targets | `src/dsp/fades.ts`, `src/dsp/loudnessTargets.ts` |
| Styling | `src/index.css` (SYN2 section at the bottom) |

### Open items
- [x] The realtime Web Audio graph (`src/engine/audioEngine.ts`) includes approximations for clipper, transient shaper, and multiband maximizer. Mastered playback uses the exact retained offline render; the realtime graph remains a low-latency preview path.
- [ ] Ear-test the preview processors against the retained offline render in desktop Chrome and Android Chrome; inspect transient shape, distortion, stereo/phase, latency, and audible differences before calling preview parity verified.
- [x] AI-shimmer detection is implemented (`src/dsp/shimmerDetect.ts`, `analysis.shimmer`): side/mid energy at 9-16 kHz, independent side-HF flicker, and HF tonality; confidence requires enough HF and cue agreement. The deterministic engine enables SYN-Restore `deShimmer` at confidence ≥ 0.6 and the gate reports an advisory check.
- [ ] Validate shimmer scoring on real Suno vocals, cymbals, synths, and stems before changing synthetic-calibrated thresholds. Preliminary owner-source probe: an independent NumPy reproduction of the current detector equations on `Shadows_Opening_Click_Repair.wav` returned score 0.205 and confidence 0.123 (below the 0.6 auto threshold); this is source-only analysis, not a rendered-master or broader corpus validation.
- [x] The Director stops on the first retained pass whose re-measured render meets every blocking objective target. An open low-mid "mud" note is advisory and no longer forces extra passes after an objective pass.
- [x] Mouse-wheel Q on EQ nodes uses a native non-passive `wheel` listener on the EQ SVG (`preventDefault`), so the page no longer scrolls while adjusting Q; nodes carry `data-band-id`.
- [x] Fades run AFTER the effects chain (`processChainOffline(..., postFades)`), in preview, Fix-All, battle, checkpoint audition, WASAPI audition and export, so the limiter sees the unfaded signal.
- [ ] Ear-test the realtime preview processors against the retained offline render with headphones/monitors; inspect transient shape, distortion, stereo/phase, and latency.
- [x] The click detector covers the first and last ~3 ms (`findEdgeClick` in `src/dsp/clickDetect.ts`); edge clicks are never forgiven by source-transient classification, and the objective gate rejects either edge.
- [x] Rendered click interpretation is shared between the Director and visible post-render analysis by `filterSourceTransientClickAnalysis`; detector thresholds and the 25% source-click allowance are unchanged. Broader click-policy calibration remains open.
- [x] **Automated verification for the responsive DAW / safe-fallback code:** GitHub Actions run [45289828376](https://github.com/LILSYNNOFFICIAL/SYN-MASTER/actions/runs/45289828376) on the complete source tree commit `26c6c824` passed **198/198 tests, 0 failures, 0 skips**, TypeScript (`tsc --noEmit`), Vite production build, and Node 22 production startup with `/api/health` and root-page checks. Earlier run 45289071180 was cancelled while the full tree was being restored. Build warning retained for follow-up: the main JS chunk is 732.16 kB minified (218.19 kB gzip).
- [ ] Sync the pushed code into Google AI Studio and inspect the live hosted app, AI provider connections, server-only Gemini configuration, and deployment access boundary.
- [ ] Android Chrome: test import, timeline seek/touch, EQ editing, FX-window scrolling/resizing, playback, Fix All and cancellation, export/download, background/resume, and a near-six-minute render without tab eviction or OOM.

---

## Current engineering worklist (owner-directed, Nov 23 2026)

This section is the active implementation queue and progress ledger. Update it in the same commit as each meaningful code change. A checkbox is only checked after the corresponding code and regression coverage are present; CI and runtime verification are recorded separately. Do not weaken an objective, detector, regression guard, or test to obtain a pass.

### Execution order

- [x] **P0-1: Unify sub-bass excess reporting, correction, and objective verification.** The source finding trigger (> +2 dB) and delivered-render target (≤ 0 dB) share one measured Sub (20-60 Hz) minus Bass (60-250 Hz) gate. The director selects a 1/3-octave-smoothed correction centre from the measured 20-60 Hz spectrum and applies a bounded bell cut there, rather than relying on a fixed 45 Hz shelf that can hit its gain limit without reaching the gate. Positive Bass Enhancer sub gain is removed and every pass is re-measured. Regression coverage, unit tests, TypeScript, production build, and Node 22 startup smoke test passed CI run 45283310903. An owner-provided source track independently reproduced the reported +5.3 dB baseline; the rendered output and Android/browser listening check remain pending.
- [ ] **P0-2: Bound offline-render memory and CPU on long tracks/mobile browsers.** Implemented: worker-owned transferred audio buffers are rendered in place (removing a second full-track stereo copy); one reusable wet/dry scratch pair serves all sequential modules including the limiter; chunked 8192-sample multiband scratch; streaming analyzer K-weight/LR correlation with bounded 400 ms energy ring; and in-place lookahead limiting that removes the full-track driven stereo copies. True-peak interpolation applies drive scaling with Float32-equivalent rounding and maintains a nine-sample minimum source guard so the in-place cursor never corrupts future interpolation windows. The ownership/scratch regression tests passed with the full suite (194/194), TypeScript, production build, and Node 22 startup smoke test in CI run 45283973497. Remaining: profile complete worker/session peak memory on a long track and verify Android Chrome stability before marking complete.
- [ ] **P0-3: Complete live hosted Gemini access-boundary verification.** Implemented in source on `main`: production `/api/ai/*` routes require a separate `SYN_MASTER_AI_ACCESS_TOKEN` bearer credential (minimum 32 bytes); missing production configuration fails closed with HTTP 503, and missing/invalid caller credentials are rejected with HTTP 401 before JSON parsing or billable Gemini work. The existing 20-request/minute IP limiter remains in front of the auth gate. Built-in Gemini Settings now accepts this separate token and stores it in session storage unless local persistence is explicitly enabled. The Gemini API key remains server-only. Unit tests are included. **Still open:** configure the production secret, sync source into AI Studio, inspect Cloud Run/IAM/IAP, and verify live 401/503/authorized behaviour without consuming Gemini quota. Repository access cannot inspect deployment secrets or upstream policy.
- [x] **P1-1: Align objective and QC loudness tolerances.** The final gate now uses the same `objective.lufsTolerance` carried by each objective instead of a fixed 0.65 LU tolerance. Boundary regression tests passed CI run 45279307130.
- [ ] **P1-2: Calibrate the residual click acceptance policy on a broader real-music set.** Keep the current allowance of 25% of source clicks until vocals, drum-heavy material, quiet intros/outros, and deliberately damaged audio establish a defensible target. Do not weaken source-transient false-positive protection.
- [x] **P1-3: Harden codec export resource handling.** Streamed input/output, 512 MiB ceiling, two-job global cap, same-origin browser guard, existing per-client rate limiter, and temp cleanup are implemented. Integration tests cover same-origin export, cross-origin rejection, declared oversize rejection, and two-active-job concurrency. CI run 45281206214 passed unit tests, TypeScript, and production build.
- [x] **P1-4: Make FFmpeg-dependent tests portable.** The export integration test probes FFmpeg and ffprobe once and skips with an explicit reason only when either is absent. CI continues installing both tools and exercising the integration test. CI run 45280105660 passed.
- [x] **P1-5: Discover tests automatically.** `npm test` now passes recursive `src/**/*.test.ts` and `src/**/*.test.mjs` patterns to the Node test runner instead of maintaining a manual file list. CI run 45280105660 passed.
- [x] **P1-6: Enable TypeScript strictness incrementally.** Stage 1: `strict: true` enabled without `noUncheckedIndexedAccess`. Node 22 CI run 45281813691 passed unit tests, TypeScript, and production build with no type corrections or suppressions required. Keep `noUncheckedIndexedAccess` as a separate later stage.
- [x] **P1-7: Verify the `npm start` runtime path.** The production smoke test starts the built app through the exact `npm start` command on Node 22.23.5, then verifies `/api/health` and the production root page. CI run 45282058467 passed unit tests, TypeScript, production build, and startup smoke test. No change to the startup command was needed; `npm run dev` remains `tsx server.ts`.
- [x] **P1-8: Unify source-transient click classification across rendered-analysis surfaces.** `filterSourceTransientClickAnalysis` is shared by the Director and visible App post-render analysis. Regression coverage protects source drum attacks, newly introduced clicks, and edge-click enforcement. Detector thresholds and the 25% source-click allowance are unchanged. CI run 45289828376 passed on restored full-tree commit `26c6c824` (198/198 tests; TypeScript, production build, and Node 22 startup smoke test).
- [x] **P1-9: Retain a safe fallback candidate when primary ranking rejects every pass.** Requires no hard-regression reasons, fit within 1.5 points of baseline, no increase in QC failures, no new objective-gate failure, and measurable reduction in objective failures or QC failures. Ranks eligible candidates by gate progress, QC, fit, and click count. The selected render retains its own gate and is NOT PASSED unless that gate passes. Source remains fallback when no candidate qualifies. CI run 45289828376 passed on restored full-tree commit `26c6c824` (198/198 tests; TypeScript, production build, and Node 22 startup smoke test).
- [x] **P1-10: Dock the Studio into a responsive mastering-DAW layout.** Desktop gets a persistent library rail, full-width Fix-It/timeline surface, centre spectrum, right processor rack, and bottom meter bridge. Tablet stacks the spectrum and rack; Android uses a touch-first one-column layout, waveform horizontal scrub with vertical page scrolling, and safe-area-aware floating rack. Existing Tailwind v4/custom CSS and Lucide retained; no new UI package added. CI run 45289828376 passed. Desktop, tablet, and Android visual/device verification remains pending.
- [ ] **P1-11: Complete real-track and device acceptance.** Run the exact owner-supplied 5:59.56 premaster through `scripts/headless-master.ts`, independently compare the retained output with FFmpeg, audition A/B, and profile browser/worker peak memory. Repeat on Android Chrome and a Windows desktop browser before closing P0-1/P0-2 device gates.
- [ ] **P1-12: Calibrate shimmer and audition realtime preview.** Validate real vocals, cymbals, synths, layered highs, legitimate stereo air, clicks, drum attacks, transients, limiter peaks, distortion, phase, and preview latency. Do not change synthetic-calibrated thresholds or preview DSP by assumption.
- [ ] **P2: Package the full Windows workstation and plan the Android URL wrapper.** Build/test a complete EXE only after deciding how the current Node server/API and native host run together; separately evaluate a URL-backed Android wrapper without creating a second source of truth. The Windows native companion workflow passed run [45289828408](https://github.com/LILSYNNOFFICIAL/SYN-MASTER/actions/runs/45289828408): Visual Studio 2022 x64 Release configure/build, CTest (1/1 native test), compiled VST3 discovery, real host/worker pairing and load, parameter/state roundtrip, +6.00 dB signal measurement, bit-identical bypass, crash/hang isolation, and clean shutdown. It uploaded artifact [`syn-plugin-host-win64-m2`](https://github.com/LILSYNNOFFICIAL/SYN-MASTER/actions/runs/45289828408/artifacts/14872224702) (9,643,882 bytes). These are native VST3 companion executables and a QA bundle, **not** a complete standalone SYN-MASTER workstation EXE or installer.
- [ ] **P2: Reduce initial JavaScript chunk size for mobile delivery.** The current successful production build emits a 732.16 kB minified main JavaScript chunk (218.19 kB gzip) and Vite warns above its 500 kB chunk threshold. Review dynamic imports and optional workspace boundaries without deferring the import/mastering path or adding a heavyweight UI framework.
- [ ] **P2: Defer broad App/director refactors, lint/format toolchain additions, native cross-platform work, `noUncheckedIndexedAccess`, and cosmetic repository cleanup** until mastering correctness and mobile resource use have regression coverage.

### Commit policy and implementation ledger

- Every implementation commit goes directly to `main`. Never create a branch, pull request, or force-push.
- Each commit must update this README with its subject, scope, and verification status. Small conventional commits only.
- Re-read the current `main` head immediately before writing. Use a fast-forward update with an expected-head check; if the head moved, stop and reconcile rather than overwrite.
- A passing TypeScript check or desktop CI is not evidence of Android Chrome stability or subjective mastering quality. Record those separately.
- Browser-first delivery is the target. The full Windows workstation EXE and Android URL wrapper are separate packaging milestones; the existing VST3 companion executables are not the full product.
- [x] **docs: establish prioritized engineering worklist** — [\`9d49cada\`](https://github.com/LILSYNNOFFICIAL/SYN-MASTER/commit/9d49cadafeeb56ab8b4b9acf802d0c41e1692101); prioritized worklist and commit-ledger policy.
- [x] **fix: gate and repair measured sub-bass excess** — [\`d5160309\`](https://github.com/LILSYNNOFFICIAL/SYN-MASTER/commit/d5160309ad809103c171b7dbaeac0d62840d8af4); empty/no-file-change commit created during the first write attempt, superseded by the implementation commit below.
- [x] **fix: gate and repair measured sub-bass excess** — [\`4768096b\`](https://github.com/LILSYNNOFFICIAL/SYN-MASTER/commit/4768096b2ec6a93d54ff55a137c55c229ebdc457); shared blocking <= 0 dB Sub/Bass gate, one diagnostic status source, iterative low-shelf / Bass Enhancer repair, and regression tests. CI passed (unit tests, TypeScript, production build); real-track and Android verification pending.
- [x] **docs: record sub-bass verification evidence** — [\`5f7ef415\`](https://github.com/LILSYNNOFFICIAL/SYN-MASTER/commit/5f7ef415686ad61c052f551a67e71eed4d218e80); CI run 45277463221 passed.
- [x] **fix: bound offline DSP scratch memory** — [\`228eeea4\`](https://github.com/LILSYNNOFFICIAL/SYN-MASTER/commit/228eeea486d616c267b971891a4e0a2e9a593db7); reusable wet/dry, multiband, and limiter scratch; full-track limiter analysis arrays replaced with bounded lookahead deque/ring. Its superseding follow-up below passed CI run 45277940155.
- [x] **fix: allocate DSP scratch for zero-wet modules** — [\`47db901b\`](https://github.com/LILSYNNOFFICIAL/SYN-MASTER/commit/47db901b961ab01aa6a5e98eb698a19df996e2aa); scratch allocated by enabled processor type even when wet/dry or intensity is zero. CI run 45277940155 passed tests, TypeScript, and build.
- [x] **fix: chunk multiband DSP scratch buffers** — [\`dba3fec1\`](https://github.com/LILSYNNOFFICIAL/SYN-MASTER/commit/dba3fec1a5d07530b211f500aed8ca52034b3588); cap multiband scratch at 8192 samples and preserve crossover/compressor state across chunks. Multi-chunk deterministic/boundary regression; CI run 45278221448 passed tests, TypeScript, and production build.
- [x] **fix: share limiter and wet/dry scratch buffers** — [\`599f0c34\`](https://github.com/LILSYNNOFFICIAL/SYN-MASTER/commit/599f0c3469a9d02dc351609dc1fc6dd336ac5fb9); one reusable stereo scratch pair for sequential wet/dry snapshots and limiter input snapshots, with a separate dry pair only for wet/dry limiter modules. Full CI passed after the following test-fixture type correction.
- [x] **test: preserve limiter oversampling literal type** — [\`9f7a00b4\`](https://github.com/LILSYNNOFFICIAL/SYN-MASTER/commit/9f7a00b4b82f0526c2ca705c3f08dab7746aff44); narrowed the fixture oversampling to the supported literal union. CI run 45278648128 passed unit tests, TypeScript, and production build.
- [x] **perf: stream analyzer filters without full-track work buffers** — [\`b951c202\`](https://github.com/LILSYNNOFFICIAL/SYN-MASTER/commit/b951c202e253fab54cf738c031fda95004d4e383); stream K-weighted LUFS and band-correlation measurements through biquad state, retaining only bounded energy rings. Follow-up below restores the analyzer's integrated-LUFS reduction from the shared block measurements.
- [x] **fix: restore integrated LUFS reduction in streamed analyzer** — [\`1b0f8c85\`](https://github.com/LILSYNNOFFICIAL/SYN-MASTER/commit/1b0f8c85cd52cc8534f78ee6a7834fd712c0fc2f); shared gated block reduction now supplies both integrated LUFS and analyzer history. CI run 45279082592 passed unit tests, TypeScript, and production build.
- [x] **fix: align objective LUFS tolerance and temper sub-bass refinement** — [\`c025149e\`](https://github.com/LILSYNNOFFICIAL/SYN-MASTER/commit/c025149ed1157b8510996748e0dfc6a2bb19f1bb); objective-specific LUFS gate, lower-gain initial sub shelf, and small bounded iterative increments near the 0 dB Sub/Bass threshold. CI run 45279307130 passed unit tests, TypeScript, and production build.
- [x] **test: discover tests and skip unavailable FFmpeg integration** — [\`987d6085\`](https://github.com/LILSYNNOFFICIAL/SYN-MASTER/commit/987d60857025a7936a727fb9fa7cf894adbc0711); recursive test globs and explicit FFmpeg/ffprobe skip. CI run 45280105660 passed unit tests, TypeScript, and production build.
- [x] **feat: stream codec uploads and cap export concurrency** — [\`d8e1334a\`](https://github.com/LILSYNNOFFICIAL/SYN-MASTER/commit/d8e1334a5c2282a0e12d44ebeb0315ba14c8e670); stream request WAV to disk with a 512 MiB hard ceiling, stream encoded output to the client, cap active FFmpeg exports at two, and enforce same-origin browser requests. Rate limiting and temporary-directory cleanup retained. Same-origin, cross-origin, oversize, and concurrency integration coverage is recorded in the following test commits. CI run 45280317622 passed.
- [x] **test: verify streamed export origin and size boundaries** — [\`8fd15667\`](https://github.com/LILSYNNOFFICIAL/SYN-MASTER/commit/8fd15667f95841de7ce6f3e5a24005cf47d373b4); same-origin export fixture, cross-origin rejection, and declared over-limit upload regression. CI run 45280450302 passed unit tests, TypeScript, and production build.
- [x] **perf: remove full-track limiter source buffers** — [\`60e3de22\`](https://github.com/LILSYNNOFFICIAL/SYN-MASTER/commit/60e3de22a9bbe37b2788c31771978ef75d27915c); compute true-peak requirements directly from untouched source windows with Float32-equivalent drive scaling, then write in place after a bounded lookahead guard. Removes the full-track driven stereo pair. CI run 45280968896 passed unit tests, TypeScript, and production build.
- [x] **test: verify in-place true-peak limiter and export concurrency** — [\`cc4331a1\`](https://github.com/LILSYNNOFFICIAL/SYN-MASTER/commit/cc4331a11d245ea20de02f30600488d7910a0f7f); compares in-place true-peak limiting against the prior driven-buffer reference and proves a third upload is rejected while two exports are active. CI run 45281206214 passed unit tests, TypeScript, and production build.
- [x] **docs: record completed engineering verification** — [\`67bc4f0e\`](https://github.com/LILSYNNOFFICIAL/SYN-MASTER/commit/67bc4f0e9ce757a52bb9a5cadb21863670269a92); recorded CI outcomes and separated code-complete items from Android / real-track verification still pending.
- [x] **docs: close current commit ledger** — [\`045bcb70\`](https://github.com/LILSYNNOFFICIAL/SYN-MASTER/commit/045bcb70418b7737b4d8889d1deaa644216dd6cc); recorded the completed CI evidence and current worklist state.
- [x] **build: enable TypeScript strict mode** — [`17a6f21d`](https://github.com/LILSYNNOFFICIAL/SYN-MASTER/commit/17a6f21dfd4c4a89122f7ca42f0e1325a8846b3d); enabled `strict: true` only. Node 22 CI run 45281813691 passed unit tests, TypeScript, and production build.
- [x] **docs: record strict TypeScript CI evidence** — [`e8807b6f`](https://github.com/LILSYNNOFFICIAL/SYN-MASTER/commit/e8807b6f7e7ddc9f4796d1844daa62d6c56d23a7); P1-6 updated with Node 22 CI run 45281813691.

- [x] **test: verify production npm start on Node 22** — [`902735de`](https://github.com/LILSYNNOFFICIAL/SYN-MASTER/commit/902735defd60a76ef0e9d2595fe46bb70ac412c4); Node 22.23.5 production startup, `/api/health`, and root-page smoke test passed in CI run 45282058467.

- [x] **fix: target the measured sub-bass peak** — [`0b872bf1`](https://github.com/LILSYNNOFFICIAL/SYN-MASTER/commit/0b872bf10d91a0d4184bf495401f9d8034a4964f); replace the fixed 45 Hz shelf with a spectrum-centered bell; final regression coverage and CI verified in the follow-up commit below.
- [x] **fix: tighten sub-bass repair regression coverage** — [`ead907fe`](https://github.com/LILSYNNOFFICIAL/SYN-MASTER/commit/ead907feb08a152b59f9a7cb5b34c4cbfe3f2c7d); preserve `deriveRefinementCommands` documentation placement, align the EQ rationale with the adaptive band, and assert migration of legacy shelf controls to the measured bell. CI run 45283310903 passed unit tests, TypeScript, production build, and startup smoke test.
- [x] **docs: record sub-bass repair commits** — [`bb192e40`](https://github.com/LILSYNNOFFICIAL/SYN-MASTER/commit/bb192e40525b781e2744f805772113771f87c4ad); recorded both adaptive Sub/Bass repair commits and their verification state.
- [x] **docs: record sub-bass repair CI pass** — this commit; marked P0-1 implementation and CI evidence complete while keeping owner-output and Android verification pending.
- [x] **perf: render transferred worker buffers in place** — [`25960d71`](https://github.com/LILSYNNOFFICIAL/SYN-MASTER/commit/25960d71e8fc00f5748a997f1c9ed8d6a8cb92c6); avoid the renderer's second full-track stereo copy and share one wet/dry scratch pair across sequential modules. Regression tests passed CI run 45283973497 (194/194 tests, TypeScript, production build, startup smoke test). Android profiling remains open.
- [x] **docs: clarify transferred-buffer ownership contract** — [`a0a105cc`](https://github.com/LILSYNNOFFICIAL/SYN-MASTER/commit/a0a105ccf2eea2d62310b25aeee5b87393eb12ec); document the default copy-safe path versus explicit worker ownership and clarify the worker-client lifecycle comment. CI run 45283973497 passed.
- [x] **docs: record worker ownership memory verification** — this commit; record 194/194 tests, strict TypeScript, production build, and Node 22 startup smoke test while retaining Android profiling as open.
- [x] **feat: dock responsive mastering DAW and harden candidate verification** — [`d1d75381`](https://github.com/LILSYNNOFFICIAL/SYN-MASTER/commit/d1d75381a29204a68e0e86a10b10dff363ba584c); shared source-transient click interpretation, safe fallback candidate selection, responsive desktop/tablet/Android Studio layout, and documented Windows/Android packaging requirements. Initial CI run 45289071180 was cancelled during full-tree recovery; restored-tree CI run 45289828376 passed 198/198 tests, TypeScript, production build, and Node 22 startup smoke test. Desktop and real-device visual checks remain open.
- [x] **fix: preserve fallback stop reason and refine touch timeline** — [`bcbf616e`](https://github.com/LILSYNNOFFICIAL/SYN-MASTER/commit/bcbf616e9f54dcc15632ca31d34a65350d28f22b); append fallback information without overwriting user-stop/budget context, and enable horizontal waveform scrubbing while allowing vertical touch scrolling.
- [x] **fix: restore full project tree and retain DAW verification updates** — [`26c6c824`](https://github.com/LILSYNNOFFICIAL/SYN-MASTER/commit/26c6c8243d37d16a276af91c57a702cca57c0e4b); restored the complete repository from the verified `d1d75381` tree after the preceding follow-up tree was incomplete. Independent comparison confirms all 164 tracked file blobs are present, with no missing or extra paths and only `README.md`, `src/director/directorEngine.ts`, and `src/index.css` changed from the full pre-follow-up tree. Web CI run 45289828376 and Windows native companion run 45289828408 both passed; native artifact `syn-plugin-host-win64-m2` was uploaded.
- [x] **docs: record full-tree restoration and web CI results** — [`070a5db5`](https://github.com/LILSYNNOFFICIAL/SYN-MASTER/commit/070a5db5fdab669c6708f2ff47e3325759deda70); records the 164-blob tree comparison, 198/198 web CI result, strict TypeScript, production build, Node 22 startup/API health result, Vite chunk-size warning, and outstanding Windows/device gates.
- [x] **docs: record DAW verification and mobile bundle warning** — [`508468f7`](https://github.com/LILSYNNOFFICIAL/SYN-MASTER/commit/508468f73db13cc160c576475a90c3d782303868); records web CI success (198/198), production chunk-size warning, and the pending mobile optimization.
- [x] **docs: record Windows native VST3 validation and hosted access release gate** — this commit; records the native build/artifact, source-only shimmer probe, and unresolved deployment access boundary; the complete source tree is checked unchanged.


# Reference: existing capabilities and setup

## Core capabilities

### Mastering Workspace

- Unified mastering workspace with dedicated navigation for the main mastering workflow and Stem Studio.
- Track analysis and objective-based mastering workflows.
- Explainable mastering plans with proposed processing stages and rationale.
- Assisted and autonomous AI Mastering Director operating modes.
- Multi-objective evaluation and iterative DSP refinement.
- **FIX ALL & VERIFY** runs the autonomous refinement workflow against the active track and reports remaining findings instead of assuming every issue can be corrected.
- Post-fix verification compares the baseline and processed analysis, reports resolved or partially resolved findings, and identifies remaining deviations.
- The main Mastering Studio keeps Analyze, FIX ALL & VERIFY, current loudness / true-peak readings, and the active mastering rack in the central workspace instead of a detached side rail.
- Each autonomous Fix All run saves a versioned diagnostic bundle in the browser's Origin Private File System (OPFS) under `SYN-MASTER-TEMP`. A small browser-local index makes the latest 100 runs discoverable after reload on the same origin. The AI workspace exposes these archives for JSON download. When durable OPFS storage or its index is unavailable, the run is marked session-only and must be downloaded before leaving the current page.
- Fix All supports up to 10 autonomous passes with a bounded execution budget, retains the best validated pass, and never equates a refinement plateau with a perfect or converged master.
- Sub-bass delivery limits use the same objective-aware tolerances as Director diagnosis (standard objectives +4.5 dB, bass-forward objectives +5.5 dB over the bass band). The measured objective gate is sent to AI on every refinement; deterministic repairs for supported blocking gates are merged into valid AI proposals instead of being skipped when AI returns a chain. Fix All converges only when both the objective gate passes and QC has zero blocking failures; unresolved failures are named explicitly in the final verification. Every candidate is still rendered and re-measured before retention.

### Measurement-aware refinement

The Director uses measured spectral and loudness information to guide corrections. Refinement recommendations are tied to the measurement that remains outside the active objective's threshold. For example:

- Bass-vs-mid excess is addressed with a restrained low-frequency shelf in the bass region.
- Low-mid buildup can call for a more focused low-mid bell adjustment.
- Subsonic excess can call for high-pass filtering.
- **Harmonic-aware resonance handling:** analyzer and restoration resonance candidates are checked for coherent harmonic families. The Director reserves dynamic EQ for isolated upper-mid spectral prominences instead of automatically cutting ordinary pitched-instrument partials.
- **Frequency-localized stereo checks:** low, mid and high correlation bands use the default Stereo Imager crossover regions. Mono compatibility scoring, QC and refinement account for localized cancellation, and corrections narrow only the affected band.
- **Noise verification:** noise-floor scoring is normalized to the selected delivery loudness so uniform attenuation cannot masquerade as denoising. Post-fix verification also requires signal-to-noise improvement and checks transient density, crest factor and high-frequency air.
- **Transient-aware restoration:** hiss control is an adaptive high-shelf gate, not a profile-based broadband denoiser. It opens rapidly for transients and returns to reduction in quiet passages; it does not reconstruct clipped or missing source information. Dynamic EQ uses a fast detector envelope while user-selected attack/release times shape gain movement.
- **Dynamics-aware loudness:** the Director will not push an already-compressed source harder merely to reach a LUFS target. When the mastering pass itself reduces dynamic range, it backs off maximizer drive and bus compression rather than treating transient emphasis as reconstruction.
- **Closed-loop regression guards:** each pass is checked for new or worsened technical findings, objective true-peak/loudness breaches, localized phase cancellation, noise regression, distortion growth, transient loss and large objective-dimension regressions. A rejected pass does not replace the best verified checkpoint.

The bass-vs-mid refinement path uses a proportional adjustment rather than applying a fixed, aggressive cut. It updates an existing suitable parametric-EQ bass shelf where possible, or adds a parametric EQ when one is not present.

**Verification is not a promise of perfect sound.** A passing metric does not replace critical listening, and a partially resolved finding means the remaining deviation is still reported. These safeguards cannot reconstruct information already lost in a clipped or over-compressed premaster. Always audition the rendered result and check it on appropriate monitoring systems.

### AI stem separation

- HT-Demucs (ONNX) runs in the browser and splits a mix into Drums, Bass, Other and Vocals.
- **High Quality mode** runs each chunk twice, the second time shifted by 0.5 s, and averages the realigned results (the Demucs `--shifts` technique). About 2x slower.
- **Mixture consistency:** after the stems are resampled to the session rate, the leftover difference between the original mix and the sum of the stems is shared out to the stems by their local energy, so the four stems always sum back to the original, including content above the model's 44.1 kHz band.

### Low-mid masking, limiter and delivery checks

- **One band map** (`src/dsp/bandMap.ts`) defines the analyzer zones and the 150–400 Hz mud region used by diagnosis, the Director and verification.
- **Dynamic low-mid control:** when 150–400 Hz masking is measured, the initial plan adds a dynamic EQ band at 250 Hz (Q 1.0, up to -3 dB) and keeps the static bell light.
- **Low-mid refinement:** each Fix All pass can deepen one low-mid bell (0.5–1.0 dB per pass, capped at -4 dB in total), retuned toward the measured build-up between 170 and 360 Hz. It never acts on an already hollow midrange. Mud progress counts toward the best checkpoint, and the loop is not marked converged while the mud finding is still open.
- **Reference-calibrated thresholds:** with a reference loaded, the low-mid limits rise to the reference's own balance plus 1 dB, never below the objective defaults.
- **Level-matched verification:** mud verification also reports each band's change with the overall loudness change removed, and warns when Mid fell by more than 1 dB.
- **Limiter:** the lookahead limiter ramps gain across the lookahead window instead of stepping, so transients are not hard-clamped.
- **Delivery check:** after encoding, the server measures integrated LUFS and true peak on the encoded file and the export panel warns when it is over the ceiling.
- **Export defaults:** 48 kHz, WAV 24-bit PCM, FLAC 24-bit, MP3 320 kbps, dither off (so FLAC is sample-identical to WAV), Full Dynamic Archive delivery objective, and no metadata unless you enter it.

### Stem Studio

- Dedicated stem-separation workspace.
- Disk-backed browser storage using the Origin Private File System (OPFS) for stem data, reducing reliance on keeping large stem buffers in memory.
- Device-aware memory checks for resource-intensive processing.
- ONNX-based stem-separation processing in the browser.

Browser support and available storage can affect OPFS behavior. Test long-form separation in the target browser and device before relying on it for a production session.

## Current architecture

- **Web application:** React, TypeScript, Vite.
- **Server:** Express. Gemini credentials are read only from the server process environment.
- **AI mastering:** Google Gen AI SDK, with structured mastering-strategy responses.
- **DSP:** Native SYN-DSP processors, 512-point windowed-sinc sample-rate conversion, and offline audio rendering in the application.
- **Export:** WAV PCM/float, MP3, OGG Vorbis, FLAC, M4A/AAC and WebM/Opus are rendered through the server-side FFmpeg encoder and its 512-point Blackman-Nuttall windowed-sinc resampler. Install FFmpeg on the server and ensure it is available on PATH to enable full-song audio export. MIDI output is a tempo / loop conductor track only; imported audio contains no MIDI note events.
- **Stem separation:** ONNX Runtime Web and browser workers, with OPFS-backed stem storage.
- **Native plugin host:** C++20, CMake, JUCE 8, isolated VST3 worker processes.
- **Persistence:** Browser-local project/storage facilities. See source modules for exact persistence boundaries.

### Export formats and runtime encoder

All full-song audio formats (WAV 16/24-bit PCM or 32-bit float, MP3 up to 320 kbps, OGG Vorbis, FLAC up to 24-bit, M4A/AAC 320 kbps, and WebM/Opus) are rendered by the `/api/export/encode` endpoint. The server resamples from the 32-bit float offline DSP render with FFmpeg's 512-point Blackman-Nuttall windowed-sinc resampler. The server requires an FFmpeg build with `libmp3lame`, `libvorbis`, FLAC, AAC and `libopus` encoders available. MIDI conductor / marker export remains browser-local. The endpoint writes only to a per-request operating-system temporary directory and removes its intermediate files after each render. WAV supports 16-bit PCM, 24-bit PCM and 32-bit IEEE float; FLAC supports 16/24-bit with selectable compression; MP3 supports 320 kbps. The browser-side Fix All diagnostic archive uses OPFS (`SYN-MASTER-TEMP`) and a browser-local index to reopen recent run bundles after reload on the same origin. Download archives as JSON from the AI workspace. If the browser cannot provide a durable archive, the in-memory fallback is session-only and must be downloaded before leaving the page.

SYN MASTER is a full-track mastering renderer, not a playlist or MIDI sequencer. Playlist note markers, instrument maximum-polyphony settings, and DAW-specific PDC-silence trimming are not exposed as misleading export toggles. The MIDI file explicitly contains only tempo and optional loop markers, never invented notes or rendered audio.

## Development

Requirements:
- Node.js 22+
- npm
- CMake 3.25+ and a C++20 toolchain for native development
- Visual Studio 2022 with Desktop development with C++ for the Windows native host

Install and run the web application:

```bash
npm install
npm test
npm run lint
npm run build
npm run dev
```

The Express server runs on port 3000 by default. Set `PORT` to override it.

## Gemini API configuration

Never place a real Gemini API key in frontend source, committed files, or client-side build variables.

The server expects:

```text
GEMINI_API_KEY=your_key_here
```

- **Google AI Studio hosted deployment:** configure the server secret named `GEMINI_API_KEY` in the AI Studio deployment's Secrets configuration.
- **Local development:** put the key in an untracked root `.env` file.
- **GitHub Actions:** only configure a GitHub Actions secret if a workflow explicitly needs to call Gemini. The current CI workflows do not need the production key.

`.env.example` is a placeholder template, not a working credential. Do not commit `.env`.

The `GET /api/health` endpoint reports whether the server process has a non-empty `GEMINI_API_KEY`. It does not verify that the key is valid or that Gemini accepts requests.

## AI endpoint protections and limits

The AI routes are protected by a process-local fixed-window request limiter: 20 requests per client key per minute. A 429 response includes `Retry-After`.

Because cloud AI is on by default for FIX ALL, the two routes that spend `GEMINI_API_KEY` (`POST /api/ai/master`, `POST /api/ai/refine`) also have spend caps (`src/server/aiSpendLimiter.mjs`), checked after the access-token guard so unauthenticated traffic never uses the budget:

| Limit | Default | Env override |
| --- | --- | --- |
| Strategy calls per client per minute | 3 | `SYN_AI_STRATEGY_PER_MINUTE` |
| Refine calls per client per minute | 12 | `SYN_AI_REFINE_PER_MINUTE` |
| Strategy calls per client per day | 40 | `SYN_AI_STRATEGY_PER_DAY` |
| Spending calls (both routes) per client per day | 250 | `SYN_AI_CLIENT_PER_DAY` |
| Spending calls for the whole server per day | 2000 | `SYN_AI_GLOBAL_PER_DAY` |

All limits are checked before any is spent. A refused call gets HTTP 429 with `Retry-After` and `{ error, code: "ai_rate_limited", scope: "client-minute" | "client-day" | "global-day", retryAfterSec, fallback: "local-dsp-planner" }`. The client (`src/ai/cloudRateLimit.ts`) treats any 429 from these routes as a notice, not an error: FIX ALL carries on with the local DSP planner (strategy) or the deterministic director (refine), shows a friendly amber notice under FIX ALL and in the AI Assistant, and sends no further built-in AI requests until the Retry-After time has passed. Day windows are fixed 24 h windows from the first counted call; counters are in-memory per server instance.

The limiter is in-memory and applies independently to each server instance. If deploying multiple instances, use a shared rate-limit store at the edge or in a shared data service. This limiter is abuse/cost friction, **not user authentication**.

Express proxy trust is disabled by default. If the deployment is behind a known reverse proxy that overwrites forwarding headers, set `TRUST_PROXY_HOPS` to the exact trusted hop count (1-5). Do not enable proxy trust without confirming the ingress topology, because client-supplied forwarding headers must not be trusted.

AI endpoint errors returned to clients are intentionally generic. Detailed exceptions are logged server-side and must not be returned to browsers.

SYN MASTER is intentionally account-free for now: there is no in-app registration, login, user profile, or multi-user identity layer. The limiter is not an access-control boundary. Do not expose the Gemini-backed API as an unrestricted public endpoint. For a remote deployment, place the entire application behind a private access boundary before sharing it. Google Cloud Run can enforce invocation access through Cloud IAM/IAP, but that relies on Google identities and is separate from SYN MASTER application accounts. If identity-based access is not wanted, use a local-only deployment or a private gateway/tunnel that injects a server-side access credential. Never embed a gateway credential in browser code. Confirm the actual deployment's ingress and access settings before assuming it is private.

## Bring your own AI provider (BYO-AI)

Built-in Gemini (through this app's server and its server-only `GEMINI_API_KEY`) stays the default and is unchanged. Under **Settings → AI Provider** a user can instead route the AI *suggestion* step to their own provider. The provider only proposes a chain: every suggestion goes through the same prompt, JSON schema and validation as the built-in route, and the Director still renders, re-measures and gates every pass. A provider can never mark a master as passed. If a provider call fails or its output fails validation, that pass falls back to built-in Gemini and the run log says why.

**Where the code lives:** `src/ai/providerPresets.ts` (data-only preset list), `src/ai/providerAdapters.ts` (request shaping, response parsing, error classification, key redaction), `src/ai/modelNames.ts` (model-name sanity check and lifecycle table), `src/ai/masteringClient.ts` (fallback routing, Test connection), `src/ai/providerStore.ts` (settings). Tests: `src/ai/providerAdapters.test.ts`, `src/ai/providerModels.test.ts` (mocked `fetch`, no real keys).

**Native presets and default models** (checked against the official model lists on 2026-11-25):

| Preset | Default model | Endpoint | Source |
| --- | --- | --- | --- |
| Google Gemini (your key) | `gemini-4-hydrogen` (stable, free tier available; same model the built-in server route uses) | `POST …/v1beta/models/{model}:generateContent`, key in `x-goog-api-key` | https://ai.google.dev/gemini-api/docs/models |
| OpenAI | `gpt-6.2-sol` | `POST https://api.openai.com/v1/chat/completions`, `response_format: json_schema` | https://developers.openai.com/api/docs/models/gpt-6.2-sol |
| Anthropic Claude | `claude-sonnet-5-5` | `POST https://api.anthropic.com/v1/messages`, strategy schema as a tool with `tool_choice: auto` | https://docs.claude.com/en/docs/about-claude/models/overview |
| xAI (Grok) | `grok-4.7` | `POST https://api.x.ai/v1/chat/completions` (OpenAI-compatible), `response_format: json_object` | https://docs.x.ai/docs/models |
| OpenRouter | `openai/gpt-6.2-sol` | OpenAI-compatible | https://openrouter.ai/api/v1/models |

Replaced stale defaults: `gemini-2.5-pro` (deprecated, API requests route to `gemini-3.8-flash` from 2026-12-01), `gpt-4.1` (deprecated, shuts down 2027-01-14), `claude-sonnet-4-5` (deprecated, retires 2026-11-30), `grok-4` (retired 2026-05-15, redirected to `grok-4.3`). Claude Sonnet 5.5 / Opus 5.5 reject a forced `tool_choice` with HTTP 400, so the Anthropic adapter now uses `tool_choice: auto` plus an explicit instruction, and also accepts a plain JSON text reply. Other presets (Groq, Mistral, DeepSeek, Together, Fireworks, Perplexity, Cerebras, local servers, agents) were not re-verified.

**Model-name sanity check** (`checkModelName`): a blank field uses the preset default; names with spaces/quotes, URLs, or anything that looks like an API key are rejected (a key-like value is never echoed back); a model from another vendor on a native preset (e.g. `gpt-…` on Anthropic) is rejected with the right example; deprecated ids run but add a warning to the run notices and to Test connection; retired ids are blocked before any request, with the documented replacement. OpenAI-compatible gateways and local servers accept any name. Update the lifecycle table in `src/ai/modelNames.ts` when providers announce retirements.

**Error messages:** errors are classified as `config`, `network` (CORS / private-network / server down), `auth` (401/403, and Gemini's 400 "API key not valid"), `model` (404 on a native endpoint, or a 400/404 whose body names the model; the message names the model sent and the current default), `http` (404 on a custom base URL points at the URL; 429 says rate limit / quota), `timeout`, `cancelled`, and `parse` (empty reply, refusal, output-token limit, blocked prompt, non-JSON). Keys are scrubbed from every message.

**Setup notes:** keys are entered in the browser and sent only to the chosen provider (sessionStorage by default; localStorage only with "Remember on this device"); they never touch this app's server. Anthropic requires the `anthropic-dangerous-direct-browser-access` header for browser calls, which the adapter sends. Providers marked "CORS unverified" may block browser calls; use OpenRouter or a local gateway if Test connection reports "Network / CORS blocked". Local servers (Ollama, LM Studio, OpenClaw) must allow this app's origin.

## CI

### Web CI

`.github/workflows/web-ci.yml` installs dependencies, runs unit tests, runs TypeScript checking, and creates a production Vite build. It does not need the Gemini API key.

### Windows native CI

`.github/workflows/windows-x64-build.yml` runs on `windows-2022` because the native CMake preset explicitly selects the Visual Studio 2022 generator. It builds the native host, scanner, worker, QA VST3 plugin, and core tests, then runs the compiled VST3 validation script.

A successful CI run verifies the build and scripted QA path on the GitHub runner. It does not prove compatibility with every third-party plugin or physical audio device.

## Native Windows build

See [native/WINDOWS_BUILD.md](native/WINDOWS_BUILD.md) for prerequisites, configure/build commands, and VST3 validation instructions.

**Licensing:** the whole repository, web app and native VST companion (`native/`), is licensed **AGPL-3.0-only** ([LICENSE](LICENSE), scope in [NOTICE](NOTICE)); decided by the owner on 2026-11-25. The companion uses JUCE 8.0.17-security under JUCE's AGPLv3 option (with the MIT-licensed VST3 SDK 3.8.0). Third-party code keeps its own licence ([docs/THIRD_PARTY_NOTICES.md](docs/THIRD_PARTY_NOTICES.md)). Details: [docs/VST_COMPANION.md](docs/VST_COMPANION.md#licensing).

## Deployment and synchronization

The GitHub repository and Google AI Studio project synchronize source code, but synchronization is distinct from publishing. After pulling source changes into AI Studio:

1. Inspect the changed files.
2. Run the available preview/build checks.
3. Test the application and AI features.
4. Republish the existing deployment when ready.

After updating the mastering workflow, test **FIX ALL & VERIFY** with a representative track. Review the Director activity and post-fix findings, then audition the resulting audio. Automated tests verify code paths and expected measurement handling, not the subjective quality of an individual master.

The live `/api/health` response only verifies configuration presence, not full AI functionality.

## Security notes

- Keep Gemini API credentials server-side.
- Do not expose API keys in React code or Vite environment variables prefixed for client exposure.
- Keep `.env` untracked.
- Keep the current account-free, single-user product boundary. Do not add in-app accounts unless that product decision changes.
- Do not leave a remote Gemini-backed endpoint openly callable. Enforce access at the deployment/network boundary; Cloud Run IAM/IAP is an option when Google-identity sign-in is acceptable, otherwise use local-only hosting or a private gateway.
- Observed Nov 23, 2026: the published health route was reachable without a login and reported `aiConfigured: true`. The source AI routes have a process-local rate limiter but no app authentication. The actual upstream Cloud Run/IAM/IAP policy remains unverified. Treat this as a release gate until the deployment owner confirms the protection and an unauthenticated AI request is rejected upstream.
- A shared rate limiter is still needed if the service is later scaled across multiple server instances.
- Avoid logging request bodies, audio, or credentials.



## Parallel execution update — November 23, 2026

- [x] **Production Gemini access gate:** server-side bearer validation, built-in Gemini Settings token entry, session/local persistence controls, and non-billable production-mode route tests are committed. The Gemini key remains server-only. Production secret configuration and hosted Cloud Run/AI Studio validation remain open.
- [ ] **Hosted deployment verification:** set the separate `SYN_MASTER_AI_ACCESS_TOKEN` deployment secret, sync the source into AI Studio, inspect Cloud Run/IAM/IAP, and verify unauthorized calls are rejected without billable Gemini usage.




### Hosted AI access-token limitations

The client-entered cloud token is a shared bearer credential, not individual user authentication. It does not provide per-account identity, entitlements, per-user revocation, or account-level quotas. Keep the value in the deployment secret manager and distribute it only through a controlled operator channel. Before public multi-user distribution, replace or wrap this gate with an identity-backed session model or a verified upstream IAM/IAP boundary, and add user-level quota/abuse controls. A successful local CI check proves the route middleware works, not that the hosted AI Studio/Cloud Run edge is configured correctly.

## Parallel execution status — November 23, 2026

- [x] **Hosted AI access protection (source):** bearer-token guard, settings field, and unit coverage are committed. This intentionally fails closed in production when `SYN_MASTER_AI_ACCESS_TOKEN` is not configured. Set a cryptographically random token (for example, `openssl rand -hex 32`) as a deployment secret and enter the same value under Settings → AI Provider → Built-in Gemini → Cloud AI access token. Do not use the Gemini API key as this token.
- [x] **Browser installability foundation:** web manifest, self-hosted black/gold SVG icon, and production service worker are committed. The service worker only handles same-origin GET navigation/static assets and explicitly bypasses `/api/`, ONNX, ORT, Demucs and model paths. This is a PWA foundation, not a verified APK or TWA.
- [x] **Bundle regression guard:** `npm run check:bundle` is part of Web CI; it enforces a largest-chunk ceiling of 800 KiB raw / 250 KiB gzip. The prior measured entry chunk (~732.16 kB raw / 218.19 kB gzip) is within this guard, but still exceeds Vite's default 500 kB warning. This guard prevents growth; it does not itself split the bundle.
- [ ] **P0 deployment verification:** configure the secret and verify live hosted AI access controls, Cloud Run/IAM/IAP, and AI Studio sync. Do not send a paid Gemini request merely to test the gate.
- [ ] **P0 mastering/device acceptance:** process the exact `Shadows_Opening_Click_Repair.wav` using `scripts/headless-master.ts`, independently remeasure the retained WAV using FFmpeg, audition A/B, and profile long-track peak memory. That source file is not present in this repository tree. Physical Android Chrome and Windows desktop browser tests also remain open.
- [ ] **Android wrapper:** first finish real Android Chrome acceptance. Then evaluate a URL-backed TWA; `docs/packaging/ANDROID.md` records package ID, signing fingerprint, controlled HTTPS origin, and Digital Asset Links prerequisites. No placeholder `assetlinks.json` is added.
- [ ] **Windows application:** the existing native VST3 companion CI is green, but this is not a complete workstation EXE. `docs/packaging/WINDOWS.md` records the server/FFmpeg/native-host/installer/signing lifecycle and a provisional Electron packaging spike. A signed installer and end-to-end installed-app test remain open.


**CI hardening follow-up:** Web CI now runs the JavaScript bundle budget check after production build and starts production with a throwaway test-only `SYN_MASTER_AI_ACCESS_TOKEN`. Its smoke test posts empty (invalid, non-billable) payloads to both `/api/ai/master` and `/api/ai/refine`: unauthenticated requests must receive 401, while the valid test bearer token must pass the gate and reach payload validation (400). This validates the server boundary without sending a Gemini request. The test-only token is not a repository secret and is not reused for deployment.


- [x] **Windows desktop packaging scaffold:** Electron shell, bundled Express runtime build, staged native VST3 companions, NSIS x64 installer config, CI installer job, localhost-only server binding, per-launch AI token, automatic VST3 pairing, and authenticated graceful host shutdown are committed. The Windows job is now building this package; only a successful uploaded installer artifact will count as build-verified. Code signing, installed-app smoke tests, and physical Windows acceptance remain open.


**Desktop runtime resilience:** the Electron shell waits for the native host HTTP listener after reading the pairing file (the native host writes that file before listening), and continues in browser-only mastering mode with a visible warning if the VST3 companion cannot start. The loopback port allocator retries distinct ports without leaving its Promise pending.


**Native companion cleanup:** the VST3 host now exposes `POST /v1/host/shutdown` only to the current bearer session. It signals the host's normal shutdown loop, which stops audition, unloads plugin workers, and stops its HTTP/WebSocket listeners. The Windows validation script now verifies HTTP 202 and a clean process exit; Electron requests this graceful shutdown before its bounded forced-stop fallback.

- [x] **First-load chunking:** Export and Preferences dialogs now use React lazy imports and mount only when opened, keeping the initial workstation bundle from loading those dialog modules up front. The updated JS chunk sizes will be recorded from the next Web CI run.
- [x] **PWA shell caching:** service-worker installation now primes the navigation shell, manifest, and 192/512 icons, and only caches responses with a known content length below 8 MiB. AI endpoints and model files remain excluded.

## Android and tablet responsive layout update — November 23, 2026

- [x] **Responsive workstation breakpoint:** the touch-first stacked layout now activates through 1024 CSS pixels, covering narrow Android/tablet browser viewports that previously retained the two-column library rail.
- [x] **Full-width mastering workspace:** the mastering stage, spectrum panel, and processor rack are constrained to the available viewport width when stacked; the spectrum panel retains a 220 px minimum height.
- [x] **Readable mastering meters:** the eight technical readouts use a two-column grid in the touch-first layout, with a single-column fallback on very narrow screens.
- [x] **Touch-sized mastering action:** the FIX IT ALL WITH AI control expands within the mobile stage, caps at 420 px on wider touch layouts, and scales its text to avoid clipping on narrow phones.
- [x] **Compact command header:** brand and export action share the first row, while the command menus occupy a horizontally scrollable second row to avoid compressing the workstation.
- [ ] **Physical Android acceptance:** verify the live synced build in Chrome/Chrome Canary on the target phone at portrait and landscape widths. GitHub CI and CSS inspection do not replace this device check.
- **Scope:** this is a CSS-only responsive layout change. React state, Web Audio routing, DSP, mastering algorithms, and audio engine modules were not modified.

## Flagship mastering UI and responsive polish — November 24, 2026

- [x] **Hardware surface hierarchy:** unified the workstation chassis, rack cards, recessed waveform/spectrum wells, telemetry tiles, and meter wells around deep black surfaces, warm gold borders, subtle inner highlights, and tabular technical readouts.
- [x] **Touch controls:** increased mobile slider, switch, bypass, and A/B control hit areas to at least 40 px, with gold active states.
- [x] **Compact command header:** below 1024 px, the application header keeps the SYN MASTER lockup, a single Menu disclosure for File/Edit/Workspace/View/Tools, and a persistent Export action. Selecting a command closes the menu.
- [x] **Consistent workspace layout:** every workspace tab now uses the same main layout container. Non-studio workspaces use a single content column; the full two-lane mastering cockpit is retained at 1024 px and wider.
- [x] **Mastering Control Desk:** long track names wrap, measurement summaries remain readable, and Analyze/Fix/Export actions wrap instead of clipping.
- [x] **AI Director:** Manual/Assisted/Autonomous cards stack below 768 px and return to three columns at 768 px; measured before/after telemetry uses two columns on mobile and three from 768 px upward.
- [x] **Analysis Lab:** spectral zone balance and resonance panels stack until the 1024 px desktop breakpoint. Frequency-band values and resonance rows use constrained grid columns to prevent overlap.
- [x] **Other workspace safeguards:** quality-control summary cards stack on narrow screens; nested workstation grid items, the Mastering Rack processor selector, and the Fix It target dropdown can shrink instead of forcing page-width overflow. Stem and plugin diagnostic tables retain their own contained horizontal scrollers.
- [x] **Spectrum analyzer:** frequency ticks now cover 30 Hz through 20 kHz, with smaller edge-aware labels on narrow canvases and a 240 px minimum mobile canvas height.
- [x] **Master Output Meter Bridge:** stereo L/R bars and monitor control occupy the first mobile row; Integrated, True Peak, Dynamic Range, Gain Reduction, and Phase occupy the second row. QC status remains visible.
- **Scope:** UI-only files changed: `src/App.tsx`, `src/components/AiMasterView.tsx`, `src/components/SynLabView.tsx`, `src/components/ReferenceAndQcViews.tsx`, `src/components/MasteringRack.tsx`, `src/components/MeterBridge.tsx`, `src/components/CanvasVisualizers.tsx`, `src/components/controls/RotaryKnob.tsx`, `src/components/controls/HorizontalSlider.tsx`, `src/components/controls/ToggleSwitch.tsx`, `src/components/controls/BypassButton.tsx`, and `src/index.css`. Responsive verification files: `scripts/responsive-layout-check.mjs` and `.github/workflows/web-ci.yml`. No React state hooks, Web Audio nodes, DSP calculations, audio worklets, or engine modules were edited.
- [x] **Automated responsive browser suite added to Web CI:** Playwright loads the demo and visits all eight workspace views plus all four library tabs at 360×800, 375×812, 412×915, 1024×900, and 1440×1000, checking document/workstation/main/footer overflow, header geometry, mobile Menu and Export controls, Analyze Track visibility, AI Director and Analysis Lab grid behavior, the five-column mobile meter row, and the desktop two-lane cockpit.
- [x] **Web CI passed on source revision `8867173`:** 202/202 unit tests, TypeScript, production build, bundle budget, production startup smoke, and 68 Playwright responsive checks passed across 360, 375, 412, 1024, and 1440 px. All eight workspace views and four library tabs passed at each viewport. [View the successful workflow run](https://github.com/LILSYNNOFFICIAL/SYN-MASTER/actions/runs/45317045685).
- [ ] **Physical Android acceptance:** still requires checking the synced build in Chrome/Chrome Canary on the target phone. Automated viewport checks do not replace final device inspection.

## Workspace instrument visual consistency — November 24, 2026

- [x] **Shared instrument treatment:** extended the SYN MASTER navy chassis, electric-blue signal accents, restrained metallic-gold details, recessed surfaces, and technical panel styling across AI Director, Analysis Lab, Stem Studio, A/B Battle, Reference Match, Quality Control, Plugin Manager, the Audio Library, and the Mastering Rack. Existing DSP, analysis, QC, stem, and native-plugin controls remain the active implementations.
- [x] **Workspace graphics:** preserved the purpose-built SVG instrument illustrations for each analysis and production workspace, with source-data status kept explicit. AI Director retains its separate orb/pipeline empty state and its processing-stage view.
- [x] **Touch navigation layering:** raised the global workspace navigation above floating transport and A/B controls so the advanced workspace drawer remains clickable on narrow layouts.
- [x] **Regression coverage:** Playwright checks the instrument surface and workspace-specific graphic in each no-source workspace, checks the Audio Library and Mastering Rack after loading the demo, and visits the workspaces and library tabs across 360, 375, 412, 1024, and 1440 px.
- [x] **Web CI passed on `d8b2116a`:** 206/206 unit tests, strict TypeScript, Vite production build, bundle budget, Node 22 production startup, and the complete Playwright responsive/workspace suite passed. [View CI run 45461173378](https://github.com/LILSYNNOFFICIAL/SYN-MASTER/actions/runs/45461173378).
- [ ] **Manual visual acceptance remains open:** compare the hosted app against the owner's reference screenshots and inspect the actual desktop browser and Android device. Automated viewport checks prove layout and interaction, not pixel-perfect reference fidelity.
- **Scope:** UI components, workspace styling, navigation layering, and responsive tests only. No DSP algorithms, Web Audio nodes, mastering calculations, or engine modules were changed in this follow-through.
- **Implementation commits:** `b60cd74`, `ed1324a`, `0f59a3c`, `5e526f1`, `8528310`, `555f3d1`, `8760d96`, `87ac084`, `869637e`, `1e51ea5`, `fbd7b19`, `5b44764`, and `d8b2116`.

## UI design system — SYN-MASTER console (Nov 24, 2026)

- **References:** owner mockups in `docs/design/refs/` (desktop: `desktop-primary-mockup6.webp`, `desktop-landscape-iconrail.webp`; mobile: `mobile-primary-mockup5.webp`, `mobile-components-*.webp`). Inspiration, not pixel targets; the product name stays **SYN-MASTER**.
- **Brand:** official logo `public/brand/syn-master-logo.{png,webp}`; round mark `public/brand/syn-master-mark.{png,webp}` (header, beside the gold serif wordmark); splash uses the full logo. Icons: `public/favicon.ico`, `public/icons/syn-master-{192,512}.png`, `syn-master-maskable-{192,512}.png`, `apple-touch-icon.png`; Windows multi-size `public/brand/syn-master.ico` for the companion.
- **Layouts (one codebase, CSS breakpoints):** desktop ≥1024 px = console (`src/components/console/MasterConsole.tsx`): Input/Transient/Stereo left, SYN EQ centre (console variant of `ParametricEQ2`), Global · FIX ALL AI · Presets below, Dynamics/Color/Output/Loudness right, bottom tab bar. <1024 px = mockup-5 portrait grid, fixed bottom tab bar, safe-area insets, ≥44 px targets. Audio library is a drawer behind the header menu button.
- **Wiring rule:** every console control edits the real chain via the same `updateChainWithHistory` path as the rack; missing processors show "Add …" (inserted before loudness stages) instead of dead knobs; readouts are measured analysis values. FIX ALL AI calls the unchanged Director loop; Stop uses the existing stop flag.

### GUI redesign status (round 3: guided flow, Nov 24 2026)
- [x] **B Hamburger** (`df3284d`): ☰ drawer now opens with real navigation (Dashboard, Reference Match, AI Director, Analysis Lab, Stem Studio, Quality Check, A/B Battle, Plugins & Host, Export, Settings) above the library; drawer is always rendered, so no empty blurred overlay (that happened in fullscreen mode).
- [x] **C Timeline** (`b2d1262`): small start/play/end transport centred under the waveform; seek, drag and S-curve fades untouched.
- [x] **A Guided flow** (`bcca7c5`): console reads 1 Import (timeline on top) → 2 Fix with AI (round FIX ALL + Ask AI) → 3 Master it yourself (EQ / Dynamic EQ + manual cards) → 4 Export (crystal dark-purple Export Master). Step labels on desktop and mobile.
- [x] **E Spectrum playhead** (`6df5f1c`): Live-spectrum playhead click/drag seeks; timeline, spectrum and QC graph share one `seekTo()` / `telemetryStore.currentTimeSec`.
- [x] **D EQ blanket** (`c88061e`): while dragging EQ nodes the blanket scales immediately by a spectrum-weighted estimate of the curve's level change; the real offline render (debounce 120→60 ms) replaces it. The estimate is broadband (pre-limiter), so with a maximizer in the chain the final render can move less than the live estimate.
- [x] **F Spectrogram** (`90f61e1`): display analyser FFT 8192 (meters use the L/R analysers, unchanged), per-device-pixel log-frequency rows, navy→purple→blue→cyan map, log Hz axis. Playhead/seek is not shown in spectrogram mode (it is a scrolling history, not track time).
- [x] **H Analysis Lab** (`ac1b23f`): chosen sub-lab persists (it reset to Stereo Lab on remount); blue glass skin with a per-lab accent; blue glowing vectorscope circle.
- [x] **I QC** (`bcf3c50`): Live Loudness panel with the measured BS.1770 short-term LUFS timeline (master vs source), playhead + "now" value while playing, integrated / ST max / momentary max / LRA / true peak / clipping / live sample peak, click-drag seek. QC runs on the source while the master render is pending. Static hero illustration removed from QC.
- [x] **J Colours** (`dbe6302`): green glowing settings gears; canvases blue/purple (spectrum post cyan, reference purple, EQ transfer magenta, timeline waveform glow); Reference / Battle / Stem / QC / Lab cards blue glass.
- [x] **Glow pass** (`89bb6a2`): hover/active/focus glow on buttons, tabs, selects, cards, knobs, faders, nav and menus; ambient blue/purple accents (console aura, EQ + Fix panel border breathe, header sweep, step badges, Export pulse). All animation off under `prefers-reduced-motion`.
- [x] **Mode steers the AI** (`ffb2759`): the strategy request always includes `Mode: <mode> — <meaning>` alongside the Objective (only prompt change; tests in `src/ai/masteringPrompt.test.ts`).
- [x] **G Dynamic EQ** (`4be09e0`): the engine already had a `dynamic-eq` processor (offline render, export and realtime graph). New "Dynamic EQ" tab beside EQ edits it (≤4 bands: freq, range, Q, threshold, attack, release; on/bypass). Off until added, so the default output is unchanged. Ratio is fixed by the engine (≈2.9:1) and shown, not editable. `src/dsp/dynamicEqExport.test.ts` checks it changes the export render and that bypass is bit-identical.
- [x] Dynamic EQ ratio (1:1 to 20:1) and cut/boost mode (`ff79089`); boost mode now attacks as the boost rises and releases as it falls (previously inverted). Default ratio 20/7 keeps legacy output identical.
- [ ] Not done: Stem Studio has no canvases of its own (its cards/accents were re-coloured via CSS); playhead dragging on the spectrogram.

### GUI redesign status (blue-glow pass, Nov 24 2026)
Owner feedback round 2 ("more blue glow everywhere"). Skin lives in `src/skin/skin.css` (layer scale, blue glow tokens `--glow-*`, `--line-blue*`); overlays render through `src/ui/Portal.tsx`.
- [x] **Layering** (`fa0db95`): one z-index scale (`--z-header`, `--z-bottombar`, `--z-menubar`, `--z-drawer`, `--z-float`, `--z-modal`, `--z-popover`); floating FX windows, Export/Settings, More menu and library drawer portal to `document.body`.
- [x] **Menubar** (`b5b6b8a`): click opens, hover switches while open, outside click / Esc / item closes, arrow keys; active item glows blue.
- [x] **Timeline player + EQ waveform** (`0d48fd5`): `studio/TimelinePlayer.tsx` under the EQ (blue overview waveform, playhead, click/drag seek, Import / Play / Jump start / Jump end / time, FL-style fade knobs = real `FadeSettings`, applied after the chain on preview, Fix-All and export). The EQ draws the processed preview's waveform (debounced re-render on every change) as a purple/blue blanket with a live playhead. The old "Timeline & fades" toggle in `FixItStage` was removed.
- [x] **AI** (`a2f96f5`): "Ask AI" sits directly under FIX ALL (ribbon button removed); AI Assistant workspace re-skinned to console glass/blue; its fake bars replaced by a live analyser spectrum (`console/LiveSpectrum.tsx`). The AI workspace layout itself is restyled, not restructured.
- [x] **More menu** (`bc1090c`): centred game-style overlay. **Export + Settings** (`b6669a2`): blue glass modals, every option unchanged, Esc closes.
- [x] **Imager** (`a8a7b12`): polar half-circle vectorscope (live analyser / rendered snapshot), live correlation + L/R balance meters, mono score, per-band *correlation* (per-band width is not measured by the analyzer).
- [x] **Modes** (`ba9210c`): console shows the active Mode and pre-selects a matching preset. What Mode does in code: saved with the project and put in the AI strategy input; the prompt uses the Objective (always set), so Mode does not change processing. Target / Objective drive the master.
- [x] **LUFS** (`160550c`): read-only meter with a draggable / keyboard target thumb (sets a custom target via the same path as the Target presets).
- [x] **Glow pass** (`c9cd5d9`): monitor volume + meter bridge, FX rack windows and in-page rack, hamburger drawer, EQ grid/nodes/curve, nav and cards. **Real-time** (`0340dcf`): Loudness card shows live RMS/peak while playing.
- [ ] Not done: FIX ALL not moved higher; AI workspace not structurally rebuilt; Analysis Lab canvases keep their existing (already live) drawing with the old palette; per-band stereo width readouts need analyzer support.

### GUI redesign (first pass, Nov 24 2026)
- [x] Desktop console + mobile portrait grid, bottom tab bar, library drawer, logo/icons/manifest (`262dd06`).
- [x] Settings → Layout: Automatic / Desktop view / Mobile view, stored in localStorage (`833c4da`).
- [ ] Skin layer: move all colours/glows/fonts into one swappable theme file + `public/skin/` artwork (knob faces, meter skins, panel/glow backgrounds, icons) shared with the companion.
- [ ] Plugins & Host tab restyle (companion status, scanned plugins, add-to-chain, parameters/editor button).
- [ ] Re-run `scripts/responsive-layout-check.mjs` in CI (updated for the new layout; passed locally at 360–1440 px, the run did not exit cleanly afterwards) and final screenshots.
- **Re-import into AI Studio:** pull `main`, import the GitHub repo into Google AI Studio, then build and republish. No new build steps: same entry files, assets live in `public/`.

## Prior handoff — Nov 24, 2026 (after commit 9e58e66)

Current state: GUI redesign rounds 1–3 are on `main` (skin in `src/skin/skin.css`, guided 1–4 console flow, TimelinePlayer with seek + S-curve fades, real EQ waveform blanket, Ask AI under FIX ALL, Ozone-style imager, live QC loudness, Dynamic EQ tab, Mode sent to the AI as its own line). The current accuracy follow-up passes lint/build and 219 of 220 tests; one FFmpeg-dependent test is skipped when FFmpeg is unavailable. See the "GUI redesign status" sections above.

Open items, in priority order:
1. **Verify in a real browser:** a full WAV export contains the timeline fades and the Dynamic EQ (automated WAV-byte coverage now checks both). Run Fix All end to end with the new Mode line; a browser download and real Fix All run remain unverified.
2. [x] **Dynamic EQ ratio knob:** ratio and cut/boost mode are implemented in the offline processor and exposed in the console and rack; legacy chains preserve the original ≈2.9:1 cut slope. Mastered playback uses the exact offline render rather than a static realtime approximation.
3. [x] **EQ live preview jump:** removed the pre-limiter broadband level estimate. The waveform blanket now holds the last completed offline render until the next render replaces it.
4. **Mobile checks:** drag-seek on a real phone, mobile menubar dropdown positions, glow performance on slow devices, prefers-reduced-motion.
5. [x] **Live spectrum sample rate:** the live FFT mapping uses `AudioContext.sampleRate` published by `SynAudioEngine.getLiveTelemetry()` instead of assuming 48 kHz.
6. **AI Assistant page:** reskinned only. Rebuild its layout to match the console.
7. **Plugins & Host tab + Windows companion:** restyle the tab (connection status, plugin list, add-to-chain, params, Open Editor). Give the companion window a JUCE LookAndFeel in the same skin (not done; the companion is still a console program). [x] Release workflow `.github/workflows/windows-companion-release.yml` (green on `main` run 45585537553; tag run 45586663270 published pre-release [v0.1.0](https://github.com/LILSYNNOFFICIAL/SYN-MASTER/releases/tag/v0.1.0) with `SYN-MASTER-VST-Companion-v0.1.0-win-x64.zip` + `.sha256`) (windows-latest, Ninja + MSVC, zip with README/notices/SHA-256, GitHub Release on `v*` tags) and [x] docs/VST_COMPANION.md finished, including licensing. [x] Pre-release [v0.1.1](https://github.com/LILSYNNOFFICIAL/SYN-MASTER/releases/tag/v0.1.1) (zip SHA-256 `70c179da174fbd88f6a2351961a3f66bbd415a49d365bb8d3bd5498fbba9b507`). [x] Licence decided: companion is AGPL-3.0-only (free JUCE AGPLv3 route), JUCE bumped to 8.0.17-security (bundles MIT VST3 SDK 3.8.0); zips ship LICENSE.txt + SOURCE.txt. Ports: HTTP 127.0.0.1:47832, WS 127.0.0.1:47833; pairing code SYN-XXXX-XXXX.
8. **BYO-AI leftovers:** [x] model names verified and stale defaults replaced (see *Bring your own AI provider*), [x] model-name sanity check + clearer provider errors, [x] mocked-fetch tests per provider, [x] BYO docs. Best-candidate fallback already exists (`src/director/safeCandidateFallback.ts`, P1-9; the Director also always keeps the best validated checkpoint), so nothing was added. Still open: shimmer calibration on real audio; a live call against each provider with a real key.
9. **Cleanup:** leftover old-dashboard CSS and the duplicate `:root` block in `src/index.css`, and native `assert` tests.

Rules: commit small working changes straight to `main`. Stay AI Studio compatible: same entry files, assets under `public/`, no new backend or build steps, Gemini key server-only. Don't change the DSP defaults, the default Gemini provider, or the Fix-All verification loop unless an item says to. Run `npm run lint`, `npm run build` and `npx tsx --test` on touched tests. Update this README as you go.

### Accuracy follow-up — Nov 25, 2026

- [x] EQ drag preview holds its prior rendered waveform; it no longer scales from an estimate that omits limiter behavior.
- [x] Dynamic EQ fallback in the realtime Web Audio graph is neutral rather than a static filter that misrepresents the offline detector. Mastered playback continues to use the exact offline render.
- [x] Add regression coverage for legacy ratio/mode migration, bounds, boost, and a WAV-byte render containing both Dynamic EQ attenuation and post-chain fades.
- [x] The live output readout exposes current sample peak and live gain reduction; the console also exposes last-render peak-stage input/output and gain reduction, alongside measured final true peak.
- [ ] Browser download/Fix-All e2e, phone/Android Chrome and low-end device checks, listening parity, and calibration on representative real music remain manual acceptance tasks. This environment has no supplied owner source track or physical device.

### Functional audit follow-up

- [x] Fix-All reference matching now derives bounded, level-neutral EQ bands from measured source and valid reference spectra; a render regression proves the selected EQ reaches the offline audio chain. Invalid or absent reference spectra do not produce Match EQ bands. Dynamic EQ remains the measured-problem correction and is covered by the existing offline/export render tests.
- [x] Fixed statuses now require a fresh, ready post-render analysis with distinct baseline/render identities and matching active/rendered chain fingerprints. Missing classifications remain unverified, and a report cannot claim a full pass while measured findings or vocal verification remain unresolved.
- [x] Stereo click repair now groups nearby channel detections into shared repair windows and applies a shared, localized edge repair. Synthetic tests measure discontinuity reduction, boundary continuity, stereo coherence, and preservation of unaffected samples; broader real-music listening/calibration remains open.
- [x] Compact EQ-header transport controls use the shared play/pause and seek actions. The source layout wraps controls on narrow screens; real-device visual checks remain open.
- [x] Vocal-Focused Fix-All measures separated source vocals against accompaniment, only evaluates reference stems when the source crosses the -3 dB trigger, caps boosts at +3 dB, independently remeasures the adjusted stems, and renders only a verified correction. Preparation is cached per source/reference pair, resource-preflighted, cancellable, and timeout-bounded. Missing references, failed separation, and unverified results are explicit and cannot produce a passed verdict. Non-Vocal-Focused objectives do not initiate this separation path.
- [x] Stem Studio and Vocal-Focused Fix-All now request separation through one shared service. It hashes the canonical 44.1 kHz stereo audio and includes the pinned model revision and quality mode in the key; identical concurrent requests share one worker, completed results are reused only for that exact identity/configuration, and malformed or failed results are not cached. Consumer cancellation detaches only that consumer and aborts the worker only when no consumers remain. Resource preflight runs once per new job; the completed in-memory cache is bounded to 256 MiB. Manually uploaded stems without verifiable source/configuration metadata are not treated as reusable Demucs results. Browser/device e2e and real-track vocal-rebalance listening remain unverified.
- Local verification on the audit workspace: `npm test` passed **237/237**, **0 skipped**; the FFmpeg/ffprobe export integration test executed. `npm run lint`, `npm run build`, and `npm run check:bundle` passed. Vite still reports its >500 kB chunk advisory; the configured bundle budget passed at **796.9 KiB raw / 236.9 KiB gzip** for the largest chunk, below 800 KiB / 250 KiB limits.
### Verification, mobile emulation and skin pass — Nov 25, 2026

Presentation and verification only: no DSP defaults, AI prompts, provider behaviour, default Gemini, or Fix-All loop changes.

- [x] **Export ↔ preview parity test** (`src/dsp/exportPreviewParity.test.ts`): a stereo source through an enabled Dynamic EQ (one cut band, one boost band) and a working limiter, with S-curve/linear timeline fades. The export path (`renderMixedChain` → 32-bit `encodeWavBlob`) is bit-identical to the preview path (the real `dspWorker` module driven through `createDspWorkerClient`), including per-module telemetry. Fades are proven post-chain (chain telemetry unchanged by fades; output = fades(chain(source)); pre-chain fading would differ). Dynamic EQ cuts 1 kHz and lifts 5 kHz; bypass is bit-identical. 16/24/32-bit files parse as valid RIFF/WAVE (RIFF size, fmt fields, data alignment) within half an LSB, and `ffprobe` accepts them (skipped when ffprobe is absent).
- [x] **Fix All end to end with a mocked AI** (`src/director/fixAllMockedAi.test.ts`, browser: `scripts/e2e-fixall-mocked-ai.mjs`). Node: for every mode the BYO-provider strategy request carries `Mode: <mode> — <meaning>`; the server's built-in Gemini call (SDK fetch mocked, no real request) sends the same line; a deliberately weak mocked AI chain seeds the loop, pass 1 is re-measured and fails the gate, the loop asks the mocked AI to refine, and the final verdict reproduces from an independent re-render + re-measure of the retained chain. Browser (production build, Chromium): imports a 2 s WAV, points the provider at a mocked OpenAI-compatible endpoint, enables cloud reasoning, presses FIX ALL; the strategy request carries the Mode line, the loop requested refinements, built-in Gemini was not called, and the UI shows a measured verdict. Note: since 2026-11-25 cloud AI reasoning is **on by default** (owner decision), so FIX ALL asks the active AI provider (built-in Gemini unless a BYO provider is set) to plan the rack, including EQ subtypes, slopes, channels and Dynamic EQ settings. The user can switch it off in AI Director → Safeguards & Cloud; the choice is remembered in `localStorage` (`syn.useCloudAi`). If the AI call fails or its chain fails validation, Fix All falls back to the local DSP planner.
- [x] **Mobile emulation** (`scripts/mobile-emulation-check.mjs`, Chromium device emulation at 412×915 and 390×844 with `isMobile` + touch; **not a real phone**): CDP touch drags seek the TimelinePlayer forwards and backwards (playhead and time readout follow, the page does not scroll); all five header Menu dropdowns, the hamburger library drawer and the More workspace menu stay on screen; the meter bridge stacks with no overlapping or clipped readouts; `emulateMedia({ reducedMotion: 'reduce' })` stops all 14 infinite glow animations that run with no preference. Fixed on the way: the mobile meter bridge stayed a single flex row (a `.syn-workstation .syn-meter-bridge` rule out-ranked the ≤767 px grid), so the monitor-volume card covered the L/R meters and the five readouts overlapped; and Esc only closed the library drawer when focus was already inside it (the toggle keeps focus), so Esc now closes it from anywhere.
- [x] **Responsive suite repaired** (`scripts/responsive-layout-check.mjs`, Web CI's `verify` job was failing on it): updated to the guided flow (FIX ALL step 2 above EQ step 3 on mobile), the always-visible TimelinePlayer (the old "Timeline & fades" toggle is gone), and QC's removed hero; the WAV export e2e removes `showSaveFilePicker` (headless Chromium exposes it but never answers, so no download arrived) and now checks the Dynamic EQ as a 260 Hz cut relative to a 1 kHz reference partial (the maximizer re-levels overall RMS, so the old RMS assertion could not hold). `SYN_RESPONSIVE_ONLY=360,1440,export` runs a subset locally. All five viewports and the export e2e pass locally.
- [x] **Skin restyle (styling only, no new controls):** *Plugins & Host* (`PluginManagerView.tsx` hooks + `skin.css`): glass cards, gold primary actions (Pair & Connect, Scan, Insert, Insert in Rack), blue-glass secondary buttons, connection pill glows cyan when connected / gold while pairing / magenta when unavailable, cyan selected plugin row, status badges recoloured, and each exposed parameter shows a bar of its real reported default (`defaultValueNormalized`). *AI Assistant*: inner wells, operating-mode cards and objective chips (now with `aria-pressed`) in the console glass/cyan language, gold FIX ALL & VERIFY to match the console centrepiece, gold measured "Post" values, cyan "Working well" and magenta open-problem cards. *Analysis Lab*: the canvases already draw in blue/cyan/purple; the remaining old-palette chrome is fixed: zone balance bars are blue→cyan with a purple tick at the real pre-master value, the loudness legend no longer says "Gold" for the cyan mastered line, resonance peaks are magenta, metric labels gold. Checked with screenshots at 1440 and 412 (connected plugin state rendered with a fake snapshot, since no companion host is available here).
- [ ] Remove dead old-dashboard CSS and the duplicate `:root` in `src/index.css`.

## Ozone-class EQ overhaul (Nov 25, 2026, owner approved DSP, prompt-schema and UI changes)

Band design lives in `src/dsp/eqDesign.ts` and is shared by the offline renderer (preview, Fix All, export), the realtime graph and the drawn curves, so the curve on screen is the response that renders.

- [x] **Parametric EQ DSP:** band families Bell / Low Shelf / High Shelf / Low-Pass / High-Pass plus Notch, Band-Pass and Tilt. Subtypes: Bell → Proportional Q (Q x1 at 6 dB, x2 at 18 dB), Bell (RBJ), Band Shelf (flat top, inner gain solved so the centre is exact); shelves → Analog (RBJ, 6/12/24 dB/oct), Baxandall (two half-gain 1st-order shelves two octaves apart), Vintage (shelf + opposite 0.35x dip past the corner, Pultec-style), Resonant (Q-form shelf with overshoot, 12/24); pass → Flat (Butterworth 6–96 dB/oct; 12 dB keeps the band Q), Resonant (top section peaks ~+6 dB), Brickwall (12th-order Chebyshev I, 0.1 dB ripple, bilinear pre-warped once at the cutoff: ≥40 dB down 0.26 oct past the cutoff). Per-band channel Stereo / Mid / Side / Left / Right (render order: stereo bands → M/S bands → L/R bands), auto-gain (pink-weighted 30 Hz–16 kHz average of the curve), and band solo (only honoured by preview renders that pass `audition: true`; export, Fix All and verification never do). Linear-phase mode builds one FIR per channel group.
- [x] **Dynamic EQ DSP:** curve types Bell, Proportional Q, Band Shelf, Baxandall Bass/Treble, Low/High Shelf; soft knee, per-band channel, custom sidechain detector frequency/Q, detector lookahead (0–10 ms, output time-aligned), up to 8 bands, preview-only solo, and per-band detector/gain traces (`collectDynamicEqTraces`) for the threshold meter and live curve.
- [x] **Backward compatibility:** bands without the new fields take the original code paths. SHA-256 golden renders from the pre-overhaul renderer (`eb48f52`) for the default EQ, default Dynamic EQ and saved legacy chains (all six shapes, tilt, linear-phase M/S, intensity) are asserted in `src/dsp/eqDesign.test.ts`; explicit default subtypes (Bell, Analog 12, Flat 12) reproduce the legacy coefficients exactly. Validation only writes new keys when present, so legacy params keep their exact shape.
- [x] **Fix All with AI:** the shared system prompt (`src/ai/masteringPrompt.ts`, used by built-in Gemini and every BYO provider) documents `subtype`, `slope`, `channel`, `autoGain` and the Dynamic EQ `type`, `kneeDb`, `channel`, `sidechain`, `lookaheadMs` fields with usage guidance; the provider tool/JSON schemas carry `paramsJson` as a string, so they needed no shape change. `validateProcessorParams` clamps and drops invalid values (subtype must belong to its shape, slope must be allowed for the subtype, 8 bands max); `validateChainAgainstInventory` still rejects non-finite values; the inventory documents the new bounds. Objective gates and the verification loop are unchanged. Tests: `src/dsp/eqValidation.test.ts`.
- [x] **Realtime, preview and verification wiring:** the realtime Web Audio graph builds non-legacy EQs from the same sections as `IIRFilterNode`s with the same channel routing and auto-gain (`src/engine/eqGraph.ts`; legacy EQs keep the original BiquadFilterNode graph). The DSP worker / fallback renderer take preview-only `audition` and `collectDynamicEqTraces` options and return `dynamicEqTraces`. Chain fingerprints include the new EQ / Dynamic EQ fields only when set, so pre-existing chains keep their fingerprints (asserted against values from `eb48f52`); a gain-0 notch or band-pass now counts as an active band. Tests: `src/engine/eqGraph.test.ts`.
- [x] **SYN EQ editor (`ParametricEQ2.tsx`, shared parts in `src/components/studio/eq/`):** Ozone-style band popover next to the node (power, S = listen, X = delete), cascading Type menu with curve icons (Bell → Proportional Q / Bell / Band Shelf; Low/High Shelf → Analog / Baxandall / Vintage / Resonant; Low/High-Pass → Flat / Resonant / Brickwall; Notch, Band-Pass, Tilt), numeric freq (with note + cents readout, accepts `2.5k`), gain, Q (drag the label or type), slope and channel selectors. Graph: pre / post / both / off analyser, per-band fills, mid curve plus dashed side / left / right curves, Q diamond handles, wheel = Q, double-click to add (8 bands), double-click a node to zero its gain. Keyboard on nodes: arrows (Shift = fine), +/- Q, S solo, Delete, Esc; menus are full keyboard menus. Toolbar: phase mode, analyser, auto-gain (shows the trim), module output gain, global tilt, A/B snapshots with copy, presets (built-in curves plus saved presets in localStorage; solo is never saved). Drags stream locally and commit once on release, so each gesture is one undo step in the existing history.
- [x] **Dynamic EQ editor:** rebuilt on the shared Ozone-style `EqGraph`, `EqBandPopover`, `EqTypeMenu`, and `CurveIcon` components. The graph draws the maximum range response and a live curve from the actual preview-render detector/gain traces; it receives source/master spectra for pre/post analysis. Bands have draggable frequency nodes, Q handles/wheel, type selection (Bell, Proportional Q, Band Shelf, Baxandall Bass/Treble, Low/High Shelf), per-band power/solo/delete, threshold meter, range, cut/boost, ratio, and advanced attack/release/knee/channel/custom-sidechain/lookahead controls. Supports all 8 DSP bands, with drag edits committed once on release. Dynamic EQ now has a brighter cyan/gold/purple glow than the parametric EQ while respecting reduced motion.
- [x] **App wiring:** preview renders pass `audition` when a band is soloed (you hear the soloed region; QC readouts follow the preview) and collect Dynamic EQ traces; export, Fix All, battle and verification renders never do. Edits go through `updateChainWithHistory` (undo/redo), chain presets / project save, A/B (Original vs Master), preview playback and export unchanged. The type menu is portalled (fixed) so no panel can clip it; below 640 px the popover docks under the graph and submenus open inline. To stay inside the 800 KiB initial-bundle budget, the Dynamic EQ editor, the in-page rack and the floating rack window are code-split and prefetched after first paint (initial chunk ~762 KiB). The spectrum view's EQ overlay and the rack card's shape list use the new designs.
- [x] **Browser checks:** `scripts/eq-overhaul-check.mjs` (Playwright, 1440 and 412 px, parametric EQ only): popover and menus on screen, Type submenus, subtype/slope/channel changes, note readout, solo notice, keyboard nudge, double-click add, no page overflow, no runtime errors. `scripts/responsive-layout-check.mjs` waits for the code-split rack / Dynamic EQ before asserting (same assertions).
- Tests: `src/dsp/eqDesign.test.ts` (every subtype's response, slopes, channels, auto-gain loudness, solo, rendered impulse response vs drawn curve in minimum and linear phase), `src/dsp/dynamicEqTypes.test.ts` (ratio, range, threshold, boost, knee, channel, sidechain, lookahead, curve types, traces, solo).

## ChatGPT handoff — next steps (Nov 25, 2026, responsive selector repair)

Current verified repository state:
- Hark's Match EQ, Vocal Rebalance, Platform Preview and What AI changed integrations are present on `main`, alongside the earlier Dynamic EQ editor.
- The pre-repair Web CI run [#45646481702](https://github.com/LILSYNNOFFICIAL/SYN-MASTER/actions/runs/45646481702) on `e12231d8c72454f0a91ece250f2f7893d121a4cd` passed 370/370 unit tests, TypeScript, production build, bundle budget and production startup. Its responsive Chromium step failed at 360 px with the mobile command menu open: workstation width 417 px in a 360 px viewport; the six-option EQ view selector was the measured overflow source.
- The pre-repair Windows x64 workflow [#45646481558](https://github.com/LILSYNNOFFICIAL/SYN-MASTER/actions/runs/45646481558) succeeded on that same baseline, including native host/scanner/worker/core tests, compiled VST3 discovery/hosting/DSP/fault-isolation checks, browser/server build and unsigned Windows installer packaging.
- Responsive repair commits on `main`: `4b594274f7ef9ead75590e291093491c574c0149` scopes a three-column, two-row wrapping layout to the EQ view selector at widths ≤640 px; `dda41d31de8608e53e400d8c071698a72d5d7485` adds Playwright assertions that all six selector buttons remain visible and inside the selector in both the mobile command-menu-open and normal studio states.
- Match EQ editor documentation was expanded in commit `c72dc78ed84a350efc8ea67842b8563eee132cd0`: graph, Learn/Re-learn/Clear, Amount, smoothing, boost/cut and frequency limits, channel/phase controls, and saved-curve workflow.
- The baseline bundle check was approximately 795.3 KiB against an 800 KiB initial JavaScript budget (about 4.7 KiB headroom). The responsive CSS and browser assertions add no runtime dependencies; verify the final build's bundle budget again.
- **Not yet verified on the repair commits:** a fresh full Web CI result and a new Windows workflow result. The available status lookup returned no status entries for the documentation commit, so do not infer that new runs passed or completed.

Next work, in priority order:
1. Verify the latest `main` commit and obtain the fresh Web CI run for it. Confirm the new responsive assertions and inspect exact job logs. Required coverage: unit tests, TypeScript, production build, bundle budget, startup smoke test, responsive Chromium at 360/375/412/1024/1440 px, and production WAV export with timeline fades and Dynamic EQ.
2. Verify the Windows x64 workflow on the repaired head, including native/plugin tests and unsigned installer packaging.
3. If the 360 px check still fails, inspect the new measured offender and computed layout before making another change. Do not hide page overflow globally or remove any EQ view.
4. Continue real-world acceptance separately: listen to Match EQ, Vocal Rebalance, Dynamic EQ and Platform Preview on representative real tracks; test real Demucs separation and OPFS reload; run FIX ALL with a live provider; test physical Android and Safari/iOS codec behavior. Synthetic fixtures and Chromium viewport checks do not replace these.
5. Keep explicit limitations: real Demucs/browser and OPFS behavior, real vocal listening and Android memory use, real-monitor/platform-limiter fidelity, Safari Ogg/Opus decoding, album-mode normalization, deployed AI Studio visual inspection, and live-provider acceptance remain unverified.

Rules: commit directly to `main`; preserve existing work; keep Google AI Studio compatibility (same entry files, assets under `public/`, no new backend/build steps, Gemini key server-only); do not change DSP defaults, the default Gemini provider or the FIX ALL verification loop unless explicitly requested. Update this README as work is verified.

## FIX ALL upgrades (Nov 25, 2026)

- [x] **Cloud AI spend caps** — per-client strategy/refine per-minute caps, per-client daily caps and a global daily cap on the Gemini-spending routes (env-overridable, see "AI endpoint protections and limits"); 429 with a clear message; the client falls back to the local DSP planner, shows a friendly notice and pauses built-in AI calls until Retry-After. `createRateLimiter` gained a non-consuming `peek`. Tests: `src/server/aiSpendLimiter.test.mjs`, `src/server/aiRateLimit.integration.test.mjs` (spawns the production server with no Gemini key), `src/ai/cloudRateLimit.test.ts`.
- [x] **Fallback Director knows the new EQ types** (`src/director/eqStrategy.ts`, used by `buildExplainableMasterPlan` and `deriveRefinementCommands`). Every choice is gated on a measurement; with no evidence a band keeps the legacy fields and renders exactly as before. Rumble: legacy Flat 12 dB/oct high-pass unless rumble is measured (16–30 Hz within 8 dB of 60–250 Hz, Sub > Bass by 4.5 dB, or DC ≥ 0.4 %), then Flat 24 dB/oct (18 for Transparent/Dynamic/Acoustic); measured rumble now adds the high-pass on any objective. Mono bass: a Side-channel Flat low cut (90 Hz 12 dB/oct, or 115 Hz 24 dB/oct below 0.5 correlation) when low-end correlation < 0.72; the imager then leaves `monoBassBelowHz` at 0 instead of stacking a second crossover. Mud: Proportional Q bells (static 300 Hz bell base Q 1.8, refinement bell base Q 1.6, so small cuts stay as wide as before and deeper refinement narrows) and a Proportional Q, 6 dB-knee dynamic 250 Hz band. Tilt: Baxandall shelves for slope-driven moves (lean-low-end bass lift, dark-slope air lift at 8 kHz); corrective and reference-matched shelves stay Analog (legacy). Harshness / sibilance: an isolated 2–12 kHz resonance gets a constant-Q dynamic bell with a 3 dB knee; if it is in 4.5–10 kHz and the 5–10 kHz region is within 2.5 dB of 0.5–2 kHz it becomes a de-esser (dynamic high shelf keyed by a custom side-chain at the resonance, 2 ms attack, 2 ms lookahead, 4 dB knee) and SYN-Restore's static de-esser drops to its light baseline. Centre-dominant material (phase correlation ≥ 0.8) is processed on the Mid channel. Objective gates and the verification loop are unchanged; all 304 existing tests pass unmodified. Tests: `src/director/eqStrategy.test.ts` (including a render showing the Side low cut raises low-end correlation, and validation keeping every new field).

## Match EQ (Nov 25, 2026)

Ozone-style Match EQ, processor type `match-eq` (`src/dsp/matchEq.ts`).

- [x] **Editor UI** (`src/components/studio/MatchEQPanel.tsx`, lazy in the console): the shared Ozone-style graph overlays the learned source spectrum (cyan), reference spectrum (gold), correction curve and frequency-limit handles (violet). Learn / Re-learn captures the loaded source and reference; Clear removes learned spectra and restores pass-through. Controls include Amount, 1/1–1/24-octave Smoothing, Max boost / Max cut, Low / High frequency limits, Stereo / Mid / Side channel and Linear / Minimum phase. Drag the L/H graph handles to set the range. Name and save learned curves, load saved curves, and manage/delete them in the editor. The panel explains that Match EQ changes tonal shape, not loudness, and distinguishes the offline FIR render from the realtime minimum-phase approximation.

- [x] **DSP** (`feat(dsp): Match EQ processor`): learns the long-term average spectrum (stereo, mid and side views; silent frames gated out) of the source and of the reference on a fixed 1/24-octave grid. The correction is the level-aligned difference of the two 1/1-1/24-octave smoothed spectra, scaled by Amount (0-100 %), clamped to Max boost / Max cut (0-12 dB) and faded to 0 dB outside the Low/High limits. Offline (preview, Fix All, export) renders it as a frequency-sampled FIR: linear phase (latency compensated, default) or minimum phase (cepstral), bounded-memory overlap-add in place. The realtime graph approximates it with a zero-latency minimum-phase true-stereo ConvolverNode (mid/side routing in the 4-channel IR). Learned spectra live in the module params, so renders, saved chains and presets are deterministic; unlearned, zero amount or zero intensity is a bit-identical pass-through, so existing chains render unchanged.
- [x] **AI / FIX ALL / Director:** shared prompt schema 15 documents `match-eq` and the strategy prompt says whether Match EQ is AVAILABLE (reference loaded) or not; refine prompts summarise Match EQ params without the learned spectra. Validation clamps every field and keeps spectra only when complete and finite; inventory entry added. The loop learns the source spectrum, hydrates AI-proposed Match EQ stages from the loaded reference (holding them to ≤ 60 % / ±3 dB) and drops them when no reference is loaded. The local Director adds one conservative Match EQ (40 %, ±2.5 dB, 1/3 octave, 40 Hz-16 kHz) right after SYN-Restore only with a learned reference and a correction of at least 0.5 dB.
- Tests: `src/dsp/matchEq.test.ts` (curve hits a +1 dB/oct pink-noise target within 0.75 dB in linear and minimum phase, amount/limits clamp exactly, range fade, rendered limits, FIR accuracy and latency compensation, pass-through bit identity, mid/side isolation, realtime IR routing, validation), `src/dsp/matchEqExportParity.test.ts` (WAV export bit-identical to the preview worker render for linear/minimum and stereo/mid), `src/director/matchEqDirector.test.ts` (Director only with a reference, hydration/clamping, prompt gating, loop hydration/drop). Inventory count tests updated 14 -> 15.

## What AI changed (Nov 25, 2026)

- [x] **"What AI changed" list after FIX ALL / CHAIN WITH AI** — `src/director/chainDiff.ts` diffs the chain from before the run against the retained final chain: every module added, removed, changed or moved, with before → after values for its key params (EQ / Dynamic EQ bands read as one line each). Generic over processor types: params are walked structurally, so new processors need no changes; UI-only state (`expanded`, band `solo`, VST3 session fields) is ignored. Modules pair by id, then by type in order (the planner may mint new ids). Each entry has Undo / Reapply that touches only that module (later manual edits survive) and **Undo all**; all go through `updateChainWithHistory`, so global undo/redo and the correction history stay consistent, and entry status (applied / undone / edited since) is derived from the live chain. UI: `src/components/studio/WhatAiChangedPanel.tsx` (lazy chunk) in the console's `aiChanges` slot under FIX ALL and in the AI Assistant workspace; styles in `src/skin/skin.css`. Tests: `src/director/chainDiff.test.ts`.
## Vocal Rebalance (Nov 25, 2026)

Ozone Master Rebalance-style processor `vocal-rebalance`: raises or lowers the vocal (-12..+6 dB) and optionally bass and drums inside the finished stereo master.

- [x] **DSP** (`src/dsp/vocalRebalance.ts`): phase-preserving, only the gain difference is added: `out = mix + (g - 1) * w(t) * stem`. 0 dB on every stem returns the input bit-for-bit. Sensitivity (0-100) weights the move by how much the stem dominates each 256-sample hop (share^(s/50)), smoothed zero-phase by Smoothing (5-500 ms); 0 = whole stem.
- [x] **Stems** reuse the Stem Studio HT-Demucs worker (`src/services/rebalanceSeparation.ts`): 44.1 kHz round trip, mixture consistency over all four stems, keep vocals/bass/drums. Cached per track by a source fingerprint in memory and in OPFS (`syn-master-rebalance-v1/`, latest two tracks). Separation only starts when the user presses **Separate stems**, with progress and Cancel. Mobile / low-memory devices get a warning (continue or skip); far-over-budget devices are blocked with a Skip button (`assessRebalanceResources`).
- [x] **Render paths:** offline only (preview render, export, Fix All). The DSP worker receives the cached stems once per worker; stems apply only when the module's input matches the source fingerprint, and validation/chain edits keep the module first. Realtime playback uses the last offline render.
- [x] **FIX ALL** (`src/director/vocalRebalancePolicy.ts`, loaded on demand): with cached stems the AI prompt gets a VOCAL REBALANCE block (measured vocal-to-music ratio, 150 Hz high-passed RMS on vocal-active frames, vs an objective range); prompts without cached stems are unchanged. Every AI or local proposal is gated: removed without stems, vocal clamped to -4..+3 dB and only toward the range (never past its far edge, at most ±1.5 dB when in range), bass/drums ±3 dB. The local Director adds only a vocal move (≤3 dB) when the measured ratio is more than 1 dB outside the range. Passes are still judged by the unchanged objective gate. **The ranges are uncalibrated starting points; calibrate on real music.**
- [x] **UI:** rack card (`VocalRebalancePanel`) and console **Vocal** tab in the EQ panel, with per-stem level meters at the playhead. Checked with Playwright at 1440 and 412 px (no overflow, keyboard slider, no page errors).
- [x] **Tests:** `src/dsp/vocalRebalance.test.ts` (bit-identical 0 dB, gain maths on synthetic stems, sensitivity bounds, no-op without matching stems, clamping, export == worker preview with stems sent once, 32-bit WAV samples), `src/director/vocalRebalancePolicy.test.ts`, `src/services/rebalanceStemCache.test.ts`.
- [ ] Not verified: a real Demucs separation run in a browser, OPFS reload, listening tests on real vocals, Android memory behaviour during separation.

## Platform Preview (monitoring only) — Nov 25, 2026

Hear and measure the master the way streaming platforms play it. **Monitoring only:** the gain sits on the playback bus after the chain (`SynAudioEngine.setPlatformPreview`), so preview renders, FIX ALL verification and export are untouched and the objective gates are unchanged.

- **Where:** compact selector under the transport (`src/components/platform/PlatformPreviewSelector.tsx`, lazy) and the full panel in Quality Control (`PlatformPreviewPanel.tsx`, lazy): "this platform will turn your master down/up by X dB", plays-at LUFS, predicted true peak after normalisation, per-platform table (click a row to hear it), Spotify Normal/Loud/Quiet. Works at 1440 and 412 px, keyboard operable, reduced-motion respected.
- **Model:** `src/dsp/platformRules.ts` (pure, no runtime imports so the server prompt builder can load it under plain Node). Track (shuffle) normalisation; album mode is not modelled. A/B vs Original stays loudness-matched by the existing A/B setting; the platform gain is computed from the master's measurements.
- **Codec audition:** encodes a 10/20/30 s snippet from the playhead through the existing `/api/export/encode` route (no new backend) as Ogg Vorbis 320, AAC 256, Opus 160 or Opus 256, decodes it in the browser, loudness-matches B to A, and plays A/B through the platform gain (`snippetPlayer.ts`). Codec clipping = decoded true peak over 0 dBTP (browser 4x interpolator, plus FFmpeg's `ebur128` reading from the route's `X-Syn-True-Peak-Dbtp` header).
- **QC / AI:** `runQualityControl` adds `platformHints` (gain + predicted true peak per platform). It is not a check and does not change any status or count. `buildRefineUserPrompt` adds it as a labelled read-only hint (values re-validated server-side) so FIX ALL can prefer platform-safe peaks.

| Platform | Rule used | Codec auditioned | Source |
| --- | --- | --- | --- |
| Spotify | Normal −14, Loud −11, Quiet −19 LUFS (ITU 1770). Positive gain stops at 1 dB true-peak headroom (their −20 LUFS / −5 dBTP → −16 example). Loud ignores peaks and uses a limiter at −1 dB sample, 5 ms attack, 100 ms decay (realtime approximation: Web Audio compressor with its makeup gain cancelled). | Ogg Vorbis ~320 (Premium Very high); AAC 256 on the web player | Official: https://support.spotify.com/us/artists/article/loudness-normalization/ , https://support.spotify.com/us/article/audio-quality/ |
| Apple Music | Sound Check raises or lowers playback; −16 LUFS by measurement; positive gain modelled peak-limited at −1 dBTP (Apple publishes no number). | AAC 256 | Apple Digital Masters: https://www.apple.com/apple-music/apple-digital-masters/ ; −16 reported: https://www.loudmeter.net/apple-music-lufs |
| YouTube | −14 LUFS, turn-down only (measured; not published). | Opus ~160 | https://www.markstudios.com/tools/lufs-meter , https://www.loudmeter.net/youtube-loudness , https://audioutils.com/blog/best-audio-format-for-youtube-upload |
| TIDAL | −14 LUFS, turn-down only, album mode aligns the loudest track (reported; TIDAL's own article is gone). | Lossless FLAC (any codec can be auditioned) | https://audioxpress.com/news/tidal-implements-album-loudness-normalization-and-activates-it-by-default-for-mobile-players , https://productionadvice.co.uk/tidal-loudness |
| Amazon Music | Listener setting; −14 LUFS turn-down only by measurement. | SD = Opus 48/192/320 kbps (official); auditioned at 256, the export route's maximum | https://www.amazon.com/gp/help/customer/display.html?nodeId=TgG1d8mPjGwf885hRP , https://developer.amazon.com/docs/music/audio-formats.html |
| SoundCloud | Applies loudness normalisation; advises −14 LUFS and −1 dBTP (−2 dBTP when louder). Whether quiet tracks are turned up is not published: modelled turn-down only. | AAC 256 (Go+ HQ), 160/96 standard | https://help.soundcloud.com/hc/en-us/articles/360053660014 , https://help.soundcloud.com/hc/en-us/articles/53385714099611-Audio-Streaming-Formats |

Tests: `src/dsp/platformPreview.test.ts` (gain maths per platform incl. Spotify's documented example and Loud limiter, QC hints leave checks untouched, prompt sanitising, codec clipping on a synthetic fs/4 inter-sample-peak signal, encode params inside the route's validation, FFmpeg Vorbis round trip of a hot signal when FFmpeg is installed).

- [x] **feat(dsp): platform playback model with read-only QC and AI hints** — `0fe2f86`.
- [x] **feat(ui): Platform Preview selector, QC panel and codec A/B audition** — `743bb97`.
- [x] **perf(ui): lazy-load the Platform Preview selector and move rule notes out of the main chunk** — `a4b77d4` (main chunk back under the 800 KiB budget).
- [x] **fix(ui): codec "after platform gain" peak follows the platform model (Spotify Loud limiter)** — this commit. Browser check (production build, headless Chromium, 1440 and 412 px): selector, panel, Ogg/AAC/Opus encodes through `/api/export/encode`, A/B, no horizontal overflow, no page errors.
- [ ] Not verified: listening on real monitors/phones, Safari/iOS decoding of Ogg Vorbis/WebM Opus (the panel reports a decode failure and suggests AAC), the realtime Spotify Loud limiter against Spotify's own limiter, and album-mode normalisation.
