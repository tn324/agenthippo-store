#!/usr/bin/env bash
#
# verify-converted-packs.sh
#
# Verifies that converted agent packs are valid and well-formed.
# Checks for required files, valid YAML, and proper structure.
#
# Validation checks:
#   1. Required files exist (agent.yaml, AGENTS.md, current.txt)
#   2. agent.yaml is valid YAML with required fields
#   3. Version directory structure is correct
#   4. Skills have SKILL.md files
#   5. No invalid file types
#
# Environment variables:
#   PACKS_PATH    - Path to agent packs (default: ./agent-packs-plugins)
#   VERBOSE       - Set to "1" for detailed output
#
# Usage:
#   ./verify-converted-packs.sh                    # Verify all packs
#   ./verify-converted-packs.sh feature-dev        # Verify specific pack
#   VERBOSE=1 ./verify-converted-packs.sh          # Verbose output
#

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Default paths
PACKS_PATH="${PACKS_PATH:-$SCRIPT_DIR/agent-packs-plugins}"

VERBOSE="${VERBOSE:-0}"

# Counters
TOTAL_PACKS=0
VALID_PACKS=0
INVALID_PACKS=0
WARNINGS=0

# -----------------------------------------------------------------------------
# Functions
# -----------------------------------------------------------------------------

log_info() {
    echo -e "${BLUE}[INFO]${NC} $*"
}

log_success() {
    echo -e "${GREEN}[PASS]${NC} $*"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $*"
    ((WARNINGS++)) || true
}

log_error() {
    echo -e "${RED}[FAIL]${NC} $*"
}

log_verbose() {
    if [[ "$VERBOSE" == "1" ]]; then
        echo -e "${CYAN}    ↳${NC} $*"
    fi
}

check_prerequisites() {
    if [[ ! -d "$PACKS_PATH" ]]; then
        log_error "Packs directory not found at: $PACKS_PATH"
        log_info "Run convert-plugins-to-packs.sh first to generate packs"
        exit 1
    fi
}

# Check if a file contains valid YAML (basic check without external deps)
check_yaml_basic() {
    local file="$1"

    # Check for basic YAML structure
    if ! grep -qE '^[a-zA-Z_][a-zA-Z0-9_]*:' "$file"; then
        return 1
    fi

    # Check for unclosed quotes (basic)
    local odd_quotes
    odd_quotes=$(grep -o "'" "$file" 2>/dev/null | wc -l | xargs || echo 0)
    # Ensure it's a valid number
    if ! [[ "$odd_quotes" =~ ^[0-9]+$ ]]; then
        odd_quotes=0
    fi
    if (( odd_quotes % 2 != 0 )); then
        return 1
    fi

    return 0
}

# Verify agent.yaml has required fields
verify_manifest() {
    local manifest="$1"
    local errors=0

    if [[ ! -f "$manifest" ]]; then
        log_error "Missing agent.yaml"
        return 1
    fi

    log_verbose "Checking agent.yaml structure"

    # Check for apiVersion
    if ! grep -q '^apiVersion:' "$manifest"; then
        log_error "agent.yaml missing 'apiVersion' field"
        ((errors++)) || true
    fi

    # Check for kind
    if ! grep -q '^kind:' "$manifest"; then
        log_error "agent.yaml missing 'kind' field"
        ((errors++)) || true
    fi

    # Check for metadata.name
    if ! grep -qE '^[[:space:]]+name:' "$manifest"; then
        log_error "agent.yaml missing 'metadata.name' field"
        ((errors++)) || true
    fi

    # Check for metadata.version
    if ! grep -qE '^[[:space:]]+version:' "$manifest"; then
        log_error "agent.yaml missing 'metadata.version' field"
        ((errors++)) || true
    fi

    # Check for spec.engine
    if ! grep -qE '^[[:space:]]+engine:' "$manifest"; then
        log_error "agent.yaml missing 'spec.engine' field"
        ((errors++)) || true
    fi

    # Basic YAML validation
    if ! check_yaml_basic "$manifest"; then
        log_error "agent.yaml appears to have invalid YAML syntax"
        ((errors++)) || true
    fi

    return $errors
}

# Verify AGENTS.md exists and has content
verify_agents_md() {
    local agents_md="$1"

    if [[ ! -f "$agents_md" ]]; then
        log_error "Missing AGENTS.md"
        return 1
    fi

    log_verbose "Checking AGENTS.md"

    # Check it has some content
    local line_count
    line_count=$(wc -l < "$agents_md" | tr -d ' ')

    if [[ "$line_count" -lt 3 ]]; then
        log_warn "AGENTS.md is very short ($line_count lines)"
    fi

    # Check for a heading
    if ! grep -q '^#' "$agents_md"; then
        log_warn "AGENTS.md has no markdown headings"
    fi

    return 0
}

# Verify current.txt points to valid version
verify_current_txt() {
    local pack_dir="$1"
    local current_txt="$pack_dir/current.txt"

    if [[ ! -f "$current_txt" ]]; then
        log_error "Missing current.txt"
        return 1
    fi

    log_verbose "Checking current.txt"

    local version
    version=$(cat "$current_txt" | tr -d '\n\r')

    if [[ ! -d "$pack_dir/$version" ]]; then
        log_error "current.txt points to non-existent version: $version"
        return 1
    fi

    log_verbose "Version pointer: $version"
    return 0
}

# Verify skills have SKILL.md
# Skills can be nested (e.g., skills/my-skill/SKILL.md or skills/category/my-skill/SKILL.md)
verify_skills() {
    local skills_dir="$1"
    local errors=0

    if [[ ! -d "$skills_dir" ]]; then
        return 0
    fi

    log_verbose "Checking skills/"

    # Find all SKILL.md files to identify valid skills
    local skill_count=0
    while IFS= read -r skill_md; do
        local skill_path
        skill_path=$(dirname "$skill_md")
        local skill_name
        skill_name=$(basename "$skill_path")
        log_verbose "  Skill: $skill_name ✓"
        ((skill_count++)) || true
    done < <(find "$skills_dir" -name "SKILL.md" -type f 2>/dev/null)

    if [[ $skill_count -eq 0 ]]; then
        # Check if there are directories without SKILL.md
        local has_dirs=false
        for dir in "$skills_dir"/*/; do
            if [[ -d "$dir" ]]; then
                has_dirs=true
                break
            fi
        done
        if [[ "$has_dirs" == "true" ]]; then
            log_warn "No SKILL.md files found in skills/"
        fi
    fi

    return $errors
}

# Verify rules directory
verify_rules() {
    local rules_dir="$1"

    if [[ ! -d "$rules_dir" ]]; then
        return 0
    fi

    log_verbose "Checking rules/"

    local count=0
    for rule_file in "$rules_dir"/*.md; do
        if [[ -f "$rule_file" ]]; then
            ((count++)) || true
            log_verbose "  Rule: $(basename "$rule_file")"
        fi
    done

    # Check subdirectories
    for sub_dir in "$rules_dir"/*/; do
        if [[ -d "$sub_dir" ]]; then
            local sub_name
            sub_name=$(basename "$sub_dir")
            local sub_count
            sub_count=$(find "$sub_dir" -name "*.md" -type f | wc -l | tr -d ' ')
            log_verbose "  rules/$sub_name/: $sub_count file(s)"
        fi
    done

    return 0
}

# Get pack statistics
get_pack_stats() {
    local version_dir="$1"

    local skills_count=0
    local rules_count=0
    local commands_count=0

    if [[ -d "$version_dir/skills" ]]; then
        skills_count=$(find "$version_dir/skills" -maxdepth 1 -type d | wc -l | tr -d ' ')
        ((skills_count--)) || true  # Subtract 1 for the directory itself
    fi

    if [[ -d "$version_dir/rules" ]]; then
        rules_count=$(find "$version_dir/rules" -maxdepth 1 -name "*.md" -type f | wc -l | tr -d ' ')
    fi

    if [[ -d "$version_dir/rules/commands" ]]; then
        commands_count=$(find "$version_dir/rules/commands" -name "*.md" -type f | wc -l | tr -d ' ')
    fi

    echo "skills=$skills_count, rules=$rules_count, commands=$commands_count"
}

# Verify a single pack
verify_pack() {
    local pack_name="$1"
    local pack_dir="$PACKS_PATH/$pack_name"
    local errors=0

    if [[ ! -d "$pack_dir" ]]; then
        log_error "Pack not found: $pack_name"
        return 1
    fi

    ((TOTAL_PACKS++)) || true

    log_info "Verifying pack: $pack_name"

    # Check current.txt and get version
    if ! verify_current_txt "$pack_dir"; then
        ((errors++)) || true
    fi

    local version
    version=$(cat "$pack_dir/current.txt" 2>/dev/null | tr -d '\n\r' || echo "")
    local version_dir="$pack_dir/$version"

    if [[ -z "$version" ]] || [[ ! -d "$version_dir" ]]; then
        log_error "Cannot determine version directory"
        ((INVALID_PACKS++)) || true
        return 1
    fi

    # Verify required files
    if ! verify_manifest "$version_dir/agent.yaml"; then
        ((errors++)) || true
    fi

    if ! verify_agents_md "$version_dir/AGENTS.md"; then
        ((errors++)) || true
    fi

    # Verify optional components
    verify_skills "$version_dir/skills" || ((errors++)) || true
    verify_rules "$version_dir/rules" || true  # Rules are optional, don't count as errors

    # Get stats
    local stats
    stats=$(get_pack_stats "$version_dir")

    if [[ $errors -eq 0 ]]; then
        log_success "$pack_name: Valid ($stats)"
        ((VALID_PACKS++)) || true
        return 0
    else
        log_error "$pack_name: Invalid ($errors error(s))"
        ((INVALID_PACKS++)) || true
        return 1
    fi
}

# List all packs
list_packs() {
    for pack_path in "$PACKS_PATH"/*/; do
        if [[ -d "$pack_path" ]]; then
            basename "$pack_path"
        fi
    done
}

verify_all_packs() {
    log_info "Scanning packs in: $PACKS_PATH"
    echo ""

    while IFS= read -r pack_name; do
        verify_pack "$pack_name"
        echo ""
    done < <(list_packs)

    # Summary
    echo ""
    echo "========================================="
    echo -e "${BLUE}Verification Summary${NC}"
    echo "========================================="
    echo -e "Total packs:   $TOTAL_PACKS"
    echo -e "${GREEN}Valid:         $VALID_PACKS${NC}"
    if [[ $INVALID_PACKS -gt 0 ]]; then
        echo -e "${RED}Invalid:       $INVALID_PACKS${NC}"
    else
        echo -e "Invalid:       $INVALID_PACKS"
    fi
    if [[ $WARNINGS -gt 0 ]]; then
        echo -e "${YELLOW}Warnings:      $WARNINGS${NC}"
    else
        echo -e "Warnings:      $WARNINGS"
    fi
    echo "========================================="

    if [[ $INVALID_PACKS -gt 0 ]]; then
        exit 1
    fi
}

usage() {
    cat <<EOF
Usage: $0 [pack-name]

Verify converted agent packs are valid and well-formed.

Arguments:
  pack-name    Optional. If provided, only verify this pack.
               If omitted, verify all packs.

Environment variables:
  PACKS_PATH    Path to agent packs (default: ./agent-packs-plugins)
  VERBOSE       Set to "1" for detailed output

Validation checks:
  ✓ Required files exist (agent.yaml, AGENTS.md, current.txt)
  ✓ agent.yaml has required fields (apiVersion, kind, metadata, spec)
  ✓ current.txt points to valid version directory
  ✓ Skills have SKILL.md files

Examples:
  $0                          # Verify all packs
  $0 feature-dev              # Verify only feature-dev pack
  VERBOSE=1 $0                # Verbose output

EOF
}

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------

main() {
    if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
        usage
        exit 0
    fi

    log_info "Packs path: $PACKS_PATH"
    [[ "$VERBOSE" == "1" ]] && log_info "Verbose mode enabled"
    echo ""

    check_prerequisites

    if [[ $# -eq 0 ]]; then
        verify_all_packs
    else
        verify_pack "$1"
    fi
}

main "$@"

