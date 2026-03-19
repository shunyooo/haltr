/**
 * Agent settings loader.
 *
 * Reads agent definitions from src/agents/*.yaml (bundled with haltr).
 * Users can override by creating haltr/agents/<role>.yaml in their project.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename_local = fileURLToPath(import.meta.url);
const __dirname_local = dirname(__filename_local);

// Built-in agents directory: dist/agents/ (copied from src/agents/ at build time)
// or src/agents/ when running via tsx
const BUILTIN_AGENTS_DIR = join(__dirname_local, "..", "agents");

/**
 * Get agent settings content for a role.
 *
 * Resolution order:
 *   1. haltr/agents/<role>.yaml (user override)
 *   2. src/agents/<role>.yaml (built-in default)
 *   3. Minimal fallback
 */
export function getAgentSettings(haltrDir: string, role: string): string {
  // 1. User override
  const overridePath = join(haltrDir, "agents", `${role}.yaml`);
  if (existsSync(overridePath)) {
    return readFileSync(overridePath, "utf-8");
  }

  // 2. Built-in default
  const builtinPath = join(BUILTIN_AGENTS_DIR, `${role}.yaml`);
  if (existsSync(builtinPath)) {
    return readFileSync(builtinPath, "utf-8");
  }

  // 3. Minimal fallback
  return `roles: [${role}]\nhooks: {}\n`;
}
