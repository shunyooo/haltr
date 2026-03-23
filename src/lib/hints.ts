/**
 * Centralized command hints for agent guidance.
 * All hints are defined here for easy maintenance.
 */

export const HINTS = {
	// Task hints
	TASK_CREATED: "hal step add --step <step-id> --goal '<goal>' でステップを追加してください",
	TASK_UPDATED: "hal status でタスクの状態を確認できます",

	// Step hints
	STEP_ADDED: "hal step start --step <step-id> でステップを開始できます",
	STEP_STARTED:
		"作業完了後、Agent ツールでサブエージェントを spawn し、accept 条件の独立検証を依頼してください。検証者が hal step verify --message '<検証結果>' を実行後、hal step done --message '<完了内容>' で完了報告できます。ユーザーとの対話に切り替える場合は hal step pause --message '<理由>'",
	STEP_IN_PROGRESS: (stepId: string) =>
		`現在のステップ: ${stepId}。作業完了後、サブエージェントで検証を実行してください。ユーザーとの対話に切り替える場合は hal step pause --message '<理由>'`,
	STEP_VERIFY_REQUIRED: (stepId: string) =>
		`ステップ ${stepId} は未検証です。サブエージェントで hal step verify --step ${stepId} --result PASS|FAIL --message '<検証結果>' を実行してください`,
	STEP_DONE_NEXT: (nextStepId: string) => `次のステップ: hal step start --step ${nextStepId}`,
	STEP_DONE_ALL:
		"全ステップが完了しました。CCR (Context Carry-over Report) を作成して、次のタスクに引き継ぐ情報をまとめてください",
	STEP_DONE_FAIL:
		"失敗した内容を修正して、再度 hal step done --step <step-id> --result PASS --message '<完了内容>' で報告してください",
	STEP_DONE_CHECK_STATUS: "hal status で残りのステップを確認してください",
	STEP_PAUSED: "対話モードです。hal step resume でタスク作業を再開できます",
	STEP_RESUMED:
		"タスク作業を再開しました。hal status で現在の状態を確認できます",

	// Status hints
	STATUS_DONE: "タスクは完了しています。CCR を作成してください",
	STATUS_NO_STEPS: "hal step add --step <step-id> --goal '<goal>' でステップを追加してください",
	STATUS_PENDING: "hal step start --step <step-id> でステップを開始してください",
	STATUS_ADD_OR_CHECK: "hal step add で新しいステップを追加するか、残りの作業を確認してください",
	STATUS_NOTES:
		"重要な情報があれば notes.md に記録してください",
	STATUS_NOTES_IN_PROGRESS:
		"作業中に重要な発見や決定事項があれば notes.md に記録してください",
	STATUS_NOTES_DONE:
		"作業結果や重要な発見を notes.md に記録してください",

	// Context hints
	CONTEXT_LIST:
		"hal context show --id <id> で内容を表示、hal context create --type <skill|knowledge> --id <id> --description '<desc>' で新規作成",
	CONTEXT_CREATED: (id: string) =>
		`ファイルに内容を直接書き込んでください。書き込み後 hal context log --id ${id} --type updated --message '<変更内容>' で変更履歴を記録してください`,
	CONTEXT_SHOWN: "hal context log --id <id> --type confirmed で最新であることを確認できます",

	// Check hints
	CHECK_BLOCKED:
		"未完了のステップがあります。タスク作業を続行してください。ユーザーから対話のリクエストがあった場合、またはユーザーに必ず確認を取る必要があると考えられる場合は hal step pause --message '<理由>' で一時停止してください",

	// No task / dialogue mode hints
	NO_TASK:
		"対話モードです。複数ステップの作業が必要な場合は hal task create でタスクを作成してください",
} as const;
