#pragma once
#include <functional>
#include <string>
#include "output.h"
namespace lp {
// Relays the protocol between stdin/stdout and the KWin plugin's socket. Exit codes as runHooks.
int runKWinBridge(Output& out);

struct KWinRelayOptions {
  std::string path;                 // the plugin's socket
  std::function<void()> loadPlugin; // asks KWin to load the plugin; called whenever the socket is missing
  int startAttempts = 20;           // retries at start before giving up with noAccess
  int retryMs = 100;
  int reconnectMs = 1000;           // after a lost connection, how often to try again
};
// The relay behind runKWinBridge, with `in` as the app's side. A lost plugin connection is retried until the app
// closes `in`, so a restarted KWin or a reloaded plugin picks lolPing up again.
int relayKWin(Output& out, int in, const KWinRelayOptions& options);
}
