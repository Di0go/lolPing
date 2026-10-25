// Windows: GDI grab of the display's physical rect, WIC resize and JPEG, the foreground window's process and title.
// lolPing's own overlays are kept out of the grab by main (WDA_EXCLUDEFROMCAPTURE on them for its duration).
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <dwmapi.h>
#include <wincodec.h>

#include <cstdint>
#include <cstdio>
#include <functional>
#include <string>
#include <vector>

#include "context.h"

namespace lp::ctx {
namespace {

std::wstring wide(const std::string& s) {
  if (s.empty()) return std::wstring();
  const int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
  std::wstring out(static_cast<size_t>(n), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), out.data(), n);
  return out;
}

std::string utf8(const std::wstring& s) {
  if (s.empty()) return std::string();
  const int n = WideCharToMultiByte(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0, nullptr, nullptr);
  std::string out(static_cast<size_t>(n), '\0');
  WideCharToMultiByte(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), out.data(), n, nullptr, nullptr);
  return out;
}

// Releases a COM pointer at scope exit.
template <typename T>
struct Com {
  T* p = nullptr;
  Com() = default;
  Com(const Com&) = delete;
  Com& operator=(const Com&) = delete;
  ~Com() {
    if (p) p->Release();
  }
  T** put() { return &p; }
  T* operator->() const { return p; }
};

IWICImagingFactory* factory() {
  static IWICImagingFactory* f = [] {
    IWICImagingFactory* made = nullptr;
    CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&made));
    return made;
  }();
  return f;
}

std::string hr(const char* what, HRESULT code) {
  char buf[96];
  std::snprintf(buf, sizeof(buf), "%s failed (0x%08lx)", what, static_cast<unsigned long>(code));
  return buf;
}

bool grab(const Rect& d, Image& out, Failure& fail) {
  HDC screen = GetDC(nullptr);
  if (!screen) {
    fail.message = "GetDC failed";
    return false;
  }
  HDC mem = CreateCompatibleDC(screen);
  BITMAPINFO bi{};
  bi.bmiHeader.biSize = sizeof(bi.bmiHeader);
  bi.bmiHeader.biWidth = d.w;
  bi.bmiHeader.biHeight = -d.h;  // top-down rows
  bi.bmiHeader.biPlanes = 1;
  bi.bmiHeader.biBitCount = 32;
  bi.bmiHeader.biCompression = BI_RGB;
  void* bits = nullptr;
  HBITMAP bmp = mem ? CreateDIBSection(mem, &bi, DIB_RGB_COLORS, &bits, nullptr, 0) : nullptr;
  bool ok = false;
  if (bmp && bits) {
    const HGDIOBJ old = SelectObject(mem, bmp);
    // CAPTUREBLT takes in other apps' layered windows too.
    ok = BitBlt(mem, 0, 0, d.w, d.h, screen, d.x, d.y, SRCCOPY | CAPTUREBLT) != 0;
    if (ok) {
      GdiFlush();
      out.w = d.w;
      out.h = d.h;
      const auto* src = static_cast<const uint8_t*>(bits);
      out.px.assign(src, src + static_cast<size_t>(d.w) * d.h * 4);
      for (size_t i = 3; i < out.px.size(); i += 4) out.px[i] = 255;  // GDI leaves alpha undefined
    }
    SelectObject(mem, old);
  }
  if (!ok) fail.message = "BitBlt of the display failed";
  if (bmp) DeleteObject(bmp);
  if (mem) DeleteDC(mem);
  ReleaseDC(nullptr, screen);
  return ok;
}

bool resize(const Image& in, int w, int h, Image& out) {
  IWICImagingFactory* f = factory();
  if (!f) return false;
  Com<IWICBitmap> src;
  Com<IWICBitmapScaler> scaler;
  const UINT stride = static_cast<UINT>(in.w) * 4;
  if (FAILED(f->CreateBitmapFromMemory(in.w, in.h, GUID_WICPixelFormat32bppBGRA, stride, stride * in.h,
                                       const_cast<BYTE*>(in.px.data()), src.put()))) {
    return false;
  }
  if (FAILED(f->CreateBitmapScaler(scaler.put()))) return false;
  if (FAILED(scaler->Initialize(src.p, w, h, WICBitmapInterpolationModeFant))) return false;
  out.w = w;
  out.h = h;
  out.px.assign(static_cast<size_t>(w) * h * 4, 0);
  return SUCCEEDED(scaler->CopyPixels(nullptr, static_cast<UINT>(w) * 4, static_cast<UINT>(out.px.size()), out.px.data()));
}

bool writeJpeg(const Image& img, int quality, const std::string& path, Failure& fail) {
  IWICImagingFactory* f = factory();
  if (!f) {
    fail.message = "WIC is unavailable";
    return false;
  }
  Com<IWICStream> stream;
  Com<IWICBitmapEncoder> encoder;
  Com<IWICBitmapFrameEncode> frame;
  Com<IPropertyBag2> props;
  HRESULT r = f->CreateStream(stream.put());
  if (SUCCEEDED(r)) r = stream->InitializeFromFilename(wide(path).c_str(), GENERIC_WRITE);
  if (SUCCEEDED(r)) r = f->CreateEncoder(GUID_ContainerFormatJpeg, nullptr, encoder.put());
  if (SUCCEEDED(r)) r = encoder->Initialize(stream.p, WICBitmapEncoderNoCache);
  if (SUCCEEDED(r)) r = encoder->CreateNewFrame(frame.put(), props.put());
  if (SUCCEEDED(r)) {
    PROPBAG2 opt{};
    opt.pstrName = const_cast<LPOLESTR>(L"ImageQuality");
    VARIANT v;
    VariantInit(&v);
    v.vt = VT_R4;
    v.fltVal = static_cast<float>(quality) / 100.0f;
    r = props->Write(1, &opt, &v);
  }
  if (SUCCEEDED(r)) r = frame->Initialize(props.p);
  if (SUCCEEDED(r)) r = frame->SetSize(img.w, img.h);
  // JPEG has no alpha: hand the encoder 24-bit BGR rows.
  WICPixelFormatGUID format = GUID_WICPixelFormat24bppBGR;
  if (SUCCEEDED(r)) r = frame->SetPixelFormat(&format);
  if (SUCCEEDED(r) && format != GUID_WICPixelFormat24bppBGR) r = E_FAIL;
  if (SUCCEEDED(r)) {
    const UINT stride = (static_cast<UINT>(img.w) * 3 + 3) & ~3u;
    std::vector<uint8_t> rows(static_cast<size_t>(stride) * img.h);
    for (int y = 0; y < img.h; ++y) {
      const uint8_t* s = &img.px[static_cast<size_t>(y) * img.w * 4];
      uint8_t* t = &rows[static_cast<size_t>(y) * stride];
      for (int x = 0; x < img.w; ++x, s += 4, t += 3) {
        t[0] = s[0];
        t[1] = s[1];
        t[2] = s[2];
      }
    }
    r = frame->WritePixels(img.h, stride, static_cast<UINT>(rows.size()), rows.data());
  }
  if (SUCCEEDED(r)) r = frame->Commit();
  if (SUCCEEDED(r)) r = encoder->Commit();
  if (FAILED(r)) fail.message = hr("writing the JPEG", r);
  return SUCCEEDED(r);
}

bool foreground(std::string& app, std::string& title, std::string& windowId, uint32_t& pid, Failure&) {
  app.clear();
  title.clear();
  windowId.clear();
  pid = 0;
  const HWND w = GetForegroundWindow();
  if (!w) return true;  // nothing in front (the desktop or a secure screen): all stay empty
  windowId = std::to_string(reinterpret_cast<uintptr_t>(w));
  wchar_t text[512];
  const int n = GetWindowTextW(w, text, 512);
  title = utf8(std::wstring(text, n > 0 ? static_cast<size_t>(n) : 0));
  DWORD owner = 0;
  GetWindowThreadProcessId(w, &owner);
  pid = static_cast<uint32_t>(owner);
  if (const HANDLE proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, owner)) {
    wchar_t image[MAX_PATH];
    DWORD size = MAX_PATH;
    if (QueryFullProcessImageNameW(proc, 0, image, &size)) {
      std::wstring name(image, size);
      const size_t slash = name.find_last_of(L"\\/");
      if (slash != std::wstring::npos) name = name.substr(slash + 1);
      if (name.size() > 4 && _wcsicmp(name.c_str() + name.size() - 4, L".exe") == 0) name.resize(name.size() - 4);
      app = utf8(name);
    }
    CloseHandle(proc);
  }
  return true;
}

// The window in front for the stale watch, polled twice a second: no message to the app, no UI Automation.
bool front(FrontWindow& out, Failure&) {
  out = FrontWindow();
  const HWND w = GetForegroundWindow();
  if (!w) return true;
  out.window = std::to_string(reinterpret_cast<uintptr_t>(w));
  wchar_t text[512];
  const int n = GetWindowTextW(w, text, 512);
  out.title = utf8(std::wstring(text, n > 0 ? static_cast<size_t>(n) : 0));
  // The frame the user sees, without the invisible resize border GetWindowRect adds on Windows 10 and 11.
  RECT r{};
  if (FAILED(DwmGetWindowAttribute(w, DWMWA_EXTENDED_FRAME_BOUNDS, &r, sizeof(r))) && !GetWindowRect(w, &r)) r = RECT{};
  out.box = Rect{static_cast<int>(r.left), static_cast<int>(r.top), static_cast<int>(r.right - r.left),
                 static_cast<int>(r.bottom - r.top)};
  DWORD pid = 0;
  GetWindowThreadProcessId(w, &pid);
  out.pid = static_cast<uint32_t>(pid);
  return true;
}

}  // namespace

// The text probes, in context_text_win.cpp.
bool nearbyControls(const std::vector<Point>& spots, int radius, std::vector<RawMark>& out, Failure& fail);
bool systemTextAt(const std::vector<Point>& spots, bool withAddress, SystemText& out, Failure& fail);
bool fileBehindWindow(std::string& path, std::string& address, std::string& how, Failure& fail);
bool elementBoxes(const std::vector<Point>& spots, std::vector<std::vector<Rect>>& out, Failure& fail);
// The form fields probe and the paste and setField calls, in context_write_win.cpp.
bool formFieldsAt(const std::vector<Point>& spots, std::vector<RawField>& out, Failure& fail);
void addWriting(ContextPlatform& p);

ContextPlatform nativePlatform() {
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
