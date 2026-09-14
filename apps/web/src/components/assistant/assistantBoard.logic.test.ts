import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  assistantThreadKind,
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
  previewLine,
  projectFailure,
  projectWaitingReason,
  taskPipeline,
} from "./assistantBoard.logic";

const projectId = ProjectId.make("project-1");

const project = ({
  autoPick,
  ...overrides
}: Partial<AssistantProject> & { autoPick?: boolean } = {}): AssistantProject => ({
  config: {
    projectId,
    linearProjectId: "linear-project",
    assignedToMe: false,
    ...(autoPick === undefined ? {} : { autoPick }),
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
    ).toMatchObject({ tone: "attention", status: "Stopped" });
    // Three declines in a row pause the loop with a reason, and the pill says so.
    const paused = project({ status: "paused", error: "Team leaders declined 3 issues in a row" });
    expect(
      describeProjectActivity({ project: paused, activeTask: null, coordinatorBusy: false }),
    ).toMatchObject({ tone: "attention", status: "Paused" });
    expect(buildInbox(board({ projects: [paused] }))).toMatchObject([{ kind: "paused" }]);
  });

  it("a paused loop still shows its team at work", () => {
    const active = task();
    const paused = project({ status: "paused" });
    expect(
      describeProjectActivity({ project: paused, activeTask: active, coordinatorBusy: false }),
    ).toMatchObject({
      tone: "active",
      status: "Paused",
      headline: `Working on ${active.issue.identifier}`,
    });
    expect(
      describeProjectActivity({ project: paused, activeTask: null, coordinatorBusy: false }),
    ).toMatchObject({ tone: "paused", headline: "Taking only issues you dispatch" });
  });

  it("says a running loop with automatic picking off is waiting on a dispatch", () => {
    const manual = project({ autoPick: false });
    expect(
      describeProjectActivity({ project: manual, activeTask: null, coordinatorBusy: false }),
    ).toMatchObject({
      tone: "idle",
      status: "Running",
      headline: "Waiting for you to dispatch an issue",
    });
    // A deliberate choice, so nothing in the inbox asks about it.
    expect(buildInbox(board({ projects: [manual] }))).toEqual([]);
    // Its team at work still outranks the setting.
    const active = task();
    expect(
      describeProjectActivity({ project: manual, activeTask: active, coordinatorBusy: false }),
    ).toMatchObject({ tone: "active", headline: `Working on ${active.issue.identifier}` });
    // Automatic picking on is the default, and a paused loop keeps its own text.
    expect(
      describeProjectActivity({ project: project(), activeTask: null, coordinatorBusy: false })
        .headline,
    ).toBe("Watching for issues");
    expect(
      describeProjectActivity({
        project: project({ status: "paused", autoPick: false }),
        activeTask: null,
        coordinatorBusy: false,
      }),
    ).toMatchObject({ tone: "paused", headline: "Taking only issues you dispatch" });
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

  it("names the thread that holds the issue", () => {
    expect(
      describeTaskPhase({ ...base, task: task({ stage: "review" }), workerBusy: true }).label,
    ).toBe("In code review");
    expect(describeTaskPhase({ ...base, task: task({ stage: "e2e" }) }).label).toBe(
      "E2E check is next",
    );
    expect(
      describeTaskPhase({ ...base, task: task({ stage: "e2e" }), workerNeedsInput: true }).detail,
    ).toBe("The e2e tester asked something in its thread.");
    const merged = task({
      stage: "coordinator",
      merge: { commit: "a".repeat(40), summary: "Fixed", at: "2026-09-13T00:00:00.000Z" },
    });
    expect(describeTaskPhase({ ...base, task: merged }).detail).toBe(
      "Merged after code review. The assistant is checking the staging deploy.",
    );
  });

  it("names the teammate whose turn or leftover work holds the handoff", () => {
    const coding = task({ stage: "implement" });
    const phase = describeTaskPhase({ ...base, task: coding, waitingOn: "review" });
    expect(phase.label).toBe("Waiting for the code reviewer");
    expect(phase.detail).toContain("The worker starts when the code reviewer's turn");
    // A holder at work is never waiting, and work without a team has no teammates.
    expect(
      describeTaskPhase({ ...base, task: coding, workerBusy: true, waitingOn: "review" }).label,
    ).toBe("Coding");
    expect(describeTaskPhase({ ...base, task: task(), waitingOn: "review" }).label).toBe(
      "With the assistant",
    );
  });

  it("puts an open question ahead of the state the issue was left in", () => {
    const blocked = task({ status: "blocked", error: "The worker stopped before delivery." });
    expect(describeTaskPhase({ ...base, task: blocked, hasOpenDecision: true }).label).toBe(
      "Waiting for your answer",
    );
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

  it("leaves the last round alone while it is still running", () => {
    // The server counts the round before it sends that round's message, so a
    // worker on its last round sits at turns === turnLimit mid-edit.
    const lastRound = task({ status: "working", turns: 6, turnLimit: 6 });
    expect(buildInbox(board({ tasks: [lastRound] }))).toEqual([]);
    const waiting = task({ status: "waiting", turns: 6, turnLimit: 6 });
    expect(buildInbox(board({ tasks: [waiting] }))).toEqual([]);
  });

  it("reports a failed queue once, as the paused project", () => {
    const failed = project({ status: "stopped", error: "The assistant thread was deleted." });
    const held = task({ status: "blocked", error: "The worker thread was deleted." });
    expect(buildInbox(board({ projects: [failed], tasks: [held] }))).toMatchObject([
      { kind: "paused" },
    ]);
  });

  it("reports a running loop that cannot advance", () => {
    // The scan writes the reason on a running project and clears it only on the
    // next scan that works, so the person has to see it meanwhile.
    const stuck = project({ error: "Linear rejected the API key." });
    expect(buildInbox(board({ projects: [stuck] }))).toMatchObject([
      { kind: "paused", reason: "Linear rejected the API key." },
    ]);
    expect(
      describeProjectActivity({ project: stuck, activeTask: null, coordinatorBusy: false }),
    ).toMatchObject({
      tone: "attention",
      status: "Running",
      headline: "Stuck on a problem",
      detail: "Linear rejected the API key.",
    });
    // A waiting note on a running project is progress, and stays out of the inbox.
    const waiting = project({ error: "Waiting: staging deploy is running" });
    expect(buildInbox(board({ projects: [waiting] }))).toEqual([]);
    expect(
      describeProjectActivity({ project: waiting, activeTask: null, coordinatorBusy: false }),
    ).toMatchObject({ tone: "waiting", detail: "staging deploy is running" });
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

describe("taskPipeline", () => {
  const commit = "a".repeat(40);
  const at = "2026-09-13T00:00:00.000Z";
  const states = (t: AssistantTask) =>
    taskPipeline(t)
      ?.map((step) => `${step.key}:${step.state}`)
      .join(" ");
  const approved = {
    codeReview: { verdict: "approved", findings: "", summary: "", commit, at },
  } as const;
  const merged = { ...approved, merge: { commit, summary: "Fixed", at } };
  const deployed = {
    ...merged,
    deployment: { revision: commit, url: "https://staging.example.com", verifiedAt: at },
  };

  it("follows the issue from code to e2e", () => {
    expect(states(task({ stage: "implement" }))).toBe(
      "code:current review:todo merge:todo staging:todo e2e:todo",
    );
    expect(states(task({ stage: "review" }))).toBe(
      "code:done review:current merge:todo staging:todo e2e:todo",
    );
    expect(states(task({ stage: "implement", ...approved }))).toBe(
      "code:done review:done merge:current staging:todo e2e:todo",
    );
    expect(states(task({ stage: "coordinator", ...merged }))).toBe(
      "code:done review:done merge:done staging:current e2e:todo",
    );
    expect(states(task({ stage: "e2e", ...deployed }))).toBe(
      "code:done review:done merge:done staging:done e2e:current",
    );
  });

  it("marks review findings and a failed e2e run where they send the work", () => {
    const findings = task({
      stage: "implement",
      codeReview: { ...approved.codeReview, verdict: "changes-requested" },
    });
    expect(taskPipeline(findings)?.[1]).toMatchObject({ state: "todo", note: "Changes requested" });
    const e2e = { verdict: "failed", report: "", humanChecks: [], screenshots: [], at } as const;
    expect(taskPipeline(task({ stage: "coordinator", ...deployed, e2e }))?.[4]).toMatchObject({
      state: "failed",
      note: "Failed on staging",
    });
    // The fix goes back to the worker while the old merge and deployment stay on record.
    const fixing = task({ stage: "implement", ...deployed, e2e });
    expect(states(fixing)).toBe("code:current review:todo merge:todo staging:todo e2e:todo");
    expect(taskPipeline(fixing)?.[0]?.note).toBe("Fixing the e2e failure");
  });

  it("starts with the team leader taking the issue, and gives it staging", () => {
    const led = (overrides: Partial<AssistantTask>) => task({ leader: true, ...overrides });
    expect(states(led({ stage: "lead", turns: 0 }))).toBe(
      "take:current code:todo review:todo merge:todo staging:todo e2e:todo",
    );
    expect(states(led({ stage: "implement", turns: 1 }))).toBe(
      "take:done code:current review:todo merge:todo staging:todo e2e:todo",
    );
    const staging = taskPipeline(led({ stage: "lead", turns: 1, ...merged }))?.[4];
    expect(staging).toMatchObject({ key: "staging", state: "current", kind: "lead" });
    const e2e = { verdict: "failed", report: "", humanChecks: [], screenshots: [], at } as const;
    expect(taskPipeline(led({ stage: "lead", turns: 1, ...deployed, e2e }))?.[5]).toMatchObject({
      state: "failed",
      note: "Failed on staging",
    });
  });

  it("has none for work started before issues had review and e2e threads", () => {
    expect(taskPipeline(task())).toBeNull();
  });
});

describe("previewLine", () => {
  it("takes the first line as plain text", () => {
    expect(previewLine("\n**SPI-134:** the fix is [done](https://x.test) in `a.ts`.\nMore")).toBe(
      "SPI-134: the fix is done in a.ts.",
    );
    expect(previewLine("Options:\n1. **Recommended:** fix it here")).toBe(
      "Recommended: fix it here",
    );
  });
});

describe("assistantThreadKind", () => {
  it("tells the coordinator, setup and each issue thread apart by id", () => {
    const id = "8d0c8385-df68-422e-b90a-db197f3c0263";
    expect(assistantThreadKind(`assistant-${id}`)).toBe("coordinator");
    expect(assistantThreadKind(`assistant-work-${id}`)).toBe("implement");
    expect(assistantThreadKind(`assistant-review-${id}`)).toBe("review");
    expect(assistantThreadKind(`assistant-e2e-${id}`)).toBe("e2e");
    expect(assistantThreadKind(`assistant-setup-${id}`)).toBe("setup");
    expect(assistantThreadKind(id)).toBeNull();
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
