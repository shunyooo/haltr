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
		},
		commands_hint:
			"CLAUDE.md に @haltr/README.md を追加してください。Claude Code の hooks に SessionStart hook を設定してください",
	});

	console.log(formatResponse(response));
}
