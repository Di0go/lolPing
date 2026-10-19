// Unit tests for the context helper's platform-free part (no screen capture).
// Build and run: npm run test:helper
#include <cstdio>
#include <map>
#include <sstream>
#include <string>
#include <vector>

#include "../src/context.h"
#include "../src/json.h"

using namespace lp::ctx;

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

Image blank(int w, int h, uint8_t v = 40) {
  Image img;
  img.w = w;
  img.h = h;
  img.px.assign(static_cast<size_t>(w) * h * 4, v);
  return img;
}

bool samePixel(const Image& a, const Image& b, int x, int y) {
  const size_t i = (static_cast<size_t>(y) * a.w + x) * 4;
  return a.px[i] == b.px[i] && a.px[i + 1] == b.px[i + 1] && a.px[i + 2] == b.px[i + 2];
}

std::map<std::string, std::string> fields(const std::string& line) {
  std::map<std::string, std::string> m;
  lp::parseFlatJson(line, m);
  return m;
}

// A capture command for display -1920,0 1920x1080 with two spots; `over` replaces fields (raw JSON values).
std::string captureLine(const std::map<std::string, std::string>& over = {}) {
  std::map<std::string, std::string> f{
      {"display", R"("-1920,0,1920,1080")"}, {"spots", R"("-1820,200;-420,900")"}, {"overview", "1600"},
      {"zoom", R"("1000,750")"}, {"quality", "80"}, {"dir", R"("C:\\Temp\\lp")"},
  };
  for (const auto& [k, v] : over) f[k] = v;
  std::string line = R"({"type":"capture","id":"a1")";
  for (const auto& [k, v] : f) line += ",\"" + k + "\":" + v;
  return line + "}";
}

}  // namespace

static void test_parse_capture_command() {
  const Command c = parseCommand(captureLine());
  CHECK(c.kind == Command::Kind::Capture);
  CHECK(c.id == "a1");
  CHECK(c.capture.display.x == -1920 && c.capture.display.y == 0);
  CHECK(c.capture.display.w == 1920 && c.capture.display.h == 1080);
  CHECK(c.capture.spots.size() == 2);
  CHECK(c.capture.spots[1].x == -420 && c.capture.spots[1].y == 900);
  CHECK(c.capture.overviewLongSide == 1600);
  CHECK(c.capture.zoomW == 1000 && c.capture.zoomH == 750);
  CHECK(c.capture.quality == 80);
  CHECK(c.capture.dir == "C:\\Temp\\lp");
}

static void test_parse_other_commands() {
  const Command f = parseCommand(R"({"type":"foreground","id":"f1"})");
  CHECK(f.kind == Command::Kind::Foreground && f.id == "f1");
  const Command p = parseCommand(R"({"type":"ping","id":"p1"})");
  CHECK(p.kind == Command::Kind::Ping && p.id == "p1");
  CHECK(parseCommand(R"({"type":"shutdown"})").kind == Command::Kind::Shutdown);
}

static void test_parse_rejects_bad_input() {
  CHECK(parseCommand("not json").kind == Command::Kind::Bad);
  CHECK(parseCommand(R"({"type":"dance","id":"x"})").kind == Command::Kind::Bad);
  CHECK(parseCommand(R"({"type":"ping"})").kind == Command::Kind::Bad);  // no id
  const auto bad = [](const std::string& field, const std::string& value) {
    return parseCommand(captureLine({{field, value}}));
  };
  const Command noRect = bad("display", R"("1,2,3")");
  CHECK(noRect.kind == Command::Kind::Bad);
  CHECK(noRect.id == "a1");  // the id is kept so the reply can name the request
  CHECK(bad("display", R"("0,0,0,1080")").kind == Command::Kind::Bad);  // empty display
  CHECK(bad("display", R"("0,0,1920x,1080")").kind == Command::Kind::Bad);
  CHECK(bad("spots", R"("100;200")").kind == Command::Kind::Bad);
  CHECK(bad("spots", R"("1,1;2,2;3,3;4,4;5,5")").kind == Command::Kind::Bad);  // more than 4
  CHECK(bad("overview", "0").kind == Command::Kind::Bad);
  CHECK(bad("zoom", R"("1000")").kind == Command::Kind::Bad);
  CHECK(bad("quality", "101").kind == Command::Kind::Bad);
  CHECK(bad("dir", R"("")").kind == Command::Kind::Bad);
  CHECK(bad("dir", R"("C:\\a;b")").kind == Command::Kind::Bad);  // ';' separates the reply's paths
  CHECK(parseCommand(R"({"type":"ping","id":"../x"})").kind == Command::Kind::Bad);  // the id names files
}

static void test_zoom_rect_stays_inside_the_display() {
  const Rect d{-1920, 0, 1920, 1080};
  const Rect mid = zoomRectAround(d, {-960, 540}, 1000, 750);
  CHECK(mid.x == -1460 && mid.y == 165 && mid.w == 1000 && mid.h == 750);
  const Rect corner = zoomRectAround(d, {-1910, 1070}, 1000, 750);
  CHECK(corner.x == -1920 && corner.y == 330);
  const Rect small = zoomRectAround(Rect{0, 0, 800, 600}, {400, 300}, 1000, 750);
  CHECK(small.x == 0 && small.y == 0 && small.w == 800 && small.h == 600);
}

static void test_overview_size_keeps_aspect() {
  int w = 0, h = 0;
  overviewSize(3840, 2160, 1600, w, h);
  CHECK(w == 1600 && h == 900);
  overviewSize(1080, 1920, 1600, w, h);
  CHECK(w == 900 && h == 1600);
  overviewSize(1280, 720, 1600, w, h);  // never enlarged
  CHECK(w == 1280 && h == 720);
}

static void test_draw_spot_marker() {
  const Image before = blank(200, 200);
  Image img = before;
  drawSpotMarker(img, 100, 100, 1);
  CHECK(samePixel(img, before, 100, 100));  // the spot itself stays visible
  CHECK(!samePixel(img, before, 100 + kMarkerRadius, 100));
  CHECK(!samePixel(img, before, 100 - kMarkerRadius, 100));
  CHECK(!samePixel(img, before, 100, 100 + kMarkerRadius));
  CHECK(!samePixel(img, before, 100, 100 - kMarkerRadius));
  CHECK(samePixel(img, before, 5, 195));  // far away: untouched
  int changed = 0;  // the number sits up and right of the ring
  for (int y = 100 - 2 * kMarkerRadius; y < 100 - kMarkerRadius; ++y)
    for (int x = 100 + kMarkerRadius; x < 100 + 2 * kMarkerRadius; ++x) changed += samePixel(img, before, x, y) ? 0 : 1;
  CHECK(changed > 10);
}

static void test_draw_spot_marker_clips_at_the_edge() {
  Image img = blank(30, 30);
  drawSpotMarker(img, 0, 0, 4);  // must not write outside the buffer
  drawSpotMarker(img, 29, 29, 4);
  CHECK(img.px.size() == 30u * 30u * 4u);
}

namespace {

struct Fake {
  std::vector<std::pair<std::string, Image>> written;
  ContextPlatform platform() {
    ContextPlatform p;
    p.grab = [](const Rect& d, Image& out, Failure&) {
      out = blank(d.w, d.h);
      return true;
    };
    p.resize = [](const Image&, int w, int h, Image& out) {
      out = blank(w, h);
      return true;
    };
    p.writeJpeg = [this](const Image& img, int, const std::string& path, Failure&) {
      written.emplace_back(path, img);
      return true;
    };
    p.foreground = [](std::string& app, std::string& title, Failure&) {
      app = "notepad";
      title = "a \"note\".txt";
      return true;
    };
    return p;
  }
};

}  // namespace

static void test_capture_writes_overview_and_one_zoom_per_spot() {
  Fake fake;
  const std::string reply = handleCommand(parseCommand(captureLine()), fake.platform());
  const auto m = fields(reply);
  CHECK(m.at("type") == "captured");
  CHECK(m.at("id") == "a1");
  CHECK(m.at("ow") == "1600" && m.at("oh") == "900");
  CHECK(fake.written.size() == 3);
  CHECK(m.at("overview") == fake.written[0].first);
  CHECK(m.at("overview").rfind("C:\\Temp\\lp", 0) == 0);
  CHECK(m.at("zooms") == fake.written[1].first + ";" + fake.written[2].first);
  // Both spots sit near an edge: their crops are moved inside the display.
  CHECK(m.at("zoomRects") == "-1920,0,1000,750;-1000,330,1000,750");
  CHECK(fake.written[1].second.w == 1000 && fake.written[1].second.h == 750);
}

static void test_capture_scales_spots_to_a_larger_image() {
  Fake fake;
  ContextPlatform p = fake.platform();
  p.grab = [](const Rect& d, Image& out, Failure&) {  // a Retina display: two pixels per point
    out = blank(d.w * 2, d.h * 2);
    return true;
  };
  const std::string reply = handleCommand(parseCommand(captureLine()), p);
  CHECK(fields(reply).at("type") == "captured");
  // The zoom is 1000 x 750 pixels of the capture, not points: half that area in points, at full detail.
  CHECK(fields(reply).at("zoomRects") == "-1920,13,500,375;-670,705,500,375");
  CHECK(fake.written[1].second.w == 1000 && fake.written[1].second.h == 750);
  CHECK(fake.written[2].second.w == 1000 && fake.written[2].second.h == 750);
}

static void test_capture_failure_is_an_error_reply() {
  Fake fake;
  ContextPlatform p = fake.platform();
  p.grab = [](const Rect&, Image&, Failure& f) {
    f.code = "permission";
    f.message = "Screen Recording is off";
    return false;
  };
  const auto m = fields(handleCommand(parseCommand(captureLine()), p));
  CHECK(m.at("type") == "error" && m.at("id") == "a1" && m.at("code") == "permission");
  CHECK(m.at("message") == "Screen Recording is off");
  CHECK(fake.written.empty());
}

static void test_foreground_and_pong_replies() {
  Fake fake;
  const auto f = fields(handleCommand(parseCommand(R"({"type":"foreground","id":"f1"})"), fake.platform()));
  CHECK(f.at("type") == "foreground" && f.at("id") == "f1" && f.at("app") == "notepad");
  CHECK(f.at("title") == "a \"note\".txt");
  const auto p = fields(handleCommand(parseCommand(R"({"type":"ping","id":"p1"})"), fake.platform()));
  CHECK(p.at("type") == "pong" && p.at("id") == "p1");
  const auto b = fields(handleCommand(parseCommand(R"({"type":"capture","id":"b1"})"), fake.platform()));
  CHECK(b.at("type") == "error" && b.at("id") == "b1" && b.at("code") == "bad");
}

static void test_loop_answers_until_shutdown() {
  Fake fake;
  std::istringstream in("{\"type\":\"ping\",\"id\":\"1\"}\r\n\n{\"type\":\"shutdown\"}\n{\"type\":\"ping\",\"id\":\"2\"}\n");
  std::vector<std::string> out;
  const int code = runContextLoop(in, [&](const std::string& s) { out.push_back(s); return true; }, fake.platform());
  CHECK(code == 0);
  CHECK(out.size() == 1);
  CHECK(out.size() == 1 && fields(out[0]).at("id") == "1");
}

int main() {
  test_parse_capture_command();
  test_parse_other_commands();
  test_parse_rejects_bad_input();
  test_zoom_rect_stays_inside_the_display();
  test_overview_size_keeps_aspect();
  test_draw_spot_marker();
  test_draw_spot_marker_clips_at_the_edge();
  test_capture_writes_overview_and_one_zoom_per_spot();
  test_capture_scales_spots_to_a_larger_image();
  test_capture_failure_is_an_error_reply();
  test_foreground_and_pong_replies();
  test_loop_answers_until_shutdown();
  std::printf("%d passed, %d failed\n", g_pass, g_fail);
  return g_fail == 0 ? 0 : 1;
}
