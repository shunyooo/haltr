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
  コーディングエージェントが長時間の作業を品質を保って完遂するためのツール。
  task.yaml にゴール・ステップ・履歴を永続化し、品質ゲートと Stop hook で
  「忘却」「手抜き」「早期離脱」を防止する。

When to use:
  複数ステップにわたる作業（実装 + テスト + ドキュメント等）で使用する。
  単発の質問や小さな修正には不要。
  ユーザーとの対話で「これは長くなるな」と判断した時点で hal task create する。

How task.yaml works:
  task.yaml はタスクの状態管理ファイル。以下を永続化する:
  - goal: タスクのゴール（何を達成するか）
  - steps: ステップの一覧と状態（pending → in_progress → done/failed）
  - history: 全イベントの履歴（created, step_started, step_done, paused 等）
  コンテキストが長くなっても hal status で現在の状態を正確に把握できる。

Accept criteria & verification:
  accept はステップの完了条件。設定すると手抜きを防止する品質ゲートが有効になる:
  1. hal step add --step impl --goal '実装' --accept 'テストが通る'
  2. 作業を実施
  3. Agent ツールでサブエージェントを spawn し、accept 条件の独立検証を依頼
  4. サブエージェントが hal step verify --step impl --result PASS|FAIL を実行
  5. verify PASS 後に hal step done --step impl --result PASS で完了
  accept なしのステップは verify 不要で直接 done できる。

Stop hook:
  hal step start 以降、タスクが完了するまでエージェントの停止をブロックする。
  ユーザーとの対話が必要な場合は hal step pause で一時解除できる。

Workflow:
  1. hal setup                                          初回のみ。hooks を登録
  2. hal task create --file <name> --goal '<goal>'       タスク作成
  3. hal step add --step <id> --goal '<goal>'            ステップ分解
  4. hal step start --step <id>                          作業開始（Stop hook 有効化）
  5. 作業 → 検証 → hal step done --step <id> --result PASS|FAIL
  6. 全ステップ完了 → タスク自動完了 → Stop hook 解除

Step lifecycle:
  hal step start   ステップを in_progress にする。Stop hook が有効化される
  hal step verify  accept 条件がある場合、サブエージェントで検証結果を記録
  hal step done    ステップを完了（PASS）または失敗記録（FAIL）
  hal step pause   対話モードへ切替（Stop hook を一時解除）
  hal step resume  自律モードに復帰（Stop hook を再有効化）

Task file resolution (--file 省略時):
  1. セッションマッピング（task create / step start 時に自動登録）
  2. カレントディレクトリの task.yaml or *.task.yaml を検出`);

// ---- setup ----

program
	.command("setup")
	.description("Register haltr hooks in ~/.claude/settings.json")
	.addHelpText("after", `
  SessionStart hook と Stop hook を登録する。初回のみ実行。
  既存の hooks がある場合はマージされる。`)
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
  指定パスにタスクファイルを作成する。セッションマッピングも自動登録。
  Example: hal task create --file feature-auth.yaml --goal 'OAuth2 認証を実装する'`)
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
  タスクのゴール・受入条件を更新する。変更は history に記録される。
  Example: hal task edit --goal 'OAuth2 に変更' --message 'セキュリティ要件の変更'`)
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
  単発: hal step add --step impl --goal '認証モジュール実装' --accept 'テストが通る'
  バッチ: echo '<yaml>' | hal step add --stdin`)
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
	.description("Start working on a step (activates Stop hook)")
	.requiredOption("--step <step>", "Step ID")
	.option("--file <file>", "Task file path")
	.addHelpText("after", `
  ステップを in_progress にする。セッションマッピングも更新される。
  別セッションからの引き継ぎ: hal step start --file task.yaml --step impl`)
	.action(withErrorHandler((opts: { step: string; file?: string }) => handleStepStart(opts)));

stepCmd
	.command("done")
	.description("Mark a step as done (PASS/FAIL)")
	.requiredOption("--step <step>", "Step ID")
	.requiredOption("--result <result>", "Result: PASS or FAIL")
	.requiredOption("--message <message>", "Result message")
	.option("--file <file>", "Task file path")
	.addHelpText("after", `
  PASS: ステップを done にする（accept ありなら verify 済みが必要）
  FAIL: 失敗を記録（ステップは in_progress のまま、修正して再度 done 可能）`)
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
  Stop hook を一時解除し、ユーザーとの対話に切り替える。
  hal step resume で自律モードに復帰。`)
	.action(
		withErrorHandler((opts: { message: string; file?: string }) => handleStepPause(opts)),
	);

stepCmd
	.command("resume")
	.description("Resume task work from dialogue mode")
	.option("--file <file>", "Task file path")
	.addHelpText("after", `
  pause 状態を解除し、作業を再開する。Stop hook が再び有効化される。`)
	.action(withErrorHandler((opts: { file?: string }) => handleStepResume(opts)));

stepCmd
	.command("verify")
	.description("Record verification result for a step (called by sub-agent)")
	.requiredOption("--step <step>", "Step ID")
	.requiredOption("--result <result>", "Result: PASS or FAIL")
	.requiredOption("--message <message>", "Verification message")
	.option("--file <file>", "Task file path")
	.addHelpText("after", `
  サブエージェント（Agent ツール）から呼ばれる。accept 条件の独立検証を行い結果を記録。
  PASS なら step done (PASS) が可能になる。`)
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
  タスクのゴール、ステップ進捗、次のアクション候補を YAML 形式で出力。`)
	.action(withErrorHandler((opts: { file?: string }) => handleStatus(opts)));

// ---- check ----

program
	.command("check")
	.description("Stop hook gate check (reads session_id from stdin)")
	.addHelpText("after", `
  Stop hook から自動実行される。手動で呼ぶ必要はない。
  未完了ステップがあれば exit 2（ブロック）、それ以外は exit 0（通過）。`)
	.action(withErrorHandler(() => handleCheck()));

// ---- session-start ----

program
	.command("session-start")
	.description("SessionStart hook handler (reads session_id from stdin)")
	.addHelpText("after", `
  SessionStart hook から自動実行される。手動で呼ぶ必要はない。
  セッション ID を環境変数 HALTR_SESSION_ID にセットする。`)
	.action(() => handleSessionStart());

program.parse();
