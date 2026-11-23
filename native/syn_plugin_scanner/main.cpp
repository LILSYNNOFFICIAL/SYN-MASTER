#include "syn_host/PluginTypes.hpp"
#include "syn_host/WindowsPeInspector.hpp"

#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

#ifdef JUCE_PLUGINHOST_VST3
#include <juce_core/juce_core.h>
#include <juce_audio_processors/juce_audio_processors.h>
#include <nlohmann/json.hpp>
#endif

using namespace syn::host;

namespace {

void printUsage() {
  std::cerr << "Usage: syn-plugin-scanner --bundle <path> --out <json_path>\n"
            << "   or: syn-plugin-scanner --selftest-crash | --selftest-hang\n";
}

} // namespace

int main(int argc, char* argv[]) {
  std::string bundlePath;
  std::string outPath;
  bool selfTestCrash = false;
  bool selfTestHang = false;

  for (int i = 1; i < argc; ++i) {
    std::string arg = argv[i];
    if (arg == "--bundle" && i + 1 < argc) bundlePath = argv[++i];
    else if (arg == "--out" && i + 1 < argc) outPath = argv[++i];
    else if (arg == "--selftest-crash") selfTestCrash = true;
    else if (arg == "--selftest-hang") selfTestHang = true;
  }

  // Deliberate crash & hang fault-injection flags for out-of-process isolation verification
  if (selfTestCrash) {
    volatile int* nullPtr = nullptr;
    *nullPtr = 42;
    return 1;
  }
  if (selfTestHang) {
    while (true) {
      std::this_thread::sleep_for(std::chrono::seconds(5));
    }
  }

  if (bundlePath.empty() || outPath.empty()) {
    printUsage();
    return 2;
  }

  auto resolved = WindowsPeInspector::resolveAndInspectVst3Bundle(bundlePath, true);
  if (!resolved.exists) {
    std::cerr << "Bundle not found: " << bundlePath << "\n";
    return 3;
  }

  if (!resolved.pe.validPe) {
    std::cerr << "Invalid PE binary: " << resolved.pe.diagnostic << "\n";
    return 4;
  }

  if (resolved.pe.arch != BinaryArch::X64) {
    std::cerr << "Incompatible binary architecture (" << toString(resolved.pe.arch)
              << "): " << resolved.pe.diagnostic << "\n";
    return 5;
  }

#ifdef JUCE_PLUGINHOST_VST3
  juce::ScopedJuceInitialiser_GUI juceInit;
  juce::VST3PluginFormat vst3Format;
  juce::OwnedArray<juce::PluginDescription> descriptions;
  vst3Format.findAllTypesForFile(descriptions, juce::String(bundlePath));

  nlohmann::json pluginsJson = nlohmann::json::array();
  int64_t nowMs = std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::system_clock::now().time_since_epoch()).count();

  for (const auto* desc : descriptions) {
    if (!desc) continue;

    nlohmann::json j;
    j["uid"] = desc->createIdentifierString().toStdString();
    j["format"] = "vst3";
    j["name"] = desc->name.toStdString();
    j["manufacturer"] = desc->manufacturerName.toStdString();
    j["version"] = desc->version.toStdString();
    j["sdkVersion"] = "VST3";
    j["category"] = desc->category.isNotEmpty() ? desc->category.toStdString() : "Effect";
    j["subCategories"] = nlohmann::json::array({desc->category.toStdString()});
    j["bundlePath"] = resolved.bundlePath;
    j["binaryPath"] = resolved.binaryPath;
    j["arch"] = toString(resolved.pe.arch);
    j["status"] = "available";
    j["statusReason"] = "";
    j["fileMtimeNs"] = resolved.mtimeNs;
    j["fileSizeBytes"] = resolved.sizeBytes;
    j["fileHashSha256"] = resolved.sha256Hex;
    j["lastScannedAt"] = nowMs;

    // Headless instantiation in scanner worker (isolated from main host) to inspect
    // actual parameters, bus layouts, sidechain, latency, and GUI editor availability.
    juce::String loadErr;
    auto instance = vst3Format.createInstanceFromDescription(*desc, 44100.0, 512, loadErr);
    if (instance) {
      j["hasEditor"] = instance->hasEditor();
      j["latencySamples"] = instance->getLatencySamples();

      nlohmann::json busArr = nlohmann::json::array();
      int mainIn = instance->getTotalNumInputChannels();
      int mainOut = instance->getTotalNumOutputChannels();
      int scIn = 0;
      if (instance->getBusCount(true) > 1) {
        scIn = instance->getChannelCountOfBus(true, 1);
      }
      busArr.push_back({
          {"layoutName", (mainIn == 2 && mainOut == 2) ? "Stereo" : std::to_string(mainIn) + "in/" + std::to_string(mainOut) + "out"},
          {"mainInputChannels", mainIn},
          {"mainOutputChannels", mainOut},
          {"sidechainInputChannels", scIn},
      });
      j["busConfigs"] = busArr;

      const auto& params = instance->getParameters();
      j["parameterCount"] = params.size();
      nlohmann::json paramArr = nlohmann::json::array();
      int maxExport = std::min(params.size(), 256);
      for (int p = 0; p < maxExport; ++p) {
        const auto* param = params[p];
        if (!param) continue;
        paramArr.push_back({
            {"id", static_cast<uint32_t>(p)},
            {"name", param->getName(128).toStdString()},
            {"label", param->getLabel().toStdString()},
            {"defaultValueNormalized", static_cast<double>(param->getDefaultValue())},
            {"stepCount", param->getNumSteps()},
            {"isAutomatable", param->isAutomatable()},
            {"isReadOnly", param->isMetaParameter()},
            {"isBypass", param == instance->getBypassParameter()},
        });
      }
      j["parameters"] = paramArr;
      instance.reset();
    } else {
      j["hasEditor"] = false;
      j["latencySamples"] = 0;
      j["busConfigs"] = nlohmann::json::array({{
          {"layoutName", "Default"},
          {"mainInputChannels", desc->numInputChannels},
          {"mainOutputChannels", desc->numOutputChannels},
          {"sidechainInputChannels", 0},
      }});
      j["parameterCount"] = 0;
      j["parameters"] = nlohmann::json::array();
      if (loadErr.isNotEmpty()) {
        j["statusReason"] = "Factory metadata loaded; headless instantiate warning: " + loadErr.toStdString();
      }
    }

    pluginsJson.push_back(std::move(j));
  }

  nlohmann::json out = {
      {"bundlePath", resolved.bundlePath},
      {"binaryPath", resolved.binaryPath},
      {"arch", toString(resolved.pe.arch)},
      {"plugins", pluginsJson},
  };

  std::ofstream ofs(outPath, std::ios::binary | std::ios::trunc);
  if (!ofs.is_open()) {
    std::cerr << "Failed to write scanner output file: " << outPath << "\n";
    return 6;
  }
  ofs << out.dump(2);
  return 0;
#else
  std::cerr << "syn-plugin-scanner compiled without JUCE_PLUGINHOST_VST3.\n";
  return 7;
#endif
}
