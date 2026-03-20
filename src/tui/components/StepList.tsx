import type React from "react";
import { Box, Text } from "ink";
import type { Step, StepStatus, HistoryEvent } from "../../types.js";

const STATUS_ICONS: Record<StepStatus, string> = {
  done: "\u2705",
  in_progress: "\uD83D\uDD04",
  pending: "\u231B",
  failed: "\u274C",
  blocked: "\uD83D\uDEAB",
  skipped: "\u23ED",
};

interface StepListProps {
  steps: Step[];
  history: HistoryEvent[];
}

function getAttemptCounts(history: HistoryEvent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of history) {
    if ("step" in event && "attempt" in event) {
      const current = counts.get(event.step) ?? 0;
      if (event.attempt > current) {
        counts.set(event.step, event.attempt);
      }
    }
  }
  return counts;
}

interface FlatStep {
  step: Step;
  depth: number;
}

function flattenSteps(steps: Step[], depth: number): FlatStep[] {
  const result: FlatStep[] = [];
  for (const step of steps) {
    result.push({ step, depth });
    if (step.steps) {
      result.push(...flattenSteps(step.steps, depth + 1));
    }
  }
  return result;
}

export const StepList: React.FC<StepListProps> = ({ steps, history }) => {
  const attemptCounts = getAttemptCounts(history);
  const flatSteps = flattenSteps(steps, 0);

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text bold underline>
        Steps
      </Text>
      {flatSteps.map(({ step, depth }) => {
        const status: StepStatus = step.status ?? "pending";
        const icon = STATUS_ICONS[status];
        const attempts = attemptCounts.get(step.id) ?? 0;
        const indent = "  ".repeat(depth);
        return (
          <Box key={`${depth}-${step.id}`}>
            <Text>
              {indent}
              {icon} {step.id}
            </Text>
            <Text dimColor> [{status}]</Text>
            {attempts > 0 && <Text dimColor> attempt:{attempts}</Text>}
          </Box>
        );
      })}
      {steps.length === 0 && <Text dimColor>(no steps)</Text>}
    </Box>
  );
};
