// @ts-check
/**
 * Atlassian Rovo Dev CLI engine bridge for AgentHippo.
 *
 * Uses the installed ACLI binary in non-interactive mode:
 *   acli rovodev run [--restore <session-id>] [--yolo] <instruction>
 *
 * AgentHippo owns the outer conversation key and persists Rovo's native session
 * UUID so later turns resume with --restore without replaying prior messages.
 *
 * Authenticate once with: acli rovodev auth login
 * https://support.atlassian.com/rovo/docs/install-and-run-rovo-dev-cli-on-your-device/
 */

import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const IS_WIN = process.platform === 'win32';
const ACLI_BIN = 'acli';
const ACLI_CMD = 'acli.cmd';
const SESSION_ID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;

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

/**
 * @param {string | undefined} explicit
 */
function expandHome(explicit) {
	if (!explicit?.trim()) {
		return undefined;
	}
	const trimmed = explicit.trim();
	if (trimmed.startsWith('~/')) {
		return path.join(process.env.HOME || process.env.USERPROFILE || '', trimmed.slice(2));
	}
	return trimmed;
}

async function findAcliBinary() {
	const explicit = expandHome(process.env.ROVO_ACLI_PATH) || expandHome(process.env.ACLI_PATH);
	if (explicit && existsSync(explicit)) {
		return explicit;
	}

	if (IS_WIN) {
		const cmd = await which(ACLI_CMD);
		if (cmd) {
			return cmd;
		}
	}

	const resolved = await which(ACLI_BIN);
	if (resolved) {
		if (IS_WIN && existsSync(`${resolved}.cmd`)) {
			return `${resolved}.cmd`;
		}
		return resolved;
	}

	return undefined;
}

/**
 * @param {import('./engine-contract.d.ts').CustomEngineTurn} turn
 */
function resolveHomeDir(turn) {
	return (
		turn.env.ROVODEV_HOME?.trim() ||
		turn.session.engineHomeDir?.trim() ||
		path.join(process.env.HOME || process.env.USERPROFILE || '', '.rovodev')
	);
}

/**
 * @param {import('./engine-contract.d.ts').CustomEngineTurn} turn
 */
function stableFallbackSessionId(turn) {
	const hash = createHash('sha256')
		.update(turn.session.key || turn.session.contextSessionId || turn.session.chatSessionId || 'rovo')
		.digest('hex')
		.slice(0, 24);
	return `agenthippo-${hash}`;
}

/**
 * @param {string} output
 */
function extractSessionId(output) {
	const matches = output.match(new RegExp(SESSION_ID_RE, 'gi'));
	if (!matches?.length) {
		return undefined;
	}
	return matches[matches.length - 1];
}

/**
 * @param {string} homeDir
 * @param {string} workspaceRoot
 */
async function discoverLatestSessionId(homeDir, workspaceRoot) {
	const sessionsDir = path.join(homeDir, 'sessions');
	if (!existsSync(sessionsDir)) {
		return undefined;
	}

	/** @type {Array<{ id: string; mtimeMs: number }>} */
	const candidates = [];
	for (const entry of await readdir(sessionsDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) {
			continue;
		}
		const sessionId = entry.name;
		if (!SESSION_ID_RE.test(sessionId)) {
			continue;
		}
		const sessionPath = path.join(sessionsDir, sessionId);
		const metadataPath = path.join(sessionPath, 'metadata.json');
		let mtimeMs = 0;
		try {
			const sessionStat = await stat(sessionPath);
			mtimeMs = sessionStat.mtimeMs;
			if (existsSync(metadataPath)) {
				const metadataRaw = await readFile(metadataPath, 'utf8');
				const metadata = JSON.parse(metadataRaw);
				const workspaceHint = [
					metadata?.workspace,
					metadata?.workspaceRoot,
					metadata?.cwd,
					metadata?.workingDirectory,
				].find(value => typeof value === 'string' && value.trim());
				if (workspaceHint && !path.resolve(workspaceHint).startsWith(path.resolve(workspaceRoot))) {
					continue;
				}
			}
		} catch {
			continue;
		}
		candidates.push({ id: sessionId, mtimeMs });
	}

	candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return candidates[0]?.id;
}

/**
 * @param {string} binary
 * @param {string[]} cliArgs
 */
function commandForSpawn(binary, cliArgs) {
	if (!IS_WIN || !/\.cmd$/i.test(binary)) {
		return { command: binary, args: cliArgs };
	}
	return {
		command: process.env.ComSpec || 'cmd.exe',
		args: ['/d', '/s', '/c', binary, ...cliArgs],
	};
}

/**
 * @param {{ missingEmail?: boolean; missingToken?: boolean; detail?: string }} [options]
 */
function rovoAuthSetupMessage(options = {}) {
	const lines = [
		'Rovo Dev CLI needs your Atlassian email and a Rovo Dev scoped API token.',
		'',
		'Add these to ~/.agent-hippo/.env (or export them in your shell):',
		'  ATLASSIAN_EMAIL=your-atlassian-account@email.com',
		'  ATLASSIAN_API_TOKEN=<your-rovo-dev-api-token>',
		'',
		'Create a token: https://go.atlassian.com/rovo-dev-api-token',
		'',
		'Authenticate once:',
		'  echo "$ATLASSIAN_API_TOKEN" | acli rovodev auth login --email "$ATLASSIAN_EMAIL" --token',
		'',
		'Install ACLI if needed:',
		'  brew tap atlassian/homebrew-acli && brew install acli',
	];

	if (options.missingEmail) {
		lines.push('', 'Missing: ATLASSIAN_EMAIL');
	}
	if (options.missingToken) {
		lines.push('', 'Missing: ATLASSIAN_API_TOKEN');
	}
	if (options.detail?.trim()) {
		lines.push('', `Details: ${options.detail.trim()}`);
	}

	return lines.join('\n');
}

/**
 * @param {import('./engine-contract.d.ts').Emitter} emitter
 * @param {string} message
 */
async function reportRovoAuthFailure(emitter, message) {
	await emitter.text(`${message}\n`);
}

/**
 * @param {string} binary
 */
async function isRovoAuthenticated(binary) {
	try {
		const { command, args } = commandForSpawn(binary, ['rovodev', 'auth', 'status']);
		const result = await execFileAsync(command, args, { windowsHide: true });
		const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
		return !/unauthorized|auth login|not authenticated/.test(output);
	} catch {
		return false;
	}
}

/**
 * @param {string} binary
 * @param {string} email
 * @param {string} token
 * @param {import('./engine-contract.d.ts').Runtime['logger']} logger
 * @param {import('./engine-contract.d.ts').Emitter} emitter
 */
async function ensureRovoAuth(binary, email, token, logger, emitter) {
	const hasEmail = Boolean(email?.trim());
	const hasToken = Boolean(token?.trim());

	if (await isRovoAuthenticated(binary)) {
		return;
	}

	if (!hasEmail || !hasToken) {
		const help = rovoAuthSetupMessage({
			missingEmail: !hasEmail,
			missingToken: !hasToken,
		});
		await reportRovoAuthFailure(emitter, help);
		throw new Error(
			'Rovo Dev CLI is not authenticated. Provide ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN in ~/.agent-hippo/.env.',
		);
	}

	const { command, args } = commandForSpawn(binary, [
		'rovodev', 'auth', 'login', '--email', email.trim(), '--token',
	]);

	await new Promise((resolve, reject) => {
		const proc = spawn(command, args, {
			env: { ...process.env, NO_COLOR: '1' },
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true,
		});

		let err = '';
		proc.stderr.on('data', chunk => { err += chunk.toString(); });
		proc.stdin.write(token.trim());
		proc.stdin.end();
		proc.on('error', reject);
		proc.on('close', code => {
			if (code === 0) {
				logger.info('[Rovo CLI] Authenticated via ATLASSIAN_EMAIL + ATLASSIAN_API_TOKEN');
				resolve(undefined);
				return;
			}
			reject(new Error(err.trim() || `acli rovodev auth login exited ${code}`));
		});
	}).catch(async (error) => {
		const detail = error instanceof Error ? error.message : String(error);
		const help = rovoAuthSetupMessage({
			missingEmail: false,
			missingToken: false,
			detail: `Auth failed for ${email.trim()}. Ensure ATLASSIAN_EMAIL matches the token owner. ${detail}`,
		});
		await reportRovoAuthFailure(emitter, help);
		throw new Error(
			'Rovo Dev CLI authentication failed. Update ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN in ~/.agent-hippo/.env.',
		);
	});

	if (!(await isRovoAuthenticated(binary))) {
		const help = rovoAuthSetupMessage({
			detail: 'Credentials were provided but Rovo Dev CLI is still not authenticated.',
		});
		await reportRovoAuthFailure(emitter, help);
		throw new Error(
			'Rovo Dev CLI is not authenticated after login attempt. Check ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN.',
		);
	}
}

/**
 * @param {string} stdout
 * @param {string} stderr
 */
function extractAssistantText(stdout, stderr) {
	const combined = `${stdout}\n${stderr}`.trim();
	if (!combined) {
		return '';
	}

	const json = parseJson(combined);
	if (json) {
		if (typeof json.text === 'string') {
			return json.text.trim();
		}
		if (typeof json.message === 'string') {
			return json.message.trim();
		}
		if (Array.isArray(json.payloads)) {
			return json.payloads
				.map(payload => (payload && typeof payload === 'object' && typeof payload.text === 'string' ? payload.text : ''))
				.filter(Boolean)
				.join('\n\n')
				.trim();
		}
	}

	const lines = combined.split(/\r?\n/).filter(line => {
		const trimmed = line.trim();
		if (!trimmed) {
			return false;
		}
		if (/^acli version\b/i.test(trimmed)) {
			return false;
		}
		if (/^✗ Error:/i.test(trimmed)) {
			return false;
		}
		if (/authenticate your Atlassian account/i.test(trimmed)) {
			return false;
		}
		if (SESSION_ID_RE.test(trimmed) && trimmed.length < 64) {
			return false;
		}
		return true;
	});

	return lines.join('\n').trim();
}

/**
 * @param {string} raw
 */
function parseJson(raw) {
	const trimmed = raw.trim();
	if (!trimmed) {
		return undefined;
	}
	try {
		return JSON.parse(trimmed);
	} catch {
		const start = trimmed.indexOf('{');
		const end = trimmed.lastIndexOf('}');
		if (start >= 0 && end > start) {
			try {
				return JSON.parse(trimmed.slice(start, end + 1));
			} catch {
				return undefined;
			}
		}
	}
	return undefined;
}

export class RovoDevCliEngine {
	/** @type {string | undefined | null} */
	#binaryPath = undefined;

	/**
	 * @param {import('./engine-contract.d.ts').CustomEngineTurn} turn
	 */
	async run(turn) {
		const { emitter, runtime, signal } = turn;

		if (this.#binaryPath === undefined) {
			this.#binaryPath = await findAcliBinary();
		}
		if (!this.#binaryPath) {
			throw new Error(
				'Atlassian CLI (acli) not found. Install ACLI and Rovo Dev, then run: acli rovodev auth login. Set ACLI_PATH or ROVO_ACLI_PATH to override.',
			);
		}

		const homeDir = resolveHomeDir(turn);
		const email =
			turn.env.ATLASSIAN_EMAIL?.trim() ||
			process.env.ATLASSIAN_EMAIL?.trim();
		const token =
			turn.env.ATLASSIAN_API_TOKEN?.trim() ||
			process.env.ATLASSIAN_API_TOKEN?.trim() ||
			turn.routing.apiKey?.trim();
		await ensureRovoAuth(this.#binaryPath, email || '', token || '', runtime.logger, emitter);

		let nativeSessionId = turn.session.nativeSessionId?.trim() || undefined;
		const cliArgs = ['rovodev', 'run', '--yolo'];

		if (nativeSessionId) {
			cliArgs.push('--restore', nativeSessionId);
		}

		cliArgs.push(turn.message);

		const { command, args } = commandForSpawn(this.#binaryPath, cliArgs);
		runtime.logger.info(`[Rovo CLI] home=${homeDir}, session=${nativeSessionId || '(new)'}, cwd=${turn.workspaceRoot}`);

		const { stdout, stderr, exitCode } = await new Promise((resolve, reject) => {
			const proc = spawn(command, args, {
				cwd: turn.workspaceRoot,
				env: {
					...turn.env,
					ROVODEV_HOME: homeDir,
					ATLASSIAN_API_TOKEN: turn.env.ATLASSIAN_API_TOKEN || turn.routing.apiKey || '',
					NO_COLOR: '1',
					FORCE_COLOR: '0',
					CI: '1',
				},
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
				for (const line of text.split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
					runtime.logger.debug(`[Rovo CLI] ${line}`);
				}
			});
			proc.on('error', error => reject(new Error(`Failed to spawn ACLI (${command}): ${error.message}`)));
			proc.on('close', code => {
				signal?.removeEventListener('abort', abort);
				if (signal?.aborted) {
					reject(new Error('Rovo Dev CLI run aborted'));
					return;
				}
				resolve({ stdout: out, stderr: err, exitCode: code });
			});
		});

		const combined = `${stdout}\n${stderr}`.trim();
		if (exitCode !== 0 && exitCode !== null) {
			const authHint = /authenticate your Atlassian account|rovodev auth login|unauthorized/i.test(combined);
			const detail = combined || `Rovo Dev CLI exited with code ${exitCode}`;
			if (authHint) {
				const help = rovoAuthSetupMessage({
					missingEmail: !email,
					missingToken: !token,
					detail,
				});
				await reportRovoAuthFailure(emitter, help);
				throw new Error(
					'Rovo Dev CLI is not authenticated. Provide ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN in ~/.agent-hippo/.env.',
				);
			}
			throw new Error(detail);
		}

		if (!nativeSessionId) {
			nativeSessionId =
				extractSessionId(combined) ||
				await discoverLatestSessionId(homeDir, turn.workspaceRoot) ||
				stableFallbackSessionId(turn);
		}

		const text = extractAssistantText(stdout, stderr);
		if (text) {
			await emitter.text(text);
		}
		await emitter.done();

		return { nativeSessionId };
	}

	/** @param {import('./engine-contract.d.ts').Runtime['logger']} logger */
	onMaintenance(logger) {
		this.#binaryPath = undefined;
		logger.info('[Rovo CLI] Maintenance: binary path cache cleared');
	}

	dispose() {
		this.#binaryPath = undefined;
	}
}
