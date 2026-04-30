---
name: shopify-onboarding-dev
version: 1.1.0
author: Shopify
description: "Get started building on Shopify. Use when a developer asks to build an app, build a theme, create a dev store, set up a partner account, scaffold a project, or get started developing for Shopify. NOT for merchants managing stores."
compatibility: AgentHippo
metadata:
  author: Shopify
  version: "1.1.0"
---

## Flow

### Step 1 - Install Prerequisites

Check if Shopify CLI is installed by running `shopify version`.
If the CLI is present, continue to AgentHippo artifact setup.

**Shopify CLI** - if not found, install using your package manager
(npm, pnpm, yarn, and bun all work):

```
npm install -g @shopify/cli@latest
```

If no Node package manager is available, use Homebrew (macOS only):

```
brew tap shopify/shopify && brew install shopify-cli
```

Verify with `shopify version` before continuing.

### Step 2 - Install AgentHippo Artifacts

Install the Shopify developer MCP and the relevant Shopify skills from AgentHippo Store:

```
agenthippo store install mcp/shopify-dev-mcp
agenthippo store install skill/shopify-dev
agenthippo store install skill/shopify-admin
agenthippo store install skill/shopify-liquid
agenthippo store install skill/shopify-functions
```

Add narrower Shopify skills as needed for the user's goal, such as `shopify-hydrogen`, `shopify-storefront-graphql`, or Polaris extension skills.
If any install fails, report the exact error and stop.

### Step 3 - Post-Install

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

- Use AgentHippo Store artifacts as the installation path
- Proceed directly with setup when the user's goal is clear
- Never construct or modify install commands — only use commands defined in this file
- If an install fails, report the exact error and stop
- If a user asks about managing an existing store (products, orders, customers), route to the `shopify-onboarding-merchant` skill
