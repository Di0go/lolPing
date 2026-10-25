#include "context.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <exception>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <map>
#include <memory>
#include <mutex>
#include <regex>
#include <thread>

#include "json.h"

namespace lp::ctx {
namespace {

using Fields = std::map<std::string, std::string>;

#ifdef _WIN32
constexpr char kSep = '\\';
#else
constexpr char kSep = '/';
#endif

// Strict: the whole text is one integer within +/-1,000,000.
bool toInt(const std::string& s, int& out) {
  if (s.empty() || s.size() > 9) return false;
  size_t i = s[0] == '-' ? 1 : 0;
  if (i == s.size()) return false;
  long v = 0;
  for (; i < s.size(); ++i) {
    if (s[i] < '0' || s[i] > '9') return false;
    v = v * 10 + (s[i] - '0');
  }
  if (v > 1000000) return false;
  out = static_cast<int>(s[0] == '-' ? -v : v);
  return true;
}

std::vector<std::string> split(const std::string& s, char sep) {
  std::vector<std::string> parts;
  size_t start = 0;
  while (true) {
    const size_t at = s.find(sep, start);
    parts.push_back(s.substr(start, at == std::string::npos ? std::string::npos : at - start));
    if (at == std::string::npos) return parts;
    start = at + 1;
  }
}

bool parseInts(const std::string& s, size_t count, std::vector<int>& out) {
  const std::vector<std::string> parts = split(s, ',');
  if (parts.size() != count) return false;
  out.assign(count, 0);
  for (size_t i = 0; i < count; ++i) {
    if (!toInt(parts[i], out[i])) return false;
  }
  return true;
}

// Ids end up in file names, so only letters, digits, '-' and '_'.
bool validId(const std::string& id) {
  if (id.empty() || id.size() > 64) return false;
  return std::all_of(id.begin(), id.end(), [](char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_';
  });
}

Command bad(const std::string& id, const std::string& why) {
  Command c;
  c.id = id;
  c.error = why;
  return c;
}

// Reads an optional integer field within [lo, hi]; false when present but malformed.
bool intField(const Fields& m, const char* key, int lo, int hi, int& out) {
  const auto it = m.find(key);
  if (it == m.end()) return true;
  int v = 0;
  if (!toInt(it->second, v) || v < lo || v > hi) return false;
  out = v;
  return true;
}

// Reads an optional true/false field; false when present but anything else.
bool boolField(const Fields& m, const char* key, bool& out) {
  const auto it = m.find(key);
  if (it == m.end()) return true;
  if (it->second != "true" && it->second != "false") return false;
  out = it->second == "true";
  return true;
}

// Reads the optional "x,y;x,y" spots field; the error is empty when it was fine.
std::string spotsField(const Fields& m, std::vector<Point>& out) {
  const auto spots = m.find("spots");
  if (spots != m.end() && !spots->second.empty()) {
    std::vector<int> v;
    for (const std::string& p : split(spots->second, ';')) {
      if (!parseInts(p, 2, v)) return "spots must be \"x,y;x,y\"";
      out.push_back(Point{v[0], v[1]});
    }
  }
  return out.size() > static_cast<size_t>(kMaxSpots) ? "too many spots" : "";
}

// Reads the required "dir" field; the error is empty when it was fine.
std::string dirField(const Fields& m, std::string& out) {
  const auto dir = m.find("dir");
  if (dir == m.end() || dir->second.empty()) return "dir is missing";
  if (dir->second.find(';') != std::string::npos) return "dir must not contain ';'";
  out = dir->second;
  return "";
}

// Reads an optional "x,y,w,h;x,y,w,h" field of rects with area; the error is empty when it was fine.
std::string rectsField(const Fields& m, const char* key, std::vector<Rect>& out) {
  const auto it = m.find(key);
  if (it == m.end() || it->second.empty()) return "";
  std::vector<int> v;
  for (const std::string& r : split(it->second, ';')) {
    if (!parseInts(r, 4, v) || v[2] < 1 || v[3] < 1 || v[2] > 32768 || v[3] > 32768) {
      return std::string(key) + " must be \"x,y,w,h;x,y,w,h\"";
    }
    out.push_back(Rect{v[0], v[1], v[2], v[3]});
  }
  return "";
}

Command parseCapture(const Fields& m, const std::string& id) {
  Command c;
  c.kind = Command::Kind::Capture;
  c.id = id;
  CaptureRequest& r = c.capture;
  std::vector<int> v;
  const auto display = m.find("display");
  if (display == m.end() || !parseInts(display->second, 4, v)) return bad(id, "display must be \"x,y,w,h\"");
  r.display = Rect{v[0], v[1], v[2], v[3]};
  if (r.display.w < 1 || r.display.h < 1 || r.display.w > 32768 || r.display.h > 32768) {
    return bad(id, "display has no area");
  }
  if (const std::string why = spotsField(m, r.spots); !why.empty()) return bad(id, why);
  std::vector<Rect> area;
  if (const std::string why = rectsField(m, "area", area); !why.empty()) return bad(id, why);
  if (area.size() > 1) return bad(id, "area must be one rect");
  r.area = area.empty() ? r.display : area[0];
  if (const std::string why = rectsField(m, "crops", r.crops); !why.empty()) return bad(id, why);
  if (!r.crops.empty() && r.crops.size() != r.spots.size()) return bad(id, "crops must have one rect per spot");
  if (!intField(m, "overview", 64, 8192, r.overviewLongSide)) return bad(id, "overview out of range");
  if (!intField(m, "quality", 1, 100, r.quality)) return bad(id, "quality out of range");
  const auto zoom = m.find("zoom");
  if (zoom != m.end()) {
    if (!parseInts(zoom->second, 2, v) || v[0] < 16 || v[1] < 16 || v[0] > 8192 || v[1] > 8192) {
      return bad(id, "zoom must be \"w,h\"");
    }
    r.zoomW = v[0];
    r.zoomH = v[1];
  }
  if (const std::string why = dirField(m, r.dir); !why.empty()) return bad(id, why);
  return c;
}

Command parseRead(const Fields& m, const std::string& id) {
  Command c;
  c.kind = Command::Kind::Read;
  c.id = id;
  ReadRequest& r = c.read;
  if (const std::string why = spotsField(m, r.spots); !why.empty()) return bad(id, why);
  if (!intField(m, "radius", 0, 32768, r.radius)) return bad(id, "radius out of range");
  if (!boolField(m, "marks", r.marks) || !boolField(m, "text", r.text) || !boolField(m, "file", r.file) ||
      !boolField(m, "boxes", r.boxes) || !boolField(m, "fields", r.fields)) {
    return bad(id, "marks, text, file, boxes and fields must be true or false");
  }
  if (const std::string why = dirField(m, r.dir); !why.empty()) return bad(id, why);
  return c;
}

// The foreground reply's window id: the HWND in decimal on Windows.
bool validWindow(const std::string& w) {
  return !w.empty() && w.size() <= 20 && std::all_of(w.begin(), w.end(), [](char c) { return c >= '0' && c <= '9'; });
}

// A UI Automation runtime id: 32-bit integers joined with dots, as formFieldsFileText writes them.
bool validFieldId(const std::string& id) {
  if (id.empty() || id.size() > kFieldIdMax) return false;
  for (const std::string& part : split(id, '.')) {
    const size_t digits = part.size() - (part.rfind('-', 0) == 0 ? 1 : 0);
    if (digits == 0 || digits > 10) return false;
    if (!std::all_of(part.end() - static_cast<std::ptrdiff_t>(digits), part.end(), [](char c) {
          return c >= '0' && c <= '9';
        })) {
      return false;
    }
    const long long v = std::stoll(part);
    if (v < INT32_MIN || v > INT32_MAX) return false;
  }
  return true;
}

// Characters, not bytes: a byte that is not a UTF-8 continuation byte starts one.
size_t charCount(const std::string& s) {
  return static_cast<size_t>(
      std::count_if(s.begin(), s.end(), [](char c) { return (static_cast<unsigned char>(c) & 0xC0) != 0x80; }));
}

// A required string field; false when it is missing.
bool stringField(const Fields& m, const char* key, std::string& out) {
  const auto it = m.find(key);
  if (it == m.end()) return false;
  out = it->second;
  return true;
}

Command parsePaste(const Fields& m, const std::string& id) {
  Command c;
  c.kind = Command::Kind::Paste;
  c.id = id;
  PasteRequest& r = c.paste;
  if (!stringField(m, "window", r.window) || !validWindow(r.window)) return bad(id, "window must be a window id");
  if (!stringField(m, "text", r.text) || r.text.empty() || charCount(r.text) > kPasteTextMax) {
    return bad(id, "text must be 1 to 20000 characters");
  }
  std::string mode;
  if (!stringField(m, "mode", mode) || (mode != "insert" && mode != "replace")) {
    return bad(id, "mode must be insert or replace");
  }
  r.replace = mode == "replace";
  const auto click = m.find("click");
  if (click != m.end() && !click->second.empty()) {
    std::vector<int> v;
    if (!parseInts(click->second, 2, v)) return bad(id, "click must be \"x,y\"");
    r.click = Point{v[0], v[1]};
  }
  // A click would drop the very selection a replace pastes over.
  if (r.replace && r.click) return bad(id, "a replace has no click");
  stringField(m, "asked", r.asked);
  if (charCount(r.asked) > kSelectionMax) return bad(id, "asked is too long");
  stringField(m, "field", r.field);
  if (r.field.size() > kFieldIdMax) return bad(id, "field is too long");
  return c;
}

Command parseSetField(const Fields& m, const std::string& id) {
  Command c;
  c.kind = Command::Kind::SetField;
  c.id = id;
  SetFieldRequest& r = c.setField;
  if (!stringField(m, "window", r.window) || !validWindow(r.window)) return bad(id, "window must be a window id");
  if (!stringField(m, "field", r.field) || !validFieldId(r.field)) return bad(id, "field must be a runtime id");
  if (!stringField(m, "value", r.value) || charCount(r.value) > kFieldValueMax) {
    return bad(id, "value must be at most 2000 characters");
  }
  return c;
}

int clampInt(int v, int lo, int hi) { return v < lo ? lo : v > hi ? hi : v; }

void setPx(Image& img, int x, int y, uint8_t b, uint8_t g, uint8_t r) {
  if (x < 0 || y < 0 || x >= img.w || y >= img.h) return;
  uint8_t* p = &img.px[(static_cast<size_t>(y) * img.w + x) * 4];
  p[0] = b;
  p[1] = g;
  p[2] = r;
  p[3] = 255;
}

// League's ping yellow over a dark edge, so the marker reads on light and dark screens.
void paint(Image& img, int x, int y, bool edge) {
  if (edge) setPx(img, x, y, 20, 20, 20);
  else setPx(img, x, y, 0, 212, 255);
}

// 5 x 7 digits, one byte per row, the low five bits from right to left.
constexpr uint8_t kDigits[10][7] = {
    {0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E}, {0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E},
    {0x0E, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1F}, {0x1F, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0E},
    {0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02}, {0x1F, 0x10, 0x1E, 0x01, 0x01, 0x11, 0x0E},
    {0x06, 0x08, 0x10, 0x1E, 0x11, 0x11, 0x0E}, {0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08},
    {0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E}, {0x0E, 0x11, 0x11, 0x0F, 0x01, 0x02, 0x0C},
};
constexpr int kGlyphScale = 2;

bool glyphOn(int digit, int gx, int gy) {
  if (gx < 0 || gy < 0 || gx >= 5 || gy >= 7) return false;
  return (kDigits[digit][gy] >> (4 - gx)) & 1;
}

void drawNumber(Image& img, int left, int top, int number) {
  const std::string text = std::to_string(number);
  for (size_t i = 0; i < text.size(); ++i) {
    const int digit = text[i] - '0';
    const int ox = left + static_cast<int>(i) * 6 * kGlyphScale;
    // Two passes: the dark outline first (every pixel next to a lit one), then the digit.
    for (int pass = 0; pass < 2; ++pass) {
      for (int y = -1; y < 7 * kGlyphScale + 1; ++y) {
        for (int x = -1; x < 5 * kGlyphScale + 1; ++x) {
          const bool on = glyphOn(digit, x < 0 ? -1 : x / kGlyphScale, y < 0 ? -1 : y / kGlyphScale);
          if (pass == 1) {
            if (on) paint(img, ox + x, top + y, false);
            continue;
          }
          bool near = false;
          for (int dy = -1; dy <= 1 && !near; ++dy) {
            for (int dx = -1; dx <= 1 && !near; ++dx) {
              const int nx = x + dx, ny = y + dy;
              near = nx >= 0 && ny >= 0 && glyphOn(digit, nx / kGlyphScale, ny / kGlyphScale);
            }
          }
          if (near) paint(img, ox + x, top + y, true);
        }
      }
    }
  }
}

Image crop(const Image& src, int x, int y, int w, int h) {
  Image out;
  out.w = w;
  out.h = h;
  out.px.resize(static_cast<size_t>(w) * h * 4);
  for (int row = 0; row < h; ++row) {
    const uint8_t* from = &src.px[(static_cast<size_t>(y + row) * src.w + x) * 4];
    std::copy(from, from + static_cast<size_t>(w) * 4, &out.px[static_cast<size_t>(row) * w * 4]);
  }
  return out;
}

std::string joinPath(const std::string& dir, const std::string& file) {
  const char last = dir.back();
  return last == '/' || last == '\\' ? dir + file : dir + kSep + file;
}

std::string rectText(const Rect& r) {
  return std::to_string(r.x) + "," + std::to_string(r.y) + "," + std::to_string(r.w) + "," + std::to_string(r.h);
}

// A spot in request units → pixels of an image showing `area` at `w` x `h`.
Point toImage(Point spot, const Rect& area, int w, int h) {
  return Point{static_cast<int>(std::lround(static_cast<double>(spot.x - area.x) * w / area.w)),
               static_cast<int>(std::lround(static_cast<double>(spot.y - area.y) * h / area.h))};
}

void drawSpots(Image& img, const std::vector<Point>& spots, const Rect& area) {
  for (size_t i = 0; i < spots.size(); ++i) {
    const Point p = toImage(spots[i], area, img.w, img.h);
    drawSpotMarker(img, p.x, p.y, static_cast<int>(i) + 1);
  }
}

// The part of `a` inside `b`; no area when they don't meet.
Rect intersect(const Rect& a, const Rect& b) {
  const int x = std::max(a.x, b.x), y = std::max(a.y, b.y);
  const int right = std::min(a.x + a.w, b.x + b.w), bottom = std::min(a.y + a.h, b.y + b.h);
  return right > x && bottom > y ? Rect{x, y, right - x, bottom - y} : Rect{};
}

// `r` (request units, inside the display) as pixels of the grab, which may be larger than the display.
Image cropUnits(const Image& full, const Rect& display, const Rect& r) {
  const double sx = static_cast<double>(full.w) / display.w;
  const double sy = static_cast<double>(full.h) / display.h;
  const int px = clampInt(static_cast<int>(std::lround((r.x - display.x) * sx)), 0, full.w - 1);
  const int py = clampInt(static_cast<int>(std::lround((r.y - display.y) * sy)), 0, full.h - 1);
  const int pw = clampInt(static_cast<int>(std::lround(r.w * sx)), 1, full.w - px);
  const int ph = clampInt(static_cast<int>(std::lround(r.h * sy)), 1, full.h - py);
  return crop(full, px, py, pw, ph);
}

// `img` with its long side cut to `longSide`; false when the resize failed.
bool fitLongSide(const Image& img, int longSide, const ContextPlatform& platform, Image& out) {
  int w = 0, h = 0;
  overviewSize(img.w, img.h, longSide, w, h);
  if (w == img.w && h == img.h) {
    out = img;
    return true;
  }
  return platform.resize(img, w, h, out);
}

std::string handleCapture(const Command& cmd, const ContextPlatform& platform) {
  const CaptureRequest& r = cmd.capture;
  Failure fail;
  Image full;
  if (!platform.grab(r.display, full, fail)) return formatError(cmd.id, fail.code, fail.message);
  if (full.w < 1 || full.h < 1 || full.px.size() != static_cast<size_t>(full.w) * full.h * 4) {
    return formatError(cmd.id, "capture", "the capture came back empty");
  }

  // An area off the display shows the whole display, as an overview with no area would.
  Rect area = intersect(r.area, r.display);
  if (area.w < 1) area = r.display;
  const bool whole = area.x == r.display.x && area.y == r.display.y && area.w == r.display.w && area.h == r.display.h;
  Image overview;
  if (!fitLongSide(whole ? full : cropUnits(full, r.display, area), r.overviewLongSide, platform, overview)) {
    return formatError(cmd.id, "capture", "could not resize");
  }
  const int ow = overview.w, oh = overview.h;
  drawSpots(overview, r.spots, area);
  const std::string overviewPath = joinPath(r.dir, "overview-" + cmd.id + ".jpg");
  if (!platform.writeJpeg(overview, r.quality, overviewPath, fail)) return formatError(cmd.id, fail.code, fail.message);

  const double sx = static_cast<double>(full.w) / r.display.w;
  const double sy = static_cast<double>(full.h) / r.display.h;
  std::string zooms, zoomRects;
  for (size_t i = 0; i < r.spots.size(); ++i) {
    // The zoom is zoomW x zoomH pixels of the capture, so on a Retina display it covers fewer points.
    Rect z = zoomRectAround(r.display, r.spots[i], std::max(1, static_cast<int>(std::lround(r.zoomW / sx))),
                            std::max(1, static_cast<int>(std::lround(r.zoomH / sy))));
    if (i < r.crops.size()) {
      const Rect c = intersect(r.crops[i], r.display);
      if (c.w > 0) z = c;
    }
    // A close-up larger than the overview's long side would only be shrunk by the model's provider.
    Image zoom;
    if (!fitLongSide(cropUnits(full, r.display, z), r.overviewLongSide, platform, zoom)) {
      return formatError(cmd.id, "capture", "could not resize");
    }
    drawSpots(zoom, r.spots, z);
    const std::string path = joinPath(r.dir, "zoom-" + cmd.id + "-" + std::to_string(i + 1) + ".jpg");
    if (!platform.writeJpeg(zoom, r.quality, path, fail)) return formatError(cmd.id, fail.code, fail.message);
    zooms += (i == 0 ? "" : ";") + path;
    zoomRects += (i == 0 ? "" : ";") + rectText(z);
  }
  return "{\"type\":\"captured\",\"id\":\"" + jsonEscape(cmd.id) + "\",\"overview\":\"" + jsonEscape(overviewPath) +
         "\",\"ow\":" + std::to_string(ow) + ",\"oh\":" + std::to_string(oh) + ",\"zooms\":\"" + jsonEscape(zooms) +
         "\",\"zoomRects\":\"" + zoomRects + "\"}";
}

constexpr size_t kMarkTextMax = 120;  // characters
constexpr char kRecordSep = '\x1e';    // between spot texts

// What a probe thread fills in, shared with that thread because a slow one outlives its command.
template <typename Out>
struct Probe {
  Out out{};
  Failure fail{"capture", "not available"};  // kept when the probe is missing or throws
  bool ok = false;
};

// A probe body that fills `job`; `call` must hold copies of everything it reads, as it may outlive the command.
template <typename Out, typename Call>
std::function<void()> bindProbe(const std::shared_ptr<Probe<Out>>& job, Call call) {
  return [job, call] { job->ok = call(job->out, job->fail); };
}

// The path is UTF-8; on Windows a narrow path would be read in the ANSI code page instead.
bool writeTextFile(const std::string& path, const std::string& text) {
  std::u8string u8;
  for (const char c : path) u8.push_back(static_cast<char8_t>(c));
  std::ofstream out(std::filesystem::path(u8), std::ios::binary);
  out << text;
  out.close();
  return !out.fail();
}

struct FileInfo {
  std::string path, address, how = "none";
};

// A layer's outcome in the read reply: off (not asked), ok, slow (still running at the budget) or a failure code.
template <typename Out>
std::string layerStatus(bool asked, bool finished, const Probe<Out>& job) {
  if (!asked) return "off";
  if (!finished) return "slow";
  return job.ok ? "ok" : job.fail.code;
}

Reply handleRead(const Command& cmd, const ContextPlatform& platform, int budgetMs) {
  const ReadRequest& r = cmd.read;
  const auto marksJob = std::make_shared<Probe<std::vector<RawMark>>>();
  const auto textJob = std::make_shared<Probe<SystemText>>();
  const auto fileJob = std::make_shared<Probe<FileInfo>>();
  const auto boxesJob = std::make_shared<Probe<std::vector<std::vector<Rect>>>>();
  const auto fieldsJob = std::make_shared<Probe<std::vector<RawField>>>();
  const bool wantMarks = r.marks && !r.spots.empty();
  const bool wantBoxes = r.boxes && !r.spots.empty();
  // A platform without a fields probe leaves the layer off, like one that was not asked for.
  const bool wantFields = r.fields && !r.spots.empty() && static_cast<bool>(platform.formFields);
  // The layers run at once under one deadline: the slowest, not the sum, sets how long an ask waits. On a fresh
  // helper, UI Automation fails a controls walk that runs beside the system text probe (E_FAIL), so the quick text
  // probe goes first on the walk's own thread. The form fields are another search of the tree, so they follow the
  // text probe on that thread too: no two searches run at once.
  std::vector<std::function<void()>> probes;
  size_t screenAt = 0, fileAt = 0;
  if (wantMarks || r.text || wantBoxes || wantFields) {
    screenAt = probes.size();
    const auto boxes = platform.boxes;
    const auto controls = platform.controls;
    const auto systemText = platform.systemText;
    const auto formFields = platform.formFields;
    const std::vector<Point> spots = r.spots;
    const int radius = r.radius;
    const bool text = r.text;
    // In a browser the file probe reads the address bar anyway; reading it twice was most of the text probe's time.
    const bool withAddress = !r.file;
    // The boxes are a few calls per spot and frame the capture, so they go first.
    probes.push_back([marksJob, textJob, boxesJob, fieldsJob, boxes, controls, systemText, formFields, spots, radius,
                      text, withAddress, wantMarks, wantBoxes, wantFields] {
      if (wantBoxes && boxes) boxesJob->ok = boxes(spots, boxesJob->out, boxesJob->fail);
      if (text) textJob->ok = systemText(spots, withAddress, textJob->out, textJob->fail);
      // Before the walk, which runs to its own deadline and would leave the fields no time.
      if (wantFields) fieldsJob->ok = formFields(spots, fieldsJob->out, fieldsJob->fail);
      if (wantMarks) marksJob->ok = controls(spots, radius, marksJob->out, marksJob->fail);
    });
  }
  if (r.file) {
    fileAt = probes.size();
    const auto fileOf = platform.fileOf;
    probes.push_back(bindProbe(fileJob, [fileOf](FileInfo& out, Failure& f) {
      return fileOf(out.path, out.address, out.how, f);
    }));
  }
  std::vector<bool> finished;
  const bool allDone = probes.empty() || runAllWithBudget(probes, budgetMs, &finished);
  const auto inTime = [&](bool asked, size_t at) { return asked && (allDone || finished[at]); };

  std::string marks = layerStatus(wantMarks, inTime(wantMarks, screenAt), *marksJob);
  std::string marksPath;
  size_t count = 0;
  if (marks == "ok") {
    marksPath = joinPath(r.dir, "marks-" + cmd.id + ".tsv");
    count = marksJob->out.size();
    if (!writeTextFile(marksPath, marksFileText(marksJob->out))) {
      marks = "capture";
      marksPath.clear();
      count = 0;
    }
  }
  std::string fieldsStatus = layerStatus(wantFields, inTime(wantFields, screenAt), *fieldsJob);
  std::string fieldsPath;
  size_t fieldCount = 0;
  if (fieldsStatus == "ok") {
    fieldsPath = joinPath(r.dir, "fields-" + cmd.id + ".jsonl");
    fieldCount = std::min(fieldsJob->out.size(), kMaxFormFields);
    if (!writeTextFile(fieldsPath, formFieldsFileText(fieldsJob->out))) {
      fieldsStatus = "capture";
      fieldsPath.clear();
      fieldCount = 0;
    }
  }
  const std::string text = layerStatus(r.text, inTime(r.text, screenAt), *textJob);
  const std::string file = layerStatus(r.file, inTime(r.file, fileAt), *fileJob);
  if (text == "ok" && file == "ok" && fileJob->out.how == "address") {
    const FileInfo& f = fileJob->out;
    textJob->out.address = cutText(f.path.empty() ? f.address : f.path, kAddressMax);
  }

  std::string line = "{\"type\":\"read\",\"id\":\"" + jsonEscape(cmd.id) + "\",\"marks\":\"" + marks +
                     "\",\"marksPath\":\"" + jsonEscape(marksPath) + "\",\"count\":" + std::to_string(count) +
                     ",\"text\":\"" + text + "\"";
  if (text == "ok") {
    const SystemText& t = textJob->out;
    std::string spotTexts;
    for (size_t i = 0; i < r.spots.size(); ++i) {
      std::string s = i < t.spotTexts.size() ? t.spotTexts[i] : std::string();
      std::replace(s.begin(), s.end(), kRecordSep, ' ');
      if (i > 0) spotTexts += kRecordSep;
      spotTexts += s;
    }
    // A password or never-fill field's value never leaves the helper, whatever the probe read; the selection is read
    // from the focused field, so it goes too. Only a field's label counts: a page's is its title ("Reset password").
    const bool secure = t.focusSecure || (t.focusKind == "field" && neverFillLabel(t.focusLabel));
    const std::string value = secure ? std::string() : t.focusValue;
    const std::string selection = secure ? std::string() : t.selection;
    line += ",\"selection\":\"" + jsonEscape(selection) + "\",\"spotTexts\":\"" + jsonEscape(spotTexts) +
            "\",\"focusKind\":\"" + jsonEscape(t.focusKind) + "\",\"focusLabel\":\"" + jsonEscape(t.focusLabel) +
            "\",\"focusValue\":\"" + jsonEscape(value) + "\",\"focusSecure\":" + (secure ? "true" : "false") +
            ",\"address\":\"" + jsonEscape(t.address) + "\"";
  }
  const std::string boxes = layerStatus(wantBoxes, inTime(wantBoxes, screenAt), *boxesJob);
  line += ",\"boxes\":\"" + boxes + "\"";
  if (boxes == "ok") {
    std::string all;
    for (size_t i = 0; i < r.spots.size(); ++i) {
      if (i > 0) all += ';';
      if (i >= boxesJob->out.size()) continue;
      const std::vector<Rect> chain = thinBoxes(boxesJob->out[i]);
      for (size_t j = 0; j < chain.size(); ++j) all += (j == 0 ? "" : "|") + rectText(chain[j]);
    }
    line += ",\"boxRects\":\"" + all + "\"";
  }
  line += ",\"fields\":\"" + fieldsStatus + "\"";
  if (fieldsStatus == "ok") {
    line += ",\"fieldsPath\":\"" + jsonEscape(fieldsPath) + "\",\"fieldCount\":" + std::to_string(fieldCount);
  }
  line += ",\"file\":\"" + file + "\"";
  if (file == "ok") {
    const FileInfo& f = fileJob->out;
    line += ",\"filePath\":\"" + jsonEscape(f.path) + "\",\"fileAddress\":\"" + jsonEscape(f.address) +
            "\",\"how\":\"" + jsonEscape(f.how) + "\"";
  }
  // What finished in time is sent; a probe still running makes the helper exit after this reply.
  return Reply{line + "}", !allDone};
}

// Below, with the text helpers they use.
Reply handlePaste(const Command& cmd, const ContextPlatform& platform, int budgetMs);
Reply handleSetField(const Command& cmd, const ContextPlatform& platform, int budgetMs);

}  // namespace

Command parseCommand(const std::string& line) {
  Fields m;
  if (!parseFlatJson(line, m)) return bad("", "not a flat JSON object");
  const auto type = m.find("type");
  if (type == m.end()) return bad("", "no type");
  if (type->second == "shutdown") {
    Command c;
    c.kind = Command::Kind::Shutdown;
    return c;
  }
  const auto idIt = m.find("id");
  const std::string id = idIt == m.end() ? std::string() : idIt->second;
  if (!validId(id)) return bad("", "id must be 1 to 64 letters, digits, '-' or '_'");
  if (type->second == "capture") return parseCapture(m, id);
  if (type->second == "read") return parseRead(m, id);
  if (type->second == "paste") return parsePaste(m, id);
  if (type->second == "setField") return parseSetField(m, id);
  Command c;
  c.id = id;
  if (type->second == "foreground") c.kind = Command::Kind::Foreground;
  else if (type->second == "front") c.kind = Command::Kind::Front;
  else if (type->second == "ping") c.kind = Command::Kind::Ping;
  else return bad(id, "unknown type");
  return c;
}

std::vector<Rect> thinBoxes(const std::vector<Rect>& chain) {
  std::vector<Rect> out;
  for (const Rect& r : chain) {
    if (r.w < 1 || r.h < 1) continue;
    if (!out.empty() && out.back().x == r.x && out.back().y == r.y && out.back().w == r.w && out.back().h == r.h) {
      continue;
    }
    out.push_back(r);
  }
  if (out.size() > kMaxBoxes) {
    const Rect window = out.back();
    out.resize(kMaxBoxes - 1);
    out.push_back(window);
  }
  return out;
}

Rect zoomRectAround(const Rect& display, Point spot, int w, int h) {
  const int zw = std::min(w, display.w);
  const int zh = std::min(h, display.h);
  return Rect{clampInt(spot.x - zw / 2, display.x, display.x + display.w - zw),
              clampInt(spot.y - zh / 2, display.y, display.y + display.h - zh), zw, zh};
}

void overviewSize(int w, int h, int longSide, int& ow, int& oh) {
  const int longest = std::max(w, h);
  if (longest <= longSide) {
    ow = w;
    oh = h;
    return;
  }
  const double scale = static_cast<double>(longSide) / longest;
  ow = std::max(1, static_cast<int>(std::lround(w * scale)));
  oh = std::max(1, static_cast<int>(std::lround(h * scale)));
}

void drawSpotMarker(Image& img, int cx, int cy, int number) {
  const double ring = kMarkerRadius;
  const int reach = kMarkerRadius + 10;
  // Edges first, colour second, so a colour pixel is never overwritten by a neighbouring edge.
  for (int pass = 0; pass < 2; ++pass) {
    const bool edge = pass == 0;
    for (int y = cy - reach; y <= cy + reach; ++y) {
      if (y < 0 || y >= img.h) continue;
      for (int x = cx - reach; x <= cx + reach; ++x) {
        if (x < 0 || x >= img.w) continue;
        const int dx = x - cx, dy = y - cy;
        const double d = std::sqrt(static_cast<double>(dx * dx + dy * dy));
        const double fromRing = std::fabs(d - ring);
        // The crosshair leaves a gap around the centre so the spot itself stays visible.
        const int along = std::max(std::abs(dx), std::abs(dy));
        const int across = std::min(std::abs(dx), std::abs(dy));
        const bool colour = fromRing <= 1.5 || (across <= 1 && along >= 7 && along <= kMarkerRadius + 8);
        const bool outline = fromRing <= 3.0 || (across <= 2 && along >= 6 && along <= kMarkerRadius + 9);
        if (edge ? outline : colour) paint(img, x, y, edge);
      }
    }
  }
  drawNumber(img, cx + kMarkerRadius - 2, cy - kMarkerRadius - 7 * kGlyphScale - 2, number);
}

std::string formatError(const std::string& id, const std::string& code, const std::string& message) {
  return "{\"type\":\"error\",\"id\":\"" + jsonEscape(id) + "\",\"code\":\"" + jsonEscape(code) + "\",\"message\":\"" +
         jsonEscape(message) + "\"}";
}

Reply handleCommand(const Command& cmd, const ContextPlatform& platform, int budgetMs) {
  try {
    switch (cmd.kind) {
      case Command::Kind::Bad: return Reply{formatError(cmd.id, "bad", cmd.error)};
      case Command::Kind::Ping: return Reply{"{\"type\":\"pong\",\"id\":\"" + jsonEscape(cmd.id) + "\"}"};
      case Command::Kind::Capture: return Reply{handleCapture(cmd, platform)};
      case Command::Kind::Foreground: {
        std::string app, title, windowId;
        uint32_t pid = 0;
        Failure fail;
        if (!platform.foreground(app, title, windowId, pid, fail)) {
          return Reply{formatError(cmd.id, fail.code, fail.message)};
        }
        return Reply{"{\"type\":\"foreground\",\"id\":\"" + jsonEscape(cmd.id) + "\",\"app\":\"" + jsonEscape(app) +
                     "\",\"title\":\"" + jsonEscape(title) + "\",\"window\":\"" + jsonEscape(windowId) +
                     "\",\"pid\":" + std::to_string(pid) + "}"};
      }
      case Command::Kind::Front: {
        if (!platform.front) return Reply{formatError(cmd.id, "bad", "front is not available here")};
        FrontWindow w;
        Failure fail;
        if (!platform.front(w, fail)) return Reply{formatError(cmd.id, fail.code, fail.message)};
        return Reply{"{\"type\":\"front\",\"id\":\"" + jsonEscape(cmd.id) + "\",\"window\":\"" + jsonEscape(w.window) +
                     "\",\"title\":\"" + jsonEscape(w.title) + "\",\"x\":" + std::to_string(w.box.x) +
                     ",\"y\":" + std::to_string(w.box.y) + ",\"w\":" + std::to_string(w.box.w) +
                     ",\"h\":" + std::to_string(w.box.h) + ",\"pid\":" + std::to_string(w.pid) + "}"};
      }
      case Command::Kind::Read: return handleRead(cmd, platform, budgetMs);
      case Command::Kind::Paste: return handlePaste(cmd, platform, budgetMs);
      case Command::Kind::SetField: return handleSetField(cmd, platform, budgetMs);
      case Command::Kind::Shutdown: break;
    }
  } catch (const std::exception& e) {  // a huge display can run out of memory; the helper stays up
    return Reply{formatError(cmd.id, "capture", e.what())};
  }
  return Reply{formatError(cmd.id, "bad", "nothing to do")};
}

std::string marksFileText(const std::vector<RawMark>& marks) {
  std::string out;
  for (const RawMark& m : marks) {
    out += m.kind + "\t" + std::to_string(m.box.x) + "\t" + std::to_string(m.box.y) + "\t" + std::to_string(m.box.w) +
           "\t" + std::to_string(m.box.h) + "\t";
    for (const char c : cutText(m.text, kMarkTextMax)) out += c == '\t' || c == '\r' || c == '\n' ? ' ' : c;
    out += '\n';
  }
  return out;
}

bool neverFillLabel(const std::string& label) {
  // The same list, in the same order, as NEVER_FILL_LABELS in src/shared/teammate/doRules.ts; both are tested against
  // tests/fixtures/never-fill-labels.json. English patterns match whole words, plural too, so "PIN" does not catch
  // "Shipping"; a `_` in the label counts as a word break. Chinese has no word breaks: substrings.
  static const std::vector<std::regex> patterns = [] {
    const char* const sources[] = {
        R"(\bpass(?:word|wd|code|phrase)s?\b)",
        R"(\bpins?\b)",
        R"(\b(?:credit|debit)\s+cards?\b)",
        R"(\bcard\s*(?:number|num|no|#)(?!\w))",
        R"(\bcv[vcn]2?s?\b)",
        R"(\bsecurity\s+codes?\b)",
        R"(\bexpir(?:y|ation|es)s?\b)",
        R"(\bibans?\b)",
        R"(\b(?:account|routing)\s*(?:number|num|no)s?\b)",
        R"(\bssns?\b)",
        R"(\bsocial\s+security\b)",
        R"(\bpassports?\b)",
        R"(\b(?:id|identity|identification)\s*(?:number|num|no)s?\b)",
        R"(\bexp\.?\s*dates?\b)",
        R"(\bmm\s*/\s*yy\b)",
        R"(\bvalid\s+(?:thru|through|until)\b)",
        R"(\b(?:national|tax)\s+ids?\b)",
        R"(\bid\s+cards?\b)",
        R"(\btins?\b)",
        R"(\bcc\s*(?:number|num|no)s?\b)",
        R"(\bcard\s+verification\b)",
        R"(\bone[-\s]time\s+codes?\b)",
        R"(\bverification\s+codes?\b)",
        R"(\botps?\b)",
        R"(\bpwds?\b)",
        R"(\bsort\s+codes?\b)",
        R"(\ba/c\s*(?:number|num|no)s?\b)",
        R"(\bsocial\s+insurance\b)",
    };
    std::vector<std::regex> out;
    for (const char* source : sources) out.emplace_back(source, std::regex::ECMAScript | std::regex::icase);
    return out;
  }();
  // UTF-8 bytes, as the compiler may not read this file as UTF-8: the TS list's password, card number, bank card,
  // security code, validity period, ID card, passport, document number, credit card, debit card, bank account (two
  // words), verification code, taxpayer number and social insurance words, in that order.
  static const char* const kChinese[] = {
      "\xe5\xaf\x86\xe7\xa0\x81",
      "\xe5\x8d\xa1\xe5\x8f\xb7",
      "\xe9\x93\xb6\xe8\xa1\x8c\xe5\x8d\xa1",
      "\xe5\xae\x89\xe5\x85\xa8\xe7\xa0\x81",
      "\xe6\x9c\x89\xe6\x95\x88\xe6\x9c\x9f",
      "\xe8\xba\xab\xe4\xbb\xbd\xe8\xaf\x81",
      "\xe6\x8a\xa4\xe7\x85\xa7",
      "\xe8\xaf\x81\xe4\xbb\xb6\xe5\x8f\xb7",
      "\xe4\xbf\xa1\xe7\x94\xa8\xe5\x8d\xa1",
      "\xe5\x80\x9f\xe8\xae\xb0\xe5\x8d\xa1",
      "\xe9\x93\xb6\xe8\xa1\x8c\xe8\xb4\xa6\xe5\x8f\xb7",
      "\xe9\x93\xb6\xe8\xa1\x8c\xe8\xb4\xa6\xe6\x88\xb7",
      "\xe9\xaa\x8c\xe8\xaf\x81\xe7\xa0\x81",
      "\xe7\xba\xb3\xe7\xa8\x8e\xe4\xba\xba\xe8\xaf\x86\xe5\x88\xab\xe5\x8f\xb7",
      "\xe7\xa4\xbe\xe4\xbf\x9d",
  };
  std::string words = label;
  std::replace(words.begin(), words.end(), '_', ' ');
  for (const std::regex& p : patterns) {
    if (std::regex_search(words, p)) return true;
  }
  for (const char* word : kChinese) {
    if (label.find(word) != std::string::npos) return true;
  }
  return false;
}

std::string formFieldsFileText(const std::vector<RawField>& fields) {
  const auto quoted = [](const std::string& s, size_t max) { return "\"" + jsonEscape(cutText(s, max)) + "\""; };
  std::string out;
  for (size_t i = 0; i < fields.size() && i < kMaxFormFields; ++i) {
    const RawField& f = fields[i];
    if (f.id.size() > kFieldIdMax) continue;  // a cut id would name another field, or none
    // A password, card number or ID number is a secret whether or not the page marks it as one.
    const bool secure = f.secure || neverFillLabel(f.label);
    out += "{\"id\":" + quoted(f.id, kFieldIdMax) + ",\"kind\":" + quoted(f.kind, 16) +
           ",\"label\":" + quoted(f.label, kFieldLabelMax) + ",\"group\":" + quoted(f.group, kFieldLabelMax) +
           ",\"value\":" + quoted(secure ? std::string() : f.value, kFieldValueMax) +
           ",\"secure\":" + (secure ? "true" : "false") + ",\"required\":" + (f.required ? "true" : "false") +
           ",\"options\":[";
    for (size_t j = 0; j < f.options.size() && j < kMaxFieldOptions; ++j) {
      out += (j == 0 ? "" : ",") + quoted(f.options[j], kFieldOptionMax);
    }
    out += "]";
    if (f.box.w > 0 && f.box.h > 0) out += ",\"box\":\"" + rectText(f.box) + "\"";
    out += "}\n";
  }
  return out;
}

std::string cutText(const std::string& text, size_t maxChars) {
  size_t chars = 0;
  for (size_t i = 0; i < text.size(); ++i) {
    // A byte that is not a continuation byte starts a character, so the cut never splits one.
    if ((static_cast<unsigned char>(text[i]) & 0xC0) != 0x80 && ++chars > maxChars) return text.substr(0, i);
  }
  return text;
}

namespace {

// Extensions that name a document in a title: Office, PDF and e-book files, plus every extension the file layer
// reads as text (TEXT_EXTENSIONS in src/main/teammate/files/text.ts; keep the two lists in step).
constexpr const char* kFileExtensions[] = {
    "pdf", "docx", "doc", "pptx", "ppt", "xlsx", "xls", "rtf", "epub",
    "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "log", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf",
    "srt", "vtt", "tex", "rst", "html", "htm", "css",
    "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "java", "kt", "c", "h", "cpp", "hpp", "cs", "go", "rs",
    "rb", "php", "swift", "sh", "bat", "ps1", "sql"};

bool isSpace(char c) { return c == ' ' || c == '\t' || c == '\r' || c == '\n'; }

char lowerAscii(char c) { return c >= 'A' && c <= 'Z' ? static_cast<char>(c - 'A' + 'a') : c; }

bool isAsciiLetter(char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'); }

bool isDigit(char c) { return c >= '0' && c <= '9'; }

std::string trim(const std::string& s) {
  size_t a = 0, b = s.size();
  while (a < b && isSpace(s[a])) ++a;
  while (b > a && isSpace(s[b - 1])) --b;
  return s.substr(a, b - a);
}

std::string lowered(std::string s) {
  for (char& c : s) c = lowerAscii(c);
  return s;
}

// Editors mark an unsaved file with a leading '*' (Notepad) or U+25CF (VS Code).
std::string withoutUnsavedMark(const std::string& s) {
  std::string t = trim(s);
  if (t.rfind('*', 0) == 0) t.erase(0, 1);
  else if (t.rfind("\xe2\x97\x8f", 0) == 0) t.erase(0, 3);
  return trim(t);
}

bool hasFileExtension(const std::string& name) {
  const size_t dot = name.find_last_of('.');
  if (dot == std::string::npos || dot == 0 || isSpace(name[dot - 1])) return false;
  const std::string ext = lowered(name.substr(dot + 1));
  return std::any_of(std::begin(kFileExtensions), std::end(kFileExtensions),
                     [&ext](const char* known) { return ext == known; });
}

// Notepad++ and others show the whole path; the lookups want the name.
std::string baseName(const std::string& s) {
  const size_t slash = s.find_last_of("\\/");
  return slash == std::string::npos ? s : s.substr(slash + 1);
}

std::vector<std::string> splitOn(const std::string& s, const std::string& sep) {
  std::vector<std::string> parts;
  size_t start = 0;
  while (true) {
    const size_t at = s.find(sep, start);
    parts.push_back(s.substr(start, at == std::string::npos ? std::string::npos : at - start));
    if (at == std::string::npos) return parts;
    start = at + sep.size();
  }
}

int hexValue(char c) {
  if (isDigit(c)) return c - '0';
  const char l = lowerAscii(c);
  return l >= 'a' && l <= 'f' ? l - 'a' + 10 : -1;
}

std::string percentDecoded(const std::string& s) {
  std::string out;
  for (size_t i = 0; i < s.size(); ++i) {
    const int hi = s[i] == '%' && i + 2 < s.size() ? hexValue(s[i + 1]) : -1;
    const int lo = hi >= 0 ? hexValue(s[i + 2]) : -1;
    if (lo < 0) {
      out += s[i];
      continue;
    }
    out += static_cast<char>(hi * 16 + lo);
    i += 2;
  }
  return out;
}

bool isDrivePath(const std::string& s) {
  return s.size() >= 3 && isAsciiLetter(s[0]) && s[1] == ':' && (s[2] == '/' || s[2] == '\\');
}

// "example.com", "localhost:3000": a host a browser opens without a scheme. "about:blank" and plain words are not.
bool looksLikeHost(const std::string& host) {
  const size_t colon = host.find(':');
  const std::string name = host.substr(0, colon);
  if (colon != std::string::npos) {
    const std::string port = host.substr(colon + 1);
    if (port.empty() || !std::all_of(port.begin(), port.end(), isDigit)) return false;
  }
  if (name.empty() || name.front() == '.' || name.back() == '.') return false;
  const bool plain = std::all_of(name.begin(), name.end(), [](char c) {
    return isAsciiLetter(c) || isDigit(c) || c == '-' || c == '.' || (static_cast<unsigned char>(c) & 0x80) != 0;
  });
  return plain && (name.find('.') != std::string::npos || lowered(name) == "localhost");
}

bool hasScheme(const std::string& v) {
  const size_t end = v.find("://");
  if (end == std::string::npos || end == 0 || !isAsciiLetter(v[0])) return false;
  return std::all_of(v.begin(), v.begin() + static_cast<std::ptrdiff_t>(end), [](char c) {
    return isAsciiLetter(c) || isDigit(c) || c == '+' || c == '-' || c == '.';
  });
}

}  // namespace

std::string fileNameFromTitle(const std::string& title) {
  const std::string t = trim(title);
  const size_t last = t.rfind(" - ");
  const std::string before = last == std::string::npos ? std::string() : withoutUnsavedMark(t.substr(0, last));
  if (hasFileExtension(before)) return baseName(before);
  const std::vector<std::string> parts = splitOn(t, " - ");
  for (auto it = parts.rbegin(); it != parts.rend(); ++it) {
    const std::string part = withoutUnsavedMark(*it);
    if (hasFileExtension(part)) return baseName(part);
  }
  const std::vector<std::string> words = splitOn(t, " ");
  for (auto it = words.rbegin(); it != words.rend(); ++it) {
    if (hasFileExtension(*it)) return baseName(*it);
  }
  return baseName(before);
}

std::string acrobatMruPath(const std::string& value) {
  if (value.size() < 4 || value[0] != '/' || !isAsciiLetter(value[1]) || value[2] != '/') return "";
  std::string path = value.substr(1, 1) + ":" + value.substr(2);
  std::replace(path.begin(), path.end(), '/', '\\');
  return path;
}

std::string officeMruPath(const std::string& value) {
  const size_t star = value.find('*');
  return star == std::string::npos ? std::string() : value.substr(star + 1);
}

bool browserAddress(const std::string& value, std::string& path, std::string& address) {
  path.clear();
  address.clear();
  const std::string v = trim(value);
  if (v.empty()) return false;
  std::string local;
  if (isDrivePath(v)) {
    local = percentDecoded(v);
  } else if (lowered(v.substr(0, 7)) == "file://") {
    // A query or fragment (Edge's PDF viewer adds "#page=N") is no part of the path; encoded ones are.
    const std::string rest = percentDecoded(v.substr(7, v.find_first_of("?#") - 7));
    if (rest.rfind('/', 0) == 0) local = rest.substr(1);  // file:///C:/a
    else if (!rest.empty()) local = "//" + rest;           // file://server/share
    if (!isDrivePath(local) && local.rfind("//", 0) != 0) return false;
  }
  if (!local.empty()) {
    std::replace(local.begin(), local.end(), '/', '\\');
    path = local;
    return true;
  }
  if (std::any_of(v.begin(), v.end(), isSpace)) return false;
  if (hasScheme(v)) {
    address = v;
    return true;
  }
  if (!looksLikeHost(v.substr(0, v.find_first_of("/?#")))) return false;
  address = "https://" + v;
  return true;
}

namespace {

constexpr const char* kExclusionNames[] = {"ExcludeClipboardContentFromMonitorProcessing",
                                           "CanIncludeInClipboardHistory", "CanUploadToCloudClipboard"};

bool isExclusionName(const std::string& name) {
  return std::any_of(std::begin(kExclusionNames), std::end(kExclusionNames),
                     [&name](const char* known) { return name == known; });
}

// Windows makes these up from another format on the clipboard: CF_TEXT, CF_BITMAP, CF_METAFILEPICT, CF_OEMTEXT,
// CF_PALETTE, CF_LOCALE and CF_DIBV5.
bool isSynthesized(unsigned id) { return id == 1 || id == 2 || id == 3 || id == 7 || id == 9 || id == 16 || id == 17; }

// No memory to copy: the owner-display formats, and the private and GDI object ranges.
bool isHandleFormat(unsigned id) {
  return id == 0x80 || id == 0x82 || id == 0x83 || id == 0x8E || (id >= 0x200 && id <= 0x3FF);
}

// UTF-16LE with its terminating zero, as CF_UNICODETEXT holds text; a malformed byte becomes U+FFFD.
std::vector<uint8_t> utf16Text(const std::string& s) {
  std::vector<uint8_t> out;
  const auto unit = [&out](uint32_t u) {
    out.push_back(static_cast<uint8_t>(u & 0xFF));
    out.push_back(static_cast<uint8_t>((u >> 8) & 0xFF));
  };
  size_t i = 0;
  while (i < s.size()) {
    const auto b = static_cast<unsigned char>(s[i]);
    const int more = b < 0x80 ? 0 : (b & 0xE0) == 0xC0 ? 1 : (b & 0xF0) == 0xE0 ? 2 : (b & 0xF8) == 0xF0 ? 3 : -1;
    uint32_t cp = more == 0 ? b : more == 1 ? (b & 0x1Fu) : more == 2 ? (b & 0x0Fu) : (b & 0x07u);
    bool ok = more >= 0 && i + static_cast<size_t>(more) < s.size();
    for (int k = 1; ok && k <= more; ++k) {
      const auto c = static_cast<unsigned char>(s[i + static_cast<size_t>(k)]);
      ok = (c & 0xC0) == 0x80;
      cp = (cp << 6) | (c & 0x3Fu);
    }
    const uint32_t least = more == 1 ? 0x80 : more == 2 ? 0x800 : more == 3 ? 0x10000 : 0;
    if (!ok || cp < least || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) {
      unit(0xFFFD);
      ++i;
      continue;
    }
    if (cp >= 0x10000) {
      unit(0xD800 + ((cp - 0x10000) >> 10));
      unit(0xDC00 + ((cp - 0x10000) & 0x3FF));
    } else {
      unit(cp);
    }
    i += static_cast<size_t>(more) + 1;
  }
  unit(0);
  return out;
}

std::string resultLine(const char* type, const std::string& id, const std::string& result) {
  return "{\"type\":\"" + std::string(type) + "\",\"id\":\"" + jsonEscape(id) + "\",\"result\":\"" + result + "\"}";
}

// The window in front now, by the foreground reply's id; empty when it can't be read.
std::string frontWindow(const ContextPlatform& p) {
  if (p.frontWindowId) return p.frontWindowId();
  std::string app, title, window;
  uint32_t pid = 0;
  Failure fail;
  return p.foreground(app, title, window, pid, fail) ? window : std::string();
}

bool hasPasteRoute(const ContextPlatform& p) {
  return p.foreground && p.responsive && p.elevated && p.windowAt && p.focusedSelection && p.fieldFacts &&
         p.keyStates && p.openClipboard && p.closeClipboard && p.clipboardFormats && p.readClipboard &&
         p.writeClipboard && p.clipboardSequence && p.click && p.pressPaste && p.wait && p.now;
}

// Another app may hold the clipboard for a moment.
bool openClipboardSoon(const ContextPlatform& p) {
  for (int i = 0; i < kClipboardTries; ++i) {
    if (i > 0) p.wait(kClipboardRetryMs);
    if (p.openClipboard()) return true;
  }
  return false;
}

// `formats` with the exclusion formats, so neither the pasted text nor the restored clipboard lands in Win+V history
// or the cloud clipboard as a new item.
bool putOnClipboard(const ContextPlatform& p, std::vector<ClipFormat> formats) {
  for (ClipFormat& f : exclusionFormats()) formats.push_back(std::move(f));
  const bool ok = p.writeClipboard(formats);
  p.closeClipboard();
  return ok;
}

// Puts the saved clipboard back once, on whichever way a paste ends after its text went on the clipboard, an exception
// included.
class ClipboardRestore {
 public:
  ClipboardRestore(const ContextPlatform& p, std::vector<ClipFormat> saved, uint32_t written, int64_t deadline)
      : p_(p), saved_(std::move(saved)), written_(written), deadline_(deadline) {}
  ClipboardRestore(const ClipboardRestore&) = delete;
  ClipboardRestore& operator=(const ClipboardRestore&) = delete;
  ~ClipboardRestore() {
    try {
      restore();
    } catch (...) {  // the reply is already on its way, or an error reply is
    }
  }

  /** False only when a restore was needed and failed. */
  bool restore() {
    if (done_) return ok_;
    done_ = true;
    // Something newer was copied since the pasted text went on: it wins over the old clipboard.
    if (p_.clipboardSequence() != written_) return ok_ = true;
    const int64_t until = std::min(p_.now() + kRestoreTryMs, deadline_);
    while (!p_.openClipboard()) {
      if (p_.now() >= until) return ok_ = false;
      p_.wait(kClipboardRetryMs);
    }
    return ok_ = putOnClipboard(p_, saved_);
  }

 private:
  const ContextPlatform& p_;
  std::vector<ClipFormat> saved_;
  uint32_t written_;
  int64_t deadline_;
  bool done_ = false, ok_ = true;
};

// A field the helper never writes: a password field, or a label that names a password, card, ID or the like.
bool secureField(const FieldFacts& f) { return f.secure || neverFillLabel(f.label); }

// What the checks that call into the target found; the flag is atomic as a slow check outlives its command.
struct PasteChecks {
  std::atomic<bool> secureChecked{false};
  bool secure = true;
  bool selectionHolds = false;
  bool onField = true;  // the element under the click is the field meant
};

// Text as the paste command carries it: without the control characters the client leaves out (helperText in
// contextProtocol.ts), which Word puts in a selection (U+000B for a line break), and without the spaces around it.
std::string comparable(const std::string& text) {
  std::string out;
  for (const char c : text) {
    const auto b = static_cast<unsigned char>(c);
    if (b < 0x20 && c != '\t' && c != '\n' && c != '\r') continue;
    out += c;
  }
  return trim(out);
}

}  // namespace

std::string clickTarget(const FieldFacts& under, const std::string& expected) {
  if (expected.empty()) return under.kind == "text" || under.kind == "multiline" ? "" : "window";
  if (under.id == expected) return "";
  // A clear or emoji button inside the field would do something of its own.
  if (under.activatable) return "window";
  for (size_t i = 0; i < under.ancestors.size() && i < kFieldAncestors; ++i) {
    const AncestorFacts& a = under.ancestors[i];
    if (a.id == expected) return a.secure || neverFillLabel(a.label) ? "secure" : "";
    // The click would bubble up to a button or link inside the field on its way to the field.
    if (a.activatable) return "window";
  }
  return "window";
}

std::vector<ClipFormat> formatsToRestore(const std::vector<ClipFormat>& listed) {
  std::vector<ClipFormat> out;
  for (const ClipFormat& f : listed) {
    if (isSynthesized(f.id) || isHandleFormat(f.id) || isExclusionName(f.name)) continue;
    if (f.name == "DataObject" || f.name == "Ole Private Data") continue;
    out.push_back(f);
  }
  return out;
}

std::vector<ClipFormat> exclusionFormats() {
  std::vector<ClipFormat> out;
  // A DWORD 0: "no" for history and the cloud clipboard; monitors skip the item whatever it holds.
  for (const char* name : kExclusionNames) out.push_back(ClipFormat{0, name, {0, 0, 0, 0}});
  return out;
}

bool isExclusionFormat(const std::string& name) { return isExclusionName(name); }

bool handsOff(const std::vector<uint16_t>& states) {
  // The low bit says the key went down since the last call, even if it is up again: not a held key.
  return std::none_of(states.begin(), states.end(), [](uint16_t s) { return (s & 0x8000) != 0; });
}

namespace {

// Every check runs after the hands-off wait, when the user has let go: the window, the frozen-app check (before
// anything calls into the target), an app run as administrator, a secure field, a replace's selection. Then the text
// goes on the clipboard and the cheap checks run again right before any input. The whole paste fits kPasteDeadlineMs;
// a refusal after the text went on the clipboard puts the saved clipboard back first.
Reply handlePaste(const Command& cmd, const ContextPlatform& p, int budgetMs) {
  const PasteRequest& r = cmd.paste;
  const auto reply = [&cmd](const char* result, bool exitAfter = false, bool restored = true) {
    std::string line = resultLine("pasted", cmd.id, result);
    if (!restored) line.insert(line.size() - 1, ",\"restored\":false");
    return Reply{line, exitAfter};
  };
  if (!hasPasteRoute(p)) return Reply{formatError(cmd.id, "bad", "paste is not available here")};
  const int64_t start = p.now();
  const int64_t deadline = start + kPasteDeadlineMs;
  if (frontWindow(p) != r.window) return reply("window");
  // The user is letting go of the ask's key, and may move focus or the selection meanwhile: wait first.
  while (!handsOff(p.keyStates())) {
    if (p.now() - start >= kHandsOffWaitMs) return reply("hands");
    p.wait(kHandsPollMs);
  }
  if (frontWindow(p) != r.window) return reply("window");
  if (!p.responsive(r.window)) return reply("hung");
  if (p.elevated(r.window)) return reply("elevated");
  if (r.click && p.windowAt(*r.click) != r.window) return reply("window");

  const auto checks = std::make_shared<PasteChecks>();
  const auto selection = p.focusedSelection;
  const auto facts = p.fieldFacts;
  const bool replace = r.replace;
  const std::string asked = comparable(r.asked);
  const std::optional<Point> click = r.click;
  const std::string expected = r.field;
  // Any of these can block on an app that stopped answering after the check above: they get a deadline of their own,
  // and one that can't answer in time, or at all, refuses the paste.
  const bool done = runWithBudget(
      [checks, selection, facts, replace, asked, click, expected] {
        FieldFacts focus;
        bool secure = !facts(std::nullopt, focus) || secureField(focus);
        if (!secure && click) {
          FieldFacts under;
          secure = !facts(click, under) || secureField(under);
          // The page may have moved since the ask: a click lands only on the field it was meant for, never on a
          // button that took its place.
          if (!secure) {
            const std::string target = clickTarget(under, expected);
            secure = target == "secure";
            checks->onField = target.empty();
          }
        }
        checks->secure = secure;
        checks->secureChecked = true;
        if (secure || !replace) return;
        std::string now;
        checks->selectionHolds = selection(now) && !asked.empty() && comparable(now) == asked;
      },
      budgetMs * 4 / 5);
  if (!done) return reply(checks->secureChecked ? "selection" : "secure", true);
  if (checks->secure) return reply("secure");
  if (!checks->onField) return reply("window");
  if (replace && !checks->selectionHolds) return reply("selection");

  if (!openClipboardSoon(p)) return reply("busy");
  // A clipboard that can't be read whole can't be put back: nothing is written over it.
  std::vector<ClipFormat> saved;
  bool whole = true;
  for (ClipFormat f : formatsToRestore(p.clipboardFormats())) {
    if (p.readClipboard(f)) {
      saved.push_back(std::move(f));
    } else {
      whole = false;
    }
  }
  if (!whole) {
    p.closeClipboard();
    return reply("busy");
  }
  // Too late to click, wait a second and put the clipboard back before the client gives up on the reply.
  const int64_t tail = (r.click ? kClickSettleMs : 0) + kAnswerWaitMs + kRestoreAfterMs + kRestoreReserveMs;
  if (deadline - p.now() < tail) {
    p.closeClipboard();
    return reply("busy");
  }
  const bool set = putOnClipboard(p, {ClipFormat{kClipUnicodeText, "", utf16Text(r.text)}});
  ClipboardRestore restore(p, std::move(saved), p.clipboardSequence(), deadline);
  const auto refuse = [&](const char* result) { return reply(result, false, restore.restore()); };
  if (!set) return refuse("busy");
  // Right before any input: the user may have moved on while the clipboard was set.
  if (frontWindow(p) != r.window) return refuse("window");
  if (!handsOff(p.keyStates())) return refuse("hands");
  if (r.click && p.windowAt(*r.click) != r.window) return refuse("window");
  if (!p.responsive(r.window)) return refuse("hung");
  if (r.click) {
    if (!p.click(*r.click)) return refuse("busy");
    p.wait(kClickSettleMs);
    // The click may have brought another window up.
    if (frontWindow(p) != r.window) return refuse("window");
  }
  const bool pressed = p.pressPaste();
  p.wait(kRestoreAfterMs);
  return reply(pressed ? "ok" : "busy", false, restore.restore());
}

Reply handleSetField(const Command& cmd, const ContextPlatform& p, int budgetMs) {
  const SetFieldRequest& r = cmd.setField;
  const auto reply = [&cmd](const std::string& result, bool exitAfter = false) {
    return Reply{resultLine("set", cmd.id, result), exitAfter};
  };
  if (!p.foreground || !p.responsive || !p.setField) {
    return Reply{formatError(cmd.id, "bad", "setField is not available here")};
  }
  if (frontWindow(p) != r.window) return reply("window");
  if (!p.responsive(r.window)) return reply("hung");
  const auto result = std::make_shared<std::string>("refused");
  const auto setField = p.setField;
  const SetFieldRequest request = r;
  const bool done = runWithBudget(
      [result, setField, request] {
        *result = setField(request, [](const FieldFacts& f) { return secureField(f) ? "secure" : std::string(); });
      },
      budgetMs * 3 / 2);
  // Still inside UI Automation: the app is not answering, and whether the value went in is unknown.
  if (!done) return reply("hung", true);
  const std::string& got = *result;
  return reply(got == "ok" || got == "gone" || got == "secure" ? got : "refused");
}

}  // namespace

bool runWithBudget(const std::function<void()>& probe, int budgetMs) {
  return runAllWithBudget({probe}, budgetMs);
}

bool runAllWithBudget(const std::vector<std::function<void()>>& probes, int budgetMs, std::vector<bool>* finished) {
  struct State {
    std::mutex m;
    std::condition_variable cv;
    size_t running = 0;
    std::vector<bool> done;
  };
  const auto state = std::make_shared<State>();
  state->running = probes.size();
  state->done.assign(probes.size(), false);
  std::vector<std::thread> workers;
  try {
    for (size_t i = 0; i < probes.size(); ++i) {
      workers.emplace_back([state, probe = probes[i], i] {
        try {
          probe();
        } catch (...) {  // a throwing probe is a failed one, not a dead helper
        }
        {
          const std::lock_guard<std::mutex> lock(state->m);
          --state->running;
          state->done[i] = true;
        }
        state->cv.notify_all();
      });
    }
  } catch (...) {  // no thread for one of them: the started ones own their copies
    for (std::thread& w : workers) w.detach();
    throw;
  }
  bool done = false;
  {
    std::unique_lock<std::mutex> lock(state->m);
    done = state->cv.wait_for(lock, std::chrono::milliseconds(budgetMs), [&state] { return state->running == 0; });
    // Read under the lock: a probe marked done wrote its output before it took the lock.
    if (finished) *finished = state->done;
  }
  // A slow probe cannot be cancelled; it keeps only its own copies and dies with the process.
  for (std::thread& w : workers) {
    if (done) w.join();
    else w.detach();
  }
  return done;
}

int runContextLoop(std::istream& in, const std::function<bool(const std::string&)>& write,
                   const ContextPlatform& platform, int budgetMs) {
  std::string line;
  while (std::getline(in, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (line.find_first_not_of(" \t") == std::string::npos) continue;
    const Command cmd = parseCommand(line);
    if (cmd.kind == Command::Kind::Shutdown) return 0;
    const Reply reply = handleCommand(cmd, platform, budgetMs);
    if (!write(reply.line)) return 0;  // lolPing is gone
    if (reply.exitAfter) return kExitNow;
  }
  return 0;
}

}  // namespace lp::ctx
