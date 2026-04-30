#!/usr/bin/env bun
/**
 * Convert one Claude Code plugin into an AgentHippo agent pack staging folder.
 *
 * Default output is versioned:
 *   <output>/<plugin-slug>/current.txt
 *   <output>/<plugin-slug>/<version>/{agent.yaml,AGENTS.md,...}
 *
 * Usage:
 *   bun run scripts/store/convert-plugin-to-pack.ts ../claude-code/plugins/plugin-dev scripts/store/agent-packs-plugins
 *   bun run scripts/store/convert-plugin-to-pack.ts --plugin ../claude-code/plugins/plugin-dev --output scripts/store/agent-packs-plugins --version 1.0.0
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
import { basename, join } from 'path';

type ParsedArgs = {
	pluginDir: string;
	outputDir: string;
	version: string;
	engine: string;
	model: string;
	dryRun: boolean;
	flat: boolean;
};

type SkillRef = {
	name: string;
	path: string;
};

type RuleRef = {
	path: string;
};

function usage(exitCode = 2): never {
	console.error(`Usage: convert-plugin-to-pack.ts [options] <plugin-dir> <output-dir>

Options:
  --plugin <path>     Claude Code plugin directory
  --output <path>     Output root directory
  --version <semver>  Pack version (default: PACK_VERSION or 1.0.0)
  --engine <id>       AgentHippo engine id (default: PACK_ENGINE or openclaw)
  --model <id>        Agent model id (default: PACK_MODEL or litellm/gpt-5.3-codex)
  --flat              Write directly to <output>/<slug> instead of versioned output
  --dry-run           Print planned conversion without writing files
  -h, --help          Show this help
`);
	process.exit(exitCode);
}

function parseArgs(argv: string[]): ParsedArgs {
	const positional: string[] = [];
	let pluginDir = '';
	let outputDir = '';
	let version = process.env.PACK_VERSION || '1.0.0';
	let engine = process.env.PACK_ENGINE || 'openclaw';
	let model = process.env.PACK_MODEL || 'litellm/gpt-5.3-codex';
	let dryRun = process.env.DRY_RUN === '1';
	let flat = process.env.FLAT_OUTPUT === '1';

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case '--plugin':
				pluginDir = argv[++i] || '';
				break;
			case '--output':
				outputDir = argv[++i] || '';
				break;
			case '--version':
				version = argv[++i] || '';
				break;
			case '--engine':
				engine = argv[++i] || '';
				break;
			case '--model':
				model = argv[++i] || '';
				break;
			case '--flat':
				flat = true;
				break;
			case '--dry-run':
				dryRun = true;
				break;
			case '-h':
			case '--help':
				usage(0);
				break;
			default:
				if (arg.startsWith('-')) {
					console.error(`Unknown option: ${arg}`);
					usage();
				}
				positional.push(arg);
		}
	}

	pluginDir ||= positional[0] || '';
	outputDir ||= positional[1] || '';

	if (!pluginDir || !outputDir || !version || !engine || !model) {
		usage();
	}

	return { pluginDir, outputDir, version, engine, model, dryRun, flat };
}

function slugify(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '-')
		.replace(/^-+|-+$/g, '') || 'plugin';
}

function yamlString(value: string): string {
	return JSON.stringify(value);
}

function readIfExists(path: string): string {
	return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function firstHeading(markdown: string, fallback: string): string {
	const heading = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
	return heading || fallback;
}

function firstParagraph(markdown: string, fallback: string): string {
	const lines = markdown.split(/\r?\n/);
	let afterHeading = false;

	for (const line of lines) {
		const trimmed = line.trim();
		if (!afterHeading && trimmed.startsWith('# ')) {
			afterHeading = true;
			continue;
		}
		if (!afterHeading || !trimmed || trimmed.startsWith('#') || trimmed.startsWith('```')) {
			continue;
		}
		return trimmed
			.replace(/\s+/g, ' ')
			.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
			.slice(0, 240);
	}

	return fallback;
}

function adaptPublicCopy(markdown: string): string {
	return markdown
		.replace(/Claude automatically uses this skill/g, 'AgentHippo can use this skill')
		.replace(/Claude will/g, 'The agent will')
		.replace(/Claude may/g, 'The agent may')
		.replace(/Ask Claude to/g, 'Ask the agent to')
		.replace(/Let Claude/g, 'Let AgentHippo')
		.replace(/Claude reads/g, 'The agent reads')
		.replace(/Claude Code attribution/g, 'AgentHippo attribution')
		.replace(/Claude Code installed/g, 'AgentHippo installed')
		.replace(/Remember: Claude is capable/g, 'Remember: the agent is capable')
		.replace(/next Claude/g, 'next agent')
		.replace(/claude\.ai artifacts/g, 'AgentHippo artifacts')
		.replace(/In claude\.ai/g, 'In AgentHippo')
		.replace(/Anthropic branding/g, 'AgentHippo gallery styling')
		.replace(/Anthropic colors\/fonts/g, 'AgentHippo-neutral colors/fonts');
}

function copyFileOrDir(src: string, dst: string): void {
	cpSync(src, dst, {
		recursive: true,
		filter: (source) => {
			const base = basename(source);
			return ![
				'.git',
				'node_modules',
				'dist',
				'build',
				'.DS_Store',
				'__pycache__',
			].includes(base);
		},
	});
}

function listMarkdownFiles(dir: string): string[] {
	if (!existsSync(dir)) {
		return [];
	}
	return readdirSync(dir)
		.filter((entry) => entry.endsWith('.md'))
		.filter((entry) => statSync(join(dir, entry)).isFile())
		.sort();
}

function findSkillRefs(skillsDir: string): SkillRef[] {
	if (!existsSync(skillsDir)) {
		return [];
	}

	return readdirSync(skillsDir)
		.filter((entry) => !entry.startsWith('.'))
		.filter((entry) => {
			const dir = join(skillsDir, entry);
			return statSync(dir).isDirectory() && existsSync(join(dir, 'SKILL.md'));
		})
		.sort()
		.map((name) => ({ name, path: `skills/${name}` }));
}

function buildManifest(params: {
	slug: string;
	version: string;
	description: string;
	skills: SkillRef[];
	rules: RuleRef[];
	hasMcp: boolean;
	engine: string;
	model: string;
}): string {
	const lines: string[] = [
		'apiVersion: agenthippo.ai/v1',
		'kind: Agent',
		'',
		'metadata:',
		`  name: ${params.slug}`,
		`  version: ${params.version}`,
		`  description: ${yamlString(params.description)}`,
		'  author: AgentHippo',
		'  license: MIT',
		'  tags:',
		'    - agenthippo',
		'    - converted-plugin',
		'  source:',
		'    type: claude-code-plugin',
		`    slug: ${params.slug}`,
		'',
		'spec:',
		`  engine: ${params.engine}`,
		`  model: ${params.model}`,
	];

	if (params.skills.length > 0) {
		lines.push('', '  skills:');
		for (const skill of params.skills) {
			lines.push(`    - path: ${skill.path}`);
		}
	}

	lines.push('', '  prompts:', '    system: ./AGENTS.md');
	if (params.rules.length > 0) {
		lines.push('    rules:');
		for (const rule of params.rules) {
			lines.push(`      - ./${rule.path}`);
		}
	} else {
		lines.push('    rules: []');
	}

	if (params.hasMcp) {
		lines.push('', '  mcp:', '    config: ./mcp/.mcp.json');
	}

	lines.push(
		'',
		'  permissions:',
		'    approval: unrestricted',
		'    fileAccess: full',
		'',
		'  visibility: public',
		'',
	);

	return `${lines.join('\n')}\n`;
}

function writeAgentsMd(pluginDir: string, packDir: string, displayName: string, slug: string): void {
	const readme = readIfExists(join(pluginDir, 'README.md'));
	const body = readme
		? readme.replace(/^#\s+.+\r?\n?/, '').trim()
		: `You are a specialized assistant powered by the ${slug} agent pack.`;
	const adaptedBody = adaptPublicCopy(body);
	const adaptedReadme = readme ? adaptPublicCopy(readme) : adaptedBody;

	writeFileSync(
		join(packDir, 'AGENTS.md'),
		`# ${displayName} Agent\n\n${adaptedBody}\n`,
	);
	writeFileSync(
		join(packDir, 'context.md'),
		`# Source Context\n\nAdapted for AgentHippo from upstream plugin source: ${slug}\n\n${adaptedReadme}\n`,
	);
}

function convertPluginToPack(args: ParsedArgs): void {
	const pluginDir = args.pluginDir;
	if (!existsSync(pluginDir) || !statSync(pluginDir).isDirectory()) {
		throw new Error(`Plugin directory not found: ${pluginDir}`);
	}

	const slug = slugify(basename(pluginDir));
	const readme = readIfExists(join(pluginDir, 'README.md'));
	const displayName = firstHeading(readme, slug);
	const description = adaptPublicCopy(firstParagraph(readme, `Converted from Claude Code plugin: ${slug}`));
	const packRoot = join(args.outputDir, slug);
	const packDir = args.flat ? packRoot : join(packRoot, args.version);

	console.log(`Converting ${slug}`);
	console.log(`  Source: ${pluginDir}`);
	console.log(`  Output: ${packDir}`);
	console.log(`  Version: ${args.version}`);
	console.log(`  Engine: ${args.engine}`);
	console.log(`  Model: ${args.model}`);

	if (args.dryRun) {
		return;
	}

	rmSync(packRoot, { recursive: true, force: true });
	mkdirSync(packDir, { recursive: true });

	writeAgentsMd(pluginDir, packDir, displayName, slug);

	const rules: RuleRef[] = [];

	const agentsDir = join(pluginDir, 'agents');
	const rulesDir = join(packDir, 'rules');
	const agentFiles = listMarkdownFiles(agentsDir);
	if (agentFiles.length > 0) {
		mkdirSync(rulesDir, { recursive: true });
		for (const file of agentFiles) {
			copyFileOrDir(join(agentsDir, file), join(rulesDir, file));
			rules.push({ path: `rules/${file}` });
		}
		console.log(`  Copied ${agentFiles.length} agents to rules/`);
	}

	const commandsDir = join(pluginDir, 'commands');
	const commandFiles = listMarkdownFiles(commandsDir);
	if (commandFiles.length > 0) {
		const outCommandsDir = join(packDir, 'rules', 'commands');
		mkdirSync(outCommandsDir, { recursive: true });
		for (const file of commandFiles) {
			copyFileOrDir(join(commandsDir, file), join(outCommandsDir, file));
			rules.push({ path: `rules/commands/${file}` });
		}
		console.log(`  Copied ${commandFiles.length} commands to rules/commands/`);
	}

	const skillsDir = join(pluginDir, 'skills');
	const skillRefs = findSkillRefs(skillsDir);
	if (skillRefs.length > 0) {
		mkdirSync(join(packDir, 'skills'), { recursive: true });
		for (const skill of skillRefs) {
			copyFileOrDir(join(skillsDir, skill.name), join(packDir, skill.path));
		}
		console.log(`  Copied ${skillRefs.length} skills`);
	}

	const hooksDir = join(pluginDir, 'hooks');
	if (existsSync(hooksDir)) {
		copyFileOrDir(hooksDir, join(packDir, 'hooks'));
		console.log('  Copied hooks/ as reference material');
	}

	const mcpConfig = join(pluginDir, '.mcp.json');
	const hasMcp = existsSync(mcpConfig);
	if (hasMcp) {
		mkdirSync(join(packDir, 'mcp'), { recursive: true });
		copyFileOrDir(mcpConfig, join(packDir, 'mcp', '.mcp.json'));
		console.log('  Copied .mcp.json to mcp/.mcp.json');
	}

	writeFileSync(
		join(packDir, 'agent.yaml'),
		buildManifest({
			slug,
			version: args.version,
			description,
			skills: skillRefs,
			rules,
			hasMcp,
			engine: args.engine,
			model: args.model,
		}),
	);

	if (!args.flat) {
		writeFileSync(join(packRoot, 'current.txt'), `${args.version}\n`);
	}

	console.log(`  OK: ${slug}`);
}

try {
	convertPluginToPack(parseArgs(process.argv.slice(2)));
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
