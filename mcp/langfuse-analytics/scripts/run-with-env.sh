#!/usr/bin/env bash
set -euo pipefail
#
# Copyright (c) AgentHippo.ai. All rights reserved.
#
# Run the MCP server with Langfuse credentials from .env.local (never commit secrets).

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT}/.env.local"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: missing ${ENV_FILE}" >&2
  echo "Copy ${ROOT}/.env.local.example to .env.local and add your Langfuse keys." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

: "${LANGFUSE_SECRET_KEY:?Set LANGFUSE_SECRET_KEY in .env.local}"
: "${LANGFUSE_PUBLIC_KEY:?Set LANGFUSE_PUBLIC_KEY in .env.local}"

export LANGFUSE_BASE_URL="${LANGFUSE_BASE_URL:-http://localhost:3001}"

exec node "${ROOT}/dist/index.js"
