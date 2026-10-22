// Windows form access by UI Automation: the fields of the form under the first spot, for the teammate's Do it asks.
// Runs on its own fresh thread (context.h), so it joins the MTA itself and never uninitializes: an abandoned thread
// may still be inside a call when the helper exits.
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <unknwn.h>
#include <UIAutomation.h>
#include <oleauto.h>

#include <chrono>
#include <cstdio>
#include <string>
#include <string_view>
#include <vector>

// The SDK's C++/WinRT headers do not build clean under /W4 /WX; our own code keeps both.
#pragma warning(push, 0)
#include <winrt/base.h>
#pragma warning(pop)

#include "context.h"

namespace lp::ctx {

// In context_text_win.cpp: whether a process is lolPing's own.
bool isLolPingProcess(unsigned long pid);

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

}  // namespace lp::ctx
