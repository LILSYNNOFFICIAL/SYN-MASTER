// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 LIL SYNN / SYN-MASTER. Part of the SYN-MASTER VST companion (native/).
#pragma once

#include <filesystem>
#include <string>
#include <vector>

namespace syn::host {

class SecurityPolicy {
public:
  SecurityPolicy();

  void setAllowedRoots(std::vector<std::string> roots);
  void addAllowedRoot(const std::string& root);
  void setExtraAllowedOrigins(std::vector<std::string> origins);

  // Cryptographically random hex pairing/session token
  static std::string generateSecureToken(size_t numBytes = 32);

  // Short human-enterable code with 40 bits of cryptographic entropy (8 base32 symbols).
  static std::string generatePairingCode();

  // Constant-time string comparison to prevent timing side-channels
  static bool constantTimeEquals(const std::string& a, const std::string& b);

  // Strictly validates Origin headers for localhost HTTP + WebSocket connections
  // Allows http://localhost:<port>, http://127.0.0.1:<port>, https://localhost:<port>,
  // https://*.run.app, or explicit CLI allowlisted origins. Rejects null, file://, arbitrary sites.
  bool isOriginAllowed(const std::string& origin) const;

  // Validates whether requestedPath is an existing canonical directory strictly within
  // one of the registered allowed roots (or equal to an allowed root), rejecting '..' traversal
  // and sensitive OS system paths when adding custom directories.
  static bool isSafeCustomScanDirectory(const std::string& rawPath, std::string& normalizedOut, std::string& reasonOut);

  // Validates whether a bundlePath belongs inside one of the authorized VST3 scan directories
  bool isPathWithinAllowedRoots(const std::string& candidatePath) const;

  // Validates JSON-RPC method names against the Milestone 1 strict command allowlist
  static bool isAllowedRpcMethod(const std::string& method);

private:
  std::vector<std::filesystem::path> m_allowedRoots;
  std::vector<std::string> m_extraOrigins;
};

} // namespace syn::host
