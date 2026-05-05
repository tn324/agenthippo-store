---
name: agent-engine-installer
description: Install, update, and validate AgentHippo custom engines such as Gemini or OpenClaw by copying selected engine adapters from a Git checkout/cache into ~/.agent-hippo/engines/<id>. Use when a user wants to distribute, install, test, or refresh custom engines without setting AGENTHIPPO_CUSTOM_ENGINES_DIR.
---

# Agent Engine Installer

Install only the requested custom engine into the default AgentHippo discovery
folder:

```text
~/.agent-hippo/engines/<engine-id>/
```

This makes the engine visible to both the AgentHippo CLI runtime and the IDE mode
picker without setting `AGENTHIPPO_CUSTOM_ENGINES_DIR`.

## Default Install

Use the bundled Node script. This is the preferred cross-platform entrypoint on
Windows, macOS, and Linux:

```bash
node <skill_location>/scripts/install-engine.mjs gemini
```

The script:

1. Clones or updates the source repo in
   `~/.agent-hippo/cache/custom-engines/agenthippoai-custom-engines`.
2. Copies only the selected engine folder into `~/.agent-hippo/engines/<id>`.
3. Runs `npm ci --omit=dev` when the engine has `package.json`.
4. Parses `engine.manifest.json`.
5. Runs `node --check` on the manifest entry file.

Install more than one engine:

```bash
node <skill_location>/scripts/install-engine.mjs gemini openclaw
```

On Windows, the PowerShell wrapper remains available:

```powershell
powershell -ExecutionPolicy Bypass -File <skill_location>\scripts\install-engine.ps1 gemini
```

## Source Override

Use `-SourceRoot` when testing from an existing checkout or local folder:

```bash
node <skill_location>/scripts/install-engine.mjs gemini --source-root D:/agenthippo-engines
```

The source root must contain one directory per engine:

```text
D:\agenthippo-engines\
  gemini\
    engine.manifest.json
    engine.mjs
    package.json
    package-lock.json
  openclaw\
    engine.manifest.json
    engine.mjs
```

Use platform-native paths:

```bash
node <skill_location>/scripts/install-engine.mjs gemini --source-root /Users/me/agenthippo-engines
node <skill_location>/scripts/install-engine.mjs gemini --source-root D:/agenthippo-engines
```

## Update

Re-run the same install command. The script refreshes the cache repo, replaces
the installed engine adapter/dependencies, and leaves engine runtime/session
state alone because that state is managed outside the installed adapter folder.

## Validation

After install, verify discovery:

```powershell
agenthippo ask "Reply OK" --engine gemini --model gemini-2.5-flash
```

For LiteLLM-routed Gemini:

```powershell
$env:AGENTHIPPO_LITELLM_BASE_URL = "http://127.0.0.1:4000"
$env:AGENTHIPPO_LITELLM_API_KEY = "dummy"
agenthippo ask "Reply OK" --engine gemini --model "gemini/gemini-flash-latest"
```

## Notes

- Do not commit credentials, `.env.local`, or signing files while installing
  engines.
- Keep third-party/private engines as separate folders under
  `~/.agent-hippo/engines`.
- Use `AGENTHIPPO_CUSTOM_ENGINES_DIR` only for CI or temporary roots where home
  installation is not desired.
