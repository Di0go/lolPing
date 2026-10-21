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
  Rect area;                  // the part of the display the overview shows; the whole display when not given
  std::vector<Point> spots;   // 1-based numbers follow this order
  std::vector<Rect> crops;    // one close-up per spot when given, instead of a zoomW x zoomH crop around it
  int overviewLongSide = 1600;
  int zoomW = 1000, zoomH = 750;
  int quality = 80;
  std::string dir;            // where the JPEGs go
};

/** Which context layers to read for one ask; they run side by side under one budget. */
struct ReadRequest {
  std::vector<Point> spots;
  int radius = 600;           // request units around each spot, for marks
  bool marks = false, text = false, file = false, boxes = false;
  std::string dir;            // where the marks file goes
};

struct Command {
  enum class Kind { Bad, Capture, Foreground, Ping, Shutdown, Read } kind = Kind::Bad;
  std::string id;
  std::string error;  // Bad: why
  CaptureRequest capture;
  ReadRequest read;
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

// controls, systemText and fileOf each run on their own fresh thread, which may outlive the command when it runs
// over budget: they must not keep references to caller-owned state, and on Windows each must CoInitializeEx on its
// thread.
struct ContextPlatform {
  /** Grabs the display. The image may be larger than the rect (macOS Retina): spots are scaled to it. */
  std::function<bool(const Rect& display, Image& out, Failure& fail)> grab;
  std::function<bool(const Image& in, int w, int h, Image& out)> resize;
  std::function<bool(const Image& img, int quality, const std::string& path, Failure& fail)> writeJpeg;
  std::function<bool(std::string& app, std::string& title, Failure& fail)> foreground;
  /** Named controls and text within `radius` of a spot; spots, radius and boxes are in request (screen) units. */
  std::function<bool(const std::vector<Point>& spots, int radius, std::vector<RawMark>& out, Failure& fail)> controls;
  /** `withAddress`: also look up the browser's address; off when the file probe of the same read looks it up. */
  std::function<bool(const std::vector<Point>& spots, bool withAddress, SystemText& out, Failure& fail)> systemText;
  /**
   * The boxes that hold the element under each spot, innermost first, ending with its top-level window; none for
   * lolPing's own windows or an element that does not answer. Request (screen) units.
   */
  std::function<bool(const std::vector<Point>& spots, std::vector<std::vector<Rect>>& out, Failure& fail)> boxes;
  /** The file or web address behind the foreground window; `how` is office, address, title or none. */
  std::function<bool(std::string& path, std::string& address, std::string& how, Failure& fail)> fileOf;
};

/** This OS's capture, resize, JPEG and foreground calls (context_capture_win.cpp, context_capture_mac.mm). */
ContextPlatform nativePlatform();

struct Reply {
  std::string line;        // without the newline
  bool exitAfter = false;  // a probe is still running past its budget: the helper exits after this reply
};

/** How long a command's OS probes may take, together, before the helper gives up on them. */
constexpr int kProbeBudgetMs = 1000;

/** runContextLoop's result after a reply with exitAfter: the caller ends the process without cleanup. */
constexpr int kExitNow = 2;

/** Runs one command. Not called for Shutdown. Tests pass a short budget. */
Reply handleCommand(const Command& cmd, const ContextPlatform& platform, int budgetMs = kProbeBudgetMs);

/** The marks file: one `kind\tx\ty\tw\th\ttext` line per mark, text on one line and at most 120 characters. */
std::string marksFileText(const std::vector<RawMark>& marks);

/** At most this many boxes per spot: the innermost ones and the window. */
constexpr size_t kMaxBoxes = 12;

/** `chain` without repeats of the same box, cut to kMaxBoxes by dropping the outer ones short of the last. */
std::vector<Rect> thinBoxes(const std::vector<Rect>& chain);

/** Caps on the system text a read sends, in characters; the probes apply them. */
constexpr size_t kSelectionMax = 4000;
constexpr size_t kSpotTextMax = 2000;
constexpr size_t kFocusValueMax = 2000;
constexpr size_t kAddressMax = 2000;

/** The first `maxChars` characters of UTF-8 `text`, never cut inside a character. */
std::string cutText(const std::string& text, size_t maxChars);

/**
 * The file name a window title shows ("notes.txt - Notepad", "a.ts - repo - Visual Studio Code"), or empty: the
 * text before the last " - " when it ends in a known extension, else the last " - " part or word that does, else the
 * text before the last " - ". A leading unsaved mark ('*' or U+25CF) is dropped.
 */
std::string fileNameFromTitle(const std::string& title);

/** Acrobat's recent-file form `/C/a/b.pdf` as `C:\a\b.pdf`; empty when the value is not in that form. */
std::string acrobatMruPath(const std::string& value);

/** Office's File MRU value `[F…][T…]*C:\a\b.docx` as the path after the `*`; empty without one. */
std::string officeMruPath(const std::string& value);

/**
 * A browser address bar's value: `C:/…` and `file:///…` become a Windows `path` (percent-decoded), anything else
 * that looks like a web address becomes `address`, with https:// added when it has no scheme. False when the value
 * looks like neither (empty, a search, `about:blank`).
 */
bool browserAddress(const std::string& value, std::string& path, std::string& address);

/** Runs `probe` on its own thread; false when it is still running at the budget, leaving it running detached. */
bool runWithBudget(const std::function<void()>& probe, int budgetMs);

/**
 * Runs every probe at once on its own thread against one deadline; false when any is still running at it. With
 * `finished`, it gets one flag per probe saying whether that probe returned in time (its output is then safe to read).
 */
bool runAllWithBudget(const std::vector<std::function<void()>>& probes, int budgetMs,
                      std::vector<bool>* finished = nullptr);

/**
 * Reads commands until shutdown, end of input or a reply that exits, writing each reply with `write`.
 * Returns kExitNow after a reply with exitAfter (a probe thread is still running), else 0.
 */
int runContextLoop(std::istream& in, const std::function<bool(const std::string&)>& write,
                   const ContextPlatform& platform, int budgetMs = kProbeBudgetMs);

std::string formatError(const std::string& id, const std::string& code, const std::string& message);

}  // namespace lp::ctx
