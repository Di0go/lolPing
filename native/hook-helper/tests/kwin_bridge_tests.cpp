// Tests the KWin bridge's relay against a fake plugin socket: lines both ways, reconnecting after the plugin drops
// the connection, and exiting when the app goes. Build and run: npm run test:helper
#include <poll.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <future>
#include <mutex>
#include <string>
#include <vector>

#include "../src/hooks_kwin.h"

using namespace lp;

static int g_pass = 0;
static int g_fail = 0;
#define CHECK(cond)                                               \
  do {                                                            \
    if (cond) {                                                   \
      ++g_pass;                                                   \
    } else {                                                      \
      ++g_fail;                                                   \
      std::printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); \
    }                                                             \
  } while (0)

namespace {
using Clock = std::chrono::steady_clock;

struct Lines {
  std::mutex mu;
  std::vector<std::string> v;
  bool has(const std::string& part) {
    std::lock_guard<std::mutex> lock(mu);
    for (const auto& l : v) if (l.find(part) != std::string::npos) return true;
    return false;
  }
  size_t count(const std::string& part) {
    std::lock_guard<std::mutex> lock(mu);
    size_t n = 0;
    for (const auto& l : v) if (l.find(part) != std::string::npos) ++n;
    return n;
  }
};

template <class F>
bool waitFor(F cond, int ms = 3000) {
  const auto end = Clock::now() + std::chrono::milliseconds(ms);
  while (Clock::now() < end) {
    if (cond()) return true;
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  return cond();
}

// The fake plugin: a listening socket that accepts one client at a time.
struct FakePlugin {
  std::string path;
  int listener = -1;
  explicit FakePlugin(const std::string& p) : path(p) {}
  bool listen() {
    sockaddr_un addr{};
    addr.sun_family = AF_UNIX;
    std::strncpy(addr.sun_path, path.c_str(), sizeof(addr.sun_path) - 1);
    unlink(path.c_str());
    listener = socket(AF_UNIX, SOCK_STREAM, 0);
    return bind(listener, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == 0 && ::listen(listener, 4) == 0;
  }
  int accept(int ms = 3000) {
    pollfd p{listener, POLLIN, 0};
    if (poll(&p, 1, ms) <= 0) return -1;
    return ::accept(listener, nullptr, nullptr);
  }
  void close() {
    if (listener >= 0) ::close(listener);
    listener = -1;
    unlink(path.c_str());
  }
};

void sendLine(int fd, const std::string& s) {
  const std::string line = s + "\n";
  (void)!write(fd, line.data(), line.size());
}
std::string readLine(int fd, int ms = 3000) {
  std::string got;
  char c;
  const auto end = Clock::now() + std::chrono::milliseconds(ms);
  while (Clock::now() < end) {
    pollfd p{fd, POLLIN, 0};
    if (poll(&p, 1, 50) <= 0) continue;
    if (read(fd, &c, 1) != 1) break;
    if (c == '\n') return got;
    got += c;
  }
  return got;
}

std::string tempSocketPath() {
  char dir[] = "/tmp/lolping-kwin-test-XXXXXX";
  if (!mkdtemp(dir)) std::abort();
  return std::string(dir) + "/plugin.sock";
}
}  // namespace

int main() {
  std::signal(SIGPIPE, SIG_IGN);

  {
    std::printf("relays lines both ways and reconnects after the plugin drops the connection\n");
    FakePlugin plugin(tempSocketPath());
    CHECK(plugin.listen());
    int app[2];
    CHECK(socketpair(AF_UNIX, SOCK_STREAM, 0, app) == 0);
    Lines lines;
    Output out([&](const std::string& l) { std::lock_guard<std::mutex> lock(lines.mu); lines.v.push_back(l); return true; });
    std::atomic<int> loads{0};
    KWinRelayOptions o;
    o.path = plugin.path;
    o.loadPlugin = [&] { ++loads; };
    o.retryMs = 10;
    o.reconnectMs = 20;
    auto relay = std::async(std::launch::async, [&] { return relayKWin(out, app[1], o); });

    int conn = plugin.accept();
    CHECK(conn >= 0);
    sendLine(conn, "{\"type\":\"ready\",\"version\":6}");
    CHECK(waitFor([&] { return lines.count("\"ready\"") == 1; }));
    sendLine(app[0], "{\"type\":\"setEnabled\",\"on\":true}");
    CHECK(readLine(conn) == "{\"type\":\"setEnabled\",\"on\":true}");

    // KWin restarts or reloads the plugin: the connection drops, then a new socket appears.
    ::close(conn);
    plugin.close();
    CHECK(waitFor([&] { return lines.has("closed the connection"); }));
    CHECK(relay.wait_for(std::chrono::milliseconds(100)) == std::future_status::timeout);  // still running
    CHECK(plugin.listen());
    conn = plugin.accept();
    CHECK(conn >= 0);
    CHECK(loads.load() >= 1);  // asked KWin to load the plugin while the socket was gone
    sendLine(conn, "{\"type\":\"ready\",\"version\":6}");
    CHECK(waitFor([&] { return lines.count("\"ready\"") == 2; }));  // the app re-sends its state on this ready
    sendLine(app[0], "{\"type\":\"suspend\",\"on\":false}");
    CHECK(readLine(conn) == "{\"type\":\"suspend\",\"on\":false}");

    // The app goes: the relay ends and closes the plugin connection, so the plugin passes everything again.
    ::close(app[0]);
    CHECK(relay.wait_for(std::chrono::seconds(3)) == std::future_status::ready);
    CHECK(relay.get() == 0);
    char c;
    CHECK(read(conn, &c, 1) == 0);
    ::close(conn);
    plugin.close();
    out.stop();
  }

  {
    std::printf("exits while waiting to reconnect when the app goes\n");
    FakePlugin plugin(tempSocketPath());
    CHECK(plugin.listen());
    int app[2];
    CHECK(socketpair(AF_UNIX, SOCK_STREAM, 0, app) == 0);
    Output out([](const std::string&) { return true; });
    KWinRelayOptions o;
    o.path = plugin.path;
    o.retryMs = 10;
    o.reconnectMs = 20;
    auto relay = std::async(std::launch::async, [&] { return relayKWin(out, app[1], o); });
    int conn = plugin.accept();
    CHECK(conn >= 0);
    ::close(conn);
    plugin.close();
    CHECK(relay.wait_for(std::chrono::milliseconds(100)) == std::future_status::timeout);
    ::close(app[0]);
    CHECK(relay.wait_for(std::chrono::seconds(3)) == std::future_status::ready);
    CHECK(relay.get() == 0);
    out.stop();
  }

  {
    std::printf("reports noAccess when the plugin never appears\n");
    int app[2];
    CHECK(socketpair(AF_UNIX, SOCK_STREAM, 0, app) == 0);
    Lines lines;
    Output out([&](const std::string& l) { std::lock_guard<std::mutex> lock(lines.mu); lines.v.push_back(l); return true; });
    std::atomic<int> loads{0};
    KWinRelayOptions o;
    o.path = tempSocketPath();
    o.loadPlugin = [&] { ++loads; };
    o.startAttempts = 3;
    o.retryMs = 10;
    CHECK(relayKWin(out, app[1], o) == 3);
    out.stop();
    CHECK(loads.load() == 1);
    CHECK(lines.has("noAccess"));
    ::close(app[0]);
  }

  std::printf("%d passed, %d failed\n", g_pass, g_fail);
  return g_fail ? 1 : 0;
}
