import { describe, expect, it } from "vite-plus/test";

import { ProjectId, ThreadId } from "./baseSchemas.ts";
import {
  assistantLinearPlan,
  assistantTaskPipeline,
  type AssistantTask,
} from "./developerAssistant.ts";

const projectId = ProjectId.make("project-1");

let taskCounter = 0;
const task = (overrides: Partial<AssistantTask> = {}): AssistantTask => {
  taskCounter += 1;
  return {
    id: `task-${taskCounter}`,
    projectId,
    issue: {
      id: `issue-${taskCounter}`,
      identifier: `SPI-${taskCounter}`,
      title: "Renewal reminders",
      url: "https://linear.app/x/issue/SPI-1",
    } as AssistantTask["issue"],
    threadId: ThreadId.make(`worker-${taskCounter}`),
    status: "working",
    brief: "",
    summary: "",
    reviewInstructions: "",
    feedback: "",
    turns: 1,
    turnLimit: 6,
    deployment: null,
    error: null,
    createdAt: "2026-09-13T00:00:00.000Z",
    updatedAt: "2026-09-13T00:00:00.000Z",
    ...overrides,
  };
};

const commit = "a".repeat(40);
const at = "2026-09-13T00:00:00.000Z";
const approved = {
  codeReview: { verdict: "approved", findings: "", summary: "", commit, at },
} as const;
const merged = { ...approved, merge: { commit, summary: "Fixed", at } };
const deployed = {
  ...merged,
  deployment: { revision: commit, url: "https://staging.example.com", verifiedAt: at },
};

describe("assistantTaskPipeline", () => {
  const states = (t: AssistantTask) =>
    assistantTaskPipeline(t)
      ?.map((step) => `${step.key}:${step.state}`)
      .join(" ");

  it("follows the issue from code to e2e", () => {
    expect(states(task({ stage: "implement" }))).toBe(
      "take:done code:current review:todo merge:todo staging:todo e2e:todo",
    );
    expect(states(task({ stage: "review" }))).toBe(
      "take:done code:done review:current merge:todo staging:todo e2e:todo",
    );
    expect(states(task({ stage: "implement", ...approved }))).toBe(
      "take:done code:done review:done merge:current staging:todo e2e:todo",
    );
    expect(states(task({ stage: "lead", ...merged }))).toBe(
      "take:done code:done review:done merge:done staging:current e2e:todo",
    );
    expect(states(task({ stage: "e2e", ...deployed }))).toBe(
      "take:done code:done review:done merge:done staging:done e2e:current",
    );
  });

  it("marks review findings and a failed e2e run where they send the work", () => {
    const findings = task({
      stage: "implement",
      codeReview: { ...approved.codeReview, verdict: "changes-requested" },
    });
    expect(assistantTaskPipeline(findings)?.[2]).toMatchObject({
      state: "todo",
      note: "Changes requested",
    });
    const e2e = { verdict: "failed", report: "", humanChecks: [], screenshots: [], at } as const;
    // The fix goes back to the worker while the old merge and deployment stay on record.
    const fixing = task({ stage: "implement", ...deployed, e2e });
    expect(states(fixing)).toBe(
      "take:done code:current review:todo merge:todo staging:todo e2e:todo",
    );
    expect(assistantTaskPipeline(fixing)?.[1]?.note).toBe("Fixing the e2e failure");
  });

  it("starts with the team leader taking the issue, and gives it staging", () => {
    const led = (overrides: Partial<AssistantTask>) => task(overrides);
    expect(states(led({ stage: "lead", turns: 0 }))).toBe(
      "take:current code:todo review:todo merge:todo staging:todo e2e:todo",
    );
    expect(states(led({ stage: "implement", turns: 1 }))).toBe(
      "take:done code:current review:todo merge:todo staging:todo e2e:todo",
    );
    const staging = assistantTaskPipeline(led({ stage: "lead", turns: 1, ...merged }))?.[4];
    expect(staging).toMatchObject({ key: "staging", state: "current", kind: "lead" });
    const e2e = { verdict: "failed", report: "", humanChecks: [], screenshots: [], at } as const;
    expect(
      assistantTaskPipeline(led({ stage: "lead", turns: 1, ...deployed, e2e }))?.[5],
    ).toMatchObject({
      state: "failed",
      note: "Failed on staging",
    });
  });

  it("puts the e2e check before the merge when the issue runs it in the worktree", () => {
    const led = (overrides: Partial<AssistantTask>) =>
      task({ e2eEnvironment: "worktree", turns: 1, ...overrides });
    const passed = {
      ...approved,
      e2e: {
        verdict: "passed",
        report: "",
        humanChecks: [],
        screenshots: [],
        at,
        environment: "worktree",
        commit,
      },
    } as const;
    expect(states(led({ stage: "review" }))).toBe(
      "take:done code:done review:current e2e:todo merge:todo staging:todo",
    );
    // Code review approves, and the team leader starts the run on that commit.
    expect(states(led({ stage: "lead", ...approved }))).toBe(
      "take:done code:done review:done e2e:current merge:todo staging:todo",
    );
    expect(states(led({ stage: "implement", ...passed }))).toBe(
      "take:done code:done review:done e2e:done merge:current staging:todo",
    );
    expect(states(led({ stage: "lead", ...passed, merge: { commit, summary: "Fixed", at } }))).toBe(
      "take:done code:done review:done e2e:done merge:done staging:current",
    );
    const failedRun = {
      verdict: "failed",
      report: "",
      humanChecks: [],
      screenshots: [],
      at,
      environment: "worktree",
      commit,
    } as const;
    expect(
      assistantTaskPipeline(led({ stage: "lead", ...approved, e2e: failedRun }))?.[3],
    ).toMatchObject({
      state: "failed",
      note: "Failed in the worktree",
    });
    // The fix goes back to the worker, before the run it has to pass again.
    expect(states(led({ stage: "implement", ...approved, e2e: failedRun }))).toBe(
      "take:done code:current review:todo e2e:todo merge:todo staging:todo",
    );
  });

  it("has none for work started before issues had review and e2e threads", () => {
    expect(assistantTaskPipeline(task())).toBeNull();
  });
});

describe("assistantLinearPlan", () => {
  const plan = (t: AssistantTask) =>
    assistantLinearPlan(t).map((step) => `${step.content}=${step.status}`);
  const failedRun = {
    verdict: "failed",
    report: "",
    humanChecks: [],
    screenshots: [],
    at,
  } as const;

  it("lists the pipeline steps and then the person's check", () => {
    expect(plan(task({ stage: "review" }))).toEqual([
      "Take on=completed",
      "Code=completed",
      "Code review=inProgress",
      "Merge=pending",
      "Staging=pending",
      "E2E test=pending",
      "Your check=pending",
    ]);
    expect(
      plan(
        task({
          stage: "implement",
          codeReview: { ...approved.codeReview, verdict: "changes-requested" },
        }),
      ).slice(1, 3),
    ).toEqual([
      "Code: Fixing review findings=inProgress",
      "Code review: Changes requested=pending",
    ]);
  });

  it("puts the e2e check before the merge in worktree mode", () => {
    expect(plan(task({ e2eEnvironment: "worktree", stage: "lead", ...approved }))).toEqual([
      "Take on=completed",
      "Code=completed",
      "Code review=completed",
      "E2E test=inProgress",
      "Merge=pending",
      "Staging=pending",
      "Your check=pending",
    ]);
  });

  it("marks a failed e2e run as in progress and says it failed", () => {
    expect(plan(task({ stage: "lead", ...deployed, e2e: failedRun })).slice(4)).toEqual([
      "Staging: aaaaaaa deployed=completed",
      "E2E test (failed): Failed on staging=inProgress",
      "Your check=pending",
    ]);
  });

  it("completes every step while the person checks, and the check once accepted", () => {
    const passed = { ...failedRun, verdict: "passed" } as const;
    const review = plan(task({ status: "review", stage: "lead", ...deployed, e2e: passed }));
    expect(review.slice(0, -1).every((step) => step.endsWith("=completed"))).toBe(true);
    expect(review.at(-1)).toBe("Your check=inProgress");
    const accepted = plan(task({ status: "accepted", stage: "lead", ...deployed, e2e: passed }));
    expect(accepted.every((step) => step.endsWith("=completed"))).toBe(true);
    expect(accepted).toHaveLength(7);
  });

  it("cancels the steps a declined issue never finished", () => {
    expect(plan(task({ status: "declined", stage: "lead", turns: 0 }))).toEqual([
      "Take on=canceled",
      "Code=canceled",
      "Code review=canceled",
      "Merge=canceled",
      "Staging=canceled",
      "E2E test=canceled",
      "Your check=canceled",
    ]);
    expect(plan(task({ status: "skipped", stage: "review" })).slice(1, 3)).toEqual([
      "Code=completed",
      "Code review=canceled",
    ]);
  });

  it("is empty for work with no pipeline", () => {
    expect(assistantLinearPlan(task())).toEqual([]);
  });
});
