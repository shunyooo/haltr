#!/usr/bin/env node
/**
 * Catalog Runner
 *
 * Executes all scenarios and captures JSON output.
 * Generates docs/message-catalog.md
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type Scenario,
	type ScenarioContext,
	cleanupContext,
	createContext,
	scenarios,
} from "./scenarios.js";

interface CapturedResult {
	scenario: Scenario;
	output: string;
	error?: string;
}

/**
 * Normalize paths in output (replace temp paths with placeholders).
 */
function normalizePaths(output: string): string {
	// Replace /tmp/hal-catalog-xxx/haltr paths with placeholder
	return output.replace(/\/tmp\/hal-catalog-[^/\s'"\n]+\/haltr/g, "<haltr>");
}

/**
 * Capture console.log output during function execution.
 */
function captureOutput(fn: () => void): { output: string; error?: string } {
	const logs: string[] = [];
	const originalLog = console.log;
	const originalError = console.error;

	console.log = (...args: unknown[]) => {
		logs.push(args.map(String).join(" "));
	};
	console.error = (...args: unknown[]) => {
		logs.push(args.map(String).join(" "));
	};

	let error: string | undefined;
	try {
		fn();
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
	} finally {
		console.log = originalLog;
		console.error = originalError;
	}

	return { output: normalizePaths(logs.join("\n")), error };
}

/**
 * Set up session for catalog test.
 */
function setupSession(ctx: ScenarioContext, scenarioId: string): void {
	// Use unique session ID per scenario
	const sessionId = `catalog-${scenarioId}-${Date.now()}`;
	process.env.HALTR_SESSION_ID = sessionId;

	// Create session file
	const sessionsDir = join(ctx.haltrDir, ".sessions");
	mkdirSync(sessionsDir, { recursive: true });
	writeFileSync(join(sessionsDir, sessionId), ctx.taskPath);
}

/**
 * Run a single scenario and capture output.
 */
function runScenario(scenario: Scenario): CapturedResult {
	const ctx = createContext();
	const originalCwd = process.cwd();

	try {
		// Change to temp directory so findHaltrDir works
		process.chdir(ctx.tmpDir);

		// Set up session to point to the test task
		setupSession(ctx, scenario.id);

		// Setup scenario
		scenario.setup(ctx);

		// Run and capture
		const { output, error } = captureOutput(() => scenario.run(ctx));

		return { scenario, output, error };
	} finally {
		// Restore original working directory
		process.chdir(originalCwd);
		cleanupContext(ctx);
	}
}

/**
 * Generate markdown from captured results.
 */
function generateMarkdown(results: CapturedResult[]): string {
	const lines: string[] = [
		"# haltr Message Catalog",
		"",
		"各コマンド・状態の出力例です。",
		"",
		"> このファイルは `npm run catalog` で自動生成されています。",
		"",
	];

	// Group by category
	const categories: Record<string, CapturedResult[]> = {};
	for (const result of results) {
		const cat = result.scenario.category;
		if (!categories[cat]) {
			categories[cat] = [];
		}
		categories[cat].push(result);
	}

	const categoryOrder = ["task", "step", "status", "check", "context"];
	const categoryNames: Record<string, string> = {
		task: "Task Commands",
		step: "Step Commands",
		status: "Status Command",
		check: "Check Command (Hook)",
		context: "Context Commands",
	};

	for (const cat of categoryOrder) {
		const catResults = categories[cat];
		if (!catResults || catResults.length === 0) continue;

		lines.push(`## ${categoryNames[cat] || cat}`);
		lines.push("");

		for (const result of catResults) {
			lines.push(`### ${result.scenario.name}`);
			lines.push("");
			lines.push(`**${result.scenario.description}**`);
			lines.push("");

			if (result.error) {
				lines.push("```");
				lines.push(`Error: ${result.error}`);
				lines.push("```");
			} else {
				// Try to parse and pretty-print JSON
				try {
					const json = JSON.parse(result.output);
					lines.push("```json");
					lines.push(JSON.stringify(json, null, 2));
					lines.push("```");
				} catch {
					// Not JSON, output as-is
					lines.push("```");
					lines.push(result.output);
					lines.push("```");
				}
			}
			lines.push("");
		}
	}

	lines.push("---");
	lines.push("");
	lines.push(`Generated at: ${new Date().toISOString()}`);
	lines.push("");

	return lines.join("\n");
}

/**
 * Main entry point.
 */
export function runCatalog(): void {
	console.log("Running message catalog...\n");

	const results: CapturedResult[] = [];

	for (const scenario of scenarios) {
		process.stdout.write(`  ${scenario.id}... `);
		const result = runScenario(scenario);
		if (result.error) {
			console.log(`ERROR: ${result.error}`);
		} else {
			console.log("OK");
		}
		results.push(result);
	}

	console.log("");

	// Generate markdown
	const markdown = generateMarkdown(results);
	const docsDir = join(process.cwd(), "docs");
	const outputPath = join(docsDir, "message-catalog.md");

	// Ensure docs directory exists
	mkdirSync(docsDir, { recursive: true });

	writeFileSync(outputPath, markdown);
	console.log(`Generated: ${outputPath}`);
}

// Run if executed directly
const isMain = process.argv[1]?.includes("runner");
if (isMain) {
	runCatalog();
}
