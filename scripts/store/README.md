# Store Scripts

All AgentHippo store maintenance scripts live here.

## Sources

- Claude Code plugins and embedded skills: `../claude-code` by default, cloned from `https://github.com/anthropics/claude-code.git` when missing.
- OpenClaw skills: `../openclaw-skills` by default, cloned from `https://github.com/openclaw/skills.git` when missing.
- MCP servers: optional. Set `MCP_REPO_PATH` or `MCP_REPO_URL`.

## Main Workflow

```bash
# Sync packs, Claude Code skills, OpenClaw skills, and MCP, then rebuild the local index.
MCP_REPO_PATH=../agenthippo-vscode/extensions/agentide/base-prompts/mcp-servers \
  scripts/store/sync-store.sh --all --verify-installs --top 3

# Sync one Claude Code plugin as an AgentHippo pack.
scripts/store/sync-store.sh --pack plugin-dev

# Sync all standalone skills from Claude Code plugins and OpenClaw.
scripts/store/sync-store.sh --skills

# Sync one OpenClaw skill by name.
scripts/store/sync-store.sh --skill canvas

# Sync MCP artifacts from a configured MCP source.
MCP_REPO_PATH=../mcp-servers scripts/store/sync-store.sh --mcp

# Preview without changing files.
scripts/store/sync-store.sh --all --dry-run
```

## Per-Type Scripts

| Script | Purpose |
| --- | --- |
| `convert-plugin-to-pack.ts` | Convert one Claude Code plugin to a versioned AgentHippo pack staging folder. |
| `convert-all-plugins.sh` | Convert all or selected Claude Code plugins. |
| `push-packs-to-store.sh` | Copy staged converted packs into `agent-packs/`. |
| `push-claude-plugin-skills-to-store.sh` | Copy skills embedded in Claude Code plugins into `skills/`. |
| `push-skills-to-store.sh` | Copy OpenClaw skills into `skills/`. |
| `push-mcp-to-store.sh` | Copy or split MCP manifests into `mcp/`. |
| `verify-converted-packs.sh` | Validate staged converted packs before pushing them into the store. |
| `verify-store-installs.sh` | Use `agenthippo store search/install` to install and verify top artifacts by type. |

`convert-plugins-to-packs.sh` and `monitor-and-sync.sh` are compatibility wrappers.

## Common Environment

```bash
export CLAUDE_CODE_REPO_PATH=../claude-code
export OPENCLAW_SKILLS_REPO_PATH=../openclaw-skills
export MCP_REPO_PATH=../mcp-servers
export STORE_REPO_PATH=/path/to/agenthippo-store
export PACK_VERSION=1.0.0
export DRY_RUN=1
```

## Verification

```bash
# Install the first 3 search results from each category with the AgentHippo CLI.
scripts/store/verify-store-installs.sh --top 3

# Allow stores with fewer than 3 entries in a category, useful while MCP is empty.
scripts/store/verify-store-installs.sh --top 3 --allow-missing
```

The store index does not currently expose install counts, so "top" means the first results returned by `agenthippo store search`.
