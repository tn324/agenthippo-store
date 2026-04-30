#!/usr/bin/env bun
/**
 * Store readiness linter.
 *
 * Scans listed public artifacts for upstream runtime/install instructions that
 * make the AgentHippo Store look like a thin mirror of another agent runtime.
 * Keep source provenance in _meta.json if useful; keep public instructions
 * AgentHippo-native.
 */

import { readdir, readFile, stat } from 'fs/promises';
import { basename, extname, join, relative } from 'path';
import { parse as parseYaml } from 'yaml';

type ArtifactType = 'pack' | 'skill' | 'mcp';

interface Artifact {
	type: ArtifactType;
	slug: string;
	dir: string;
}

interface StoreListing {
	listed?: boolean;
	reason?: string;
}

interface PackManifest {
	metadata?: {
		store?: StoreListing;
	};
	spec?: {
		visibility?: string;
	};
}

interface SkillFrontmatter {
	store?: StoreListing;
}

interface McpManifest {
	store?: StoreListing;
}

interface PatternRule {
	label: string;
	pattern: RegExp;
}

const TEXT_EXTENSIONS = new Set([
	'.json',
	'.md',
	'.toml',
	'.yaml',
	'.yml',
]);

const FAIL_PATTERNS: PatternRule[] = [
	{ label: 'Claude Code marketplace install flow', pattern: /\/plugin\s+(?:install|marketplace|update)\b/i },
	{ label: 'Claude Code local plugin runner', pattern: /\bcc\s+--plugin-dir\b/i },
	{ label: 'Claude Code repository availability claim', pattern: /Claude Code repository/i },
	{ label: 'Claude Code marketplace availability claim', pattern: /Claude Code Marketplace/i },
	{ label: 'Claude plugin root environment variable', pattern: /\bCLAUDE_PLUGIN_ROOT\b/ },
	{ label: 'Claude project/state directory', pattern: /(?:^|[`\s])(?:~\/)?\.claude(?:\/|\b)/i },
	{ label: 'Claude plugin manifest path', pattern: /\.claude-plugin\b/i },
	{ label: 'ClawHub install/update command', pattern: /\bclawhub\s+(?:install|star|sync)\b/i },
	{ label: 'ClawHub marketplace link', pattern: /clawhub\.ai/i },
	{ label: 'Clawdbot runtime branding', pattern: /\bClawdbot\b/i },
	{ label: 'External Shopify skill fetch', pattern: /(?:https?:\/\/(?:www\.)?)?shopify\.com\/SKILL\.md/i },
	{ label: 'External skill installer command', pattern: /\bnpx\s+skills\s+add\b/i },
	{ label: 'Unresolved Shopify instrumentation placeholder', pattern: /\bYOUR_MODEL_NAME\b/ },
	{ label: 'Upstream client placeholder', pattern: /claude-code\/cursor/i },
	{ label: 'Claude runtime phrasing', pattern: /\b(?:Claude automatically|Claude will|Claude may|Ask Claude|Let Claude|Claude has already|Claude generated)\b/i },
	{ label: 'Claude Code attribution/install wording', pattern: /\bClaude Code (?:attribution|installed)\b/i },
	{ label: 'Claude artifact surface', pattern: /\bclaude\.ai\b/i },
	{ label: 'Upstream Anthropic UI branding', pattern: /\bAnthropic branding\b/i },
	{ label: 'Upstream Claude Code example URL', pattern: /github\.com\/anthropics\/claude-code/i },
];

const WARN_PATTERNS: PatternRule[] = [
	{ label: 'Claude-specific project guidance file', pattern: /\bCLAUDE\.md\b/ },
	{ label: 'Claude tool-name drift', pattern: /\b(?:TodoWrite|AskUserQuestion|Task tool|Read tool|Write tool|Glob tool|Grep tool|WebFetch|WebSearch)\b/ },
	{ label: 'Third-party Maton gateway dependency', pattern: /^\s*(?:compatibility:.*Maton|author:\s*maton)\b/i },
];

function parseFrontmatter(content: string): Record<string, unknown> {
	if (!content.startsWith('---')) {
		return {};
	}
	const lines = content.split('\n');
	const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
	if (end === -1) {
		return {};
	}
	try {
		return parseYaml(lines.slice(1, end).join('\n')) as Record<string, unknown>;
	} catch {
		return {};
	}
}

async function readYamlFile<T>(path: string): Promise<T | null> {
	try {
		return parseYaml(await readFile(path, 'utf8')) as T;
	} catch {
		return null;
	}
}

async function readJsonFile<T>(path: string): Promise<T | null> {
	try {
		return JSON.parse(await readFile(path, 'utf8')) as T;
	} catch {
		return null;
	}
}

async function isListedPack(dir: string): Promise<boolean> {
	const manifest = await readYamlFile<PackManifest>(join(dir, 'agent.yaml'));
	return Boolean(manifest && manifest.spec?.visibility === 'public' && manifest.metadata?.store?.listed !== false);
}

async function isListedSkill(dir: string): Promise<boolean> {
	try {
		const content = await readFile(join(dir, 'SKILL.md'), 'utf8');
		const frontmatter = parseFrontmatter(content) as SkillFrontmatter;
		return frontmatter.store?.listed !== false;
	} catch {
		return false;
	}
}

async function isListedMcp(dir: string): Promise<boolean> {
	const manifest = await readJsonFile<McpManifest>(join(dir, 'mcp.json'));
	return Boolean(manifest && manifest.store?.listed !== false);
}

async function artifactDirs(root: string, type: ArtifactType): Promise<Artifact[]> {
	const artifacts: Artifact[] = [];
	for (const entry of await readdir(root).catch(() => [])) {
		if (entry.startsWith('.')) {
			continue;
		}
		const dir = join(root, entry);
		const info = await stat(dir).catch(() => null);
		if (!info?.isDirectory()) {
			continue;
		}

		let listed = false;
		if (type === 'pack') {
			listed = await isListedPack(dir);
		} else if (type === 'skill') {
			listed = await isListedSkill(dir);
		} else {
			listed = await isListedMcp(dir);
		}

		if (listed) {
			artifacts.push({ type, slug: basename(dir), dir });
		}
	}
	return artifacts;
}

async function collectTextFiles(dir: string): Promise<string[]> {
	const files: string[] = [];
	async function walk(current: string) {
		for (const entry of await readdir(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === 'node_modules') {
					continue;
				}
				await walk(path);
				continue;
			}
			if (entry.name === '_meta.json' || entry.name === 'package-lock.json') {
				continue;
			}
			if (TEXT_EXTENSIONS.has(extname(entry.name))) {
				files.push(path);
			}
		}
	}
	await walk(dir);
	return files;
}

function checkContent(path: string, content: string, rules: PatternRule[]) {
	const hits: Array<{ label: string; line: number; text: string }> = [];
	const lines = content.split('\n');
	for (const rule of rules) {
		for (let index = 0; index < lines.length; index++) {
			if (rule.pattern.test(lines[index])) {
				hits.push({
					label: rule.label,
					line: index + 1,
					text: lines[index].trim(),
				});
			}
		}
	}
	return hits.map((hit) => ({
		...hit,
		path,
	}));
}

async function main() {
	const artifacts = [
		...(await artifactDirs('agent-packs', 'pack')),
		...(await artifactDirs('skills', 'skill')),
		...(await artifactDirs('mcp', 'mcp')),
	];

	const failures: Array<{ path: string; line: number; label: string; text: string }> = [];
	const warnings: Array<{ path: string; line: number; label: string; text: string }> = [];

	for (const artifact of artifacts) {
		for (const file of await collectTextFiles(artifact.dir)) {
			const content = await readFile(file, 'utf8');
			failures.push(...checkContent(file, content, FAIL_PATTERNS));
			warnings.push(...checkContent(file, content, WARN_PATTERNS));
		}
	}

	for (const hit of failures) {
		console.error(`FAIL ${hit.label}: ${relative(process.cwd(), hit.path)}:${hit.line}`);
		console.error(`  ${hit.text}`);
	}
	for (const hit of warnings) {
		console.warn(`WARN ${hit.label}: ${relative(process.cwd(), hit.path)}:${hit.line}`);
		console.warn(`  ${hit.text}`);
	}

	if (failures.length > 0) {
		console.error(`\nStore readiness failed: ${failures.length} blocker(s), ${warnings.length} warning(s).`);
		process.exit(1);
	}

	console.log(`Store readiness passed: ${artifacts.length} listed artifact(s), ${warnings.length} warning(s).`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
