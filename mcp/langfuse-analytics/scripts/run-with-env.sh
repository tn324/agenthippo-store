#!/bin/bash
#
# Copyright (c) AgentHippo.ai. All rights reserved.
#
# Run the MCP server with Langfuse credentials from .env.local

export LANGFUSE_SECRET_KEY="sk-lf-427333f6-80ca-440e-bb6b-6cfaaa02c8d3"
export LANGFUSE_PUBLIC_KEY="pk-lf-80ec7ea4-03a5-46b2-aed1-d8f2812101bc"
export LANGFUSE_BASE_URL="http://localhost:3001"

exec node "$(dirname "$0")/../dist/index.js"

