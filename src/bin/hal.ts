#!/usr/bin/env node

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { initHaltr } from "../commands/init.js";
import {
  createEpic,
  listEpics,
  currentEpic,
  archiveEpic,
} from "../commands/epic.js";
import { createTask, editTask, writeTask } from "../commands/task.js";
import { registerHistoryCommand } from "../commands/history.js";
import { registerStatusCommand } from "../commands/status.js";
import { registerCheckCommand } from "../commands/check.js";
import { handleEscalate } from "../commands/escalate.js";
import { handleKill } from "../commands/kill-cmd.js";
import { handlePanes } from "../commands/panes.js";
import { listRules, addRule } from "../commands/rule.js";
import { handleLayout } from "../commands/layout.js";
import { handleSpawn, VALID_ROLES } from "../commands/spawn.js";
import { handleStart } from "../commands/start.js";
import { handleStop } from "../commands/stop.js";
import { TmuxRuntime } from "../lib/tmux-runtime.js";
import { registerHookCommand } from "../commands/hook.js";


const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve package.json from project root (two levels up from dist/bin/)
const pkgPath = resolve(__dirname, "..", "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

const program = new Command();

program
  .name("hal")
  .description("haltr — Quality assurance orchestration for coding agents")
  .version(pkg.version);

program
  .command("init")
  .description("Initialize haltr/ directory structure")
  .action(() => {
    try {
      initHaltr(process.cwd());
      console.log("Initialized haltr/ directory structure.");
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

const taskCmd = new Command("task").description("Manage tasks (new, edit)");

taskCmd
  .command("new")
  .description("Create a new task in an epic")
  .requiredOption("--epic <name>", "Epic name (suffix match)")
  .action((opts: { epic: string }) => {
    try {
      const taskPath = createTask(process.cwd(), opts.epic);
      console.log(`Created task: ${taskPath}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

taskCmd
  .command("edit <path>")
  .description("Edit a task.yaml file")
  .option("--field <field>", "Field to update")
  .option("--value <value>", "Value to set")
  .action((path: string, opts: { field?: string; value?: string }) => {
    try {
      if (!opts.field && !opts.value) {
        // Open in $EDITOR
        const editor = process.env.EDITOR || "vi";
        execFileSync(editor, [path], { stdio: "inherit" });
        // After editor closes, add updated event
        editTask(path);
      } else {
        editTask(path, opts.field, opts.value);
      }
      console.log(`Updated task: ${path}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

taskCmd
  .command("write <path>")
  .description("Write task.yaml from stdin (validates against schema)")
  .action((path: string) => {
    try {
      const content = readFileSync(0, "utf-8"); // read from stdin
      writeTask(path, content);
      console.log(`Written task: ${path}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

program.addCommand(taskCmd);

// ---- history, status, check ----

registerHistoryCommand(program);
registerStatusCommand(program);
registerCheckCommand(program);

// ---- escalate ----

program
  .command("escalate")
  .description("Report a problem from worker (status -> blocked)")
  .requiredOption("--task <path>", "Path to task.yaml")
  .requiredOption("--step <step>", "Step path")
  .requiredOption("--reason <reason>", "Reason for escalation")
  .action(async (opts: { task: string; step: string; reason: string }) => {
    try {
      await handleEscalate(opts);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

// ---- kill ----

program
  .command("kill")
  .description("Kill all panes related to a task")
  .requiredOption("--task <path>", "Path to task.yaml")
  .action(async (opts: { task: string }) => {
    try {
      await handleKill(opts);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

// ---- panes ----

program
  .command("panes")
  .description("List current panes")
  .action(() => {
    try {
      const output = handlePanes();
      console.log(output);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

// ---- rule ----

const ruleCmd = new Command("rule").description(
  "Manage project rules (add, list)",
);

ruleCmd
  .command("list")
  .description("List all rules")
  .action(() => {
    try {
      const content = listRules(process.cwd());
      console.log(content);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

ruleCmd
  .command("add <rule>")
  .description("Add a rule")
  .action((rule: string) => {
    try {
      addRule(process.cwd(), rule);
      console.log(`Rule added: ${rule}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

program.addCommand(ruleCmd);

// ---- layout ----

program
  .command("layout <type>")
  .description("Change tmux layout")
  .action(async (type: string) => {
    try {
      await handleLayout(type);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

// ---- spawn ----

program
  .command("spawn <role>")
  .description(
    `Spawn a new agent pane (roles: ${[...VALID_ROLES].join(", ")})`,
  )
  .requiredOption("--task <path>", "Path to task.yaml")
  .option("--step <step>", "Step path")
  .option("--cli <cli>", "CLI override (claude, codex, gemini)")
  .action(
    async (
      role: string,
      opts: { task: string; step?: string; cli?: string },
    ) => {
      try {
        const runtime = new TmuxRuntime("haltr", process.cwd());
        await handleSpawn(
          { role, task: opts.task, step: opts.step, cli: opts.cli },
          runtime,
        );
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`Error: ${msg}`);
        process.exit(1);
      }
    },
  );

// ---- start ----

program
  .command("start")
  .description("Start tmux session and orchestrator agent")
  .option("--cli <cli>", "CLI override for orchestrator")
  .option("--task <path>", "Path to task.yaml")
  .action(async (opts: { cli?: string; task?: string }) => {
    try {
      await handleStart(opts);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

// ---- stop ----

program
  .command("stop")
  .description("Stop tmux session and watcher process")
  .action(async () => {
    try {
      await handleStop();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

registerHookCommand(program);

program.parse();
