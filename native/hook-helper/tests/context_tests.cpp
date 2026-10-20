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
  LastGrab last;
  const std::string reply = handleCommand(parseCommand(captureLine()), fake.platform(), last).line;
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
  LastGrab last;
  const std::string reply = handleCommand(parseCommand(captureLine()), p, last).line;
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
  LastGrab last;
  const auto m = fields(handleCommand(parseCommand(captureLine()), p, last).line);
  CHECK(m.at("type") == "error" && m.at("id") == "a1" && m.at("code") == "permission");
  CHECK(m.at("message") == "Screen Recording is off");
  CHECK(fake.written.empty());
}

static void test_foreground_and_pong_replies() {
  Fake fake;
  LastGrab last;
  const auto f = fields(handleCommand(parseCommand(R"({"type":"foreground","id":"f1"})"), fake.platform(), last).line);
  CHECK(f.at("type") == "foreground" && f.at("id") == "f1" && f.at("app") == "notepad");
  CHECK(f.at("title") == "a \"note\".txt");
  const auto p = fields(handleCommand(parseCommand(R"({"type":"ping","id":"p1"})"), fake.platform(), last).line);
  CHECK(p.at("type") == "pong" && p.at("id") == "p1");
  const auto b = fields(handleCommand(parseCommand(R"({"type":"capture","id":"b1"})"), fake.platform(), last).line);
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

// A marks command for capture a1 with one spot near the display's left edge; `extra` adds raw JSON fields.
std::string marksLine(const std::string& id, const std::string& extra) {
  return R"({"type":"marks","id":")" + id + R"(","of":"a1","spots":"-1820,200",)" + extra + R"(,"dir":")" +
         lp::jsonEscape(testDir().string()) + R"("})";
}

std::string readFile(const std::filesystem::path& path) {
  std::ifstream file(path, std::ios::binary);
  return std::string((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
}

}  // namespace

static void test_parse_marks_command() {
  const Command c = parseCommand(
      R"({"type":"marks","id":"m1","of":"a1","spots":"-1820,200;-420,900","radius":600,"ocr":true,)"
      R"("controls":false,"dir":"C:\\Temp\\lp"})");
  CHECK(c.kind == Command::Kind::Marks && c.id == "m1");
  CHECK(c.marks.of == "a1");
  CHECK(c.marks.spots.size() == 2 &&c.marks.spots[1].x == -420 && c.marks.spots[1].y == 900);
  CHECK(c.marks.radius == 600);
  CHECK(c.marks.ocr && !c.marks.controls);
  CHECK(c.marks.dir == "C:\\Temp\\lp");
  CHECK(parseCommand(R"({"type":"marks","id":"m1","of":"../a","dir":"C:\\t"})").kind == Command::Kind::Bad);
  CHECK(parseCommand(R"({"type":"marks","id":"m1","of":"a1","ocr":"yes","dir":"C:\\t"})").kind == Command::Kind::Bad);
  CHECK(parseCommand(R"({"type":"marks","id":"m1","of":"a1","radius":-1,"dir":"C:\\t"})").kind == Command::Kind::Bad);
  CHECK(parseCommand(R"({"type":"marks","id":"m1","of":"a1"})").kind == Command::Kind::Bad);  // no dir
  const Command t = parseCommand(R"({"type":"systemText","id":"s1","spots":"5,6"})");
  CHECK(t.kind == Command::Kind::SystemText && t.spots.size() == 1);
  CHECK(t.spots.size() == 1 && t.spots[0].x == 5 && t.spots[0].y == 6);
  CHECK(parseCommand(R"({"type":"systemText","id":"s1","spots":"5"})").kind == Command::Kind::Bad);
  const Command f = parseCommand(R"({"type":"fileOf","id":"f1"})");
  CHECK(f.kind == Command::Kind::FileOf && f.id == "f1");
}

static void test_marks_for_a_gone_capture_is_bad() {
  Fake fake;
  const ContextPlatform p = fake.platform();
  LastGrab last;
  auto m = fields(handleCommand(parseCommand(marksLine("m1", R"("ocr":true)")), p, last).line);
  CHECK(m.at("type") == "error" && m.at("id") == "m1" && m.at("code") == "bad");
  CHECK(m.at("message") == "that capture is gone");
  CHECK(fields(handleCommand(parseCommand(captureLine()), p, last).line).at("type") == "captured");
  const std::string other = R"({"type":"marks","id":"m2","of":"a0","ocr":true,"dir":"C:\\t"})";
  m = fields(handleCommand(parseCommand(other), p, last).line);
  CHECK(m.at("code") == "bad" && m.at("message") == "that capture is gone");
}

static void test_marks_maps_boxes_to_request_units() {
  Fake fake;
  ContextPlatform p = fake.platform();
  p.grab = [](const Rect& d, Image& out, Failure&) {  // Retina: two pixels per point
    out = blank(d.w * 2, d.h * 2);
    return true;
  };
  Rect ocrArea;
  p.ocr = [&ocrArea](const Image&, const Rect& area, std::vector<RawMark>& out, Failure&) {
    ocrArea = area;
    out.push_back(RawMark{"text", Rect{40, 220, 100, 40}, "Save\tall"});
    return true;
  };
  p.controls = [](const std::vector<Point>& spots, int radius, std::vector<RawMark>& out, Failure&) {
    if (spots.size() == 1 && spots[0].x == -1820 && radius == 100) {
      out.push_back(RawMark{"button", Rect{-1800, 190, 50, 20}, "OK"});
    }
    return true;
  };
  LastGrab last;
  handleCommand(parseCommand(captureLine()), p, last);
  const Reply r = handleCommand(parseCommand(marksLine("m1", R"("radius":100,"ocr":true,"controls":true)")), p, last);
  const auto m = fields(r.line);
  CHECK(!r.exitAfter);
  CHECK(m.at("type") == "marks" && m.at("id") == "m1" && m.at("count") == "2");
  // The spot +/- 100 points, clipped at the display's left edge, in the grab's pixels.
  CHECK(ocrArea.x == 0 && ocrArea.y == 200 && ocrArea.w == 400 && ocrArea.h == 400);
  CHECK(m.at("path") == (testDir() / "marks-m1.tsv").string());
  CHECK(readFile(testDir() / "marks-m1.tsv") ==
        "text\t-1900\t110\t50\t20\tSave all\nbutton\t-1800\t190\t50\t20\tOK\n");
}

static void test_marks_keeps_what_one_probe_found() {
  Fake fake;
  ContextPlatform p = fake.platform();
  p.ocr = [](const Image&, const Rect&, std::vector<RawMark>&, Failure& f) {
    f.message = "no OCR language";
    return false;
  };
  p.controls = [](const std::vector<Point>&, int, std::vector<RawMark>& out, Failure&) {
    out.push_back(RawMark{"link", Rect{-1800, 190, 50, 20}, "Home"});
    return true;
  };
  LastGrab last;
  handleCommand(parseCommand(captureLine()), p, last);
  const std::string line = marksLine("m2", R"("ocr":true,"controls":true)");
  CHECK(fields(handleCommand(parseCommand(line), p, last).line).at("count") == "1");
  p.controls = [](const std::vector<Point>&, int, std::vector<RawMark>&, Failure& f) {
    f.message = "no UI Automation";
    return false;
  };
  const auto m = fields(handleCommand(parseCommand(line), p, last).line);
  CHECK(m.at("type") == "error" && m.at("message") == "no OCR language");  // nothing could be read at all
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

static void test_secure_focus_sends_no_value() {
  Fake fake;
  ContextPlatform p = fake.platform();
  p.systemText = [](const std::vector<Point>& spots, SystemText& out, Failure&) {
    out.selection = "picked";
    for (size_t i = 0; i < spots.size(); ++i) out.spotTexts.push_back("spot " + std::to_string(i + 1));
    out.focusKind = "field";
    out.focusLabel = "Password";
    out.focusValue = "hunter2";
    out.focusSecure = true;
    out.address = "https://example.com/login";
    return true;
  };
  LastGrab last;
  const std::string reply =
      handleCommand(parseCommand(R"({"type":"systemText","id":"s1","spots":"1,2"})"), p, last).line;
  CHECK(reply.find(R"("focusValue":"")") != std::string::npos);
  CHECK(reply.find("hunter2") == std::string::npos);
  const auto m = fields(reply);
  CHECK(m.at("type") == "systemText" && m.at("id") == "s1");
  CHECK(m.at("selection") == "picked" && m.at("focusKind") == "field" && m.at("focusLabel") == "Password");
  CHECK(m.at("focusSecure") == "true");
  CHECK(m.at("spotTexts") == "spot 1");
  CHECK(m.at("address") == "https://example.com/login");
  // One text per spot, joined with U+001E (the test's flat parser reads no \u escapes, so look at the line).
  const std::string two =
      handleCommand(parseCommand(R"({"type":"systemText","id":"s2","spots":"1,2;3,4"})"), p, last).line;
  CHECK(two.find(R"("spotTexts":"spot 1\u001espot 2")") != std::string::npos);
}

static void test_slow_probe_replies_slow_and_exits() {
  Fake fake;
  ContextPlatform p = fake.platform();
  p.fileOf = [](std::string&, std::string&, std::string&, Failure&) {
    std::this_thread::sleep_for(std::chrono::milliseconds(kProbeBudgetMs + 1000));
    return true;
  };
  LastGrab last;
  const Reply r = handleCommand(parseCommand(R"({"type":"fileOf","id":"f1"})"), p, last);
  const auto m = fields(r.line);
  CHECK(m.at("type") == "error" && m.at("id") == "f1" && m.at("code") == "slow");
  CHECK(r.exitAfter);
  std::istringstream in("{\"type\":\"fileOf\",\"id\":\"1\"}\n{\"type\":\"ping\",\"id\":\"2\"}\n");
  std::vector<std::string> out;
  runContextLoop(in, [&](const std::string& s) { out.push_back(s); return true; }, p);
  CHECK(out.size() == 1);  // the loop stopped after the slow reply
}

static void test_file_of_reply() {
  Fake fake;
  ContextPlatform p = fake.platform();
  p.fileOf = [](std::string& path, std::string& address, std::string& how, Failure&) {
    path = "C:\\docs\\a.pdf";
    address.clear();
    how = "title";
    return true;
  };
  LastGrab last;
  const auto m = fields(handleCommand(parseCommand(R"({"type":"fileOf","id":"f2"})"), p, last).line);
  CHECK(m.at("type") == "fileOf" && m.at("id") == "f2");
  CHECK(m.at("path") == "C:\\docs\\a.pdf" && m.at("address").empty() && m.at("how") == "title");
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
  test_parse_marks_command();
  test_marks_for_a_gone_capture_is_bad();
  test_marks_maps_boxes_to_request_units();
  test_marks_keeps_what_one_probe_found();
  test_marks_file_escapes_tabs_and_newlines();
  test_marks_file_cuts_on_a_character_boundary();
  test_budget_gives_up_on_a_slow_probe();
  test_budget_returns_a_fast_probe();
  test_secure_focus_sends_no_value();
  test_slow_probe_replies_slow_and_exits();
  test_file_of_reply();
  std::printf("%d passed, %d failed\n", g_pass, g_fail);
  return g_fail == 0 ? 0 : 1;
}
