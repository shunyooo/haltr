import { readFileSync } from "node:fs";
import AjvModule, { type ValidateFunction } from "ajv";
import * as yaml from "js-yaml";

import taskSchemaJson from "../schemas/task.schema.json" with { type: "json" };
import type { TaskYaml } from "../types.js";

// Handle both ESM default and CJS interop
// biome-ignore lint/suspicious/noExplicitAny: ESM/CJS interop requires any
const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true, discriminator: true });

const taskValidator: ValidateFunction = ajv.compile(taskSchemaJson);

/**
 * Validate parsed task data against the task schema.
 * Returns typed TaskYaml or throws with clear error messages.
 */
export function validateTask(data: unknown): TaskYaml {
	const valid = taskValidator(data);
	if (!valid) {
		const errors = taskValidator.errors ?? [];
		const messages = errors.map((e) => {
			const path = e.instancePath || "(root)";
			return `  ${path}: ${e.message}${e.params ? ` (${JSON.stringify(e.params)})` : ""}`;
		});
		throw new Error(`Task validation failed:\n${messages.join("\n")}`);
	}

	return data as TaskYaml;
}

/**
 * Load a YAML file, parse it, and validate against the task schema.
 */
export function loadAndValidateTask(filePath: string): TaskYaml {
	const content = readFileSync(filePath, "utf-8");
	const data = yaml.load(content);
	return validateTask(data);
}
