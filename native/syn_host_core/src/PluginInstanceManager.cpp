// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 LIL SYNN / SYN-MASTER. Part of the SYN-MASTER VST companion (native/).
#include "syn_host/PluginInstanceManager.hpp"
#include "syn_host/AudioRouter.hpp"
#include "syn_host/ProcessRunner.hpp"

#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <sstream>
#include <thread>

#ifdef _WIN32
#include <windows.h>
#else
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#endif

namespace syn::host {

namespace {

// Minimal dependency-free key=value / pipe-safe single-line IPC helpers
std::string escapeField(const std::string& s) {
  std::string out;
  out.reserve(s.size() + 8);
  for (char c : s) {
    if (c == '\\') out += "\\\\";
    else if (c == '\t') out += "\\t";
    else if (c == '\n') out += "\\n";
    else if (c == '\r') out += "\\r";
    else out.push_back(c);
  }
  return out;
}

std::string unescapeField(const std::string& s) {
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

std::vector<std::string> splitTabs(const std::string& line) {
  std::vector<std::string> parts;
  size_t start = 0;
  while (true) {
    size_t pos = line.find('\t', start);
    if (pos == std::string::npos) {
      parts.push_back(unescapeField(line.substr(start)));
      break;
    }
    parts.push_back(unescapeField(line.substr(start, pos - start)));
    start = pos + 1;
  }
  return parts;
}

} // namespace

struct PluginInstanceManager::WorkerSession {
  PluginInstanceInfo info;
  std::mutex ioMutex;
  std::string readRemainder;
  bool alive = false;

#ifdef _WIN32
  HANDLE hProcess = nullptr;
  HANDLE hJob = nullptr;
  HANDLE hChildStdinWrite = nullptr;
  HANDLE hChildStdoutRead = nullptr;
#else
  pid_t pid = -1;
  int toChildFd = -1;
  int fromChildFd = -1;
#endif

  ~WorkerSession() {
    terminate();
  }

  bool spawn(const std::string& exePath, const std::vector<std::string>& args, std::string& errOut) {
#ifdef _WIN32
    auto toWide = [](const std::string& utf8) -> std::wstring {
      if (utf8.empty()) return {};
      int needed = MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), -1, nullptr, 0);
      std::wstring w(static_cast<size_t>(needed > 0 ? needed - 1 : 0), L'\0');
      if (needed > 0) MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), -1, w.data(), needed);
      return w;
    };
    auto quoteArg = [](const std::wstring& a) -> std::wstring {
      std::wstring q = L"\"";
      for (wchar_t c : a) {
        if (c == L'"') q += L"\\\"";
        else q.push_back(c);
      }
      q.push_back(L'"');
      return q;
    };

    SECURITY_ATTRIBUTES sa{};
    sa.nLength = sizeof(sa);
    sa.bInheritHandle = TRUE;

    HANDLE hStdinRead = nullptr, hStdinWrite = nullptr;
    HANDLE hStdoutRead = nullptr, hStdoutWrite = nullptr;
    if (!CreatePipe(&hStdinRead, &hStdinWrite, &sa, 262144) ||
        !CreatePipe(&hStdoutRead, &hStdoutWrite, &sa, 262144)) {
      errOut = "Failed to create worker pipes";
      return false;
    }
    SetHandleInformation(hStdinWrite, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(hStdoutRead, HANDLE_FLAG_INHERIT, 0);

    std::wstring cmdLine = quoteArg(toWide(exePath));
    for (const auto& a : args) {
      cmdLine += L" ";
      cmdLine += quoteArg(toWide(a));
    }

    hJob = CreateJobObjectW(nullptr, nullptr);
    if (hJob) {
      JOBOBJECT_EXTENDED_LIMIT_INFORMATION jeli{};
      jeli.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      SetInformationJobObject(hJob, JobObjectExtendedLimitInformation, &jeli, sizeof(jeli));
    }

    STARTUPINFOW si{};
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = hStdinRead;
    si.hStdOutput = hStdoutWrite;
    si.hStdError = GetStdHandle(STD_ERROR_HANDLE);

    PROCESS_INFORMATION pi{};
    BOOL ok = CreateProcessW(
        nullptr, cmdLine.data(), nullptr, nullptr, TRUE,
        CREATE_NO_WINDOW | CREATE_SUSPENDED, nullptr, nullptr, &si, &pi);

    CloseHandle(hStdinRead);
    CloseHandle(hStdoutWrite);

    if (!ok) {
      CloseHandle(hStdinWrite);
      CloseHandle(hStdoutRead);
      if (hJob) { CloseHandle(hJob); hJob = nullptr; }
      errOut = "CreateProcessW worker launch failed: " + std::to_string(GetLastError());
      return false;
    }

    if (hJob) AssignProcessToJobObject(hJob, pi.hProcess);
    ResumeThread(pi.hThread);
    CloseHandle(pi.hThread);

    hProcess = pi.hProcess;
    hChildStdinWrite = hStdinWrite;
    hChildStdoutRead = hStdoutRead;
    alive = true;
    return true;
#else
    int inPipe[2]{-1, -1};
    int outPipe[2]{-1, -1};
    if (pipe(inPipe) != 0 || pipe(outPipe) != 0) {
      errOut = "pipe() failed for worker";
      return false;
    }

    pid = fork();
    if (pid < 0) {
      close(inPipe[0]); close(inPipe[1]);
      close(outPipe[0]); close(outPipe[1]);
      errOut = "fork() failed for worker";
      return false;
    }

    if (pid == 0) {
      dup2(inPipe[0], STDIN_FILENO);
      dup2(outPipe[1], STDOUT_FILENO);
      close(inPipe[0]); close(inPipe[1]);
      close(outPipe[0]); close(outPipe[1]);
      std::vector<char*> argv;
      argv.push_back(const_cast<char*>(exePath.c_str()));
      for (const auto& a : args) argv.push_back(const_cast<char*>(a.c_str()));
      argv.push_back(nullptr);
      execvp(exePath.c_str(), argv.data());
      _exit(127);
    }

    close(inPipe[0]);
    close(outPipe[1]);
    toChildFd = inPipe[1];
    fromChildFd = outPipe[0];
    fcntl(fromChildFd, F_SETFL, O_NONBLOCK);
    alive = true;
    return true;
#endif
  }

  void terminate() {
#ifdef _WIN32
    if (hChildStdinWrite) { CloseHandle(hChildStdinWrite); hChildStdinWrite = nullptr; }
    if (hChildStdoutRead) { CloseHandle(hChildStdoutRead); hChildStdoutRead = nullptr; }
    if (hProcess) {
      TerminateProcess(hProcess, 0);
      WaitForSingleObject(hProcess, 1000);
      CloseHandle(hProcess);
      hProcess = nullptr;
    }
    if (hJob) { CloseHandle(hJob); hJob = nullptr; }
#else
    if (toChildFd >= 0) { close(toChildFd); toChildFd = -1; }
    if (fromChildFd >= 0) { close(fromChildFd); fromChildFd = -1; }
    if (pid > 0) {
      int st = 0;
      if (waitpid(pid, &st, WNOHANG) == 0) {
        kill(pid, SIGKILL);
        waitpid(pid, &st, 0);
      }
      pid = -1;
    }
#endif
    alive = false;
  }

  bool sendCommand(
      const std::string& line,
      std::string& responseLine,
      uint32_t timeoutMs,
      bool& outCrashed,
      std::string& errOut) {
    std::lock_guard<std::mutex> lock(ioMutex);
    outCrashed = false;
    if (!alive) {
      outCrashed = true;
      errOut = "Worker process is not running";
      return false;
    }

    std::string packet = line + "\n";
#ifdef _WIN32
    size_t sent = 0;
    while (sent < packet.size()) {
      DWORD chunk = 0;
      if (!WriteFile(hChildStdinWrite, packet.data() + sent,
                     static_cast<DWORD>(packet.size() - sent), &chunk, nullptr) || chunk == 0) {
        outCrashed = true;
        errOut = "Worker pipe write failed (worker crashed or exited)";
        checkChildCrash(errOut);
        terminate();
        return false;
      }
      sent += chunk;
    }

    auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
    while (true) {
      auto nl = readRemainder.find('\n');
      if (nl != std::string::npos) {
        responseLine = readRemainder.substr(0, nl);
        readRemainder.erase(0, nl + 1);
        if (!responseLine.empty() && responseLine.back() == '\r') responseLine.pop_back();
        return true;
      }

      DWORD avail = 0;
      if (!PeekNamedPipe(hChildStdoutRead, nullptr, 0, nullptr, &avail, nullptr)) {
        outCrashed = true;
        errOut = "Worker stdout closed unexpectedly";
        checkChildCrash(errOut);
        terminate();
        return false;
      }

      if (avail > 0) {
        char buf[8192];
        DWORD got = 0;
        if (ReadFile(hChildStdoutRead, buf, std::min<DWORD>(avail, sizeof(buf)), &got, nullptr) && got > 0) {
          readRemainder.append(buf, got);
          continue;
        }
      }

      DWORD exitCode = STILL_ACTIVE;
      if (GetExitCodeProcess(hProcess, &exitCode) && exitCode != STILL_ACTIVE) {
        outCrashed = true;
        errOut = "Worker exited unexpectedly: " + ProcessRunner::describeWin32ExitCode(exitCode);
        terminate();
        return false;
      }

      if (std::chrono::steady_clock::now() >= deadline) {
        outCrashed = true;
        errOut = "Worker command exceeded timeout (" + std::to_string(timeoutMs) + " ms) — terminated";
        terminate();
        return false;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
#else
    size_t sent = 0;
    while (sent < packet.size()) {
      ssize_t w = write(toChildFd, packet.data() + sent, packet.size() - sent);
      if (w <= 0) {
        if (w < 0 && errno == EINTR) continue;
        outCrashed = true;
        errOut = "Worker pipe write failed";
        checkChildCrash(errOut);
        terminate();
        return false;
      }
      sent += static_cast<size_t>(w);
    }

    auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
    while (true) {
      auto nl = readRemainder.find('\n');
      if (nl != std::string::npos) {
        responseLine = readRemainder.substr(0, nl);
        readRemainder.erase(0, nl + 1);
        return true;
      }

      auto now = std::chrono::steady_clock::now();
      if (now >= deadline) {
        outCrashed = true;
        errOut = "Worker exceeded timeout (" + std::to_string(timeoutMs) + " ms) and was killed";
        terminate();
        return false;
      }

      int waitMs = static_cast<int>(
          std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now).count());
      struct pollfd pfd{fromChildFd, POLLIN, 0};
      int pr = poll(&pfd, 1, std::min(waitMs, 25));
      if (pr > 0) {
        char buf[8192];
        ssize_t got = read(fromChildFd, buf, sizeof(buf));
        if (got > 0) {
          readRemainder.append(buf, static_cast<size_t>(got));
          continue;
        }
        if (got == 0) {
          outCrashed = true;
          errOut = "Worker closed stdout (process crashed or exited)";
          checkChildCrash(errOut);
          terminate();
          return false;
        }
      }

      int st = 0;
      if (waitpid(pid, &st, WNOHANG) == pid) {
        outCrashed = true;
        if (WIFSIGNALED(st)) {
          errOut = "Worker crashed with signal " + std::to_string(WTERMSIG(st));
        } else {
          errOut = "Worker exited with code " + std::to_string(WEXITSTATUS(st));
        }
        terminate();
        return false;
      }
    }
#endif
  }

  void checkChildCrash(std::string& errOut) {
#ifdef _WIN32
    if (!hProcess) return;
    WaitForSingleObject(hProcess, 250);
    DWORD exitCode = 0;
    if (GetExitCodeProcess(hProcess, &exitCode) && exitCode >= 0x80000000u) {
      errOut = "Worker crashed: " + ProcessRunner::describeWin32ExitCode(exitCode);
    }
#else
    if (pid <= 0) return;
    int st = 0;
    if (waitpid(pid, &st, 0) == pid && WIFSIGNALED(st)) {
      errOut = "Worker terminated by signal " + std::to_string(WTERMSIG(st));
    }
#endif
  }
};

PluginInstanceManager::PluginInstanceManager(std::string workerBinaryPath)
    : m_workerBinaryPath(std::move(workerBinaryPath)) {}

PluginInstanceManager::~PluginInstanceManager() {
  unloadAll();
}

void PluginInstanceManager::setWorkerBinaryPath(std::string path) {
  std::lock_guard<std::mutex> lock(m_mutex);
  m_workerBinaryPath = std::move(path);
}

bool PluginInstanceManager::loadPlugin(
    const std::string& uid,
    const std::string& bundlePath,
    double sampleRate,
    int blockSize,
    int channels,
    PluginInstanceInfo& outInfo,
    std::string& errorOut,
    bool injectCrash,
    bool injectHang) {
  if (m_workerBinaryPath.empty()) {
    errorOut = "Worker executable path not configured";
    return false;
  }

  auto session = std::make_shared<WorkerSession>();
  std::string instanceId;
  {
    std::lock_guard<std::mutex> lock(m_mutex);
    instanceId = "inst_" + std::to_string(m_nextId++);
  }

  std::vector<std::string> args;
  if (injectCrash) args.emplace_back("--selftest-crash");
  if (injectHang) args.emplace_back("--selftest-hang");

  if (!session->spawn(m_workerBinaryPath, args, errorOut)) {
    return false;
  }

  std::ostringstream cmd;
  cmd << "LOAD\t" << escapeField(uid) << "\t" << escapeField(bundlePath) << "\t"
      << sampleRate << "\t" << blockSize << "\t" << channels;

  std::string resp;
  bool crashed = false;
  if (!session->sendCommand(cmd.str(), resp, 8000, crashed, errorOut)) {
    return false;
  }

  auto cols = splitTabs(resp);
  if (cols.empty() || cols[0] != "OK") {
    errorOut = cols.size() > 1 ? cols[1] : ("Unexpected worker response: " + resp);
    return false;
  }

  // Format: OK \t name \t manufacturer \t hasEditor(0/1) \t latencySamples \t engine \t paramCount [\t id|name|label|val|def|steps|auto|ro|bypass|disp ...]
  session->info.instanceId = instanceId;
  session->info.uid = uid;
  session->info.bundlePath = bundlePath;
  session->info.sampleRate = sampleRate;
  session->info.blockSize = blockSize;
  session->info.channels = channels;
  session->info.active = true;
  session->info.crashed = false;
  session->info.bypassed = false;
  session->info.name = cols.size() > 1 ? cols[1] : uid;
  session->info.manufacturer = cols.size() > 2 ? cols[2] : "Unknown";
  session->info.hasEditor = cols.size() > 3 && cols[3] == "1";
  session->info.latencySamples = cols.size() > 4 ? std::atoi(cols[4].c_str()) : 0;
  session->info.workerEngine = cols.size() > 5 ? cols[5] : "juce-vst3-worker";

  int paramCount = cols.size() > 6 ? std::atoi(cols[6].c_str()) : 0;
  for (int i = 0; i < paramCount && (7 + i) < static_cast<int>(cols.size()); ++i) {
    const auto& rawP = cols[static_cast<size_t>(7 + i)];
    std::vector<std::string> fields;
    size_t s = 0;
    while (true) {
      size_t bar = rawP.find('|', s);
      if (bar == std::string::npos) {
        fields.push_back(rawP.substr(s));
        break;
      }
      fields.push_back(rawP.substr(s, bar - s));
      s = bar + 1;
    }
    if (fields.size() >= 6) {
      ParameterValue pv;
      pv.id = static_cast<uint32_t>(std::strtoul(fields[0].c_str(), nullptr, 10));
      pv.name = fields[1];
      pv.label = fields[2];
      pv.valueNormalized = std::atof(fields[3].c_str());
      pv.defaultValueNormalized = std::atof(fields[4].c_str());
      pv.stepCount = std::atoi(fields[5].c_str());
      pv.isAutomatable = fields.size() > 6 ? (fields[6] == "1") : true;
      pv.isReadOnly = fields.size() > 7 ? (fields[7] == "1") : false;
      pv.isBypass = fields.size() > 8 ? (fields[8] == "1") : false;
      pv.displayValue = fields.size() > 9 ? fields[9] : "";
      session->info.parameters.push_back(std::move(pv));
    }
  }

  outInfo = session->info;
  {
    std::lock_guard<std::mutex> lock(m_mutex);
    m_sessions[instanceId] = session;
  }
  return true;
}

bool PluginInstanceManager::unloadPlugin(const std::string& instanceId, std::string& errorOut) {
  std::shared_ptr<WorkerSession> session;
  {
    std::lock_guard<std::mutex> lock(m_mutex);
    auto it = m_sessions.find(instanceId);
    if (it == m_sessions.end()) {
      errorOut = "Unknown plugin instance: " + instanceId;
      return false;
    }
    session = it->second;
    m_sessions.erase(it);
  }
  if (session->alive) {
    std::string dummy;
    bool crashed = false;
    std::string err;
    session->sendCommand("QUIT", dummy, 500, crashed, err);
  }
  session->terminate();
  return true;
}

void PluginInstanceManager::unloadAll() {
  std::unordered_map<std::string, std::shared_ptr<WorkerSession>> copy;
  {
    std::lock_guard<std::mutex> lock(m_mutex);
    copy.swap(m_sessions);
  }
  for (auto& [_, session] : copy) {
    if (session) session->terminate();
  }
}

std::optional<PluginInstanceInfo> PluginInstanceManager::getInstance(const std::string& instanceId) const {
  std::lock_guard<std::mutex> lock(m_mutex);
  auto it = m_sessions.find(instanceId);
  if (it == m_sessions.end() || !it->second) return std::nullopt;
  return it->second->info;
}

std::vector<PluginInstanceInfo> PluginInstanceManager::listInstances() const {
  std::lock_guard<std::mutex> lock(m_mutex);
  std::vector<PluginInstanceInfo> out;
  out.reserve(m_sessions.size());
  for (const auto& [_, session] : m_sessions) {
    if (session) out.push_back(session->info);
  }
  return out;
}

bool PluginInstanceManager::setParameter(
    const std::string& instanceId,
    uint32_t paramId,
    double normalizedValue,
    std::string& displayValueOut,
    std::string& errorOut) {
  std::shared_ptr<WorkerSession> session;
  {
    std::lock_guard<std::mutex> lock(m_mutex);
    auto it = m_sessions.find(instanceId);
    if (it == m_sessions.end()) { errorOut = "Unknown instance"; return false; }
    session = it->second;
  }

  normalizedValue = std::clamp(normalizedValue, 0.0, 1.0);
  std::ostringstream cmd;
  cmd << "SETPARAM\t" << paramId << "\t" << normalizedValue;
  std::string resp;
  bool crashed = false;
  if (!session->sendCommand(cmd.str(), resp, 3000, crashed, errorOut)) {
    std::lock_guard<std::mutex> lock(m_mutex);
    if (crashed) { session->info.crashed = true; session->info.active = false; session->info.lastError = errorOut; }
    return false;
  }

  auto cols = splitTabs(resp);
  if (cols.empty() || cols[0] != "OK") {
    errorOut = cols.size() > 1 ? cols[1] : "Failed to set parameter";
    return false;
  }
  displayValueOut = cols.size() > 1 ? cols[1] : "";

  std::lock_guard<std::mutex> lock(m_mutex);
  for (auto& p : session->info.parameters) {
    if (p.id == paramId) {
      p.valueNormalized = normalizedValue;
      p.displayValue = displayValueOut;
      break;
    }
  }
  return true;
}

bool PluginInstanceManager::getParameters(
    const std::string& instanceId,
    std::vector<ParameterValue>& paramsOut,
    std::string& errorOut) {
  std::shared_ptr<WorkerSession> session;
  {
    std::lock_guard<std::mutex> lock(m_mutex);
    auto it = m_sessions.find(instanceId);
    if (it == m_sessions.end()) { errorOut = "Unknown instance"; return false; }
    session = it->second;
  }

  std::string resp;
  bool crashed = false;
  if (session->alive && session->sendCommand("GETPARAMS", resp, 3000, crashed, errorOut)) {
    auto cols = splitTabs(resp);
    if (cols.size() >= 2 && cols[0] == "OK") {
      int paramCount = std::atoi(cols[1].c_str());
      std::vector<ParameterValue> refreshed;
      for (int i = 0; i < paramCount && (2 + i) < static_cast<int>(cols.size()); ++i) {
        const auto& rawP = cols[static_cast<size_t>(2 + i)];
        std::vector<std::string> fields;
        size_t s = 0;
        while (true) {
          size_t bar = rawP.find('|', s);
          if (bar == std::string::npos) {
            fields.push_back(rawP.substr(s));
            break;
          }
          fields.push_back(rawP.substr(s, bar - s));
          s = bar + 1;
        }
        if (fields.size() >= 6) {
          ParameterValue pv;
          pv.id = static_cast<uint32_t>(std::strtoul(fields[0].c_str(), nullptr, 10));
          pv.name = fields[1];
          pv.label = fields[2];
          pv.valueNormalized = std::atof(fields[3].c_str());
          pv.defaultValueNormalized = std::atof(fields[4].c_str());
          pv.stepCount = std::atoi(fields[5].c_str());
          pv.isAutomatable = fields.size() > 6 ? (fields[6] == "1") : true;
          pv.isReadOnly = fields.size() > 7 ? (fields[7] == "1") : false;
          pv.isBypass = fields.size() > 8 ? (fields[8] == "1") : false;
          pv.displayValue = fields.size() > 9 ? fields[9] : "";
          refreshed.push_back(std::move(pv));
        }
      }
      std::lock_guard<std::mutex> lock(m_mutex);
      session->info.parameters = refreshed;
      paramsOut = std::move(refreshed);
      return true;
    }
  } else if (crashed) {
    std::lock_guard<std::mutex> lock(m_mutex);
    session->info.crashed = true;
    session->info.active = false;
    session->info.lastError = errorOut;
    return false;
  }

  std::lock_guard<std::mutex> lock(m_mutex);
  paramsOut = session->info.parameters;
  return true;
}

bool PluginInstanceManager::setBypass(const std::string& instanceId, bool bypassed, std::string& errorOut) {
  std::shared_ptr<WorkerSession> session;
  {
    std::lock_guard<std::mutex> lock(m_mutex);
    auto it = m_sessions.find(instanceId);
    if (it == m_sessions.end()) { errorOut = "Unknown instance"; return false; }
    session = it->second;
  }

  std::string resp;
  bool crashed = false;
  if (!session->sendCommand(bypassed ? "BYPASS\t1" : "BYPASS\t0", resp, 2000, crashed, errorOut)) {
    std::lock_guard<std::mutex> lock(m_mutex);
    if (crashed) { session->info.crashed = true; session->info.active = false; session->info.lastError = errorOut; }
    return false;
  }
  auto cols = splitTabs(resp);
  if (cols.empty() || cols[0] != "OK") {
    errorOut = cols.size() > 1 ? cols[1] : "Bypass failed";
    return false;
  }
  std::lock_guard<std::mutex> lock(m_mutex);
  session->info.bypassed = bypassed;
  return true;
}

bool PluginInstanceManager::getStateBase64(
    const std::string& instanceId,
    std::string& stateBase64Out,
    std::string& errorOut) {
  std::shared_ptr<WorkerSession> session;
  {
    std::lock_guard<std::mutex> lock(m_mutex);
    auto it = m_sessions.find(instanceId);
    if (it == m_sessions.end()) { errorOut = "Unknown instance"; return false; }
    session = it->second;
  }
  std::string resp;
  bool crashed = false;
  if (!session->sendCommand("GETSTATE", resp, 3000, crashed, errorOut)) {
    std::lock_guard<std::mutex> lock(m_mutex);
    if (crashed) { session->info.crashed = true; session->info.active = false; session->info.lastError = errorOut; }
    return false;
  }
  auto cols = splitTabs(resp);
  if (cols.empty() || cols[0] != "OK") {
    errorOut = cols.size() > 1 ? cols[1] : "getState failed";
    return false;
  }
  stateBase64Out = cols.size() > 1 ? cols[1] : "";
  return true;
}

bool PluginInstanceManager::setStateBase64(
    const std::string& instanceId,
    const std::string& stateBase64,
    std::string& errorOut) {
  std::shared_ptr<WorkerSession> session;
  {
    std::lock_guard<std::mutex> lock(m_mutex);
    auto it = m_sessions.find(instanceId);
    if (it == m_sessions.end()) { errorOut = "Unknown instance"; return false; }
    session = it->second;
  }
  std::string resp;
  bool crashed = false;
  if (!session->sendCommand("SETSTATE\t" + escapeField(stateBase64), resp, 3000, crashed, errorOut)) {
    std::lock_guard<std::mutex> lock(m_mutex);
    if (crashed) { session->info.crashed = true; session->info.active = false; session->info.lastError = errorOut; }
    return false;
  }
  auto cols = splitTabs(resp);
  if (cols.empty() || cols[0] != "OK") {
    errorOut = cols.size() > 1 ? cols[1] : "setState failed";
    return false;
  }
  std::vector<ParameterValue> refreshed;
  std::string refreshErr;
  getParameters(instanceId, refreshed, refreshErr);
  return true;
}

bool PluginInstanceManager::openEditor(const std::string& instanceId, std::string& errorOut) {
  std::shared_ptr<WorkerSession> session;
  {
    std::lock_guard<std::mutex> lock(m_mutex);
    auto it = m_sessions.find(instanceId);
    if (it == m_sessions.end()) { errorOut = "Unknown instance"; return false; }
    session = it->second;
  }
  std::string resp;
  bool crashed = false;
  if (!session->sendCommand("OPENEDITOR", resp, 4000, crashed, errorOut)) {
    std::lock_guard<std::mutex> lock(m_mutex);
    if (crashed) { session->info.crashed = true; session->info.active = false; session->info.lastError = errorOut; }
    return false;
  }
  auto cols = splitTabs(resp);
  if (cols.empty() || cols[0] != "OK") {
    errorOut = cols.size() > 1 ? cols[1] : "Failed to open editor";
    return false;
  }
  std::lock_guard<std::mutex> lock(m_mutex);
  session->info.editorOpen = true;
  return true;
}

bool PluginInstanceManager::closeEditor(const std::string& instanceId, std::string& errorOut) {
  std::shared_ptr<WorkerSession> session;
  {
    std::lock_guard<std::mutex> lock(m_mutex);
    auto it = m_sessions.find(instanceId);
    if (it == m_sessions.end()) { errorOut = "Unknown instance"; return false; }
    session = it->second;
  }
  std::string resp;
  bool crashed = false;
  if (!session->sendCommand("CLOSEEDITOR", resp, 4000, crashed, errorOut)) {
    std::lock_guard<std::mutex> lock(m_mutex);
    if (crashed) { session->info.crashed = true; session->info.active = false; session->info.lastError = errorOut; }
    return false;
  }
  auto cols = splitTabs(resp);
  if (cols.empty() || cols[0] != "OK") {
    errorOut = cols.size() > 1 ? cols[1] : "Failed to close editor";
    return false;
  }
  std::lock_guard<std::mutex> lock(m_mutex);
  session->info.editorOpen = false;
  return true;
}

InstanceProcessResult PluginInstanceManager::processBlock(
    const std::string& instanceId,
    std::vector<float>& left,
    std::vector<float>& right,
    uint32_t timeoutMs) {
  InstanceProcessResult res;
  std::shared_ptr<WorkerSession> session;
  {
    std::lock_guard<std::mutex> lock(m_mutex);
    auto it = m_sessions.find(instanceId);
    if (it == m_sessions.end()) {
      res.error = "Unknown instance: " + instanceId;
      return res;
    }
    session = it->second;
  }

  if (session->info.crashed || !session->alive) {
    res.crashed = true;
    res.error = session->info.lastError.empty() ? "Worker crashed" : session->info.lastError;
    return res;
  }

  if (session->info.bypassed) {
    res.ok = true;
    res.latencySamples = 0;
    return res;
  }

  std::ostringstream cmd;
  cmd << "PROCESS\t" << left.size() << "\t"
      << AudioRouter::encodeFloat32Base64(left) << "\t"
      << AudioRouter::encodeFloat32Base64(right);

  std::string resp;
  bool crashed = false;
  std::string err;
  if (!session->sendCommand(cmd.str(), resp, timeoutMs, crashed, err)) {
    std::lock_guard<std::mutex> lock(m_mutex);
    if (crashed) {
      session->info.crashed = true;
      session->info.active = false;
      session->info.lastError = err;
    }
    res.crashed = crashed;
    res.error = err;
    return res;
  }

  auto cols = splitTabs(resp);
  if (cols.size() < 3 || cols[0] != "OK") {
    res.error = cols.size() > 1 ? cols[1] : "Worker processBlock error";
    return res;
  }

  std::vector<float> outL, outR;
  if (!AudioRouter::decodeFloat32Base64(cols[1], outL) ||
      !AudioRouter::decodeFloat32Base64(cols[2], outR) ||
      outL.size() != left.size() || outR.size() != right.size()) {
    res.error = "Corrupted audio payload returned by worker";
    return res;
  }

  left = std::move(outL);
  right = std::move(outR);
  res.ok = true;
  res.latencySamples = cols.size() > 3 ? std::atoi(cols[3].c_str()) : session->info.latencySamples;
  return res;
}

} // namespace syn::host
