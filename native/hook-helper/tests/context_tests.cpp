// Unit tests for the context helper's platform-free part (no screen capture).
// Build and run: npm run test:helper
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <map>
#include <memory>
#include <sstream>
#include <string>
#include <thread>
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
  CHECK(bad("area", R"("0,0,0,10")").kind == Command::Kind::Bad);
  CHECK(bad("area", R"("0,0,10,10;0,0,5,5")").kind == Command::Kind::Bad);
  CHECK(bad("crops", R"("0,0,10,10")").kind == Command::Kind::Bad);  // two spots need two crops
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
    p.foreground = [](std::string& app, std::string& title, std::string& windowId, Failure&) {
      app = "notepad";
      title = "a \"note\".txt";
      windowId = "263544";
      return true;
    };
    return p;
  }
};

}  // namespace

static void test_capture_writes_overview_and_one_zoom_per_spot() {
  Fake fake;
  const std::string reply = handleCommand(parseCommand(captureLine()), fake.platform()).line;
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
  const std::string reply = handleCommand(parseCommand(captureLine()), p).line;
  CHECK(fields(reply).at("type") == "captured");
  // The zoom is 1000 x 750 pixels of the capture, not points: half that area in points, at full detail.
  CHECK(fields(reply).at("zoomRects") == "-1920,13,500,375;-670,705,500,375");
  CHECK(fake.written[1].second.w == 1000 && fake.written[1].second.h == 750);
  CHECK(fake.written[2].second.w == 1000 && fake.written[2].second.h == 750);
}

static void test_capture_shows_the_area_and_the_crops() {
  Fake fake;
  // The overview shows an 800 x 600 window; spot 1's close-up is a 600 x 200 paragraph, spot 2's a 2400 x 900 panel.
  const std::string line = captureLine({{"area", R"("-1900,100,800,600")"},
                                        {"crops", R"("-1900,150,600,200;-1900,100,2400,900")"}});
  const Command c = parseCommand(line);
  CHECK(c.capture.area.x == -1900 && c.capture.area.w == 800);
  CHECK(c.capture.crops.size() == 2 && c.capture.crops[0].h == 200);
  const auto m = fields(handleCommand(c, fake.platform()).line);
  CHECK(m.at("ow") == "800" && m.at("oh") == "600");  // small enough to send at full size
  CHECK(fake.written[0].second.w == 800 && fake.written[0].second.h == 600);
  // A crop is cut to the display; one longer than the overview's long side is scaled down to it.
  CHECK(m.at("zoomRects") == "-1900,150,600,200;-1900,100,1900,900");
  CHECK(fake.written[1].second.w == 600 && fake.written[1].second.h == 200);
  CHECK(fake.written[2].second.w == 1600 && fake.written[2].second.h == 758);
  // An area off the display shows the whole display.
  Fake off;
  const auto o = fields(handleCommand(parseCommand(captureLine({{"area", R"("100,100,500,500")"}})), off.platform()).line);
  CHECK(o.at("ow") == "1600" && o.at("oh") == "900");
}

static void test_capture_failure_is_an_error_reply() {
  Fake fake;
  ContextPlatform p = fake.platform();
  p.grab = [](const Rect&, Image&, Failure& f) {
    f.code = "permission";
    f.message = "Screen Recording is off";
    return false;
  };
  const auto m = fields(handleCommand(parseCommand(captureLine()), p).line);
  CHECK(m.at("type") == "error" && m.at("id") == "a1" && m.at("code") == "permission");
  CHECK(m.at("message") == "Screen Recording is off");
  CHECK(fake.written.empty());
}

static void test_foreground_and_pong_replies() {
  Fake fake;
  const auto f = fields(handleCommand(parseCommand(R"({"type":"foreground","id":"f1"})"), fake.platform()).line);
  CHECK(f.at("type") == "foreground" && f.at("id") == "f1" && f.at("app") == "notepad");
  CHECK(f.at("title") == "a \"note\".txt");
  CHECK(f.at("window") == "263544");
  const auto p = fields(handleCommand(parseCommand(R"({"type":"ping","id":"p1"})"), fake.platform()).line);
  CHECK(p.at("type") == "pong" && p.at("id") == "p1");
  const auto b = fields(handleCommand(parseCommand(R"({"type":"capture","id":"b1"})"), fake.platform()).line);
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

namespace {

std::filesystem::path testDir() {
  const std::filesystem::path dir = std::filesystem::temp_directory_path() / "lp-context-tests";
  std::filesystem::create_directories(dir);
  return dir;
}

// A read command with one spot near the display's left edge; `layers` adds raw JSON fields, each with its comma.
std::string readLine(const std::string& id, const std::string& layers) {
  return R"({"type":"read","id":")" + id + R"(","spots":"-1820,200",)" + layers + R"("dir":")" +
         lp::jsonEscape(testDir().string()) + R"("})";
}

std::string readFile(const std::filesystem::path& path) {
  std::ifstream file(path, std::ios::binary);
  return std::string((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
}

// A platform whose three text probes answer at once with fixed results.
ContextPlatform readPlatform(Fake& fake) {
  ContextPlatform p = fake.platform();
  p.controls = [](const std::vector<Point>&, int, std::vector<RawMark>& out, Failure&) {
    out.push_back(RawMark{"button", Rect{-1800, 190, 50, 20}, "OK"});
    return true;
  };
  p.systemText = [](const std::vector<Point>& spots, bool, SystemText& out, Failure&) {
    for (size_t i = 0; i < spots.size(); ++i) out.spotTexts.push_back("spot " + std::to_string(i + 1));
    return true;
  };
  p.fileOf = [](std::string& path, std::string& address, std::string& how, Failure&) {
    path = "C:\\docs\\a.pdf";
    address.clear();
    how = "title";
    return true;
  };
  return p;
}

}  // namespace

static void test_parse_read_command() {
  const Command c = parseCommand(
      R"({"type":"read","id":"r1","spots":"-1820,200;-420,900","radius":600,"marks":true,"text":false,)"
      R"("file":true,"dir":"C:\\Temp\\lp"})");
  CHECK(c.kind == Command::Kind::Read && c.id == "r1");
  CHECK(c.read.spots.size() == 2 && c.read.spots[1].x == -420 && c.read.spots[1].y == 900);
  CHECK(c.read.radius == 600);
  CHECK(c.read.marks && !c.read.text && c.read.file);
  CHECK(c.read.dir == "C:\\Temp\\lp");
  CHECK(parseCommand(R"({"type":"read","id":"r1","marks":"yes","dir":"C:\\t"})").kind == Command::Kind::Bad);
  CHECK(parseCommand(R"({"type":"read","id":"r1","radius":-1,"dir":"C:\\t"})").kind == Command::Kind::Bad);
  CHECK(parseCommand(R"({"type":"read","id":"r1","spots":"5","dir":"C:\\t"})").kind == Command::Kind::Bad);
  CHECK(parseCommand(R"({"type":"read","id":"r1","spots":"1,2"})").kind == Command::Kind::Bad);  // no dir
  // The separate commands are gone: an older main gets an error, not a hang.
  CHECK(parseCommand(R"({"type":"marks","id":"m1","dir":"C:\\t"})").kind == Command::Kind::Bad);
  CHECK(parseCommand(R"({"type":"systemText","id":"s1"})").kind == Command::Kind::Bad);
  CHECK(parseCommand(R"({"type":"fileOf","id":"f1"})").kind == Command::Kind::Bad);
}

static void test_read_answers_every_layer_it_was_asked_for() {
  Fake fake;
  ContextPlatform p = readPlatform(fake);
  p.controls = [](const std::vector<Point>& spots, int radius, std::vector<RawMark>& out, Failure&) {
    if (spots.size() == 1 && spots[0].x == -1820 && radius == 100) {
      out.push_back(RawMark{"text", Rect{-1900, 110, 50, 20}, "Save\tall"});
      out.push_back(RawMark{"button", Rect{-1800, 190, 50, 20}, "OK"});
    }
    return true;
  };
  const Reply r = handleCommand(parseCommand(readLine("r1", R"("radius":100,"marks":true,"text":true,"file":true,)")), p);
  const auto m = fields(r.line);
  CHECK(!r.exitAfter);
  CHECK(m.at("type") == "read" && m.at("id") == "r1");
  CHECK(m.at("marks") == "ok" && m.at("count") == "2");
  CHECK(m.at("marksPath") == (testDir() / "marks-r1.tsv").string());
  CHECK(readFile(m.at("marksPath")) == "text\t-1900\t110\t50\t20\tSave all\nbutton\t-1800\t190\t50\t20\tOK\n");
  CHECK(m.at("text") == "ok" && m.at("spotTexts") == "spot 1" && m.at("focusSecure") == "false");
  CHECK(m.at("file") == "ok" && m.at("filePath") == "C:\\docs\\a.pdf" && m.at("how") == "title");
  CHECK(m.at("fileAddress").empty());
}

static void test_read_sends_the_boxes_around_each_spot() {
  Fake fake;
  ContextPlatform p = readPlatform(fake);
  p.boxes = [](const std::vector<Point>& spots, std::vector<std::vector<Rect>>& out, Failure&) {
    out.push_back({Rect{-1830, 190, 40, 20}, Rect{-1830, 190, 40, 20}, Rect{-1900, 150, 600, 200},
                   Rect{-1920, 0, 1920, 1040}});
    for (size_t i = 1; i < spots.size(); ++i) out.emplace_back();
    return true;
  };
  const auto m = fields(handleCommand(parseCommand(readLine("r1", R"("boxes":true,)")), p).line);
  CHECK(m.at("boxes") == "ok");
  CHECK(m.at("boxRects") == "-1830,190,40,20|-1900,150,600,200|-1920,0,1920,1040");  // the repeat is dropped
  CHECK(m.at("marks") == "off" && m.at("text") == "off");
  const auto none = fields(handleCommand(parseCommand(readLine("r2", "")), p).line);
  CHECK(none.at("boxes") == "off" && none.count("boxRects") == 0);
}

static void test_thin_boxes_keeps_the_inner_boxes_and_the_window() {
  std::vector<Rect> chain;
  for (int i = 0; i < 20; ++i) chain.push_back(Rect{0, 0, 10 + i, 10 + i});
  const std::vector<Rect> thin = thinBoxes(chain);
  CHECK(thin.size() == kMaxBoxes);
  CHECK(thin.front().w == 10 && thin[kMaxBoxes - 2].w == 10 + static_cast<int>(kMaxBoxes) - 2);
  CHECK(thin.back().w == 29);
  CHECK(thinBoxes({Rect{0, 0, 0, 5}, Rect{0, 0, 5, 5}}).size() == 1);  // a box with no area is dropped
}

static void test_read_leaves_out_the_layers_that_are_off() {
  Fake fake;
  ContextPlatform p = readPlatform(fake);
  bool walked = false;
  p.controls = [&walked](const std::vector<Point>&, int, std::vector<RawMark>&, Failure&) {
    walked = true;
    return true;
  };
  const auto m = fields(handleCommand(parseCommand(readLine("r2", R"("text":true,)")), p).line);
  CHECK(!walked);
  CHECK(m.at("marks") == "off" && m.at("marksPath").empty() && m.at("count") == "0");
  CHECK(m.at("text") == "ok" && m.at("file") == "off");
  CHECK(m.count("filePath") == 0);
  const auto none = fields(handleCommand(parseCommand(readLine("r3", "")), p).line);
  CHECK(none.at("marks") == "off" && none.at("text") == "off" && none.at("file") == "off");
}

static void test_read_reports_a_failed_layer_and_keeps_the_others() {
  Fake fake;
  ContextPlatform p = readPlatform(fake);
  p.systemText = [](const std::vector<Point>&, bool, SystemText&, Failure& f) {
    f.code = "permission";
    f.message = "Accessibility is off";
    return false;
  };
  const auto m = fields(handleCommand(parseCommand(readLine("r4", R"("marks":true,"text":true,"file":true,)")), p).line);
  CHECK(m.at("text") == "permission" && m.count("spotTexts") == 0);
  CHECK(m.at("marks") == "ok" && m.at("file") == "ok");
}

static void test_secure_focus_sends_no_value() {
  Fake fake;
  ContextPlatform p = readPlatform(fake);
  p.systemText = [](const std::vector<Point>& spots, bool, SystemText& out, Failure&) {
    out.selection = "picked";
    for (size_t i = 0; i < spots.size(); ++i) out.spotTexts.push_back("spot " + std::to_string(i + 1));
    out.focusKind = "field";
    out.focusLabel = "Password";
    out.focusValue = "hunter2";
    out.focusSecure = true;
    out.address = "https://example.com/login";
    return true;
  };
  const std::string reply = handleCommand(parseCommand(readLine("s1", R"("text":true,)")), p).line;
  CHECK(reply.find(R"("focusValue":"")") != std::string::npos);
  CHECK(reply.find("hunter2") == std::string::npos);
  const auto m = fields(reply);
  CHECK(m.at("type") == "read" && m.at("id") == "s1");
  CHECK(m.at("selection") == "picked" && m.at("focusKind") == "field" && m.at("focusLabel") == "Password");
  CHECK(m.at("focusSecure") == "true");
  CHECK(m.at("spotTexts") == "spot 1");
  CHECK(m.at("address") == "https://example.com/login");
  // One text per spot, joined with U+001E (the test's flat parser reads no \u escapes, so look at the line).
  const std::string two = handleCommand(parseCommand(
      R"({"type":"read","id":"s2","spots":"1,2;3,4","text":true,"dir":"C:\\t"})"), p).line;
  CHECK(two.find(R"("spotTexts":"spot 1\u001espot 2")") != std::string::npos);
}

static void test_read_runs_its_layers_under_one_deadline() {
  Fake fake;
  ContextPlatform p = readPlatform(fake);
  // The walk and the file probe each take 60% of the budget: one after the other they would run over it, side by
  // side they fit. The quick text probe runs first on the walk's thread.
  constexpr int budget = 500;
  const auto wait = [] { std::this_thread::sleep_for(std::chrono::milliseconds(budget * 6 / 10)); };
  const auto order = std::make_shared<std::string>();
  p.controls = [wait, order](const std::vector<Point>&, int, std::vector<RawMark>& out, Failure&) {
    *order += "walk ";
    wait();
    out.push_back(RawMark{"button", Rect{-1800, 190, 50, 20}, "OK"});
    return true;
  };
  p.systemText = [order](const std::vector<Point>&, bool, SystemText& out, Failure&) {
    *order += "text ";
    out.spotTexts.push_back("spot 1");
    return true;
  };
  p.fileOf = [wait](std::string& path, std::string&, std::string& how, Failure&) {
    wait();
    path = "C:\\docs\\a.pdf";
    how = "title";
    return true;
  };
  const auto start = std::chrono::steady_clock::now();
  const Reply r = handleCommand(parseCommand(readLine("r5", R"("marks":true,"text":true,"file":true,)")), p, budget);
  const auto took = std::chrono::steady_clock::now() - start;
  const auto m = fields(r.line);
  CHECK(!r.exitAfter);
  CHECK(m.at("marks") == "ok" && m.at("text") == "ok" && m.at("file") == "ok");
  CHECK(took < std::chrono::milliseconds(budget));  // the whole command fits the one budget the client waits for
  CHECK(*order == "text walk ");  // never side by side: that fails the walk on a fresh helper
}

static void test_read_looks_up_a_browser_address_once() {
  Fake fake;
  ContextPlatform p = readPlatform(fake);
  const auto asked = std::make_shared<std::vector<bool>>();
  p.systemText = [asked](const std::vector<Point>&, bool withAddress, SystemText& out, Failure&) {
    asked->push_back(withAddress);
    if (withAddress) out.address = "https://example.com/own";
    return true;
  };
  p.fileOf = [](std::string& path, std::string& address, std::string& how, Failure&) {
    path.clear();
    address = "https://example.com/a.pdf";
    how = "address";
    return true;
  };
  // With the file layer on, its address bar lookup also gives the text layer its address.
  const auto both = fields(handleCommand(parseCommand(readLine("r7", R"("text":true,"file":true,)")), p).line);
  CHECK(both.at("address") == "https://example.com/a.pdf" && both.at("fileAddress") == "https://example.com/a.pdf");
  // Without it, the text probe looks the address up itself.
  const auto alone = fields(handleCommand(parseCommand(readLine("r8", R"("text":true,)")), p).line);
  CHECK(alone.at("address") == "https://example.com/own");
  CHECK(*asked == std::vector<bool>({false, true}));
}

static void test_read_sends_what_finished_and_exits_after_a_slow_layer() {
  Fake fake;
  ContextPlatform p = readPlatform(fake);
  p.fileOf = [](std::string&, std::string&, std::string&, Failure&) {
    std::this_thread::sleep_for(std::chrono::milliseconds(300));
    return true;
  };
  const Reply r = handleCommand(parseCommand(readLine("r6", R"("marks":true,"text":true,"file":true,)")), p, 30);
  const auto m = fields(r.line);
  CHECK(m.at("type") == "read" && m.at("id") == "r6");
  CHECK(m.at("file") == "slow" && m.count("filePath") == 0);
  CHECK(m.at("marks") == "ok" && m.at("count") == "1" && m.at("text") == "ok");
  CHECK(r.exitAfter);  // the file probe is still running, so the helper ends after this reply
  std::istringstream in(readLine("1", R"("file":true,)") + "\n{\"type\":\"ping\",\"id\":\"2\"}\n");
  std::vector<std::string> out;
  const int code = runContextLoop(in, [&](const std::string& s) { out.push_back(s); return true; }, p, 30);
  CHECK(out.size() == 1);  // the loop stopped after the slow reply
  CHECK(code == kExitNow);  // so the main ends the process at once
}

static void test_marks_file_escapes_tabs_and_newlines() {
  const std::string text =
      marksFileText({RawMark{"field", Rect{-5, 6, 7, 8}, "a\tb\r\nc\nd"}, RawMark{"tab", Rect{1, 2, 3, 4}, ""}});
  CHECK(text == "field\t-5\t6\t7\t8\ta b  c d\ntab\t1\t2\t3\t4\t\n");
}

static void test_marks_file_cuts_on_a_character_boundary() {
  std::string chinese;
  for (int i = 0; i < 130; ++i) chinese += "\xe4\xb8\xad";  // U+4E2D, three bytes each
  const std::string text = marksFileText({RawMark{"text", Rect{0, 0, 10, 10}, chinese}});
  const std::string prefix = "text\t0\t0\t10\t10\t";
  CHECK(text.rfind(prefix, 0) == 0);
  CHECK(text.back() == '\n');
  CHECK(text.substr(prefix.size()) == chinese.substr(0, 120 * 3) + "\n");
  // A cut that would land inside a character moves back to its start.
  const std::string mixed = marksFileText({RawMark{"text", Rect{0, 0, 10, 10}, std::string(119, 'a') + chinese}});
  CHECK(mixed.substr(prefix.size()) == std::string(119, 'a') + "\xe4\xb8\xad\n");
}

namespace {

std::vector<std::string> lines(const std::string& text) {
  std::vector<std::string> out;
  std::istringstream in(text);
  for (std::string line; std::getline(in, line);) out.push_back(line);
  return out;
}

RawField field(const std::string& id, const std::string& kind, const std::string& label) {
  RawField f;
  f.id = id;
  f.kind = kind;
  f.label = label;
  return f;
}

}  // namespace

static void test_form_fields_send_no_value_for_a_secure_field() {
  Fake fake;
  ContextPlatform p = readPlatform(fake);
  p.formFields = [](const std::vector<Point>&, std::vector<RawField>& out, Failure&) {
    RawField password = field("42.7.1", "text", "Password");
    password.value = "hunter2";
    password.secure = true;
    RawField name = field("42.7.2", "text", "Name");
    name.value = "Ada";
    name.required = true;
    out = {password, name};
    return true;
  };
  const Reply r = handleCommand(parseCommand(readLine("f1", R"("fields":true,)")), p);
  const auto m = fields(r.line);
  CHECK(m.at("fields") == "ok" && m.at("fieldCount") == "2");
  CHECK(m.at("fieldsPath") == (testDir() / "fields-f1.jsonl").string());
  const std::string file = readFile(m.at("fieldsPath"));
  CHECK(file.find("hunter2") == std::string::npos);
  const std::vector<std::string> rows = lines(file);
  CHECK(rows.size() == 2);
  CHECK(rows[0].find(R"("id":"42.7.1","kind":"text","label":"Password","group":"","value":"","secure":true)") !=
        std::string::npos);
  const std::string ada = rows[1];
  CHECK(ada.find(R"("value":"Ada")") != std::string::npos && ada.find(R"("required":true)") != std::string::npos);
  CHECK(r.line.find("hunter2") == std::string::npos && r.line.find("Ada") == std::string::npos);
}

static void test_form_fields_file_cuts_labels_on_a_character_boundary() {
  std::string chinese;
  for (int i = 0; i < 130; ++i) chinese += "\xe4\xb8\xad";  // U+4E2D, three bytes each
  RawField f = field("1.2", "combo", chinese);
  f.group = chinese;
  f.value = std::string(2001, 'v');
  f.options = {chinese, "Small"};
  const std::vector<std::string> rows = lines(formFieldsFileText({f}));
  CHECK(rows.size() == 1);
  const std::string cut120 = chinese.substr(0, 120 * 3);
  CHECK(rows[0].find("\"label\":\"" + cut120 + "\"") != std::string::npos);
  CHECK(rows[0].find("\"group\":\"" + cut120 + "\"") != std::string::npos);
  CHECK(rows[0].find("\"options\":[\"" + cut120 + "\",\"Small\"]") != std::string::npos);
  CHECK(rows[0].find("\"value\":\"" + std::string(2000, 'v') + "\"") != std::string::npos);
  // A cut that would land inside a character moves back to its start.
  const std::string mixed = formFieldsFileText({field("1.3", "text", std::string(119, 'a') + chinese)});
  CHECK(mixed.find("\"label\":\"" + std::string(119, 'a') + "\xe4\xb8\xad\"") != std::string::npos);
}

static void test_form_fields_file_keeps_one_line_per_field_and_the_caps() {
  RawField f = field("1.1", "text", "Say \"hi\"\nthen\ttab");
  f.value = "line one\nline two";
  const std::string text = formFieldsFileText({f});
  CHECK(lines(text).size() == 1);  // the newlines are escaped
  CHECK(text.find(R"("label":"Say \"hi\"\nthen\ttab")") != std::string::npos);
  CHECK(text.find(R"("value":"line one\nline two")") != std::string::npos);
  std::vector<RawField> many;
  for (int i = 0; i < 70; ++i) many.push_back(field("1." + std::to_string(i), "text", "F"));
  many[0].options.assign(60, "o");
  const std::vector<std::string> rows = lines(formFieldsFileText(many));
  CHECK(rows.size() == kMaxFormFields);
  size_t options = 0;
  for (size_t at = rows[0].find("\"o\""); at != std::string::npos; at = rows[0].find("\"o\"", at + 1)) ++options;
  CHECK(options == kMaxFieldOptions);
}

static void test_read_leaves_the_fields_layer_off_unless_asked_and_reports_a_failure() {
  Fake fake;
  ContextPlatform p = readPlatform(fake);
  bool read = false;
  p.formFields = [&read](const std::vector<Point>&, std::vector<RawField>& out, Failure&) {
    read = true;
    out = {field("1.1", "text", "Name")};
    return true;
  };
  const auto off = fields(handleCommand(parseCommand(readLine("f2", R"("text":true,)")), p).line);
  CHECK(!read && off.at("fields") == "off" && off.count("fieldsPath") == 0);
  const auto no = fields(handleCommand(parseCommand(readLine("f3", R"("fields":false,)")), p).line);
  CHECK(!read && no.at("fields") == "off");
  p.formFields = [](const std::vector<Point>&, std::vector<RawField>&, Failure& f) {
    f.code = "permission";
    return false;
  };
  const auto failed = fields(handleCommand(parseCommand(readLine("f4", R"("fields":true,"text":true,)")), p).line);
  CHECK(failed.at("fields") == "permission" && failed.count("fieldsPath") == 0 && failed.at("text") == "ok");
  // A platform with no fields probe (macOS for now) answers off, not an error.
  p.formFields = nullptr;
  const auto none = fields(handleCommand(parseCommand(readLine("f5", R"("fields":true,)")), p).line);
  CHECK(none.at("fields") == "off");
  CHECK(parseCommand(R"({"type":"read","id":"r1","fields":"yes","dir":"C:\\t"})").kind == Command::Kind::Bad);
}

static void test_budget_gives_up_on_a_slow_probe() {
  const auto start = std::chrono::steady_clock::now();
  const bool done = runWithBudget([] { std::this_thread::sleep_for(std::chrono::milliseconds(200)); }, 20);
  const auto took = std::chrono::steady_clock::now() - start;
  CHECK(!done);
  CHECK(took < std::chrono::milliseconds(100));
}

static void test_budget_returns_a_fast_probe() {
  const auto ran = std::make_shared<int>(0);
  CHECK(runWithBudget([ran] { *ran = 7; }, 1000));
  CHECK(*ran == 7);
}

static void test_cut_text_keeps_whole_characters() {
  const std::string zhong = "\xe4\xb8\xad";  // U+4E2D
  CHECK(cutText("hello", 3) == "hel");
  CHECK(cutText("hi", 5) == "hi");
  CHECK(cutText("ab" + zhong + zhong, 3) == "ab" + zhong);
  CHECK(cutText("\xf0\xa0\x80\x80" "ab", 1) == "\xf0\xa0\x80\x80");  // a four-byte character counts once
  CHECK(cutText("abc", 0).empty());
}

static void test_file_name_from_a_window_title() {
  CHECK(fileNameFromTitle("notes.txt - Notepad") == "notes.txt");
  CHECK(fileNameFromTitle("My Report.docx - Word") == "My Report.docx");
  CHECK(fileNameFromTitle("plan - final.pdf - Adobe Acrobat Pro (64-bit)") == "plan - final.pdf");
  CHECK(fileNameFromTitle("*notes.txt - Notepad") == "notes.txt");
  CHECK(fileNameFromTitle("\xe2\x97\x8f context.cpp - lolPing - Visual Studio Code") == "context.cpp");
  CHECK(fileNameFromTitle("My Notes.md - repo - Visual Studio Code") == "My Notes.md");
  CHECK(fileNameFromTitle("Reading report.PDF now") == "report.PDF");
  CHECK(fileNameFromTitle("Document1 - Word") == "Document1");
  CHECK(fileNameFromTitle("My Notes.md") == "My Notes.md");
  CHECK(fileNameFromTitle("a.js and b.py open") == "b.py");
  CHECK(fileNameFromTitle("C:\\a\\b.txt - Notepad++") == "b.txt");
  // Every extension the file layer reads as text names a file, not only the common ones.
  CHECK(fileNameFromTitle("App.tsx - web - Visual Studio Code") == "App.tsx");
  CHECK(fileNameFromTitle("deploy.sh - scripts - Visual Studio Code") == "deploy.sh");
  CHECK(fileNameFromTitle("values.yaml - chart - Visual Studio Code") == "values.yaml");
  CHECK(fileNameFromTitle("Program.cs - app - Visual Studio Code") == "Program.cs");
  CHECK(fileNameFromTitle("Settings").empty());
  CHECK(fileNameFromTitle("").empty());
  // ".pdfx" is not ".pdf", and an extension alone is no name.
  CHECK(fileNameFromTitle("a.pdfx - Viewer") == "a.pdfx");
  CHECK(fileNameFromTitle(".pdf").empty());
}

static void test_acrobat_mru_path() {
  CHECK(acrobatMruPath("/C/Users/me/My Docs/a.pdf") == "C:\\Users\\me\\My Docs\\a.pdf");
  CHECK(acrobatMruPath("/d/b.pdf") == "d:\\b.pdf");
  CHECK(acrobatMruPath("C:\\a.pdf").empty());
  CHECK(acrobatMruPath("/server/share/a.pdf").empty());
  CHECK(acrobatMruPath("/C").empty());
  CHECK(acrobatMruPath("").empty());
}

static void test_office_mru_path() {
  CHECK(officeMruPath("[F00000000][T01D93C7FC86CB1A0][O00000000]*C:\\Users\\me\\a.docx") == "C:\\Users\\me\\a.docx");
  CHECK(officeMruPath("C:\\Users\\me\\Desktop\\").empty());
  CHECK(officeMruPath("[F00000000]*").empty());
}

static void test_browser_address() {
  std::string path, address;
  const auto read = [&](const std::string& value) {
    path = "x";
    address = "x";
    return browserAddress(value, path, address);
  };
  CHECK(read("C:/Users/Darren Meng/a.pdf") && path == "C:\\Users\\Darren Meng\\a.pdf" && address.empty());
  CHECK(read("file:///C:/Users/Darren%20Meng/b%25.pdf") && path == "C:\\Users\\Darren Meng\\b%.pdf");
  CHECK(read("FILE:///d:/x.pdf") && path == "d:\\x.pdf");
  // Edge's PDF viewer adds "#page=N"; an encoded '#' or '?' is part of the name.
  CHECK(read("file:///C:/a/b.pdf#page=2") && path == "C:\\a\\b.pdf");
  CHECK(read("file:///C:/a/b%23c%3F.pdf?x=1") && path == "C:\\a\\b#c?.pdf");
  CHECK(read("file://server/share/c.pdf#page=1") && path == "\\\\server\\share\\c.pdf");
  CHECK(read("file://server/share/c.pdf") && path == "\\\\server\\share\\c.pdf");
  CHECK(read("C:/a/%E4%B8%AD.pdf") && path == "C:\\a\\\xe4\xb8\xad.pdf");
  CHECK(read("example.com/docs/a.pdf") && address == "https://example.com/docs/a.pdf" && path.empty());
  CHECK(read("https://example.com/a.pdf?x=1") && address == "https://example.com/a.pdf?x=1");
  CHECK(read("http://localhost:3000/") && address == "http://localhost:3000/");
  CHECK(read("localhost:3000/x") && address == "https://localhost:3000/x");
  CHECK(read("  example.com  ") && address == "https://example.com");
  CHECK(!read("") && path.empty() && address.empty());
  CHECK(!read("how to read a pdf"));
  CHECK(!read("about:blank"));
  CHECK(!read("hello"));
  CHECK(!read("file:///"));
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
  test_capture_shows_the_area_and_the_crops();
  test_capture_failure_is_an_error_reply();
  test_foreground_and_pong_replies();
  test_loop_answers_until_shutdown();
  test_parse_read_command();
  test_read_answers_every_layer_it_was_asked_for();
  test_read_sends_the_boxes_around_each_spot();
  test_thin_boxes_keeps_the_inner_boxes_and_the_window();
  test_read_leaves_out_the_layers_that_are_off();
  test_read_reports_a_failed_layer_and_keeps_the_others();
  test_secure_focus_sends_no_value();
  test_read_runs_its_layers_under_one_deadline();
  test_read_looks_up_a_browser_address_once();
  test_read_sends_what_finished_and_exits_after_a_slow_layer();
  test_marks_file_escapes_tabs_and_newlines();
  test_marks_file_cuts_on_a_character_boundary();
  test_form_fields_send_no_value_for_a_secure_field();
  test_form_fields_file_cuts_labels_on_a_character_boundary();
  test_form_fields_file_keeps_one_line_per_field_and_the_caps();
  test_read_leaves_the_fields_layer_off_unless_asked_and_reports_a_failure();
  test_budget_gives_up_on_a_slow_probe();
  test_budget_returns_a_fast_probe();
  test_cut_text_keeps_whole_characters();
  test_file_name_from_a_window_title();
  test_acrobat_mru_path();
  test_office_mru_path();
  test_browser_address();
  std::printf("%d passed, %d failed\n", g_pass, g_fail);
  return g_fail == 0 ? 0 : 1;
}
