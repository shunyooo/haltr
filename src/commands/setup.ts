import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

interface HookEntry {
	type: string;
	command: string;
}

interface HookGroup {
	hooks: HookEntry[];
}

interface HooksConfig {
	hooks?: {
		SessionStart?: HookGroup[];
		Stop?: HookGroup[];
		[key: string]: HookGroup[] | undefined;
	};
	[key: string]: unknown;
}

/**
 * hal setup
 *
 * Register SessionStart and Stop hooks in ~/.claude/settings.json.
 */
export function handleSetup(): void {
	const settingsPath = join(homedir(), ".claude", "settings.json");

	let settings: HooksConfig = {};
	if (existsSync(settingsPath)) {
		try {
			const content = readFileSync(settingsPath, "utf-8");
			settings = JSON.parse(content);
		} catch {
			throw new Error(`Failed to read ~/.claude/settings.json`);
		}
	}

	if (!settings.hooks) {
		settings.hooks = {};
	}

	// SessionStart hook
	if (!settings.hooks.SessionStart) {
		settings.hooks.SessionStart = [];
	}
	const hasSessionStart = settings.hooks.SessionStart.some(
		(group) => group.hooks?.some((h) => h.command === "hal session-start"),
	);
	if (!hasSessionStart) {
		settings.hooks.SessionStart.push({
			hooks: [{ type: "command", command: "hal session-start" }],
		});
	}

	// Stop hook
	if (!settings.hooks.Stop) {
		settings.hooks.Stop = [];
	}
	const hasStop = settings.hooks.Stop.some(
		(group) => group.hooks?.some((h) => h.command === "hal check"),
	);
	if (!hasStop) {
		settings.hooks.Stop.push({
			hooks: [{ type: "command", command: "hal check" }],
		});
	}

	const settingsDir = dirname(settingsPath);
	if (!existsSync(settingsDir)) {
		mkdirSync(settingsDir, { recursive: true });
	}

	writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");

	console.log("haltr hooks configured:");
	console.log("  - SessionStart: hal session-start");
	console.log("  - Stop: hal check");
	console.log(`  - Settings: ${settingsPath}`);
}
