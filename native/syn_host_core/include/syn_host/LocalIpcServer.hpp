// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 LIL SYNN / SYN-MASTER. Part of the SYN-MASTER VST companion (native/).
#pragma once

#include "PluginCatalogDb.hpp"
#include "PluginInstanceManager.hpp"
#include "PluginTypes.hpp"
#include "SecurityPolicy.hpp"
#include "WasapiDeviceManager.hpp"

#include <atomic>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_set>
#include <vector>

namespace syn::host {

struct HostServerConfig {
  int httpPort = 47832;
  int wsPort = 47833;
  std::string pairingCode;
  std::string sessionToken;
  std::string scannerBinaryPath;
  std::string workerBinaryPath;
  std::vector<std::string> standardDirectories;
  uint32_t scanTimeoutMs = 15000;
};

class LocalIpcServer {
public:
  using ScanTriggerCallback = std::function<void(
      const std::string& mode,
      const std::string& onlyBundlePath,
      std::function<void(int done, int total, const std::string& bundle, const std::string& status)> progressCb)>;

  LocalIpcServer(
      HostServerConfig config,
      PluginCatalogDb& db,
      SecurityPolicy& security,
      PluginInstanceManager* instanceManager = nullptr,
      WasapiDeviceManager* audioManager = nullptr);
  ~LocalIpcServer();

  bool start(std::string& errorOut);
  void stop();
  void wait();

  void setScanHandler(ScanTriggerCallback cb);
  void setShutdownHandler(std::function<void()> cb);
  void broadcastNotification(const std::string& method, const std::string& paramsJson);

  // Companion-window status hooks (read from the GUI thread; all lock-free).
  // startScan() runs the same path as the catalog.scan RPC and broadcasts progress
  // to the web app; returns false if a scan is already running or no handler is set.
  bool startScan(const std::string& mode);
  bool isScanInProgress() const { return m_scanInProgress.load(); }
  int scanCompleted() const { return m_scanDone.load(); }
  int scanTotal() const { return m_scanTotal.load(); }
  // A browser client completed /v1/auth/pair at least once this launch.
  bool hasPairedOnce() const { return m_pairedOnce.load(); }
  // Number of WebSocket clients currently authenticated with the session token.
  int authenticatedClientCount() const { return m_authedClients.load(); }

  static std::string serializePluginJson(const PluginDescriptor& d);

private:
  HostServerConfig m_config;
  PluginCatalogDb& m_db;
  SecurityPolicy& m_security;
  PluginInstanceManager* m_instanceManager = nullptr;
  WasapiDeviceManager* m_audioManager = nullptr;
  ScanTriggerCallback m_scanHandler;
  std::function<void()> m_shutdownHandler;
  std::atomic<bool> m_running{false};
  std::atomic<bool> m_scanInProgress{false};
  std::atomic<int> m_scanDone{0};
  std::atomic<int> m_scanTotal{0};
  std::atomic<bool> m_pairedOnce{false};
  std::atomic<int> m_failedPairingAttempts{0};
  std::atomic<int> m_authedClients{0};

  struct Impl;
  std::unique_ptr<Impl> m_impl;
};

} // namespace syn::host
