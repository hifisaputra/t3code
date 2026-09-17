import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  assistantTeamThread,
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
  describeE2ePlan,
  describeProjectActivity,
  describeTaskPhase,
  e2eDepthChange,
  historyTasks,
  instructionSections,
  previewLine,
  projectFailure,
  projectLimitHold,
  projectWaitingReason,
  taskOutcome,
  teamRoleOrder,
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
  threadId: ThreadId.make("assistant-lead-task-1"),
  taskId: "task-1",
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
    const failed = project({ status: "stopped", error: "Linear rejected the API key" });
    expect(projectFailure(failed)).toBe("Linear rejected the API key");
    expect(describeProjectActivity({ project: failed, activeTasks: [] })).toMatchObject({
      tone: "attention",
      status: "Stopped",
    });
    // Three declines in a row pause the loop with a reason, and the pill says so.
    const paused = project({ status: "paused", error: "Team leaders declined 3 issues in a row" });
    expect(describeProjectActivity({ project: paused, activeTasks: [] })).toMatchObject({
      tone: "attention",
      status: "Paused",
    });
    expect(buildInbox(board({ projects: [paused] }))).toMatchObject([{ kind: "paused" }]);
  });

  it("a paused loop still shows its team at work", () => {
    const active = task();
    const paused = project({ status: "paused" });
    expect(describeProjectActivity({ project: paused, activeTasks: [active] })).toMatchObject({
      tone: "active",
      status: "Paused",
      headline: `Working on ${active.issue.identifier}`,
    });
    expect(describeProjectActivity({ project: paused, activeTasks: [] })).toMatchObject({
      tone: "paused",
      headline: "Taking only issues you dispatch",
    });
  });

  it("names the issues a project holds, and counts them once there are several", () => {
    const one = task();
    const two = task();
    const three = task();
    expect(
      describeProjectActivity({
        project: project(),
        activeTasks: [one, two],
      }),
    ).toMatchObject({
      headline: `Working on ${one.issue.identifier} and ${two.issue.identifier}`,
    });
    expect(
      describeProjectActivity({
        project: project(),
        activeTasks: [one, two, three],
      }),
    ).toMatchObject({
      headline: "Working on 3 issues",
      detail: `${one.issue.identifier}, ${two.issue.identifier} and ${three.issue.identifier}`,
    });
    expect(
      describeProjectActivity({
        project: project({ status: "stopped" }),
        activeTasks: [one, two],
      }),
    ).toMatchObject({
      headline: `Holding ${one.issue.identifier} and ${two.issue.identifier}`,
      detail:
        "Their teams are stopped. Start, or resume the teams from the menu, to continue them.",
    });
  });

  it("says a running loop with automatic picking off is waiting on a dispatch", () => {
    const manual = project({ autoPick: false });
    expect(describeProjectActivity({ project: manual, activeTasks: [] })).toMatchObject({
      tone: "idle",
      status: "Running",
      headline: "Waiting for you to dispatch an issue",
    });
    // A deliberate choice, so nothing in the inbox asks about it.
    expect(buildInbox(board({ projects: [manual] }))).toEqual([]);
    // Its team at work still outranks the setting.
    const active = task();
    expect(describeProjectActivity({ project: manual, activeTasks: [active] })).toMatchObject({
      tone: "active",
      headline: `Working on ${active.issue.identifier}`,
    });
    // Automatic picking on is the default, and a paused loop keeps its own text.
    expect(describeProjectActivity({ project: project(), activeTasks: [] }).headline).toBe(
      "Watching for issues",
    );
    expect(
      describeProjectActivity({
        project: project({ status: "paused", autoPick: false }),
        activeTasks: [],
      }),
    ).toMatchObject({ tone: "paused", headline: "Taking only issues you dispatch" });
  });

  it("ignores a stale waiting note once the queue is stopped", () => {
    const stopped = project({ status: "stopped", error: "Waiting: deploy" });
    expect(projectWaitingReason(stopped)).toBeNull();
    expect(describeProjectActivity({ project: stopped, activeTasks: [] }).tone).toBe("paused");
  });

  it("names what the project waits on ahead of the issues it holds", () => {
    const active = task();
    const running = project({ error: "Waiting: deploy" });
    expect(describeProjectActivity({ project: running, activeTasks: [active] })).toMatchObject({
      tone: "waiting",
      detail: "deploy",
    });
    expect(describeProjectActivity({ project: project(), activeTasks: [active] }).headline).toBe(
      `Working on ${active.issue.identifier}`,
    );
  });

  it("says a usage limit holds the project, and names when it resets", () => {
    const nowMs = Date.parse("2026-09-14T13:00:00.000Z");
    const limited = project({ limitedUntil: "2026-09-14T15:00:00.000Z" });
    expect(projectLimitHold(limited, nowMs)).toBe("2026-09-14T15:00:00.000Z");
    // The threads are idle because of the limit, so the hold outranks the
    // issues its teams still hold.
    expect(
      describeProjectActivity({
        project: limited,
        activeTasks: [task()],
        limitResumesAt: "3:00 PM",
        nowMs,
      }),
    ).toEqual({
      tone: "waiting",
      status: "Running",
      headline: "Waiting for Claude's usage limit to reset",
      detail: "Work continues by itself once it resets at 3:00 PM. Start now to try sooner.",
    });
    // A paused loop keeps its own pill while it waits out the same limit.
    expect(
      describeProjectActivity({
        project: project({ status: "paused", limitedUntil: "2026-09-14T15:00:00.000Z" }),
        activeTasks: [],
        nowMs,
      }),
    ).toMatchObject({
      tone: "waiting",
      status: "Paused",
      detail: "Work continues by itself once it resets. Start now to try sooner.",
    });
  });

  it("ignores a usage limit that has passed, or one on a stopped project", () => {
    const nowMs = Date.parse("2026-09-14T13:00:00.000Z");
    // The server leaves the stamp in place once it has told the threads to continue.
    const past = project({ limitedUntil: "2026-09-14T12:00:00.000Z" });
    expect(projectLimitHold(past, nowMs)).toBeNull();
    expect(describeProjectActivity({ project: past, activeTasks: [], nowMs }).headline).toBe(
      "Watching for issues",
    );
    const stopped = project({ status: "stopped", limitedUntil: "2026-09-14T15:00:00.000Z" });
    expect(projectLimitHold(stopped, nowMs)).toBeNull();
    expect(describeProjectActivity({ project: stopped, activeTasks: [], nowMs })).toMatchObject({
      tone: "paused",
      status: "Stopped",
      headline: "Stopped",
    });
  });

  it("shows a failure ahead of a usage limit", () => {
    const nowMs = Date.parse("2026-09-14T13:00:00.000Z");
    const broken = project({
      error: "Linear rejected the API key",
      limitedUntil: "2026-09-14T15:00:00.000Z",
    });
    expect(
      describeProjectActivity({
        project: broken,
        activeTasks: [],
        limitResumesAt: "3:00 PM",
        nowMs,
      }),
    ).toMatchObject({
      tone: "attention",
      headline: "Stuck on a problem",
      detail: "Linear rejected the API key",
    });
  });
});

describe("describeTaskPhase", () => {
  const base = { workerBusy: false, workerNeedsInput: false, step: null, hasOpenDecision: false };

  it("separates a coding worker from one whose turn has ended", () => {
    expect(
      describeTaskPhase({ ...base, task: task(), workerBusy: true, step: "Run tests" }),
    ).toEqual({ tone: "active", label: "Coding", detail: "Run tests" });
    expect(describeTaskPhase({ ...base, task: task() }).label).toBe("Worker is next");
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
      stage: "lead",
      merge: { commit: "a".repeat(40), summary: "Fixed", at: "2026-09-13T00:00:00.000Z" },
    });
    expect(describeTaskPhase({ ...base, task: merged }).detail).toBe(
      "Merged after code review. The team leader is checking the staging deploy.",
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
      "Worker is next",
    );
  });

  it("says what a team leader waits on, with how many checks it has had", () => {
    const waiting = task({
      stage: "lead",
      turns: 1,
      wait: { reason: "the staging deploy is running", checks: 3, notified: true },
    });
    expect(describeTaskPhase({ ...base, task: waiting })).toEqual({
      tone: "waiting",
      label: "Waiting on something",
      detail: "the staging deploy is running · check 3 of 15",
    });
    // A leader mid-turn is working again, not waiting.
    expect(describeTaskPhase({ ...base, task: waiting, workerBusy: true }).label).toBe(
      "Team leader is deciding",
    );
  });

  it("says where the e2e check runs", () => {
    expect(
      describeTaskPhase({ ...base, task: task({ stage: "e2e" }), workerBusy: true }).label,
    ).toBe("Testing on staging");
    expect(
      describeTaskPhase({
        ...base,
        task: task({ stage: "e2e", e2eEnvironment: "worktree" }),
        workerBusy: true,
      }).label,
    ).toBe("Testing in the worktree");
    const failed = task({
      stage: "lead",
      turns: 1,
      e2eEnvironment: "worktree",
      e2e: {
        verdict: "failed",
        report: "",
        humanChecks: [],
        screenshots: [],
        at: "2026-09-13T00:00:00.000Z",
        environment: "worktree",
      },
    });
    expect(describeTaskPhase({ ...base, task: failed }).detail).toBe(
      "It failed in the worktree. The team leader is deciding on a fix.",
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

describe("e2e depth", () => {
  const at = "2026-09-13T00:00:00.000Z";
  const run = (verdict: "passed" | "failed") =>
    ({ verdict, report: "", humanChecks: [], screenshots: [], at }) as const;

  it("says how deep the test goes, who set it, and why", () => {
    expect(describeE2ePlan(task())).toBeNull();
    expect(describeE2ePlan(task({ e2ePlan: { brief: "Open /billing" } }))).toEqual({
      depth: "full",
      label: "Full test",
      setBy: null,
      detail: null,
    });
    expect(
      describeE2ePlan(
        task({
          criteria: ["One", "Two", "Three"],
          e2ePlan: { brief: "", depth: "smoke", smokeCriteria: [3, 1], depthSetBy: "review" },
        }),
      ),
    ).toMatchObject({
      label: "Smoke test",
      setBy: "Raised by code review",
      detail: "Criteria 1, 3",
    });
    expect(
      describeE2ePlan(task({ criteria: ["One"], e2ePlan: { brief: "", depth: "smoke" } }))?.detail,
    ).toBe("All criteria");
    expect(
      describeE2ePlan(
        task({ e2ePlan: { brief: "", depth: "none", reason: "CI only", depthSetBy: "person" } }),
      ),
    ).toMatchObject({ label: "No e2e test", setBy: "Set by you", detail: "CI only" });
  });

  it("lets the person change the depth only until a test starts or passes", () => {
    const e2ePlan = { brief: "" };
    expect(e2eDepthChange(task({ stage: "implement", e2ePlan })).allowed).toBe(true);
    expect(e2eDepthChange(task({ stage: "implement" })).allowed).toBe(false);
    expect(e2eDepthChange(task({ stage: "e2e", e2ePlan }))).toEqual({
      allowed: false,
      reason: "The e2e test is running.",
    });
    expect(e2eDepthChange(task({ stage: "lead", e2ePlan, e2e: run("passed") })).allowed).toBe(
      false,
    );
    // A failed run goes back to the worker, and the next run can still change.
    expect(e2eDepthChange(task({ stage: "implement", e2ePlan, e2e: run("failed") })).allowed).toBe(
      true,
    );
    expect(e2eDepthChange(task({ status: "review", stage: "lead", e2ePlan })).allowed).toBe(false);
  });

  it("does not wait for a worktree e2e check that will not run", () => {
    const base = { workerBusy: false, workerNeedsInput: false, step: null, hasOpenDecision: false };
    const commit = "a".repeat(40);
    const codeReview = { verdict: "approved", findings: "", summary: "", commit, at } as const;
    const worktree = (depth: "full" | "none") =>
      task({
        stage: "lead",
        turns: 1,
        e2eEnvironment: "worktree",
        e2ePlan: { brief: "", depth },
        codeReview,
      });
    expect(describeTaskPhase({ ...base, task: worktree("full") }).detail).toBe(
      "Code review approved the change. The team leader starts the e2e check in the worktree.",
    );
    expect(describeTaskPhase({ ...base, task: worktree("none") }).detail).toBe(
      "The team leader is deciding the next step.",
    );
    const merged = { ...worktree("none"), merge: { commit, summary: "Fixed", at } };
    expect(describeTaskPhase({ ...base, task: merged }).detail).toBe(
      "Merged after code review. The team leader is checking the staging deploy.",
    );
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
    const failed = project({ status: "stopped", error: "Linear rejected the API key" });
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
    expect(describeProjectActivity({ project: stuck, activeTasks: [] })).toMatchObject({
      tone: "attention",
      status: "Running",
      headline: "Stuck on a problem",
      detail: "Linear rejected the API key.",
    });
    // A waiting note on a running project is progress, and stays out of the inbox.
    const waiting = project({ error: "Waiting: staging deploy is running" });
    expect(buildInbox(board({ projects: [waiting] }))).toEqual([]);
    expect(describeProjectActivity({ project: waiting, activeTasks: [] })).toMatchObject({
      tone: "waiting",
      detail: "staging deploy is running",
    });
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
  it("tells setup and each issue thread apart by id", () => {
    const id = "8d0c8385-df68-422e-b90a-db197f3c0263";
    // The retired assistant chat thread is an ordinary thread now.
    expect(assistantThreadKind(`assistant-${id}`)).toBeNull();
    expect(assistantThreadKind(`assistant-work-${id}`)).toBe("implement");
    expect(assistantThreadKind(`assistant-review-${id}`)).toBe("review");
    expect(assistantThreadKind(`assistant-e2e-${id}`)).toBe("e2e");
    expect(assistantThreadKind(`assistant-setup-${id}`)).toBe("setup");
    expect(assistantThreadKind(id)).toBeNull();
  });
});

describe("assistantTeamThread", () => {
  it("names the issue and the role behind each of a team's four thread ids", () => {
    const id = "8d0c8385-df68-422e-b90a-db197f3c0263";
    expect(assistantTeamThread(`assistant-lead-${id}`)).toEqual({ taskId: id, role: "lead" });
    expect(assistantTeamThread(`assistant-work-${id}`)).toEqual({ taskId: id, role: "implement" });
    expect(assistantTeamThread(`assistant-review-${id}`)).toEqual({ taskId: id, role: "review" });
    expect(assistantTeamThread(`assistant-e2e-${id}`)).toEqual({ taskId: id, role: "e2e" });
  });

  it("claims no thread that is not one of a team's", () => {
    const id = "8d0c8385-df68-422e-b90a-db197f3c0263";
    expect(assistantTeamThread(`assistant-${id}`)).toBeNull();
    expect(assistantTeamThread(`assistant-setup-${id}`)).toBeNull();
    expect(assistantTeamThread(id)).toBeNull();
  });
});

describe("teamRoleOrder", () => {
  it("runs from the team leader to the e2e tester, the way the work does", () => {
    expect(teamRoleOrder).toEqual(["lead", "implement", "review", "e2e"]);
  });
});

describe("taskOutcome", () => {
  it("quotes the words the person or the team leader left with the issue", () => {
    expect(taskOutcome(task({ status: "accepted", deliveredState: "Done" }))).toEqual({
      label: "Accepted",
      detail: "Left in Done in Linear.",
    });
    expect(
      taskOutcome(task({ status: "changes-requested", feedback: "  Fix the empty state  " })),
    ).toEqual({ label: "Sent back for changes", detail: "Fix the empty state" });
    expect(
      taskOutcome(
        task({
          status: "declined",
          declined: {
            reason: "The issue has no acceptance criteria.",
            fingerprint: "f",
            issueUpdatedAt: "2026-09-13T00:00:00.000Z",
            at: "2026-09-13T00:00:00.000Z",
          },
        }),
      ),
    ).toEqual({ label: "Declined", detail: "The issue has no acceptance criteria." });
    expect(
      taskOutcome(task({ status: "skipped", feedback: "Skipped from the assistant board." })),
    ).toEqual({ label: "Skipped", detail: "Skipped from the assistant board." });
  });

  it("has no detail when nothing was written down", () => {
    expect(taskOutcome(task({ status: "accepted" }))).toEqual({ label: "Accepted", detail: null });
    expect(taskOutcome(task({ status: "changes-requested", feedback: "   " }))).toEqual({
      label: "Sent back for changes",
      detail: null,
    });
  });

  it("says an unfinished issue is still in progress", () => {
    expect(taskOutcome(task({ status: "working" })).label).toBe("Still in progress");
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

describe("instructionSections", () => {
  it("gives the whole budget to a setup written before sections existed", () => {
    expect(instructionSections({ instructions: "  Ship carefully.  " })).toEqual([
      {
        key: "shared",
        label: "Shared policy",
        text: "Ship carefully.",
        length: 15,
        budget: 20000,
        over: false,
      },
    ]);
  });

  it("lists the sections that have text, shared policy first and on the shared budget", () => {
    const sections = instructionSections({
      instructions: "Shared",
      roleInstructions: {
        e2e: "Sign in as the test account",
        lead: "Take small issues",
        review: " ",
      },
    });
    expect(sections.map((section) => [section.key, section.label, section.budget])).toEqual([
      ["shared", "Shared policy", 4000],
      ["lead", "Team leader", 6000],
      ["e2e", "E2E tester", 6000],
    ]);
  });

  it("marks a section over its budget", () => {
    const sections = instructionSections({
      instructions: "x".repeat(4001),
      roleInstructions: { implement: "y".repeat(6001), review: "fine" },
    });
    expect(sections.map((section) => [section.key, section.over])).toEqual([
      ["shared", true],
      ["implement", true],
      ["review", false],
    ]);
  });
});
