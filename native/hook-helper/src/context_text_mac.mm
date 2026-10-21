// macOS text probes: named controls and text near the spots by the Accessibility API, the boxes around the element
// under each spot, the system's own text (selection, focus, text under the spots, browser address) and the file
// behind the window.
// Each runs on its own fresh thread (context.h), so each opens its own autorelease pool and keeps no caller state.
// The Accessibility probes need the Accessibility permission for this process.
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <CoreGraphics/CoreGraphics.h>
#include <strings.h>
#include <sys/stat.h>
#include <unistd.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <deque>
#include <functional>
#include <iterator>
#include <string>
#include <vector>

#include "context.h"

namespace lp::ctx {
namespace {

using Clock = std::chrono::steady_clock;

constexpr size_t kMaxControls = 400;
constexpr size_t kControlNodes = 4000;  // elements looked at per window before the walk gives up
constexpr size_t kSecureScanNodes = 5000;
constexpr size_t kAddressNodes = 1500;
constexpr size_t kNameMax = 200;  // characters of a control's name kept; the marks file cuts it further
constexpr int kPasswordParents = 3;  // how far up a password field's inner nodes are looked for
// The probe's own limit, inside the 1 s the caller gives it: past it a walk stops and the probe answers with what
// it has, rather than the helper being restarted for answering late.
constexpr std::chrono::milliseconds kWalkBudget{800};

// Owns one Core Foundation object.
class Ref {
 public:
  Ref() = default;
  explicit Ref(CFTypeRef r) : r_(r) {}
  Ref(Ref&& o) noexcept : r_(o.r_) { o.r_ = nullptr; }
  Ref& operator=(Ref&& o) noexcept {
    if (this != &o) {
      reset();
      r_ = o.r_;
      o.r_ = nullptr;
    }
    return *this;
  }
  Ref(const Ref&) = delete;
  Ref& operator=(const Ref&) = delete;
  ~Ref() { reset(); }
  CFTypeRef get() const { return r_; }
  explicit operator bool() const { return r_ != nullptr; }
  /** For the Copy… calls: releases what was held and hands out the slot to fill. */
  CFTypeRef* put() {
    reset();
    return &r_;
  }
  /** Only when the object is known to be an element. */
  AXUIElementRef el() const { return static_cast<AXUIElementRef>(r_); }
  void reset() {
    if (r_) CFRelease(r_);
    r_ = nullptr;
  }

 private:
  CFTypeRef r_ = nullptr;
};

Ref retained(CFTypeRef r) {
  CFRetain(r);
  return Ref(r);
}

std::string utf8Of(CFStringRef s) {
  const char* c = ((__bridge NSString*)s).UTF8String;
  return c ? std::string(c) : std::string();
}

// A string value cut to `maxChars` characters before it is copied; "" for anything that is not a string.
std::string textOf(CFTypeRef v, size_t maxChars) {
  if (!v || CFGetTypeID(v) != CFStringGetTypeID() || maxChars == 0) return "";
  const CFStringRef s = static_cast<CFStringRef>(v);
  CFIndex n = CFStringGetLength(s);
  const CFIndex keep = static_cast<CFIndex>(maxChars) * 2;  // UTF-16 units; characters outside the BMP take two
  if (n <= keep) return cutText(utf8Of(s), maxChars);
  n = keep;
  if (CFStringIsSurrogateHighCharacter(CFStringGetCharacterAtIndex(s, n - 1))) --n;
  const Ref part(CFStringCreateWithSubstring(kCFAllocatorDefault, s, CFRangeMake(0, n)));
  return part ? cutText(utf8Of(static_cast<CFStringRef>(part.get())), maxChars) : std::string();
}

std::string trimmed(const std::string& s) {
  const size_t a = s.find_first_not_of(" \t\r\n");
  if (a == std::string::npos) return std::string();
  return s.substr(a, s.find_last_not_of(" \t\r\n") - a + 1);
}

Ref attr(AXUIElementRef el, CFStringRef name) {
  Ref out;
  if (AXUIElementCopyAttributeValue(el, name, out.put()) != kAXErrorSuccess) out.reset();
  return out;
}

bool isElement(const Ref& r) { return r && CFGetTypeID(r.get()) == AXUIElementGetTypeID(); }

// lolPing's main process started this helper and owns lolPing's windows. An element whose process cannot be told is
// left alone too.
bool unreadableApp(AXUIElementRef el) {
  pid_t pid = 0;
  return AXUIElementGetPid(el, &pid) != kAXErrorSuccess || pid == getppid();
}

bool isFile(const std::string& path) {
  struct stat st;
  return !path.empty() && ::stat(path.c_str(), &st) == 0 && S_ISREG(st.st_mode);
}

// One element's kind, name, box and children, read in a single call.
struct Node {
  std::string role, subrole, title, description;
  CGRect frame = CGRectZero;
  bool hasFrame = false;  // a position and a size, the size not empty
  Ref children;
};

enum NodeAttribute : CFIndex {
  kAttrRole,
  kAttrSubrole,
  kAttrTitle,
  kAttrDescription,
  kAttrPosition,
  kAttrSize,
  kAttrChildren,
  kNodeAttributes
};

CFArrayRef nodeAttributes() {
  static const CFArrayRef names = [] {
    const void* v[kNodeAttributes] = {kAXRoleAttribute,     kAXSubroleAttribute, kAXTitleAttribute,   kAXDescriptionAttribute,
                                      kAXPositionAttribute, kAXSizeAttribute,    kAXChildrenAttribute};
    return CFArrayCreate(kCFAllocatorDefault, v, kNodeAttributes, &kCFTypeArrayCallBacks);
  }();
  return names;
}

// An empty `role` means the element did not answer.
Node readNode(AXUIElementRef el) {
  Node n;
  CFArrayRef raw = nullptr;
  if (AXUIElementCopyMultipleAttributeValues(el, nodeAttributes(), static_cast<AXCopyMultipleAttributeOptions>(0),
                                             &raw) != kAXErrorSuccess ||
      !raw) {
    return n;
  }
  const Ref values(raw);
  if (CFArrayGetCount(raw) < kNodeAttributes) return n;
  n.role = textOf(CFArrayGetValueAtIndex(raw, kAttrRole), 80);
  n.subrole = textOf(CFArrayGetValueAtIndex(raw, kAttrSubrole), 80);
  n.title = trimmed(textOf(CFArrayGetValueAtIndex(raw, kAttrTitle), kNameMax));
  n.description = trimmed(textOf(CFArrayGetValueAtIndex(raw, kAttrDescription), kNameMax));
  const CFTypeRef position = CFArrayGetValueAtIndex(raw, kAttrPosition);
  const CFTypeRef size = CFArrayGetValueAtIndex(raw, kAttrSize);
  CGPoint p = CGPointZero;
  CGSize s = CGSizeZero;
  if (position && size && CFGetTypeID(position) == AXValueGetTypeID() && CFGetTypeID(size) == AXValueGetTypeID() &&
      AXValueGetValue(static_cast<AXValueRef>(position), kAXValueTypeCGPoint, &p) &&
      AXValueGetValue(static_cast<AXValueRef>(size), kAXValueTypeCGSize, &s) && s.width > 0 && s.height > 0) {
    n.frame = CGRectMake(p.x, p.y, s.width, s.height);
    n.hasFrame = true;
  }
  const CFTypeRef kids = CFArrayGetValueAtIndex(raw, kAttrChildren);
  if (kids && CFGetTypeID(kids) == CFArrayGetTypeID()) n.children = retained(kids);
  return n;
}

bool isSecure(const Node& n) { return n.role == "AXSecureTextField" || n.subrole == "AXSecureTextField"; }

// What a node name says: its title, else its description.
std::string nameOf(const Node& n) { return n.title.empty() ? n.description : n.title; }

enum class Next { Into, Skip, Stop };

// Visits `root` and then its descendants breadth first. Returns false when it gave up (node limit or deadline)
// before the whole tree was seen; true when it finished or `visit` said Stop.
bool walk(AXUIElementRef root, size_t maxNodes, Clock::time_point deadline,
          const std::function<Next(const Node&, AXUIElementRef)>& visit) {
  std::deque<Ref> queue;
  queue.push_back(retained(root));
  size_t seen = 0;
  while (!queue.empty()) {
    if (seen >= maxNodes || Clock::now() >= deadline) return false;
    const Ref current = std::move(queue.front());
    queue.pop_front();
    ++seen;
    const Node node = readNode(current.el());
    const Next next = visit(node, current.el());
    if (next == Next::Stop) return true;
    if (next == Next::Skip || !node.children) continue;
    const CFArrayRef kids = static_cast<CFArrayRef>(node.children.get());
    for (CFIndex i = 0; i < CFArrayGetCount(kids); ++i) {
      const CFTypeRef kid = CFArrayGetValueAtIndex(kids, i);
      if (kid && CFGetTypeID(kid) == AXUIElementGetTypeID()) queue.push_back(retained(kid));
    }
  }
  return true;
}

// Whether the element may hold a password field below it, so the text it gives may include one. Anything that cannot be
// told counts as yes (a node that does not answer, or a tree too big to look through in time).
bool mayHoldSecureField(AXUIElementRef el, Clock::time_point deadline) {
  bool found = false;
  const bool whole = walk(el, kSecureScanNodes, deadline, [&](const Node& n, AXUIElementRef) {
    if (n.role.empty() || isSecure(n)) {
      found = true;
      return Next::Stop;
    }
    return Next::Into;
  });
  return found || !whole;
}

enum class Guard { Open, Secure, Unreadable };

// Whether the element, or one of its few parents, is a password field. Chromium's password field holds a text node of
// bullets that is not marked as secure itself, so the parents are asked too.
Guard guardOf(AXUIElementRef el) {
  Ref node = retained(el);
  for (int depth = 0; depth <= kPasswordParents; ++depth) {
    const Node n = readNode(node.el());
    if (n.role.empty()) return Guard::Unreadable;
    if (isSecure(n)) return Guard::Secure;
    Ref parent = attr(node.el(), kAXParentAttribute);
    if (!isElement(parent)) break;
    node = std::move(parent);
  }
  return Guard::Open;
}

// The mark kind for a role, or nullptr to leave it out.
const char* kindOf(const Node& n) {
  const std::string& r = n.role;
  if (n.subrole == "AXTabButton" || r == "AXTab") return "tab";
  if (r == "AXButton" || r == "AXPopUpButton" || r == "AXMenuButton" || r == "AXDisclosureTriangle") return "button";
  if (r == "AXLink") return "link";
  if (r == "AXTextField" || r == "AXTextArea" || r == "AXComboBox" || r == "AXSecureTextField") return "field";
  if (r == "AXMenuItem" || r == "AXMenuBarItem" || r == "AXMenuBar") return "menu";
  if (r == "AXCheckBox" || r == "AXRadioButton") return "check";
  if (r == "AXRow" || r == "AXCell") return "item";
  if (r == "AXStaticText" || r == "AXHeading") return "text";
  // Containers, whose names say little about a place.
  for (const char* skip : {"AXGroup", "AXWindow", "AXWebArea", "AXScrollArea", "AXSplitGroup",
                           "AXToolbar", "AXList", "AXTable", "AXOutline", "AXBrowser", "AXTabGroup", "AXRadioGroup",
                           "AXLayoutArea", "AXLayoutItem", "AXSplitter", "AXScrollBar", "AXSheet", "AXDrawer",
                           "AXPopover", "AXApplication", "AXUnknown", "AXGrowArea"}) {
    if (r == skip) return nullptr;
  }
  return "other";
}

// Distance from `p` to the nearest point of `r`, squared; 0 inside. Same measure as selectMarks in marks.ts.
double distanceSq(const Point& p, const CGRect& r) {
  const double dx = std::max({r.origin.x - p.x, 0.0, p.x - (r.origin.x + r.size.width)});
  const double dy = std::max({r.origin.y - p.y, 0.0, p.y - (r.origin.y + r.size.height)});
  return dx * dx + dy * dy;
}

Ref systemWide() {
  Ref system(AXUIElementCreateSystemWide());
  if (system) AXUIElementSetMessagingTimeout(system.el(), 1.0f);  // a hung app must not stall the reply
  return system;
}

bool noAccess(Failure& fail) {
  if (AXIsProcessTrusted()) return false;
  fail.code = "permission";
  fail.message = "Accessibility permission is off";
  return true;
}

// The element at a screen point, or none when it is lolPing's own or does not answer.
Ref elementAt(AXUIElementRef system, Point p) {
  AXUIElementRef hit = nullptr;
  if (AXUIElementCopyElementAtPosition(system, static_cast<float>(p.x), static_cast<float>(p.y), &hit) !=
          kAXErrorSuccess ||
      !hit) {
    return Ref();
  }
  Ref out(hit);
  return unreadableApp(out.el()) ? Ref() : std::move(out);
}

// The window that holds the element at `p`, or none (the menu bar and the Dock have none).
Ref windowAt(AXUIElementRef system, Point p) {
  const Ref hit = elementAt(system, p);
  if (!hit) return Ref();
  if (readNode(hit.el()).role == "AXWindow") return retained(hit.get());
  Ref window = attr(hit.el(), kAXWindowAttribute);
  return isElement(window) ? std::move(window) : Ref();
}

}  // namespace

bool nearbyControls(const std::vector<Point>& spots, int radius, std::vector<RawMark>& out, Failure& fail) {
  @autoreleasepool {
    if (noAccess(fail)) return false;
    const Clock::time_point deadline = Clock::now() + kWalkBudget;
    const Ref system = systemWide();
    if (!system) {
      fail.message = "could not reach the Accessibility API";
      return false;
    }
    const double r2 = static_cast<double>(radius) * radius;
    const auto inReach = [&](const CGRect& box) {
      return std::any_of(spots.begin(), spots.end(), [&](const Point& p) { return distanceSq(p, box) <= r2; });
    };
    std::vector<Ref> seen;
    for (const Point& spot : spots) {
      if (out.size() >= kMaxControls || Clock::now() >= deadline) break;
      Ref window = windowAt(system.el(), spot);
      if (!window) continue;
      if (std::any_of(seen.begin(), seen.end(), [&](const Ref& w) { return CFEqual(w.get(), window.get()); })) continue;
      seen.push_back(retained(window.get()));
      walk(window.el(), kControlNodes, deadline, [&](const Node& n, AXUIElementRef) {
        if (out.size() >= kMaxControls) return Next::Stop;
        // A child lies inside its parent, so a branch that is out of reach has nothing in reach below it.
        if (n.hasFrame && !inReach(n.frame)) return Next::Skip;
        const char* kind = kindOf(n);
        const std::string name = nameOf(n);
        if (kind && n.hasFrame && !name.empty()) {
          const int x = static_cast<int>(std::lround(n.frame.origin.x));
          const int y = static_cast<int>(std::lround(n.frame.origin.y));
          const int w = std::max(1, static_cast<int>(std::lround(n.frame.size.width)));
          const int h = std::max(1, static_cast<int>(std::lround(n.frame.size.height)));
          out.push_back(RawMark{kind, Rect{x, y, w, h}, name});
        }
        return Next::Into;
      });
    }
    return true;
  }
}

namespace {

const char* const kBrowsers[] = {"com.apple.Safari",       "com.apple.SafariTechnologyPreview", "com.google.Chrome",
                                 "com.google.Chrome.canary", "com.microsoft.edgemac",             "company.thebrowser.Browser",
                                 "com.brave.Browser",       "org.mozilla.firefox"};

bool isBrowser(AXUIElementRef app) {
  pid_t pid = 0;
  if (AXUIElementGetPid(app, &pid) != kAXErrorSuccess) return false;
  NSString* bundle = [NSRunningApplication runningApplicationWithProcessIdentifier:pid].bundleIdentifier;
  if (!bundle) return false;
  return std::any_of(std::begin(kBrowsers), std::end(kBrowsers),
                     [&](const char* id) { return [bundle isEqualToString:[NSString stringWithUTF8String:id]]; });
}

// A file URL as a path (percent-decoded), or empty when it is another kind of address.
std::string pathFromFileUrl(const std::string& value) {
  NSString* text = [NSString stringWithUTF8String:value.c_str()];
  NSURL* url = text ? [NSURL URLWithString:text] : nil;
  if (!url || !url.isFileURL) return "";
  const char* path = url.path.UTF8String;
  return path ? std::string(path) : std::string();
}

bool startsWithFileScheme(const std::string& value) {
  return value.size() >= 7 && strncasecmp(value.c_str(), "file://", 7) == 0;
}

// A browser's URL or address-bar text as a local `path` or a web `address`; false when it is neither.
bool pathOrAddress(const std::string& value, std::string& path, std::string& address) {
  path.clear();
  address.clear();
  if (startsWithFileScheme(value)) {
    path = pathFromFileUrl(value);
    return !path.empty();
  }
  std::string drive;  // the shared helper's Windows path form; meaningless here
  return browserAddress(value, drive, address) && drive.empty();
}

// AXURL holds a URL object in most apps and a string in some.
std::string urlText(const Ref& v) {
  if (!v) return "";
  if (CFGetTypeID(v.get()) == CFURLGetTypeID()) {
    return textOf(CFURLGetString(static_cast<CFURLRef>(v.get())), kAddressMax);
  }
  return textOf(v.get(), kAddressMax);
}

// The page behind a browser window: the URL of its first web area, else the first address bar whose text reads as an
// address (Safari shows only the host there). Only the window's own controls are looked at, never a page's fields,
// and a password field is never read.
bool pageAddress(AXUIElementRef window, Clock::time_point deadline, std::string& path, std::string& address) {
  std::string barPath, barAddress;
  bool web = false, bar = false;
  walk(window, kAddressNodes, deadline, [&](const Node& n, AXUIElementRef el) {
    if (n.role == "AXWebArea") {
      web = pathOrAddress(urlText(attr(el, kAXURLAttribute)), path, address);
      return web ? Next::Stop : Next::Skip;
    }
    if (!bar && (n.role == "AXTextField" || n.role == "AXComboBox") && !isSecure(n)) {
      bar = pathOrAddress(textOf(attr(el, kAXValueAttribute).get(), kAddressMax), barPath, barAddress);
    }
    return Next::Into;
  });
  if (web) return true;
  path = barPath;
  address = barAddress;
  return bar;
}

// The paragraph under the spot when the element has text, else its name and value.
std::string spotText(AXUIElementRef system, Point p, Clock::time_point deadline) {
  const Ref el = elementAt(system, p);
  if (!el || guardOf(el.el()) != Guard::Open) return "";
  const Node n = readNode(el.el());
  const std::string name = nameOf(n);
  std::string value = textOf(attr(el.el(), kAXValueAttribute).get(), kSpotTextMax);
  if (!value.empty() && mayHoldSecureField(el.el(), deadline)) value.clear();
  if (value.empty() || value == name) return cutText(name, kSpotTextMax);
  return cutText(name.empty() ? value : name + "\n" + value, kSpotTextMax);
}

// The focused element's kind, label, value and selection; nothing when it is lolPing's own.
void readFocus(AXUIElementRef system, Clock::time_point deadline, SystemText& out) {
  const Ref focus = attr(system, kAXFocusedUIElementAttribute);
  if (!isElement(focus) || unreadableApp(focus.el())) return;
  const Guard guard = guardOf(focus.el());
  if (guard == Guard::Unreadable) return;
  const Node n = readNode(focus.el());
  const char* kind = kindOf(n);
  out.focusKind = kind ? kind : "other";
  out.focusLabel = cutText(nameOf(n), kFocusValueMax);
  if (out.focusLabel.empty()) {
    const Ref label = attr(focus.el(), kAXTitleUIElementAttribute);
    if (isElement(label)) out.focusLabel = cutText(nameOf(readNode(label.el())), kFocusValueMax);
  }
  out.focusSecure = guard == Guard::Secure;
  if (out.focusSecure) return;  // never read: no value, no selection
  std::string value = textOf(attr(focus.el(), kAXValueAttribute).get(), kFocusValueMax);
  std::string selection = textOf(attr(focus.el(), kAXSelectedTextAttribute).get(), kSelectionMax);
  if ((!value.empty() || !selection.empty()) && mayHoldSecureField(focus.el(), deadline)) {
    value.clear();
    selection.clear();
  }
  out.focusValue = std::move(value);
  out.selection = std::move(selection);
}

}  // namespace

bool elementBoxes(const std::vector<Point>& spots, std::vector<std::vector<Rect>>& out, Failure& fail) {
  @autoreleasepool {
    if (noAccess(fail)) return false;
    const Clock::time_point deadline = Clock::now() + kWalkBudget;
    const Ref system = systemWide();
    if (!system) {
      fail.message = "could not reach the Accessibility API";
      return false;
    }
    for (const Point& spot : spots) {
      std::vector<Rect>& chain = out.emplace_back();
      Ref el = elementAt(system.el(), spot);
      // Up to the window: the application above it frames nothing.
      for (int depth = 0; isElement(el) && depth < 40 && Clock::now() < deadline; ++depth) {
        const Node n = readNode(el.el());
        if (n.role.empty() || n.role == "AXApplication") break;
        if (n.hasFrame) {
          chain.push_back(Rect{static_cast<int>(std::lround(n.frame.origin.x)),
                               static_cast<int>(std::lround(n.frame.origin.y)),
                               static_cast<int>(std::lround(n.frame.size.width)),
                               static_cast<int>(std::lround(n.frame.size.height))});
        }
        if (n.role == "AXWindow") break;
        el = attr(el.el(), kAXParentAttribute);
      }
    }
    return true;
  }
}

bool systemTextAt(const std::vector<Point>& spots, bool withAddress, SystemText& out, Failure& fail) {
  @autoreleasepool {
    if (noAccess(fail)) return false;
    const Clock::time_point deadline = Clock::now() + kWalkBudget;
    const Ref system = systemWide();
    if (!system) {
      fail.message = "could not reach the Accessibility API";
      return false;
    }
    for (const Point& spot : spots) out.spotTexts.push_back(spotText(system.el(), spot, deadline));
    readFocus(system.el(), deadline, out);
    if (!withAddress) return true;
    const Ref app = attr(system.el(), kAXFocusedApplicationAttribute);
    if (isElement(app) && !unreadableApp(app.el()) && isBrowser(app.el())) {
      AXUIElementSetMessagingTimeout(app.el(), 1.0f);  // a hung browser must not stall the reply
      const Ref window = attr(app.el(), kAXFocusedWindowAttribute);
      std::string path, address;
      if (isElement(window) && pageAddress(window.el(), deadline, path, address)) {
        out.address = cutText(path.empty() ? address : path, kAddressMax);
      }
    }
    return true;
  }
}

bool fileBehindWindow(std::string& path, std::string& address, std::string& how, Failure& fail) {
  @autoreleasepool {
    path.clear();
    address.clear();
    how = "none";
    if (noAccess(fail)) return false;
    const Clock::time_point deadline = Clock::now() + kWalkBudget;
    const Ref system = systemWide();
    if (!system) {
      fail.message = "could not reach the Accessibility API";
      return false;
    }
    const Ref app = attr(system.el(), kAXFocusedApplicationAttribute);
    if (!isElement(app) || unreadableApp(app.el())) return true;
    AXUIElementSetMessagingTimeout(app.el(), 1.0f);
    const Ref window = attr(app.el(), kAXFocusedWindowAttribute);
    if (!isElement(window)) return true;
    if (isBrowser(app.el())) {
      std::string local, web;
      if (!pageAddress(window.el(), deadline, local, web)) return true;
      if (!local.empty() && !isFile(local)) return true;
      path = local;
      address = web;
      how = "address";
      return true;
    }
    // The window's own document, which the app reports as a file URL.
    const std::string document = urlText(attr(window.el(), kAXDocumentAttribute));
    const std::string file = startsWithFileScheme(document) ? pathFromFileUrl(document) : std::string();
    if (isFile(file)) {
      path = file;
      how = "office";
    }
    return true;
  }
}

}  // namespace lp::ctx
