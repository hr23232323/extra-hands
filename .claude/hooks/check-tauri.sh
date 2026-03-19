#!/usr/bin/env bash
# Runs after every Edit/Write tool use.
# If the touched file is inside src-tauri/, verify it compiles.

set -euo pipefail

INPUT=$(cat)
FILE=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('file_path',''))" 2>/dev/null || echo "")

if [[ "$FILE" == *"/src-tauri/"* ]]; then
  REPO=$(echo "$FILE" | sed 's|/src-tauri/.*||')
  MANIFEST="$REPO/src-tauri/Cargo.toml"

  echo "⚙  Tauri file changed — running cargo build to verify..."
  if cargo build --manifest-path "$MANIFEST" 2>&1; then
    echo "✓  cargo build passed"
  else
    echo "✗  cargo build FAILED — fix before handing back to user"
    exit 1
  fi
fi
