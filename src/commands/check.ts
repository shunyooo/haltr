/**
 * `hal check` — Role-based completion gate check.
 *
 * Used as a Stop Hook for Claude Code (and other CLI agents).
 *
 * Three modes:
 *   --worker      Worker stop-hook gate
 *   --verifier    Verifier stop-hook gate
 *   --orchestrator Orchestrator stop-hook gate
 *
 * Exit codes:
 *   0 = allow (agent can stop)
 *   1 = block (agent must continue)
 *
 * Messages printed to stdout become the systemMessage when blocking.
 */

import type { Command } from "commander";
import { resolve, dirname } from "node:path";
import { writeFileSync } from "node:fs";
import * as yaml from "js-yaml";
import { loadAndValidateTask, loadAndValidateConfig } from "../lib/validator.js";
import { findStep, validateTaskPath, loadConfig } from "../lib/task-utils.js";
import { PanesManager } from "../lib/panes-manager.js";
import { tmuxSendKeys, tmuxKillPane } from "../lib/tmux.js";
import type {
  TaskYaml,
  HistoryEvent,
  Step,
  AcceptObject,
} from "../types.js";

// ============================================================================
// Core check logic (exported for testing)
// ============================================================================

export interface CheckResult {
  /** "allow" (exit 0), "block" (exit 1), or "escalate" (exit 2). */
  action: "allow" | "block" | "escalate";
  /** Message to display (stdout for hooks). */
  message?: string;
  /** Notification to send to parent orchestrator pane. */
  notification?: string;
}

/**
 * Get history events for a specific step + current attempt.
 * "Current attempt" = the highest attempt number for that step.
 */
function getStepHistory(
  history: HistoryEvent[],
  stepId: string,
): HistoryEvent[] {
  // Find the current attempt number (max attempt from step_started events)
  let currentAttempt = 1;
  for (const e of history) {
    if (
      e.type === "step_started" &&
      "step" in e &&
      e.step === stepId &&
      "attempt" in e
    ) {
      if (e.attempt > currentAttempt) {
        currentAttempt = e.attempt;
      }
    }
  }

  // Filter to events for this step + current attempt
  return history.filter((e) => {
    if (!("step" in e) || (e as any).step !== stepId) return false;
    if ("attempt" in e && (e as any).attempt !== currentAttempt) return false;
    return true;
  });
}

/**
 * Worker stop-hook check logic.
 */
export function checkWorker(
  task: TaskYaml,
  stepId: string,
): CheckResult {
  // Shared session: block if there are more pending steps
  if (task.worker_session === "shared") {
    const hasPendingSteps = task.steps.some(
      (s) => (s.status ?? "pending") === "pending",
    );
    if (hasPendingSteps) {
      return {
        action: "block",
        message: "セッション共有モードです。次のステップの指示を待ってください。",
      };
    }
  }

  const history = task.history ?? [];
  const stepHistory = getStepHistory(history, stepId);

  // Check max_retries guard
  const step = findStep(task.steps, stepId);
  if (step?.max_retries !== undefined) {
    const attemptCount = history.filter(
      (e) => e.type === "step_started" && "step" in e && e.step === stepId,
    ).length;
    if (attemptCount > step.max_retries) {
      return {
        action: "escalate",
        message: `リトライ上限（${step.max_retries}回）に達しました。オーケストレーターに判断を委ねます`,
      };
    }
  }

  // Find the latest work_done event
  let lastWorkDoneIndex = -1;
  for (let i = stepHistory.length - 1; i >= 0; i--) {
    if (stepHistory[i].type === "work_done") {
      lastWorkDoneIndex = i;
      break;
    }
  }

  // 1. No work_done at all -> block
  if (lastWorkDoneIndex === -1) {
    return {
      action: "block",
      message: `作業を完了してから以下を実行してください: hal history add --type work_done --step '${stepId}' --task <task-path> --message '作業内容'`,
    };
  }

  // 2. Check if there was a verification_failed AFTER the last work_done,
  //    with no new work_done after that verification_failed
  let hasVerificationFailedAfterWorkDone = false;
  for (let i = lastWorkDoneIndex + 1; i < stepHistory.length; i++) {
    if (stepHistory[i].type === "verification_failed") {
      hasVerificationFailedAfterWorkDone = true;
    }
    if (stepHistory[i].type === "work_done") {
      // A new work_done after verification_failed -> clears it
      hasVerificationFailedAfterWorkDone = false;
    }
  }

  if (hasVerificationFailedAfterWorkDone) {
    return {
      action: "block",
      message:
        `検証が失敗しています。修正を完了してから以下を実行してください: hal history add --type work_done --step '${stepId}' --task <task-path> --message '修正内容'`,
    };
  }

  // 3. work_done exists (and no unresolved verification_failed)
  // (step already retrieved above for max_retries check)

  // Check if accept is defined
  const hasAccept =
    step?.accept !== undefined &&
    (typeof step.accept === "string" ||
      (Array.isArray(step.accept) && step.accept.length > 0));

  if (!hasAccept) {
    // No accept -> allow + notify "step-X 完了（accept なし）"
    return {
      action: "allow",
      notification: `${stepId} 完了（accept なし）`,
    };
  }

  // accept is defined — check if ALL are type: human
  const acceptArr: AcceptObject[] = Array.isArray(step?.accept)
    ? (step?.accept as AcceptObject[])
    : [{ id: "default", check: step?.accept as string }];

  const allHuman = acceptArr.every((a) => a.type === "human");

  if (allHuman) {
    return {
      action: "allow",
      message: "人間検証が必要です",
      notification: `${stepId} 完了 — 人間検証が必要`,
    };
  }

  // Mixed or all-agent accept
  return {
    action: "allow",
    message: "検証完了まで待機してください",
    notification: `${stepId} 完了 — 検証が必要`,
  };
}

/**
 * Verifier stop-hook check logic.
 */
export function checkVerifier(
  task: TaskYaml,
  stepId: string,
): CheckResult {
  const history = task.history ?? [];
  const stepHistory = getStepHistory(history, stepId);

  // Find the latest work_done
  let lastWorkDoneIndex = -1;
  for (let i = stepHistory.length - 1; i >= 0; i--) {
    if (stepHistory[i].type === "work_done") {
      lastWorkDoneIndex = i;
      break;
    }
  }

  // Check for verification_passed or verification_failed after work_done
  let hasResult = false;
  let resultType = "";
  const searchFrom = lastWorkDoneIndex >= 0 ? lastWorkDoneIndex + 1 : 0;
  for (let i = searchFrom; i < stepHistory.length; i++) {
    const t = stepHistory[i].type;
    if (t === "verification_passed" || t === "verification_failed") {
      hasResult = true;
      resultType = t;
    }
  }

  if (!hasResult) {
    return {
      action: "block",
      message: `検証結果を記録してください。PASS: hal history add --type verification_passed --step '${stepId}' --task <task-path> --accept-id default --message '検証内容' / FAIL: hal history add --type verification_failed --step '${stepId}' --task <task-path> --accept-id default --message '失敗理由'`,
    };
  }

  // Verification result exists -> allow + notify
  const resultLabel =
    resultType === "verification_passed" ? "検証 PASS" : "検証 FAIL";
  return {
    action: "allow",
    notification: `${stepId} ${resultLabel}`,
  };
}

/**
 * Orchestrator stop-hook check logic.
 */
export function checkOrchestrator(
  task: TaskYaml,
  panes: { role: string }[],
): CheckResult {
  // 1. Check if any step has status: in_progress (recursively)
  function hasInProgressStep(steps: Step[]): boolean {
    for (const s of steps) {
      if (s.status === "in_progress") return true;
      if (s.steps && hasInProgressStep(s.steps)) return true;
    }
    return false;
  }

  if (hasInProgressStep(task.steps)) {
    return {
      action: "block",
      message: "進行中のステップがあります",
    };
  }

  // 2. Check if any worker/verifier panes exist
  const activePanes = panes.filter(
    (p) => p.role === "worker" || p.role === "verifier",
  );
  if (activePanes.length > 0) {
    return {
      action: "block",
      message: "実行中の agent がいます",
    };
  }

  // 3. Both clear -> allow
  return {
    action: "allow",
    message: "未記録の意思決定がないか確認してください",
  };
}

// ============================================================================
// Notification helper
// ============================================================================

/**
 * Send a notification message to the parent orchestrator pane.
 * Reads .panes.yaml to find the parent_pane_id for the current step,
 * then sends via tmux send-keys.
 *
 * Silently does nothing if .panes.yaml is missing or parent is not found.
 */
/**
 * Clean up the current pane: remove from .panes.yaml and kill the pane.
 * Called after a non-orchestrator agent finishes successfully.
 */
async function cleanupPane(taskPath: string, stepId: string, role: string): Promise<void> {
  try {
    const epicDir = dirname(taskPath);
    const pm = new PanesManager(epicDir);
    const panes = pm.load();
    const myPane = panes.find((p) => p.step === stepId && p.role === role);
    if (myPane) {
      pm.remove(myPane.pane_id);
      try { await tmuxKillPane(myPane.pane_id); } catch {}
    }
  } catch {
    // Best effort
  }
}

export async function notifyParent(
  basePath: string,
  stepId: string,
  message: string,
): Promise<void> {
  try {
    const pm = new PanesManager(basePath);
    const entries = pm.load();
    // Find a pane for this step
    const myPane = entries.find((e) => e.step === stepId);
    if (!myPane) return;

    const parentPaneId = myPane.parent_pane_id;
    if (!parentPaneId) return;

    await tmuxSendKeys(parentPaneId, message);
  } catch {
    // Graceful: if anything fails (no tmux, no .panes.yaml), just skip
  }
}

// ============================================================================
// CLI registration
// ============================================================================

export function registerCheckCommand(program: Command): void {
  program
    .command("check")
    .description(
      "Role-based completion gate check (worker/verifier/orchestrator/task-spec-reviewer)",
    )
    .option("--worker", "Worker stop-hook gate")
    .option("--verifier", "Verifier stop-hook gate")
    .option("--orchestrator", "Orchestrator stop-hook gate")
    .option("--task-spec-reviewer", "Task spec reviewer stop-hook gate")
    .option("--task <path>", "Path to task.yaml")
    .option("--step <step>", "Step path (e.g., step-1)")
    .action(async (opts) => {
      try {
        await handleCheck(opts);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`Error: ${msg}`);
        process.exit(1);
      }
    });
}

async function handleCheck(opts: {
  worker?: boolean;
  verifier?: boolean;
  orchestrator?: boolean;
  taskSpecReviewer?: boolean;
  task?: string;
  step?: string;
}): Promise<void> {
  const modeCount = [
    opts.worker,
    opts.verifier,
    opts.orchestrator,
    opts.taskSpecReviewer,
  ].filter(Boolean).length;
  if (modeCount === 0) {
    throw new Error(
      "One of --worker, --verifier, --orchestrator, or --task-spec-reviewer is required",
    );
  }
  if (modeCount > 1) {
    throw new Error(
      "Only one mode can be specified",
    );
  }

  if (opts.worker || opts.verifier) {
    if (!opts.task) {
      throw new Error("--task is required for --worker and --verifier modes");
    }
    if (!opts.step) {
      throw new Error("--step is required for --worker and --verifier modes");
    }

    const taskPath = resolve(opts.task);
    validateTaskPath(taskPath);
    const task = loadAndValidateTask(taskPath);

    // Verify step exists
    const step = findStep(task.steps, opts.step);
    if (!step) {
      throw new Error(`Step not found: "${opts.step}"`);
    }

    let result: CheckResult;
    if (opts.worker) {
      result = checkWorker(task, opts.step);
    } else {
      result = checkVerifier(task, opts.step);
    }

    // Handle notification
    if (result.notification) {
      const basePath = dirname(taskPath);
      await notifyParent(basePath, opts.step, result.notification);
    }

    // Output and exit
    if (result.action === "block" || result.action === "escalate") {
      console.log(JSON.stringify({
        decision: result.action,
        reason: result.message,
      }));
      process.exit(2); // exit 2 = blocking in Claude Code hooks
    } else {
      const role = opts.worker ? "worker" : "verifier";
      // Worker pane stays alive (may need to fix after verification failure)
      // Verifier pane is cleaned up after completion
      if (opts.verifier) {
        await cleanupPane(taskPath, opts.step, role);
      }
      const msg = result.notification ?? `${role} check passed`;
      console.log(JSON.stringify({ systemMessage: `[haltr] ${msg}` }));
      process.exit(0);
    }
  }

  if (opts.orchestrator) {
    if (!opts.task) {
      // No task assigned yet — nothing to check
      return;
    }
    const taskPath = resolve(opts.task);
    validateTaskPath(taskPath);
    const task = loadAndValidateTask(taskPath);

    // Load panes
    const basePath = dirname(taskPath);
    const pm = new PanesManager(basePath);
    const panes = pm.load();

    const result = checkOrchestrator(task, panes);

    if (result.action === "block") {
      console.log(JSON.stringify({ decision: "block", reason: result.message }));
      process.exit(2); // exit 2 = blocking in Claude Code hooks
    } else {
      console.log(JSON.stringify({ systemMessage: `[haltr] orchestrator check passed` }));
      process.exit(0);
    }
  }

  if (opts.taskSpecReviewer) {
    if (!opts.task) {
      throw new Error("--task is required for --task-spec-reviewer mode");
    }
    const taskPath = resolve(opts.task);
    validateTaskPath(taskPath);
    const task = loadAndValidateTask(taskPath);

    // Check that reviewer recorded spec_reviewed with message
    const reviewed = task.history?.find((e) => e.type === "spec_reviewed");
    if (!reviewed) {
      console.log(JSON.stringify({
        decision: "block",
        reason: `レビュー結果を記録してください: hal history add --type spec_reviewed --task '${taskPath}' --message 'レビュー内容'`,
      }));
      process.exit(2);
    }

    // Notify parent orchestrator and clean up pane
    const epicDir = dirname(taskPath);
    const pm = new PanesManager(epicDir);
    const panes = pm.load();
    const reviewerPane = panes.find((p) => p.role === "task-spec-reviewer");
    const parentPaneId = reviewerPane?.parent_pane_id;
    if (parentPaneId) {
      try {
        await tmuxSendKeys(parentPaneId, `spec_reviewed: タスク仕様のレビューが完了しました。task.yaml の history を確認してください。`);
      } catch {
        // Best effort
      }
    }

    // Clean up reviewer pane
    if (reviewerPane) {
      pm.remove(reviewerPane.pane_id);
      try { await tmuxKillPane(reviewerPane.pane_id); } catch {}
    }

    console.log(JSON.stringify({ systemMessage: "[haltr] spec review completed" }));
    process.exit(0);
  }
}
