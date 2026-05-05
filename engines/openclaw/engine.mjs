// @ts-check
/**
 * OpenClaw CLI engine bridge for AgentHippo.
 *
 * This bridge intentionally uses the installed OpenClaw/HippoClaw CLI:
 *   openclaw agent --local --json --agent agenthippo --session-id <id> --message <message>
 *
 * AgentHippo owns the outer conversation/session key. OpenClaw owns its native
 * agent state under OPENCLAW_STATE_DIR, and this bridge persists the stable
 * native session id back to AgentHippo so future turns resume the same agent
 * session without AgentHippo resending prior messages.
 */

import { spawn, execFile } from 'child_process';
import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { promises as fs } from 'fs';
import http from 'http';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const IS_WIN = process.platform === 'win32';
const OPENCLAW_AGENT_ID = 'agenthippo';
const DEFAULT_TIMEOUT_SECONDS = 600;
const DEFAULT_LITELLM_BASE_URL = 'http://127.0.0.1:4000';
const CODEX_DUMMY_JWT_ENV = 'OPENCLAW_CODEX_DUMMY_JWT';

function firstLine(value) {
	return String(value ?? '').split(/\r?\n/).map(s => s.trim()).find(Boolean) || undefined;
}

async function which(binary) {
	const command = IS_WIN ? 'where.exe' : 'which';
	try {
		const result = await execFileAsync(command, [binary], { windowsHide: true });
		return firstLine(result.stdout);
	} catch {
		return undefined;
	}
}

async function findOpenClawBinary() {
	const explicit = process.env.OPENCLAW_CLI_PATH?.trim();
	if (explicit) {
		return explicit;
	}

	if (IS_WIN) {
		const cmd = await which('openclaw.cmd') ?? await which('hippoclaw.cmd');
		if (cmd) {
			return cmd;
		}
	}

	const resolved = await which('openclaw') ?? await which('hippoclaw');
	if (resolved) {
		if (IS_WIN && existsSync(`${resolved}.cmd`)) {
			return `${resolved}.cmd`;
		}
		return resolved;
	}

	return undefined;
}

function stableNativeSessionId(turn) {
	if (turn.session.nativeSessionId?.trim()) {
		return turn.session.nativeSessionId.trim();
	}
	const hash = createHash('sha256')
		.update(turn.session.key || turn.session.contextSessionId || turn.session.chatSessionId || 'openclaw')
		.digest('hex')
		.slice(0, 24);
	return `agenthippo-${hash}`;
}

function stripTrailingSlash(value) {
	return value.replace(/\/+$/, '');
}

function resolveBaseUrl(turn) {
	return stripTrailingSlash(
		turn.routing.openaiBaseUrl ||
		turn.routing.baseUrl ||
		turn.env.AGENTHIPPO_LITELLM_BASE_URL ||
		turn.env.AGENTIDE_LITELLM_BASE_URL ||
		turn.env.AGENTHIPPO_BASE_URL ||
		DEFAULT_LITELLM_BASE_URL,
	);
}

function resolveApiKey(turn) {
	return (
		turn.env.LITELLM_API_KEY ||
		turn.env.AGENTHIPPO_LITELLM_API_KEY ||
		turn.env.AGENTIDE_LITELLM_API_KEY ||
		turn.routing.apiKey ||
		'sk-dummy'
	);
}

function isLiteLLMModel(modelId) {
	return modelId.startsWith('litellm/');
}

function needsCodexResponsesShim(modelId) {
	if (process.env.OPENCLAW_FORCE_CODEX_SHIM?.trim() === '1') {
		return true;
	}
	return isLiteLLMModel(modelId) && /\bcodex\b/i.test(modelId);
}

function fakeCodexJwt() {
	const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
	return [
		encode({ alg: 'none', typ: 'JWT' }),
		encode({
			'https://api.openai.com/auth': {
				chatgpt_account_id: 'agenthippo',
			},
		}),
		'signature',
	].join('.');
}

function resolveResponsesUrl(baseUrl) {
	const raw = stripTrailingSlash(baseUrl);
	if (/\/v1\/responses$/i.test(raw)) {
		return raw;
	}
	if (/\/v1$/i.test(raw)) {
		return `${raw}/responses`;
	}
	return `${raw}/v1/responses`;
}

function metadataHeadersFromEnv(turn) {
	const headers = {};
	const raw = turn.env.AGENTHIPPO_LITELLM_METADATA_HEADERS || '';
	for (const line of raw.split(/\r?\n/)) {
		const index = line.indexOf(':');
		if (index <= 0) {
			continue;
		}
		const name = line.slice(0, index).trim();
		const value = line.slice(index + 1).trim();
		if (name && value) {
			headers[name] = value;
		}
	}
	return headers;
}

function readRequestBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		req.on('data', chunk => chunks.push(Buffer.from(chunk)));
		req.on('end', () => resolve(Buffer.concat(chunks)));
		req.on('error', reject);
	});
}

async function startLiteLLMCodexShim({ baseUrl, apiKey, metadataHeaders, logger }) {
	const targetUrl = resolveResponsesUrl(baseUrl);
	const server = http.createServer(async (req, res) => {
		try {
			const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
			if (req.method !== 'POST' || !pathname.endsWith('/codex/responses')) {
				res.writeHead(404, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ error: 'Not found' }));
				return;
			}

			const body = await readRequestBody(req);
			const response = await fetch(targetUrl, {
				method: 'POST',
				headers: {
					authorization: `Bearer ${apiKey}`,
					'content-type': req.headers['content-type'] || 'application/json',
					accept: 'text/event-stream',
					...metadataHeaders,
				},
				body,
			});

			/** @type {import('http').OutgoingHttpHeaders} */
			const responseHeaders = {};
			for (const [key, value] of response.headers.entries()) {
				if (key.toLowerCase() !== 'content-encoding') {
					responseHeaders[key] = value;
				}
			}
			res.writeHead(response.status, responseHeaders);
			if (response.body) {
				for await (const chunk of response.body) {
					res.write(Buffer.from(chunk));
				}
			}
			res.end();
		} catch (error) {
			logger.warn(`[OpenClaw CLI] LiteLLM codex shim error: ${error instanceof Error ? error.message : String(error)}`);
			if (!res.headersSent) {
				res.writeHead(502, { 'content-type': 'application/json' });
			}
			res.end(JSON.stringify({ error: 'LiteLLM codex shim failed' }));
		}
	});

	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			resolve(undefined);
		});
	});

	const address = server.address();
	if (!address || typeof address === 'string') {
		throw new Error('Failed to start LiteLLM codex shim');
	}

	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		targetUrl,
		close: () => new Promise(resolve => server.close(() => resolve(undefined))),
	};
}

function buildOpenClawModelConfig(modelId, baseUrl, options = {}) {
	if (!isLiteLLMModel(modelId)) {
		return {
			primary: modelId,
			providers: {},
		};
	}

	const useCodexShim = options.useCodexShim === true;
	const providerId = useCodexShim ? 'agenthippo-litellm-codex' : 'agenthippo-litellm';
	const api = useCodexShim ? 'openai-codex-responses' : 'openai-responses';
	return {
		primary: `${providerId}/${modelId}`,
		providers: {
			[providerId]: {
				baseUrl,
				apiKey: useCodexShim ? `\${${CODEX_DUMMY_JWT_ENV}}` : '${LITELLM_API_KEY}',
				auth: 'api-key',
				api,
				models: [
					{
						id: modelId,
						name: modelId,
						api,
						reasoning: true,
						input: ['text', 'image'],
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
						},
						contextWindow: 200000,
						maxTokens: 16000,
						compat: {
							supportsDeveloperRole: true,
							supportsReasoningEffort: true,
							supportsStore: true,
							supportsTools: true,
							requiresToolResultName: true,
						},
					},
				],
			},
		},
	};
}

async function writeOpenClawConfig(turn, options = {}) {
	// Keep OpenClaw's home stable so auth, provider config, and cached state are
	// shared across AgentHippo conversations. Native session ids separate chats.
	const stateDir = turn.session.engineHomeDir;
	const agentDir = path.join(stateDir, 'agents', OPENCLAW_AGENT_ID, 'agent');
	const sessionsDir = path.join(stateDir, 'agents', OPENCLAW_AGENT_ID, 'sessions');
	const baseUrl = options.baseUrl || resolveBaseUrl(turn);
	const model = buildOpenClawModelConfig(turn.modelId, baseUrl, {
		useCodexShim: options.useCodexShim === true,
	});

	await fs.mkdir(agentDir, { recursive: true });
	await fs.mkdir(sessionsDir, { recursive: true });

	const config = {
		agents: {
			defaults: {
				workspace: turn.workspaceRoot,
				model: { primary: model.primary },
				skipBootstrap: true,
				timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
			},
			list: [
				{
					id: OPENCLAW_AGENT_ID,
					default: true,
					workspace: turn.workspaceRoot,
					agentDir,
					model: { primary: model.primary },
				},
			],
		},
		models: {
			mode: 'merge',
			providers: model.providers,
		},
	};

	const configPath = path.join(stateDir, 'openclaw.json');
	await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

	return { stateDir, agentDir, configPath, baseUrl };
}

function parseCliJson(stdout) {
	const trimmed = stdout.trim();
	if (!trimmed) {
		return undefined;
	}
	try {
		return JSON.parse(trimmed);
	} catch {
		const start = trimmed.indexOf('{');
		const end = trimmed.lastIndexOf('}');
		if (start >= 0 && end > start) {
			return JSON.parse(trimmed.slice(start, end + 1));
		}
		throw new Error(`OpenClaw CLI produced non-JSON output: ${trimmed.slice(0, 500)}`);
	}
}

function collectPayloadText(result) {
	if (!result || typeof result !== 'object') {
		return '';
	}
	const payloads = Array.isArray(result.payloads) ? result.payloads : [];
	return payloads
		.map(payload => {
			if (payload && typeof payload === 'object' && typeof payload.text === 'string') {
				return payload.text;
			}
			return '';
		})
		.filter(Boolean)
		.join('\n\n');
}

function resultError(result) {
	if (!result || typeof result !== 'object') {
		return undefined;
	}
	const meta = result.meta;
	if (meta && typeof meta === 'object') {
		if (meta.stopReason === 'error') {
			return collectPayloadText(result) || 'OpenClaw CLI returned an error result';
		}
		if (typeof meta.error === 'string' && meta.error.trim()) {
			return meta.error.trim();
		}
	}
	return undefined;
}

/**
 * Parse a .cmd npm shim to find the underlying Node.js script path.
 * npm Windows shims embed the script path as a quoted string, e.g.:
 *   "%~dp0\node_modules\openclaw\openclaw.mjs" %*
 *
 * @param {string} cmdPath
 * @param {string} baseDir
 * @returns {Promise<string | undefined>}
 */
async function resolveScriptFromCmdFile(cmdPath, baseDir) {
	try {
		const content = await fs.readFile(cmdPath, 'utf8');
		for (const match of content.matchAll(/"([^"]+\.m?js)"/g)) {
			const rawPath = match[1].replace(/%~?dp0%?[/\\]?/gi, '');
			const candidate = path.resolve(baseDir, rawPath);
			if (existsSync(candidate)) {
				return candidate;
			}
		}
	} catch { /* ignore */ }
	return undefined;
}

/**
 * Resolve the command and args to spawn the OpenClaw CLI.
 * On Windows, .cmd shims cannot receive arbitrary stdin/args safely via cmd.exe,
 * so we locate the underlying Node.js entry script and invoke it directly.
 *
 * @param {string} binary
 * @param {string[]} cliArgs
 * @returns {Promise<{ command: string; args: string[] }>}
 */
async function resolveSpawnCommand(binary, cliArgs) {
	if (IS_WIN && /\.cmd$/i.test(binary)) {
		const npmGlobalDir = path.dirname(binary);
		// Common locations for the underlying Node.js entry script
		const candidates = [
			path.join(npmGlobalDir, 'node_modules', 'openclaw', 'openclaw.mjs'),
			path.join(npmGlobalDir, 'node_modules', 'hippoclaw', 'openclaw.mjs'),
			path.join(npmGlobalDir, 'node_modules', 'openclaw', 'bin', 'openclaw.mjs'),
			path.join(npmGlobalDir, 'node_modules', 'hippoclaw', 'bin', 'openclaw.mjs'),
		];
		for (const candidate of candidates) {
			if (existsSync(candidate)) {
				return { command: process.execPath, args: [candidate, ...cliArgs] };
			}
		}
		// Parse the .cmd shim itself to extract the script path
		const parsed = await resolveScriptFromCmdFile(binary, npmGlobalDir);
		if (parsed) {
			return { command: process.execPath, args: [parsed, ...cliArgs] };
		}
		// Last resort: cmd.exe. Note that cmd.exe special characters in
		// message args (^, %, !, &, |) may be misinterpreted even when
		// Node passes them as separate array elements.
		return {
			command: process.env.ComSpec || 'cmd.exe',
			args: ['/d', '/s', '/c', binary, ...cliArgs],
		};
	}
	return { command: binary, args: cliArgs };
}

export class OpenClawCliEngine {
	/** @type {string | undefined | null} */
	#binaryPath = undefined;

	/**
	 * @param {import('../../../extensions/agentide/examples/custom-engines/engine-contract.d.ts').CustomEngineTurn} turn
	 */
	async run(turn) {
		const { emitter, runtime, signal } = turn;

		if (this.#binaryPath === undefined) {
			this.#binaryPath = await findOpenClawBinary();
		}
		if (!this.#binaryPath) {
			throw new Error(
				'OpenClaw CLI not found. Install it via Agent Anywhere or set OPENCLAW_CLI_PATH.',
			);
		}

		const nativeSessionId = stableNativeSessionId(turn);
		const useCodexShim = needsCodexResponsesShim(turn.modelId);
		const shim = useCodexShim
			? await startLiteLLMCodexShim({
				baseUrl: resolveBaseUrl(turn),
				apiKey: resolveApiKey(turn),
				metadataHeaders: metadataHeadersFromEnv(turn),
				logger: runtime.logger,
			})
			: undefined;
		const { stateDir, agentDir, configPath, baseUrl } = await writeOpenClawConfig(turn, {
			baseUrl: shim?.baseUrl,
			useCodexShim,
		});
		runtime.logger.info(`[OpenClaw CLI] state=${stateDir}, config=${configPath}, baseUrl=${baseUrl}, session=${nativeSessionId}`);
		if (shim) {
			runtime.logger.info(`[OpenClaw CLI] LiteLLM codex shim target=${shim.targetUrl}`);
		}

		const cliArgs = [
			'agent',
			'--local',
			'--json',
			'--agent',
			OPENCLAW_AGENT_ID,
			'--session-id',
			nativeSessionId,
			'--message',
			turn.message,
			'--timeout',
			String(DEFAULT_TIMEOUT_SECONDS),
		];

		const thinking = process.env.OPENCLAW_THINKING?.trim();
		if (thinking) {
			cliArgs.push('--thinking', thinking);
		}

		const { command, args } = await resolveSpawnCommand(this.#binaryPath, cliArgs);
		let stdout = '';
		try {
			stdout = await new Promise((resolve, reject) => {
				const proc = spawn(command, args, {
					env: {
						...turn.env,
						OPENCLAW_STATE_DIR: stateDir,
						OPENCLAW_AGENT_DIR: agentDir,
						PI_CODING_AGENT_DIR: agentDir,
						LITELLM_API_KEY: resolveApiKey(turn),
						[CODEX_DUMMY_JWT_ENV]: fakeCodexJwt(),
						OPENAI_API_KEY: turn.env.OPENAI_API_KEY || 'sk-dummy',
						NO_COLOR: '1',
					},
					cwd: turn.workspaceRoot,
					stdio: ['ignore', 'pipe', 'pipe'],
					windowsHide: true,
				});

				const abort = () => proc.kill('SIGTERM');
				signal?.addEventListener('abort', abort, { once: true });

				let out = '';
				let err = '';
				proc.stdout.on('data', chunk => { out += chunk.toString(); });
				proc.stderr.on('data', chunk => {
					const text = chunk.toString();
					err += text;
					if (text.trim()) {
						runtime.logger.warn(`[OpenClaw CLI] ${text.trim()}`);
					}
				});
				proc.on('error', error => reject(new Error(`Failed to spawn OpenClaw CLI (${command}): ${error.message}`)));
				proc.on('close', code => {
					signal?.removeEventListener('abort', abort);
					if (signal?.aborted) {
						reject(new Error('OpenClaw CLI run aborted'));
						return;
					}
					if (code === 0 || code === null) {
						resolve(out);
					} else {
						const detail = err.trim() || out.trim() || `OpenClaw CLI exited with code ${code}`;
						reject(new Error(detail));
					}
				});
			});
		} finally {
			await shim?.close().catch(error => {
				runtime.logger.warn(`[OpenClaw CLI] LiteLLM codex shim close failed: ${error instanceof Error ? error.message : String(error)}`);
			});
		}

		const result = parseCliJson(stdout);
		const error = resultError(result);
		if (error) {
			throw new Error(error);
		}

		const text = collectPayloadText(result);
		if (text) {
			await emitter.text(text);
		}
		await emitter.done();

		return { nativeSessionId };
	}

	/** @param {object} logger */
	onMaintenance(logger) {
		this.#binaryPath = undefined;
		logger.info('[OpenClaw CLI] Maintenance: binary path cache cleared');
	}

	dispose() {
		this.#binaryPath = undefined;
	}
}
