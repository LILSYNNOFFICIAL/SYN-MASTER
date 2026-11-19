#pragma once

#include "PluginTypes.hpp"
#include <optional>
#include <string>
#include <vector>

struct sqlite3;

namespace syn::host {

class PluginCatalogDb {
public:
  PluginCatalogDb() = default;
  ~PluginCatalogDb();

  PluginCatalogDb(const PluginCatalogDb&) = delete;
  PluginCatalogDb& operator=(const PluginCatalogDb&) = delete;

  bool open(const std::string& dbPath, std::string& errorOut);
  void close();

  bool upsertPlugin(const PluginDescriptor& plugin, std::string& errorOut);
  std::optional<PluginDescriptor> findByUidAndBundle(
      const std::string& uid,
      const std::string& bundlePath) const;

  // Lookup existing records associated with a bundle path (useful for incremental skipping)
  std::vector<PluginDescriptor> findByBundlePath(const std::string& bundlePath) const;

  std::vector<PluginDescriptor> listAllPlugins() const;

  // Marks plugins whose bundle_path is no longer present on disk as PluginStatus::Missing
  int markMissingBundlesNotInSet(const std::vector<std::string>& discoveredBundlePaths);

  bool setPluginPreference(
      const std::string& uid,
      const std::string& bundlePath,
      std::optional<bool> favorite,
      std::optional<bool> disabledByUser,
      std::optional<int64_t> lastUsedAt);

  bool clearQuarantineAndResetFailures(const std::string& uid, const std::string& bundlePath);

  // Custom directories
  bool addCustomDirectory(const std::string& dirPath, std::string& errorOut);
  bool removeCustomDirectory(const std::string& dirPath);
  std::vector<std::string> listCustomDirectories() const;

  // Scan history
  bool insertScanHistory(const ScanHistoryEntry& entry);
  std::vector<ScanHistoryEntry> listScanHistory(int limit = 25) const;

private:
  bool initSchema(std::string& errorOut);
  sqlite3* m_db = nullptr;
};

} // namespace syn::host
