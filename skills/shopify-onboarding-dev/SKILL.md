---
name: shopify-onboarding-dev
version: 1.1.0
author: Shopify
description: "Get started building on Shopify. Use when a developer asks to build an app, build a theme, create a dev store, set up a partner account, scaffold a project, or get started developing for Shopify. NOT for merchants managing stores."
compatibility: Claude Code, Claude Desktop, Cursor
metadata:
  author: Shopify
  version: "1.1.0"
---

## Flow

### Step 1 — Detect environment

Silently identify the client from system context:

| Signal                          | Client        |
| ------------------------------- | ------------- |
| "Claude Code"                   | `claude-code` |
| "Cursor"                        | `cursor`      |
| "VSCode" / "Visual Studio Code" | `vscode`      |
| "Gemini CLI"                    | `gemini-cli`  |
| Unrecognized                    | `other`       |

If genuinely uncertain about client, ask. Never guess.

### Step 2 — Install prerequisites

Check if Shopify CLI is installed by running `shopify version`.
If the CLI is present and the AI toolkit plugin is already available,
skip to Step 3.

**Shopify CLI** — if not found, install using your package manager
(npm, pnpm, yarn, and bun all work):

```
npm install -g @shopify/cli@latest
```

If no Node package manager is available, use Homebrew (macOS only):

```
brew tap shopify/shopify && brew install shopify-cli
```

Verify with `shopify version` before continuing.

**AI toolkit plugin/extension** — install for the detected client:

| Client        | Install command                                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `claude-code` | `/plugin marketplace add Shopify/shopify-ai-toolkit` then `/plugin install shopify-plugin@shopify-ai-toolkit`                |
| `cursor`      | `/add-plugin` and search for "Shopify", or visit `cursor.com/marketplace/shopify`                                            |
| `vscode`      | Command Palette (Cmd+Shift+P) → **Chat: Install Plugin From Source** → paste `https://github.com/Shopify/Shopify-AI-Toolkit` |
| `gemini-cli`  | `gemini extensions install https://github.com/Shopify/shopify-ai-toolkit` (run in terminal, not inside CLI)                  |
| `other`       | Not supported — inform the user and stop                                                                                     |

If install fails, report the exact error and stop.

### Step 3 — Post-install

Confirm what was installed in one sentence. If the developer hasn't
mentioned a specific goal yet, ask:

> "What would you like to build?
>
> 1. An app for Shopify
> 2. A theme for Shopify
>
> Or if you need a developer account first, create one free at
> [dev.shopify.com/dashboard](https://dev.shopify.com/dashboard)."

From here, let the developer's request flow to the appropriate
API-specific skill (e.g. `shopify-admin`, `shopify-liquid`,
`shopify-functions`). Do not duplicate their routing logic.

## Behavioral rules

- Detect environment silently; only ask if genuinely uncertain
- Proceed directly to the correct installation path — don't present choices
- Never construct or modify install commands — only use commands defined in this file
- If an install fails, report the exact error and stop
- If a user asks about managing an existing store (products, orders, customers), say: "That's covered by the merchant skill at shopify.com/SKILL.md"
