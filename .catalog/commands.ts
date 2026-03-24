/**
 * Command metadata extracted from hal.ts
 */

export interface CommandOption {
	name: string;
	required: boolean;
	description: string;
	choices?: string[];
}

export interface CommandMeta {
	name: string;
	description: string;
	/** Detailed explanation of the command */
	detail?: string;
	options: CommandOption[];
}

export const commands: Record<string, CommandMeta> = {
	setup: {
		name: "setup",
		description: "Register haltr hooks in ~/.claude/settings.json",
		detail: "SessionStart hook と Stop hook を ~/.claude/settings.json に登録。初回のみ実行。",
		options: [],
	},
	"task create": {
		name: "task create",
		description: "Create a new task file",
		detail: "指定パスに task.yaml を作成。セッションマッピングも自動登録される。",
		options: [
			{ name: "--file", required: true, description: "Task file path (required)" },
			{ name: "--goal", required: true, description: "Task goal" },
			{ name: "--accept", required: false, description: "Accept criteria (repeatable)" },
			{ name: "--plan", required: false, description: "Task plan" },
		],
	},
	"task edit": {
		name: "task edit",
		description: "Edit the current task",
		detail: "タスクのゴール、受入条件を更新。変更は history に updated イベントとして記録。",
		options: [
			{ name: "--file", required: false, description: "Task file path" },
			{ name: "--goal", required: false, description: "New goal" },
			{ name: "--accept", required: false, description: "New accept criteria (repeatable)" },
			{ name: "--plan", required: false, description: "New plan" },
			{ name: "--message", required: true, description: "Change reason" },
		],
	},
	"step add": {
		name: "step add",
		description: "Add a new step to the task",
		detail: "タスクにステップを追加。単発モード（--step --goal）またはバッチモード（--stdin）で追加可能。",
		options: [
			{ name: "--file", required: false, description: "Task file path" },
			{ name: "--step", required: false, description: "Step ID (single mode)" },
			{ name: "--goal", required: false, description: "Step goal (single mode)" },
			{ name: "--accept", required: false, description: "Accept criteria (repeatable)" },
			{ name: "--after", required: false, description: "Insert after this step ID" },
			{ name: "--stdin", required: false, description: "Read steps from stdin as YAML array (batch mode)" },
		],
	},
	"step start": {
		name: "step start",
		description: "Start working on a step",
		detail: "ステップを in_progress に遷移。セッションマッピングも更新（別セッション引き継ぎ対応）。",
		options: [
			{ name: "--step", required: true, description: "Step ID" },
			{ name: "--file", required: false, description: "Task file path" },
		],
	},
	"step done": {
		name: "step done",
		description: "Mark a step as done (PASS/FAIL)",
		detail: "ステップを完了マーク。PASS なら done、FAIL なら in_progress のまま。accept 条件があれば verify 済みが必要。",
		options: [
			{ name: "--step", required: true, description: "Step ID" },
			{ name: "--result", required: true, description: "Result: PASS or FAIL", choices: ["PASS", "FAIL"] },
			{ name: "--message", required: true, description: "Result message" },
			{ name: "--file", required: false, description: "Task file path" },
		],
	},
	"step pause": {
		name: "step pause",
		description: "Pause task work and switch to dialogue mode",
		detail: "作業を一時停止して対話モードに切り替え。Stop hook がブロックしなくなる。",
		options: [
			{ name: "--message", required: true, description: "Reason for pausing" },
			{ name: "--file", required: false, description: "Task file path" },
		],
	},
	"step resume": {
		name: "step resume",
		description: "Resume task work from dialogue mode",
		detail: "一時停止を解除して作業を再開。Stop hook が再びブロックするようになる。",
		options: [
			{ name: "--file", required: false, description: "Task file path" },
		],
	},
	"step verify": {
		name: "step verify",
		description: "Record verification result for a step",
		detail: "検証エージェントが呼び出す。ステップの作業結果を検証し、結果を記録。step done (PASS) の前提条件。",
		options: [
			{ name: "--step", required: true, description: "Step ID" },
			{ name: "--result", required: true, description: "Result: PASS or FAIL", choices: ["PASS", "FAIL"] },
			{ name: "--message", required: true, description: "Verification message" },
			{ name: "--file", required: false, description: "Task file path" },
		],
	},
	status: {
		name: "status",
		description: "Show current task status",
		detail: "現在のタスク状態を YAML 形式で出力。ゴール、ステップ進捗、次のアクション候補を表示。",
		options: [
			{ name: "--file", required: false, description: "Task file path" },
		],
	},
	check: {
		name: "check",
		description: "Stop hook gate check (reads session_id from stdin)",
		detail: "Stop hook から呼ばれる。タスクが完了/一時停止なら allow、未完了ステップありなら block。",
		options: [],
	},
	"session-start": {
		name: "session-start",
		description: "SessionStart hook handler (reads session_id from stdin)",
		detail: "SessionStart hook から呼ばれる。セッション ID を環境変数に設定。",
		options: [],
	},
};
