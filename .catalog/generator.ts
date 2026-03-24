/**
 * Markdown generator for catalog
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { commands, type CommandMeta } from "./commands.js";
import { stories, type Story, type StoryCategory } from "./stories.js";
import { runAllStories, type StoryResult } from "./runner.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Category display names
 */
const categoryNames: Record<StoryCategory, string> = {
	setup: "🔧 Setup",
	task: "🎯 Task",
	step: "👣 Step",
	status: "📊 Status",
	check: "🚦 Check",
	hook: "🪝 Hook",
	help: "❓ Help",
};

/**
 * Category descriptions
 */
const categoryDescriptions: Record<StoryCategory, string> = {
	setup: "Initial setup. Registers hooks in ~/.claude/settings.json.",
	task: "Task creation and editing. Task files can be created anywhere.",
	step: "Step management. Break tasks into small work units and track progress. Each step transitions: pending -> in_progress -> done/failed.",
	status: "Show current task status. View goal, step progress, and suggested next actions.",
	check: "Stop hook gate check. Verifies task completion before agent stops. Blocks if incomplete.",
	hook: "Claude Code hook handlers. Auto-executed on session start.",
	help: "Help commands. View available commands and options.",
};

/**
 * Category order
 */
const categoryOrder: StoryCategory[] = [
	"help",
	"setup",
	"task",
	"step",
	"status",
	"check",
	"hook",
];

/**
 * Generate markdown for a single story result
 */
function generateStoryMd(result: StoryResult): string {
	const { story, output, exitCode } = result;
	const cmd = commands[story.command];

	const lines: string[] = [];

	lines.push(`#### ${story.id}`);
	lines.push("");
	lines.push(`**${story.title}**`);
	lines.push("");

	if (story.description) {
		lines.push(story.description);
		lines.push("");
	}

	// Tags
	if (story.tags.length > 0) {
		lines.push(`Tags: ${story.tags.map((t) => `\`${t}\``).join(", ")}`);
		lines.push("");
	}

	// Command
	lines.push("**Command:**");
	lines.push("```bash");
	lines.push(story.input);
	lines.push("```");
	lines.push("");

	// Output
	lines.push("**Output:**");
	lines.push(`\`exit ${exitCode}\``);
	lines.push("```yaml");
	lines.push(output || "(no output)");
	lines.push("```");
	lines.push("");

	return lines.join("\n");
}

/**
 * Generate markdown for a category
 */
function generateCategoryMd(
	category: StoryCategory,
	results: StoryResult[],
): string {
	const categoryResults = results.filter((r) => r.story.category === category);
	if (categoryResults.length === 0) return "";

	const lines: string[] = [];

	lines.push(`## ${categoryNames[category]}`);
	lines.push("");

	// Category description
	const categoryDesc = categoryDescriptions[category];
	if (categoryDesc) {
		lines.push(categoryDesc);
		lines.push("");
	}

	// List commands in this category
	const categoryCommands = Object.values(commands).filter((cmd) => {
		const cmdCategory = cmd.name.split(" ")[0];
		return cmdCategory === category || cmd.name === category;
	});

	if (categoryCommands.length > 0) {
		lines.push("### 📖 Commands");
		lines.push("");
		for (const cmd of categoryCommands) {
			lines.push(`#### \`hal ${cmd.name}\``);
			lines.push("");
			lines.push(cmd.description);
			if (cmd.detail) {
				lines.push("");
				lines.push(cmd.detail);
			}
			if (cmd.options.length > 0) {
				lines.push("");
				lines.push("**Options:**");
				for (const opt of cmd.options) {
					const req = opt.required ? "(required)" : "(optional)";
					const choices = opt.choices ? ` [${opt.choices.join("|")}]` : "";
					lines.push(`- \`${opt.name}\` ${req} — ${opt.description}${choices}`);
				}
			}
			lines.push("");
		}
	}

	lines.push("### 🎬 Stories");
	lines.push("");

	for (const result of categoryResults) {
		lines.push(generateStoryMd(result));
	}

	return lines.join("\n");
}

/**
 * Generate table of contents
 */
function generateToc(results: StoryResult[]): string {
	const lines: string[] = [];

	lines.push("## Table of Contents");
	lines.push("");

	for (const category of categoryOrder) {
		const categoryResults = results.filter((r) => r.story.category === category);
		if (categoryResults.length === 0) continue;

		lines.push(`- [${categoryNames[category]}](#${category})`);
		for (const result of categoryResults) {
			lines.push(`  - [${result.story.id}](#${result.story.id})`);
		}
	}

	lines.push("");
	return lines.join("\n");
}

/**
 * Generate summary statistics
 */
function generateSummary(results: StoryResult[]): string {
	const lines: string[] = [];

	const total = results.length;
	const success = results.filter((r) => {
		const expectedExit = r.story.expected_exit ?? 0;
		const isExpectedError = r.story.tags.includes("error") && r.exitCode !== 0;
		return r.exitCode === expectedExit || isExpectedError;
	}).length;
	const failed = total - success;

	lines.push("## Summary");
	lines.push("");
	lines.push(`- Total stories: ${total}`);
	lines.push(`- Success: ${success}`);
	lines.push(`- Failed: ${failed}`);
	lines.push("");

	// By category
	lines.push("### By Category");
	lines.push("");
	lines.push("| Category | Stories |");
	lines.push("|----------|---------|");

	for (const category of categoryOrder) {
		const count = results.filter((r) => r.story.category === category).length;
		if (count > 0) {
			lines.push(`| ${categoryNames[category]} | ${count} |`);
		}
	}

	lines.push("");
	return lines.join("\n");
}

/**
 * Generate full catalog markdown
 */
export function generateCatalog(results: StoryResult[]): string {
	const lines: string[] = [];

	// Header
	lines.push("# haltr Command Catalog");
	lines.push("");
	lines.push("This catalog documents all haltr CLI commands with examples and expected outputs.");
	lines.push("");
	lines.push(`Generated: ${new Date().toISOString()}`);
	lines.push("");

	// TOC
	lines.push(generateToc(results));

	// Summary
	lines.push(generateSummary(results));

	// Categories
	for (const category of categoryOrder) {
		const categoryMd = generateCategoryMd(category, results);
		if (categoryMd) {
			lines.push(categoryMd);
		}
	}

	return lines.join("\n");
}

/**
 * Generate JSON catalog (for programmatic use)
 */
export function generateCatalogJson(results: StoryResult[]): object {
	return {
		generated: new Date().toISOString(),
		summary: {
			total: results.length,
			success: results.filter((r) => r.exitCode === 0).length,
			failed: results.filter((r) => r.exitCode !== 0).length,
		},
		commands: Object.values(commands),
		stories: results.map((r) => ({
			id: r.story.id,
			command: r.story.command,
			title: r.story.title,
			description: r.story.description,
			category: r.story.category,
			tags: r.story.tags,
			input: r.story.input,
			output: r.output,
			exitCode: r.exitCode,
			error: r.error,
		})),
	};
}

/**
 * Main: Run all stories and generate catalog
 */
export async function main(): Promise<void> {
	const halBinPath = resolve(__dirname, "..", "dist", "bin", "hal.js");
	const outputDir = resolve(__dirname, "output");

	console.log("Running stories...");

	// Ensure output directory exists
	if (!existsSync(outputDir)) {
		mkdirSync(outputDir, { recursive: true });
	}

	// Run all stories
	const results = runAllStories(stories, halBinPath);

	// Report progress
	let success = 0;
	let failed = 0;
	for (const r of results) {
		const expectedExit = r.story.expected_exit ?? 0;
		const isExpectedError = r.story.tags.includes("error") && r.exitCode !== 0;
		if (r.exitCode === expectedExit || isExpectedError) {
			success++;
			console.log(`  PASS: ${r.story.id}`);
		} else {
			failed++;
			console.log(`  FAIL: ${r.story.id} (exit ${r.exitCode}, expected ${expectedExit})`);
		}
	}

	console.log(`\nResults: ${success} passed, ${failed} failed`);

	// Generate markdown
	const markdown = generateCatalog(results);
	writeFileSync(join(outputDir, "catalog.md"), markdown);
	console.log(`\nGenerated: ${join(outputDir, "catalog.md")}`);

	// Generate JSON
	const json = generateCatalogJson(results);
	writeFileSync(join(outputDir, "catalog.json"), JSON.stringify(json, null, 2));
	console.log(`Generated: ${join(outputDir, "catalog.json")}`);
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((e) => {
		console.error(e);
		process.exit(1);
	});
}
