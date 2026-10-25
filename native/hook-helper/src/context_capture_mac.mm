// macOS: ScreenCaptureKit grab without lolPing's windows (CGWindowList on macOS 13), CoreGraphics resize, ImageIO JPEG,
// the frontmost app and its focused window's title.
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ImageIO/ImageIO.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#include <unistd.h>

#include <cmath>
#include <string>
#include <vector>

#include "ax_mac.h"
#include "context.h"

namespace lp::ctx {

// In context_write_mac.mm: the id of the app's topmost normal window, which the paste and setField commands name.
std::string frontWindowId(pid_t pid);
// Also in context_write_mac.mm: the same window with its caption and box (global points, top left origin).
bool frontWindowInfo(pid_t pid, std::string& window, std::string& title, CGRect& box);

namespace {

// One deadline for the whole grab (listing + screenshot), short of the main process's 3 s request timeout,
// so a stuck call becomes an error reply instead of a restart.
constexpr double kGrabSeconds = 2.6;

bool waitUntil(dispatch_semaphore_t done, dispatch_time_t deadline) {
  return dispatch_semaphore_wait(done, deadline) == 0;
}

// Premultiplied-first, little-endian: B, G, R, A in memory.
constexpr CGBitmapInfo kBgra = static_cast<CGBitmapInfo>(kCGImageAlphaPremultipliedFirst) | kCGBitmapByteOrder32Little;

// Draws `src` into BGRA pixels at w x h (premultiplied-first, little-endian: B, G, R, A in memory).
bool draw(CGImageRef src, int w, int h, Image& out) {
  out.w = w;
  out.h = h;
  out.px.assign(static_cast<size_t>(w) * h * 4, 0);
  CGColorSpaceRef space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  CGContextRef ctx = CGBitmapContextCreate(out.px.data(), w, h, 8, static_cast<size_t>(w) * 4, space,
                                           kBgra);
  CGColorSpaceRelease(space);
  if (!ctx) return false;
  CGContextSetInterpolationQuality(ctx, kCGInterpolationHigh);
  CGContextDrawImage(ctx, CGRectMake(0, 0, w, h), src);
  CGContextRelease(ctx);
  return true;
}

CGImageRef toCGImage(const Image& img) {
  CGColorSpaceRef space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  CGContextRef ctx = CGBitmapContextCreate(const_cast<uint8_t*>(img.px.data()), img.w, img.h, 8,
                                           static_cast<size_t>(img.w) * 4, space,
                                           kBgra);
  CGColorSpaceRelease(space);
  if (!ctx) return nullptr;
  CGImageRef out = CGBitmapContextCreateImage(ctx);  // copies the pixels
  CGContextRelease(ctx);
  return out;
}

std::string utf8(CFStringRef s) {
  if (!s) return std::string();
  NSString* ns = (__bridge NSString*)s;
  const char* c = ns.UTF8String;
  return c ? std::string(c) : std::string();
}

// Crops `shot` to `part` (in its pixels) and reads it into `out`. Releases `shot`.
bool finishGrab(CGImageRef shot, CGRect part, Image& out, Failure& fail) {
  CGImageRef cropped = CGImageCreateWithImageInRect(shot, part);
  CGImageRelease(shot);
  if (!cropped) {
    fail.message = "the rect is outside the display";
    return false;
  }
  const int w = static_cast<int>(CGImageGetWidth(cropped));
  const int h = static_cast<int>(CGImageGetHeight(cropped));
  const bool ok = draw(cropped, w, h, out);
  CGImageRelease(cropped);
  if (!ok) fail.message = "could not read the screenshot";
  return ok;
}

// macOS 13: the screen without lolPing's own windows, from the window list (CGWindowListCreateImage is
// deprecated since 14 but is the only grab that exists on 13). `d` is global points, top left origin.
bool grabLegacy(const Rect& d, Image& out, Failure& fail) {
  const pid_t lolPing = getppid();
  CFArrayRef info = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID);
  if (!info) {
    fail.message = "could not list the windows";
    return false;
  }
  std::vector<const void*> ids;
  for (CFIndex i = 0; i < CFArrayGetCount(info); ++i) {
    NSDictionary* w = (__bridge NSDictionary*)CFArrayGetValueAtIndex(info, i);
    if ([w[(__bridge NSString*)kCGWindowOwnerPID] intValue] == lolPing) continue;
    const uintptr_t number = [w[(__bridge NSString*)kCGWindowNumber] unsignedIntValue];
    ids.push_back(reinterpret_cast<const void*>(number));  // CGWindowListCreateImageFromArray wants the ids as raw values
  }
  CFRelease(info);
  if (ids.empty()) {
    fail.message = "no windows to capture";
    return false;
  }
  CFArrayRef list = CFArrayCreate(kCFAllocatorDefault, ids.data(), static_cast<CFIndex>(ids.size()), nullptr);
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  CGImageRef shot = CGWindowListCreateImageFromArray(CGRectMake(d.x, d.y, d.w, d.h), list, kCGWindowImageBoundsIgnoreFraming);
#pragma clang diagnostic pop
  CFRelease(list);
  if (!shot) {
    fail.message = "the screenshot failed";
    return false;
  }
  const CGRect whole = CGRectMake(0, 0, CGImageGetWidth(shot), CGImageGetHeight(shot));
  return finishGrab(shot, whole, out, fail);
}

// macOS 14+: ScreenCaptureKit, with lolPing's windows excluded from the display's content.
API_AVAILABLE(macos(14.0))
bool grabKit(const Rect& d, dispatch_time_t deadline, Image& out, Failure& fail) {
  dispatch_semaphore_t listed = dispatch_semaphore_create(0);
  __block SCShareableContent* content = nil;
  __block NSError* error = nil;
  [SCShareableContent getShareableContentExcludingDesktopWindows:NO
                                              onScreenWindowsOnly:YES
                                                completionHandler:^(SCShareableContent* c, NSError* e) {
                                                  content = c;
                                                  error = e;
                                                  dispatch_semaphore_signal(listed);
                                                }];
  if (!waitUntil(listed, deadline)) {
    fail.message = "listing the displays timed out";
    return false;
  }
  if (!content) {
    if (error.code == SCStreamErrorUserDeclined) fail.code = "permission";
    fail.message = error ? error.localizedDescription.UTF8String : "no shareable content";
    return false;
  }
  // The display that holds the rect's centre; rects are global points, like the hook coordinates.
  const CGPoint centre = CGPointMake(d.x + d.w / 2.0, d.y + d.h / 2.0);
  SCDisplay* display = nil;
  for (SCDisplay* s in content.displays) {
    if (CGRectContainsPoint(s.frame, centre)) {
      display = s;
      break;
    }
  }
  if (!display) {
    fail.message = "no display at that rect";
    return false;
  }
  // lolPing's overlays and panels belong to the process that started this helper.
  const pid_t lolPing = getppid();
  NSMutableArray<SCWindow*>* own = [NSMutableArray array];
  for (SCWindow* w in content.windows) {
    if (w.owningApplication.processID == lolPing) [own addObject:w];
  }
  SCContentFilter* filter = [[SCContentFilter alloc] initWithDisplay:display excludingWindows:own];
  const CGFloat scale = filter.pointPixelScale;
  SCStreamConfiguration* config = [[SCStreamConfiguration alloc] init];
  config.width = static_cast<size_t>(display.frame.size.width * scale);
  config.height = static_cast<size_t>(display.frame.size.height * scale);
  config.showsCursor = NO;
  dispatch_semaphore_t shotDone = dispatch_semaphore_create(0);
  __block CGImageRef shot = nullptr;
  __block NSError* shotError = nil;
  [SCScreenshotManager captureImageWithFilter:filter
                                configuration:config
                            completionHandler:^(CGImageRef image, NSError* e) {
                              if (image) shot = CGImageRetain(image);
                              shotError = e;
                              dispatch_semaphore_signal(shotDone);
                            }];
  if (!waitUntil(shotDone, deadline)) {
    fail.message = "the screenshot timed out";  // a late image leaks; rare enough to accept
    return false;
  }
  if (!shot) {
    if (shotError.code == SCStreamErrorUserDeclined) fail.code = "permission";
    fail.message = shotError ? shotError.localizedDescription.UTF8String : "no image";
    return false;
  }
  // The rect is normally the whole display; crop when it is a part of it.
  const CGRect part = CGRectMake((d.x - display.frame.origin.x) * scale, (d.y - display.frame.origin.y) * scale,
                                 d.w * scale, d.h * scale);
  return finishGrab(shot, part, out, fail);
}

bool grab(const Rect& d, Image& out, Failure& fail) {
  @autoreleasepool {
    if (!CGPreflightScreenCaptureAccess()) {
      CGRequestScreenCaptureAccess();  // lists lolPing under Screen Recording and shows the system prompt once
      fail.code = "permission";
      fail.message = "Screen Recording permission is off";
      return false;
    }
    if (@available(macOS 14.0, *)) {
      const int64_t budget = static_cast<int64_t>(kGrabSeconds * NSEC_PER_SEC);
      return grabKit(d, dispatch_time(DISPATCH_TIME_NOW, budget), out, fail);
    }
    return grabLegacy(d, out, fail);
  }
}

bool resize(const Image& in, int w, int h, Image& out) {
  CGImageRef src = toCGImage(in);
  if (!src) return false;
  const bool ok = draw(src, w, h, out);
  CGImageRelease(src);
  return ok;
}

bool writeJpeg(const Image& img, int quality, const std::string& path, Failure& fail) {
  @autoreleasepool {
    CGImageRef image = toCGImage(img);
    if (!image) {
      fail.message = "could not build the image";
      return false;
    }
    NSURL* url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:path.c_str()]];
    CGImageDestinationRef dest = CGImageDestinationCreateWithURL((__bridge CFURLRef)url, CFSTR("public.jpeg"), 1, nullptr);
    bool ok = false;
    if (dest) {
      NSDictionary* props = @{(__bridge NSString*)kCGImageDestinationLossyCompressionQuality : @(quality / 100.0)};
      CGImageDestinationAddImage(dest, image, (__bridge CFDictionaryRef)props);
      ok = CGImageDestinationFinalize(dest);
      CFRelease(dest);
    }
    CGImageRelease(image);
    if (!ok) fail.message = "writing the JPEG failed";
    return ok;
  }
}

bool foreground(std::string& app, std::string& title, std::string& windowId, uint32_t& pid, Failure&) {
  @autoreleasepool {
    app.clear();
    title.clear();
    windowId.clear();
    pid = 0;
    // NSWorkspace learns about app switches from run loop notifications; this process blocks on stdin otherwise.
    [[NSRunLoop currentRunLoop] runUntilDate:[NSDate date]];
    NSRunningApplication* front = NSWorkspace.sharedWorkspace.frontmostApplication;
    if (!front) return true;
    pid = static_cast<uint32_t>(front.processIdentifier);
    if (front.localizedName) app = front.localizedName.UTF8String;
    windowId = frontWindowId(front.processIdentifier);
    AXUIElementRef el = AXUIElementCreateApplication(front.processIdentifier);
    if (!el) return true;
    AXUIElementSetMessagingTimeout(el, kAxMessagingTimeoutSeconds);
    CFTypeRef window = nullptr;
    if (AXUIElementCopyAttributeValue(el, kAXFocusedWindowAttribute, &window) == kAXErrorSuccess && window) {
      CFTypeRef value = nullptr;
      if (AXUIElementCopyAttributeValue((AXUIElementRef)window, kAXTitleAttribute, &value) == kAXErrorSuccess &&
          value) {
        if (CFGetTypeID(value) == CFStringGetTypeID()) title = utf8(static_cast<CFStringRef>(value));
        CFRelease(value);
      }
      CFRelease(window);
    }
    CFRelease(el);
    return true;
  }
}

// The window in front for the stale watch, polled twice a second: the window list only, no Accessibility call.
bool front(FrontWindow& out, Failure&) {
  @autoreleasepool {
    out = FrontWindow();
    // NSWorkspace learns about app switches from run loop notifications; this process blocks on stdin otherwise.
    [[NSRunLoop currentRunLoop] runUntilDate:[NSDate date]];
    NSRunningApplication* app = NSWorkspace.sharedWorkspace.frontmostApplication;
    if (!app) return true;  // nothing in front: all stay empty
    // The pid stays even with no window on screen, so main can tell lolPing in front from nothing in front.
    out.pid = static_cast<uint32_t>(app.processIdentifier);
    CGRect box = CGRectZero;
    if (!frontWindowInfo(app.processIdentifier, out.window, out.title, box)) return true;
    out.box = Rect{static_cast<int>(std::lround(box.origin.x)), static_cast<int>(std::lround(box.origin.y)),
                   static_cast<int>(std::lround(box.size.width)), static_cast<int>(std::lround(box.size.height))};
    return true;
  }
}

}  // namespace

// The text probes, in context_text_mac.mm.
bool nearbyControls(const std::vector<Point>& spots, int radius, std::vector<RawMark>& out, Failure& fail);
bool systemTextAt(const std::vector<Point>& spots, bool withAddress, SystemText& out, Failure& fail);
bool elementBoxes(const std::vector<Point>& spots, std::vector<std::vector<Rect>>& out, Failure& fail);
bool fileBehindWindow(std::string& path, std::string& address, std::string& how, Failure& fail);
// The form fields and the writes, in context_write_mac.mm.
bool formFieldsAt(const std::vector<Point>& spots, std::vector<RawField>& out, Failure& fail);
void addWriting(ContextPlatform& p);

ContextPlatform nativePlatform() {
  NSApplicationLoad();  // a command-line process needs a window server connection for ScreenCaptureKit
  systemWide();  // set the process-wide AX timeout before any foreground read or probe
  ContextPlatform p;
  p.grab = grab;
  p.resize = resize;
  p.writeJpeg = writeJpeg;
  p.foreground = foreground;
  p.front = front;
  p.controls = nearbyControls;
  p.systemText = systemTextAt;
  p.fileOf = fileBehindWindow;
  p.boxes = elementBoxes;
  p.formFields = formFieldsAt;
  addWriting(p);
  return p;
}

}  // namespace lp::ctx
