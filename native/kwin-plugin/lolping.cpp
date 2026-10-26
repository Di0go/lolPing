// KWin backend: a compositor plugin, because a Wayland client cannot see or hold back another client's input.
// It runs the shared gesture decision inside KWin's input chain, swallows only wheel gestures, and talks the
// helper's JSON-lines protocol over a socket in $XDG_RUNTIME_DIR. With no client connected it passes everything.
#include "input.h"
#include "input_event.h"
#include "keyboard_input.h"
#include "plugin.h"
#include "pointer_input.h"

#include <QDir>
#include <QLocalServer>
#include <QLocalSocket>
#include <QPointer>
#include <QTimer>

#include <chrono>
#include <string>

#include "../hook-helper/src/commands.h"
#include "../hook-helper/src/decision.h"
#include "../hook-helper/src/evdevinput.h"
#include "../hook-helper/src/output.h"

namespace lolping {
namespace {

uint64_t nowMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch())
      .count();
}
uint32_t buttonCode(lp::Btn b) {
  switch (b) {
    case lp::Btn::Left: return 0x110; case lp::Btn::Right: return 0x111; case lp::Btn::Middle: return 0x112;
    case lp::Btn::X1: return 0x113; case lp::Btn::X2: return 0x114; default: return 0;
  }
}
constexpr qint64 kMaxBacklog = 1 << 20;  // a client this far behind is stuck: drop it rather than buffer forever

class Bridge : public KWin::Plugin, public KWin::InputEventFilter {
 public:
  // After the lock screen, before screen edges, global shortcuts and window actions (Alt+drag moves windows).
  Bridge() : KWin::InputEventFilter(KWin::InputFilterOrder::ScreenEdge) {
    const QString dir = qEnvironmentVariable("XDG_RUNTIME_DIR", QDir::tempPath());
    path_ = dir + QStringLiteral("/lolping-kwin.sock");
    QLocalServer::removeServer(path_);
    server_.setSocketOptions(QLocalServer::UserAccessOption);
    if (!server_.listen(path_)) qWarning("lolping: cannot listen on %s", qPrintable(path_));
    QObject::connect(&server_, &QLocalServer::newConnection, this, [this] { accept(); });
    // The decision's only timer is the watchdog for a gesture whose release was lost (10 s), so the tick runs
    // only while a gesture is open: an idle KWin gets no wakeups from lolPing.
    tick_.setInterval(500);
    QObject::connect(&tick_, &QTimer::timeout, this, [this] { apply(decision_.tick(nowMs())); });
    KWin::input()->installInputEventFilter(this);
  }
  ~Bridge() override {
    KWin::input()->uninstallInputEventFilter(this);
    if (client_) client_->abort();
    server_.close();
  }

  bool pointerMotion(KWin::PointerMotionEvent* event) override {
    if (!live()) return false;
    lp::InputEvent e;
    e.kind = lp::EvKind::MouseMove;
    e.x = static_cast<int>(event->position.x());
    e.y = static_cast<int>(event->position.y());
    e.timeMs = nowMs();
    apply(decision_.onEvent(e));
    return false;  // the cursor always moves
  }
  bool pointerButton(KWin::PointerButtonEvent* event) override {
    if (!live()) return false;
    const lp::Btn btn = lp::evdev::button(event->nativeButton);
    if (btn == lp::Btn::None) return false;
    lp::InputEvent e;
    e.kind = event->state == KWin::PointerButtonState::Pressed ? lp::EvKind::MouseDown : lp::EvKind::MouseUp;
    e.btn = btn;
    e.x = static_cast<int>(event->position.x());
    e.y = static_cast<int>(event->position.y());
    e.timeMs = nowMs();
    const lp::Result r = decision_.onEvent(e);
    apply(r);
    return r.swallow;
  }
  bool keyboardKey(KWin::KeyboardKeyEvent* event) override {
    if (!live()) return false;
    const uint32_t vk = lp::evdev::keyToVk(event->nativeScanCode);
    if (!vk) return false;
    lp::InputEvent e;
    e.kind = event->state == KWin::KeyboardKeyState::Released ? lp::EvKind::KeyUp : lp::EvKind::KeyDown;
    e.vk = vk;
    e.timeMs = nowMs();
    lp::Result r = decision_.onEvent(e);
    // Modifiers always pass, as on X11: the application keeps its own idea of what is held. So their replays
    // are dropped, and a key swallowed only to be replayed right behind them (typing while a custom trigger is
    // held) passes as it is: a deferred replay would land after the key's own release and stick it down.
    std::erase_if(r.injects, [](const lp::Inject& i) {
      return (i.kind == lp::InjectKind::KeyDown || i.kind == lp::InjectKind::KeyUp) && lp::evdev::isModifierVk(i.vk);
    });
    const bool replaysItself = r.injects.size() == 1 && r.injects[0].vk == vk &&
        r.injects[0].kind == (e.kind == lp::EvKind::KeyDown ? lp::InjectKind::KeyDown : lp::InjectKind::KeyUp);
    if (replaysItself) { r.injects.clear(); r.swallow = false; }
    apply(r);
    return r.swallow && !lp::evdev::isModifierVk(vk);
  }

 private:
  bool live() const { return client_ && !replaying_; }

  void accept() {
    QLocalSocket* next = server_.nextPendingConnection();
    if (!next) return;
    if (client_) client_->abort();  // one app at a time: the newest wins
    client_ = next;
    pending_.clear();
    decision_ = lp::Decision{};
    decision_.setMaskMenuKeys(false);
    decision_.setPanelRepeatGap(0);  // KWin may not repeat a key held under a swallow
    QObject::connect(next, &QLocalSocket::readyRead, this, [this, next] { read(next); });
    QObject::connect(next, &QLocalSocket::disconnected, this, [this, next] {
      if (client_ == next) client_ = nullptr;
      tick_.stop();
      next->deleteLater();
    });
    send("{\"type\":\"ready\",\"version\":6}");
  }
  void read(QLocalSocket* socket) {
    if (socket != client_) return;
    pending_ += socket->readAll().toStdString();
    size_t end;
    while ((end = pending_.find('\n')) != std::string::npos) {
      std::string line = pending_.substr(0, end);
      pending_.erase(0, end + 1);
      if (!line.empty() && line.back() == '\r') line.pop_back();
      command(line);
      if (!client_) return;
    }
    if (pending_.size() > 65536) socket->abort();
  }
  void command(const std::string& line) {
    const lp::Command c = lp::parseCommand(line, decision_.config());
    switch (c.kind) {
      case lp::Command::Kind::Config: apply(decision_.setConfig(c.config)); break;
      case lp::Command::Kind::SetEnabled: apply(decision_.setEnabled(c.flag)); break;
      case lp::Command::Kind::Suspend: apply(decision_.setSuspended(c.flag)); break;
      case lp::Command::Kind::StaleWatch: apply(decision_.setStaleWatch(c.flag)); break;
      case lp::Command::Kind::Shutdown: client_->disconnectFromServer(); break;
      default: send("{\"type\":\"error\",\"message\":\"invalid command\"}"); break;
    }
  }
  void send(const std::string& line) {
    if (!client_) return;
    if (client_->bytesToWrite() > kMaxBacklog) { client_->abort(); return; }
    client_->write(line.data(), static_cast<qint64>(line.size()));
    client_->write("\n", 1);
  }
  void apply(const lp::Result& r) {
    const bool busy = decision_.state() == lp::Decision::State::Pending || decision_.state() == lp::Decision::State::Wheel;
    if (busy != tick_.isActive()) busy ? tick_.start() : tick_.stop();
    for (const auto& e : r.emits) send(lp::formatEmit(e));
    if (r.injects.empty()) return;
    // Replays run after the event that caused them has left the input chain, so KWin's own button and key
    // state is settled first. They skip this filter (replaying_) and go to whatever is under the pointer.
    const std::vector<lp::Inject> injects = r.injects;
    QTimer::singleShot(0, this, [this, injects] {
      replaying_ = true;
      const auto time = std::chrono::duration_cast<std::chrono::microseconds>(
          std::chrono::steady_clock::now().time_since_epoch());
      bool buttons = false;
      for (const auto& i : injects) {
        const bool down = i.kind == lp::InjectKind::ButtonDown || i.kind == lp::InjectKind::KeyDown;
        if (i.kind == lp::InjectKind::ButtonDown || i.kind == lp::InjectKind::ButtonUp) {
          if (const uint32_t code = buttonCode(i.btn)) {
            KWin::input()->pointer()->processButton(
                code, down ? KWin::PointerButtonState::Pressed : KWin::PointerButtonState::Released, time);
            buttons = true;
          }
        } else if (!lp::evdev::isModifierVk(i.vk)) {
          if (const uint32_t code = lp::evdev::vkToKey(i.vk))
            KWin::input()->keyboard()->processKey(
                code, down ? KWin::KeyboardKeyState::Pressed : KWin::KeyboardKeyState::Released, time);
        }
      }
      // Clients apply pointer events at the frame that ends them: without one the replay waits for the next move.
      if (buttons) KWin::input()->pointer()->processFrame();
      replaying_ = false;
    });
  }

  QString path_;
  QLocalServer server_;
  QPointer<QLocalSocket> client_;
  QTimer tick_;
  lp::Decision decision_;
  std::string pending_;
  bool replaying_ = false;
};

}  // namespace

class BridgeFactory : public KWin::PluginFactory {
  Q_OBJECT
  Q_PLUGIN_METADATA(IID PluginFactory_iid FILE "metadata.json")
  Q_INTERFACES(KWin::PluginFactory)

 public:
  std::unique_ptr<KWin::Plugin> create() const override { return std::make_unique<Bridge>(); }
};

}  // namespace lolping

#include "lolping.moc"
