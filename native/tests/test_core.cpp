// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 LIL SYNN / SYN-MASTER. Part of the SYN-MASTER VST companion (native/).
#include "syn_host/AudioRouter.hpp"
#include "syn_host/PluginInstanceManager.hpp"
#include "syn_host/SecurityPolicy.hpp"
#include "syn_host/SpscRingBuffer.hpp"
#include "syn_host/WindowsPeInspector.hpp"

#include <cassert>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <vector>

using namespace syn::host;

namespace {

std::vector<uint8_t> makeSyntheticPeBytes(uint16_t machine, uint16_t optMagic) {
  std::vector<uint8_t> buf(256, 0);
  buf[0] = 'M';
  buf[1] = 'Z';
  uint32_t peOff = 0x80;
  buf[0x3C] = static_cast<uint8_t>(peOff & 0xFF);
  buf[0x3D] = static_cast<uint8_t>((peOff >> 8) & 0xFF);

  buf[peOff] = 'P';
  buf[peOff + 1] = 'E';
  buf[peOff + 2] = 0;
  buf[peOff + 3] = 0;

  buf[peOff + 4] = static_cast<uint8_t>(machine & 0xFF);
  buf[peOff + 5] = static_cast<uint8_t>((machine >> 8) & 0xFF);
  buf[peOff + 20] = 24;
  buf[peOff + 21] = 0;

  buf[peOff + 24] = static_cast<uint8_t>(optMagic & 0xFF);
  buf[peOff + 25] = static_cast<uint8_t>((optMagic >> 8) & 0xFF);
  return buf;
}

void testPeInspector() {
  auto pe64 = WindowsPeInspector::inspectBytes(makeSyntheticPeBytes(0x8664, 0x020b));
  assert(pe64.validPe && pe64.arch == BinaryArch::X64 && pe64.is64Bit);

  auto pe32 = WindowsPeInspector::inspectBytes(makeSyntheticPeBytes(0x014c, 0x010b));
  assert(pe32.validPe && pe32.arch == BinaryArch::X86 && !pe32.is64Bit);

  auto peArm = WindowsPeInspector::inspectBytes(makeSyntheticPeBytes(0xaa64, 0x020b));
  assert(peArm.validPe && peArm.arch == BinaryArch::ARM64 && peArm.is64Bit);

  auto bad = WindowsPeInspector::inspectBytes({0x7F, 'E', 'L', 'F', 0, 0});
  assert(!bad.validPe && bad.arch == BinaryArch::Unknown);

  auto tmpRoot = std::filesystem::temp_directory_path() / "syn_vst3_pe_test";
  std::filesystem::remove_all(tmpRoot);
  auto bundleDir = tmpRoot / "DemoComp.vst3";
  auto binDir = bundleDir / "Contents" / "x86_64-win";
  std::filesystem::create_directories(binDir);
  auto binFile = binDir / "DemoComp.vst3";
  {
    auto bytes = makeSyntheticPeBytes(0x8664, 0x020b);
    std::ofstream ofs(binFile, std::ios::binary);
    ofs.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
  }

  auto res = WindowsPeInspector::resolveAndInspectVst3Bundle(bundleDir, true);
  assert(res.exists && res.isBundleDirectory);
  assert(res.pe.validPe && res.pe.arch == BinaryArch::X64);
  assert(res.sizeBytes == 256);
  assert(res.sha256Hex.size() == 64);
  std::filesystem::remove_all(tmpRoot);

  const uint8_t abc[] = {'a', 'b', 'c'};
  assert(WindowsPeInspector::sha256Bytes(abc, 3) ==
         "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");

  std::cout << "[PASS] testPeInspector\n";
}

void testSecurityPolicy() {
  SecurityPolicy policy;

  assert(policy.isOriginAllowed("http://localhost:3000"));
  assert(policy.isOriginAllowed("http://127.0.0.1:5173"));
  assert(policy.isOriginAllowed("https://ais-dev-example-123.us-west1.run.app"));
  assert(policy.isOriginAllowed("https://syn-master.ai.studio"));
  assert(!policy.isOriginAllowed("http://syn-master.ai.studio"));
  assert(!policy.isOriginAllowed("https://syn-master.ai.studio.evil.com"));
  assert(!policy.isOriginAllowed("https://evilai.studio"));
  assert(!policy.isOriginAllowed(""));
  assert(!policy.isOriginAllowed("null"));
  assert(!policy.isOriginAllowed("file://"));
  assert(!policy.isOriginAllowed("https://evil-attacker.com"));
  assert(!policy.isOriginAllowed("http://localhost.attacker.com:3000"));
  assert(!policy.isOriginAllowed("http://localhost:3000/extra"));

  auto tok1 = SecurityPolicy::generateSecureToken(32);
  auto tok2 = SecurityPolicy::generateSecureToken(32);
  assert(tok1.size() == 64 && tok2.size() == 64 && tok1 != tok2);
  assert(SecurityPolicy::constantTimeEquals(tok1, tok1));
  assert(!SecurityPolicy::constantTimeEquals(tok1, tok2));
  assert(!SecurityPolicy::constantTimeEquals("abc", "abcd"));

  auto code = SecurityPolicy::generatePairingCode();
  assert(code.rfind("SYN-", 0) == 0 && code.size() == 13);
  const std::string pairingAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (size_t i = 4; i < code.size(); ++i) {
    if (i == 8) {
      assert(code[i] == '-');
    } else {
      assert(pairingAlphabet.find(code[i]) != std::string::npos);
    }
  }

  auto tmpVst = std::filesystem::temp_directory_path() / "syn_safe_vst_root";
  std::filesystem::create_directories(tmpVst);
  std::string norm, reason;
  assert(SecurityPolicy::isSafeCustomScanDirectory(tmpVst.string(), norm, reason));
  assert(!SecurityPolicy::isSafeCustomScanDirectory("/tmp/../etc", norm, reason));
  assert(!SecurityPolicy::isSafeCustomScanDirectory("/", norm, reason));
  assert(!SecurityPolicy::isSafeCustomScanDirectory("relative/path", norm, reason));

  policy.setAllowedRoots({tmpVst.string()});
  assert(policy.isPathWithinAllowedRoots((tmpVst / "Plugin.vst3").string()));
  assert(!policy.isPathWithinAllowedRoots("/etc/passwd"));
  assert(!policy.isPathWithinAllowedRoots((tmpVst / ".." / "secret.vst3").string()));
  std::filesystem::remove_all(tmpVst);

  // Milestone 2 strict allowlist check
  assert(SecurityPolicy::isAllowedRpcMethod("catalog.scan"));
  assert(SecurityPolicy::isAllowedRpcMethod("plugin.load"));
  assert(SecurityPolicy::isAllowedRpcMethod("plugin.setParameter"));
  assert(SecurityPolicy::isAllowedRpcMethod("audio.processOffline"));
  assert(!SecurityPolicy::isAllowedRpcMethod("system.exec"));
  assert(!SecurityPolicy::isAllowedRpcMethod("shell.run"));

  std::cout << "[PASS] testSecurityPolicy\n";
}

void testRingBufferAndBase64() {
  SpscRingBuffer ring(64);
  assert(ring.capacity() >= 64);
  std::vector<float> in(40);
  for (size_t i = 0; i < in.size(); ++i) in[i] = static_cast<float>(i) * 0.25f;

  assert(ring.push(in.data(), in.size()) == 40);
  std::vector<float> out(25, 0.0f);
  assert(ring.pop(out.data(), out.size()) == 25);
  for (size_t i = 0; i < 25; ++i) assert(std::abs(out[i] - in[i]) < 1e-6f);

  // Wrap-around push + pop
  std::vector<float> in2(30, -0.5f);
  assert(ring.push(in2.data(), in2.size()) == 30);
  std::vector<float> out2(45, 0.0f);
  assert(ring.pop(out2.data(), out2.size()) == 45);
  for (size_t i = 0; i < 15; ++i) assert(std::abs(out2[i] - in[25 + i]) < 1e-6f);
  for (size_t i = 15; i < 45; ++i) assert(std::abs(out2[i] - (-0.5f)) < 1e-6f);

  // Base64 float32 roundtrip
  std::vector<float> f32 = {0.0f, 1.0f, -1.0f, 0.123456f, -0.987654f};
  std::string b64 = AudioRouter::encodeFloat32Base64(f32);
  std::vector<float> decoded;
  assert(AudioRouter::decodeFloat32Base64(b64, decoded));
  assert(decoded.size() == f32.size());
  for (size_t i = 0; i < f32.size(); ++i) assert(std::abs(decoded[i] - f32[i]) < 1e-7f);

  std::cout << "[PASS] testRingBufferAndBase64\n";
}

void testIsolatedWorkerAndAudioRouter() {
  std::string workerPath;
#ifdef SYN_TEST_WORKER_PATH
  workerPath = SYN_TEST_WORKER_PATH;
#else
  if (const char* env = std::getenv("SYN_TEST_WORKER_PATH")) workerPath = env;
#endif
  if (workerPath.empty() || !std::filesystem::exists(workerPath)) {
    std::cout << "[SKIP] testIsolatedWorkerAndAudioRouter (worker binary not passed)\n";
    return;
  }

  PluginInstanceManager mgr(workerPath);
  PluginInstanceInfo info1, info2;
  std::string err;

  // 1. Load two isolated workers (second reports 64-sample latency to verify compensation!)
  assert(mgr.loadPlugin("builtin.qa.gain", "/tmp/qa1.vst3", 48000.0, 256, 2, info1, err));
  assert(info1.active && !info1.crashed && info1.parameters.size() == 2);
  assert(mgr.loadPlugin("builtin.qa.latency", "/tmp/qa2.vst3", 48000.0, 256, 2, info2, err));
  assert(info2.latencySamples == 64);

  // 2. Set +6.0 dB gain on info1 (norm 0.625 => (0.625-0.5)*48 = +6 dB => ~2.0x)
  std::string disp;
  assert(mgr.setParameter(info1.instanceId, 0, 0.625, disp, err));

  // Save and restore chunk state
  std::string stateB64;
  assert(mgr.getStateBase64(info1.instanceId, stateB64, err));
  assert(!stateB64.empty());
  assert(mgr.setParameter(info1.instanceId, 0, 0.5, disp, err));
  assert(mgr.setStateBase64(info1.instanceId, stateB64, err));
  std::vector<ParameterValue> syncedParams;
  assert(mgr.getParameters(info1.instanceId, syncedParams, err));
  assert(!syncedParams.empty() && std::abs(syncedParams[0].valueNormalized - 0.625) < 1e-4);

  // 3. Process 2048-sample calibrated 1kHz sine through sequential chain [info1 (+6dB) -> info2 (0dB, 64smpl latency)]
  const int n = 2048;
  std::vector<float> origL(n), origR(n);
  for (int i = 0; i < n; ++i) {
    float v = 0.25f * std::sin(2.0f * 3.14159265f * 1000.0f * static_cast<float>(i) / 48000.0f);
    origL[i] = v;
    origR[i] = -v;
  }
  auto procL = origL;
  auto procR = origR;
  auto stats = AudioRouter::processSequentialOffline(mgr, {info1.instanceId, info2.instanceId}, 48000, 256, procL, procR);
  assert(stats.ok);
  assert(stats.totalLatencySamples == 64);

  double rmsIn = 0.0, rmsOut = 0.0;
  for (int i = 256; i < n - 256; ++i) {
    rmsIn += origL[i] * origL[i];
    rmsOut += procL[i] * procL[i];
  }
  double gainDbMeasured = 10.0 * std::log10((rmsOut + 1e-12) / (rmsIn + 1e-12));
  assert(std::abs(gainDbMeasured - 6.0) < 0.35);

  // 4. Bypass must produce bit-identical pass-through
  assert(mgr.setBypass(info1.instanceId, true, err));
  auto bpL = origL, bpR = origR;
  auto bpStats = AudioRouter::processSequentialOffline(mgr, {info1.instanceId}, 48000, 256, bpL, bpR);
  assert(bpStats.ok);
  for (int i = 0; i < n; ++i) assert(bpL[i] == origL[i] && bpR[i] == origR[i]);

  // 5. Fault injection: worker crash & hang must NEVER crash host and MUST isolate failing plugin
  PluginInstanceInfo crashInfo;
  bool crashedLoadOk = mgr.loadPlugin("builtin.qa.gain", "/tmp/crash.vst3", 48000.0, 256, 2, crashInfo, err, true, false);
  assert(!crashedLoadOk);

  PluginInstanceInfo hangInfo;
  // Note: loadPlugin timeout is 8s, so test abort-on-load UID ("builtin.qa.crash") cleanly:
  bool abortLoadOk = mgr.loadPlugin("builtin.qa.crash", "/tmp/abort.vst3", 48000.0, 256, 2, hangInfo, err, false, false);
  assert(!abortLoadOk);

  // Healthy worker info1 MUST STILL WORK AFTER NEIGHBOR WORKER CRASHED!
  assert(mgr.setBypass(info1.instanceId, false, err));
  auto stillWorksL = origL, stillWorksR = origR;
  auto okAfterCrash = AudioRouter::processSequentialOffline(mgr, {info1.instanceId}, 48000, 256, stillWorksL, stillWorksR);
  assert(okAfterCrash.ok);

  assert(mgr.unloadPlugin(info1.instanceId, err));
  assert(mgr.unloadPlugin(info2.instanceId, err));
  std::cout << "[PASS] testIsolatedWorkerAndAudioRouter\n";
}

} // namespace

int main() {
  testPeInspector();
  testSecurityPolicy();
  testRingBufferAndBase64();
  testIsolatedWorkerAndAudioRouter();
  std::cout << "ALL NATIVE PORTABLE C++20 MILESTONE 2 TESTS PASSED\n";
  return 0;
}
