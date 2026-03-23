import { readFileSync } from "node:fs";
import AjvModule, { type ValidateFunction } from "ajv";
import * as yaml from "js-yaml";
import configSchemaJson from "../schemas/config.schema.json" with {
	type: "json",
};

import taskSchemaJson from "../schemas/task.schema.json" with { type: "json" };
import type { ConfigYaml, TaskYaml } from "../types.js";

// Handle both ESM default and CJS interop
// biome-ignore lint/suspicious/noExplicitAny: ESM/CJS interop requires any
const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true, discriminator: true });

const taskValidator: ValidateFunction = ajv.compile(taskSchemaJson);
const configValidator: ValidateFunction = ajv.compile(configSchemaJson);

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
 * Validate parsed config data against the config schema.
 * Returns typed ConfigYaml or throws with clear error messages.
 */
export function validateConfig(data: unknown): ConfigYaml {
	const valid = configValidator(data);
	if (!valid) {
		const errors = configValidator.errors ?? [];
		const messages = errors.map((e) => {
			const path = e.instancePath || "(root)";
			return `  ${path}: ${e.message}${e.params ? ` (${JSON.stringify(e.params)})` : ""}`;
		});
		throw new Error(`Config validation failed:\n${messages.join("\n")}`);
	}
	return data as ConfigYaml;
}

/**
 * Load a YAML file, parse it, and validate against the task schema.
 */
export function loadAndValidateTask(filePath: string): TaskYaml {
	const content = readFileSync(filePath, "utf-8");
	const data = yaml.load(content);
	return validateTask(data);
}

/**
 * Load a YAML file, parse it, and validate against the config schema.
 */
export function loadAndValidateConfig(filePath: string): ConfigYaml {
	const content = readFileSync(filePath, "utf-8");
	const data = yaml.load(content);
	return validateConfig(data);
}
