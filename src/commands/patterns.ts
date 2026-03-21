/**
 * `hal patterns` — List and show task design patterns.
 *
 * Patterns are bundled in src/patterns/ and available via CLI.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename_local = fileURLToPath(import.meta.url);
const __dirname_local = dirname(__filename_local);
const PATTERNS_DIR = join(__dirname_local, "..", "patterns");

export function listPatterns(): string {
	const indexPath = join(PATTERNS_DIR, "index.md");
	if (existsSync(indexPath)) {
		return readFileSync(indexPath, "utf-8");
	}

	// Fallback: list files
	try {
		const files = readdirSync(PATTERNS_DIR).filter(
			(f) => f.endsWith(".md") && f !== "index.md",
		);
		if (files.length === 0) return "パターンが見つかりません。";
		return files.map((f) => `- ${f.replace(".md", "")}`).join("\n");
	} catch {
		return "パターンが見つかりません。";
	}
}

export function showPattern(id: string): string {
	const filePath = join(PATTERNS_DIR, `${id}.md`);
	if (!existsSync(filePath)) {
		// List available patterns
		const available = readdirSync(PATTERNS_DIR)
			.filter((f) => f.endsWith(".md") && f !== "index.md")
			.map((f) => f.replace(".md", ""));
		throw new Error(
			`パターン "${id}" が見つかりません。利用可能: ${available.join(", ")}`,
		);
	}
	return readFileSync(filePath, "utf-8");
}
