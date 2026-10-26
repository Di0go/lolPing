#pragma once
#include "output.h"
namespace lp {
// Relays the protocol between stdin/stdout and the KWin plugin's socket. Exit codes as runHooks.
int runKWinBridge(Output& out);
}
