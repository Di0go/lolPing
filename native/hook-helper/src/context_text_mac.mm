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

#include "ax_mac.h"
#include "context.h"

namespace lp::ctx {
namespace {

constexpr size_t kMaxControls = 400;
constexpr size_t kControlNodes = 4000;  // elements looked at per window before the walk gives up
constexpr size_t kSecureScanNodes = 5000;
constexpr size_t kAddressNodes = 1500;
// The probe's own limit, inside the 1 s the caller gives it: past it a walk stops and the probe answers with what
// it has, rather than the helper being restarted for answering late.
constexpr std::chrono::milliseconds kWalkBudget{800};
// Paste checks also read field facts within 800 ms; leave room for those and the last AX call.
constexpr std::chrono::milliseconds kSelectionBudget{400};

bool isFile(const std::string& path) {
  struct stat st;
  return !path.empty() && ::stat(path.c_str(), &st) == 0 && S_ISREG(st.st_mode);
}

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

// The paragraph under the spot when the element has text, else its name and value. A field named like a card number
// or a password gives only its name, as its value never leaves the helper.
std::string spotText(AXUIElementRef system, Point p, Clock::time_point deadline) {
  const Ref el = elementAt(system, p);
  if (!el || guardOf(el.el()) != Guard::Open) return "";
  const Node n = readNode(el.el());
  const std::string name = nameOf(n);
  const char* kind = kindOf(n);
  if (kind && std::string(kind) == "field" && neverFillLabel(name)) return cutText(name, kSpotTextMax);
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
      const Ref window = attr(app.el(), kAXFocusedWindowAttribute);
      std::string path, address;
      if (isElement(window) && pageAddress(window.el(), deadline, path, address)) {
        out.address = cutText(path.empty() ? address : path, kAddressMax);
      }
    }
    return true;
  }
}

// The focused element's selection, read as the ask's own read does, so a replace compares like with like. False when
// nothing readable has the keyboard or it is a password field.
bool focusedSelection(std::string& out) {
  @autoreleasepool {
    out.clear();
    Failure fail;
    if (noAccess(fail)) return false;
    const Ref system = systemWide();
    if (!system) return false;
    SystemText text;
    readFocus(system.el(), Clock::now() + kSelectionBudget, text);
    if (text.focusKind.empty() || text.focusSecure) return false;
    out = std::move(text.selection);
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
