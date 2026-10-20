// Windows text probes: OCR of the kept grab by Windows.Media.Ocr, named controls near the spots by UI Automation.
// Each runs on its own fresh thread (context.h), so each joins the MTA itself and never uninitializes: an abandoned
// thread may still be inside a call when the helper exits.
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <unknwn.h>
#include <UIAutomation.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <functional>
#include <string>
#include <string_view>
#include <vector>

// The SDK's C++/WinRT headers do not build clean under /W4 /WX; our own code keeps both.
#pragma warning(push, 0)
#include <winrt/base.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Graphics.Imaging.h>
#include <winrt/Windows.Media.Ocr.h>
#include <winrt/Windows.Storage.Streams.h>
#pragma warning(pop)

#include "context.h"

namespace lp::ctx {
namespace {

using winrt::Windows::Graphics::Imaging::BitmapAlphaMode;
using winrt::Windows::Graphics::Imaging::BitmapPixelFormat;
using winrt::Windows::Graphics::Imaging::SoftwareBitmap;
using winrt::Windows::Media::Ocr::OcrEngine;

constexpr size_t kMaxControls = 400;

std::string failed(const char* what, HRESULT code) {
  char buf[96];
  std::snprintf(buf, sizeof(buf), "%s failed (0x%08lx)", what, static_cast<unsigned long>(code));
  return buf;
}

char32_t firstChar(std::wstring_view s) {
  if (s.empty()) return 0;
  if (s.size() >= 2 && IS_HIGH_SURROGATE(s[0]) && IS_LOW_SURROGATE(s[1])) {
    return 0x10000 + ((static_cast<char32_t>(s[0]) - 0xD800) << 10) + (static_cast<char32_t>(s[1]) - 0xDC00);
  }
  return s[0];
}

char32_t lastChar(std::wstring_view s) {
  if (s.empty()) return 0;
  const size_t n = s.size();
  if (n >= 2 && IS_HIGH_SURROGATE(s[n - 2]) && IS_LOW_SURROGATE(s[n - 1])) {
    return 0x10000 + ((static_cast<char32_t>(s[n - 2]) - 0xD800) << 10) + (static_cast<char32_t>(s[n - 1]) - 0xDC00);
  }
  return s[n - 1];
}

// Han, Hiragana, Katakana and Hangul: OCR splits these into words of a character or so, with no space between them.
bool isCjk(char32_t c) {
  return (c >= 0x1100 && c <= 0x11FF) ||    // Hangul Jamo
         (c >= 0x3040 && c <= 0x30FF) ||    // Hiragana, Katakana
         (c >= 0x3130 && c <= 0x318F) ||    // Hangul compatibility Jamo
         (c >= 0x31F0 && c <= 0x31FF) ||    // Katakana phonetic extensions
         (c >= 0x3400 && c <= 0x4DBF) ||    // Han extension A
         (c >= 0x4E00 && c <= 0x9FFF) ||    // Han
         (c >= 0xAC00 && c <= 0xD7AF) ||    // Hangul syllables
         (c >= 0xF900 && c <= 0xFAFF) ||    // Han compatibility
         (c >= 0xFF66 && c <= 0xFF9F) ||    // half-width Katakana
         (c >= 0x20000 && c <= 0x3FFFF);    // Han extensions B and later
}

// Adds an OCR word to its line: a space between words, none between two CJK characters.
void appendWord(std::wstring& line, std::wstring_view word) {
  if (word.empty()) return;
  if (!line.empty() && !(isCjk(lastChar(line)) && isCjk(firstChar(word)))) line += L' ';
  line += word;
}

// Distance from `p` to the nearest point of `r`, squared; 0 inside. Same measure as selectMarks in marks.ts.
double distanceSq(const Point& p, const RECT& r) {
  const double dx = std::max({static_cast<double>(r.left) - p.x, 0.0, static_cast<double>(p.x) - r.right});
  const double dy = std::max({static_cast<double>(r.top) - p.y, 0.0, static_cast<double>(p.y) - r.bottom});
  return dx * dx + dy * dy;
}

// The mark kind for a UIA control type, or nullptr to leave it out.
const char* kindOf(CONTROLTYPEID type) {
  switch (type) {
    case UIA_ButtonControlTypeId:
    case UIA_SplitButtonControlTypeId: return "button";
    case UIA_HyperlinkControlTypeId: return "link";
    case UIA_EditControlTypeId:
    case UIA_ComboBoxControlTypeId: return "field";
    case UIA_MenuItemControlTypeId:
    case UIA_MenuBarControlTypeId: return "menu";
    case UIA_TabItemControlTypeId: return "tab";
    case UIA_CheckBoxControlTypeId:
    case UIA_RadioButtonControlTypeId: return "check";
    case UIA_ListItemControlTypeId:
    case UIA_TreeItemControlTypeId:
    case UIA_DataItemControlTypeId: return "item";
    // Text repeats what OCR reads; the others are containers whose names say little about a place.
    case UIA_TextControlTypeId:
    case UIA_PaneControlTypeId:
    case UIA_GroupControlTypeId:
    case UIA_DocumentControlTypeId:
    case UIA_WindowControlTypeId: return nullptr;
    default: return "other";
  }
}

std::wstring trimmed(const wchar_t* s, UINT n) {
  std::wstring_view v(s, n);
  const size_t a = v.find_first_not_of(L" \t\r\n ");
  if (a == std::wstring_view::npos) return std::wstring();
  const size_t b = v.find_last_not_of(L" \t\r\n ");
  return std::wstring(v.substr(a, b - a + 1));
}

// Reads the cached kind, name and box of one element into `out`; false when it is not worth a mark.
bool readControl(IUIAutomationElement* el, RawMark& out, RECT& box) {
  CONTROLTYPEID type = 0;
  if (FAILED(el->get_CachedControlType(&type))) return false;
  const char* kind = kindOf(type);
  if (!kind) return false;
  if (FAILED(el->get_CachedBoundingRectangle(&box)) || box.right <= box.left || box.bottom <= box.top) return false;
  BSTR name = nullptr;
  if (FAILED(el->get_CachedName(&name)) || !name) return false;
  const std::wstring text = trimmed(name, SysStringLen(name));
  SysFreeString(name);
  if (text.empty()) return false;
  out.kind = kind;
  out.box = Rect{box.left, box.top, box.right - box.left, box.bottom - box.top};
  out.text = winrt::to_string(text);
  return true;
}

// The top-level window that the element at `p` belongs to, or nullptr. Walks up to the first element with a window
// handle, then takes that window's root.
HWND topWindowAt(IUIAutomation* uia, IUIAutomationTreeWalker* walker, IUIAutomationCacheRequest* hwndReq, Point p) {
  winrt::com_ptr<IUIAutomationElement> el;
  if (FAILED(uia->ElementFromPointBuildCache(POINT{p.x, p.y}, hwndReq, el.put())) || !el) return nullptr;
  for (int depth = 0; el && depth < 64; ++depth) {
    UIA_HWND handle = nullptr;
    if (SUCCEEDED(el->get_CachedNativeWindowHandle(&handle)) && handle) {
      const HWND root = GetAncestor(static_cast<HWND>(handle), GA_ROOT);
      // The desktop's own element would mean a FindAll over every window.
      return root == GetDesktopWindow() ? nullptr : root;
    }
    winrt::com_ptr<IUIAutomationElement> parent;
    if (FAILED(walker->GetParentElementBuildCache(el.get(), hwndReq, parent.put()))) return nullptr;
    el = parent;
  }
  return nullptr;
}

}  // namespace

bool ocrLines(const Image& img, const Rect& area, const std::function<bool(const Image&, int, int, Image&)>& resize,
              std::vector<RawMark>& out, Failure& fail) {
  try {
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    const OcrEngine engine = OcrEngine::TryCreateFromUserProfileLanguages();
    if (!engine) {
      fail.message = "no OCR language";
      return false;
    }
    Image crop;
    crop.w = area.w;
    crop.h = area.h;
    crop.px.resize(static_cast<size_t>(area.w) * area.h * 4);
    for (int y = 0; y < area.h; ++y) {
      const uint8_t* row = &img.px[(static_cast<size_t>(area.y + y) * img.w + area.x) * 4];
      std::memcpy(&crop.px[static_cast<size_t>(y) * area.w * 4], row, static_cast<size_t>(area.w) * 4);
    }
    // OCR refuses images over its limit: read a scaled-down copy and scale the boxes back.
    const double maxSide = static_cast<double>(OcrEngine::MaxImageDimension());
    const double scale = std::min({1.0, maxSide / area.w, maxSide / area.h});
    if (scale < 1.0) {
      Image smaller;
      const int w = std::max(1, static_cast<int>(area.w * scale));
      const int h = std::max(1, static_cast<int>(area.h * scale));
      if (!resize(crop, w, h, smaller)) {
        fail.message = "could not scale the area for OCR";
        return false;
      }
      crop = std::move(smaller);
    }
    const uint32_t bytes = static_cast<uint32_t>(crop.px.size());
    winrt::Windows::Storage::Streams::Buffer buffer(bytes);
    std::memcpy(buffer.data(), crop.px.data(), bytes);
    buffer.Length(bytes);
    const SoftwareBitmap bitmap = SoftwareBitmap::CreateCopyFromBuffer(buffer, BitmapPixelFormat::Bgra8, crop.w, crop.h,
                                                                       BitmapAlphaMode::Premultiplied);
    const double sx = static_cast<double>(area.w) / crop.w, sy = static_cast<double>(area.h) / crop.h;
    for (const auto& line : engine.RecognizeAsync(bitmap).get().Lines()) {
      std::wstring text;
      float x0 = 0, y0 = 0, x1 = 0, y1 = 0;
      bool any = false;
      for (const auto& word : line.Words()) {
        appendWord(text, word.Text());
        const auto r = word.BoundingRect();
        x0 = any ? std::min(x0, r.X) : r.X;
        y0 = any ? std::min(y0, r.Y) : r.Y;
        x1 = any ? std::max(x1, r.X + r.Width) : r.X + r.Width;
        y1 = any ? std::max(y1, r.Y + r.Height) : r.Y + r.Height;
        any = true;
      }
      if (!any || text.empty()) continue;
      const int left = area.x + static_cast<int>(std::floor(x0 * sx));
      const int top = area.y + static_cast<int>(std::floor(y0 * sy));
      const int right = area.x + static_cast<int>(std::ceil(x1 * sx));
      const int bottom = area.y + static_cast<int>(std::ceil(y1 * sy));
      out.push_back(RawMark{"text", Rect{left, top, std::max(1, right - left), std::max(1, bottom - top)},
                            winrt::to_string(text)});
    }
    return true;
  } catch (const winrt::hresult_error& e) {
    fail.message = failed("OCR", e.code());
    return false;
  }
}

bool nearbyControls(const std::vector<Point>& spots, int radius, std::vector<RawMark>& out, Failure& fail) {
  try {
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    const auto uia = winrt::create_instance<IUIAutomation>(CLSID_CUIAutomation);
    winrt::com_ptr<IUIAutomationTreeWalker> walker;
    winrt::check_hresult(uia->get_RawViewWalker(walker.put()));
    winrt::com_ptr<IUIAutomationCacheRequest> hwndReq, controlReq;
    winrt::check_hresult(uia->CreateCacheRequest(hwndReq.put()));
    winrt::check_hresult(hwndReq->AddProperty(UIA_NativeWindowHandlePropertyId));
    winrt::check_hresult(uia->CreateCacheRequest(controlReq.put()));
    for (const PROPERTYID id : {UIA_ControlTypePropertyId, UIA_NamePropertyId, UIA_BoundingRectanglePropertyId,
                                UIA_IsOffscreenPropertyId}) {
      winrt::check_hresult(controlReq->AddProperty(id));
    }
    winrt::com_ptr<IUIAutomationCondition> isControl, notOffscreen, condition;
    winrt::check_hresult(uia->get_ControlViewCondition(isControl.put()));
    VARIANT no;
    VariantInit(&no);
    no.vt = VT_BOOL;
    no.boolVal = VARIANT_FALSE;
    winrt::check_hresult(uia->CreatePropertyCondition(UIA_IsOffscreenPropertyId, no, notOffscreen.put()));
    winrt::check_hresult(uia->CreateAndCondition(isControl.get(), notOffscreen.get(), condition.put()));

    const double r2 = static_cast<double>(radius) * radius;
    std::vector<HWND> seen;
    for (const Point& spot : spots) {
      if (out.size() >= kMaxControls) break;
      const HWND top = topWindowAt(uia.get(), walker.get(), hwndReq.get(), spot);
      if (!top || std::find(seen.begin(), seen.end(), top) != seen.end()) continue;
      seen.push_back(top);
      winrt::com_ptr<IUIAutomationElement> window;
      winrt::com_ptr<IUIAutomationElementArray> found;
      if (FAILED(uia->ElementFromHandle(top, window.put())) || !window) continue;
      if (FAILED(window->FindAllBuildCache(TreeScope_Descendants, condition.get(), controlReq.get(), found.put())) ||
          !found) {
        continue;
      }
      int count = 0;
      found->get_Length(&count);
      for (int i = 0; i < count && out.size() < kMaxControls; ++i) {
        winrt::com_ptr<IUIAutomationElement> el;
        if (FAILED(found->GetElement(i, el.put())) || !el) continue;
        RawMark mark;
        RECT box{};
        if (!readControl(el.get(), mark, box)) continue;
        if (std::any_of(spots.begin(), spots.end(), [&](const Point& p) { return distanceSq(p, box) <= r2; })) {
          out.push_back(std::move(mark));
        }
      }
    }
    return true;
  } catch (const winrt::hresult_error& e) {
    fail.message = failed("UI Automation", e.code());
    return false;
  }
}

}  // namespace lp::ctx
