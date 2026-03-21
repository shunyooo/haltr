import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";
import type { ConfigYaml } from "../types.js";

const DEFAULT_CONFIG: ConfigYaml = {
	orchestrator_cli: "claude:sonnet",
	watcher: {
		poll_interval: 30,
		inactivity_threshold: 300,
	},
	panes: {
		max_concurrent: 10,
	},
	retry: {
		max_attempts: 3,
	},
	defaults: {
		worker: "claude:sonnet",
		verifier: "claude:haiku",
		worker_session: "shared",
	},
};

/**
 * Initialize haltr/ directory structure in the given base directory.
 * Throws if haltr/ already exists.
 *
 * Creates a minimal structure:
 *   haltr/
 *   ├── config.yaml
 *   ├── rules.md
 *   ├── decisions/
 *   └── epics/
 *
 * Agent definitions are built into haltr and don't need files.
 * To customize, create haltr/agents/<role>.yaml to override defaults.
 */
export function initHaltr(baseDir: string): void {
	const haltrDir = join(baseDir, "haltr");

	if (existsSync(haltrDir)) {
		throw new Error(`haltr/ already exists in ${baseDir}`);
	}

	mkdirSync(haltrDir, { recursive: true });
	mkdirSync(join(haltrDir, "epics"), { recursive: true });
	mkdirSync(join(haltrDir, "decisions"), { recursive: true });

	writeFileSync(
		join(haltrDir, "config.yaml"),
		yaml.dump(DEFAULT_CONFIG, { lineWidth: -1 }),
	);

	writeFileSync(join(haltrDir, "rules.md"), "# Rules\n");
}
