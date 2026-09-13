import * as NodeCrypto from "node:crypto";
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
  MessageId,
  ProjectId,
  ThreadId,
  assistantTaskHoldsProject,
  assistantTaskThreadId,
  type AssistantAnswerInput,
  type AssistantCodeReview,
  type AssistantE2eResult,
  type AssistantThreadRole,
  type AssistantControlInput,
  type AssistantReviewInput,
  type AssistantSetupInput,
  type AssistantSetupPlan,
  type AssistantSetupResolveInput,
  type OrchestrationEvent,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  type LinearIssueSummary,
} from "@t3tools/contracts";
import { isStaleRequestFailureDetail } from "../orchestration/decider.ts";
import { LinearApi } from "../linear/LinearApi.ts";
import { LinearThreadService } from "../linear/LinearThreadService.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionService } from "../orchestration/Services/ProviderRuntimeIngestion.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { forkParked } from "../serverActivation.ts";
import { AssistantEvidence } from "./AssistantEvidence.ts";
import {
  deployedComment,
  e2eComment,
  linearFailureDetail,
  linearFeedback,
  mergedComment,
} from "./linearUpdates.ts";
import { StagingVerifier } from "./StagingVerifier.ts";
import {
  assistantInstructions,
  e2eBrief,
  e2eInstructions,
  reviewerInstructions,
  workerInstructions,
} from "./prompts.ts";
import { makeSetup, validateDeploymentConfig } from "./AssistantSetup.ts";

type ProjectRow = {
  project_id: string;
  thread_id: string;
  repository_key: string;
  config: string;
  status: "running" | "stopped";
  error: string | null;
  wake_version: number;
  delivered_version: number;
  wake_reason: string;
  issue_fingerprint: string | null;
  external_waits: number;
};
type TaskRow = { id: string; project_id: string; thread_id: string; data: string };
const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(AssistantProjectConfig));
const decodeTask = Schema.decodeUnknownEffect(Schema.fromJsonString(AssistantTask));
const decodeDecision = Schema.decodeUnknownEffect(Schema.fromJsonString(AssistantDecision));
const encodeConfig = Schema.encodeSync(Schema.fromJsonString(AssistantProjectConfig));
const encodeTask = Schema.encodeSync(Schema.fromJsonString(AssistantTask));
const encodeDecision = Schema.encodeSync(Schema.fromJsonString(AssistantDecision));
const isAssistantError = Schema.is(DeveloperAssistantError);
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
    : fail(
        "The developer assistant operation failed. Inspect the thread or server logs and retry.",
      );
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const newId = () => NodeCrypto.randomUUID();
const busy = (status: string | undefined) => status === "running" || status === "starting";
const ROLES = ["implement", "review", "e2e"] as const;
const ROLE_THREAD = /^assistant-(review|e2e)-(.+)$/;
const ROLE_TITLES = { review: "code review", e2e: "e2e on staging" } as const;

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
  // The coordinator's conversation keeps its operating instructions, so wakes
  // repeat them only when they changed, the conversation was compacted, or the
  // person started the assistant. Kept in memory: a restart re-sends them once.
  const briefed = new Map<string, string>();

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
  const wake = Effect.fn("Assistant.wake")(function* (id: string, reason: string) {
    yield* sql`UPDATE assistant_projects SET wake_version = wake_version + 1,
      wake_reason = ${reason.slice(0, 12000)} WHERE project_id = ${id}`;
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
  // The threads share one worktree, so only one of them runs at a time.
  const taskBusy = Effect.fn("Assistant.taskBusy")(function* (t: AssistantTask) {
    for (const id of taskThreadIds(t)) {
      const shell = yield* snapshots.getThreadShellById(id);
      if (Option.isSome(shell) && (yield* threadBusy(shell.value))) return true;
    }
    return false;
  });
  const taskQueued = Effect.fn("Assistant.taskQueued")(function* (t: AssistantTask) {
    const ids = taskThreadIds(t);
    const rows =
      yield* sql`SELECT id FROM assistant_messages WHERE delivered = 0 AND thread_id IN (${ids[0]}, ${ids[1]}, ${ids[2]})`;
    return rows.length > 0;
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
      yield* sql`SELECT id FROM assistant_decisions WHERE resolved = 0 AND thread_id IN (${ids[0]}, ${ids[1]}, ${ids[2]})`;
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

  const board = Effect.fn("Assistant.board")(function* (projectId: string | null) {
    const projects =
      yield* sql<ProjectRow>`SELECT * FROM assistant_projects WHERE (${projectId ?? null} IS NULL OR project_id = ${projectId ?? null})`;
    const tasks =
      yield* sql<TaskRow>`SELECT * FROM assistant_tasks WHERE (${projectId ?? null} IS NULL OR project_id = ${projectId ?? null}) AND (status NOT IN ('accepted','skipped') OR id IN (
      SELECT id FROM assistant_tasks WHERE status IN ('accepted','skipped') ORDER BY rowid DESC LIMIT 200
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
      "This tool is only available to the project's developer assistant or its authorized worker.",
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
    if (p.status !== "running") return yield* fail("The assistant is stopped.");
    if (!assistantTaskHoldsProject(owner.task.status))
      return yield* fail("This issue is no longer active.");
    return { p, t: owner.task };
  });

  const candidates = Effect.fn("Assistant.candidates")(function* (config: AssistantProjectConfig) {
    const issues: LinearIssueSummary[] = [];
    let cursor: string | undefined;
    do {
      const page = yield* linear.listIssues({
        projectId: config.linearProjectId,
        assignedToMe: config.assignedToMe,
        stateTypes: config.readyStates.length ? ["unstarted", "backlog"] : ["unstarted"],
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      issues.push(...page.issues);
      cursor = page.pageInfo?.hasNextPage ? (page.pageInfo.endCursor ?? undefined) : undefined;
    } while (cursor && issues.length < 1000);
    const claimedRows = yield* sql<{
      issue_id: string;
    }>`SELECT DISTINCT issue_id FROM assistant_tasks WHERE status != 'changes-requested'`;
    const claimed = new Set(claimedRows.map((t) => t.issue_id));
    const shell = yield* snapshots.getShellSnapshot();
    for (const thread of shell.threads) if (thread.linkedIssue) claimed.add(thread.linkedIssue.id);
    return issues
      .filter(
        (issue) =>
          !claimed.has(issue.id) &&
          (!config.readyStates.length || config.readyStates.includes(issue.state.name)),
      )
      .sort(
        (a, b) => (a.priority || 5) - (b.priority || 5) || a.identifier.localeCompare(b.identifier),
      );
  });

  const queueMessage = Effect.fn("Assistant.queueMessage")(function* (
    projectId: string,
    threadId: ThreadId,
    id: string,
    text: string,
  ) {
    yield* sql`INSERT OR IGNORE INTO assistant_messages (id, project_id, thread_id, text, created_at) VALUES (${id}, ${projectId}, ${threadId}, ${text}, ${yield* now})`;
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
    const active =
      yield* sql`SELECT id FROM assistant_tasks WHERE project_id = ${config.projectId} AND status IN ('preparing','working','waiting','blocked')`;
    if (active.length)
      return yield* fail(
        "Finish or skip the active issue before changing the project's environment or scope.",
      );
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
    yield* sql`INSERT INTO assistant_projects (project_id, repository_key, thread_id, config) VALUES (${config.projectId}, ${repositoryKey}, ${threadId}, ${encodeConfig(config)})
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

  const control = Effect.fn("Assistant.control")(
    function* (input: typeof AssistantControlInput.Type) {
      let p = yield* project(input.projectId);
      if (input.action === "stop" || input.action === "interrupt") {
        yield* sql`UPDATE assistant_projects SET status = 'stopped' WHERE project_id = ${input.projectId}`;
        yield* engine
          .dispatch({
            type: "thread.turn.interrupt",
            commandId: CommandId.make(newId()),
            threadId: ThreadId.make(p.thread_id),
            createdAt: yield* now,
          })
          .pipe(Effect.catch(() => Effect.void));
        if (input.action === "interrupt") {
          const b = yield* board(input.projectId);
          for (const t of b.tasks.filter((t) => assistantTaskHoldsProject(t.status))) {
            // A worker whose worktree setup failed never got a thread to interrupt.
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
            }
            yield* saveTask({
              ...t,
              status: "blocked",
              error: "Interrupted by you. Resume the assistant to recover this issue, or skip it.",
            });
          }
        }
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
        if (input.action === "start") briefed.delete(input.projectId);
        yield* sql`UPDATE assistant_projects SET status = 'running', error = NULL, external_waits = 0 WHERE project_id = ${input.projectId}`;
        yield* wake(
          input.projectId,
          input.action === "wake"
            ? "The person asked you to check the project and continue."
            : "The person started the developer assistant. Inspect current work and decisions, then progress the project.",
        );
      }
      yield* changed;
      return yield* board(null);
    },
    deliveryLock.withPermits(1),
    Effect.mapError(wrap),
  );

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
    if (role !== "implement") {
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

  const startIssue = Effect.fn("Assistant.startIssue")(
    function* (caller: ThreadId, reference: string, brief: string) {
      const p = yield* authorize(caller);
      if (p.status !== "running") return yield* fail("The assistant is stopped.");
      const issue = yield* linear.getIssue({ reference });
      const b = yield* board(p.project_id);
      const previousRows =
        yield* sql<TaskRow>`SELECT * FROM assistant_tasks WHERE project_id = ${p.project_id} AND issue_id = ${issue.id} ORDER BY rowid DESC LIMIT 1`;
      const previous = previousRows[0] ? yield* decodeTask(previousRows[0].data) : undefined;
      if (previous && previous.status !== "changes-requested") return previous;
      if (b.decisions.some((d) => d.answer === null))
        return yield* fail("Resolve the pending decisions before starting another issue.");
      if (b.tasks.some((t) => assistantTaskHoldsProject(t.status)))
        return yield* fail(
          "Finish the active issue through verified staging deployment before starting another.",
        );
      if (issue.project?.id !== p.config.linearProjectId)
        return yield* fail("This issue is outside the configured Linear project.");
      if (p.config.assignedToMe) {
        const identity = yield* linear.status;
        if (identity.status !== "connected" || issue.assignee?.id !== identity.viewer.id)
          return yield* fail("This issue is not assigned to the connected Linear account.");
      }
      if (
        !previous &&
        (!(p.config.readyStates.length ? ["unstarted", "backlog"] : ["unstarted"]).includes(
          issue.state.type,
        ) ||
          (p.config.readyStates.length > 0 && !p.config.readyStates.includes(issue.state.name)))
      )
        return yield* fail("This issue is outside the configured ready states.");
      const shell = yield* snapshots.getShellSnapshot();
      for (const thread of shell.threads) {
        if (
          thread.id !== caller &&
          ((thread.linkedIssue?.id === issue.id && !previous) ||
            (thread.projectId === p.config.projectId && (yield* threadBusy(thread))))
        ) {
          return yield* fail(
            "An existing thread already owns this issue or is running in the project. Resolve that work first.",
          );
        }
      }
      const timestamp = yield* now;
      const id = newId();
      const value: AssistantTask = {
        id,
        projectId: p.config.projectId,
        issue,
        threadId: ThreadId.make(`assistant-work-${id}`),
        status: "preparing",
        brief,
        summary: "",
        reviewInstructions: "",
        feedback: previous?.feedback ?? "",
        turns: 0,
        turnLimit: p.config.maxWorkerTurns,
        deployment: null,
        error: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        stage: "implement",
        codeReview: null,
        merge: null,
        e2e: null,
        linearCommentIds: [],
      };
      yield* sql`INSERT INTO assistant_tasks (id, project_id, issue_id, thread_id, status, data) VALUES (${id}, ${p.project_id}, ${issue.id}, ${value.threadId}, ${value.status}, ${encodeTask(value)})`;
      yield* sql`UPDATE assistant_projects SET external_waits = 0 WHERE project_id = ${p.project_id}`;
      yield* changed;
      return yield* prepareTask(p, value).pipe(
        Effect.catch((error) =>
          saveTask({ ...value, status: "blocked", error: wrap(error).detail }),
        ),
      );
    },
    lock.withPermits(1),
    Effect.mapError(wrap),
  );

  const readThread = Effect.fn("Assistant.readThread")(function* (
    caller: ThreadId,
    taskId: string,
    role: AssistantThreadRole = "implement",
  ) {
    const p = yield* authorize(caller);
    const t = yield* task(taskId);
    if (t.projectId !== p.project_id) return yield* fail("This worker belongs to another project.");
    const detail = yield* snapshots.getThreadDetailById(assistantTaskThreadId(t, role));
    return {
      task: t,
      transcript: Option.isSome(detail)
        ? detail.value.messages
            .slice(-20)
            .map((m) => ({ role: m.role, text: m.text.slice(0, 20000) }))
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
      taskId: string,
      message: string,
      role: AssistantThreadRole = "implement",
    ) {
      const p = yield* authorize(caller);
      if (p.status !== "running") return yield* fail("The assistant is stopped.");
      const t = yield* task(taskId);
      if (t.projectId !== p.project_id || !assistantTaskHoldsProject(t.status))
        return yield* fail(
          "Only this project's active worker can receive follow-up work. Start a new issue thread for review feedback.",
        );
      if (role === "implement" && t.turns >= t.turnLimit)
        return yield* fail(
          "This issue reached its worker turn limit. Ask the person to review it or explicitly retry from the assistant board.",
        );
      if (
        role === "e2e" &&
        (!t.deployment ||
          Option.isNone(
            yield* snapshots.getThreadShellById(assistantTaskThreadId(t, "e2e"), {
              includeArchived: true,
            }),
          ))
      )
        return yield* fail(
          "Verify the staging deployment and start the tester with assistant_start_e2e first.",
        );
      if (yield* taskDecisionsPending(t))
        return yield* fail(
          "The issue has an unanswered decision or permission request. If the person answered a decision in your chat, pass it on with assistant_answer_decision; otherwise wait for their answer.",
        );
      if (yield* taskBusy(t))
        return yield* fail(
          "One of the issue's threads is still running. End your turn and wait for its result.",
        );
      if (yield* taskQueued(t)) return t;
      if (role === "implement" && t.turns === 0) return yield* prepareTask(p, t);
      if (role !== "implement") {
        // Creating the review thread dispatches to the engine, which stays outside SQL transactions.
        yield* queueRoleTurn(p, t, role, message, () => reviewerInstructions(p.config, t));
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
      if (p.status !== "running") return yield* fail("The assistant is stopped.");
      const b = yield* board(p.project_id);
      const existing = b.decisions.find(
        (d) => d.threadId === caller && d.answer === null && d.question === question,
      );
      if (existing) return existing;
      const t = b.tasks.find((t) => t.threadId === caller);
      if (t && !assistantTaskHoldsProject(t.status))
        return yield* fail(
          "This worker is no longer active. Ask the developer assistant to schedule follow-up work.",
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
      if (t) yield* saveTask({ ...t, status: "waiting" });
      yield* wake(
        p.project_id,
        "A worker needs a product decision. Read the decision inbox; do not guess the person's answer.",
      );
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
        }
        // The coordinator relaying an answer already knows it.
        if (via === "inbox")
          yield* wake(d.projectId, `The person answered a decision: ${d.question}\n${text}`);
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
        // The pair has spent its rounds; the coordinator hears when this turn ends.
        return yield* saveTask({
          ...t,
          codeReview,
          stage: "coordinator",
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
      // An earlier problem the issue has since moved past must not follow it to review.
      const posted = yield* postLinear(
        { ...t, merge, error: null },
        mergedComment({ merge, review, pullRequest, baseBranch: p.config.baseBranch }),
      );
      // The coordinator is woken when this thread's turn ends.
      return yield* saveTask({ ...posted, summary, stage: "coordinator" });
    },
    lock.withPermits(1),
    Effect.mapError(wrap),
  );

  const verifyStaging = Effect.fn("Assistant.verifyStaging")(
    function* (caller: ThreadId, taskId: string, targetIds?: ReadonlyArray<string>) {
      const p = yield* authorize(caller);
      if (p.status !== "running") return yield* fail("The assistant is stopped.");
      const t = yield* task(taskId);
      if (t.projectId !== p.project_id)
        return yield* fail("This worker belongs to another project.");
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
      if ((yield* taskBusy(t)) || (yield* taskQueued(t)))
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
      const posted = yield* postLinear(
        { ...t, deployment, error: null },
        deployedComment({ deployment }),
      );
      yield* sql`UPDATE assistant_projects SET external_waits = 0 WHERE project_id = ${p.project_id}`;
      return yield* saveTask(posted);
    },
    lock.withPermits(1),
    Effect.mapError(wrap),
  );

  const startE2e = Effect.fn("Assistant.startE2e")(
    function* (caller: ThreadId, taskId: string, brief: string) {
      const p = yield* authorize(caller);
      if (p.status !== "running") return yield* fail("The assistant is stopped.");
      const t = yield* task(taskId);
      if (t.projectId !== p.project_id || !assistantTaskHoldsProject(t.status))
        return yield* fail("Only this project's active issue can be tested.");
      if (!t.deployment)
        return yield* fail("Verify the staging deployment with assistant_verify_staging first.");
      if (yield* taskDecisionsPending(t))
        return yield* fail("Resolve the issue's pending decisions first.");
      if ((yield* taskBusy(t)) || (yield* taskQueued(t)))
        return yield* fail("Wait for the issue's threads to finish before starting e2e.");
      const directory = yield* evidence.directory(t.id);
      const run = e2eBrief(t, brief);
      const updated = yield* saveTask({ ...t, stage: "e2e", status: "working", error: null });
      yield* queueRoleTurn(
        p,
        updated,
        "e2e",
        `New e2e run on the deployment of ${t.deployment.revision.slice(0, 7)}. Save screenshots in ${directory}.\n${run}`,
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
      if (t.stage !== "e2e" || !t.deployment)
        return yield* fail("No e2e run is in progress for this issue.");
      if (input.screenshots.length > 12)
        return yield* fail("Attach at most 12 screenshots; keep the ones that prove each check.");
      if (input.verdict === "partial" && !input.humanChecks.length)
        return yield* fail("A partial result lists what a person should check in humanChecks.");
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
      };
      const worker = yield* snapshots.getThreadShellById(t.threadId, { includeArchived: true });
      const pullRequest = Option.isSome(worker)
        ? (worker.value.linkedPullRequest ?? worker.value.branchPullRequest ?? null)
        : null;
      let updated = yield* postLinear(
        { ...t, e2e, error: null },
        e2eComment({
          e2e,
          merge: t.merge ?? null,
          deployment: t.deployment,
          pullRequest,
          acceptedState: p.config.acceptedState,
        }),
      );
      if (input.verdict === "failed") return yield* saveTask({ ...updated, stage: "coordinator" });
      const linearError = yield* changeLinearState(updated, p.config.reviewState).pipe(
        Effect.as(null),
        Effect.catch((error) => Effect.succeed(wrap(error).detail)),
      );
      updated = {
        ...updated,
        status: "review",
        stage: "coordinator",
        summary: t.merge?.summary ?? t.summary,
        reviewInstructions: [
          ...input.humanChecks.map((check, i) => `${i + 1}. ${check}`),
          input.report,
        ].join("\n\n"),
        // Without a successful move there is no delivered state to be moved away from.
        deliveredState: linearError ? null : p.config.reviewState.trim() || null,
        error: [updated.error, linearError].filter(Boolean).join(" ") || null,
      };
      yield* sql`UPDATE assistant_projects SET external_waits = 0 WHERE project_id = ${p.project_id}`;
      // Threads are archived and the coordinator woken when this turn ends.
      return yield* saveTask(updated);
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
        if (!assistantTaskHoldsProject(t.status))
          return yield* fail("Only an active issue can be skipped.");
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
        yield* saveTask({ ...t, turnLimit: t.turns + p.config.maxWorkerTurns, error: null });
      }
      yield* wake(
        t.projectId,
        `The person chose ${input.action} for ${t.issue.identifier}. ${input.feedback}`,
      );
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
    const p = yield* authorize(caller);
    if (p.status !== "running") return yield* fail("The assistant is stopped.");
    if (p.external_waits >= 15) {
      yield* sql`UPDATE assistant_projects SET status = 'stopped', error = 'External progress has not completed after 15 checks. Inspect the blocker, then Start to allow another attempt.' WHERE project_id = ${p.project_id}`;
      yield* changed;
      return;
    }
    yield* sql`UPDATE assistant_projects SET external_waits = external_waits + 1, error = ${`Waiting: ${reason.slice(0, 1000)}`} WHERE project_id = ${p.project_id}`;
    yield* changed;
  }, Effect.mapError(wrap));

  const pause = Effect.fn("Assistant.pause")(
    function* (caller: ThreadId) {
      const p = yield* authorize(caller);
      yield* sql`UPDATE assistant_projects SET status = 'stopped' WHERE project_id = ${p.project_id}`;
      yield* changed;
    },
    deliveryLock.withPermits(1),
    Effect.mapError(wrap),
  );

  const deliver = Effect.fn("Assistant.deliver")(
    function* () {
      const rows =
        yield* sql<ProjectRow>`SELECT * FROM assistant_projects WHERE status = 'running'`;
      for (const row of rows) {
        const p = yield* project(row.project_id);
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
          const wakeText = `Wake reason: ${p.wake_reason}\nRead assistant_get_board before taking action.`;
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
      }>`SELECT m.* FROM assistant_messages m JOIN assistant_projects p ON p.project_id = m.project_id WHERE m.delivered = 0 AND p.status = 'running' ORDER BY m.rowid`;
      for (const m of messages) {
        const threadId = ThreadId.make(m.thread_id);
        const current = yield* snapshots.getThreadShellById(threadId);
        if (Option.isNone(current) || (yield* threadBusy(current.value))) continue;
        // An issue's threads share one worktree: a handoff waits for the sender's turn to end.
        const owner = yield* threadTask(threadId);
        if (owner && (yield* taskBusy(owner.task))) continue;
        const pending =
          yield* sql`SELECT id FROM assistant_decisions WHERE thread_id = ${threadId} AND resolved = 0`;
        if (
          pending.length ||
          current.value.hasPendingApprovals ||
          current.value.hasPendingUserInput
        )
          continue;
        const p = yield* project(m.project_id);
        if (p.status !== "running") continue;
        yield* engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(m.id),
          threadId,
          message: { messageId: MessageId.make(m.id), role: "user", text: m.text, attachments: [] },
          modelSelection:
            threadId === p.thread_id ? p.config.modelSelection : p.config.workerModelSelection,
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
   * One of an issue's threads finished a turn. A handoff it queued carries the
   * issue on without the coordinator; otherwise the coordinator hears why the
   * issue is back with it: a merge, an e2e result, or a thread that stopped
   * without handing off.
   */
  const turnEnded = Effect.fn("Assistant.turnEnded")(function* (
    t: AssistantTask,
    role: AssistantThreadRole,
  ) {
    const id = t.issue.identifier;
    if (t.status === "review") {
      if (role !== "e2e") return;
      for (const threadId of taskThreadIds(t)) {
        yield* terminals.close({ threadId });
        yield* archiveThread(threadId);
      }
      return yield* wake(
        t.projectId,
        `${id} ${t.e2e?.verdict === "partial" ? "passed e2e with checks for the person" : "passed e2e"} and is in review. The project is free; select the next eligible issue now.`,
      );
    }
    // A queued handoff carries the issue on; an open question waits for the person.
    if (
      !assistantTaskHoldsProject(t.status) ||
      (yield* taskQueued(t)) ||
      (yield* taskDecisionsPending(t))
    )
      return;
    if (t.stage === role) {
      yield* saveTask({ ...t, stage: "coordinator" });
      return yield* wake(
        t.projectId,
        `The ${role} thread for ${id} ended its turn without handing off. Read it with assistant_read_thread (thread "${role}") and decide the next step.`,
      );
    }
    if (t.stage !== "coordinator") return;
    if (t.status === "blocked")
      return yield* wake(t.projectId, `${id} is blocked: ${t.error ?? "see its threads"}`);
    if (t.e2e?.verdict === "failed" && role === "e2e")
      return yield* wake(
        t.projectId,
        `${id} failed its e2e check on staging:\n${t.e2e.report.slice(0, 4000)}\nDecide whether this goes to the implementer, back to the tester, or to the person.`,
      );
    if (t.merge && !t.deployment && role === "implement")
      return yield* wake(
        t.projectId,
        `${id} was approved in code review and merged into its integration branch at ${t.merge.commit.slice(0, 7)}. Verify staging, then start the e2e check.`,
      );
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
        yield* wake(
          projectId,
          `The person answered in the original thread: ${d.question}\n${event.payload.text}`,
        );
      }
    } else if (event.type === "thread.activity-appended") {
      const a = event.payload.activity;
      if (a.kind === "context-compaction") {
        // A compacted summary may drop the instructions; the next wake restores them.
        if (projects[0]) briefed.delete(projectId);
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
        if (t && assistantTaskHoldsProject(t.status)) yield* saveTask({ ...t, status: "waiting" });
        if (t)
          yield* wake(
            projectId,
            `${t.issue.identifier} needs input in its thread. Surface the pending decision to the person.`,
          );
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
      if (t && status === "stopped" && (yield* releasedWhileIdle(threadId))) {
        // Nothing to do: the thread's turn ended normally before its session was released.
      } else if (
        // A delivered issue's tester may stop instead of settling; either way its work is done.
        t &&
        owner &&
        t.stage !== undefined &&
        settled &&
        (status === "ready" || t.status === "review")
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
          ...(t.stage === undefined ? { summary } : { stage: "coordinator" as const }),
          ...(failed
            ? {
                status: "blocked" as const,
                error: event.payload.session.lastError ?? "The worker stopped before delivery.",
              }
            : {}),
        });
        yield* wake(
          projectId,
          `${t.issue.identifier} ${owner?.role === "implement" ? "worker" : `${owner?.role} thread`} is ${status}. Read its result and manage the next step. A finished turn does not prove deployment.`,
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
          error: `The ${owner?.role === "implement" ? "worker" : `${owner?.role}`} thread was deleted. Skip this issue to release the project.`,
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
        const t = yield* decodeTask(row.data);
        const p = yield* project(t.projectId);
        const issue = yield* linear.getIssue({ reference: t.issue.id });
        const state = issue.state;
        const delivered =
          t.deliveredState !== undefined
            ? t.deliveredState
            : t.error
              ? null
              : p.config.reviewState.trim() || null;
        if (state.type === "completed") {
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
          yield* saveTask({ ...t, status: "changes-requested", feedback });
          yield* wake(
            t.projectId,
            `The person asked for changes on ${t.issue.identifier} from Linear.\n${feedback}\nStart it again with assistant_start_issue when the project is free.`,
          );
        }
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
    const rows = yield* sql<ProjectRow>`SELECT * FROM assistant_projects WHERE status = 'running'`;
    for (const row of rows) {
      yield* Effect.gen(function* () {
        const config = yield* decodeConfig(row.config);
        const available = yield* candidates(config);
        const fingerprint = NodeCrypto.createHash("sha256")
          .update(available.map((i) => `${i.id}:${i.updatedAt}`).join("\n"))
          .digest("hex");
        if (row.issue_fingerprint !== fingerprint) {
          yield* sql`UPDATE assistant_projects SET issue_fingerprint = ${fingerprint} WHERE project_id = ${row.project_id}`;
          yield* wake(
            row.project_id,
            "The eligible issue list changed. Reassess priorities without interrupting the current worker.",
          );
        }
        if (row.error?.startsWith("Waiting:")) {
          yield* wake(row.project_id, row.error);
        }
        if (row.error !== null) {
          yield* sql`UPDATE assistant_projects SET error = NULL WHERE project_id = ${row.project_id} AND error = ${row.error}`;
          yield* changed;
        }
      }).pipe(
        Effect.catch((error) =>
          sql`UPDATE assistant_projects SET error = ${wrap(error).detail} WHERE project_id = ${row.project_id}`.pipe(
            Effect.andThen(changed),
          ),
        ),
      );
    }
    yield* syncLinearReviews();
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
    startIssue,
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
      yield* sql<ProjectRow>`SELECT * FROM assistant_projects WHERE status = 'running'`;
    for (const p of running)
      yield* wake(
        p.project_id,
        "T3 restarted. Inspect retained workers, queued work, and decisions before continuing.",
      );
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
