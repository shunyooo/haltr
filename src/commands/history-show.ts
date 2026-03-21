/**
 * `hal history show` — Display history events for a step.
 *
 * Workers can use this to read verification results, escalation details, etc.
 */

import { resolve } from "node:path";
import { loadConfig, validateTaskPath } from "../lib/task-utils.js";
import { formatLocalDateTime, resolveTimezone } from "../lib/timezone.js";
import { loadAndValidateTask } from "../lib/validator.js";

export interface HistoryShowOptions {
	task: string;
	step?: string;
	type?: string;
	last?: boolean;
}

export function handleHistoryShow(opts: HistoryShowOptions): string {
	const taskPath = resolve(opts.task);
	validateTaskPath(taskPath);
	const task = loadAndValidateTask(taskPath);

	let events = task.history ?? [];

	// Filter by step
	if (opts.step) {
		events = events.filter((e) => "step" in e && e.step === opts.step);
	}

	// Filter by type
	if (opts.type) {
		events = events.filter((e) => e.type === opts.type);
	}

	if (events.length === 0) {
		return "該当するイベントはありません。";
	}

	// If --last, show only the most recent
	if (opts.last) {
		events = [events[events.length - 1]];
	}

	// Resolve timezone
	let timezone = resolveTimezone();
	try {
		const config = loadConfig(taskPath);
		timezone = resolveTimezone(config.timezone);
	} catch {
		// Config not found — use TZ env or UTC
	}

	// Format output
	const lines: string[] = [];
	for (const e of events) {
		let line = `[${formatLocalDateTime(e.at, timezone)}] ${e.type}`;
		if ("step" in e) line += ` (${e.step})`;
		if ("attempt" in e) line += ` attempt:${e.attempt}`;
		line += ` by:${e.by}`;
		lines.push(line);
		if ("message" in e && e.message) {
			lines.push(e.message);
		}
		if ("accept_id" in e && e.accept_id) {
			lines.push(`accept_id: ${e.accept_id}`);
		}
		lines.push("");
	}

	return lines.join("\n").trim();
}
