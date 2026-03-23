import { buildResponse, formatResponse } from "../lib/response-builder.js";
import {
	addHistoryEvent,
	checkStaleness,
	createEntry,
	deleteEntry,
	findEntry,
	getContent,
	loadIndex,
} from "../lib/context-manager.js";
import { findHaltrDir } from "../lib/task-utils.js";

/**
 * hal context list
 *
 * List all context entries (skills and knowledge).
 */
export function handleContextList(): void {
	const haltrDir = findHaltrDir(process.cwd());
	const entries = loadIndex(haltrDir);

	const items = entries.map((e) => ({
		type: e.type,
		id: e.id,
		description: e.description,
	}));

	const response = buildResponse({
		status: "ok",
		message:
			entries.length === 0
				? "コンテキストエントリはありません"
				: `${entries.length} 件のコンテキストエントリ`,
		data: {
			entries: items,
		},
		haltrDir,
		commands_hint:
			"hal context show --id <id> で内容を表示、hal context create --type <skill|knowledge> --id <id> --description '<desc>' で新規作成",
	});

	console.log(formatResponse(response));
}

/**
 * hal context show --id <id>
 *
 * Show the content of a context entry. Records a 'used' event.
 */
export function handleContextShow(opts: { id: string }): void {
	const haltrDir = findHaltrDir(process.cwd());
	const entries = loadIndex(haltrDir);
	const entry = findEntry(entries, opts.id);

	if (!entry) {
		throw new Error(`コンテキストエントリ "${opts.id}" が見つかりません`);
	}

	// Get content
	const content = getContent(haltrDir, entry);

	// Record 'used' event
	addHistoryEvent(haltrDir, opts.id, {
		type: "used",
	});

	// Check staleness
	const staleness = checkStaleness(haltrDir, opts.id);

	const data: Record<string, unknown> = {
		id: entry.id,
		type: entry.type,
		description: entry.description,
		path: entry.path,
		content,
	};

	if (staleness.stale) {
		data.staleness_warning = staleness.daysSince
			? `最終活動から ${staleness.daysSince} 日経過しています。内容が最新か確認してください`
			: "活動履歴がありません。内容が最新か確認してください";
	}

	const response = buildResponse({
		status: "ok",
		message: `コンテキスト: ${entry.id}`,
		data,
		haltrDir,
		commands_hint:
			"hal context log --id <id> --type confirmed で最新であることを確認できます",
	});

	console.log(formatResponse(response));
}

/**
 * hal context create --type <skill|knowledge> --id <id> --description <desc>
 *
 * Create a new context entry with an empty file.
 */
export function handleContextCreate(opts: {
	type: string;
	id: string;
	description: string;
}): void {
	if (opts.type !== "skill" && opts.type !== "knowledge") {
		throw new Error(
			`無効なタイプ: "${opts.type}"。skill または knowledge を指定してください`,
		);
	}

	const haltrDir = findHaltrDir(process.cwd());
	const relativePath = createEntry(
		haltrDir,
		opts.type as "skill" | "knowledge",
		opts.id,
		opts.description,
	);

	const response = buildResponse({
		status: "ok",
		message: `コンテキストエントリを作成しました: ${opts.id}`,
		data: {
			id: opts.id,
			type: opts.type,
			description: opts.description,
			path: relativePath,
		},
		haltrDir,
		commands_hint:
			"ファイルに内容を直接書き込んでください。書き込み後 hal context log --id " +
			opts.id +
			" --type updated --message '<変更内容>' で記録してください",
	});

	console.log(formatResponse(response));
}

/**
 * hal context delete --id <id> --reason <reason>
 *
 * Delete a context entry and its directory.
 */
export function handleContextDelete(opts: {
	id: string;
	reason: string;
}): void {
	const haltrDir = findHaltrDir(process.cwd());
	deleteEntry(haltrDir, opts.id, opts.reason);

	const response = buildResponse({
		status: "ok",
		message: `コンテキストエントリを削除しました: ${opts.id}`,
		data: {
			id: opts.id,
			reason: opts.reason,
		},
		haltrDir,
	});

	console.log(formatResponse(response));
}

/**
 * hal context log --id <id> --type <event_type> [--message <msg>]
 *
 * Record a history event for a context entry.
 */
export function handleContextLog(opts: {
	id: string;
	type: string;
	message?: string;
}): void {
	const validTypes = new Set(["updated", "confirmed", "deprecated", "promoted"]);
	if (!validTypes.has(opts.type)) {
		throw new Error(
			`無効なイベントタイプ: "${opts.type}"。updated, confirmed, deprecated, promoted のいずれかを指定してください`,
		);
	}

	const haltrDir = findHaltrDir(process.cwd());
	const entries = loadIndex(haltrDir);
	const entry = findEntry(entries, opts.id);

	if (!entry) {
		throw new Error(`コンテキストエントリ "${opts.id}" が見つかりません`);
	}

	addHistoryEvent(haltrDir, opts.id, {
		type: opts.type as "updated" | "confirmed" | "deprecated" | "promoted",
		message: opts.message,
	});

	const response = buildResponse({
		status: "ok",
		message: `イベントを記録しました: ${opts.id} (${opts.type})`,
		data: {
			id: opts.id,
			event_type: opts.type,
			message: opts.message,
		},
		haltrDir,
	});

	console.log(formatResponse(response));
}
