#pragma once

#include "PluginTypes.hpp"

#include <cstdint>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace syn::host {

struct InstanceProcessResult {
  bool ok = false;
  bool crashed = false;
  int latencySamples = 0;
  std::string error;
};

/**
 * Manages live VST3 plugin instances via crash-isolated out-of-process workers
 * (`syn-plugin-worker.exe` on Windows, `syn-plugin-worker` on POSIX QA).
 * Each loaded instance owns an isolated child worker process communicating over
 * private OS pipes so third-party C++ exceptions, access violations, or audio-thread
 * hangs cannot bring down `syn-plugin-host`.
 */
class PluginInstanceManager {
public:
  explicit PluginInstanceManager(std::string workerBinaryPath = {});
  ~PluginInstanceManager();

  void setWorkerBinaryPath(std::string path);
  const std::string& workerBinaryPath() const { return m_workerBinaryPath; }

  bool loadPlugin(
      const std::string& uid,
      const std::string& bundlePath,
      double sampleRate,
      int blockSize,
      int channels,
      PluginInstanceInfo& outInfo,
      std::string& errorOut,
      bool injectCrash = false,
      bool injectHang = false);

  bool unloadPlugin(const std::string& instanceId, std::string& errorOut);
  void unloadAll();

  std::optional<PluginInstanceInfo> getInstance(const std::string& instanceId) const;
  std::vector<PluginInstanceInfo> listInstances() const;

  bool setParameter(
      const std::string& instanceId,
      uint32_t paramId,
      double normalizedValue,
      std::string& displayValueOut,
      std::string& errorOut);

  bool getParameters(
      const std::string& instanceId,
      std::vector<ParameterValue>& paramsOut,
      std::string& errorOut);

  bool setBypass(
      const std::string& instanceId,
      bool bypassed,
      std::string& errorOut);

  bool getStateBase64(
      const std::string& instanceId,
      std::string& stateBase64Out,
      std::string& errorOut);

  bool setStateBase64(
      const std::string& instanceId,
      const std::string& stateBase64,
      std::string& errorOut);

  bool openEditor(const std::string& instanceId, std::string& errorOut);
  bool closeEditor(const std::string& instanceId, std::string& errorOut);

  InstanceProcessResult processBlock(
      const std::string& instanceId,
      std::vector<float>& left,
      std::vector<float>& right,
      uint32_t timeoutMs = 5000);

private:
  struct WorkerSession;
  std::string m_workerBinaryPath;
  mutable std::mutex m_mutex;
  std::unordered_map<std::string, std::shared_ptr<WorkerSession>> m_sessions;
  uint64_t m_nextId = 1;
};

} // namespace syn::host
