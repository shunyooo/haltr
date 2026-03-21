/**
 * `hal rule add` / `hal rule list` — manage project rules.
 *
 * For M7, rule add simply appends to haltr/rules.md.
 * In M8, this will be enhanced to spawn a rules agent.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * List rules from haltr/rules.md.
 *
 * @param baseDir  project root directory
 * @returns        content of rules.md
 */
export function listRules(baseDir: string): string {
	const rulesPath = join(baseDir, "haltr", "rules.md");

	if (!existsSync(rulesPath)) {
		throw new Error("haltr/rules.md not found. Run 'hal init' first.");
	}

	return readFileSync(rulesPath, "utf-8");
}

/**
 * Add a rule to haltr/rules.md.
 *
 * @param baseDir  project root directory
 * @param rule     rule text to add
 */
export function addRule(baseDir: string, rule: string): void {
	const rulesPath = join(baseDir, "haltr", "rules.md");

	if (!existsSync(rulesPath)) {
		throw new Error("haltr/rules.md not found. Run 'hal init' first.");
	}

	appendFileSync(rulesPath, `- ${rule}\n`, "utf-8");
}
