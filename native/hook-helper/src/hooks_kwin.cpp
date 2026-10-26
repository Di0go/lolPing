// Wayland backend for KDE Plasma: the gestures are decided by lolPing's KWin plugin (native/kwin-plugin), which
// owns the input chain. This side only relays the JSON lines between the app and the plugin's socket.
#include "hooks_kwin.h"
#include <poll.h>
#include <spawn.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>
#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <string>
#include <thread>

extern char** environ;

namespace lp {
namespace {
int connectTo(const std::string& path) {
  sockaddr_un addr{};
  if (path.size() >= sizeof(addr.sun_path)) return -1;
  addr.sun_family = AF_UNIX;
  std::memcpy(addr.sun_path, path.c_str(), path.size() + 1);
  const int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (fd < 0) return -1;
  if (connect(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == 0) return fd;
  close(fd);
  return -1;
}
// The plugin is off by default in KWin; ask KWin to load it (a no-op when it is already loaded).
void loadPlugin() {
  const char* argv[] = {"busctl", "--user", "--quiet", "call", "org.kde.KWin", "/Plugins", "org.kde.KWin.Plugins",
                        "LoadPlugin", "s", "lolping", nullptr};
  pid_t pid;
  if (posix_spawnp(&pid, "busctl", nullptr, nullptr, const_cast<char**>(argv), environ) == 0) waitpid(pid, nullptr, 0);
}
bool writeAll(int fd, const char* data, size_t size) {
  while (size > 0) {
    const ssize_t n = write(fd, data, size);
    if (n <= 0) return false;
    data += n;
    size -= static_cast<size_t>(n);
  }
  return true;
}
}

int relayKWin(Output& out, int in, const KWinRelayOptions& o) {
  int fd = connectTo(o.path);
  if (fd < 0) {
    if (o.loadPlugin) o.loadPlugin();
    for (int i = 0; i < o.startAttempts && fd < 0; ++i) {
      std::this_thread::sleep_for(std::chrono::milliseconds(o.retryMs));
      fd = connectTo(o.path);
    }
  }
  if (fd < 0) {
    out.error("noAccess", "Wayland needs lolPing's KWin plugin (KDE Plasma 6). Install it, or rebuild it after a KWin "
              "update: native/kwin-plugin/build.sh.");
    return 3;
  }
  // The plugin says ready itself; every line it sends is already in the protocol's format.
  std::string fromPlugin;
  char buf[4096];
  auto lost = [&] {
    out.error("The KWin plugin closed the connection; reconnecting");
    close(fd);
    fd = -1;
    fromPlugin.clear();
  };
  auto nextTry = std::chrono::steady_clock::now();
  for (;;) {
    if (fd < 0) {
      // KWin restarted or the plugin was reloaded. The plugin's ready on the new connection makes the app send
      // its state again, so commands that arrive meanwhile are dropped; only the app leaving ends the wait.
      const auto now = std::chrono::steady_clock::now();
      if (now >= nextTry) {
        fd = connectTo(o.path);
        if (fd < 0 && o.loadPlugin) o.loadPlugin();
        nextTry = now + std::chrono::milliseconds(o.reconnectMs);
        if (fd >= 0) continue;
      }
      pollfd p{in, POLLIN, 0};
      const auto wait = std::chrono::duration_cast<std::chrono::milliseconds>(nextTry - now).count();
      const int r = poll(&p, 1, static_cast<int>(std::max<long long>(wait, 0)));
      if (r < 0 && errno != EINTR) return 1;
      if (r > 0 && read(in, buf, sizeof(buf)) <= 0) return 0;
      continue;
    }
    pollfd fds[] = {{fd, POLLIN, 0}, {in, POLLIN, 0}};
    if (poll(fds, 2, -1) < 0) {
      if (errno == EINTR) continue;
      break;
    }
    if (fds[0].revents & (POLLIN | POLLHUP | POLLERR)) {
      const ssize_t n = read(fd, buf, sizeof(buf));
      if (n <= 0) { lost(); continue; }
      fromPlugin.append(buf, static_cast<size_t>(n));
      size_t end;
      while ((end = fromPlugin.find('\n')) != std::string::npos) {
        out.line(fromPlugin.substr(0, end));
        fromPlugin.erase(0, end + 1);
      }
      if (fromPlugin.size() > 65536) { out.error("plugin line too long"); break; }
    }
    if (fds[1].revents & (POLLIN | POLLHUP | POLLERR)) {
      const ssize_t n = read(in, buf, sizeof(buf));
      if (n <= 0) break;  // the app is gone: closing the socket makes the plugin pass everything again
      if (!writeAll(fd, buf, static_cast<size_t>(n))) lost();
    }
  }
  close(fd);
  return 0;
}

int runKWinBridge(Output& out) {
  const char* runtime = std::getenv("XDG_RUNTIME_DIR");
  // The plugin names its socket after KWin's Wayland display, so each KWin (a nested one too) has its own.
  std::string display = std::getenv("WAYLAND_DISPLAY") ? std::getenv("WAYLAND_DISPLAY") : "wayland-0";
  if (const size_t slash = display.rfind('/'); slash != std::string::npos) display.erase(0, slash + 1);
  KWinRelayOptions o;
  o.path = std::string(runtime ? runtime : "/tmp") + "/lolping-kwin-" + display + ".sock";
  o.loadPlugin = loadPlugin;
  return relayKWin(out, STDIN_FILENO, o);
}
}
