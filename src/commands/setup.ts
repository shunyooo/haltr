import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

interface HookEntry {
	type: string;
	command: string;
}

interface HooksConfig {
	hooks?: {
		SessionStart?: HookEntry[];
		Stop?: HookEntry[];
		[key: string]: HookEntry[] | undefined;
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
			throw new Error(`~/.claude/settings.json の読み込みに失敗しました`);
		}
	}

	if (!settings.hooks) {
		settings.hooks = {};
	}

	const sessionStartHook: HookEntry = {
		type: "command",
		command: "hal session-start",
	};

	const stopHook: HookEntry = {
		type: "command",
		command: "hal check",
	};

	// Add SessionStart hook if not already present
	if (!settings.hooks.SessionStart) {
		settings.hooks.SessionStart = [];
	}
	const hasSessionStart = settings.hooks.SessionStart.some(
		(h) => h.command === "hal session-start",
	);
	if (!hasSessionStart) {
		settings.hooks.SessionStart.push(sessionStartHook);
	}

	// Add Stop hook if not already present
	if (!settings.hooks.Stop) {
		settings.hooks.Stop = [];
	}
	const hasStop = settings.hooks.Stop.some(
		(h) => h.command === "hal check",
	);
	if (!hasStop) {
		settings.hooks.Stop.push(stopHook);
	}

	// Ensure directory exists
	const settingsDir = dirname(settingsPath);
	if (!existsSync(settingsDir)) {
		mkdirSync(settingsDir, { recursive: true });
	}

	writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");

	console.log("haltr hooks を設定しました:");
	console.log("  - SessionStart: hal session-start");
	console.log("  - Stop: hal check");
	console.log(`  - 設定ファイル: ${settingsPath}`);
}
