// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 LIL SYNN / SYN-MASTER. Part of the SYN-MASTER VST companion (native/).
#pragma once

#include "PluginTypes.hpp"
#include "SpscRingBuffer.hpp"

#include <atomic>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace syn::host {

struct AuditionStatus {
  bool active = false;
  std::string deviceName;
  std::string driverType;
  double sampleRate = 48000.0;
  int bufferSize = 512;
  int64_t totalFrames = 0;
  int64_t playedFrames = 0;
  bool looping = true;
  uint64_t underruns = 0;
  std::string lastError;
};

/**
 * Windows 11 WASAPI (and optional ASIO) real-time audition playback manager.
 * Backed by juce::AudioDeviceManager + lock-free SpscRingBuffer when compiled
 * with JUCE audio_devices on Windows.
 */
class WasapiDeviceManager {
public:
  WasapiDeviceManager();
  ~WasapiDeviceManager();

  std::vector<AudioDeviceDescriptor> listOutputDevices() const;

  bool startAudition(
      std::vector<float> left,
      std::vector<float> right,
      double sampleRate,
      const std::string& preferredDeviceId,
      bool loop,
      std::string& errorOut);

  void stopAudition();
  AuditionStatus getStatus() const;

private:
  struct Impl;
  std::unique_ptr<Impl> m_impl;
  mutable std::mutex m_mutex;
};

} // namespace syn::host
