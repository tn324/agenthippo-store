---
name: shopify-onboarding-merchant
version: 1.1.0
author: Shopify
description: "Set up and connect a Shopify store from AgentHippo. Use when the user wants to: set up my Shopify store, connect my store, get started with Shopify, manage my store, add products to my store, merchant onboarding, start selling online, Shopify setup help, create my first store, import products, migrate from Square, migrate from WooCommerce, migrate from Etsy, migrate from Amazon, migrate from eBay, migrate from Wix, import from Google Merchant Center, migrate from Clover, migrate from Lightspeed, move products to Shopify, import catalog, replatform to Shopify. This is for store owners, not developers."
compatibility: AgentHippo
context: fork
metadata:
  author: Shopify
  version: "1.1.0"
---

## Flow

### Step 1 - Clarify the Merchant Goal

Ask one concise question if the user's goal is unclear. Common merchant goals include creating a new store, connecting an existing store, adding products, importing a catalog, migrating from another platform, reviewing orders, or preparing to start selling.

If the user asks about building apps, themes, extensions, Functions, Admin GraphQL, Storefront GraphQL, or developer stores, route to `shopify-onboarding-dev`.

### Step 2 - Confirm Shopify Access

Ask whether the user already has a Shopify store or needs to create one.

- Existing store: ask for the store URL or myshopify domain and confirm they can sign in.
- New store: direct them to create a Shopify account and store, then return here for setup.
- Migration/import: ask for the source platform and whether they have a CSV export or API access.

### Step 3 - Install AgentHippo Artifacts

Install the Shopify developer MCP and merchant-relevant skills from AgentHippo Store when they are not already available:

```
agenthippo store install mcp/shopify-dev-mcp
agenthippo store install skill/shopify-dev
agenthippo store install skill/shopify-admin
```

If any install fails, report the exact error and stop. For product, order, customer, inventory, and catalog workflows, use the installed Shopify skills instead of fetching external instructions.

### Step 4 - Route the Work

- Product or catalog setup: use Shopify Admin guidance and ask for product data, images, variants, pricing, inventory, and collections.
- Orders or customers: use Shopify Admin guidance and ask whether the user needs lookup, reporting, or an action.
- Migration: collect source platform, export format, fields available, and data quality constraints before proposing an import plan.
- Store setup: walk through store identity, payments, shipping, taxes, policies, theme, domain, and launch checklist.

## Behavioral Rules

- Keep the workflow merchant-focused and avoid developer setup unless the user asks for custom apps or themes.
- Use AgentHippo Store artifacts and installed Shopify skills as the source of assistant behavior.
- Do not fetch external skill instructions at runtime.
- Ask before taking any action that changes store data, sends customer communication, or affects payments, shipping, taxes, or fulfillment.
