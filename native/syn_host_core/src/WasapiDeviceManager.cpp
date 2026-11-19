#include "syn_host/WasapiDeviceManager.hpp"

#include <algorithm>
#include <atomic>
#include <cstring>
#include <thread>

#ifdef SYN_HAS_JUCE_AUDIO_DEVICES
#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_core/juce_core.h>
#endif

namespace syn::host {

struct WasapiDeviceManager::Impl {
  std::vector<float> left;
  std::vector<float> right;
  std::atomic<size_t> cursor{0};
  std::atomic<bool> active{false};
  std::atomic<bool> loop{true};
  double sampleRate = 48000.0;
  int bufferSize = 512;
  std::string deviceName;
  std::string driverType = "WASAPI";
  std::string lastError;
  SpscRingBuffer ring{131072};

#ifdef SYN_HAS_JUCE_AUDIO_DEVICES
  class AuditionCallback : public juce::AudioIODeviceCallback {
  public:
    explicit AuditionCallback(Impl& owner) : m_owner(owner) {}

    void audioDeviceIOCallbackWithContext(
        const float* const* /*inputChannelData*/,
        int /*numInputChannels*/,
        float* const* outputChannelData,
        int numOutputChannels,
        int numSamples,
        const juce::AudioIODeviceCallbackContext&) override {
      if (!m_owner.active.load(std::memory_order_acquire) || m_owner.left.empty()) {
        for (int c = 0; c < numOutputChannels; ++c) {
          if (outputChannelData[c]) std::memset(outputChannelData[c], 0, sizeof(float) * static_cast<size_t>(numSamples));
        }
        return;
      }

      const size_t total = m_owner.left.size();
      size_t pos = m_owner.cursor.load(std::memory_order_relaxed);
      bool stoppedNow = false;
      for (int i = 0; i < numSamples; ++i) {
        if (stoppedNow) {
          if (numOutputChannels >= 1 && outputChannelData[0]) outputChannelData[0][i] = 0.0f;
          if (numOutputChannels >= 2 && outputChannelData[1]) outputChannelData[1][i] = 0.0f;
          continue;
        }
        if (pos >= total) {
          if (m_owner.loop.load(std::memory_order_relaxed)) {
            pos = 0;
          } else {
            if (numOutputChannels >= 1 && outputChannelData[0]) outputChannelData[0][i] = 0.0f;
            if (numOutputChannels >= 2 && outputChannelData[1]) outputChannelData[1][i] = 0.0f;
            m_owner.active.store(false, std::memory_order_release);
            stoppedNow = true;
            continue;
          }
        }
        float l = std::isfinite(m_owner.left[pos]) ? std::clamp(m_owner.left[pos], -1.0f, 1.0f) : 0.0f;
        float r = std::isfinite(m_owner.right[pos]) ? std::clamp(m_owner.right[pos], -1.0f, 1.0f) : 0.0f;
        if (numOutputChannels >= 1 && outputChannelData[0]) outputChannelData[0][i] = l;
        if (numOutputChannels >= 2 && outputChannelData[1]) outputChannelData[1][i] = r;
        ++pos;
      }
      m_owner.cursor.store(pos, std::memory_order_relaxed);
    }

    void audioDeviceAboutToStart(juce::AudioIODevice* device) override {
      if (device) {
        m_owner.sampleRate = device->getCurrentSampleRate();
        m_owner.bufferSize = device->getCurrentBufferSizeSamples();
      }
    }

    void audioDeviceStopped() override {}

  private:
    Impl& m_owner;
  };

  std::unique_ptr<juce::AudioDeviceManager> deviceManager;
  std::unique_ptr<AuditionCallback> callback;
#endif
};

WasapiDeviceManager::WasapiDeviceManager() : m_impl(std::make_unique<Impl>()) {}

WasapiDeviceManager::~WasapiDeviceManager() {
  stopAudition();
}

std::vector<AudioDeviceDescriptor> WasapiDeviceManager::listOutputDevices() const {
  std::vector<AudioDeviceDescriptor> out;
#ifdef SYN_HAS_JUCE_AUDIO_DEVICES
  juce::AudioDeviceManager dm;
  const auto& types = dm.getAvailableDeviceTypes();
  for (auto* t : types) {
    if (!t) continue;
    t->scanForDevices();
    auto names = t->getDeviceNames(false);
    int defIdx = t->getDefaultDeviceIndex(false);
    for (int i = 0; i < names.size(); ++i) {
      AudioDeviceDescriptor desc;
      desc.driverType = t->getTypeName().toStdString();
      desc.name = names[i].toStdString();
      desc.id = desc.driverType + "::" + desc.name;
      desc.maxOutputChannels = 2;
      desc.supportedSampleRates = {44100.0, 48000.0, 88200.0, 96000.0};
      desc.defaultBufferSize = 512;
      desc.isDefault = (i == defIdx);
      out.push_back(std::move(desc));
    }
  }
#endif
  return out;
}

bool WasapiDeviceManager::startAudition(
    std::vector<float> left,
    std::vector<float> right,
    double sampleRate,
    const std::string& preferredDeviceId,
    bool loop,
    std::string& errorOut) {
  stopAudition();
  std::lock_guard<std::mutex> lock(m_mutex);

  if (left.empty() || left.size() != right.size()) {
    errorOut = "Invalid stereo audition buffers";
    m_impl->lastError = errorOut;
    return false;
  }

  m_impl->left = std::move(left);
  m_impl->right = std::move(right);
  m_impl->cursor.store(0, std::memory_order_relaxed);
  m_impl->sampleRate = sampleRate;
  m_impl->loop.store(loop, std::memory_order_relaxed);

#ifdef SYN_HAS_JUCE_AUDIO_DEVICES
  m_impl->deviceManager = std::make_unique<juce::AudioDeviceManager>();
  juce::String initErr = m_impl->deviceManager->initialiseWithDefaultDevices(0, 2);
  if (initErr.isNotEmpty()) {
    errorOut = "WASAPI/Audio device init failed: " + initErr.toStdString();
    m_impl->lastError = errorOut;
    return false;
  }

  if (!preferredDeviceId.empty()) {
    auto sep = preferredDeviceId.find("::");
    if (sep != std::string::npos) {
      std::string drv = preferredDeviceId.substr(0, sep);
      std::string dev = preferredDeviceId.substr(sep + 2);
      m_impl->deviceManager->setCurrentAudioDeviceType(juce::String(drv), true);
      auto setup = m_impl->deviceManager->getAudioDeviceSetup();
      setup.outputDeviceName = juce::String(dev);
      setup.sampleRate = sampleRate;
      setup.bufferSize = 512;
      m_impl->deviceManager->setAudioDeviceSetup(setup, true);
    }
  }

  if (auto* dev = m_impl->deviceManager->getCurrentAudioDevice()) {
    m_impl->deviceName = dev->getName().toStdString();
    m_impl->driverType = dev->getTypeName().toStdString();
  }

  m_impl->callback = std::make_unique<Impl::AuditionCallback>(*m_impl);
  m_impl->active.store(true, std::memory_order_release);
  m_impl->deviceManager->addAudioCallback(m_impl->callback.get());
  m_impl->lastError.clear();
  return true;
#else
  (void)preferredDeviceId;
  errorOut = "WASAPI hardware audio playback requires Windows + JUCE audio_devices build (unavailable on this platform)";
  m_impl->lastError = errorOut;
  return false;
#endif
}

void WasapiDeviceManager::stopAudition() {
  std::lock_guard<std::mutex> lock(m_mutex);
  m_impl->active.store(false, std::memory_order_release);
#ifdef SYN_HAS_JUCE_AUDIO_DEVICES
  if (m_impl->deviceManager && m_impl->callback) {
    m_impl->deviceManager->removeAudioCallback(m_impl->callback.get());
  }
  m_impl->callback.reset();
  m_impl->deviceManager.reset();
#endif
}

AuditionStatus WasapiDeviceManager::getStatus() const {
  std::lock_guard<std::mutex> lock(m_mutex);
  AuditionStatus st;
  st.active = m_impl->active.load(std::memory_order_acquire);
  st.deviceName = m_impl->deviceName;
  st.driverType = m_impl->driverType;
  st.sampleRate = m_impl->sampleRate;
  st.bufferSize = m_impl->bufferSize;
  st.totalFrames = static_cast<int64_t>(m_impl->left.size());
  st.playedFrames = static_cast<int64_t>(m_impl->cursor.load(std::memory_order_relaxed));
  st.looping = m_impl->loop.load(std::memory_order_relaxed);
  st.underruns = m_impl->ring.underrunCount();
  st.lastError = m_impl->lastError;
  return st;
}

} // namespace syn::host
