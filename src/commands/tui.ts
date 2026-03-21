import { existsSync } from "node:fs";
import { join } from "node:path";
import { render } from "ink";
import React from "react";
import { resolveTimezone } from "../lib/timezone.js";
import { loadAndValidateConfig } from "../lib/validator.js";
import { Dashboard } from "../tui/app.js";

export async function handleTui(): Promise<void> {
	const cwd = process.cwd();
	const epicsDir = join(cwd, "haltr", "epics");

	if (!existsSync(epicsDir)) {
		throw new Error("haltr/epics/ directory not found. Run 'hal init' first.");
	}

	let timezone = resolveTimezone();
	try {
		const configPath = join(cwd, "haltr", "config.yaml");
		const config = loadAndValidateConfig(configPath);
		timezone = resolveTimezone(config.timezone);
	} catch {
		// Config not found or invalid — use TZ env or UTC
	}

	const { waitUntilExit } = render(
		React.createElement(Dashboard, { epicsDir, timezone }),
	);

	await waitUntilExit();
}
