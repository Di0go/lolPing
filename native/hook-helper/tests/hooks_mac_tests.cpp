// Exercise the production macOS callback without installing a tap or posting input to other apps.
#include <ApplicationServices/ApplicationServices.h>
#include <iostream>
#include <string>
#include <vector>

namespace {
CGEventFlags flags = 0;
std::vector<int64_t> replayedCounts;
CGEventFlags testFlags(CGEventSourceStateID) { return flags; }
void testPost(CGEventTapLocation, CGEventRef event) {
  replayedCounts.push_back(CGEventGetIntegerValueField(event, kCGMouseEventClickState));
}
}

#define CGEventPost testPost
#define CGEventSourceFlagsState testFlags
#include "../src/hooks_mac.cpp"
#undef CGEventSourceFlagsState
#undef CGEventPost

int main() {
  int passed = 0, failed = 0;
  lp::Output out([](const std::string&) { return true; });
  lp::g_out = &out;
  const auto check = [&](bool condition, const char* message) {
    if (condition) ++passed;
    else { ++failed; std::cerr << message << '\n'; }
  };
  const auto mouse = [](CGEventType type, CGMouseButton button, int64_t count) {
    auto event = CGEventCreateMouseEvent(nullptr, type, CGPointMake(100, 100), button);
    CGEventSetFlags(event, flags);
    CGEventSetIntegerValueField(event, kCGMouseEventButtonNumber, button);
    CGEventSetIntegerValueField(event, kCGMouseEventClickState, count);
    const bool swallowed = lp::tapCallback(nullptr, type, event, nullptr) == nullptr;
    CFRelease(event);
    return swallowed;
  };
  for (const int64_t count : {1, 2, 3}) {
    for (const bool sideButton : {false, true}) {
      lp::Decision decision;
      decision.setMaskMenuKeys(false);
      auto cfg = decision.config();
      cfg.trigger = sideButton ? lp::Trigger::Mouse4 : lp::Trigger::Alt;
      decision.setConfig(cfg);
      lp::g_decision = &decision;
      lp::g_flags = 0;
      flags = sideButton ? 0 : kCGEventFlagMaskAlternate;
      replayedCounts.clear();
      const auto button = static_cast<CGMouseButton>(sideButton ? 3 : 0);
      check(mouse(sideButton ? kCGEventOtherMouseDown : kCGEventLeftMouseDown, button, count), "gesture press should be swallowed");
      // An unrelated button must not overwrite the gesture's click count.
      mouse(kCGEventRightMouseUp, kCGMouseButtonRight, 1);
      check(mouse(sideButton ? kCGEventOtherMouseUp : kCGEventLeftMouseUp, button, count), "gesture release should be swallowed");
      check(replayedCounts == std::vector<int64_t>({count, count}), "replayed down/up must preserve the original click count");
    }
  }
  // Releasing Option before the mouse also replays the saved press, before a mouse-up arrives.
  lp::Decision decision;
  decision.setMaskMenuKeys(false);
  lp::g_decision = &decision;
  lp::g_flags = 0;
  flags = kCGEventFlagMaskAlternate;
  replayedCounts.clear();
  mouse(kCGEventLeftMouseDown, kCGMouseButtonLeft, 2);
  flags = 0;
  auto release = CGEventCreateKeyboardEvent(nullptr, 58, false);
  CGEventSetType(release, kCGEventFlagsChanged);
  CGEventSetFlags(release, 0);
  lp::tapCallback(nullptr, kCGEventFlagsChanged, release, nullptr);
  CFRelease(release);
  check(replayedCounts == std::vector<int64_t>({2}), "trigger release must preserve the saved double-click count");
  check(!mouse(kCGEventLeftMouseUp, kCGMouseButtonLeft, 2), "real mouse-up after trigger release should pass through");
  // Command pressed and let go twice, as the tap sees it: flag changes, no key events. Real timestamps, a few ms apart.
  const auto commandFlagsChanged = [](bool down) {
    flags = down ? kCGEventFlagMaskCommand : 0;
    auto event = CGEventCreateKeyboardEvent(nullptr, 55, down);
    CGEventSetType(event, kCGEventFlagsChanged);
    CGEventSetFlags(event, flags);
    const bool swallowed = lp::tapCallback(nullptr, kCGEventFlagsChanged, event, nullptr) == nullptr;
    CFRelease(event);
    return swallowed;
  };
  const auto scroll = [] {
    auto event = CGEventCreateScrollWheelEvent(nullptr, kCGScrollEventUnitLine, 1, 3);
    CGEventSetFlags(event, 0);
    CGEventSetLocation(event, CGPointMake(120, 80));
    const bool swallowed = lp::tapCallback(nullptr, kCGEventScrollWheel, event, nullptr) == nullptr;
    CFRelease(event);
    return swallowed;
  };
  const auto countOf = [](const std::vector<std::string>& lines, const std::string& type) {
    int n = 0;
    for (const auto& l : lines) {
      if (l.find("\"type\":\"" + type + "\"") != std::string::npos) ++n;
    }
    return n;
  };
  {
    std::vector<std::string> lines;
    lp::Output sink([&lines](const std::string& l) { lines.push_back(l); return true; });
    lp::g_out = &sink;
    lp::Decision tapper;
    tapper.setMaskMenuKeys(false);
    auto cfg = tapper.config();
    cfg.askTrigger = lp::Trigger::Win;  // Command is the Win key on the Mac
    cfg.askDoubleTap = true;
    tapper.setConfig(cfg);
    lp::g_decision = &tapper;
    lp::g_flags = 0;
    flags = 0;
    commandFlagsChanged(true);
    commandFlagsChanged(false);
    commandFlagsChanged(true);
    commandFlagsChanged(false);
    sink.stop();
    check(countOf(lines, "askWords") == 1, "a double tap of command emits askWords");
  }
  {
    std::vector<std::string> lines;
    lp::Output sink([&lines](const std::string& l) { lines.push_back(l); return true; });
    lp::g_out = &sink;
    lp::Decision tapper;
    tapper.setMaskMenuKeys(false);
    auto cfg = tapper.config();
    cfg.askTrigger = lp::Trigger::Win;
    cfg.askDoubleTap = true;
    tapper.setConfig(cfg);
    lp::g_decision = &tapper;
    lp::g_flags = 0;
    flags = 0;
    commandFlagsChanged(true);
    commandFlagsChanged(false);
    check(!scroll(), "a scroll passes through the tap");  // watch off: nothing reported, and it cancels the tap
    commandFlagsChanged(true);
    commandFlagsChanged(false);
    tapper.setStaleWatch(true);
    check(!scroll(), "a reported scroll passes through the tap");
    sink.stop();
    check(countOf(lines, "askWords") == 0, "a scroll between the taps cancels the double tap");
    check(countOf(lines, "scroll") == 1, "a scroll is reported while the stale watch is on");
    bool located = false;
    for (const auto& l : lines) {
      if (l.find("\"type\":\"scroll\"") != std::string::npos) {
        located = l.find("\"x\":120,\"y\":80") != std::string::npos;
      }
    }
    check(located, "a scroll is reported at the event's location");
  }
  lp::g_decision = nullptr;
  lp::g_out = nullptr;
  std::cout << passed << " passed, " << failed << " failed (macOS callback)\n";
  return failed ? 1 : 0;
}
