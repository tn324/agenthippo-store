#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_REPO_URL = 'git@github.com:agenthippoai/custom-engines.git';

function usage() {
	return [
		'Usage:',
		'  node install-engine.mjs <engine...> [options]',
		'',
		'Options:',
		'  --repo-url <url>       Source Git repo when --source-root is omitted',
		'  --ref <ref>            Branch, tag, or SHA to checkout in the cache repo',
		'  --source-root <path>   Existing folder containing engine directories',
		'  --cache-root <path>    Git cache folder',
		'  --install-root <path>  Destination engines folder',
		'  --no-npm-ci           Skip npm ci',
		'  --help                Show this help',
	].join('\n');
}

function parseArgs(argv) {
	const options = {
		engines: [],
		repoUrl: DEFAULT_REPO_URL,
		ref: '',
		sourceRoot: '',
		cacheRoot: '',
		installRoot: '',
		noNpmCi: false,
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--help' || arg === '-h') {
			console.log(usage());
			process.exit(0);
		}
		if (arg === '--no-npm-ci') {
			options.noNpmCi = true;
			continue;
		}
		if (arg.startsWith('--')) {
			const [name, inlineValue] = arg.split(/=(.*)/s, 2);
			const key = {
				'--repo-url': 'repoUrl',
				'--ref': 'ref',
				'--source-root': 'sourceRoot',
				'--cache-root': 'cacheRoot',
				'--install-root': 'installRoot',
			}[name];
			if (!key) {
				throw new Error(`Unknown option: ${name}`);
			}
			const value = inlineValue !== undefined ? inlineValue : argv[++i];
			if (!value) {
				throw new Error(`Missing value for ${name}`);
			}
			options[key] = value;
			continue;
		}
		options.engines.push(arg);
	}

	if (options.engines.length === 0) {
		throw new Error(`At least one engine id is required.\n\n${usage()}`);
	}

	return options;
}

function fullPath(value) {
	return path.resolve(value.replace(/^~(?=$|[\\/])/, os.homedir()));
}

function commandExists(command) {
	const result = spawnSync(command, ['--version'], {
		stdio: 'ignore',
		shell: process.platform === 'win32',
	});
	return result.status === 0;
}

function run(command, args, options = {}) {
	console.log(`>> ${command} ${args.join(' ')}`);
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		stdio: 'inherit',
		shell: process.platform === 'win32',
		env: process.env,
	});
	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0) {
		throw new Error(`Command failed with exit code ${result.status}: ${command} ${args.join(' ')}`);
	}
}

function ensureSourceRoot(options) {
	if (options.sourceRoot.trim()) {
		const sourceRoot = fullPath(options.sourceRoot);
		if (!fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) {
			throw new Error(`Source root does not exist: ${sourceRoot}`);
		}
		return sourceRoot;
	}

	if (!commandExists('git')) {
		throw new Error('git is required when --source-root is not provided');
	}

	const cacheRoot = fullPath(
		options.cacheRoot.trim() ||
		path.join(os.homedir(), '.agent-hippo', 'cache', 'custom-engines', 'agenthippoai-custom-engines'),
	);
	fs.mkdirSync(path.dirname(cacheRoot), { recursive: true });

	const gitDir = path.join(cacheRoot, '.git');
	if (fs.existsSync(gitDir) && fs.statSync(gitDir).isDirectory()) {
		run('git', ['-C', cacheRoot, 'fetch', '--all', '--tags', '--prune']);
		if (options.ref.trim()) {
			run('git', ['-C', cacheRoot, 'checkout', options.ref.trim()]);
		} else {
			run('git', ['-C', cacheRoot, 'pull', '--ff-only']);
		}
		return cacheRoot;
	}

	if (fs.existsSync(cacheRoot)) {
		throw new Error(`Cache root exists but is not a Git checkout: ${cacheRoot}`);
	}

	run('git', ['clone', options.repoUrl, cacheRoot]);
	if (options.ref.trim()) {
		run('git', ['-C', cacheRoot, 'checkout', options.ref.trim()]);
	}
	return cacheRoot;
}

function assertDestinationWithinRoot(destination, installRoot) {
	const resolvedRoot = fullPath(installRoot);
	const resolvedDestination = fullPath(destination);
	const rootPrefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
	if (!resolvedDestination.startsWith(rootPrefix)) {
		throw new Error(`Refusing to write outside install root: ${resolvedDestination}`);
	}
	if (resolvedDestination === resolvedRoot) {
		throw new Error('Refusing to replace the install root itself');
	}
}

function copyDirectoryContents(source, destination) {
	fs.mkdirSync(destination, { recursive: true });
	for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
		if (entry.name === 'node_modules' || entry.name === '.git') {
			continue;
		}
		const src = path.join(source, entry.name);
		const dest = path.join(destination, entry.name);
		if (entry.isDirectory()) {
			fs.cpSync(src, dest, { recursive: true, force: true });
		} else if (entry.isFile() || entry.isSymbolicLink()) {
			fs.copyFileSync(src, dest);
		}
	}
}

function readManifest(manifestPath) {
	let manifest;
	try {
		manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	} catch (err) {
		throw new Error(`Failed to parse ${manifestPath}: ${err.message}`);
	}
	if (manifest.version !== 2) {
		throw new Error(`Manifest version must be 2: ${manifestPath}`);
	}
	if (typeof manifest.id !== 'string' || !manifest.id.trim()) {
		throw new Error(`Manifest is missing id: ${manifestPath}`);
	}
	if (typeof manifest.entry !== 'string' || !manifest.entry.trim()) {
		throw new Error(`Manifest is missing entry: ${manifestPath}`);
	}
	return manifest;
}

function installEngine(engineName, sourceRoot, installRoot, options) {
	const source = path.join(sourceRoot, engineName);
	if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
		throw new Error(`Engine "${engineName}" not found under source root: ${sourceRoot}`);
	}

	const sourceManifestPath = path.join(source, 'engine.manifest.json');
	if (!fs.existsSync(sourceManifestPath)) {
		throw new Error(`Missing engine.manifest.json for "${engineName}": ${sourceManifestPath}`);
	}

	const sourceManifest = readManifest(sourceManifestPath);
	const engineId = sourceManifest.id.trim().toLowerCase();
	const destination = path.join(installRoot, engineId);
	assertDestinationWithinRoot(destination, installRoot);

	console.log(`Installing engine "${engineName}" as "${engineId}"`);
	fs.mkdirSync(installRoot, { recursive: true });
	if (fs.existsSync(destination)) {
		fs.rmSync(destination, { recursive: true, force: true });
	}
	fs.mkdirSync(destination, { recursive: true });
	copyDirectoryContents(source, destination);

	const manifest = readManifest(path.join(destination, 'engine.manifest.json'));
	const entryPath = path.isAbsolute(manifest.entry)
		? manifest.entry
		: path.resolve(destination, manifest.entry);
	if (!fs.existsSync(entryPath)) {
		throw new Error(`Manifest entry not found after install: ${entryPath}`);
	}

	const packageJson = path.join(destination, 'package.json');
	if (fs.existsSync(packageJson) && !options.noNpmCi) {
		if (!commandExists('npm')) {
			throw new Error(`npm is required to install dependencies for "${engineId}"`);
		}
		const packageLock = path.join(destination, 'package-lock.json');
		if (!fs.existsSync(packageLock)) {
			throw new Error(`package-lock.json is required for deterministic npm ci: ${packageLock}`);
		}
		run('npm', ['ci', '--prefix', destination, '--omit=dev']);
	}

	if (!commandExists('node')) {
		throw new Error('node is required for syntax validation');
	}
	run('node', ['--check', entryPath]);
	console.log(`Installed custom engine "${engineId}" at ${destination}`);
}

try {
	const options = parseArgs(process.argv.slice(2));
	const sourceRoot = ensureSourceRoot(options);
	const installRoot = fullPath(
		options.installRoot.trim() ||
		path.join(os.homedir(), '.agent-hippo', 'engines'),
	);

	for (const engine of options.engines) {
		installEngine(engine, sourceRoot, installRoot, options);
	}

	console.log(`Done. AgentHippo will discover installed engines from: ${installRoot}`);
} catch (err) {
	console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
}
