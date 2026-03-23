import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";
import type { ConfigYaml } from "../types.js";
import { buildResponse, formatResponse } from "../lib/response-builder.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Build a minimal v2 config.
 * Includes timezone from TZ env var if available.
 */
function buildDefaultConfig(): ConfigYaml {
	const config: ConfigYaml = {};
	const tz = process.env.TZ;
	if (tz) {
		config.timezone = tz;
	}
	return config;
}

/**
 * Load the README template from src/templates/readme.md.
 * Falls back to a minimal README if template not found.
 */
function loadReadmeTemplate(): string {
	// In dist, templates are at dist/templates/readme.md
	// relative to dist/commands/init.js -> ../../templates/readme.md is wrong
	// Actually: dist/commands/init.js -> ../templates/readme.md
	const templatePath = resolve(__dirname, "..", "templates", "readme.md");

	try {
		return readFileSync(templatePath, "utf-8");
	} catch {
		// Fallback: try source path (for development)
		const srcPath = resolve(
			__dirname,
			"..",
			"..",
			"src",
			"templates",
			"readme.md",
		);
		try {
			return readFileSync(srcPath, "utf-8");
		} catch {
			return "# haltr\n\nRun `hal status` to check current task state.\n";
		}
	}
}

/**
 * Initialize haltr/ directory structure in the given base directory.
 * Throws if haltr/ already exists.
 *
 * Creates the v2 structure:
 *   haltr/
 *   ├── config.yaml          — minimal config
 *   ├── README.md            — operation guide
 *   ├── context/
 *   │   ├── index.yaml       — empty array []
 *   │   ├── history.yaml     — empty object {}
 *   │   ├── skills/          — empty dir
 *   │   └── knowledge/       — empty dir
 *   ├── epics/               — empty dir
 *   └── .sessions/           — empty dir
 */
export function initHaltr(baseDir: string): void {
	const haltrDir = join(baseDir, "haltr");

	if (existsSync(haltrDir)) {
		throw new Error(`haltr/ already exists in ${baseDir}`);
	}

	// Create directories
	mkdirSync(haltrDir, { recursive: true });
	mkdirSync(join(haltrDir, "context", "skills"), { recursive: true });
	mkdirSync(join(haltrDir, "context", "knowledge"), { recursive: true });
	mkdirSync(join(haltrDir, "epics"), { recursive: true });
	mkdirSync(join(haltrDir, ".sessions"), { recursive: true });

	// Write config.yaml
	const config = buildDefaultConfig();
	writeFileSync(
		join(haltrDir, "config.yaml"),
		yaml.dump(config, { lineWidth: -1 }),
	);

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
	const hooksSetup = setupClaudeCodeHooks(baseDir, haltrDir);

	// Setup CLAUDE.md reference
	const claudeMdSetup = setupClaudeMd(baseDir);

	// Output result
	const response = buildResponse({
		status: "ok",
		message: "haltr/ ディレクトリを初期化しました",
		data: {
			haltr_dir: haltrDir,
			structure: [
				"config.yaml",
				"README.md",
				"context/index.yaml",
				"context/history.yaml",
				"context/skills/",
				"context/knowledge/",
				"epics/",
				".sessions/",
			],
			hooks: hooksSetup,
			claude_md: claudeMdSetup,
		},
	});

	console.log(formatResponse(response));
}

/**
 * Setup Claude Code hooks in .claude/settings.json.
 * Adds SessionStart hook (HALTR_SESSION_ID) and Stop hook (hal check).
 */
function setupClaudeCodeHooks(baseDir: string, haltrDir: string): string {
	const claudeDir = join(baseDir, ".claude");
	const settingsPath = join(claudeDir, "settings.json");

	// Load existing settings or create new
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

	// Ensure hooks object exists
	if (!settings.hooks || typeof settings.hooks !== "object") {
		settings.hooks = {};
	}
	const hooks = settings.hooks as Record<string, unknown[]>;

	// SessionStart hook — set HALTR_SESSION_ID
	const sessionStartHookPath = join(haltrDir, "session-start-hook.sh");
	const sessionStartHookContent = loadSessionStartHookTemplate();
	writeFileSync(sessionStartHookPath, sessionStartHookContent, { mode: 0o755 });

	if (!Array.isArray(hooks.SessionStart)) {
		hooks.SessionStart = [];
	}
	const hasSessionHook = hooks.SessionStart.some(
		(h: unknown) => typeof h === "object" && h !== null && "command" in h &&
			String((h as Record<string, unknown>).command).includes("session-start-hook"),
	);
	if (!hasSessionHook) {
		hooks.SessionStart.push({
			command: sessionStartHookPath,
		});
	}

	// Stop hook — hal check
	if (!Array.isArray(hooks.Stop)) {
		hooks.Stop = [];
	}
	const hasStopHook = hooks.Stop.some(
		(h: unknown) => typeof h === "object" && h !== null && "command" in h &&
			String((h as Record<string, unknown>).command).includes("hal check"),
	);
	if (!hasStopHook) {
		hooks.Stop.push({
			command: "hal check",
		});
	}

	// Save settings
	writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

	return "hooks を .claude/settings.json に設定しました（SessionStart + Stop）";
}

/**
 * Load the session-start-hook.sh template.
 */
function loadSessionStartHookTemplate(): string {
	const templatePath = resolve(__dirname, "..", "templates", "session-start-hook.sh");
	try {
		return readFileSync(templatePath, "utf-8");
	} catch {
		const srcPath = resolve(__dirname, "..", "..", "src", "templates", "session-start-hook.sh");
		try {
			return readFileSync(srcPath, "utf-8");
		} catch {
			return `#!/bin/bash
SESSION_ID=$(cat | jq -r '.session_id // empty')
if [ -n "$SESSION_ID" ] && [ -n "$CLAUDE_ENV_FILE" ]; then
  echo "export HALTR_SESSION_ID=$SESSION_ID" >> "$CLAUDE_ENV_FILE"
fi
exit 0
`;
		}
	}
}

/**
 * Add @haltr/README.md reference to CLAUDE.md if not already present.
 */
function setupClaudeMd(baseDir: string): string {
	const claudeMdPath = join(baseDir, "CLAUDE.md");
	const reference = "@haltr/README.md";

	if (existsSync(claudeMdPath)) {
		const content = readFileSync(claudeMdPath, "utf-8");
		if (content.includes(reference)) {
			return "CLAUDE.md に既に @haltr/README.md が含まれています";
		}
		writeFileSync(claudeMdPath, `${content}\n${reference}\n`);
		return "CLAUDE.md に @haltr/README.md を追加しました";
	}

	writeFileSync(claudeMdPath, `${reference}\n`);
	return "CLAUDE.md を作成し、@haltr/README.md を追加しました";
}
