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
import { handleSpawn, VALID_ROLES } from "../commands/spawn.js";
import { handleNext } from "../commands/next.js";
import { handleSend } from "../commands/send.js";
import { listPatterns, showPattern } from "../commands/patterns.js";
import { handleStart } from "../commands/start.js";
import { TmuxRuntime } from "../lib/tmux-runtime.js";
import { registerHookCommand } from "../commands/hook.js";
import {
  handleDefault as handleSessionDefault,
  handleNew as handleSessionNew,
  handleAttach as handleSessionAttach,
  handleStopSession as handleSessionStop,
  listSessions as sessionListSessions,
} from "../commands/session.js";
import { handleTui } from "../commands/tui.js";


const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve package.json from project root (two levels up from dist/bin/)
const pkgPath = resolve(__dirname, "..", "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

const program = new Command();

program
  .name("hal")
  .description("haltr — Quality assurance orchestration for coding agents")
  .version(pkg.version)
  .action(async () => {
    try {
      await handleSessionDefault();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

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
  .requiredOption("--message <message>", "Message for escalation")
  .action(async (opts: { task: string; step: string; message: string }) => {
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
        // Detect current tmux session name (spawn runs inside a haltr session)
        const { tmuxCurrentSession } = await import("../lib/tmux.js");
        const currentSession = await tmuxCurrentSession() ?? "haltr";
        const runtime = new TmuxRuntime(currentSession, process.cwd());
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

// ---- next ----

program
  .command("next")
  .description("Advance to next step (done → spawn worker)")
  .requiredOption("--task <path>", "Path to task.yaml")
  .requiredOption("--from <step>", "Current step to mark as done")
  .requiredOption("--to <step>", "Next step to start")
  .action(async (opts: { task: string; from: string; to: string }) => {
    try {
      const { tmuxCurrentSession } = await import("../lib/tmux.js");
      const currentSession = await tmuxCurrentSession() ?? "haltr";
      const runtime = new TmuxRuntime(currentSession, process.cwd());
      await handleNext(opts, runtime);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

// ---- send ----

program
  .command("send")
  .description("Send a message to an agent pane")
  .requiredOption("--task <path>", "Path to task.yaml")
  .requiredOption("--step <step>", "Step ID")
  .requiredOption("--message <text>", "Message to send")
  .option("--role <role>", "Target role (default: worker)")
  .action(async (opts: { task: string; step: string; message: string; role?: string }) => {
    try {
      await handleSend(opts);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

// ---- patterns ----

const patternsCmd = new Command("patterns").description("Task design patterns");

patternsCmd
  .command("list")
  .description("List available patterns")
  .action(() => {
    console.log(listPatterns());
  });

patternsCmd
  .command("show <id>")
  .description("Show a specific pattern")
  .action((id: string) => {
    try {
      console.log(showPattern(id));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

program.addCommand(patternsCmd);

// ---- session management ----

program
  .command("new")
  .description("Start a new haltr session")
  .action(async () => {
    try {
      await handleSessionNew();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

program
  .command("ls")
  .description("List active haltr sessions")
  .action(async () => {
    try {
      const sessions = await sessionListSessions();
      if (sessions.length === 0) {
        console.log("アクティブなセッションはありません。");
        return;
      }
      for (const s of sessions) {
        console.log(`  ${s.epicName}`);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

program
  .command("attach [epic]")
  .description("Attach to an existing haltr session")
  .action(async (epic?: string) => {
    try {
      if (epic) {
        await handleSessionAttach(epic);
      } else {
        await handleSessionDefault();
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

program
  .command("stop [epic]")
  .description("Stop haltr session(s)")
  .option("--all", "Stop all sessions")
  .action(async (epic: string | undefined, opts: { all?: boolean }) => {
    try {
      await handleSessionStop(epic, opts.all ?? false);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

// Keep start for backward compat (used internally by session.ts)
program
  .command("start")
  .description("Start tmux session and orchestrator agent (internal)")
  .option("--cli <cli>", "CLI override for orchestrator")
  .option("--task <path>", "Path to task.yaml")
  .option("--session-name <name>", "tmux session name")
  .action(async (opts: { cli?: string; task?: string; sessionName?: string }) => {
    try {
      await handleStart(opts);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

registerHookCommand(program);

// ---- tui ----

program
  .command("tui")
  .description("Launch interactive TUI dashboard")
  .action(async () => {
    try {
      await handleTui();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

program.parse();
