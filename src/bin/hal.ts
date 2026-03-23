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
import {
	archiveEpic,
	createEpic,
	currentEpic,
	listEpics,
} from "../commands/epic.js";
import { initHaltr } from "../commands/init.js";
import {
	handleStepAdd,
	handleStepDone,
	handleStepPause,
	handleStepResume,
	handleStepStart,
} from "../commands/step.js";
import { handleStatus } from "../commands/status.js";
import { handleTaskCreate, handleTaskEdit } from "../commands/task.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve package.json from project root (two levels up from dist/bin/)
const pkgPath = resolve(__dirname, "..", "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

const program = new Command();

program
	.name("hal")
	.description("haltr — Quality assurance tool for coding agent outputs")
	.version(pkg.version);

// ---- init ----

program
	.command("init")
	.description("Initialize haltr/ directory structure")
	.action(() => {
		try {
			initHaltr(process.cwd());
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error(`Error: ${msg}`);
			process.exit(1);
		}
	});

// ---- epic ----

const epicCmd = new Command("epic").description(
	"Manage epics (create, list, current, archive)",
);

epicCmd
	.command("create <name>")
	.description("Create a new epic")
	.action((name: string) => {
		try {
			const epicPath = createEpic(process.cwd(), name);
			console.log(`Created epic: ${epicPath}`);
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error(`Error: ${msg}`);
			process.exit(1);
		}
	});

epicCmd
	.command("list")
	.description("List all epics with status")
	.action(() => {
		try {
			const epics = listEpics(process.cwd());
			if (epics.length === 0) {
				console.log("No epics found.");
				return;
			}
			for (const epic of epics) {
				console.log(`${epic.name}  status: ${epic.status}`);
			}
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error(`Error: ${msg}`);
			process.exit(1);
		}
	});

epicCmd
	.command("current")
	.description("Show the most recent epic")
	.action(() => {
		try {
			const epic = currentEpic(process.cwd());
			if (!epic) {
				console.log("No epics found.");
				return;
			}
			console.log(`Epic: ${epic.name}`);
			if (epic.taskPath) {
				console.log(`Task: ${epic.taskPath}`);
			}
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error(`Error: ${msg}`);
			process.exit(1);
		}
	});

epicCmd
	.command("archive <name>")
	.description("Archive an epic")
	.action((name: string) => {
		try {
			archiveEpic(process.cwd(), name);
			console.log(`Archived epic: ${name}`);
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error(`Error: ${msg}`);
			process.exit(1);
		}
	});

program.addCommand(epicCmd);

// ---- task ----

const taskCmd = new Command("task").description("Manage tasks (create, edit)");

taskCmd
	.command("create")
	.description("Create a new task in the current epic")
	.requiredOption("--goal <goal>", "Task goal")
	.option("--accept <accept...>", "Accept criteria (repeatable)")
	.option("--plan <plan>", "Task plan")
	.option("--notes <notes>", "Task notes")
	.action(
		(opts: {
			goal: string;
			accept?: string[];
			plan?: string;
			notes?: string;
		}) => {
			try {
				handleTaskCreate(opts);
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e);
				console.error(`Error: ${msg}`);
				process.exit(1);
			}
		},
	);

taskCmd
	.command("edit")
	.description("Edit the current task")
	.option("--goal <goal>", "New goal")
	.option("--accept <accept...>", "New accept criteria (repeatable)")
	.option("--plan <plan>", "New plan")
	.option("--notes <notes>", "New notes")
	.requiredOption("--message <message>", "Change reason")
	.action(
		(opts: {
			goal?: string;
			accept?: string[];
			plan?: string;
			notes?: string;
			message: string;
		}) => {
			try {
				handleTaskEdit(opts);
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e);
				console.error(`Error: ${msg}`);
				process.exit(1);
			}
		},
	);

program.addCommand(taskCmd);

// ---- step ----

const stepCmd = new Command("step").description(
	"Manage steps (add, start, done, pause, resume)",
);

stepCmd
	.command("add")
	.description("Add a new step to the current task")
	.requiredOption("--step <step>", "Step ID")
	.requiredOption("--goal <goal>", "Step goal")
	.option("--accept <accept...>", "Accept criteria (repeatable)")
	.option("--after <after>", "Insert after this step ID")
	.action(
		(opts: {
			step: string;
			goal: string;
			accept?: string[];
			after?: string;
		}) => {
			try {
				handleStepAdd(opts);
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e);
				console.error(`Error: ${msg}`);
				process.exit(1);
			}
		},
	);

stepCmd
	.command("start")
	.description("Start working on a step")
	.requiredOption("--step <step>", "Step ID")
	.action((opts: { step: string }) => {
		try {
			handleStepStart(opts);
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error(`Error: ${msg}`);
			process.exit(1);
		}
	});

stepCmd
	.command("done")
	.description("Mark a step as done (PASS/FAIL)")
	.requiredOption("--step <step>", "Step ID")
	.requiredOption("--result <result>", "Result: PASS or FAIL")
	.option("--message <message>", "Result message")
	.action((opts: { step: string; result: string; message?: string }) => {
		try {
			handleStepDone(opts);
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error(`Error: ${msg}`);
			process.exit(1);
		}
	});

stepCmd
	.command("pause")
	.description("Pause current work (copilot mode)")
	.action(() => {
		try {
			handleStepPause();
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error(`Error: ${msg}`);
			process.exit(1);
		}
	});

stepCmd
	.command("resume")
	.description("Resume paused work")
	.action(() => {
		try {
			handleStepResume();
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error(`Error: ${msg}`);
			process.exit(1);
		}
	});

program.addCommand(stepCmd);

// ---- status ----

program
	.command("status")
	.description("Show current task status")
	.action(() => {
		try {
			handleStatus();
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error(`Error: ${msg}`);
			process.exit(1);
		}
	});

// ---- check ----

program
	.command("check")
	.description("Stop hook gate check (reads session_id from stdin)")
	.action(() => {
		try {
			handleCheck();
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error(`Error: ${msg}`);
			process.exit(1);
		}
	});

// ---- context ----

const contextCmd = new Command("context").description(
	"Manage context (skills and knowledge)",
);

contextCmd
	.command("list")
	.description("List all context entries")
	.action(() => {
		try {
			handleContextList();
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error(`Error: ${msg}`);
			process.exit(1);
		}
	});

contextCmd
	.command("show")
	.description("Show content of a context entry")
	.requiredOption("--id <id>", "Context entry ID")
	.action((opts: { id: string }) => {
		try {
			handleContextShow(opts);
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error(`Error: ${msg}`);
			process.exit(1);
		}
	});

contextCmd
	.command("create")
	.description("Create a new context entry")
	.requiredOption("--type <type>", "Entry type: skill or knowledge")
	.requiredOption("--id <id>", "Entry ID")
	.requiredOption("--description <description>", "Entry description")
	.action((opts: { type: string; id: string; description: string }) => {
		try {
			handleContextCreate(opts);
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error(`Error: ${msg}`);
			process.exit(1);
		}
	});

contextCmd
	.command("delete")
	.description("Delete a context entry")
	.requiredOption("--id <id>", "Context entry ID")
	.requiredOption("--reason <reason>", "Deletion reason")
	.action((opts: { id: string; reason: string }) => {
		try {
			handleContextDelete(opts);
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error(`Error: ${msg}`);
			process.exit(1);
		}
	});

contextCmd
	.command("log")
	.description("Record a history event for a context entry")
	.requiredOption("--id <id>", "Context entry ID")
	.requiredOption(
		"--type <type>",
		"Event type: updated, confirmed, deprecated, promoted",
	)
	.option("--message <message>", "Event message")
	.action((opts: { id: string; type: string; message?: string }) => {
		try {
			handleContextLog(opts);
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error(`Error: ${msg}`);
			process.exit(1);
		}
	});

program.addCommand(contextCmd);

program.parse();
