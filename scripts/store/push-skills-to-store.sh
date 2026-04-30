#!/usr/bin/env bash
#
# Copy OpenClaw skills into agenthippo-store/skills.
#
# Usage:
#   scripts/store/push-skills-to-store.sh             # all skills
#   scripts/store/push-skills-to-store.sh canvas      # one skill
#   DRY_RUN=1 scripts/store/push-skills-to-store.sh   # preview
#
# Environment:
#   SKILLS_REPO_PATH    Path to openclaw/skills checkout
#   STORE_REPO_PATH     Path to agenthippo-store
#   DRY_RUN             Set to 1 to preview
#   OPENCLAW_ARCHIVE_ALL Set to 1 to import every nested ClawHub archive skill
#   OPENCLAW_IMPORT_LIMIT Optional max number of skills to import when copying all

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STORE_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

default_skills_repo_path() {
	local candidate
	for candidate in "$STORE_ROOT/../openclaw-skills" "$STORE_ROOT/../skills"; do
		if [[ -d "$candidate/.git" ]]; then
			local remote
			remote="$(git -C "$candidate" remote get-url origin 2>/dev/null || true)"
			if [[ "$remote" == *"openclaw/skills"* ]]; then
				cd "$candidate" && pwd
				return
			fi
		fi
	done
	cd "$STORE_ROOT/../openclaw-skills" 2>/dev/null && pwd || printf '%s\n' "$STORE_ROOT/../openclaw-skills"
}

SKILLS_REPO_PATH="${SKILLS_REPO_PATH:-$(default_skills_repo_path)}"
STORE_REPO_PATH="${STORE_REPO_PATH:-$STORE_ROOT}"
DRY_RUN="${DRY_RUN:-0}"
OPENCLAW_ARCHIVE_ALL="${OPENCLAW_ARCHIVE_ALL:-0}"
OPENCLAW_IMPORT_LIMIT="${OPENCLAW_IMPORT_LIMIT:-0}"

log() {
	printf '%s\n' "$*"
}

usage() {
	cat <<EOF
Usage: $0 [--all] [skill-name ...]

Copies skills from an openclaw/skills checkout into agenthippo-store/skills.

Options:
  --all       Copy all skills (default when no skill names are passed)
  -h, --help  Show this help

Environment:
  SKILLS_REPO_PATH  Path to openclaw/skills checkout
  STORE_REPO_PATH   Path to agenthippo-store (default: current repo)
  DRY_RUN=1         Preview without writing
  OPENCLAW_ARCHIVE_ALL=1  Import every nested ClawHub archive skill
  OPENCLAW_IMPORT_LIMIT=n Limit all-skill imports to n copied skills
EOF
}

check_prerequisites() {
	if [[ ! -d "$SKILLS_REPO_PATH" ]]; then
		log "ERROR: Skills repo not found: $SKILLS_REPO_PATH" >&2
		log "Run scripts/store/sync-store.sh so it can clone https://github.com/openclaw/skills.git, or set SKILLS_REPO_PATH." >&2
		exit 1
	fi

	if [[ ! -d "$SKILLS_REPO_PATH/skills" ]]; then
		log "ERROR: Skills directory not found: $SKILLS_REPO_PATH/skills" >&2
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

find_skill_dir() {
	local skill_name="$1"
	local flat_path="$SKILLS_REPO_PATH/skills/$skill_name"
	if [[ -f "$flat_path/SKILL.md" ]]; then
		printf '%s\n' "$flat_path"
		return 0
	fi

	find "$SKILLS_REPO_PATH/skills" -mindepth 3 -maxdepth 3 -path "*/$skill_name/SKILL.md" -type f -print -quit \
		| sed 's#/SKILL.md$##'
}

copy_skill_dir() {
	local src_path="$1"
	local skill_name
	skill_name="$(basename "$src_path")"
	local dest_path="$STORE_REPO_PATH/skills/$skill_name"

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
	log "Copied skill: $skill_name"
}

copy_skill() {
	local skill_name="$1"
	local src_path
	src_path="$(find_skill_dir "$skill_name")"

	if [[ -z "$src_path" ]]; then
		log "ERROR: Skill not found: $skill_name" >&2
		return 1
	fi

	copy_skill_dir "$src_path"
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

	log "Skills repo: $SKILLS_REPO_PATH"
	log "Store repo:  $STORE_REPO_PATH"
	[[ "$DRY_RUN" == "1" ]] && log "DRY RUN: no files will be changed"
	log ""

	check_prerequisites

	local count=0
	local failed=0
	if [[ ${#requested[@]} -eq 0 ]]; then
		local nested_count
		nested_count="$(find "$SKILLS_REPO_PATH/skills" -mindepth 3 -maxdepth 3 -name SKILL.md -type f | wc -l | tr -d ' ')"
		if [[ "$nested_count" -gt 100 && "$OPENCLAW_ARCHIVE_ALL" != "1" ]]; then
			log "WARN: Detected nested ClawHub archive layout with $nested_count skills."
			log "      Skipping archive-wide import by default; pass named skills or set OPENCLAW_ARCHIVE_ALL=1."
			log "      This avoids importing the entire public archive into the announcement store accidentally."
		fi

		while IFS= read -r skill_md; do
			local skill_path
			skill_path="$(dirname "$skill_md")"
			if copy_skill_dir "$skill_path"; then
				count=$((count + 1))
			else
				failed=$((failed + 1))
			fi
			if [[ "$OPENCLAW_IMPORT_LIMIT" != "0" && "$count" -ge "$OPENCLAW_IMPORT_LIMIT" ]]; then
				break
			fi
		done < <(find "$SKILLS_REPO_PATH/skills" -mindepth 2 -maxdepth 2 -name SKILL.md -type f | sort)

		if [[ "$nested_count" -le 100 || "$OPENCLAW_ARCHIVE_ALL" == "1" ]]; then
			while IFS= read -r skill_md; do
				local skill_path
				skill_path="$(dirname "$skill_md")"
				if copy_skill_dir "$skill_path"; then
					count=$((count + 1))
				else
					failed=$((failed + 1))
				fi
				if [[ "$OPENCLAW_IMPORT_LIMIT" != "0" && "$count" -ge "$OPENCLAW_IMPORT_LIMIT" ]]; then
					break
				fi
			done < <(find "$SKILLS_REPO_PATH/skills" -mindepth 3 -maxdepth 3 -name SKILL.md -type f | sort)
		fi
	else
		for skill_name in "${requested[@]}"; do
			if copy_skill "$skill_name"; then
				count=$((count + 1))
			else
				failed=$((failed + 1))
			fi
		done
	fi

	log ""
	log "Skills copied: $count"
	log "Failed: $failed"

	if [[ "$DRY_RUN" != "1" ]]; then
		log ""
		git -C "$STORE_REPO_PATH" status --short skills/ || true
	fi

	[[ "$failed" -eq 0 ]]
}

main "$@"
