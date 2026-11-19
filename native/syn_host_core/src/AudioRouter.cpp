#include "syn_host/AudioRouter.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstring>

namespace syn::host {

namespace {

constexpr char kB64Alphabet[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

} // namespace

std::string AudioRouter::encodeBase64(const uint8_t* data, size_t size) {
  if (!data || size == 0) return {};
  std::string out;
  out.reserve(((size + 2) / 3) * 4);
  for (size_t i = 0; i < size; i += 3) {
    uint32_t octetA = i < size ? data[i] : 0;
    uint32_t octetB = (i + 1) < size ? data[i + 1] : 0;
    uint32_t octetC = (i + 2) < size ? data[i + 2] : 0;
    uint32_t triple = (octetA << 16) | (octetB << 8) | octetC;

    out.push_back(kB64Alphabet[(triple >> 18) & 0x3F]);
    out.push_back(kB64Alphabet[(triple >> 12) & 0x3F]);
    out.push_back((i + 1) < size ? kB64Alphabet[(triple >> 6) & 0x3F] : '=');
    out.push_back((i + 2) < size ? kB64Alphabet[triple & 0x3F] : '=');
  }
  return out;
}

bool AudioRouter::decodeBase64(const std::string& b64, std::vector<uint8_t>& outBytes) {
  outBytes.clear();
  if (b64.empty()) return true;

  std::array<int, 256> rev{};
  rev.fill(-1);
  for (int i = 0; i < 64; ++i) {
    rev[static_cast<uint8_t>(kB64Alphabet[i])] = i;
  }

  std::string clean;
  clean.reserve(b64.size());
  for (char c : b64) {
    if (c == '\r' || c == '\n' || c == ' ' || c == '\t') continue;
    clean.push_back(c);
  }
  if (clean.size() % 4 != 0) return false;

  outBytes.reserve((clean.size() / 4) * 3);
  for (size_t i = 0; i < clean.size(); i += 4) {
    int a = rev[static_cast<uint8_t>(clean[i])];
    int b = rev[static_cast<uint8_t>(clean[i + 1])];
    int c = clean[i + 2] == '=' ? 0 : rev[static_cast<uint8_t>(clean[i + 2])];
    int d = clean[i + 3] == '=' ? 0 : rev[static_cast<uint8_t>(clean[i + 3])];
    if (a < 0 || b < 0 || c < 0 || d < 0) return false;

    uint32_t triple = (static_cast<uint32_t>(a) << 18) |
                      (static_cast<uint32_t>(b) << 12) |
                      (static_cast<uint32_t>(c) << 6) |
                      static_cast<uint32_t>(d);

    outBytes.push_back(static_cast<uint8_t>((triple >> 16) & 0xFF));
    if (clean[i + 2] != '=') outBytes.push_back(static_cast<uint8_t>((triple >> 8) & 0xFF));
    if (clean[i + 3] != '=') outBytes.push_back(static_cast<uint8_t>(triple & 0xFF));
  }
  return true;
}

std::string AudioRouter::encodeFloat32Base64(const std::vector<float>& samples) {
  if (samples.empty()) return {};
  return encodeBase64(
      reinterpret_cast<const uint8_t*>(samples.data()),
      samples.size() * sizeof(float));
}

bool AudioRouter::decodeFloat32Base64(const std::string& b64, std::vector<float>& outSamples) {
  outSamples.clear();
  std::vector<uint8_t> raw;
  if (!decodeBase64(b64, raw)) return false;
  if (raw.size() % sizeof(float) != 0) return false;
  size_t count = raw.size() / sizeof(float);
  outSamples.resize(count);
  if (count > 0) {
    std::memcpy(outSamples.data(), raw.data(), raw.size());
  }
  return true;
}

OfflineProcessStats AudioRouter::processSequentialOffline(
    PluginInstanceManager& manager,
    const std::vector<std::string>& instanceIds,
    int sampleRate,
    int blockSize,
    std::vector<float>& left,
    std::vector<float>& right,
    uint32_t blockTimeoutMs) {
  OfflineProcessStats stats;
  stats.sampleRate = sampleRate;
  stats.channels = 2;

  const auto startClock = std::chrono::steady_clock::now();
  const size_t n = std::min(left.size(), right.size());
  left.resize(n);
  right.resize(n);
  stats.totalFrames = static_cast<int>(n);

  if (n == 0 || instanceIds.empty()) {
    stats.ok = true;
    return stats;
  }

  const int safeBlockSize = std::clamp(blockSize, 64, 8192);
  std::vector<float> blkL;
  std::vector<float> blkR;

  for (const auto& instId : instanceIds) {
    auto infoOpt = manager.getInstance(instId);
    if (!infoOpt.has_value()) {
      stats.ok = false;
      stats.failedInstanceId = instId;
      stats.error = "Plugin instance not loaded: " + instId;
      return stats;
    }
    if (infoOpt->crashed) {
      stats.ok = false;
      stats.failedInstanceId = instId;
      stats.error = "Plugin instance previously crashed: " + infoOpt->lastError;
      return stats;
    }
    if (infoOpt->bypassed) {
      continue;
    }

    int instLatency = std::max(0, infoOpt->latencySamples);
    stats.totalLatencySamples += instLatency;

    // Feed audio plus latency tail so delayed output is aligned cleanly back onto 0..n-1
    const size_t totalWithTail = n + static_cast<size_t>(instLatency);
    std::vector<float> delayedL;
    std::vector<float> delayedR;
    if (instLatency > 0) {
      delayedL.reserve(totalWithTail);
      delayedR.reserve(totalWithTail);
    }

    for (size_t offset = 0; offset < totalWithTail; offset += static_cast<size_t>(safeBlockSize)) {
      const size_t len = std::min(static_cast<size_t>(safeBlockSize), totalWithTail - offset);
      blkL.assign(len, 0.0f);
      blkR.assign(len, 0.0f);
      for (size_t k = 0; k < len; ++k) {
        size_t idx = offset + k;
        if (idx < n) {
          float lVal = std::isfinite(left[idx]) ? left[idx] : 0.0f;
          float rVal = std::isfinite(right[idx]) ? right[idx] : 0.0f;
          blkL[k] = lVal;
          blkR[k] = rVal;
        }
      }

      auto res = manager.processBlock(instId, blkL, blkR, blockTimeoutMs);
      if (!res.ok) {
        stats.ok = false;
        stats.failedInstanceId = instId;
        stats.error = res.error;
        return stats;
      }

      if (instLatency > 0) {
        for (size_t k = 0; k < len; ++k) {
          delayedL.push_back(std::isfinite(blkL[k]) ? std::clamp(blkL[k], -16.0f, 16.0f) : 0.0f);
          delayedR.push_back(std::isfinite(blkR[k]) ? std::clamp(blkR[k], -16.0f, 16.0f) : 0.0f);
        }
      } else {
        for (size_t k = 0; k < len; ++k) {
          left[offset + k] = std::isfinite(blkL[k]) ? std::clamp(blkL[k], -16.0f, 16.0f) : 0.0f;
          right[offset + k] = std::isfinite(blkR[k]) ? std::clamp(blkR[k], -16.0f, 16.0f) : 0.0f;
        }
      }
    }

    if (instLatency > 0) {
      const size_t lat = static_cast<size_t>(instLatency);
      for (size_t i = 0; i < n; ++i) {
        left[i] = (i + lat) < delayedL.size() ? delayedL[i + lat] : 0.0f;
        right[i] = (i + lat) < delayedR.size() ? delayedR[i + lat] : 0.0f;
      }
    }
  }

  const auto endClock = std::chrono::steady_clock::now();
  stats.durationMs = std::chrono::duration<double, std::milli>(endClock - startClock).count();
  stats.ok = true;
  return stats;
}

} // namespace syn::host
