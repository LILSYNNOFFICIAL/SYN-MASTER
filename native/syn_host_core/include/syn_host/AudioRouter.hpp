#pragma once

#include "PluginInstanceManager.hpp"

#include <cstdint>
#include <string>
#include <vector>

namespace syn::host {

struct OfflineProcessStats {
  bool ok = false;
  int totalFrames = 0;
  int sampleRate = 48000;
  int channels = 2;
  int totalLatencySamples = 0;
  double durationMs = 0.0;
  std::string failedInstanceId;
  std::string error;
};

/**
 * Routes multi-channel float32 audio sequentially across an ordered list of
 * active PluginInstanceManager slots, applying bypass pass-through, NaN/Inf clamping,
 * chunked block streaming, and plugin latency compensation tracking.
 */
class AudioRouter {
public:
  static std::string encodeBase64(const uint8_t* data, size_t size);
  static bool decodeBase64(const std::string& b64, std::vector<uint8_t>& outBytes);

  static std::string encodeFloat32Base64(const std::vector<float>& samples);
  static bool decodeFloat32Base64(const std::string& b64, std::vector<float>& outSamples);

  static OfflineProcessStats processSequentialOffline(
      PluginInstanceManager& manager,
      const std::vector<std::string>& instanceIds,
      int sampleRate,
      int blockSize,
      std::vector<float>& left,
      std::vector<float>& right,
      uint32_t blockTimeoutMs = 5000);
};

} // namespace syn::host
