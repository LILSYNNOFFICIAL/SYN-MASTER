# SYN-MASTER VST Companion (Windows)

A small Windows program that lets the SYN-MASTER web app (https://syn-master.ai.studio/) use the
VST3 plugins installed on the same PC. Plugin choice, chain order and controls live in the web app
(Plugins & Host); the companion scans, hosts and runs the plugins locally, each in its own worker
process so a crashing plugin cannot take the host down.

It is **not** the full SYN-MASTER workstation EXE (see `docs/packaging/WINDOWS.md` and the README
P2 item). It is the loopback bridge the browser app talks to.

## What ships

| File | Role |
| --- | --- |
| `syn-plugin-host.exe` | The companion. Prints status, ports and the pairing code in a console window. |
| `syn-plugin-scanner.exe` | Out-of-process VST3 bundle scanner (started by the host). |
| `syn-plugin-worker.exe` | Out-of-process plugin host/editor worker, one per plugin instance (started by the host). |
| `README.txt` | End-user install notes (`native/companion-release/README.txt`). |
| `THIRD_PARTY_NOTICES.txt` | Native component licences (`native/companion-release/THIRD_PARTY_NOTICES.txt`). |

All three executables must stay in the same folder; the host finds the scanner and worker next to itself.

## Network and pairing

- Loopback only: HTTP `127.0.0.1:47832`, WebSocket `127.0.0.1:47833` (both bound to `127.0.0.1`,
  never `0.0.0.0`). Override with `--port` / `--ws-port`.
- Allowed browser origins: `https://*.ai.studio` (the published app), `https://*.run.app`
  (AI Studio deployments), `http(s)://localhost[:port]` and `http(s)://127.0.0.1[:port]`
  (development). Extra origins only via `--allow-origin` (development).
- Pairing: each launch generates a one-time code `SYN-XXXX-XXXX` (CSPRNG, unambiguous alphabet),
  shown in the console and written to `%LOCALAPPDATA%\SYN MASTER\host_pairing.json`. The web app's
  Plugins & Host → **Pair & Connect Host** exchanges it for a session bearer token.
- Data folder: `%LOCALAPPDATA%\SYN MASTER` (plugin catalog SQLite DB, pairing file). Override with `--data-dir`.
- Scanned by default: `C:\Program Files\Common Files\VST3` and `%LOCALAPPDATA%\Programs\Common\VST3`.

## Install (end users)

1. Download `SYN-MASTER-VST-Companion-<version>-win-x64.zip` from the GitHub Release
   (https://github.com/LILSYNNOFFICIAL/SYN-MASTER/releases).
2. Unzip to a folder you own (e.g. `%LOCALAPPDATA%\Programs\SYN-MASTER-Companion`).
3. Run `syn-plugin-host.exe`. The build is **not code-signed**, so Windows SmartScreen shows
   "Windows protected your PC": click **More info → Run anyway** (or right-click the exe →
   Properties → Unblock). Compare the zip with the published `.sha256` if in doubt.
4. In the web app open Plugins & Host, enter the pairing code and click **Pair & Connect Host**.
5. Keep the console open while working; close it or press Ctrl+C to stop.

## Building and releasing

- CI build + QA: `.github/workflows/windows-x64-build.yml` (windows-2022, VS 2022 generator; builds
  host/scanner/worker/QA VST3/core tests, runs CTest and `native/scripts/validate_windows_vst3.ps1`,
  then the Electron workstation installer).
- Release: `.github/workflows/windows-companion-release.yml`. Runs on `windows-latest` for a pushed
  `v*` tag (and `workflow_dispatch`). It uses the `windows-x64-ninja` CMake preset inside an MSVC
  developer shell (so it does not depend on which Visual Studio generator the image ships), builds
  host/scanner/worker/core tests, runs CTest, zips the three executables with `README.txt` and
  `THIRD_PARTY_NOTICES.txt`, writes a SHA-256 file, uploads both as a workflow artifact and, for a
  tag, creates the GitHub Release (marked pre-release) and attaches them. `workflow_dispatch` builds
  the zip as an artifact only.
- To release: make sure the workflow is green on `main`, then
  `git tag v0.1.0 && git push origin v0.1.0`.
- Local build: see `native/WINDOWS_BUILD.md`.

## Status (2026-11-25)

Done:
- Loopback host, scanner, worker, catalog, pairing, graceful shutdown (`POST /v1/host/shutdown`), CI build and VST3 validation.
- Release workflow, end-user README, native third-party notices. First pre-release:
  https://github.com/LILSYNNOFFICIAL/SYN-MASTER/releases/tag/v0.1.0
  (zip: https://github.com/LILSYNNOFFICIAL/SYN-MASTER/releases/download/v0.1.0/SYN-MASTER-VST-Companion-v0.1.0-win-x64.zip,
  SHA-256 `34325cc642eadc5625c9cdece9ff5e973bfbf5dc4b088cd435700a4a7a3aec6c`).
- Assets for a future companion window: `native/syn_companion_ui/assets/syn-master.ico` (multi-size icon) and `syn_master_logo.png` (320 px header logo).
- `LocalIpcServer` status hooks for a window: `startScan(mode)`, `isScanInProgress()`, `scanCompleted()/scanTotal()`, `hasPairedOnce()`, `authenticatedClientCount()`.

Not done:
1. Companion window (`native/syn_companion_ui/`): `SynLookAndFeel` + `CompanionWindow` (paired/not paired,
   pairing code, scan folders + Rescan, plugin count, ports) with assets via `juce_add_binary_data`.
   Today the companion is a console program.
2. CMake for that window: link `juce_gui_basics` + BinaryData into `syn-plugin-host`, add a `.rc`
   with `IDI_ICON1 ICON "syn_companion_ui/assets/syn-master.ico"`, `WIN32_EXECUTABLE` with
   `/ENTRY:mainCRTStartup`, and a `--headless` flag so `validate_windows_vst3.ps1` keeps working.
3. Code signing (removes the SmartScreen warning) and an installer/auto-start option.
4. JUCE pin: 8.0.6 is older than JUCE's own `8.0.16-security` / `8.0.17-security` tags and the 9.0.x
   releases. Review the security releases and bump the pin in a separate, CI-verified change.

## Licensing (read before distributing widely)

- **JUCE** is dual licensed: **AGPLv3** or a **commercial JUCE licence**. The companion links JUCE,
  so a distributed binary is covered by one of the two. Under AGPLv3 the complete corresponding
  source must be offered to every recipient under AGPLv3-compatible terms. The repository is
  public but has **no LICENSE file**, so today the AGPL option is not cleanly met.
- **VST3 SDK:** Steinberg relicensed the VST3 SDK under the **MIT licence from version 3.8.0**.
  However, the pinned **JUCE 8.0.6 bundles VST3 SDK 3.7.x**, which is under the proprietary
  Steinberg VST3 License **or GPLv3**, not MIT (checked in
  `modules/juce_audio_processors/format_types/VST3_SDK/LICENSE.txt` at tag 8.0.6; JUCE's current
  `master` bundles the MIT SDK). The comment in `native/CMakeLists.txt` that says the SDK is MIT
  applies only once JUCE is moved to a version that bundles VST3 SDK 3.8+.
- Other components: IXWebSocket (BSD-3-Clause), nlohmann/json (MIT), SQLite (public domain).
  See `native/companion-release/THIRD_PARTY_NOTICES.txt`.

> **Owner decision required:** pick the JUCE licence before distributing the companion widely.
> Either (a) license the companion source under AGPLv3 (add a LICENSE covering `native/`, keep
> the source public, keep notices in the zip), or (b) buy a commercial JUCE licence (allows a
> closed-source companion). Also move to a JUCE version that bundles the MIT VST3 SDK, or accept
> the Steinberg VST3 License / GPLv3 terms for the 3.7.x SDK. The v0.1.0 pre-release is fine for
> testing; this is not legal advice.
