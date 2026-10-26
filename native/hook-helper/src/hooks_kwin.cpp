// Wayland backend for KDE Plasma: the gestures are decided by lolPing's KWin plugin (native/kwin-plugin), which
// owns the input chain. This side only relays the JSON lines between the app and the plugin's socket.
#include "hooks_kwin.h"
#include <poll.h>
#include <spawn.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>
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

int runKWinBridge(Output& out) {
  const char* runtime = std::getenv("XDG_RUNTIME_DIR");
  // The plugin names its socket after KWin's Wayland display, so each KWin (a nested one too) has its own.
  std::string display = std::getenv("WAYLAND_DISPLAY") ? std::getenv("WAYLAND_DISPLAY") : "wayland-0";
  if (const size_t slash = display.rfind('/'); slash != std::string::npos) display.erase(0, slash + 1);
  const std::string path = std::string(runtime ? runtime : "/tmp") + "/lolping-kwin-" + display + ".sock";
  int fd = connectTo(path);
  if (fd < 0) {
    loadPlugin();
    for (int i = 0; i < 20 && fd < 0; ++i) {
      std::this_thread::sleep_for(std::chrono::milliseconds(100));
      fd = connectTo(path);
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
  for (;;) {
    pollfd fds[] = {{fd, POLLIN, 0}, {STDIN_FILENO, POLLIN, 0}};
    if (poll(fds, 2, -1) < 0) break;
    if (fds[0].revents & (POLLIN | POLLHUP | POLLERR)) {
      const ssize_t n = read(fd, buf, sizeof(buf));
      if (n <= 0) { out.error("The KWin plugin closed the connection"); close(fd); return 1; }
      fromPlugin.append(buf, static_cast<size_t>(n));
      size_t end;
      while ((end = fromPlugin.find('\n')) != std::string::npos) {
        out.line(fromPlugin.substr(0, end));
        fromPlugin.erase(0, end + 1);
      }
      if (fromPlugin.size() > 65536) { out.error("plugin line too long"); break; }
    }
    if (fds[1].revents & (POLLIN | POLLHUP | POLLERR)) {
      const ssize_t n = read(STDIN_FILENO, buf, sizeof(buf));
      if (n <= 0) break;  // the app is gone: closing the socket makes the plugin pass everything again
      if (!writeAll(fd, buf, static_cast<size_t>(n))) { out.error("The KWin plugin closed the connection"); close(fd); return 1; }
    }
  }
  close(fd);
  return 0;
}
}
