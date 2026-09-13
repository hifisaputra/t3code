import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type AssistantBoard,
  type AssistantDecision,
  type AssistantProject,
  type AssistantTask,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildInbox,
  decisionOptions,
  describeProjectActivity,
  describeTaskPhase,
  historyTasks,
  projectFailure,
  projectWaitingReason,
} from "./assistantBoard.logic";

const projectId = ProjectId.make("project-1");

const project = (overrides: Partial<AssistantProject> = {}): AssistantProject => ({
  config: {
    projectId,
    linearProjectId: "linear-project",
    assignedToMe: false,
    readyStates: [],
    modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5" },
    workerModelSelection: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-opus-5",
    },
    runtimeMode: "full-access",
    baseBranch: "develop",
    instructions: "",
    stagingCheckCommand: "",
    reviewState: "In Review",
    acceptedState: "Done",
    maxWorkerTurns: 6,
  },
  threadId: ThreadId.make("assistant-1"),
  status: "running",
  error: null,
  ...overrides,
});

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

const decision = (overrides: Partial<AssistantDecision> = {}): AssistantDecision => ({
  id: "decision-1",
  projectId,
  threadId: ThreadId.make("assistant-1"),
  taskId: null,
  requestId: null,
  kind: "decision",
  question: "Which way?",
  answer: null,
  createdAt: "2026-09-13T01:00:00.000Z",
  ...overrides,
});

const board = (overrides: Partial<AssistantBoard> = {}): AssistantBoard => ({
  setups: [],
  projects: [project()],
  tasks: [],
  decisions: [],
  ...overrides,
});

describe("project status text", () => {
  it("reads a waiting note as progress, not a failure", () => {
    const waiting = project({ error: "Waiting: staging deploy run 123 is in progress" });
    expect(projectWaitingReason(waiting)).toBe("staging deploy run 123 is in progress");
    expect(projectFailure(waiting)).toBeNull();
  });

  it("treats any other note as the reason the queue stopped", () => {
    const failed = project({ status: "stopped", error: "The assistant thread was deleted." });
    expect(projectFailure(failed)).toBe("The assistant thread was deleted.");
    expect(
      describeProjectActivity({ project: failed, activeTask: null, coordinatorBusy: false }),
    ).toMatchObject({ tone: "attention", status: "Paused" });
  });

  it("ignores a stale waiting note once the queue is stopped", () => {
    const stopped = project({ status: "stopped", error: "Waiting: deploy" });
    expect(projectWaitingReason(stopped)).toBeNull();
    expect(
      describeProjectActivity({ project: stopped, activeTask: null, coordinatorBusy: false }).tone,
    ).toBe("paused");
  });

  it("prefers what the assistant is doing over what it is waiting on", () => {
    const active = task();
    const running = project({ error: "Waiting: deploy" });
    expect(
      describeProjectActivity({ project: running, activeTask: active, coordinatorBusy: true })
        .headline,
    ).toBe("Assistant is thinking");
    expect(
      describeProjectActivity({ project: running, activeTask: active, coordinatorBusy: false }),
    ).toMatchObject({ tone: "waiting", detail: "deploy" });
    expect(
      describeProjectActivity({ project: project(), activeTask: active, coordinatorBusy: false })
        .headline,
    ).toBe(`Working on ${active.issue.identifier}`);
  });
});

describe("describeTaskPhase", () => {
  const base = { workerBusy: false, workerNeedsInput: false, step: null, hasOpenDecision: false };

  it("separates a coding worker from one waiting on the assistant", () => {
    expect(
      describeTaskPhase({ ...base, task: task(), workerBusy: true, step: "Run tests" }),
    ).toEqual({ tone: "active", label: "Coding", detail: "Run tests" });
    expect(describeTaskPhase({ ...base, task: task() }).label).toBe("With the assistant");
  });

  it("points at the inbox only when a decision there is open", () => {
    const waiting = task({ status: "waiting" });
    expect(describeTaskPhase({ ...base, task: waiting, hasOpenDecision: true }).label).toBe(
      "Waiting for your answer",
    );
    expect(describeTaskPhase({ ...base, task: waiting }).label).toBe("Waiting for input");
  });

  it("carries the blocker's reason", () => {
    expect(
      describeTaskPhase({ ...base, task: task({ status: "blocked", error: "Worker stopped." }) }),
    ).toEqual({ tone: "blocked", label: "Blocked", detail: "Worker stopped." });
  });
});

describe("buildInbox", () => {
  it("puts blocking items before reviews, oldest first", () => {
    const review = task({ status: "review", updatedAt: "2026-09-13T00:30:00.000Z" });
    const later = decision({ id: "later", createdAt: "2026-09-13T02:00:00.000Z" });
    const earlier = decision({ id: "earlier", createdAt: "2026-09-13T01:00:00.000Z" });
    const items = buildInbox(board({ tasks: [review], decisions: [later, earlier] }));
    expect(items.map((item) => item.key)).toEqual([
      "decision:earlier",
      "decision:later",
      `review:${review.id}`,
    ]);
  });

  it("skips answered decisions", () => {
    expect(buildInbox(board({ decisions: [decision({ answer: "yes" })] }))).toEqual([]);
  });

  it("leaves a blocked issue to a running assistant with rounds to spend", () => {
    expect(buildInbox(board({ tasks: [task({ status: "blocked", error: "x" })] }))).toEqual([]);
  });

  it("hands a blocked issue to the person when no rounds or no assistant remain", () => {
    const exhausted = task({ status: "blocked", turns: 6, turnLimit: 6 });
    expect(buildInbox(board({ tasks: [exhausted] }))).toMatchObject([
      { kind: "stuck", reason: "rounds" },
    ]);
    const held = task({ status: "blocked", error: "Interrupted by you." });
    expect(
      buildInbox(board({ projects: [project({ status: "stopped" })], tasks: [held] })),
    ).toMatchObject([{ kind: "stuck", reason: "stopped" }]);
  });

  it("reports a failed queue once, as the paused project", () => {
    const failed = project({ status: "stopped", error: "The assistant thread was deleted." });
    const held = task({ status: "blocked", error: "The worker thread was deleted." });
    expect(buildInbox(board({ projects: [failed], tasks: [held] }))).toMatchObject([
      { kind: "paused" },
    ]);
  });

  it("lists setups only once their proposal is ready", () => {
    const setup = {
      preferences: {} as never,
      threadId: ThreadId.make("assistant-setup-1"),
      proposal: null,
      summary: "",
      revision: 0,
    };
    expect(buildInbox(board({ setups: [setup] }))).toEqual([]);
    expect(
      buildInbox(board({ setups: [{ ...setup, proposal: project().config, revision: 1 }] })),
    ).toMatchObject([{ kind: "setup" }]);
  });
});

describe("historyTasks", () => {
  it("lists finished work, newest first", () => {
    const old = task({ status: "accepted", updatedAt: "2026-09-12T00:00:00.000Z" });
    const recent = task({ status: "skipped", updatedAt: "2026-09-13T00:00:00.000Z" });
    const active = task({ status: "working" });
    expect(historyTasks(board({ tasks: [old, active, recent] })).map((t) => t.id)).toEqual([
      recent.id,
      old.id,
    ]);
  });
});

describe("decisionOptions", () => {
  it("reads numbered choices under an Options heading", () => {
    const question = [
      "SPI-99 is merged but I can't log in to staging.",
      "",
      "Options:",
      "1. **Recommended:** make AgentMail readable for T3 sessions: `AGENTMAIL_API_KEY` in the",
      "   environment of the service. I would then log in.",
      "2. Release SPI-99 on the evidence above plus the worker's local proof: every phase.",
      "",
      "Separately, FYI: 3. is not an option.",
    ].join("\n");
    expect(decisionOptions(question)).toEqual([
      { number: 1, label: "Make AgentMail readable for T3 sessions", recommended: true },
      {
        number: 2,
        label: "Release SPI-99 on the evidence above plus the worker's…",
        recommended: false,
      },
    ]);
  });

  it("ignores numbered lists that are not offered as options", () => {
    const question = [
      "Proposed rules once the grace period ends:",
      "1. Custom scripts stop loading",
      "2. Collaborators lose access",
    ].join("\n");
    expect(decisionOptions(question)).toEqual([]);
  });

  it("needs at least two choices", () => {
    expect(decisionOptions("Options:\n1. Only this")).toEqual([]);
  });
});
