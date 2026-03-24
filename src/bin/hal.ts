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
	.version(pkg.version)
	.addHelpText("after", `
What is haltr?
  A tool that helps coding agents complete long-running tasks with quality.
  Persists goals, steps, and history in task.yaml. Uses quality gates and
  Stop hook to prevent forgetting, cutting corners, and premature exit.

When to use:
  Use for multi-step work (implementation + tests + docs, etc.).
  Not needed for simple questions or small fixes.
  Create a task with hal task create when you judge "this will take a while".

How task.yaml works:
  task.yaml is the state management file. It persists:
  - goal: what to achieve
  - steps: list of steps and their status (pending -> in_progress -> done/failed)
  - history: full event log (created, step_started, step_done, paused, etc.)
  Even as context grows long, hal status gives an accurate view of current state.

Accept criteria & verification:
  accept defines step completion criteria. When set, a quality gate is enforced:
  1. hal step add --step impl --goal 'Implement' --accept 'Tests pass'
  2. Do the work
  3. Spawn a sub-agent with the Agent tool to independently verify accept criteria
  4. Sub-agent runs hal step verify --step impl --result PASS|FAIL
  5. After verify PASS, run hal step done --step impl --result PASS
  Steps without accept can be marked done directly (no verify needed).

Stop hook:
  After hal step start, the agent is blocked from stopping until the task completes.
  Use hal step pause to temporarily unblock for user dialogue.

Workflow:
  1. hal setup                                          One-time. Register hooks
  2. hal task create --file <name> --goal '<goal>'       Create task
  3. hal step add --step <id> --goal '<goal>'            Break into steps
  4. hal step start --step <id>                          Start work (Stop hook active)
  5. Work -> verify -> hal step done --step <id> --result PASS|FAIL
  6. All steps done -> task auto-completes -> Stop hook deactivated

Step lifecycle:
  hal step start   Set step to in_progress. Stop hook activated
  hal step verify  Record verification result via sub-agent (when accept exists)
  hal step done    Mark step complete (PASS) or record failure (FAIL)
  hal step pause   Switch to dialogue mode (Stop hook temporarily deactivated)
  hal step resume  Return to autonomous mode (Stop hook reactivated)

Task file resolution (when --file omitted):
  1. Session mapping (auto-registered on task create / step start)
  2. Auto-detect task.yaml or *.task.yaml in current directory`);

// ---- setup ----

program
	.command("setup")
	.description("Register haltr hooks in ~/.claude/settings.json")
	.addHelpText("after", `
  Registers SessionStart and Stop hooks. Run once.
  Existing hooks are preserved (merged).`)
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
	.addHelpText("after", `
  Creates a task file at the specified path. Session mapping is auto-registered.
  Example: hal task create --file feature-auth.yaml --goal 'Implement OAuth2 auth'`)
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
	.addHelpText("after", `
  Updates goal or accept criteria. Changes are recorded in history.
  Example: hal task edit --goal 'Switch to OAuth2' --message 'Security requirements changed'`)
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
	.addHelpText("after", `
  Single: hal step add --step impl --goal 'Implement auth' --accept 'Tests pass'
  Batch:  echo '<yaml>' | hal step add --stdin`)
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
					throw new Error("Specify --step and --goal, or use --stdin for batch mode");
				}
			},
		),
	);

stepCmd
	.command("start")
	.description("Start working on a step (activates Stop hook)")
	.requiredOption("--step <step>", "Step ID")
	.option("--file <file>", "Task file path")
	.addHelpText("after", `
  Sets step to in_progress. Session mapping is also updated.
  Cross-session handoff: hal step start --file task.yaml --step impl`)
	.action(withErrorHandler((opts: { step: string; file?: string }) => handleStepStart(opts)));

stepCmd
	.command("done")
	.description("Mark a step as done (PASS/FAIL)")
	.requiredOption("--step <step>", "Step ID")
	.requiredOption("--result <result>", "Result: PASS or FAIL")
	.requiredOption("--message <message>", "Result message")
	.option("--file <file>", "Task file path")
	.addHelpText("after", `
  PASS: marks step done (requires verify if accept criteria exist)
  FAIL: records failure (step stays in_progress, fix and retry)`)
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
	.addHelpText("after", `
  Temporarily deactivates Stop hook for user dialogue.
  Resume with hal step resume.`)
	.action(
		withErrorHandler((opts: { message: string; file?: string }) => handleStepPause(opts)),
	);

stepCmd
	.command("resume")
	.description("Resume task work from dialogue mode")
	.option("--file <file>", "Task file path")
	.addHelpText("after", `
  Clears pause state and resumes work. Stop hook reactivated.`)
	.action(withErrorHandler((opts: { file?: string }) => handleStepResume(opts)));

stepCmd
	.command("verify")
	.description("Record verification result for a step (called by sub-agent)")
	.requiredOption("--step <step>", "Step ID")
	.requiredOption("--result <result>", "Result: PASS or FAIL")
	.requiredOption("--message <message>", "Verification message")
	.option("--file <file>", "Task file path")
	.addHelpText("after", `
  Called by sub-agent (Agent tool). Independently verifies accept criteria.
  PASS enables step done (PASS).`)
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
	.addHelpText("after", `
  Outputs task goal, step progress, and suggested next actions in YAML.`)
	.action(withErrorHandler((opts: { file?: string }) => handleStatus(opts)));

// ---- check ----

program
	.command("check")
	.description("Stop hook gate check (reads session_id from stdin)")
	.addHelpText("after", `
  Auto-executed by Stop hook. No need to call manually.
  Exit 2 (block) if incomplete steps remain, exit 0 (allow) otherwise.`)
	.action(withErrorHandler(() => handleCheck()));

// ---- session-start ----

program
	.command("session-start")
	.description("SessionStart hook handler (reads session_id from stdin)")
	.addHelpText("after", `
  Auto-executed by SessionStart hook. No need to call manually.
  Sets session ID to HALTR_SESSION_ID environment variable.`)
	.action(() => handleSessionStart());

program.parse();
