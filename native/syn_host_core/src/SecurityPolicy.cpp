// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 LIL SYNN / SYN-MASTER. Part of the SYN-MASTER VST companion (native/).
#include "syn_host/SecurityPolicy.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <fstream>
#include <iomanip>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <unordered_set>

#ifdef _WIN32
#include <windows.h>
#include <bcrypt.h>
#endif

namespace syn::host {

namespace {

std::string toLower(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) {
    return static_cast<char>(std::tolower(c));
  });
  return s;
}

bool isValidPortSuffix(const std::string& s) {
  if (s.empty()) return true;
  if (s[0] != ':') return false;
  if (s.size() < 2 || s.size() > 6) return false;
  for (size_t i = 1; i < s.size(); ++i) {
    if (!std::isdigit(static_cast<unsigned char>(s[i]))) return false;
  }
  int port = std::stoi(s.substr(1));
  return port >= 1 && port <= 65535;
}

bool containsTraversalSegment(const std::filesystem::path& p) {
  for (const auto& part : p) {
    if (part == "..") return true;
  }
  return false;
}

} // namespace

SecurityPolicy::SecurityPolicy() = default;

void SecurityPolicy::setAllowedRoots(std::vector<std::string> roots) {
  m_allowedRoots.clear();
  for (const auto& r : roots) {
    addAllowedRoot(r);
  }
}

void SecurityPolicy::addAllowedRoot(const std::string& root) {
  if (root.empty()) return;
  std::error_code ec;
  std::filesystem::path p(root);
  auto canon = std::filesystem::weakly_canonical(p, ec);
  if (!ec) {
    m_allowedRoots.push_back(canon);
  } else {
    m_allowedRoots.push_back(p.lexically_normal());
  }
}

void SecurityPolicy::setExtraAllowedOrigins(std::vector<std::string> origins) {
  m_extraOrigins = std::move(origins);
}

std::string SecurityPolicy::generateSecureToken(size_t numBytes) {
  std::vector<uint8_t> bytes(numBytes, 0);
#ifdef _WIN32
  if (bytes.size() > static_cast<size_t>(std::numeric_limits<ULONG>::max()) ||
      BCryptGenRandom(nullptr, bytes.data(), static_cast<ULONG>(bytes.size()),
                      BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0) {
    throw std::runtime_error("Cryptographic random number generation failed");
  }
#else
  std::ifstream urandom("/dev/urandom", std::ios::binary);
  if (!urandom.is_open()) throw std::runtime_error("Could not open the system random source");
  urandom.read(reinterpret_cast<char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
  if (!urandom || urandom.gcount() != static_cast<std::streamsize>(bytes.size())) {
    throw std::runtime_error("Could not read enough cryptographic random data");
  }
#endif
  std::ostringstream oss;
  oss << std::hex << std::setfill('0');
  for (uint8_t b : bytes) {
    oss << std::setw(2) << static_cast<int>(b);
  }
  return oss.str();
}

std::string SecurityPolicy::generatePairingCode() {
  static constexpr char kAlphabet[] = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  std::string raw = generateSecureToken(8);
  std::string code = "SYN-";
  for (size_t i = 0; i < 8; ++i) {
    const auto byteText = raw.substr(i * 2, 2);
    const unsigned int val = static_cast<unsigned int>(std::stoul(byteText, nullptr, 16));
    code.push_back(kAlphabet[val & 0x1f]);
    if (i == 3) code.push_back('-');
  }
  return code;
}

bool SecurityPolicy::constantTimeEquals(const std::string& a, const std::string& b) {
  if (a.size() != b.size()) return false;
  unsigned char diff = 0;
  for (size_t i = 0; i < a.size(); ++i) {
    diff |= static_cast<unsigned char>(a[i]) ^ static_cast<unsigned char>(b[i]);
  }
  return diff == 0;
}

bool SecurityPolicy::isOriginAllowed(const std::string& origin) const {
  if (origin.empty()) return false;
  std::string lower = toLower(origin);
  if (lower == "null") return false;

  for (const auto& extra : m_extraOrigins) {
    if (toLower(extra) == lower) return true;
  }

  // Strip scheme
  std::string rest;
  bool isHttps = false;
  if (lower.rfind("http://", 0) == 0) {
    rest = lower.substr(7);
  } else if (lower.rfind("https://", 0) == 0) {
    rest = lower.substr(8);
    isHttps = true;
  } else {
    return false;
  }

  // Reject userinfo, path, query, fragment in Origin header
  if (rest.find('/') != std::string::npos || rest.find('@') != std::string::npos ||
      rest.find('?') != std::string::npos || rest.find('#') != std::string::npos) {
    return false;
  }

  if (rest.rfind("localhost", 0) == 0) {
    return isValidPortSuffix(rest.substr(9));
  }
  if (rest.rfind("127.0.0.1", 0) == 0) {
    return isValidPortSuffix(rest.substr(9));
  }

  // Hosted AI Studio Cloud Run previews
  if (isHttps) {
    std::string host = rest;
    auto colon = rest.find(':');
    if (colon != std::string::npos) {
      if (!isValidPortSuffix(rest.substr(colon))) return false;
      host = rest.substr(0, colon);
    }
    // *.run.app = AI Studio Cloud Run deployments; *.ai.studio = the published
    // AI Studio app domain the live SYN MASTER build is served from
    // (https://syn-master.ai.studio). HTTPS only.
    auto endsWith = [&](const std::string& suffix) {
      return host.size() > suffix.size() &&
             host.compare(host.size() - suffix.size(), suffix.size(), suffix) == 0;
    };
    if (endsWith(".run.app") || endsWith(".ai.studio")) {
      // Basic hostname character validation
      for (char c : host) {
        if (!std::isalnum(static_cast<unsigned char>(c)) && c != '-' && c != '.') {
          return false;
        }
      }
      return true;
    }
  }

  return false;
}

bool SecurityPolicy::isSafeCustomScanDirectory(
    const std::string& rawPath,
    std::string& normalizedOut,
    std::string& reasonOut) {
  if (rawPath.empty() || rawPath.size() > 512) {
    reasonOut = "Directory path must be between 1 and 512 characters";
    return false;
  }
  if (rawPath.find('\0') != std::string::npos) {
    reasonOut = "Directory path contains null bytes";
    return false;
  }

  std::filesystem::path raw(rawPath);
  if (!raw.is_absolute()) {
    reasonOut = "Scan directory must be an absolute path";
    return false;
  }
  if (containsTraversalSegment(raw)) {
    reasonOut = "Parent directory traversal segments ('..') are not allowed";
    return false;
  }

  std::error_code ec;
  std::filesystem::path canon = std::filesystem::weakly_canonical(raw, ec);
  if (ec) {
    reasonOut = "Could not canonicalize directory path";
    return false;
  }

  std::string lower = toLower(canon.string());
  // Block overly broad root drives or OS system folders
  if (lower == "/" || lower == "c:\\" || lower == "c:/" ||
      lower.rfind("c:\\windows", 0) == 0 || lower.rfind("c:/windows", 0) == 0 ||
      lower == "/etc" || lower == "/usr" || lower == "/bin" || lower == "/sbin") {
    reasonOut = "Scanning OS system root directories is prohibited";
    return false;
  }

  if (!std::filesystem::exists(canon, ec) || !std::filesystem::is_directory(canon, ec)) {
    reasonOut = "Directory does not exist or is not a folder";
    return false;
  }

  normalizedOut = canon.string();
  reasonOut.clear();
  return true;
}

bool SecurityPolicy::isPathWithinAllowedRoots(const std::string& candidatePath) const {
  if (candidatePath.empty()) return false;
  std::filesystem::path raw(candidatePath);
  if (containsTraversalSegment(raw)) return false;

  std::error_code ec;
  std::filesystem::path canon = std::filesystem::weakly_canonical(raw, ec);
  if (ec) return false;

  std::string candStr = toLower(canon.lexically_normal().string());
  for (const auto& root : m_allowedRoots) {
    std::string rootStr = toLower(root.lexically_normal().string());
    if (rootStr.empty()) continue;
    if (candStr == rootStr) return true;
    if (candStr.rfind(rootStr, 0) == 0) {
      char next = candStr[rootStr.size()];
      if (rootStr.back() == '/' || rootStr.back() == '\\' || next == '/' || next == '\\') {
        return true;
      }
    }
  }
  return false;
}

bool SecurityPolicy::isAllowedRpcMethod(const std::string& method) {
  static const std::unordered_set<std::string> kAllowed = {
      // Milestone 1: Host Auth, Discovery & Catalog
      "host.auth",
      "host.info",
      "catalog.list",
      "catalog.scan",
      "catalog.retryPlugin",
      "catalog.setPreference",
      "catalog.paths.list",
      "catalog.paths.add",
      "catalog.paths.remove",
      "catalog.history",
      // Milestone 2: Plugin Hosting, Parameter/State/Editor Control & Audio Routing
      "plugin.load",
      "plugin.unload",
      "plugin.listInstances",
      "plugin.setParameter",
      "plugin.getParameters",
      "plugin.setBypass",
      "plugin.getState",
      "plugin.setState",
      "plugin.openEditor",
      "plugin.closeEditor",
      "audio.devices",
      "audio.processOffline",
      "audio.auditionStart",
      "audio.auditionStop",
      "audio.auditionStatus",
  };
  return kAllowed.find(method) != kAllowed.end();
}

} // namespace syn::host
