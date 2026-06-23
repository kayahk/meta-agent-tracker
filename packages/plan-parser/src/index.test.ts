import { describe, it, expect } from "vitest";
import {
  parsePlans,
  parseChecklist,
  diffSteps,
  extractMilestones,
  type ParsedStep,
  type StepDiff
} from "./index.js";

describe("parseChecklist", () => {
  it("extracts unchecked items", () => {
    const result = parseChecklist("- [ ] install dependencies\n- [ ] run tests");
    expect(result).toEqual([
      { stepOrder: 1, text: "install dependencies", completed: false },
      { stepOrder: 2, text: "run tests", completed: false }
    ]);
  });

  it("extracts checked items", () => {
    const result = parseChecklist("- [x] setup project\n- [X] add CI");
    expect(result).toEqual([
      { stepOrder: 1, text: "setup project", completed: true },
      { stepOrder: 2, text: "add CI", completed: true }
    ]);
  });

  it("handles asterisk list markers", () => {
    const result = parseChecklist("* [ ] task one\n* [x] task two");
    expect(result).toEqual([
      { stepOrder: 1, text: "task one", completed: false },
      { stepOrder: 2, text: "task two", completed: true }
    ]);
  });

  it("ignores non-checkbox items", () => {
    const result = parseChecklist("- plain item\n- [x] real checkbox\nsome text");
    expect(result).toEqual([{ stepOrder: 1, text: "real checkbox", completed: true }]);
  });

  it("returns empty for no checkboxes", () => {
    expect(parseChecklist("just text\nno checkboxes")).toEqual([]);
  });

  it("trims whitespace from step text", () => {
    const result = parseChecklist("- [ ]   padded text   ");
    expect(result).toEqual([{ stepOrder: 1, text: "padded text", completed: false }]);
  });
});

describe("parsePlans", () => {
  it("extracts plan from ## Implementation Plan heading", () => {
    const body = `## Implementation Plan\n\n- [x] Done step\n- [ ] Todo step\n\n## Other Section\n\n- [ ] ignore me`;
    const plans = parsePlans(body);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.headingName).toBe("Implementation Plan");
    expect(plans[0]!.steps).toHaveLength(2);
    expect(plans[0]!.steps[0]!.completed).toBe(true);
    expect(plans[0]!.steps[1]!.completed).toBe(false);
  });

  it("matches ## Plan heading", () => {
    const body = `## Plan\n\n- [ ] step 1`;
    const plans = parsePlans(body);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.headingName).toBe("Plan");
  });

  it("matches ## Checklist heading", () => {
    const body = `## Checklist\n\n- [x] item`;
    const plans = parsePlans(body);
    expect(plans).toHaveLength(1);
  });

  it("stops at next ## heading", () => {
    const body = `## Implementation Plan\n- [ ] first\n## Next Plan\n- [ ] second`;
    const plans = parsePlans(body);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.steps).toHaveLength(1);
    expect(plans[0]!.steps[0]!.text).toBe("first");
  });

  it("ignores sections with no checkboxes", () => {
    const body = `## Implementation Plan\n\njust prose, no checkboxes`;
    const plans = parsePlans(body);
    expect(plans).toHaveLength(0);
  });

  it("extracts multiple plans from different headings", () => {
    const body = `## Plan\n- [ ] step A\n\n## Checklist\n- [x] step B\n- [ ] step C`;
    const plans = parsePlans(body);
    expect(plans).toHaveLength(2);
  });

  it("matches heading with trailing question mark", () => {
    const body = `## Implementation Plan?\n\n- [ ] maybe`;
    const plans = parsePlans(body);
    expect(plans).toHaveLength(1);
  });

  it("includes the raw body in output", () => {
    const body = `## Implementation Plan\n\n- [ ] step 1\n- [x] step 2`;
    const plans = parsePlans(body);
    expect(plans[0]!.rawBody).toContain("- [ ] step 1");
    expect(plans[0]!.rawBody).toContain("- [x] step 2");
  });
});

describe("diffSteps", () => {
  const makeStep = (order: number, text: string, completed: boolean = false): ParsedStep => ({
    stepOrder: order,
    text,
    completed
  });

  it("detects no changes", () => {
    const old_steps = [makeStep(1, "task", false)];
    const new_steps = [makeStep(1, "task", false)];
    const diff = diffSteps(old_steps, new_steps);
    expect(diff).toEqual({
      added: [],
      removed: [],
      completed: [],
      changed: [],
      reopened: []
    });
  });

  it("detects completed steps", () => {
    const old_steps = [makeStep(1, "task", false)];
    const new_steps = [makeStep(1, "task", true)];
    const diff = diffSteps(old_steps, new_steps);
    expect(diff.completed).toHaveLength(1);
    expect(diff.completed[0]!.old.completed).toBe(false);
    expect(diff.completed[0]!.new.completed).toBe(true);
  });

  it("detects added steps", () => {
    const old_steps = [makeStep(1, "existing", false)];
    const new_steps = [makeStep(1, "existing", false), makeStep(2, "new", false)];
    const diff = diffSteps(old_steps, new_steps);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0]!.text).toBe("new");
  });

  it("detects removed steps", () => {
    const old_steps = [makeStep(1, "keep", false), makeStep(2, "remove", false)];
    const new_steps = [makeStep(1, "keep", false)];
    const diff = diffSteps(old_steps, new_steps);
    expect(diff.removed).toHaveLength(1);
    expect(diff.removed[0]!.text).toBe("remove");
  });

  it("detects changed text", () => {
    const old_steps = [makeStep(1, "old text", false)];
    const new_steps = [makeStep(1, "new text", false)];
    const diff = diffSteps(old_steps, new_steps);
    expect(diff.changed).toHaveLength(1);
  });

  it("detects reopened steps", () => {
    const old_steps = [makeStep(1, "task", true)];
    const new_steps = [makeStep(1, "task", false)];
    const diff = diffSteps(old_steps, new_steps);
    expect(diff.reopened).toHaveLength(1);
  });
});

describe("extractMilestones", () => {
  it("extracts only completed transitions", () => {
    const diff: StepDiff = {
      added: [{ stepOrder: 3, text: "new", completed: false }],
      removed: [],
      completed: [
        {
          old: { stepOrder: 1, text: "done", completed: false },
          new: { stepOrder: 1, text: "done", completed: true }
        }
      ],
      changed: [],
      reopened: [
        {
          old: { stepOrder: 2, text: "oops", completed: true },
          new: { stepOrder: 2, text: "oops", completed: false }
        }
      ]
    };
    const milestones = extractMilestones(diff);
    expect(milestones).toHaveLength(1);
    expect(milestones[0]).toEqual({
      stepOrder: 1,
      stepText: "done",
      previousState: "incomplete",
      newState: "complete"
    });
  });

  it("returns empty when nothing completed", () => {
    const diff: StepDiff = {
      added: [],
      removed: [],
      completed: [],
      changed: [],
      reopened: []
    };
    expect(extractMilestones(diff)).toHaveLength(0);
  });
});
