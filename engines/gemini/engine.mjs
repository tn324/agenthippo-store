// @ts-check
/**
 * Gemini SDK engine bridge for AgentHippo.
 *
 * Uses the official @google/gemini-cli-core package in-process instead of
 * spawning the `gemini` CLI for every turn. AgentHippo still owns the stable
 * conversation key, engine home/session directories, model routing, and env
 * injection; Gemini owns the agent loop, tools, memory, and chat history.
 */

import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const ACTIVE_SESSION_IDLE_TTL_MS = 1000 * 60 * 30; // 30 minutes
const SDK_PACKAGE = '@google/gemini-cli-core';

/** @type {Promise<Record<string, any>> | undefined} */
let coreModulePromise;

async function loadGeminiCore() {
	if (!coreModulePromise) {
		coreModulePromise = import(SDK_PACKAGE).catch((err) => {
			coreModulePromise = undefined;
			throw new Error(
				`Gemini SDK package not found. Install it in this engine directory with: npm install --prefix .agent-hippo/engines/gemini ${SDK_PACKAGE}@0.40.0. Original error: ${err instanceof Error ? err.message : String(err)}`,
			);
		});
	}
	return coreModulePromise;
}

/**
 * @param {string | undefined} value
 * @returns {Record<string, string> | undefined}
 */
function parseHeaderBlock(value) {
	if (!value?.trim()) {
		return undefined;
	}
	const headers = {};
	for (const line of value.split(/\r?\n/)) {
		const idx = line.indexOf(':');
		if (idx <= 0) {
			continue;
		}
		const key = line.slice(0, idx).trim();
		const headerValue = line.slice(idx + 1).trim();
		if (key && headerValue) {
			headers[key] = headerValue;
		}
	}
	return Object.keys(headers).length > 0 ? headers : undefined;
}

/**
 * @param {string | undefined} baseUrl
 * @param {boolean} useLiteLLM
 */
function normalizeBaseUrl(baseUrl, useLiteLLM) {
	if (!baseUrl || useLiteLLM) {
		return baseUrl;
	}
	try {
		const url = new URL(baseUrl);
		const isNativeGoogleUrl = url.hostname === 'generativelanguage.googleapis.com';
		const isVersionPath = url.pathname === '/v1' || url.pathname === '/v1beta' || url.pathname === '/v1alpha';
		if (isNativeGoogleUrl && isVersionPath) {
			return undefined;
		}
	} catch {
		return baseUrl;
	}
	return baseUrl;
}

/**
 * @param {import('../../../extensions/agentide/examples/custom-engines/engine-contract.d.ts').CustomEngineTurn} turn
 */
function resolveAuth(turn) {
	let apiKey = turn.routing.apiKey
		|| turn.env.GEMINI_API_KEY
		|| turn.env.GOOGLE_API_KEY;
	let baseUrl = turn.routing.baseUrl
		|| turn.env.GOOGLE_GEMINI_BASE_URL;

	if (turn.routing.useLiteLLM) {
		apiKey = apiKey
			|| turn.env.AGENTHIPPO_LITELLM_API_KEY
			|| turn.env.AGENTIDE_LITELLM_API_KEY
			|| 'sk-dummy';
		baseUrl = baseUrl
			|| turn.env.AGENTHIPPO_LITELLM_BASE_URL
			|| turn.env.AGENTIDE_LITELLM_BASE_URL;
	}
	baseUrl = normalizeBaseUrl(baseUrl, turn.routing.useLiteLLM);

	if (!apiKey) {
		throw new Error(
			'Gemini SDK auth is not configured. Provide GEMINI_API_KEY (native Gemini) or route through LiteLLM so AgentHippo can inject a dummy key and GOOGLE_GEMINI_BASE_URL.',
		);
	}

	return {
		apiKey,
		baseUrl,
		customHeaders: parseHeaderBlock(turn.env.AGENTHIPPO_LITELLM_METADATA_HEADERS),
	};
}

/** @param {ReturnType<typeof resolveAuth>} auth */
function authFingerprint(auth) {
	return createHash('sha256')
		.update(JSON.stringify({
			apiKey: auth.apiKey,
			baseUrl: auth.baseUrl,
			customHeaders: auth.customHeaders,
		}))
		.digest('hex');
}

/**
 * @param {import('../../../extensions/agentide/examples/custom-engines/engine-contract.d.ts').CustomEngineTurn} turn
 */
async function readUserMemory(turn) {
	const rulesFile = turn.agent.rulesFilePath;
	if (!rulesFile) {
		return '';
	}
	try {
		return await readFile(rulesFile, 'utf8');
	} catch {
		return '';
	}
}

/**
 * @param {import('../../../extensions/agentide/examples/custom-engines/engine-contract.d.ts').CustomEngineTurn} turn
 */
function resolveNativeSessionId(turn) {
	return turn.session.nativeSessionId?.trim() || `agenthippo-gemini-${randomUUID()}`;
}

/**
 * @param {unknown} value
 */
function toJson(value) {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

/**
 * @param {Array<any> | undefined} content
 */
function contentToText(content) {
	if (!Array.isArray(content)) {
		return '';
	}
	const chunks = [];
	for (const part of content) {
		if (!part || typeof part !== 'object') {
			continue;
		}
		if (part.type === 'text' && typeof part.text === 'string') {
			chunks.push(part.text);
		} else if (part.type === 'thought' && typeof part.thought === 'string') {
			chunks.push(part.thought);
		} else if (part.type === 'reference' && typeof part.text === 'string') {
			chunks.push(part.text);
		} else if (part.type === 'media') {
			chunks.push(`[media: ${part.mimeType ?? part.uri ?? 'inline'}]`);
		}
	}
	return chunks.join('\n');
}

/**
 * @param {any} event
 */
function toolResponseToText(event) {
	const contentText = contentToText(event.content);
	if (contentText) {
		return contentText;
	}
	const displayResult = event.display?.result;
	if (displayResult?.type === 'text' && typeof displayResult.text === 'string') {
		return displayResult.text;
	}
	if (displayResult?.type === 'diff') {
		return toJson(displayResult);
	}
	if (event.data) {
		return toJson(event.data);
	}
	return undefined;
}

/**
 * @param {any} event
 * @param {import('../../../extensions/agentide/examples/custom-engines/engine-contract.d.ts').Emitter} emitter
 * @param {import('../../../extensions/agentide/examples/custom-engines/engine-contract.d.ts').Runtime} runtime
 */
async function emitAgentEvent(event, emitter, runtime) {
	switch (event.type) {
		case 'message': {
			if (event.role !== 'agent') {
				return;
			}
			for (const part of event.content ?? []) {
				if (part.type === 'text' && typeof part.text === 'string') {
					await emitter.text(part.text);
				} else if (part.type === 'thought' && typeof part.thought === 'string') {
					await emitter.thinking(part.thought);
				}
			}
			return;
		}
		case 'tool_request':
			await emitter.toolStart(
				String(event.name ?? ''),
				event.args == null ? undefined : toJson(event.args),
				String(event.requestId ?? ''),
			);
			return;
		case 'tool_update': {
			const status = event.display?.description
				|| event.display?.resultSummary
				|| event._meta?.legacyState?.status
				|| event._meta?.legacyState?.progressMessage;
			if (status) {
				await emitter.progress(String(status));
			}
			return;
		}
		case 'tool_response':
			await emitter.toolEnd(
				String(event.name ?? 'tool'),
				String(event.requestId ?? ''),
				toolResponseToText(event),
				Boolean(event.isError),
			);
			return;
		case 'error':
			await emitter.error(String(event.message ?? 'Gemini SDK error'));
			return;
		case 'agent_start':
		case 'agent_end':
		case 'initialize':
		case 'session_update':
		case 'usage':
		case 'custom':
			return;
		default:
			runtime.logger.debug(`[Gemini SDK] Unhandled agent event: ${toJson(event)}`);
	}
}

/**
 * @param {Record<string, any>} core
 * @param {import('../../../extensions/agentide/examples/custom-engines/engine-contract.d.ts').CustomEngineTurn} turn
 * @param {string} nativeSessionId
 * @param {string} userMemory
 */
function buildConfig(core, turn, nativeSessionId, userMemory) {
	const approvalMode = core.ApprovalMode?.YOLO ?? 'yolo';
	return new core.Config({
		sessionId: nativeSessionId,
		clientName: 'agenthippo-gemini-sdk',
		clientVersion: 'custom-engine-v2',
		targetDir: turn.workspaceRoot,
		cwd: turn.workspaceRoot,
		model: turn.modelId,
		debugMode: false,
		usageStatisticsEnabled: false,
		telemetry: { enabled: false, traces: false, logPrompts: false },
		approvalMode,
		trustedFolder: true,
		folderTrust: false,
		interactive: false,
		noBrowser: true,
		ideMode: true,
		checkpointing: false,
		contextFileName: 'GEMINI.md',
		userMemory,
		includeDirectories: turn.additionalDirectories,
		loadMemoryFromIncludeDirectories: false,
		mcpEnabled: false,
		extensionsEnabled: false,
		skillsSupport: true,
		adminSkillsEnabled: true,
		enableHooks: false,
		enableHooksUI: false,
		enableInteractiveShell: false,
		useRipgrep: true,
		disableYoloMode: false,
		disableAlwaysAllow: false,
		maxSessionTurns: -1,
		output: { format: 'text' },
	});
}

export class GeminiSdkEngine {
	/** @type {Map<string, { core: Record<string, any>, config: any, session: any, nativeSessionId: string, authFingerprint: string, lastUsedAt: number }>} */
	#sessions = new Map();

	/**
	 * @param {import('../../../extensions/agentide/examples/custom-engines/engine-contract.d.ts').CustomEngineTurn} turn
	 */
	async run(turn) {
		const { emitter, runtime, signal } = turn;
		const core = await loadGeminiCore();
		const auth = resolveAuth(turn);
		const authHash = authFingerprint(auth);

		// The Gemini SDK reads these two vars from process.env internally rather
		// than accepting them as Config parameters. Both are idempotent across
		// concurrent calls: GEMINI_CLI_HOME is the same engineHomeDir for every
		// session of this engine, and GEMINI_CLI_TRUST_WORKSPACE is always 'true'.
		process.env.GEMINI_CLI_HOME = turn.env.GEMINI_CLI_HOME ?? turn.session.engineHomeDir;
		process.env.GEMINI_CLI_TRUST_WORKSPACE = 'true';

		let state = this.#sessions.get(turn.session.key);
		if (!state) {
			state = await this.#createSession(core, turn, auth, authHash);
		} else {
			if (state.authFingerprint !== authHash) {
				await state.config.refreshAuth(core.AuthType.USE_GEMINI, auth.apiKey, auth.baseUrl, auth.customHeaders);
				state.authFingerprint = authHash;
			}
			if (state.config.getModel?.() !== turn.modelId) {
				state.config.setModel(turn.modelId);
			}
		}
		state.lastUsedAt = Date.now();

		let fatalError;
		const abort = () => {
			void state?.session.abort().catch((err) => {
				runtime.logger.warn(`[Gemini SDK] Abort failed: ${err instanceof Error ? err.message : String(err)}`);
			});
		};
		signal?.addEventListener('abort', abort, { once: true });
		try {
			for await (const event of state.session.sendStream({
				message: {
					content: [{ type: 'text', text: turn.message }],
					displayContent: turn.message,
				},
				_meta: { source: 'agenthippo' },
			})) {
				await emitAgentEvent(event, emitter, runtime);
				if (event.type === 'error' && event.fatal) {
					fatalError = new Error(String(event.message ?? 'Gemini SDK fatal error'));
				}
			}
		} finally {
			signal?.removeEventListener('abort', abort);
		}

		if (fatalError) {
			throw fatalError;
		}
		await emitter.done();
		return { nativeSessionId: state.nativeSessionId };
	}

	/**
	 * @param {Record<string, any>} core
	 * @param {import('../../../extensions/agentide/examples/custom-engines/engine-contract.d.ts').CustomEngineTurn} turn
	 * @param {ReturnType<typeof resolveAuth>} auth
	 * @param {string} authHash
	 */
	async #createSession(core, turn, auth, authHash) {
		const nativeSessionId = resolveNativeSessionId(turn);
		const userMemory = await readUserMemory(turn);
		const config = buildConfig(core, turn, nativeSessionId, userMemory);
		await config.refreshAuth(core.AuthType.USE_GEMINI, auth.apiKey, auth.baseUrl, auth.customHeaders);
		await config.initialize();

		const session = new core.LegacyAgentSession({
			config,
			streamId: nativeSessionId,
			getPreferredEditor: () => undefined,
		});
		const state = {
			core,
			config,
			session,
			nativeSessionId,
			authFingerprint: authHash,
			lastUsedAt: Date.now(),
		};
		this.#sessions.set(turn.session.key, state);
		return state;
	}

	/** @param {import('../../../extensions/agentide/examples/custom-engines/engine-contract.d.ts').Runtime['logger']} logger */
	onMaintenance(logger) {
		const now = Date.now();
		for (const [key, state] of this.#sessions.entries()) {
			if (now - state.lastUsedAt <= ACTIVE_SESSION_IDLE_TTL_MS) {
				continue;
			}
			try {
				state.config.getGeminiClient?.().dispose?.();
			} catch { /* best effort */ }
			this.#sessions.delete(key);
			logger.info(`[Gemini SDK] Closed idle session (key=${key})`);
		}
	}

	dispose() {
		for (const state of this.#sessions.values()) {
			try {
				state.config.getGeminiClient?.().dispose?.();
			} catch { /* best effort */ }
		}
		this.#sessions.clear();
	}
}
