#!/usr/bin/env bash
#
# Copy MCP server manifests into agenthippo-store/mcp.
#
# Usage:
#   MCP_REPO_PATH=../mcp-servers scripts/store/push-mcp-to-store.sh
#   scripts/store/push-mcp-to-store.sh github

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STORE_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

default_mcp_repo_path() {
	for candidate in "$STORE_ROOT/../mcp" "$STORE_ROOT/../mcp-servers" "$STORE_ROOT/mcp"; do
		if [[ -d "$candidate" ]]; then
			cd "$candidate" && pwd
			return
		fi
	done
	printf '%s\n' ""
}

MCP_REPO_PATH="${MCP_REPO_PATH:-$(default_mcp_repo_path)}"
STORE_REPO_PATH="${STORE_REPO_PATH:-$STORE_ROOT}"
DRY_RUN="${DRY_RUN:-0}"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
	cat <<EOF
Usage: $0 [mcp-name ...]

Environment:
  MCP_REPO_PATH    Source directory containing mcp.json or .mcp.json files
  STORE_REPO_PATH  agenthippo-store path (default: current repo)
  DRY_RUN=1        Preview without writing
EOF
	exit 0
fi

if [[ -z "$MCP_REPO_PATH" || ! -d "$MCP_REPO_PATH" ]]; then
	echo "WARN: No MCP source directory found. Set MCP_REPO_PATH or MCP_REPO_URL for sync-store.sh." >&2
	exit 0
fi

args=(
	"$SCRIPT_DIR/push-mcp-to-store.ts"
	"--source" "$MCP_REPO_PATH"
	"--store" "$STORE_REPO_PATH"
)
if [[ "$DRY_RUN" == "1" ]]; then
	args+=("--dry-run")
fi
args+=("$@")

if command -v bun >/dev/null 2>&1; then
	bun run "${args[@]}"
elif command -v npx >/dev/null 2>&1; then
	npx tsx "${args[@]}"
else
	echo "ERROR: Need bun or npx+tsx to run push-mcp-to-store.ts" >&2
	exit 1
fi
