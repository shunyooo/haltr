/**
 * Timezone resolution and time formatting utilities.
 *
 * Priority: config.yaml timezone > TZ environment variable > UTC
 */

export function resolveTimezone(configTimezone?: string): string {
	if (configTimezone) return configTimezone;
	if (process.env.TZ) return process.env.TZ;
	return "UTC";
}

export function formatLocalTime(isoString: string, timezone: string): string {
	try {
		const date = new Date(isoString);
		return date.toLocaleTimeString("ja-JP", {
			hour12: false,
			timeZone: timezone,
		});
	} catch {
		return isoString;
	}
}

export function formatLocalDateTime(
	isoString: string,
	timezone: string,
): string {
	try {
		const date = new Date(isoString);
		return date.toLocaleString("ja-JP", {
			hour12: false,
			timeZone: timezone,
		});
	} catch {
		return isoString;
	}
}
