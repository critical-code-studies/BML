#!/bin/sh
# Render tools/share-card.html to share.png, the social preview.
#
# Headless Chrome, because the card is a PAGE: it uses the site's own colours,
# font stack and banner art, so the two cannot drift apart. A drawing would.
#
#   sh tools/make-share-card.sh
set -e
HERE=$(cd "$(dirname "$0")/.." && pwd)
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -x "$CHROME" ] || { echo "no Chrome at $CHROME" >&2; exit 2; }
"$CHROME" --headless --disable-gpu --hide-scrollbars \
  --screenshot="$HERE/share.png" --window-size=1200,630 \
  "file://$HERE/tools/share-card.html" >/dev/null 2>&1
echo "wrote $HERE/share.png"
