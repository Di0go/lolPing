#pragma once
#include <cstdint>
#include "decision.h"
namespace lp::evdev {
// Linux evdev key and button codes -> the platform-neutral values used by the shared protocol (KWin backend).
// Keys map by physical position, like the X11 backend's XKB names, so a trigger key survives a layout change.
uint32_t keyToVk(uint32_t code);
// The evdev code a VK is typed with when it has to be replayed (0 = none).
uint32_t vkToKey(uint32_t vk);
Btn button(uint32_t code);
bool isModifierVk(uint32_t vk);
}
