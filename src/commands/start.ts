/**
 * `hal start` -- Start tmux session and main orchestrator agent.
 *
 * hal start [--cli <cli>]
 *
 * Steps:
 *   1. Check if tmux session `haltr` already exists -> error
 *   2. Clear any leftover .panes.yaml
 *   3. Create tmux session `haltr`
 *   4. The initial pane (pane 0) becomes the main orchestrator
 *   5. Generate prompt.md for pane 0
 *   6. Register pane 0 in .panes.yaml as main-orchestrator
 *   7. Start watcher process (placeholder for M8)
 */

import { existsSync, writeFileSync } from "node:fs";
import { execFileSync, fork } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PanesManager } from "../lib/panes-manager.js";
import { loadAndValidateConfig } from "../lib/validator.js";
import { loadAndValidateTask } from "../lib/validator.js";
import {
  tmuxSessionExists,
  tmuxCreateSession,
  tmuxSendKeys,
  tmuxListPanes,
} from "../lib/tmux.js";
import {
  renderHooks,
  assemblePrompt,
  readRules,
  convertAgentSettingsForClaude,
  buildLaunchScript,
  type ClaudeSettings,
} from "./spawn.js";
import { validateCli, parseCli } from "../lib/task-utils.js";
import { Watcher, type WatcherDeps } from "../lib/watcher.js";

export interface StartOptions {
  cli?: string;
  task?: string;
  sessionName?: string;
}

/**
 * Dependencies that can be injected for testing.
 */
export interface StartDeps {
  sessionExists: (name: string) => Promise<boolean>;
  createSession: (name: string) => Promise<string>;
  sendKeys: (paneId: string, text: string) => Promise<void>;
  listAlivePanes?: () => Promise<string[]>;
}

const defaultDeps: StartDeps = {
  sessionExists: tmuxSessionExists,
  createSession: tmuxCreateSession,
  sendKeys: tmuxSendKeys,
  listAlivePanes: () => tmuxListPanes("haltr"), // default, overridden at runtime
};

/**
 * Core start logic, exported for testability.
 *
 * @param opts      command options
 * @param basePath  base path for haltr/ and .panes.yaml (defaults to cwd)
 * @param deps      injectable dependencies for testing
 */
export async function handleStart(
  opts: StartOptions = {},
  basePath?: string,
  deps: StartDeps = defaultDeps,
): Promise<{ paneId: string; cli: string }> {
  const base = basePath ?? process.cwd();
  const sessionName = opts.sessionName ?? "haltr";

  // 1. Check if session already exists
  const exists = await deps.sessionExists(sessionName);
  if (exists) {
    throw new Error(
      `tmux session "${sessionName}" already exists. Run 'hal stop' first.`,
    );
  }

  // 2. Find haltr directory and load config
  const haltrDir = findHaltrDirFromBase(base);
  const configPath = join(haltrDir, "config.yaml");
  const configYaml = loadAndValidateConfig(configPath);

  // Resolve CLI
  const resolvedCli = opts.cli ?? configYaml.orchestrator_cli;

  // Validate CLI against whitelist
  validateCli(resolvedCli);

  // 4. Create tmux session
  const paneId = await deps.createSession(sessionName);

  // 5. Generate prompt and hooks for main orchestrator
  let promptPath: string | undefined;
  let agentSettings: ClaudeSettings = {};
  const taskPath = opts.task ? resolve(opts.task) : undefined;

  try {
    // Render agent settings for main-orchestrator
    const hooksDir = renderHooks(haltrDir, "main-orchestrator", taskPath ?? "");
    agentSettings = convertAgentSettingsForClaude(hooksDir);

    if (taskPath && existsSync(taskPath)) {
      const taskYaml = loadAndValidateTask(taskPath);
      promptPath = assemblePrompt(
        hooksDir, haltrDir, "main-orchestrator", taskYaml, taskPath,
      );
    } else {
      promptPath = assembleOrchestratorPromptWithoutTask(hooksDir, haltrDir);
    }
  } catch {
    // Continue without prompt if anything fails
  }

  // 6. Register pane 0 as main-orchestrator
  // .panes.yaml is stored in the epic directory (if task exists) or haltr/ (fallback)
  const panesBase = taskPath ? dirname(taskPath) : haltrDir;
  const panesManager = new PanesManager(panesBase);
  panesManager.clear();
  panesManager.add({
    pane_id: paneId,
    step: "",
    role: "main-orchestrator",
    parent_pane_id: "",
    cli: resolvedCli,
    task_path: taskPath ?? "",
  });

  // Style orchestrator pane and enable border status
  if (deps === defaultDeps) {
    try {
      const { tmuxStylePane, tmuxEnableBorderStatus } = await import("../lib/tmux.js");
      await tmuxEnableBorderStatus(sessionName);
      await tmuxStylePane(paneId, "orchestrator", "yellow");
    } catch {
      // Best effort
    }
  }

  // 7. Start watcher as background process
  if (deps === defaultDeps) {
    // Production: fork watcher as detached child process
    const watcherScript = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "lib",
      "watcher-process.js",
    );
    const child = fork(watcherScript, [haltrDir, base], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } else {
    // Test: start watcher in-process
    const watcherDeps: WatcherDeps = {
      listAlivePanes: deps.listAlivePanes ?? (() => tmuxListPanes(sessionName)),
      sendKeys: deps.sendKeys,
    };
    const watcher = new Watcher(configYaml, haltrDir, base, watcherDeps);
    watcher.start();
  }

  // Launch orchestrator CLI in pane 0
  try {
    const hooksDir = join(haltrDir, ".hooks", "001_main-orchestrator");
    if (promptPath) {
      const scriptPath = buildLaunchScript(resolvedCli, "main-orchestrator", hooksDir, promptPath);
      await deps.sendKeys(paneId, `bash '${scriptPath}'`);
    } else {
      const { provider, model } = parseCli(resolvedCli);
      let cliCommand = provider;
      if (model) cliCommand += ` --model ${model}`;
      await deps.sendKeys(paneId, cliCommand);
    }
  } catch {
    // Best effort
  }

  console.log(`Started haltr session with main orchestrator (${resolvedCli})`);
  console.log(`  Pane: ${paneId}`);
  if (promptPath) {
    console.log(`  Prompt: ${promptPath}`);
  }

  // 8. Attach to tmux session (gives control to the user)
  if (deps === defaultDeps) {
    try {
      execFileSync("tmux", ["attach", "-t", sessionName], { stdio: "inherit" });
    } catch {
      // User detached from tmux — that's fine
    }
  }

  return { paneId, cli: resolvedCli };
}

/**
 * Find the haltr directory from a base path.
 * Checks both `base/haltr/` and `base/` itself.
 */
function findHaltrDirFromBase(base: string): string {
  // Check if base itself is a haltr directory
  if (existsSync(join(base, "config.yaml"))) {
    return base;
  }

  // Check haltr/ subdirectory
  const haltrSubDir = join(base, "haltr");
  if (
    existsSync(haltrSubDir) &&
    existsSync(join(haltrSubDir, "config.yaml"))
  ) {
    return haltrSubDir;
  }

  throw new Error(
    `Could not find haltr/ directory in ${base}. Run 'hal init' first.`,
  );
}


/**
 * Generate a prompt for the main orchestrator when no task exists yet.
 * Includes project rules and orchestrator role description.
 */
function assembleOrchestratorPromptWithoutTask(
  hooksDir: string,
  haltrDir: string,
): string {
  const rules = readRules(haltrDir);
  const prompt = `${rules}
---

# メインオーケストレーター

あなたは haltr のメインオーケストレーターです。
ユーザーの指示をタスクに構造化し、レビュー・承認・実行のフローを管理します。

## 絶対に守るルール

1. **ファイルを直接編集しない。** コードを書くのは worker。あなたは hal コマンドだけ使う。
2. **worker spawn の前に spec_reviewed と execution_approved の2つのイベントを history に記録すること。** これがないと hal spawn worker はエラーで弾かれる。
3. **ユーザーの承認なしに execution_approved を記録しない。** 必ずユーザーに確認する。
4. **agent の進捗を自分でポーリングしない。** tmux capture-pane や sleep で監視しないこと。agent が完了すれば stop hook 経由で通知が来る。問題があれば watcher が通知する。spawn したら完了通知を待つ。

## ワークフロー（この順序で実行）

### Step 1: タスク定義
実行するコマンド:
\`\`\`bash
hal epic create <name>
hal task new --epic <name>
cat << 'EOF' | hal task write <task-path>
id: <name>
status: pending
agents:
  worker: claude:sonnet
  verifier: claude:haiku
steps:
  - id: step-1
    goal: "ゴール"
    accept: "受入条件"
    status: pending
context: "背景"
history: []
EOF
\`\`\`

### Step 2: レビュー
実行するコマンド:
\`\`\`bash
hal spawn task-spec-reviewer --task <task-path>
\`\`\`
レビュアーの完了を待ち、レビュー内容を確認する。
問題なければ **必ず以下を実行**:
\`\`\`bash
hal history add --type spec_reviewed --task <task-path> --summary 'レビュー OK'
\`\`\`

### Step 3: ユーザー承認
ユーザーに以下を提示する:
- タスクの内容（ステップ、受入条件）
- レビュー結果
- 「この内容で実行してよいですか？」

ユーザーが承認したら **必ず以下を実行**:
\`\`\`bash
hal history add --type execution_approved --task <task-path>
\`\`\`
**ユーザーが承認するまで絶対に次に進まない。**

### Step 4: 実行
\`\`\`bash
hal history add --type step_started --step <step-id> --task <task-path>
hal status --task <task-path> <step-id> in_progress
hal spawn worker --step <step-id> --task <task-path>
\`\`\`

### Step 5: 検証
worker 完了後:
\`\`\`bash
hal spawn verifier --step <step-id> --task <task-path>
\`\`\`
PASS → hal status --task <task-path> <step-id> done → 次のステップへ
FAIL → リトライ

## その他のコマンド
\`\`\`bash
hal panes          # pane 一覧
hal kill --task <path>  # タスクの全 pane 停止
\`\`\`

作業ディレクトリ: ${haltrDir.replace(/\/haltr$/, "")}
`;

  const promptPath = join(hooksDir, "prompt.md");
  writeFileSync(promptPath, prompt, "utf-8");
  return promptPath;
}
