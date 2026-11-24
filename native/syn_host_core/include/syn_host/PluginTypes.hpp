#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace syn::host {

enum class PluginFormat {
  VST3,
  CLAP,
  AU,
  LV2
};

inline std::string toString(PluginFormat fmt) {
  switch (fmt) {
    case PluginFormat::VST3: return "vst3";
    case PluginFormat::CLAP: return "clap";
    case PluginFormat::AU: return "au";
    case PluginFormat::LV2: return "lv2";
  }
  return "vst3";
}

enum class PluginStatus {
  Available,
  Missing,
  Incompatible,
  ScanFailed,
  Quarantined,
  Disabled
};

inline std::string toString(PluginStatus status) {
  switch (status) {
    case PluginStatus::Available: return "available";
    case PluginStatus::Missing: return "missing";
    case PluginStatus::Incompatible: return "incompatible";
    case PluginStatus::ScanFailed: return "scan_failed";
    case PluginStatus::Quarantined: return "quarantined";
    case PluginStatus::Disabled: return "disabled";
  }
  return "scan_failed";
}

enum class BinaryArch {
  X64,
  X86,
  ARM64,
  Unknown
};

inline std::string toString(BinaryArch arch) {
  switch (arch) {
    case BinaryArch::X64: return "x64";
    case BinaryArch::X86: return "x86";
    case BinaryArch::ARM64: return "arm64";
    case BinaryArch::Unknown: return "unknown";
  }
  return "unknown";
}

struct ParameterDescriptor {
  uint32_t id = 0;
  std::string name;
  std::string label;
  double defaultValueNormalized = 0.0;
  int stepCount = 0;
  bool isAutomatable = true;
  bool isReadOnly = false;
  bool isBypass = false;
  // Extended scanner metadata kept as a JSON object string so this header stays
  // dependency-free: paramIdString, units, isDiscrete, isBoolean, defaultText,
  // textSamples [[normalized, "text"], ...], valueStrings [...], category.
  std::string extJson;
};

struct BusConfiguration {
  std::string layoutName;
  int mainInputChannels = 2;
  int mainOutputChannels = 2;
  int sidechainInputChannels = 0;
};

struct PluginDescriptor {
  std::string uid;
  PluginFormat format = PluginFormat::VST3;
  std::string name;
  std::string manufacturer;
  std::string version;
  std::string sdkVersion;
  std::string category = "Other";
  std::vector<std::string> subCategories;
  std::string bundlePath;
  std::string binaryPath;
  BinaryArch arch = BinaryArch::Unknown;
  PluginStatus status = PluginStatus::Available;
  std::string statusReason;
  bool hasEditor = false;
  int latencySamples = 0;
  std::vector<BusConfiguration> busConfigs;
  int parameterCount = 0;
  std::vector<ParameterDescriptor> parameters;
  int64_t fileMtimeNs = 0;
  uint64_t fileSizeBytes = 0;
  std::string fileHashSha256;
  int failCount = 0;
  int64_t lastScannedAt = 0;
  bool favorite = false;
  int64_t lastUsedAt = 0;
  bool disabledByUser = false;
};

struct ScanHistoryEntry {
  int64_t id = 0;
  int64_t startedAt = 0;
  int64_t finishedAt = 0;
  std::string mode;
  int totalBundles = 0;
  int discoveredPlugins = 0;
  int failedBundles = 0;
  int skippedUnchanged = 0;
  std::string summary;
};

struct ParameterValue {
  uint32_t id = 0;
  std::string name;
  std::string label;
  double valueNormalized = 0.0;
  double defaultValueNormalized = 0.0;
  int stepCount = 0;
  bool isAutomatable = true;
  bool isReadOnly = false;
  bool isBypass = false;
  std::string displayValue;
};

struct PluginInstanceInfo {
  std::string instanceId;
  std::string uid;
  std::string bundlePath;
  std::string name;
  std::string manufacturer;
  double sampleRate = 48000.0;
  int blockSize = 512;
  int channels = 2;
  int latencySamples = 0;
  bool bypassed = false;
  bool hasEditor = false;
  bool editorOpen = false;
  bool active = false;
  bool crashed = false;
  std::string workerEngine = "juce-vst3-worker";
  std::string lastError;
  std::vector<ParameterValue> parameters;
};

struct AudioDeviceDescriptor {
  std::string id;
  std::string name;
  std::string driverType; // e.g. "WASAPI (Shared)", "WASAPI (Exclusive)", "ASIO"
  int maxOutputChannels = 2;
  std::vector<double> supportedSampleRates;
  int defaultBufferSize = 512;
  bool isDefault = false;
};

struct HostInfo {
  std::string hostVersion = "0.2.0";
  std::string os = "windows-x64";
  int milestone = 2;
  std::vector<std::string> formatsSupported = {"vst3"};
  bool audioEngineActive = false;
  std::vector<std::string> standardDirectories;
  std::vector<std::string> customDirectories;
};

} // namespace syn::host
