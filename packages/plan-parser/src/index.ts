/**
 * Phase 2: Plan & Checklist Parser
 *
 * Deterministic plan extraction from markdown bodies.
 * Parses "## Implementation Plan" sections, extracts checkbox steps,
 * and diffs snapshots to produce milestone events.
 */

export interface ParsedStep {
  /** 1-based order in the checklist */
  stepOrder: number;
  /** The step text (checkbox content without the [ ] / [x] marker) */
  text: string;
  /** Whether the checkbox was checked */
  completed: boolean;
}

export interface ParsedPlan {
  /** Name of the matching heading (e.g., "Implementation Plan") */
  headingName: string;
  /** The raw markdown body of the plan section */
  rawBody: string;
  /** Parsed steps */
  steps: ParsedStep[];
}

export interface StepDiff {
  /** Steps added between old and new */
  added: ParsedStep[];
  /** Steps removed between old and new */
  removed: ParsedStep[];
  /** Steps that were incomplete before and are now complete */
  completed: { old: ParsedStep; new: ParsedStep }[];
  /** Steps whose text changed */
  changed: { old: ParsedStep; new: ParsedStep }[];
  /** Steps that were complete before and are now incomplete (reopened) */
  reopened: { old: ParsedStep; new: ParsedStep }[];
}

export interface MilestoneEvent {
  stepOrder: number;
  stepText: string;
  previousState: "incomplete";
  newState: "complete";
}

/** Heading names that identify plan sections (case-insensitive) */
const PLAN_HEADINGS = ["implementation plan", "implementation plan?", "plan", "checklist"];

/**
 * Parse a markdown body and extract plan steps from recognized heading sections.
 * Returns all matching plans found.
 */
export function parsePlans(body: string): ParsedPlan[] {
  const plans: ParsedPlan[] = [];
  const lines = body.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // Match "## <heading>" (level 2 headings)
    const headingMatch = line.match(/^##\s+(.+)/);
    if (!headingMatch?.[1]) continue;

    const headingText = headingMatch[1].trim().toLowerCase();
    const matchedHeading = PLAN_HEADINGS.find((h) => headingText.startsWith(h));
    if (!matchedHeading) continue;

    // Collect all content under this heading until the next ## or end
    const sectionLines: string[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const nextLine = lines[j];
      if (nextLine != null && nextLine.startsWith("## ")) break;
      sectionLines.push(nextLine ?? "");
      j++;
    }

    const rawBody = sectionLines.join("\n");
    const steps = parseChecklist(rawBody);
    if (steps.length === 0) continue;

    plans.push({
      headingName: headingMatch[1].trim(),
      rawBody,
      steps
    });
  }

  return plans;
}

/**
 * Extract checkbox items from markdown content.
 * Only matches items starting with "- [ ]" or "- [x]" (case-insensitive x).
 */
export function parseChecklist(rawBody: string): ParsedStep[] {
  const steps: ParsedStep[] = [];
  const lines = rawBody.split("\n");
  let order = 0;

  for (const line of lines) {
    const match = line.match(/^[-*]\s+\[([ xX])\]\s+(.+)/);
    if (!match?.[1] || !match[2]) continue;

    order++;
    steps.push({
      stepOrder: order,
      text: match[2].trim(),
      completed: match[1].toLowerCase() === "x"
    });
  }

  return steps;
}

/**
 * Diff two step lists and produce a StepDiff.
 * Matches steps by position (stepOrder) and text similarity.
 */
export function diffSteps(oldSteps: ParsedStep[], newSteps: ParsedStep[]): StepDiff {
  const oldMap = new Map<number, ParsedStep>();
  for (const s of oldSteps) {
    oldMap.set(s.stepOrder, s);
  }

  const newMap = new Map<number, ParsedStep>();
  for (const s of newSteps) {
    newMap.set(s.stepOrder, s);
  }

  const diff: StepDiff = {
    added: [],
    removed: [],
    completed: [],
    changed: [],
    reopened: []
  };

  // Find added and changed/completed/reopened
  newMap.forEach((newStep, order) => {
    const oldStep = oldMap.get(order);
    if (!oldStep) {
      diff.added.push(newStep);
    } else if (oldStep.text !== newStep.text) {
      diff.changed.push({ old: oldStep, new: newStep });
    } else if (!oldStep.completed && newStep.completed) {
      diff.completed.push({ old: oldStep, new: newStep });
    } else if (oldStep.completed && !newStep.completed) {
      diff.reopened.push({ old: oldStep, new: newStep });
    }
  });

  // Find removed
  oldMap.forEach((oldStep, order) => {
    if (!newMap.has(order)) {
      diff.removed.push(oldStep);
    }
  });

  return diff;
}

/**
 * Extract milestone events from a step diff.
 * Only emits events for steps that transitioned from incomplete → complete.
 */
export function extractMilestones(diff: StepDiff): MilestoneEvent[] {
  return diff.completed.map(({ new: step }) => ({
    stepOrder: step.stepOrder,
    stepText: step.text,
    previousState: "incomplete" as const,
    newState: "complete" as const
  }));
}
