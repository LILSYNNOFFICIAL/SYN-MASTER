#include "syn_host/PluginCatalogDb.hpp"

#ifdef SYN_HAS_SQLITE
#include <sqlite3.h>
#include <nlohmann/json.hpp>
#endif

#include <chrono>
#include <unordered_set>

namespace syn::host {

PluginCatalogDb::~PluginCatalogDb() {
  close();
}

void PluginCatalogDb::close() {
#ifdef SYN_HAS_SQLITE
  if (m_db) {
    sqlite3_close(m_db);
    m_db = nullptr;
  }
#endif
}

bool PluginCatalogDb::open(const std::string& dbPath, std::string& errorOut) {
#ifndef SYN_HAS_SQLITE
  (void)dbPath;
  errorOut = "SQLite3 support disabled at compile time (SYN_HAS_SQLITE not defined)";
  return false;
#else
  close();
  int rc = sqlite3_open(dbPath.c_str(), &m_db);
  if (rc != SQLITE_OK) {
    errorOut = m_db ? sqlite3_errmsg(m_db) : "Failed to open SQLite database";
    close();
    return false;
  }
  return initSchema(errorOut);
#endif
}

bool PluginCatalogDb::initSchema(std::string& errorOut) {
#ifndef SYN_HAS_SQLITE
  errorOut = "SQLite3 unavailable";
  return false;
#else
  static const char* kSchemaSql = R"SQL(
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS plugins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL,
  format TEXT NOT NULL,
  name TEXT NOT NULL,
  manufacturer TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '',
  sdk_version TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'Other',
  subcategories_json TEXT NOT NULL DEFAULT '[]',
  bundle_path TEXT NOT NULL,
  binary_path TEXT NOT NULL DEFAULT '',
  arch TEXT NOT NULL DEFAULT 'unknown',
  status TEXT NOT NULL DEFAULT 'available',
  status_reason TEXT NOT NULL DEFAULT '',
  has_editor INTEGER NOT NULL DEFAULT 0,
  latency_samples INTEGER NOT NULL DEFAULT 0,
  bus_configs_json TEXT NOT NULL DEFAULT '[]',
  parameter_count INTEGER NOT NULL DEFAULT 0,
  parameters_json TEXT NOT NULL DEFAULT '[]',
  file_mtime_ns INTEGER NOT NULL DEFAULT 0,
  file_size_bytes INTEGER NOT NULL DEFAULT 0,
  file_hash_sha256 TEXT NOT NULL DEFAULT '',
  fail_count INTEGER NOT NULL DEFAULT 0,
  last_scanned_at INTEGER NOT NULL DEFAULT 0,
  favorite INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER NOT NULL DEFAULT 0,
  disabled_by_user INTEGER NOT NULL DEFAULT 0,
  UNIQUE(uid, bundle_path)
);

CREATE INDEX IF NOT EXISTS idx_plugins_bundle_path ON plugins(bundle_path);
CREATE INDEX IF NOT EXISTS idx_plugins_status ON plugins(status);

CREATE TABLE IF NOT EXISTS custom_directories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  added_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scan_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  mode TEXT NOT NULL,
  total_bundles INTEGER NOT NULL,
  discovered_plugins INTEGER NOT NULL,
  failed_bundles INTEGER NOT NULL,
  skipped_unchanged INTEGER NOT NULL,
  summary TEXT NOT NULL DEFAULT ''
);
)SQL";

  char* errMsg = nullptr;
  int rc = sqlite3_exec(m_db, kSchemaSql, nullptr, nullptr, &errMsg);
  if (rc != SQLITE_OK) {
    errorOut = errMsg ? errMsg : "Failed to initialize SQLite schema";
    sqlite3_free(errMsg);
    return false;
  }
  return true;
#endif
}

#ifdef SYN_HAS_SQLITE
namespace {

PluginFormat parseFormat(const std::string& s) {
  if (s == "clap") return PluginFormat::CLAP;
  if (s == "au") return PluginFormat::AU;
  if (s == "lv2") return PluginFormat::LV2;
  return PluginFormat::VST3;
}

PluginStatus parseStatus(const std::string& s) {
  if (s == "available") return PluginStatus::Available;
  if (s == "missing") return PluginStatus::Missing;
  if (s == "incompatible") return PluginStatus::Incompatible;
  if (s == "quarantined") return PluginStatus::Quarantined;
  if (s == "disabled") return PluginStatus::Disabled;
  return PluginStatus::ScanFailed;
}

BinaryArch parseArch(const std::string& s) {
  if (s == "x64") return BinaryArch::X64;
  if (s == "x86") return BinaryArch::X86;
  if (s == "arm64") return BinaryArch::ARM64;
  return BinaryArch::Unknown;
}

std::string serializeSubCategories(const std::vector<std::string>& items) {
  nlohmann::json arr = items;
  return arr.dump();
}

std::string serializeBusConfigs(const std::vector<BusConfiguration>& buses) {
  nlohmann::json arr = nlohmann::json::array();
  for (const auto& b : buses) {
    arr.push_back({
        {"layoutName", b.layoutName},
        {"mainInputChannels", b.mainInputChannels},
        {"mainOutputChannels", b.mainOutputChannels},
        {"sidechainInputChannels", b.sidechainInputChannels},
    });
  }
  return arr.dump();
}

std::string serializeParameters(const std::vector<ParameterDescriptor>& params) {
  nlohmann::json arr = nlohmann::json::array();
  for (const auto& p : params) {
    arr.push_back({
        {"id", p.id},
        {"name", p.name},
        {"label", p.label},
        {"defaultValueNormalized", p.defaultValueNormalized},
        {"stepCount", p.stepCount},
        {"isAutomatable", p.isAutomatable},
        {"isReadOnly", p.isReadOnly},
        {"isBypass", p.isBypass},
    });
  }
  return arr.dump();
}

std::string colText(sqlite3_stmt* st, int col) {
  const unsigned char* txt = sqlite3_column_text(st, col);
  return txt ? reinterpret_cast<const char*>(txt) : "";
}

PluginDescriptor readRow(sqlite3_stmt* st) {
  PluginDescriptor d;
  d.uid = colText(st, 0);
  d.format = parseFormat(colText(st, 1));
  d.name = colText(st, 2);
  d.manufacturer = colText(st, 3);
  d.version = colText(st, 4);
  d.sdkVersion = colText(st, 5);
  d.category = colText(st, 6);

  try {
    auto subs = nlohmann::json::parse(colText(st, 7));
    if (subs.is_array()) {
      for (const auto& item : subs) {
        if (item.is_string()) d.subCategories.push_back(item.get<std::string>());
      }
    }
  } catch (...) {}

  d.bundlePath = colText(st, 8);
  d.binaryPath = colText(st, 9);
  d.arch = parseArch(colText(st, 10));
  d.status = parseStatus(colText(st, 11));
  d.statusReason = colText(st, 12);
  d.hasEditor = sqlite3_column_int(st, 13) != 0;
  d.latencySamples = sqlite3_column_int(st, 14);

  try {
    auto buses = nlohmann::json::parse(colText(st, 15));
    if (buses.is_array()) {
      for (const auto& b : buses) {
        BusConfiguration bc;
        bc.layoutName = b.value("layoutName", "Stereo");
        bc.mainInputChannels = b.value("mainInputChannels", 2);
        bc.mainOutputChannels = b.value("mainOutputChannels", 2);
        bc.sidechainInputChannels = b.value("sidechainInputChannels", 0);
        d.busConfigs.push_back(std::move(bc));
      }
    }
  } catch (...) {}

  d.parameterCount = sqlite3_column_int(st, 16);

  try {
    auto params = nlohmann::json::parse(colText(st, 17));
    if (params.is_array()) {
      for (const auto& p : params) {
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
    }
  } catch (...) {}

  d.fileMtimeNs = sqlite3_column_int64(st, 18);
  d.fileSizeBytes = static_cast<uint64_t>(sqlite3_column_int64(st, 19));
  d.fileHashSha256 = colText(st, 20);
  d.failCount = sqlite3_column_int(st, 21);
  d.lastScannedAt = sqlite3_column_int64(st, 22);
  d.favorite = sqlite3_column_int(st, 23) != 0;
  d.lastUsedAt = sqlite3_column_int64(st, 24);
  d.disabledByUser = sqlite3_column_int(st, 25) != 0;
  return d;
}

const char* kSelectCols =
    "SELECT uid, format, name, manufacturer, version, sdk_version, category, "
    "subcategories_json, bundle_path, binary_path, arch, status, status_reason, "
    "has_editor, latency_samples, bus_configs_json, parameter_count, parameters_json, "
    "file_mtime_ns, file_size_bytes, file_hash_sha256, fail_count, last_scanned_at, "
    "favorite, last_used_at, disabled_by_user FROM plugins ";

} // namespace
#endif

bool PluginCatalogDb::upsertPlugin(const PluginDescriptor& plugin, std::string& errorOut) {
#ifndef SYN_HAS_SQLITE
  (void)plugin;
  errorOut = "SQLite unavailable";
  return false;
#else
  if (!m_db) {
    errorOut = "Database not open";
    return false;
  }

  static const char* kSql = R"SQL(
INSERT INTO plugins (
  uid, format, name, manufacturer, version, sdk_version, category,
  subcategories_json, bundle_path, binary_path, arch, status, status_reason,
  has_editor, latency_samples, bus_configs_json, parameter_count, parameters_json,
  file_mtime_ns, file_size_bytes, file_hash_sha256, fail_count, last_scanned_at,
  favorite, last_used_at, disabled_by_user
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26)
ON CONFLICT(uid, bundle_path) DO UPDATE SET
  format = excluded.format,
  name = excluded.name,
  manufacturer = excluded.manufacturer,
  version = excluded.version,
  sdk_version = excluded.sdk_version,
  category = excluded.category,
  subcategories_json = excluded.subcategories_json,
  binary_path = excluded.binary_path,
  arch = excluded.arch,
  status = excluded.status,
  status_reason = excluded.status_reason,
  has_editor = excluded.has_editor,
  latency_samples = excluded.latency_samples,
  bus_configs_json = excluded.bus_configs_json,
  parameter_count = excluded.parameter_count,
  parameters_json = excluded.parameters_json,
  file_mtime_ns = excluded.file_mtime_ns,
  file_size_bytes = excluded.file_size_bytes,
  file_hash_sha256 = excluded.file_hash_sha256,
  fail_count = excluded.fail_count,
  last_scanned_at = excluded.last_scanned_at;
)SQL";

  sqlite3_stmt* st = nullptr;
  if (sqlite3_prepare_v2(m_db, kSql, -1, &st, nullptr) != SQLITE_OK) {
    errorOut = sqlite3_errmsg(m_db);
    return false;
  }

  std::string fmt = toString(plugin.format);
  std::string subs = serializeSubCategories(plugin.subCategories);
  std::string arch = toString(plugin.arch);
  std::string status = toString(plugin.status);
  std::string buses = serializeBusConfigs(plugin.busConfigs);
  std::string params = serializeParameters(plugin.parameters);

  sqlite3_bind_text(st, 1, plugin.uid.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(st, 2, fmt.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(st, 3, plugin.name.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(st, 4, plugin.manufacturer.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(st, 5, plugin.version.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(st, 6, plugin.sdkVersion.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(st, 7, plugin.category.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(st, 8, subs.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(st, 9, plugin.bundlePath.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(st, 10, plugin.binaryPath.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(st, 11, arch.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(st, 12, status.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(st, 13, plugin.statusReason.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_int(st, 14, plugin.hasEditor ? 1 : 0);
  sqlite3_bind_int(st, 15, plugin.latencySamples);
  sqlite3_bind_text(st, 16, buses.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_int(st, 17, plugin.parameterCount);
  sqlite3_bind_text(st, 18, params.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_int64(st, 19, plugin.fileMtimeNs);
  sqlite3_bind_int64(st, 20, static_cast<sqlite3_int64>(plugin.fileSizeBytes));
  sqlite3_bind_text(st, 21, plugin.fileHashSha256.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_int(st, 22, plugin.failCount);
  sqlite3_bind_int64(st, 23, plugin.lastScannedAt);
  sqlite3_bind_int(st, 24, plugin.favorite ? 1 : 0);
  sqlite3_bind_int64(st, 25, plugin.lastUsedAt);
  sqlite3_bind_int(st, 26, plugin.disabledByUser ? 1 : 0);

  int rc = sqlite3_step(st);
  sqlite3_finalize(st);
  if (rc != SQLITE_DONE) {
    errorOut = sqlite3_errmsg(m_db);
    return false;
  }
  return true;
#endif
}

std::optional<PluginDescriptor> PluginCatalogDb::findByUidAndBundle(
    const std::string& uid,
    const std::string& bundlePath) const {
#ifndef SYN_HAS_SQLITE
  (void)uid;
  (void)bundlePath;
  return std::nullopt;
#else
  if (!m_db) return std::nullopt;
  std::string sql = std::string(kSelectCols) + "WHERE uid = ?1 AND bundle_path = ?2 LIMIT 1;";
  sqlite3_stmt* st = nullptr;
  if (sqlite3_prepare_v2(m_db, sql.c_str(), -1, &st, nullptr) != SQLITE_OK) return std::nullopt;
  sqlite3_bind_text(st, 1, uid.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(st, 2, bundlePath.c_str(), -1, SQLITE_TRANSIENT);
  std::optional<PluginDescriptor> res;
  if (sqlite3_step(st) == SQLITE_ROW) {
    res = readRow(st);
  }
  sqlite3_finalize(st);
  return res;
#endif
}

std::vector<PluginDescriptor> PluginCatalogDb::findByBundlePath(const std::string& bundlePath) const {
  std::vector<PluginDescriptor> out;
#ifdef SYN_HAS_SQLITE
  if (!m_db) return out;
  std::string sql = std::string(kSelectCols) + "WHERE bundle_path = ?1;";
  sqlite3_stmt* st = nullptr;
  if (sqlite3_prepare_v2(m_db, sql.c_str(), -1, &st, nullptr) != SQLITE_OK) return out;
  sqlite3_bind_text(st, 1, bundlePath.c_str(), -1, SQLITE_TRANSIENT);
  while (sqlite3_step(st) == SQLITE_ROW) {
    out.push_back(readRow(st));
  }
  sqlite3_finalize(st);
#else
  (void)bundlePath;
#endif
  return out;
}

std::vector<PluginDescriptor> PluginCatalogDb::listAllPlugins() const {
  std::vector<PluginDescriptor> out;
#ifdef SYN_HAS_SQLITE
  if (!m_db) return out;
  std::string sql = std::string(kSelectCols) + "ORDER BY manufacturer ASC, name ASC;";
  sqlite3_stmt* st = nullptr;
  if (sqlite3_prepare_v2(m_db, sql.c_str(), -1, &st, nullptr) != SQLITE_OK) return out;
  while (sqlite3_step(st) == SQLITE_ROW) {
    out.push_back(readRow(st));
  }
  sqlite3_finalize(st);
#endif
  return out;
}

int PluginCatalogDb::markMissingBundlesNotInSet(const std::vector<std::string>& discoveredBundlePaths) {
#ifndef SYN_HAS_SQLITE
  (void)discoveredBundlePaths;
  return 0;
#else
  if (!m_db) return 0;
  std::unordered_set<std::string> present(discoveredBundlePaths.begin(), discoveredBundlePaths.end());
  auto existing = listAllPlugins();
  int changed = 0;

  for (const auto& item : existing) {
    if (present.find(item.bundlePath) == present.end() && item.status != PluginStatus::Missing) {
      static const char* kSql =
          "UPDATE plugins SET status = 'missing', status_reason = 'Plugin bundle removed from disk' "
          "WHERE uid = ?1 AND bundle_path = ?2;";
      sqlite3_stmt* st = nullptr;
      if (sqlite3_prepare_v2(m_db, kSql, -1, &st, nullptr) == SQLITE_OK) {
        sqlite3_bind_text(st, 1, item.uid.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(st, 2, item.bundlePath.c_str(), -1, SQLITE_TRANSIENT);
        if (sqlite3_step(st) == SQLITE_DONE) ++changed;
        sqlite3_finalize(st);
      }
    }
  }
  return changed;
#endif
}

bool PluginCatalogDb::setPluginPreference(
    const std::string& uid,
    const std::string& bundlePath,
    std::optional<bool> favorite,
    std::optional<bool> disabledByUser,
    std::optional<int64_t> lastUsedAt) {
#ifndef SYN_HAS_SQLITE
  (void)uid; (void)bundlePath; (void)favorite; (void)disabledByUser; (void)lastUsedAt;
  return false;
#else
  if (!m_db) return false;
  auto current = findByUidAndBundle(uid, bundlePath);
  if (!current.has_value()) return false;

  bool nextFav = favorite.value_or(current->favorite);
  bool nextDisabled = disabledByUser.value_or(current->disabledByUser);
  int64_t nextUsed = lastUsedAt.value_or(current->lastUsedAt);

  static const char* kSql =
      "UPDATE plugins SET favorite = ?1, disabled_by_user = ?2, last_used_at = ?3 "
      "WHERE uid = ?4 AND bundle_path = ?5;";
  sqlite3_stmt* st = nullptr;
  if (sqlite3_prepare_v2(m_db, kSql, -1, &st, nullptr) != SQLITE_OK) return false;
  sqlite3_bind_int(st, 1, nextFav ? 1 : 0);
  sqlite3_bind_int(st, 2, nextDisabled ? 1 : 0);
  sqlite3_bind_int64(st, 3, nextUsed);
  sqlite3_bind_text(st, 4, uid.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(st, 5, bundlePath.c_str(), -1, SQLITE_TRANSIENT);
  bool ok = sqlite3_step(st) == SQLITE_DONE;
  sqlite3_finalize(st);
  return ok;
#endif
}

bool PluginCatalogDb::clearQuarantineAndResetFailures(
    const std::string& uid,
    const std::string& bundlePath) {
#ifndef SYN_HAS_SQLITE
  (void)uid; (void)bundlePath;
  return false;
#else
  if (!m_db) return false;
  static const char* kSql =
      "UPDATE plugins SET fail_count = 0, status = 'scan_failed', status_reason = 'Pending retry' "
      "WHERE uid = ?1 AND bundle_path = ?2;";
  sqlite3_stmt* st = nullptr;
  if (sqlite3_prepare_v2(m_db, kSql, -1, &st, nullptr) != SQLITE_OK) return false;
  sqlite3_bind_text(st, 1, uid.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(st, 2, bundlePath.c_str(), -1, SQLITE_TRANSIENT);
  bool ok = sqlite3_step(st) == SQLITE_DONE;
  sqlite3_finalize(st);
  return ok;
#endif
}

bool PluginCatalogDb::addCustomDirectory(const std::string& dirPath, std::string& errorOut) {
#ifndef SYN_HAS_SQLITE
  (void)dirPath;
  errorOut = "SQLite unavailable";
  return false;
#else
  if (!m_db) {
    errorOut = "Database not open";
    return false;
  }
  int64_t nowMs = std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::system_clock::now().time_since_epoch()).count();
  static const char* kSql = "INSERT OR IGNORE INTO custom_directories (path, added_at) VALUES (?1, ?2);";
  sqlite3_stmt* st = nullptr;
  if (sqlite3_prepare_v2(m_db, kSql, -1, &st, nullptr) != SQLITE_OK) {
    errorOut = sqlite3_errmsg(m_db);
    return false;
  }
  sqlite3_bind_text(st, 1, dirPath.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_int64(st, 2, nowMs);
  int rc = sqlite3_step(st);
  sqlite3_finalize(st);
  if (rc != SQLITE_DONE) {
    errorOut = sqlite3_errmsg(m_db);
    return false;
  }
  return true;
#endif
}

bool PluginCatalogDb::removeCustomDirectory(const std::string& dirPath) {
#ifndef SYN_HAS_SQLITE
  (void)dirPath;
  return false;
#else
  if (!m_db) return false;
  static const char* kSql = "DELETE FROM custom_directories WHERE path = ?1;";
  sqlite3_stmt* st = nullptr;
  if (sqlite3_prepare_v2(m_db, kSql, -1, &st, nullptr) != SQLITE_OK) return false;
  sqlite3_bind_text(st, 1, dirPath.c_str(), -1, SQLITE_TRANSIENT);
  bool ok = sqlite3_step(st) == SQLITE_DONE;
  sqlite3_finalize(st);
  return ok;
#endif
}

std::vector<std::string> PluginCatalogDb::listCustomDirectories() const {
  std::vector<std::string> out;
#ifdef SYN_HAS_SQLITE
  if (!m_db) return out;
  static const char* kSql = "SELECT path FROM custom_directories ORDER BY added_at ASC;";
  sqlite3_stmt* st = nullptr;
  if (sqlite3_prepare_v2(m_db, kSql, -1, &st, nullptr) != SQLITE_OK) return out;
  while (sqlite3_step(st) == SQLITE_ROW) {
    out.push_back(colText(st, 0));
  }
  sqlite3_finalize(st);
#endif
  return out;
}

bool PluginCatalogDb::insertScanHistory(const ScanHistoryEntry& entry) {
#ifndef SYN_HAS_SQLITE
  (void)entry;
  return false;
#else
  if (!m_db) return false;
  static const char* kSql = R"SQL(
INSERT INTO scan_history (
  started_at, finished_at, mode, total_bundles, discovered_plugins,
  failed_bundles, skipped_unchanged, summary
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8);
)SQL";
  sqlite3_stmt* st = nullptr;
  if (sqlite3_prepare_v2(m_db, kSql, -1, &st, nullptr) != SQLITE_OK) return false;
  sqlite3_bind_int64(st, 1, entry.startedAt);
  sqlite3_bind_int64(st, 2, entry.finishedAt);
  sqlite3_bind_text(st, 3, entry.mode.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_int(st, 4, entry.totalBundles);
  sqlite3_bind_int(st, 5, entry.discoveredPlugins);
  sqlite3_bind_int(st, 6, entry.failedBundles);
  sqlite3_bind_int(st, 7, entry.skippedUnchanged);
  sqlite3_bind_text(st, 8, entry.summary.c_str(), -1, SQLITE_TRANSIENT);
  bool ok = sqlite3_step(st) == SQLITE_DONE;
  sqlite3_finalize(st);
  return ok;
#endif
}

std::vector<ScanHistoryEntry> PluginCatalogDb::listScanHistory(int limit) const {
  std::vector<ScanHistoryEntry> out;
#ifdef SYN_HAS_SQLITE
  if (!m_db) return out;
  static const char* kSql =
      "SELECT id, started_at, finished_at, mode, total_bundles, discovered_plugins, "
      "failed_bundles, skipped_unchanged, summary FROM scan_history ORDER BY id DESC LIMIT ?1;";
  sqlite3_stmt* st = nullptr;
  if (sqlite3_prepare_v2(m_db, kSql, -1, &st, nullptr) != SQLITE_OK) return out;
  sqlite3_bind_int(st, 1, limit);
  while (sqlite3_step(st) == SQLITE_ROW) {
    ScanHistoryEntry e;
    e.id = sqlite3_column_int64(st, 0);
    e.startedAt = sqlite3_column_int64(st, 1);
    e.finishedAt = sqlite3_column_int64(st, 2);
    e.mode = colText(st, 3);
    e.totalBundles = sqlite3_column_int(st, 4);
    e.discoveredPlugins = sqlite3_column_int(st, 5);
    e.failedBundles = sqlite3_column_int(st, 6);
    e.skippedUnchanged = sqlite3_column_int(st, 7);
    e.summary = colText(st, 8);
    out.push_back(std::move(e));
  }
  sqlite3_finalize(st);
#else
  (void)limit;
#endif
  return out;
}

} // namespace syn::host
