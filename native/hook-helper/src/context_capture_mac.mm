// macOS: ScreenCaptureKit grab without lolPing's windows, CoreGraphics resize, ImageIO JPEG,
// the frontmost app and its focused window's title.
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ImageIO/ImageIO.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#include <unistd.h>

#include <string>

#include "context.h"

namespace lp::ctx {
namespace {

// Short of the main process's 3 s request timeout, so a stuck call becomes an error reply instead of a restart.
constexpr double kWaitSeconds = 2.5;

bool wait(dispatch_semaphore_t done) {
  const int64_t ns = static_cast<int64_t>(kWaitSeconds * NSEC_PER_SEC);
  return dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, ns)) == 0;
}

// Draws `src` into BGRA pixels at w x h (premultiplied-first, little-endian: B, G, R, A in memory).
bool draw(CGImageRef src, int w, int h, Image& out) {
  out.w = w;
  out.h = h;
  out.px.assign(static_cast<size_t>(w) * h * 4, 0);
  CGColorSpaceRef space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  CGContextRef ctx = CGBitmapContextCreate(out.px.data(), w, h, 8, static_cast<size_t>(w) * 4, space,
                                           kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little);
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
                                           kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little);
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

bool grab(const Rect& d, Image& out, Failure& fail) {
  @autoreleasepool {
    if (!CGPreflightScreenCaptureAccess()) {
      fail.code = "permission";
      fail.message = "Screen Recording permission is off";
      return false;
    }
    if (@available(macOS 14.0, *)) {
      dispatch_semaphore_t done = dispatch_semaphore_create(0);
      __block SCShareableContent* content = nil;
      __block NSError* error = nil;
      [SCShareableContent getShareableContentExcludingDesktopWindows:NO
                                                  onScreenWindowsOnly:YES
                                                    completionHandler:^(SCShareableContent* c, NSError* e) {
                                                      content = c;
                                                      error = e;
                                                      dispatch_semaphore_signal(done);
                                                    }];
      if (!wait(done)) {
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
      __block CGImageRef shot = nullptr;
      [SCScreenshotManager captureImageWithFilter:filter
                                    configuration:config
                                completionHandler:^(CGImageRef image, NSError* e) {
                                  if (image) shot = CGImageRetain(image);
                                  error = e;
                                  dispatch_semaphore_signal(done);
                                }];
      if (!wait(done)) {
        fail.message = "the screenshot timed out";  // a late image leaks; rare enough to accept
        return false;
      }
      if (!shot) {
        if (error.code == SCStreamErrorUserDeclined) fail.code = "permission";
        fail.message = error ? error.localizedDescription.UTF8String : "no image";
        return false;
      }
      // The rect is normally the whole display; crop when it is a part of it.
      const CGRect part = CGRectMake((d.x - display.frame.origin.x) * scale, (d.y - display.frame.origin.y) * scale,
                                     d.w * scale, d.h * scale);
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
    fail.message = "screen capture needs macOS 14 or later";
    return false;
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

bool foreground(std::string& app, std::string& title, Failure&) {
  @autoreleasepool {
    app.clear();
    title.clear();
    // NSWorkspace learns about app switches from run loop notifications; this process blocks on stdin otherwise.
    [[NSRunLoop currentRunLoop] runUntilDate:[NSDate date]];
    NSRunningApplication* front = NSWorkspace.sharedWorkspace.frontmostApplication;
    if (!front) return true;
    if (front.localizedName) app = front.localizedName.UTF8String;
    AXUIElementRef el = AXUIElementCreateApplication(front.processIdentifier);
    if (!el) return true;
    AXUIElementSetMessagingTimeout(el, 1.0f);  // a hung app must not stall the reply
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

}  // namespace

ContextPlatform nativePlatform() {
  ContextPlatform p;
  p.grab = grab;
  p.resize = resize;
  p.writeJpeg = writeJpeg;
  p.foreground = foreground;
  return p;
}

}  // namespace lp::ctx
