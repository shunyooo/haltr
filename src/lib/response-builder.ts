import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";

export interface KnowledgeEntry {
	type: string;
	id: string;
	description: string;
}

export interface HalResponse {
	status: string;
	message: string;
	data?: Record<string, unknown>;
	context?: {
		available_knowledge: KnowledgeEntry[];
	};
	notes_prompt?: string;
	commands_hint?: string;
}

interface BuildResponseOpts {
	status: string;
	message: string;
	data?: Record<string, unknown>;
	haltrDir?: string;
	notes_prompt?: string;
	commands_hint?: string;
}

/**
 * Load knowledge descriptions from haltr/context/index.yaml if it exists.
 * Returns an array of knowledge entries.
 */
function loadKnowledgeList(haltrDir: string): KnowledgeEntry[] {
	const indexPath = join(haltrDir, "context", "index.yaml");
	if (!existsSync(indexPath)) {
		return [];
	}

	try {
		const content = readFileSync(indexPath, "utf-8");
		const data = yaml.load(content) as
			| KnowledgeEntry[]
			| { entries: KnowledgeEntry[] }
			| null;

		if (Array.isArray(data)) {
			return data;
		}
		if (data && typeof data === "object" && "entries" in data) {
			return data.entries;
		}
		return [];
	} catch {
		return [];
	}
}

/**
 * Build a structured HalResponse.
 * Automatically loads context knowledge if haltrDir is provided.
 */
export function buildResponse(opts: BuildResponseOpts): HalResponse {
	const response: HalResponse = {
		status: opts.status,
		message: opts.message,
	};

	if (opts.data) {
		response.data = opts.data;
	}

	if (opts.haltrDir) {
		const knowledge = loadKnowledgeList(opts.haltrDir);
		if (knowledge.length > 0) {
			response.context = {
				available_knowledge: knowledge,
			};
		}
	}

	if (opts.notes_prompt) {
		response.notes_prompt = opts.notes_prompt;
	}

	if (opts.commands_hint) {
		response.commands_hint = opts.commands_hint;
	}

	return response;
}

/**
 * Format a HalResponse as readable YAML for agent consumption.
 */
export function formatResponse(response: HalResponse): string {
	return yaml.dump(response, { lineWidth: -1, noRefs: true });
}
