import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  AssistantBoard,
  AssistantDecision,
  AssistantProjectConfig,
  AssistantTask,
  CommandId,
  DeveloperAssistantError,
  LinearIssueNotFoundError,
  LinearOperationError,
  LinearUnavailableError,
  MessageId,
  ProjectId,
  ThreadId,
  assistantE2eEnvironment,
  assistantParallelIssues,
  assistantPicksIssues,
  assistantTaskE2eEnvironment,
  assistantTaskHoldsProject,
  assistantTaskThreadId,
  assistantThreadKind,
  type AssistantAnswerInput,
  type AssistantCodeReview,
  type AssistantE2eResult,
  type AssistantThreadRole,
  type AssistantControlInput,
  type AssistantDispatchInput,
  type AssistantProjectStatus,
  type AssistantReviewInput,
  type AssistantSetupInput,
  type AssistantSetupPlan,
  type AssistantSetupResolveInput,
  type OrchestrationEvent,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  type LinearIssueDetail,
  type LinearIssueSummary,
  type LinearWorkflowStateType,
} from "@t3tools/contracts";
import { isStaleRequestFailureDetail } from "../orchestration/decider.ts";
import { LinearApi } from "../linear/LinearApi.ts";
import { LinearThreadService } from "../linear/LinearThreadService.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionService } from "../orchestration/Services/ProviderRuntimeIngestion.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { forkParked } from "../serverActivation.ts";
import { AssistantEvidence } from "./AssistantEvidence.ts";
import {
  declinedComment,
  deliveredDescription,
  deployedComment,
  e2eComment,
  issueFingerprint,
  linearFailureDetail,
  linearFeedback,
  mergedComment,
} from "./linearUpdates.ts";
import { StagingVerifier } from "./StagingVerifier.ts";
import {
  assistantInstructions,
  e2eBrief,
  e2eInstructions,
  leadInstructions,
  reviewerInstructions,
  workerInstructions,
} from "./prompts.ts";
import { makeSetup, validateDeploymentConfig } from "./AssistantSetup.ts";

type ProjectRow = {
  project_id: string;
  thread_id: string;
  repository_key: string;
  config: string;
  status: AssistantProjectStatus;
  error: string | null;
  wake_version: number;
  delivered_version: number;
  wake_reason: string;
  issue_fingerprint: string | null;
  external_waits: number;
  limited_until: string | null;
};
type TaskRow = { id: string; project_id: string; thread_id: string; data: string };
const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(AssistantProjectConfig));
const decodeTask = Schema.decodeUnknownEffect(Schema.fromJsonString(AssistantTask));
const decodeDecision = Schema.decodeUnknownEffect(Schema.fromJsonString(AssistantDecision));
const encodeConfig = Schema.encodeSync(Schema.fromJsonString(AssistantProjectConfig));
const encodeTask = Schema.encodeSync(Schema.fromJsonString(AssistantTask));
const encodeDecision = Schema.encodeSync(Schema.fromJsonString(AssistantDecision));
const isAssistantError = Schema.is(DeveloperAssistantError);
/** Linear's errors say what the person can act on: a bad reference, a rejected key, a rate limit. */
const isLinearError = Schema.is(
  Schema.Union([LinearIssueNotFoundError, LinearOperationError, LinearUnavailableError]),
);
const decodeRequest = Schema.decodeUnknownEffect(Schema.Struct({ requestId: Schema.String }));
// Answering a request the provider no longer knows (e.g. after a server restart)
// closes it, matching the thread's pending accounting.
const isStale = (activity: Pick<OrchestrationThreadActivity, "kind" | "payload">) => {
  if (
    !["provider.approval.respond.failed", "provider.user-input.respond.failed"].includes(
      activity.kind,
    ) ||
    typeof activity.payload !== "object" ||
    activity.payload === null
  )
    return false;
  const payload = activity.payload as Record<string, unknown>;
  return typeof payload.requestId === "string" && isStaleRequestFailureDetail(payload);
};
const fail = (detail: string) => new DeveloperAssistantError({ detail });
const wrap = (error: unknown) =>
  isAssistantError(error)
    ? error
    : isLinearError(error)
      ? fail(error.message)
      : fail(
          "The developer assistant operation failed. Inspect the thread or server logs and retry.",
        );
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const newId = () => NodeCrypto.randomUUID();
const busy = (status: string | undefined) => status === "running" || status === "starting";
const ROLES = ["lead", "implement", "review", "e2e"] as const;
/** How long a released session gets to report itself stopped before it is asked again. */
const RELEASE_RETRY_MS = 30_000;
const ROLE_THREAD = /^assistant-(lead|review|e2e)-(.+)$/;
const ROLE_TITLES = { lead: "team leader", review: "code review", e2e: "e2e on staging" } as const;
const ROLE_NAMES = {
  lead: "team leader",
  implement: "worker",
  review: "code review thread",
  e2e: "e2e thread",
} as const;
/** A team leader that declines this many issues in a row pauses the loop for the person. */
const DECLINE_STREAK_LIMIT = 3;
/**
 * The Claude adapter fails a turn the account's usage limit stopped with
 * "Claude usage limit reached. Send the message again once the 5-hour limit
 * resets in 2h 10m." The wait is read from that clause. Without one the limit
 * is tried again after a while, which costs one rejected request per thread.
 */
const USAGE_LIMIT_RETRY_MS = 20 * 60_000;
/** The reset time is rounded up to the minute; the slack keeps the first try after it. */
const USAGE_LIMIT_SLACK_MS = 60_000;
const usageLimitWaitMs = (error: string | null | undefined): number | null => {
  if (!error || !/usage limit/i.test(error)) return null;
  const match = /limit resets in (?:(\d+)h)?\s*(?:(\d+)m)?/.exec(error);
  const minutes = match ? Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0) : 0;
  return (minutes > 0 ? minutes * 60_000 : USAGE_LIMIT_RETRY_MS) + USAGE_LIMIT_SLACK_MS;
};
/** The thread that decides for an issue: its team leader, or the assistant for earlier work. */
const leadStage = (t: AssistantTask) => (t.leader ? ("lead" as const) : ("coordinator" as const));
const withLead = (stage: AssistantTask["stage"]) => stage === "lead" || stage === "coordinator";
const byPriority = (a: LinearIssueSummary, b: LinearIssueSummary) =>
  (a.priority || 5) - (b.priority || 5) || a.identifier.localeCompare(b.identifier);
/** Every state an issue can still be worked from; a ready state may be any of them. */
const OPEN_STATE_TYPES = [
  "triage",
  "backlog",
  "unstarted",
  "started",
  "duplicate",
] as const satisfies ReadonlyArray<LinearWorkflowStateType>;
/**
 * The person accepts a delivery by closing the issue or by moving it to the
 * accepted state the setup names, which its comments ask them to use and which
 * need not be a completed state.
 */
const acceptedInLinear = (
  state: { readonly name: string; readonly type: LinearWorkflowStateType },
  config: Pick<AssistantProjectConfig, "acceptedState">,
) => {
  const accepted = config.acceptedState.trim().toLowerCase();
  return (
    state.type === "completed" || (accepted !== "" && state.name.trim().toLowerCase() === accepted)
  );
};
/** What assistant_wait told the caller to do next. */
export type AssistantWaitResult = {
  readonly outcome: "waiting" | "limit" | "stopped";
};

export const DeveloperAssistantWorkers = Context.Reference<boolean>("t3/assistant/workers", {
  defaultValue: () => true,
});

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const ingestion = yield* ProviderRuntimeIngestionService;
  const turns = yield* ProjectionTurnRepository;
  const linear = yield* LinearApi;
  const linearThreads = yield* LinearThreadService;
  const settings = yield* ServerSettingsService;
  const verifier = yield* StagingVerifier;
  const evidence = yield* AssistantEvidence;
  const terminals = yield* TerminalManager;
  const providers = yield* ProviderService;
  const lock = yield* Semaphore.make(1);
  const deliveryLock = yield* Semaphore.make(1);
  const changes = yield* PubSub.unbounded<void>();
  const threadBusy = Effect.fn("Assistant.threadBusy")(function* (
    thread: OrchestrationThreadShell,
  ) {
    return (
      busy(thread.session?.status) ||
      thread.latestTurn?.state === "running" ||
      thread.backgroundLiveness != null ||
      Option.isSome(yield* turns.getPendingTurnStartByThreadId({ threadId: thread.id }))
    );
  });
  const changed = PubSub.publish(changes, undefined).pipe(Effect.asVoid);
  // The assistant's conversation keeps its operating instructions, so wakes
  // repeat them only when they changed or the conversation was compacted. Kept
  // in memory: a restart re-sends them once.
  const briefed = new Map<string, string>();
  // Issues declined in a row since the last one a team took, per project. In
  // memory: a restart only allows a few more declines before the pause.
  const declineStreak = new Map<string, ReadonlyArray<string>>();
  // Threads whose session the assistant released, and when: their stop is no
  // failure, and one that never reports back is asked again after a while.
  const releasedAt = new Map<string, number>();

  const project = Effect.fn("Assistant.project")(function* (id: string) {
    const rows = yield* sql<ProjectRow>`SELECT * FROM assistant_projects WHERE project_id = ${id}`;
    if (!rows[0]) return yield* fail("Configure this project's developer assistant first.");
    return { ...rows[0], config: yield* decodeConfig(rows[0].config) };
  });
  const task = Effect.fn("Assistant.task")(function* (id: string) {
    const rows = yield* sql<TaskRow>`SELECT * FROM assistant_tasks WHERE id = ${id}`;
    if (!rows[0]) return yield* fail("This managed issue no longer exists.");
    return yield* decodeTask(rows[0].data);
  });
  const saveTask = Effect.fn("Assistant.saveTask")(function* (value: AssistantTask) {
    const updated = { ...value, updatedAt: yield* now };
    yield* sql`UPDATE assistant_tasks SET status = ${updated.status}, data = ${encodeTask(updated)} WHERE id = ${updated.id}`;
    yield* changed;
    return updated;
  });
  /** Wake the project's developer assistant. The loop itself never needs it. */
  const wake = Effect.fn("Assistant.wake")(function* (id: string, reason: string) {
    yield* sql`UPDATE assistant_projects SET wake_version = wake_version + 1,
      wake_reason = ${reason.slice(0, 12000)} WHERE project_id = ${id}`;
    yield* changed;
  });
  const queueMessage = Effect.fn("Assistant.queueMessage")(function* (
    projectId: string,
    threadId: ThreadId,
    id: string,
    text: string,
  ) {
    yield* sql`INSERT OR IGNORE INTO assistant_messages (id, project_id, thread_id, text, created_at) VALUES (${id}, ${projectId}, ${threadId}, ${text}, ${yield* now})`;
  });
  /** Tell an issue's team leader what happened. Work from before leaders goes to the assistant. */
  const notifyLead = Effect.fn("Assistant.notifyLead")(function* (t: AssistantTask, text: string) {
    if (!t.leader) return yield* wake(t.projectId, text);
    yield* queueMessage(
      t.projectId,
      assistantTaskThreadId(t, "lead"),
      `${t.id}:lead:${newId()}`,
      text,
    );
    yield* changed;
  });
  /** The managed issue a thread works on, and which of its threads it is. */
  const threadTask = Effect.fn("Assistant.threadTask")(function* (threadId: string) {
    const rows = yield* sql<TaskRow>`SELECT * FROM assistant_tasks WHERE thread_id = ${threadId}`;
    if (rows[0]) return { task: yield* decodeTask(rows[0].data), role: "implement" as const };
    const match = ROLE_THREAD.exec(threadId);
    if (!match) return null;
    const owner = yield* sql<TaskRow>`SELECT * FROM assistant_tasks WHERE id = ${match[2]!}`;
    if (!owner[0]) return null;
    return { task: yield* decodeTask(owner[0].data), role: match[1] as AssistantThreadRole };
  });
  const taskThreadIds = (t: AssistantTask) => ROLES.map((role) => assistantTaskThreadId(t, role));
  /** The issues the project's teams hold right now, oldest first; one per slot. */
  const heldTasks = Effect.fn("Assistant.heldTasks")(function* (projectId: string) {
    const rows =
      yield* sql<TaskRow>`SELECT * FROM assistant_tasks WHERE project_id = ${projectId} AND status IN ('preparing','working','waiting','blocked') ORDER BY rowid`;
    return yield* Effect.forEach(rows, (row) => decodeTask(row.data));
  });
  /** A usage limit is in force for the project: nothing is sent to its threads until it resets. */
  const limited = Effect.fn("Assistant.limited")(function* (p: Pick<ProjectRow, "limited_until">) {
    if (p.limited_until === null) return false;
    return Date.parse(p.limited_until) > (yield* Clock.currentTimeMillis);
  });
  // The threads share one worktree, so only one of them runs at a time. A
  // thread asking about the others leaves itself out: its own turn is running.
  const taskBusy = Effect.fn("Assistant.taskBusy")(function* (t: AssistantTask, except?: ThreadId) {
    for (const id of taskThreadIds(t)) {
      if (id === except) continue;
      const shell = yield* snapshots.getThreadShellById(id);
      if (Option.isSome(shell) && (yield* threadBusy(shell.value))) return true;
    }
    return false;
  });
  /**
   * A thread that handed the issue on may leave background work behind: a
   * watch loop, a dev server. That keeps it busy, and a loop that never ends
   * would hold the team for good. Nothing of a thread that no longer holds the
   * issue may run on in the shared worktree, so its session is released, which
   * orphans that work. Its next turn resumes the conversation.
   */
  const releaseHandedOff = Effect.fn("Assistant.releaseHandedOff")(function* (t: AssistantTask) {
    if (t.stage === undefined) return;
    const time = yield* Clock.currentTimeMillis;
    for (const role of ROLES) {
      if (role === t.stage) continue;
      const id = assistantTaskThreadId(t, role);
      const shell = yield* snapshots.getThreadShellById(id);
      if (Option.isNone(shell) || shell.value.backgroundLiveness == null) continue;
      const last = releasedAt.get(id);
      if (
        busy(shell.value.session?.status) ||
        shell.value.latestTurn?.state === "running" ||
        Option.isSome(yield* turns.getPendingTurnStartByThreadId({ threadId: id })) ||
        (last !== undefined && time - last < RELEASE_RETRY_MS)
      )
        continue;
      releasedAt.set(id, time);
      yield* Effect.logInfo("Developer assistant released a handed-off thread's background work", {
        threadId: id,
        role,
        task: t.id,
        backgroundLiveness: shell.value.backgroundLiveness,
      });
      yield* providers.stopSession({ threadId: id }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Developer assistant could not release a handed-off thread", {
            threadId: id,
            error,
          }),
        ),
      );
    }
  });
  const taskQueued = Effect.fn("Assistant.taskQueued")(function* (
    t: AssistantTask,
    except?: ThreadId,
  ) {
    const ids = taskThreadIds(t);
    const rows = yield* sql<{
      thread_id: string;
    }>`SELECT thread_id FROM assistant_messages WHERE delivered = 0 AND thread_id IN (${ids[0]}, ${ids[1]}, ${ids[2]}, ${ids[3]})`;
    return rows.some((row) => row.thread_id !== except);
  });
  /**
   * A provider releases an idle session: the inactivity reaper, or settling a
   * thread after its PR merged. Nothing was in flight; the turn it ran already
   * ended and was handled when the session went ready.
   */
  const releasedWhileIdle = Effect.fn("Assistant.releasedWhileIdle")(function* (
    threadId: ThreadId,
  ) {
    const shell = yield* snapshots.getThreadShellById(threadId, { includeArchived: true });
    if (Option.isNone(shell)) return false;
    const turn = shell.value.latestTurn;
    const askedAt = shell.value.latestUserMessageAt;
    return (
      turn?.state === "completed" &&
      (askedAt === null || Date.parse(askedAt) <= Date.parse(turn.requestedAt)) &&
      Option.isNone(yield* turns.getPendingTurnStartByThreadId({ threadId }))
    );
  });
  const taskDecisionsPending = Effect.fn("Assistant.taskDecisionsPending")(function* (
    t: AssistantTask,
  ) {
    const ids = taskThreadIds(t);
    const rows =
      yield* sql`SELECT id FROM assistant_decisions WHERE resolved = 0 AND thread_id IN (${ids[0]}, ${ids[1]}, ${ids[2]}, ${ids[3]})`;
    return rows.length > 0;
  });
  const archiveThread = Effect.fn("Assistant.archiveThread")(function* (threadId: ThreadId) {
    // The engine keeps rejected command ids, so never reuse one across attempts.
    const shell = yield* snapshots.getThreadShellById(threadId, { includeArchived: true });
    if (Option.isSome(shell) && shell.value.archivedAt === null)
      yield* engine
        .dispatch({ type: "thread.archive", commandId: CommandId.make(newId()), threadId })
        .pipe(Effect.catchTag("OrchestrationCommandInvariantError", () => Effect.void));
  });
  /** The issue's shared worktree; the leader's thread holds it from the start. */
  const taskWorktree = Effect.fn("Assistant.taskWorktree")(function* (t: AssistantTask) {
    for (const id of [assistantTaskThreadId(t, "lead"), t.threadId]) {
      const shell = yield* snapshots.getThreadShellById(id, { includeArchived: true });
      if (Option.isSome(shell) && shell.value.worktreePath)
        return { path: shell.value.worktreePath, branch: shell.value.branch };
    }
    return null;
  });
  /**
   * A team is done: archive its threads and, for work its leader ran, remove
   * the worktree. Git keeps a worktree with uncommitted changes, and so do we.
   */
  const closeTeam = Effect.fn("Assistant.closeTeam")(function* (t: AssistantTask) {
    // Several threads can settle after a delivery; the first close is the one
    // that counts, and its archived lead thread says the team is already closed.
    const primary = t.leader ? assistantTaskThreadId(t, "lead") : t.threadId;
    const held = yield* snapshots.getThreadShellById(primary, { includeArchived: true });
    if (Option.isSome(held) && held.value.archivedAt !== null) return;
    const worktree = yield* taskWorktree(t);
    for (const threadId of taskThreadIds(t)) {
      yield* terminals.close({ threadId });
      yield* archiveThread(threadId);
    }
    const root = yield* snapshots.getProjectShellById(t.projectId);
    if (!t.leader || !worktree || Option.isNone(root)) return;
    yield* verifier
      .removeWorktree({ cwd: root.value.workspaceRoot, worktreePath: worktree.path })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("Developer assistant kept a finished issue's worktree", {
            worktree: worktree.path,
            error,
          }),
        ),
      );
  });
  /** Post a phase update on the issue. Delivery never waits on Linear; a failure is noted on the task. */
  const postLinear = Effect.fn("Assistant.postLinear")(function* (t: AssistantTask, body: string) {
    return yield* linear.createComment({ issueId: t.issue.id, body }).pipe(
      Effect.map((comment): AssistantTask => ({
        ...t,
        linearCommentIds: [...(t.linearCommentIds ?? []), comment.id],
      })),
      Effect.catch((error) =>
        Effect.succeed<AssistantTask>({
          ...t,
          error: `Could not post the update on Linear: ${linearFailureDetail(error)}`,
        }),
      ),
    );
  });
  /**
   * On delivery the issue's description gets a "What shipped" section, so the
   * issue itself says what was delivered rather than only its comments.
   * Delivery never waits on Linear; a failure is noted on the task.
   */
  const updateDescription = Effect.fn("Assistant.updateDescription")(function* (
    t: AssistantTask,
    p: AwaitedProject,
    e2e: AssistantE2eResult,
  ) {
    const deployment = t.deployment;
    if (!deployment) return t;
    return yield* linear.getIssue({ reference: t.issue.id }).pipe(
      Effect.flatMap((issue) =>
        linear.updateIssue({
          issueId: t.issue.id,
          description: deliveredDescription({
            current: issue.description,
            merge: t.merge ?? null,
            e2e,
            deployment,
            acceptedState: p.config.acceptedState,
          }),
        }),
      ),
      Effect.as(t),
      Effect.catch((error) =>
        Effect.succeed<AssistantTask>({
          ...t,
          error:
            [
              t.error,
              `Could not update the issue description on Linear: ${linearFailureDetail(error)}`,
            ]
              .filter(Boolean)
              .join(" ") || null,
        }),
      ),
    );
  });

  const board = Effect.fn("Assistant.board")(function* (projectId: string | null) {
    const projects =
      yield* sql<ProjectRow>`SELECT * FROM assistant_projects WHERE (${projectId ?? null} IS NULL OR project_id = ${projectId ?? null})`;
    const tasks =
      yield* sql<TaskRow>`SELECT * FROM assistant_tasks WHERE (${projectId ?? null} IS NULL OR project_id = ${projectId ?? null}) AND (status NOT IN ('accepted','skipped','declined') OR id IN (
      SELECT id FROM assistant_tasks WHERE status IN ('accepted','skipped','declined') ORDER BY rowid DESC LIMIT 200
    )) ORDER BY rowid DESC`;
    const decisions = yield* sql<{
      data: string;
      resolved: number;
    }>`SELECT data, resolved FROM assistant_decisions WHERE (${projectId ?? null} IS NULL OR project_id = ${projectId ?? null}) AND (resolved = 0 OR id IN (
      SELECT id FROM assistant_decisions WHERE resolved = 1 ORDER BY rowid DESC LIMIT 50
    )) ORDER BY resolved, rowid DESC`;
    return {
      setups: yield* setup.list(projectId),
      projects: yield* Effect.forEach(projects, (p) =>
        decodeConfig(p.config).pipe(
          Effect.map((config) => ({
            config,
            threadId: ThreadId.make(p.thread_id),
            status: p.status,
            error: p.error,
            limitedUntil: p.limited_until,
          })),
        ),
      ),
      tasks: yield* Effect.forEach(tasks, (t) => decodeTask(t.data)),
      decisions: yield* Effect.forEach(decisions, (d) =>
        decodeDecision(d.data).pipe(
          Effect.map((value) =>
            d.resolved && value.answer === null ? { ...value, answer: "Closed" } : value,
          ),
        ),
      ),
    } satisfies AssistantBoard;
  }, Effect.mapError(wrap));

  const authorize = Effect.fn("Assistant.authorize")(function* (
    threadId: ThreadId,
    coordinatorOnly = true,
  ) {
    const rows =
      yield* sql<ProjectRow>`SELECT * FROM assistant_projects WHERE thread_id = ${threadId}`;
    if (rows[0]) return yield* project(rows[0].project_id);
    if (!coordinatorOnly) {
      const owner = yield* threadTask(threadId);
      if (owner) return yield* project(owner.task.projectId);
    }
    return yield* fail(
      "This tool is only available to the project's developer assistant or one of an issue's threads.",
    );
  });
  /** A tool only one of an active issue's threads may call. */
  const authorizeRole = Effect.fn("Assistant.authorizeRole")(function* (
    threadId: ThreadId,
    role: AssistantThreadRole,
  ) {
    const owner = yield* threadTask(threadId);
    if (!owner || owner.role !== role)
      return yield* fail(
        `Only the issue's ${role === "implement" ? "implementation" : ROLE_TITLES[role]} thread can use this tool.`,
      );
    const p = yield* project(owner.task.projectId);
    if (p.status === "stopped") return yield* fail("The assistant is stopped.");
    if (!assistantTaskHoldsProject(owner.task.status))
      return yield* fail("This issue is no longer active.");
    return { p, t: owner.task };
  });
  /** The issue a tool acts on: a team leader's own, or the one the assistant names. */
  const authorizeTask = Effect.fn("Assistant.authorizeTask")(function* (
    caller: ThreadId,
    taskId: string | undefined,
  ) {
    const owner = yield* threadTask(caller);
    if (owner?.role === "lead") {
      if (taskId && taskId !== owner.task.id)
        return yield* fail("A team leader acts only on its own issue.");
      return { p: yield* project(owner.task.projectId), t: owner.task, lead: true };
    }
    const p = yield* authorize(caller);
    if (!taskId) return yield* fail("Name the issue with its taskId from assistant_get_board.");
    const t = yield* task(taskId);
    if (t.projectId !== p.project_id) return yield* fail("This issue belongs to another project.");
    return { p, t, lead: false };
  });

  /** The project's issues in its ready states, as Linear lists them. */
  const readyIssues = Effect.fn("Assistant.readyIssues")(function* (
    config: AssistantProjectConfig,
  ) {
    const issues: LinearIssueSummary[] = [];
    let cursor: string | undefined;
    do {
      const page = yield* linear.listIssues({
        projectId: config.linearProjectId,
        assignedToMe: config.assignedToMe,
        stateTypes: config.readyStates.length ? OPEN_STATE_TYPES : ["unstarted"],
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      issues.push(...page.issues);
      cursor = page.pageInfo?.hasNextPage ? (page.pageInfo.endCursor ?? undefined) : undefined;
    } while (cursor && issues.length < 1000);
    return issues.filter(
      (issue) => !config.readyStates.length || config.readyStates.includes(issue.state.name),
    );
  });
  /** Issues a thread outside the assistant is working on. */
  const humanClaims = Effect.fn("Assistant.humanClaims")(function* () {
    const shell = yield* snapshots.getShellSnapshot();
    return new Set(
      shell.threads.flatMap((thread) =>
        thread.linkedIssue && !assistantThreadKind(thread.id) ? [thread.linkedIssue.id] : [],
      ),
    );
  });
  /** Ready issues no team and no person's thread has claimed, in the order the loop takes them. */
  const unclaimed = Effect.fn("Assistant.unclaimed")(function* (
    projectId: string,
    issues: ReadonlyArray<LinearIssueSummary>,
  ) {
    // Scoped to this project: two assistants on one Linear project each keep
    // their own claims rather than hiding every issue from each other.
    const claimedRows = yield* sql<{
      issue_id: string;
    }>`SELECT DISTINCT issue_id FROM assistant_tasks WHERE project_id = ${projectId} AND status != 'changes-requested'`;
    const claimed = new Set(claimedRows.map((t) => t.issue_id));
    const human = yield* humanClaims();
    return issues
      .filter((issue) => !claimed.has(issue.id) && !human.has(issue.id))
      .sort(byPriority);
  });
  const candidates = Effect.fn("Assistant.candidates")(function* (config: AssistantProjectConfig) {
    return yield* unclaimed(config.projectId, yield* readyIssues(config));
  });
  const createCoordinator = Effect.fn("Assistant.createCoordinator")(function* (p: AwaitedProject) {
    const shell = yield* snapshots.getProjectShellById(p.config.projectId);
    if (Option.isNone(shell)) return yield* fail("The T3 project no longer exists.");
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`assistant:${p.thread_id}:create`),
      threadId: ThreadId.make(p.thread_id),
      projectId: p.config.projectId,
      title: `Developer assistant · ${shell.value.title}`,
      modelSelection: p.config.modelSelection,
      runtimeMode: p.config.runtimeMode,
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: yield* now,
    });
  });
  type AwaitedProject = Effect.Success<ReturnType<typeof project>>;

  const configureProject = Effect.fn("Assistant.configure")(function* (
    config: AssistantProjectConfig,
  ) {
    const deploymentError = validateDeploymentConfig(config);
    if (deploymentError) return yield* deploymentError;
    const shell = yield* snapshots.getProjectShellById(config.projectId);
    if (Option.isNone(shell)) return yield* fail("Select an existing T3 project.");
    const existing =
      yield* sql<ProjectRow>`SELECT * FROM assistant_projects WHERE project_id = ${config.projectId}`;
    if (existing[0]?.status === "running")
      return yield* fail("Stop the assistant before changing its project setup.");
    // An issue in progress stays on the branch and Linear project it started
    // from. Everything else applies to the threads started after the save.
    const current = existing[0] ? yield* decodeConfig(existing[0].config) : null;
    const inProgress = yield* heldTasks(config.projectId);
    if (
      inProgress.length &&
      current &&
      (current.baseBranch !== config.baseBranch ||
        current.linearProjectId !== config.linearProjectId)
    ) {
      const names = inProgress.slice(0, 3).map((t) => t.issue.identifier);
      return yield* fail(
        `${names.join(", ")} ${names.length > 1 ? "are" : "is"} still in progress on ${current.baseBranch}. Keep the base branch and Linear project until ${names.length > 1 ? "they are" : "it is"} finished or skipped.`,
      );
    }
    const repositoryKey = yield* verifier.repositoryKey(shell.value.workspaceRoot);
    const sameRepo =
      yield* sql`SELECT project_id FROM assistant_projects WHERE repository_key = ${repositoryKey} AND project_id != ${config.projectId}
          UNION SELECT project_id FROM assistant_setups WHERE repository_key = ${repositoryKey} AND project_id != ${config.projectId}`;
    if (sameRepo.length)
      return yield* fail(
        "This repository already has a developer assistant. Use its existing project to preserve sequential work.",
      );
    const previousThread = existing[0]
      ? yield* snapshots.getThreadShellById(ThreadId.make(existing[0].thread_id), {
          includeArchived: true,
        })
      : Option.none();
    if (Option.isSome(previousThread) && (yield* threadBusy(previousThread.value)))
      return yield* fail(
        "Wait for the assistant's interrupted turn to finish before changing its setup.",
      );
    const threadId = Option.isSome(previousThread)
      ? previousThread.value.id
      : `assistant-${newId()}`;
    if (existing[0] && existing[0].thread_id !== threadId) {
      yield* sql`UPDATE assistant_messages SET delivered = 1 WHERE thread_id = ${existing[0].thread_id}`;
      yield* sql`UPDATE assistant_decisions SET resolved = 1 WHERE thread_id = ${existing[0].thread_id}`;
    }
    // A setup revision rebuilds the config from the plan and the person's
    // preferences, which carry no picking choice: the one the Start button
    // saved stands until they start the loop again.
    const saved: AssistantProjectConfig =
      config.autoPick === undefined && current?.autoPick !== undefined
        ? { ...config, autoPick: current.autoPick }
        : config;
    yield* sql`INSERT INTO assistant_projects (project_id, repository_key, thread_id, config) VALUES (${config.projectId}, ${repositoryKey}, ${threadId}, ${encodeConfig(saved)})
      ON CONFLICT(project_id) DO UPDATE SET repository_key = excluded.repository_key, thread_id = excluded.thread_id, config = excluded.config, error = NULL`;
    yield* sql`UPDATE assistant_messages SET delivered = 1 WHERE thread_id = ${threadId} AND delivered = 0`;
    yield* createCoordinator(yield* project(config.projectId));
    yield* changed;
  }, Effect.mapError(wrap));

  const setup = yield* makeSetup({
    changed,
    threadBusy: (thread) => threadBusy(thread).pipe(Effect.mapError(wrap)),
    configure: configureProject,
  });
  const configure = Effect.fn("Assistant.configureFromClient")(
    function* (config: AssistantProjectConfig) {
      const pending = yield* setup.list(config.projectId);
      if (pending.length)
        return yield* fail(
          "Finish or cancel the setup conversation before changing configuration directly.",
        );
      yield* configureProject(config);
      return yield* board(null);
    },
    lock.withPermits(1),
    deliveryLock.withPermits(1),
    Effect.mapError(wrap),
  );
  const beginSetup = (input: AssistantSetupInput) =>
    setup
      .begin(input)
      .pipe(lock.withPermits(1), deliveryLock.withPermits(1), Effect.mapError(wrap));
  const getSetup = (caller: ThreadId) => setup.read(caller).pipe(Effect.mapError(wrap));
  const proposeSetup = (caller: ThreadId, plan: AssistantSetupPlan, summary: string) =>
    setup.propose(caller, plan, summary).pipe(lock.withPermits(1), Effect.mapError(wrap));
  const resolveSetup = (input: typeof AssistantSetupResolveInput.Type) =>
    setup
      .resolve(input)
      .pipe(
        Effect.andThen(board(null)),
        lock.withPermits(1),
        deliveryLock.withPermits(1),
        Effect.mapError(wrap),
      );

  /**
   * Start runs the loop. Pause stops the loop taking issues, while teams at
   * work and issues the person dispatches carry on; from stopped it resumes the
   * teams with the loop still paused. Interrupt stops everything mid-turn.
   */
  const control = Effect.fn("Assistant.control")(
    function* (input: typeof AssistantControlInput.Type) {
      let p = yield* project(input.projectId);
      const action = input.action === "stop" ? "pause" : input.action;
      if (action === "interrupt") {
        // Under the board lock: interrupting reads the board and then writes to
        // every held issue, and a turn ending meanwhile writes to the same rows.
        yield* Effect.gen(function* () {
          yield* sql`UPDATE assistant_projects SET status = 'stopped', limited_until = NULL WHERE project_id = ${input.projectId}`;
          yield* engine
            .dispatch({
              type: "thread.turn.interrupt",
              commandId: CommandId.make(newId()),
              threadId: ThreadId.make(p.thread_id),
              createdAt: yield* now,
            })
            .pipe(Effect.catch(() => Effect.void));
          const b = yield* board(input.projectId);
          for (const held of b.tasks.filter((t) => assistantTaskHoldsProject(t.status))) {
            // A worker whose worktree setup failed never got a thread to interrupt.
            for (const threadId of taskThreadIds(held)) {
              yield* engine
                .dispatch({
                  type: "thread.turn.interrupt",
                  commandId: CommandId.make(newId()),
                  threadId,
                  createdAt: yield* now,
                })
                .pipe(Effect.catch(() => Effect.void));
              yield* terminals.close({ threadId });
            }
            // The interrupts above are awaited, so the issue is re-read rather
            // than written back as it stood before them.
            yield* saveTask({
              ...(yield* task(held.id)),
              status: "blocked",
              error: "Interrupted by you. Resume the assistant to recover this issue, or skip it.",
            });
          }
        }).pipe(lock.withPermits(1));
      } else if (action === "pause" && p.status !== "stopped") {
        yield* sql`UPDATE assistant_projects SET status = 'paused' WHERE project_id = ${input.projectId}`;
      } else {
        if ((yield* setup.list(input.projectId)).length)
          return yield* fail(
            "Save or cancel the project's setup conversation before starting the queue.",
          );
        const connection = yield* linear.status;
        if (connection.status !== "connected")
          return yield* fail("Connect Linear before starting the assistant.");
        if (!(yield* settings.getSettings).linear.agentAccess)
          return yield* fail(
            "Enable Linear agent access in Settings → Integrations → Linear first.",
          );
        // What the person chose on the Start button is the loop's mode from
        // here on. Earlier clients send no options and keep the config as it is.
        if (action === "start" && input.options) {
          const options = input.options;
          const chosen: AssistantProjectConfig = {
            ...p.config,
            autoPick: options.autoPick,
            assignedToMe: options.assignedToMe,
            // Earlier clients send no count and keep the one the config has.
            ...(options.parallelIssues === undefined
              ? {}
              : { parallelIssues: options.parallelIssues }),
          };
          yield* sql`UPDATE assistant_projects SET config = ${encodeConfig(chosen)} WHERE project_id = ${input.projectId}`;
          p = yield* project(input.projectId);
        }
        // Only a deleted coordinator is replaced; an archived one keeps its decisions.
        const coordinator = yield* snapshots.getThreadShellById(ThreadId.make(p.thread_id), {
          includeArchived: true,
        });
        if (Option.isNone(coordinator)) {
          const replacement = `assistant-${newId()}`;
          yield* sql`UPDATE assistant_messages SET delivered = 1 WHERE thread_id = ${p.thread_id}`;
          yield* sql`UPDATE assistant_decisions SET resolved = 1 WHERE thread_id = ${p.thread_id}`;
          yield* sql`UPDATE assistant_projects SET thread_id = ${replacement} WHERE project_id = ${input.projectId}`;
          p = yield* project(input.projectId);
        }
        yield* createCoordinator(p);
        yield* engine.dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make(newId()),
          threadId: ThreadId.make(p.thread_id),
          runtimeMode: p.config.runtimeMode,
          createdAt: yield* now,
        });
        // Archiving stops the assistant, so resuming restores its conversation.
        if (Option.isSome(coordinator) && coordinator.value.archivedAt !== null)
          yield* engine.dispatch({
            type: "thread.unarchive",
            commandId: CommandId.make(newId()),
            threadId: ThreadId.make(p.thread_id),
          });
        const status =
          action === "pause" || (action === "wake" && p.status === "paused") ? "paused" : "running";
        // The person may have switched accounts or seen the limit reset early,
        // so starting lifts a usage-limit hold and sends what was waiting.
        yield* sql`UPDATE assistant_projects SET status = ${status}, error = NULL, external_waits = 0, limited_until = NULL WHERE project_id = ${input.projectId}`;
        const held = yield* heldTasks(input.projectId);
        if (action === "start") {
          declineStreak.delete(input.projectId);
          // Work from before team leaders still needs the assistant to carry it.
          // Otherwise it is woken only to receive instructions it does not have yet.
          const legacy = held.find((t) => !t.leader);
          if (legacy)
            yield* wake(
              input.projectId,
              `The person started the assistant. ${legacy.issue.identifier} was started before issues had team leaders, so it is still yours to carry to review: check its threads with assistant_read_thread and take the next step. The issue loop starts once it is done.`,
            );
          else if (
            briefed.get(input.projectId) !== `${p.thread_id}\n${assistantInstructions(p.config)}`
          )
            yield* wake(
              input.projectId,
              "The person started the issue loop. Nothing needs you now.",
            );
        }
        // An interrupted issue waits for someone to pick its threads back up.
        if (action === "start" || p.status === "stopped")
          for (const blocked of held.filter((t) => t.status === "blocked"))
            yield* notifyLead(
              blocked,
              `The person resumed the assistant while this issue was blocked (${blocked.error ?? "see its threads"}). Check each of its threads with assistant_read_thread and continue where the work stopped.`,
            );
        // The loop fills the project up to its limit; advance stops there.
        yield* advance(input.projectId).pipe(
          lock.withPermits(1),
          Effect.catch(
            (error) =>
              sql`UPDATE assistant_projects SET error = ${wrap(error).detail} WHERE project_id = ${input.projectId}`,
          ),
        );
      }
      yield* changed;
      return yield* board(null);
    },
    deliveryLock.withPermits(1),
    Effect.mapError(wrap),
  );

  /** Work from before team leaders: the worker's own worktree, prepared on its first turn. */
  const prepareTask = Effect.fn("Assistant.prepareTask")(function* (
    p: AwaitedProject,
    value: AssistantTask,
  ) {
    const shell = yield* snapshots.getProjectShellById(p.config.projectId);
    if (Option.isNone(shell)) return yield* fail("The T3 project no longer exists.");
    const prepared = yield* linearThreads.prepareIssueThread({
      cwd: shell.value.workspaceRoot,
      reference: value.issue.id,
      mode: "worktree",
      threadId: value.threadId,
      baseBranch: p.config.baseBranch,
      branch: `assistant/${value.issue.identifier.toLowerCase()}-${value.id.slice(0, 8)}`,
    });
    if (!prepared.worktreePath)
      return yield* fail("A coding worker requires an isolated worktree.");
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`${value.id}:create`),
      threadId: value.threadId,
      projectId: p.config.projectId,
      title: `${value.issue.identifier}: ${value.issue.title}`,
      modelSelection: p.config.workerModelSelection,
      runtimeMode: p.config.runtimeMode,
      interactionMode: "default",
      branch: prepared.branch,
      worktreePath: prepared.worktreePath,
      linkedIssue: {
        provider: "linear",
        id: value.issue.id,
        identifier: value.issue.identifier,
        url: value.issue.url,
      },
      createdAt: value.createdAt,
    });
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* saveTask({ ...value, status: "working", turns: 1, error: null });
        yield* queueMessage(
          value.projectId,
          value.threadId,
          `${value.id}:turn:1`,
          workerInstructions(p.config, value),
        );
      }),
    );
    return yield* task(value.id);
  });

  /**
   * Queue a turn for one of the issue's threads, creating the review or e2e
   * thread on the implementation worktree the first time it is needed. A new
   * thread starts with its role's instructions; later turns are the message alone.
   */
  const queueRoleTurn = Effect.fn("Assistant.queueRoleTurn")(function* (
    p: AwaitedProject,
    t: AssistantTask,
    role: AssistantThreadRole,
    message: string,
    instructions: () => string,
  ) {
    const threadId = assistantTaskThreadId(t, role);
    if (role === "review" || role === "e2e") {
      const existing = yield* snapshots.getThreadShellById(threadId, { includeArchived: true });
      if (Option.isNone(existing)) {
        const worker = yield* snapshots.getThreadShellById(t.threadId, { includeArchived: true });
        if (Option.isNone(worker) || !worker.value.worktreePath)
          return yield* fail("The worker's worktree could not be found.");
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${t.id}:${role}:create`),
          threadId,
          projectId: p.config.projectId,
          title: `${t.issue.identifier} · ${ROLE_TITLES[role]}`,
          modelSelection: p.config.workerModelSelection,
          runtimeMode: p.config.runtimeMode,
          interactionMode: "default",
          branch: worker.value.branch,
          worktreePath: worker.value.worktreePath,
          linkedIssue: {
            provider: "linear",
            id: t.issue.id,
            identifier: t.issue.identifier,
            url: t.issue.url,
          },
          createdAt: yield* now,
        });
      } else if (existing.value.archivedAt !== null) {
        yield* engine.dispatch({
          type: "thread.unarchive",
          commandId: CommandId.make(newId()),
          threadId,
        });
      }
    }
    // Keyed on what was sent, not on the thread existing, so a failure between
    // creating the thread and queueing its first turn still sends the instructions.
    const sent =
      yield* sql`SELECT id FROM assistant_messages WHERE thread_id = ${threadId} LIMIT 1`;
    yield* queueMessage(
      p.project_id,
      threadId,
      `${t.id}:${role}:${newId()}`,
      sent.length ? message : `${instructions()}\n\n${message}`,
    );
  });

  const newTask = Effect.fn("Assistant.newTask")(function* (
    p: AwaitedProject,
    issue: LinearIssueSummary,
    fields: Partial<Pick<AssistantTask, "status" | "brief" | "feedback" | "dispatched">>,
  ) {
    const timestamp = yield* now;
    const id = newId();
    const value: AssistantTask = {
      id,
      projectId: p.config.projectId,
      issue,
      threadId: ThreadId.make(`assistant-work-${id}`),
      status: "preparing",
      brief: "",
      summary: "",
      reviewInstructions: "",
      feedback: "",
      turns: 0,
      turnLimit: p.config.maxWorkerTurns,
      deployment: null,
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      stage: "lead",
      codeReview: null,
      merge: null,
      e2e: null,
      linearCommentIds: [],
      leader: true,
      // Fixed when the issue is created, so a setup change mid-issue does not
      // move the goalposts for the team working it.
      e2eEnvironment: assistantE2eEnvironment(p.config),
      ...fields,
    };
    return value;
  });
  /** Every comment T3 posted on an issue, across the teams that worked on it. */
  const postedComments = Effect.fn("Assistant.postedComments")(function* (issueId: string) {
    const rows = yield* sql<TaskRow>`SELECT * FROM assistant_tasks WHERE issue_id = ${issueId}`;
    const tasks = yield* Effect.forEach(rows, (row) => decodeTask(row.data));
    return tasks.flatMap((t) => t.linearCommentIds ?? []);
  });

  /** The team's worktree, fresh from the base branch, and its leader's thread in it. */
  const prepareTeam = Effect.fn("Assistant.prepareTeam")(function* (
    p: AwaitedProject,
    t: AssistantTask,
  ) {
    const shell = yield* snapshots.getProjectShellById(p.config.projectId);
    if (Option.isNone(shell)) return yield* fail("The T3 project no longer exists.");
    const prepared = yield* linearThreads.prepareIssueThread({
      cwd: shell.value.workspaceRoot,
      reference: t.issue.id,
      mode: "worktree",
      threadId: t.threadId,
      baseBranch: p.config.baseBranch,
      branch: `assistant/${t.issue.identifier.toLowerCase()}-${t.id.slice(0, 8)}`,
      // Linear moves to started once the leader takes the issue.
      moveToStarted: false,
    });
    if (!prepared.worktreePath) return yield* fail("A team requires an isolated worktree.");
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`${t.id}:lead:create`),
      threadId: assistantTaskThreadId(t, "lead"),
      projectId: p.config.projectId,
      title: `${t.issue.identifier} · ${ROLE_TITLES.lead}`,
      modelSelection: p.config.modelSelection,
      runtimeMode: p.config.runtimeMode,
      interactionMode: "default",
      branch: prepared.branch,
      worktreePath: prepared.worktreePath,
      linkedIssue: {
        provider: "linear",
        id: t.issue.id,
        identifier: t.issue.identifier,
        url: t.issue.url,
      },
      createdAt: yield* now,
    });
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* saveTask({ ...t, status: "working", error: null });
        yield* queueMessage(
          t.projectId,
          assistantTaskThreadId(t, "lead"),
          `${t.id}:lead:start`,
          leadInstructions(p.config, t),
        );
      }),
    );
    return yield* task(t.id);
  });
  /**
   * Give an issue to a new team. A setup failure leaves the issue blocked for a
   * retry. The team takes the lowest slot the project's other teams leave free,
   * which project instructions derive per-team resources from.
   */
  const startTeam = Effect.fn("Assistant.startTeam")(function* (
    p: AwaitedProject,
    value: AssistantTask,
  ) {
    const taken = new Set(
      (yield* heldTasks(p.project_id)).flatMap((other) =>
        other.id !== value.id && other.slot !== undefined ? [other.slot] : [],
      ),
    );
    let slot = 0;
    while (taken.has(slot)) slot += 1;
    const t: AssistantTask = {
      ...value,
      status: "preparing",
      stage: "lead",
      leader: true,
      turns: 0,
      error: null,
      slot,
      wait: null,
      updatedAt: yield* now,
    };
    yield* sql`INSERT INTO assistant_tasks (id, project_id, issue_id, thread_id, status, data) VALUES (${t.id}, ${p.project_id}, ${t.issue.id}, ${t.threadId}, ${t.status}, ${encodeTask(t)})
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data`;
    yield* sql`UPDATE assistant_projects SET external_waits = 0 WHERE project_id = ${p.project_id}`;
    yield* changed;
    return yield* prepareTeam(p, t).pipe(
      Effect.catch((error) => saveTask({ ...t, status: "blocked", error: wrap(error).detail })),
    );
  });

  /** Declined issues that someone has changed since, eligible again. */
  const changedSinceDeclined = Effect.fn("Assistant.changedSinceDeclined")(function* (
    p: AwaitedProject,
    ready: ReadonlyArray<LinearIssueSummary>,
  ) {
    const rows =
      yield* sql<TaskRow>`SELECT * FROM assistant_tasks t WHERE project_id = ${p.project_id} AND status = 'declined'
      AND rowid = (SELECT MAX(rowid) FROM assistant_tasks WHERE issue_id = t.issue_id AND project_id = ${p.project_id})`;
    const human = yield* humanClaims();
    const listed = new Map(ready.map((issue) => [issue.id, issue]));
    const edited: LinearIssueSummary[] = [];
    for (const row of rows) {
      const t = yield* decodeTask(row.data);
      const issue = listed.get(t.issue.id);
      // Linear's timestamp is a cheap first check; the fingerprint decides.
      if (!issue || !t.declined || human.has(issue.id)) continue;
      if (issue.updatedAt === t.declined.issueUpdatedAt) continue;
      const detail = yield* linear.getIssue({ reference: issue.id });
      if (issueFingerprint(detail, yield* postedComments(issue.id)) !== t.declined.fingerprint)
        edited.push(issue);
      else yield* saveTask({ ...t, declined: { ...t.declined, issueUpdatedAt: detail.updatedAt } });
    }
    return edited;
  });

  /**
   * The loop. It fills the project up to the issues it works at once, each on
   * its own team: an issue the person dispatched first, then, unless the loop
   * is paused or set not to pick issues itself, an issue sent back for changes,
   * then ready issues by priority, including a declined issue someone has
   * changed since. Linear's ready issues are read at most once per pass.
   */
  const advance = Effect.fn("Assistant.advance")(function* (projectId: string) {
    const p = yield* project(projectId);
    if (p.status === "stopped") return;
    // A new team's first turn would only fail the same way until the limit resets.
    if (yield* limited(p)) return;
    const limit = assistantParallelIssues(p.config);
    let held = (yield* heldTasks(projectId)).length;
    // Issues this pass already gave a team, so a second look does not pick them again.
    const taken = new Set<string>();
    let ready: ReadonlyArray<LinearIssueSummary> | null = null;
    /** The next issue to give a team, or null when the project has nothing left to start. */
    const next = Effect.fn("Assistant.nextIssue")(function* () {
      const dispatched =
        yield* sql<TaskRow>`SELECT * FROM assistant_tasks WHERE project_id = ${projectId} AND status = 'queued' ORDER BY rowid`;
      for (const row of dispatched) {
        const queued = yield* decodeTask(row.data);
        if (!taken.has(queued.issue.id)) return queued;
      }
      const sentBack =
        yield* sql<TaskRow>`SELECT * FROM assistant_tasks t WHERE project_id = ${projectId} AND status = 'changes-requested'
      AND rowid = (SELECT MAX(rowid) FROM assistant_tasks WHERE issue_id = t.issue_id AND project_id = ${projectId}) ORDER BY rowid`;
      for (const row of sentBack) {
        const previous = yield* decodeTask(row.data);
        if (taken.has(previous.issue.id)) continue;
        // A loop that is paused, or set not to pick issues, takes nothing of its
        // own; an issue the person dispatched stays theirs, so their change
        // request goes to a new team all the same.
        if ((p.status === "paused" || !assistantPicksIssues(p.config)) && !previous.dispatched)
          continue;
        // One issue Linear cannot be read for must not hold up the rest of the scan.
        const read = yield* linear.getIssue({ reference: previous.issue.id }).pipe(
          Effect.map(Option.some<LinearIssueDetail>),
          Effect.catch((error) =>
            Effect.logDebug("Developer assistant could not read a sent-back issue in Linear", {
              issue: previous.issue.identifier,
              error,
            }).pipe(Effect.as(Option.none<LinearIssueDetail>())),
          ),
        );
        if (Option.isNone(read)) continue;
        const issue = read.value;
        // Closed or accepted in Linear after it was sent back: nothing is left to redo.
        if (acceptedInLinear(issue.state, p.config) || issue.state.type === "canceled") {
          yield* saveTask({
            ...previous,
            status: issue.state.type === "canceled" ? "skipped" : "accepted",
          });
          continue;
        }
        return yield* newTask(p, issue, {
          feedback: previous.feedback,
          ...(previous.dispatched ? { dispatched: true } : {}),
        });
      }
      // Nothing is read from Linear while the loop is paused or picks nothing.
      if (p.status === "paused" || !assistantPicksIssues(p.config)) return null;
      ready ??= yield* readyIssues(p.config);
      const pick = [
        ...(yield* unclaimed(projectId, ready)),
        ...(yield* changedSinceDeclined(p, ready)),
      ]
        .sort(byPriority)
        .find((issue) => !taken.has(issue.id));
      return pick ? yield* newTask(p, pick, {}) : null;
    });
    while (held < limit) {
      const value = yield* next();
      if (!value) return;
      taken.add(value.issue.id);
      yield* startTeam(p, value);
      held += 1;
    }
  });

  /**
   * The person gives an issue to the next team, from the board or through the
   * assistant. It goes ahead of the loop's own picks and runs while the loop is
   * paused. Its team leader takes it or asks; it does not decline it.
   */
  const dispatchIssue = Effect.fn("Assistant.dispatchIssue")(function* (
    p: AwaitedProject,
    reference: string,
    note: string,
  ) {
    const issue = yield* linear.getIssue({ reference });
    if (issue.project?.id !== p.config.linearProjectId)
      return yield* fail("This issue is outside the assistant's Linear project.");
    if (acceptedInLinear(issue.state, p.config) || issue.state.type === "canceled")
      return yield* fail("This issue is closed in Linear.");
    const rows =
      yield* sql<TaskRow>`SELECT * FROM assistant_tasks WHERE project_id = ${p.project_id} AND issue_id = ${issue.id} ORDER BY rowid DESC LIMIT 1`;
    const previous = rows[0] ? yield* decodeTask(rows[0].data) : undefined;
    if (previous && (previous.status === "queued" || assistantTaskHoldsProject(previous.status)))
      return previous;
    if (previous?.status === "review")
      return yield* fail(
        "This issue is waiting for the person's review. Moving it back in Linear gives it to a new team with their feedback.",
      );
    if ((yield* humanClaims()).has(issue.id))
      return yield* fail("A thread outside the assistant is already working on this issue.");
    const value = yield* newTask(p, issue, {
      status: "queued",
      dispatched: true,
      brief: note,
      feedback: previous?.status === "changes-requested" ? previous.feedback : "",
    });
    yield* sql`INSERT INTO assistant_tasks (id, project_id, issue_id, thread_id, status, data) VALUES (${value.id}, ${p.project_id}, ${issue.id}, ${value.threadId}, ${value.status}, ${encodeTask(value)})`;
    yield* changed;
    // A free project starts it now; otherwise it waits for the active issue.
    yield* advance(p.project_id).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Developer assistant could not start the dispatched issue yet", {
          error,
        }),
      ),
    );
    return yield* task(value.id);
  });
  /** The assistant dispatches an issue the person asked for in its chat. */
  const dispatchFromAssistant = Effect.fn("Assistant.dispatchFromAssistant")(
    function* (caller: ThreadId, reference: string, note: string) {
      return yield* dispatchIssue(yield* authorize(caller), reference, note);
    },
    lock.withPermits(1),
    Effect.mapError(wrap),
  );
  const dispatch = Effect.fn("Assistant.dispatch")(
    function* (input: typeof AssistantDispatchInput.Type) {
      yield* dispatchIssue(yield* project(input.projectId), input.reference, input.note.trim());
      return yield* board(null);
    },
    lock.withPermits(1),
    Effect.mapError(wrap),
  );

  /** The team leader takes its issue: Linear moves to started and the worker gets the brief. */
  const acceptIssue = Effect.fn("Assistant.acceptIssue")(
    function* (caller: ThreadId, brief: string) {
      const { p, t } = yield* authorizeRole(caller, "lead");
      if (t.turns > 0)
        return yield* fail(
          "The team already took this issue. Direct the worker with assistant_message_worker.",
        );
      if (yield* taskDecisionsPending(t))
        return yield* fail("Wait for the answer to your open question before taking the issue.");
      const worktree = yield* taskWorktree(t);
      if (!worktree) return yield* fail("The issue's worktree could not be found.");
      yield* linearThreads.moveToStarted(t.issue);
      declineStreak.delete(p.project_id);
      if (Option.isNone(yield* snapshots.getThreadShellById(t.threadId, { includeArchived: true })))
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${t.id}:create`),
          threadId: t.threadId,
          projectId: p.config.projectId,
          title: `${t.issue.identifier}: ${t.issue.title}`,
          modelSelection: p.config.workerModelSelection,
          runtimeMode: p.config.runtimeMode,
          interactionMode: "default",
          branch: worktree.branch,
          worktreePath: worktree.path,
          linkedIssue: {
            provider: "linear",
            id: t.issue.id,
            identifier: t.issue.identifier,
            url: t.issue.url,
          },
          createdAt: yield* now,
        });
      const taken: AssistantTask = {
        ...t,
        brief,
        turns: 1,
        stage: "implement",
        status: "working",
        error: null,
      };
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* saveTask(taken);
          yield* queueMessage(
            t.projectId,
            t.threadId,
            `${t.id}:turn:1`,
            workerInstructions(p.config, taken),
          );
        }),
      );
      return yield* task(t.id);
    },
    lock.withPermits(1),
    Effect.mapError(wrap),
  );

  /**
   * The team leader does not take its issue. The reason goes on the issue, and
   * the loop leaves it until someone changes it. Several declines in a row
   * pause the loop: those issues need the person more than another team.
   */
  const declineIssue = Effect.fn("Assistant.declineIssue")(
    function* (caller: ThreadId, reason: string) {
      const { p, t } = yield* authorizeRole(caller, "lead");
      if (t.turns > 0)
        return yield* fail(
          "The team already took this issue. Ask the person with assistant_ask_decision, or explain the blocker and end your turn.",
        );
      if (t.dispatched)
        return yield* fail(
          "The person dispatched this issue to your team, so it cannot be declined. Ask them with assistant_ask_decision what stands in the way.",
        );
      const issue = yield* linear.getIssue({ reference: t.issue.id });
      const declined = {
        reason,
        fingerprint: issueFingerprint(issue, yield* postedComments(t.issue.id)),
        issueUpdatedAt: issue.updatedAt,
        at: yield* now,
      };
      const posted = yield* postLinear(t, declinedComment(reason));
      const ids = taskThreadIds(t);
      yield* sql`UPDATE assistant_decisions SET resolved = 1 WHERE resolved = 0 AND thread_id IN (${ids[0]}, ${ids[1]}, ${ids[2]}, ${ids[3]})`;
      const updated = yield* saveTask({ ...posted, status: "declined", declined });
      const streak = [...(declineStreak.get(p.project_id) ?? []), t.issue.identifier];
      if (streak.length < DECLINE_STREAK_LIMIT) declineStreak.set(p.project_id, streak);
      else {
        declineStreak.delete(p.project_id);
        yield* sql`UPDATE assistant_projects SET status = 'paused', error = ${`Team leaders declined ${streak.length} issues in a row (${streak.join(", ")}). Each reason is on its issue in Linear. Start to let the loop continue.`} WHERE project_id = ${p.project_id}`;
        yield* changed;
      }
      return updated;
    },
    lock.withPermits(1),
    Effect.mapError(wrap),
  );

  const readThread = Effect.fn("Assistant.readThread")(function* (
    caller: ThreadId,
    taskId: string | undefined,
    role: AssistantThreadRole = "implement",
  ) {
    const { t } = yield* authorizeTask(caller, taskId);
    const detail = yield* snapshots.getThreadDetailById(assistantTaskThreadId(t, role));
    // The recent end of the conversation; a whole transcript would crowd the reader's context.
    return {
      task: t,
      transcript: Option.isSome(detail)
        ? detail.value.messages
            .slice(-8)
            .map((m) => ({ role: m.role, text: m.text.slice(0, 8000) }))
        : [],
      sessionStatus: Option.isSome(detail)
        ? (detail.value.session?.status ?? "idle")
        : "archived or not started",
      worktreePath: Option.isSome(detail) ? detail.value.worktreePath : null,
    };
  }, Effect.mapError(wrap));

  const messageWorker = Effect.fn("Assistant.messageWorker")(
    function* (
      caller: ThreadId,
      taskId: string | undefined,
      message: string,
      role: AssistantThreadRole = "implement",
    ) {
      const { p, t, lead } = yield* authorizeTask(caller, taskId);
      if (p.status === "stopped") return yield* fail("The assistant is stopped.");
      if (!assistantTaskHoldsProject(t.status))
        return yield* fail(
          "Only the active issue's threads can receive follow-up work. An issue sent back from review goes to a new team.",
        );
      if (role === "lead" && (lead || !t.leader))
        return yield* fail(
          lead ? "Message the issue's other threads." : "This issue has no team leader.",
        );
      if (role === "implement" && t.leader && t.turns === 0)
        return yield* fail(
          "The team has not taken this issue yet. The team leader takes it with assistant_accept_issue.",
        );
      if (role === "implement" && t.turns >= t.turnLimit)
        return yield* fail(
          "This issue reached its worker turn limit. Ask the person to review it or explicitly retry from the assistant board.",
        );
      // In the worktree the tester runs on the approved commit, before any deployment.
      const testerReady =
        assistantTaskE2eEnvironment(t) === "worktree"
          ? t.codeReview?.verdict === "approved"
          : t.deployment !== null;
      if (
        role === "e2e" &&
        (!testerReady ||
          Option.isNone(
            yield* snapshots.getThreadShellById(assistantTaskThreadId(t, "e2e"), {
              includeArchived: true,
            }),
          ))
      )
        return yield* fail(
          assistantTaskE2eEnvironment(t) === "worktree"
            ? "Start the tester with assistant_start_e2e once code review approves the commit."
            : "Verify the staging deployment and start the tester with assistant_start_e2e first.",
        );
      // A tester that never got its run brief would read a follow-up as its
      // whole assignment, so the run is started before it can be messaged.
      if (role === "e2e") {
        const run =
          yield* sql`SELECT id FROM assistant_messages WHERE thread_id = ${assistantTaskThreadId(t, "e2e")} LIMIT 1`;
        if (!run.length) return yield* fail("Start the tester with assistant_start_e2e first.");
      }
      if (yield* taskDecisionsPending(t))
        return yield* fail(
          "The issue has an unanswered decision or permission request. If the person answered a decision in your chat, pass it on with assistant_answer_decision; otherwise wait for their answer.",
        );
      yield* releaseHandedOff(t);
      if (yield* taskBusy(t, caller))
        return yield* fail(
          "One of the issue's threads is still running. End your turn and wait for its result.",
        );
      if (yield* taskQueued(t, caller)) return t;
      if (role === "implement" && t.turns === 0) return yield* prepareTask(p, t);
      if (role !== "implement") {
        // Creating the review thread dispatches to the engine, which stays outside SQL transactions.
        yield* queueRoleTurn(p, t, role, message, () =>
          role === "lead" ? leadInstructions(p.config, t) : reviewerInstructions(p.config, t),
        );
        return yield* saveTask({ ...t, status: "working", error: null, stage: role });
      }
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* saveTask({
            ...t,
            status: "working",
            turns: t.turns + 1,
            error: null,
            ...(t.stage ? { stage: "implement" as const } : {}),
          });
          yield* queueMessage(p.project_id, t.threadId, `${t.id}:turn:${t.turns + 1}`, message);
        }),
      );
      return yield* task(t.id);
    },
    lock.withPermits(1),
    Effect.mapError(wrap),
  );

  const askDecision = Effect.fn("Assistant.askDecision")(
    function* (caller: ThreadId, question: string) {
      const p = yield* authorize(caller, false);
      if (p.status === "stopped") return yield* fail("The assistant is stopped.");
      const b = yield* board(p.project_id);
      const existing = b.decisions.find(
        (d) => d.threadId === caller && d.answer === null && d.question === question,
      );
      if (existing) return existing;
      const t = (yield* threadTask(caller))?.task;
      if (t && !assistantTaskHoldsProject(t.status))
        return yield* fail(
          "This issue is no longer active. Ask the developer assistant to schedule follow-up work.",
        );
      const value: AssistantDecision = {
        id: newId(),
        projectId: p.config.projectId,
        threadId: caller,
        taskId: t?.id ?? null,
        requestId: null,
        kind: "decision",
        question,
        answer: null,
        createdAt: yield* now,
      };
      yield* sql`INSERT INTO assistant_decisions (id, project_id, thread_id, data) VALUES (${value.id}, ${p.project_id}, ${caller}, ${encodeDecision(value)})`;
      // The inbox shows the question; the answer goes straight to the thread that asked.
      if (t) yield* saveTask({ ...t, status: "waiting" });
      yield* changed;
      return value;
    },
    lock.withPermits(1),
    Effect.mapError(wrap),
  );

  /** An open decision, or null once someone answered it. */
  const openDecision = Effect.fn("Assistant.openDecision")(function* (id: string) {
    const rows = yield* sql<{
      data: string;
      resolved: number;
    }>`SELECT * FROM assistant_decisions WHERE id = ${id}`;
    if (!rows[0]) return yield* fail("This decision no longer exists.");
    if (rows[0].resolved) return null;
    const d = yield* decodeDecision(rows[0].data);
    if (d.kind !== "decision")
      return yield* fail(
        "Answer this provider question or permission request in its original thread.",
      );
    return d;
  });
  /** Record the person's answer and send it to the thread that asked. */
  const resolveDecision = Effect.fn("Assistant.resolveDecision")(function* (
    d: AssistantDecision,
    text: string,
    via: "inbox" | "assistant",
  ) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`UPDATE assistant_decisions SET resolved = 1, data = ${encodeDecision({ ...d, answer: text })} WHERE id = ${d.id}`;
        if (d.taskId) {
          const t = yield* task(d.taskId);
          const asker = yield* threadTask(d.threadId);
          yield* queueMessage(
            d.projectId,
            d.threadId,
            `decision:${d.id}`,
            `The person answered your question${via === "assistant" ? " through the developer assistant" : ""}.\nQuestion: ${d.question}\nAnswer: ${text}\nContinue within the agreed scope.`,
          );
          yield* saveTask({
            ...t,
            status: "working",
            error: null,
            ...(t.stage && asker ? { stage: asker.role } : {}),
          });
        } else if (via === "inbox")
          // The assistant asked this itself. An answer it relayed, it already knows.
          yield* wake(d.projectId, `The person answered your question: ${d.question}\n${text}`);
      }),
    );
    yield* changed;
  });

  const answer = Effect.fn("Assistant.answer")(
    function* (input: typeof AssistantAnswerInput.Type) {
      const d = yield* openDecision(input.decisionId);
      if (d) yield* resolveDecision(d, input.answer, "inbox");
      return yield* board(null);
    },
    lock.withPermits(1),
    Effect.mapError(wrap),
  );

  /**
   * The coordinator passes on an answer the person gave in its chat. The
   * person still decides: the coordinator may only relay once they have
   * written to it since the question was asked.
   */
  const relayAnswer = Effect.fn("Assistant.relayAnswer")(
    function* (caller: ThreadId, decisionId: string, text: string) {
      const p = yield* authorize(caller);
      const d = yield* openDecision(decisionId);
      if (!d) return yield* fail("This decision was already answered.");
      if (d.projectId !== p.config.projectId)
        return yield* fail("This decision belongs to another project.");
      const detail = yield* snapshots.getThreadDetailById(caller);
      const since = Option.isSome(detail)
        ? detail.value.messages.filter(
            (m) => m.role === "user" && Date.parse(m.createdAt) > Date.parse(d.createdAt),
          )
        : [];
      let personSpoke = false;
      for (const m of since) {
        const automated = yield* sql`SELECT id FROM assistant_messages WHERE id = ${m.id}`;
        if (!automated.length) personSpoke = true;
      }
      if (!personSpoke)
        return yield* fail(
          "The person has not written to you since this question was asked. Only pass on an answer they gave you; do not answer from your own judgment.",
        );
      yield* resolveDecision(d, text, "assistant");
      return { ...d, answer: text };
    },
    lock.withPermits(1),
    Effect.mapError(wrap),
  );

  const changeLinearState = Effect.fn("Assistant.changeLinearState")(function* (
    t: AssistantTask,
    name: string,
  ) {
    if (!name.trim()) return;
    const states = yield* linear.workflowStates(t.issue.team.id);
    const state = states.find((s) => s.name.toLowerCase() === name.trim().toLowerCase());
    if (!state)
      return yield* fail(
        `Linear has no state named "${name}" on ${t.issue.team.key}. Update the issue manually and correct the assistant setup.`,
      );
    yield* linear.updateIssueState({ issueId: t.issue.id, stateId: state.id });
  });

  const requestReview = Effect.fn("Assistant.requestReview")(
    function* (caller: ThreadId, message: string) {
      const { p, t } = yield* authorizeRole(caller, "implement");
      const worker = yield* snapshots.getThreadShellById(t.threadId, { includeArchived: true });
      if (Option.isNone(worker) || !worker.value.worktreePath)
        return yield* fail("The worker's worktree could not be found.");
      // The reviewer approves a commit, so there must be one: this fails on uncommitted work.
      yield* verifier.revision(worker.value.worktreePath);
      // New code voids the last approval and anything that was verified with it.
      const updated = yield* saveTask({
        ...t,
        status: "working",
        stage: "review",
        merge: null,
        deployment: null,
        error: null,
      });
      yield* queueRoleTurn(
        p,
        updated,
        "review",
        `Review request from the implementer:\n${message}`,
        () => reviewerInstructions(p.config, updated),
      );
      return updated;
    },
    lock.withPermits(1),
    Effect.mapError(wrap),
  );

  const submitReview = Effect.fn("Assistant.submitReview")(
    function* (
      caller: ThreadId,
      verdict: AssistantCodeReview["verdict"],
      findings: string,
      summary: string,
    ) {
      const { p, t } = yield* authorizeRole(caller, "review");
      if (t.stage !== "review")
        return yield* fail(
          "No review is requested. End your turn; the implementer asks when ready.",
        );
      const worker = yield* snapshots.getThreadShellById(t.threadId, { includeArchived: true });
      if (Option.isNone(worker) || !worker.value.worktreePath)
        return yield* fail("The worker's worktree could not be found.");
      // Findings may concern uncommitted files; only an approval needs a clean commit.
      const head = yield* verifier.revision(worker.value.worktreePath, {
        allowUncommitted: verdict === "changes-requested",
      });
      const codeReview: AssistantCodeReview = {
        verdict,
        findings,
        summary,
        commit: head,
        at: yield* now,
      };
      if (verdict === "approved") {
        // In the worktree the e2e check comes before the merge, so the issue
        // goes back to its team leader to start it rather than to the worker.
        if (assistantTaskE2eEnvironment(t) === "worktree") {
          const tested = yield* saveTask({ ...t, codeReview, stage: leadStage(t) });
          yield* notifyLead(
            tested,
            `Code review approved commit ${head.slice(0, 7)} for ${t.issue.identifier}. Start the e2e check in the worktree with assistant_start_e2e: a brief with each acceptance criterion as a check a person could follow, the pages or endpoints affected, the data it needs and what to clean up. T3 tells the worker to merge once it passes.`,
          );
          return tested;
        }
        const updated = yield* saveTask({ ...t, codeReview, stage: "implement" });
        yield* queueMessage(
          p.project_id,
          t.threadId,
          `${t.id}:approved:${newId()}`,
          `Code review approved commit ${head}.\n${findings}\nMerge the PR into ${p.config.baseBranch} with a merge commit once its required checks pass, then call assistant_report_merged. If anything changes before the merge, push and request review again.`,
        );
        return updated;
      }
      if (t.turns >= t.turnLimit) {
        // The pair has spent its rounds; the team leader hears when this turn ends.
        return yield* saveTask({
          ...t,
          codeReview,
          stage: leadStage(t),
          status: "blocked",
          error: `Code review still requests changes after ${t.turns} worker rounds.`,
        });
      }
      const updated = yield* saveTask({ ...t, codeReview, stage: "implement", turns: t.turns + 1 });
      yield* queueMessage(
        p.project_id,
        t.threadId,
        `${t.id}:turn:${t.turns + 1}`,
        `Code review requested changes on ${head}:\n${findings}\nFix them (or explain why a finding is wrong), commit, push and call assistant_request_review again.`,
      );
      return updated;
    },
    lock.withPermits(1),
    Effect.mapError(wrap),
  );

  const reportMerged = Effect.fn("Assistant.reportMerged")(
    function* (caller: ThreadId, summary: string) {
      const { p, t } = yield* authorizeRole(caller, "implement");
      const review = t.codeReview;
      if (review?.verdict !== "approved")
        return yield* fail("Request a code review and wait for its approval before merging.");
      const worker = yield* snapshots.getThreadShellById(t.threadId, { includeArchived: true });
      const root = yield* snapshots.getProjectShellById(t.projectId);
      if (Option.isNone(worker) || Option.isNone(root) || !worker.value.worktreePath)
        return yield* fail("The worker's worktree could not be found.");
      const head = yield* verifier.revision(worker.value.worktreePath);
      if (head !== review.commit)
        return yield* fail(
          `The branch moved past the approved commit ${review.commit.slice(0, 7)}. Push and request review again before merging.`,
        );
      // In the worktree the e2e check runs before the merge, on this very commit.
      const worktreeE2e = assistantTaskE2eEnvironment(t) === "worktree";
      if (worktreeE2e && (!t.e2e || t.e2e.verdict === "failed" || t.e2e.commit !== head))
        return yield* fail(
          "The e2e check has not passed on this commit. Wait for T3 to tell you it passed before merging.",
        );
      if (
        !(yield* verifier.isMerged({
          cwd: root.value.workspaceRoot,
          revision: head,
          baseBranch: p.config.baseBranch,
        }))
      )
        return yield* fail(
          `${head.slice(0, 7)} is not on origin/${p.config.baseBranch} yet. Merge the PR with a merge commit, then report again.`,
        );
      if (t.merge?.commit === head) return t;
      const merge = { commit: head, summary, at: yield* now };
      const pullRequest = worker.value.linkedPullRequest ?? worker.value.branchPullRequest ?? null;
      // The merge is saved before the comment is posted: it guards re-entry, so
      // a retry after a failure here does not put a second card on the issue.
      // An earlier problem the issue has since moved past must not follow it to review.
      const merged = yield* saveTask({ ...t, merge, summary, stage: leadStage(t), error: null });
      // The team leader hears when this thread's turn ends.
      return yield* saveTask(
        yield* postLinear(
          merged,
          mergedComment({
            merge,
            review,
            pullRequest,
            baseBranch: p.config.baseBranch,
            e2e: worktreeE2e ? (t.e2e ?? null) : null,
          }),
        ),
      );
    },
    lock.withPermits(1),
    Effect.mapError(wrap),
  );

  /** The team worktree's HEAD; it fails on uncommitted changes. */
  const workerRevision = Effect.fn("Assistant.workerRevision")(function* (t: AssistantTask) {
    const worker = yield* snapshots.getThreadShellById(t.threadId, { includeArchived: true });
    if (Option.isNone(worker) || !worker.value.worktreePath)
      return yield* fail("The worker's worktree could not be found.");
    return yield* verifier.revision(worker.value.worktreePath);
  });
  /**
   * The issue is delivered: the e2e card goes on the issue, its description
   * says what shipped, and Linear moves it to the review state for the person.
   * Staging runs reach this from the e2e result, worktree runs from the staging
   * deploy that follows their merge.
   */
  const finishDelivery = Effect.fn("Assistant.finishDelivery")(function* (
    p: AwaitedProject,
    value: AssistantTask,
    e2e: AssistantE2eResult,
  ) {
    const deployment = value.deployment;
    if (!deployment) return value;
    const worker = yield* snapshots.getThreadShellById(value.threadId, { includeArchived: true });
    const pullRequest = Option.isSome(worker)
      ? (worker.value.linkedPullRequest ?? worker.value.branchPullRequest ?? null)
      : null;
    let updated = yield* postLinear(
      value,
      e2eComment({
        e2e,
        merge: value.merge ?? null,
        deployment,
        pullRequest,
        acceptedState: p.config.acceptedState,
      }),
    );
    updated = yield* updateDescription(updated, p, e2e);
    const linearError = yield* changeLinearState(updated, p.config.reviewState).pipe(
      Effect.as(null),
      Effect.catch((error) => Effect.succeed(wrap(error).detail)),
    );
    updated = {
      ...updated,
      status: "review",
      summary: updated.merge?.summary ?? updated.summary,
      reviewInstructions: [
        ...e2e.humanChecks.map((check, i) => `${i + 1}. ${check}`),
        e2e.report,
      ].join("\n\n"),
      // Without a successful move there is no delivered state to be moved away from.
      deliveredState: linearError ? null : p.config.reviewState.trim() || null,
      error: [updated.error, linearError].filter(Boolean).join(" ") || null,
    };
    yield* sql`UPDATE assistant_projects SET external_waits = 0 WHERE project_id = ${p.project_id}`;
    return yield* saveTask(updated);
  });

  const verifyStaging = Effect.fn("Assistant.verifyStaging")(
    function* (caller: ThreadId, taskId: string | undefined, targetIds?: ReadonlyArray<string>) {
      const { p, t } = yield* authorizeTask(caller, taskId);
      if (p.status === "stopped") return yield* fail("The assistant is stopped.");
      if (!assistantTaskHoldsProject(t.status))
        return yield* fail("This issue is no longer active.");
      if (t.deployment) return t;
      if (
        !t.merge ||
        t.codeReview?.verdict !== "approved" ||
        t.merge.commit !== t.codeReview.commit
      )
        return yield* fail(
          "Staging is verified after the implementer merges the approved commit and reports it.",
        );
      // An archived worker still owns its worktree.
      const worker = yield* snapshots.getThreadShellById(t.threadId, { includeArchived: true });
      const root = yield* snapshots.getProjectShellById(t.projectId);
      if (Option.isNone(worker) || Option.isNone(root) || !worker.value.worktreePath)
        return yield* fail("The worker's worktree could not be found.");
      if ((yield* taskBusy(t, caller)) || (yield* taskQueued(t, caller)))
        return yield* fail("Wait for the issue's threads to finish before verifying staging.");
      if (yield* taskDecisionsPending(t))
        return yield* fail("Resolve the issue's pending decisions before verifying staging.");
      const deployment = yield* verifier.verify({
        cwd: root.value.workspaceRoot,
        worktreePath: worker.value.worktreePath,
        baseBranch: p.config.baseBranch,
        expectedRevision: t.merge.commit,
        command: p.config.stagingCheckCommand,
        ...(p.config.stagingUrl ? { stagingUrl: p.config.stagingUrl } : {}),
        ...(p.config.deploymentTargets ? { targets: p.config.deploymentTargets } : {}),
        ...(targetIds ? { targetIds } : {}),
      });
      yield* terminals.close({ threadId: t.threadId });
      // A run in the worktree already proved the change; this deploy is the
      // last gate, so verifying it delivers the issue. The deployment is saved
      // first: it guards re-entry, so a retry posts no second card.
      const tested = t.e2e;
      if (assistantTaskE2eEnvironment(t) === "worktree" && tested && tested.verdict !== "failed") {
        const verified = yield* saveTask({ ...t, deployment, error: null, wait: null });
        return yield* finishDelivery(p, verified, tested);
      }
      const posted = yield* postLinear(
        { ...t, deployment, error: null, wait: null },
        deployedComment({ deployment }),
      );
      yield* sql`UPDATE assistant_projects SET external_waits = 0 WHERE project_id = ${p.project_id}`;
      return yield* saveTask(posted);
    },
    lock.withPermits(1),
    Effect.mapError(wrap),
  );

  const startE2e = Effect.fn("Assistant.startE2e")(
    function* (caller: ThreadId, taskId: string | undefined, brief: string) {
      const { p, t } = yield* authorizeTask(caller, taskId);
      if (p.status === "stopped") return yield* fail("The assistant is stopped.");
      if (!assistantTaskHoldsProject(t.status))
        return yield* fail("Only the active issue can be tested.");
      const inWorktree = assistantTaskE2eEnvironment(t) === "worktree";
      const review = t.codeReview;
      if (inWorktree) {
        if (review?.verdict !== "approved")
          return yield* fail("Start e2e after code review approves a commit.");
      } else if (!t.deployment)
        return yield* fail("Verify the staging deployment with assistant_verify_staging first.");
      if (yield* taskDecisionsPending(t))
        return yield* fail("Resolve the issue's pending decisions first.");
      if ((yield* taskBusy(t, caller)) || (yield* taskQueued(t, caller)))
        return yield* fail("Wait for the issue's threads to finish before starting e2e.");
      // The tester runs the application from the team's worktree, so the run is
      // pinned to the commit the reviewer approved.
      const head = inWorktree ? yield* workerRevision(t) : null;
      if (inWorktree && head !== review!.commit)
        return yield* fail(
          `The worktree moved past the approved commit ${review!.commit.slice(0, 7)}. Commit what changed, push and request review again before the e2e check.`,
        );
      const directory = yield* evidence.directory(t.id);
      const run = e2eBrief(t, brief);
      const updated = yield* saveTask({
        ...t,
        stage: "e2e",
        status: "working",
        error: null,
        wait: null,
      });
      yield* queueRoleTurn(
        p,
        updated,
        "e2e",
        head
          ? `New e2e run on commit ${head.slice(0, 7)} in the worktree. Save screenshots in ${directory}.\n${run}`
          : `New e2e run on the deployment of ${t.deployment!.revision.slice(0, 7)}. Save screenshots in ${directory}.\n${run}`,
        () => e2eInstructions(p.config, updated, directory, run),
      );
      return updated;
    },
    lock.withPermits(1),
    Effect.mapError(wrap),
  );

  const submitE2e = Effect.fn("Assistant.submitE2e")(
    function* (
      caller: ThreadId,
      input: {
        readonly verdict: AssistantE2eResult["verdict"];
        readonly report: string;
        readonly humanChecks: ReadonlyArray<string>;
        readonly screenshots: ReadonlyArray<{ readonly path: string; readonly caption: string }>;
      },
    ) {
      const { p, t } = yield* authorizeRole(caller, "e2e");
      const inWorktree = assistantTaskE2eEnvironment(t) === "worktree";
      if (t.stage !== "e2e" || (!inWorktree && !t.deployment))
        return yield* fail("No e2e run is in progress for this issue.");
      if (input.screenshots.length > 12)
        return yield* fail("Attach at most 12 screenshots; keep the ones that prove each check.");
      if (input.verdict === "partial" && !input.humanChecks.length)
        return yield* fail("A partial result lists what a person should check in humanChecks.");
      // The result covers the commit the reviewer approved; the merge is of it.
      const head = inWorktree ? yield* workerRevision(t) : null;
      if (inWorktree && head !== t.codeReview?.commit)
        return yield* fail(
          `The worktree moved past the tested commit ${t.codeReview?.commit.slice(0, 7) ?? ""}. Commit what changed, push and request review again.`,
        );
      // Every file is read before any upload, so a bad path uploads nothing.
      const images = yield* Effect.forEach(input.screenshots, (shot) =>
        evidence.read(t.id, shot.path).pipe(Effect.map((image) => ({ image, shot }))),
      );
      const screenshots = yield* Effect.forEach(images, ({ image, shot }) =>
        linear.uploadFile(image).pipe(
          Effect.map(({ url }) => ({ url, caption: shot.caption })),
          Effect.mapError((error) =>
            fail(`Could not upload ${image.fileName} to Linear: ${linearFailureDetail(error)}`),
          ),
        ),
      );
      const e2e: AssistantE2eResult = {
        verdict: input.verdict,
        report: input.report,
        humanChecks: input.humanChecks,
        screenshots,
        at: yield* now,
        environment: inWorktree ? "worktree" : "staging",
        ...(head ? { commit: head } : {}),
      };
      // A run in the worktree happens before the merge: nothing is on the issue
      // yet, and a pass tells the worker to merge the commit that was tested.
      if (inWorktree) {
        if (input.verdict === "failed")
          // The team leader hears when this turn ends.
          return yield* saveTask({ ...t, e2e, stage: leadStage(t) });
        const passed = yield* saveTask({
          ...t,
          e2e,
          stage: "implement",
          error: null,
          wait: null,
        });
        yield* queueMessage(
          p.project_id,
          t.threadId,
          `${t.id}:e2e-passed:${newId()}`,
          `The e2e check ${input.verdict === "partial" ? "passed (with checks left for the person)" : "passed"} on commit ${head!.slice(0, 7)} in the worktree. Merge the PR into ${p.config.baseBranch} with a merge commit once its required checks pass, then call assistant_report_merged. If anything changes before the merge, push and request review again.`,
        );
        return passed;
      }
      // The stage leaving e2e is what stops a second run reporting again, so it
      // is saved before the comment: a retry after a failure here posts no
      // second card on the issue.
      const updated = yield* saveTask({ ...t, e2e, stage: leadStage(t), error: null });
      if (input.verdict === "failed") {
        const worker = yield* snapshots.getThreadShellById(t.threadId, { includeArchived: true });
        const pullRequest = Option.isSome(worker)
          ? (worker.value.linkedPullRequest ?? worker.value.branchPullRequest ?? null)
          : null;
        return yield* saveTask(
          yield* postLinear(
            updated,
            e2eComment({
              e2e,
              merge: t.merge ?? null,
              deployment: t.deployment!,
              pullRequest,
              acceptedState: p.config.acceptedState,
            }),
          ),
        );
      }
      // The team is closed when this turn ends, and the loop moves on.
      return yield* finishDelivery(p, updated, e2e);
    },
    lock.withPermits(1),
    Effect.mapError(wrap),
  );

  const review = Effect.fn("Assistant.review")(
    function* (input: typeof AssistantReviewInput.Type) {
      const t = yield* task(input.taskId);
      const p = yield* project(t.projectId);
      if (input.action === "accept" || input.action === "request-changes") {
        if (t.status !== "review")
          return yield* fail("Only deployed work awaiting review can be accepted or sent back.");
        if (input.action === "request-changes" && !input.feedback.trim())
          return yield* fail("Describe the changes you want.");
        const updated = yield* saveTask({
          ...t,
          status: input.action === "accept" ? "accepted" : "changes-requested",
          feedback: input.feedback,
        });
        if (input.action === "accept")
          yield* changeLinearState(updated, p.config.acceptedState).pipe(
            Effect.catch((error) => saveTask({ ...updated, error: wrap(error).detail })),
          );
      } else if (input.action === "skip") {
        if (!assistantTaskHoldsProject(t.status) && t.status !== "queued")
          return yield* fail("Only an active or queued issue can be skipped.");
        for (const threadId of taskThreadIds(t)) {
          yield* engine
            .dispatch({
              type: "thread.turn.interrupt",
              commandId: CommandId.make(newId()),
              threadId,
              createdAt: yield* now,
            })
            .pipe(Effect.catch(() => Effect.void));
          yield* terminals.close({ threadId });
          yield* sql`UPDATE assistant_messages SET delivered = 1 WHERE thread_id = ${threadId}`;
          yield* sql`UPDATE assistant_decisions SET resolved = 1 WHERE thread_id = ${threadId}`;
        }
        yield* saveTask({ ...t, status: "skipped", feedback: input.feedback });
      } else {
        if (!assistantTaskHoldsProject(t.status))
          return yield* fail("Only blocked or active work can be retried.");
        const lead = yield* snapshots.getThreadShellById(assistantTaskThreadId(t, "lead"), {
          includeArchived: true,
        });
        // A team whose worktree could not be prepared has no leader to tell yet.
        if (t.leader && Option.isNone(lead)) {
          yield* prepareTeam(p, t).pipe(
            Effect.catch((error) =>
              saveTask({ ...t, status: "blocked", error: wrap(error).detail }),
            ),
          );
          return yield* board(null);
        }
        // The person looked at the blocker, so the wait budget starts over too.
        yield* sql`UPDATE assistant_projects SET external_waits = 0 WHERE project_id = ${p.project_id}`;
        const retried = yield* saveTask({
          ...t,
          turnLimit: t.turns + p.config.maxWorkerTurns,
          error: null,
          wait: null,
        });
        yield* notifyLead(
          retried,
          `The person allowed more rounds for ${t.issue.identifier}. ${input.feedback}`,
        );
      }
      return yield* board(null);
    },
    lock.withPermits(1),
    deliveryLock.withPermits(1),
    Effect.mapError(wrap),
  );

  const getAgentBoard = Effect.fn("Assistant.getAgentBoard")(function* (caller: ThreadId) {
    const p = yield* authorize(caller);
    return { ...(yield* board(p.project_id)), candidates: yield* candidates(p.config) };
  }, Effect.mapError(wrap));
  const waitForExternal = Effect.fn("Assistant.waitForExternal")(function* (
    caller: ThreadId,
    reason: string,
  ) {
    const owner = yield* threadTask(caller);
    const p =
      owner?.role === "lead" ? yield* project(owner.task.projectId) : yield* authorize(caller);
    if (p.status === "stopped") return yield* fail("The assistant is stopped.");
    // A team leader's issue is the one that is stuck: its wait is counted on
    // the issue, so it waits for the person while the loop and the project's
    // other teams carry on. Work from before team leaders has only the
    // assistant to stop, and keeps the project's own wait budget.
    if (owner?.role === "lead") {
      const t = yield* task(owner.task.id);
      if ((t.wait?.checks ?? 0) >= 15) {
        yield* saveTask({
          ...t,
          status: "blocked",
          wait: null,
          error:
            "External progress has not completed after 15 checks. Inspect the blocker, then retry from the board.",
        });
        yield* changed;
        return { outcome: "limit" } satisfies AssistantWaitResult;
      }
      yield* saveTask({
        ...t,
        wait: { reason: reason.slice(0, 1000), checks: (t.wait?.checks ?? 0) + 1, notified: false },
      });
      yield* changed;
      return { outcome: "waiting" } satisfies AssistantWaitResult;
    }
    if (p.external_waits >= 15) {
      yield* sql`UPDATE assistant_projects SET status = 'stopped', error = 'External progress has not completed after 15 checks. Inspect the blocker, then Start to allow another attempt.' WHERE project_id = ${p.project_id}`;
      yield* changed;
      return { outcome: "stopped" } satisfies AssistantWaitResult;
    }
    yield* sql`UPDATE assistant_projects SET external_waits = external_waits + 1, error = ${`Waiting: ${reason.slice(0, 1000)}`} WHERE project_id = ${p.project_id}`;
    yield* changed;
    return { outcome: "waiting" } satisfies AssistantWaitResult;
  }, Effect.mapError(wrap));

  /** The loop takes no new issues; teams at work finish theirs. */
  const pause = Effect.fn("Assistant.pause")(
    function* (caller: ThreadId) {
      const p = yield* authorize(caller);
      yield* sql`UPDATE assistant_projects SET status = 'paused' WHERE project_id = ${p.project_id} AND status = 'running'`;
      yield* changed;
    },
    deliveryLock.withPermits(1),
    Effect.mapError(wrap),
  );

  const deliver = Effect.fn("Assistant.deliver")(
    function* () {
      const rows =
        yield* sql<ProjectRow>`SELECT * FROM assistant_projects WHERE status != 'stopped'`;
      for (const row of rows) {
        const p = yield* project(row.project_id);
        if (yield* limited(p)) continue;
        const coordinator = yield* snapshots.getThreadShellById(ThreadId.make(p.thread_id));
        const questions =
          yield* sql`SELECT id FROM assistant_decisions WHERE thread_id = ${p.thread_id} AND resolved = 0`;
        if (
          p.wake_version > p.delivered_version &&
          !questions.length &&
          Option.isSome(coordinator) &&
          !(yield* threadBusy(coordinator.value))
        ) {
          const id = `assistant:${p.thread_id}:wake:${p.wake_version}`;
          const instructions = assistantInstructions(p.config);
          const brief = `${p.thread_id}\n${instructions}`;
          const wakeText = `Wake reason: ${p.wake_reason}`;
          yield* queueMessage(
            p.project_id,
            ThreadId.make(p.thread_id),
            id,
            briefed.get(p.project_id) === brief ? wakeText : `${instructions}\n\n${wakeText}`,
          );
          briefed.set(p.project_id, brief);
          yield* sql`UPDATE assistant_projects SET delivered_version = ${p.wake_version} WHERE project_id = ${p.project_id}`;
        }
      }
      const messages = yield* sql<{
        id: string;
        project_id: string;
        thread_id: string;
        text: string;
        created_at: string;
      }>`SELECT m.* FROM assistant_messages m JOIN assistant_projects p ON p.project_id = m.project_id WHERE m.delivered = 0 AND p.status != 'stopped' ORDER BY m.rowid`;
      for (const m of messages) {
        const threadId = ThreadId.make(m.thread_id);
        const current = yield* snapshots.getThreadShellById(threadId, { includeArchived: true });
        if (Option.isNone(current)) continue;
        const p = yield* project(m.project_id);
        // A turn sent while the usage limit holds would fail the same way; the
        // message keeps until the limit resets.
        if (p.status === "stopped" || (yield* limited(p))) continue;
        // Nothing else delivers this message, so a thread the person archived
        // with work still queued for it comes back rather than wedging its issue.
        if (current.value.archivedAt !== null) {
          const unarchived = yield* engine
            .dispatch({ type: "thread.unarchive", commandId: CommandId.make(newId()), threadId })
            .pipe(
              Effect.as(true),
              Effect.catch(() => Effect.succeed(false)),
            );
          if (!unarchived) continue;
        }
        if (yield* threadBusy(current.value)) continue;
        // An issue's threads share one worktree: a handoff waits for the sender's turn to end.
        const owner = yield* threadTask(threadId);
        if (owner && (yield* taskBusy(owner.task))) {
          yield* releaseHandedOff(owner.task);
          continue;
        }
        const pending =
          yield* sql`SELECT id FROM assistant_decisions WHERE thread_id = ${threadId} AND resolved = 0`;
        if (
          pending.length ||
          current.value.hasPendingApprovals ||
          current.value.hasPendingUserInput
        )
          continue;
        yield* engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(m.id),
          threadId,
          message: { messageId: MessageId.make(m.id), role: "user", text: m.text, attachments: [] },
          // The assistant and team leaders decide; the other threads do the work.
          modelSelection:
            threadId === p.thread_id || owner?.role === "lead"
              ? p.config.modelSelection
              : p.config.workerModelSelection,
          runtimeMode: p.config.runtimeMode,
          interactionMode: "default",
          createdAt: m.created_at,
        });
        yield* sql`UPDATE assistant_messages SET delivered = 1 WHERE id = ${m.id}`;
      }
    },
    deliveryLock.withPermits(1),
    Effect.mapError(wrap),
  );

  /**
   * The team leader ended a turn with the issue still in its hands and nothing
   * handed on. A turn that answered the person is fine; otherwise it is nudged
   * once, and a second such turn blocks the issue for the person.
   */
  const leadIdle = Effect.fn("Assistant.leadIdle")(function* (t: AssistantTask) {
    // A leader that called assistant_wait and ended its turn is doing the right
    // thing; the scan tells it to check again.
    if (t.status === "blocked" || t.wait) return;
    const lead = assistantTaskThreadId(t, "lead");
    const detail = yield* snapshots.getThreadDetailById(lead);
    const asked = Option.isSome(detail)
      ? detail.value.messages.findLast((m) => m.role === "user")
      : undefined;
    if (!asked) return;
    const automated = yield* sql`SELECT id FROM assistant_messages WHERE id = ${asked.id}`;
    if (!automated.length) return;
    if (asked.id.includes(":nudge:"))
      return yield* saveTask({
        ...t,
        status: "blocked",
        error: "The team leader ended its turn twice without a next step.",
      });
    yield* queueMessage(
      t.projectId,
      lead,
      `${t.id}:lead:nudge:${newId()}`,
      `You ended your turn with the issue still yours and nothing handed on. Take the next step (${t.dispatched ? "take" : "take or decline"} the issue, verify staging, start e2e, or message a thread), ask the person with assistant_ask_decision, or use assistant_wait while staging deploys.`,
    );
    yield* changed;
  });

  /**
   * One of an issue's threads finished a turn. A handoff it queued carries the
   * issue on by itself; otherwise the team leader hears why the issue is back
   * with it: a merge, an e2e result, or a thread that stopped without handing
   * off. A delivered or declined issue closes its team.
   */
  const turnEnded = Effect.fn("Assistant.turnEnded")(function* (
    t: AssistantTask,
    role: AssistantThreadRole,
  ) {
    const id = t.issue.identifier;
    if (t.status === "declined") return role === "lead" ? yield* closeTeam(t) : undefined;
    if (t.status === "review") {
      // A delivered issue's other threads may still be finishing; whichever
      // settles last closes the team.
      if (yield* taskBusy(t, assistantTaskThreadId(t, role))) return;
      yield* closeTeam(t);
      // Work from before team leaders reported to the assistant, which chose the next issue.
      if (!t.leader)
        yield* wake(
          t.projectId,
          `${id} ${t.e2e?.verdict === "partial" ? "passed e2e with checks for the person" : "passed e2e"} and is in review.`,
        );
      return;
    }
    // A queued handoff carries the issue on; an open question waits for the person.
    if (
      !assistantTaskHoldsProject(t.status) ||
      (yield* taskQueued(t)) ||
      (yield* taskDecisionsPending(t))
    )
      return;
    if (role === "lead") return withLead(t.stage) ? yield* leadIdle(t) : undefined;
    if (t.stage === role) {
      yield* saveTask({ ...t, stage: leadStage(t) });
      return yield* notifyLead(
        t,
        `The ${ROLE_NAMES[role]} for ${id} ended its turn without handing off. Read it with assistant_read_thread (thread "${role}") and decide the next step.`,
      );
    }
    if (!withLead(t.stage)) return;
    if (t.status === "blocked")
      return yield* notifyLead(t, `${id} is blocked: ${t.error ?? "see its threads"}`);
    const inWorktree = assistantTaskE2eEnvironment(t) === "worktree";
    if (t.e2e?.verdict === "failed" && role === "e2e")
      return yield* notifyLead(
        t,
        `${id} failed its e2e check ${inWorktree ? "in the worktree" : "on staging"}:\n${t.e2e.report.slice(0, 4000)}\nDecide whether this goes to the worker, back to the tester, or to the person.`,
      );
    if (t.merge && !t.deployment && role === "implement")
      return yield* notifyLead(
        t,
        inWorktree
          ? `${id} was approved in code review and merged into its integration branch at ${t.merge.commit.slice(0, 7)} after the e2e check passed. Verify staging with assistant_verify_staging; T3 then puts the issue in review.`
          : `${id} was approved in code review and merged into its integration branch at ${t.merge.commit.slice(0, 7)}. Verify staging, then start the e2e check.`,
      );
  });

  /**
   * The provider's usage limit stops every turn on the account at once, and it
   * lifts by itself. The project waits for the reset instead of blocking the
   * issue or stopping the loop: nothing is sent to its threads until then, and
   * the thread that was stopped is told to continue. Nothing is held for a
   * stopped project or a thread whose issue is no longer active.
   */
  const holdForUsageLimit = Effect.fn("Assistant.holdForUsageLimit")(function* (
    projectId: string,
    threadId: ThreadId,
    t: AssistantTask | null,
    waitMs: number,
  ) {
    const p = yield* project(projectId);
    if (p.status === "stopped") return false;
    const coordinator = p.thread_id === threadId;
    if (!coordinator && !(t && assistantTaskHoldsProject(t.status))) return false;
    const until = DateTime.formatIso(
      DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + waitMs),
    );
    // Several threads stop at once; the latest reset time is the one to wait for.
    if (p.limited_until === null || p.limited_until < until)
      yield* sql`UPDATE assistant_projects SET limited_until = ${until} WHERE project_id = ${projectId}`;
    if (coordinator)
      yield* wake(
        projectId,
        `A Claude usage limit stopped your previous turn before it finished. The limit has reset: continue where you left off. If that turn was answering a wake from T3, its reason was: ${p.wake_reason.slice(0, 4000)}`,
      );
    else
      yield* queueMessage(
        projectId,
        threadId,
        `${threadId}:limit:${until}`,
        "A Claude usage limit stopped your previous turn before it finished. The limit has reset: continue where you left off, and hand off as usual when you are done.",
      );
    yield* Effect.logInfo("Developer assistant is waiting for a usage limit to reset", {
      projectId,
      threadId,
      until,
    });
    return true;
  });

  const observe = Effect.fn("Assistant.observe")(function* (event: OrchestrationEvent) {
    if (!("threadId" in event.payload)) return;
    const threadId = event.payload.threadId;
    if (event.type === "thread.deleted") {
      const removed =
        yield* sql`DELETE FROM assistant_setups WHERE thread_id = ${threadId} RETURNING project_id`;
      if (removed.length) yield* changed;
    }
    const projects =
      yield* sql<ProjectRow>`SELECT * FROM assistant_projects WHERE thread_id = ${threadId}`;
    const owner = yield* threadTask(threadId);
    const projectId = projects[0]?.project_id ?? owner?.task.projectId;
    if (!projectId) return;
    const t = owner?.task ?? null;
    if (
      event.type === "thread.message-sent" &&
      event.payload.role === "user" &&
      event.payload.text.trim()
    ) {
      const automated =
        yield* sql`SELECT id FROM assistant_messages WHERE id = ${event.payload.messageId}`;
      if (automated.length) return;
      const decisions = yield* sql<{
        id: string;
        data: string;
      }>`SELECT * FROM assistant_decisions WHERE thread_id = ${threadId} AND resolved = 0 AND request_id IS NULL`;
      // A reply in the original thread is already a turn. Resolve its question
      // without queueing a duplicate answer turn. Multiple questions use the inbox.
      if (decisions.length === 1) {
        const d = yield* decodeDecision(decisions[0]!.data);
        yield* sql`UPDATE assistant_decisions SET resolved = 1, data = ${encodeDecision({ ...d, answer: event.payload.text })} WHERE id = ${d.id}`;
        if (t && assistantTaskHoldsProject(t.status))
          yield* saveTask({
            ...t,
            status: "working",
            error: null,
            ...(t.stage && owner ? { stage: owner.role } : {}),
          });
      }
    } else if (event.type === "thread.activity-appended") {
      const a = event.payload.activity;
      if (a.kind === "context-compaction") {
        // A compacted summary may drop the instructions. The assistant is not
        // woken by the loop, so restore them now rather than on some later wake.
        const state = (a.payload as { readonly state?: unknown } | null)?.state;
        if (projects[0] && state === "compacted") {
          briefed.delete(projectId);
          yield* wake(
            projectId,
            "Your conversation was compacted, so your instructions are repeated above. Nothing needs you now.",
          );
        }
      } else if (["user-input.requested", "approval.requested"].includes(a.kind)) {
        const payload = yield* decodeRequest(a.payload);
        const id = `provider:${threadId}:${payload.requestId}`;
        const decision: AssistantDecision = {
          id,
          projectId: ProjectId.make(projectId),
          threadId,
          taskId: t?.id ?? null,
          requestId: payload.requestId,
          kind: a.kind === "approval.requested" ? "approval" : "user-input",
          question: a.summary,
          answer: null,
          createdAt: yield* now,
        };
        yield* sql`INSERT OR IGNORE INTO assistant_decisions (id, project_id, thread_id, request_id, data) VALUES (${id}, ${projectId}, ${threadId}, ${payload.requestId}, ${encodeDecision(decision)})`;
        // The inbox shows the request; it is answered in its own thread.
        if (t && assistantTaskHoldsProject(t.status)) yield* saveTask({ ...t, status: "waiting" });
      } else if (["user-input.resolved", "approval.resolved"].includes(a.kind) || isStale(a)) {
        const payload = yield* decodeRequest(a.payload);
        const answer = isStale(a)
          ? "The request expired before it was answered"
          : "Answered in the thread";
        const ds = yield* sql<{
          id: string;
          data: string;
        }>`SELECT * FROM assistant_decisions WHERE thread_id = ${threadId} AND request_id = ${payload.requestId} AND resolved = 0`;
        for (const d of ds)
          yield* sql`UPDATE assistant_decisions SET resolved = 1, data = ${encodeDecision({ ...(yield* decodeDecision(d.data)), answer })} WHERE id = ${d.id}`;
        if (t && t.status === "waiting") yield* saveTask({ ...t, status: "working" });
      }
    } else if (event.type === "thread.session-set") {
      const status = event.payload.session.status;
      const settled =
        status === "ready" ||
        status === "error" ||
        status === "interrupted" ||
        status === "stopped";
      const limitWait =
        status === "error" ? usageLimitWaitMs(event.payload.session.lastError) : null;
      if (limitWait !== null && (yield* holdForUsageLimit(projectId, threadId, t, limitWait))) {
        // The thread continues once the limit resets; its issue is not blocked
        // and the loop is not stopped.
      } else if (
        t &&
        status === "stopped" &&
        (releasedAt.delete(threadId) || (yield* releasedWhileIdle(threadId)))
      ) {
        // Nothing to do: the thread's turn ended normally before its session was released.
      } else if (
        // A delivered issue's tester may stop instead of settling; either way its work is done.
        t &&
        owner &&
        t.stage !== undefined &&
        settled &&
        (status === "ready" || t.status === "review" || t.status === "declined")
      ) {
        yield* ingestion.drain;
        if (
          status === "ready" &&
          Option.isSome(yield* turns.getPendingTurnStartByThreadId({ threadId }))
        )
          return;
        yield* turnEnded(t, owner.role);
      } else if (
        t &&
        assistantTaskHoldsProject(t.status) &&
        (status === "ready" ||
          status === "error" ||
          status === "interrupted" ||
          status === "stopped")
      ) {
        yield* ingestion.drain;
        if (
          status === "ready" &&
          Option.isSome(yield* turns.getPendingTurnStartByThreadId({ threadId }))
        )
          return;
        const detail = yield* snapshots.getThreadDetailById(threadId);
        const summary = Option.isSome(detail)
          ? (detail.value.messages
              .findLast((m) => m.role === "assistant" && m.text.trim())
              ?.text.slice(0, 20000) ?? t.summary)
          : t.summary;
        const failed = status === "error" || status === "interrupted" || status === "stopped";
        yield* saveTask({
          ...t,
          // Work started before the review and e2e threads keeps its worker's last word.
          ...(t.stage === undefined ? { summary } : { stage: leadStage(t) }),
          ...(failed
            ? {
                status: "blocked" as const,
                error: event.payload.session.lastError ?? "The worker stopped before delivery.",
              }
            : {}),
        });
        // A leader that failed is not told about itself; the board shows the issue blocked.
        if (owner?.role !== "lead")
          yield* notifyLead(
            t,
            `The ${ROLE_NAMES[owner?.role ?? "implement"]} for ${t.issue.identifier} is ${status}. Read its result and manage the next step. A finished turn does not prove deployment.`,
          );
      } else if (
        projects[0]?.status === "running" &&
        (status === "error" || status === "interrupted")
      ) {
        yield* sql`UPDATE assistant_projects SET error = ${event.payload.session.lastError ?? "The assistant stopped. Resume it to continue."}, status = 'stopped' WHERE project_id = ${projectId}`;
      }
    } else if (event.type === "thread.archived" && projects[0]) {
      yield* sql`UPDATE assistant_projects SET status = 'stopped', error = 'The assistant conversation was archived. Start to resume it.' WHERE project_id = ${projectId}`;
    } else if (event.type === "thread.deleted") {
      if (projects[0])
        yield* sql`UPDATE assistant_projects SET status = 'stopped', error = 'The assistant thread was deleted.' WHERE project_id = ${projectId}`;
      if (t && assistantTaskHoldsProject(t.status))
        yield* saveTask({
          ...t,
          status: "blocked",
          error: `The ${ROLE_NAMES[owner?.role ?? "implement"]} was deleted. Skip this issue to release the project.`,
        });
    }
    yield* changed;
  }, lock.withPermits(1));

  /**
   * The person can decide from the Linear card: a completed state accepts the
   * delivery, and moving the issue anywhere else before that asks for changes,
   * with their comments since the card as the feedback.
   */
  const syncLinearReviews = Effect.fn("Assistant.syncLinearReviews")(function* () {
    const rows = yield* sql<TaskRow>`SELECT * FROM assistant_tasks WHERE status = 'review'`;
    for (const row of rows) {
      yield* Effect.gen(function* () {
        const read = yield* decodeTask(row.data);
        const p = yield* project(read.projectId);
        // Linear is read outside the lock; the decision it leads to is taken
        // under it, on the task as it stands then, so a review the person just
        // made in the UI is not overwritten by this stale read.
        const issue = yield* linear.getIssue({ reference: read.issue.id });
        const state = issue.state;
        yield* Effect.gen(function* () {
          const t = yield* task(read.id);
          if (t.status !== "review") return;
          const delivered =
            t.deliveredState !== undefined
              ? t.deliveredState
              : t.error
                ? null
                : p.config.reviewState.trim() || null;
          if (acceptedInLinear(state, p.config)) {
            yield* saveTask({
              ...t,
              status: "accepted",
              feedback: `Accepted in Linear (${state.name}).`,
            });
          } else if (state.type === "canceled") {
            yield* saveTask({
              ...t,
              status: "skipped",
              feedback: `Canceled in Linear (${state.name}).`,
            });
          } else if (delivered && state.name.toLowerCase() !== delivered.toLowerCase()) {
            // Deliveries from before phase updates recorded no comment ids; their
            // delivery comment is the last one carrying T3's verified-commit line.
            const legacyCard = issue.comments
              .filter((c) => c.body.includes("Verified commit: `"))
              .map((c) => c.createdAt)
              .toSorted()
              .at(-1);
            const feedback = linearFeedback({
              comments: issue.comments,
              since: t.e2e?.at ?? legacyCard ?? t.deployment?.verifiedAt ?? t.updatedAt,
              postedIds: t.linearCommentIds ?? [],
              stateName: state.name,
            });
            // The loop gives it to a new team with this feedback once the project is free.
            yield* saveTask({ ...t, status: "changes-requested", feedback });
          }
        }).pipe(lock.withPermits(1));
      }).pipe(
        Effect.catch((error) =>
          Effect.logDebug("Developer assistant could not check a reviewed issue in Linear", {
            error,
          }),
        ),
      );
    }
  });

  const scan = Effect.fn("Assistant.scan")(function* () {
    // A usage limit that has reset no longer holds the project; the board says
    // so, and the deliveries below send what waited for it.
    const released =
      yield* sql`UPDATE assistant_projects SET limited_until = NULL WHERE limited_until IS NOT NULL AND limited_until <= ${yield* now} RETURNING project_id`;
    if (released.length) yield* changed;
    // Decisions made in Linear first, so an issue sent back goes to the next team.
    yield* syncLinearReviews();
    const rows = yield* sql<ProjectRow>`SELECT * FROM assistant_projects WHERE status != 'stopped'`;
    for (const row of rows) {
      yield* Effect.gen(function* () {
        // The project's own wait is the coordinator's, for work from before team
        // leaders. Every team leader's wait is counted on its own issue.
        if (row.error?.startsWith("Waiting:")) yield* wake(row.project_id, row.error);
        // Under the board lock: a turn ending meanwhile writes the same rows.
        yield* Effect.gen(function* () {
          for (const held of yield* heldTasks(row.project_id)) {
            const wait = held.wait;
            // One assistant_wait call produces one check-again message.
            if (!wait || wait.notified) continue;
            yield* notifyLead(held, `Waiting: ${wait.reason}\nCheck again.`);
            yield* saveTask({ ...held, wait: { ...wait, notified: true } });
          }
        }).pipe(lock.withPermits(1));
        // A paused loop keeps the reason it paused until the person starts it again.
        if (row.error !== null && (row.status === "running" || row.error.startsWith("Waiting:"))) {
          yield* sql`UPDATE assistant_projects SET error = NULL WHERE project_id = ${row.project_id} AND error = ${row.error}`;
          yield* changed;
        }
        yield* advance(row.project_id).pipe(lock.withPermits(1));
      }).pipe(
        Effect.catch((error) =>
          sql`UPDATE assistant_projects SET error = ${wrap(error).detail} WHERE project_id = ${row.project_id}`.pipe(
            Effect.andThen(changed),
          ),
        ),
      );
    }
    yield* deliver();
  }, Effect.mapError(wrap));

  const stream = Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(changes);
      // Most changes are thread heartbeats that leave the board as it was; send
      // a board only when it differs from the last one.
      let last = "";
      return Stream.concat(
        Stream.fromEffect(board(null)),
        Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => board(null))),
      ).pipe(
        Stream.filter((value) => {
          const encoded = JSON.stringify(value);
          if (encoded === last) return false;
          last = encoded;
          return true;
        }),
      );
    }),
  );
  const service = {
    getSetup,
    beginSetup,
    proposeSetup,
    resolveSetup,
    pause,
    board,
    configure,
    control,
    answer,
    review,
    getAgentBoard,
    dispatch,
    dispatchFromAssistant,
    acceptIssue,
    declineIssue,
    readThread,
    messageWorker,
    askDecision,
    relayAnswer,
    requestReview,
    submitReview,
    reportMerged,
    verifyStaging,
    startE2e,
    submitE2e,
    waitForExternal,
    deliver,
    observe,
    scan,
    stream,
  };
  if (!(yield* DeveloperAssistantWorkers)) return service;

  const events = yield* engine.subscribeDomainEvents;
  const relevant = (event: OrchestrationEvent) =>
    (event.type === "thread.message-sent" && event.payload.role === "user") ||
    event.type === "thread.session-set" ||
    event.type === "thread.archived" ||
    event.type === "thread.deleted" ||
    (event.type === "thread.activity-appended" &&
      ([
        "user-input.requested",
        "approval.requested",
        "user-input.resolved",
        "approval.resolved",
        "context-compaction",
      ].includes(event.payload.activity.kind) ||
        isStale(event.payload.activity)));
  const eventLock = yield* Semaphore.make(1);
  const record = Effect.fn("Assistant.recordEvent")(function* (event: OrchestrationEvent) {
    const cursors = yield* sql<{
      sequence: number;
    }>`SELECT sequence FROM assistant_event_cursor WHERE id = 1`;
    if ((cursors[0]?.sequence ?? 0) >= event.sequence) return;
    if (relevant(event)) yield* observe(event);
    yield* sql`UPDATE assistant_event_cursor SET sequence = ${event.sequence} WHERE id = 1`;
  }, eventLock.withPermits(1));
  const recovered = yield* Deferred.make<void>();
  const handleEvent = (event: OrchestrationEvent) =>
    record(event).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("Developer assistant event handling will retry", { error }),
      ),
      Effect.retry(Schedule.spaced("5 seconds")),
    );
  // Subscribe before replay, then consume the buffered stream in sequence. A failed
  // event must not be skipped by a later cursor; delivery waits for recovery.
  yield* Effect.gen(function* () {
    while (true) {
      const cursors = yield* sql<{
        sequence: number;
      }>`SELECT sequence FROM assistant_event_cursor WHERE id = 1`;
      const batch = yield* engine
        .readEvents(cursors[0]?.sequence ?? 0, 500)
        .pipe(Stream.runCollect);
      if (!batch.length) break;
      for (const event of batch) if (relevant(event)) yield* handleEvent(event);
      // Token deltas need no assistant projection write. Advance once for the
      // remainder of this replay batch, after every relevant event succeeded.
      const lastSequence = batch[batch.length - 1]!.sequence;
      yield* sql`UPDATE assistant_event_cursor SET sequence = ${lastSequence} WHERE id = 1 AND sequence < ${lastSequence}`;
    }
    const running =
      yield* sql<ProjectRow>`SELECT * FROM assistant_projects WHERE status != 'stopped'`;
    // Team leaders hear about their threads' own failures; only earlier work,
    // which the assistant ran, needs a look after a restart.
    for (const p of running) {
      const held = yield* heldTasks(p.project_id);
      if (held.some((t) => !t.leader))
        yield* wake(
          p.project_id,
          "T3 restarted. Inspect retained workers, queued work, and decisions before continuing.",
        );
    }
    yield* Deferred.succeed(recovered, undefined);
    yield* events.pipe(Stream.filter(relevant), Stream.runForEach(handleEvent));
  }).pipe(
    Effect.tapError((error) =>
      Effect.logWarning("Developer assistant recovery will retry", { error }),
    ),
    Effect.retry(Schedule.spaced("5 seconds")),
    forkParked,
  );
  const updates = yield* PubSub.subscribe(changes);
  yield* Deferred.await(recovered).pipe(
    Effect.andThen(
      Stream.fromSubscription(updates).pipe(
        Stream.runForEach(() =>
          deliver().pipe(
            Effect.catch((error) =>
              Effect.logWarning("Developer assistant delivery is pending", { error }),
            ),
          ),
        ),
      ),
    ),
    forkParked,
  );
  // Linear is re-fetched once per minute; persisted messages also retry here.
  yield* Deferred.await(recovered).pipe(
    Effect.andThen(
      scan().pipe(
        Effect.catch((error) =>
          Effect.logWarning("Developer assistant issue scan will retry", { error }),
        ),
        Effect.repeat(Schedule.spaced("60 seconds")),
      ),
    ),
    forkParked,
  );
  return service;
});

export class DeveloperAssistant extends Context.Service<
  DeveloperAssistant,
  Effect.Success<typeof make>
>()("t3/assistant/DeveloperAssistant") {}
export const layer = Layer.effect(DeveloperAssistant, make);
