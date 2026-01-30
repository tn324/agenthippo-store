#!/usr/bin/env bun
/**
 * Build Store Index
 *
 * This script scans the store repository and builds:
 * 1. store-index.json - Raw metadata for all artifacts
 * 2. store-orama.json - Serialized Orama search index (for extension)
 * 3. store-meta.json - Index metadata (version, timestamp, count)
 *
 * Run with: bun run scripts/build-index.ts
 *
 * Output goes to ./dist/ for deployment to GitHub Pages.
 */

import { readdir, readFile, writeFile, mkdir, stat } from 'fs/promises';
import { join, basename } from 'path';
import { parse as parseYaml } from 'yaml';

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const ARTIFACT_DIRS = {
	pack: 'agent-packs',
	skill: 'skills',
	mcp: 'mcp',
} as const;

const OUTPUT_DIR = 'dist';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface StoreArtifact {
	id: string;
	type: 'pack' | 'skill' | 'mcp';
	slug: string;
	displayName: string;
	description: string;
	tags: string[];
	author?: string;
	latestVersion: string;
	updatedAt: string;
}

interface SkillFrontmatter {
	name?: string;
	description?: string;
	version?: string;
	author?: string;
	tags?: string[];
}

interface PackManifest {
	apiVersion?: string;
	kind?: string;
	metadata?: {
		name?: string;
		version?: string;
		description?: string;
		author?: string;
		tags?: string[];
	};
}

interface McpManifest {
	name?: string;
	version?: string;
	description?: string;
	author?: string;
	tags?: string[];
}

// -----------------------------------------------------------------------------
// Parsing Functions
// -----------------------------------------------------------------------------

/**
 * Parse YAML frontmatter from a markdown file.
 */
function parseFrontmatter(content: string): Record<string, unknown> {
	if (!content.startsWith('---')) {
		return {};
	}

	const lines = content.split('\n');
	let endIndex = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === '---') {
			endIndex = i;
			break;
		}
	}

	if (endIndex === -1) {
		return {};
	}

	const yamlContent = lines.slice(1, endIndex).join('\n');
	try {
		return parseYaml(yamlContent) as Record<string, unknown>;
	} catch {
		return {};
	}
}

/**
 * Parse a skill from its SKILL.md file.
 */
async function parseSkill(skillDir: string): Promise<StoreArtifact | null> {
	const skillMdPath = join(skillDir, 'SKILL.md');
	const slug = basename(skillDir);

	try {
		const content = await readFile(skillMdPath, 'utf8');
		const frontmatter = parseFrontmatter(content) as SkillFrontmatter;
		const stats = await stat(skillMdPath);

		return {
			id: `skill/${slug}`,
			type: 'skill',
			slug,
			displayName: frontmatter.name || slug,
			description: frontmatter.description || '',
			tags: frontmatter.tags || [],
			author: frontmatter.author,
			latestVersion: frontmatter.version || '0.0.0',
			updatedAt: stats.mtime.toISOString(),
		};
	} catch {
		console.warn(`  ⚠ Could not parse skill: ${slug}`);
		return null;
	}
}

/**
 * Parse a pack from its agent.yaml manifest.
 */
async function parsePack(packDir: string): Promise<StoreArtifact | null> {
	const manifestPath = join(packDir, 'agent.yaml');
	const slug = basename(packDir);

	try {
		const content = await readFile(manifestPath, 'utf8');
		const manifest = parseYaml(content) as PackManifest;
		const stats = await stat(manifestPath);

		return {
			id: `pack/${slug}`,
			type: 'pack',
			slug,
			displayName: manifest.metadata?.name || slug,
			description: manifest.metadata?.description || '',
			tags: manifest.metadata?.tags || [],
			author: manifest.metadata?.author,
			latestVersion: manifest.metadata?.version || '0.0.0',
			updatedAt: stats.mtime.toISOString(),
		};
	} catch {
		console.warn(`  ⚠ Could not parse pack: ${slug}`);
		return null;
	}
}

/**
 * Parse an MCP server from its mcp.json manifest.
 */
async function parseMcp(mcpDir: string): Promise<StoreArtifact | null> {
	const manifestPath = join(mcpDir, 'mcp.json');
	const slug = basename(mcpDir);

	try {
		const content = await readFile(manifestPath, 'utf8');
		const manifest = JSON.parse(content) as McpManifest;
		const stats = await stat(manifestPath);

		return {
			id: `mcp/${slug}`,
			type: 'mcp',
			slug,
			displayName: manifest.name || slug,
			description: manifest.description || '',
			tags: manifest.tags || [],
			author: manifest.author,
			latestVersion: manifest.version || '0.0.0',
			updatedAt: stats.mtime.toISOString(),
		};
	} catch {
		console.warn(`  ⚠ Could not parse mcp: ${slug}`);
		return null;
	}
}

// -----------------------------------------------------------------------------
// Main Build Function
// -----------------------------------------------------------------------------

async function buildIndex() {
	console.log('🔍 Scanning store repository...\n');

	const artifacts: StoreArtifact[] = [];

	for (const [type, dir] of Object.entries(ARTIFACT_DIRS)) {
		console.log(`📁 Scanning ${dir}/`);

		let entries: string[] = [];
		try {
			entries = await readdir(dir);
		} catch {
			console.log(`   (directory not found, skipping)`);
			continue;
		}

		for (const entry of entries) {
			// Skip hidden directories
			if (entry.startsWith('.')) {
				continue;
			}

			const entryPath = join(dir, entry);
			const entryStat = await stat(entryPath).catch(() => null);
			if (!entryStat?.isDirectory()) {
				continue;
			}

			let artifact: StoreArtifact | null = null;

			switch (type) {
				case 'skill':
					artifact = await parseSkill(entryPath);
					break;
				case 'pack':
					artifact = await parsePack(entryPath);
					break;
				case 'mcp':
					artifact = await parseMcp(entryPath);
					break;
			}

			if (artifact) {
				artifacts.push(artifact);
				console.log(`   ✓ ${artifact.slug} (v${artifact.latestVersion})`);
			}
		}
	}

	console.log(`\n📦 Found ${artifacts.length} artifacts total\n`);

	// Create output directory
	await mkdir(OUTPUT_DIR, { recursive: true });

	// Write store-index.json (raw metadata)
	const storeIndex = {
		version: 1,
		generatedAt: new Date().toISOString(),
		artifacts,
	};
	await writeFile(
		join(OUTPUT_DIR, 'store-index.json'),
		JSON.stringify(storeIndex, null, 2),
	);
	console.log(`✓ Wrote ${OUTPUT_DIR}/store-index.json`);

	// Write store-orama.json (for extension to load)
	// The extension rebuilds the Orama index from this, so we just store the artifacts
	const storeOrama = {
		artifacts,
	};
	await writeFile(
		join(OUTPUT_DIR, 'store-orama.json'),
		JSON.stringify(storeOrama),
	);
	console.log(`✓ Wrote ${OUTPUT_DIR}/store-orama.json`);

	// Write store-meta.json (metadata)
	const storeMeta = {
		version: 1,
		generatedAt: new Date().toISOString(),
		artifactCount: artifacts.length,
	};
	await writeFile(
		join(OUTPUT_DIR, 'store-meta.json'),
		JSON.stringify(storeMeta, null, 2),
	);
	console.log(`✓ Wrote ${OUTPUT_DIR}/store-meta.json`);

	console.log(`\n✅ Build complete! Deploy ${OUTPUT_DIR}/ to GitHub Pages.`);
}

// Run
buildIndex().catch((e) => {
	console.error('Build failed:', e);
	process.exit(1);
});

