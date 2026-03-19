#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOCS_DIR="$REPO_ROOT/docs"
OUTPUT="$DOCS_DIR/screenshot-home.png"

mkdir -p "$DOCS_DIR"

echo ""
echo "extra-hands screenshot capture"
echo "================================"
echo ""
echo "1. Make sure extra-hands is running (run 'make dev' in another terminal if needed)."
echo "2. Press Enter when you are ready, then click the extra-hands window to capture it."
echo ""
read -r -p "Press Enter to start interactive capture..."

screencapture -i -o "$OUTPUT"

echo ""
echo "Screenshot saved to $OUTPUT"
