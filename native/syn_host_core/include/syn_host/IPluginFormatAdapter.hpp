// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 LIL SYNN / SYN-MASTER. Part of the SYN-MASTER VST companion (native/).
#pragma once

#include "PluginTypes.hpp"
#include <string>
#include <vector>

namespace syn::host {

struct BundleScanOutcome {
  bool success = false;
  bool crashed = false;
  bool timedOut = false;
  int exitCode = 0;
  std::string diagnosticMessage;
  std::vector<PluginDescriptor> plugins;
};

/**
 * Format-agnostic plugin discovery adapter interface.
 * Milestone 1 implements VST3FormatAdapter; CLAP, AU, and LV2 plug in cleanly
 * in later milestones without changing the catalog, IPC protocol, or UI.
 */
class IPluginFormatAdapter {
public:
  virtual ~IPluginFormatAdapter() = default;
  virtual PluginFormat format() const = 0;
  virtual std::vector<std::string> defaultSearchDirectories() const = 0;
  virtual std::vector<std::string> collectBundlePaths(
      const std::vector<std::string>& directories) const = 0;
  virtual BundleScanOutcome scanBundle(const std::string& bundlePath) const = 0;
};

} // namespace syn::host
