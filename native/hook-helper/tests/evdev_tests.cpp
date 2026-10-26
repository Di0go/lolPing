// Tests the evdev key map of the KWin backend against the X11 backend's map, using the system's XKB keycode
// names (/usr/share/X11/xkb/keycodes/evdev) as the shared ground truth. Build and run: npm run test:helper
#include <cstdio>
#include <fstream>
#include <regex>
#include <string>

#include "../src/evdevinput.h"
#include "../src/linuxinput.h"

using namespace lp;

static int g_pass = 0;
static int g_fail = 0;
#define CHECK(cond)                                               \
  do {                                                            \
    if (cond) {                                                   \
      ++g_pass;                                                   \
    } else {                                                      \
      ++g_fail;                                                   \
      std::printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); \
    }                                                             \
  } while (0)

int main() {
  // Every physical key the X11 backend names maps to the same VK here (X keycode = evdev code + 8).
  std::ifstream xkb("/usr/share/X11/xkb/keycodes/evdev");
  if (xkb) {
    const std::regex entry(R"(^\s*<([A-Z0-9]{4})>\s*=\s*(\d+)\s*;)");
    int compared = 0;
    for (std::string line; std::getline(xkb, line);) {
      std::smatch m;
      if (!std::regex_search(line, m, entry)) continue;
      const uint32_t vk = x11::keyNameToVk(m[1].str().c_str());
      if (!vk) continue;
      const uint32_t code = static_cast<uint32_t>(std::stoi(m[2].str())) - 8;
      if (evdev::keyToVk(code) != vk) std::printf("  mismatch <%s> evdev %u\n", m[1].str().c_str(), code);
      CHECK(evdev::keyToVk(code) == vk);
      ++compared;
    }
    CHECK(compared >= 40);
  } else {
    std::printf("skip: no XKB keycodes file\n");
  }
  // Keys the X11 backend maps by keysym: modifiers, Escape, the custom-trigger favourites.
  CHECK(evdev::keyToVk(56) == 0xA4);   // KEY_LEFTALT
  CHECK(evdev::keyToVk(100) == 0xA5);  // KEY_RIGHTALT
  CHECK(evdev::keyToVk(29) == 0xA2);   // KEY_LEFTCTRL
  CHECK(evdev::keyToVk(97) == 0xA3);   // KEY_RIGHTCTRL
  CHECK(evdev::keyToVk(42) == 0xA0);   // KEY_LEFTSHIFT
  CHECK(evdev::keyToVk(125) == 0x5B);  // KEY_LEFTMETA
  CHECK(evdev::keyToVk(1) == 0x1B);    // KEY_ESC
  CHECK(evdev::keyToVk(59) == 0x70);   // KEY_F1
  CHECK(evdev::keyToVk(88) == 0x7B);   // KEY_F12
  CHECK(evdev::keyToVk(0x2ff) == 0);
  // Replays type a VK on the key it came from.
  for (uint32_t code = 1; code < 200; ++code) {
    const uint32_t vk = evdev::keyToVk(code);
    if (vk && code != 96) CHECK(evdev::vkToKey(vk) == code);  // keypad Enter replays as Enter
  }
  CHECK(evdev::button(0x110) == Btn::Left);
  CHECK(evdev::button(0x111) == Btn::Right);
  CHECK(evdev::button(0x112) == Btn::Middle);
  CHECK(evdev::button(0x113) == Btn::X1);
  CHECK(evdev::button(0x114) == Btn::X2);
  CHECK(evdev::button(0x120) == Btn::None);
  CHECK(evdev::isModifierVk(0xA4) && evdev::isModifierVk(0x5C) && !evdev::isModifierVk(0x1B));
  std::printf("%d passed, %d failed\n", g_pass, g_fail);
  return g_fail == 0 ? 0 : 1;
}
