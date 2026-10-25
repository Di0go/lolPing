// macOS writes for the teammate's Do it asks: the fields of the form under the first spot and setField by the
// Accessibility API, and the paste route (NSPasteboard, a click and ⌘V). Mirrors context_write_win.cpp.
// Each Accessibility call runs on a fresh thread (context.h), so each opens its own autorelease pool and keeps no
// caller state; the clipboard and input calls run on the command loop. The Accessibility calls need the Accessibility
// permission for this process, the posted events too.
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Carbon/Carbon.h>
#include <unistd.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <deque>
#include <functional>
#include <iterator>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "ax_mac.h"
#include "context.h"
#include "selfMarker.h"

namespace lp::ctx {

// In context_text_mac.mm: the focused element's selection, read as the ask's own read does.
bool focusedSelection(std::string& out);

namespace {

// Stops with the fields found so far, short of the 1 s probe budget, so a big form still gives some.
constexpr std::chrono::milliseconds kFieldsBudget{700};
constexpr size_t kFieldNodes = 6000;  // elements looked at before the search gives up
constexpr int kFieldDepth = 80;
// How far up from the spot the page's web area is looked for.
constexpr int kScopeLevels = 40;
// How far up from a radio its group is looked for.
constexpr int kGroupLevels = 8;
// How far below a pop-up its list items are looked for.
constexpr int kOptionLevels = 3;
// How long a pop-up's list, or a checkbox's new state, may take to show after the call that changes it.
constexpr int kSettlePolls = 10;
constexpr int kSettlePollMs = 30;
// A window smaller than this is a helper window (a shadow, an invisible tracking area), not the one the user sees.
constexpr CGFloat kMinWindowPoints = 32;
// The pause between the events of a click or a key press, so an app that samples them sees each.
constexpr int kEventGapMs = 10;
// The nspasteboard.org markers: clipboard managers skip an item that has either one.
NSString* const kTransientType = @"org.nspasteboard.TransientType";
NSString* const kConcealedType = @"org.nspasteboard.ConcealedType";
constexpr CGKeyCode kFallbackKeyV = 9;  // kVK_ANSI_V

void sleepMs(int ms) { std::this_thread::sleep_for(std::chrono::milliseconds(ms)); }

int px(CGFloat v) { return static_cast<int>(std::lround(v)); }

// A label or name on one line, without the spaces around it.
std::string oneLine(const std::string& text) {
  std::string out;
  for (size_t i = 0; i < text.size(); ++i) {
    const char c = text[i];
    if (c == '\r' || c == '\n' || c == '\t') {
      out += ' ';
    } else if (c == '\xC2' && i + 1 < text.size() && text[i + 1] == '\xA0') {  // a no-break space
      out += ' ';
      ++i;
    } else {
      out += c;
    }
  }
  return trimmed(out);
}

bool flagOf(AXUIElementRef el, CFStringRef name) {
  const Ref v = attr(el, name);
  return v && CFGetTypeID(v.get()) == CFBooleanGetTypeID() && CFBooleanGetValue(static_cast<CFBooleanRef>(v.get()));
}

// ---- Windows: the id main keeps for the ask's window -------------------------------------------------------------
// The foreground reply's window id is the app's process id above the window's CGWindowID, in decimal: the same pair
// names the window under a click point, with no private API. A window is the topmost normal-level window the user
// sees (an app's palettes and panels sit at other levels).

std::string windowKey(pid_t pid, uint32_t number) {
  return std::to_string((static_cast<uint64_t>(static_cast<uint32_t>(pid)) << 32) | number);
}

// The parser lets through digits only.
bool splitKey(const std::string& key, pid_t& pid, uint32_t& number) {
  try {
    const unsigned long long v = std::stoull(key);
    pid = static_cast<pid_t>(v >> 32);
    number = static_cast<uint32_t>(v & 0xFFFFFFFFu);
    return pid > 0 && number > 0;
  } catch (const std::exception&) {
    return false;
  }
}

struct OnScreen {
  pid_t pid = 0;
  uint32_t number = 0;
  CGRect bounds = CGRectZero;
  std::string title;  // empty without Screen Recording permission
};

// The normal-level windows on screen, front to back, in global points with the origin at the top left.
std::vector<OnScreen> normalWindows() {
  std::vector<OnScreen> out;
  @autoreleasepool {
    CFArrayRef info = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
                                                 kCGNullWindowID);
    if (!info) return out;
    for (CFIndex i = 0; i < CFArrayGetCount(info); ++i) {
      NSDictionary* w = (__bridge NSDictionary*)CFArrayGetValueAtIndex(info, i);
      if ([w[(__bridge NSString*)kCGWindowLayer] intValue] != 0) continue;
      NSNumber* alpha = w[(__bridge NSString*)kCGWindowAlpha];
      if (alpha && alpha.doubleValue <= 0.01) continue;
      NSDictionary* box = w[(__bridge NSString*)kCGWindowBounds];
      CGRect bounds = CGRectZero;
      if (!box || !CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)box, &bounds)) continue;
      if (bounds.size.width < kMinWindowPoints || bounds.size.height < kMinWindowPoints) continue;
      OnScreen s;
      s.pid = static_cast<pid_t>([w[(__bridge NSString*)kCGWindowOwnerPID] intValue]);
      s.number = [w[(__bridge NSString*)kCGWindowNumber] unsignedIntValue];
      s.bounds = bounds;
      NSString* name = w[(__bridge NSString*)kCGWindowName];
      if ([name isKindOfClass:[NSString class]] && name.UTF8String) s.title = name.UTF8String;
      out.push_back(s);
    }
    CFRelease(info);
  }
  return out;
}

std::string frontWindowKey(pid_t pid) {
  for (const OnScreen& w : normalWindows()) {
    if (w.pid == pid) return windowKey(pid, w.number);
  }
  return std::string();
}

// The same window frontWindowKey names, with its caption and box; false when the app has none on screen.
bool frontWindowOf(pid_t pid, std::string& key, std::string& title, CGRect& bounds) {
  for (const OnScreen& w : normalWindows()) {
    if (w.pid != pid) continue;
    key = windowKey(pid, w.number);
    title = w.title;
    bounds = w.bounds;
    return true;
  }
  return false;
}

// Empty when no normal window is under the point.
std::string windowKeyAt(Point at) {
  const CGPoint p = CGPointMake(at.x, at.y);
  for (const OnScreen& w : normalWindows()) {
    if (CGRectContainsPoint(w.bounds, p)) return windowKey(w.pid, w.number);
  }
  return std::string();
}

// A window that answers an Accessibility call within 200 ms: a frozen app would take the ⌘V late, after the restore.
bool responsive(const std::string& window) {
  @autoreleasepool {
    pid_t pid = 0;
    uint32_t number = 0;
    if (!splitKey(window, pid, number)) return false;
    NSRunningApplication* app = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
    if (!app || app.terminated) return false;
    const Ref el(AXUIElementCreateApplication(pid));
    if (!el) return false;
    AXUIElementSetMessagingTimeout(el.el(), static_cast<float>(kAnswerWaitMs) / 1000.0f);
    CFTypeRef role = nullptr;
    const AXError error = AXUIElementCopyAttributeValue(el.el(), kAXRoleAttribute, &role);
    if (role) CFRelease(role);
    // Only an answer from the app counts, even one saying the attribute is missing; any other error (a timeout, a
    // denied or failed call) may mean it would take the ⌘V late.
    return error == kAXErrorSuccess || error == kAXErrorAttributeUnsupported || error == kAXErrorNoValue ||
           error == kAXErrorNotImplemented;
  }
}

// ---- Fields: the ids setField and the paste's click check use ---------------------------------------------------
// There is no runtime id in the Accessibility API, so a field read gets ids of its own, "<window>.<read>.<number>",
// and the helper keeps the elements they name for the reads that follow. The id also says which window the field is
// in, so a setField is refused for a window other than the ask's. Entries of the last few reads are kept: a field
// read for an earlier ask still answers its own fill.

struct Known {
  std::string id;
  pid_t pid = 0;
  uint32_t window = 0;
  Ref el;
};

class Registry {
 public:
  /** A generation for this read, seeded per process so quick helper restarts do not start at the same number. */
  int32_t nextRead() {
    const std::lock_guard<std::mutex> hold(lock_);
    counter_ = counter_ >= 2000000000 ? 1 : counter_ + 1;
    return counter_;
  }

  void publish(std::vector<Known> fresh) {
    if (fresh.empty()) return;
    const std::lock_guard<std::mutex> hold(lock_);
    reads_.push_back(std::move(fresh));
    while (reads_.size() > kReads) reads_.pop_front();
  }

  bool find(const std::string& id, Known& out) const {
    const std::lock_guard<std::mutex> hold(lock_);
    for (const std::vector<Known>& read : reads_) {
      for (const Known& k : read) {
        if (k.id != id) continue;
        out.id = k.id;
        out.pid = k.pid;
        out.window = k.window;
        out.el = retained(k.el.get());
        return true;
      }
    }
    return false;
  }

  /** The id of the element, or empty when no read listed it. */
  std::string idOf(AXUIElementRef el) const {
    const std::lock_guard<std::mutex> hold(lock_);
    for (auto read = reads_.rbegin(); read != reads_.rend(); ++read) {
      for (const Known& k : *read) {
        if (CFEqual(k.el.get(), el)) return k.id;
      }
    }
    return std::string();
  }

 private:
  static constexpr size_t kReads = 4;
  mutable std::mutex lock_;
  std::deque<std::vector<Known>> reads_;
  int32_t counter_ = static_cast<int32_t>((arc4random() ^ static_cast<uint32_t>(getpid())) % 2000000000u) + 1;
};

// Never destroyed: a probe thread that ran over its budget may still be using it when the helper exits.
Registry& registry() {
  static Registry* const instance = new Registry;
  return *instance;
}

// ---- Fields: what a control is and says ---------------------------------------------------------------------------

// The field kind of an element (RawField::kind), or nullptr when it is not a form control.
const char* fieldKindOf(const Node& n) {
  const std::string& r = n.role;
  if (n.subrole == "AXTabButton") return nullptr;  // a tab, not a choice in a form
  if (r == "AXTextField" || r == "AXSecureTextField") return "text";  // a password field has the secure subrole
  if (r == "AXTextArea") return "multiline";
  if (r == "AXComboBox" || r == "AXPopUpButton") return "combo";
  if (r == "AXCheckBox") return "checkbox";
  if (r == "AXRadioButton") return "radio";
  return nullptr;
}

// The label a field shows: the element that labels it, else its title, its description, then its placeholder, as the
// Windows probe reads LabeledBy, Name and HelpText.
std::string labelOf(AXUIElementRef el, const Node& n) {
  const Ref labelEl = attr(el, kAXTitleUIElementAttribute);
  if (isElement(labelEl)) {
    std::string text = nameOf(readNode(labelEl.el()));
    if (text.empty()) text = trimmed(textOf(attr(labelEl.el(), kAXValueAttribute).get(), kNameMax));
    if (!text.empty()) return text;
  }
  if (!n.title.empty()) return n.title;
  if (!n.description.empty()) return n.description;
  return trimmed(textOf(attr(el, CFSTR("AXPlaceholderValue")).get(), kNameMax));
}

// A checkbox's or radio's AXValue: 1 on, 0 off, 2 mixed; -1 when it can't be read.
int checkState(AXUIElementRef el) {
  const Ref v = attr(el, kAXValueAttribute);
  if (v && CFGetTypeID(v.get()) == CFBooleanGetTypeID()) {
    return CFBooleanGetValue(static_cast<CFBooleanRef>(v.get())) ? 1 : 0;
  }
  int state = -1;
  if (v && CFGetTypeID(v.get()) == CFNumberGetTypeID() &&
      CFNumberGetValue(static_cast<CFNumberRef>(v.get()), kCFNumberIntType, &state)) {
    return state;
  }
  return -1;
}

// The list items of a pop-up or combo, read where they are without opening it: a web page's select keeps them in
// the tree, a closed Cocoa pop-up keeps its menu.
void gatherOptions(const Node& n, int levels, std::vector<std::string>& out) {
  if (levels == 0 || !n.children) return;
  const CFArrayRef kids = static_cast<CFArrayRef>(n.children.get());
  for (CFIndex i = 0; i < CFArrayGetCount(kids) && out.size() < kMaxFieldOptions; ++i) {
    const CFTypeRef kid = CFArrayGetValueAtIndex(kids, i);
    if (!kid || CFGetTypeID(kid) != AXUIElementGetTypeID()) continue;
    const Node child = readNode(static_cast<AXUIElementRef>(kid));
    if (child.role == "AXMenuItem") {
      const std::string name = oneLine(nameOf(child));
      if (!name.empty()) out.push_back(name);
    } else {
      gatherOptions(child, levels - 1, out);
    }
  }
}

// ---- Fields: the search -------------------------------------------------------------------------------------------

struct Scope {
  Ref element;
  CGRect frame = CGRectZero;
  pid_t pid = 0;
  uint32_t window = 0;
};

// What to search: the page's web area when the spot is on a web page, so the browser's own address bar (also a text
// field) is not a field, else the window. None for lolPing's own windows, and when the element under the spot is not
// in the window the paste route names for that point (a menu, a panel).
bool scopeUnder(AXUIElementRef system, Point spot, Clock::time_point deadline, Scope& out) {
  const Ref hit = elementAt(system, spot);
  if (!hit || AXUIElementGetPid(hit.el(), &out.pid) != kAXErrorSuccess) return false;
  pid_t keyPid = 0;
  if (!splitKey(windowKeyAt(spot), keyPid, out.window) || keyPid != out.pid) return false;
  if (out.window > static_cast<uint32_t>(INT32_MAX)) return false;  // the id's first part is a 32-bit int
  // A page inside a page (an iframe) has a web area of its own: the outermost one covers them all.
  Ref web, window;
  Ref node = retained(hit.get());
  for (int depth = 0; depth < kScopeLevels && Clock::now() < deadline; ++depth) {
    const std::string role = textOf(attr(node.el(), kAXRoleAttribute).get(), 80);
    if (role == "AXWebArea") web = retained(node.get());
    if (role == "AXWindow") {
      window = retained(node.get());
      break;
    }
    Ref parent = attr(node.el(), kAXParentAttribute);
    if (!isElement(parent)) break;
    node = std::move(parent);
  }
  if (!window) {
    Ref found = attr(hit.el(), kAXWindowAttribute);
    if (isElement(found)) window = std::move(found);
  }
  Ref& scope = web ? web : window;
  if (!scope) return false;
  const Node n = readNode(scope.el());
  if (n.hasFrame) {
    out.frame = n.frame;
  } else {
    const Node w = window ? readNode(window.el()) : Node();
    if (!w.hasFrame) return false;
    out.frame = w.frame;
  }
  out.element = std::move(scope);
  return true;
}

struct Walk {
  Clock::time_point deadline;
  CGRect scope = CGRectZero;
  pid_t pid = 0;
  uint32_t window = 0;
  int32_t read = 0;
  size_t nodes = 0;
  std::vector<RawField>* out = nullptr;
  std::vector<Known> known;
  std::vector<std::pair<int, std::string>> groups;  // the named groups above the node, with the depth of each

  bool done() const { return out->size() >= kMaxFormFields || nodes >= kFieldNodes || Clock::now() >= deadline; }
};

void addField(AXUIElementRef el, const Node& n, const char* kind, int depth, Walk& w) {
  if (!n.hasFrame) return;
  const Ref enabled = attr(el, kAXEnabledAttribute);
  if (enabled && CFGetTypeID(enabled.get()) == CFBooleanGetTypeID() &&
      !CFBooleanGetValue(static_cast<CFBooleanRef>(enabled.get()))) {
    return;
  }
  RawField f;
  f.kind = kind;
  f.box = Rect{px(n.frame.origin.x), px(n.frame.origin.y), std::max(1, px(n.frame.size.width)),
               std::max(1, px(n.frame.size.height))};
  f.secure = isSecure(n);
  f.label = oneLine(labelOf(el, n));
  f.required = flagOf(el, CFSTR("AXRequired"));
  if (f.kind == "checkbox" || f.kind == "radio") {
    f.value = checkState(el) == 1 ? "on" : "off";
    // The nearest named group above a radio (a fieldset's legend).
    if (f.kind == "radio" && !w.groups.empty() && depth - w.groups.back().first <= kGroupLevels) {
      f.group = w.groups.back().second;
    }
  } else {
    // A password field's bullets say how long the password is: nothing of it is kept.
    if (!f.secure) f.value = textOf(attr(el, kAXValueAttribute).get(), kFieldValueMax);
    if (f.kind == "combo") gatherOptions(n, kOptionLevels, f.options);
  }
  f.id = std::to_string(w.window) + "." + std::to_string(w.read) + "." + std::to_string(w.out->size() + 1);
  w.known.push_back(Known{f.id, w.pid, w.window, retained(el)});
  w.out->push_back(std::move(f));
}

// Visits the element and what is below it in document order. Off screen or scrolled out of the page, an element
// shows nothing below it either.
void collect(AXUIElementRef el, int depth, Walk& w) {
  if (w.done() || depth > kFieldDepth) return;
  ++w.nodes;
  const Node n = readNode(el);
  if (n.role.empty()) return;
  if (n.hasFrame && !CGRectIntersectsRect(n.frame, w.scope)) return;
  if (const char* kind = fieldKindOf(n)) {
    addField(el, n, kind, depth, w);
    return;  // what is inside a field is its own part
  }
  const bool group = (n.role == "AXRadioGroup" || n.role == "AXGroup") && !nameOf(n).empty();
  if (group) w.groups.emplace_back(depth, oneLine(nameOf(n)));
  if (n.children) {
    const CFArrayRef kids = static_cast<CFArrayRef>(n.children.get());
    for (CFIndex i = 0; i < CFArrayGetCount(kids) && !w.done(); ++i) {
      const CFTypeRef kid = CFArrayGetValueAtIndex(kids, i);
      if (kid && CFGetTypeID(kid) == AXUIElementGetTypeID()) collect(static_cast<AXUIElementRef>(kid), depth + 1, w);
    }
  }
  if (group) w.groups.pop_back();
}

}  // namespace

std::string frontWindowId(pid_t pid) { return frontWindowKey(pid); }

bool frontWindowInfo(pid_t pid, std::string& window, std::string& title, CGRect& box) {
  @autoreleasepool {
    return frontWindowOf(pid, window, title, box);
  }
}

bool formFieldsAt(const std::vector<Point>& spots, std::vector<RawField>& out, Failure& fail) {
  @autoreleasepool {
    if (noAccess(fail)) return false;
    const Clock::time_point deadline = Clock::now() + kFieldsBudget;
    const Ref system = systemWide();
    if (!system) {
      fail.message = "could not reach the Accessibility API";
      return false;
    }
    if (spots.empty()) return true;
    Scope scope;
    if (!scopeUnder(system.el(), spots.front(), deadline, scope)) return true;
    Walk walk;
    walk.deadline = deadline;
    walk.scope = scope.frame;
    walk.pid = scope.pid;
    walk.window = scope.window;
    walk.read = registry().nextRead();
    walk.out = &out;
    collect(scope.element.el(), 0, walk);
    registry().publish(std::move(walk.known));
    return true;
  }
}

namespace {

// ---- What a write needs to know about a field first ---------------------------------------------------------------

const char* const kClickableRoles[] = {"AXButton",   "AXLink",         "AXMenuItem",           "AXMenuBarItem",
                                       "AXMenuButton", "AXPopUpButton", "AXComboBox",           "AXCheckBox",
                                       "AXRadioButton", "AXDisclosureTriangle", "AXRow",         "AXTab"};

// Whether a click on the element does something of its own: its role, or an action that presses it. One that can't be
// read counts as one.
bool activatable(AXUIElementRef el, const Node& n) {
  if (n.role.empty() || n.subrole == "AXTabButton") return true;
  if (std::any_of(std::begin(kClickableRoles), std::end(kClickableRoles),
                  [&n](const char* role) { return n.role == role; })) {
    return true;
  }
  CFArrayRef names = nullptr;
  if (AXUIElementCopyActionNames(el, &names) != kAXErrorSuccess || !names) return true;
  const Ref held(names);
  return CFArrayContainsValue(names, CFRangeMake(0, CFArrayGetCount(names)), kAXPressAction);
}

// Kind, label, id and password flag; an element that can't be read, or sits in a password field, counts as one.
FieldFacts factsOf(AXUIElementRef el, const Node& n) {
  FieldFacts f;
  const char* kind = fieldKindOf(n);
  f.kind = kind ? kind : "other";
  f.label = n.role.empty() ? std::string() : oneLine(labelOf(el, n));
  f.id = registry().idOf(el);
  f.secure = n.role.empty() || guardOf(el) != Guard::Open;
  return f;
}

// The first kFieldAncestors elements above `el`, nearest first.
std::vector<AncestorFacts> ancestorsOf(AXUIElementRef el) {
  std::vector<AncestorFacts> out;
  Ref node = retained(el);
  while (out.size() < kFieldAncestors) {
    Ref parent = attr(node.el(), kAXParentAttribute);
    if (!isElement(parent)) break;
    const Node n = readNode(parent.el());
    AncestorFacts a;
    a.id = registry().idOf(parent.el());
    a.label = n.role.empty() ? std::string() : oneLine(labelOf(parent.el(), n));
    a.secure = n.role.empty() || isSecure(n);
    a.activatable = activatable(parent.el(), n);
    out.push_back(std::move(a));
    node = std::move(parent);
  }
  return out;
}

bool fieldFactsAt(std::optional<Point> at, FieldFacts& out) {
  @autoreleasepool {
    Failure fail;
    if (noAccess(fail)) return false;
    const Ref system = systemWide();
    if (!system) return false;
    Ref el;
    if (at) {
      el = elementAt(system.el(), *at);
    } else {
      const AXError error = AXUIElementCopyAttributeValue(system.el(), kAXFocusedUIElementAttribute, el.put());
      if (error == kAXErrorNoValue) {
        // A responsive app can have no focused control; a click may still put the caret in an allowed field.
        const Ref app = attr(system.el(), kAXFocusedApplicationAttribute);
        pid_t pid = 0;
        if (!isElement(app) || unreadableApp(app.el()) || AXUIElementGetPid(app.el(), &pid) != kAXErrorSuccess ||
            !responsive(frontWindowKey(pid))) return false;
        out = FieldFacts{};
        out.kind = "other";
        return true;
      }
      if (error != kAXErrorSuccess || !isElement(el) || unreadableApp(el.el())) el.reset();
    }
    if (!el) return false;
    const Node n = readNode(el.el());
    out = factsOf(el.el(), n);
    if (at) {
      // What the click would hit may be a part of the field, or a button in it: clickTarget decides.
      out.activatable = activatable(el.el(), n);
      out.ancestors = ancestorsOf(el.el());
    }
    return true;
  }
}

// ---- Hands, the clipboard and the events --------------------------------------------------------------------------

// The state of Shift, Control, Option, Command and the mouse buttons as the apps see it, held with the top bit set.
std::vector<uint16_t> keyStates() {
  constexpr CGEventSourceStateID kState = kCGEventSourceStateCombinedSessionState;
  const CGEventFlags flags = CGEventSourceFlagsState(kState);
  std::vector<uint16_t> out;
  for (const CGEventFlags mask : {kCGEventFlagMaskShift, kCGEventFlagMaskControl, kCGEventFlagMaskAlternate,
                                  kCGEventFlagMaskCommand}) {
    out.push_back((flags & mask) != 0 ? 0x8000 : 0);
  }
  for (int button = 0; button < 5; ++button) {
    out.push_back(CGEventSourceButtonState(kState, static_cast<CGMouseButton>(button)) ? 0x8000 : 0);
  }
  return out;
}

// A pasteboard holds items, each with its own types. A saved format is named "<item>|<type>", and the saved bytes of
// every type of every item go back as they were.
std::string formatName(size_t item, const char* type) { return std::to_string(item) + "|" + type; }

bool parseFormatName(const std::string& name, size_t& item, std::string& type) {
  const size_t bar = name.find('|');
  if (bar == std::string::npos || bar == 0 || bar + 1 >= name.size()) return false;
  try {
    item = static_cast<size_t>(std::stoul(name.substr(0, bar)));
  } catch (const std::exception&) {
    return false;
  }
  type = name.substr(bar + 1);
  return true;
}

// The items the last clipboardFormats call listed, for readClipboard to read the bytes from. Used on the command loop
// only.
NSArray<NSPasteboardItem*>* g_items = nil;

// A promised type stays listed, but reading it is refused before asking its owner to produce data.
bool promised(NSString* type) { return [type.lowercaseString containsString:@"promise"]; }

// The pasteboard is not opened or locked: nothing to wait for.
bool openClipboard() { return true; }

std::vector<ClipFormat> clipboardFormats() {
  std::vector<ClipFormat> out;
  @autoreleasepool {
    g_items = NSPasteboard.generalPasteboard.pasteboardItems;
    for (NSUInteger i = 0; i < g_items.count; ++i) {
      for (NSPasteboardType type in g_items[i].types) {
        const char* c = type.UTF8String;
        if (c) out.push_back(ClipFormat{0, formatName(i, c), {}});
      }
    }
  }
  return out;
}

bool readClipboard(ClipFormat& f) {
  @autoreleasepool {
    size_t item = 0;
    std::string type;
    if (!parseFormatName(f.name, item, type) || !g_items || item >= g_items.count) return false;
    NSString* name = [NSString stringWithUTF8String:type.c_str()];
    if (!name || promised(name)) return false;
    NSData* data = [g_items[item] dataForType:name];
    if (!data) return false;
    f.bytes.clear();
    if (data.length > 0) {
      const auto* bytes = static_cast<const uint8_t*>(data.bytes);
      f.bytes.assign(bytes, bytes + data.length);
    }
    return true;
  }
}

// The text the shared code builds for CF_UNICODETEXT: UTF-16LE with its terminating zero.
NSString* textOfUtf16(const std::vector<uint8_t>& bytes) {
  size_t n = bytes.size();
  if (n >= 2 && bytes[n - 2] == 0 && bytes[n - 1] == 0) n -= 2;
  return [[NSString alloc] initWithBytes:bytes.data() length:n encoding:NSUTF16LittleEndianStringEncoding];
}

// Puts the formats on the pasteboard, going on past one that fails; false when any did. The text goes on as the plain
// string of the first item; the three exclusion formats become the transient and concealed markers on it.
bool writeClipboard(const std::vector<ClipFormat>& formats) {
  @autoreleasepool {
    NSMutableDictionary<NSNumber*, NSPasteboardItem*>* byIndex = [NSMutableDictionary dictionary];
    const auto itemAt = [byIndex](NSUInteger index) {
      NSPasteboardItem* item = byIndex[@(index)];
      if (!item) {
        item = [[NSPasteboardItem alloc] init];
        byIndex[@(index)] = item;
      }
      return item;
    };
    bool all = true, marked = false;
    for (const ClipFormat& f : formats) {
      if (isExclusionFormat(f.name)) {
        marked = true;
      } else if (f.id == kClipUnicodeText) {
        NSString* text = textOfUtf16(f.bytes);
        if (!text || ![itemAt(0) setString:text forType:NSPasteboardTypeString]) all = false;
      } else {
        size_t index = 0;
        std::string type;
        NSString* name = nil;
        if (parseFormatName(f.name, index, type)) name = [NSString stringWithUTF8String:type.c_str()];
        NSData* data = [NSData dataWithBytes:f.bytes.data() length:f.bytes.size()];
        if (!name || ![itemAt(static_cast<NSUInteger>(index)) setData:data forType:name]) all = false;
      }
    }
    NSMutableArray<NSPasteboardItem*>* items = [NSMutableArray array];
    for (NSNumber* index in [byIndex.allKeys sortedArrayUsingSelector:@selector(compare:)]) {
      [items addObject:byIndex[index]];
    }
    // Clipboard managers look at the types of the pasteboard, so the first item carries the markers.
    if (marked && items.count > 0) {
      for (NSString* marker in @[ kTransientType, kConcealedType ]) {
        if (![items[0].types containsObject:marker] && ![items[0] setData:[NSData data] forType:marker]) all = false;
      }
    }
    NSPasteboard* pasteboard = NSPasteboard.generalPasteboard;
    [pasteboard clearContents];
    if (items.count == 0) return all;
    return [pasteboard writeObjects:items] && all;
  }
}

// An event of lolPing's own: the input hook passes it through as it is (selfMarker.h).
bool post(CGEventRef event) {
  if (!event) return false;
  CGEventSetIntegerValueField(event, kCGEventSourceUserData, static_cast<int64_t>(kSelfMarker));
  CGEventPost(kCGHIDEventTap, event);
  CFRelease(event);
  return true;
}

bool mouse(CGEventType type, CGPoint at, int64_t clickState = 0) {
  CGEventRef event = CGEventCreateMouseEvent(nullptr, type, at, kCGMouseButtonLeft);
  if (event && clickState != 0) CGEventSetIntegerValueField(event, kCGMouseEventClickState, clickState);
  return post(event);
}

// A primary-button click at the point; the pointer goes back where it was, as the click only puts the caret in a field.
bool clickAt(Point at) {
  CGPoint was = CGPointZero;
  bool known = false;
  if (CGEventRef now = CGEventCreate(nullptr)) {
    was = CGEventGetLocation(now);
    known = true;
    CFRelease(now);
  }
  const CGPoint target = CGPointMake(at.x, at.y);
  if (!mouse(kCGEventMouseMoved, target)) return false;
  sleepMs(kEventGapMs);
  if (!mouse(kCGEventLeftMouseDown, target, 1)) return false;  // nothing went down: nothing to let up
  sleepMs(kEventGapMs);
  const bool up = mouse(kCGEventLeftMouseUp, target, 1);
  if (known) mouse(kCGEventMouseMoved, was);
  return up;
}

// The Command mapping matters for layouts such as Dvorak-QWERTY Command.
std::optional<CGKeyCode> commandVInLayout(TISInputSourceRef source) {
  if (!source) return std::nullopt;
  const CFTypeRef property = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData);
  if (!property || CFGetTypeID(property) != CFDataGetTypeID()) return std::nullopt;
  const CFDataRef data = static_cast<CFDataRef>(property);
  if (CFDataGetLength(data) == 0) return std::nullopt;
  const auto* layout = reinterpret_cast<const UCKeyboardLayout*>(CFDataGetBytePtr(data));
  for (UInt16 key = 0; key < 128; ++key) {
    UInt32 dead = 0;
    UniChar chars[4] = {};
    UniCharCount count = 0;
    const OSStatus status = UCKeyTranslate(layout, key, kUCKeyActionDown, cmdKey >> 8,
                                          static_cast<UInt32>(LMGetKbdType()), kUCKeyTranslateNoDeadKeysMask,
                                          &dead, 4, &count, chars);
    if (status == noErr && count == 1 && chars[0] == 'v') return key;
  }
  return std::nullopt;
}

CGKeyCode commandVKey() {
  // The command loop (including pressPaste) is on main. TIS must never be called by an AX probe worker.
  if (![NSThread isMainThread]) return kFallbackKeyV;
  const TISInputSourceRef current = TISCopyCurrentKeyboardLayoutInputSource();
  const Ref heldCurrent(current);
  if (const auto key = commandVInLayout(current)) return *key;
  const TISInputSourceRef ascii = TISCopyCurrentASCIICapableKeyboardLayoutInputSource();
  const Ref heldAscii(ascii);
  if (const auto key = commandVInLayout(ascii)) return *key;
  return kFallbackKeyV;
}

// ⌘V as a V key press carrying the Command flag, the way the wheel's own replayed keys do (hooks_mac.cpp): the real
// ⌘ key never goes down, so nothing can be left held. Both events are made before either is sent.
bool pressCommandV() {
  const CGKeyCode key = commandVKey();
  CGEventRef down = CGEventCreateKeyboardEvent(nullptr, key, true);
  CGEventRef up = CGEventCreateKeyboardEvent(nullptr, key, false);
  if (!down || !up) {
    if (down) CFRelease(down);
    if (up) CFRelease(up);
    return false;
  }
  CGEventSetFlags(down, kCGEventFlagMaskCommand);
  CGEventSetFlags(up, kCGEventFlagMaskCommand);
  post(down);
  sleepMs(kEventGapMs);
  post(up);
  return true;
}

// ---- setField ------------------------------------------------------------------------------------------------------

bool press(AXUIElementRef el) { return AXUIElementPerformAction(el, kAXPressAction) == kAXErrorSuccess; }

const char* setText(AXUIElementRef el, const std::string& value) {
  Boolean settable = false;
  if (AXUIElementIsAttributeSettable(el, kAXValueAttribute, &settable) != kAXErrorSuccess || !settable) {
    return "refused";
  }
  NSString* text = [NSString stringWithUTF8String:value.c_str()];
  if (!text) return "refused";
  const std::string before = textOf(attr(el, kAXValueAttribute).get(), kFieldValueMax);
  if (AXUIElementSetAttributeValue(el, kAXValueAttribute, (__bridge CFStringRef)text) != kAXErrorSuccess) {
    return "refused";
  }
  // A page may take the value a moment after the call. A value that never changed was ignored; one that changed to
  // something else (a mask, a limit) was taken.
  std::string now = before;
  for (int i = 0; i < kSettlePolls; ++i) {
    now = textOf(attr(el, kAXValueAttribute).get(), kFieldValueMax);
    if (now == value) return "ok";
    if (now != before) return "ok";
    sleepMs(kSettlePollMs);
  }
  return now == before && before != value ? "refused" : "ok";
}

// Presses until the state is the one asked for. A page may show the new state a moment after the call, so each press
// waits for the state to change before the next: two quick presses would undo each other.
const char* setChecked(AXUIElementRef el, const std::string& value) {
  if (value != "on" && value != "off") return "refused";
  const int want = value == "on" ? 1 : 0;
  // Off, on, in between: two presses reach any state.
  for (int presses = 0; presses <= 2; ++presses) {
    const int before = checkState(el);
    if (before < 0) return "refused";
    if (before == want) return "ok";
    if (presses == 2 || !press(el)) return "refused";
    int now = before;
    for (int i = 0; i < kSettlePolls && now == before; ++i) {
      sleepMs(kSettlePollMs);
      now = checkState(el);
      if (now < 0) return "refused";
    }
    if (now == before) return "refused";
  }
  return "refused";
}

const char* setRadio(AXUIElementRef el, const std::string& value) {
  const int selected = checkState(el);
  if (selected < 0) return "refused";
  // A radio is turned off only by choosing another one in its group.
  if (value == "off") return selected == 0 ? "ok" : "refused";
  if (value != "on") return "refused";
  if (selected == 1) return "ok";
  if (!press(el)) return "refused";
  for (int i = 0; i < kSettlePolls; ++i) {
    sleepMs(kSettlePollMs);
    if (checkState(el) == 1) return "ok";
  }
  return "refused";
}

// The list item named `value` below the pop-up, or none; `listed` says whether it shows any item at all.
Ref itemNamed(const Node& n, int levels, const std::string& value, bool& listed) {
  if (levels == 0 || !n.children) return Ref();
  const CFArrayRef kids = static_cast<CFArrayRef>(n.children.get());
  for (CFIndex i = 0; i < CFArrayGetCount(kids); ++i) {
    const CFTypeRef kid = CFArrayGetValueAtIndex(kids, i);
    if (!kid || CFGetTypeID(kid) != AXUIElementGetTypeID()) continue;
    const Node child = readNode(static_cast<AXUIElementRef>(kid));
    if (child.role == "AXMenuItem") {
      listed = true;
      if (oneLine(nameOf(child)) == value) return retained(kid);
    } else if (Ref found = itemNamed(child, levels - 1, value, listed)) {
      return found;
    }
  }
  return Ref();
}

// AXCancel belongs to the menu, not to the pop-up button that opened it.
Ref menuBelow(const Node& n, int levels) {
  if (levels == 0 || !n.children) return Ref();
  const CFArrayRef kids = static_cast<CFArrayRef>(n.children.get());
  for (CFIndex i = 0; i < CFArrayGetCount(kids); ++i) {
    const CFTypeRef kid = CFArrayGetValueAtIndex(kids, i);
    if (!kid || CFGetTypeID(kid) != AXUIElementGetTypeID()) continue;
    const Node child = readNode(static_cast<AXUIElementRef>(kid));
    if (child.role == "AXMenu") return retained(kid);
    if (Ref found = menuBelow(child, levels - 1)) return found;
  }
  return Ref();
}

// Chooses the option by name: where the tree keeps it, else in the list a press opens. A web page's select takes
// a value set and ignores it (spec §16), so the item is pressed.
const char* setPopUp(AXUIElementRef el, const Node& n, const std::string& value) {
  bool listed = false;
  Ref item = itemNamed(n, kOptionLevels, value, listed);
  bool opened = false;
  if (!item) {
    opened = press(el) || AXUIElementPerformAction(el, kAXShowMenuAction) == kAXErrorSuccess;
    for (int i = 0; opened && !item && i < kSettlePolls; ++i) {
      sleepMs(kSettlePollMs);
      listed = false;
      item = itemNamed(readNode(el), kOptionLevels, value, listed);
    }
  }
  const char* result = item && press(item.el()) ? "ok" : "refused";
  if (opened && std::string(result) != "ok") {
    const Ref menu = menuBelow(readNode(el), kOptionLevels);
    if (menu) AXUIElementPerformAction(menu.el(), kAXCancelAction);
  }
  // A pop-up that lists nothing takes any text (comboAccepts in doRules.ts).
  if (!listed) result = setText(el, value);
  return result;
}

std::string setFieldIn(const SetFieldRequest& r, const std::function<std::string(const FieldFacts&)>& vet) {
  @autoreleasepool {
    pid_t pid = 0;
    uint32_t number = 0;
    Failure fail;
    if (!splitKey(r.window, pid, number) || noAccess(fail)) return "refused";
    const Ref system = systemWide();
    // A field of this window only, as the id says: one from another window, or from before the helper started, is gone.
    Known known;
    if (!registry().find(r.field, known) || known.pid != pid || known.window != number) return "gone";
    const Node n = readNode(known.el.el());
    if (n.role.empty()) return "gone";
    if (const std::string refused = vet(factsOf(known.el.el(), n)); !refused.empty()) return refused;
    const std::string& role = n.role;
    if (role == "AXCheckBox") return setChecked(known.el.el(), r.value);
    if (role == "AXRadioButton") return setRadio(known.el.el(), r.value);
    if (role == "AXPopUpButton") return setPopUp(known.el.el(), n, r.value);
    return setText(known.el.el(), r.value);
  }
}

}  // namespace

// There is no integrity level above the user's on macOS that drops input: `elevated` is never reported.
void addWriting(ContextPlatform& p) {
  p.frontWindowId = [] {
    @autoreleasepool {
      // Refresh NSWorkspace's cached foreground pid without an AX query to the target app.
      [[NSRunLoop currentRunLoop] runUntilDate:[NSDate date]];
      NSRunningApplication* front = NSWorkspace.sharedWorkspace.frontmostApplication;
      return front ? frontWindowKey(front.processIdentifier) : std::string();
    }
  };
  p.responsive = responsive;
  p.elevated = [](const std::string&) { return false; };
  p.windowAt = windowKeyAt;
  p.focusedSelection = focusedSelection;
  p.fieldFacts = fieldFactsAt;
  p.keyStates = keyStates;
  p.openClipboard = openClipboard;
  p.closeClipboard = [] {};
  p.clipboardFormats = clipboardFormats;
  p.readClipboard = readClipboard;
  p.writeClipboard = writeClipboard;
  p.clipboardSequence = [] { return static_cast<uint32_t>(NSPasteboard.generalPasteboard.changeCount); };
  p.click = clickAt;
  p.pressPaste = pressCommandV;
  p.wait = sleepMs;
  p.now = [] {
    return static_cast<int64_t>(
        std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now().time_since_epoch()).count());
  };
  p.setField = setFieldIn;
}

}  // namespace lp::ctx
