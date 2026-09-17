import {
  ASSISTANT_INSTRUCTION_BUDGET,
  assistantPicksIssues,
  assistantTaskE2eDepth,
  assistantTaskE2eEnvironment,
  assistantTaskHoldsProject,
  type AssistantBoard,
  type AssistantDecision,
  type AssistantE2eDepth,
  type AssistantInstructionAudience,
  type AssistantProject,
  type AssistantProjectConfig,
  type AssistantProjectNote,
  type AssistantSetup,
  type AssistantTask,
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

/**
 * When a provider's usage limit stopped one of the project's threads, the time
 * the server waits for before it tells them to continue. The server clears the
 * stamp on its next scan after it passes, so until then a time in the past is
 * not a hold; a stopped project is not waiting on anything either.
 */
export function projectLimitHold(
  project: AssistantProject,
  nowMs: number = Date.now(),
): string | null {
  if (project.status === "stopped") return null;
  const until = project.limitedUntil ?? null;
  if (!until) return null;
  const at = new Date(until).getTime();
  return Number.isNaN(at) || at <= nowMs ? null : until;
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

/** The issues themselves when there are few, a count when there are many. */
function namedIssues(tasks: ReadonlyArray<AssistantTask>): string {
  const [first, second] = tasks;
  if (tasks.length === 1 && first) return first.issue.identifier;
  if (tasks.length === 2 && first && second)
    return `${first.issue.identifier} and ${second.issue.identifier}`;
  return `${tasks.length} issues`;
}

/** "SPI-1, SPI-2 and SPI-3", for a line that has room to name them all. */
function identifierList(tasks: ReadonlyArray<AssistantTask>): string {
  const ids = tasks.map((t) => t.issue.identifier);
  const last = ids.at(-1);
  return ids.length > 1 && last ? `${ids.slice(0, -1).join(", ")} and ${last}` : ids.join("");
}

/** One title reads best on its own; several need their identifiers to tell apart. */
function issuesDetail(tasks: ReadonlyArray<AssistantTask>): string | null {
  const [first] = tasks;
  if (tasks.length === 0) return null;
  if (tasks.length === 1 && first) return first.issue.title;
  if (tasks.length === 2) return tasks.map((t) => t.issue.title).join(" · ");
  return identifierList(tasks);
}

export function describeProjectActivity(input: {
  project: AssistantProject;
  /** Every issue the project holds right now, in the order the board lists them. */
  activeTasks: ReadonlyArray<AssistantTask>;
  /**
   * The usage-limit reset already in the person's own clock format. The caller
   * formats it because the preference lives in the settings store, which this
   * module stays out of; without it the line simply names no time.
   */
  limitResumesAt?: string | null;
  nowMs?: number;
}): ProjectActivity {
  const { project, activeTasks, limitResumesAt, nowMs = Date.now() } = input;
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
          headline: activeTasks.length > 0 ? `Holding ${namedIssues(activeTasks)}` : "Stopped",
          detail:
            activeTasks.length === 0
              ? "Start to take issues from Linear, or resume the teams and dispatch issues yourself."
              : activeTasks.length === 1
                ? "Its team is stopped. Start, or resume the teams from the menu, to continue it."
                : "Their teams are stopped. Start, or resume the teams from the menu, to continue them.",
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
  // A usage limit leaves every thread idle, so without this line the card would
  // report the project as thinking or working when nothing can run at all.
  const limitHold = projectLimitHold(project, nowMs);
  if (limitHold)
    return {
      tone: "waiting",
      status,
      headline: "Waiting for Claude's usage limit to reset",
      detail: limitResumesAt
        ? `Work continues by itself once it resets at ${limitResumesAt}. Start now to try sooner.`
        : "Work continues by itself once it resets. Start now to try sooner.",
    };
  if (waiting)
    return {
      tone: "waiting",
      status,
      headline: "Waiting on something",
      detail: waiting,
    };
  if (activeTasks.length > 0)
    return {
      tone: "active",
      status,
      headline: `Working on ${namedIssues(activeTasks)}`,
      detail: issuesDetail(activeTasks),
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

/** The server gives up on a team leader's wait after this many checks. */
const WAIT_CHECKS_LIMIT = 15;

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
    default: {
      if (workerNeedsInput)
        return {
          tone: "waiting",
          label: "Waiting for input",
          detail: `The ${holder} asked something in its thread.`,
        };
      // A team leader waiting on something outside T3 records it on its issue.
      // T3 tells it to check again once a minute until it moves or gives up.
      const wait = task.wait ?? null;
      if (wait && !workerBusy) {
        const detail = [
          wait.reason.trim() || null,
          wait.checks > 0 ? `check ${wait.checks} of ${WAIT_CHECKS_LIMIT}` : null,
        ]
          .filter(Boolean)
          .join(" · ");
        return { tone: "waiting", label: "Waiting on something", detail: detail || null };
      }
      // The issue's threads share one worktree: a handoff waits for the rest of the team.
      if (!workerBusy && waitingOn && task.stage !== undefined)
        return {
          tone: "idle",
          label: `Waiting for the ${STAGE_THREAD[waitingOn]}`,
          detail: `The ${holder} starts when the ${STAGE_THREAD[waitingOn]}'s turn and background work end. T3 releases a finished thread's background work by itself.`,
        };
      const inWorktree = assistantTaskE2eEnvironment(task) === "worktree";
      // With no e2e test the worktree order is the staging one: review, merge, deploy.
      const testsInWorktree = inWorktree && assistantTaskE2eDepth(task) !== "none";
      const e2ePassed = Boolean(task.e2e) && task.e2e?.verdict !== "failed";
      switch (task.stage ?? "implement") {
        case "implement":
          if (workerBusy)
            return task.codeReview?.verdict === "approved"
              ? {
                  tone: "active",
                  label: "Merging",
                  detail:
                    inWorktree && e2ePassed
                      ? "The e2e check passed in the worktree."
                      : "Code review approved the change.",
                }
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
            ? {
                tone: "active",
                label: inWorktree ? "Testing in the worktree" : "Testing on staging",
                detail: step,
              }
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
                  ? inWorktree
                    ? "It failed in the worktree. The team leader is deciding on a fix."
                    : "It failed on staging. The team leader is deciding on a fix."
                  : task.merge && !task.deployment
                    ? testsInWorktree
                      ? "Merged after the e2e check passed. The team leader is checking the staging deploy."
                      : "Merged after code review. The team leader is checking the staging deploy."
                    : testsInWorktree && task.codeReview?.verdict === "approved" && !task.e2e
                      ? "Code review approved the change. The team leader starts the e2e check in the worktree."
                      : "The team leader is deciding the next step.",
          };
      }
    }
  }
}

export const taskRoundsExhausted = (task: AssistantTask) => task.turns >= task.turnLimit;

export {
  assistantTaskPipeline as taskPipeline,
  type PipelineStep,
  type PipelineStepKey,
  type PipelineStepState,
} from "@t3tools/contracts";

const E2E_DEPTH_LABEL: Record<AssistantE2eDepth, string> = {
  full: "Full",
  smoke: "Smoke",
  none: "None",
};

const E2E_DEPTH_SET_BY = {
  lead: "Set by the team leader",
  review: "Raised by code review",
  person: "Set by you",
} as const;

export interface E2ePlanSummary {
  readonly depth: AssistantE2eDepth;
  /** "Full test", "Smoke test", "No e2e test". */
  readonly label: string;
  readonly setBy: string | null;
  /** The reason for none, or which criteria a smoke test covers. */
  readonly detail: string | null;
}

/** What the issue's e2e plan says about how deep the test goes. Null before the plan exists. */
export function describeE2ePlan(
  task: Pick<AssistantTask, "e2ePlan" | "criteria">,
): E2ePlanSummary | null {
  const plan = task.e2ePlan;
  if (!plan) return null;
  const depth = assistantTaskE2eDepth(task);
  const setBy = plan.depthSetBy ? E2E_DEPTH_SET_BY[plan.depthSetBy] : null;
  const smoke = plan.smokeCriteria?.length ? plan.smokeCriteria : null;
  const detail =
    depth === "none"
      ? plan.reason?.trim() || null
      : depth === "smoke"
        ? smoke
          ? `Criteria ${smoke.toSorted((a, b) => a - b).join(", ")}`
          : task.criteria?.length
            ? "All criteria"
            : null
        : null;
  const label = depth === "none" ? "No e2e test" : depth === "smoke" ? "Smoke test" : "Full test";
  return { depth, label, setBy, detail };
}

export const e2eDepthLabel = (depth: AssistantE2eDepth) => E2E_DEPTH_LABEL[depth];

/**
 * Whether the person can still change how deep the issue's e2e test goes: the
 * server allows it on an active issue with a plan, until a test starts or passes.
 */
export function e2eDepthChange(
  task: Pick<AssistantTask, "e2ePlan" | "status" | "stage" | "e2e">,
): { readonly allowed: true } | { readonly allowed: false; readonly reason: string } {
  if (!task.e2ePlan)
    return {
      allowed: false,
      reason: "The team leader plans the e2e test when it takes the issue.",
    };
  if (!assistantTaskHoldsProject(task.status))
    return { allowed: false, reason: "The issue is no longer being worked on." };
  if (task.stage === "e2e") return { allowed: false, reason: "The e2e test is running." };
  if (task.e2e && task.e2e.verdict !== "failed")
    return { allowed: false, reason: "The e2e test already ran." };
  return { allowed: true };
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
    // A blocked issue in a running project is its team's to repair. It
    // becomes the person's when the team has no rounds left to spend, or
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

/** Every issue a project holds right now, in the order the board lists them. */
export function activeTasksFor(
  board: AssistantBoard,
  projectId: ProjectId,
): ReadonlyArray<AssistantTask> {
  return board.tasks.filter(
    (t) => t.projectId === projectId && assistantTaskHoldsProject(t.status),
  );
}

const HISTORY_STATUSES = new Set<AssistantTask["status"]>([
  "accepted",
  "changes-requested",
  "skipped",
  "declined",
]);

/** Whether the issue is done with: its team settled and its row moved to history. */
export const taskIsFinished = (task: Pick<AssistantTask, "status">): boolean =>
  HISTORY_STATUSES.has(task.status);

export function historyTasks(board: AssistantBoard): ReadonlyArray<AssistantTask> {
  return board.tasks
    .filter(taskIsFinished)
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * The four threads of an issue's team, in the order the work moves through
 * them. Every strip and menu lists them this way, so a role keeps its place.
 */
export const teamRoleOrder: ReadonlyArray<AssistantThreadRole> = [
  "lead",
  "implement",
  "review",
  "e2e",
];

export interface TaskOutcome {
  /** How the issue ended, as a sentence opener. */
  readonly label: string;
  /** The person's or the team leader's words for it, when there are any. */
  readonly detail: string | null;
}

const trimmedOrNull = (text: string | null | undefined): string | null => text?.trim() || null;

/** How a finished issue ended, for its history record. */
export function taskOutcome(task: AssistantTask): TaskOutcome {
  switch (task.status) {
    case "accepted":
      return {
        label: "Accepted",
        detail: task.deliveredState ? `Left in ${task.deliveredState} in Linear.` : null,
      };
    case "changes-requested":
      return { label: "Sent back for changes", detail: trimmedOrNull(task.feedback) };
    case "skipped":
      return { label: "Skipped", detail: trimmedOrNull(task.feedback) };
    case "declined":
      return { label: "Declined", detail: trimmedOrNull(task.declined?.reason) };
    default:
      return { label: "Still in progress", detail: null };
  }
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

export interface InstructionSection {
  readonly key: "shared" | AssistantInstructionAudience;
  readonly label: string;
  readonly text: string;
  readonly length: number;
  readonly budget: number;
  /** Over budget: the setup refuses to save a plan this long. */
  readonly over: boolean;
}

/** The role sections, in the order a review lists them after the shared policy. */
const INSTRUCTION_SECTIONS: ReadonlyArray<{
  readonly audience: AssistantInstructionAudience;
  readonly label: string;
}> = [
  // The "assistant" section had only the retired chat to read it; a saved one is not shown.
  { audience: "lead", label: "Team leader" },
  { audience: "implement", label: "Implementation worker" },
  { audience: "review", label: "Code reviewer" },
  { audience: "e2e", label: "E2E tester" },
];

const instructionSection = (
  key: InstructionSection["key"],
  label: string,
  text: string,
  budget: number,
): InstructionSection => ({
  key,
  label,
  text,
  length: text.length,
  budget,
  over: text.length > budget,
});

/**
 * The project instructions as the threads receive them: the shared policy,
 * always listed, then each role section that has any text. The shared policy
 * keeps the whole budget on a setup written before sections existed, when it is
 * the entire instructions, and the smaller shared budget once sections split it.
 */
export function instructionSections(
  config: Pick<AssistantProjectConfig, "instructions" | "roleInstructions">,
): ReadonlyArray<InstructionSection> {
  const sections = INSTRUCTION_SECTIONS.flatMap(({ audience, label }) => {
    const text = config.roleInstructions?.[audience]?.trim() ?? "";
    return text
      ? [instructionSection(audience, label, text, ASSISTANT_INSTRUCTION_BUDGET.section)]
      : [];
  });
  const shared = config.instructions.trim();
  return [
    instructionSection(
      "shared",
      "Shared policy",
      shared,
      sections.length > 0
        ? ASSISTANT_INSTRUCTION_BUDGET.shared
        : ASSISTANT_INSTRUCTION_BUDGET.total,
    ),
    ...sections,
  ];
}

const NOTE_AUTHOR: Record<AssistantProjectNote["role"], string> = {
  lead: "team leader",
  implement: "worker",
  e2e: "e2e tester",
  person: "you",
};

/** Who wrote a project note, and on which issue: "SPI-141 · e2e tester", or "Added by you". */
export function projectNoteSource(note: AssistantProjectNote): string {
  if (note.role === "person") return "Added by you";
  const author = NOTE_AUTHOR[note.role];
  return note.issueIdentifier ? `${note.issueIdentifier} · ${author}` : `By the ${author}`;
}
