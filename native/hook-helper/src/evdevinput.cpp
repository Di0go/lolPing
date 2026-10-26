#include "evdevinput.h"
#include <array>
namespace lp::evdev {
namespace {
struct Entry { uint16_t code; uint8_t vk; };
// Codes from <linux/input-event-codes.h>; the header is not needed for a table this small.
constexpr Entry kKeys[] = {
  {1, 0x1B}, {2, '1'}, {3, '2'}, {4, '3'}, {5, '4'}, {6, '5'}, {7, '6'}, {8, '7'}, {9, '8'}, {10, '9'}, {11, '0'},
  {12, 0xBD}, {13, 0xBB}, {14, 0x08}, {15, 0x09},
  {16, 'Q'}, {17, 'W'}, {18, 'E'}, {19, 'R'}, {20, 'T'}, {21, 'Y'}, {22, 'U'}, {23, 'I'}, {24, 'O'}, {25, 'P'},
  {26, 0xDB}, {27, 0xDD}, {28, 0x0D}, {29, 0xA2},
  {30, 'A'}, {31, 'S'}, {32, 'D'}, {33, 'F'}, {34, 'G'}, {35, 'H'}, {36, 'J'}, {37, 'K'}, {38, 'L'},
  {39, 0xBA}, {40, 0xDE}, {41, 0xC0}, {42, 0xA0}, {43, 0xDC},
  {44, 'Z'}, {45, 'X'}, {46, 'C'}, {47, 'V'}, {48, 'B'}, {49, 'N'}, {50, 'M'},
  {51, 0xBC}, {52, 0xBE}, {53, 0xBF}, {54, 0xA1}, {55, 0x6A}, {56, 0xA4}, {57, 0x20}, {58, 0x14},
  {59, 0x70}, {60, 0x71}, {61, 0x72}, {62, 0x73}, {63, 0x74}, {64, 0x75}, {65, 0x76}, {66, 0x77}, {67, 0x78},
  {68, 0x79}, {69, 0x90}, {70, 0x91},
  {71, 0x67}, {72, 0x68}, {73, 0x69}, {74, 0x6D}, {75, 0x64}, {76, 0x65}, {77, 0x66}, {78, 0x6B},
  {79, 0x61}, {80, 0x62}, {81, 0x63}, {82, 0x60}, {83, 0x6E}, {87, 0x7A}, {88, 0x7B},
  {96, 0x0D}, {97, 0xA3}, {98, 0x6F}, {99, 0x2C}, {100, 0xA5},
  {102, 0x24}, {103, 0x26}, {104, 0x21}, {105, 0x25}, {106, 0x27}, {107, 0x23}, {108, 0x28}, {109, 0x22},
  {110, 0x2D}, {111, 0x2E}, {119, 0x13}, {125, 0x5B}, {126, 0x5C}, {127, 0x5D},
  {183, 0x7C}, {184, 0x7D}, {185, 0x7E}, {186, 0x7F}, {187, 0x80}, {188, 0x81}, {189, 0x82}, {190, 0x83},
  {191, 0x84}, {192, 0x85}, {193, 0x86}, {194, 0x87},
};
}
uint32_t keyToVk(uint32_t code) {
  for (const auto& e : kKeys) if (e.code == code) return e.vk;
  return 0;
}
uint32_t vkToKey(uint32_t vk) {
  // The first entry wins: Enter is typed on the main key, not the keypad's.
  for (const auto& e : kKeys) if (e.vk == vk) return e.code;
  return 0;
}
Btn button(uint32_t code) {
  switch (code) {
    case 0x110: return Btn::Left; case 0x111: return Btn::Right; case 0x112: return Btn::Middle;
    case 0x113: case 0x116: return Btn::X1;  // BTN_SIDE, BTN_BACK
    case 0x114: case 0x115: return Btn::X2;  // BTN_EXTRA, BTN_FORWARD
    default: return Btn::None;
  }
}
bool isModifierVk(uint32_t v) {
  return v == 0x10 || v == 0x11 || v == 0x12 || (v >= 0xA0 && v <= 0xA5) || v == 0x5B || v == 0x5C;
}
}
