/**
 * Sync check - detect drift between CLI and catalog
 *
 * Usage: npx tsx .catalog/sync-check.ts
 */

import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { commands } from "./commands.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface CliCommand {
	name: string;
	description: string;
}

/**
 * Parse `hal --help` output to extract commands
 */
function parseHelpOutput(output: string): CliCommand[] {
	const commands: CliCommand[] = [];
	const lines = output.split("\n");

	let inCommands = false;
	for (const line of lines) {
		// Start of commands section
		if (line.trim() === "Commands:") {
			inCommands = true;
			continue;
		}

		// End of commands section (Options or empty line after commands)
		if (inCommands && (line.trim() === "" || line.trim().startsWith("Options:"))) {
			break;
		}

		if (inCommands) {
			// Parse command line: "  command-name    description"
			const match = line.match(/^\s{2}(\S+)\s+(.+)$/);
			if (match) {
				commands.push({
					name: match[1],
					description: match[2].trim(),
				});
			}
		}
	}

	return commands;
}

/**
 * Parse subcommand help (e.g., `hal epic --help`)
 */
function parseSubcommandHelp(parentCmd: string, output: string): CliCommand[] {
	const subcommands: CliCommand[] = [];
	const lines = output.split("\n");

	let inCommands = false;
	for (const line of lines) {
		if (line.trim() === "Commands:") {
			inCommands = true;
			continue;
		}

		if (inCommands && (line.trim() === "" || line.trim().startsWith("Options:"))) {
			break;
		}

		if (inCommands) {
			const match = line.match(/^\s{2}(\S+)\s+(.+)$/);
			if (match) {
				subcommands.push({
					name: `${parentCmd} ${match[1]}`,
					description: match[2].trim(),
				});
			}
		}
	}

	return subcommands;
}

/**
 * Clean description by removing [options], <name>, etc. prefixes
 */
function cleanDescription(desc: string): string {
	return desc
		.replace(/^\[options\]\s+/i, "")
		.replace(/^<\w+>\s+/i, "")
		.replace(/^\[\w+\]\s+/i, "")
		.trim();
}

/**
 * Get all CLI commands by parsing help output
 */
function getCliCommands(halBinPath: string): CliCommand[] {
	const allCommands: CliCommand[] = [];

	// Get top-level commands
	const mainHelp = execSync(`node ${halBinPath} --help`, { encoding: "utf-8" });
	const topLevel = parseHelpOutput(mainHelp);

	// Commands with subcommands
	const commandsWithSubs = ["epic", "task", "step", "context"];

	for (const cmd of topLevel) {
		if (commandsWithSubs.includes(cmd.name)) {
			// Get subcommands
			try {
				const subHelp = execSync(`node ${halBinPath} ${cmd.name} --help`, {
					encoding: "utf-8",
				});
				const subs = parseSubcommandHelp(cmd.name, subHelp);
				// Filter out 'help' subcommand and clean descriptions
				for (const sub of subs) {
					if (!sub.name.endsWith(" help")) {
						sub.description = cleanDescription(sub.description);
						allCommands.push(sub);
					}
				}
			} catch {
				// No subcommands, add as-is
				cmd.description = cleanDescription(cmd.description);
				allCommands.push(cmd);
			}
		} else if (cmd.name !== "help") {
			// Skip 'help' command, add others
			cmd.description = cleanDescription(cmd.description);
			allCommands.push(cmd);
		}
	}

	return allCommands;
}

/**
 * Get commands from catalog
 */
function getCatalogCommands(): string[] {
	return Object.keys(commands);
}

/**
 * Compare CLI and catalog commands
 */
function compareCommands(
	cliCommands: CliCommand[],
	catalogCommands: string[],
): {
	missingInCatalog: CliCommand[];
	extraInCatalog: string[];
	matched: string[];
} {
	const cliNames = new Set(cliCommands.map((c) => c.name));
	const catalogNames = new Set(catalogCommands);

	const missingInCatalog = cliCommands.filter((c) => !catalogNames.has(c.name));
	const extraInCatalog = catalogCommands.filter((c) => !cliNames.has(c));
	const matched = catalogCommands.filter((c) => cliNames.has(c));

	return { missingInCatalog, extraInCatalog, matched };
}

/**
 * Check if descriptions match (allowing truncation)
 */
function descriptionsMatch(cli: string, catalog: string): boolean {
	// Exact match
	if (cli === catalog) return true;
	// CLI truncated (catalog starts with CLI)
	if (catalog.startsWith(cli)) return true;
	// Catalog truncated (CLI starts with catalog)
	if (cli.startsWith(catalog)) return true;
	return false;
}

/**
 * Check description sync
 */
function checkDescriptions(
	cliCommands: CliCommand[],
	catalogCommands: typeof commands,
): { command: string; cli: string; catalog: string }[] {
	const diffs: { command: string; cli: string; catalog: string }[] = [];

	for (const cliCmd of cliCommands) {
		const catalogCmd = catalogCommands[cliCmd.name];
		if (catalogCmd && !descriptionsMatch(cliCmd.description, catalogCmd.description)) {
			diffs.push({
				command: cliCmd.name,
				cli: cliCmd.description,
				catalog: catalogCmd.description,
			});
		}
	}

	return diffs;
}

/**
 * Main sync check
 */
export function runSyncCheck(): {
	success: boolean;
	report: string;
} {
	const halBinPath = resolve(__dirname, "..", "dist", "bin", "hal.js");

	const lines: string[] = [];
	let hasErrors = false;

	lines.push("# Catalog Sync Check");
	lines.push("");

	// Get commands
	const cliCommands = getCliCommands(halBinPath);
	const catalogCommandNames = getCatalogCommands();

	lines.push(`CLI commands: ${cliCommands.length}`);
	lines.push(`Catalog commands: ${catalogCommandNames.length}`);
	lines.push("");

	// Compare
	const { missingInCatalog, extraInCatalog, matched } = compareCommands(
		cliCommands,
		catalogCommandNames,
	);

	// Missing in catalog
	if (missingInCatalog.length > 0) {
		hasErrors = true;
		lines.push("## Missing in Catalog");
		lines.push("");
		lines.push("These CLI commands are not documented in the catalog:");
		lines.push("");
		for (const cmd of missingInCatalog) {
			lines.push(`- \`${cmd.name}\` - ${cmd.description}`);
		}
		lines.push("");
	}

	// Extra in catalog
	if (extraInCatalog.length > 0) {
		hasErrors = true;
		lines.push("## Extra in Catalog");
		lines.push("");
		lines.push("These catalog commands don't exist in CLI:");
		lines.push("");
		for (const cmd of extraInCatalog) {
			lines.push(`- \`${cmd}\``);
		}
		lines.push("");
	}

	// Description diffs
	const descDiffs = checkDescriptions(cliCommands, commands);
	if (descDiffs.length > 0) {
		lines.push("## Description Mismatches");
		lines.push("");
		for (const diff of descDiffs) {
			lines.push(`### \`${diff.command}\``);
			lines.push(`- CLI: "${diff.cli}"`);
			lines.push(`- Catalog: "${diff.catalog}"`);
			lines.push("");
		}
	}

	// Summary
	if (!hasErrors && descDiffs.length === 0) {
		lines.push("## Result: SYNC OK");
		lines.push("");
		lines.push(`All ${matched.length} commands are in sync.`);
	} else {
		lines.push("## Result: OUT OF SYNC");
		lines.push("");
		lines.push("Please update `.catalog/commands.ts` to match the CLI.");
	}

	return {
		success: !hasErrors && descDiffs.length === 0,
		report: lines.join("\n"),
	};
}

/**
 * Main entry point
 */
function main(): void {
	console.log("Checking catalog sync...\n");

	try {
		const { success, report } = runSyncCheck();
		console.log(report);
		process.exit(success ? 0 : 1);
	} catch (e) {
		console.error("Error running sync check:", e);
		process.exit(1);
	}
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}
