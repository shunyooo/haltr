import type React from "react";
import { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { HistoryEvent } from "../../types.js";

const MAX_VISIBLE = 8;

interface HistoryTimelineProps {
  history: HistoryEvent[];
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

function formatTime(isoString: string): string {
  try {
    const date = new Date(isoString);
    return date.toLocaleTimeString("ja-JP", { hour12: false });
  } catch {
    return isoString;
  }
}

function getEventSummary(event: HistoryEvent): string {
  const parts: string[] = [];
  if ("step" in event) {
    parts.push(event.step);
  }
  if ("message" in event && event.message) {
    parts.push(event.message);
  }
  return parts.join(" ");
}

export const HistoryTimeline: React.FC<HistoryTimelineProps> = ({
  history,
}) => {
  const [scrollOffset, setScrollOffset] = useState(0);

  const total = history.length;
  const maxOffset = Math.max(0, total - MAX_VISIBLE);

  useInput((_input, key) => {
    if (key.upArrow) {
      setScrollOffset((prev) => Math.min(prev + 1, maxOffset));
    }
    if (key.downArrow) {
      setScrollOffset((prev) => Math.max(prev - 1, 0));
    }
  });

  const startIdx = Math.max(0, total - MAX_VISIBLE - scrollOffset);
  const endIdx = total - scrollOffset;
  const visible = history.slice(startIdx, endIdx);

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray">
      <Box>
        <Text bold underline>
          History
        </Text>
        {total > MAX_VISIBLE && (
          <Text dimColor>
            {" "}
            (scroll: up/down {startIdx + 1}-{endIdx}/{total})
          </Text>
        )}
      </Box>
      {visible.map((event) => {
        const summary = getEventSummary(event);
        const key = `${event.at}-${event.type}-${"step" in event ? event.step : ""}`;
        return (
          <Box key={key}>
            <Text dimColor>{formatTime(event.at)} </Text>
            <Text color={eventColor(event.type)}>[{event.type}]</Text>
            {summary && <Text> {summary}</Text>}
          </Box>
        );
      })}
      {history.length === 0 && <Text dimColor> (no events)</Text>}
    </Box>
  );
};
