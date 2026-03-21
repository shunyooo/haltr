import { Box, Text, useInput, useStdout } from "ink";
import type React from "react";
import { useEffect, useState } from "react";
import { formatLocalTime } from "../../lib/timezone.js";
import type { HistoryEvent } from "../../types.js";

const DEFAULT_MAX_VISIBLE = 8;

interface HistoryTimelineProps {
	history: HistoryEvent[];
	focused: boolean;
	onExit?: () => void;
	maxVisible?: number;
	timezone: string;
}

function eventColor(type: string): string {
	switch (type) {
		case "verification_passed":
		case "work_done":
		case "completed":
			return "green";
		case "verification_failed":
		case "escalation":
		case "failed":
			return "red";
		case "step_started":
		case "verifier_started":
		case "in_progress":
			return "blue";
		case "step_skipped":
		case "blocked_resolved":
			return "yellow";
		default:
			return "white";
	}
}


function getEventSummary(event: HistoryEvent): string {
	const parts: string[] = [];
	if ("step" in event) {
		parts.push(event.step);
	}
	if ("message" in event && event.message) {
		const firstLine = event.message.split("\n")[0];
		parts.push(firstLine);
	}
	return parts.join(" ");
}

function getEventMessage(event: HistoryEvent): string {
	if ("message" in event && event.message) return event.message;
	if ("diff" in event && event.diff) return event.diff;
	return "";
}

function truncate(text: string, maxLen: number): string {
	if (maxLen <= 0) return "";
	if (text.length <= maxLen) return text;
	if (maxLen <= 1) return "\u2026";
	return `${text.slice(0, maxLen - 1)}\u2026`;
}

export const HistoryTimeline: React.FC<HistoryTimelineProps> = ({
	history,
	focused,
	onExit,
	maxVisible: maxVisibleProp,
	timezone,
}) => {
	const MAX_VISIBLE = maxVisibleProp ?? DEFAULT_MAX_VISIBLE;
	const { stdout } = useStdout();
	const termWidth = stdout.columns ?? 80;

	const total = history.length;
	const [cursorIndex, setCursorIndex] = useState(() =>
		Math.max(0, total - 1),
	);
	const [viewOffset, setViewOffset] = useState(() =>
		Math.max(0, total - MAX_VISIBLE),
	);
	const [detailIndex, setDetailIndex] = useState<number | null>(null);

	// Keep cursor in bounds when history changes
	useEffect(() => {
		if (total === 0) {
			setCursorIndex(0);
			setViewOffset(0);
			return;
		}
		setCursorIndex((prev) => Math.min(prev, total - 1));
		setViewOffset((prev) =>
			Math.min(prev, Math.max(0, total - MAX_VISIBLE)),
		);
	}, [total, MAX_VISIBLE]);

	// Close detail when focus lost
	useEffect(() => {
		if (!focused) {
			setDetailIndex(null);
		}
	}, [focused]);

	// Auto-scroll to keep cursor visible
	useEffect(() => {
		if (cursorIndex < viewOffset) {
			setViewOffset(cursorIndex);
		} else if (cursorIndex >= viewOffset + MAX_VISIBLE) {
			setViewOffset(cursorIndex - MAX_VISIBLE + 1);
		}
	}, [cursorIndex, viewOffset, MAX_VISIBLE]);

	useInput((_input, key) => {
		if (!focused) return;

		if (detailIndex !== null) {
			if (key.escape) {
				setDetailIndex(null);
			}
			return;
		}

		// List view
		if (key.upArrow) {
			setCursorIndex((prev) => Math.max(0, prev - 1));
		}
		if (key.downArrow) {
			setCursorIndex((prev) => Math.min(total - 1, prev + 1));
		}
		if (key.return && total > 0) {
			setDetailIndex(cursorIndex);
		}
		if (key.escape) {
			onExit?.();
		}
	});

	// Detail view
	if (detailIndex !== null && focused) {
		const event = history[detailIndex];
		if (!event) {
			setDetailIndex(null);
			return null;
		}

		const message = getEventMessage(event);

		return (
			<Box
				flexDirection="column"
				borderStyle="single"
				borderColor="yellow"
				paddingX={1}
			>
				<Box>
					<Text bold>History Detail</Text>
					<Text color="yellow"> (Esc to go back)</Text>
				</Box>
				<Box marginTop={1} flexDirection="column">
					<Box>
						<Text dimColor>Time: </Text>
						<Text>{formatLocalTime(event.at, timezone)}</Text>
					</Box>
					<Box>
						<Text dimColor>Type: </Text>
						<Text color={eventColor(event.type)}>{event.type}</Text>
					</Box>
					{"step" in event && (
						<Box>
							<Text dimColor>Step: </Text>
							<Text>
								{(event as { step: string }).step}
							</Text>
						</Box>
					)}
					{"attempt" in event && (
						<Box>
							<Text dimColor>Attempt: </Text>
							<Text>
								{String((event as { attempt: number }).attempt)}
							</Text>
						</Box>
					)}
					{"accept_id" in event && (
						<Box>
							<Text dimColor>Accept: </Text>
							<Text>
								{(event as { accept_id: string }).accept_id}
							</Text>
						</Box>
					)}
					<Box>
						<Text dimColor>By: </Text>
						<Text>{event.by}</Text>
					</Box>
				</Box>
				{message && (
					<Box marginTop={1} flexDirection="column">
						<Text bold>Message:</Text>
						<Text>{message}</Text>
					</Box>
				)}
			</Box>
		);
	}

	// List view
	const visibleCount = Math.min(MAX_VISIBLE, total);
	const visible = history.slice(viewOffset, viewOffset + visibleCount);

	// Box overhead: border (2) + paddingX (2) = 4
	const boxOverhead = 4;

	return (
		<Box
			flexDirection="column"
			borderStyle="single"
			borderColor={focused ? "yellow" : "gray"}
			paddingX={1}
		>
			<Box>
				<Text bold underline>
					History
				</Text>
				{focused && (
					<Text color="yellow">
						{" "}
						[FOCUSED] {"\u2191\u2193"} select, Enter detail
					</Text>
				)}
				{!focused && total > MAX_VISIBLE && (
					<Text dimColor> ({total} events)</Text>
				)}
			</Box>
			{visible.map((event, idx) => {
				const histIdx = viewOffset + idx;
				const isSelected = focused && histIdx === cursorIndex;
				const key = `${histIdx}-${event.at}-${event.type}`;

				const cursor = isSelected ? "\u25B8 " : "  ";
				const time = formatLocalTime(event.at, timezone);
				const type = `[${event.type}]`;
				const summary = getEventSummary(event);

				const prefixLen = cursor.length + time.length + 1 + type.length;
				const availWidth = termWidth - boxOverhead - prefixLen;
				const truncatedSummary = summary
					? ` ${truncate(summary, Math.max(0, availWidth - 1))}`
					: "";

				return (
					<Box key={key}>
						<Text color={isSelected ? "yellow" : undefined}>
							{cursor}
						</Text>
						<Text dimColor={!isSelected}>{time} </Text>
						<Text
							color={eventColor(event.type)}
							bold={isSelected}
						>
							{type}
						</Text>
						{truncatedSummary && (
							<Text bold={isSelected}>{truncatedSummary}</Text>
						)}
					</Box>
				);
			})}
			{total === 0 && <Text dimColor> (no events)</Text>}
		</Box>
	);
};
