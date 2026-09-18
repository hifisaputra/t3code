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
  ASSISTANT_PROJECT_NOTES,
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
  assistantE2ePendingEngineeringChecks,
  assistantE2eVerdict,
  assistantLinearPlan,
  assistantParallelIssues,
  assistantPicksIssues,
  assistantTaskE2eDepth,
  assistantTaskE2eEnvironment,
  assistantTaskEngineeringChecksPending,
  assistantTaskHoldsProject,
  assistantTaskThreadId,
  assistantThreadKind,
  type AssistantAddProjectNoteInput,
  type AssistantAnswerInput,
  type AssistantCodeReview,
  type AssistantDeleteProjectNoteInput,
  type AssistantDeployment,
  type AssistantE2eCheck,
  type AssistantE2eDepth,
  type AssistantE2ePlan,
  type AssistantE2eResult,
  type AssistantProjectNote,
  type AssistantSetE2eDepthInput,
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
import {
  LinearAgentOutbox,
  type OutboxContent,
  type TeamDispatchInput,
  type TeamPromptInput,
} from "../linear/LinearAgentOutbox.ts";
import { LinearApi, LinearAppCredential } from "../linear/LinearApi.ts";
import { LinearOAuth } from "../linear/LinearOAuth.ts";
import { LinearThreadService } from "../linear/LinearThreadService.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionService } from "../orchestration/Services/ProviderRuntimeIngestion.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { forkParked } from "../serverActivation.ts";
import { AssistantEvidence, type EvidenceKind } from "./AssistantEvidence.ts";
import {
  declinedComment,
  deliveredDescription,
  deployedComment,
  e2eComment,
  issueFingerprint,
  linearFailureDetail,
  linearFeedback,
  mergedComment,
  noE2eComment,
  sessionNotes,
  withSessionNote,
} from "./linearUpdates.ts";
import { StagingVerifier } from "./StagingVerifier.ts";
import {
  e2eBrief,
  e2eInstructions,
  leadInstructions,
  reviewerInstructions,
  workerInstructions,
} from "./prompts.ts";
import { makeSetup, validateSetupPlan } from "./AssistantSetup.ts";
import { openProjectNotes, projectNoteKey } from "./projectNotes.ts";

type ProjectRow = {
  project_id: string;
  repository_key: string;
  config: string;
  status: AssistantProjectStatus;
  error: string | null;
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
/** How long after an issue last changed the scan still closes its finished team. */
const CLOSE_RETRY_WINDOW_MS = 24 * 60 * 60_000;
// How long after a turn ends its checkpoint may still be read from the worktree.
const CHECKPOINT_GRACE_MS = 30_000;
const ROLE_THREAD = /^assistant-(lead|review|e2e)-(.+)$/;
const ROLE_TITLES = { lead: "team leader", review: "code review", e2e: "e2e on staging" } as const;
const ROLE_NAMES = {
  lead: "team leader",
  implement: "worker",
  review: "code review thread",
  e2e: "e2e thread",
} as const;
/** How a role reads in its team's Linear session. */
const LINEAR_ROLES = {
  lead: "team leader",
  implement: "implementer",
  review: "reviewer",
  e2e: "tester",
} as const;
const STOPPED_FROM_LINEAR =
  "Stopped from Linear. Resume or skip the issue on the developer assistant board in T3 Code.";
const firstLine = (text: string) => text.trim().split("\n")[0]!.slice(0, 300);
/** A team leader that declines this many issues in a row pauses the loop for the person. */
const DECLINE_STREAK_LIMIT = 3;
/** How long T3 watches a staging deploy before handing it back to the team leader. */
const DEPLOY_WATCH_MS = 45 * 60_000;
/** How much of a passing check run the reviewer is shown. */
const CHECK_TAIL = 2000;
const shortSha = (revision: string) => revision.slice(0, 7);
/** The findings a reviewer listed, counted by their top-level list items. */
const findingCount = (findings: string) =>
  findings.split("\n").filter((line) => /^(?:[-*]|\d+[.)])\s+\S/.test(line)).length;
/** A failed e2e run in a few lines for the Linear session; the team handles the rest. */
const e2eFailureNote = (t: AssistantTask, e2e: AssistantE2eResult) => {
  const failed = (e2e.checks ?? []).flatMap((check) =>
    check.result === "failed"
      ? [
          `- ${t.criteria?.[check.criterion - 1] ?? `Criterion ${check.criterion}`}: ${check.evidence.slice(0, 300)}`,
        ]
      : [],
  );
  return [
    `E2E test failed ${e2e.environment === "worktree" ? "in the worktree" : "on staging"}. The team is working on it.`,
    failed.length ? failed.join("\n") : e2e.report.slice(0, 500),
  ].join("\n\n");
};
/** A run's engineering checks as a numbered list. */
const numbered = (items: ReadonlyArray<string>) =>
  items.map((item, index) => `${index + 1}. ${item}`).join("\n");
/** What the team leader hears when a passed or partial run left engineering checks to settle. */
const engineeringNotice = (t: AssistantTask, e2e: AssistantE2eResult) => {
  const inWorktree = e2e.environment === "worktree";
  const count = e2e.engineeringChecks?.length ?? 0;
  return `${t.issue.identifier} ${e2e.verdict === "partial" ? "passed its e2e check with checks left for the person" : "passed its e2e check"} ${inWorktree ? "in the worktree" : "on staging"}, and the tester listed ${count === 1 ? "an engineering check" : `${count} engineering checks`} that only an engineer can do. T3 holds the ${inWorktree ? "merge" : "delivery"} until you settle ${count === 1 ? "it" : "them"}:
${numbered(e2e.engineeringChecks ?? [])}
Settle each with the code reviewer: send the checks with assistant_message_worker and thread "review" (it can run the app in this worktree), and read its answer with assistant_read_thread (thread "review"). When a check shows a defect, send it to the worker with assistant_message_worker, as after a failed run. Once every check is settled, call assistant_deliver with what was checked and what it showed; T3 then ${inWorktree ? "tells the worker to merge" : "puts the issue in review"}.`;
};
/**
 * What the team leader's e2e brief should hold. With criteria recorded T3 hands
 * the tester those itself; issues taken before them still ask for the checks.
 */
const briefAsk = (t: AssistantTask) =>
  t.criteria?.length
    ? "a brief for the tester with the pages or endpoints affected, the data it needs and what to clean up; T3 gives the tester the acceptance criteria you listed"
    : "a brief with each acceptance criterion as a check a person could follow, the pages or endpoints affected, the data it needs and what to clean up";
/**
 * Why a smoke test's criterion numbers are wrong, or null when they are right:
 * at least one, no repeats, each an acceptance criterion of the issue.
 */
const smokeCriteriaError = (numbers: ReadonlyArray<number>, criteriaCount: number) => {
  if (!numbers.length)
    return "A smoke test lists at least one acceptance criterion in smokeCriteria.";
  if (new Set(numbers).size !== numbers.length) return "List each criterion in smokeCriteria once.";
  const unknown = numbers.filter((n) => !Number.isInteger(n) || n < 1 || n > criteriaCount);
  return unknown.length
    ? `smokeCriteria are the 1-based numbers of the issue's ${criteriaCount} acceptance criteria; there is no criterion ${unknown.join(", ")}.`
    : null;
};
/** A plan at another depth, keeping only the fields that depth uses. */
const planAtDepth = (
  plan: AssistantE2ePlan,
  depth: AssistantE2eDepth,
  depthSetBy: NonNullable<AssistantE2ePlan["depthSetBy"]>,
  extra: { readonly reason?: string; readonly smokeCriteria?: ReadonlyArray<number> } = {},
): AssistantE2ePlan => {
  const { reason: _reason, smokeCriteria: _smoke, ...rest } = plan;
  return {
    ...rest,
    depth,
    depthSetBy,
    ...(depth === "none" && extra.reason !== undefined ? { reason: extra.reason } : {}),
    ...(depth === "smoke" && extra.smokeCriteria
      ? { smokeCriteria: [...extra.smokeCriteria].toSorted((a, b) => a - b) }
      : {}),
  };
};
/** Who set an issue's e2e depth, as the team leader reads it. */
const DEPTH_SETTERS = {
  lead: "You",
  review: "The code reviewer",
  person: "The person, on the board,",
} as const;
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
/**
 * The repository's skill for a role, mentioned on that thread's first message
 * only. It is the last line and nothing follows it: Claude Code runs the last
 * `$name` of a message as its skill and passes the rest as arguments (see
 * provider/Drivers/ClaudeSkillDispatch.ts), and Codex parses `$name` natively.
 */
const withRoleSkill = (
  config: AssistantProjectConfig,
  role: AssistantThreadRole,
  text: string,
): string => {
  const skill = config.roleSkills?.[role]?.trim();
  return skill ? `${text}\n$${skill}` : text;
};
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
/**
 * The state a delivered issue was left in, which moving it away from sends it
 * back; null when Linear could not move it, so only the board sends it back.
 */
const deliveredState = (
  t: Pick<AssistantTask, "deliveredState" | "error">,
  config: Pick<AssistantProjectConfig, "reviewState">,
) =>
  t.deliveredState !== undefined
    ? t.deliveredState
    : t.error
      ? null
      : config.reviewState.trim() || null;
/** What assistant_wait told the caller to do next. */
export type AssistantWaitResult = {
  readonly outcome: "waiting" | "limit";
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
  const oauth = yield* LinearOAuth;
  const outbox = yield* LinearAgentOutbox;
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
  // Issues declined in a row since the last one a team took, per project. In
  // memory: a restart only allows a few more declines before the pause.
  const declineStreak = new Map<string, ReadonlyArray<string>>();
  // Threads whose session the assistant released, and when: their stop is no
  // failure, and one that never reports back is asked again after a while.
  const releasedAt = new Map<string, number>();
  // Issues whose check command is running right now, so a second review request
  // from the same worker does not start the suite again in its worktree.
  const checking = new Set<string>();

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
  /**
   * Linear writes speak as the T3 Code app while it is connected, so the
   * team's updates read as the app's and not the person's; otherwise they use
   * the personal key, as before the app existed.
   */
  const asAssistant = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    outbox.connected.pipe(
      Effect.flatMap((app) =>
        app
          ? effect.pipe(Effect.provideService(LinearAppCredential, oauth.accessToken(false)))
          : effect,
      ),
    );
  /**
   * Queue an update on the team's Linear agent session, when it has one. The
   * outbox sends it and retries; `key` makes a repeated call a no-op.
   */
  const sessionUpdate = Effect.fn("Assistant.sessionUpdate")(function* (
    t: AssistantTask,
    key: string,
    content: OutboxContent,
  ) {
    if (!t.linearSession) return;
    yield* outbox.enqueue(`${t.id}:${key}`, t.linearSession.id, content).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Developer assistant could not queue a Linear session update", {
          task: t.id,
          error,
        }),
      ),
    );
  });
  const saveTask = Effect.fn("Assistant.saveTask")(function* (value: AssistantTask) {
    const updated = { ...value, updatedAt: yield* now };
    const before = updated.linearSession
      ? yield* sql<{ status: string }>`SELECT status FROM assistant_tasks WHERE id = ${updated.id}`
      : [];
    yield* sql`UPDATE assistant_tasks SET status = ${updated.status}, data = ${encodeTask(updated)} WHERE id = ${updated.id}`;
    if (updated.linearSession) {
      // Every way an issue gets blocked for the person passes here.
      if (updated.status === "blocked" && before[0]?.status !== "blocked") {
        const error = updated.error ?? "The team stopped.";
        // A reason that already names the board says what to do itself.
        yield* sessionUpdate(updated, `blocked:${updated.updatedAt}`, {
          type: "error",
          body: error.includes("board in T3 Code")
            ? error
            : `${error}\n\nRetry or skip the issue on the developer assistant board in T3 Code.`,
        });
      }
      // The plan is read when the sync is sent, so a save only re-arms it. Linear
      // drops a finished session's plan, so nothing syncs after the final response.
      if (assistantTaskHoldsProject(updated.status))
        yield* sessionUpdate(updated, "sync", { type: "syncTask", taskId: updated.id });
    }
    yield* changed;
    return updated;
  });
  const queueMessage = Effect.fn("Assistant.queueMessage")(function* (
    projectId: string,
    threadId: ThreadId,
    id: string,
    text: string,
  ) {
    yield* sql`INSERT OR IGNORE INTO assistant_messages (id, project_id, thread_id, text, created_at) VALUES (${id}, ${projectId}, ${threadId}, ${text}, ${yield* now})`;
  });
  /** Tell an issue's team leader what happened. */
  const notifyLead = Effect.fn("Assistant.notifyLead")(function* (t: AssistantTask, text: string) {
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
  /**
   * Park a finished thread on the Settled shelf. Settling keeps the thread in
   * the client's live snapshot, so its conversation stays open from the
   * assistant page, while archiving takes it out of the snapshot entirely.
   * The decider refuses to settle a thread whose session is starting or
   * running, one with an open approval or native question, or one with a turn
   * just queued (OrchestrationThreadSettleBlockedError); such a thread simply
   * stays active, which is the right answer for a thread still doing something.
   */
  const settleThread = Effect.fn("Assistant.settleThread")(function* (threadId: ThreadId) {
    // The engine keeps rejected command ids, so never reuse one across attempts.
    const shell = yield* snapshots.getThreadShellById(threadId, { includeArchived: true });
    if (
      Option.isSome(shell) &&
      shell.value.archivedAt === null &&
      shell.value.settledOverride !== "settled"
    )
      yield* engine
        .dispatch({ type: "thread.settle", commandId: CommandId.make(newId()), threadId })
        .pipe(
          Effect.catchTags({
            OrchestrationCommandInvariantError: () => Effect.void,
            OrchestrationThreadSettleBlockedError: () => Effect.void,
          }),
        );
    // Whether the thread is out of the way now: settled, archived, or never created.
    const after = yield* snapshots.getThreadShellById(threadId, { includeArchived: true });
    return (
      Option.isNone(after) ||
      after.value.archivedAt !== null ||
      after.value.settledOverride === "settled"
    );
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
  /** The issue's pull request, as the worker's thread knows it. */
  const taskPullRequest = Effect.fn("Assistant.taskPullRequest")(function* (t: AssistantTask) {
    const worker = yield* snapshots.getThreadShellById(t.threadId, { includeArchived: true });
    return Option.isSome(worker)
      ? (worker.value.linkedPullRequest ?? worker.value.branchPullRequest ?? null)
      : null;
  });
  /**
   * A team is done: settle its threads and remove the worktree. Git keeps a
   * worktree with uncommitted changes, and so do we.
   * Settled rather than archived, so a finished issue's conversations stay
   * reachable from the assistant page and from the sidebar's Settled shelf.
   * The task's teamClosedAt says the close happened. A thread settled by
   * someone else (the PR settlement reactor, the person) does not: its
   * teammates may still be open. A settle that is refused leaves the team
   * open, and the scan tries again. Callers hold the assistant lock.
   */
  const closeTeam = Effect.fn("Assistant.closeTeam")(function* (value: AssistantTask) {
    // Several threads can finish after a delivery; the first close is the one that counts.
    const t = yield* task(value.id);
    if (t.teamClosedAt) return;
    const worktree = yield* taskWorktree(t);
    let settled = true;
    for (const threadId of taskThreadIds(t)) {
      yield* terminals.close({ threadId });
      if (!(yield* settleThread(threadId))) settled = false;
    }
    // A turn that just ended still has its checkpoint captured from the
    // worktree; removing the worktree under it fails that capture.
    const recentTurn = settled && (yield* turnJustEnded(t));
    if (!settled || recentTurn) {
      yield* Effect.logDebug("Developer assistant left a finished team open to close later", {
        task: t.id,
        reason: settled ? "checkpoint" : "settle",
      });
      return;
    }
    const root = yield* snapshots.getProjectShellById(t.projectId);
    if (worktree && Option.isSome(root))
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
    yield* saveTask({ ...t, teamClosedAt: yield* now });
  });
  /** Whether a team thread's latest turn ended too recently for its checkpoint to be captured. */
  const turnJustEnded = Effect.fn("Assistant.turnJustEnded")(function* (t: AssistantTask) {
    const at = yield* Clock.currentTimeMillis;
    for (const threadId of taskThreadIds(t)) {
      const shell = yield* snapshots.getThreadShellById(threadId, { includeArchived: true });
      const completedAt = Option.isSome(shell) ? shell.value.latestTurn?.completedAt : null;
      const age = completedAt ? at - Date.parse(completedAt) : null;
      if (age !== null && age >= 0 && age < CHECKPOINT_GRACE_MS) return true;
    }
    return false;
  });
  /**
   * Delivered and declined issues whose team did not close when its last turn
   * ended, because a thread could not be settled then. Only recent ones: an
   * issue closed before teamClosedAt was recorded has none, and closing it
   * again would settle threads the person has reopened since.
   */
  const closeFinishedTeams = Effect.fn("Assistant.closeFinishedTeams")(function* (
    projectId: string,
  ) {
    const since = (yield* Clock.currentTimeMillis) - CLOSE_RETRY_WINDOW_MS;
    const rows =
      yield* sql<TaskRow>`SELECT * FROM assistant_tasks WHERE project_id = ${projectId} AND status IN ('review','declined')`;
    for (const row of rows) {
      const t = yield* decodeTask(row.data);
      if (t.teamClosedAt || Date.parse(t.updatedAt) < since) continue;
      if ((yield* taskBusy(t)) || (yield* taskQueued(t))) continue;
      yield* closeTeam(t).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Developer assistant could not close a finished team", {
            task: t.id,
            error,
          }),
        ),
      );
    }
  });
  /** Post a phase update on the issue. Delivery never waits on Linear; a failure is noted on the task. */
  const postLinear = Effect.fn("Assistant.postLinear")(function* (t: AssistantTask, body: string) {
    return yield* asAssistant(linear.createComment({ issueId: t.issue.id, body })).pipe(
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
    e2e: AssistantE2eResult | null,
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
      asAssistant,
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
        Effect.all([decodeConfig(p.config), openProjectNotes(sql, p.project_id)]).pipe(
          Effect.map(([config, notes]) => ({
            config,
            status: p.status,
            error: p.error,
            limitedUntil: p.limited_until,
            notes,
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
  /** A team leader's own issue, whatever state it is in; each tool checks what it needs. */
  const authorizeLead = Effect.fn("Assistant.authorizeLead")(function* (caller: ThreadId) {
    const owner = yield* threadTask(caller);
    if (owner?.role !== "lead")
      return yield* fail("Only the issue's team leader can use this tool.");
    return { p: yield* project(owner.task.projectId), t: owner.task };
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
  type AwaitedProject = Effect.Success<ReturnType<typeof project>>;

  const configureProject = Effect.fn("Assistant.configure")(function* (
    config: AssistantProjectConfig,
  ) {
    const deploymentError = validateSetupPlan(config);
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
    // A setup revision rebuilds the config from the plan and the person's
    // preferences, which carry no picking choice: the one the Start button
    // saved stands until they start the loop again.
    const saved: AssistantProjectConfig =
      config.autoPick === undefined && current?.autoPick !== undefined
        ? { ...config, autoPick: current.autoPick }
        : config;
    yield* sql`INSERT INTO assistant_projects (project_id, repository_key, config) VALUES (${config.projectId}, ${repositoryKey}, ${encodeConfig(saved)})
      ON CONFLICT(project_id) DO UPDATE SET repository_key = excluded.repository_key, config = excluded.config, error = NULL`;
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
        const status =
          action === "pause" || (action === "wake" && p.status === "paused") ? "paused" : "running";
        // The person may have switched accounts or seen the limit reset early,
        // so starting lifts a usage-limit hold and sends what was waiting.
        yield* sql`UPDATE assistant_projects SET status = ${status}, error = NULL, limited_until = NULL WHERE project_id = ${input.projectId}`;
        const held = yield* heldTasks(input.projectId);
        if (action === "start") declineStreak.delete(input.projectId);
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
    instructions: (notes: ReadonlyArray<AssistantProjectNote>) => string,
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
      sent.length
        ? message
        : withRoleSkill(
            p.config,
            role,
            `${instructions(yield* openProjectNotes(sql, p.project_id))}\n\n${message}`,
          ),
    );
  });

  const newTask = Effect.fn("Assistant.newTask")(function* (
    p: AwaitedProject,
    issue: LinearIssueSummary,
    fields: Partial<
      Pick<AssistantTask, "status" | "brief" | "feedback" | "dispatched" | "linearSession">
    >,
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
    const notes = yield* openProjectNotes(sql, p.project_id);
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* saveTask({ ...t, status: "working", error: null });
        yield* queueMessage(
          t.projectId,
          assistantTaskThreadId(t, "lead"),
          `${t.id}:lead:start`,
          withRoleSkill(p.config, "lead", leadInstructions(p.config, t, notes)),
        );
      }),
    );
    return yield* task(t.id);
  });
  /**
   * Each team gets its own agent session on the issue while the Linear app is
   * connected, opened before the git work so Linear hears from the team at once.
   * The team runs without one when Linear cannot open it.
   */
  const openSession = Effect.fn("Assistant.openSession")(function* (t: AssistantTask) {
    // A person delegated the issue in Linear: the team speaks in that session.
    if (t.linearSession?.origin === "delegated") {
      // Delegation records it too, so a failure here only waits for that.
      yield* outbox.adoptSession(t.linearSession.id, t.issue.id, t.id).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Developer assistant could not record its delegated session", {
            task: t.id,
            error,
          }),
        ),
      );
      yield* sessionUpdate(t, "picked-up", {
        type: "thought",
        body: "Picked up by a team in T3 Code.",
      });
      yield* sessionUpdate(t, "sync", { type: "syncTask", taskId: t.id });
      return { task: t, error: null };
    }
    if (t.linearSession || !(yield* outbox.connected)) return { task: t, error: null };
    const created = yield* outbox.createSession(t.issue.id, t.id).pipe(
      Effect.map((id) => ({ id, error: null })),
      Effect.catch((error) =>
        Effect.succeed({
          id: null,
          error: `Could not open the Linear agent session: ${linearFailureDetail(error)}`,
        }),
      ),
    );
    if (created.id === null) return { task: t, error: created.error };
    const opened = yield* saveTask({
      ...t,
      linearSession: { id: created.id, origin: "created" },
    });
    yield* sessionUpdate(opened, "picked-up", {
      type: "thought",
      body: "Picked up by a team in T3 Code.",
    });
    yield* sessionUpdate(opened, "sync", { type: "syncTask", taskId: opened.id });
    return { task: opened, error: null };
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
    yield* changed;
    const opened = yield* openSession(t);
    const team = yield* prepareTeam(p, opened.task).pipe(
      Effect.catch((error) =>
        saveTask({ ...opened.task, status: "blocked", error: wrap(error).detail }),
      ),
    );
    // Preparing clears the task's error; a session that could not be opened stays said.
    return opened.error
      ? yield* saveTask({
          ...team,
          error: [team.error, opened.error].filter(Boolean).join(" "),
        })
      : team;
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
   * The person gives an issue to the next team from the board. It goes ahead
   * of the loop's own picks and runs while the loop is paused. Its team leader
   * takes it or asks; it does not decline it.
   */
  const dispatchIssue = Effect.fn("Assistant.dispatchIssue")(function* (
    p: AwaitedProject,
    reference: string,
    note: string,
    linearSession?: AssistantTask["linearSession"],
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
      // Carried from the start, so a team started below speaks in it and opens none.
      ...(linearSession ? { linearSession } : {}),
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
  /**
   * A person delegated an issue to the T3 Code app in Linear. The assistant whose
   * Linear project holds it dispatches it, as from the board, with the delegated
   * session as its team's; null leaves it to a plain delegated thread. A retried
   * delivery finds the task it already made, so it dispatches once.
   */
  const delegated = Effect.fn("Assistant.delegated")(
    function* (input: TeamDispatchInput) {
      const issue = yield* linear.getIssue({ reference: input.issueId });
      if (!issue.project) return null;
      const rows = yield* sql<ProjectRow>`SELECT * FROM assistant_projects ORDER BY rowid`;
      const matches: AwaitedProject[] = [];
      for (const row of rows) {
        const config = yield* decodeConfig(row.config);
        if (config.linearProjectId === issue.project.id) matches.push({ ...row, config });
      }
      // Two T3 projects on one Linear project: the one that is not stopped takes it.
      const p = matches.find((match) => match.status !== "stopped") ?? matches[0];
      if (!p) return null;
      const session = { id: input.sessionId, origin: "delegated" as const };
      let t = yield* dispatchIssue(p, issue.id, input.note, session);
      const say = (key: string, content: OutboxContent) =>
        outbox.enqueue(`${t.id}:${key}:${input.deliveryId}`, input.sessionId, content);
      if (t.linearSession && t.linearSession.id !== input.sessionId) {
        // The team speaks in its own session; this one only points there.
        yield* say("elsewhere", {
          type: "response",
          body:
            t.status === "queued"
              ? "This issue is already queued in T3 Code. Follow its session on this issue."
              : "A team is already working on this issue in T3 Code. Follow its session on this issue.",
        });
        return { taskId: t.id, queuedBehind: 0, attached: false };
      }
      if (!t.linearSession) {
        // Queued or held before the delegation, without a session of its own.
        t = yield* saveTask({ ...t, linearSession: session });
        if (assistantTaskHoldsProject(t.status)) yield* openSession(t);
      }
      if (t.status !== "queued") return { taskId: t.id, queuedBehind: 0, attached: true };
      // What starts before it, the way advance picks: earlier dispatched issues
      // first, and every team when the project is at its limit.
      const current = yield* project(p.project_id);
      const held = (yield* heldTasks(p.project_id)).length;
      const earlier = yield* sql<{
        n: number;
      }>`SELECT COUNT(*) AS n FROM assistant_tasks WHERE project_id = ${p.project_id} AND status = 'queued' AND rowid < (SELECT rowid FROM assistant_tasks WHERE id = ${t.id})`;
      const queuedBehind =
        (held >= assistantParallelIssues(current.config) ? held : 0) + (earlier[0]?.n ?? 0);
      yield* say("queued", {
        type: "thought",
        body:
          current.status === "stopped"
            ? "Queued in T3 Code. The developer assistant is stopped, so a team starts it once the assistant is started again."
            : (yield* limited(current))
              ? `Queued in T3 Code. The project waits for a usage limit to reset (${current.limited_until}); a team starts it after that.`
              : queuedBehind > 0
                ? `Queued behind ${queuedBehind} ${queuedBehind === 1 ? "issue" : "issues"} in T3 Code. A team starts it as soon as one is free.`
                : "Queued in T3 Code. A team starts it as soon as one is free.",
      });
      return { taskId: t.id, queuedBehind, attached: true };
    },
    lock.withPermits(1),
    // Its detail is what the person reads in the session.
    Effect.mapError(
      (error) => new LinearOperationError({ operation: "delegation", detail: wrap(error).detail }),
    ),
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
    function* (
      caller: ThreadId,
      brief: string,
      criteria: ReadonlyArray<string>,
      e2e: {
        readonly depth: AssistantE2eDepth;
        readonly brief: string;
        readonly reason?: string | undefined;
        readonly smokeCriteria?: ReadonlyArray<number> | undefined;
        readonly targetIds?: ReadonlyArray<string> | undefined;
      },
    ) {
      const { p, t } = yield* authorizeRole(caller, "lead");
      if (t.turns > 0)
        return yield* fail(
          "The team already took this issue. Direct the worker with assistant_message_worker.",
        );
      const listed = criteria.map((criterion) => criterion.trim()).filter(Boolean);
      if (!listed.length || listed.length > 12)
        return yield* fail(
          "List 1 to 12 acceptance criteria, each one a check a person could perform on the product. T3 gives them to the worker, the reviewer and the tester.",
        );
      const testBrief = e2e.brief.trim();
      if (!testBrief && e2e.depth !== "none")
        return yield* fail(
          "Give the e2e plan a brief for the tester: the pages or endpoints affected, the data it needs and what to clean up. T3 starts the tester with it once the change is ready to test.",
        );
      const reason = e2e.reason?.trim() ?? "";
      if (e2e.depth === "none" && !reason)
        return yield* fail(
          "Give a reason for e2e depth none: what makes this change one no user sees or does anything with. When in doubt, plan a full test.",
        );
      if (e2e.depth === "smoke") {
        const error = smokeCriteriaError(e2e.smokeCriteria ?? [], listed.length);
        if (error) return yield* fail(error);
      }
      const targetIds = (e2e.targetIds ?? []).map((id) => id.trim()).filter(Boolean);
      if (yield* taskDecisionsPending(t))
        return yield* fail("Wait for the answer to your open question before taking the issue.");
      const worktree = yield* taskWorktree(t);
      if (!worktree) return yield* fail("The issue's worktree could not be found.");
      yield* asAssistant(linearThreads.moveToStarted(t.issue));
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
        criteria: listed,
        e2ePlan: {
          brief: testBrief,
          ...(targetIds.length ? { targetIds } : {}),
          depth: e2e.depth,
          depthSetBy: "lead",
          ...(e2e.depth === "none" ? { reason } : {}),
          ...(e2e.depth === "smoke"
            ? { smokeCriteria: [...(e2e.smokeCriteria ?? [])].toSorted((a, b) => a - b) }
            : {}),
        },
        turns: 1,
        stage: "implement",
        status: "working",
        error: null,
      };
      const notes = yield* openProjectNotes(sql, p.project_id);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* saveTask(taken);
          yield* queueMessage(
            t.projectId,
            t.threadId,
            `${t.id}:turn:1`,
            withRoleSkill(p.config, "implement", workerInstructions(p.config, taken, notes)),
          );
        }),
      );
      // Not ephemeral: this is where the person sees the scope the team took on.
      yield* sessionUpdate(taken, "taken", {
        type: "thought",
        body: `Taking this issue. Acceptance criteria:\n\n${listed.map((criterion, i) => `${i + 1}. ${criterion}`).join("\n")}`,
      });
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
      yield* sessionUpdate(updated, "declined", {
        type: "response",
        body:
          reason.length > 300
            ? `Not taken: ${reason.slice(0, 300)}… The full reason is in the comment on this issue.`
            : `Not taken: ${reason}`,
      });
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
    role: AssistantThreadRole = "implement",
  ) {
    const { t } = yield* authorizeLead(caller);
    const threadId = assistantTaskThreadId(t, role);
    const detail = yield* snapshots.getThreadDetailById(threadId);
    // Queued messages are not in the conversation until their turn starts.
    const queued = yield* sql<{
      text: string;
      created_at: string;
    }>`SELECT text, created_at FROM assistant_messages WHERE thread_id = ${threadId} AND delivered = 0 ORDER BY rowid`;
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
      queued: queued.map((m) => ({ queuedAt: m.created_at, preview: m.text.slice(0, 300) })),
    };
  }, Effect.mapError(wrap));

  const messageWorker = Effect.fn("Assistant.messageWorker")(
    function* (caller: ThreadId, message: string, role: AssistantThreadRole = "implement") {
      const { p, t } = yield* authorizeLead(caller);
      if (p.status === "stopped") return yield* fail("The assistant is stopped.");
      if (!assistantTaskHoldsProject(t.status))
        return yield* fail(
          "Only the active issue's threads can receive follow-up work. An issue sent back from review goes to a new team.",
        );
      if (role === "lead") return yield* fail("Message the issue's other threads.");
      if (role === "implement" && t.turns === 0)
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
          "The issue has an unanswered decision or permission request. Wait for the person's answer.",
        );
      yield* releaseHandedOff(t);
      if (yield* taskBusy(t, caller))
        return yield* fail(
          "One of the issue's threads is still running. End your turn and wait for its result.",
        );
      // Nothing is sent twice, and a leader that could not see the queued
      // message must hear that it is there rather than a silent success.
      const queued = yield* sql<{
        thread_id: string;
      }>`SELECT thread_id FROM assistant_messages WHERE delivered = 0 AND thread_id != ${caller} AND thread_id IN (${assistantTaskThreadId(t, "implement")}, ${assistantTaskThreadId(t, "review")}, ${assistantTaskThreadId(t, "e2e")}) ORDER BY rowid LIMIT 1`;
      if (queued[0]) {
        const waiting = ROLES.find((r) => assistantTaskThreadId(t, r) === queued[0]!.thread_id);
        return yield* fail(
          `A message to the ${ROLE_NAMES[waiting ?? "implement"]} is already queued; it starts when the current turn ends.`,
        );
      }
      if (role !== "implement") {
        // Creating the review thread dispatches to the engine, which stays outside SQL transactions.
        // A tester is only messaged once its run started, so it already has its instructions.
        yield* queueRoleTurn(p, t, role, message, (notes) =>
          reviewerInstructions(p.config, t, notes),
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
      const owner = yield* threadTask(caller);
      if (!owner) return yield* fail("Only one of an issue's threads can ask the person.");
      const t = owner.task;
      const p = yield* project(t.projectId);
      if (p.status === "stopped") return yield* fail("The assistant is stopped.");
      const b = yield* board(p.project_id);
      const existing = b.decisions.find(
        (d) => d.threadId === caller && d.answer === null && d.question === question,
      );
      if (existing) return existing;
      if (!assistantTaskHoldsProject(t.status))
        return yield* fail(
          "This issue is no longer active. Explain what is left in your final message; the person schedules follow-up work from the board.",
        );
      const value: AssistantDecision = {
        id: newId(),
        projectId: p.config.projectId,
        threadId: caller,
        taskId: t.id,
        requestId: null,
        kind: "decision",
        question,
        answer: null,
        createdAt: yield* now,
      };
      yield* sql`INSERT INTO assistant_decisions (id, project_id, thread_id, data) VALUES (${value.id}, ${p.project_id}, ${caller}, ${encodeDecision(value)})`;
      // A reply on the session answers it, the same as the inbox.
      const role = LINEAR_ROLES[owner.role];
      yield* sessionUpdate(t, `decision:${value.id}`, {
        type: "elicitation",
        body: `${role[0]!.toUpperCase()}${role.slice(1)} asks:\n\n${question.slice(0, 11_000)}\n\nReply here to answer.`,
      });
      // The inbox shows the question; the answer goes straight to the thread that asked.
      yield* saveTask({ ...t, status: "waiting" });
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
  /** Closes the question in the team's Linear session when the person answered it in T3. */
  const answeredInT3 = (t: AssistantTask, d: AssistantDecision, text: string) =>
    sessionUpdate(t, `answered:${d.id}`, {
      type: "thought",
      body: `Answered in T3 Code: ${text.slice(0, 500)}`,
    });
  /** Record the person's answer and send it to the thread that asked. */
  const resolveDecision = Effect.fn("Assistant.resolveDecision")(function* (
    d: AssistantDecision,
    text: string,
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
            `The person answered your question.\nQuestion: ${d.question}\nAnswer: ${text}\nContinue within the agreed scope.`,
          );
          yield* saveTask({
            ...t,
            status: "working",
            error: null,
            ...(t.stage && asker ? { stage: asker.role } : {}),
          });
        }
      }),
    );
    yield* changed;
  });

  const answer = Effect.fn("Assistant.answer")(
    function* (input: typeof AssistantAnswerInput.Type) {
      const d = yield* openDecision(input.decisionId);
      if (d) {
        yield* resolveDecision(d, input.answer);
        if (d.taskId) yield* answeredInT3(yield* task(d.taskId), d, input.answer);
      }
      return yield* board(null);
    },
    lock.withPermits(1),
    Effect.mapError(wrap),
  );

  /**
   * A person's reply on a team's Linear session, or its stop button. A reply
   * answers the team's oldest open question, or reaches the team leader as a
   * note, or is kept for a send-back once the work is delivered. Each webhook
   * delivery is applied once; a failure leaves it for Linear delegation to retry.
   */
  const linearReply = Effect.fn("Assistant.linearReply")(
    function* (input: TeamPromptInput) {
      const handled =
        yield* sql`SELECT delivery_id FROM assistant_linear_replies WHERE delivery_id = ${input.deliveryId}`;
      if (handled.length) return;
      const record = sql`INSERT OR IGNORE INTO assistant_linear_replies (delivery_id, task_id, handled_at) VALUES (${input.deliveryId}, ${input.taskId}, ${yield* now})`;
      const rows = yield* sql<TaskRow>`SELECT * FROM assistant_tasks WHERE id = ${input.taskId}`;
      const body = input.body.trim();
      const stop = input.signal === "stop";
      if (!rows[0] || (!body && !stop)) return yield* record;
      const t = yield* decodeTask(rows[0].data);
      const reply = (text: string) =>
        outbox.enqueue(`${t.id}:linear-reply:${input.deliveryId}`, input.sessionId, {
          type: "thought",
          body: text,
        });
      if (stop && assistantTaskHoldsProject(t.status)) {
        // Like the board's interrupt, for this issue alone. Interrupting twice
        // is harmless, so a retry after a failure below repeats it.
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
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* record;
            // Re-read: the interrupts above are awaited. The blocked hook in
            // saveTask sends the session its error.
            const current = yield* task(t.id);
            if (current.status === "blocked") yield* reply(STOPPED_FROM_LINEAR);
            yield* saveTask({ ...current, status: "blocked", error: STOPPED_FROM_LINEAR });
          }),
        );
        return;
      }
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* record;
          if (!stop && assistantTaskHoldsProject(t.status)) {
            const ids = taskThreadIds(t);
            const open = yield* sql<{
              data: string;
            }>`SELECT data FROM assistant_decisions WHERE resolved = 0 AND thread_id IN (${ids[0]}, ${ids[1]}, ${ids[2]}, ${ids[3]}) ORDER BY rowid`;
            const decisions = yield* Effect.forEach(open, (row) => decodeDecision(row.data));
            const roleOf = (threadId: ThreadId) =>
              threadTask(threadId).pipe(
                Effect.map((owner) => (owner ? LINEAR_ROLES[owner.role] : "team")),
              );
            const questions = decisions.filter((d) => d.kind === "decision");
            if (questions[0]) {
              yield* resolveDecision(questions[0], body);
              const next = questions[1];
              return yield* reply(
                `Answer sent to the ${yield* roleOf(questions[0].threadId)}.${next ? `\n\nStill open: ${firstLine(next.question)}` : ""}`,
              );
            }
            if (decisions[0])
              return yield* reply(
                `A ${yield* roleOf(decisions[0].threadId)} thread is waiting on a permission or input request, which can only be answered in T3 Code.`,
              );
            yield* queueMessage(
              t.projectId,
              assistantTaskThreadId(t, "lead"),
              `${t.id}:lead:linear:${input.deliveryId}`,
              `The person wrote on the Linear issue:\n${body}\nTake it into account; ask with assistant_ask_decision if it changes the agreed scope.`,
            );
            yield* changed;
            return yield* reply("Passed to the team leader.");
          }
          if (t.status === "queued") {
            if (stop) {
              // Like the board's skip; no thread exists yet to interrupt.
              yield* saveTask({ ...t, status: "skipped" });
              return yield* outbox.enqueue(
                `${t.id}:linear-reply:${input.deliveryId}`,
                input.sessionId,
                { type: "response", body: "Removed from the queue." },
              );
            }
            // The brief is the dispatch note the team leader starts with.
            yield* saveTask({ ...t, brief: [t.brief.trim(), body].filter(Boolean).join("\n\n") });
            return yield* reply("Queued. The team leader gets this note when the team starts.");
          }
          if (!stop && t.status === "review") {
            const p = yield* project(t.projectId);
            yield* saveTask({ ...t, feedback: withSessionNote(t.feedback, body) });
            // Any state other than the delivered one sends it back; see syncLinearReviews.
            const accepted = p.config.acceptedState.trim() || "a completed state";
            return yield* reply(
              deliveredState(t, p.config) === null
                ? `Noted for a send-back. Send the issue back from the developer assistant board in T3 Code, or move it to ${accepted} to accept it.`
                : `Noted for a send-back. Move the issue back to In Progress to send it to a new team, or move it to ${accepted} to accept it.`,
            );
          }
          yield* reply(
            `This team is finished (${t.status === "changes-requested" ? "sent back for changes" : t.status}), so it cannot act on this. Use the developer assistant board in T3 Code for this issue.`,
          );
        }),
      );
    },
    lock.withPermits(1),
    deliveryLock.withPermits(1),
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
  }, asAssistant);

  /**
   * The project's check command, in the worker's worktree. It is the repository's
   * own suite, so it runs outside the assistant lock and only one run per issue
   * is allowed: a second request would run it twice in the same worktree.
   */
  const runProjectCheck = Effect.fn("Assistant.runProjectCheck")(function* (
    t: AssistantTask,
    worktreePath: string,
    command: string,
    commit: string,
  ) {
    if (checking.has(t.id))
      return yield* fail("The project's check command is still running for your earlier request.");
    checking.add(t.id);
    const result = yield* verifier
      .runCheck({ worktreePath, command })
      .pipe(Effect.ensuring(Effect.sync(() => checking.delete(t.id))));
    return { command, commit, exitCode: result.exitCode, output: result.output, at: yield* now };
  });
  const requestReview = Effect.fn("Assistant.requestReview")(function* (
    caller: ThreadId,
    message: string,
    input: {
      readonly testNotes?: string | undefined;
      readonly planChanged?: boolean | undefined;
    } = {},
  ) {
    const { p, t } = yield* authorizeRole(caller, "implement");
    const notes = input.testNotes?.trim() ?? "";
    // The tester is started with these notes and no leader in between, so a
    // task with a planned e2e test cannot go to review without them.
    if (t.e2ePlan && (!notes || typeof input.planChanged !== "boolean"))
      return yield* fail(
        "Pass testNotes and planChanged with assistant_request_review. testNotes: what the change does now for a user, the pages, endpoints and flows to test, and the data they need. planChanged: true when the work differs from the team leader's brief in a way the e2e test depends on, otherwise false. T3 starts the e2e tester with them.",
      );
    const worker = yield* snapshots.getThreadShellById(t.threadId, { includeArchived: true });
    if (Option.isNone(worker) || !worker.value.worktreePath)
      return yield* fail("The worker's worktree could not be found.");
    // The reviewer approves a commit, so there must be one: this fails on uncommitted work.
    const head = yield* verifier.revision(worker.value.worktreePath);
    const command = p.config.checkCommand?.trim() ?? "";
    const checks = command
      ? yield* runProjectCheck(t, worker.value.worktreePath, command, head)
      : null;
    // The issue may have moved while the checks ran; the state change is made
    // on it as it stands now.
    return yield* Effect.gen(function* () {
      const current = yield* task(t.id);
      if (!assistantTaskHoldsProject(current.status))
        return yield* fail("This issue is no longer active.");
      const recorded = checks ? { ...current, checks } : current;
      if (checks && checks.exitCode !== 0) {
        yield* saveTask(recorded);
        return yield* fail(
          `The project's check command failed (exit ${checks.exitCode}) at ${shortSha(head)}. Fix the checks before requesting review.\n${checks.output}`,
        );
      }
      // New code voids the last approval and anything that was verified with
      // it, including a staging deploy T3 was still watching for the leader.
      const testNotes = notes
        ? { notes, planChanged: input.planChanged === true, commit: head, at: yield* now }
        : null;
      const updated = yield* saveTask({
        ...recorded,
        status: "working",
        stage: "review",
        merge: null,
        deployment: null,
        deployWait: null,
        testNotes,
        error: null,
        // A run still waiting on its engineering checks tested the old code.
        ...(assistantE2ePendingEngineeringChecks(recorded.e2e) ? { e2e: null } : {}),
      });
      yield* queueRoleTurn(
        p,
        updated,
        "review",
        `${checks ? `T3 ran \`${command}\` at ${shortSha(head)}: passed.\n${checks.output.slice(-CHECK_TAIL)}\n\n` : ""}Review request from the implementer:\n${message}${testNotes ? `\n\nTest notes for the e2e tester (plan changed: ${testNotes.planChanged ? "yes" : "no"}):\n${testNotes.notes}` : ""}`,
        (notes) => reviewerInstructions(p.config, updated, notes),
      );
      const pullRequest = yield* taskPullRequest(updated);
      yield* sessionUpdate(updated, `review-requested:${head}:${updated.updatedAt}`, {
        type: "action",
        action: "Requested review",
        parameter:
          pullRequest?.url ??
          (worker.value.branch ? `${worker.value.branch} at ${shortSha(head)}` : shortSha(head)),
        ephemeral: true,
      });
      return updated;
    }).pipe(lock.withPermits(1));
  }, Effect.mapError(wrap));

  const submitReview = Effect.fn("Assistant.submitReview")(
    function* (
      caller: ThreadId,
      verdict: AssistantCodeReview["verdict"],
      findings: string,
      summary: string,
      needsE2e?: boolean,
    ) {
      const { p, t: current } = yield* authorizeRole(caller, "review");
      // A reviewer who sees user-facing changes the planned depth would not
      // test raises it to full, with either verdict.
      const raise =
        needsE2e === true &&
        current.e2ePlan !== undefined &&
        current.stage === "review" &&
        assistantTaskE2eDepth(current) !== "full";
      const t: AssistantTask =
        raise && current.e2ePlan
          ? { ...current, e2ePlan: planAtDepth(current.e2ePlan, "full", "review") }
          : current;
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
      if (raise)
        yield* sessionUpdate(t, `depth-review:${head}:${t.turns}`, {
          type: "thought",
          body: "Reviewer asked for a full e2e test",
        });
      const findingsListed = findingCount(findings);
      yield* sessionUpdate(t, `review:${verdict}:${head}:${t.turns}`, {
        type: "action",
        action: verdict === "approved" ? "Reviewer: approved" : "Reviewer: changes requested",
        parameter: shortSha(head),
        ...(verdict === "changes-requested" && findingsListed
          ? { result: `${findingsListed} finding${findingsListed === 1 ? "" : "s"}` }
          : {}),
      });
      if (verdict === "approved") {
        // In the worktree the e2e check comes before the merge, so the issue
        // goes back to its team leader to start it rather than to the worker.
        if (assistantTaskE2eEnvironment(t) === "worktree") {
          const tested = yield* saveTask({ ...t, codeReview, stage: "lead" });
          // With a planned test T3 starts the tester itself; this reviewer's
          // turn is still running, so it does not count as the team being busy.
          if (tested.e2ePlan) {
            yield* autoStartE2e(p, tested, caller);
            return yield* task(t.id);
          }
          yield* notifyLead(
            tested,
            `Code review approved commit ${shortSha(head)} for ${t.issue.identifier}. Start the e2e check in the worktree with assistant_start_e2e: ${briefAsk(t)}. T3 tells the worker to merge once it passes.`,
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
          stage: "lead",
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
      const noE2e = assistantTaskE2eDepth(t) === "none";
      if (
        worktreeE2e &&
        !noE2e &&
        (!t.e2e ||
          t.e2e.verdict === "failed" ||
          t.e2e.commit !== head ||
          assistantE2ePendingEngineeringChecks(t.e2e) > 0)
      )
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
      const merged = yield* saveTask({ ...t, merge, summary, stage: "lead", error: null });
      // With a session the merge is one line in it rather than a comment.
      if (merged.linearSession) {
        yield* sessionUpdate(merged, `merged:${head}`, {
          type: "action",
          action: `Merged into ${p.config.baseBranch}`,
          parameter: shortSha(head),
        });
        return merged;
      }
      // The team leader hears when this thread's turn ends.
      return yield* saveTask(
        yield* postLinear(
          merged,
          mergedComment({
            merge,
            review,
            pullRequest,
            baseBranch: p.config.baseBranch,
            e2e: worktreeE2e && !noE2e ? (t.e2e ?? null) : null,
            noE2e,
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
   * deploy that follows their merge. An issue planned with no e2e test is
   * delivered with a null result once staging verifies it.
   */
  const finishDelivery = Effect.fn("Assistant.finishDelivery")(function* (
    p: AwaitedProject,
    value: AssistantTask,
    e2e: AssistantE2eResult | null,
  ) {
    const deployment = value.deployment;
    if (!deployment) return value;
    const pullRequest = yield* taskPullRequest(value);
    const noTestReason = value.e2ePlan?.reason?.trim() || "nothing a user sees changed";
    // The card stays a comment even with a session: a finished session is one
    // collapsed row on the issue page, and the person reads the card there.
    const card = e2e
      ? e2eComment({
          e2e,
          merge: value.merge ?? null,
          deployment,
          pullRequest,
          acceptedState: p.config.acceptedState,
          criteria: value.criteria ?? null,
          smoke: assistantTaskE2eDepth(value) === "smoke",
        })
      : noE2eComment({
          reason: noTestReason,
          decidedBy: value.e2ePlan?.depthSetBy,
          merge: value.merge ?? null,
          deployment,
          pullRequest,
          acceptedState: p.config.acceptedState,
        });
    let updated = yield* postLinear(value, card);
    const cardPosted =
      (updated.linearCommentIds ?? []).length > (value.linearCommentIds ?? []).length;
    updated = yield* updateDescription(updated, p, e2e);
    const linearError = yield* changeLinearState(updated, p.config.reviewState).pipe(
      Effect.as(null),
      Effect.catch((error) => Effect.succeed(wrap(error).detail)),
    );
    updated = {
      ...updated,
      status: "review",
      summary: updated.merge?.summary ?? updated.summary,
      reviewInstructions: e2e
        ? [
            ...e2e.humanChecks.map((check, i) => `${i + 1}. ${check}`),
            e2e.worthALook?.length
              ? `Worth a look:\n${e2e.worthALook.map((note) => `- ${note}`).join("\n")}`
              : null,
            e2e.report,
          ]
            .filter(Boolean)
            .join("\n\n")
        : value.e2ePlan?.depthSetBy === "person"
          ? "No e2e test ran: the person set the depth to none on the board."
          : `No e2e test ran. The team leader decided none was needed: ${noTestReason}`,
      // Without a successful move there is no delivered state to be moved away from.
      deliveredState: linearError ? null : p.config.reviewState.trim() || null,
      error: [updated.error, linearError].filter(Boolean).join(" ") || null,
    };
    const delivered = yield* saveTask(updated);
    yield* sessionUpdate(delivered, "delivered", {
      type: "response",
      body: `${card.split("\n")[0]}\n\n${cardPosted ? "The result is in the comment on this issue." : "The result could not be posted on this issue; it is on the developer assistant board in T3 Code."}`,
    });
    return delivered;
  });

  /**
   * What a deployment check reads. The scan re-runs the same check for a deploy
   * it watches as the team leader's own call made.
   */
  const deployInput = (
    p: AwaitedProject,
    input: {
      readonly cwd: string;
      readonly worktreePath: string;
      /** The merged commit each deployment must contain. */
      readonly commit: string;
      readonly targetIds: ReadonlyArray<string> | null | undefined;
    },
  ) => ({
    cwd: input.cwd,
    worktreePath: input.worktreePath,
    baseBranch: p.config.baseBranch,
    expectedRevision: input.commit,
    command: p.config.stagingCheckCommand,
    ...(p.config.stagingUrl ? { stagingUrl: p.config.stagingUrl } : {}),
    ...(p.config.deploymentTargets ? { targets: p.config.deploymentTargets } : {}),
    ...(input.targetIds ? { targetIds: input.targetIds } : {}),
  });

  const stagingNote = (t: AssistantTask, deployment: AssistantDeployment) =>
    sessionUpdate(t, `staging:${deployment.revision}`, {
      type: "action",
      action: "Staging verified",
      parameter: shortSha(deployment.revision),
    });
  /**
   * A verified staging deploy: the delivery in worktree mode, where a run in the
   * worktree already proved the change and this deploy is the last gate, and the
   * deployed card in staging mode, where the e2e check comes next. Reached from
   * the team leader's own call and from the scan that watches the deploy for it.
   */
  const stagingVerified = Effect.fn("Assistant.stagingVerified")(function* (
    p: AwaitedProject,
    t: AssistantTask,
    deployment: AssistantDeployment,
  ) {
    yield* terminals.close({ threadId: t.threadId });
    // The deployment is saved first: it guards re-entry, so a retry posts no second card.
    const tested = t.e2e;
    const noE2e = t.e2ePlan !== undefined && assistantTaskE2eDepth(t) === "none";
    if (
      assistantTaskE2eEnvironment(t) === "worktree" &&
      (noE2e || (tested && tested.verdict !== "failed"))
    ) {
      const verified = yield* saveTask({
        ...t,
        deployment,
        error: null,
        wait: null,
        deployWait: null,
      });
      yield* stagingNote(verified, deployment);
      return yield* finishDelivery(p, verified, noE2e ? null : (tested ?? null));
    }
    const next: AssistantTask = { ...t, deployment, error: null, wait: null, deployWait: null };
    // With a session the deploy is one line in it rather than a comment. With
    // no e2e test planned the delivery card follows at once, so neither is posted.
    if (t.linearSession || noE2e) {
      const saved = yield* saveTask(next);
      yield* stagingNote(saved, deployment);
      return saved;
    }
    return yield* saveTask(yield* postLinear(next, deployedComment({ deployment })));
  });

  /**
   * Check the staging deploy of the issue's merge: from the team leader's call,
   * and by T3 itself once the worker's merge turn ends. A deploy still rolling
   * out is watched from the scan. Callers hold the assistant lock.
   */
  const verifyStagingFor = Effect.fn("Assistant.verifyStagingFor")(function* (
    p: AwaitedProject,
    t: AssistantTask,
    targetIds: ReadonlyArray<string> | undefined,
  ) {
    if (t.deployment) return { task: t, outcome: "verified" as const };
    if (!t.merge || t.codeReview?.verdict !== "approved" || t.merge.commit !== t.codeReview.commit)
      return yield* fail(
        "Staging is verified after the implementer merges the approved commit and reports it.",
      );
    // An archived worker still owns its worktree.
    const worker = yield* snapshots.getThreadShellById(t.threadId, { includeArchived: true });
    const root = yield* snapshots.getProjectShellById(t.projectId);
    if (Option.isNone(worker) || Option.isNone(root) || !worker.value.worktreePath)
      return yield* fail("The worker's worktree could not be found.");
    const check = yield* verifier.checkDeploy(
      deployInput(p, {
        cwd: root.value.workspaceRoot,
        worktreePath: worker.value.worktreePath,
        commit: t.merge.commit,
        targetIds,
      }),
    );
    // A deployment that will not arrive by itself is the team leader's call.
    if (check.outcome === "failed")
      return { task: t, outcome: "failed" as const, detail: check.detail };
    // T3 watches the deploy from the scan instead of the leader polling it.
    if (check.outcome === "pending") {
      const watching = yield* saveTask({
        ...t,
        wait: null,
        deployWait: {
          targetIds: targetIds ? [...targetIds] : null,
          commit: t.merge.commit,
          since: yield* now,
          checks: 1,
          detail: check.detail,
        },
      });
      yield* sessionUpdate(watching, `staging-watch:${t.merge.commit}`, {
        type: "action",
        action: "Watching staging deploy",
        parameter: shortSha(t.merge.commit),
        ephemeral: true,
      });
      return { task: watching, outcome: "watching" as const };
    }
    return {
      task: yield* stagingVerified(p, t, check.deployment),
      outcome: "verified" as const,
    };
  });

  const verifyStaging = Effect.fn("Assistant.verifyStaging")(
    function* (caller: ThreadId, targetIds?: ReadonlyArray<string>) {
      const { p, t } = yield* authorizeLead(caller);
      if (p.status === "stopped") return yield* fail("The assistant is stopped.");
      if (!assistantTaskHoldsProject(t.status))
        return yield* fail("This issue is no longer active.");
      if (t.deployment) return { task: t, outcome: "verified" as const };
      if (
        !t.merge ||
        t.codeReview?.verdict !== "approved" ||
        t.merge.commit !== t.codeReview.commit
      )
        return yield* fail(
          "Staging is verified after the implementer merges the approved commit and reports it.",
        );
      if ((yield* taskBusy(t, caller)) || (yield* taskQueued(t, caller)))
        return yield* fail("Wait for the issue's threads to finish before verifying staging.");
      if (yield* taskDecisionsPending(t))
        return yield* fail("Resolve the issue's pending decisions before verifying staging.");
      const result = yield* verifyStagingFor(p, t, targetIds);
      if (result.outcome === "failed") return yield* fail(result.detail);
      // A deploy that verifies at once goes on to the planned test, as the watch does.
      if (
        result.outcome === "verified" &&
        result.task.e2ePlan &&
        result.task.status !== "review" &&
        result.task.stage !== "e2e" &&
        assistantTaskE2eEnvironment(result.task) !== "worktree"
      ) {
        yield* autoStartE2e(p, result.task, caller);
        return { task: yield* task(t.id), outcome: result.outcome };
      }
      return { task: result.task, outcome: result.outcome };
    },
    lock.withPermits(1),
    Effect.mapError(wrap),
  );

  /**
   * Queue the issue's e2e run: from the team leader's call, and by T3 itself
   * with the brief the leader planned on taking the issue. Callers hold the
   * assistant lock and have checked that the team is free to test.
   */
  const startE2eFor = Effect.fn("Assistant.startE2eFor")(function* (
    p: AwaitedProject,
    t: AssistantTask,
    brief: string,
  ) {
    const inWorktree = assistantTaskE2eEnvironment(t) === "worktree";
    // The tester runs the application from the team's worktree, so the run is
    // pinned to the commit the reviewer approved.
    const head = inWorktree ? yield* workerRevision(t) : null;
    if (inWorktree && head !== t.codeReview?.commit)
      return yield* fail(
        `The worktree moved past the approved commit ${t.codeReview?.commit.slice(0, 7) ?? ""}. Commit what changed, push and request review again before the e2e check.`,
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
        ? `New e2e run on commit ${head.slice(0, 7)} in the worktree. Save screenshots and recordings in ${directory}.\n${run}`
        : `New e2e run on the deployment of ${t.deployment!.revision.slice(0, 7)}. Save screenshots and recordings in ${directory}.\n${run}`,
      (notes) => e2eInstructions(p.config, updated, directory, run, notes),
    );
    yield* sessionUpdate(updated, `e2e-started:${updated.updatedAt}`, {
      type: "action",
      action: "E2E test running",
      parameter: inWorktree ? "worktree" : "staging",
      ephemeral: true,
    });
    return updated;
  });

  const startE2e = Effect.fn("Assistant.startE2e")(
    function* (
      caller: ThreadId,
      brief: string,
      options: {
        readonly depth?: "full" | "smoke" | undefined;
        readonly smokeCriteria?: ReadonlyArray<number> | undefined;
      } = {},
    ) {
      const { p, t } = yield* authorizeLead(caller);
      if (p.status === "stopped") return yield* fail("The assistant is stopped.");
      if (!assistantTaskHoldsProject(t.status))
        return yield* fail("Only the active issue can be tested.");
      if (assistantTaskE2eEnvironment(t) === "worktree") {
        if (t.codeReview?.verdict !== "approved")
          return yield* fail("Start e2e after code review approves a commit.");
      } else if (!t.deployment)
        return yield* fail("Verify the staging deployment with assistant_verify_staging first.");
      if (yield* taskDecisionsPending(t))
        return yield* fail("Resolve the issue's pending decisions first.");
      if ((yield* taskBusy(t, caller)) || (yield* taskQueued(t, caller)))
        return yield* fail("Wait for the issue's threads to finish before starting e2e.");
      if (options.depth === "smoke") {
        const error = smokeCriteriaError(options.smokeCriteria ?? [], t.criteria?.length ?? 0);
        if (error) return yield* fail(error);
      }
      // The leader's latest brief and depth are the plan: a later automatic run uses them.
      const briefed: AssistantE2ePlan | undefined = t.e2ePlan
        ? { ...t.e2ePlan, brief }
        : options.depth
          ? { brief }
          : undefined;
      const e2ePlan =
        briefed && options.depth
          ? planAtDepth(briefed, options.depth, "lead", {
              ...(options.smokeCriteria ? { smokeCriteria: options.smokeCriteria } : {}),
            })
          : briefed;
      return yield* startE2eFor(p, e2ePlan ? { ...t, e2ePlan } : t, brief);
    },
    lock.withPermits(1),
    Effect.mapError(wrap),
  );

  /**
   * The change is ready to test: staging verified its merge, or, in the
   * worktree, code review approved it. T3 starts the tester with the brief the
   * team leader planned on taking the issue, unless the implementer reports
   * that the work moved away from that plan or the team is not free to test;
   * then the leader decides. `except` is the thread whose turn is ending.
   * Callers hold the assistant lock.
   */
  const autoStartE2e = Effect.fn("Assistant.autoStartE2e")(function* (
    p: AwaitedProject,
    t: AssistantTask,
    except?: ThreadId,
  ) {
    const plan = t.e2ePlan;
    if (!plan) return;
    const id = t.issue.identifier;
    const inWorktree = assistantTaskE2eEnvironment(t) === "worktree";
    const depth = assistantTaskE2eDepth(t);
    const ready = inWorktree
      ? `Code review approved commit ${shortSha(t.codeReview?.commit ?? "")} for ${id}.`
      : `Staging verified for ${id} at ${shortSha(t.merge?.commit ?? t.deployment?.revision ?? "")}.`;
    const where = inWorktree ? "in the worktree" : "on staging";
    const after = inWorktree ? " T3 tells the worker to merge once it passes." : "";
    // The person choosing no test on the board has already answered what a
    // changed plan would ask the leader.
    if (t.testNotes?.planChanged && !(depth === "none" && plan.depthSetBy === "person"))
      return yield* notifyLead(
        t,
        depth === "none"
          ? `${ready} The implementer reports that the work changed from your plan, so T3 did not go on without an e2e test (you planned none: ${plan.reason ?? "no reason given"}).\nThe implementer's test notes:\n${t.testNotes.notes}\nIf the change now affects what a user sees, start the e2e check ${where} with assistant_start_e2e, a depth and a brief. To keep no test, ask the person with assistant_ask_decision; they can set the depth to none on the board.${after}`
          : `${ready} The implementer reports that the work changed from your plan, so T3 did not start the e2e check ${where}.\nThe implementer's test notes:\n${t.testNotes.notes}\nYour e2e brief from taking the issue:\n${plan.brief}\nStart the e2e check with assistant_start_e2e, with a revised brief or your original one. T3 gives the tester the acceptance criteria and these notes.${after}`,
      );
    if (depth === "none") {
      const reason = plan.reason ?? "nothing a user sees changes";
      if (inWorktree) {
        // No tester runs before the merge: the approved commit goes straight to the worker.
        const commit = t.codeReview?.commit ?? "";
        yield* saveTask({ ...t, stage: "implement", status: "working", error: null, wait: null });
        yield* queueMessage(
          p.project_id,
          t.threadId,
          `${t.id}:no-e2e-merge:${newId()}`,
          `Code review approved commit ${commit}. No e2e test is planned for this issue (${plan.depthSetBy === "person" ? "the person set the depth to none on the board" : `reason: ${reason}`}). Merge the PR into ${p.config.baseBranch} with a merge commit once its required checks pass, then call assistant_report_merged. If anything changes before the merge, push and request review again.`,
        );
        return;
      }
      if (!t.deployment) return;
      const delivered = yield* finishDelivery(p, t, null);
      // A thread whose turn is ending closes the team when it ends; otherwise nothing will.
      if (except === undefined && delivered.status === "review" && !(yield* taskBusy(delivered)))
        yield* closeTeam(delivered);
      return;
    }
    // A reviewer or the person raised the depth of an issue planned with no
    // test, so there is no brief for the tester yet.
    if (!plan.brief.trim()) {
      const who = DEPTH_SETTERS[plan.depthSetBy ?? "lead"];
      return yield* notifyLead(
        t,
        `${ready} ${who} set the e2e test to ${depth}${depth === "smoke" && plan.smokeCriteria?.length ? ` (criteria ${plan.smokeCriteria.join(", ")})` : ""}, and the plan has no brief for the tester, so T3 did not start it. Start the e2e check ${where} with assistant_start_e2e and a brief: the pages or endpoints affected, the data it needs and what to clean up. T3 gives the tester the acceptance criteria and the implementer's test notes.${after}`,
      );
    }
    const reason = (yield* taskDecisionsPending(t))
      ? "the issue has a question open for the person"
      : (yield* taskBusy(t, except)) || (yield* taskQueued(t, except))
        ? "another of the issue's threads is still running or has work queued"
        : null;
    const handBack = (why: string) =>
      notifyLead(
        t,
        `${ready} T3 did not start the e2e check ${where} because ${why}. Start it with assistant_start_e2e once the team is free, with the brief you planned or a revised one:\n${plan.brief}${after}`,
      );
    if (reason) return yield* handBack(reason);
    yield* startE2eFor(p, t, plan.brief).pipe(
      Effect.catch((error) => handBack(`it could not be started: ${wrap(error).detail}`)),
    );
  });

  /**
   * A passed or partial run in the worktree: the worker merges the commit that
   * was tested. From the tester's result, or from the team leader settling the
   * run's engineering checks.
   */
  const mergeAfterE2e = Effect.fn("Assistant.mergeAfterE2e")(function* (
    p: AwaitedProject,
    t: AssistantTask,
    e2e: AssistantE2eResult,
  ) {
    const passed = yield* saveTask({ ...t, e2e, stage: "implement", error: null, wait: null });
    yield* queueMessage(
      p.project_id,
      t.threadId,
      `${t.id}:e2e-passed:${newId()}`,
      `The e2e check ${e2e.verdict === "partial" ? "passed (with checks left for the person)" : "passed"} on commit ${shortSha(e2e.commit ?? "")} in the worktree. Merge the PR into ${p.config.baseBranch} with a merge commit once its required checks pass, then call assistant_report_merged. If anything changes before the merge, push and request review again.`,
    );
    return passed;
  });

  /**
   * A passed or partial run with engineering checks does not deliver (or, in
   * the worktree, merge): the issue goes to the team leader, which hears the
   * checks when the tester's turn ends and settles them before assistant_deliver.
   */
  const holdForEngineering = Effect.fn("Assistant.holdForEngineering")(function* (
    t: AssistantTask,
    e2e: AssistantE2eResult,
  ) {
    const held = yield* saveTask({ ...t, e2e, stage: "lead", error: null, wait: null });
    const count = e2e.engineeringChecks?.length ?? 0;
    yield* sessionUpdate(held, `e2e-engineering:${e2e.at}`, {
      type: "thought",
      body: `E2E test passed. The team is confirming ${count === 1 ? "1 engineering check" : `${count} engineering checks`} before ${e2e.environment === "worktree" ? "the merge" : "delivery"}.`,
    });
    return held;
  });

  const submitE2e = Effect.fn("Assistant.submitE2e")(
    function* (
      caller: ThreadId,
      input: {
        readonly verdict?: AssistantE2eResult["verdict"] | undefined;
        readonly report: string;
        readonly humanChecks: ReadonlyArray<string>;
        /** What only an engineer can check; on a pass they hold the delivery for the team leader. */
        readonly engineeringChecks?: ReadonlyArray<string> | undefined;
        readonly screenshots: ReadonlyArray<{ readonly path: string; readonly caption: string }>;
        /** Recordings of behaviour over time, at most one per criterion. */
        readonly videos?:
          | ReadonlyArray<{ readonly path: string; readonly caption: string }>
          | undefined;
        readonly checks?: ReadonlyArray<AssistantE2eCheck> | undefined;
        /** Notes for the person that are not failures. */
        readonly worthALook?: ReadonlyArray<string> | undefined;
      },
    ) {
      const { p, t } = yield* authorizeRole(caller, "e2e");
      const inWorktree = assistantTaskE2eEnvironment(t) === "worktree";
      if (t.stage !== "e2e" || (!inWorktree && !t.deployment))
        return yield* fail("No e2e run is in progress for this issue.");
      const worthALook = input.worthALook ?? [];
      const videoInputs = input.videos ?? [];
      const engineeringChecks = input.engineeringChecks ?? [];
      if (worthALook.length > 15)
        return yield* fail(
          "List at most 15 items in worthALook; keep the ones the person most needs to see.",
        );
      if (worthALook.some((note) => note.length > 400))
        return yield* fail(
          "Keep each worthALook item to one short line of at most 400 characters; put the detail in report.",
        );
      // With criteria recorded the verdict is theirs to add up; a tester's own
      // verdict is not read. Issues taken before them keep the free-text path.
      const criteria = t.criteria ?? [];
      const reported = criteria.length ? (input.checks ?? []) : null;
      // A smoke test covers only the criteria its plan lists; T3 records the rest.
      const smoke =
        criteria.length && assistantTaskE2eDepth(t) === "smoke"
          ? new Set(t.e2ePlan?.smokeCriteria ?? [])
          : null;
      const required = (criterion: number) => smoke === null || smoke.has(criterion);
      if (reported && !reported.length)
        return yield* fail(
          smoke
            ? `List one check per criterion in the smoke test (${[...smoke].join(", ")}) in checks.`
            : "List one check per acceptance criterion in checks.",
        );
      if (reported?.some((check) => check.result === "skipped"))
        return yield* fail(
          "Do not report a criterion as skipped: T3 records skipped itself for the criteria outside a smoke test. Report passed, failed or not-checked for each criterion you were asked to check.",
        );
      let checks: ReadonlyArray<AssistantE2eCheck> | null = reported;
      if (reported) {
        const missing = criteria.flatMap((_, index) =>
          !required(index + 1) || reported.some((check) => check.criterion === index + 1)
            ? []
            : [index + 1],
        );
        const repeated = criteria.flatMap((_, index) =>
          reported.filter((check) => check.criterion === index + 1).length > 1 ? [index + 1] : [],
        );
        const unknown = [
          ...new Set(
            reported.flatMap((check) =>
              check.criterion > criteria.length ? [check.criterion] : [],
            ),
          ),
        ];
        if (missing.length || repeated.length || unknown.length)
          return yield* fail(
            [
              smoke
                ? `This smoke test covers criteria ${[...smoke].join(", ")}; list one check for each, in order.`
                : `This issue has ${criteria.length} acceptance criteria; list one check for each, in order.`,
              missing.length ? `No check for ${missing.join(", ")}.` : "",
              repeated.length ? `More than one check for ${repeated.join(", ")}.` : "",
              unknown.length ? `No such criterion: ${unknown.join(", ")}.` : "",
            ]
              .filter(Boolean)
              .join(" "),
          );
        const stray = reported.find(
          (check) => check.screenshot !== undefined && check.screenshot > input.screenshots.length,
        );
        if (stray)
          return yield* fail(
            `Criterion ${stray.criterion} points at screenshot ${stray.screenshot}, and you attached ${input.screenshots.length}. Number each screenshot by its position in screenshots.`,
          );
        const strayVideo = reported.find(
          (check) => check.video !== undefined && check.video > videoInputs.length,
        );
        if (strayVideo)
          return yield* fail(
            `Criterion ${strayVideo.criterion} points at video ${strayVideo.video}, and you attached ${videoInputs.length}. Number each video by its position in videos.`,
          );
        if (
          reported.some((check) => check.result === "not-checked") &&
          !input.humanChecks.length &&
          !engineeringChecks.length
        )
          return yield* fail(
            "Each criterion you could not check needs an entry in humanChecks saying what a person should do in the product, or in engineeringChecks when only an engineer can check it.",
          );
        if (smoke)
          checks = criteria.map(
            (_, index): AssistantE2eCheck =>
              reported.find((check) => check.criterion === index + 1) ?? {
                criterion: index + 1,
                result: "skipped",
                evidence: "Not in the smoke test",
              },
          );
      }
      if (!checks && !input.verdict)
        return yield* fail("Give a verdict: this issue has no recorded criteria.");
      const verdict = checks ? assistantE2eVerdict(checks) : input.verdict!;
      if (verdict === "partial" && !input.humanChecks.length && !engineeringChecks.length)
        return yield* fail(
          "A partial result lists what a person should check in humanChecks, or what only an engineer can check in engineeringChecks.",
        );
      // The result covers the commit the reviewer approved; the merge is of it.
      const head = inWorktree ? yield* workerRevision(t) : null;
      if (inWorktree && head !== t.codeReview?.commit)
        return yield* fail(
          `The worktree moved past the tested commit ${t.codeReview?.commit.slice(0, 7) ?? ""}. Commit what changed, push and request review again.`,
        );
      // Every file is read before any upload, so a bad path uploads nothing.
      const readAll = (
        attached: ReadonlyArray<{ readonly path: string; readonly caption: string }>,
        kind: EvidenceKind,
      ) =>
        Effect.forEach(attached, (item) =>
          evidence.read(t.id, item.path, kind).pipe(Effect.map((file) => ({ file, item }))),
        );
      const images = yield* readAll(input.screenshots, "screenshot");
      const clips = yield* readAll(videoInputs, "video");
      const upload = (files: typeof images) =>
        Effect.forEach(files, ({ file, item }) =>
          asAssistant(linear.uploadFile(file)).pipe(
            Effect.map(({ url }) => ({ url, caption: item.caption, path: file.path })),
            Effect.mapError((error) =>
              fail(`Could not upload ${file.fileName} to Linear: ${linearFailureDetail(error)}`),
            ),
          ),
        );
      const screenshots = yield* upload(images);
      const videos = yield* upload(clips);
      const e2e: AssistantE2eResult = {
        verdict,
        report: input.report,
        ...(checks ? { checks } : {}),
        humanChecks: input.humanChecks,
        ...(engineeringChecks.length ? { engineeringChecks } : {}),
        ...(worthALook.length ? { worthALook } : {}),
        screenshots,
        ...(videos.length ? { videos } : {}),
        at: yield* now,
        environment: inWorktree ? "worktree" : "staging",
        ...(head ? { commit: head } : {}),
      };
      // A run in the worktree happens before the merge: nothing is on the issue
      // yet, and a pass tells the worker to merge the commit that was tested.
      if (inWorktree) {
        if (verdict === "failed") {
          // The team leader hears when this turn ends.
          const failed = yield* saveTask({ ...t, e2e, stage: "lead" });
          yield* sessionUpdate(failed, `e2e-failed:${e2e.at}`, {
            type: "thought",
            body: e2eFailureNote(t, e2e),
          });
          return failed;
        }
        if (assistantE2ePendingEngineeringChecks(e2e)) return yield* holdForEngineering(t, e2e);
        return yield* mergeAfterE2e(p, t, e2e);
      }
      // The stage leaving e2e is what stops a second run reporting again, so it
      // is saved before the comment: a retry after a failure here posts no
      // second card on the issue.
      const updated = yield* saveTask({ ...t, e2e, stage: "lead", error: null });
      if (verdict === "failed") {
        yield* sessionUpdate(updated, `e2e-failed:${e2e.at}`, {
          type: "thought",
          body: e2eFailureNote(t, e2e),
        });
        const pullRequest = yield* taskPullRequest(t);
        return yield* saveTask(
          yield* postLinear(
            updated,
            e2eComment({
              e2e,
              merge: t.merge ?? null,
              deployment: t.deployment!,
              pullRequest,
              acceptedState: p.config.acceptedState,
              criteria: t.criteria ?? null,
              smoke: assistantTaskE2eDepth(t) === "smoke",
            }),
          ),
        );
      }
      if (assistantE2ePendingEngineeringChecks(e2e)) return yield* holdForEngineering(updated, e2e);
      // The team is closed when this turn ends, and the loop moves on.
      return yield* finishDelivery(p, updated, e2e);
    },
    lock.withPermits(1),
    Effect.mapError(wrap),
  );

  /**
   * The team leader settled the engineering checks of a passed or partial run:
   * the issue goes on as the run would have taken it without them, delivered
   * with the stored result on staging, or merged in the worktree. What was
   * settled goes on the result, and on the Linear card with the tester's report.
   */
  const deliverChecked = Effect.fn("Assistant.deliverChecked")(
    function* (caller: ThreadId, settled: string) {
      const { p, t } = yield* authorizeLead(caller);
      if (p.status === "stopped") return yield* fail("The assistant is stopped.");
      if (!assistantTaskHoldsProject(t.status))
        return yield* fail("This issue is no longer active.");
      const e2e = t.e2e;
      if (!e2e || !assistantE2ePendingEngineeringChecks(e2e))
        return yield* fail(
          "No engineering checks are waiting to be settled on this issue. assistant_deliver is only for an e2e run whose tester listed engineeringChecks; T3 moves every other passed run on by itself.",
        );
      if (t.stage !== "lead")
        return yield* fail(
          `The issue is with the ${ROLE_NAMES[t.stage ?? "implement"]}. Wait for its turn to end before delivering.`,
        );
      const text = settled.trim();
      if (!text)
        return yield* fail(
          "Say how each engineering check was settled: what was checked and what it showed.",
        );
      if (yield* taskDecisionsPending(t))
        return yield* fail("Resolve the issue's pending decisions before delivering.");
      if ((yield* taskBusy(t, caller)) || (yield* taskQueued(t, caller)))
        return yield* fail("Wait for the issue's threads to finish before delivering.");
      const record: AssistantE2eResult = { ...e2e, engineeringSettled: text };
      if (assistantTaskE2eEnvironment(t) === "worktree") {
        // The merge must be of the commit the run tested.
        const head = yield* workerRevision(t);
        if (head !== e2e.commit)
          return yield* fail(
            `The worktree moved past the tested commit ${shortSha(e2e.commit ?? "")}. A change needs code review and a new e2e run: send it to the worker with assistant_message_worker.`,
          );
        return yield* mergeAfterE2e(p, t, record);
      }
      if (!t.deployment)
        return yield* fail(
          "Staging is not verified for this issue, so there is nothing to deliver.",
        );
      // The team is closed when this turn ends, and the loop moves on.
      return yield* finishDelivery(p, yield* saveTask({ ...t, e2e: record, error: null }), record);
    },
    lock.withPermits(1),
    Effect.mapError(wrap),
  );

  /**
   * The person changes how deep an issue's e2e test goes, from the board, until
   * the test starts. An issue already waiting for the step after its review or
   * staging deploy goes on at the new depth at once, without waking anyone.
   */
  const setE2eDepth = Effect.fn("Assistant.setE2eDepth")(
    function* (input: typeof AssistantSetE2eDepthInput.Type) {
      const t = yield* task(input.taskId);
      const p = yield* project(t.projectId);
      const plan = t.e2ePlan;
      if (!plan) return yield* fail("The team leader plans the test when it takes the issue.");
      if (!assistantTaskHoldsProject(t.status))
        return yield* fail("Only an active issue's e2e test can be changed.");
      if (t.stage === "e2e")
        return yield* fail(
          "The e2e test is already running. Change the depth for a rerun once it reports.",
        );
      if (t.e2e && t.e2e.verdict !== "failed")
        return yield* fail("The e2e test already ran for this issue.");
      const inWorktree = assistantTaskE2eEnvironment(t) === "worktree";
      // In the worktree the test runs before the merge, so once the worker is
      // merging without one there is no test left to run.
      if (
        inWorktree &&
        (t.merge ||
          (assistantTaskE2eDepth(t) === "none" &&
            t.stage === "implement" &&
            t.codeReview?.verdict === "approved"))
      )
        return yield* fail("The approved commit is already being merged without an e2e test.");
      const criteriaCount = t.criteria?.length ?? 0;
      const smokeCriteria =
        input.depth === "smoke"
          ? (input.smokeCriteria ??
            plan.smokeCriteria ??
            Array.from({ length: criteriaCount }, (_, i) => i + 1))
          : undefined;
      if (smokeCriteria) {
        const error = smokeCriteriaError(smokeCriteria, criteriaCount);
        if (error) return yield* fail(error);
      }
      const saved = yield* saveTask({
        ...t,
        e2ePlan: planAtDepth(plan, input.depth, "person", {
          reason: "Set by the person on the board.",
          ...(smokeCriteria ? { smokeCriteria } : {}),
        }),
      });
      yield* sessionUpdate(saved, `depth-person:${saved.updatedAt}`, {
        type: "thought",
        body: `Depth set to ${input.depth} by the person`,
      });
      const ready =
        saved.stage === "lead" &&
        (inWorktree
          ? saved.codeReview?.verdict === "approved" && !saved.merge
          : saved.deployment !== null && !saved.deployWait);
      const waiting = ready && !saved.e2e;
      // After a failed run the leader is deciding; choosing no test decides it,
      // unless the leader already handed the failure on to a thread.
      const failedRunSettled =
        ready &&
        input.depth === "none" &&
        saved.e2e?.verdict === "failed" &&
        !(yield* taskBusy(saved)) &&
        // A notice or nudge waiting for the leader is not work handed on.
        !(yield* taskQueued(saved, assistantTaskThreadId(saved, "lead")));
      // A leader already told the plan changed decides the test itself.
      if (waiting && !(saved.testNotes?.planChanged && input.depth !== "none"))
        yield* autoStartE2e(p, saved);
      // In the worktree the worker merges next; the failed run no longer
      // applies, so it is cleared for the board to show the merge.
      else if (failedRunSettled)
        yield* autoStartE2e(p, inWorktree ? yield* saveTask({ ...saved, e2e: null }) : saved);
      return yield* board(null);
    },
    lock.withPermits(1),
    Effect.mapError(wrap),
  );

  /**
   * Record a fact about the project for later teams. A note that says what an
   * open one already says (ignoring case and whitespace) is not added again;
   * the open one comes back with added false. A project keeps at most 20 open
   * notes, until a setup revision absorbs them or the person deletes some.
   */
  const addNote = Effect.fn("Assistant.addNote")(function* (
    projectId: string,
    text: string,
    author: {
      readonly role: AssistantProjectNote["role"];
      readonly task: AssistantTask | null;
    },
  ) {
    const trimmed = text.trim();
    if (!trimmed) return yield* fail("Write the note: one fact a later team needs.");
    if (trimmed.length > ASSISTANT_PROJECT_NOTES.maxLength)
      return yield* fail(
        `A note is at most ${ASSISTANT_PROJECT_NOTES.maxLength} characters; this one is ${trimmed.length}. Keep it to the one fact a later team needs.`,
      );
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const open = yield* openProjectNotes(sql, projectId);
          const key = projectNoteKey(trimmed);
          const existing = open.find((note) => projectNoteKey(note.text) === key);
          if (existing) return { note: existing, added: false };
          if (open.length >= ASSISTANT_PROJECT_NOTES.maxOpen)
            return yield* fail(
              author.role === "person"
                ? `The project already has ${ASSISTANT_PROJECT_NOTES.maxOpen} notes. Delete one, or revise the setup to fold them into the instructions.`
                : `The project already has ${ASSISTANT_PROJECT_NOTES.maxOpen} notes, the most it keeps. Name this fact in your report or final message instead, so the person can add it to the project setup.`,
            );
          const note: AssistantProjectNote = {
            id: newId(),
            projectId: ProjectId.make(projectId),
            text: trimmed,
            role: author.role,
            taskId: author.task?.id ?? null,
            issueIdentifier: author.task?.issue.identifier ?? null,
            createdAt: yield* now,
          };
          yield* sql`INSERT INTO assistant_project_notes (id, project_id, text, role, task_id, issue_identifier, created_at)
          VALUES (${note.id}, ${projectId}, ${note.text}, ${note.role}, ${note.taskId}, ${note.issueIdentifier}, ${note.createdAt})`;
          return { note, added: true };
        }),
      )
      .pipe(Effect.tap(({ added }) => (added ? changed : Effect.void)));
  });

  /** A team's leader, worker or tester writes down a fact about the project for later teams. */
  const addProjectNoteFromThread = Effect.fn("Assistant.addProjectNoteFromThread")(function* (
    caller: ThreadId,
    text: string,
  ) {
    const owner = yield* threadTask(caller);
    if (!owner || owner.role === "review")
      return yield* fail(
        "Only a team's leader, implementation worker or e2e tester can add a project note.",
      );
    return yield* addNote(owner.task.projectId, text, { role: owner.role, task: owner.task });
  }, Effect.mapError(wrap));

  /** The person adds a project note on the board. */
  const addProjectNote = Effect.fn("Assistant.addProjectNote")(function* (
    input: typeof AssistantAddProjectNoteInput.Type,
  ) {
    const p = yield* project(input.projectId);
    const { added } = yield* addNote(p.project_id, input.text, { role: "person", task: null });
    if (!added) return yield* fail("The project already has this note.");
    return yield* board(null);
  }, Effect.mapError(wrap));

  /** The person deletes a project note; one already gone is not an error. */
  const deleteProjectNote = Effect.fn("Assistant.deleteProjectNote")(function* (
    input: typeof AssistantDeleteProjectNoteInput.Type,
  ) {
    yield* sql`DELETE FROM assistant_project_notes WHERE id = ${input.noteId}`;
    yield* changed;
    return yield* board(null);
  }, Effect.mapError(wrap));

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
          // Replies kept from the Linear session go back with the person's own words.
          feedback:
            input.action === "accept"
              ? input.feedback
              : [input.feedback.trim(), sessionNotes(t.feedback)].filter(Boolean).join("\n\n"),
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
        const skipped = yield* saveTask({ ...t, status: "skipped", feedback: input.feedback });
        yield* sessionUpdate(skipped, "skipped", {
          type: "response",
          body: input.feedback.trim()
            ? `Skipped in T3 Code: ${input.feedback.trim()}`
            : "Skipped in T3 Code.",
        });
      } else {
        if (!assistantTaskHoldsProject(t.status))
          return yield* fail("Only blocked or active work can be retried.");
        const lead = yield* snapshots.getThreadShellById(assistantTaskThreadId(t, "lead"), {
          includeArchived: true,
        });
        // A team whose worktree could not be prepared has no leader to tell yet.
        if (Option.isNone(lead)) {
          yield* prepareTeam(p, t).pipe(
            Effect.catch((error) =>
              saveTask({ ...t, status: "blocked", error: wrap(error).detail }),
            ),
          );
          return yield* board(null);
        }
        // The person looked at the blocker, so the wait budget starts over.
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

  /**
   * A team leader waits for progress outside T3. The wait is counted on its
   * issue, so the issue waits for the person while the loop and the project's
   * other teams carry on.
   */
  const waitForExternal = Effect.fn("Assistant.waitForExternal")(function* (
    caller: ThreadId,
    reason: string,
  ) {
    const { p, t } = yield* authorizeLead(caller);
    if (p.status === "stopped") return yield* fail("The assistant is stopped.");
    if (!assistantTaskHoldsProject(t.status)) return yield* fail("This issue is no longer active.");
    if ((t.wait?.checks ?? 0) >= 15) {
      yield* saveTask({
        ...t,
        status: "blocked",
        wait: null,
        error:
          "External progress has not completed after 15 checks. Inspect the blocker, then retry from the board.",
      });
      return { outcome: "limit" } satisfies AssistantWaitResult;
    }
    const waiting = yield* saveTask({
      ...t,
      wait: { reason: reason.slice(0, 1000), checks: (t.wait?.checks ?? 0) + 1, notified: false },
    });
    yield* sessionUpdate(waiting, `wait:${waiting.wait?.checks}`, {
      type: "thought",
      body: `Waiting: ${reason.slice(0, 1000)}`,
    });
    return { outcome: "waiting" } satisfies AssistantWaitResult;
  }, Effect.mapError(wrap));

  const deliver = Effect.fn("Assistant.deliver")(
    function* () {
      const messages = yield* sql<{
        id: string;
        project_id: string;
        thread_id: string;
        text: string;
        created_at: string;
      }>`SELECT m.* FROM assistant_messages m JOIN assistant_projects p ON p.project_id = m.project_id WHERE m.delivered = 0 AND p.status != 'stopped' ORDER BY m.rowid`;
      const owners = new Map<string, Effect.Success<ReturnType<typeof threadTask>>>();
      for (const m of messages)
        if (!owners.has(m.thread_id)) owners.set(m.thread_id, yield* threadTask(m.thread_id));
      // The threads of an issue share a worktree, so whichever turn starts first
      // holds the others. The handoff to the thread the issue's stage names goes
      // first: a leader notice queued earlier must not hold up a review request.
      const onStage = (threadId: string) => {
        const owner = owners.get(threadId);
        return owner ? owner.task.stage === owner.role : false;
      };
      const ordered = messages.toSorted(
        (a, b) => Number(onStage(b.thread_id)) - Number(onStage(a.thread_id)),
      );
      for (const m of ordered) {
        const threadId = ThreadId.make(m.thread_id);
        const current = yield* snapshots.getThreadShellById(threadId, { includeArchived: true });
        if (Option.isNone(current)) continue;
        const owner = owners.get(m.thread_id) ?? null;
        // A nudge is only right while the issue is still the leader's to move on.
        if (
          m.id.includes(":nudge:") &&
          owner &&
          (owner.task.stage !== "lead" || !assistantTaskHoldsProject(owner.task.status))
        ) {
          yield* sql`UPDATE assistant_messages SET delivered = 1 WHERE id = ${m.id}`;
          continue;
        }
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
          // Team leaders decide; the other threads do the work.
          modelSelection:
            owner?.role === "lead" ? p.config.modelSelection : p.config.workerModelSelection,
          runtimeMode: p.config.runtimeMode,
          interactionMode: "default",
          // The turn starts now; a message that waited in the queue must not
          // make the turn look as long as the wait.
          createdAt: yield* now,
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
    // A leader waiting on something outside T3 — its own assistant_wait, or a
    // staging deploy T3 watches for it — ended its turn for the right reason.
    if (t.status === "blocked" || t.wait || t.deployWait) return;
    const lead = assistantTaskThreadId(t, "lead");
    // Another thread still at work (the worker it just handed to) carries the
    // issue on; its turn ending is what brings the issue back.
    if (yield* taskBusy(t, lead)) return;
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
      assistantTaskEngineeringChecksPending(t)
        ? `You ended your turn with the e2e run's engineering checks unsettled and nothing handed on. Send them to the code reviewer with assistant_message_worker and thread "review", send a defect to the worker, call assistant_deliver once they are settled, or ask the person with assistant_ask_decision.`
        : `You ended your turn with the issue still yours and nothing handed on. Take the next step (${t.dispatched ? "take" : "take or decline"} the issue, verify staging, start e2e, or message a thread), ask the person with assistant_ask_decision, or use assistant_wait while staging deploys.`,
    );
    yield* changed;
  });

  /**
   * The worker's merge turn ended on an issue with a planned e2e test: T3
   * watches the staging deploy itself instead of waking the team leader. The
   * deployment CLIs are slow, so they do not run here, under the assistant lock
   * and inside event handling: the scan's watchDeploy makes the first check and
   * starts the tester once it verifies (in the worktree it delivers the issue).
   */
  const watchAfterMerge = Effect.fn("Assistant.watchAfterMerge")(function* (
    t: AssistantTask,
    merge: NonNullable<AssistantTask["merge"]>,
  ) {
    const watching = yield* saveTask({
      ...t,
      wait: null,
      deployWait: {
        targetIds: t.e2ePlan?.targetIds ? [...t.e2ePlan.targetIds] : null,
        commit: merge.commit,
        since: yield* now,
        checks: 0,
        detail: "Waiting for the first check",
      },
    });
    yield* sessionUpdate(watching, `staging-watch:${merge.commit}`, {
      type: "action",
      action: "Watching staging deploy",
      parameter: shortSha(merge.commit),
      ephemeral: true,
    });
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
      return yield* closeTeam(t);
    }
    // A queued handoff carries the issue on; an open question waits for the person.
    if (
      !assistantTaskHoldsProject(t.status) ||
      (yield* taskQueued(t)) ||
      (yield* taskDecisionsPending(t))
    )
      return;
    if (role === "lead") return t.stage === "lead" ? yield* leadIdle(t) : undefined;
    if (t.stage === role) {
      yield* saveTask({ ...t, stage: "lead" });
      // The leader asked the reviewer to settle a run's engineering checks.
      if (role === "review" && assistantE2ePendingEngineeringChecks(t.e2e))
        return yield* notifyLead(
          t,
          `The code reviewer for ${id} ended its turn on the engineering checks. Read its answer with assistant_read_thread (thread "review"), then call assistant_deliver with how each check was settled, send a defect to the worker with assistant_message_worker, or ask the reviewer again.`,
        );
      return yield* notifyLead(
        t,
        `The ${ROLE_NAMES[role]} for ${id} ended its turn without handing off. Read it with assistant_read_thread (thread "${role}") and decide the next step.`,
      );
    }
    if (t.stage !== "lead") return;
    if (t.status === "blocked")
      return yield* notifyLead(t, `${id} is blocked: ${t.error ?? "see its threads"}`);
    const inWorktree = assistantTaskE2eEnvironment(t) === "worktree";
    if (t.e2e && assistantE2ePendingEngineeringChecks(t.e2e) && role === "e2e")
      return yield* notifyLead(t, engineeringNotice(t, t.e2e));
    if (t.e2e?.verdict === "failed" && role === "e2e")
      return yield* notifyLead(
        t,
        `${id} failed its e2e check ${inWorktree ? "in the worktree" : "on staging"}:\n${t.e2e.report.slice(0, 4000)}\nDecide whether this goes to the worker, back to the tester, or to the person.`,
      );
    if (t.merge && !t.deployment && role === "implement" && t.e2ePlan)
      return yield* watchAfterMerge(t, t.merge);
    if (t.merge && !t.deployment && role === "implement")
      return yield* notifyLead(
        t,
        inWorktree
          ? `${id} was approved in code review and merged into its integration branch at ${shortSha(t.merge.commit)} after the e2e check passed. Verify staging with assistant_verify_staging; T3 then puts the issue in review.`
          : `${id} was approved in code review and merged into its integration branch at ${shortSha(t.merge.commit)}. Verify staging with assistant_verify_staging, then start the e2e check with ${briefAsk(t)}.`,
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
    t: AssistantTask,
    waitMs: number,
  ) {
    const p = yield* project(projectId);
    if (p.status === "stopped" || !assistantTaskHoldsProject(t.status)) return false;
    const until = DateTime.formatIso(
      DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + waitMs),
    );
    // Several threads stop at once; the latest reset time is the one to wait for.
    if (p.limited_until === null || p.limited_until < until)
      yield* sql`UPDATE assistant_projects SET limited_until = ${until} WHERE project_id = ${projectId}`;
    yield* queueMessage(
      projectId,
      threadId,
      `${threadId}:limit:${until}`,
      "A Claude usage limit stopped your previous turn before it finished. The limit has reset: continue where you left off, and hand off as usual when you are done.",
    );
    yield* sessionUpdate(t, `limit:${until}`, {
      type: "thought",
      body: `Paused until ${until.slice(0, 10)} ${until.slice(11, 16)} UTC (usage limit).`,
    });
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
    const owner = yield* threadTask(threadId);
    if (!owner) return;
    const projectId = owner.task.projectId;
    const t = owner.task;
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
        yield* answeredInT3(t, d, event.payload.text);
        if (assistantTaskHoldsProject(t.status))
          yield* saveTask({
            ...t,
            status: "working",
            error: null,
            ...(t.stage ? { stage: owner.role } : {}),
          });
      }
    } else if (event.type === "thread.activity-appended") {
      const a = event.payload.activity;
      if (["user-input.requested", "approval.requested"].includes(a.kind)) {
        const payload = yield* decodeRequest(a.payload);
        const id = `provider:${threadId}:${payload.requestId}`;
        const decision: AssistantDecision = {
          id,
          projectId: ProjectId.make(projectId),
          threadId,
          taskId: t.id,
          requestId: payload.requestId,
          kind: a.kind === "approval.requested" ? "approval" : "user-input",
          question: a.summary,
          answer: null,
          createdAt: yield* now,
        };
        yield* sql`INSERT OR IGNORE INTO assistant_decisions (id, project_id, thread_id, request_id, data) VALUES (${id}, ${projectId}, ${threadId}, ${payload.requestId}, ${encodeDecision(decision)})`;
        // The inbox shows the request; it is answered in its own thread.
        if (assistantTaskHoldsProject(t.status)) yield* saveTask({ ...t, status: "waiting" });
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
        if (t.status === "waiting") yield* saveTask({ ...t, status: "working" });
      }
    } else if (event.type === "thread.session-set") {
      const status = event.payload.session.status;
      const failed = status === "error" || status === "interrupted" || status === "stopped";
      const limitWait =
        status === "error" ? usageLimitWaitMs(event.payload.session.lastError) : null;
      if (limitWait !== null && (yield* holdForUsageLimit(projectId, threadId, t, limitWait))) {
        // The thread continues once the limit resets; its issue is not blocked
        // and the loop is not stopped.
      } else if (
        status === "stopped" &&
        (releasedAt.delete(threadId) || (yield* releasedWhileIdle(threadId)))
      ) {
        // Nothing to do: the thread's turn ended normally before its session was released.
      } else if (
        // A delivered issue's tester may stop instead of settling; either way its work is done.
        status === "ready" ||
        (failed && (t.status === "review" || t.status === "declined"))
      ) {
        yield* ingestion.drain;
        if (
          status === "ready" &&
          Option.isSome(yield* turns.getPendingTurnStartByThreadId({ threadId }))
        )
          return;
        yield* turnEnded(t, owner.role);
      } else if (failed && assistantTaskHoldsProject(t.status)) {
        yield* ingestion.drain;
        yield* saveTask({
          ...t,
          stage: "lead",
          status: "blocked",
          error: event.payload.session.lastError ?? "The worker stopped before delivery.",
        });
        // A leader that failed is not told about itself; the board shows the issue blocked.
        if (owner.role !== "lead")
          yield* notifyLead(
            t,
            `The ${ROLE_NAMES[owner.role]} for ${t.issue.identifier} is ${status}. Read its result and manage the next step. A finished turn does not prove deployment.`,
          );
      }
    } else if (event.type === "thread.deleted" && assistantTaskHoldsProject(t.status)) {
      yield* saveTask({
        ...t,
        status: "blocked",
        error: `The ${ROLE_NAMES[owner.role]} was deleted. Skip this issue to release the project.`,
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
          const delivered = deliveredState(t, p.config);
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
              notes: sessionNotes(t.feedback),
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

  /**
   * One staging deploy T3 watches for a team leader. The deployment CLIs run
   * outside the assistant lock; what they report is applied under it, to the
   * issue as it stands then and only while it still waits for the same commit.
   */
  const watchDeploy = Effect.fn("Assistant.watchDeploy")(function* (
    p: AwaitedProject,
    t: AssistantTask,
  ) {
    const wait = t.deployWait;
    if (!wait) return;
    const worker = yield* snapshots.getThreadShellById(t.threadId, { includeArchived: true });
    const root = yield* snapshots.getProjectShellById(t.projectId);
    if (Option.isNone(worker) || Option.isNone(root) || !worker.value.worktreePath) return;
    const check = yield* verifier
      .checkDeploy(
        deployInput(p, {
          cwd: root.value.workspaceRoot,
          worktreePath: worker.value.worktreePath,
          commit: wait.commit,
          targetIds: wait.targetIds,
        }),
      )
      // A check that cannot run is the leader's to look at, like a failed deploy.
      .pipe(
        Effect.catch((error) =>
          Effect.succeed({ outcome: "failed" as const, detail: error.detail }),
        ),
      );
    const elapsed = (yield* Clock.currentTimeMillis) - Date.parse(wait.since);
    yield* Effect.gen(function* () {
      const current = yield* task(t.id);
      if (!assistantTaskHoldsProject(current.status) || current.deployWait?.commit !== wait.commit)
        return;
      if (check.outcome === "verified") {
        const verified = yield* stagingVerified(p, current, check.deployment);
        // In the worktree the deploy was the last gate, so the issue is
        // delivered: no turn of this team is running, and the close its last
        // turn would have done falls to the scan.
        if (verified.status === "review") {
          if (!(yield* taskBusy(verified))) yield* closeTeam(verified);
          return;
        }
        if (verified.e2ePlan && assistantTaskE2eEnvironment(verified) !== "worktree")
          return yield* autoStartE2e(p, verified);
        return yield* notifyLead(
          verified,
          `Staging verified for ${current.issue.identifier} at ${shortSha(wait.commit)}. Start the e2e check with assistant_start_e2e: ${briefAsk(current)}.`,
        );
      }
      if (check.outcome === "pending" && elapsed < DEPLOY_WATCH_MS)
        return yield* saveTask({
          ...current,
          deployWait: { ...wait, checks: wait.checks + 1, detail: check.detail },
        });
      const cleared = yield* saveTask({ ...current, deployWait: null });
      yield* notifyLead(
        cleared,
        check.outcome === "pending"
          ? `T3 watched the staging deploy of ${shortSha(wait.commit)} for 45 minutes and it has not verified: ${check.detail}. Decide: keep waiting with assistant_wait, ask the person with assistant_ask_decision, or look at the deployment.`
          : `T3 watched the staging deploy of ${shortSha(wait.commit)} and it did not verify: ${check.detail}. Decide: call assistant_verify_staging again once the deployment is fixed, ask the person with assistant_ask_decision, or look at the deployment.`,
      );
    }).pipe(lock.withPermits(1));
  });
  /** One failing deploy check must not stop the scan for the project's other teams. */
  const watchDeploys = Effect.fn("Assistant.watchDeploys")(function* (projectId: string) {
    const waiting = (yield* heldTasks(projectId)).filter((t) => t.deployWait);
    if (!waiting.length) return;
    const p = yield* project(projectId);
    for (const t of waiting)
      yield* watchDeploy(p, t).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Developer assistant could not check a watched staging deploy", {
            task: t.id,
            error,
          }),
        ),
      );
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
        yield* watchDeploys(row.project_id);
        yield* closeFinishedTeams(row.project_id).pipe(lock.withPermits(1));
        // A paused loop keeps the reason it paused until the person starts it again.
        if (row.error !== null && row.status === "running") {
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

  /**
   * Each project once had a developer assistant chat thread, retired by
   * migration 057. Its conversation is archived rather than deleted, so the
   * person can still open it. One that cannot be archived is left for next time.
   */
  const archiveRetiredThreads = Effect.fn("Assistant.archiveRetiredThreads")(function* () {
    const rows = yield* sql<{ thread_id: string }>`SELECT thread_id FROM assistant_retired_threads`;
    for (const row of rows) {
      const threadId = ThreadId.make(row.thread_id);
      yield* Effect.gen(function* () {
        const shell = yield* snapshots.getThreadShellById(threadId, { includeArchived: true });
        if (Option.isSome(shell) && shell.value.archivedAt === null)
          yield* engine.dispatch({
            type: "thread.archive",
            commandId: CommandId.make(newId()),
            threadId,
          });
        yield* sql`DELETE FROM assistant_retired_threads WHERE thread_id = ${row.thread_id}`;
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Developer assistant could not archive a retired assistant thread", {
            threadId,
            error,
          }),
        ),
      );
    }
  });

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
  // Not under the outbox's send lock, so it may take the assistant's locks.
  yield* outbox.setTeamPrompt(linearReply);
  yield* outbox.setTeamDispatch(delegated);
  // Runs under the outbox's send lock, so it only reads: never the assistant's locks.
  yield* outbox.setTaskSync((taskId) =>
    Effect.gen(function* () {
      const rows = yield* sql<TaskRow>`SELECT * FROM assistant_tasks WHERE id = ${taskId}`;
      if (!rows[0]) return null;
      const t = yield* decodeTask(rows[0].data);
      const lead = yield* outbox.threadLink(assistantTaskThreadId(t, "lead"), "Team leader thread");
      const pullRequest = yield* taskPullRequest(t);
      return {
        plan: assistantLinearPlan(t),
        links: [
          ...(lead ? [lead] : []),
          ...(pullRequest
            ? [{ label: `Pull request #${pullRequest.number}`, url: pullRequest.url }]
            : []),
        ],
      };
    }).pipe(Effect.mapError(wrap)),
  );
  const service = {
    getSetup,
    beginSetup,
    proposeSetup,
    resolveSetup,
    board,
    configure,
    control,
    answer,
    review,
    dispatch,
    setE2eDepth,
    addProjectNote,
    deleteProjectNote,
    addProjectNoteFromThread,
    acceptIssue,
    declineIssue,
    readThread,
    messageWorker,
    askDecision,
    requestReview,
    submitReview,
    reportMerged,
    verifyStaging,
    startE2e,
    submitE2e,
    deliverChecked,
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
    yield* archiveRetiredThreads().pipe(
      Effect.catch((error) =>
        Effect.logWarning("Developer assistant could not read the retired assistant threads", {
          error,
        }),
      ),
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
