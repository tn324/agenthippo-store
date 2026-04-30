#!/usr/bin/env bash
# Backwards-compatible wrapper. Prefer convert-all-plugins.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/convert-all-plugins.sh" "$@"
