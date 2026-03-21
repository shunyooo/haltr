import { Box, Text, useInput } from "ink";
import type React from "react";
import { useEffect, useState } from "react";
import { formatLocalTime } from "../../lib/timezone.js";
import type { AcceptObject, HistoryEvent, Step, StepStatus } from "../../types.js";

interface TimelineBarProps {
	steps: Step[];
	history: HistoryEvent[];
	focused: boolean;
	timezone: string;
}

function getStatusSymbol(status: StepStatus): string {
	switch (status) {
		case "done":
			return "\u25CF"; // ●
		case "in_progress":
			return "\u25C9"; // ◉
		case "pending":
			return "\u25CB"; // ○
		case "failed":
			return "\u2715"; // ✕
		case "skipped":
			return "\u2500"; // ─
		case "blocked":
			return "\u25CB"; // ○
		default:
			return "\u25CB";
	}
}

function getStatusColor(status: StepStatus): string {
	switch (status) {
		case "done":
			return "green";
		case "in_progress":
			return "blue";
		case "failed":
			return "red";
		default:
			return "gray";
	}
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

function hasStep(e: HistoryEvent): e is HistoryEvent & { step: string } {
	return "step" in e;
}

function calcStepElapsed(
	stepId: string,
	stepStatus: StepStatus,
	history: HistoryEvent[],
): number {
	const stepEvents = history.filter(
		(e) => hasStep(e) && e.step === stepId,
	);
	if (stepEvents.length === 0) return 0;

	// Group by attempt
	const byAttempt = new Map<number, HistoryEvent[]>();
	for (const e of stepEvents) {
		const attempt = "attempt" in e ? (e as { attempt: number }).attempt : 0;
		const arr = byAttempt.get(attempt);
		if (arr) {
			arr.push(e);
		} else {
			byAttempt.set(attempt, [e]);
		}
	}

	let totalMs = 0;
	for (const [, events] of byAttempt) {
		const startEvent = events.find((e) => e.type === "step_started");
		if (!startEvent) continue;
		const startTime = new Date(startEvent.at).getTime();

		const sorted = [...events].sort(
			(a, b) => new Date(a.at).getTime() - new Date(b.at).getTime(),
		);
		const lastEvent = sorted[sorted.length - 1];

		if (
			stepStatus === "in_progress" &&
			lastEvent.type !== "verification_passed"
		) {
			totalMs += Date.now() - startTime;
		} else {
			totalMs += new Date(lastEvent.at).getTime() - startTime;
		}
	}

	return totalMs;
}

function formatDuration(ms: number): string {
	if (ms <= 0) return "";
	const totalSec = Math.floor(ms / 1000);
	const minutes = Math.floor(totalSec / 60);
	const seconds = totalSec % 60;
	if (minutes > 0 && seconds > 0) return `${minutes}m${seconds}s`;
	if (minutes > 0) return `${minutes}m`;
	return `${seconds}s`;
}

function centerPad(text: string, width: number): string {
	if (text.length >= width) return text.slice(0, width);
	const leftPad = Math.floor((width - text.length) / 2);
	return (
		" ".repeat(leftPad) + text + " ".repeat(width - text.length - leftPad)
	);
}

export const TimelineBar: React.FC<TimelineBarProps> = ({
	steps,
	history,
	focused,
	timezone,
}) => {
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [showDetail, setShowDetail] = useState(false);
	const [blinkVisible, setBlinkVisible] = useState(true);
	const [, setTick] = useState(0);

	// Blink animation for in_progress dots
	useEffect(() => {
		const interval = setInterval(() => {
			setBlinkVisible((prev) => !prev);
		}, 500);
		return () => clearInterval(interval);
	}, []);

	// Real-time update for in_progress elapsed time
	const hasInProgress = steps.some(
		(s) => (s.status ?? "pending") === "in_progress",
	);
	useEffect(() => {
		if (!hasInProgress) return;
		const interval = setInterval(() => {
			setTick((prev) => prev + 1);
		}, 1000);
		return () => clearInterval(interval);
	}, [hasInProgress]);

	// Close detail when focus lost
	useEffect(() => {
		if (!focused) {
			setShowDetail(false);
		}
	}, [focused]);

	// Keep selectedIndex in bounds
	useEffect(() => {
		if (selectedIndex >= steps.length && steps.length > 0) {
			setSelectedIndex(steps.length - 1);
		}
	}, [steps.length, selectedIndex]);

	useInput((_input, key) => {
		if (!focused) return;

		if (showDetail) {
			if (key.escape) {
				setShowDetail(false);
			}
			return;
		}

		if (key.leftArrow) {
			setSelectedIndex((prev) => Math.max(0, prev - 1));
		}
		if (key.rightArrow) {
			setSelectedIndex((prev) => Math.min(steps.length - 1, prev + 1));
		}
		if (key.return) {
			setShowDetail(true);
		}
	});

	if (steps.length === 0) {
		return (
			<Box
				borderStyle={focused ? "single" : undefined}
				borderColor={focused ? "yellow" : undefined}
				paddingX={focused ? 1 : 0}
			>
				<Text dimColor>(no steps)</Text>
			</Box>
		);
	}

	// Detail view
	if (showDetail && focused) {
		const step = steps[selectedIndex];
		if (!step) return null;
		const stepHistory = history.filter(
			(e) => hasStep(e) && e.step === step.id,
		);
		const accepts: AcceptObject[] | null = step.accept
			? Array.isArray(step.accept)
				? step.accept
				: null
			: null;

		return (
			<Box
				flexDirection="column"
				borderStyle="single"
				borderColor="yellow"
				paddingX={1}
			>
				<Box>
					<Text bold>
						Step: {step.id}
					</Text>
					<Text dimColor> [{step.status ?? "pending"}]</Text>
					<Text color="yellow"> (Esc to go back)</Text>
				</Box>
				<Box marginTop={1} flexDirection="column">
					<Text bold>Instructions:</Text>
					<Text>{step.instructions?.trim()}</Text>
				</Box>
				{step.accept && (
					<Box marginTop={1} flexDirection="column">
						<Text bold>Accept criteria:</Text>
						{accepts
							? accepts.map((a) => (
									<Box key={a.id}>
										<Text color="cyan"> {a.id}: </Text>
										<Text>{a.check}</Text>
									</Box>
								))
							: <Text> {String(step.accept)}</Text>
						}
					</Box>
				)}
				{stepHistory.length > 0 && (
					<Box marginTop={1} flexDirection="column">
						<Text bold>History:</Text>
						{stepHistory.map((e) => (
							<Box key={`${e.at}-${e.type}`}>
								<Text dimColor>
									{formatLocalTime(e.at, timezone)}{" "}
								</Text>
								<Text color={eventColor(e.type)}>[{e.type}]</Text>
								{"message" in e && e.message && (
									<Text>
										{" "}
										{String(e.message).split("\n")[0].slice(0, 60)}
									</Text>
								)}
							</Box>
						))}
					</Box>
				)}
			</Box>
		);
	}

	// Calculate cell width
	const maxNameLen = Math.max(...steps.map((s) => s.id.length));
	const cellWidth = Math.max(maxNameLen + 2, 6);
	const halfLeft = Math.floor((cellWidth - 1) / 2);

	return (
		<Box
			flexDirection="column"
			borderStyle={focused ? "single" : undefined}
			borderColor={focused ? "yellow" : undefined}
			paddingX={focused ? 1 : 0}
		>
			<Box>
				<Text bold underline>
					Timeline
				</Text>
				{focused && (
					<Text color="yellow"> [FOCUSED] {"\u2190\u2192"} select, Enter detail</Text>
				)}
			</Box>
			{/* Dot line */}
			<Box flexDirection="row">
				{steps.map((step, i) => {
					const status: StepStatus = step.status ?? "pending";
					const symbol = getStatusSymbol(status);
					const color = getStatusColor(status);
					const isSelected = focused && i === selectedIndex;
					const isBlinking =
						status === "in_progress" && !blinkVisible;

					const rightHalf =
						i < steps.length - 1
							? cellWidth - 1 - halfLeft
							: halfLeft;

					return (
						<Text key={step.id}>
							{"\u2500".repeat(halfLeft)}
							<Text
								color={isBlinking ? "gray" : color}
								bold={isSelected}
								inverse={isSelected}
							>
								{isBlinking ? "\u25CB" : symbol}
							</Text>
							{"\u2500".repeat(rightHalf)}
						</Text>
					);
				})}
			</Box>
			{/* Name line */}
			<Box flexDirection="row">
				{steps.map((step, i) => {
					const isSelected = focused && i === selectedIndex;
					return (
						<Box key={step.id} width={cellWidth}>
							<Text
								bold={isSelected}
								color={isSelected ? "yellow" : undefined}
							>
								{centerPad(step.id, cellWidth)}
							</Text>
						</Box>
					);
				})}
			</Box>
			{/* Time line */}
			<Box flexDirection="row">
				{steps.map((step) => {
					const status: StepStatus = step.status ?? "pending";
					const elapsed = calcStepElapsed(step.id, status, history);
					const timeStr = formatDuration(elapsed);
					return (
						<Box key={step.id} width={cellWidth}>
							<Text dimColor>
								{centerPad(timeStr, cellWidth)}
							</Text>
						</Box>
					);
				})}
			</Box>
		</Box>
	);
};
