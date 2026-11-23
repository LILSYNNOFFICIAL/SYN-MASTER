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
- **Fade-in / fade-out lines** you click and drag on the waveform (FL Studio style).
- Compression, multiband compression, limiter/maximizer, high-pass and low-pass filters, frequency splitters/crossovers, a **Maximus-style multiband maximizer**, stereo imager, saturation/exciter, de-esser, dynamic EQ, transient shaper, clipper, dither, loudness targets (Spotify / Apple Music / YouTube presets), **A/B compare**, and new innovative tools.
- Knobs, dials, and sliders.

### 6. Chainable FX rack
A channel/FX rack in a **floating window** you can drag and resize, with reorder, bypass, and add/remove modules through a nice dropdown menu.

### 7. AI controls every tool
The AI and the algorithm must be able to set every tool's parameters, since more tools means a better master.

### 8. Look and feel
Keep the **black and gold** look, but with a completely new style/CSS and a rearranged layout that is easier to follow while still showing the technical details.

## Roadmap

Priority order. Tick as done; note open problems inline.

- [x] Rewrite README with Vision / Spec + Roadmap (handoff note)
- [x] Audit + fix the Fix-All verify / re-analyze loop (root cause documented below)
- [ ] New first screen: "Import your track" drag-and-drop
- [ ] Waveform with time grid + big centered "FIX IT ALL WITH AI" button that runs the full auto-master and reveals technical details
- [ ] Diagnostic log panel (every issue + exact per-tool settings), downloadable as JSON and text
- [x] Iterative fix/verify engine on objective metrics (LUFS, dBTP, LRA, crest, clips, clicks, spectral balance vs reference curve, phase correlation, DC) with max-iteration cap (`src/director/masterTargets.ts`, gate wired into `runAutonomousDirectorLoop`, cap 10 passes / 120 s)
- [x] De-click / de-crackle / transient spike repair (`src/dsp/repair.ts`, detector `src/dsp/clickDetect.ts`, exposed as SYN-Restore params `declick`, `decrackle`, `spikeRepair`)
- [x] AI-shimmer / metallic artifact reduction (SYN-Restore `deShimmer`, dynamic 9 kHz+ band reduction weighted to the side channel)
- [ ] New black + gold layout and CSS
- [ ] Floating draggable/resizable FX rack window with reorder, bypass and add/remove dropdown
- [ ] FL-style parametric EQ (spectrum, draggable nodes, band types)
- [ ] Dynamics modules with knobs (compressor, multiband, limiter/maximizer, clipper, transient shaper, de-esser, dynamic EQ)
- [ ] Draggable fade-in / fade-out lines on the waveform
- [ ] Maximus-style multiband maximizer
- [ ] Loudness target presets (Spotify / Apple / YouTube)
- [ ] A/B compare
- [ ] Remaining tools (HPF/LPF, crossovers, imager, saturation/exciter, dither) exposed in manual mode and controllable by the AI

### Verification bug: root cause (fixed)
Four problems combined so that "FIX ALL & VERIFY" could say a track was mastered when it was not:

1. **"Converged" was judged on a rejected pass.** The convergence check looked at the pass that had *just* been rendered, even when the regression guards had rejected that pass. The run then reported "Converged" while the chain actually delivered was an older pass that never met the targets. Convergence is now judged only on the retained best pass.
2. **Two different loudness targets.** The mastering objective (e.g. Electronic, -9.5 LUFS) and the QC profile (default Streaming, -14 LUFS) were chosen separately. The loop pushed toward one target while QC judged against the other, so a run could never truly pass, or passed against the wrong number. The objective is now the single source of truth for LUFS / true peak (`alignQcProfileToObjective`), in the loop and in the QC panel.
3. **No objective pass/fail gate.** "Done" leaned on a heuristic fit score (≥ 90) and QC. Now every pass's rendered audio is re-measured by `evaluateMasterTargets` (LUFS, dBTP, clipped samples, clicks, DC, phase, low-end phase, dynamics collapse, crest collapse, spectral balance vs reference). A gate-passing pass always beats a failing one, convergence requires the gate, plateaus no longer stop the loop while the gate fails, and the final report states plainly whether targets were met (`report.targetGate`). Clicks/pops were not measured at all before; they are now detected and fixed on the first pass.
4. **What you heard was not what was verified.** "Mastered" playback ran an approximate realtime Web Audio graph, while verification and export used the offline renderer. Playback now uses the exact verified offline render (hot-swapped after each re-render).

### Open items
_None yet._

---

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

The limiter is in-memory and applies independently to each server instance. If deploying multiple instances, use a shared rate-limit store at the edge or in a shared data service. This limiter is abuse/cost friction, **not user authentication**.

Express proxy trust is disabled by default. If the deployment is behind a known reverse proxy that overwrites forwarding headers, set `TRUST_PROXY_HOPS` to the exact trusted hop count (1-5). Do not enable proxy trust without confirming the ingress topology, because client-supplied forwarding headers must not be trusted.

AI endpoint errors returned to clients are intentionally generic. Detailed exceptions are logged server-side and must not be returned to browsers.

SYN MASTER is intentionally account-free for now: there is no in-app registration, login, user profile, or multi-user identity layer. The limiter is not an access-control boundary. Do not expose the Gemini-backed API as an unrestricted public endpoint. For a remote deployment, place the entire application behind a private access boundary before sharing it. Google Cloud Run can enforce invocation access through Cloud IAM/IAP, but that relies on Google identities and is separate from SYN MASTER application accounts. If identity-based access is not wanted, use a local-only deployment or a private gateway/tunnel that injects a server-side access credential. Never embed a gateway credential in browser code. Confirm the actual deployment's ingress and access settings before assuming it is private.

## CI

### Web CI

`.github/workflows/web-ci.yml` installs dependencies, runs unit tests, runs TypeScript checking, and creates a production Vite build. It does not need the Gemini API key.

### Windows native CI

`.github/workflows/windows-x64-build.yml` runs on `windows-2022` because the native CMake preset explicitly selects the Visual Studio 2022 generator. It builds the native host, scanner, worker, QA VST3 plugin, and core tests, then runs the compiled VST3 validation script.

A successful CI run verifies the build and scripted QA path on the GitHub runner. It does not prove compatibility with every third-party plugin or physical audio device.

## Native Windows build

See [native/WINDOWS_BUILD.md](native/WINDOWS_BUILD.md) for prerequisites, configure/build commands, and VST3 validation instructions.

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
- A shared rate limiter is still needed if the service is later scaled across multiple server instances.
- Avoid logging request bodies, audio, or credentials.
