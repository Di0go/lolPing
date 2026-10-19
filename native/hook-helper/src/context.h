#pragma once
// The context helper's platform-free part: commands, geometry, spot markers and replies.
// Each platform supplies a ContextPlatform (context_capture_win.cpp, context_capture_mac.mm).
#include <cstdint>
#include <functional>
#include <istream>
#include <string>
#include <vector>

namespace lp::ctx {

struct Rect {
  int x = 0, y = 0, w = 0, h = 0;
};

struct Point {
  int x = 0, y = 0;
};

/** 32-bit BGRA pixels, rows top to bottom, no padding. */
struct Image {
  int w = 0, h = 0;
  std::vector<uint8_t> px;
};

struct CaptureRequest {
  Rect display;               // the display to grab, in the same units as the input helper's coordinates
  std::vector<Point> spots;   // 1-based numbers follow this order
  int overviewLongSide = 1600;
  int zoomW = 1000, zoomH = 750;
  int quality = 80;
  std::string dir;            // where the JPEGs go
};

struct Command {
  enum class Kind { Bad, Capture, Foreground, Ping, Shutdown } kind = Kind::Bad;
  std::string id;
  std::string error;  // Bad: why
  CaptureRequest capture;
};

constexpr int kMaxSpots = 4;

/** Parses one stdin line. Anything malformed is Kind::Bad, with the id when one could be read. */
Command parseCommand(const std::string& line);

/** The crop around `spot`, moved (not shrunk) to stay inside the display unless the display is smaller. */
Rect zoomRectAround(const Rect& display, Point spot, int w, int h);

/** The overview size: the long side scaled to `longSide` (never enlarged), the other side keeping the aspect. */
void overviewSize(int w, int h, int longSide, int& ow, int& oh);

/** Draws spot `number`'s ring, crosshair and number centred on (cx, cy). The centre pixel itself stays untouched. */
void drawSpotMarker(Image& img, int cx, int cy, int number);

/** The ring's radius, in image pixels. */
constexpr int kMarkerRadius = 22;

/** Why a platform call failed: code is "capture" or "permission". */
struct Failure {
  std::string code = "capture";
  std::string message;
};

struct ContextPlatform {
  /** Grabs the display. The image may be larger than the rect (macOS Retina): spots are scaled to it. */
  std::function<bool(const Rect& display, Image& out, Failure& fail)> grab;
  std::function<bool(const Image& in, int w, int h, Image& out)> resize;
  std::function<bool(const Image& img, int quality, const std::string& path, Failure& fail)> writeJpeg;
  std::function<bool(std::string& app, std::string& title, Failure& fail)> foreground;
};

/** This OS's capture, resize, JPEG and foreground calls (context_capture_win.cpp, context_capture_mac.mm). */
ContextPlatform nativePlatform();

/** Runs one command and returns the reply line (without the newline). Not called for Shutdown. */
std::string handleCommand(const Command& cmd, const ContextPlatform& platform);

/** Reads commands until shutdown or end of input, writing each reply with `write`. */
int runContextLoop(std::istream& in, const std::function<bool(const std::string&)>& write,
                   const ContextPlatform& platform);

std::string formatError(const std::string& id, const std::string& code, const std::string& message);

}  // namespace lp::ctx
