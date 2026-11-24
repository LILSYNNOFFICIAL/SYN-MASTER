# Windows desktop packaging plan

## What exists today

The repository already builds and tests `syn-plugin-host.exe`, `syn-plugin-scanner.exe`, and `syn-plugin-worker.exe`. These are the native VST3 companion, not the SYN MASTER workstation. The main application remains the browser UI; `server.ts` owns the Express API and static-file delivery.

## Required lifecycle work

A complete workstation installer must package and verify:

- The React/Vite production build and a managed local Express server.
- Loopback-only API binding and a secure browser-to-local-server boundary.
- FFmpeg availability plus codec licensing and redistribution decisions.
- Native host/scanner/worker, VST3 plugin paths, process supervision and shutdown.
- WASAPI device selection and recovery when devices disappear.
- User/project data preservation, upgrades, uninstall, code signing and release distribution.
- An installed-app smoke test: launch, import audio, play, render, export and close cleanly.

## Packaging direction

Electron is the first candidate for a packaging spike because the app already depends on Node/Express and the native host is a separate Windows executable. Tauri remains a smaller-shell alternative but still needs a defined Node server lifecycle and native-host integration. This is a provisional direction, not a completed EXE or installer.

Do not mark desktop packaging complete from the native VST3 CI artifact. A signed installer and an end-to-end Windows acceptance run are required.
