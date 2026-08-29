#!/usr/bin/env bash
# runs-in: host — no network, executes nothing fetched.
#
# Stamps a build id and per-file hashes into app.js, writes version.json, and
# copies to the deploy tree. Per-file rather than one version so a running page
# can tell a styling change from a code change: the first is hot-swappable, the
# second needs a reload.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST=/home/user/r/github.com/rtcfirefly/webapps/video-delay
BUILD="$(date -u +%Y%m%d-%H%M%S)"

h() { sha256sum "$1" | cut -c1-12; }
# app.js is hashed with its own stamp lines removed, or stamping would change
# the hash that the stamp records.
JS=$(sed '/^const BUILD = /d;/^const FILES = /d' "$SRC/app.js" | sha256sum | cut -c1-12)
CSS=$(h "$SRC/style.css")
HTML=$(h "$SRC/index.html")

sed -i "s|^const BUILD = '[^']*';|const BUILD = '$BUILD';|" "$SRC/app.js"
sed -i "s|^const FILES = .*|const FILES = { js: '$JS', css: '$CSS', html: '$HTML' };|" "$SRC/app.js"

printf '{"build":"%s","js":"%s","css":"%s","html":"%s"}\n' "$BUILD" "$JS" "$CSS" "$HTML" > "$SRC/version.json"

grep -q "^const BUILD = '$BUILD';" "$SRC/app.js" || { echo "FAILED to stamp BUILD"; exit 1; }
grep -q "^const FILES = { js: '$JS'" "$SRC/app.js" || { echo "FAILED to stamp FILES"; exit 1; }
node --check "$SRC/app.js"

for f in app.js qr.js index.html style.css README.md signal-server.js version.json .nojekyll .gitignore release.sh; do
  cp "$SRC/$f" "$DEST/$f"
done

# The harness is part of the project, not a local scratch dir. Its output is
# gitignored; the code is not.
mkdir -p "$DEST/tools/shots" "$DEST/test"
cp "$SRC"/tools/shots/{Dockerfile,run.sh,shoot.py} "$DEST/tools/shots/"
cp "$SRC"/test/pair.html "$DEST/test/"
echo "build $BUILD  js=$JS css=$CSS html=$HTML -> $DEST"
