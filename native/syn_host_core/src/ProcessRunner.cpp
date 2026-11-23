#include "syn_host/ProcessRunner.hpp"

#include <sstream>
#include <thread>
#include <chrono>

#ifdef _WIN32
#include <windows.h>
#else
#include <fcntl.h>
#include <signal.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#endif

namespace syn::host {

std::string ProcessRunner::describeWin32ExitCode(uint32_t code) {
  switch (code) {
    case 0xC0000005u: return "STATUS_ACCESS_VIOLATION (0xC0000005)";
    case 0xC000001Du: return "STATUS_ILLEGAL_INSTRUCTION (0xC000001D)";
    case 0xC0000094u: return "STATUS_INTEGER_DIVIDE_BY_ZERO (0xC0000094)";
    case 0xC00000FDu: return "STATUS_STACK_OVERFLOW (0xC00000FD)";
    case 0xC0000135u: return "STATUS_DLL_NOT_FOUND (0xC0000135)";
    case 0xC0000139u: return "STATUS_ENTRYPOINT_NOT_FOUND (0xC0000139)";
    case 0xC0000409u: return "STATUS_STACK_BUFFER_OVERRUN (0xC0000409)";
    case 0xE06D7363u: return "MSVC C++ Unhandled Exception (0xE06D7363)";
    default: break;
  }
  std::ostringstream oss;
  oss << "0x" << std::hex << std::uppercase << code;
  return oss.str();
}

ProcessExecutionResult ProcessRunner::runWithTimeout(
    const std::string& executablePath,
    const std::vector<std::string>& args,
    uint32_t timeoutMs) {
  ProcessExecutionResult result;

#ifdef _WIN32
  auto toWide = [](const std::string& utf8) -> std::wstring {
    if (utf8.empty()) return {};
    int needed = MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), -1, nullptr, 0);
    std::wstring w(static_cast<size_t>(needed > 0 ? needed - 1 : 0), L'\0');
    if (needed > 0) {
      MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), -1, w.data(), needed);
    }
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

  std::wstring cmdLine = quoteArg(toWide(executablePath));
  for (const auto& a : args) {
    cmdLine += L" ";
    cmdLine += quoteArg(toWide(a));
  }

  HANDLE hJob = CreateJobObjectW(nullptr, nullptr);
  if (hJob) {
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION jeli{};
    jeli.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    SetInformationJobObject(hJob, JobObjectExtendedLimitInformation, &jeli, sizeof(jeli));
  }

  STARTUPINFOW si{};
  si.cb = sizeof(si);
  PROCESS_INFORMATION pi{};

  BOOL created = CreateProcessW(
      nullptr,
      cmdLine.data(),
      nullptr,
      nullptr,
      FALSE,
      CREATE_NO_WINDOW | CREATE_SUSPENDED,
      nullptr,
      nullptr,
      &si,
      &pi);

  if (!created) {
    if (hJob) CloseHandle(hJob);
    result.launched = false;
    result.diagnostic = "CreateProcessW failed with error " + std::to_string(GetLastError());
    return result;
  }

  result.launched = true;
  if (hJob) {
    AssignProcessToJobObject(hJob, pi.hProcess);
  }
  ResumeThread(pi.hThread);
  CloseHandle(pi.hThread);

  DWORD waitRes = WaitForSingleObject(pi.hProcess, timeoutMs);
  if (waitRes == WAIT_TIMEOUT) {
    result.timedOut = true;
    TerminateProcess(pi.hProcess, 0xDEAD0001u);
    WaitForSingleObject(pi.hProcess, 2000);
    result.exitCode = -1;
    result.diagnostic = "Scanner process exceeded timeout (" + std::to_string(timeoutMs) + " ms) and was terminated";
  } else {
    DWORD exitCode = 0;
    GetExitCodeProcess(pi.hProcess, &exitCode);
    result.exitCode = static_cast<int>(exitCode);
    // Windows fatal NTSTATUS / SEH exceptions always have bit 31 (or 0xC0000000+) set
    if (exitCode >= 0x80000000u) {
      result.crashed = true;
      result.nativeExceptionCode = exitCode;
      result.diagnostic = "Scanner process crashed: " + describeWin32ExitCode(exitCode);
    } else if (exitCode == 0) {
      result.exitedNormally = true;
      result.diagnostic = "Scanner exited cleanly (0)";
    } else {
      result.diagnostic = "Scanner exited with non-zero code " + std::to_string(exitCode);
    }
  }

  CloseHandle(pi.hProcess);
  if (hJob) CloseHandle(hJob);
  return result;
#else
  int pipefd[2]{-1, -1};
  if (pipe(pipefd) != 0) {
    result.diagnostic = "Failed to create diagnostic pipe";
    return result;
  }

  pid_t pid = fork();
  if (pid < 0) {
    close(pipefd[0]);
    close(pipefd[1]);
    result.diagnostic = "fork() failed";
    return result;
  }

  if (pid == 0) {
    close(pipefd[0]);
    dup2(pipefd[1], STDERR_FILENO);
    close(pipefd[1]);
    std::vector<char*> argv;
    argv.push_back(const_cast<char*>(executablePath.c_str()));
    for (const auto& a : args) {
      argv.push_back(const_cast<char*>(a.c_str()));
    }
    argv.push_back(nullptr);
    execvp(executablePath.c_str(), argv.data());
    _exit(127);
  }

  close(pipefd[1]);
  fcntl(pipefd[0], F_SETFL, O_NONBLOCK);
  result.launched = true;

  auto start = std::chrono::steady_clock::now();
  int status = 0;
  bool finished = false;
  while (true) {
    pid_t wp = waitpid(pid, &status, WNOHANG);
    if (wp == pid) {
      finished = true;
      break;
    }
    if (wp < 0) break;

    auto elapsedMs = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - start).count();
    if (elapsedMs >= static_cast<long long>(timeoutMs)) {
      result.timedOut = true;
      kill(pid, SIGKILL);
      waitpid(pid, &status, 0);
      result.diagnostic = "Scanner process exceeded timeout (" + std::to_string(timeoutMs) + " ms) and was killed";
      break;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(15));
  }

  char buf[512];
  ssize_t n = 0;
  while ((n = read(pipefd[0], buf, sizeof(buf))) > 0) {
    if (result.stderrTail.size() < 2048) {
      result.stderrTail.append(buf, static_cast<size_t>(n));
    }
  }
  close(pipefd[0]);

  if (finished && !result.timedOut) {
    if (WIFSIGNALED(status)) {
      int sig = WTERMSIG(status);
      result.crashed = true;
      result.exitCode = 128 + sig;
      result.nativeExceptionCode = static_cast<uint32_t>(sig);
      result.diagnostic = "Scanner terminated by signal " + std::to_string(sig);
    } else if (WIFEXITED(status)) {
      result.exitCode = WEXITSTATUS(status);
      if (result.exitCode == 0) {
        result.exitedNormally = true;
        result.diagnostic = "Scanner exited cleanly (0)";
      } else {
        result.diagnostic = "Scanner exited with status " + std::to_string(result.exitCode);
      }
    }
  }
  return result;
#endif
}

} // namespace syn::host
