#!/usr/bin/env bash
# Generates the committed audio fixtures under tests/fixtures/audio (spec/roadmap.md Phase 3, S3.2).
#
#   sample.m4a     ~20 s spoken paragraph about blog0 — macOS `say` → AIFF → `afconvert` (AAC, mono)
#   sample.mp3     the same reading — Homebrew `ffmpeg` (libmp3lame, mono, 48 kbps)
#   not-audio.wav  1 s of silence (a real WAV: readable by any probe, but NOT an accepted upload)
#   sample.json    { "mp3": { durationMs, bytes, sha256 }, "m4a": {…}, "wav": {…} } — the values the
#                  tests assert against (durations from ffprobe, rounded to whole milliseconds)
#
# macOS only (say + afconvert ship with the OS; ffmpeg from Homebrew). Run from the repo root:
#   bash scripts/make-audio-fixture.sh
# Each spoken file must stay ≤ 400 KB (checked below). Re-running regenerates everything.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/tests/fixtures/audio"
FFMPEG="${FFMPEG:-/opt/homebrew/bin/ffmpeg}"
FFPROBE="${FFPROBE:-$(dirname "$FFMPEG")/ffprobe}"
MAX_BYTES=409600

for tool in say afconvert "$FFMPEG" "$FFPROBE" shasum; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "make-audio-fixture: missing tool: $tool" >&2
    exit 1
  fi
done

TEXT="blog0 is a small publishing platform for writers who want every article to reach readers in more than one shape. \
You write once in Markdown. The same text becomes a readable page, a short slide deck, and a spoken reading you can listen to. \
Nothing is generated behind your back; every format is reviewed before it is published. Readers pick the shape that fits their moment."

mkdir -p "$OUT"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "speaking…"
say -v Samantha -r 170 -o "$TMP/sample.aiff" "$TEXT"

echo "m4a (afconvert AAC)…"
afconvert -f m4af -d aac -b 48000 -c 1 "$TMP/sample.aiff" "$OUT/sample.m4a"

echo "mp3 (ffmpeg libmp3lame)…"
"$FFMPEG" -y -loglevel error -i "$TMP/sample.aiff" -ac 1 -ar 22050 -codec:a libmp3lame -b:a 48k -id3v2_version 3 "$OUT/sample.mp3"

echo "not-audio.wav (1 s silence)…"
"$FFMPEG" -y -loglevel error -f lavfi -i anullsrc=r=8000:cl=mono -t 1 -c:a pcm_s16le "$OUT/not-audio.wav"

duration_ms() {
  # ffprobe prints seconds with 6 decimals; round to whole milliseconds.
  "$FFPROBE" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$1" |
    awk '{ printf "%d", ($1 * 1000) + 0.5 }'
}
bytes_of() { stat -f %z "$1"; }
sha256_of() { shasum -a 256 "$1" | awk '{ print $1 }'; }

entry() {
  local file="$1"
  printf '{ "durationMs": %s, "bytes": %s, "sha256": "%s" }' "$(duration_ms "$file")" "$(bytes_of "$file")" "$(sha256_of "$file")"
}

for f in sample.m4a sample.mp3; do
  size="$(bytes_of "$OUT/$f")"
  if [ "$size" -gt "$MAX_BYTES" ]; then
    echo "make-audio-fixture: $f is $size bytes (> $MAX_BYTES) — shorten TEXT or lower the bitrate" >&2
    exit 1
  fi
done

{
  echo '{'
  echo "  \"text\": \"$TEXT\","
  echo "  \"mp3\": $(entry "$OUT/sample.mp3"),"
  echo "  \"m4a\": $(entry "$OUT/sample.m4a"),"
  echo "  \"wav\": $(entry "$OUT/not-audio.wav")"
  echo '}'
} > "$OUT/sample.json"

echo "wrote:"
ls -l "$OUT"
cat "$OUT/sample.json"
