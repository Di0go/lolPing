#include "context.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <exception>
#include <filesystem>
#include <fstream>
#include <map>
#include <memory>
#include <mutex>
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

Command parseMarks(const Fields& m, const std::string& id) {
  Command c;
  c.kind = Command::Kind::Marks;
  c.id = id;
  MarksRequest& r = c.marks;
  const auto of = m.find("of");
  if (of == m.end() || !validId(of->second)) return bad(id, "of must name a capture");
  r.of = of->second;
  if (const std::string why = spotsField(m, r.spots); !why.empty()) return bad(id, why);
  if (!intField(m, "radius", 0, 32768, r.radius)) return bad(id, "radius out of range");
  if (!boolField(m, "ocr", r.ocr) || !boolField(m, "controls", r.controls)) {
    return bad(id, "ocr and controls must be true or false");
  }
  if (const std::string why = dirField(m, r.dir); !why.empty()) return bad(id, why);
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

std::string handleCapture(const Command& cmd, const ContextPlatform& platform, LastGrab& last) {
  const CaptureRequest& r = cmd.capture;
  Failure fail;
  Image full;
  if (!platform.grab(r.display, full, fail)) return formatError(cmd.id, fail.code, fail.message);
  if (full.w < 1 || full.h < 1 || full.px.size() != static_cast<size_t>(full.w) * full.h * 4) {
    return formatError(cmd.id, "capture", "the capture came back empty");
  }

  int ow = 0, oh = 0;
  overviewSize(full.w, full.h, r.overviewLongSide, ow, oh);
  Image overview;
  if (ow == full.w && oh == full.h) overview = full;
  else if (!platform.resize(full, ow, oh, overview)) return formatError(cmd.id, "capture", "could not resize");
  drawSpots(overview, r.spots, r.display);
  const std::string overviewPath = joinPath(r.dir, "overview-" + cmd.id + ".jpg");
  if (!platform.writeJpeg(overview, r.quality, overviewPath, fail)) return formatError(cmd.id, fail.code, fail.message);

  const double sx = static_cast<double>(full.w) / r.display.w;
  const double sy = static_cast<double>(full.h) / r.display.h;
  std::string zooms, zoomRects;
  for (size_t i = 0; i < r.spots.size(); ++i) {
    // The zoom is zoomW x zoomH pixels of the capture, so on a Retina display it covers fewer points.
    const Rect z = zoomRectAround(r.display, r.spots[i], std::max(1, static_cast<int>(std::lround(r.zoomW / sx))),
                                  std::max(1, static_cast<int>(std::lround(r.zoomH / sy))));
    const int px = clampInt(static_cast<int>(std::lround((z.x - r.display.x) * sx)), 0, full.w - 1);
    const int py = clampInt(static_cast<int>(std::lround((z.y - r.display.y) * sy)), 0, full.h - 1);
    const int pw = clampInt(static_cast<int>(std::lround(z.w * sx)), 1, full.w - px);
    const int ph = clampInt(static_cast<int>(std::lround(z.h * sy)), 1, full.h - py);
    Image zoom = crop(full, px, py, pw, ph);
    drawSpots(zoom, r.spots, z);
    const std::string path = joinPath(r.dir, "zoom-" + cmd.id + "-" + std::to_string(i + 1) + ".jpg");
    if (!platform.writeJpeg(zoom, r.quality, path, fail)) return formatError(cmd.id, fail.code, fail.message);
    zooms += (i == 0 ? "" : ";") + path;
    zoomRects += (i == 0 ? "" : ";") + rectText(z);
  }
  last.id = cmd.id;
  last.display = r.display;
  last.image = std::make_shared<const Image>(std::move(full));
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

// Runs `call` on its own thread; `call` must hold copies of everything it reads. False when over budget.
template <typename Out, typename Call>
bool runProbe(const std::shared_ptr<Probe<Out>>& job, Call call) {
  return runWithBudget([job, call] { job->ok = call(job->out, job->fail); }, kProbeBudgetMs);
}

Reply slowReply(const std::string& id) {
  return Reply{formatError(id, "slow", "the system took too long to answer"), true};
}

// The bounding box of the (at least one) spots +/- radius, clipped to the display, in the grab's pixels.
Rect ocrArea(const std::vector<Point>& spots, int radius, const LastGrab& grab) {
  const Rect& d = grab.display;
  int x0 = spots[0].x - radius, y0 = spots[0].y - radius, x1 = spots[0].x + radius, y1 = spots[0].y + radius;
  for (const Point& p : spots) {
    x0 = std::min(x0, p.x - radius);
    y0 = std::min(y0, p.y - radius);
    x1 = std::max(x1, p.x + radius);
    y1 = std::max(y1, p.y + radius);
  }
  const double sx = static_cast<double>(grab.image->w) / d.w;
  const double sy = static_cast<double>(grab.image->h) / d.h;
  const auto px = [&](int v, int origin, int size, double s, int limit) {
    return clampInt(static_cast<int>(std::lround((clampInt(v, origin, origin + size) - origin) * s)), 0, limit);
  };
  const int left = px(x0, d.x, d.w, sx, grab.image->w), right = px(x1, d.x, d.w, sx, grab.image->w);
  const int top = px(y0, d.y, d.h, sy, grab.image->h), bottom = px(y1, d.y, d.h, sy, grab.image->h);
  return Rect{left, top, std::max(0, right - left), std::max(0, bottom - top)};
}

// A box in the grab's pixels → request units.
Rect toRequest(const Rect& box, const LastGrab& grab) {
  const Rect& d = grab.display;
  const double sx = static_cast<double>(grab.image->w) / d.w;
  const double sy = static_cast<double>(grab.image->h) / d.h;
  const int x0 = d.x + static_cast<int>(std::lround(box.x / sx));
  const int y0 = d.y + static_cast<int>(std::lround(box.y / sy));
  const int x1 = d.x + static_cast<int>(std::lround((box.x + box.w) / sx));
  const int y1 = d.y + static_cast<int>(std::lround((box.y + box.h) / sy));
  return Rect{x0, y0, std::max(1, x1 - x0), std::max(1, y1 - y0)};
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

Reply handleMarks(const Command& cmd, const ContextPlatform& platform, const LastGrab& last) {
  const MarksRequest& r = cmd.marks;
  if (!last.image || last.id != r.of) return Reply{formatError(cmd.id, "bad", "that capture is gone")};
  std::vector<RawMark> marks;
  bool tried = false, found = false;
  Failure firstFail;
  const auto keep = [&](const Probe<std::vector<RawMark>>& job, bool scaled) {
    tried = true;
    if (!job.ok) {
      if (firstFail.message.empty()) firstFail = job.fail;
      return;
    }
    found = true;
    for (RawMark m : job.out) {
      if (scaled) m.box = toRequest(m.box, last);
      marks.push_back(std::move(m));
    }
  };
  const Rect area = r.spots.empty() ? Rect{} : ocrArea(r.spots, r.radius, last);
  if (r.ocr && area.w > 0 && area.h > 0) {
    const auto job = std::make_shared<Probe<std::vector<RawMark>>>();
    const auto ocr = platform.ocr;
    const std::shared_ptr<const Image> image = last.image;
    if (!runProbe(job, [ocr, image, area](std::vector<RawMark>& out, Failure& f) {
          return ocr(*image, area, out, f);
        })) {
      return slowReply(cmd.id);
    }
    keep(*job, true);
  }
  if (r.controls && !r.spots.empty()) {
    const auto job = std::make_shared<Probe<std::vector<RawMark>>>();
    const auto controls = platform.controls;
    const std::vector<Point> spots = r.spots;
    const int radius = r.radius;
    if (!runProbe(job, [controls, spots, radius](std::vector<RawMark>& out, Failure& f) {
          return controls(spots, radius, out, f);
        })) {
      return slowReply(cmd.id);
    }
    keep(*job, false);
  }
  // One probe coming up empty-handed leaves its marks out; only nothing at all is an error.
  if (tried && !found) return Reply{formatError(cmd.id, firstFail.code, firstFail.message)};
  const std::string path = joinPath(r.dir, "marks-" + cmd.id + ".tsv");
  if (!writeTextFile(path, marksFileText(marks))) {
    return Reply{formatError(cmd.id, "capture", "could not write the marks file")};
  }
  return Reply{"{\"type\":\"marks\",\"id\":\"" + jsonEscape(cmd.id) + "\",\"path\":\"" + jsonEscape(path) +
               "\",\"count\":" + std::to_string(marks.size()) + "}"};
}

Reply handleSystemText(const Command& cmd, const ContextPlatform& platform) {
  const auto job = std::make_shared<Probe<SystemText>>();
  const auto systemText = platform.systemText;
  const std::vector<Point> spots = cmd.spots;
  if (!runProbe(job, [systemText, spots](SystemText& out, Failure& f) { return systemText(spots, out, f); })) {
    return slowReply(cmd.id);
  }
  if (!job->ok) return Reply{formatError(cmd.id, job->fail.code, job->fail.message)};
  const SystemText& t = job->out;
  std::string spotTexts;
  for (size_t i = 0; i < cmd.spots.size(); ++i) {
    std::string text = i < t.spotTexts.size() ? t.spotTexts[i] : std::string();
    std::replace(text.begin(), text.end(), kRecordSep, ' ');
    if (i > 0) spotTexts += kRecordSep;
    spotTexts += text;
  }
  // A password field's value never leaves the helper, whatever the probe read.
  const std::string value = t.focusSecure ? std::string() : t.focusValue;
  return Reply{"{\"type\":\"systemText\",\"id\":\"" + jsonEscape(cmd.id) + "\",\"selection\":\"" +
               jsonEscape(t.selection) + "\",\"spotTexts\":\"" + jsonEscape(spotTexts) + "\",\"focusKind\":\"" +
               jsonEscape(t.focusKind) + "\",\"focusLabel\":\"" + jsonEscape(t.focusLabel) + "\",\"focusValue\":\"" +
               jsonEscape(value) + "\",\"focusSecure\":" + (t.focusSecure ? "true" : "false") + ",\"address\":\"" +
               jsonEscape(t.address) + "\"}"};
}

struct FileInfo {
  std::string path, address, how = "none";
};

Reply handleFileOf(const Command& cmd, const ContextPlatform& platform) {
  const auto job = std::make_shared<Probe<FileInfo>>();
  const auto fileOf = platform.fileOf;
  if (!runProbe(job, [fileOf](FileInfo& out, Failure& f) { return fileOf(out.path, out.address, out.how, f); })) {
    return slowReply(cmd.id);
  }
  if (!job->ok) return Reply{formatError(cmd.id, job->fail.code, job->fail.message)};
  const FileInfo& file = job->out;
  return Reply{"{\"type\":\"fileOf\",\"id\":\"" + jsonEscape(cmd.id) + "\",\"path\":\"" + jsonEscape(file.path) +
               "\",\"address\":\"" + jsonEscape(file.address) + "\",\"how\":\"" + jsonEscape(file.how) + "\"}"};
}

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
  if (type->second == "marks") return parseMarks(m, id);
  Command c;
  c.id = id;
  if (type->second == "foreground") c.kind = Command::Kind::Foreground;
  else if (type->second == "ping") c.kind = Command::Kind::Ping;
  else if (type->second == "fileOf") c.kind = Command::Kind::FileOf;
  else if (type->second == "systemText") {
    c.kind = Command::Kind::SystemText;
    if (const std::string why = spotsField(m, c.spots); !why.empty()) return bad(id, why);
  } else return bad(id, "unknown type");
  return c;
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

Reply handleCommand(const Command& cmd, const ContextPlatform& platform, LastGrab& last) {
  try {
    switch (cmd.kind) {
      case Command::Kind::Bad: return Reply{formatError(cmd.id, "bad", cmd.error)};
      case Command::Kind::Ping: return Reply{"{\"type\":\"pong\",\"id\":\"" + jsonEscape(cmd.id) + "\"}"};
      case Command::Kind::Capture: return Reply{handleCapture(cmd, platform, last)};
      case Command::Kind::Foreground: {
        std::string app, title;
        Failure fail;
        if (!platform.foreground(app, title, fail)) return Reply{formatError(cmd.id, fail.code, fail.message)};
        return Reply{"{\"type\":\"foreground\",\"id\":\"" + jsonEscape(cmd.id) + "\",\"app\":\"" + jsonEscape(app) +
                     "\",\"title\":\"" + jsonEscape(title) + "\"}"};
      }
      case Command::Kind::Marks: return handleMarks(cmd, platform, last);
      case Command::Kind::SystemText: return handleSystemText(cmd, platform);
      case Command::Kind::FileOf: return handleFileOf(cmd, platform);
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
    size_t chars = 0;
    for (const char c : m.text) {
      // A byte that is not a continuation byte starts a character, so the cut never splits one.
      if ((static_cast<unsigned char>(c) & 0xC0) != 0x80 && ++chars > kMarkTextMax) break;
      out += c == '\t' || c == '\r' || c == '\n' ? ' ' : c;
    }
    out += '\n';
  }
  return out;
}

bool runWithBudget(const std::function<void()>& probe, int budgetMs) {
  struct State {
    std::mutex m;
    std::condition_variable cv;
    bool done = false;
  };
  const auto state = std::make_shared<State>();
  std::thread worker([state, probe] {
    try {
      probe();
    } catch (...) {  // a throwing probe is a failed one, not a dead helper
    }
    {
      const std::lock_guard<std::mutex> lock(state->m);
      state->done = true;
    }
    state->cv.notify_one();
  });
  bool done = false;
  {
    std::unique_lock<std::mutex> lock(state->m);
    done = state->cv.wait_for(lock, std::chrono::milliseconds(budgetMs), [&state] { return state->done; });
  }
  // A slow probe cannot be cancelled; it keeps only its own copies and dies with the process.
  if (done) worker.join();
  else worker.detach();
  return done;
}

int runContextLoop(std::istream& in, const std::function<bool(const std::string&)>& write,
                   const ContextPlatform& platform) {
  LastGrab last;
  std::string line;
  while (std::getline(in, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (line.find_first_not_of(" \t") == std::string::npos) continue;
    const Command cmd = parseCommand(line);
    if (cmd.kind == Command::Kind::Shutdown) return 0;
    const Reply reply = handleCommand(cmd, platform, last);
    if (!write(reply.line)) return 0;  // lolPing is gone
    if (reply.exitAfter) return 0;
  }
  return 0;
}

}  // namespace lp::ctx
