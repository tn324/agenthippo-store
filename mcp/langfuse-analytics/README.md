# Langfuse Analytics MCP Server

MCP server that provides tools for querying Langfuse analytics data (costs, latencies, errors).

## Tools

| Tool | Description |
|------|-------------|
| `langfuse_list_sessions` | List recent sessions with filtering |
| `langfuse_list_traces` | List traces with filtering |
| `langfuse_get_trace` | Get detailed trace information |
| `langfuse_cost_summary` | Aggregate costs by model/session/user |
| `langfuse_latency_summary` | Latency statistics by model/name/session |
| `langfuse_error_patterns` | Find error patterns in traces |

## Setup

### 1. Install dependencies

```bash
cd extensions/agentide/base-prompts/mcp-servers/langfuse-analytics
npm install
```

### 2. Build

```bash
npm run build
```

### 3. Configure environment

Create a `.env` file in your workspace root:

```bash
LANGFUSE_BASE_URL=http://localhost:3000
LANGFUSE_SECRET_KEY=sk-lf-your-secret-key
LANGFUSE_PUBLIC_KEY=pk-lf-your-public-key
```

Or export them directly:

```bash
export LANGFUSE_BASE_URL=http://localhost:3000
export LANGFUSE_SECRET_KEY=sk-lf-your-secret-key
export LANGFUSE_PUBLIC_KEY=pk-lf-your-public-key
```

### 4. Enable in Agent Hippo

The bundled `.mcp.json` is automatically synced to `.agent-hippo/agents/default/mcp/.mcp.json` on first run:

```json
{
  "mcpServers": {
    "langfuse-analytics": {
      "command": "enable-bundled",
      "env": {
        "LANGFUSE_SECRET_KEY": "${env:LANGFUSE_SECRET_KEY}",
        "LANGFUSE_PUBLIC_KEY": "${env:LANGFUSE_PUBLIC_KEY}",
        "LANGFUSE_BASE_URL": "${env:LANGFUSE_BASE_URL}"
      }
    }
  }
}
```

## Testing

### Test Langfuse API connection (without MCP)

```bash
node scripts/test-client.js
```

### Test MCP server

```bash
npm test
# or
node scripts/test-server.js
```

## Development

Watch mode for development:

```bash
npm run dev
```

## Usage

The server runs via stdio and follows the MCP protocol. It's designed to be:
1. Started by Agent Hippo's MCP infrastructure
2. Configured via `.mcp.json` with `enable-bundled` command
3. Automatically passed to Claude and Codex SDKs

### Manual testing with MCP Inspector

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

## Example Queries

### Get cost breakdown by model

```json
{
  "name": "langfuse_cost_summary",
  "arguments": {
    "groupBy": "model",
    "limit": 20
  }
}
```

### Find slow operations

```json
{
  "name": "langfuse_latency_summary",
  "arguments": {
    "groupBy": "name",
    "fromDate": "2026-01-01"
  }
}
```

### List recent errors

```json
{
  "name": "langfuse_error_patterns",
  "arguments": {
    "groupBy": "error",
    "limit": 50
  }
}
```

