import {
	createInterface,
} from "node:readline";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";
import type { HaltrConfig } from "../types.js";
import { buildResponse, formatResponse } from "../lib/response-builder.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Default directory name */
const DEFAULT_DIR = "work";

/** Config file name */
const CONFIG_FILE = ".haltr.json";

/**
 * Build the haltr config.
 */
function buildConfig(directory: string): HaltrConfig {
	const config: HaltrConfig = { directory };
	const tz = process.env.TZ;
	if (tz) {
		config.timezone = tz;
	}
	return config;
}

/**
 * Load the README template from src/templates/readme.md.
 */
function loadReadmeTemplate(): string {
	const templatePath = resolve(__dirname, "..", "templates", "readme.md");
	try {
		return readFileSync(templatePath, "utf-8");
	} catch {
		const srcPath = resolve(__dirname, "..", "..", "src", "templates", "readme.md");
		try {
			return readFileSync(srcPath, "utf-8");
		} catch {
			return "# haltr\n\nRun `hal status` to check current task state.\n";
		}
	}
}

/**
 * Prompt user for directory name.
 */
async function promptDirectory(): Promise<string> {
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	return new Promise((resolve) => {
		rl.question(`ディレクトリ名 (default: ${DEFAULT_DIR}): `, (answer) => {
			rl.close();
			resolve(answer.trim() || DEFAULT_DIR);
		});
	});
}

/**
 * Initialize haltr directory structure.
 *
 * Creates:
 *   .haltr.json           — config file in project root
 *   <dir>/
 *   ├── README.md         — operation guide
 *   ├── context/
 *   │   ├── index.yaml    — empty array []
 *   │   ├── history.yaml  — empty object {}
 *   │   ├── skills/       — empty dir
 *   │   └── knowledge/    — empty dir
 *   ├── epics/            — empty dir
 *   └── .sessions/        — empty dir
 */
export async function initHaltr(baseDir: string, dir?: string): Promise<void> {
	// Check if already initialized
	const configPath = join(baseDir, CONFIG_FILE);
	if (existsSync(configPath)) {
		throw new Error(`${CONFIG_FILE} already exists. Already initialized.`);
	}

	// Get directory name (interactive or from option)
	const dirName = dir ?? await promptDirectory();

	const haltrDir = join(baseDir, dirName);

	if (existsSync(haltrDir)) {
		throw new Error(`${dirName}/ already exists in ${baseDir}`);
	}

	// Create .haltr.json
	const config = buildConfig(dirName);
	writeFileSync(configPath, JSON.stringify(config, null, 2));

	// Create directories
	mkdirSync(haltrDir, { recursive: true });
	mkdirSync(join(haltrDir, "context", "skills"), { recursive: true });
	mkdirSync(join(haltrDir, "context", "knowledge"), { recursive: true });
	mkdirSync(join(haltrDir, "epics"), { recursive: true });
	mkdirSync(join(haltrDir, ".sessions"), { recursive: true });

	// Write context/index.yaml (empty array)
	writeFileSync(
		join(haltrDir, "context", "index.yaml"),
		yaml.dump([], { lineWidth: -1 }),
	);

	// Write context/history.yaml (empty object)
	writeFileSync(
		join(haltrDir, "context", "history.yaml"),
		yaml.dump({}, { lineWidth: -1 }),
	);

	// Write README.md from template
	const readme = loadReadmeTemplate();
	writeFileSync(join(haltrDir, "README.md"), readme);

	// Setup Claude Code hooks
	const hooksSetup = setupClaudeCodeHooks(baseDir);

	// Generate CLAUDE.md instruction
	const claudeMdHint = getClaudeMdInstruction(dirName);

	// Output result
	const response = buildResponse({
		status: "ok",
		message: `${dirName}/ ディレクトリを初期化しました`,
		data: {
			haltr_dir: haltrDir,
			directory_name: dirName,
			structure: [
				CONFIG_FILE,
				"README.md",
				"context/index.yaml",
				"context/history.yaml",
				"context/skills/",
				"context/knowledge/",
				"epics/",
				".sessions/",
			],
			hooks: hooksSetup,
			claude_md_hint: claudeMdHint,
		},
	});

	console.log(formatResponse(response));
}

/**
 * Setup Claude Code hooks in .claude/settings.json.
 */
function setupClaudeCodeHooks(baseDir: string): string {
	const claudeDir = join(baseDir, ".claude");
	const settingsPath = join(claudeDir, "settings.json");

	let settings: Record<string, unknown> = {};
	if (existsSync(settingsPath)) {
		try {
			settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
		} catch {
			settings = {};
		}
	} else {
		mkdirSync(claudeDir, { recursive: true });
	}

	if (!settings.hooks || typeof settings.hooks !== "object") {
		settings.hooks = {};
	}
	const hooks = settings.hooks as Record<string, unknown[]>;

	// SessionStart hook
	if (!Array.isArray(hooks.SessionStart)) {
		hooks.SessionStart = [];
	}
	const hasSessionHook = (hooks.SessionStart as unknown[]).some(
		(entry: unknown) => {
			if (typeof entry !== "object" || entry === null) return false;
			const e = entry as Record<string, unknown>;
			const innerHooks = e.hooks as unknown[];
			if (!Array.isArray(innerHooks)) return false;
			return innerHooks.some(
				(h: unknown) => typeof h === "object" && h !== null && "command" in h &&
					String((h as Record<string, unknown>).command).includes("hal session-start"),
			);
		},
	);
	if (!hasSessionHook) {
		hooks.SessionStart.push({
			matcher: "startup",
			hooks: [{ type: "command", command: "hal session-start" }],
		});
	}

	// Stop hook
	if (!Array.isArray(hooks.Stop)) {
		hooks.Stop = [];
	}
	const hasStopHook = (hooks.Stop as unknown[]).some(
		(entry: unknown) => {
			if (typeof entry !== "object" || entry === null) return false;
			const e = entry as Record<string, unknown>;
			const innerHooks = e.hooks as unknown[];
			if (!Array.isArray(innerHooks)) return false;
			return innerHooks.some(
				(h: unknown) => typeof h === "object" && h !== null && "command" in h &&
					String((h as Record<string, unknown>).command).includes("hal check"),
			);
		},
	);
	if (!hasStopHook) {
		hooks.Stop.push({
			hooks: [{ type: "command", command: "hal check" }],
		});
	}

	writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
	return "hooks を .claude/settings.json に設定しました";
}

/**
 * Generate instruction for CLAUDE.md setup.
 */
function getClaudeMdInstruction(dirName: string): string {
	return `CLAUDE.md に @${dirName}/README.md を追加してください`;
}
