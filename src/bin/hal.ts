#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { handleCheck } from "../commands/check.js";
import { handleSessionStart } from "../commands/session.js";
import { handleSetup } from "../commands/setup.js";
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

const pkgPath = resolve(__dirname, "..", "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

/**
 * Wrap a command handler with common error handling.
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

// ---- setup ----

program
	.command("setup")
	.description("Register haltr hooks in ~/.claude/settings.json")
	.action(withErrorHandler(() => handleSetup()));

// ---- task ----

const taskCmd = new Command("task").description("Manage tasks (create, edit)");

taskCmd
	.command("create")
	.description("Create a new task file")
	.requiredOption("--file <file>", "Task file path (required)")
	.requiredOption("--goal <goal>", "Task goal")
	.option("--accept <accept...>", "Accept criteria (repeatable)")
	.option("--plan <plan>", "Task plan")
	.action(
		withErrorHandler(
			(opts: {
				file: string;
				goal: string;
				accept?: string[];
				plan?: string;
			}) => handleTaskCreate(opts),
		),
	);

taskCmd
	.command("edit")
	.description("Edit the current task")
	.option("--file <file>", "Task file path")
	.option("--goal <goal>", "New goal")
	.option("--accept <accept...>", "New accept criteria (repeatable)")
	.option("--plan <plan>", "New plan")
	.requiredOption("--message <message>", "Change reason")
	.action(
		withErrorHandler(
			(opts: {
				file?: string;
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
	.description("Add a new step to the task")
	.option("--file <file>", "Task file path")
	.option("--step <step>", "Step ID (single mode)")
	.option("--goal <goal>", "Step goal (single mode)")
	.option("--accept <accept...>", "Accept criteria (repeatable)")
	.option("--after <after>", "Insert after this step ID")
	.option("--stdin", "Read steps from stdin as YAML array (batch mode)")
	.action(
		withErrorHandler(
			(opts: {
				file?: string;
				step?: string;
				goal?: string;
				accept?: string[];
				after?: string;
				stdin?: boolean;
			}) => {
				if (opts.stdin) {
					handleStepAddBatch({ file: opts.file });
				} else if (opts.step && opts.goal) {
					handleStepAdd({
						file: opts.file,
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
	.option("--file <file>", "Task file path")
	.action(withErrorHandler((opts: { step: string; file?: string }) => handleStepStart(opts)));

stepCmd
	.command("done")
	.description("Mark a step as done (PASS/FAIL)")
	.requiredOption("--step <step>", "Step ID")
	.requiredOption("--result <result>", "Result: PASS or FAIL")
	.requiredOption("--message <message>", "Result message")
	.option("--file <file>", "Task file path")
	.action(
		withErrorHandler(
			(opts: { step: string; result: string; message: string; file?: string }) =>
				handleStepDone(opts),
		),
	);

stepCmd
	.command("pause")
	.description("Pause task work and switch to dialogue mode")
	.requiredOption("--message <message>", "Reason for pausing")
	.option("--file <file>", "Task file path")
	.action(
		withErrorHandler((opts: { message: string; file?: string }) => handleStepPause(opts)),
	);

stepCmd
	.command("resume")
	.description("Resume task work from dialogue mode")
	.option("--file <file>", "Task file path")
	.action(withErrorHandler((opts: { file?: string }) => handleStepResume(opts)));

stepCmd
	.command("verify")
	.description("Record verification result for a step")
	.requiredOption("--step <step>", "Step ID")
	.requiredOption("--result <result>", "Result: PASS or FAIL")
	.requiredOption("--message <message>", "Verification message")
	.option("--file <file>", "Task file path")
	.action(
		withErrorHandler(
			(opts: { step: string; result: string; message: string; file?: string }) =>
				handleStepVerify(opts),
		),
	);

program.addCommand(stepCmd);

// ---- status ----

program
	.command("status")
	.description("Show current task status")
	.option("--file <file>", "Task file path")
	.action(withErrorHandler((opts: { file?: string }) => handleStatus(opts)));

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

program.parse();
