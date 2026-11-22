#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace syn::host {

struct ProcessExecutionResult {
  bool launched = false;
  bool exitedNormally = false;
  bool crashed = false;
  bool timedOut = false;
  int exitCode = -1;
  uint32_t nativeExceptionCode = 0;
  std::string stderrTail;
  std::string diagnostic;
};

class ProcessRunner {
public:
  // Executes an external worker binary with arguments in a crash-isolated child process.
  // On Windows: uses CreateProcessW + Job Object (KILL_ON_JOB_CLOSE) + WaitForSingleObject(timeoutMs)
  // and decodes NTSTATUS exception exit codes (e.g., 0xC0000005 STATUS_ACCESS_VIOLATION).
  // On POSIX: uses fork/execvp + waitpid polling with SIGKILL timeout enforcement.
  static ProcessExecutionResult runWithTimeout(
      const std::string& executablePath,
      const std::vector<std::string>& args,
      uint32_t timeoutMs);

  static std::string describeWin32ExitCode(uint32_t code);
};

} // namespace syn::host
