import {
  assistantPicksIssues,
  assistantTaskHoldsProject,
  type AssistantBoard,
  type AssistantDecision,
  type AssistantProject,
  type AssistantSetup,
  type AssistantTask,
  type AssistantThreadKind,
  type AssistantThreadRole,
  type ProjectId,
} from "@t3tools/contracts";

/**
 * The server keeps one free-text slot per project and uses it for two things:
 * a real failure that paused or stopped it, and a team leader's note while it
 * waits on something outside T3 ("Waiting: staging deploy is running"). Only
 * the first is worth an alarm.
 */
const WAITING_PREFIX = "Waiting: ";

export function projectWaitingReason(project: AssistantProject): string | null {
  return project.status !== "stopped" && project.error?.startsWith(WAITING_PREFIX)
    ? project.error.slice(WAITING_PREFIX.length).trim() || null
    : null;
}

export function projectFailure(project: AssistantProject): string | null {
  if (!project.error || project.error.startsWith(WAITING_PREFIX)) return null;
  return project.error;
}

export type ProjectActivityTone = "active" | "idle" | "waiting" | "paused" | "attention";

export interface ProjectActivity {
  readonly tone: ProjectActivityTone;
  /** The status pill: Running, Paused, Stopped. */
  readonly status: string;
  /** One line of what is happening right now. */
  readonly headline: string;
  readonly detail: string | null;
}

export function describeProjectActivity(input: {
  project: AssistantProject;
  activeTask: AssistantTask | null;
  coordinatorBusy: boolean;
}): ProjectActivity {
  const { project, activeTask, coordinatorBusy } = input;
  // A running loop records a failure too, when its scan cannot advance (a
  // revoked Linear key, a state name that no longer exists). It clears only on
  // the next scan that works, so the person has to see it meanwhile.
  const failure = projectFailure(project);
  if (project.status === "stopped")
    return failure
      ? { tone: "attention", status: "Stopped", headline: "Stopped by a problem", detail: failure }
      : {
          tone: "paused",
          status: "Stopped",
          headline: activeTask ? `Holding ${activeTask.issue.identifier}` : "Stopped",
          detail: activeTask
            ? "Its team is stopped. Start, or resume the teams from the menu, to continue it."
            : "Start to take issues from Linear, or resume the teams and dispatch issues yourself.",
        };
  const status = project.status === "paused" ? "Paused" : "Running";
  if (failure)
    return {
      tone: "attention",
      status,
      headline: project.status === "running" ? "Stuck on a problem" : "Loop paused by a problem",
      detail: failure,
    };
  const waiting = projectWaitingReason(project);
  if (coordinatorBusy)
    return {
      tone: "active",
      status,
      headline: "Assistant is thinking",
      detail: activeTask ? `${activeTask.issue.identifier} · ${activeTask.issue.title}` : null,
    };
  if (waiting)
    return {
      tone: "waiting",
      status,
      headline: "Waiting on something",
      detail: waiting,
    };
  if (activeTask)
    return {
      tone: "active",
      status,
      headline: `Working on ${activeTask.issue.identifier}`,
      detail: activeTask.issue.title,
    };
  if (project.status === "paused")
    return {
      tone: "paused",
      status,
      headline: "Taking only issues you dispatch",
      detail: "Start to let it pick issues from Linear again.",
    };
  // Started with automatic picking off: idle is the choice the person made, not
  // a queue that ran dry, so it is never an alarm.
  if (!assistantPicksIssues(project.config))
    return {
      tone: "idle",
      status,
      headline: "Waiting for you to dispatch an issue",
      detail:
        "It picks nothing from Linear. Dispatch an issue, or start again with automatic picking.",
    };
  return {
    tone: "idle",
    status,
    headline: "Watching for issues",
    detail: "Nothing is ready to pick up. The assistant starts on the next issue that is.",
  };
}

export type TaskPhaseTone = "active" | "waiting" | "blocked" | "idle";

export interface TaskPhase {
  readonly tone: TaskPhaseTone;
  readonly label: string;
  readonly detail: string | null;
}

const STAGE_THREAD: Record<string, string> = {
  lead: "team leader",
  implement: "worker",
  review: "code reviewer",
  e2e: "e2e tester",
};

/**
 * The phase of the issue's thread that holds it; `worker*` fields describe that
 * thread. `waitingOn` is a teammate still running, or with background work
 * left, that the handoff to the holder waits for.
 */
export function describeTaskPhase(input: {
  task: AssistantTask;
  workerBusy: boolean;
  workerNeedsInput: boolean;
  step: string | null;
  hasOpenDecision: boolean;
  waitingOn?: AssistantThreadRole | null;
}): TaskPhase {
  const { task, workerBusy, workerNeedsInput, step, hasOpenDecision, waitingOn } = input;
  const holder = STAGE_THREAD[task.stage ?? "implement"] ?? "worker";
  // A question outranks whatever state the issue was left in while it waits.
  if (hasOpenDecision && task.status !== "preparing")
    return { tone: "waiting", label: "Waiting for your answer", detail: null };
  switch (task.status) {
    case "preparing":
      return { tone: "active", label: "Preparing a worktree", detail: null };
    case "queued":
      return { tone: "idle", label: "Up next", detail: null };
    case "blocked":
      return { tone: "blocked", label: "Blocked", detail: task.error };
    case "waiting":
      return {
        tone: "waiting",
        label: "Waiting for input",
        detail: `The ${holder} asked something in its thread.`,
      };
    default:
      if (workerNeedsInput)
        return {
          tone: "waiting",
          label: "Waiting for input",
          detail: `The ${holder} asked something in its thread.`,
        };
      // The issue's threads share one worktree: a handoff waits for the rest of the team.
      if (!workerBusy && waitingOn && task.stage !== undefined)
        return {
          tone: "idle",
          label: `Waiting for the ${STAGE_THREAD[waitingOn]}`,
          detail: `The ${holder} starts when the ${STAGE_THREAD[waitingOn]}'s turn and background work end. T3 releases a finished thread's background work by itself.`,
        };
      switch (task.stage) {
        default:
          // Work started before issues had review and e2e threads.
          return workerBusy
            ? { tone: "active", label: "Coding", detail: step }
            : {
                tone: "idle",
                label: "With the assistant",
                detail: "The worker finished a round. The assistant is reviewing it.",
              };
        case "implement":
          if (workerBusy)
            return task.codeReview?.verdict === "approved"
              ? { tone: "active", label: "Merging", detail: "Code review approved the change." }
              : { tone: "active", label: "Coding", detail: step };
          return { tone: "idle", label: "Worker is next", detail: null };
        case "review":
          return workerBusy
            ? { tone: "active", label: "In code review", detail: step }
            : {
                tone: "idle",
                label: "Code review is next",
                detail: "The reviewer starts when the worker's turn ends.",
              };
        case "e2e":
          return workerBusy
            ? { tone: "active", label: "Testing on staging", detail: step }
            : { tone: "idle", label: "E2E check is next", detail: null };
        case "lead":
          if (workerBusy)
            return {
              tone: "active",
              label: task.turns === 0 ? "Reading the issue" : "Team leader is deciding",
              detail: step,
            };
          return {
            tone: "idle",
            label: "With the team leader",
            detail:
              task.turns === 0
                ? "It decides whether the team takes the issue."
                : task.e2e?.verdict === "failed"
                  ? "It failed on staging. The team leader is deciding on a fix."
                  : task.merge && !task.deployment
                    ? "Merged after code review. The team leader is checking the staging deploy."
                    : "The team leader is deciding the next step.",
          };
        case "coordinator":
          return {
            tone: "idle",
            label: "With the assistant",
            detail:
              task.e2e?.verdict === "failed"
                ? "It failed on staging. The assistant is deciding on a fix."
                : task.merge && !task.deployment
                  ? "Merged after code review. The assistant is checking the staging deploy."
                  : "The assistant is deciding the next step.",
          };
      }
  }
}

export const taskRoundsExhausted = (task: AssistantTask) => task.turns >= task.turnLimit;

export type PipelineStepKey = "take" | "code" | "review" | "merge" | "staging" | "e2e";
export type PipelineStepState = "done" | "current" | "failed" | "todo";

export interface PipelineStep {
  readonly key: PipelineStepKey;
  readonly label: string;
  /** The thread that does this step. */
  readonly kind: AssistantThreadKind;
  readonly state: PipelineStepState;
  readonly note: string | null;
}

type PipelineStepDef = { key: PipelineStepKey; label: string; kind: AssistantThreadKind };

const TO_STAGING: ReadonlyArray<PipelineStepDef> = [
  { key: "code", label: "Code", kind: "implement" },
  { key: "review", label: "Code review", kind: "review" },
  { key: "merge", label: "Merge", kind: "implement" },
  { key: "staging", label: "Staging", kind: "lead" },
  { key: "e2e", label: "E2E test", kind: "e2e" },
];
const LED_PIPELINE: ReadonlyArray<PipelineStepDef> = [
  { key: "take", label: "Take on", kind: "lead" },
  ...TO_STAGING,
];
// Work from before team leaders: the assistant checked staging itself.
const ASSISTANT_PIPELINE = TO_STAGING.map((step) =>
  step.kind === "lead" ? { ...step, kind: "coordinator" as const } : step,
);

/**
 * Where an issue is on its way to staging, from what the server recorded.
 * Work started before issues had review and e2e threads has no pipeline.
 */
export function taskPipeline(task: AssistantTask): ReadonlyArray<PipelineStep> | null {
  if (task.stage === undefined) return null;
  const steps = task.leader ? LED_PIPELINE : ASSISTANT_PIPELINE;
  const offset = task.leader ? 1 : 0;
  const approved = task.codeReview?.verdict === "approved";
  const e2eFailed = task.e2e?.verdict === "failed";
  const at = (() => {
    if (task.status === "review" || task.status === "accepted") return steps.length;
    if (task.stage === "lead" && task.turns === 0) return 0;
    switch (task.stage) {
      case "review":
        return offset + 1;
      case "e2e":
        return offset + 4;
      // Back with the worker after a failed e2e run, the earlier approval,
      // merge and deployment are still on record; it is coding again.
      case "implement":
        return offset + (approved && !task.merge ? 2 : 0);
      case "lead":
      case "coordinator":
        return offset + (task.deployment ? 4 : task.merge ? 3 : approved ? 2 : 0);
    }
  })();
  const changesRequested = task.codeReview?.verdict === "changes-requested";
  const notes: Partial<Record<PipelineStepKey, string>> = {
    ...(changesRequested && at === offset
      ? { code: "Fixing review findings", review: "Changes requested" }
      : {}),
    ...(e2eFailed && at === offset ? { code: "Fixing the e2e failure" } : {}),
    ...(task.deployment && at > offset + 3
      ? { staging: `${task.deployment.revision.slice(0, 7)} deployed` }
      : {}),
    ...(task.e2e && at >= offset + 4 && task.stage !== "e2e"
      ? {
          e2e: e2eFailed
            ? "Failed on staging"
            : task.e2e.verdict === "partial"
              ? "Passed, with checks for you"
              : "Passed",
        }
      : {}),
  };
  return steps.map((step, index) => ({
    ...step,
    state:
      index < at
        ? "done"
        : index > at
          ? "todo"
          : step.key === "e2e" &&
              e2eFailed &&
              (task.stage === "coordinator" || task.stage === "lead")
            ? "failed"
            : "current",
    note: notes[step.key] ?? null,
  }));
}

/** The first line of an agent's message as plain text, for a one-line preview. */
export function previewLine(text: string): string {
  const line =
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && !/^(#+\s*)?(\*\*)?(options|choices)(\*\*)?:?$/i.test(l)) ?? "";
  return line
    .replace(/^#+\s*|^[-*]\s+|^\d+[.)]\s+/, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
}

/** How many things hold a project still until the person acts; reviews never do. */
export const blockingCount = (inbox: ReadonlyArray<InboxItem>) =>
  inbox.filter((item) => item.kind !== "review").length;

/** Whether this thread asked the person something that is still open. */
export const threadHasOpenQuestion = (board: AssistantBoard | null, threadId: string) =>
  board?.decisions.some((d) => d.threadId === threadId && d.answer === null) ?? false;

export type InboxItem =
  | {
      readonly kind: "setup";
      readonly key: string;
      readonly at: string;
      readonly setup: AssistantSetup;
    }
  | {
      readonly kind: "paused";
      readonly key: string;
      readonly at: string;
      readonly project: AssistantProject;
      readonly reason: string;
    }
  | {
      readonly kind: "decision";
      readonly key: string;
      readonly at: string;
      readonly decision: AssistantDecision;
    }
  | {
      readonly kind: "stuck";
      readonly key: string;
      readonly at: string;
      readonly task: AssistantTask;
      readonly reason: "rounds" | "stopped";
    }
  | {
      readonly kind: "review";
      readonly key: string;
      readonly at: string;
      readonly task: AssistantTask;
    };

/**
 * Everything on the board that waits on the person, most blocking first.
 *
 * Decisions, stuck issues, paused queues and unsaved setups hold a project
 * still, so they lead. Reviews never do (the next issue starts as soon as
 * staging is verified), so they follow. Within a group the oldest comes first:
 * it has waited longest.
 */
export function buildInbox(board: AssistantBoard): ReadonlyArray<InboxItem> {
  const blocking: InboxItem[] = [];
  const reviews: InboxItem[] = [];
  const projects = new Map(board.projects.map((p) => [p.config.projectId, p]));

  for (const setup of board.setups ?? []) {
    if (setup.proposal)
      blocking.push({ kind: "setup", key: `setup:${setup.threadId}`, at: "", setup });
  }
  for (const project of board.projects) {
    // Only a failure earns a row: a paused loop, or one started with automatic
    // picking off, is a deliberate choice and needs nothing from the person. A
    // running loop counts too: the scan records what stopped it from advancing
    // and clears it only once a scan works again. `projectFailure` already
    // leaves out the "Waiting: " notes, which are progress, not a problem.
    const reason = projectFailure(project);
    if (reason)
      blocking.push({
        kind: "paused",
        key: `paused:${project.config.projectId}`,
        at: "",
        project,
        reason,
      });
  }
  for (const decision of board.decisions) {
    if (decision.answer === null)
      blocking.push({
        kind: "decision",
        key: `decision:${decision.id}`,
        at: decision.createdAt,
        decision,
      });
  }
  for (const task of board.tasks) {
    if (task.status === "review") {
      reviews.push({ kind: "review", key: `review:${task.id}`, at: task.updatedAt, task });
      continue;
    }
    if (!assistantTaskHoldsProject(task.status)) continue;
    const project = projects.get(task.projectId);
    // A blocked issue in a running project is the assistant's to repair. It
    // becomes the person's when the assistant has no rounds left to spend, or
    // when nothing is running that could pick it up. The server counts a round
    // before it queues that round's message, so `turns === turnLimit` on an
    // issue still in flight is the last round running, not a failure: only a
    // blocked issue is actually out of rounds.
    if (task.status === "blocked" && taskRoundsExhausted(task))
      blocking.push({
        kind: "stuck",
        key: `stuck:${task.id}`,
        at: task.updatedAt,
        task,
        reason: "rounds",
      });
    else if (task.status === "blocked" && project?.status === "stopped" && !projectFailure(project))
      blocking.push({
        kind: "stuck",
        key: `stuck:${task.id}`,
        at: task.updatedAt,
        task,
        reason: "stopped",
      });
  }
  const byAge = (a: InboxItem, b: InboxItem) => a.at.localeCompare(b.at);
  return [...blocking.toSorted(byAge), ...reviews.toSorted(byAge)];
}

export function activeTaskFor(board: AssistantBoard, projectId: ProjectId): AssistantTask | null {
  return (
    board.tasks.find((t) => t.projectId === projectId && assistantTaskHoldsProject(t.status)) ??
    null
  );
}

const HISTORY_STATUSES = new Set<AssistantTask["status"]>([
  "accepted",
  "changes-requested",
  "skipped",
  "declined",
]);

export function historyTasks(board: AssistantBoard): ReadonlyArray<AssistantTask> {
  return board.tasks
    .filter((t) => HISTORY_STATUSES.has(t.status))
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Issues the person put next, in the order the loop takes them. */
export function queuedTasks(board: AssistantBoard): ReadonlyArray<AssistantTask> {
  return board.tasks
    .filter((t) => t.status === "queued")
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export interface DecisionOption {
  readonly number: number;
  readonly label: string;
  readonly recommended: boolean;
}

const OPTIONS_HEADING = /^\s*(?:#+\s*)?(?:\*\*)?(?:options|choices)(?:\*\*)?\s*:?\s*(?:\*\*)?\s*$/i;
const NUMBERED_LINE = /^\s*(\d{1,2})[.)]\s+(.+)$/;
const RECOMMENDED = /^\s*\(?(?:\*\*)?\s*recommended\s*[:.)]?\s*(?:\*\*)?\s*[:.)]?\s*/i;

/**
 * The numbered choices an assistant laid out under an "Options:" heading, so
 * they can be offered as one-tap replies. Only a list under that heading
 * counts: numbered lists elsewhere in a question are usually facts or steps,
 * and a reply that names the wrong one would be worse than no shortcut.
 */
export function decisionOptions(question: string): ReadonlyArray<DecisionOption> {
  const lines = question.split("\n");
  const heading = lines.findIndex((line) => OPTIONS_HEADING.test(line));
  if (heading < 0) return [];
  const options: DecisionOption[] = [];
  for (const line of lines.slice(heading + 1)) {
    const match = NUMBERED_LINE.exec(line);
    if (match) {
      const raw = match[2]!;
      const recommended = /recommended/i.test(raw.slice(0, 40));
      options.push({
        number: Number(match[1]),
        label: shortOptionLabel(raw.replace(RECOMMENDED, "")),
        recommended,
      });
      continue;
    }
    // Wrapped continuation lines belong to the option above; a blank line or
    // new paragraph after at least one option ends the list.
    if (options.length > 0 && (line.trim() === "" || !/^\s/.test(line))) break;
  }
  return options.length >= 2 ? options : [];
}

function shortOptionLabel(text: string): string {
  const plain = text
    .replace(/\*\*|__|`/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .trim();
  const clause = plain.split(/(?<=[.:;])\s|,\s(?=[a-z])/)[0]!.replace(/[.:;]$/, "");
  const label = clause.charAt(0).toUpperCase() + clause.slice(1);
  return label.length > 56 ? `${label.slice(0, 55).trimEnd()}…` : label;
}

/** A long agent message is read in part, then opened; short ones stay whole. */
export const isLongText = (text: string) => text.length > 600 || text.split("\n").length > 10;
