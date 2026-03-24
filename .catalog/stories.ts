/**
 * Story definitions for catalog (v3)
 */

export type StoryCategory =
	| "setup"
	| "task"
	| "step"
	| "status"
	| "check"
	| "hook"
	| "help";

export type StoryTag =
	| "success"
	| "error"
	| "edge-case"
	| "validation"
	| "workflow";

export interface Story {
	/** Unique story ID */
	id: string;
	/** Command name (key in commands.ts) */
	command: string;
	/** Story title */
	title: string;
	/** Detailed description */
	description?: string;
	/** Category for grouping */
	category: StoryCategory;
	/** Tags for filtering */
	tags: StoryTag[];
	/** Full command line input */
	input: string;
	/** Environment variables to set */
	env?: Record<string, string>;
	/** Setup function */
	setup?: "none" | "with-task" | "with-steps" | "with-steps-active" | "with-steps-active-no-accept" | "with-steps-active-unverified";
	/** Expected exit code (default: 0) */
	expected_exit?: number;
}

export const stories: Story[] = [
	// ============================================================================
	// Help
	// ============================================================================
	{
		id: "help-root",
		command: "setup",
		title: "ヘルプ表示",
		description: "hal のヘルプを表示する",
		category: "help",
		tags: ["success"],
		input: "hal --help",
	},
	{
		id: "help-task",
		command: "task create",
		title: "task サブコマンドのヘルプ",
		description: "hal task のヘルプを表示する",
		category: "help",
		tags: ["success"],
		input: "hal task --help",
	},
	{
		id: "help-step",
		command: "step add",
		title: "step サブコマンドのヘルプ",
		description: "hal step のヘルプを表示する",
		category: "help",
		tags: ["success"],
		input: "hal step --help",
	},

	// ============================================================================
	// Task
	// ============================================================================
	{
		id: "task-create-basic",
		command: "task create",
		title: "基本的なタスク作成",
		description: "ゴールのみでタスクを作成する",
		category: "task",
		tags: ["success"],
		input: "hal task create --file task.yaml --goal 'ユーザー認証機能を実装する'",
		env: { HALTR_SESSION_ID: "test-session-001" },
	},
	{
		id: "task-create-with-accept",
		command: "task create",
		title: "受入条件付きタスク作成",
		description: "ゴールと受入条件でタスクを作成する",
		category: "task",
		tags: ["success"],
		input: "hal task create --file login.task.yaml --goal 'ログイン機能を実装' --accept 'メールとパスワードでログインできる' --accept 'エラー時にメッセージが表示される'",
		env: { HALTR_SESSION_ID: "test-session-002" },
	},
	{
		id: "task-create-no-goal",
		command: "task create",
		title: "ゴールなしでタスク作成（エラー）",
		description: "必須オプション--goalがない場合のエラー",
		category: "task",
		tags: ["error", "validation"],
		input: "hal task create --file task.yaml",
	},
	{
		id: "task-edit-goal",
		command: "task edit",
		title: "タスクのゴール更新",
		description: "タスクのゴールを変更する",
		category: "task",
		tags: ["success"],
		input: "hal task edit --file task.yaml --goal 'OAuth2を使用してユーザー認証を実装する' --message 'OAuth2採用に伴いゴール更新'",
		setup: "with-task",
		env: { HALTR_SESSION_ID: "test-session-001" },
	},

	// ============================================================================
	// Step
	// ============================================================================
	{
		id: "step-add-basic",
		command: "step add",
		title: "ステップ追加",
		description: "タスクにステップを追加する",
		category: "step",
		tags: ["success"],
		input: "hal step add --file task.yaml --step s1 --goal 'データベーススキーマを設計する'",
		setup: "with-task",
		env: { HALTR_SESSION_ID: "test-session-001" },
	},
	{
		id: "step-add-with-accept",
		command: "step add",
		title: "受入条件付きステップ追加",
		description: "受入条件を指定してステップを追加する",
		category: "step",
		tags: ["success"],
		input: "hal step add --file task.yaml --step s2 --goal 'APIエンドポイントを実装' --accept 'POST /login が動作する' --accept '認証トークンを返す'",
		setup: "with-task",
		env: { HALTR_SESSION_ID: "test-session-001" },
	},
	{
		id: "step-add-batch",
		command: "step add",
		title: "複数ステップをバッチ追加",
		description: "stdin から YAML で複数ステップを一括追加する",
		category: "step",
		tags: ["success", "workflow"],
		input: `echo '- id: s1
  goal: データベース設計
  accept: ERD が作成されている
- id: s2
  goal: API実装
  accept:
    - POST /login が動作する
    - 認証トークンを返す
- id: s3
  goal: テスト作成' | hal step add --file task.yaml --stdin`,
		setup: "with-task",
		env: { HALTR_SESSION_ID: "test-session-001" },
	},
	{
		id: "step-start",
		command: "step start",
		title: "ステップ開始",
		description: "ステップの作業を開始する",
		category: "step",
		tags: ["success"],
		input: "hal step start --file task.yaml --step s1",
		setup: "with-steps",
		env: { HALTR_SESSION_ID: "test-session-001" },
	},
	{
		id: "step-done-pass-verified",
		command: "step done",
		title: "ステップ完了（accept あり・検証済み）",
		description: "accept 条件があり、検証済みのステップを成功で完了する",
		category: "step",
		tags: ["success"],
		input: "hal step done --file task.yaml --step s1 --result PASS --message 'スキーマ設計完了、migrations/001_users.sqlを作成'",
		setup: "with-steps-active",
		env: { HALTR_SESSION_ID: "test-session-001" },
	},
	{
		id: "step-done-pass-no-accept",
		command: "step done",
		title: "ステップ完了（accept なし・検証不要）",
		description: "accept 条件がないステップは検証なしで完了できる",
		category: "step",
		tags: ["success", "workflow"],
		input: "hal step done --file task.yaml --step s1 --result PASS --message '作業完了'",
		setup: "with-steps-active-no-accept",
		env: { HALTR_SESSION_ID: "test-session-001" },
	},
	{
		id: "step-done-pass-unverified",
		command: "step done",
		title: "ステップ完了エラー（accept あり・未検証）",
		description: "accept 条件があるが未検証のステップは完了できない",
		category: "step",
		tags: ["error", "validation"],
		input: "hal step done --file task.yaml --step s1 --result PASS --message '作業完了'",
		setup: "with-steps-active-unverified",
		env: { HALTR_SESSION_ID: "test-session-001" },
	},
	{
		id: "step-done-fail",
		command: "step done",
		title: "ステップ完了（FAIL）",
		description: "ステップを失敗で完了する（検証不要）",
		category: "step",
		tags: ["success", "workflow"],
		input: "hal step done --file task.yaml --step s1 --result FAIL --message '外部APIの仕様が不明、確認が必要'",
		setup: "with-steps-active-no-accept",
		env: { HALTR_SESSION_ID: "test-session-001" },
	},
	{
		id: "step-verify-pass",
		command: "step verify",
		title: "ステップ検証（PASS）",
		description: "ステップの作業結果を検証し、受入条件を満たしていることを記録する",
		category: "step",
		tags: ["success", "workflow"],
		input: "hal step verify --file task.yaml --step s1 --result PASS --message '全テストが通過、accept条件を満たしている'",
		setup: "with-steps-active-unverified",
		env: { HALTR_SESSION_ID: "test-session-001" },
	},
	{
		id: "step-verify-fail",
		command: "step verify",
		title: "ステップ検証（FAIL）",
		description: "ステップの作業結果を検証し、受入条件を満たしていないことを記録する",
		category: "step",
		tags: ["success", "workflow"],
		input: "hal step verify --file task.yaml --step s1 --result FAIL --message 'テストが2件失敗している'",
		setup: "with-steps-active-unverified",
		env: { HALTR_SESSION_ID: "test-session-001" },
	},
	{
		id: "step-pause",
		command: "step pause",
		title: "作業一時停止",
		description: "ユーザーとの対話のため作業を一時停止する",
		category: "step",
		tags: ["success", "workflow"],
		input: "hal step pause --file task.yaml --message '認証方式について確認が必要'",
		setup: "with-steps",
		env: { HALTR_SESSION_ID: "test-session-001" },
	},
	{
		id: "step-resume",
		command: "step resume",
		title: "作業再開",
		description: "一時停止した作業を再開する",
		category: "step",
		tags: ["success", "workflow"],
		input: "hal step resume --file task.yaml",
		setup: "with-steps",
		env: { HALTR_SESSION_ID: "test-session-001" },
	},

	// ============================================================================
	// Status
	// ============================================================================
	{
		id: "status-no-task",
		command: "status",
		title: "ステータス表示（タスクなし）",
		description: "タスクがない場合のエラー表示",
		category: "status",
		tags: ["error", "edge-case"],
		input: "hal status",
		setup: "none",
	},
	{
		id: "status-with-task",
		command: "status",
		title: "ステータス表示（タスクあり）",
		description: "タスクがある場合のステータス表示",
		category: "status",
		tags: ["success"],
		input: "hal status --file task.yaml",
		setup: "with-steps",
		env: { HALTR_SESSION_ID: "test-session-001" },
	},

	// ============================================================================
	// Check (Hook)
	// ============================================================================
	{
		id: "check-allow-done",
		command: "check",
		title: "チェック通過（タスク完了）",
		description: "タスクが完了している場合、停止を許可する",
		category: "check",
		tags: ["success", "workflow"],
		input: "echo '{\"session_id\":\"test-session-001\"}' | hal check",
		setup: "with-task",
		env: { HALTR_SESSION_ID: "test-session-001" },
	},
	{
		id: "check-block-incomplete",
		command: "check",
		title: "チェックブロック（未完了ステップあり）",
		description: "未完了のステップがある場合、停止をブロックする",
		category: "check",
		tags: ["workflow"],
		input: "echo '{\"session_id\":\"test-session-001\"}' | hal check",
		setup: "with-steps",
		env: { HALTR_SESSION_ID: "test-session-001" },
		expected_exit: 2,
	},

	// ============================================================================
	// Hook
	// ============================================================================
	{
		id: "session-start-new",
		command: "session-start",
		title: "セッション開始（タスクなし）",
		description: "新しいセッションを開始する（タスクがまだない状態）",
		category: "hook",
		tags: ["success", "workflow"],
		input: "echo '{\"session_id\":\"new-session-001\"}' | hal session-start",
		setup: "none",
	},
	{
		id: "session-start-with-task",
		command: "session-start",
		title: "セッション開始（タスクあり）",
		description: "既存タスクがあるセッションを開始する",
		category: "hook",
		tags: ["success", "workflow"],
		input: "echo '{\"session_id\":\"test-session-001\"}' | hal session-start",
		setup: "with-steps",
		env: { HALTR_SESSION_ID: "test-session-001" },
	},
];
