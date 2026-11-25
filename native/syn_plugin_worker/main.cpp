// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 LIL SYNN / SYN-MASTER. Part of the SYN-MASTER VST companion (native/).
#include "syn_host/AudioRouter.hpp"
#include "syn_host/PluginInstanceManager.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#ifdef JUCE_PLUGINHOST_VST3
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include <juce_gui_basics/juce_gui_basics.h>
#endif

using namespace syn::host;

namespace {

[[maybe_unused]] std::string escapeTabField(const std::string& s) {
  std::string out;
  out.reserve(s.size());
  for (char c : s) {
    if (c == '\\') out += "\\\\";
    else if (c == '\t') out += "\\t";
    else if (c == '\n') out += "\\n";
    else if (c == '\r') out += "\\r";
    else out.push_back(c);
  }
  return out;
}

std::string unescapeTabField(const std::string& s) {
  std::string out;
  out.reserve(s.size());
  for (size_t i = 0; i < s.size(); ++i) {
    if (s[i] == '\\' && i + 1 < s.size()) {
      char n = s[i + 1];
      if (n == '\\') { out.push_back('\\'); ++i; continue; }
      if (n == 't') { out.push_back('\t'); ++i; continue; }
      if (n == 'n') { out.push_back('\n'); ++i; continue; }
      if (n == 'r') { out.push_back('\r'); ++i; continue; }
    }
    out.push_back(s[i]);
  }
  return out;
}

std::vector<std::string> splitTabLine(const std::string& line) {
  std::vector<std::string> parts;
  size_t start = 0;
  while (true) {
    size_t pos = line.find('\t', start);
    if (pos == std::string::npos) {
      parts.push_back(unescapeTabField(line.substr(start)));
      break;
    }
    parts.push_back(unescapeTabField(line.substr(start, pos - start)));
    start = pos + 1;
  }
  return parts;
}

[[maybe_unused]] std::string sanitizeParamToken(std::string s) {
  for (char& c : s) {
    if (c == '|' || c == '\t' || c == '\n' || c == '\r') c = ' ';
  }
  return s;
}

#ifdef JUCE_PLUGINHOST_VST3
class PluginEditorWindow : public juce::DocumentWindow {
public:
  PluginEditorWindow(const juce::String& title, juce::AudioProcessorEditor* editor, std::function<void()> onClose)
      : DocumentWindow(title, juce::Colour(0xff0b0c10), DocumentWindow::closeButton),
        m_onClose(std::move(onClose)) {
    setUsingNativeTitleBar(true);
    setContentOwned(editor, true);
    setResizable(editor ? editor->isResizable() : false, false);
    centreWithSize(getWidth(), getHeight());
    setVisible(true);
    toFront(true);
  }

  void closeButtonPressed() override {
    setVisible(false);
    if (m_onClose) m_onClose();
  }

private:
  std::function<void()> m_onClose;
};
#endif

} // namespace

int main(int argc, char* argv[]) {
  bool selfTestCrash = false;
  bool selfTestHang = false;
  for (int i = 1; i < argc; ++i) {
    std::string a = argv[i];
    if (a == "--selftest-crash") selfTestCrash = true;
    else if (a == "--selftest-hang") selfTestHang = true;
  }

  if (selfTestCrash) {
    volatile int* bad = nullptr;
    *bad = 0xDEAD;
    return 139;
  }
  if (selfTestHang) {
    while (true) {
      std::this_thread::sleep_for(std::chrono::seconds(10));
    }
  }

#ifdef JUCE_PLUGINHOST_VST3
  juce::ScopedJuceInitialiser_GUI juceInit;
  juce::VST3PluginFormat vst3;
  std::unique_ptr<juce::AudioPluginInstance> plugin;
  std::unique_ptr<PluginEditorWindow> editorWindow;
  juce::AudioBuffer<float> audioBuf;
  juce::MidiBuffer midiBuf;
  bool bypassed = false;
  double sr = 48000.0;
  int blk = 512;

  auto serializeParams = [](juce::AudioPluginInstance& inst, std::ostringstream& resp) {
    const auto& params = inst.getParameters();
    int maxExport = std::min(params.size(), 256);
    resp << maxExport;
    for (int i = 0; i < maxExport; ++i) {
      auto* p = params[i];
      if (!p) continue;
      float val = p->getValue();
      std::string disp = p->getCurrentValueAsText().toStdString();
      resp << "\t" << i << "|"
           << sanitizeParamToken(p->getName(128).toStdString()) << "|"
           << sanitizeParamToken(p->getLabel().toStdString()) << "|"
           << val << "|"
           << p->getDefaultValue() << "|"
           << p->getNumSteps() << "|"
           << (p->isAutomatable() ? "1" : "0") << "|"
           << (p->isMetaParameter() ? "1" : "0") << "|"
           << ((p == inst.getBypassParameter()) ? "1" : "0") << "|"
           << sanitizeParamToken(disp);
    }
  };

  std::thread commandThread([&]() {
    auto closeEditorAndUnloadOnMsgThread = [&]() {
      struct Ctx {
        std::unique_ptr<PluginEditorWindow>* win;
        std::unique_ptr<juce::AudioPluginInstance>* plug;
      } ctx{&editorWindow, &plugin};
      if (auto* mm = juce::MessageManager::getInstanceWithoutCreating()) {
        mm->callFunctionOnMessageThread([](void* raw) -> void* {
          auto* c = static_cast<Ctx*>(raw);
          c->win->reset();
          if (*c->plug) {
            (*c->plug)->releaseResources();
            c->plug->reset();
          }
          return nullptr;
        }, &ctx);
      }
    };

    std::string line;
    while (std::getline(std::cin, line)) {
      if (!line.empty() && line.back() == '\r') line.pop_back();
      auto cols = splitTabLine(line);
      if (cols.empty()) continue;
      const auto& op = cols[0];

      if (op == "QUIT") {
        closeEditorAndUnloadOnMsgThread();
        std::cout << "OK\tbye\n" << std::flush;
        break;
      }

      if (op == "LOAD") {
        closeEditorAndUnloadOnMsgThread();
        std::string uid = cols.size() > 1 ? cols[1] : "";
        std::string bundlePath = cols.size() > 2 ? cols[2] : "";
        sr = cols.size() > 3 ? std::atof(cols[3].c_str()) : 48000.0;
        blk = std::max(64, cols.size() > 4 ? std::atoi(cols[4].c_str()) : 512);
        int channels = cols.size() > 5 ? std::atoi(cols[5].c_str()) : 2;
        channels = std::clamp(channels, 1, 2);

        struct LoadCtx {
          juce::VST3PluginFormat* fmt;
          std::unique_ptr<juce::AudioPluginInstance>* plug;
          std::string uid;
          std::string bundle;
          double sr;
          int blk;
          int channels;
          std::string name;
          std::string manufacturer;
          std::string err;
          bool ok = false;
        } lctx{&vst3, &plugin, uid, bundlePath, sr, blk, channels, "", "", "", false};

        juce::MessageManager::getInstance()->callFunctionOnMessageThread([](void* raw) -> void* {
          auto* c = static_cast<LoadCtx*>(raw);
          juce::OwnedArray<juce::PluginDescription> descs;
          c->fmt->findAllTypesForFile(descs, juce::String(c->bundle));
          const juce::PluginDescription* chosen = nullptr;
          for (const auto* d : descs) {
            if (d && (c->uid.empty() || d->createIdentifierString().toStdString() == c->uid)) {
              chosen = d;
              break;
            }
          }
          if (!chosen && descs.size() > 0) chosen = descs[0];
          if (!chosen) {
            c->err = "No matching VST3 plugin inside bundle: " + c->bundle;
            return nullptr;
          }
          juce::String loadErr;
          *c->plug = c->fmt->createInstanceFromDescription(*chosen, c->sr, c->blk, loadErr);
          if (!*c->plug) {
            c->err = "VST3 load failed: " + loadErr.toStdString();
            return nullptr;
          }
          (*c->plug)->setPlayConfigDetails(c->channels, c->channels, c->sr, c->blk);
          (*c->plug)->prepareToPlay(c->sr, c->blk);
          c->name = chosen->name.toStdString();
          c->manufacturer = chosen->manufacturerName.toStdString();
          c->ok = true;
          return nullptr;
        }, &lctx);

        if (!lctx.ok || !plugin) {
          std::cout << "ERR\t" << escapeTabField(lctx.err) << "\n" << std::flush;
          continue;
        }

        const int allocCh = std::max({2, channels, plugin->getTotalNumInputChannels(), plugin->getTotalNumOutputChannels()});
        audioBuf.setSize(allocCh, blk * 4);
        bypassed = false;

        std::ostringstream resp;
        resp << "OK\t"
             << escapeTabField(lctx.name) << "\t"
             << escapeTabField(lctx.manufacturer) << "\t"
             << (plugin->hasEditor() ? "1" : "0") << "\t"
             << plugin->getLatencySamples() << "\t"
             << "juce-vst3-worker\t";
        serializeParams(*plugin, resp);
        std::cout << resp.str() << "\n" << std::flush;
        continue;
      }

      if (!plugin) {
        std::cout << "ERR\tNo plugin loaded\n" << std::flush;
        continue;
      }

      if (op == "SETPARAM") {
        int idx = cols.size() > 1 ? std::atoi(cols[1].c_str()) : -1;
        float val = static_cast<float>(cols.size() > 2 ? std::atof(cols[2].c_str()) : 0.0);
        val = std::clamp(val, 0.0f, 1.0f);
        const auto& params = plugin->getParameters();
        if (idx < 0 || idx >= params.size() || !params[idx]) {
          std::cout << "ERR\tInvalid parameter index\n" << std::flush;
          continue;
        }
        params[idx]->setValueNotifyingHost(val);
        std::cout << "OK\t" << escapeTabField(params[idx]->getCurrentValueAsText().toStdString()) << "\n" << std::flush;
        continue;
      }

      if (op == "GETPARAMS") {
        std::ostringstream resp;
        resp << "OK\t";
        serializeParams(*plugin, resp);
        std::cout << resp.str() << "\n" << std::flush;
        continue;
      }

      if (op == "BYPASS") {
        bypassed = cols.size() > 1 && cols[1] == "1";
        if (auto* bp = plugin->getBypassParameter()) {
          bp->setValueNotifyingHost(bypassed ? 1.0f : 0.0f);
        }
        std::cout << "OK\t" << (bypassed ? "1" : "0") << "\n" << std::flush;
        continue;
      }

      if (op == "GETSTATE") {
        juce::MemoryBlock mb;
        plugin->getStateInformation(mb);
        std::string b64 = AudioRouter::encodeBase64(
            static_cast<const uint8_t*>(mb.getData()), mb.getSize());
        std::cout << "OK\t" << b64 << "\n" << std::flush;
        continue;
      }

      if (op == "SETSTATE") {
        std::string b64 = cols.size() > 1 ? cols[1] : "";
        std::vector<uint8_t> raw;
        if (!AudioRouter::decodeBase64(b64, raw)) {
          std::cout << "ERR\tInvalid Base64 state chunk\n" << std::flush;
          continue;
        }
        struct StateCtx {
          juce::AudioPluginInstance* p;
          const void* data;
          int size;
        } sctx{plugin.get(), raw.data(), static_cast<int>(raw.size())};
        juce::MessageManager::getInstance()->callFunctionOnMessageThread([](void* rawPtr) -> void* {
          auto* c = static_cast<StateCtx*>(rawPtr);
          c->p->setStateInformation(c->data, c->size);
          return nullptr;
        }, &sctx);
        std::cout << "OK\trestored\n" << std::flush;
        continue;
      }

      if (op == "OPENEDITOR") {
        if (!plugin->hasEditor()) {
          std::cout << "ERR\tPlugin does not provide a native GUI editor\n" << std::flush;
          continue;
        }
        struct OpenCtx {
          juce::AudioPluginInstance* p;
          std::unique_ptr<PluginEditorWindow>* win;
          bool ok = false;
        } ctx{plugin.get(), &editorWindow, false};
        juce::MessageManager::getInstance()->callFunctionOnMessageThread([](void* rawPtr) -> void* {
          auto* c = static_cast<OpenCtx*>(rawPtr);
          if (!*c->win) {
            if (auto* ed = c->p->createEditorIfNeeded()) {
              *c->win = std::make_unique<PluginEditorWindow>(
                  c->p->getName() + " — SYN-PLUGIN HOST", ed, []() {});
              c->ok = true;
            }
          } else {
            (*c->win)->setVisible(true);
            (*c->win)->toFront(true);
            c->ok = true;
          }
          return nullptr;
        }, &ctx);
        std::cout << (ctx.ok ? "OK\topen\n" : "ERR\tFailed to create plugin editor window\n") << std::flush;
        continue;
      }

      if (op == "CLOSEEDITOR") {
        juce::MessageManager::getInstance()->callFunctionOnMessageThread([](void* ptr) -> void* {
          auto* winPtr = static_cast<std::unique_ptr<PluginEditorWindow>*>(ptr);
          winPtr->reset();
          return nullptr;
        }, &editorWindow);
        std::cout << "OK\tclosed\n" << std::flush;
        continue;
      }

      if (op == "PROCESS") {
        int n = cols.size() > 1 ? std::atoi(cols[1].c_str()) : 0;
        std::vector<float> lIn, rIn;
        if (cols.size() < 4 ||
            !AudioRouter::decodeFloat32Base64(cols[2], lIn) ||
            !AudioRouter::decodeFloat32Base64(cols[3], rIn) ||
            static_cast<int>(lIn.size()) != n || static_cast<int>(rIn.size()) != n) {
          std::cout << "ERR\tInvalid PROCESS block payload\n" << std::flush;
          continue;
        }
        if (!bypassed && n > 0) {
          const int pluginInCh = plugin->getTotalNumInputChannels();
          const int pluginOutCh = plugin->getTotalNumOutputChannels();
          const int procCh = std::max({1, pluginInCh, pluginOutCh});
          if (audioBuf.getNumChannels() < procCh || audioBuf.getNumSamples() < blk) {
            audioBuf.setSize(procCh, std::max(blk, 512), false, false, true);
          }

          int offset = 0;
          while (offset < n) {
            const int chunk = std::min(blk, n - offset);
            audioBuf.clear(0, chunk);
            audioBuf.copyFrom(0, 0, lIn.data() + offset, chunk);
            if (procCh >= 2) {
              audioBuf.copyFrom(1, 0, rIn.data() + offset, chunk);
            }
            midiBuf.clear();
            juce::AudioBuffer<float> slice(audioBuf.getArrayOfWritePointers(), procCh, 0, chunk);
            plugin->processBlock(slice, midiBuf);
            std::copy_n(slice.getReadPointer(0), chunk, lIn.begin() + offset);
            if (procCh >= 2 && pluginOutCh >= 2) {
              std::copy_n(slice.getReadPointer(1), chunk, rIn.begin() + offset);
            } else {
              std::copy_n(slice.getReadPointer(0), chunk, rIn.begin() + offset);
            }
            offset += chunk;
          }
        }
        std::cout << "OK\t" << AudioRouter::encodeFloat32Base64(lIn)
                  << "\t" << AudioRouter::encodeFloat32Base64(rIn)
                  << "\t" << plugin->getLatencySamples() << "\n" << std::flush;
        continue;
      }

      std::cout << "ERR\tUnknown worker command: " << escapeTabField(op) << "\n" << std::flush;
    }

    closeEditorAndUnloadOnMsgThread();
    if (auto* mm = juce::MessageManager::getInstanceWithoutCreating()) {
      mm->stopDispatchLoop();
    }
  });

  juce::MessageManager::getInstance()->runDispatchLoop();
  if (commandThread.joinable()) commandThread.join();
  return 0;

#else
  // Portable C++20 QA Worker Fixture (explicitly labeled as non-VST3 Linux/POSIX QA test harness)
  double gainNorm = 0.5;   // 0.5 -> 0 dB (-24 dB to +24 dB)
  double tiltNorm = 0.5;   // 0.5 -> neutral high-shelf tilt
  bool bypassed = false;
  int latencySamples = 0;
  bool loaded = false;
  std::string loadedUid;
  double lpStateL = 0.0, lpStateR = 0.0;

  auto formatGainDisp = [](double gn) {
    double db = (gn - 0.5) * 48.0;
    std::ostringstream disp;
    disp.precision(1);
    disp << std::fixed << db << " dB";
    return disp.str();
  };
  auto formatTiltDisp = [](double tn) {
    double db = (tn - 0.5) * 12.0;
    std::ostringstream disp;
    disp.precision(1);
    disp << std::fixed << db << " dB";
    return disp.str();
  };

  std::string line;
  while (std::getline(std::cin, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    auto cols = splitTabLine(line);
    if (cols.empty()) continue;
    const auto& op = cols[0];

    if (op == "QUIT") {
      std::cout << "OK\tbye\n" << std::flush;
      break;
    }

    if (op == "LOAD") {
      loadedUid = cols.size() > 1 ? cols[1] : "builtin.qa.gain";
      if (loadedUid.find("crash") != std::string::npos) {
        std::abort();
      }
      if (loadedUid.find("latency") != std::string::npos) {
        latencySamples = 64;
      }
      loaded = true;
      std::cout << "OK\tSYN Portable QA Worker Fixture\tSYN MASTER QA\t0\t"
                << latencySamples << "\tportable-qa-fixture\t2\t"
                << "0|Gain|dB|" << gainNorm << "|0.5|0|1|0|0|" << formatGainDisp(gainNorm) << "\t"
                << "1|Tilt|dB|" << tiltNorm << "|0.5|0|1|0|0|" << formatTiltDisp(tiltNorm) << "\n"
                << std::flush;
      continue;
    }

    if (!loaded) {
      std::cout << "ERR\tNo plugin loaded\n" << std::flush;
      continue;
    }

    if (op == "SETPARAM") {
      int idx = cols.size() > 1 ? std::atoi(cols[1].c_str()) : -1;
      double val = std::clamp(cols.size() > 2 ? std::atof(cols[2].c_str()) : 0.5, 0.0, 1.0);
      if (idx == 0) {
        gainNorm = val;
        std::cout << "OK\t" << formatGainDisp(gainNorm) << "\n" << std::flush;
      } else if (idx == 1) {
        tiltNorm = val;
        std::cout << "OK\t" << formatTiltDisp(tiltNorm) << "\n" << std::flush;
      } else {
        std::cout << "ERR\tInvalid parameter id\n" << std::flush;
      }
      continue;
    }

    if (op == "GETPARAMS") {
      std::cout << "OK\t2\t"
                << "0|Gain|dB|" << gainNorm << "|0.5|0|1|0|0|" << formatGainDisp(gainNorm) << "\t"
                << "1|Tilt|dB|" << tiltNorm << "|0.5|0|1|0|0|" << formatTiltDisp(tiltNorm) << "\n"
                << std::flush;
      continue;
    }

    if (op == "BYPASS") {
      bypassed = cols.size() > 1 && cols[1] == "1";
      std::cout << "OK\t" << (bypassed ? "1" : "0") << "\n" << std::flush;
      continue;
    }

    if (op == "GETSTATE") {
      std::ostringstream ss;
      ss << "QA1:" << gainNorm << ":" << tiltNorm << ":" << (bypassed ? 1 : 0);
      std::string raw = ss.str();
      std::cout << "OK\t" << AudioRouter::encodeBase64(
          reinterpret_cast<const uint8_t*>(raw.data()), raw.size()) << "\n" << std::flush;
      continue;
    }

    if (op == "SETSTATE") {
      std::string b64 = cols.size() > 1 ? cols[1] : "";
      std::vector<uint8_t> raw;
      if (!AudioRouter::decodeBase64(b64, raw)) {
        std::cout << "ERR\tBad base64\n" << std::flush;
        continue;
      }
      std::string s(raw.begin(), raw.end());
      if (s.rfind("QA1:", 0) == 0) {
        std::istringstream iss(s.substr(4));
        std::string g, t, bp;
        if (std::getline(iss, g, ':') && std::getline(iss, t, ':') && std::getline(iss, bp, ':')) {
          gainNorm = std::clamp(std::atof(g.c_str()), 0.0, 1.0);
          tiltNorm = std::clamp(std::atof(t.c_str()), 0.0, 1.0);
          bypassed = (bp == "1");
          std::cout << "OK\trestored\n" << std::flush;
          continue;
        }
      }
      std::cout << "ERR\tMalformed QA state payload\n" << std::flush;
      continue;
    }

    if (op == "OPENEDITOR" || op == "CLOSEEDITOR") {
      std::cout << "ERR\tNative VST3 GUI unavailable in portable Linux QA worker\n" << std::flush;
      continue;
    }

    if (op == "PROCESS") {
      int n = cols.size() > 1 ? std::atoi(cols[1].c_str()) : 0;
      std::vector<float> lIn, rIn;
      if (cols.size() < 4 ||
          !AudioRouter::decodeFloat32Base64(cols[2], lIn) ||
          !AudioRouter::decodeFloat32Base64(cols[3], rIn) ||
          static_cast<int>(lIn.size()) != n || static_cast<int>(rIn.size()) != n) {
        std::cout << "ERR\tInvalid PROCESS block\n" << std::flush;
        continue;
      }
      if (!bypassed) {
        const float linGain = static_cast<float>(std::pow(10.0, ((gainNorm - 0.5) * 48.0) / 20.0));
        const double hfScale = (tiltNorm - 0.5) * 2.0; // -1..+1
        for (int i = 0; i < n; ++i) {
          lpStateL = 0.85 * lpStateL + 0.15 * lIn[static_cast<size_t>(i)];
          lpStateR = 0.85 * lpStateR + 0.15 * rIn[static_cast<size_t>(i)];
          double hfL = lIn[static_cast<size_t>(i)] - lpStateL;
          double hfR = rIn[static_cast<size_t>(i)] - lpStateR;
          lIn[static_cast<size_t>(i)] = static_cast<float>((lIn[static_cast<size_t>(i)] + hfScale * 0.6 * hfL) * linGain);
          rIn[static_cast<size_t>(i)] = static_cast<float>((rIn[static_cast<size_t>(i)] + hfScale * 0.6 * hfR) * linGain);
        }
      }
      std::cout << "OK\t" << AudioRouter::encodeFloat32Base64(lIn)
                << "\t" << AudioRouter::encodeFloat32Base64(rIn)
                << "\t" << latencySamples << "\n" << std::flush;
      continue;
    }

    std::cout << "ERR\tUnknown command\n" << std::flush;
  }
  return 0;
#endif
}
