#!/bin/sh
# Builds the KWin plugin (KDE Plasma 6 on Wayland) against the installed KWin: build/lolping.so.
# KWin loads binary plugins only from the exact version they were built for, so rebuild after every KWin update.
set -eu
cd "$(dirname "$0")"
mkdir -p build
CXX=${CXX:-c++}
MOC=${MOC:-$(pkg-config --variable=libexecdir Qt6Core)/moc}
[ -x "$MOC" ] || MOC=/usr/lib/qt6/moc
KWIN_INCLUDE=${KWIN_INCLUDE:-/usr/include/kwin}
[ -f "$KWIN_INCLUDE/plugin.h" ] || { echo "KWin development headers not found in $KWIN_INCLUDE" >&2; exit 1; }
"$MOC" -DQT_NO_KEYWORDS -I"$KWIN_INCLUDE" lolping.cpp -o build/lolping.moc
"$CXX" -std=c++20 -O2 -fPIC -shared -Wall -Wextra -fvisibility=hidden -DQT_NO_KEYWORDS ${CPPFLAGS:-} -Ibuild -I"$KWIN_INCLUDE" \
  -I/usr/include/KF6/KCoreAddons -I/usr/include/KF6/KConfig -I/usr/include/KF6/KConfigCore \
  -I/usr/include/KF6/KWindowSystem $(pkg-config --cflags Qt6Core Qt6Gui Qt6Network) \
  lolping.cpp ../hook-helper/src/decision.cpp ../hook-helper/src/commands.cpp ../hook-helper/src/json.cpp \
  ../hook-helper/src/output.cpp ../hook-helper/src/evdevinput.cpp \
  ${LDFLAGS:-} -lkwin $(pkg-config --libs Qt6Core Qt6Gui Qt6Network) -o build/lolping.so
echo "Built build/lolping.so for KWin $(sed -n 's/.*KWIN_PLUGIN_VERSION_STRING "\(.*\)"/\1/p' "$KWIN_INCLUDE/config-kwin.h")"
