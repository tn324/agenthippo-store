# Custom agent engines

## Purpose

Custom engines are how **your** agent runtime—an SDK you already use, a vendor CLI, or an internal stack—plugs into AgentHippo’s chat and automation surface.

AgentHippo keeps a single stable envelope around the conversation: session identity, locking, workspace context, model selection, optional LiteLLM routing, and UI wiring. **Your engine adapter** is responsible only for mapping that envelope onto your native runtime (streaming, tools, memory, resume semantics).

You do **not** need AgentHippo source code or a fork of the IDE to ship an engine. You ship two files (plus optional npm metadata), install them where AgentHippo looks, and your engine id appears alongside built-in modes.

## What this enables

- **Bring your own runtime** — Wrap an existing Node-capable SDK or a subprocess CLI without rewriting how it thinks about sessions or tools.
- **Same engine, IDE and CLI** — One adapter works for interactive chat and for headless `ask` / `serve` style flows when your distribution exposes them.
- **Isolation-friendly hosting** — AgentHippo provisions managed directories and a per-turn environment object so adapters can store auth, cache, and transcripts predictably.
- **Distribution** — Engines can live in the workspace for development or under the user’s AgentHippo home for installs shared across projects (including store-style distribution where your product supports it).

---

## How integration works (overview)

1. You publish a directory named after a stable **engine id** (lowercase, hyphen-safe).
2. **`engine.manifest.json`** (format **version 2**) declares display metadata, default model hints, optional workspace sync for rules/skills folders, and which env vars receive resolved API keys or base URLs.
3. **`engine.mjs`** exports an adapter class or object whose **`run(turn)`** method drives one chat turn: stream assistant output and tool events back through `turn.emitter`, optionally return a **`nativeSessionId`** for resume.
4. AgentHippo calls **`run(turn)`** with the **current user message only** in `turn.message`. Prior turns stay in **your** runtime unless you explicitly replay them—do not duplicate AgentHippo’s transcript inside the adapter.

---

## Directory layout

Install each engine under an AgentHippo engines root:

```text
<engines-root>/<engine-id>/
├── engine.manifest.json    # v2 manifest
├── engine.mjs              # adapter with run(turn)
├── package.json            # optional — if the adapter depends on npm packages
└── package-lock.json       # required when package.json is present
```

If your distribution ships a zero-dependency **`engine-contract.d.ts`** type stub for editors, you may place it beside `engine.mjs`; it is optional and not required at runtime.

---

## Manifest (version 2) — what to declare

Typical fields:

- **`version`** — Must be `2`.
- **`id`** — Same as the folder name; used for `--engine`, session keys, and mode routing.
- **`entry`** — Path to the adapter module (usually `./engine.mjs`).
- **`engineExport`** — Named export for the adapter class; omit to use the default export.
- **`displayName` / `description`** — Shown in UI pickers.
- **`homeEnvVar`** — Optional. AgentHippo puts `engineHomeDir` into **`turn.env`** under this name. It does **not** set global `process.env` for you.
- **`workspaceSync`** — Optional. Lets AgentHippo materialize a derived folder in the workspace (for example rules and skills your CLI reads from a fixed relative path).
- **`promptInjection`** — Optional. Controls whether runtime paths are appended to the user message, env-only, or omitted.
- **`model`** — Optional defaults and wiring: `defaultModel`, `apiKeyEnvVar`, `baseUrlEnvVar`, `openaiBaseUrlEnvVar` so routing can populate provider-specific variables your SDK expects.

Exact semantics evolve with the product; use **`agent-engine-creator`** (below) when authoring so your assistant follows current guardrails.

---

## Adapter contract — `run(turn)`

Your adapter receives a **`turn`** object including:

- **`turn.message`** — Only this turn’s user text.
- **`turn.modelId`** — Resolved model id (use this rather than re-resolving defaults).
- **`turn.workspaceRoot`** and **`turn.additionalDirectories`** — Filesystem scope.
- **`turn.permissions`** — Normalized file-access envelope.
- **`turn.env`** — Merged environment for **this** turn (routing, `AGENTHIPPO_*` paths, manifest-driven keys). Apply it yourself: e.g. pass **`env: turn.env`** to **`spawn`**. Do not assume the host mirrored everything onto global **`process.env`**; concurrent chats share one Node process.
- **`turn.routing`** — Structured API key and base URL fields when you prefer parameters over env vars.
- **`turn.session`** — Conversation key, managed **`engineHomeDir`** / **`engineSessionDir`**, optional **`nativeSessionId`** from a prior turn, and paths to exported context/attachments when enabled.
- **`turn.emitter`** — Callbacks for text, thinking, tools, progress, errors, and **`done()`**.
- **`turn.signal`** — Abort signal when the user cancels.

Return **`{ nativeSessionId }`** when your runtime exposes a stable resume handle; otherwise persist state under the provided directories.

Optional lifecycle hooks if your distribution supports them: **`onMaintenance`**, **`dispose`**.

---

## Where AgentHippo loads engines from

Engines are discovered from (first match wins depending on product configuration):

- **Workspace:** `.agent-hippo/engines` under the opened workspace.
- **User home:** `~/.agent-hippo/engines/<engine-id>/` (common for shared or store-installed engines).

Environment variables such as **`AGENTHIPPO_CUSTOM_ENGINES_DIR`** or **`AGENTIDE_CUSTOM_ENGINES_DIR`** may override or add roots when your distribution documents them.

---

## Validation

- Run **`node --check engine.mjs`** on the adapter file.
- Exercise **`--engine <your-id>`** in real IDE chat and in CLI flows your product provides.
- Confirm multi-turn behavior using the same outer session id and one user message per request for HTTP-style APIs.

---

## Help from an AI assistant

When using Cursor or another environment that loads AgentHippo skills, invoke the **`agent-engine-creator`** skill for step-by-step authoring: manifest checklist, CLI versus SDK patterns, routing notes, templates, and pitfalls (history duplication, env concurrency, LiteLLM routing expectations).
