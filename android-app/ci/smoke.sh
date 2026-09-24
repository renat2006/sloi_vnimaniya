#!/usr/bin/env bash
# Запускается внутри эмулятора: ставит APK, стартует приложение, проверяет что оно живо и не упало.
set -euo pipefail
APK="$1"
PKG=site.renat.sloi

adb install -r "$APK"
adb logcat -c
adb shell am start -n "$PKG/.MainActivity"
sleep 20

if ! adb shell pidof "$PKG" >/dev/null; then
  echo "::error::приложение не запущено (процесс не найден)"
  adb logcat -d | tail -60
  exit 1
fi
if adb logcat -d | grep -q "FATAL EXCEPTION"; then
  echo "::error::в логе есть FATAL EXCEPTION"
  adb logcat -d | grep -A15 "FATAL EXCEPTION" | head -40
  exit 1
fi
adb shell dumpsys package "$PKG" | grep -E "versionName|versionCode" | head -2
adb exec-out screencap -p > smoke-screenshot.png || true
echo "smoke ok"
