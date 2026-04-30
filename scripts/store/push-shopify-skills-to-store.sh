#!/usr/bin/env bash
#
# Copy Shopify AI Toolkit skills into agenthippo-store/skills.
#
# Usage:
#   scripts/store/push-shopify-skills-to-store.sh
#   scripts/store/push-shopify-skills-to-store.sh shopify-admin shopify-liquid
#   DRY_RUN=1 scripts/store/push-shopify-skills-to-store.sh
#
# Environment:
#   SHOPIFY_AI_TOOLKIT_REPO_PATH  Path to Shopify/shopify-ai-toolkit checkout
#   STORE_REPO_PATH               Path to agenthippo-store
#   DRY_RUN                       Set to 1 to preview

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STORE_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

SHOPIFY_AI_TOOLKIT_REPO_PATH="${SHOPIFY_AI_TOOLKIT_REPO_PATH:-$STORE_ROOT/../shopify-ai-toolkit}"
STORE_REPO_PATH="${STORE_REPO_PATH:-$STORE_ROOT}"
DRY_RUN="${DRY_RUN:-0}"

log() {
	printf '%s\n' "$*"
}

usage() {
	cat <<EOF
Usage: $0 [--all] [skill-name ...]

Copies skills from a Shopify/shopify-ai-toolkit checkout into agenthippo-store/skills.

Options:
  --all       Copy all Shopify AI Toolkit skills (default when no skill names are passed)
  -h, --help  Show this help

Environment:
  SHOPIFY_AI_TOOLKIT_REPO_PATH  Path to Shopify/shopify-ai-toolkit checkout
  STORE_REPO_PATH               Path to agenthippo-store (default: current repo)
  DRY_RUN=1                     Preview without writing
EOF
}

check_prerequisites() {
	if [[ ! -d "$SHOPIFY_AI_TOOLKIT_REPO_PATH" ]]; then
		log "ERROR: Shopify AI Toolkit repo not found: $SHOPIFY_AI_TOOLKIT_REPO_PATH" >&2
		log "Run scripts/store/sync-store.sh so it can clone https://github.com/Shopify/shopify-ai-toolkit.git, or set SHOPIFY_AI_TOOLKIT_REPO_PATH." >&2
		exit 1
	fi

	if [[ ! -d "$SHOPIFY_AI_TOOLKIT_REPO_PATH/skills" ]]; then
		log "ERROR: Shopify skills directory not found: $SHOPIFY_AI_TOOLKIT_REPO_PATH/skills" >&2
		exit 1
	fi

	if [[ ! -f "$SHOPIFY_AI_TOOLKIT_REPO_PATH/package.json" ]]; then
		log "ERROR: Shopify AI Toolkit package.json not found: $SHOPIFY_AI_TOOLKIT_REPO_PATH/package.json" >&2
		exit 1
	fi

	if [[ ! -d "$STORE_REPO_PATH" ]]; then
		log "ERROR: Store repo not found: $STORE_REPO_PATH" >&2
		exit 1
	fi

	if [[ "$DRY_RUN" != "1" ]]; then
		mkdir -p "$STORE_REPO_PATH/skills"
	fi
}

package_field() {
	local field="$1"
	node -e '
const fs = require("fs");
const path = process.argv[1];
const field = process.argv[2];
const pkg = JSON.parse(fs.readFileSync(path, "utf8"));
const value = pkg[field];
if (typeof value === "string") {
  console.log(value);
} else if (value && typeof value.name === "string") {
  console.log(value.name);
}
' "$SHOPIFY_AI_TOOLKIT_REPO_PATH/package.json" "$field"
}

normalize_frontmatter() {
	local skill_md="$1"
	local version="$2"
	local author="$3"

	node -e '
const fs = require("fs");
const skillPath = process.argv[1];
const version = process.argv[2];
const author = process.argv[3];
let content = fs.readFileSync(skillPath, "utf8");
const match = content.match(/^---\n([\s\S]*?)\n---/);
if (!match) process.exit(0);
let frontmatter = match[1];
const additions = [];
if (!/^version:/m.test(frontmatter)) additions.push(`version: ${version}`);
if (author && !/^author:/m.test(frontmatter)) additions.push(`author: ${author}`);
if (!additions.length) process.exit(0);
const lines = frontmatter.split("\n");
let insertAt = lines.findIndex((line, index) => index > 0 && /^[a-zA-Z_-]+:/.test(line));
if (insertAt === -1) insertAt = lines.length;
lines.splice(insertAt, 0, ...additions);
frontmatter = lines.join("\n");
content = `---\n${frontmatter}\n---` + content.slice(match[0].length);
fs.writeFileSync(skillPath, content);
' "$skill_md" "$version" "$author"
}

copy_skill_dir() {
	local src_path="$1"
	local skill_name
	skill_name="$(basename "$src_path")"
	local dest_path="$STORE_REPO_PATH/skills/$skill_name"
	local version="$2"
	local author="$3"

	if [[ ! -d "$src_path" ]]; then
		log "ERROR: Skill not found: $skill_name" >&2
		return 1
	fi
	if [[ ! -f "$src_path/SKILL.md" ]]; then
		log "WARN: Skipping $skill_name: missing SKILL.md" >&2
		return 0
	fi

	if [[ "$DRY_RUN" == "1" ]]; then
		log "[DRY RUN] Would copy $src_path -> $dest_path"
		return 0
	fi

	rm -rf "$dest_path"
	cp -R "$src_path" "$dest_path"
	normalize_frontmatter "$dest_path/SKILL.md" "$version" "$author"
	log "Copied Shopify skill: $skill_name"
}

copy_skill() {
	local skill_name="$1"
	local version="$2"
	local author="$3"
	local src_path="$SHOPIFY_AI_TOOLKIT_REPO_PATH/skills/$skill_name"

	copy_skill_dir "$src_path" "$version" "$author"
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

	log "Shopify AI Toolkit repo: $SHOPIFY_AI_TOOLKIT_REPO_PATH"
	log "Store repo:              $STORE_REPO_PATH"
	[[ "$DRY_RUN" == "1" ]] && log "DRY RUN: no files will be changed"
	log ""

	check_prerequisites

	local version
	local author
	version="$(package_field version)"
	author="$(package_field author)"

	local count=0
	local failed=0
	if [[ ${#requested[@]} -eq 0 ]]; then
		while IFS= read -r skill_md; do
			local skill_path
			skill_path="$(dirname "$skill_md")"
			if copy_skill_dir "$skill_path" "$version" "$author"; then
				count=$((count + 1))
			else
				failed=$((failed + 1))
			fi
		done < <(find "$SHOPIFY_AI_TOOLKIT_REPO_PATH/skills" -mindepth 2 -maxdepth 2 -name SKILL.md -type f | sort)
	else
		for skill_name in "${requested[@]}"; do
			if copy_skill "$skill_name" "$version" "$author"; then
				count=$((count + 1))
			else
				failed=$((failed + 1))
			fi
		done
	fi

	log ""
	log "Shopify skills copied: $count"
	log "Failed: $failed"

	if [[ "$DRY_RUN" != "1" ]]; then
		log ""
		git -C "$STORE_REPO_PATH" status --short skills/ || true
	fi

	[[ "$failed" -eq 0 ]]
}

main "$@"
