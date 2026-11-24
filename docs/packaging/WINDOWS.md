# Windows desktop packaging

## Current implementation

The first Electron-based workstation shell and unsigned NSIS x64 installer pipeline are now in the repository. Electron starts the Express production runtime on a random loopback port, injects a per-launch bearer token through a narrow preload IPC bridge, opens the browser workstation inside an isolated renderer, and launches the native VST3 companion when its staged binaries are present. It uses Electron 45.4.1 and electron-builder 26.17.0.

The native companion remains independently built: syn-plugin-host.exe, syn-plugin-scanner.exe, and syn-plugin-worker.exe. The desktop preparation script stages these binaries, the built Vite application, and a bundled production Express server before electron-builder produces the NSIS installer.

The app requests authenticated graceful shutdown from the VST3 host before a bounded forced-stop fallback. The native validation harness now asserts that the shutdown endpoint returns HTTP 202 and the host process exits with code 0; this new assertion is pending the current Windows CI run.

## Pipeline

The Windows workflow builds the native VST3 companion, runs plugin discovery/audio/fault-isolation checks, builds the React app and server runtime, then produces an unsigned Windows x64 NSIS installer. The installer artifact is not code-signed.

## Remaining release gates

- Verify the Windows workflow completes and inspect the uploaded installer artifact.
- Install and launch that artifact on a real Windows 11 x64 machine.
- Test import, playback, seek, Fix All, cancellation/rollback, export, WASAPI selection/recovery, VST3 discovery/hosting, and clean app shutdown.
- Verify app data survives upgrade and uninstall behaviour is correct.
- Decide FFmpeg redistribution and codec licensing; confirm any external FFmpeg deployment or runtime dependency.
- Add release signing and installer provenance before public distribution.
- Validate native host startup failure, server startup failure, occupied port recovery, and app forced termination.

Do not equate a successful compiler or installer build with an installed-app acceptance pass.
