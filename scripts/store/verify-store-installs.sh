#!/usr/bin/env bash
#
# Install top store artifacts with the agenthippo CLI and verify expected files.
#
# The store index does not currently expose install counts, so "top" means the
# first results returned by `agenthippo store search` for each type.

set -euo pipefail

TOP=3
AGENT_ID="${AGENT_ID:-default}"
ALLOW_MISSING=0
KEEP_TMP=0

usage() {
	cat <<EOF
Usage: $0 [options]

Options:
  --top <n>          Number of artifacts per type to install (default: 3)
  --agent <id>       Target agent for skill/mcp installs (default: default)
  --allow-missing    Do not fail when fewer than --top artifacts exist
  --keep-tmp         Keep temporary install directories
  -h, --help         Show this help
EOF
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--top)
			if [[ $# -lt 2 ]]; then
				echo "ERROR: --top requires a number" >&2
				exit 2
			fi
			TOP="$2"
			shift 2
			;;
		--agent)
			if [[ $# -lt 2 ]]; then
				echo "ERROR: --agent requires an id" >&2
				exit 2
			fi
			AGENT_ID="$2"
			shift 2
			;;
		--allow-missing)
			ALLOW_MISSING=1
			shift
			;;
		--keep-tmp)
			KEEP_TMP=1
			shift
			;;
		-h|--help)
			usage
			exit 0
			;;
		*)
			echo "ERROR: Unknown option: $1" >&2
			usage >&2
			exit 2
			;;
	esac
done

if ! command -v agenthippo >/dev/null 2>&1; then
	echo "ERROR: agenthippo CLI not found on PATH" >&2
	exit 1
fi

TMP_ROOT="$(mktemp -d)"
TMP_HOME="$TMP_ROOT/home"
TMP_WORKSPACE="$TMP_ROOT/workspace"
mkdir -p "$TMP_HOME" "$TMP_WORKSPACE"

cleanup() {
	if [[ "$KEEP_TMP" == "1" ]]; then
		echo "Kept temp root: $TMP_ROOT"
	else
		rm -rf "$TMP_ROOT"
	fi
}
trap cleanup EXIT

artifact_ids_for_type() {
	local type="$1"
	agenthippo store search --type "$type" --limit "$TOP" --json \
		| node -e 'let input=""; process.stdin.on("data",d=>input+=d); process.stdin.on("end",()=>{const rows=JSON.parse(input||"[]"); for (const row of rows) console.log(row.id);});'
}

verify_one() {
	local type="$1"
	local id="$2"
	local slug="${id#*/}"

	echo "Installing $id"
	HOME="$TMP_HOME" agenthippo store install "$id" \
		--workspace "$TMP_WORKSPACE" \
		--agent "$AGENT_ID" \
		--force >/tmp/agenthippo-store-install.log 2>&1 || {
			cat /tmp/agenthippo-store-install.log >&2
			return 1
		}

	case "$type" in
		pack)
			if ! find "$TMP_HOME/.agent-hippo/agents/$slug" -name agent.yaml -type f 2>/dev/null | grep -q .; then
				echo "ERROR: pack install did not create an agent.yaml for $id" >&2
				return 1
			fi
			;;
		skill)
			if [[ ! -f "$TMP_WORKSPACE/.agent-hippo/agents/$AGENT_ID/skills/$slug/SKILL.md" ]]; then
				echo "ERROR: skill install did not create SKILL.md for $id" >&2
				return 1
			fi
			;;
		mcp)
			if [[ ! -f "$TMP_WORKSPACE/.agent-hippo/agents/$AGENT_ID/mcp/.mcp.json" ]] \
				&& ! find "$TMP_WORKSPACE/.agent-hippo/agents/$AGENT_ID/mcp" -name mcp.json -type f 2>/dev/null | grep -q .; then
				echo "ERROR: mcp install did not create MCP config for $id" >&2
				return 1
			fi
			;;
	esac

	echo "Verified $id"
}

main() {
	local failures=0
	for type in pack skill mcp; do
		echo ""
		echo "Checking top $TOP $type artifact(s)"
		local ids_file="$TMP_ROOT/${type}.ids"
		artifact_ids_for_type "$type" > "$ids_file"
		local found
		found="$(grep -c . "$ids_file" || true)"

		if [[ "$found" -lt "$TOP" ]]; then
			local message="Only found $found $type artifact(s), requested $TOP"
			if [[ "$ALLOW_MISSING" == "1" ]]; then
				echo "WARN: $message"
			else
				echo "ERROR: $message" >&2
				failures=$((failures + 1))
			fi
		fi

		while IFS= read -r id; do
			[[ -n "$id" ]] || continue
			if ! verify_one "$type" "$id"; then
				failures=$((failures + 1))
			fi
		done < "$ids_file"
	done

	echo ""
	if [[ "$failures" -gt 0 ]]; then
		echo "Verification failed: $failures issue(s)" >&2
		exit 1
	fi
	echo "Verification complete"
}

main
