#!/usr/bin/env bun
/**
 * Copy or split MCP server definitions into agenthippo-store/mcp.
 *
 * Supported source shapes:
 *   <source>/<slug>/mcp.json          Store-style single MCP manifest
 *   <source>/<slug>/.mcp.json         Claude/VSC-style { mcpServers: { ... } }
 *   <source>/.mcp.json                Claude/VSC-style root config
 */

import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'fs';
import { basename, join, relative } from 'path';

type ServerConfig = Record<string, unknown> & {
	name?: string;
	version?: string;
	description?: string;
	label?: string;
	transport?: string;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	npmPackage?: string;
	disabled?: boolean;
};

type Args = {
	source: string;
	store: string;
	names: string[];
	dryRun: boolean;
};

function usage(): never {
	console.error(`Usage: push-mcp-to-store.ts --source <path> --store <agenthippo-store> [mcp-name ...]

Options:
  --source <path>  Source MCP directory or repo
  --store <path>   agenthippo-store repo path
  --dry-run        Preview without writing
  -h, --help       Show this help
`);
	process.exit(2);
}

function parseArgs(argv: string[]): Args {
	let source = process.env.MCP_REPO_PATH || process.env.MCP_SOURCE_PATH || '';
	let store = process.env.STORE_REPO_PATH || process.cwd();
	let dryRun = process.env.DRY_RUN === '1';
	const names: string[] = [];

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case '--source':
				source = argv[++i] || '';
				break;
			case '--store':
				store = argv[++i] || '';
				break;
			case '--dry-run':
				dryRun = true;
				break;
			case '-h':
			case '--help':
				usage();
				break;
			default:
				if (arg.startsWith('-')) {
					console.error(`Unknown option: ${arg}`);
					usage();
				}
				names.push(arg);
		}
	}

	if (!source || !store) {
		usage();
	}

	return { source, store, names, dryRun };
}

function slugify(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '-')
		.replace(/^-+|-+$/g, '') || 'mcp';
}

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, 'utf8'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function transportFor(config: ServerConfig): string {
	if (typeof config.transport === 'string') {
		return config.transport;
	}
	if (typeof config.url === 'string' && config.url.length > 0) {
		return config.url.includes('/sse') ? 'sse' : 'http';
	}
	return 'stdio';
}

function cleanManifest(name: string, config: ServerConfig): Record<string, unknown> {
	const manifest: Record<string, unknown> = {
		name,
		version: typeof config.version === 'string' ? config.version : '1.0.0',
		description:
			typeof config.description === 'string'
				? config.description
				: typeof config.label === 'string'
					? config.label
					: `MCP server: ${name}`,
		transport: transportFor(config),
	};

	for (const key of [
		'command',
		'args',
		'env',
		'url',
		'npmPackage',
		'headers',
		'cwd',
		'tags',
		'author',
	]) {
		if (config[key] !== undefined) {
			manifest[key] = config[key];
		}
	}

	return JSON.parse(JSON.stringify(manifest));
}

function copySupportFiles(sourceDir: string, destDir: string, serverName: string): void {
	const supportDir = join(sourceDir, serverName);
	if (existsSync(supportDir) && statSync(supportDir).isDirectory()) {
		cpSync(supportDir, destDir, {
			recursive: true,
			filter: (source) => {
				const base = basename(source);
				return !['.git', 'node_modules', 'dist', 'build', '.DS_Store', '__pycache__'].includes(base);
			},
		});
	}
}

function writeManifest(destRoot: string, name: string, manifest: Record<string, unknown>, dryRun: boolean): void {
	const slug = slugify(name);
	const destDir = join(destRoot, 'mcp', slug);
	if (dryRun) {
		console.log(`[DRY RUN] Would write ${relative(process.cwd(), join(destDir, 'mcp.json'))}`);
		return;
	}
	rmSync(destDir, { recursive: true, force: true });
	mkdirSync(destDir, { recursive: true });
	writeFileSync(join(destDir, 'mcp.json'), `${JSON.stringify(manifest, null, 2)}\n`);
	console.log(`Copied MCP: ${slug}`);
}

function copyStoreStyleMcp(sourceDir: string, destRoot: string, dryRun: boolean): string | null {
	const manifestPath = join(sourceDir, 'mcp.json');
	if (!existsSync(manifestPath)) {
		return null;
	}

	const manifest = readJson(manifestPath);
	if (!isRecord(manifest)) {
		throw new Error(`Invalid JSON object: ${manifestPath}`);
	}

	const name = typeof manifest.name === 'string' ? manifest.name : basename(sourceDir);
	const normalizedManifest = cleanManifest(name, manifest as ServerConfig);
	for (const [key, value] of Object.entries(manifest)) {
		if (normalizedManifest[key] === undefined) {
			normalizedManifest[key] = value;
		}
	}
	const slug = slugify(name);
	const destDir = join(destRoot, 'mcp', slug);

	if (dryRun) {
		console.log(`[DRY RUN] Would copy ${sourceDir} -> ${destDir}`);
		return slug;
	}

	rmSync(destDir, { recursive: true, force: true });
	cpSync(sourceDir, destDir, {
		recursive: true,
		filter: (source) => {
			const base = basename(source);
			return !['.git', 'node_modules', 'dist', 'build', '.DS_Store', '__pycache__'].includes(base);
		},
	});
	writeFileSync(join(destDir, 'mcp.json'), `${JSON.stringify(normalizedManifest, null, 2)}\n`);
	console.log(`Copied MCP: ${slug}`);
	return slug;
}

function splitMcpConfig(
	sourceDir: string,
	config: Record<string, unknown>,
	destRoot: string,
	dryRun: boolean,
	filterNames: string[] = [],
): string[] {
	if (!isRecord(config.mcpServers)) {
		return [];
	}

	const wanted = new Set(filterNames.map(slugify));
	const processed: string[] = [];
	for (const [serverName, rawConfig] of Object.entries(config.mcpServers)) {
		if (!isRecord(rawConfig)) {
			continue;
		}
		const slug = slugify(serverName);
		if (wanted.size > 0 && !wanted.has(slug)) {
			continue;
		}
		const serverConfig = rawConfig as ServerConfig;
		if (serverConfig.disabled === true) {
			continue;
		}

		const manifest = cleanManifest(serverName, serverConfig);
		const destDir = join(destRoot, 'mcp', slug);
		writeManifest(destRoot, serverName, manifest, dryRun);
		if (!dryRun) {
			copySupportFiles(sourceDir, destDir, serverName);
		}
		processed.push(slug);
	}
	return processed;
}

function discoverConfigDirs(sourceRoot: string): string[] {
	const dirs = new Set<string>();

	if (existsSync(join(sourceRoot, 'mcp.json')) || existsSync(join(sourceRoot, '.mcp.json'))) {
		dirs.add(sourceRoot);
	}

	for (const entry of readdirSync(sourceRoot)) {
		if (entry.startsWith('.')) {
			continue;
		}
		const dir = join(sourceRoot, entry);
		if (!statSync(dir).isDirectory()) {
			continue;
		}
		if (existsSync(join(dir, 'mcp.json')) || existsSync(join(dir, '.mcp.json'))) {
			dirs.add(dir);
		}
	}

	return [...dirs].sort();
}

function main(): void {
	const args = parseArgs(process.argv.slice(2));
	if (!existsSync(args.source)) {
		throw new Error(`MCP source not found: ${args.source}`);
	}

	const filter = new Set(args.names.map(slugify));
	const dirs = discoverConfigDirs(args.source).filter((dir) => {
		if (filter.size === 0) {
			return true;
		}
		return filter.has(slugify(basename(dir))) || existsSync(join(dir, '.mcp.json'));
	});

	if (dirs.length === 0) {
		console.log(`No MCP manifests found in ${args.source}`);
		return;
	}

	const processed = new Set<string>();
	for (const dir of dirs) {
		const dotMcp = join(dir, '.mcp.json');
		if (existsSync(dotMcp)) {
			const config = readJson(dotMcp);
			if (!isRecord(config)) {
				throw new Error(`Invalid JSON object: ${dotMcp}`);
			}
			for (const slug of splitMcpConfig(dir, config, args.store, args.dryRun, args.names)) {
				processed.add(slug);
			}
			continue;
		}

		const copied = copyStoreStyleMcp(dir, args.store, args.dryRun);
		if (copied && (filter.size === 0 || filter.has(slugify(copied)))) {
			processed.add(copied);
		}
	}

	console.log(`MCP processed: ${processed.size}`);
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
