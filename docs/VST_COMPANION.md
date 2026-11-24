# SYN-MASTER VST Companion (Windows)

Bridge so any VST3 installed on a Windows PC can be used from the SYN-MASTER web app
(https://syn-master.ai.studio/). Plugin picking, chain and controls live in the web app;
the companion is a small status/pairing window. Loopback only: HTTP 127.0.0.1:47832, WS 127.0.0.1:47833.

## Status (2026-11-24, work stopped at deadline)

Done:
- `native/syn_companion_ui/assets/syn-master.ico` — multi-size app icon (256/128/64/48/40 from the full logo; 32/24/16 cropped to the headphone "S" so it stays legible).
- `native/syn_companion_ui/assets/syn_master_logo.png` — 320 px header logo for JUCE BinaryData.
- `LocalIpcServer` status hooks for the window (additive, not yet compiled in CI):
  `startScan(mode)` (catalog.scan RPC now routes through it), `isScanInProgress()`,
  `scanCompleted()/scanTotal()`, `hasPairedOnce()`, `authenticatedClientCount()`.

Left to do:
1. `native/syn_companion_ui/`: `SynLookAndFeel` (near-black/deep-purple bg, blue→magenta glow,
   chrome SYN-MASTER wordmark) + `CompanionWindow` (paired/not paired, pairing code SYN-XXXX-XXXX,
   scan folders + Rescan, plugin count, ports). Assets via `juce_add_binary_data`.
2. CMake: link `juce_gui_basics` + BinaryData into `syn-plugin-host`, add a `.rc` with
   `IDI_ICON1 ICON "syn_companion_ui/assets/syn-master.ico"`, `WIN32_EXECUTABLE` with
   `/ENTRY:mainCRTStartup`, and a `--headless` flag so `scripts/validate_windows_vst3.ps1` keeps working.
3. `.github/workflows/windows-companion-release.yml`: build on windows-latest, zip host+scanner+worker,
   attach to a GitHub Release on tag `v*`; then tag v0.1.0 once CI is green.
4. Install docs: unzip, run `syn-plugin-host.exe`; SmartScreen will warn on the unsigned exe
   ("More info" → "Run anyway"); pair by entering the code from the window in the web app.

## Licensing
JUCE is used under AGPLv3 (or a commercial JUCE licence if distributed closed-source).
