// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 LIL SYNN / SYN-MASTER. Part of the SYN-MASTER VST companion (native/).
#pragma once

#include "PluginTypes.hpp"
#include <cstdint>
#include <filesystem>
#include <string>
#include <vector>

namespace syn::host {

struct PeInspectionResult {
  bool validPe = false;
  BinaryArch arch = BinaryArch::Unknown;
  bool is64Bit = false;
  uint16_t machineType = 0;
  std::string diagnostic;
};

struct BundleFileResolution {
  bool exists = false;
  bool isBundleDirectory = false;
  std::string bundlePath;
  std::string binaryPath;
  PeInspectionResult pe;
  int64_t mtimeNs = 0;
  uint64_t sizeBytes = 0;
  std::string sha256Hex;
  std::string errorMessage;
};

class WindowsPeInspector {
public:
  // Inspect raw PE bytes in memory (DOS MZ header + PE\0\0 + COFF Machine + Optional Magic)
  static PeInspectionResult inspectBytes(const std::vector<uint8_t>& bytes);

  // Inspect a PE binary file on disk
  static PeInspectionResult inspectFile(const std::filesystem::path& filePath);

  // Resolve either a Windows VST3 bundle directory (*.vst3/Contents/x86_64-win/*.vst3)
  // or a legacy flat *.vst3 DLL file, inspect PE architecture, size, mtime, and optional SHA-256.
  static BundleFileResolution resolveAndInspectVst3Bundle(
      const std::filesystem::path& bundlePath,
      bool computeHash = true);

  // Pure C++20 SHA-256 implementation (FIPS 180-4) for incremental scan fingerprinting
  static std::string sha256Bytes(const uint8_t* data, size_t len);
  static std::string sha256File(const std::filesystem::path& filePath);
};

} // namespace syn::host
