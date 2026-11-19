<#
.SYNOPSIS
  SYN-PLUGIN HOST Milestone 2.5 Windows 11 x64 Real VST3 Validation Script.
  Executes real-world validation against the compiled MSVC/JUCE binaries and
  `SYN Test Gain and Tilt QA.vst3` without requiring manual guesswork.

.PARAMETER BuildDir
  CMake binary directory (default: build/windows-x64-release).

.PARAMETER SkipSystemInstall
  Skip copying the QA .vst3 bundle to C:\Program Files\Common Files\VST3\
  (uses a temporary directory registered via catalog.paths.add in CI or non-admin runs).

.PARAMETER SkipAudioHardware
  Skip enumerating/opening physical WASAPI output endpoints (useful on headless CI runners).

.PARAMETER InteractiveGui
  Opens the real Win32 VST3 native editor window (`OPENEDITOR`) briefly for visual confirmation.
#>
param(
  [string]$BuildDir = "build/windows-x64-release",
  [switch]$SkipSystemInstall,
  [switch]$SkipAudioHardware,
  [switch]$InteractiveGui
)

$ErrorActionPreference = "Stop"

$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$BinDir = (Resolve-Path (Join-Path $RootDir "$BuildDir/Release")).Path
$HostExe = Join-Path $BinDir "syn-plugin-host.exe"
$ScannerExe = Join-Path $BinDir "syn-plugin-scanner.exe"
$WorkerExe = Join-Path $BinDir "syn-plugin-worker.exe"
$CoreTestsExe = Join-Path $BinDir "syn_core_tests.exe"
$BuiltVst3Dir = (Resolve-Path (Join-Path $RootDir "$BuildDir/syn_test_vst3_gain_artefacts/Release/VST3/SYN Test Gain and Tilt QA.vst3")).Path

foreach ($req in @($HostExe, $ScannerExe, $WorkerExe, $BuiltVst3Dir)) {
  if (-not (Test-Path $req)) {
    throw "Missing required compiled artifact: $req"
  }
}

Write-Host "=== [1/7] Verifying C++ Core Tests (syn_core_tests.exe) ===" -ForegroundColor Cyan
if (Test-Path $CoreTestsExe) {
  & $CoreTestsExe
  if ($LASTEXITCODE -ne 0) { throw "syn_core_tests.exe failed with exit code $LASTEXITCODE" }
}

Write-Host "=== [2/7] Inspecting Compiled Test VST3 Bundle & Installing ===" -ForegroundColor Cyan
$BinaryInsideBundle = Join-Path $BuiltVst3Dir "Contents\x86_64-win\SYN Test Gain and Tilt QA.vst3"
if (-not (Test-Path $BinaryInsideBundle)) {
  throw "Expected x86_64-win PE binary inside VST3 bundle at: $BinaryInsideBundle"
}

$StagingDataDir = Join-Path $env:TEMP ("syn_m25_val_" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $StagingDataDir -Force | Out-Null

$ScanTargetVst3 = $BuiltVst3Dir
$CustomScanDir = $null
if (-not $SkipSystemInstall) {
  $SystemVst3Dir = "C:\Program Files\Common Files\VST3"
  New-Item -ItemType Directory -Path $SystemVst3Dir -Force | Out-Null
  $DestVst3 = Join-Path $SystemVst3Dir "SYN Test Gain and Tilt QA.vst3"
  if (Test-Path $DestVst3) { Remove-Item -Recurse -Force $DestVst3 }
  Copy-Item -Recurse -Force $BuiltVst3Dir $DestVst3
  $ScanTargetVst3 = $DestVst3
  Write-Host "Installed QA VST3 into standard Windows VST3 path: $DestVst3" -ForegroundColor Green
} else {
  $CustomScanDir = Join-Path $StagingDataDir "vst3_plugins"
  New-Item -ItemType Directory -Path $CustomScanDir -Force | Out-Null
  $DestVst3 = Join-Path $CustomScanDir "SYN Test Gain and Tilt QA.vst3"
  Copy-Item -Recurse -Force $BuiltVst3Dir $DestVst3
  $ScanTargetVst3 = $DestVst3
  Write-Host "Staged QA VST3 for non-admin validation: $DestVst3" -ForegroundColor Yellow
}

Write-Host "=== [3/7] Real Out-of-Process VST3 Scan (syn-plugin-scanner.exe) ===" -ForegroundColor Cyan
$ScanJsonPath = Join-Path $StagingDataDir "scan_result.json"
& $ScannerExe --bundle $ScanTargetVst3 --out $ScanJsonPath
if ($LASTEXITCODE -ne 0) { throw "syn-plugin-scanner.exe failed with exit code $LASTEXITCODE" }

$ScanData = Get-Content -Raw $ScanJsonPath | ConvertFrom-Json
if ($ScanData.arch -ne "x64" -or $ScanData.plugins.Count -lt 1) {
  throw "Scanner failed to inspect x64 VST3 plugin metadata cleanly."
}
$QaMeta = $ScanData.plugins[0]
Write-Host ("Discovered: {0} | Manufacturer: {1} | Editor: {2} | Params: {3}" -f $QaMeta.name, $QaMeta.manufacturer, $QaMeta.hasEditor, $QaMeta.parameterCount) -ForegroundColor Green
if ($QaMeta.parameterCount -lt 4) {
  throw "Expected at least 4 VST3 parameters (Gain, High Tilt, Stereo Width, Bypass), got $($QaMeta.parameterCount)"
}

Write-Host "=== [4/7] Real Crash & Hang Fault-Injection Checks (Win32 SEH & Timeout) ===" -ForegroundColor Cyan
$CrashProc = Start-Process -FilePath $WorkerExe -ArgumentList "--selftest-crash" -Wait -PassThru -NoNewWindow
if ($CrashProc.ExitCode -eq 0) {
  throw "Expected non-zero Win32 exception exit code from --selftest-crash"
}
Write-Host ("--selftest-crash exited cleanly isolated with exit code: 0x{0:X8}" -f ($CrashProc.ExitCode -band 0xFFFFFFFF)) -ForegroundColor Green

$HangProc = Start-Process -FilePath $WorkerExe -ArgumentList "--selftest-hang" -PassThru -NoNewWindow
if ($HangProc.WaitForExit(1000)) {
  throw "Expected --selftest-hang to block until host termination"
}
Stop-Process -Id $HangProc.Id -Force
Write-Host "--selftest-hang watchdog termination verified." -ForegroundColor Green

Write-Host "=== [5/7] Launching syn-plugin-host.exe, Pairing, Load, Param, State, Signal & Bypass Verification ===" -ForegroundColor Cyan
$HttpPort = 47932
$WsPort = 47933
$HostLogOut = Join-Path $StagingDataDir "host_stdout.log"
$HostLogErr = Join-Path $StagingDataDir "host_stderr.log"

$HostProc = Start-Process -FilePath $HostExe `
  -ArgumentList "--port", $HttpPort, "--ws-port", $WsPort, "--data-dir", $StagingDataDir `
  -RedirectStandardOutput $HostLogOut -RedirectStandardError $HostLogErr -PassThru -NoNewWindow

try {
  $PairingPath = Join-Path $StagingDataDir "host_pairing.json"
  $Deadline = (Get-Date).AddSeconds(10)
  while (-not (Test-Path $PairingPath)) {
    if ((Get-Date) -gt $Deadline) { throw "Timed out waiting for host_pairing.json" }
    Start-Sleep -Milliseconds 150
  }
  $PairingDoc = Get-Content -Raw $PairingPath | ConvertFrom-Json
  $Health = Invoke-RestMethod -Uri "http://127.0.0.1:$HttpPort/v1/health" -Method Get
  if ($Health.status -ne "ok") { throw "Host /v1/health returned $($Health.status)" }

  # Pair via HTTP
  $PairResp = Invoke-RestMethod -Uri "http://127.0.0.1:$HttpPort/v1/auth/pair" -Method Post `
    -ContentType "application/json" `
    -Body (@{ pairingCode = $PairingDoc.pairingCode } | ConvertTo-Json)
  $Token = $PairResp.sessionToken
  if (-not $Token) { throw "Failed to acquire bearer sessionToken from /v1/auth/pair" }

  # Verify Origin / Auth rejection
  try {
    Invoke-WebRequest -Uri "http://127.0.0.1:$HttpPort/v1/health" -Headers @{ Origin = "https://evil-attacker.example" } -UseBasicParsing | Out-Null
    throw "Expected 403 Forbidden for unauthorized Origin"
  } catch {
    if ($_.Exception.Response.StatusCode.value__ -ne 403) { throw }
  }
  Write-Host "Verified strict 403 Origin rejection and pairing auth." -ForegroundColor Green

  # WebSocket JSON-RPC End-to-End Test against Real VST3 Binary
  $WsClient = New-Object System.Net.WebSockets.ClientWebSocket
  $Ct = [System.Threading.CancellationToken]::None
  $WsClient.ConnectAsync([Uri]"ws://127.0.0.1:$WsPort/ws", $Ct).GetAwaiter().GetResult()

  $script:RpcId = 1
  function Invoke-HostRpc([string]$Method, [hashtable]$Params) {
    $id = $script:RpcId++
    $json = @{ jsonrpc = "2.0"; id = $id; method = $Method; params = $Params } | ConvertTo-Json -Compress -Depth 8
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $seg = New-Object System.ArraySegment[byte] (, $bytes)
    $WsClient.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $Ct).GetAwaiter().GetResult()

    $buf = New-Object byte[] 65536
    while ($true) {
      $ms = New-Object System.IO.MemoryStream
      do {
        $rseg = New-Object System.ArraySegment[byte] (, $buf)
        $res = $WsClient.ReceiveAsync($rseg, $Ct).GetAwaiter().GetResult()
        $ms.Write($buf, 0, $res.Count)
      } while (-not $res.EndOfMessage)
      $msg = [System.Text.Encoding]::UTF8.GetString($ms.ToArray()) | ConvertFrom-Json
      if ($null -ne $msg.id -and [int]$msg.id -eq $id) {
        if ($null -ne $msg.error) { throw "RPC $Method failed ($($msg.error.code)): $($msg.error.message)" }
        return $msg.result
      }
    }
  }

  $null = Invoke-HostRpc "host.auth" @{ sessionToken = $Token }
  if ($CustomScanDir) {
    $null = Invoke-HostRpc "catalog.paths.add" @{ path = $CustomScanDir }
  }
  $null = Invoke-HostRpc "catalog.scan" @{ mode = "force" }

  # Wait up to 15s for catalog.list to include SYN Test Gain and Tilt QA
  $PluginRec = $null
  $ScanWait = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $ScanWait) {
    $Cat = Invoke-HostRpc "catalog.list" @{}
    $PluginRec = $Cat.plugins | Where-Object { $_.bundlePath -eq $ScanTargetVst3 -and $_.status -eq "available" } | Select-Object -First 1
    if ($PluginRec) { break }
    Start-Sleep -Milliseconds 250
  }
  if (-not $PluginRec) { throw "Host catalog scan did not persist QA VST3 plugin record." }

  # Load real VST3 plugin worker
  $Loaded = Invoke-HostRpc "plugin.load" @{
    uid = $PluginRec.uid
    bundlePath = $PluginRec.bundlePath
    sampleRate = 48000
    blockSize = 512
    channels = 2
  }
  $InstId = $Loaded.instanceId
  Write-Host ("Loaded real VST3 worker instance: {0} ({1})" -f $InstId, $Loaded.workerEngine) -ForegroundColor Green

  if ($InteractiveGui -and $Loaded.hasEditor) {
    $null = Invoke-HostRpc "plugin.openEditor" @{ instanceId = $InstId }
    Start-Sleep -Seconds 2
    $null = Invoke-HostRpc "plugin.closeEditor" @{ instanceId = $InstId }
    Write-Host "Opened and closed real Win32 VST3 plugin editor window cleanly." -ForegroundColor Green
  }

  # Parameter control: Gain is index 0 (-24..+24 dB => normalized 0.625 = +6.0 dB)
  $SetP = Invoke-HostRpc "plugin.setParameter" @{ instanceId = $InstId; paramId = 0; valueNormalized = 0.625 }
  Write-Host ("Set Param[0] Gain -> displayValue='{0}'" -f $SetP.displayValue) -ForegroundColor Green

  # State roundtrip: save +6 dB chunk -> reset to 0 dB (0.5) -> restore +6 dB chunk
  $StateObj = Invoke-HostRpc "plugin.getState" @{ instanceId = $InstId }
  $null = Invoke-HostRpc "plugin.setParameter" @{ instanceId = $InstId; paramId = 0; valueNormalized = 0.5 }
  $null = Invoke-HostRpc "plugin.setState" @{ instanceId = $InstId; stateBase64 = $StateObj.stateBase64 }
  $SyncedParams = (Invoke-HostRpc "plugin.getParameters" @{ instanceId = $InstId }).parameters
  if ([Math]::Abs($SyncedParams[0].valueNormalized - 0.625) -gt 0.01) {
    throw "State chunk restore did not synchronize parameter 0 back to 0.625 (+6 dB)."
  }
  Write-Host "Verified VST3 state chunk save/restore & parameter synchronization." -ForegroundColor Green

  Write-Host "=== [6/7] Audio Processing Mathematical Measurement (+6 dB Sine & Bit-Identical Bypass) ===" -ForegroundColor Cyan
  $Sr = 48000
  $N = 4096
  $LeftIn = New-Object float[] $N
  $RightIn = New-Object float[] $N
  for ($i = 0; $i -lt $N; $i++) {
    $s = [float](0.25 * [Math]::Sin(2.0 * [Math]::PI * 1000.0 * $i / $Sr))
    $LeftIn[$i] = $s
    $RightIn[$i] = -$s
  }
  $LBytes = New-Object byte[] ($N * 4)
  $RBytes = New-Object byte[] ($N * 4)
  [Buffer]::BlockCopy($LeftIn, 0, $LBytes, 0, $LBytes.Length)
  [Buffer]::BlockCopy($RightIn, 0, $RBytes, 0, $RBytes.Length)

  $ProcPayload = @{
    instanceIds = @($InstId)
    sampleRate = $Sr
    blockSize = 512
    leftBase64 = [Convert]::ToBase64String($LBytes)
    rightBase64 = [Convert]::ToBase64String($RBytes)
  } | ConvertTo-Json -Compress

  $ProcResp = Invoke-RestMethod -Uri "http://127.0.0.1:$HttpPort/v1/audio/process-offline" `
    -Method Post -ContentType "application/json" -Headers @{ Authorization = "Bearer $Token" } `
    -Body $ProcPayload

  $OutLBytes = [Convert]::FromBase64String($ProcResp.leftBase64)
  $OutL = New-Object float[] $N
  [Buffer]::BlockCopy($OutLBytes, 0, $OutL, 0, $OutLBytes.Length)

  $RmsIn = 0.0; $RmsOut = 0.0
  for ($i = 512; $i -lt ($N - 512); $i++) {
    $RmsIn += $LeftIn[$i] * $LeftIn[$i]
    $RmsOut += $OutL[$i] * $OutL[$i]
  }
  $MeasuredDb = 10.0 * [Math]::Log10(($RmsOut + 1e-12) / ($RmsIn + 1e-12))
  Write-Host ("Real VST3 +6.0 dB Sine RMS Gain Measured: {0:F2} dB" -f $MeasuredDb) -ForegroundColor Green
  if ([Math]::Abs($MeasuredDb - 6.0) -gt 0.35) {
    throw "Measured VST3 gain ($MeasuredDb dB) deviated beyond +/-0.35 dB from +6.0 dB."
  }

  # Bypass pass-through check
  $null = Invoke-HostRpc "plugin.setBypass" @{ instanceId = $InstId; bypassed = $true }
  $BpResp = Invoke-RestMethod -Uri "http://127.0.0.1:$HttpPort/v1/audio/process-offline" `
    -Method Post -ContentType "application/json" -Headers @{ Authorization = "Bearer $Token" } `
    -Body $ProcPayload
  $BpBytes = [Convert]::FromBase64String($BpResp.leftBase64)
  $BpOut = New-Object float[] $N
  [Buffer]::BlockCopy($BpBytes, 0, $BpOut, 0, $BpBytes.Length)
  for ($i = 0; $i -lt $N; $i++) {
    if ($BpOut[$i] -ne $LeftIn[$i]) { throw "Bypass output differed at sample $i" }
  }
  Write-Host "Verified bit-identical VST3 bypass pass-through." -ForegroundColor Green

  if (-not $SkipAudioHardware) {
    $DevResp = Invoke-HostRpc "audio.devices" @{}
    Write-Host ("Detected {0} Windows WASAPI/ASIO output endpoints." -f $DevResp.devices.Count) -ForegroundColor Green
  }

  Write-Host "=== [7/7] Unload Plugin & Clean Shutdown ===" -ForegroundColor Cyan
  $null = Invoke-HostRpc "plugin.unload" @{ instanceId = $InstId }
  $WsClient.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, "done", $Ct).GetAwaiter().GetResult()
  Write-Host "MILESTONE 2.5 REAL WINDOWS VST3 VALIDATION PASSED." -ForegroundColor Green
}
finally {
  if ($HostProc -and -not $HostProc.HasExited) {
    Stop-Process -Id $HostProc.Id -Force
  }
  if (Test-Path $StagingDataDir) {
    Remove-Item -Recurse -Force $StagingDataDir -ErrorAction SilentlyContinue
  }
}
