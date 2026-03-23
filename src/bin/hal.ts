#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { handleCheck } from "../commands/check.js";
import {
	handleContextCreate,
	handleContextDelete,
	handleContextList,
	handleContextLog,
	handleContextShow,
} from "../commands/context.js";
import { handleSessionStart } from "../commands/session.js";
import {
	archiveEpic,
	createEpic,
	currentEpic,
	listEpics,
} from "../commands/epic.js";
import { initHaltr } from "../commands/init.js";
import {
	handleStepAdd,
	handleStepAddBatch,
	handleStepDone,
	handleStepPause,
	handleStepResume,
	handleStepStart,
	handleStepVerify,
} from "../commands/step.js";
import { handleStatus } from "../commands/status.js";
import { handleTaskCreate, handleTaskEdit } from "../commands/task.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve package.json from project root (two levels up from dist/bin/)
const pkgPath = resolve(__dirname, "..", "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

/**
 * Wrap a command handler with common error handling.
 * Catches errors, prints message, and exits with code 1.
 * Supports both sync and async handlers.
 */
function withErrorHandler<T extends unknown[]>(
	fn: (...args: T) => void | Promise<void>,
): (...args: T) => void | Promise<void> {
	return async (...args: T) => {
		try {
			await fn(...args);
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error(`Error: ${msg}`);
			process.exit(1);
		}
	};
}

const program = new Command();

program
	.name("hal")
	.description("haltr — Quality assurance tool for coding agent outputs")
	.version(pkg.version);

// ---- init ----

program
	.command("init")
	.description("Initialize haltr directory structure")
	.option("--dir <dir>", "Directory name (default: work, interactive if not specified)")
	.action(
		withErrorHandler((opts: { dir?: string }) =>
			initHaltr(process.cwd(), opts.dir),
		),
	);

// ---- epic ----

const epicCmd = new Command("epic").description(
	"Manage epics (create, list, current, archive)",
);

epicCmd
	.command("create <name>")
	.description("Create a new epic")
	.action(
		withErrorHandler((name: string) => {
			const epicPath = createEpic(process.cwd(), name);
			console.log(`Created epic: ${epicPath}`);
		}),
	);

epicCmd
	.command("list")
	.description("List all epics with status")
	.action(
		withErrorHandler(() => {
			const epics = listEpics(process.cwd());
			if (epics.length === 0) {
				console.log("No epics found.");
				return;
			}
			for (const epic of epics) {
				console.log(`${epic.name}  status: ${epic.status}`);
			}
		}),
	);

epicCmd
	.command("current")
	.description("Show the most recent epic")
	.action(
		withErrorHandler(() => {
			const epic = currentEpic(process.cwd());
			if (!epic) {
				console.log("No epics found.");
				return;
			}
			console.log(`Epic: ${epic.name}`);
			if (epic.taskPath) {
				console.log(`Task: ${epic.taskPath}`);
			}
		}),
	);

epicCmd
	.command("archive <name>")
	.description("Archive an epic")
	.action(
		withErrorHandler((name: string) => {
			archiveEpic(process.cwd(), name);
			console.log(`Archived epic: ${name}`);
		}),
	);

program.addCommand(epicCmd);

// ---- task ----

const taskCmd = new Command("task").description("Manage tasks (create, edit)");

taskCmd
	.command("create")
	.description("Create a new task in the current epic")
	.requiredOption("--goal <goal>", "Task goal")
	.option("--accept <accept...>", "Accept criteria (repeatable)")
	.option("--plan <plan>", "Task plan")
	.action(
		withErrorHandler(
			(opts: {
				goal: string;
				accept?: string[];
				plan?: string;
			}) => handleTaskCreate(opts),
		),
	);

taskCmd
	.command("edit")
	.description("Edit the current task")
	.option("--goal <goal>", "New goal")
	.option("--accept <accept...>", "New accept criteria (repeatable)")
	.option("--plan <plan>", "New plan")
	.requiredOption("--message <message>", "Change reason")
	.action(
		withErrorHandler(
			(opts: {
				goal?: string;
				accept?: string[];
				plan?: string;
				message: string;
			}) => handleTaskEdit(opts),
		),
	);

program.addCommand(taskCmd);

// ---- step ----

const stepCmd = new Command("step").description(
	"Manage steps (add, start, done, pause, resume, verify)",
);

stepCmd
	.command("add")
	.description("Add a new step to the current task")
	.option("--step <step>", "Step ID (single mode)")
	.option("--goal <goal>", "Step goal (single mode)")
	.option("--accept <accept...>", "Accept criteria (repeatable)")
	.option("--after <after>", "Insert after this step ID")
	.option("--stdin", "Read steps from stdin as YAML array (batch mode)")
	.action(
		withErrorHandler(
			(opts: {
				step?: string;
				goal?: string;
				accept?: string[];
				after?: string;
				stdin?: boolean;
			}) => {
				if (opts.stdin) {
					handleStepAddBatch();
				} else if (opts.step && opts.goal) {
					handleStepAdd({
						step: opts.step,
						goal: opts.goal,
						accept: opts.accept,
						after: opts.after,
					});
				} else {
					throw new Error("--step と --goal を指定するか、--stdin でバッチモードを使用してください");
				}
			},
		),
	);

stepCmd
	.command("start")
	.description("Start working on a step")
	.requiredOption("--step <step>", "Step ID")
	.action(withErrorHandler((opts: { step: string }) => handleStepStart(opts)));

stepCmd
	.command("done")
	.description("Mark a step as done (PASS/FAIL)")
	.requiredOption("--step <step>", "Step ID")
	.requiredOption("--result <result>", "Result: PASS or FAIL")
	.requiredOption("--message <message>", "Result message (what was done or why it failed)")
	.action(
		withErrorHandler(
			(opts: { step: string; result: string; message: string }) =>
				handleStepDone(opts),
		),
	);

stepCmd
	.command("pause")
	.description("Pause task work and switch to dialogue mode")
	.requiredOption("--message <message>", "Reason for pausing")
	.action(
		withErrorHandler((opts: { message: string }) => handleStepPause(opts)),
	);

stepCmd
	.command("resume")
	.description("Resume task work from dialogue mode")
	.action(withErrorHandler(() => handleStepResume()));

stepCmd
	.command("verify")
	.description("Record verification result for a step (called by verify agent)")
	.requiredOption("--step <step>", "Step ID")
	.requiredOption("--result <result>", "Result: PASS or FAIL")
	.requiredOption("--message <message>", "Verification message (why it passed or failed)")
	.action(
		withErrorHandler(
			(opts: { step: string; result: string; message: string }) =>
				handleStepVerify(opts),
		),
	);

program.addCommand(stepCmd);

// ---- status ----

program
	.command("status")
	.description("Show current task status")
	.action(withErrorHandler(() => handleStatus()));

// ---- check ----

program
	.command("check")
	.description("Stop hook gate check (reads session_id from stdin)")
	.action(withErrorHandler(() => handleCheck()));

// ---- session-start ----

program
	.command("session-start")
	.description("SessionStart hook handler (reads session_id from stdin)")
	.action(() => handleSessionStart());

// ---- context ----

const contextCmd = new Command("context").description(
	"Manage context (skills and knowledge)",
);

contextCmd
	.command("list")
	.description("List all context entries")
	.action(withErrorHandler(() => handleContextList()));

contextCmd
	.command("show")
	.description("Show content of a context entry")
	.requiredOption("--id <id>", "Context entry ID")
	.action(withErrorHandler((opts: { id: string }) => handleContextShow(opts)));

contextCmd
	.command("create")
	.description("Create a new context entry")
	.requiredOption("--type <type>", "Entry type: skill or knowledge")
	.requiredOption("--id <id>", "Entry ID")
	.requiredOption("--description <description>", "Entry description")
	.action(
		withErrorHandler(
			(opts: { type: string; id: string; description: string }) =>
				handleContextCreate(opts),
		),
	);

contextCmd
	.command("delete")
	.description("Delete a context entry")
	.requiredOption("--id <id>", "Context entry ID")
	.requiredOption("--reason <reason>", "Deletion reason")
	.action(
		withErrorHandler((opts: { id: string; reason: string }) =>
			handleContextDelete(opts),
		),
	);

contextCmd
	.command("log")
	.description("Record a history event for a context entry")
	.requiredOption("--id <id>", "Context entry ID")
	.requiredOption(
		"--type <type>",
		"Event type: updated, confirmed, deprecated, promoted",
	)
	.option("--message <message>", "Event message")
	.action(
		withErrorHandler((opts: { id: string; type: string; message?: string }) =>
			handleContextLog(opts),
		),
	);

program.addCommand(contextCmd);

program.parse();
