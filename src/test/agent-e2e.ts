/**
 * Agent E2E Test
 *
 * Full end-to-end test using actual Claude Code agents in tmux panes.
 * Each stage runs a real Claude agent that executes hal commands.
 *
 *   Stage 1: Orchestrator creates epic and task via hal commands
 *   Stage 2: Worker implements the task (creates file + records work_done)
 *   Stage 3: Verifier checks the result (records verification_passed)
 *   Stage 4: Validate final task.yaml state
 *
 * Uses --model haiku for cost efficiency.
 * Run with: npm run test:agent-e2e
 */

import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as yaml from "js-yaml";

const SESSION = "haltr-e2e";
const PROJECT_ROOT = process.cwd();
const HAL_BIN = join(PROJECT_ROOT, "dist", "bin", "hal.js");
const CLAUDE_MODEL = "haiku";
const STAGE_TIMEOUT_MS = 90_000;
const POLL_MS = 2_000;

// ============================================================================
// Helpers
// ============================================================================

function tmux(...args: string[]): string {
  try {
    return execFileSync("tmux", args, { encoding: "utf-8", timeout: 5000 }).trim();
  } catch (e: any) {
    return ((e.stdout ?? "") + (e.stderr ?? "")).trim();
  }
}

function hal(cwd: string, ...args: string[]): string {
  try {
    return execFileSync("node", [HAL_BIN, ...args], {
      encoding: "utf-8",
      cwd,
      timeout: 15000,
    }).trim();
  } catch (e: any) {
    return ((e.stdout ?? "") + (e.stderr ?? "")).trim();
  }
}

function capturePaneOutput(paneId: string): string {
  try {
    return execFileSync("tmux", ["capture-pane", "-t", paneId, "-p", "-S", "-200"], {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
  } catch {
    return "";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function cleanup() {
  try { execFileSync("tmux", ["kill-session", "-t", SESSION], { timeout: 3000 }); } catch {}
}

async function waitFor(
  label: string,
  fn: () => boolean,
  timeoutMs = STAGE_TIMEOUT_MS,
): Promise<void> {
  const start = Date.now();
  process.stdout.write(`   Waiting: ${label}`);
  while (Date.now() - start < timeoutMs) {
    if (fn()) {
      process.stdout.write(` ✓ (${Math.round((Date.now() - start) / 1000)}s)\n`);
      return;
    }
    process.stdout.write(".");
    await sleep(POLL_MS);
  }
  process.stdout.write(` ✗\n`);
  throw new Error(`Timeout: ${label} (${timeoutMs}ms)`);
}

/**
 * Run a Claude agent in a tmux pane and wait for it to finish.
 * Uses --print mode so the agent runs the task and exits.
 */
async function runAgentInPane(
  paneId: string,
  cwd: string,
  prompt: string,
  label: string,
): Promise<void> {
  // Write prompt to temp file (avoids shell escaping issues)
  const promptFile = join(cwd, `.prompt-${Date.now()}.md`);
  writeFileSync(promptFile, prompt, "utf-8");

  // Use a unique marker with a random suffix to avoid matching the command line itself
  const marker = `HALTR_DONE_${Math.random().toString(36).slice(2, 10)}`;

  // Pipe prompt via stdin to claude --print
  tmux(
    "send-keys", "-t", paneId,
    `cat '${promptFile}' | claude --model ${CLAUDE_MODEL} -p --allowedTools "Bash Write Read Edit Glob Grep" 2>&1; echo ${marker}`,
    "Enter",
  );

  // Wait for the marker to appear as output (not just in the command line)
  await waitFor(label, () => {
    const output = capturePaneOutput(paneId);
    // Split by lines and check if marker appears as a standalone line (= output of echo)
    const lines = output.split("\n").map(l => l.trim());
    // The marker appears twice: once in the command, once as echo output
    // Check for it appearing after the $ prompt (as echo output)
    let count = 0;
    for (const line of lines) {
      if (line === marker) count++;
    }
    return count >= 1;
  });
}

function findTaskPath(testDir: string): string | undefined {
  const epicsDir = join(testDir, "haltr", "epics");
  if (!existsSync(epicsDir)) return undefined;
  const epics = readdirSync(epicsDir).filter(e => !e.startsWith(".") && e !== "archive").sort();
  if (epics.length === 0) return undefined;
  const epicDir = join(epicsDir, epics[epics.length - 1]);
  const tasks = readdirSync(epicDir).filter(f => f.endsWith("_task.yaml")).sort();
  if (tasks.length === 0) return undefined;
  return join(epicDir, tasks[tasks.length - 1]);
}

function readTask(path: string): any {
  return yaml.load(readFileSync(path, "utf-8"));
}

/**
 * Check pane output for hook errors and warnings.
 */
function checkPaneForErrors(paneId: string, label: string): void {
  const output = capturePaneOutput(paneId);
  const lines = output.split("\n");
  const hookErrors = lines.filter(l =>
    /hook.*error|hook.*fail|Hook Error/i.test(l)
  );
  if (hookErrors.length > 0) {
    console.log(`   ⚠ Hook errors in ${label}:`);
    for (const line of hookErrors) {
      console.log(`     ${line.trim()}`);
    }
  }
}

// ============================================================================
// Pre-flight
// ============================================================================

console.log("=== Agent E2E Test (Full Orchestration Flow) ===\n");

try { execFileSync("tmux", ["-V"], { encoding: "utf-8" }); } catch {
  console.log("SKIP: tmux not available"); process.exit(0);
}
try { execFileSync("claude", ["--version"], { encoding: "utf-8", timeout: 5000 }); } catch {
  console.log("SKIP: claude CLI not available"); process.exit(0);
}
if (!existsSync(HAL_BIN)) {
  console.log("ERROR: run 'npm run build' first"); process.exit(1);
}

cleanup();

// ============================================================================
// Test
// ============================================================================

const testDir = mkdtempSync(join(tmpdir(), "haltr-agent-e2e-"));
const targetFile = join(testDir, "hello.txt");

try {
  // Setup: hal init
  console.log("0. Setup");
  hal(testDir, "init");
  console.log(`   Dir: ${testDir}\n`);

  // Start tmux session
  tmux("new-session", "-d", "-s", SESSION, "-c", testDir);
  const basePaneId = tmux("list-panes", "-t", SESSION, "-F", "#{pane_id}").split("\n")[0];

  // ========================================================================
  // Stage 1: Orchestrator creates epic and task
  // ========================================================================
  console.log("Stage 1: Orchestrator creates epic and task");

  await runAgentInPane(basePaneId, testDir, `
あなたは haltr のオーケストレーターです。以下の手順を正確に実行してください。

1. 以下のコマンドでエピックを作成:
   hal epic create hello-world

2. 以下のコマンドでタスクを作成:
   hal task new --epic hello-world

3. 作成された task.yaml のパスを確認して、以下の内容で上書き:
   - id: hello-world
   - status: pending
   - agents.worker: claude
   - agents.verifier: claude
   - steps に1つだけステップを追加:
     - id: create-file
     - instructions: "${targetFile} に 'Hello from haltr E2E' という内容のファイルを作成する"
     - accept: "${targetFile} が存在し中身に 'Hello from haltr E2E' が含まれること"
     - status: pending
   - context: "E2E テスト用のシンプルなタスク"
   - history はそのまま残す

task.yaml のスキーマ例:
\`\`\`yaml
id: hello-world
status: pending
agents:
  worker: claude
  verifier: claude
steps:
  - id: create-file
    instructions: "${targetFile} に 'Hello from haltr E2E' という内容のファイルを作成する"
    accept: "${targetFile} が存在し中身に 'Hello from haltr E2E' が含まれること"
    status: pending
context: "E2E テスト用のシンプルなタスク"
history:
  - at: "2026-01-01T00:00:00Z"
    type: created
    by: orchestrator(claude)
\`\`\`

必ず Bash ツールで hal コマンドを実行してください。
作業ディレクトリ: ${testDir}
`, "Stage 1 (orchestrator creates task)");

  // Verify task was created
  const taskPath = findTaskPath(testDir);
  if (!taskPath) throw new Error("Task file not found after Stage 1");
  const task1 = readTask(taskPath);
  console.log(`   Task path: ${taskPath}`);
  console.log(`   Task id: ${task1.id}`);
  console.log(`   Steps: ${task1.steps?.length ?? 0}`);
  if (!task1.steps || task1.steps.length === 0) {
    throw new Error("Task has no steps after Stage 1");
  }
  checkPaneForErrors(basePaneId, "Stage 1 pane");
  console.log("");

  // ========================================================================
  // Stage 2: Worker implements the task
  // ========================================================================
  console.log("Stage 2: Worker implements the task");

  // Orchestrator records step_started (as the orchestrator would)
  hal(testDir, "history", "add", "--type", "step_started", "--step", "create-file", "--task", taskPath);
  hal(testDir, "status", "--task", taskPath, "create-file", "in_progress");

  // Spawn a new pane for worker
  tmux("split-window", "-t", SESSION, "-c", testDir);
  await sleep(500);
  const workerPaneId = tmux("list-panes", "-t", SESSION, "-F", "#{pane_id}").split("\n").pop()!;

  await runAgentInPane(workerPaneId, testDir, `
あなたは haltr の worker エージェントです。以下のタスクを実行してください。

## タスク
${targetFile} に "Hello from haltr E2E" という内容のファイルを作成する。

## 完了後
以下のコマンドを実行して作業完了を記録してください:
hal history add --type work_done --step create-file --task '${taskPath}' --summary 'hello.txt を作成しました'

作業ディレクトリ: ${testDir}
`, "Stage 2 (worker creates file)");

  // Verify file was created
  if (!existsSync(targetFile)) throw new Error("hello.txt not created by worker");
  const content = readFileSync(targetFile, "utf-8");
  if (!content.includes("Hello from haltr E2E")) {
    throw new Error(`Wrong content: ${content}`);
  }
  console.log("   ✓ File created with correct content");

  // Verify work_done event
  const task2 = readTask(taskPath);
  const workDone = task2.history?.find((e: any) => e.type === "work_done");
  if (!workDone) {
    console.log("   △ work_done event not recorded (continuing)");
  } else {
    console.log("   ✓ work_done event recorded");
  }
  checkPaneForErrors(workerPaneId, "Stage 2 worker pane");
  console.log("");

  // ========================================================================
  // Stage 3: Verifier checks the result
  // ========================================================================
  console.log("Stage 3: Verifier checks the result");

  // Orchestrator records verifier_started
  hal(testDir, "history", "add", "--type", "verifier_started", "--step", "create-file", "--task", taskPath, "--accept-id", "default");

  // Spawn verifier pane
  tmux("split-window", "-t", SESSION, "-c", testDir);
  await sleep(500);
  const verifierPaneId = tmux("list-panes", "-t", SESSION, "-F", "#{pane_id}").split("\n").pop()!;

  await runAgentInPane(verifierPaneId, testDir, `
あなたは haltr の verifier エージェントです。以下の受入条件を検証してください。

## 受入条件
${targetFile} が存在し、中身に "Hello from haltr E2E" が含まれること

## 検証手順
1. ファイルの存在を確認
2. 内容を確認
3. 結果を記録

## 検証結果の記録

### PASS の場合:
hal history add --type verification_passed --step create-file --task '${taskPath}' --accept-id default --evidence '検証 OK: ファイルが存在し内容が正しい'

### FAIL の場合:
hal history add --type verification_failed --step create-file --task '${taskPath}' --accept-id default --reason '失敗理由をここに'

作業ディレクトリ: ${testDir}
`, "Stage 3 (verifier checks)");

  // Verify verification event was recorded
  const task3 = readTask(taskPath);
  const verPassed = task3.history?.find((e: any) => e.type === "verification_passed");
  const verFailed = task3.history?.find((e: any) => e.type === "verification_failed");

  if (verPassed) {
    console.log("   ✓ verification_passed recorded");
    console.log(`     Evidence: ${verPassed.message}`);
  } else if (verFailed) {
    console.log(`   △ verification_failed: ${verFailed.message}`);
  } else {
    console.log("   △ No verification event recorded");
  }
  checkPaneForErrors(verifierPaneId, "Stage 3 verifier pane");
  console.log("");

  // ========================================================================
  // Stage 4: Validate final state
  // ========================================================================
  console.log("Stage 4: Validate final state");

  // Mark step as done if verification passed
  if (verPassed) {
    hal(testDir, "status", "--task", taskPath, "create-file", "done");
  }

  const finalTask = readTask(taskPath);
  console.log(`   Task ID:      ${finalTask.id}`);
  console.log(`   Task status:  ${finalTask.status}`);
  console.log(`   Step status:  ${finalTask.steps?.[0]?.status}`);
  console.log(`   History:      ${finalTask.history?.length} events`);

  // List all history events
  console.log("\n   History timeline:");
  for (const event of finalTask.history ?? []) {
    const time = event.at?.substring(11, 19) ?? "??";
    const step = event.step ? ` [${event.step}]` : "";
    const extra = event.message ?? event.message ?? event.message ?? event.message ?? "";
    console.log(`     ${time} ${event.type}${step} ${extra ? "— " + extra : ""}`);
  }

  // Assertions
  const errors: string[] = [];
  if (!existsSync(targetFile)) errors.push("hello.txt does not exist");
  if (!finalTask.steps?.[0]) errors.push("No steps in task");
  if (verPassed && finalTask.steps?.[0]?.status !== "done") errors.push(`Step not done: ${finalTask.steps?.[0]?.status}`);

  const expectedEvents = ["created", "step_started"];
  for (const type of expectedEvents) {
    if (!finalTask.history?.some((e: any) => e.type === type)) {
      errors.push(`Missing event: ${type}`);
    }
  }

  if (errors.length > 0) {
    console.log("\n   Errors:");
    for (const e of errors) console.log(`     ✗ ${e}`);
    throw new Error(`Validation failed: ${errors.join(", ")}`);
  }

  console.log("\n========================================");
  console.log("✓ Agent E2E test passed!");
  console.log("========================================");

} catch (e: any) {
  console.error(`\n✗ ${e.message}`);

  // Dump pane outputs for debugging
  try {
    console.log("\n--- Debug: Pane outputs ---");
    const panes = tmux("list-panes", "-t", SESSION, "-F", "#{pane_id}").split("\n");
    for (const pane of panes) {
      if (!pane) continue;
      console.log(`\n[Pane ${pane}]:`);
      const out = capturePaneOutput(pane);
      // Show last 30 lines
      console.log(out.split("\n").slice(-30).join("\n"));
    }
  } catch {}

  process.exit(1);
} finally {
  cleanup();
  rmSync(testDir, { recursive: true, force: true });
}
