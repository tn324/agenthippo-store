---
name: agent-engine-creator
description: Create, plug in, and test an AgentHippo custom agent engine from a developer-owned runtime. Use when adding a v2 engine under .agent-hippo/engines, writing engine.manifest.json and engine.mjs, adapting an SDK/CLI runtime to AgentHippo's custom engine contract, or validating session continuation with AgentHippo CLI/serve and the IDE.
author: agent hippo
---

# Agent Engine Creator

You are helping developers integrate their agent runtime (an SDK or
CLI) into AgentHippo as a custom engine. The developer ships two main files —
`engine.manifest.json` and `engine.mjs` — into a folder AgentHippo discovers at
runtime. They do **not** modify AgentHippo source.

Your job: ask the right questions, generate both files, write a type-contract
stub, run validation, then guide the developer through a smoke test. Drive the
implementation — don't just explain it.

---

## Step 1 — Gather requirements

Ask the developer these questions before writing any code. Collect all answers
before proceeding:

1. **Engine id** — a short, stable slug (e.g. `gemini`, `openclaw`, `myagent`).
   Used in folder names, CLI flags, and session keys. No spaces.
2. **Display name** — human-readable label shown in the mode picker (e.g. `"My Agent"`).
3. **Integration type** — SDK/in-process or CLI subprocess?
   - SDK: the npm package exposes a session/streaming API in Node.js.
   - CLI: the agent surface is a command-line tool the user has installed.
4. **SDK/CLI package name or binary name** — e.g. `@vendor/my-agent-sdk` or `my-agent`.
5. **API key env var** — what env var does their SDK/CLI read for the API key?
   (e.g. `MY_AGENT_API_KEY`)
6. **Model** — default model id (e.g. `gpt-5.5`, `claude-opus-4-7`).
7. **Routing** — does it talk to an OpenAI-compatible endpoint, anthropic etc.?
8. **Workspace sync** — does the runtime discover a workspace config folder
   (like `.gemini`, `.claude`) for rules or skills? If yes, which folder?
9. **Install target** — workspace-local (`.agent-hippo/engines/<id>/`) or home
   library (`~/.agent-hippo/engines/<id>/`)?

If the developer is unsure about routing, default to OpenAI-compatible.
If they skip workspace sync, create one based on the engine name.

---

## Step 2 — Create the engine folder

Create the folder at the chosen install target:

```
.agent-hippo/engines/<engine-id>/
  engine.manifest.json
  engine.mjs
  engine-contract.d.ts   ← type stub for editor support
```

If the engine uses npm packages, also create `package.json` here and tell the
developer to run `npm install` in this folder before testing.

---

## Step 3 — Generate `engine.manifest.json`

Fill in all fields the developer provided. Omit optional fields they skipped.

```json
{
  "version": 2,
  "id": "<engine-id>",
  "displayName": "<Display Name>",
  "description": "<one-line description>",
  "entry": "./engine.mjs",
  "engineExport": "<ClassName>",
  "homeEnvVar": "<ENGINE_HOME_ENV_VAR>",
  "workspaceSync": {
    "enabled": true,
    "dir": ".<engine-id>",
    "rulesFile": "<ENGINE>.md",
    "includeSkills": true,
    "includeRules": true
  },
  "promptInjection": {
    "mode": "message-suffix"
  },
  "model": {
    "defaultModel": "<default-model-id>",
    "apiKeyEnvVar": "<THEIR_API_KEY_VAR>",
    "openaiBaseUrlEnvVar": "<THEIR_BASE_URL_VAR>"
  }
}
```

**Field rules:**
- `version` must be `2`.
- `engineExport` is the named export class in `engine.mjs`; omit if using default export.
- `homeEnvVar` value becomes `turn.session.engineHomeDir` — injected into `turn.env` only, not global `process.env`.
- `promptInjection.mode`: use `message-suffix` unless the developer requests `none` or `env-only`.
- Use `openaiBaseUrlEnvVar` for OpenAI-compatible SDKs/CLIs; use `baseUrlEnvVar` for provider-native (Gemini, Anthropic).
- Omit `workspaceSync` entirely if the developer said no to workspace sync.

---

## Step 4 — Generate `engine.mjs`

Choose the right template based on integration type.

### SDK template

Use when an npm package exposes the real session/streaming API.

```js
// @ts-check
import { randomUUID, createHash } from 'node:crypto';

const SDK_PACKAGE = '<@vendor/package>';
const IDLE_TTL_MS = 1000 * 60 * 30;

let sdkPromise;
async function loadSdk() {
  if (!sdkPromise) {
    sdkPromise = import(SDK_PACKAGE).catch(err => {
      sdkPromise = undefined;
      throw new Error(`Missing ${SDK_PACKAGE}. Run: npm install --prefix ~/.agent-hippo/engines/<id>. ${err.message}`);
    });
  }
  return sdkPromise;
}

function resolveAuth(turn) {
  return {
    apiKey: turn.routing.apiKey || turn.env.<THEIR_API_KEY_VAR> || 'sk-dummy',
    baseUrl: turn.routing.openaiBaseUrl || turn.routing.baseUrl,
    model: turn.modelId,
  };
}

function authHash(auth) {
  return createHash('sha256').update(JSON.stringify(auth)).digest('hex');
}

export class <ClassName> {
  #sessions = new Map();

  async run(turn) {
    const sdk = await loadSdk();
    const auth = resolveAuth(turn);
    const fingerprint = authHash(auth);

    let state = this.#sessions.get(turn.session.key);
    if (!state) {
      const id = turn.session.nativeSessionId?.trim() || `agenthippo-${randomUUID()}`;
      const client = new sdk.Client({
        apiKey: auth.apiKey,
        baseUrl: auth.baseUrl,
        homeDir: turn.session.engineHomeDir,
        workspaceRoot: turn.workspaceRoot,
      });
      const session = await client.createSession({
        id,
        model: auth.model,
        sessionDir: turn.session.engineSessionDir,
        rulesFile: turn.agent.rulesFilePath,
        skillsDir: turn.agent.skillsDir,
      });
      state = { client, session, nativeSessionId: id, authHash: fingerprint, lastUsedAt: Date.now() };
      this.#sessions.set(turn.session.key, state);
    } else {
      if (state.authHash !== fingerprint) {
        await state.client.updateAuth?.({ apiKey: auth.apiKey, baseUrl: auth.baseUrl });
        state.authHash = fingerprint;
      }
      await state.session.setModel?.(auth.model);
      state.lastUsedAt = Date.now();
    }

    const abort = () => void state?.session.abort?.().catch(() => {});
    turn.signal?.addEventListener('abort', abort, { once: true });
    try {
      for await (const event of state.session.send({ message: turn.message, signal: turn.signal })) {
        await mapEvent(event, turn.emitter, turn.runtime);
      }
    } finally {
      turn.signal?.removeEventListener('abort', abort);
    }

    await turn.emitter.done();
    return { nativeSessionId: state.nativeSessionId };
  }

  onMaintenance(logger) {
    const now = Date.now();
    for (const [key, state] of this.#sessions.entries()) {
      if (now - state.lastUsedAt <= IDLE_TTL_MS) { continue; }
      try { state.session.dispose?.(); } catch {}
      try { state.client.dispose?.(); } catch {}
      this.#sessions.delete(key);
      logger.info(`[<ClassName>] Closed idle session ${key}`);
    }
  }

  dispose() {
    for (const state of this.#sessions.values()) {
      try { state.session.dispose?.(); } catch {}
      try { state.client.dispose?.(); } catch {}
    }
    this.#sessions.clear();
  }
}

async function mapEvent(event, emitter, runtime) {
  switch (event.type) {
    case 'text':      await emitter.text(event.delta ?? event.text ?? ''); return;
    case 'thinking':  await emitter.thinking(event.delta ?? event.text ?? ''); return;
    case 'tool_start': await emitter.toolStart(event.name, JSON.stringify(event.input ?? {}), event.id); return;
    case 'tool_end':  await emitter.toolEnd(event.name, event.id, event.result, Boolean(event.isError)); return;
    case 'error':
      await emitter.error(event.message ?? 'SDK error');
      if (event.fatal) throw new Error(event.message ?? 'SDK fatal error');
      return;
    default:
      runtime.logger.debug(`[<ClassName>] Unhandled event: ${JSON.stringify(event)}`);
  }
}
```

**After writing:** replace `<@vendor/package>`, `<THEIR_API_KEY_VAR>`, and
`<ClassName>` with the developer's actual values. Adapt `client.createSession`,
`session.send`, and `mapEvent` to the real SDK API — ask the developer to share
SDK docs or type exports if uncertain.

### CLI template

Use when the agent surface is an installed CLI binary.

```js
// @ts-check
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const IS_WIN = process.platform === 'win32';
const CLI_BIN = '<binary-name>';
const CLI_CMD = '<binary-name>.cmd';
const CLI_NODE_ENTRY = ['node_modules', '<binary-name>', 'bin', '<binary-name>.mjs'];

function firstLine(v) {
  return String(v ?? '').split(/\r?\n/).map(s => s.trim()).find(Boolean);
}

async function which(bin) {
  try {
    const r = await execFileAsync(IS_WIN ? 'where.exe' : 'which', [bin], { windowsHide: true });
    return firstLine(r.stdout);
  } catch { return undefined; }
}

async function findBinary() {
  if (process.env.<ENGINE_CLI_PATH_ENV>?.trim()) return process.env.<ENGINE_CLI_PATH_ENV>.trim();
  if (IS_WIN) { const cmd = await which(CLI_CMD); if (cmd) return cmd; }
  const bin = await which(CLI_BIN);
  if (bin && IS_WIN && existsSync(`${bin}.cmd`)) return `${bin}.cmd`;
  return bin;
}

function stableSessionId(turn) {
  if (turn.session.nativeSessionId?.trim()) return turn.session.nativeSessionId.trim();
  return 'agenthippo-' + createHash('sha256')
    .update(turn.session.key || turn.session.chatSessionId)
    .digest('hex').slice(0, 24);
}

function commandForSpawn(binary, args) {
  if (!IS_WIN || !/\.cmd$/i.test(binary)) return { command: binary, args };
  const nodeEntry = path.join(path.dirname(binary), ...CLI_NODE_ENTRY);
  if (existsSync(nodeEntry)) return { command: process.execPath, args: [nodeEntry, ...args] };
  return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', binary, ...args] };
}

export class <ClassName> {
  #binaryPath = undefined;

  async run(turn) {
    if (this.#binaryPath === undefined) this.#binaryPath = await findBinary();
    if (!this.#binaryPath) {
      throw new Error('<binary-name> CLI not found. Install it or set <ENGINE_CLI_PATH_ENV>.');
    }

    const sessionId = stableSessionId(turn);
    const cliArgs = [
      '--json',
      '--session-id', sessionId,
      '--model', turn.modelId,
      '--message', turn.message,
      // add CLI-specific flags here
    ];

    const { command, args } = commandForSpawn(this.#binaryPath, cliArgs);
    const stdout = await new Promise((resolve, reject) => {
      const proc = spawn(command, args, {
        cwd: turn.workspaceRoot,
        env: {
          ...turn.env,
          <THEIR_API_KEY_VAR>: turn.routing.apiKey || 'sk-dummy',
          <THEIR_BASE_URL_VAR>: turn.routing.openaiBaseUrl || turn.routing.baseUrl || '',
          NO_COLOR: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      const abort = () => proc.kill('SIGTERM');
      turn.signal?.addEventListener('abort', abort, { once: true });

      let out = '', err = '';
      proc.stdout.on('data', c => { out += c; });
      proc.stderr.on('data', c => {
        err += c;
        String(c).split(/\r?\n/).map(s => s.trim()).filter(Boolean)
          .forEach(l => turn.runtime.logger.warn(`[<ClassName>] ${l}`));
      });
      proc.on('error', reject);
      proc.on('close', code => {
        turn.signal?.removeEventListener('abort', abort);
        if (turn.signal?.aborted) { reject(new Error('CLI aborted')); return; }
        if (code === 0 || code === null) { resolve(out); return; }
        reject(new Error(`CLI exited ${code}: ${(err || out).trim()}`));
      });
    });

    const result = parseJson(stdout);
    const text = resultText(result);
    if (text) await turn.emitter.text(text);
    await turn.emitter.done();
    return { nativeSessionId: sessionId };
  }

  onMaintenance(logger) {
    this.#binaryPath = undefined;
    logger.info('[<ClassName>] Cleared binary cache');
  }

  dispose() { this.#binaryPath = undefined; }
}

function parseJson(stdout) {
  const s = stdout.trim();
  if (!s) return undefined;
  try { return JSON.parse(s); } catch {}
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i >= 0 && j > i) return JSON.parse(s.slice(i, j + 1));
  throw new Error(`Non-JSON CLI output: ${s.slice(0, 300)}`);
}

function resultText(r) {
  if (typeof r?.text === 'string') return r.text;
  if (typeof r?.message === 'string') return r.message;
  if (Array.isArray(r?.payloads)) return r.payloads.map(p => p?.text).filter(Boolean).join('\n\n');
  return '';
}
```

**After writing:** replace `<binary-name>`, `<ClassName>`, `<ENGINE_CLI_PATH_ENV>`,
`<THEIR_API_KEY_VAR>`, and `<THEIR_BASE_URL_VAR>` with real values. Adjust
`cliArgs` to match the CLI's actual flags for message and session id.

---

## Step 5 — Write `engine-contract.d.ts`

Write this file verbatim next to `engine.mjs` to give the developer editor type
checking. It has zero dependencies.

```ts
export interface Turn {
  message: string;
  modelId: string;
  workspaceRoot: string;
  additionalDirectories: string[];
  permissions: Record<string, unknown>;
  env: Record<string, string>;
  routing: {
    useLiteLLM: boolean;
    apiKey: string;
    baseUrl: string;
    openaiBaseUrl: string;
  };
  session: {
    key: string;
    nativeSessionId?: string;
    engineHomeDir: string;
    engineSessionDir: string;
    contextFilePath: string;
    terminalLogPath: string;
    attachmentsDir: string;
    chatSessionId: string;
    contextSessionId: string;
  };
  agent: {
    rulesFilePath?: string;
    skillsDir?: string;
    rulesDir?: string;
  };
  emitter: Emitter;
  runtime: { logger: Logger };
  signal?: AbortSignal;
}

export interface Emitter {
  text(delta: string): Promise<void>;
  thinking(delta: string): Promise<void>;
  toolStart(name: string, input: string, id?: string): Promise<void>;
  toolEnd(name: string, id: string | undefined, result: unknown, isError: boolean): Promise<void>;
  question(payload: unknown): Promise<void>;
  progress(message: string): Promise<void>;
  error(message: string): Promise<void>;
  done(): Promise<void>;
}

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  debug(msg: string): void;
  error(msg: string): void;
}

export interface Engine {
  run(turn: Turn): Promise<{ nativeSessionId?: string } | void>;
  onMaintenance?(logger: Logger): void;
  dispose?(): void;
}
```

---

## Step 6 — Validate syntax and manifest

Run these in the engine folder before testing end-to-end:

```bash
node --check .agent-hippo/engines/<engine-id>/engine.mjs
node -e "JSON.parse(require('fs').readFileSync('.agent-hippo/engines/<engine-id>/engine.manifest.json','utf8')); console.log('manifest ok')"
```

Fix any errors before proceeding to smoke tests.

---

## Step 7 — Smoke test

Use the installed AgentHippo CLI (`agenthippo` or `ah`).

**Single-turn ask:**

```bash
<THEIR_API_KEY_VAR>=<key> agenthippo ask \
  'Reply with exactly: ENGINE_OK' \
  --engine <engine-id> \
  --model <default-model> \
  --workspace /tmp/engine-smoke \
  --json
```

**Multi-turn serve test** (verifies session continuation — most important):

```bash
# Terminal 1 — start serve
<THEIR_API_KEY_VAR>=<key> agenthippo serve \
  --engine <engine-id> \
  --model <default-model> \
  --workspace /tmp/engine-smoke \
  --port 31991

# Terminal 2 — send two turns with the same session_id
curl -s -X POST http://127.0.0.1:31991/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"What is 8+9? Reply with only the number.","session_id":"smoke-1"}'

curl -s -X POST http://127.0.0.1:31991/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"Double it. Reply with only the number.","session_id":"smoke-1"}'
```

Pass condition: the second response (`34`) uses engine-managed continuation.
The request body must **not** include prior chat history — AgentHippo sends one
message per turn; the engine keeps state.

If `AGENTHIPPO_CUSTOM_ENGINES_DIR` is needed (engine not in workspace or home):

```bash
AGENTHIPPO_CUSTOM_ENGINES_DIR=/path/to/parent/of/engine/folders \
  agenthippo serve ...
```

---

## Step 8 — IDE validation

Tell the developer to reload the VS Code window after installing the engine,
then verify:

- The engine appears in the mode picker with its manifest `displayName`.
- Mode matching is case/space/dash insensitive.
- Sending a message routes to `custom:<engine-id>`.
- No routine per-turn startup noise appears in the UI.

If the mode is missing, check that `engine.manifest.json` is valid JSON and
that the engine folder is under a discovered search root.

---

## Reference: `turn` fields quick lookup

| Field | Type | Purpose |
|---|---|---|
| `turn.message` | string | Current user message only — do not replay history |
| `turn.modelId` | string | Selected model id |
| `turn.workspaceRoot` | string | Primary workspace root |
| `turn.env` | object | Merged env for this turn — pass to subprocess, do not mutate global `process.env` |
| `turn.routing.apiKey` | string | Resolved API key (often dummy for LiteLLM) |
| `turn.routing.baseUrl` | string | Provider-native base URL |
| `turn.routing.openaiBaseUrl` | string | OpenAI-compatible base URL |
| `turn.session.key` | string | Stable conversation key — use as Map key |
| `turn.session.nativeSessionId` | string? | Persisted native resume handle from prior turn |
| `turn.session.engineHomeDir` | string | Stable per-engine home directory |
| `turn.session.engineSessionDir` | string | Stable per-conversation storage |
| `turn.agent.rulesFilePath` | string? | Synced rules file (when workspaceSync enabled) |
| `turn.agent.skillsDir` | string? | Synced skills dir (when workspaceSync enabled) |
| `turn.emitter` | Emitter | Stream bridge back to AgentHippo |
| `turn.runtime.logger` | Logger | Diagnostic logging — not user-visible |
| `turn.signal` | AbortSignal? | Cancellation signal |

## Reference: emitter methods

| Method | When to call |
|---|---|
| `emitter.text(delta)` | Each chunk of assistant text |
| `emitter.thinking(delta)` | Model reasoning/thinking output |
| `emitter.toolStart(name, input, id)` | Tool call begins |
| `emitter.toolEnd(name, id, result, isError)` | Tool call completes |
| `emitter.progress(msg)` | Meaningful work status (not every turn start) |
| `emitter.error(msg)` | Non-fatal SDK error |
| `emitter.done()` | **Required** — call exactly once on success |

Always throw after a fatal error. Do not call `done()` on failure.

## Reference: routing patterns

| Scenario | What to use |
|---|---|
| Direct provider (no proxy) | `turn.routing.apiKey` + `turn.routing.baseUrl` (or none for default) |
| LiteLLM / OpenAI-compatible proxy | `turn.routing.apiKey` (often `sk-dummy`) + `turn.routing.openaiBaseUrl` |
| Gemini via `@google/genai` | Use `GEMINI_API_KEY` directly; omit `baseUrl` for public endpoint |
| Anthropic SDK via LiteLLM | Dummy key + `turn.routing.baseUrl` as `baseURL` |

## Guardrails

- Do **not** replay prior messages through `turn.message` — send only the current user message; the engine keeps session state.
- Do **not** mutate global `process.env` — pass `turn.env` to subprocesses to avoid races across concurrent chats.
- Do **not** log API keys or auth-bearing command lines.
