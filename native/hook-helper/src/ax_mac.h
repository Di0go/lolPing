#pragma once
// The Accessibility API helpers the macOS probes share (context_text_mac.mm, context_write_mac.mm): CF ownership, one
// element's attributes in a single call, the password-field guard, the element at a point. Objective-C++ only.
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#include <unistd.h>

#include <chrono>
#include <string>
#include <utility>

#include "context.h"

namespace lp::ctx {

using Clock = std::chrono::steady_clock;

// A timeout on the system-wide element changes the default for this entire process, not just this thread.
// All probes use the same value so concurrent reads cannot lengthen each other's calls. Half a second holds a hung
// app to one call, and is long enough for a busy browser's tree. The frozen-app check alone sets a shorter timeout, on
// the one app element it asks.
constexpr float kAxMessagingTimeoutSeconds = 0.5f;

constexpr size_t kNameMax = 200;  // characters of a control's name kept; the marks file cuts it further
constexpr int kPasswordParents = 3;  // how far up a password field's inner nodes are looked for

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

inline Ref retained(CFTypeRef r) {
  CFRetain(r);
  return Ref(r);
}

inline std::string utf8Of(CFStringRef s) {
  const char* c = ((__bridge NSString*)s).UTF8String;
  return c ? std::string(c) : std::string();
}

// A string value cut to `maxChars` characters before it is copied; "" for anything that is not a string.
inline std::string textOf(CFTypeRef v, size_t maxChars) {
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

inline std::string trimmed(const std::string& s) {
  const size_t a = s.find_first_not_of(" \t\r\n");
  if (a == std::string::npos) return std::string();
  return s.substr(a, s.find_last_not_of(" \t\r\n") - a + 1);
}

inline Ref attr(AXUIElementRef el, CFStringRef name) {
  Ref out;
  if (AXUIElementCopyAttributeValue(el, name, out.put()) != kAXErrorSuccess) out.reset();
  return out;
}

inline bool isElement(const Ref& r) { return r && CFGetTypeID(r.get()) == AXUIElementGetTypeID(); }

// lolPing's main process started this helper and owns lolPing's windows. An element whose process cannot be told is
// left alone too.
inline bool unreadableApp(AXUIElementRef el) {
  pid_t pid = 0;
  return AXUIElementGetPid(el, &pid) != kAXErrorSuccess || pid == getppid();
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

inline CFArrayRef nodeAttributes() {
  static const CFArrayRef names = [] {
    const void* v[kNodeAttributes] = {kAXRoleAttribute,     kAXSubroleAttribute, kAXTitleAttribute,   kAXDescriptionAttribute,
                                      kAXPositionAttribute, kAXSizeAttribute,    kAXChildrenAttribute};
    return CFArrayCreate(kCFAllocatorDefault, v, kNodeAttributes, &kCFTypeArrayCallBacks);
  }();
  return names;
}

// An empty `role` means the element did not answer.
inline Node readNode(AXUIElementRef el) {
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

inline bool isSecure(const Node& n) { return n.role == "AXSecureTextField" || n.subrole == "AXSecureTextField"; }

// What a node name says: its title, else its description.
inline std::string nameOf(const Node& n) { return n.title.empty() ? n.description : n.title; }

enum class Guard { Open, Secure, Unreadable };

// Whether the element, or one of its few parents, is a password field. Chromium's password field holds a text node of
// bullets that is not marked as secure itself, so the parents are asked too.
inline Guard guardOf(AXUIElementRef el) {
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

inline Ref systemWide() {
  Ref system(AXUIElementCreateSystemWide());
  if (system) AXUIElementSetMessagingTimeout(system.el(), kAxMessagingTimeoutSeconds);
  return system;
}

inline bool noAccess(Failure& fail) {
  if (AXIsProcessTrusted()) return false;
  fail.code = "permission";
  fail.message = "Accessibility permission is off";
  return true;
}

// The element at a screen point, or none when it is lolPing's own or does not answer.
inline Ref elementAt(AXUIElementRef system, Point p) {
  AXUIElementRef hit = nullptr;
  if (AXUIElementCopyElementAtPosition(system, static_cast<float>(p.x), static_cast<float>(p.y), &hit) !=
          kAXErrorSuccess ||
      !hit) {
    return Ref();
  }
  Ref out(hit);
  return unreadableApp(out.el()) ? Ref() : std::move(out);
}

}  // namespace lp::ctx
