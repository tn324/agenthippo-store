#!/usr/bin/env bash
#
# Copy standalone skills from Claude Code plugins into agenthippo-store/skills.
#
# Claude Code plugins can contain skills at:
#   <plugins-dir>/<plugin-name>/skills/<skill-name>/SKILL.md
#
# Usage:
#   scripts/store/push-claude-plugin-skills-to-store.sh
#   scripts/store/push-claude-plugin-skills-to-store.sh frontend-design
#   DRY_RUN=1 scripts/store/push-claude-plugin-skills-to-store.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STORE_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

SKILLS_REPO_PATH="${SKILLS_REPO_PATH:-$STORE_ROOT/../claude-code/plugins}"
STORE_REPO_PATH="${STORE_REPO_PATH:-$STORE_ROOT}"
DRY_RUN="${DRY_RUN:-0}"
DEFAULT_SKILL_VERSION="${DEFAULT_SKILL_VERSION:-1.0.0}"

log() {
	printf '%s\n' "$*"
}

usage() {
	cat <<EOF
Usage: $0 [--all] [skill-name ...]

Copies skills embedded in Claude Code plugins into agenthippo-store/skills.

Options:
  --all       Copy all skills (default when no skill names are passed)
  -h, --help  Show this help

Environment:
  SKILLS_REPO_PATH  Path to claude-code/plugins checkout
  STORE_REPO_PATH   Path to agenthippo-store (default: current repo)
  DRY_RUN=1         Preview without writing
  DEFAULT_SKILL_VERSION  Version added when copied skills omit one (default: 1.0.0)
EOF
}

check_prerequisites() {
	if [[ ! -d "$SKILLS_REPO_PATH" ]]; then
		log "ERROR: Claude Code plugins directory not found: $SKILLS_REPO_PATH" >&2
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

find_skill_path() {
	local skill_name="$1"
	find "$SKILLS_REPO_PATH" -path "*/skills/$skill_name/SKILL.md" -type f -print -quit \
		| sed 's#/SKILL.md$##'
}

frontmatter_value() {
	local file="$1"
	local key="$2"
	awk -v key="$key" '
		NR == 1 && $0 == "---" { in_frontmatter = 1; next }
		in_frontmatter && $0 == "---" { exit }
		in_frontmatter && $0 ~ ("^" key ":") {
			sub("^[^:]+:[[:space:]]*", "")
			gsub(/^"|"$/, "")
			gsub(/^'\''|'\''$/, "")
			print
			exit
		}
	' "$file"
}

ensure_frontmatter_key() {
	local file="$1"
	local key="$2"
	local value="$3"

	if [[ -n "$(frontmatter_value "$file" "$key")" ]]; then
		return 0
	fi

	local tmp_file
	tmp_file="$(mktemp)"
	if [[ "$(sed -n '1p' "$file")" == "---" ]]; then
		awk -v line="$key: $value" '
			NR == 1 { print; next }
			$0 == "---" && !inserted { print line; inserted = 1 }
			{ print }
		' "$file" > "$tmp_file"
	else
		{
			printf '%s\n' "---" "$key: $value" "---"
			cat "$file"
		} > "$tmp_file"
	fi
	mv "$tmp_file" "$file"
}

copy_skill_dir() {
	local skill_dir="$1"
	local skill_name
	skill_name="$(basename "$skill_dir")"

	if [[ ! -f "$skill_dir/SKILL.md" ]]; then
		log "WARN: Skipping $skill_name: missing SKILL.md" >&2
		return 0
	fi

	local dest_path="$STORE_REPO_PATH/skills/$skill_name"
	if [[ "$DRY_RUN" == "1" ]]; then
		log "[DRY RUN] Would copy $skill_dir -> $dest_path"
		return 0
	fi

	local existing_version=""
	local preserved_license=""
	if [[ -f "$dest_path/SKILL.md" ]]; then
		existing_version="$(frontmatter_value "$dest_path/SKILL.md" version || true)"
	fi
	if [[ -f "$dest_path/LICENSE.txt" && ! -f "$skill_dir/LICENSE.txt" ]]; then
		preserved_license="$(mktemp)"
		cp "$dest_path/LICENSE.txt" "$preserved_license"
	fi

	rm -rf "$dest_path"
	cp -R "$skill_dir" "$dest_path"
	if [[ -n "$preserved_license" ]]; then
		cp "$preserved_license" "$dest_path/LICENSE.txt"
		rm -f "$preserved_license"
	fi
	ensure_frontmatter_key "$dest_path/SKILL.md" version "${existing_version:-$DEFAULT_SKILL_VERSION}"
	log "Copied Claude skill: $skill_name"
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

	log "Claude plugins dir: $SKILLS_REPO_PATH"
	log "Store repo:         $STORE_REPO_PATH"
	[[ "$DRY_RUN" == "1" ]] && log "DRY RUN: no files will be changed"
	log ""

	check_prerequisites

	local count=0
	local failed=0
	if [[ ${#requested[@]} -eq 0 ]]; then
		while IFS= read -r skill_md; do
			local skill_dir
			skill_dir="$(dirname "$skill_md")"
			if copy_skill_dir "$skill_dir"; then
				count=$((count + 1))
			else
				failed=$((failed + 1))
			fi
		done < <(find "$SKILLS_REPO_PATH" -path "*/skills/*/SKILL.md" -type f | sort)
	else
		local skill_name
		for skill_name in "${requested[@]}"; do
			local skill_dir
			skill_dir="$(find_skill_path "$skill_name")"
			if [[ -z "$skill_dir" ]]; then
				log "ERROR: Claude plugin skill not found: $skill_name" >&2
				failed=$((failed + 1))
				continue
			fi
			if copy_skill_dir "$skill_dir"; then
				count=$((count + 1))
			else
				failed=$((failed + 1))
			fi
		done
	fi

	log ""
	log "Claude skills copied: $count"
	log "Failed: $failed"

	if [[ "$DRY_RUN" != "1" ]]; then
		log ""
		git -C "$STORE_REPO_PATH" status --short skills/ || true
	fi

	[[ "$failed" -eq 0 ]]
}

main "$@"
