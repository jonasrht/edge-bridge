#!/bin/sh
# Renders docs/logo*.svg into the extension icons. Needs a Chrome/Chromium binary in $CHROME.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
: "${CHROME:?set CHROME to a Chrome or Chromium binary}"
TMP=$(mktemp -d)
for size in 16 32 48 128; do
  src=logo.svg
  [ "$size" -le 16 ] && src=logo-small.svg
  printf '<style>html,body{margin:0;background:transparent}</style><img src="file://%s/docs/%s" width="%s" height="%s">' "$ROOT" "$src" "$size" "$size" > "$TMP/i.html"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --default-background-color=00000000 \
    --force-device-scale-factor=1 --window-size="$size,$size" --screenshot="$ROOT/extension/icons/$size.png" "file://$TMP/i.html" 2>/dev/null
done
rm -rf "$TMP"
