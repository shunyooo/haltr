import * as yaml from "js-yaml";

export interface HalResponse {
	status: string;
	message: string;
	data?: Record<string, unknown>;
	commands_hint?: string;
}

interface BuildResponseOpts {
	status: string;
	message: string;
	data?: Record<string, unknown>;
	commands_hint?: string;
}

/**
 * Build a structured HalResponse.
 */
export function buildResponse(opts: BuildResponseOpts): HalResponse {
	const response: HalResponse = {
		status: opts.status,
		message: opts.message,
	};

	if (opts.data) {
		response.data = opts.data;
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
