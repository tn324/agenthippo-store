#!/usr/bin/env bash
#
# Pull/clone upstream sources, convert artifacts, and copy them into this store.
#
# Examples:
#   scripts/store/sync-store.sh --all
#   scripts/store/sync-store.sh --pack plugin-dev
#   scripts/store/sync-store.sh --skill canvas
#   MCP_REPO_URL=https://github.com/example/mcp-servers.git scripts/store/sync-store.sh --mcp github

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STORE_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

CLAUDE_CODE_REPO_URL="${CLAUDE_CODE_REPO_URL:-https://github.com/anthropics/claude-code.git}"
CLAUDE_CODE_REPO_PATH="${CLAUDE_CODE_REPO_PATH:-$STORE_ROOT/../claude-code}"
OPENCLAW_SKILLS_REPO_URL="${OPENCLAW_SKILLS_REPO_URL:-https://github.com/openclaw/skills.git}"
OPENCLAW_SKILLS_REPO_PATH="${OPENCLAW_SKILLS_REPO_PATH:-$STORE_ROOT/../openclaw-skills}"
MCP_REPO_URL="${MCP_REPO_URL:-}"
MCP_REPO_PATH="${MCP_REPO_PATH:-$STORE_ROOT/../mcp-servers}"

PACK_VERSION="${PACK_VERSION:-1.0.0}"
DRY_RUN="${DRY_RUN:-0}"
PULL_SOURCES=1
BUILD_INDEX=1
VERIFY_INSTALLS=0
VERIFY_TOP=3

DO_PACKS=0
DO_SKILLS=0
DO_MCP=0
PACK_NAMES=()
SKILL_NAMES=()
MCP_NAMES=()

usage() {
	cat <<EOF
Usage: $0 [options]

Source management:
  --no-pull              Do not pull or clone upstream repos
  --dry-run              Preview conversions/copies without writing

Artifact selection:
  --all                  Sync packs, skills, and MCP
  --packs                Sync all Claude Code plugin packs
  --pack <name>          Sync one Claude Code plugin pack (repeatable)
  --skills               Sync all OpenClaw skills
  --skill <name>         Sync one OpenClaw skill (repeatable)
  --mcp                  Sync all MCP manifests from MCP_REPO_PATH
  --mcp-server <name>    Sync one MCP server (repeatable)

Verification:
  --verify-installs      Use agenthippo CLI to install top artifacts after sync
  --top <n>              Number of artifacts per type to install (default: 3)
  --no-build             Skip bun run scripts/build-index.ts

Environment:
  CLAUDE_CODE_REPO_URL       Default: https://github.com/anthropics/claude-code.git
  CLAUDE_CODE_REPO_PATH      Default: ../claude-code
  OPENCLAW_SKILLS_REPO_URL   Default: https://github.com/openclaw/skills.git
  OPENCLAW_SKILLS_REPO_PATH  Default: ../openclaw-skills
  MCP_REPO_URL               Optional; cloned when MCP_REPO_PATH is absent
  MCP_REPO_PATH              Default: ../mcp-servers
  PACK_VERSION               Default: 1.0.0
EOF
}

log() {
	printf '%s\n' "$*"
}

repo_has_tracked_changes() {
	local repo="$1"
	[[ -n "$(git -C "$repo" status --porcelain --untracked-files=no 2>/dev/null || true)" ]]
}

ensure_repo() {
	local path="$1"
	local url="$2"
	local label="$3"

	if [[ "$PULL_SOURCES" != "1" ]]; then
		return 0
	fi

	if [[ "$DRY_RUN" == "1" ]]; then
		if [[ -d "$path/.git" ]]; then
			log "[DRY RUN] Would pull $label: $path"
		elif [[ -n "$url" ]]; then
			log "[DRY RUN] Would clone $label: $url -> $path"
		else
			log "[DRY RUN] No URL configured for $label; would skip clone"
		fi
		return 0
	fi

	if [[ -d "$path/.git" ]]; then
		local remote
		remote="$(git -C "$path" remote get-url origin 2>/dev/null || true)"
		if [[ -n "$url" && "$remote" != "$url" ]]; then
			log "WARN: $label exists at $path with origin $remote, expected $url"
		fi
		if repo_has_tracked_changes "$path"; then
			log "WARN: $label has tracked local changes; skipping pull: $path"
			return 0
		fi
		log "Pulling $label: $path"
		git -C "$path" fetch --prune origin

		local upstream
		upstream="$(git -C "$path" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
		if [[ -n "$upstream" ]]; then
			git -C "$path" merge --ff-only "$upstream"
			return 0
		fi

		local default_branch
		default_branch="$(git -C "$path" remote show origin 2>/dev/null | sed -n '/HEAD branch/s/.*: //p' | head -n 1)"
		if [[ -z "$default_branch" ]]; then
			log "WARN: $label has no upstream branch and origin default branch could not be detected; fetched only."
			return 0
		fi

		local remote_ref="origin/$default_branch"
		if git -C "$path" merge-base --is-ancestor HEAD "$remote_ref"; then
			git -C "$path" merge --ff-only "$remote_ref"
		else
			log "WARN: $label current branch is not fast-forwardable to $remote_ref; fetched only."
			log "      Set the matching *_REPO_PATH environment variable to a clean checkout for announcement sync."
		fi
		return 0
	fi

	if [[ -z "$url" ]]; then
		log "WARN: No URL configured for $label; skipping clone"
		return 0
	fi

	log "Cloning $label"
	log "  $url -> $path"
	git clone "$url" "$path"
}

parse_args() {
	while [[ $# -gt 0 ]]; do
		case "$1" in
			--all)
				DO_PACKS=1
				DO_SKILLS=1
				DO_MCP=1
				shift
				;;
			--packs)
				DO_PACKS=1
				shift
				;;
			--pack)
				if [[ $# -lt 2 ]]; then
					log "ERROR: --pack requires a name" >&2
					exit 2
				fi
				DO_PACKS=1
				PACK_NAMES+=("$2")
				shift 2
				;;
			--skills)
				DO_SKILLS=1
				shift
				;;
			--skill)
				if [[ $# -lt 2 ]]; then
					log "ERROR: --skill requires a name" >&2
					exit 2
				fi
				DO_SKILLS=1
				SKILL_NAMES+=("$2")
				shift 2
				;;
			--mcp)
				DO_MCP=1
				shift
				;;
			--mcp-server)
				if [[ $# -lt 2 ]]; then
					log "ERROR: --mcp-server requires a name" >&2
					exit 2
				fi
				DO_MCP=1
				MCP_NAMES+=("$2")
				shift 2
				;;
			--no-pull)
				PULL_SOURCES=0
				shift
				;;
			--dry-run)
				DRY_RUN=1
				shift
				;;
			--verify-installs)
				VERIFY_INSTALLS=1
				shift
				;;
			--top)
				if [[ $# -lt 2 ]]; then
					log "ERROR: --top requires a number" >&2
					exit 2
				fi
				VERIFY_TOP="$2"
				shift 2
				;;
			--no-build)
				BUILD_INDEX=0
				shift
				;;
			-h|--help)
				usage
				exit 0
				;;
			*)
				log "ERROR: Unknown option: $1" >&2
				usage >&2
				exit 2
				;;
		esac
	done

	if [[ "$DO_PACKS" == "0" && "$DO_SKILLS" == "0" && "$DO_MCP" == "0" ]]; then
		DO_PACKS=1
		DO_SKILLS=1
		DO_MCP=1
	fi
}

sync_packs() {
	ensure_repo "$CLAUDE_CODE_REPO_PATH" "$CLAUDE_CODE_REPO_URL" "claude-code"

	local plugins_dir="$CLAUDE_CODE_REPO_PATH/plugins"
	if [[ ! -d "$plugins_dir" ]]; then
		if [[ "$DRY_RUN" == "1" ]]; then
			log "DRY RUN: Claude Code plugins directory is not present yet; skipping pack conversion preview."
			return 0
		fi
		log "ERROR: Claude Code plugins directory not found: $plugins_dir" >&2
		return 1
	fi

	log ""
	log "Converting Claude Code plugins"
	if [[ ${#PACK_NAMES[@]} -gt 0 ]]; then
		PLUGINS_REPO_PATH="$plugins_dir" \
			OUTPUT_PATH="$SCRIPT_DIR/agent-packs-plugins" \
			PACK_VERSION="$PACK_VERSION" \
			DRY_RUN="$DRY_RUN" \
			"$SCRIPT_DIR/convert-all-plugins.sh" "${PACK_NAMES[@]}"
	else
		PLUGINS_REPO_PATH="$plugins_dir" \
			OUTPUT_PATH="$SCRIPT_DIR/agent-packs-plugins" \
			PACK_VERSION="$PACK_VERSION" \
			DRY_RUN="$DRY_RUN" \
			"$SCRIPT_DIR/convert-all-plugins.sh"
	fi

	if [[ "$DRY_RUN" == "1" ]]; then
		log ""
		log "DRY RUN: skipping pack copy because conversion output was not written"
		return 0
	fi

	log ""
	log "Copying converted packs into store"
	if [[ ${#PACK_NAMES[@]} -gt 0 ]]; then
		PACKS_PATH="$SCRIPT_DIR/agent-packs-plugins" \
			STORE_REPO_PATH="$STORE_ROOT" \
			DRY_RUN="$DRY_RUN" \
			VERIFY_FIRST=1 \
			"$SCRIPT_DIR/push-packs-to-store.sh" "${PACK_NAMES[@]}"
	else
		PACKS_PATH="$SCRIPT_DIR/agent-packs-plugins" \
			STORE_REPO_PATH="$STORE_ROOT" \
			DRY_RUN="$DRY_RUN" \
			VERIFY_FIRST=1 \
			"$SCRIPT_DIR/push-packs-to-store.sh"
	fi
}

sync_skills() {
	ensure_repo "$CLAUDE_CODE_REPO_PATH" "$CLAUDE_CODE_REPO_URL" "claude-code"
	ensure_repo "$OPENCLAW_SKILLS_REPO_PATH" "$OPENCLAW_SKILLS_REPO_URL" "openclaw-skills"

	local plugins_dir="$CLAUDE_CODE_REPO_PATH/plugins"
	if [[ -d "$plugins_dir" ]]; then
		log ""
		log "Copying Claude Code plugin skills into store"
		SKILLS_REPO_PATH="$plugins_dir" \
			STORE_REPO_PATH="$STORE_ROOT" \
			DRY_RUN="$DRY_RUN" \
			"$SCRIPT_DIR/push-claude-plugin-skills-to-store.sh"
	elif [[ "$DRY_RUN" == "1" ]]; then
		log "DRY RUN: Claude Code plugins directory is not present yet; skipping Claude skill copy preview."
	else
		log "WARN: Claude Code plugins directory not found; skipping Claude skill copy: $plugins_dir"
	fi

	if [[ ! -d "$OPENCLAW_SKILLS_REPO_PATH/skills" && "$DRY_RUN" == "1" ]]; then
		log "DRY RUN: OpenClaw skills checkout is not present yet; skipping skill copy preview."
		return 0
	fi

	log ""
	log "Copying OpenClaw skills into store"
	if [[ ${#SKILL_NAMES[@]} -gt 0 ]]; then
		SKILLS_REPO_PATH="$OPENCLAW_SKILLS_REPO_PATH" \
			STORE_REPO_PATH="$STORE_ROOT" \
			DRY_RUN="$DRY_RUN" \
			"$SCRIPT_DIR/push-skills-to-store.sh" "${SKILL_NAMES[@]}"
	else
		SKILLS_REPO_PATH="$OPENCLAW_SKILLS_REPO_PATH" \
			STORE_REPO_PATH="$STORE_ROOT" \
			DRY_RUN="$DRY_RUN" \
			"$SCRIPT_DIR/push-skills-to-store.sh"
	fi
}

sync_mcp() {
	ensure_repo "$MCP_REPO_PATH" "$MCP_REPO_URL" "mcp"

	if [[ ! -d "$MCP_REPO_PATH" ]]; then
		log "WARN: MCP source directory not found; skipping MCP sync."
		log "      Set MCP_REPO_PATH, or set MCP_REPO_URL so this script can clone it."
		return 0
	fi

	log ""
	log "Copying MCP manifests into store"
	if [[ ${#MCP_NAMES[@]} -gt 0 ]]; then
		MCP_REPO_PATH="$MCP_REPO_PATH" \
			STORE_REPO_PATH="$STORE_ROOT" \
			DRY_RUN="$DRY_RUN" \
			"$SCRIPT_DIR/push-mcp-to-store.sh" "${MCP_NAMES[@]}"
	else
		MCP_REPO_PATH="$MCP_REPO_PATH" \
			STORE_REPO_PATH="$STORE_ROOT" \
			DRY_RUN="$DRY_RUN" \
			"$SCRIPT_DIR/push-mcp-to-store.sh"
	fi
}

build_index() {
	if [[ "$BUILD_INDEX" != "1" || "$DRY_RUN" == "1" ]]; then
		return 0
	fi
	log ""
	log "Building store index"
	( cd "$STORE_ROOT" && bun run scripts/build-index.ts )
}

verify_installs() {
	if [[ "$VERIFY_INSTALLS" != "1" || "$DRY_RUN" == "1" ]]; then
		return 0
	fi
	log ""
	log "Verifying store installs via agenthippo CLI"
	"$SCRIPT_DIR/verify-store-installs.sh" --top "$VERIFY_TOP" --allow-missing
}

main() {
	parse_args "$@"

	log "Store root: $STORE_ROOT"
	log "Dry run: $DRY_RUN"
	log ""

	if [[ "$DO_PACKS" == "1" ]]; then
		sync_packs
	fi
	if [[ "$DO_SKILLS" == "1" ]]; then
		sync_skills
	fi
	if [[ "$DO_MCP" == "1" ]]; then
		sync_mcp
	fi

	build_index
	verify_installs

	log ""
	log "Store sync complete"
	git -C "$STORE_ROOT" status --short agent-packs/ skills/ mcp/ dist/ scripts/store package.json || true
}

main "$@"
