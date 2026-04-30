#!/usr/bin/env bash
#
# Convert Claude Code plugins to AgentHippo agent pack staging output.
#
# Usage:
#   scripts/store/convert-all-plugins.sh                 # all plugins
#   scripts/store/convert-all-plugins.sh plugin-dev      # one plugin
#   DRY_RUN=1 scripts/store/convert-all-plugins.sh --all # preview
#
# Environment:
#   PLUGINS_REPO_PATH   Path to claude-code/plugins
#   OUTPUT_PATH         Staging output path
#   PACK_VERSION        Version for converted packs
#   DRY_RUN             Set to 1 to preview

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STORE_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PLUGINS_REPO_PATH="${PLUGINS_REPO_PATH:-$(cd "$STORE_ROOT/../claude-code/plugins" 2>/dev/null && pwd || true)}"
OUTPUT_PATH="${OUTPUT_PATH:-$SCRIPT_DIR/agent-packs-plugins}"
PACK_VERSION="${PACK_VERSION:-1.0.0}"
DRY_RUN="${DRY_RUN:-0}"

usage() {
	cat <<EOF
Usage: $0 [--all] [plugin-name ...]

Converts Claude Code plugins into versioned AgentHippo agent pack staging output.

Options:
  --all              Convert all plugins (default when no plugin names are passed)
  -h, --help         Show this help

Environment:
  PLUGINS_REPO_PATH  Path to claude-code/plugins (default: ../claude-code/plugins)
  OUTPUT_PATH        Output path (default: scripts/store/agent-packs-plugins)
  PACK_VERSION       Pack version (default: 1.0.0)
  DRY_RUN=1          Preview without writing
EOF
}

log() {
	printf '%s\n' "$*"
}

run_converter() {
	local plugin_dir="$1"
	local args=(
		"$SCRIPT_DIR/convert-plugin-to-pack.ts"
		"--plugin" "$plugin_dir"
		"--output" "$OUTPUT_PATH"
		"--version" "$PACK_VERSION"
	)
	if [[ "$DRY_RUN" == "1" ]]; then
		args+=("--dry-run")
	fi

	if command -v bun >/dev/null 2>&1; then
		bun run "${args[@]}"
	elif command -v npx >/dev/null 2>&1; then
		npx tsx "${args[@]}"
	else
		log "ERROR: Need bun or npx+tsx to run convert-plugin-to-pack.ts" >&2
		return 1
	fi
}

list_plugins() {
	find "$PLUGINS_REPO_PATH" -mindepth 1 -maxdepth 1 -type d \
		-not -name '.*' \
		-exec test -f '{}/README.md' ';' \
		-print | sort
}

main() {
	local requested=()

	for arg in "$@"; do
		case "$arg" in
			--all)
				;;
			-h|--help)
				usage
				exit 0
				;;
			-*)
				log "ERROR: Unknown option: $arg" >&2
				usage >&2
				exit 2
				;;
			*)
				requested+=("$arg")
				;;
		esac
	done

	if [[ -z "$PLUGINS_REPO_PATH" || ! -d "$PLUGINS_REPO_PATH" ]]; then
		log "ERROR: Claude Code plugins directory not found. Set PLUGINS_REPO_PATH." >&2
		log "Tried: ${PLUGINS_REPO_PATH:-<empty>}" >&2
		exit 1
	fi

	if [[ "$DRY_RUN" != "1" ]]; then
		mkdir -p "$OUTPUT_PATH"
	fi

	log "Converting Claude Code plugins"
	log "  Source: $PLUGINS_REPO_PATH"
	log "  Output: $OUTPUT_PATH"
	log "  Version: $PACK_VERSION"
	log ""

	local total=0
	local failed=0

	if [[ ${#requested[@]} -eq 0 ]]; then
		while IFS= read -r plugin_dir; do
			[[ -z "$plugin_dir" ]] && continue
			if run_converter "$plugin_dir"; then
				total=$((total + 1))
			else
				failed=$((failed + 1))
			fi
			log ""
		done < <(list_plugins)
	else
		for plugin_name in "${requested[@]}"; do
			local plugin_dir="$PLUGINS_REPO_PATH/$plugin_name"
			if [[ ! -d "$plugin_dir" ]]; then
				log "ERROR: Plugin not found: $plugin_name" >&2
				failed=$((failed + 1))
				continue
			fi
			if run_converter "$plugin_dir"; then
				total=$((total + 1))
			else
				failed=$((failed + 1))
			fi
			log ""
		done
	fi

	log "Converted: $total"
	log "Failed: $failed"

	[[ "$failed" -eq 0 ]]
}

main "$@"
