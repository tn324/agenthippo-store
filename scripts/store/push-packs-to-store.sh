#!/usr/bin/env bash
#
# push-packs-to-store.sh
#
# Pushes converted agent packs to the agenthippo-store repository.
# Each pack is copied to agent-packs/<pack-name>/ in the store.
#
# Prerequisites:
#   - git must be installed and configured
#   - agenthippo-store repo must be cloned locally
#   - You must have push access to agenthippo-store
#   - Packs should be verified with verify-converted-packs.sh first
#
# Environment variables:
#   PACKS_PATH        - Path to converted packs (default: ./agent-packs-plugins)
#   STORE_REPO_PATH   - Path to agenthippo-store repo (default: ../../../agenthippo-store)
#   DRY_RUN           - Set to "1" to preview without making changes
#   VERIFY_FIRST      - Set to "0" to skip verification (default: "1")
#
# Usage:
#   ./push-packs-to-store.sh                    # Push all packs
#   ./push-packs-to-store.sh feature-dev        # Push specific pack
#   DRY_RUN=1 ./push-packs-to-store.sh          # Preview changes
#

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STORE_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Default paths
PACKS_PATH="${PACKS_PATH:-$SCRIPT_DIR/agent-packs-plugins}"
STORE_REPO_PATH="${STORE_REPO_PATH:-$STORE_ROOT}"

DRY_RUN="${DRY_RUN:-0}"
VERIFY_FIRST="${VERIFY_FIRST:-1}"

# -----------------------------------------------------------------------------
# Functions
# -----------------------------------------------------------------------------

log_info() {
    echo -e "${BLUE}[INFO]${NC} $*"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $*"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $*"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $*" >&2
}

check_prerequisites() {
    if [[ ! -d "$PACKS_PATH" ]]; then
        log_error "Packs directory not found at: $PACKS_PATH"
        log_info "Run convert-plugins-to-packs.sh first to generate packs"
        exit 1
    fi

    if [[ ! -d "$STORE_REPO_PATH" ]]; then
        log_error "agenthippo-store repo not found at: $STORE_REPO_PATH"
        log_error "Set STORE_REPO_PATH environment variable to the correct path"
        log_info "Clone it with: git clone https://github.com/agenthippoai/agenthippo-store.git"
        exit 1
    fi

    # Ensure store has agent-packs directory
    if [[ "$DRY_RUN" != "1" ]]; then
        mkdir -p "$STORE_REPO_PATH/agent-packs"
    fi
}

# Run verification on a pack
verify_pack() {
    local pack_name="$1"

    if [[ "$VERIFY_FIRST" != "1" ]]; then
        return 0
    fi

    log_info "Verifying $pack_name..."

    if PACKS_PATH="$PACKS_PATH" "$SCRIPT_DIR/verify-converted-packs.sh" "$pack_name" >/dev/null 2>&1; then
        return 0
    else
        log_error "Pack verification failed for: $pack_name"
        log_info "Run: VERBOSE=1 ./verify-converted-packs.sh $pack_name"
        return 1
    fi
}

# Copy pack to store (flattened structure - no version directory in store)
copy_pack() {
    local pack_name="$1"
    local pack_dir="$PACKS_PATH/$pack_name"
    local dest_dir="$STORE_REPO_PATH/agent-packs/$pack_name"

    if [[ ! -d "$pack_dir" ]]; then
        log_error "Pack not found: $pack_name"
        return 1
    fi

    # Get version from current.txt
    local version
    version=$(cat "$pack_dir/current.txt" 2>/dev/null | tr -d '\n\r' || echo "")

    if [[ -z "$version" ]] || [[ ! -d "$pack_dir/$version" ]]; then
        log_error "Cannot determine version for: $pack_name"
        return 1
    fi

    local version_dir="$pack_dir/$version"

    log_info "Processing pack: $pack_name (v$version)"

    if [[ "$DRY_RUN" == "1" ]]; then
        log_info "  [DRY RUN] Would copy $version_dir -> $dest_dir"
        return 0
    fi

    # Verify first
    if ! verify_pack "$pack_name"; then
        return 1
    fi

    # Remove existing and copy fresh
    # Note: We copy the contents of the version directory, not the versioned structure
    # The store uses flat structure (agent-packs/pack-name/) not versioned directories
    rm -rf "$dest_dir"
    cp -r "$version_dir" "$dest_dir"

    log_success "  Copied $pack_name to store"
}

push_all_packs() {
    local count=0
    local failed=0

    log_info "Scanning packs in: $PACKS_PATH"
    echo ""

    for pack_path in "$PACKS_PATH"/*/; do
        if [[ -d "$pack_path" ]]; then
            local pack_name
            pack_name=$(basename "$pack_path")

            if copy_pack "$pack_name"; then
                ((count++)) || true
            else
                ((failed++)) || true
            fi
        fi
    done

    echo ""
    log_info "========================================="
    log_info "Summary:"
    log_info "  Packs pushed: $count"
    [[ $failed -gt 0 ]] && log_warn "  Failed: $failed"
    log_info "========================================="
}

push_single_pack() {
    local pack_name="$1"
    copy_pack "$pack_name"
}

show_git_status() {
    if [[ "$DRY_RUN" == "1" ]]; then
        return
    fi

    echo ""
    log_info "Changes in agenthippo-store:"
    cd "$STORE_REPO_PATH"
    git status --short agent-packs/

    echo ""
    log_info "To commit and push:"
    echo "  cd $STORE_REPO_PATH"
    echo '  git add agent-packs/'
    echo '  git commit -m "feat: add converted agent packs from claude-code plugins"'
    echo '  git push origin main'
}

usage() {
    cat <<EOF
Usage: $0 [pack-name]

Push converted agent packs to the agenthippo-store repository.

Arguments:
  pack-name    Optional. If provided, only push this pack.
               If omitted, push all packs.

Environment variables:
  PACKS_PATH        Path to converted packs (default: ./agent-packs-plugins)
  STORE_REPO_PATH   Path to agenthippo-store (default: ../../../agenthippo-store)
  DRY_RUN           Set to "1" to preview without copying
  VERIFY_FIRST      Set to "0" to skip verification (default: "1")

Examples:
  $0                          # Push all packs
  $0 feature-dev              # Push only feature-dev pack
  DRY_RUN=1 $0                # Preview changes
  VERIFY_FIRST=0 $0           # Skip verification

Workflow:
  1. Run convert-plugins-to-packs.sh to convert plugins
  2. Run verify-converted-packs.sh to validate
  3. Run this script to push to store
  4. Commit and push changes in agenthippo-store

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
    log_info "Store repo: $STORE_REPO_PATH"
    [[ "$DRY_RUN" == "1" ]] && log_warn "DRY RUN mode - no files will be changed"
    [[ "$VERIFY_FIRST" != "1" ]] && log_warn "Verification disabled"
    echo ""

    check_prerequisites

    if [[ $# -eq 0 ]]; then
        push_all_packs
    else
        push_single_pack "$1"
    fi

    show_git_status
}

main "$@"
