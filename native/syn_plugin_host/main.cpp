#include "syn_host/AudioRouter.hpp"
#include "syn_host/LocalIpcServer.hpp"
#include "syn_host/PluginCatalogDb.hpp"
#include "syn_host/PluginInstanceManager.hpp"
#include "syn_host/PluginTypes.hpp"
#include "syn_host/ProcessRunner.hpp"
#include "syn_host/SecurityPolicy.hpp"
#include "syn_host/WasapiDeviceManager.hpp"
#include "syn_host/WindowsPeInspector.hpp"

#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

#ifdef SYN_HOST_FULL_BUILD
#include <nlohmann/json.hpp>
#endif

#ifdef _WIN32
#include <windows.h>
#endif

#ifdef SYN_HAS_JUCE_AUDIO_DEVICES
#include <juce_events/juce_events.h>
#endif

using namespace syn::host;

namespace {

std::atomic<bool> g_shouldStop{false};

void handleSignal(int) {
  g_shouldStop = true;
}

std::vector<std::string> detectStandardVst3Directories() {
  std::vector<std::string> dirs;
#ifdef _WIN32
  dirs.emplace_back("C:\\Program Files\\Common Files\\VST3");
  if (const char* localApp = std::getenv("LOCALAPPDATA")) {
    dirs.push_back((std::filesystem::path(localApp) / "Programs" / "Common" / "VST3").string());
  }
#else
  dirs.emplace_back("/usr/local/lib/vst3");
  dirs.emplace_back("/usr/lib/vst3");
#endif
  return dirs;
}

std::filesystem::path getAppDataDir() {
#ifdef _WIN32
  if (const char* appData = std::getenv("LOCALAPPDATA")) {
    return std::filesystem::path(appData) / "SYN MASTER";
  }
  return std::filesystem::current_path() / ".syn_master_host";
#else
  if (const char* home = std::getenv("HOME")) {
    return std::filesystem::path(home) / ".local" / "share" / "syn-master";
  }
  return std::filesystem::current_path() / ".syn_master_host";
#endif
}

std::vector<std::string> collectVst3Bundles(const std::vector<std::string>& searchDirs) {
  std::vector<std::string> found;
  std::error_code ec;
  for (const auto& dirStr : searchDirs) {
    std::filesystem::path root(dirStr);
    if (!std::filesystem::exists(root, ec) || !std::filesystem::is_directory(root, ec)) continue;

    // Walk recursively; do not descend into *.vst3 bundle directories themselves
    for (auto it = std::filesystem::recursive_directory_iterator(
             root, std::filesystem::directory_options::skip_permission_denied, ec);
         it != std::filesystem::recursive_directory_iterator();
         it.increment(ec)) {
      if (ec) continue;
      const auto& p = it->path();
      if (p.extension() == ".vst3") {
        found.push_back(p.lexically_normal().string());
        if (it->is_directory(ec)) {
          it.disable_recursion_pending();
        }
      }
    }
  }
  return found;
}

} // namespace

int main(int argc, char* argv[]) {
  std::signal(SIGINT, handleSignal);
  std::signal(SIGTERM, handleSignal);

#ifdef SYN_HAS_JUCE_AUDIO_DEVICES
  juce::ScopedJuceInitialiser_GUI juceInit;
#endif

  int httpPort = 47832;
  int wsPort = 47833;
  std::string dataDirOverride;
  std::vector<std::string> extraOrigins;

  for (int i = 1; i < argc; ++i) {
    std::string arg = argv[i];
    if (arg == "--port" && i + 1 < argc) httpPort = std::stoi(argv[++i]);
    else if (arg == "--ws-port" && i + 1 < argc) wsPort = std::stoi(argv[++i]);
    else if (arg == "--data-dir" && i + 1 < argc) dataDirOverride = argv[++i];
    else if (arg == "--allow-origin" && i + 1 < argc) extraOrigins.emplace_back(argv[++i]);
  }

  std::filesystem::path dataDir = dataDirOverride.empty() ? getAppDataDir() : std::filesystem::path(dataDirOverride);
  std::error_code ec;
  std::filesystem::create_directories(dataDir, ec);

  std::filesystem::path exeDir = std::filesystem::weakly_canonical(std::filesystem::path(argv[0]), ec).parent_path();
#ifdef _WIN32
  {
    wchar_t modBuf[MAX_PATH * 4]{};
    DWORD len = GetModuleFileNameW(nullptr, modBuf, static_cast<DWORD>(std::size(modBuf)));
    if (len > 0 && len < std::size(modBuf)) {
      exeDir = std::filesystem::path(modBuf).parent_path();
    }
  }
  std::filesystem::path scannerPath = exeDir / "syn-plugin-scanner.exe";
  std::filesystem::path workerPath = exeDir / "syn-plugin-worker.exe";
#else
  std::filesystem::path scannerPath = exeDir / "syn-plugin-scanner";
  std::filesystem::path workerPath = exeDir / "syn-plugin-worker";
#endif

  PluginCatalogDb db;
  std::string dbErr;
  std::filesystem::path dbPath = dataDir / "plugin_catalog.db";
  if (!db.open(dbPath.string(), dbErr)) {
    std::cerr << "[syn-plugin-host] Failed to open catalog SQLite DB: " << dbErr << "\n";
    return 1;
  }

  SecurityPolicy security;
  security.setExtraAllowedOrigins(extraOrigins);
  auto stdDirs = detectStandardVst3Directories();
  security.setAllowedRoots(stdDirs);
  for (const auto& c : db.listCustomDirectories()) {
    security.addAllowedRoot(c);
  }

  HostServerConfig cfg;
  cfg.httpPort = httpPort;
  cfg.wsPort = wsPort;
  cfg.pairingCode = SecurityPolicy::generatePairingCode();
  cfg.sessionToken = SecurityPolicy::generateSecureToken(32);
  cfg.scannerBinaryPath = scannerPath.string();
  cfg.workerBinaryPath = workerPath.string();
  cfg.standardDirectories = stdDirs;

  PluginInstanceManager instanceManager(cfg.workerBinaryPath);
  WasapiDeviceManager audioManager;

#ifdef SYN_HOST_FULL_BUILD
  {
    nlohmann::json pairingDoc = {
        {"httpPort", cfg.httpPort},
        {"wsPort", cfg.wsPort},
        {"pairingCode", cfg.pairingCode},
        {"sessionToken", cfg.sessionToken},
        {"createdAt", std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::system_clock::now().time_since_epoch()).count()},
    };
    std::ofstream pf(dataDir / "host_pairing.json", std::ios::trunc);
    pf << pairingDoc.dump(2);
  }
#endif

  LocalIpcServer server(cfg, db, security, &instanceManager, &audioManager);
  server.setScanHandler([&](
      const std::string& mode,
      const std::string& onlyBundlePath,
      std::function<void(int, int, const std::string&, const std::string&)> progressCb) {
#ifdef SYN_HOST_FULL_BUILD
    int64_t startedAt = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();

    std::vector<std::string> allDirs = cfg.standardDirectories;
    for (const auto& c : db.listCustomDirectories()) allDirs.push_back(c);

    std::vector<std::string> bundles = onlyBundlePath.empty()
        ? collectVst3Bundles(allDirs)
        : std::vector<std::string>{onlyBundlePath};

    int discovered = 0;
    int failed = 0;
    int skipped = 0;
    int total = static_cast<int>(bundles.size());

    for (int i = 0; i < total; ++i) {
      const auto& bundle = bundles[static_cast<size_t>(i)];
      auto existing = db.findByBundlePath(bundle);

      // Quarantine skip unless retry or force
      if (mode != "force" && mode != "retry" && !existing.empty() &&
          existing[0].status == PluginStatus::Quarantined) {
        ++skipped;
        progressCb(i + 1, total, bundle, "quarantined");
        continue;
      }

      auto resolved = WindowsPeInspector::resolveAndInspectVst3Bundle(bundle, true);
      if (mode == "incremental" && !existing.empty() && resolved.exists &&
          existing[0].fileMtimeNs == resolved.mtimeNs &&
          existing[0].fileSizeBytes == resolved.sizeBytes &&
          existing[0].fileHashSha256 == resolved.sha256Hex &&
          existing[0].status == PluginStatus::Available) {
        ++skipped;
        progressCb(i + 1, total, bundle, "unchanged");
        continue;
      }

      // Pre-check incompatible architecture before spawning scanner
      if (resolved.exists && resolved.pe.validPe && resolved.pe.arch != BinaryArch::X64) {
        PluginDescriptor d;
        d.uid = "incompat:" + resolved.bundlePath;
        d.format = PluginFormat::VST3;
        d.name = std::filesystem::path(bundle).stem().string();
        d.manufacturer = "Unknown";
        d.bundlePath = resolved.bundlePath;
        d.binaryPath = resolved.binaryPath;
        d.arch = resolved.pe.arch;
        d.status = PluginStatus::Incompatible;
        d.statusReason = resolved.pe.diagnostic;
        d.fileMtimeNs = resolved.mtimeNs;
        d.fileSizeBytes = resolved.sizeBytes;
        d.fileHashSha256 = resolved.sha256Hex;
        d.lastScannedAt = startedAt;
        std::string err;
        db.upsertPlugin(d, err);
        ++failed;
        progressCb(i + 1, total, bundle, "incompatible");
        continue;
      }

      std::filesystem::path outJson = dataDir / ("scan_" + std::to_string(startedAt) + "_" + std::to_string(i) + ".json");
      auto procRes = ProcessRunner::runWithTimeout(
          cfg.scannerBinaryPath,
          {"--bundle", bundle, "--out", outJson.string()},
          cfg.scanTimeoutMs);

      if (procRes.exitedNormally && std::filesystem::exists(outJson, ec)) {
        try {
          std::ifstream ifs(outJson);
          auto parsed = nlohmann::json::parse(ifs);
          for (const auto& pj : parsed["plugins"]) {
            PluginDescriptor d;
            d.uid = pj.value("uid", "");
            d.name = pj.value("name", std::filesystem::path(bundle).stem().string());
            d.manufacturer = pj.value("manufacturer", "Unknown");
            d.version = pj.value("version", "");
            d.sdkVersion = pj.value("sdkVersion", "VST3");
            d.category = pj.value("category", "Effect");
            d.bundlePath = pj.value("bundlePath", bundle);
            d.binaryPath = pj.value("binaryPath", resolved.binaryPath);
            d.arch = BinaryArch::X64;
            d.status = PluginStatus::Available;
            d.statusReason = pj.value("statusReason", "");
            d.hasEditor = pj.value("hasEditor", false);
            d.latencySamples = pj.value("latencySamples", 0);
            d.parameterCount = pj.value("parameterCount", 0);
            d.fileMtimeNs = resolved.mtimeNs;
            d.fileSizeBytes = resolved.sizeBytes;
            d.fileHashSha256 = resolved.sha256Hex;
            d.failCount = 0;
            d.lastScannedAt = startedAt;
            for (const auto& b : pj["busConfigs"]) {
              BusConfiguration bc;
              bc.layoutName = b.value("layoutName", "Stereo");
              bc.mainInputChannels = b.value("mainInputChannels", 2);
              bc.mainOutputChannels = b.value("mainOutputChannels", 2);
              bc.sidechainInputChannels = b.value("sidechainInputChannels", 0);
              d.busConfigs.push_back(std::move(bc));
            }
            for (const auto& p : pj["parameters"]) {
              ParameterDescriptor pd;
              pd.id = p.value("id", 0u);
              pd.name = p.value("name", "");
              pd.label = p.value("label", "");
              pd.defaultValueNormalized = p.value("defaultValueNormalized", 0.0);
              pd.stepCount = p.value("stepCount", 0);
              pd.isAutomatable = p.value("isAutomatable", true);
              pd.isReadOnly = p.value("isReadOnly", false);
              pd.isBypass = p.value("isBypass", false);
              d.parameters.push_back(std::move(pd));
            }
            std::string err;
            db.upsertPlugin(d, err);
            ++discovered;
          }
          std::filesystem::remove(outJson, ec);
          progressCb(i + 1, total, bundle, "ok");
          continue;
        } catch (...) {
          std::filesystem::remove(outJson, ec);
        }
      }

      std::filesystem::remove(outJson, ec);
      int prevFails = existing.empty() ? 0 : existing[0].failCount;
      int nextFails = prevFails + 1;
      PluginDescriptor failRec;
      failRec.uid = existing.empty() ? ("failed:" + bundle) : existing[0].uid;
      failRec.name = std::filesystem::path(bundle).stem().string();
      failRec.manufacturer = "Unknown";
      failRec.bundlePath = bundle;
      failRec.binaryPath = resolved.binaryPath;
      failRec.arch = resolved.pe.arch;
      failRec.failCount = nextFails;
      failRec.status = nextFails >= 2 ? PluginStatus::Quarantined : PluginStatus::ScanFailed;
      failRec.statusReason = procRes.diagnostic.empty() ? "Scanner failed" : procRes.diagnostic;
      failRec.fileMtimeNs = resolved.mtimeNs;
      failRec.fileSizeBytes = resolved.sizeBytes;
      failRec.fileHashSha256 = resolved.sha256Hex;
      failRec.lastScannedAt = startedAt;
      std::string err;
      db.upsertPlugin(failRec, err);
      ++failed;
      progressCb(i + 1, total, bundle, toString(failRec.status));
    }

    if (onlyBundlePath.empty()) {
      db.markMissingBundlesNotInSet(bundles);
    }

    int64_t finishedAt = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    ScanHistoryEntry hist;
    hist.startedAt = startedAt;
    hist.finishedAt = finishedAt;
    hist.mode = mode;
    hist.totalBundles = total;
    hist.discoveredPlugins = discovered;
    hist.failedBundles = failed;
    hist.skippedUnchanged = skipped;
    hist.summary = "Scanned " + std::to_string(total) + " bundles: " +
                   std::to_string(discovered) + " plugins, " +
                   std::to_string(skipped) + " unchanged, " +
                   std::to_string(failed) + " failed.";
    db.insertScanHistory(hist);
#else
    (void)mode; (void)onlyBundlePath; (void)progressCb;
#endif
  });

  std::string err;
  if (!server.start(err)) {
    std::cerr << "[syn-plugin-host] Startup failed: " << err << "\n";
    return 2;
  }

  std::cout << "==========================================================\n"
            << "SYN-PLUGIN-HOST v0.2.0 (Milestone 2: VST3 Hosting & Audio)\n"
            << "Loopback HTTP:      http://127.0.0.1:" << cfg.httpPort << "\n"
            << "Loopback WebSocket: ws://127.0.0.1:" << cfg.wsPort << "/ws\n"
            << "Pairing Code:       " << cfg.pairingCode << "\n"
            << "Worker Binary:      " << cfg.workerBinaryPath << "\n"
            << "Catalog DB:         " << dbPath.string() << "\n"
            << "==========================================================\n";

  while (!g_shouldStop.load()) {
#ifdef SYN_HAS_JUCE_AUDIO_DEVICES
    if (auto* mm = juce::MessageManager::getInstanceWithoutCreating()) {
      mm->runDispatchLoopUntil(200);
    } else {
      std::this_thread::sleep_for(std::chrono::milliseconds(200));
    }
#else
    std::this_thread::sleep_for(std::chrono::milliseconds(200));
#endif
  }
  audioManager.stopAudition();
  instanceManager.unloadAll();
  server.stop();
  return 0;
}
