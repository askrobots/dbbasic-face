#!/usr/bin/env bash
# Downloads Rhubarb Lip Sync (MIT) into tools/ and checks for required commands.
set -euo pipefail
cd "$(dirname "$0")"

RHUBARB_VERSION="1.14.0"

case "$(uname -s)" in
  Darwin) RHUBARB_OS="macOS" ;;
  Linux)  RHUBARB_OS="Linux" ;;
  *) echo "Unsupported OS: $(uname -s)"; exit 1 ;;
esac

if ls tools/*/rhubarb >/dev/null 2>&1; then
  echo "✓ Rhubarb already present in tools/"
else
  url="https://github.com/DanielSWolf/rhubarb-lip-sync/releases/download/v${RHUBARB_VERSION}/Rhubarb-Lip-Sync-${RHUBARB_VERSION}-${RHUBARB_OS}.zip"
  echo "Downloading Rhubarb Lip Sync ${RHUBARB_VERSION} (${RHUBARB_OS})..."
  mkdir -p tools
  curl -sL -o tools/rhubarb.zip "$url"
  unzip -q -o tools/rhubarb.zip -d tools/
  rm tools/rhubarb.zip
  echo "✓ Rhubarb installed in tools/"
fi

echo
echo "Checking required commands:"
missing=0
for cmd in node ffmpeg ffprobe; do
  if command -v "$cmd" >/dev/null; then echo "  ✓ $cmd"; else echo "  ✗ $cmd  (brew install ${cmd/ffprobe/ffmpeg})"; missing=1; fi
done

echo
echo "TTS engines (at least one needed):"
found_tts=0
for cmd in say espeak espeak-ng; do
  if command -v "$cmd" >/dev/null; then echo "  ✓ $cmd"; found_tts=1; fi
done
[ "$found_tts" = 1 ] || { echo "  ✗ none found — install espeak (brew/apt install espeak) or use macOS"; missing=1; }

echo
if [ "$missing" = 0 ]; then
  echo "All set. Run:  node server.js"
else
  echo "Install the missing pieces above, then run:  node server.js"
fi
