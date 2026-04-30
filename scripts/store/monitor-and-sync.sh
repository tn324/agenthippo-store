#!/usr/bin/env bash
# Backwards-compatible one-shot wrapper. Prefer sync-store.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "${1:-once}" in
	once)
		shift || true
		exec "$SCRIPT_DIR/sync-store.sh" --all "$@"
		;;
	status|watch|daemon|stop)
		echo "monitor-and-sync.sh has been replaced by sync-store.sh for deterministic store syncs." >&2
		echo "Run: $SCRIPT_DIR/sync-store.sh --all" >&2
		exit 2
		;;
	*)
		exec "$SCRIPT_DIR/sync-store.sh" "$@"
		;;
esac
