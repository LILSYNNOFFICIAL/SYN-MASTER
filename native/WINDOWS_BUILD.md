# SYN-PLUGIN HOST — Windows 11 x64 Build & Run Guide (Milestone 2)

## 1. Prerequisites (Windows 11 x64)
1. **Visual Studio 2022** (Community / Pro / Enterprise) with **Desktop development with C++** workload (MSVC v143 x64 toolset + Windows 11 SDK).
2. **CMake 3.25+** (`winget install Kitware.CMake`) and **Git** (`winget install Git.Git`).
3. *(Optional)* **Ninja** (`winget install Ninja-build.Ninja`) if using the `windows-x64-ninja` preset.
4. Network access on initial configure so `FetchContent` pulls pinned dependencies (`JUCE 8.0.17-security`, `nlohmann/json v3.11.3`, `IXWebSocket v11.4.5`, `SQLite 3.47.2`).

> **Environment Honesty Note**: Linux containers cannot cross-compile Windows MSVC/Win32/WASAPI/VST3 binaries. On Linux/POSIX CI, `g++ -std=c++20` compiles and verifies all portable core units (`WindowsPeInspector`, `SecurityPolicy`, `SpscRingBuffer`, `AudioRouter`, `PluginInstanceManager` + portable `syn-plugin-worker` IPC crash/timeout tests). Genuine Windows `.exe` and `.vst3` compilation must run on Windows 11 x64 (`windows-x64-release` preset or `.github/workflows/windows-x64-build.yml`).

---

## 2. Configure, Build & Test (Windows 11 PowerShell)

```powershell
cd native
cmake --preset windows-x64-release
cmake --build --preset windows-x64-release
ctest --test-dir build/windows-x64-release -C Release --output-on-failure
```

### Milestone 2 Build Outputs
1. `build/windows-x64-release/Release/syn-plugin-host.exe` — Loopback HTTP/WebSocket host daemon (`127.0.0.1:47832` / `:47833`).
2. `build/windows-x64-release/Release/syn-plugin-scanner.exe` — Crash-isolated VST3 bundle inspector (staged alongside `syn-plugin-host.exe`).
3. `build/windows-x64-release/Release/syn-plugin-worker.exe` — Crash-isolated VST3 audio hosting & native GUI editor subprocess (staged alongside `syn-plugin-host.exe`).
4. `build/windows-x64-release/Release/syn_core_tests.exe` — Portable core & worker isolation C++20 test suite.
5. `build/windows-x64-release/syn_test_vst3_gain_artefacts/Release/VST3/SYN Test Gain and Tilt QA.vst3` — Minimal JUCE-built **QA Test VST3 plugin** (`syn_test_vst3_gain`). Copy into `C:\Program Files\Common Files\VST3\` (or run `scripts/validate_windows_vst3.ps1`) to verify genuine VST3 discovery, audio processing, parameter control, state chunks, and native HWND editor rendering immediately without third-party plugins.

---

## 3. Milestone 2.5 Automated Windows Validation

Run the PowerShell validation harness (use an elevated shell to install into `C:\Program Files\Common Files\VST3\`, or pass `-SkipSystemInstall` for user-scoped validation, and `-InteractiveGui` to open the Win32 VST3 editor window):

```powershell
cd native
.\scripts\validate_windows_vst3.ps1 -InteractiveGui
```

### Manual Workstation Checklist
1. Start `.\build\windows-x64-release\Release\syn-plugin-host.exe`.
2. Pair SYN MASTER via the **Pairing Code** (`SYN-XXXX-XXXX`).
3. Scan plugins on the **Plugins** tab -> insert **SYN Test Gain and Tilt QA** (or any commercial 64-bit VST3) directly into the **Mastering Chain** rack alongside native SYN MASTER processors.
4. Adjust VST3 parameters, open/close the native plugin GUI window (`Open Native Plugin GUI`), compare **Original A / Mastered B**, verify **SYN-QC**, and export 24-bit WAV — re-import the exported WAV back into SYN MASTER to verify LUFS/TP/phase preservation.
5. Fault-injection verification on Windows:
   - `.\build\windows-x64-release\Release\syn-plugin-worker.exe --selftest-crash` -> `0xC0000005` caught cleanly by `PluginInstanceManager`.
   - `.\build\windows-x64-release\Release\syn-plugin-worker.exe --selftest-hang` -> terminated cleanly after worker deadline without blocking `syn-plugin-host.exe`.

## 4. GitHub Actions Windows x64 Build

The repository includes a native Windows CI workflow at `.github/workflows/windows-x64-build.yml`.

- Open **GitHub → Actions → Windows x64 Native Plugin Host Build → Run workflow** to start it manually.
- The workflow also runs automatically when files under `native/**` or the workflow definition change on a push.
- It uses a Windows 2022 runner with the Visual Studio 2022 x64 generator, builds the host, scanner, worker, QA VST3 plugin and core tests, then runs CTest and the compiled VST3 validation harness.
- A successful run uploads the `syn-plugin-host-win64-m2` artifact containing the native executables and QA VST3 bundle. Download and inspect that artifact before treating the native build as deliverable.

The automated validation uses `-SkipSystemInstall -SkipAudioHardware`; it verifies compiled plugin discovery, hosting, DSP and fault isolation without installing into the system VST3 directory or requiring a physical audio device. Interactive GUI and actual workstation playback still require a Windows machine.
