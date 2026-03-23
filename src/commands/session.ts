import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findHaltrDir } from "../lib/task-utils.js";

/**
 * hal session-start
 *
 * Read session_id from stdin (Claude Code SessionStart hook input)
 * and write it to CLAUDE_ENV_FILE for use by subsequent commands.
 *
 * Input format (JSON from Claude Code):
 * { "session_id": "..." }
 */
export function handleSessionStart(): void {
	// Read stdin synchronously
	const input = readFileSync(0, "utf-8").trim();
	if (!input) {
		// No input, exit silently
		process.exit(0);
	}

	let sessionId: string | undefined;
	try {
		const data = JSON.parse(input);
		sessionId = data.session_id;
	} catch {
		// Invalid JSON, exit silently
		process.exit(0);
	}

	if (!sessionId) {
		process.exit(0);
	}

	const envFile = process.env.CLAUDE_ENV_FILE;
	if (!envFile) {
		// No env file to write to, exit silently
		process.exit(0);
	}

	// Write session ID to env file
	const envLine = `export HALTR_SESSION_ID=${sessionId}\n`;
	writeFileSync(envFile, envLine, { flag: "a" });

	// Also ensure .sessions directory exists
	try {
		const haltrDir = findHaltrDir(process.cwd());
		const sessionsDir = join(haltrDir, ".sessions");
		if (!existsSync(sessionsDir)) {
			mkdirSync(sessionsDir, { recursive: true });
		}
	} catch {
		// haltr dir not found, that's okay
	}

	process.exit(0);
}
