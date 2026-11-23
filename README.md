# SYN MASTER

**Precision Engineering. Intelligent Mastering. Exceptional Sound.**

SYN MASTER is an AI-assisted mastering workstation built around a browser-based React application, a server-side Gemini integration, a native DSP engine, and a Windows VST3 companion host. Its mastering workflow combines audio analysis, explainable processing plans, iterative DSP refinement, and post-processing verification.

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
- Each autonomous Fix All run journals its baseline diagnosis, proposed chain, activity notes, and measured checkpoints into a temporary OPFS workspace, then removes that scratch folder after the final report is captured.
- Fix All supports up to 10 autonomous passes with a bounded execution budget, retains the best validated pass, and never equates a refinement plateau with a perfect or converged master.

### Measurement-aware refinement

The Director uses measured spectral and loudness information to guide corrections. Refinement recommendations are tied to the measurement that remains outside the active objective's threshold. For example:

- Bass-vs-mid excess is addressed with a restrained low-frequency shelf in the bass region.
- Low-mid buildup can call for a more focused low-mid bell adjustment.
- Subsonic excess can call for high-pass filtering.

The bass-vs-mid refinement path uses a proportional adjustment rather than applying a fixed, aggressive cut. It updates an existing suitable parametric-EQ bass shelf where possible, or adds a parametric EQ when one is not present.

**Verification is not a promise of perfect sound.** A passing metric does not replace critical listening, and a partially resolved finding means the remaining deviation is still reported. Always audition the rendered result and check it on appropriate monitoring systems.

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

All full-song audio formats (WAV 16/24-bit PCM or 32-bit float, MP3 up to 320 kbps, OGG Vorbis, FLAC up to 24-bit, M4A/AAC 320 kbps, and WebM/Opus) are rendered by the `/api/export/encode` endpoint. The server resamples from the 32-bit float offline DSP render with FFmpeg's 512-point Blackman-Nuttall windowed-sinc resampler. The server requires an FFmpeg build with `libmp3lame`, `libvorbis`, FLAC, AAC and `libopus` encoders available. MIDI conductor / marker export remains browser-local. The endpoint writes only to a per-request operating-system temporary directory and removes its intermediate files after each render. WAV supports 16-bit PCM, 24-bit PCM and 32-bit IEEE float; FLAC supports 16/24-bit with selectable compression; MP3 supports 320 kbps. The browser-side Fix All scratch journal uses OPFS (`SYN-MASTER-TEMP`) and removes the per-run directory on completion.

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
