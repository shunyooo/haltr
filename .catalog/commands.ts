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
	init: {
		name: "init",
		description: "Initialize haltr directory structure",
		detail: "プロジェクトルートに `.haltr.json` と作業ディレクトリを作成。Claude Code hooks (`SessionStart`, `Stop`) も自動設定される。",
		options: [
			{ name: "--dir", required: false, description: "Directory name (default: work, interactive if not specified)" },
		],
	},
	"epic create": {
		name: "epic create",
		description: "Create a new epic",
		detail: "エピック（タスクのコンテナ）を作成。命名規則: `YYYYMMDD-NNN_name`。epics/ ディレクトリ配下に作成される。",
		options: [
			{ name: "<name>", required: true, description: "Epic name" },
		],
	},
	"epic list": {
		name: "epic list",
		description: "List all epics with status",
		detail: "全エピックを一覧表示。各エピックのステータス（active/archived）も表示。",
		options: [],
	},
	"epic current": {
		name: "epic current",
		description: "Show the most recent epic",
		detail: "最新のアクティブなエピックを表示。現在のタスクパスも含む。",
		options: [],
	},
	"epic archive": {
		name: "epic archive",
		description: "Archive an epic",
		detail: "エピックをアーカイブ。完了したエピックを整理するために使用。",
		options: [
			{ name: "<name>", required: true, description: "Epic name" },
		],
	},
	"task create": {
		name: "task create",
		description: "Create a new task in the current epic",
		detail: "現在のエピックに新しいタスクを作成。task.yaml が生成され、セッションにマッピングされる。history に `created` イベントが記録される。ノートは notes.md に直接記録。",
		options: [
			{ name: "--goal", required: true, description: "Task goal" },
			{ name: "--accept", required: false, description: "Accept criteria (repeatable)" },
			{ name: "--plan", required: false, description: "Task plan" },
		],
	},
	"task edit": {
		name: "task edit",
		description: "Edit the current task",
		detail: "タスクのゴール、受入条件を更新。変更は history に `updated` イベントとして記録される。ノートは notes.md に直接記録。",
		options: [
			{ name: "--goal", required: false, description: "New goal" },
			{ name: "--accept", required: false, description: "New accept criteria (repeatable)" },
			{ name: "--plan", required: false, description: "New plan" },
			{ name: "--message", required: true, description: "Change reason" },
		],
	},
	"step add": {
		name: "step add",
		description: "Add a new step to the current task",
		detail: "タスクに新しいステップを追加。単発モード（--step --goal）またはバッチモード（--stdin）で複数追加可能。ステップは pending 状態で作成。",
		options: [
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
		detail: "ステップを pending → in_progress に遷移。history に `step_started` イベントが記録される。",
		options: [
			{ name: "--step", required: true, description: "Step ID" },
		],
	},
	"step done": {
		name: "step done",
		description: "Mark a step as done (PASS/FAIL)",
		detail: "ステップを完了としてマーク。PASS なら done、FAIL なら failed 状態に。全ステップ完了でタスクも done になる。verify 済みでないと実行不可。",
		options: [
			{ name: "--step", required: true, description: "Step ID" },
			{ name: "--result", required: true, description: "Result: PASS or FAIL", choices: ["PASS", "FAIL"] },
			{ name: "--message", required: true, description: "Result message" },
		],
	},
	"step pause": {
		name: "step pause",
		description: "Pause task work and switch to dialogue mode",
		detail: "作業を一時停止してユーザーとの対話モードに切り替え。check ゲートがパスするようになる。",
		options: [
			{ name: "--message", required: true, description: "Reason for pausing" },
		],
	},
	"step resume": {
		name: "step resume",
		description: "Resume task work from dialogue mode",
		detail: "一時停止状態を解除して作業を再開。paused フラグがクリアされる。",
		options: [],
	},
	"step verify": {
		name: "step verify",
		description: "Record verification result for a step (called by verify agent)",
		detail: "検証エージェントが呼び出す。ステップの作業結果を第三者視点で検証し、結果を記録。step done の前提条件。",
		options: [
			{ name: "--step", required: true, description: "Step ID" },
			{ name: "--result", required: true, description: "Result: PASS or FAIL", choices: ["PASS", "FAIL"] },
			{ name: "--message", required: true, description: "Verification message" },
		],
	},
	status: {
		name: "status",
		description: "Show current task status",
		detail: "現在のタスク状態を YAML 形式で出力。ゴール、ステップ進捗、次のアクション候補を表示。",
		options: [],
	},
	check: {
		name: "check",
		description: "Stop hook gate check (reads session_id from stdin)",
		detail: "Claude Code の Stop hook から呼ばれる。タスクが完了/一時停止していれば allow、未完了ステップがあれば block を返す。",
		options: [],
	},
	"session-start": {
		name: "session-start",
		description: "SessionStart hook handler (reads session_id from stdin)",
		detail: "Claude Code の SessionStart hook から呼ばれる。セッション ID を環境変数に設定し、タスク状態を表示。",
		options: [],
	},
	"context list": {
		name: "context list",
		description: "List all context entries",
		detail: "全コンテキストエントリ（スキル・ナレッジ）を一覧表示。ID、タイプ、説明を含む。",
		options: [],
	},
	"context show": {
		name: "context show",
		description: "Show content of a context entry",
		detail: "コンテキストエントリの内容を表示。使用履歴が history に記録される。stale 検出も行う。",
		options: [
			{ name: "--id", required: true, description: "Context entry ID" },
		],
	},
	"context create": {
		name: "context create",
		description: "Create a new context entry",
		detail: "新しいスキルまたはナレッジエントリを作成。ディレクトリと雛形ファイルが生成され、index.yaml に追加される。",
		options: [
			{ name: "--type", required: true, description: "Entry type: skill or knowledge", choices: ["skill", "knowledge"] },
			{ name: "--id", required: true, description: "Entry ID" },
			{ name: "--description", required: true, description: "Entry description" },
		],
	},
	"context delete": {
		name: "context delete",
		description: "Delete a context entry",
		detail: "コンテキストエントリを削除。ディレクトリごと削除され、index.yaml から除去される。削除理由は history に記録。",
		options: [
			{ name: "--id", required: true, description: "Context entry ID" },
			{ name: "--reason", required: true, description: "Deletion reason" },
		],
	},
	"context log": {
		name: "context log",
		description: "Record a history event for a context entry",
		detail: "コンテキストエントリの履歴イベントを記録。updated（更新）、confirmed（確認）、deprecated（非推奨）、promoted（昇格）から選択。",
		options: [
			{ name: "--id", required: true, description: "Context entry ID" },
			{ name: "--type", required: true, description: "Event type", choices: ["updated", "confirmed", "deprecated", "promoted"] },
			{ name: "--message", required: false, description: "Event message" },
		],
	},
};
