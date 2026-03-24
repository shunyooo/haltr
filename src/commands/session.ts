import { readFileSync, writeFileSync } from "node:fs";

/**
 * hal session-start
 *
 * Read session_id from stdin (Claude Code SessionStart hook input)
 * and write it to CLAUDE_ENV_FILE for use by subsequent commands.
 */
export function handleSessionStart(): void {
	const input = readFileSync(0, "utf-8").trim();
	if (!input) {
		process.exit(0);
	}

	let sessionId: string | undefined;
	try {
		const data = JSON.parse(input);
		sessionId = data.session_id;
	} catch {
		process.exit(0);
	}

	if (!sessionId) {
		process.exit(0);
	}

	const envFile = process.env.CLAUDE_ENV_FILE;
	if (!envFile) {
		process.exit(0);
	}

	const envLine = `export HALTR_SESSION_ID=${sessionId}\n`;
	writeFileSync(envFile, envLine, { flag: "a" });

	process.exit(0);
}
