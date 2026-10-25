// context-helper on macOS: reads capture/foreground/ping commands on stdin, one reply line each on stdout.
// A separate process from hook-helper, so a slow or crashing capture never touches the event tap.
#include <unistd.h>

#include <csignal>
#include <iostream>
#include <string>

#include "context.h"

namespace {

bool writeStdout(const std::string& s) {
  const std::string buf = s + "\n";
  size_t done = 0;
  while (done < buf.size()) {
    const ssize_t n = ::write(STDOUT_FILENO, buf.data() + done, buf.size() - done);
    if (n <= 0) return false;
    done += static_cast<size_t>(n);
  }
  return true;
}

}  // namespace

int main() {
  std::signal(SIGPIPE, SIG_IGN);  // a closed pipe makes write() fail instead of killing the process
  const int code = lp::ctx::runContextLoop(std::cin, writeStdout, lp::ctx::nativePlatform());
  // A slow probe's thread may still be inside an Accessibility call: end without exit-time cleanup running under it.
  if (code == lp::ctx::kExitNow) _exit(0);
  return code;
}
