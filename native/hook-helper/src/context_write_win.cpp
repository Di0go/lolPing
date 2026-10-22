// Windows writes for the teammate's Do it asks: the fields of the form under the first spot and setField by UI
// Automation, and the paste route (clipboard, click and Ctrl+V). The UI Automation calls each run on a fresh thread
// (context.h), never beside another tree search, so each joins the MTA itself and never uninitializes: an abandoned
// thread may still be inside a call when the helper exits. The clipboard and input calls run on the command loop.
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <unknwn.h>
#include <UIAutomation.h>
#include <oleauto.h>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <future>
#include <optional>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

// The SDK's C++/WinRT headers do not build clean under /W4 /WX; our own code keeps both.
#pragma warning(push, 0)
#include <winrt/base.h>
#pragma warning(pop)

#include "context.h"
#include "selfMarker.h"

namespace lp::ctx {

// In context_text_win.cpp: whether a process is lolPing's own; whether an element is safe to read (not lolPing's,
// not in a password field, which sets `secure`); the focused element's selection, read as a read command reads it.
bool isLolPingProcess(unsigned long pid);
bool readableElement(IUIAutomation* uia, IUIAutomationElement* el, bool& secure);
bool focusedSelection(std::string& out);

namespace {

using Clock = std::chrono::steady_clock;
// Stops with the fields found so far, short of the 1 s probe budget, so a big form still gives some.
constexpr std::chrono::milliseconds kFieldsBudget{700};
// How far up from the spot the page's document is looked for.
constexpr int kScopeLevels = 40;
// How far up from a radio its group is looked for.
constexpr int kGroupLevels = 8;
// An edit taller than this (at 96 dpi) holds several lines. A single-line input is 21 to 38 px high in the common
// styles; a textarea of two rows is about as tall as a big input, so it reads as single line: harmless, as filling
// a field writes the same either way.
constexpr int kMultilineHeight = 44;

std::string failed(const char* what, HRESULT code) {
  char buf[96];
  std::snprintf(buf, sizeof(buf), "%s failed (0x%08lx)", what, static_cast<unsigned long>(code));
  return buf;
}

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

// A label or name on one line, without the spaces around it.
std::string oneLine(const std::wstring& text) {
  std::wstring out;
  for (const wchar_t c : text) out += c == L'\r' || c == L'\n' || c == L'\t' || c == 0x00a0 ? L' ' : c;
  const size_t a = out.find_first_not_of(L' ');
  if (a == std::wstring::npos) return std::string();
  const size_t b = out.find_last_not_of(L' ');
  return winrt::to_string(std::wstring_view(out).substr(a, b - a + 1));
}

std::string currentName(IUIAutomationElement* el) {
  Bstr name;
  return SUCCEEDED(el->get_CurrentName(&name.s)) ? oneLine(name.text()) : std::string();
}

winrt::com_ptr<IUIAutomationCondition> typeIs(IUIAutomation* uia, CONTROLTYPEID type) {
  Variant v;
  v.v.vt = VT_I4;
  v.v.lVal = static_cast<LONG>(type);
  winrt::com_ptr<IUIAutomationCondition> cond;
  winrt::check_hresult(uia->CreatePropertyCondition(UIA_ControlTypePropertyId, v.v, cond.put()));
  return cond;
}

winrt::com_ptr<IUIAutomationCondition> flagIs(IUIAutomation* uia, PROPERTYID property, bool on) {
  Variant v;
  v.v.vt = VT_BOOL;
  v.v.boolVal = on ? VARIANT_TRUE : VARIANT_FALSE;
  winrt::com_ptr<IUIAutomationCondition> cond;
  winrt::check_hresult(uia->CreatePropertyCondition(property, v.v, cond.put()));
  return cond;
}

// Any of the control types.
winrt::com_ptr<IUIAutomationCondition> typeIsAny(IUIAutomation* uia, const std::vector<CONTROLTYPEID>& types) {
  winrt::com_ptr<IUIAutomationCondition> any = typeIs(uia, types.front());
  for (size_t i = 1; i < types.size(); ++i) {
    winrt::com_ptr<IUIAutomationCondition> next;
    winrt::check_hresult(uia->CreateOrCondition(any.get(), typeIs(uia, types[i]).get(), next.put()));
    any = next;
  }
  return any;
}

// The runtime id, joined with dots: the same control keeps it for as long as it lives, so a later fill finds it again.
std::string runtimeIdOf(IUIAutomationElement* el) {
  SAFEARRAY* ids = nullptr;
  if (FAILED(el->GetRuntimeId(&ids)) || !ids) return std::string();
  std::string out;
  LONG lo = 0, hi = -1;
  if (SUCCEEDED(SafeArrayGetLBound(ids, 1, &lo)) && SUCCEEDED(SafeArrayGetUBound(ids, 1, &hi))) {
    for (LONG i = lo; i <= hi; ++i) {
      int part = 0;
      if (FAILED(SafeArrayGetElement(ids, &i, &part))) {
        out.clear();
        break;
      }
      if (!out.empty()) out += '.';
      out += std::to_string(part);
    }
  }
  SafeArrayDestroy(ids);
  return out;
}

// What to search: the page's document when the spot is on a web page, so the browser's own address bar (also an
// edit) is not a field, else the top-level window. Null for lolPing's own windows and for the desktop itself, whose
// search would cover every window.
winrt::com_ptr<IUIAutomationElement> scopeUnder(IUIAutomation* uia, Point spot) {
  winrt::com_ptr<IUIAutomationTreeWalker> walker;
  winrt::check_hresult(uia->get_ControlViewWalker(walker.put()));
  winrt::com_ptr<IUIAutomationElement> root;
  winrt::check_hresult(uia->GetRootElement(root.put()));
  winrt::com_ptr<IUIAutomationElement> el;
  if (FAILED(uia->ElementFromPoint(POINT{spot.x, spot.y}, el.put())) || !el) return nullptr;
  int pid = 0;
  if (SUCCEEDED(el->get_CurrentProcessId(&pid)) && isLolPingProcess(static_cast<unsigned long>(pid))) return nullptr;
  // A page inside a page (an iframe) has a document of its own: the outermost one covers them all.
  winrt::com_ptr<IUIAutomationElement> document;
  for (int depth = 0; depth < kScopeLevels; ++depth) {
    CONTROLTYPEID type = 0;
    if (SUCCEEDED(el->get_CurrentControlType(&type)) && type == UIA_DocumentControlTypeId) document = el;
    winrt::com_ptr<IUIAutomationElement> parent;
    if (FAILED(walker->GetParentElement(el.get(), parent.put())) || !parent) break;
    BOOL isRoot = FALSE;
    if (SUCCEEDED(uia->CompareElements(parent.get(), root.get(), &isRoot)) && isRoot) break;
    el = parent;
  }
  if (document) return document;
  BOOL isDesktop = FALSE;
  if (FAILED(uia->CompareElements(el.get(), root.get(), &isDesktop)) || isDesktop) return nullptr;
  return el;
}

// The name of the nearest Group above a radio (a fieldset's legend), or empty.
std::string groupOf(IUIAutomationTreeWalker* walker, IUIAutomationCacheRequest* request, IUIAutomationElement* el) {
  winrt::com_ptr<IUIAutomationElement> node;
  node.copy_from(el);
  for (int level = 0; level < kGroupLevels; ++level) {
    winrt::com_ptr<IUIAutomationElement> parent;
    if (FAILED(walker->GetParentElementBuildCache(node.get(), request, parent.put())) || !parent) return std::string();
    CONTROLTYPEID type = 0;
    if (FAILED(parent->get_CachedControlType(&type))) return std::string();
    if (type == UIA_GroupControlTypeId) {
      Bstr name;
      return SUCCEEDED(parent->get_CachedName(&name.s)) ? oneLine(name.text()) : std::string();
    }
    // The document and the window are the form's edge.
    if (type == UIA_DocumentControlTypeId || type == UIA_WindowControlTypeId) return std::string();
    node = parent;
  }
  return std::string();
}

// A combo's list items, read where they are without opening the combo: a closed one may show none.
std::vector<std::string> optionsOf(IUIAutomationElement* combo, IUIAutomationCondition* isItem,
                                   IUIAutomationCacheRequest* request) {
  std::vector<std::string> out;
  winrt::com_ptr<IUIAutomationElementArray> items;
  if (FAILED(combo->FindAllBuildCache(TreeScope_Descendants, isItem, request, items.put())) || !items) return out;
  int count = 0;
  if (FAILED(items->get_Length(&count))) return out;
  for (int i = 0; i < count && out.size() < kMaxFieldOptions; ++i) {
    winrt::com_ptr<IUIAutomationElement> item;
    Bstr name;
    if (FAILED(items->GetElement(i, item.put())) || !item || FAILED(item->get_CachedName(&name.s))) continue;
    const std::string text = oneLine(name.text());
    if (!text.empty()) out.push_back(text);
  }
  return out;
}

std::string cachedText(IUIAutomationElement* el, PROPERTYID property) {
  Variant v;
  if (FAILED(el->GetCachedPropertyValue(property, &v.v)) || v.v.vt != VT_BSTR || !v.v.bstrVal) return std::string();
  return winrt::to_string(std::wstring_view(v.v.bstrVal, SysStringLen(v.v.bstrVal)));
}

// The screen's dpi, to scale the height that makes an edit multiline.
int screenDpi() {
  static const int dpi = [] {
    const HDC dc = GetDC(nullptr);
    const int d = dc ? GetDeviceCaps(dc, LOGPIXELSY) : 96;
    if (dc) ReleaseDC(nullptr, dc);
    return d > 0 ? d : 96;
  }();
  return dpi;
}

// An edit holds several lines when the page says so (aria-multiline), its text already breaks lines, or it is tall.
bool isMultiline(const std::string& aria, const std::string& value, const RECT& box) {
  if (aria.find("multiline=true") != std::string::npos) return true;
  if (value.find('\n') != std::string::npos) return true;
  return static_cast<long long>(box.bottom - box.top) * 96 > static_cast<long long>(kMultilineHeight) * screenDpi();
}

// "on" for a checked checkbox or a chosen radio, else "off" (also a checkbox in between).
std::string checkedState(IUIAutomationElement* el, bool radio) {
  Variant v;
  if (radio && SUCCEEDED(el->GetCachedPropertyValue(UIA_SelectionItemIsSelectedPropertyId, &v.v)) &&
      v.v.vt == VT_BOOL) {
    return v.v.boolVal != VARIANT_FALSE ? "on" : "off";
  }
  Variant toggle;
  if (SUCCEEDED(el->GetCachedPropertyValue(UIA_ToggleToggleStatePropertyId, &toggle.v)) && toggle.v.vt == VT_I4) {
    return toggle.v.lVal == ToggleState_On ? "on" : "off";
  }
  return "off";
}

}  // namespace

bool formFieldsAt(const std::vector<Point>& spots, std::vector<RawField>& out, Failure& fail) {
  const Clock::time_point deadline = Clock::now() + kFieldsBudget;
  try {
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    if (spots.empty()) return true;
    const auto uia = winrt::create_instance<IUIAutomation>(CLSID_CUIAutomation);
    const winrt::com_ptr<IUIAutomationElement> scope = scopeUnder(uia.get(), spots.front());
    if (!scope) return true;

    const auto isField = typeIsAny(uia.get(), {UIA_EditControlTypeId, UIA_ComboBoxControlTypeId,
                                               UIA_CheckBoxControlTypeId, UIA_RadioButtonControlTypeId,
                                               UIA_SpinnerControlTypeId});
    winrt::com_ptr<IUIAutomationCondition> shown, wanted;
    const auto onScreen = flagIs(uia.get(), UIA_IsOffscreenPropertyId, false);
    const auto enabled = flagIs(uia.get(), UIA_IsEnabledPropertyId, true);
    winrt::check_hresult(uia->CreateAndCondition(isField.get(), onScreen.get(), shown.put()));
    winrt::check_hresult(uia->CreateAndCondition(shown.get(), enabled.get(), wanted.put()));
    winrt::com_ptr<IUIAutomationCacheRequest> fieldReq, groupReq, itemReq;
    winrt::check_hresult(uia->CreateCacheRequest(fieldReq.put()));
    for (const PROPERTYID id : {UIA_ControlTypePropertyId, UIA_NamePropertyId, UIA_BoundingRectanglePropertyId,
                                UIA_IsPasswordPropertyId, UIA_HelpTextPropertyId, UIA_ClassNamePropertyId,
                                UIA_IsRequiredForFormPropertyId, UIA_AriaPropertiesPropertyId, UIA_LabeledByPropertyId,
                                UIA_ValueValuePropertyId, UIA_ToggleToggleStatePropertyId,
                                UIA_SelectionItemIsSelectedPropertyId}) {
      winrt::check_hresult(fieldReq->AddProperty(id));
    }
    winrt::check_hresult(uia->CreateCacheRequest(groupReq.put()));
    for (const PROPERTYID id : {UIA_ControlTypePropertyId, UIA_NamePropertyId}) {
      winrt::check_hresult(groupReq->AddProperty(id));
    }
    winrt::check_hresult(uia->CreateCacheRequest(itemReq.put()));
    winrt::check_hresult(itemReq->AddProperty(UIA_NamePropertyId));
    winrt::check_hresult(itemReq->put_AutomationElementMode(AutomationElementMode_None));
    const auto isItem = typeIs(uia.get(), UIA_ListItemControlTypeId);
    winrt::com_ptr<IUIAutomationTreeWalker> walker;
    winrt::check_hresult(uia->get_ControlViewWalker(walker.put()));

    // One search for every field, in document order.
    winrt::com_ptr<IUIAutomationElementArray> found;
    winrt::check_hresult(scope->FindAllBuildCache(TreeScope_Descendants, wanted.get(), fieldReq.get(), found.put()));
    if (!found) return true;
    int count = 0;
    winrt::check_hresult(found->get_Length(&count));
    for (int i = 0; i < count && out.size() < kMaxFormFields && Clock::now() < deadline; ++i) {
      winrt::com_ptr<IUIAutomationElement> el;
      RECT box{};
      CONTROLTYPEID type = 0;
      if (FAILED(found->GetElement(i, el.put())) || !el || FAILED(el->get_CachedControlType(&type)) ||
          FAILED(el->get_CachedBoundingRectangle(&box)) || box.right <= box.left || box.bottom <= box.top) {
        continue;
      }
      Bstr className;
      if (SUCCEEDED(el->get_CachedClassName(&className.s)) && className.text() == L"OmniboxViewViews") continue;

      RawField f;
      f.id = runtimeIdOf(el.get());
      if (f.id.empty()) continue;
      BOOL password = FALSE, required = FALSE;
      el->get_CachedIsPassword(&password);
      el->get_CachedIsRequiredForForm(&required);
      f.secure = password != FALSE;
      f.required = required != FALSE;

      winrt::com_ptr<IUIAutomationElement> labelledBy;
      if (SUCCEEDED(el->get_CachedLabeledBy(labelledBy.put())) && labelledBy) f.label = currentName(labelledBy.get());
      if (f.label.empty()) {
        Bstr name;
        if (SUCCEEDED(el->get_CachedName(&name.s))) f.label = oneLine(name.text());
      }
      if (f.label.empty()) {
        Bstr help;
        if (SUCCEEDED(el->get_CachedHelpText(&help.s))) f.label = oneLine(help.text());
      }

      switch (type) {
        case UIA_CheckBoxControlTypeId:
          f.kind = "checkbox";
          f.value = checkedState(el.get(), false);
          break;
        case UIA_RadioButtonControlTypeId:
          f.kind = "radio";
          f.value = checkedState(el.get(), true);
          f.group = groupOf(walker.get(), groupReq.get(), el.get());
          break;
        case UIA_ComboBoxControlTypeId:
          f.kind = "combo";
          if (!f.secure) f.value = cachedText(el.get(), UIA_ValueValuePropertyId);
          f.options = optionsOf(el.get(), isItem.get(), itemReq.get());
          break;
        case UIA_SpinnerControlTypeId:
          f.kind = "other";
          if (!f.secure) f.value = cachedText(el.get(), UIA_ValueValuePropertyId);
          break;
        default:  // an edit
          if (!f.secure) f.value = cachedText(el.get(), UIA_ValueValuePropertyId);
          f.kind = isMultiline(cachedText(el.get(), UIA_AriaPropertiesPropertyId), f.value, box) ? "multiline" : "text";
          break;
      }
      // A password field's bullets say how long the password is: nothing of it is kept.
      if (f.secure) f.value.clear();
      out.push_back(std::move(f));
    }
    return true;
  } catch (const winrt::hresult_error& e) {
    fail.message = failed("UI Automation", e.code());
    return false;
  }
}

namespace {

// How long a window may take to answer before it counts as not responding: a suspended app failed it in 213 ms (spec
// §16), while IsHungAppWindow needs 5 s.
constexpr UINT kAnswerMs = 200;
// How long a combo's list, or a checkbox's new state, may take to show after the call that changes it.
constexpr int kSettlePolls = 10;
constexpr DWORD kSettlePollMs = 30;

// The parser lets through digits only.
HWND windowOf(const std::string& id) {
  try {
    return reinterpret_cast<HWND>(static_cast<uintptr_t>(std::stoull(id)));
  } catch (const std::exception&) {
    return nullptr;
  }
}

std::string idOf(HWND w) { return w ? std::to_string(reinterpret_cast<uintptr_t>(w)) : std::string(); }

bool responsive(const std::string& window) {
  const HWND w = windowOf(window);
  DWORD_PTR answer = 0;
  return w && IsWindow(w) && SendMessageTimeoutW(w, WM_NULL, 0, 0, SMTO_ABORTIFHUNG, kAnswerMs, &answer) != 0;
}

std::string rootWindowAt(Point at) {
  const HWND w = WindowFromPoint(POINT{at.x, at.y});
  return idOf(w ? GetAncestor(w, GA_ROOT) : nullptr);
}

const char* fieldKind(CONTROLTYPEID type) {
  switch (type) {
    case UIA_EditControlTypeId: return "text";
    case UIA_ComboBoxControlTypeId: return "combo";
    case UIA_CheckBoxControlTypeId: return "checkbox";
    case UIA_RadioButtonControlTypeId: return "radio";
    default: return "other";
  }
}

// The label a form field shows: the element that labels it, else its name, else its help text (the placeholder), as
// formFieldsAt reads it.
std::string currentLabel(IUIAutomationElement* el) {
  std::string label;
  winrt::com_ptr<IUIAutomationElement> labelledBy;
  if (SUCCEEDED(el->get_CurrentLabeledBy(labelledBy.put())) && labelledBy) label = currentName(labelledBy.get());
  if (label.empty()) label = currentName(el);
  if (label.empty()) {
    Bstr help;
    if (SUCCEEDED(el->get_CurrentHelpText(&help.s))) label = oneLine(help.text());
  }
  return label;
}

// Kind, label and password flag; an element whose password flag can't be read counts as a password field.
FieldFacts factsOf(IUIAutomation* uia, IUIAutomationElement* el) {
  FieldFacts f;
  CONTROLTYPEID type = 0;
  el->get_CurrentControlType(&type);
  f.kind = fieldKind(type);
  f.label = currentLabel(el);
  bool secure = false;
  f.secure = !readableElement(uia, el, secure) || secure;
  return f;
}

bool fieldFactsAt(std::optional<Point> at, FieldFacts& out) {
  try {
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    const auto uia = winrt::create_instance<IUIAutomation>(CLSID_CUIAutomation);
    winrt::com_ptr<IUIAutomationElement> el;
    const HRESULT found = at ? uia->ElementFromPoint(POINT{at->x, at->y}, el.put()) : uia->GetFocusedElement(el.put());
    if (FAILED(found) || !el) return false;
    out = factsOf(uia.get(), el.get());
    return true;
  } catch (const winrt::hresult_error&) {
    return false;
  }
}

std::vector<uint16_t> keyStates() {
  static constexpr int kKeys[] = {VK_LBUTTON, VK_RBUTTON, VK_MBUTTON, VK_XBUTTON1, VK_XBUTTON2,
                                  VK_CONTROL, VK_SHIFT,   VK_MENU,    VK_LWIN,     VK_RWIN};
  std::vector<uint16_t> out;
  for (const int vk : kKeys) out.push_back(static_cast<uint16_t>(GetAsyncKeyState(vk)));
  return out;
}

// The clipboard's owner while the helper writes it: a message-only window on a thread of its own that keeps reading
// its messages. An app that empties the clipboard later sends the owner a message and waits for it to be read; the
// command loop, blocked on stdin, never would. Null when it could not be made: the clipboard then reads as busy.
HWND clipboardOwner() {
  static const HWND owner = [] {
    std::promise<HWND> made;
    std::future<HWND> ready = made.get_future();
    std::thread([made = std::move(made)]() mutable {
      WNDCLASSW wc{};
      wc.lpfnWndProc = DefWindowProcW;
      wc.hInstance = GetModuleHandleW(nullptr);
      wc.lpszClassName = L"lolPingContextClipboard";
      RegisterClassW(&wc);
      const HWND w = CreateWindowExW(0, wc.lpszClassName, L"", 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr, wc.hInstance,
                                     nullptr);
      made.set_value(w);
      MSG msg;
      while (w && GetMessageW(&msg, nullptr, 0, 0) > 0) DispatchMessageW(&msg);
    }).detach();
    return ready.get();
  }();
  return owner;
}

bool openClipboard() {
  const HWND owner = clipboardOwner();
  return owner && OpenClipboard(owner) != 0;
}

std::vector<ClipFormat> clipboardFormats() {
  std::vector<ClipFormat> out;
  for (UINT id = EnumClipboardFormats(0); id != 0; id = EnumClipboardFormats(id)) {
    ClipFormat f;
    f.id = id;
    wchar_t name[256];
    const int n = id >= 0xC000 ? GetClipboardFormatNameW(id, name, 256) : 0;
    if (n > 0) f.name = winrt::to_string(std::wstring_view(name, static_cast<size_t>(n)));
    out.push_back(std::move(f));
  }
  return out;
}

bool readClipboard(ClipFormat& f) {
  const HANDLE h = GetClipboardData(f.id);
  if (!h) return false;
  if (f.id == kClipEnhMetafile) {
    const auto emf = static_cast<HENHMETAFILE>(h);
    const UINT n = GetEnhMetaFileBits(emf, 0, nullptr);
    if (n == 0) return false;
    f.bytes.resize(n);
    return GetEnhMetaFileBits(emf, n, f.bytes.data()) == n;
  }
  const SIZE_T n = GlobalSize(h);
  const void* data = n ? GlobalLock(h) : nullptr;
  if (!data) return false;
  f.bytes.assign(static_cast<const uint8_t*>(data), static_cast<const uint8_t*>(data) + n);
  GlobalUnlock(h);
  return true;
}

// Puts each format on the open clipboard, going on past one that fails; false when any did.
bool writeClipboard(const std::vector<ClipFormat>& formats) {
  if (!EmptyClipboard()) return false;
  bool all = true;
  for (const ClipFormat& f : formats) {
    const UINT id = f.id ? f.id : RegisterClipboardFormatW(winrt::to_hstring(f.name).c_str());
    if (id == kClipEnhMetafile) {
      const HENHMETAFILE emf = SetEnhMetaFileBits(static_cast<UINT>(f.bytes.size()), f.bytes.data());
      if (!emf || !SetClipboardData(id, emf)) {
        if (emf) DeleteEnhMetaFile(emf);
        all = false;
      }
      continue;
    }
    const HGLOBAL g = id ? GlobalAlloc(GMEM_MOVEABLE, std::max<size_t>(f.bytes.size(), 1)) : nullptr;
    void* data = g ? GlobalLock(g) : nullptr;
    if (!data) {
      if (g) GlobalFree(g);
      all = false;
      continue;
    }
    std::copy(f.bytes.begin(), f.bytes.end(), static_cast<uint8_t*>(data));
    GlobalUnlock(g);
    // The clipboard owns the memory once it takes it.
    if (!SetClipboardData(id, g)) {
      GlobalFree(g);
      all = false;
    }
  }
  return all;
}

// An absolute pointer move to (x, y) in physical pixels, marked as lolPing's own so the input hook lets it through.
INPUT pointerTo(int x, int y) {
  const int vx = GetSystemMetrics(SM_XVIRTUALSCREEN), vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
  const int vw = std::max(2, GetSystemMetrics(SM_CXVIRTUALSCREEN));
  const int vh = std::max(2, GetSystemMetrics(SM_CYVIRTUALSCREEN));
  INPUT in{};
  in.type = INPUT_MOUSE;
  in.mi.dx = MulDiv(x - vx, 65535, vw - 1);
  in.mi.dy = MulDiv(y - vy, 65535, vh - 1);
  in.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
  in.mi.dwExtraInfo = kSelfMarker;
  return in;
}

INPUT button(DWORD flag) {
  INPUT in{};
  in.type = INPUT_MOUSE;
  in.mi.dwFlags = flag;
  in.mi.dwExtraInfo = kSelfMarker;
  return in;
}

bool clickAt(Point at) {
  // Injected buttons are physical: with the buttons swapped, the primary click is the right one.
  const bool swapped = GetSystemMetrics(SM_SWAPBUTTON) != 0;
  std::vector<INPUT> in = {pointerTo(at.x, at.y), button(swapped ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_LEFTDOWN),
                           button(swapped ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_LEFTUP)};
  // The click only puts the caret in the field: the pointer goes back where the user left it.
  POINT was{};
  if (GetCursorPos(&was)) in.push_back(pointerTo(was.x, was.y));
  const UINT n = static_cast<UINT>(in.size());
  return SendInput(n, in.data(), sizeof(INPUT)) == n;
}

INPUT key(WORD vk, bool up) {
  INPUT in{};
  in.type = INPUT_KEYBOARD;
  in.ki.wVk = vk;
  in.ki.wScan = static_cast<WORD>(MapVirtualKeyW(vk, MAPVK_VK_TO_VSC));
  in.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0;
  in.ki.dwExtraInfo = kSelfMarker;
  return in;
}

bool pressCtrlV() {
  INPUT in[] = {key(VK_CONTROL, false), key('V', false), key('V', true), key(VK_CONTROL, true)};
  return SendInput(4, in, sizeof(INPUT)) == 4;
}

// The element with this runtime id under the window, or null.
winrt::com_ptr<IUIAutomationElement> findByRuntimeId(IUIAutomation* uia, HWND window, const std::string& field) {
  winrt::com_ptr<IUIAutomationElement> root;
  if (FAILED(uia->ElementFromHandle(window, root.put())) || !root) return nullptr;
  std::vector<int> parts;
  size_t start = 0;
  while (true) {
    const size_t dot = field.find('.', start);
    parts.push_back(std::stoi(field.substr(start, dot == std::string::npos ? std::string::npos : dot - start)));
    if (dot == std::string::npos) break;
    start = dot + 1;
  }
  Variant id;
  id.v.vt = VT_I4 | VT_ARRAY;
  id.v.parray = SafeArrayCreateVector(VT_I4, 0, static_cast<ULONG>(parts.size()));
  if (!id.v.parray) return nullptr;
  for (LONG i = 0; i < static_cast<LONG>(parts.size()); ++i) {
    winrt::check_hresult(SafeArrayPutElement(id.v.parray, &i, &parts[static_cast<size_t>(i)]));
  }
  winrt::com_ptr<IUIAutomationCondition> isField;
  winrt::check_hresult(uia->CreatePropertyCondition(UIA_RuntimeIdPropertyId, id.v, isField.put()));
  winrt::com_ptr<IUIAutomationElement> el;
  if (FAILED(root->FindFirst(TreeScope_Descendants, isField.get(), el.put()))) return nullptr;
  return el;
}

const char* setText(IUIAutomationElement* el, const std::string& value) {
  winrt::com_ptr<IUIAutomationValuePattern> pattern;
  BOOL readOnly = TRUE;
  if (FAILED(el->GetCurrentPatternAs(UIA_ValuePatternId, IID_PPV_ARGS(pattern.put()))) || !pattern ||
      FAILED(pattern->get_CurrentIsReadOnly(&readOnly)) || readOnly) {
    return "refused";
  }
  const winrt::hstring text = winrt::to_hstring(value);
  Bstr b;
  b.s = SysAllocStringLen(text.c_str(), text.size());
  return b.s && SUCCEEDED(pattern->SetValue(b.s)) ? "ok" : "refused";
}

// Toggles until the state is the one asked for. A page may show the new state a moment after the call, so each toggle
// waits for the state to change before the next: two quick toggles would undo each other.
const char* setChecked(IUIAutomationElement* el, const std::string& value) {
  winrt::com_ptr<IUIAutomationTogglePattern> toggle;
  if ((value != "on" && value != "off") ||
      FAILED(el->GetCurrentPatternAs(UIA_TogglePatternId, IID_PPV_ARGS(toggle.put()))) || !toggle) {
    return "refused";
  }
  const ToggleState want = value == "on" ? ToggleState_On : ToggleState_Off;
  // Off, on, in between: two toggles reach any state.
  for (int toggles = 0; toggles <= 2; ++toggles) {
    ToggleState before = ToggleState_Indeterminate;
    if (FAILED(toggle->get_CurrentToggleState(&before))) return "refused";
    if (before == want) return "ok";
    if (toggles == 2 || FAILED(toggle->Toggle())) return "refused";
    ToggleState now = before;
    for (int i = 0; i < kSettlePolls && now == before; ++i) {
      Sleep(kSettlePollMs);
      if (FAILED(toggle->get_CurrentToggleState(&now))) return "refused";
    }
    if (now == before) return "refused";
  }
  return "refused";
}

const char* setRadio(IUIAutomationElement* el, const std::string& value) {
  winrt::com_ptr<IUIAutomationSelectionItemPattern> item;
  BOOL selected = FALSE;
  if (FAILED(el->GetCurrentPatternAs(UIA_SelectionItemPatternId, IID_PPV_ARGS(item.put()))) || !item ||
      FAILED(item->get_CurrentIsSelected(&selected))) {
    return "refused";
  }
  if (value == "on") return selected || SUCCEEDED(item->Select()) ? "ok" : "refused";
  // A radio is turned off only by choosing another one in its group.
  return value == "off" && !selected ? "ok" : "refused";
}

// The list item named `value` under an open combo, or null; `listed` says whether the combo shows any item at all.
winrt::com_ptr<IUIAutomationElement> optionNamed(IUIAutomation* uia, IUIAutomationElement* combo,
                                                  const std::string& value, bool& listed) {
  const auto isItem = typeIs(uia, UIA_ListItemControlTypeId);
  winrt::com_ptr<IUIAutomationCacheRequest> request;
  winrt::check_hresult(uia->CreateCacheRequest(request.put()));
  winrt::check_hresult(request->AddProperty(UIA_NamePropertyId));
  winrt::com_ptr<IUIAutomationElementArray> items;
  int count = 0;
  // An opened list may fill in a moment after Expand.
  for (int i = 0; i < kSettlePolls && count == 0; ++i) {
    if (i > 0) Sleep(kSettlePollMs);
    items = nullptr;
    if (FAILED(combo->FindAllBuildCache(TreeScope_Descendants, isItem.get(), request.get(), items.put())) || !items ||
        FAILED(items->get_Length(&count))) {
      count = 0;
    }
  }
  listed = count > 0;
  for (int i = 0; i < count; ++i) {
    winrt::com_ptr<IUIAutomationElement> item;
    Bstr name;
    if (SUCCEEDED(items->GetElement(i, item.put())) && item && SUCCEEDED(item->get_CachedName(&name.s)) &&
        oneLine(name.text()) == value) {
      return item;
    }
  }
  return nullptr;
}

// Expand, choose the option by name, collapse: a web page's select takes SetValue and ignores it (spec §16).
const char* setCombo(IUIAutomation* uia, IUIAutomationElement* el, const std::string& value) {
  winrt::com_ptr<IUIAutomationExpandCollapsePattern> expand;
  el->GetCurrentPatternAs(UIA_ExpandCollapsePatternId, IID_PPV_ARGS(expand.put()));
  const bool opened = expand && SUCCEEDED(expand->Expand());
  bool listed = false;
  const char* result = "refused";
  if (const auto option = optionNamed(uia, el, value, listed)) {
    winrt::com_ptr<IUIAutomationSelectionItemPattern> item;
    if (SUCCEEDED(option->GetCurrentPatternAs(UIA_SelectionItemPatternId, IID_PPV_ARGS(item.put()))) && item &&
        SUCCEEDED(item->Select())) {
      result = "ok";
    }
  }
  if (opened) expand->Collapse();
  // A combo that lists nothing takes any text (comboAccepts in doRules.ts).
  if (!listed) result = setText(el, value);
  return result;
}

std::string setFieldIn(const SetFieldRequest& r, const std::function<std::string(const FieldFacts&)>& check) {
  try {
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    const HWND window = windowOf(r.window);
    if (!window || !IsWindow(window)) return "gone";
    const auto uia = winrt::create_instance<IUIAutomation>(CLSID_CUIAutomation);
    const auto el = findByRuntimeId(uia.get(), window, r.field);
    if (!el) return "gone";
    if (const std::string refused = check(factsOf(uia.get(), el.get())); !refused.empty()) return refused;
    CONTROLTYPEID type = 0;
    if (FAILED(el->get_CurrentControlType(&type))) return "gone";
    switch (type) {
      case UIA_CheckBoxControlTypeId: return setChecked(el.get(), r.value);
      case UIA_RadioButtonControlTypeId: return setRadio(el.get(), r.value);
      case UIA_ComboBoxControlTypeId: return setCombo(uia.get(), el.get(), r.value);
      default: return setText(el.get(), r.value);
    }
  } catch (const winrt::hresult_error&) {
    return "refused";
  } catch (const std::exception&) {  // a runtime id part out of range: no such field
    return "gone";
  }
}

}  // namespace

void addWriting(ContextPlatform& p) {
  p.responsive = responsive;
  p.windowAt = rootWindowAt;
  p.focusedSelection = focusedSelection;
  p.fieldFacts = fieldFactsAt;
  p.keyStates = keyStates;
  p.openClipboard = openClipboard;
  p.closeClipboard = [] { CloseClipboard(); };
  p.clipboardFormats = clipboardFormats;
  p.readClipboard = readClipboard;
  p.writeClipboard = writeClipboard;
  p.click = clickAt;
  p.pressPaste = pressCtrlV;
  p.wait = [](int ms) { Sleep(static_cast<DWORD>(ms)); };
  p.setField = setFieldIn;
}

}  // namespace lp::ctx
