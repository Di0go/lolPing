#pragma once
// The context helper's platform-free part: commands, geometry, spot markers and replies.
// Each platform supplies a ContextPlatform (context_capture_win.cpp, context_capture_mac.mm).
#include <cstdint>
#include <functional>
#include <istream>
#include <optional>
#include <string>
#include <vector>

namespace lp::ctx {

struct Rect {
  int x = 0, y = 0, w = 0, h = 0;
};

struct Point {
  int x = 0, y = 0;
};

/** 32-bit BGRA pixels, rows top to bottom, no padding. */
struct Image {
  int w = 0, h = 0;
  std::vector<uint8_t> px;
};

struct CaptureRequest {
  Rect display;               // the display to grab, in the same units as the input helper's coordinates
  Rect area;                  // the part of the display the overview shows; the whole display when not given
  std::vector<Point> spots;   // 1-based numbers follow this order
  std::vector<Rect> crops;    // one close-up per spot when given, instead of a zoomW x zoomH crop around it
  int overviewLongSide = 1600;
  int zoomW = 1000, zoomH = 750;
  int quality = 80;
  std::string dir;            // where the JPEGs go
};

/** Which context layers to read for one ask; they run side by side under one budget. */
struct ReadRequest {
  std::vector<Point> spots;
  int radius = 600;           // request units around each spot, for marks
  bool marks = false, text = false, file = false, boxes = false, fields = false;
  std::string dir;            // where the marks and fields files go
};

/** A paste into the ask's window by the clipboard route, the one place lolPing sends input for the user (spec §10.3). */
struct PasteRequest {
  std::string window;           // the foreground reply's window id
  std::string text;             // UTF-8, 1 to kPasteTextMax characters
  std::optional<Point> click;   // clicked first to put the caret in the field; insert only
  std::string field;            // the field the click must land on (RawField::id); empty: any text field
  bool replace = false;         // replace pastes only while the selection still holds `asked`
  std::string asked;
};

/** A form field's new value, written by UI Automation. Checkboxes and radios take "on" or "off". */
struct SetFieldRequest {
  std::string window;
  std::string field;  // its runtime id, joined with dots (RawField::id)
  std::string value;
};

struct Command {
  enum class Kind { Bad, Capture, Foreground, Front, Ping, Shutdown, Read, Paste, SetField } kind = Kind::Bad;
  std::string id;
  std::string error;  // Bad: why
  CaptureRequest capture;
  ReadRequest read;
  PasteRequest paste;
  SetFieldRequest setField;
};

constexpr size_t kPasteTextMax = 20000;  // characters

/** One clipboard format: its id, its registered name (empty for the standard ones) and its bytes. */
struct ClipFormat {
  unsigned id = 0;  // 0 when only the name is known: the platform registers it
  std::string name;
  std::vector<uint8_t> bytes;
};

constexpr unsigned kClipUnicodeText = 13;  // CF_UNICODETEXT
constexpr unsigned kClipEnhMetafile = 14;  // CF_ENHMETAFILE: a handle, saved as its bits

/**
 * The listed formats a restore puts back, in their order: not the ones Windows makes up from another (restoring the
 * source brings them back), not the OLE ones (they point into the old owner), not GDI or private handles, and not the
 * exclusion formats, which every write adds fresh.
 */
std::vector<ClipFormat> formatsToRestore(const std::vector<ClipFormat>& listed);

/** The three formats that keep a write out of clipboard history, the cloud clipboard and clipboard monitors. */
std::vector<ClipFormat> exclusionFormats();

/**
 * Whether a format name is one of exclusionFormats(). A platform with marker types of its own (macOS: the
 * nspasteboard.org transient and concealed types) writes those in place of one when it sees it.
 */
bool isExclusionFormat(const std::string& name);

/** Whether no watched key or button is held: each state as GetAsyncKeyState returns it, held with the top bit set. */
bool handsOff(const std::vector<uint16_t>& states);

/** The paste route's waits, in milliseconds. */
constexpr int kHandsOffWaitMs = 3000;
constexpr int kHandsPollMs = 50;
constexpr int kClipboardTries = 20;
constexpr int kClipboardRetryMs = 25;
constexpr int kClickSettleMs = 150;
constexpr int kRestoreAfterMs = 1000;
/** How long a window may take to answer WM_NULL: a suspended app failed it in 213 ms (spec §16). */
constexpr int kAnswerWaitMs = 200;
/** How long a restore keeps trying to open a busy clipboard. */
constexpr int kRestoreTryMs = 1500;
/** Time a restore is sure to get, kept back when deciding whether a paste can still start. */
constexpr int kRestoreReserveMs = 500;
/**
 * A paste's whole time, from the command to its reply, inside the client's 6,000 ms (PASTE_TIMEOUT_MS): a paste
 * that could not finish in it is refused before its text goes on the clipboard.
 */
constexpr int kPasteDeadlineMs = 5500;

/** How far above the element under a paste's click its field is looked for: the browser's hit test often lands on a
 *  paragraph or text node inside the field. */
constexpr size_t kFieldAncestors = 3;

/** An element above the one under a click: its runtime id, name, password flag and whether it acts on a click. */
struct AncestorFacts {
  std::string id;
  std::string label;
  bool secure = false;
  bool activatable = false;
};

/** What a write needs to know about a field first: its kind (RawField's), label, password flag and runtime id. */
struct FieldFacts {
  std::string kind;
  std::string label;
  bool secure = false;
  std::string id;
  /** Under a click only: the element does something when clicked (a button, link, check box, list item and such). */
  bool activatable = false;
  /** Under a click only: the first kFieldAncestors elements above it, nearest first. */
  std::vector<AncestorFacts> ancestors;
};

/**
 * Where a paste's click on `under` lands, for a paste meant for field `expected`: "" on that field, "secure" on it
 * when it is a password field, else "window". Without an id the element itself must be a text field.
 */
std::string clickTarget(const FieldFacts& under, const std::string& expected);

constexpr int kMaxSpots = 4;

/** Parses one stdin line. Anything malformed is Kind::Bad, with the id when one could be read. */
Command parseCommand(const std::string& line);

/** The crop around `spot`, moved (not shrunk) to stay inside the display unless the display is smaller. */
Rect zoomRectAround(const Rect& display, Point spot, int w, int h);

/** The overview size: the long side scaled to `longSide` (never enlarged), the other side keeping the aspect. */
void overviewSize(int w, int h, int longSide, int& ow, int& oh);

/** Draws spot `number`'s ring, crosshair and number centred on (cx, cy). The centre pixel itself stays untouched. */
void drawSpotMarker(Image& img, int cx, int cy, int number);

/** The ring's radius, in image pixels. */
constexpr int kMarkerRadius = 22;

/** Why a platform call failed: code is "capture" or "permission". */
struct Failure {
  std::string code = "capture";
  std::string message;
};

/** A line of text or a control: kind is one of text, button, link, field, menu, tab, check, item, other. */
struct RawMark {
  std::string kind;
  Rect box;
  std::string text;
};

/** A form control. kind is one of text, multiline, combo, checkbox, radio, other (FormField in doRules.ts). */
struct RawField {
  std::string id;     // the control's UI Automation runtime id, joined with dots
  std::string kind;
  std::string label, group;
  std::string value;  // a checkbox or radio: "on" or "off"; empty for a secure field, whatever it holds
  bool secure = false, required = false;
  std::vector<std::string> options;  // a combo's list items
  Rect box;  // on screen, physical px: where the teammate pings it and where a paste into it clicks
};

struct SystemText {
  std::string selection;
  std::vector<std::string> spotTexts;  // one per spot, in spot order
  std::string focusKind, focusLabel, focusValue, address;
  bool focusSecure = false;
};

/** The window in front, read without calling into its app: its id (as foreground's), caption, box and process. */
struct FrontWindow {
  std::string window;
  std::string title;
  Rect box;
  uint32_t pid = 0;
};

// controls, systemText, formFields and fileOf each run on their own fresh thread, which may outlive the command
// when it runs over budget: they must not keep references to caller-owned state, and on Windows each must
// CoInitializeEx on its thread.
struct ContextPlatform {
  /** Grabs the display. The image may be larger than the rect (macOS Retina): spots are scaled to it. */
  std::function<bool(const Rect& display, Image& out, Failure& fail)> grab;
  std::function<bool(const Image& in, int w, int h, Image& out)> resize;
  std::function<bool(const Image& img, int quality, const std::string& path, Failure& fail)> writeJpeg;
  /**
   * `windowId` names the window for later commands (the HWND in decimal on Windows); empty where there is none.
   * `pid`: the process that owns it (0 when nothing is in front), so main can tell its own windows apart.
   */
  std::function<bool(std::string& app, std::string& title, std::string& windowId, uint32_t& pid, Failure& fail)>
      foreground;
  /**
   * The window in front by foreground's id, its caption, box and process id, without calling into its app (no
   * Accessibility or UI Automation call). Nothing in front: empty window, zero box. Optional: unset answers `bad`.
   */
  std::function<bool(FrontWindow& out, Failure& fail)> front;
  /** Named controls and text within `radius` of a spot; spots, radius and boxes are in request (screen) units. */
  std::function<bool(const std::vector<Point>& spots, int radius, std::vector<RawMark>& out, Failure& fail)> controls;
  /** `withAddress`: also look up the browser's address; off when the file probe of the same read looks it up. */
  std::function<bool(const std::vector<Point>& spots, bool withAddress, SystemText& out, Failure& fail)> systemText;
  /**
   * The boxes that hold the element under each spot, innermost first, ending with its top-level window; none for
   * lolPing's own windows or an element that does not answer. Request (screen) units.
   */
  std::function<bool(const std::vector<Point>& spots, std::vector<std::vector<Rect>>& out, Failure& fail)> boxes;
  /**
   * The text fields, combos, checkboxes, radios and spinners that are on screen and enabled in the window under the
   * first spot (the page's document in a browser), in document order. Unset where the platform has none: the read
   * reports the layer off.
   */
  std::function<bool(const std::vector<Point>& spots, std::vector<RawField>& out, Failure& fail)> formFields;
  /** The file or web address behind the foreground window; `how` is office, address, title or none. */
  std::function<bool(std::string& path, std::string& address, std::string& how, Failure& fail)> fileOf;

  // Writing: paste and setField (context_write_win.cpp). Unset where the platform has none: both answer `bad`.
  // focusedSelection, fieldFacts and setField call into the target app by UI Automation: each runs on a fresh thread,
  // like the probes above, and only after `responsive` said the app answers.
  /**
   * The id of the window in front now, by foreground's ids, without calling into the app (no Accessibility or UI
   * Automation call, which a frozen app would block). Optional: paste and setField window checks use it when set,
   * else foreground. macOS sets it; Windows reads the foreground window without blocking.
   */
  std::function<std::string()> frontWindowId;
  /** Whether the window answers a message within 200 ms: a frozen app would take a Ctrl+V late, after the restore. */
  std::function<bool(const std::string& window)> responsive;
  /**
   * Whether the window's app runs at a higher integrity level than the helper (an app run as administrator): Windows
   * drops input sent to it without a word. True when it can't be told.
   */
  std::function<bool(const std::string& window)> elevated;
  /** The top-level window under a point, by the same id as foreground's. */
  std::function<std::string(Point at)> windowAt;
  /** The focused element's selected text, read as the read command reads it; false when it can't be read. */
  std::function<bool(std::string& out)> focusedSelection;
  /** The field under `at`, or the focused one without it; false when it can't be read. */
  std::function<bool(std::optional<Point> at, FieldFacts& out)> fieldFacts;
  /** The states of the mouse buttons, Ctrl, Shift, Alt and Win (handsOff). */
  std::function<std::vector<uint16_t>()> keyStates;
  /** One try; the clipboard's other calls run between a successful open and the close. */
  std::function<bool()> openClipboard;
  std::function<void()> closeClipboard;
  /** The formats on the clipboard, ids and names only, in its order. */
  std::function<std::vector<ClipFormat>()> clipboardFormats;
  /** Fills in `format.bytes`; false when a listed format cannot be safely read and restored. */
  std::function<bool(ClipFormat& format)> readClipboard;
  /** Empties the clipboard and puts these formats on it. */
  std::function<bool(const std::vector<ClipFormat>& formats)> writeClipboard;
  /** A number that changes whenever anything changes the clipboard (GetClipboardSequenceNumber). */
  std::function<uint32_t()> clipboardSequence;
  /**
   * A primary-button click at the point, marked as lolPing's own input; the pointer goes back where it was. A button
   * Windows took down is let up again even when it took only some of the events.
   */
  std::function<bool(Point at)> click;
  /**
   * Ctrl down, V down, V up, Ctrl up, each marked as lolPing's own input. When Windows takes only some of them, the
   * keys it took down are let up again.
   */
  std::function<bool()> pressPaste;
  std::function<void(int ms)> wait;
  /** Milliseconds on a steady clock. */
  std::function<int64_t()> now;
  /**
   * Finds the field by runtime id under the window and writes the value; `check` sees the field first and returns a
   * result code to refuse it, or "" to allow. Returns ok, gone, refused or check's code.
   */
  std::function<std::string(const SetFieldRequest& request,
                            const std::function<std::string(const FieldFacts&)>& check)> setField;
};

/** This OS's capture, resize, JPEG and foreground calls (context_capture_win.cpp, context_capture_mac.mm). */
ContextPlatform nativePlatform();

struct Reply {
  std::string line;        // without the newline
  bool exitAfter = false;  // a probe is still running past its budget: the helper exits after this reply
};

/** How long a command's OS probes may take, together, before the helper gives up on them. */
constexpr int kProbeBudgetMs = 1000;

/** runContextLoop's result after a reply with exitAfter: the caller ends the process without cleanup. */
constexpr int kExitNow = 2;

/**
 * Runs one command. Not called for Shutdown. Tests pass a short budget. A paste is held to kPasteDeadlineMs instead
 * (its hands-off wait and restore take seconds); its UI Automation checks get four fifths of the budget (800 ms), and a
 * setField gets one and a half times it (1,500 ms: opening a combo's list takes a while).
 */
Reply handleCommand(const Command& cmd, const ContextPlatform& platform, int budgetMs = kProbeBudgetMs);

/** The marks file: one `kind\tx\ty\tw\th\ttext` line per mark, text on one line and at most 120 characters. */
std::string marksFileText(const std::vector<RawMark>& marks);

/** Caps on the form fields file, in characters except the counts; formFieldsFileText applies them. */
constexpr size_t kMaxFormFields = 60;
constexpr size_t kFieldIdMax = 120;
constexpr size_t kFieldLabelMax = 120;
constexpr size_t kFieldValueMax = 2000;
constexpr size_t kMaxFieldOptions = 50;
constexpr size_t kFieldOptionMax = 120;

/**
 * The fields file: one JSON object per line for each of the first kMaxFormFields fields, texts cut to their caps on
 * character boundaries. The value of a secure field, or of one whose label is a never-fill label, is never written,
 * whatever the probe read; such a field is written with secure true. A field's box is left out when it is empty.
 */
std::string formFieldsFileText(const std::vector<RawField>& fields);

/**
 * Whether a label names a password, PIN, card number, security code, expiry, bank account, SSN, passport or ID number,
 * in English or Chinese: the same test as neverFill in src/shared/teammate/doRules.ts.
 */
bool neverFillLabel(const std::string& label);

/** At most this many boxes per spot: the innermost ones and the window. */
constexpr size_t kMaxBoxes = 12;

/** `chain` without repeats of the same box, cut to kMaxBoxes by dropping the outer ones short of the last. */
std::vector<Rect> thinBoxes(const std::vector<Rect>& chain);

/** Caps on the system text a read sends, in characters; the probes apply them. */
constexpr size_t kSelectionMax = 4000;
constexpr size_t kSpotTextMax = 2000;
constexpr size_t kFocusValueMax = 2000;
constexpr size_t kAddressMax = 2000;

/** The first `maxChars` characters of UTF-8 `text`, never cut inside a character. */
std::string cutText(const std::string& text, size_t maxChars);

/**
 * The file name a window title shows ("notes.txt - Notepad", "a.ts - repo - Visual Studio Code"), or empty: the
 * text before the last " - " when it ends in a known extension, else the last " - " part or word that does, else the
 * text before the last " - ". A leading unsaved mark ('*' or U+25CF) is dropped.
 */
std::string fileNameFromTitle(const std::string& title);

/** Acrobat's recent-file form `/C/a/b.pdf` as `C:\a\b.pdf`; empty when the value is not in that form. */
std::string acrobatMruPath(const std::string& value);

/** Office's File MRU value `[F…][T…]*C:\a\b.docx` as the path after the `*`; empty without one. */
std::string officeMruPath(const std::string& value);

/**
 * A browser address bar's value: `C:/…` and `file:///…` become a Windows `path` (percent-decoded), anything else
 * that looks like a web address becomes `address`, with https:// added when it has no scheme. False when the value
 * looks like neither (empty, a search, `about:blank`).
 */
bool browserAddress(const std::string& value, std::string& path, std::string& address);

/** Runs `probe` on its own thread; false when it is still running at the budget, leaving it running detached. */
bool runWithBudget(const std::function<void()>& probe, int budgetMs);

/**
 * Runs every probe at once on its own thread against one deadline; false when any is still running at it. With
 * `finished`, it gets one flag per probe saying whether that probe returned in time (its output is then safe to read).
 */
bool runAllWithBudget(const std::vector<std::function<void()>>& probes, int budgetMs,
                      std::vector<bool>* finished = nullptr);

/**
 * Reads commands until shutdown, end of input or a reply that exits, writing each reply with `write`.
 * Returns kExitNow after a reply with exitAfter (a probe thread is still running), else 0.
 */
int runContextLoop(std::istream& in, const std::function<bool(const std::string&)>& write,
                   const ContextPlatform& platform, int budgetMs = kProbeBudgetMs);

std::string formatError(const std::string& id, const std::string& code, const std::string& message);

}  // namespace lp::ctx
