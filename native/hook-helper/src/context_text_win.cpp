// Windows text probes: named controls and text near the spots by UI Automation, the boxes around the element under each spot, the system's own text (selection, focus, text under the spots, browser address) and the file behind the window.
// Each runs on its own fresh thread (context.h), so each joins the MTA itself and never uninitializes: an abandoned
// thread may still be inside a call when the helper exits.
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <unknwn.h>
#include <UIAutomation.h>
#include <oleauto.h>
#include <shellapi.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <tlhelp32.h>
#include <winternl.h>

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <deque>
#include <functional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

// The SDK's C++/WinRT headers do not build clean under /W4 /WX; our own code keeps both.
#pragma warning(push, 0)
#include <winrt/base.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#pragma warning(pop)

#include "context.h"

namespace lp::ctx {
namespace {

constexpr size_t kMaxControls = 400;
// The controls walk stops here with what it has, short of the 1 s probe budget, so a big page still gives marks.
constexpr std::chrono::milliseconds kWalkBudget{800};
using Clock = std::chrono::steady_clock;

std::string failed(const char* what, HRESULT code) {
  char buf[96];
  std::snprintf(buf, sizeof(buf), "%s failed (0x%08lx)", what, static_cast<unsigned long>(code));
  return buf;
}

// lolPing's main process started this helper and owns lolPing's windows.
DWORD lolPingPid() {
  static const DWORD pid = [] {
    DWORD parent = 0;
    const HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE_VALUE) return parent;
    PROCESSENTRY32W entry{};
    entry.dwSize = sizeof(entry);
    for (BOOL more = Process32FirstW(snap, &entry); more; more = Process32NextW(snap, &entry)) {
      if (entry.th32ProcessID == GetCurrentProcessId()) {
        parent = entry.th32ParentProcessID;
        break;
      }
    }
    CloseHandle(snap);
    return parent;
  }();
  return pid;
}

bool isLolPing(DWORD pid) { return pid != 0 && pid == lolPingPid(); }

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
    case UIA_TextControlTypeId: return "text";
    // Containers, whose names say little about a place.
    case UIA_PaneControlTypeId:
    case UIA_GroupControlTypeId:
    case UIA_DocumentControlTypeId:
    case UIA_WindowControlTypeId: return nullptr;
    default: return "other";
  }
}

std::wstring trimmed(const wchar_t* s, UINT n) {
  std::wstring_view v(s, n);
  const size_t a = v.find_first_not_of(L" \t\r\n\u00a0");
  if (a == std::wstring_view::npos) return std::wstring();
  const size_t b = v.find_last_not_of(L" \t\r\n\u00a0");
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

bool isLolPingProcess(unsigned long pid) { return isLolPing(static_cast<DWORD>(pid)); }

bool nearbyControls(const std::vector<Point>& spots, int radius, std::vector<RawMark>& out, Failure& fail) {
  const Clock::time_point deadline = Clock::now() + kWalkBudget;
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
                                UIA_IsControlElementPropertyId}) {
      winrt::check_hresult(controlReq->AddProperty(id));
    }
    winrt::com_ptr<IUIAutomationCondition> notOffscreen;
    VARIANT no;
    VariantInit(&no);
    no.vt = VT_BOOL;
    no.boolVal = VARIANT_FALSE;
    winrt::check_hresult(uia->CreatePropertyCondition(UIA_IsOffscreenPropertyId, no, notOffscreen.put()));

    const double r2 = static_cast<double>(radius) * radius;
    const auto nearSpot = [&](const RECT& box) {
      return std::any_of(spots.begin(), spots.end(), [&](const Point& p) { return distanceSq(p, box) <= r2; });
    };
    std::vector<HWND> seen;
    for (const Point& spot : spots) {
      if (out.size() >= kMaxControls || Clock::now() >= deadline) break;
      const HWND top = topWindowAt(uia.get(), walker.get(), hwndReq.get(), spot);
      if (!top || std::find(seen.begin(), seen.end(), top) != seen.end()) continue;
      seen.push_back(top);
      DWORD pid = 0;
      GetWindowThreadProcessId(top, &pid);
      if (isLolPing(pid)) continue;  // lolPing's own overlay is never a mark
      winrt::com_ptr<IUIAutomationElement> window;
      if (FAILED(uia->ElementFromHandle(top, window.put())) || !window) continue;
      // Breadth first, one call per element for its on-screen children, so the walk can stop at the deadline with
      // what it found. The raw view, as a control can sit under a container that is not one. A branch out of every
      // spot's radius is skipped: a child lies inside its parent.
      std::deque<winrt::com_ptr<IUIAutomationElement>> queue{window};
      while (!queue.empty() && out.size() < kMaxControls && Clock::now() < deadline) {
        const winrt::com_ptr<IUIAutomationElement> parent = queue.front();
        queue.pop_front();
        winrt::com_ptr<IUIAutomationElementArray> children;
        if (FAILED(parent->FindAllBuildCache(TreeScope_Children, notOffscreen.get(), controlReq.get(),
                                             children.put())) ||
            !children) {
          continue;
        }
        int count = 0;
        children->get_Length(&count);
        for (int i = 0; i < count && out.size() < kMaxControls; ++i) {
          winrt::com_ptr<IUIAutomationElement> el;
          RECT box{};
          if (FAILED(children->GetElement(i, el.put())) || !el || FAILED(el->get_CachedBoundingRectangle(&box))) {
            continue;
          }
          const bool sized = box.right > box.left && box.bottom > box.top;
          // A zero-size wrapper can still hold sized children, so only a sized branch far away is skipped.
          if (sized && !nearSpot(box)) continue;
          queue.push_back(el);
          BOOL control = FALSE;
          RawMark mark;
          if (SUCCEEDED(el->get_CachedIsControlElement(&control)) && control && readControl(el.get(), mark, box)) {
            out.push_back(std::move(mark));
          }
        }
      }
    }
    return true;
  } catch (const winrt::hresult_error& e) {
    fail.message = failed("UI Automation", e.code());
    return false;
  }
}

namespace {

constexpr size_t kMaxAddressEdits = 40;  // the address bar comes first in a browser's tree

// Releases a BSTR at scope exit.
struct Bstr {
  BSTR s = nullptr;
  Bstr() = default;
  Bstr(const Bstr&) = delete;
  Bstr& operator=(const Bstr&) = delete;
  ~Bstr() { SysFreeString(s); }
  std::wstring text() const { return s ? std::wstring(s, SysStringLen(s)) : std::wstring(); }
};

// Clears a VARIANT at scope exit.
struct Variant {
  VARIANT v;
  Variant() { VariantInit(&v); }
  Variant(const Variant&) = delete;
  Variant& operator=(const Variant&) = delete;
  ~Variant() { VariantClear(&v); }
};

std::wstring wide(const std::string& s) { return std::wstring(winrt::to_hstring(s)); }

struct WindowProcess {
  DWORD pid = 0;
  std::wstring exe;  // lower case, without ".exe"
};

WindowProcess processOf(HWND w) {
  WindowProcess out;
  GetWindowThreadProcessId(w, &out.pid);
  const HANDLE proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, out.pid);
  if (!proc) return out;
  wchar_t image[MAX_PATH];
  DWORD size = MAX_PATH;
  if (QueryFullProcessImageNameW(proc, 0, image, &size)) {
    std::wstring name(image, size);
    name = name.substr(name.find_last_of(L"\\/") + 1);
    if (name.size() > 4 && _wcsicmp(name.c_str() + name.size() - 4, L".exe") == 0) name.resize(name.size() - 4);
    CharLowerBuffW(name.data(), static_cast<DWORD>(name.size()));
    out.exe = name;
  }
  CloseHandle(proc);
  return out;
}

bool isBrowser(const std::wstring& exe) {
  return exe == L"chrome" || exe == L"msedge" || exe == L"brave" || exe == L"firefox";
}

bool isFile(const std::wstring& path) {
  const DWORD attrs = GetFileAttributesW(path.c_str());
  return attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_DIRECTORY) == 0;
}

// A lookup's hit: the name must equal the title's before the disk is touched, as a stale network path can block.
bool isNamedFile(const std::wstring& path, const std::wstring& name) {
  const std::wstring_view file = std::wstring_view(path).substr(path.find_last_of(L"\\/") + 1);
  return CompareStringOrdinal(file.data(), static_cast<int>(file.size()), name.data(), static_cast<int>(name.size()),
                              TRUE) == CSTR_EQUAL &&
         isFile(path);
}

std::string textOf(const std::wstring& s, size_t maxChars) { return cutText(winrt::to_string(s), maxChars); }

// A range's text: at most `maxChars` characters (twice as many UTF-16 units asked, for surrogate pairs).
std::string rangeText(IUIAutomationTextRange* range, size_t maxChars) {
  Bstr text;
  if (FAILED(range->GetText(static_cast<int>(maxChars * 2), &text.s))) return "";
  return textOf(text.text(), maxChars);
}

std::string valuePatternText(IUIAutomationElement* el, size_t maxChars) {
  winrt::com_ptr<IUIAutomationValuePattern> value;
  if (FAILED(el->GetCurrentPatternAs(UIA_ValuePatternId, IID_PPV_ARGS(value.put()))) || !value) return "";
  Bstr text;
  if (FAILED(value->get_CurrentValue(&text.s))) return "";
  return textOf(text.text(), maxChars);
}

winrt::com_ptr<IUIAutomationTextPattern> textPatternOf(IUIAutomationElement* el) {
  winrt::com_ptr<IUIAutomationTextPattern> text;
  if (FAILED(el->GetCurrentPatternAs(UIA_TextPatternId, IID_PPV_ARGS(text.put())))) return nullptr;
  return text;
}

std::string nameOf(IUIAutomationElement* el) {
  Bstr name;
  if (FAILED(el->get_CurrentName(&name.s)) || !name.s) return "";
  return winrt::to_string(trimmed(name.s, SysStringLen(name.s)));
}

constexpr int kPasswordParents = 3;  // how far up a password field's inner nodes are looked for

// Whether the element is safe to read: it answers, is not lolPing's, and is not in a password field. Chromium's
// password field holds a text node of bullets that is not marked as a password itself, so the parents are asked too.
bool readable(IUIAutomation* uia, IUIAutomationElement* el, bool& secure) {
  int pid = 0;
  if (FAILED(el->get_CurrentProcessId(&pid)) || isLolPing(static_cast<DWORD>(pid))) return false;
  winrt::com_ptr<IUIAutomationTreeWalker> walker;
  if (FAILED(uia->get_RawViewWalker(walker.put())) || !walker) return false;
  winrt::com_ptr<IUIAutomationElement> node;
  node.copy_from(el);
  for (int depth = 0; node && depth <= kPasswordParents; ++depth) {
    BOOL password = FALSE;
    if (FAILED(node->get_CurrentIsPassword(&password))) return false;
    if (password) {
      secure = true;
      return false;
    }
    winrt::com_ptr<IUIAutomationElement> parent;
    if (FAILED(walker->GetParentElement(node.get(), parent.put()))) break;
    node = parent;
  }
  return true;
}

constexpr int kTextOwnerParents = 16;  // how far up the element holding a range's text pattern is looked for

// The text pattern of `el` or its nearest parent that has one: in Chromium a paragraph's own pattern cannot make a
// range for a field outside it, the document's can.
winrt::com_ptr<IUIAutomationTextPattern> textOwnerOf(IUIAutomation* uia, IUIAutomationElement* el) {
  winrt::com_ptr<IUIAutomationTreeWalker> walker;
  if (FAILED(uia->get_RawViewWalker(walker.put())) || !walker) return nullptr;
  winrt::com_ptr<IUIAutomationElement> node;
  node.copy_from(el);
  for (int depth = 0; node && depth <= kTextOwnerParents; ++depth) {
    if (auto text = textPatternOf(node.get())) return text;
    winrt::com_ptr<IUIAutomationElement> parent;
    if (FAILED(walker->GetParentElement(node.get(), parent.put()))) return nullptr;
    node = parent;
  }
  return nullptr;
}

// Whether a text range is in or overlaps a password field: Chromium's document text shows a field's bullets, which
// give away the password's length. Anything that cannot be checked counts as touching one.
bool touchesPassword(IUIAutomation* uia, IUIAutomationTextRange* range) {
  winrt::com_ptr<IUIAutomationElement> enclosing;
  bool secure = false;
  if (FAILED(range->GetEnclosingElement(enclosing.put())) || !enclosing || !readable(uia, enclosing.get(), secure)) {
    return true;
  }
  VARIANT yes;
  VariantInit(&yes);
  yes.vt = VT_BOOL;
  yes.boolVal = VARIANT_TRUE;
  winrt::com_ptr<IUIAutomationCondition> isPassword;
  winrt::com_ptr<IUIAutomationElementArray> fields;
  if (FAILED(uia->CreatePropertyCondition(UIA_IsPasswordPropertyId, yes, isPassword.put())) ||
      FAILED(enclosing->FindAll(TreeScope_Descendants, isPassword.get(), fields.put())) || !fields) {
    return true;
  }
  int count = 0;
  if (FAILED(fields->get_Length(&count))) return true;
  if (count == 0) return false;
  const auto owner = textOwnerOf(uia, enclosing.get());
  if (!owner) return true;
  for (int i = 0; i < count; ++i) {
    winrt::com_ptr<IUIAutomationElement> field;
    winrt::com_ptr<IUIAutomationTextRange> fieldRange;
    int startVsEnd = 0, endVsStart = 0;
    if (FAILED(fields->GetElement(i, field.put())) || !field ||
        FAILED(owner->RangeFromChild(field.get(), fieldRange.put())) || !fieldRange ||
        FAILED(range->CompareEndpoints(TextPatternRangeEndpoint_Start, fieldRange.get(), TextPatternRangeEndpoint_End,
                                       &startVsEnd)) ||
        FAILED(range->CompareEndpoints(TextPatternRangeEndpoint_End, fieldRange.get(), TextPatternRangeEndpoint_Start,
                                       &endVsStart))) {
      return true;
    }
    if (startVsEnd < 0 && endVsStart > 0) return true;  // the two ranges overlap
  }
  return false;
}

// The paragraph under the spot when the element has text, else its name and value. A field named like a card number
// or a password gives only its name, as its value never leaves the helper.
std::string spotText(IUIAutomation* uia, Point p) {
  winrt::com_ptr<IUIAutomationElement> el;
  if (FAILED(uia->ElementFromPoint(POINT{p.x, p.y}, el.put())) || !el) return "";
  bool secure = false;
  if (!readable(uia, el.get(), secure)) return "";
  const std::string name = nameOf(el.get());
  CONTROLTYPEID type = 0;
  el->get_CurrentControlType(&type);
  const char* kind = kindOf(type);
  if (kind && std::string(kind) == "field" && neverFillLabel(name)) return cutText(name, kSpotTextMax);
  if (const auto text = textPatternOf(el.get())) {
    winrt::com_ptr<IUIAutomationTextRange> range;
    if (SUCCEEDED(text->RangeFromPoint(POINT{p.x, p.y}, range.put())) && range &&
        SUCCEEDED(range->ExpandToEnclosingUnit(TextUnit_Paragraph))) {
      if (touchesPassword(uia, range.get())) return "";
      const std::string paragraph = rangeText(range.get(), kSpotTextMax);
      if (paragraph.find_first_not_of(" \t\r\n") != std::string::npos) return paragraph;
    }
  }
  const std::string value = valuePatternText(el.get(), kSpotTextMax);
  if (value.empty() || value == name) return cutText(name, kSpotTextMax);
  return cutText(name.empty() ? value : name + "\n" + value, kSpotTextMax);
}

// The selected text, ranges joined by line breaks; ranges in or over a password field are left out.
std::string selectionOf(IUIAutomation* uia, IUIAutomationTextPattern* text) {
  std::string out;
  winrt::com_ptr<IUIAutomationTextRangeArray> ranges;
  if (FAILED(text->GetSelection(ranges.put())) || !ranges) return out;
  int count = 0;
  ranges->get_Length(&count);
  for (int i = 0; i < count && out.size() < kSelectionMax * 4; ++i) {
    winrt::com_ptr<IUIAutomationTextRange> range;
    if (FAILED(ranges->GetElement(i, range.put())) || !range || touchesPassword(uia, range.get())) continue;
    const std::string part = rangeText(range.get(), kSelectionMax);
    if (part.empty()) continue;
    out += (out.empty() ? "" : "\n") + part;
  }
  return cutText(out, kSelectionMax);
}

// The focused element's kind, label, value and selection; nothing when it is lolPing's own.
void readFocus(IUIAutomation* uia, SystemText& out) {
  winrt::com_ptr<IUIAutomationElement> el;
  if (FAILED(uia->GetFocusedElement(el.put())) || !el) return;
  bool secure = false;
  const bool open = readable(uia, el.get(), secure);
  if (!open && !secure) return;
  CONTROLTYPEID type = 0;
  el->get_CurrentControlType(&type);
  const char* kind = kindOf(type);
  out.focusKind = kind ? kind : "other";
  out.focusLabel = cutText(nameOf(el.get()), kFocusValueMax);
  if (out.focusLabel.empty()) {
    winrt::com_ptr<IUIAutomationElement> label;
    if (SUCCEEDED(el->get_CurrentLabeledBy(label.put())) && label) {
      out.focusLabel = cutText(nameOf(label.get()), kFocusValueMax);
    }
  }
  out.focusSecure = secure;
  if (secure) return;  // never read: no value, no selection
  out.focusValue = valuePatternText(el.get(), kFocusValueMax);
  const auto text = textPatternOf(el.get());
  if (!text) return;
  if (out.focusValue.empty()) {
    winrt::com_ptr<IUIAutomationTextRange> document;
    if (SUCCEEDED(text->get_DocumentRange(document.put())) && document &&
        !touchesPassword(uia, document.get())) {
      out.focusValue = rangeText(document.get(), kFocusValueMax);
    }
  }
  out.selection = selectionOf(uia, text.get());
}

// The first edit in the browser window whose value reads as an address; password fields are never read.
bool addressBar(IUIAutomation* uia, HWND window, std::string& path, std::string& address) {
  winrt::com_ptr<IUIAutomationElement> root;
  if (FAILED(uia->ElementFromHandle(window, root.put())) || !root) return false;
  VARIANT edit;
  VariantInit(&edit);
  edit.vt = VT_I4;
  edit.lVal = UIA_EditControlTypeId;
  VARIANT no;
  VariantInit(&no);
  no.vt = VT_BOOL;
  no.boolVal = VARIANT_FALSE;
  winrt::com_ptr<IUIAutomationCondition> isEdit, notPassword, condition;
  winrt::com_ptr<IUIAutomationCacheRequest> cache;
  winrt::com_ptr<IUIAutomationElementArray> found;
  if (FAILED(uia->CreatePropertyCondition(UIA_ControlTypePropertyId, edit, isEdit.put())) ||
      FAILED(uia->CreatePropertyCondition(UIA_IsPasswordPropertyId, no, notPassword.put())) ||
      FAILED(uia->CreateAndCondition(isEdit.get(), notPassword.get(), condition.put())) ||
      FAILED(uia->CreateCacheRequest(cache.put())) || FAILED(cache->AddProperty(UIA_ValueValuePropertyId)) ||
      FAILED(cache->put_AutomationElementMode(AutomationElementMode_None)) ||
      FAILED(root->FindAllBuildCache(TreeScope_Descendants, condition.get(), cache.get(), found.put())) || !found) {
    return false;
  }
  int count = 0;
  found->get_Length(&count);
  for (int i = 0; i < count && static_cast<size_t>(i) < kMaxAddressEdits; ++i) {
    winrt::com_ptr<IUIAutomationElement> el;
    Variant value;
    if (FAILED(found->GetElement(i, el.put())) || !el) continue;
    if (FAILED(el->GetCachedPropertyValue(UIA_ValueValuePropertyId, &value.v)) || value.v.vt != VT_BSTR) continue;
    const std::string text = winrt::to_string(std::wstring_view(value.v.bstrVal, SysStringLen(value.v.bstrVal)));
    if (browserAddress(text, path, address)) {
      address = cutText(address, kAddressMax);
      return true;
    }
  }
  return false;
}

HRESULT getProperty(IDispatch* object, const wchar_t* name, VARIANT& out) {
  DISPID id = 0;
  LPOLESTR names[] = {const_cast<LPOLESTR>(name)};
  const HRESULT r = object->GetIDsOfNames(IID_NULL, names, 1, LOCALE_USER_DEFAULT, &id);
  if (FAILED(r)) return r;
  DISPPARAMS none{};
  return object->Invoke(id, IID_NULL, LOCALE_USER_DEFAULT, DISPATCH_PROPERTYGET, &none, &out, nullptr, nullptr);
}

struct OfficeApp {
  const wchar_t* exe;
  const wchar_t* progId;
  const wchar_t* active;  // the property holding the document in front
};

constexpr OfficeApp kOfficeApps[] = {{L"winword", L"Word.Application", L"ActiveDocument"},
                                     {L"powerpnt", L"PowerPoint.Application", L"ActivePresentation"},
                                     {L"excel", L"Excel.Application", L"ActiveWorkbook"}};

const OfficeApp* officeApp(const std::wstring& exe) {
  for (const OfficeApp& app : kOfficeApps) {
    if (exe == app.exe) return &app;
  }
  return nullptr;
}

// The document in front of a running Office app, by its FullName; false for an unsaved or online document.
bool officeDocument(const OfficeApp& office, std::wstring& path) {
  CLSID clsid;
  winrt::com_ptr<IUnknown> running;
  if (FAILED(CLSIDFromProgID(office.progId, &clsid)) || FAILED(GetActiveObject(clsid, nullptr, running.put())) ||
      !running) {
    return false;
  }
  const auto app = running.try_as<IDispatch>();
  Variant document, fullName;
  if (!app || FAILED(getProperty(app.get(), office.active, document.v)) || document.v.vt != VT_DISPATCH ||
      !document.v.pdispVal || FAILED(getProperty(document.v.pdispVal, L"FullName", fullName.v)) ||
      fullName.v.vt != VT_BSTR) {
    return false;
  }
  const std::wstring name(fullName.v.bstrVal, SysStringLen(fullName.v.bstrVal));
  if (!isFile(name)) return false;
  path = name;
  return true;
}

std::wstring commandLineOf(DWORD pid) {
  using QueryFn = LONG(NTAPI*)(HANDLE, ULONG, PVOID, ULONG, PULONG);
  constexpr ULONG kProcessCommandLineInformation = 60;
  static const auto query =
      reinterpret_cast<QueryFn>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryInformationProcess"));
  if (!query) return L"";
  const HANDLE proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!proc) return L"";
  // A UNICODE_STRING header followed by the text, which is at most 32,767 characters.
  std::vector<uint64_t> buf(70000 / sizeof(uint64_t));
  ULONG length = 0;
  std::wstring out;
  if (query(proc, kProcessCommandLineInformation, buf.data(), static_cast<ULONG>(buf.size() * sizeof(uint64_t)),
            &length) >= 0) {
    const auto* text = reinterpret_cast<const UNICODE_STRING*>(buf.data());
    if (text->Buffer) out.assign(text->Buffer, text->Length / sizeof(wchar_t));
  }
  CloseHandle(proc);
  return out;
}

bool fromCommandLine(DWORD pid, const std::wstring& name, std::wstring& out) {
  const std::wstring line = commandLineOf(pid);
  if (line.empty()) return false;
  int argc = 0;
  wchar_t** argv = CommandLineToArgvW(line.c_str(), &argc);
  if (!argv) return false;
  bool found = false;
  // Only absolute paths: a relative one is relative to that process's folder, not this one's.
  for (int i = 1; i < argc && !found; ++i) {
    const std::wstring arg = argv[i];
    const bool absolute = (arg.size() >= 3 && arg[1] == L':' && arg[2] == L'\\') || arg.rfind(L"\\\\", 0) == 0;
    if (absolute && isNamedFile(arg, name)) {
      out = arg;
      found = true;
    }
  }
  LocalFree(argv);
  return found;
}

std::wstring linkTarget(const std::wstring& lnk) {
  winrt::com_ptr<IShellLinkW> link;
  if (FAILED(CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(link.put())))) return L"";
  const auto file = link.try_as<IPersistFile>();
  wchar_t target[MAX_PATH * 4] = {};
  // No Resolve: it can search the disk and show UI.
  if (!file || FAILED(file->Load(lnk.c_str(), STGM_READ)) ||
      FAILED(link->GetPath(target, static_cast<int>(std::size(target)), nullptr, 0))) {
    return L"";
  }
  return target;
}

// Recent's links are named after their file ("notes.txt.lnk", "notes.txt (2).lnk"): newest first.
bool fromRecent(const std::wstring& name, std::wstring& out) {
  PWSTR folder = nullptr;
  if (FAILED(SHGetKnownFolderPath(FOLDERID_Recent, 0, nullptr, &folder))) return false;
  const std::wstring dir = folder;
  CoTaskMemFree(folder);
  std::vector<std::pair<uint64_t, std::wstring>> links;
  WIN32_FIND_DATAW data;
  const HANDLE find = FindFirstFileW((dir + L"\\" + name + L"*.lnk").c_str(), &data);
  if (find == INVALID_HANDLE_VALUE) return false;
  do {
    const uint64_t written = (static_cast<uint64_t>(data.ftLastWriteTime.dwHighDateTime) << 32) |
                             data.ftLastWriteTime.dwLowDateTime;
    links.emplace_back(written, dir + L"\\" + data.cFileName);
  } while (FindNextFileW(find, &data));
  FindClose(find);
  std::sort(links.begin(), links.end(), [](const auto& a, const auto& b) { return a.first > b.first; });
  for (const auto& link : links) {
    const std::wstring target = linkTarget(link.second);
    if (!target.empty() && isNamedFile(target, name)) {
      out = target;
      return true;
    }
  }
  return false;
}

// Calls `each` with every subkey of HKCU\<path> until it returns true.
bool anySubkey(const std::wstring& path, const std::function<bool(HKEY)>& each) {
  HKEY root = nullptr;
  if (RegOpenKeyExW(HKEY_CURRENT_USER, path.c_str(), 0, KEY_READ, &root) != ERROR_SUCCESS) return false;
  bool found = false;
  wchar_t sub[256];
  for (DWORD i = 0; !found; ++i) {
    DWORD size = static_cast<DWORD>(std::size(sub));
    if (RegEnumKeyExW(root, i, sub, &size, nullptr, nullptr, nullptr, nullptr) != ERROR_SUCCESS) break;
    HKEY key = nullptr;
    if (RegOpenKeyExW(root, sub, 0, KEY_READ, &key) != ERROR_SUCCESS) continue;
    found = each(key);
    RegCloseKey(key);
  }
  RegCloseKey(root);
  return found;
}

std::wstring stringValue(HKEY key, const wchar_t* sub, const wchar_t* name) {
  DWORD bytes = 0;
  if (RegGetValueW(key, sub, name, RRF_RT_REG_SZ, nullptr, nullptr, &bytes) != ERROR_SUCCESS || bytes < 2) return L"";
  std::wstring out(bytes / sizeof(wchar_t), L'\0');
  if (RegGetValueW(key, sub, name, RRF_RT_REG_SZ, nullptr, out.data(), &bytes) != ERROR_SUCCESS) return L"";
  out.resize(wcsnlen(out.c_str(), out.size()));
  return out;
}

// Acrobat writes its list when a file closes, so this finds files read before rather than the one open now.
bool fromAcrobat(const std::wstring& name, std::wstring& out) {
  for (const wchar_t* path : {L"Software\\Adobe\\Adobe Acrobat\\DC\\AVGeneral\\cRecentFiles",
                              L"Software\\Adobe\\Acrobat Reader\\DC\\AVGeneral\\cRecentFiles"}) {
    if (anySubkey(path, [&](HKEY entry) {
          const std::string text = acrobatMruPath(winrt::to_string(stringValue(entry, nullptr, L"tDIText")));
          const std::wstring file = text.empty() ? std::wstring() : wide(text);
          if (file.empty() || !isNamedFile(file, name)) return false;
          out = file;
          return true;
        })) {
      return true;
    }
  }
  return false;
}

bool fromOfficeMru(const std::wstring& name, std::wstring& out) {
  for (const wchar_t* app : {L"Word", L"Excel", L"PowerPoint"}) {
    const std::wstring path = std::wstring(L"Software\\Microsoft\\Office\\16.0\\") + app + L"\\User MRU";
    if (anySubkey(path, [&](HKEY account) {
          HKEY mru = nullptr;
          if (RegOpenKeyExW(account, L"File MRU", 0, KEY_READ, &mru) != ERROR_SUCCESS) return false;
          bool found = false;
          wchar_t valueName[64];
          for (DWORD i = 0; !found; ++i) {
            DWORD size = static_cast<DWORD>(std::size(valueName));
            if (RegEnumValueW(mru, i, valueName, &size, nullptr, nullptr, nullptr, nullptr) != ERROR_SUCCESS) break;
            const std::string text = officeMruPath(winrt::to_string(stringValue(mru, nullptr, valueName)));
            const std::wstring file = text.empty() ? std::wstring() : wide(text);
            if (!file.empty() && isNamedFile(file, name)) {
              out = file;
              found = true;
            }
          }
          RegCloseKey(mru);
          return found;
        })) {
      return true;
    }
  }
  return false;
}

// The title's file, from the process command line, Recent, then Acrobat's and Office's recent lists.
bool fromTitle(DWORD pid, const std::wstring& title, std::wstring& out) {
  const std::wstring name = wide(fileNameFromTitle(winrt::to_string(title)));
  // Not a file name (and no wildcards in the Recent search).
  if (name.empty() || name.find_first_of(L"\\/:*?\"<>|") != std::wstring::npos) return false;
  return fromCommandLine(pid, name, out) || fromRecent(name, out) || fromAcrobat(name, out) || fromOfficeMru(name, out);
}

}  // namespace

bool systemTextAt(const std::vector<Point>& spots, bool withAddress, SystemText& out, Failure& fail) {
  try {
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    const auto uia = winrt::create_instance<IUIAutomation>(CLSID_CUIAutomation);
    for (const Point& spot : spots) out.spotTexts.push_back(spotText(uia.get(), spot));
    readFocus(uia.get(), out);
    if (!withAddress) return true;
    const HWND front = GetForegroundWindow();
    const WindowProcess proc = front ? processOf(front) : WindowProcess{};
    std::string path, address;
    if (front && !isLolPing(proc.pid) && isBrowser(proc.exe) && addressBar(uia.get(), front, path, address)) {
      out.address = cutText(path.empty() ? address : path, kAddressMax);
    }
    return true;
  } catch (const winrt::hresult_error& e) {
    fail.message = failed("UI Automation", e.code());
    return false;
  }
}

bool readableElement(IUIAutomation* uia, IUIAutomationElement* el, bool& secure) { return readable(uia, el, secure); }

bool focusedSelection(std::string& out) {
  try {
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    const auto uia = winrt::create_instance<IUIAutomation>(CLSID_CUIAutomation);
    winrt::com_ptr<IUIAutomationElement> el;
    bool secure = false;
    if (FAILED(uia->GetFocusedElement(el.put())) || !el || !readable(uia.get(), el.get(), secure)) return false;
    const auto text = textPatternOf(el.get());
    if (!text) return false;
    // The same reading as the ask's, so an unchanged selection compares equal.
    out = selectionOf(uia.get(), text.get());
    return true;
  } catch (const winrt::hresult_error&) {
    return false;
  }
}

bool elementBoxes(const std::vector<Point>& spots, std::vector<std::vector<Rect>>& out, Failure& fail) {
  try {
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    const auto uia = winrt::create_instance<IUIAutomation>(CLSID_CUIAutomation);
    winrt::com_ptr<IUIAutomationTreeWalker> walker;
    winrt::check_hresult(uia->get_ControlViewWalker(walker.put()));
    winrt::com_ptr<IUIAutomationElement> root;
    winrt::check_hresult(uia->GetRootElement(root.put()));
    for (const Point& spot : spots) {
      std::vector<Rect>& chain = out.emplace_back();
      winrt::com_ptr<IUIAutomationElement> el;
      if (FAILED(uia->ElementFromPoint(POINT{spot.x, spot.y}, el.put())) || !el) continue;
      int pid = 0;
      if (SUCCEEDED(el->get_CurrentProcessId(&pid)) && isLolPing(static_cast<DWORD>(pid))) continue;
      // Up to the top-level window: the desktop itself frames nothing.
      for (int depth = 0; el && depth < 40; ++depth) {
        BOOL isRoot = FALSE;
        if (SUCCEEDED(uia->CompareElements(el.get(), root.get(), &isRoot)) && isRoot) break;
        RECT r{};
        if (SUCCEEDED(el->get_CurrentBoundingRectangle(&r)) && r.right > r.left && r.bottom > r.top) {
          chain.push_back(Rect{r.left, r.top, r.right - r.left, r.bottom - r.top});
        }
        winrt::com_ptr<IUIAutomationElement> parent;
        if (FAILED(walker->GetParentElement(el.get(), parent.put()))) break;
        el = parent;
      }
    }
    return true;
  } catch (const winrt::hresult_error& e) {
    fail.message = failed("UI Automation", e.code());
    return false;
  }
}

bool fileBehindWindow(std::string& path, std::string& address, std::string& how, Failure& fail) {
  path.clear();
  address.clear();
  how = "none";
  try {
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    const HWND front = GetForegroundWindow();
    if (!front) return true;
    const WindowProcess proc = processOf(front);
    if (isLolPing(proc.pid)) return true;
    std::wstring file;
    if (isBrowser(proc.exe)) {
      const auto uia = winrt::create_instance<IUIAutomation>(CLSID_CUIAutomation);
      std::string local, web;
      if (!addressBar(uia.get(), front, local, web)) return true;
      if (!local.empty() && !isFile(wide(local))) return true;
      path = local;
      address = web;
      how = "address";
      return true;
    }
    const OfficeApp* office = officeApp(proc.exe);
    if (office && officeDocument(*office, file)) {
      how = "office";
    } else {
      // Office joins the running object table only once its window first loses focus, so a document just opened
      // from Explorer is found by its title instead.
      wchar_t title[512];
      const int n = GetWindowTextW(front, title, static_cast<int>(std::size(title)));
      if (n > 0 && fromTitle(proc.pid, std::wstring(title, static_cast<size_t>(n)), file)) how = "title";
    }
    if (how != "none") path = winrt::to_string(file);
    return true;
  } catch (const winrt::hresult_error& e) {
    fail.message = failed("Finding the file", e.code());
    return false;
  }
}

}  // namespace lp::ctx
