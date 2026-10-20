#pragma once
// The context helper's platform-free part: commands, geometry, spot markers and replies.
// Each platform supplies a ContextPlatform (context_capture_win.cpp, context_capture_mac.mm).
#include <cstdint>
#include <functional>
#include <istream>
#include <memory>
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

struct MarksRequest {
  std::string of;             // the capture whose grab is read
  std::vector<Point> spots;
  int radius = 600;           // request units around each spot
  bool ocr = false, controls = false;
  std::string dir;            // where the marks file goes
};

struct Command {
  enum class Kind { Bad, Capture, Foreground, Ping, Shutdown, Marks, SystemText, FileOf } kind = Kind::Bad;
  std::string id;
  std::string error;  // Bad: why
  CaptureRequest capture;
  MarksRequest marks;
  std::vector<Point> spots;  // SystemText
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

/** A line of text or a control: kind is one of text, button, link, field, menu, tab, check, item, other. */
struct RawMark {
  std::string kind;
  Rect box;
  std::string text;
};

struct SystemText {
  std::string selection;
  std::vector<std::string> spotTexts;  // one per spot, in spot order
  std::string focusKind, focusLabel, focusValue, address;
  bool focusSecure = false;
};

struct ContextPlatform {
  /** Grabs the display. The image may be larger than the rect (macOS Retina): spots are scaled to it. */
  std::function<bool(const Rect& display, Image& out, Failure& fail)> grab;
  std::function<bool(const Image& in, int w, int h, Image& out)> resize;
  std::function<bool(const Image& img, int quality, const std::string& path, Failure& fail)> writeJpeg;
  std::function<bool(std::string& app, std::string& title, Failure& fail)> foreground;
  /** Text lines inside `area` of the grab; the area and the boxes are in the image's pixels. */
  std::function<bool(const Image& img, const Rect& area, std::vector<RawMark>& out, Failure& fail)> ocr;
  /** Named controls within `radius` of a spot; spots, radius and boxes are in request (screen) units. */
  std::function<bool(const std::vector<Point>& spots, int radius, std::vector<RawMark>& out, Failure& fail)> controls;
  std::function<bool(const std::vector<Point>& spots, SystemText& out, Failure& fail)> systemText;
  /** The file or web address behind the foreground window; `how` is office, address, title or none. */
  std::function<bool(std::string& path, std::string& address, std::string& how, Failure& fail)> fileOf;
};

/** This OS's capture, resize, JPEG and foreground calls (context_capture_win.cpp, context_capture_mac.mm). */
ContextPlatform nativePlatform();

/** The latest successful capture's full grab, kept for `marks` until the next capture. */
struct LastGrab {
  std::string id;
  Rect display;
  std::shared_ptr<const Image> image;  // shared so a probe thread that outlives its command can still read it
};

struct Reply {
  std::string line;        // without the newline
  bool exitAfter = false;  // a probe is still running past its budget: the helper exits after this reply
};

/** How long one OS probe may take before the helper gives up on it. */
constexpr int kProbeBudgetMs = 1500;

/** Runs one command. Not called for Shutdown. */
Reply handleCommand(const Command& cmd, const ContextPlatform& platform, LastGrab& last);

/** The marks file: one `kind\tx\ty\tw\th\ttext` line per mark, text on one line and at most 120 characters. */
std::string marksFileText(const std::vector<RawMark>& marks);

/** Runs `probe` on its own thread; false when it is still running at the budget, leaving it running detached. */
bool runWithBudget(const std::function<void()>& probe, int budgetMs);

/** Reads commands until shutdown, end of input or a reply that exits, writing each reply with `write`. */
int runContextLoop(std::istream& in, const std::function<bool(const std::string&)>& write,
                   const ContextPlatform& platform);

std::string formatError(const std::string& id, const std::string& code, const std::string& message);

}  // namespace lp::ctx
