import {
  assistantTaskHoldsProject,
  type AssistantBoard,
  type AssistantDecision,
  type AssistantProject,
  type AssistantSetup,
  type AssistantTask,
  type ProjectId,
} from "@t3tools/contracts";

/**
 * The server keeps one free-text slot per project and uses it for two things:
 * a real failure that stopped the queue, and the coordinator's own note while
 * it waits on something outside T3 ("Waiting: staging deploy is running").
 * Only the first is worth an alarm.
 */
const WAITING_PREFIX = "Waiting: ";

export function projectWaitingReason(project: AssistantProject): string | null {
  return project.status === "running" && project.error?.startsWith(WAITING_PREFIX)
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
  /** The status pill: Running, Paused, Needs you. */
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
  if (project.status === "stopped") {
    const failure = projectFailure(project);
    return failure
      ? { tone: "attention", status: "Paused", headline: "Stopped by a problem", detail: failure }
      : {
          tone: "paused",
          status: "Paused",
          headline: activeTask ? `Holding ${activeTask.issue.identifier}` : "Not taking issues",
          detail: activeTask
            ? "The issue stays assigned. Start to let the assistant continue it."
            : "Start to let the assistant pick up issues.",
        };
  }
  const waiting = projectWaitingReason(project);
  if (coordinatorBusy)
    return {
      tone: "active",
      status: "Running",
      headline: "Assistant is thinking",
      detail: activeTask ? `${activeTask.issue.identifier} · ${activeTask.issue.title}` : null,
    };
  if (waiting)
    return {
      tone: "waiting",
      status: "Running",
      headline: "Waiting on something",
      detail: waiting,
    };
  if (activeTask)
    return {
      tone: "active",
      status: "Running",
      headline: `Working on ${activeTask.issue.identifier}`,
      detail: activeTask.issue.title,
    };
  return {
    tone: "idle",
    status: "Running",
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

export function describeTaskPhase(input: {
  task: AssistantTask;
  workerBusy: boolean;
  workerNeedsInput: boolean;
  step: string | null;
  hasOpenDecision: boolean;
}): TaskPhase {
  const { task, workerBusy, workerNeedsInput, step, hasOpenDecision } = input;
  switch (task.status) {
    case "preparing":
      return { tone: "active", label: "Preparing a worktree", detail: null };
    case "blocked":
      return { tone: "blocked", label: "Blocked", detail: task.error };
    case "waiting":
      return hasOpenDecision
        ? { tone: "waiting", label: "Waiting for your answer", detail: null }
        : {
            tone: "waiting",
            label: "Waiting for input",
            detail: "The worker asked something in its thread.",
          };
    default:
      if (workerNeedsInput)
        return {
          tone: "waiting",
          label: "Waiting for input",
          detail: "The worker asked something in its thread.",
        };
      return workerBusy
        ? { tone: "active", label: "Coding", detail: step }
        : {
            tone: "idle",
            label: "With the assistant",
            detail: "The worker finished a round. The assistant is reviewing it.",
          };
  }
}

export const taskRoundsExhausted = (task: AssistantTask) => task.turns >= task.turnLimit;

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
    const reason = project.status === "stopped" ? projectFailure(project) : null;
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
    // when nothing is running that could pick it up.
    if (taskRoundsExhausted(task))
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
]);

export function historyTasks(board: AssistantBoard): ReadonlyArray<AssistantTask> {
  return board.tasks
    .filter((t) => HISTORY_STATUSES.has(t.status))
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
