import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Stream from "effect/Stream";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TestClock } from "effect/testing";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  DeveloperAssistantError,
  EventId,
  MessageId,
  LinearOperationError,
  OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  assistantTaskHoldsProject,
  assistantTaskThreadId,
  type AssistantProjectConfig,
  type AssistantTask,
  type LinearIssueDetail,
  type LinearPrepareIssueThreadInput,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationMessage,
} from "@t3tools/contracts";
import { LinearApi } from "../linear/LinearApi.ts";
import { LinearThreadService } from "../linear/LinearThreadService.ts";
import {
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
  OrchestrationThreadSettleBlockedError,
} from "../orchestration/Errors.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionService } from "../orchestration/Services/ProviderRuntimeIngestion.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import * as Settings from "../serverSettings.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { ServerActivation } from "../serverActivation.ts";
import Migration from "../persistence/Migrations/052_DeveloperAssistant.ts";
import SetupMigration from "../persistence/Migrations/053_AssistantSetup.ts";
import ParallelMigration from "../persistence/Migrations/055_AssistantParallelIssues.ts";
import UsageLimitMigration from "../persistence/Migrations/056_AssistantUsageLimit.ts";
import * as Assistant from "./DeveloperAssistant.ts";
import { AssistantEvidence } from "./AssistantEvidence.ts";
import { StagingVerifier } from "./StagingVerifier.ts";

const decodeThread = Schema.decodeUnknownSync(OrchestrationThreadShell);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const timestamp = "2026-09-12T00:00:00.000Z";
const config: AssistantProjectConfig = {
  projectId: ProjectId.make("project"),
  linearProjectId: "linear-project",
  assignedToMe: true,
  readyStates: [],
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "assistant-model" },
  workerModelSelection: {
    instanceId: ProviderInstanceId.make("claudeCode"),
    model: "worker-model",
  },
  runtimeMode: "approval-required",
  baseBranch: "develop",
  instructions: "Use the isolated development database.",
  stagingCheckCommand: "check-staging",
  reviewState: "In Review",
  acceptedState: "Done",
  maxWorkerTurns: 2,
};
const project = {
  id: config.projectId,
  title: "Next app",
  workspaceRoot: "/repos/app",
  defaultModelSelection: null,
  scripts: [],
  createdAt: timestamp,
  updatedAt: timestamp,
};
const makeIssue = (number: number): LinearIssueDetail => ({
  id: `issue-${number}`,
  identifier: `APP-${number}`,
  title: `Issue ${number}`,
  url: `https://linear.app/test/issue/APP-${number}`,
  branchName: `app-${number}`,
  priority: 3,
  updatedAt: timestamp,
  state: { id: "todo", name: "Todo", type: "unstarted", position: 0, color: "#fff" },
  team: { id: "team", key: "APP", name: "App" },
  assignee: { id: "me", name: "Me", displayName: "Me" },
  project: { id: config.linearProjectId, name: "App", url: "https://linear.app/test/project/app" },
  cycle: null,
  description: "Implement this issue",
  comments: [],
  labels: [],
  children: [],
  parent: null,
});

function harness() {
  const commands: OrchestrationCommand[] = [];
  const replayEvents: OrchestrationEvent[] = [];
  let dispatchObserver = (_command: OrchestrationCommand): Effect.Effect<void> => Effect.void;
  const seen = new Set<string>();
  const rejected = new Map<string, string>();
  const threads = new Map<ThreadId, OrchestrationThreadShell>();
  const messages = new Map<ThreadId, OrchestrationMessage[]>();
  // Like the real projection, lookups hide archived threads unless asked.
  const visibleThread = (id: ThreadId, options?: { readonly includeArchived?: boolean }) =>
    Option.fromNullishOr(threads.get(id)).pipe(
      Option.filter((t) => options?.includeArchived === true || t.archivedAt === null),
    );
  const issues = [makeIssue(1), makeIssue(2), makeIssue(3)];
  const transitions: string[] = [];
  const started: string[] = [];
  const prepared: LinearPrepareIssueThreadInput[] = [];
  const removed: string[] = [];
  const comments: Array<{ issueId: string; body: string }> = [];
  const descriptions: Array<{ issueId: string; description: string | undefined }> = [];
  const listed: Array<{ assignedToMe: boolean; stateTypes: ReadonlyArray<string> }> = [];
  // Issues Linear refuses to read, and hooks that run while it is being read
  // or commented on, to test what the assistant does around those calls.
  const linearFailures = new Set<string>();
  let onIssueRead: (reference: string) => Effect.Effect<void> = () => Effect.void;
  let onComment: (body: string) => Effect.Effect<void> = () => Effect.void;
  let commentsHealthy = true;
  let descriptionsHealthy = true;
  const pendingStarts = new Set<ThreadId>();
  let stagingHealthy = true;
  let setupHealthy = true;
  // The worktree HEAD the verifier reports, and whether origin's branch has it.
  const git = { head: "b".repeat(40), merged: true };
  const verified: Array<{ expectedRevision?: string }> = [];
  const uploads: string[] = [];
  const stopped: ThreadId[] = [];
  const dependencies = Layer.mergeAll(
    // Like a provider, a stopped session drops the thread's background work.
    Layer.mock(ProviderService)({
      stopSession: ({ threadId }) =>
        Effect.sync(() => {
          stopped.push(threadId);
          const thread = threads.get(threadId);
          if (thread) threads.set(threadId, { ...thread, session: null, backgroundLiveness: null });
        }),
    }),
    Settings.layerTest({ linear: { agentAccess: true, apiKey: "test-key" } }),
    Layer.mock(ProjectionTurnRepository)({
      getPendingTurnStartByThreadId: ({ threadId }) =>
        Effect.succeed(
          pendingStarts.has(threadId)
            ? Option.some({
                threadId,
                messageId: MessageId.make("pending"),
                sourceProposedPlanThreadId: null,
                sourceProposedPlanId: null,
                requestedAt: timestamp,
              })
            : Option.none(),
        ),
    }),
    Layer.mock(ProviderRuntimeIngestionService)({ drain: Effect.void }),
    Layer.mock(TerminalManager)({ close: () => Effect.void }),
    Layer.mock(StagingVerifier)({
      removeWorktree: ({ worktreePath }) =>
        Effect.sync(() => {
          removed.push(worktreePath);
        }),
      repositoryKey: () => Effect.succeed("/repos/app/.git"),
      revision: () => Effect.sync(() => git.head),
      isMerged: () => Effect.sync(() => git.merged),
      verify: (input) =>
        stagingHealthy
          ? Effect.sync(() => {
              verified.push(input);
            }).pipe(
              Effect.as({
                revision: "a".repeat(40),
                url: "https://staging.example.com",
                verifiedAt: timestamp,
              }),
            )
          : Effect.fail(new DeveloperAssistantError({ detail: "Deployment failed" })),
    }),
    Layer.mock(AssistantEvidence)({
      directory: (taskId) => Effect.succeed(`/evidence/${taskId}`),
      read: (_taskId, file) =>
        file.startsWith("/evidence/")
          ? Effect.succeed({
              fileName: file.split("/").at(-1)!,
              contentType: "image/png",
              bytes: new Uint8Array([1]),
            })
          : Effect.fail(new DeveloperAssistantError({ detail: `"${file}" is outside` })),
    }),
    Layer.mock(LinearApi)({
      status: Effect.succeed({
        status: "connected",
        viewer: { id: "me", name: "Me", displayName: "Me" },
        workspace: { id: "workspace", name: "Workspace", urlKey: "workspace" },
      }),
      listIssues: (input) =>
        Effect.sync(() => {
          listed.push({
            assignedToMe: input.assignedToMe === true,
            stateTypes: input.stateTypes ?? [],
          });
          return { issues };
        }),
      getIssue: ({ reference }) =>
        linearFailures.has(reference)
          ? Effect.fail(
              new LinearOperationError({ operation: "getIssue", detail: "Linear is unavailable." }),
            )
          : onIssueRead(reference).pipe(
              Effect.as(
                issues.find((i) => i.id === reference || i.identifier === reference) ?? issues[0]!,
              ),
            ),
      workflowStates: () =>
        Effect.succeed([
          { id: "review", name: "In Review", type: "started", position: 1, color: "#fff" },
          { id: "done", name: "Done", type: "completed", position: 2, color: "#fff" },
        ]),
      updateIssueState: ({ issueId, stateId }) =>
        Effect.sync(() => {
          transitions.push(stateId);
          const index = issues.findIndex((i) => i.id === issueId);
          const state = [
            {
              id: "review",
              name: "In Review",
              type: "started" as const,
              position: 1,
              color: "#fff",
            },
            { id: "done", name: "Done", type: "completed" as const, position: 2, color: "#fff" },
          ].find((s) => s.id === stateId);
          if (index >= 0 && state) issues[index] = { ...issues[index]!, state };
        }),
      uploadFile: (input) =>
        Effect.sync(() => {
          uploads.push(input.fileName);
          return { url: `https://uploads.linear.app/${input.fileName}` };
        }),
      updateIssue: (input) =>
        descriptionsHealthy
          ? Effect.sync(() => {
              descriptions.push({ issueId: input.issueId, description: input.description });
            })
          : Effect.fail(
              new LinearOperationError({
                operation: "updateIssue",
                detail: "Linear refused to save the issue.",
              }),
            ),
      createComment: (input) =>
        commentsHealthy
          ? onComment(input.body).pipe(
              Effect.map(() => {
                comments.push(input);
                return { id: `comment-${comments.length}`, url: "https://linear.app/c" };
              }),
            )
          : Effect.fail(
              new LinearOperationError({
                operation: "createComment",
                detail: "Linear refused to add the comment.",
              }),
            ),
    }),
    Layer.mock(LinearThreadService)({
      moveToStarted: (issue) =>
        Effect.sync(() => {
          started.push(issue.identifier);
          return null;
        }),
      prepareIssueThread: (input) =>
        setupHealthy
          ? Effect.sync(() => {
              prepared.push(input);
            }).pipe(
              Effect.as({
                issue: issues.find((i) => i.id === input.reference)!,
                branch: input.branch!,
                baseBranch: input.baseBranch!,
                worktreePath: `/worktrees/${input.threadId}`,
                reusedExistingBranch: false,
                movedToState: null,
              }),
            )
          : Effect.fail(
              new LinearOperationError({ operation: "prepareIssueThread", detail: "Setup failed" }),
            ),
    }),
    Layer.mock(OrchestrationEngineService)({
      subscribeDomainEvents: Effect.succeed(Stream.empty),
      readEvents: (after) =>
        Stream.fromIterable(replayEvents.filter((event) => event.sequence > after)),
      dispatch: (command) =>
        Effect.gen(function* () {
          if (seen.has(command.commandId)) return { sequence: commands.length };
          // Like the real engine, a rejected command id stays rejected.
          const previous = rejected.get(command.commandId);
          if (previous !== undefined)
            return yield* new OrchestrationCommandPreviouslyRejectedError({
              commandId: command.commandId,
              detail: previous,
            });
          // Mirror the decider's thread invariants so callers cannot rely on
          // commands the real engine rejects.
          const target = "threadId" in command ? threads.get(command.threadId) : undefined;
          const violation =
            command.type === "thread.create"
              ? target && "Thread already exists."
              : command.type === "thread.unarchive"
                ? (target?.archivedAt ?? null) === null && "Thread is not archived."
                : command.type === "thread.archive" || command.type === "thread.settle"
                  ? (!target || target.archivedAt !== null) && "Thread is missing or archived."
                  : "threadId" in command && !target && "Thread does not exist.";
          // Like the decider, a thread whose session is alive cannot be settled.
          if (
            command.type === "thread.settle" &&
            !violation &&
            (target?.session?.status === "starting" || target?.session?.status === "running")
          ) {
            rejected.set(command.commandId, "Thread still needs attention.");
            return yield* new OrchestrationThreadSettleBlockedError({ threadId: command.threadId });
          }
          if (violation) {
            rejected.set(command.commandId, violation);
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: violation,
            });
          }
          seen.add(command.commandId);
          commands.push(command);
          if (command.type === "thread.create")
            threads.set(
              command.threadId,
              decodeThread({
                ...command,
                id: command.threadId,
                updatedAt: timestamp,
                latestTurn: null,
                session: null,
                latestUserMessageAt: null,
                hasPendingApprovals: false,
                hasPendingUserInput: false,
                hasActionableProposedPlan: false,
              }),
            );
          const thread = "threadId" in command ? threads.get(command.threadId) : undefined;
          // Like the projection, a turn's message joins the thread's conversation.
          if (thread && command.type === "thread.turn.start")
            messages.set(thread.id, [
              ...(messages.get(thread.id) ?? []),
              {
                id: command.message.messageId,
                role: "user",
                text: command.message.text,
                turnId: null,
                streaming: false,
                createdAt: timestamp,
                updatedAt: timestamp,
              },
            ]);
          if (thread && command.type === "thread.turn.start")
            threads.set(thread.id, {
              ...thread,
              // The projection stamps the message that started the turn, which
              // is also how a thread shows it has ever run one.
              latestUserMessageAt: timestamp,
              // Like the decider, work on a settled thread un-settles it.
              settledOverride: null,
              settledAt: null,
              session: {
                threadId: thread.id,
                status: "running",
                providerName: "test",
                activeTurnId: TurnId.make(command.commandId),
                runtimeMode: "approval-required",
                lastError: null,
                updatedAt: timestamp,
              },
            });
          if (thread && command.type === "thread.archive")
            threads.set(thread.id, { ...thread, archivedAt: timestamp });
          if (thread && command.type === "thread.unarchive")
            threads.set(thread.id, { ...thread, archivedAt: null });
          if (thread && command.type === "thread.settle")
            threads.set(thread.id, {
              ...thread,
              settledOverride: "settled",
              settledAt: timestamp,
            });
          if (thread && command.type === "thread.unsettle")
            threads.set(thread.id, { ...thread, settledOverride: null, settledAt: null });
          if (thread && command.type === "thread.turn.interrupt")
            threads.set(thread.id, { ...thread, session: null });
          return { sequence: commands.length };
        }).pipe(Effect.tap(() => dispatchObserver(command))),
    }),
    Layer.mock(ProjectionSnapshotQuery)({
      getProjectShellById: () => Effect.succeed(Option.some(project)),
      getShellSnapshot: () =>
        Effect.succeed({
          projects: [project],
          threads: [...threads.values()].filter((t) => t.archivedAt === null),
          snapshotSequence: commands.length,
          updatedAt: timestamp,
        }),
      getThreadShellById: (id, options) => Effect.succeed(visibleThread(id, options)),
      getThreadDetailById: (id) =>
        Effect.succeed(visibleThread(id)).pipe(
          Effect.map(
            Option.map((thread) => ({
              ...thread,
              deletedAt: null,
              messages: messages.get(thread.id) ?? [],
              activities: [],
              checkpoints: [],
              proposedPlans: [],
            })),
          ),
        ),
    }),
  );
  const make = Assistant.make.pipe(
    Effect.provide(dependencies),
    Effect.provideService(Assistant.DeveloperAssistantWorkers, false),
  );
  const initialize = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE orchestration_events (sequence INTEGER)`;
    yield* Migration;
    yield* SetupMigration;
    yield* ParallelMigration;
    yield* UsageLimitMigration;
    return yield* make;
  });
  /** A configured, running project; overrides change the setup it runs with. */
  const setupWith = (overrides: Partial<AssistantProjectConfig> = {}) =>
    Effect.gen(function* () {
      const service = yield* initialize;
      yield* service.configure({ ...config, ...overrides });
      const board = yield* service.control({ projectId: config.projectId, action: "start" });
      return { service, caller: board.projects[0]!.threadId };
    });
  return {
    initialize,
    setup: setupWith(),
    setupWith,
    make,
    makeWithWorkers: Assistant.make.pipe(Effect.provide(dependencies)),
    replayEvents,
    onDispatch: (observer: typeof dispatchObserver) => {
      dispatchObserver = observer;
    },
    commands,
    issues,
    threads,
    messages,
    transitions,
    started,
    prepared,
    removed,
    comments,
    descriptions,
    listed,
    linearFailures,
    whenIssueRead: (hook: typeof onIssueRead) => {
      onIssueRead = hook;
    },
    whenCommentPosted: (hook: typeof onComment) => {
      onComment = hook;
    },
    setCommentsHealthy: (value: boolean) => {
      commentsHealthy = value;
    },
    setDescriptionsHealthy: (value: boolean) => {
      descriptionsHealthy = value;
    },
    pendingStarts,
    git,
    verified,
    uploads,
    stopped,
    setStagingHealthy: (value: boolean) => {
      stagingHealthy = value;
    },
    setSetupHealthy: (value: boolean) => {
      setupHealthy = value;
    },
    finish: (id: ThreadId) => {
      const thread = threads.get(id)!;
      threads.set(id, { ...thread, session: null });
    },
  };
}
const database = NodeSqliteClient.layerMemory;
type Harness = ReturnType<typeof harness>;
type Service = Effect.Success<typeof Assistant.make>;

const sessionReady = (threadId: ThreadId) =>
  ({
    ...eventBase(threadId),
    type: "thread.session-set",
    payload: {
      threadId,
      session: {
        threadId,
        status: "ready",
        providerName: "test",
        activeTurnId: null,
        runtimeMode: "approval-required",
        lastError: null,
        updatedAt: timestamp,
      },
    },
  }) satisfies OrchestrationEvent;

/** A thread's turn ends the way the provider reports it. */
const endTurn = (h: Harness, service: Service, threadId: ThreadId) => {
  h.finish(threadId);
  return service.observe(sessionReady(threadId));
};

/** What a thread was sent, turn by turn. */
const turnsOf = (h: Harness, threadId: ThreadId) =>
  h.commands.flatMap((c) =>
    c.type === "thread.turn.start" && c.threadId === threadId ? [c.message.text] : [],
  );
const leadOf = (t: AssistantTask) => assistantTaskThreadId(t, "lead");
const activeTask = (service: Service) =>
  service
    .board(null)
    .pipe(Effect.map((b) => b.tasks.find((t) => assistantTaskHoldsProject(t.status))!));
const taskById = (service: Service, id: string) =>
  service.board(null).pipe(Effect.map((b) => b.tasks.find((t) => t.id === id)!));

/** Every issue the project's teams hold, by identifier. */
const heldTasks = (service: Service) =>
  service
    .board(null)
    .pipe(
      Effect.map((b) =>
        b.tasks
          .filter((t) => assistantTaskHoldsProject(t.status))
          .toSorted((a, c) => a.issue.identifier.localeCompare(c.issue.identifier)),
      ),
    );

/** One team takes its issue; the worker's first turn is queued. */
const takeTask = (h: Harness, service: Service, t: AssistantTask, brief = "Fix it") =>
  Effect.gen(function* () {
    yield* service.deliver();
    yield* service.acceptIssue(leadOf(t), brief);
    yield* endTurn(h, service, leadOf(t));
    return yield* taskById(service, t.id);
  });

/** The team the loop started takes its issue; the worker's first turn is queued. */
const takeIssue = (h: Harness, service: Service, brief = "Fix it") =>
  Effect.gen(function* () {
    const t = yield* activeTask(service);
    return yield* takeTask(h, service, t, brief);
  });

/** The code reviewer approves the worker's commit. */
const approveReview = (h: Harness, service: Service, t: AssistantTask) =>
  Effect.gen(function* () {
    const reviewer = assistantTaskThreadId(t, "review");
    yield* service.deliver();
    yield* service.requestReview(t.threadId, "Ready for review: PR #1");
    yield* endTurn(h, service, t.threadId);
    yield* service.deliver();
    yield* service.submitReview(reviewer, "approved", "Looks right.", "Covered the fix.");
    yield* endTurn(h, service, reviewer);
    yield* service.deliver();
  });

/** Carry a taken issue through review and merge, ready for staging. */
const reachMerge = (h: Harness, service: Service, t: AssistantTask) =>
  Effect.gen(function* () {
    const reviewer = assistantTaskThreadId(t, "review");
    yield* service.deliver();
    yield* service.requestReview(t.threadId, "Ready for review: PR #1");
    yield* endTurn(h, service, t.threadId);
    yield* service.deliver();
    yield* service.submitReview(
      reviewer,
      "approved",
      "Looks right.",
      "Covered the fix and its tests.",
    );
    yield* endTurn(h, service, reviewer);
    yield* service.deliver();
    yield* service.reportMerged(t.threadId, "The page loads again.");
    yield* endTurn(h, service, t.threadId);
  });

/** The team leader, told about the merge, verifies staging and starts e2e. */
const leadToE2e = (h: Harness, service: Service, t: AssistantTask) =>
  Effect.gen(function* () {
    yield* service.deliver();
    yield* service.verifyStaging(leadOf(t), undefined);
    yield* service.startE2e(leadOf(t), undefined, "Open the page.");
    yield* endTurn(h, service, leadOf(t));
    yield* service.deliver();
  });

/** Carry a taken issue through merge, staging and a passing e2e run. */
const deliverIssue = (h: Harness, service: Service, t: AssistantTask) =>
  Effect.gen(function* () {
    const tester = assistantTaskThreadId(t, "e2e");
    yield* reachMerge(h, service, t);
    yield* leadToE2e(h, service, t);
    const delivered = yield* service.submitE2e(tester, {
      verdict: "passed",
      report: "- The page loads: passed",
      humanChecks: [],
      screenshots: [{ path: `/evidence/${t.id}/page.png`, caption: "The page after the fix" }],
    });
    yield* endTurn(h, service, tester);
    return delivered;
  });

const setupInput = {
  projectId: config.projectId,
  linearProjectId: config.linearProjectId,
  assignedToMe: true,
  modelSelection: config.modelSelection,
  workerModelSelection: config.workerModelSelection,
  runtimeMode: "full-access" as const,
  setupRuntimeMode: "approval-required" as const,
  context: "Inspect the existing staging deployment.",
};
const setupPlan = {
  baseBranch: "develop",
  readyStates: [],
  instructions: "Use the staging database and verify the affected UI.",
  stagingCheckCommand: "",
  stagingUrl: "https://staging.example.test",
  deploymentTargets: [
    { kind: "github-actions" as const, id: "web", repository: "owner/app", workflow: "deploy.yml" },
  ],
  reviewState: "In Review",
  acceptedState: "Done",
  maxWorkerTurns: 6,
};

it.effect("setup is a durable conversation and saving never starts the issue queue", () =>
  Effect.gen(function* () {
    const h = harness();
    const service = yield* h.initialize;
    const draft = yield* service.beginSetup(setupInput);
    assert.equal(
      (yield* service.getSetup(draft.threadId)).setup.preferences.context,
      setupInput.context,
    );
    assert.isTrue(yield* service.getSetup(ThreadId.make("unrelated")).pipe(Effect.isFailure));
    assert.equal((yield* service.beginSetup(setupInput)).threadId, draft.threadId);
    assert.lengthOf(
      h.commands.filter((c) => c.type === "thread.turn.start"),
      1,
    );
    assert.equal(h.threads.get(draft.threadId)?.runtimeMode, "approval-required");
    assert.lengthOf((yield* service.board(null)).projects, 0);
    assert.isTrue(
      yield* service.dispatchFromAssistant(draft.threadId, "APP-1", "").pipe(Effect.isFailure),
    );
    assert.isTrue(
      yield* service
        .proposeSetup(ThreadId.make("unrelated"), setupPlan, "Not authorized")
        .pipe(Effect.isFailure),
    );
    const proposed = yield* service.proposeSetup(
      draft.threadId,
      setupPlan,
      "Deploy through GitHub Actions.",
    );
    assert.equal(proposed.proposal?.runtimeMode, "full-access");
    const save = { threadId: draft.threadId, action: "save" as const, revision: proposed.revision };
    assert.isTrue(yield* service.resolveSetup(save).pipe(Effect.isFailure));
    h.finish(draft.threadId);
    const restarted = yield* h.make;
    assert.equal(
      (yield* restarted.board(null)).setups?.[0]?.summary,
      "Deploy through GitHub Actions.",
    );
    const board = yield* restarted.resolveSetup(save);
    assert.lengthOf(board.setups ?? [], 0);
    assert.equal(board.projects[0]?.status, "stopped");
    assert.deepEqual(board.projects[0]?.config.deploymentTargets, setupPlan.deploymentTargets);
    assert.equal(board.projects[0]?.config.workerModelSelection.model, "worker-model");
    assert.lengthOf(board.tasks, 0);
    assert.lengthOf(h.transitions, 0);
    assert.lengthOf(
      h.commands.filter((c) => c.type === "thread.turn.start"),
      1,
    );
    assert.equal(h.threads.get(draft.threadId)?.archivedAt, timestamp);
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("setup runs with its own permissions, separate from issue work", () =>
  Effect.gen(function* () {
    const h = harness();
    const service = yield* h.initialize;
    const draft = yield* service.beginSetup({
      ...setupInput,
      runtimeMode: "approval-required",
      setupRuntimeMode: "full-access",
    });
    assert.equal(h.threads.get(draft.threadId)?.runtimeMode, "full-access");
    const start = h.commands.find((c) => c.type === "thread.turn.start");
    assert.equal(start?.type === "thread.turn.start" ? start.runtimeMode : null, "full-access");
    const proposed = yield* service.proposeSetup(draft.threadId, setupPlan, "Plan");
    assert.equal(proposed.proposal?.runtimeMode, "approval-required");
    assert.notProperty(proposed.proposal, "setupRuntimeMode");

    // Setups saved before the choice existed keep running supervised.
    const sql = yield* SqlClient.SqlClient;
    const { setupRuntimeMode: _mode, ...legacy } = draft.preferences;
    const encoded = yield* encodeJson(legacy);
    yield* sql`UPDATE assistant_setups SET preferences = ${encoded} WHERE thread_id = ${draft.threadId}`;
    assert.equal(
      (yield* service.getSetup(draft.threadId)).setup.preferences.setupRuntimeMode,
      "approval-required",
    );
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("requires a fresh proposal after more discussion and rejects stale saves", () =>
  Effect.gen(function* () {
    const h = harness();
    const service = yield* h.initialize;
    const draft = yield* service.beginSetup(setupInput);
    const first = yield* service.proposeSetup(draft.threadId, setupPlan, "First plan");
    h.finish(draft.threadId);
    h.threads.set(draft.threadId, {
      ...h.threads.get(draft.threadId)!,
      latestUserMessageAt: "2026-09-12T00:01:00.000Z",
    });
    assert.isTrue(
      yield* service
        .resolveSetup({ threadId: draft.threadId, action: "save", revision: first.revision })
        .pipe(Effect.isFailure),
    );
    const revised = yield* service.proposeSetup(
      draft.threadId,
      { ...setupPlan, maxWorkerTurns: 3 },
      "Revised plan",
    );
    assert.isTrue(
      yield* service
        .resolveSetup({ threadId: draft.threadId, action: "save", revision: first.revision })
        .pipe(Effect.isFailure),
    );
    const saved = yield* service.resolveSetup({
      threadId: draft.threadId,
      action: "save",
      revision: revised.revision,
    });
    assert.equal(saved.projects[0]?.config.maxWorkerTurns, 3);
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("cancelling setup interrupts its turn, retains history and permits a new setup", () =>
  Effect.gen(function* () {
    const h = harness();
    const service = yield* h.initialize;
    const draft = yield* service.beginSetup(setupInput);
    const board = yield* service.resolveSetup({
      threadId: draft.threadId,
      action: "cancel",
      revision: 0,
    });
    assert.lengthOf(board.setups ?? [], 0);
    assert.lengthOf(board.projects, 0);
    assert.isNull(h.threads.get(draft.threadId)?.session);
    assert.equal(h.threads.get(draft.threadId)?.archivedAt, timestamp);
    assert.isTrue(
      yield* service.proposeSetup(draft.threadId, setupPlan, "Too late").pipe(Effect.isFailure),
    );
    assert.notEqual((yield* service.beginSetup(setupInput)).threadId, draft.threadId);
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("a paused assistant can be revised with an issue in progress, keeping its branch", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service } = yield* h.setup;
    assert.isTrue(yield* service.beginSetup(setupInput).pipe(Effect.isFailure));
    const task = yield* activeTask(service);
    yield* service.control({ projectId: config.projectId, action: "pause" });
    const draft = yield* service.beginSetup(setupInput);
    assert.include(
      (yield* service.getSetup(draft.threadId)).instructions,
      "APP-1 is still in progress on develop",
    );
    assert.isTrue(
      yield* service
        .control({ projectId: config.projectId, action: "start" })
        .pipe(Effect.isFailure),
    );
    assert.isTrue(yield* service.configure(config).pipe(Effect.isFailure));
    h.finish(draft.threadId);
    // The issue in progress stays on the branch it started from.
    const moved = yield* service.proposeSetup(
      draft.threadId,
      { ...setupPlan, baseBranch: "main" },
      "Deliver to main",
    );
    const refused = yield* service
      .resolveSetup({ threadId: draft.threadId, action: "save", revision: moved.revision })
      .pipe(Effect.flip);
    assert.include(refused.detail, "APP-1 is still in progress on develop");
    const kept = yield* service.proposeSetup(draft.threadId, setupPlan, "New instructions");
    const saved = yield* service.resolveSetup({
      threadId: draft.threadId,
      action: "save",
      revision: kept.revision,
    });
    assert.equal(saved.projects[0]?.config.instructions, setupPlan.instructions);
    assert.equal(saved.projects[0]?.status, "paused");
    assert.equal(saved.tasks.find((t) => t.id === task.id)?.status, "working");
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("rejects missing deployment checks and duplicate repository setup", () =>
  Effect.gen(function* () {
    const h = harness();
    const service = yield* h.initialize;
    const draft = yield* service.beginSetup(setupInput);
    assert.isTrue(
      yield* service
        .beginSetup({ ...setupInput, projectId: ProjectId.make("same-repo") })
        .pipe(Effect.isFailure),
    );
    assert.isTrue(
      yield* service
        .configure({ ...config, projectId: ProjectId.make("same-repo") })
        .pipe(Effect.isFailure),
    );
    assert.isTrue(
      yield* service
        .proposeSetup(
          draft.threadId,
          { ...setupPlan, deploymentTargets: [] },
          "No deployment evidence",
        )
        .pipe(Effect.isFailure),
    );
    assert.isTrue(
      yield* service
        .proposeSetup(
          draft.threadId,
          {
            ...setupPlan,
            deploymentTargets: [...setupPlan.deploymentTargets, ...setupPlan.deploymentTargets],
          },
          "Duplicate targets",
        )
        .pipe(Effect.isFailure),
    );
    assert.isNull((yield* service.board(null)).setups?.[0]?.proposal);
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("the loop gives one issue at a time to a team and moves on after e2e", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service, caller } = yield* h.setup;
    const team = yield* activeTask(service);
    const lead = leadOf(team);
    assert.equal(team.issue.identifier, "APP-1");
    assert.isTrue(team.leader);
    // The leader works in a worktree fresh from the base branch; Linear waits for its call.
    assert.equal(h.prepared[0]?.baseBranch, "develop");
    assert.isFalse(h.prepared[0]?.moveToStarted);
    assert.equal(h.threads.get(lead)?.worktreePath, `/worktrees/${team.threadId}`);
    assert.equal(h.threads.get(lead)?.modelSelection.model, "assistant-model");
    assert.isFalse(h.threads.has(team.threadId));
    assert.lengthOf(h.started, 0);
    yield* service.deliver();
    assert.include(turnsOf(h, lead)[0], "You are the team leader for this issue");
    assert.include(turnsOf(h, lead)[0], "APP-1: Issue 1");

    const first = yield* takeIssue(h, service, "Fix the page");
    assert.deepEqual(h.started, ["APP-1"]);
    assert.equal(first.brief, "Fix the page");
    assert.equal(h.threads.get(first.threadId)?.worktreePath, `/worktrees/${team.threadId}`);
    yield* service.deliver();
    const workerStart = h.commands.find(
      (c) => c.type === "thread.turn.start" && c.threadId === first.threadId,
    );
    assert.equal(
      workerStart?.type === "thread.turn.start" ? workerStart.modelSelection?.model : null,
      "worker-model",
    );
    // No second team while one holds the project.
    yield* service.scan();
    assert.lengthOf((yield* service.board(null)).tasks, 1);

    yield* reachMerge(h, service, first);
    yield* service.deliver();
    assert.include(turnsOf(h, lead).at(-1), "merged into its integration branch");
    h.setStagingHealthy(false);
    assert.isTrue(yield* service.verifyStaging(lead, undefined).pipe(Effect.isFailure));
    h.setStagingHealthy(true);
    // A leader acts only on its own issue.
    assert.isTrue(yield* service.verifyStaging(lead, "another-task").pipe(Effect.isFailure));
    const verified = yield* service.verifyStaging(lead, undefined);
    // Staging alone does not release the project; the e2e check does.
    assert.equal(verified.status, "working");
    yield* service.scan();
    assert.lengthOf((yield* service.board(null)).tasks, 1);
    yield* service.startE2e(lead, undefined, "Open the page.");
    yield* endTurn(h, service, lead);
    yield* service.deliver();
    const tester = assistantTaskThreadId(first, "e2e");
    const delivered = yield* service.submitE2e(tester, {
      verdict: "passed",
      report: "- The page loads: passed",
      humanChecks: [],
      screenshots: [],
    });
    assert.equal(delivered.status, "review");
    yield* endTurn(h, service, tester);
    // A finished team's threads are settled, not archived: the person can still
    // open them from the assistant page.
    for (const role of ["lead", "implement", "review", "e2e"] as const) {
      const thread = h.threads.get(assistantTaskThreadId(first, role));
      assert.equal(thread?.settledOverride, "settled");
      assert.isNull(thread?.archivedAt);
    }
    assert.deepEqual(h.removed, [`/worktrees/${first.threadId}`]);
    yield* service.scan();
    const next = yield* activeTask(service);
    assert.equal(next.issue.identifier, "APP-2");
    assert.deepEqual(h.transitions, ["review"]);
    // The loop never needed the assistant: its only turn is the one from Start.
    yield* service.deliver();
    assert.lengthOf(turnsOf(h, caller), 1);
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("posts a Linear update for each phase, with the e2e card last", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service } = yield* h.setup;
    const first = yield* takeIssue(h, service);
    yield* reachMerge(h, service, first);
    assert.lengthOf(h.comments, 1);
    assert.match(h.comments[0]!.body, /^\*\*Code review passed · merged into `develop`\*\*/);
    assert.include(h.comments[0]!.body, "The page loads again.");
    assert.include(h.comments[0]!.body, "**Code review:** Covered the fix and its tests.");
    yield* service.deliver();
    yield* service.verifyStaging(leadOf(first), undefined);
    // A repeated call returns the recorded deployment without posting twice.
    yield* service.verifyStaging(leadOf(first), undefined);
    assert.lengthOf(h.comments, 2);
    assert.include(h.comments[1]!.body, "[staging.example.com](https://staging.example.com)");
    yield* service.startE2e(leadOf(first), undefined, "Open the page.");
    yield* endTurn(h, service, leadOf(first));
    yield* service.deliver();
    const tester = assistantTaskThreadId(first, "e2e");
    const delivered = yield* service.submitE2e(tester, {
      verdict: "partial",
      report: "- The page loads: passed\n- Email: not checked",
      humanChecks: ["Open the reminder email in the test inbox."],
      screenshots: [{ path: `/evidence/${first.id}/page.png`, caption: "The page after the fix" }],
    });
    assert.lengthOf(h.comments, 3);
    const card = h.comments[2]!.body;
    assert.match(card, /^\*\*👀 Verified on staging, with checks for a person\*\*/);
    assert.include(card, "1. Open the reminder email in the test inbox.");
    assert.include(card, "**What changed**\n\nThe page loads again.");
    assert.include(card, "![The page after the fix](https://uploads.linear.app/page.png)");
    assert.include(card, "move this issue to Done");
    assert.deepEqual(h.uploads, ["page.png"]);
    assert.equal(delivered.status, "review");
    assert.deepEqual(delivered.linearCommentIds, ["comment-1", "comment-2", "comment-3"]);
    assert.include(delivered.reviewInstructions, "Open the reminder email");
    // The issue itself says what shipped, above the person's own description.
    assert.deepEqual(
      h.descriptions.map((d) => d.issueId),
      ["issue-1"],
    );
    const description = h.descriptions[0]!.description!;
    assert.isTrue(description.startsWith("Implement this issue\n\n<!-- t3:delivered -->"));
    assert.include(description, "## What shipped");
    assert.include(description, "Move this issue to Done to accept it.");
    assert.include(description, "The page loads again.");
    assert.include(description, "1. Open the reminder email in the test inbox.");
    assert.include(description, "Staging: [staging.example.com](https://staging.example.com)");
    assert.notInclude(description, "Pull request");
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("keeps a delivery whose Linear comment fails, and says so on the task", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service } = yield* h.setup;
    const first = yield* takeIssue(h, service);
    h.setCommentsHealthy(false);
    const delivered = yield* deliverIssue(h, service, first);
    assert.equal(delivered.status, "review");
    assert.include(delivered.error ?? "", "Could not post the update on Linear");
    assert.include(delivered.error ?? "", "Linear refused to add the comment.");
    assert.deepEqual(h.transitions, ["review"]);
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("keeps a delivery whose Linear description update fails, and says so on the task", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service } = yield* h.setup;
    const first = yield* takeIssue(h, service);
    h.setDescriptionsHealthy(false);
    const delivered = yield* deliverIssue(h, service, first);
    assert.equal(delivered.status, "review");
    assert.include(delivered.error ?? "", "Could not update the issue description on Linear");
    assert.include(delivered.error ?? "", "Linear refused to save the issue.");
    // The rest of the delivery still happened.
    assert.deepEqual(h.transitions, ["review"]);
    assert.equal(delivered.deliveredState, "In Review");
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("a declined issue gets one comment and waits until a person changes it", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service } = yield* h.setup;
    const team = yield* activeTask(service);
    yield* service.deliver();
    // Only the leader decides, and only before the team takes the issue.
    assert.isTrue(
      yield* service.declineIssue(team.threadId, "Not mine to decide").pipe(Effect.isFailure),
    );
    const declined = yield* service.declineIssue(
      leadOf(team),
      "The issue has no acceptance criteria. Add them to the description.",
    );
    assert.equal(declined.status, "declined");
    assert.lengthOf(h.comments, 1);
    assert.match(h.comments[0]!.body, /^\*\*Not taken by the developer assistant\*\*/);
    assert.include(h.comments[0]!.body, "no acceptance criteria");
    assert.lengthOf(h.started, 0);
    yield* endTurn(h, service, leadOf(team));
    assert.equal(h.threads.get(leadOf(team))?.settledOverride, "settled");
    assert.isNull(h.threads.get(leadOf(team))?.archivedAt);
    assert.deepEqual(h.removed, [`/worktrees/${team.threadId}`]);

    // Only the declined issue is left: an unchanged issue stays declined.
    h.issues.splice(1);
    yield* service.scan();
    assert.isUndefined(yield* activeTask(service));
    // T3's own comment does not count as a change.
    const own = {
      id: declined.linearCommentIds![0]!,
      body: "Not taken",
      url: "",
      createdAt: "2026-09-12T00:01:00.000Z",
      author: null,
    };
    h.issues[0] = { ...h.issues[0]!, updatedAt: "2026-09-12T00:01:00.000Z", comments: [own] };
    yield* service.scan();
    assert.isUndefined(yield* activeTask(service));
    assert.equal(
      (yield* taskById(service, declined.id)).declined?.issueUpdatedAt,
      "2026-09-12T00:01:00.000Z",
    );
    // A person's comment does.
    h.issues[0] = {
      ...h.issues[0]!,
      updatedAt: "2026-09-12T00:02:00.000Z",
      comments: [own, { ...own, id: "person", body: "Criteria: the page loads.", author: null }],
    };
    yield* service.scan();
    const again = yield* activeTask(service);
    assert.equal(again.issue.identifier, "APP-1");
    assert.notEqual(again.id, declined.id);
    assert.lengthOf(h.comments, 1);
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("three declines in a row pause the loop until the person starts it again", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service } = yield* h.setup;
    for (const identifier of ["APP-1", "APP-2", "APP-3"]) {
      const team = yield* activeTask(service);
      assert.equal(team.issue.identifier, identifier);
      yield* service.deliver();
      yield* service.declineIssue(leadOf(team), `${identifier} is blocked.`);
      yield* endTurn(h, service, leadOf(team));
      yield* service.scan();
    }
    const paused = (yield* service.board(null)).projects[0]!;
    assert.equal(paused.status, "paused");
    assert.include(paused.error!, "APP-1, APP-2, APP-3");
    const resumed = yield* service.control({ projectId: config.projectId, action: "start" });
    assert.equal(resumed.projects[0]?.status, "running");
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect(
  "a dispatched issue goes next, its leader cannot decline it, and it can be taken out",
  () =>
    Effect.gen(function* () {
      const h = harness();
      const { service, caller } = yield* h.setup;
      const first = yield* activeTask(service);
      const board = yield* service.dispatch({
        projectId: config.projectId,
        reference: "APP-3",
        note: "Do the header first.",
      });
      const picked = board.tasks.find((t) => t.issue.identifier === "APP-3")!;
      assert.equal(picked.status, "queued");
      assert.isTrue(picked.dispatched);
      assert.equal((yield* service.dispatchFromAssistant(caller, "APP-3", "Again")).id, picked.id);
      // A team leader does not dispatch, and nothing outside the project's scope is dispatched.
      assert.isTrue(
        yield* service.dispatchFromAssistant(leadOf(first), "APP-2", "").pipe(Effect.isFailure),
      );
      h.issues[1] = { ...h.issues[1]!, project: null };
      assert.isTrue(
        yield* service.dispatchFromAssistant(caller, "APP-2", "").pipe(Effect.isFailure),
      );
      h.issues[1] = {
        ...makeIssue(2),
        state: { id: "done", name: "Done", type: "completed", position: 2, color: "#fff" },
      };
      assert.isTrue(
        yield* service.dispatchFromAssistant(caller, "APP-2", "").pipe(Effect.isFailure),
      );
      h.issues[1] = makeIssue(2);

      yield* service.review({ taskId: first.id, action: "skip", feedback: "Later" });
      yield* service.scan();
      const next = yield* activeTask(service);
      assert.equal(next.id, picked.id);
      yield* service.deliver();
      const brief = turnsOf(h, leadOf(next))[0];
      assert.include(brief, "The person dispatched it to your team");
      assert.include(brief, "Do the header first.");
      assert.notInclude(brief, "assistant_decline_issue");
      const refused = yield* service.declineIssue(leadOf(next), "Not clear").pipe(Effect.flip);
      assert.include(refused.detail, "cannot be declined");
      assert.lengthOf(h.comments, 0);

      // Someone else's issue can be dispatched: the person chose it.
      h.issues[1] = { ...makeIssue(2), assignee: null };
      const later = yield* service.dispatchFromAssistant(caller, "APP-2", "");
      yield* service.review({ taskId: later.id, action: "skip", feedback: "Taken out" });
      assert.equal((yield* taskById(service, later.id)).status, "skipped");
    }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("a paused loop takes no new issue, while its team and dispatched issues run", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service, caller } = yield* h.setup;
    const team = yield* activeTask(service);
    yield* service.deliver();
    assert.lengthOf(turnsOf(h, caller), 1);
    const paused = yield* service.control({ projectId: config.projectId, action: "pause" });
    assert.equal(paused.projects[0]?.status, "paused");
    // The team at work carries on.
    yield* service.deliver();
    assert.lengthOf(turnsOf(h, leadOf(team)), 1);
    yield* service.acceptIssue(leadOf(team), "Fix it");
    yield* endTurn(h, service, leadOf(team));
    yield* service.deliver();
    assert.lengthOf(turnsOf(h, team.threadId), 1);
    // Once it is gone, the loop takes nothing from Linear.
    yield* service.review({ taskId: team.id, action: "skip", feedback: "Later" });
    yield* service.scan();
    assert.isUndefined(yield* activeTask(service));
    // An issue the person dispatches starts right away.
    yield* service.dispatch({ projectId: config.projectId, reference: "APP-3", note: "" });
    const dispatched = yield* activeTask(service);
    assert.equal(dispatched.issue.identifier, "APP-3");
    yield* service.deliver();
    assert.lengthOf(turnsOf(h, leadOf(dispatched)), 1);
    // Starting the loop again does not wake an assistant that has already run.
    const started = yield* service.control({ projectId: config.projectId, action: "start" });
    assert.equal(started.projects[0]?.status, "running");
    yield* service.deliver();
    assert.lengthOf(turnsOf(h, caller), 1);
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("starting again does not wake the assistant", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service, caller } = yield* h.setup;
    // The assistant's first turn is the briefing Start sent it.
    yield* service.deliver();
    assert.lengthOf(turnsOf(h, caller), 1);
    h.finish(caller);
    yield* service.control({ projectId: config.projectId, action: "pause" });
    yield* service.control({ projectId: config.projectId, action: "start" });
    yield* service.deliver();
    assert.lengthOf(turnsOf(h, caller), 1);
    // A restarted server has forgotten what it briefed, and Start still leaves
    // the assistant alone: the next real wake repeats the instructions.
    const restarted = yield* h.make;
    yield* restarted.control({ projectId: config.projectId, action: "start" });
    yield* restarted.deliver();
    assert.lengthOf(turnsOf(h, caller), 1);
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("a revised setup does not wake the assistant on start", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service, caller } = yield* h.setup;
    yield* service.deliver();
    assert.lengthOf(turnsOf(h, caller), 1);
    h.finish(caller);
    // Configuration changes while the loop is stopped, so Start follows a revision.
    yield* service.control({ projectId: config.projectId, action: "pause" });
    const revised = "Never touch the production database.";
    yield* service.configure({ ...config, instructions: revised });
    yield* service.control({ projectId: config.projectId, action: "start" });
    yield* service.deliver();
    assert.lengthOf(turnsOf(h, caller), 1);
    // The next real wake carries the revised instructions.
    const question = yield* service.askDecision(caller, "Which issue should go first?");
    yield* service.answer({ decisionId: question.id, answer: "APP-2" });
    yield* service.deliver();
    assert.lengthOf(turnsOf(h, caller), 2);
    assert.include(turnsOf(h, caller).at(-1), "The person answered your question");
    assert.include(turnsOf(h, caller).at(-1), revised);
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("a paused loop reworks a dispatched issue the person sent back, and only that", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service } = yield* h.setup;
    // The loop's own pick is delivered; its review feedback waits for the loop.
    const own = yield* takeIssue(h, service);
    yield* deliverIssue(h, service, own);
    yield* service.control({ projectId: config.projectId, action: "pause" });
    yield* service.review({ taskId: own.id, action: "request-changes", feedback: "Bigger." });
    yield* service.scan();
    assert.isUndefined(yield* activeTask(service));
    // An issue the person dispatched is theirs: its rework starts while paused.
    yield* service.dispatch({ projectId: config.projectId, reference: "APP-2", note: "" });
    const dispatched = yield* takeIssue(h, service);
    assert.equal(dispatched.issue.identifier, "APP-2");
    yield* deliverIssue(h, service, dispatched);
    yield* service.review({
      taskId: dispatched.id,
      action: "request-changes",
      feedback: "Port the newer design.",
    });
    yield* service.scan();
    const rework = yield* activeTask(service);
    assert.equal(rework.issue.identifier, "APP-2");
    assert.equal(rework.feedback, "Port the newer design.");
    assert.isTrue(rework.dispatched);
    yield* service.deliver();
    assert.include(turnsOf(h, leadOf(rework))[0], "Port the newer design.");
    // Once the loop runs again, its own sent-back issue comes back too.
    yield* service.review({ taskId: rework.id, action: "skip", feedback: "Later" });
    yield* service.control({ projectId: config.projectId, action: "start" });
    yield* service.scan();
    assert.equal((yield* activeTask(service)).issue.identifier, "APP-1");
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("starting with picking off saves the mode and reads nothing from Linear", () =>
  Effect.gen(function* () {
    const h = harness();
    const service = yield* h.initialize;
    yield* service.configure(config);
    const board = yield* service.control({
      projectId: config.projectId,
      action: "start",
      options: { autoPick: false, assignedToMe: true },
    });
    assert.equal(board.projects[0]?.status, "running");
    assert.isFalse(board.projects[0]?.config.autoPick);
    assert.isTrue(board.projects[0]?.config.assignedToMe);
    // No ready issue is even looked for, so no team starts.
    assert.lengthOf(board.tasks, 0);
    yield* service.scan();
    assert.lengthOf((yield* service.board(null)).tasks, 0);
    assert.lengthOf(h.listed, 0);
    // What the person dispatches still runs.
    yield* service.dispatch({ projectId: config.projectId, reference: "APP-3", note: "" });
    assert.equal((yield* activeTask(service)).issue.identifier, "APP-3");
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("starting with picking on takes the top ready issue, the person's or not", () =>
  Effect.gen(function* () {
    const h = harness();
    const service = yield* h.initialize;
    yield* service.configure(config);
    const board = yield* service.control({
      projectId: config.projectId,
      action: "start",
      options: { autoPick: true, assignedToMe: false },
    });
    assert.isTrue(board.projects[0]?.config.autoPick);
    assert.isFalse(board.projects[0]?.config.assignedToMe);
    assert.deepEqual(h.listed, [{ assignedToMe: false, stateTypes: ["unstarted"] }]);
    assert.equal((yield* activeTask(service)).issue.identifier, "APP-1");
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect(
  "a start without options keeps the mode the person last chose, and so does a revision",
  () =>
    Effect.gen(function* () {
      const h = harness();
      const service = yield* h.initialize;
      yield* service.configure(config);
      yield* service.control({
        projectId: config.projectId,
        action: "start",
        options: { autoPick: false, assignedToMe: false },
      });
      yield* service.control({ projectId: config.projectId, action: "pause" });
      // An older client sends no options at all.
      const started = yield* service.control({ projectId: config.projectId, action: "start" });
      assert.isFalse(started.projects[0]?.config.autoPick);
      assert.isFalse(started.projects[0]?.config.assignedToMe);
      assert.lengthOf(h.listed, 0);
      // A setup revision carries no picking choice, but does carry the Linear scope.
      yield* service.control({ projectId: config.projectId, action: "pause" });
      const revised = yield* service.configure({ ...config, maxWorkerTurns: 3 });
      assert.isFalse(revised.projects[0]?.config.autoPick);
      assert.isTrue(revised.projects[0]?.config.assignedToMe);
      assert.equal(revised.projects[0]?.config.maxWorkerTurns, 3);
    }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("with picking off, only a dispatched issue's rework goes back to a team", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service } = yield* h.setup;
    // Delivered while the loop still picked issues itself.
    const own = yield* takeIssue(h, service);
    yield* deliverIssue(h, service, own);
    yield* service.control({
      projectId: config.projectId,
      action: "start",
      options: { autoPick: false, assignedToMe: true },
    });
    yield* service.dispatch({ projectId: config.projectId, reference: "APP-2", note: "" });
    const dispatched = yield* takeIssue(h, service);
    assert.equal(dispatched.issue.identifier, "APP-2");
    yield* deliverIssue(h, service, dispatched);
    // The loop's own pick stays put; the person's issue is reworked.
    yield* service.review({ taskId: own.id, action: "request-changes", feedback: "Bigger." });
    yield* service.scan();
    assert.isUndefined(yield* activeTask(service));
    yield* service.review({
      taskId: dispatched.id,
      action: "request-changes",
      feedback: "Port the newer design.",
    });
    yield* service.scan();
    const rework = yield* activeTask(service);
    assert.equal(rework.issue.identifier, "APP-2");
    assert.isTrue(rework.dispatched);
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("with the loop never started, dispatching is the only way in", () =>
  Effect.gen(function* () {
    const h = harness();
    const service = yield* h.initialize;
    yield* service.configure(config);
    // Stopped: a dispatched issue waits until the person resumes the teams.
    yield* service.dispatch({ projectId: config.projectId, reference: "APP-2", note: "" });
    assert.isUndefined(yield* activeTask(service));
    const resumed = yield* service.control({ projectId: config.projectId, action: "pause" });
    assert.equal(resumed.projects[0]?.status, "paused");
    const team = yield* activeTask(service);
    assert.equal(team.issue.identifier, "APP-2");
    yield* service.review({ taskId: team.id, action: "skip", feedback: "Later" });
    yield* service.scan();
    assert.isUndefined(yield* activeTask(service));
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("a leader that ends its turn without a next step is nudged once, then blocked", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service } = yield* h.setup;
    const team = yield* activeTask(service);
    const lead = leadOf(team);
    yield* service.deliver();
    yield* endTurn(h, service, lead);
    yield* service.deliver();
    assert.include(turnsOf(h, lead).at(-1), "You ended your turn with the issue still yours");
    // A turn that answered the person is not a stall.
    h.messages.set(lead, [
      ...(h.messages.get(lead) ?? []),
      {
        id: MessageId.make("person"),
        role: "user",
        text: "What is left?",
        turnId: null,
        streaming: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ]);
    yield* endTurn(h, service, lead);
    assert.equal((yield* taskById(service, team.id)).status, "working");
    h.messages.set(lead, (h.messages.get(lead) ?? []).slice(0, -1));
    yield* endTurn(h, service, lead);
    const blocked = yield* taskById(service, team.id);
    assert.equal(blocked.status, "blocked");
    assert.include(blocked.error ?? "", "without a next step");
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("retains ownership and queued turns across service recreation", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service } = yield* h.setup;
    const first = yield* takeIssue(h, service);
    const restarted = yield* h.make;
    assert.equal((yield* restarted.board(null)).tasks[0]?.id, first.id);
    yield* restarted.scan();
    assert.lengthOf((yield* restarted.board(null)).tasks, 1);
    yield* restarted.deliver();
    yield* restarted.deliver();
    const starts = h.commands.filter(
      (c) => c.type === "thread.turn.start" && c.threadId === first.threadId,
    );
    assert.lengthOf(starts, 1);
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("answers a decision exactly once in its worker and prevents unattended guessing", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service, caller } = yield* h.setup;
    const first = yield* takeIssue(h, service);
    yield* service.deliver();
    h.finish(first.threadId);
    const decision = yield* service.askDecision(
      first.threadId,
      "Should existing users keep access?",
    );
    assert.equal(decision.taskId, first.id);
    assert.isTrue(
      yield* service.messageWorker(caller, first.id, "Just guess").pipe(Effect.isFailure),
    );
    assert.isTrue(yield* service.verifyStaging(caller, first.id).pipe(Effect.isFailure));
    yield* service.answer({ decisionId: decision.id, answer: "Keep existing access." });
    yield* service.answer({ decisionId: decision.id, answer: "Duplicate" });
    yield* service.deliver();
    const replies = h.commands.filter(
      (c) => c.type === "thread.turn.start" && c.message.text.includes("Keep existing access."),
    );
    assert.lengthOf(replies, 1);
    assert.equal((yield* service.board(null)).decisions[0]?.answer, "Keep existing access.");
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("a reviewer's question is answered in the reviewer's thread", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service } = yield* h.setup;
    const first = yield* takeIssue(h, service);
    const reviewer = assistantTaskThreadId(first, "review");
    yield* service.deliver();
    yield* service.requestReview(first.threadId, "Ready");
    yield* endTurn(h, service, first.threadId);
    yield* service.deliver();
    const decision = yield* service.askDecision(reviewer, "Is the old endpoint still used?");
    assert.equal(decision.taskId, first.id);
    yield* endTurn(h, service, reviewer);
    yield* service.answer({ decisionId: decision.id, answer: "No, remove it." });
    yield* service.deliver();
    assert.include(turnsOf(h, reviewer).at(-1), "No, remove it.");
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("the assistant passes on an answer the person gave in its chat, and only then", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service, caller } = yield* h.setup;
    const first = yield* takeIssue(h, service);
    yield* service.deliver();
    h.finish(first.threadId);
    const decision = yield* service.askDecision(first.threadId, "Fix the XSS here or separately?");
    const at = (offset: number) =>
      DateTime.formatIso(DateTime.makeUnsafe(Date.parse(decision.createdAt) + offset));
    const message = (id: string, createdAt: string): OrchestrationMessage => ({
      id: MessageId.make(id),
      role: "user",
      text: "Go with your recommendation.",
      turnId: null,
      streaming: false,
      createdAt,
      updatedAt: createdAt,
    });
    const relay = service.relayAnswer(caller, decision.id, "Fix it in this PR.");

    // An earlier message, or one T3 sent itself, is not the person answering.
    const wake = h.commands.findLast(
      (c) => c.type === "thread.turn.start" && c.threadId === caller,
    );
    h.messages.set(caller, [
      message("before-the-question", at(-1000)),
      message(wake?.type === "thread.turn.start" ? wake.message.messageId : "missing", at(1000)),
    ]);
    assert.isTrue(yield* relay.pipe(Effect.isFailure));
    assert.isTrue(
      yield* service.relayAnswer(first.threadId, decision.id, "Anything").pipe(Effect.isFailure),
    );

    h.messages.set(caller, [message("person", at(1000))]);
    const relayed = yield* relay;
    assert.equal(relayed.answer, "Fix it in this PR.");
    const board = yield* service.board(null);
    assert.equal(board.tasks[0]?.status, "working");
    assert.isTrue(yield* relay.pipe(Effect.isFailure));
    yield* service.deliver();
    const reply = h.commands.findLast(
      (c) => c.type === "thread.turn.start" && c.threadId === first.threadId,
    );
    assert.include(
      reply?.type === "thread.turn.start" ? reply.message.text : "",
      "through the developer assistant.\nQuestion: Fix the XSS here or separately?\nAnswer: Fix it in this PR.",
    );
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect(
  "a thread that handed off is released when its leftover background work holds the team",
  () =>
    Effect.gen(function* () {
      const h = harness();
      const { service } = yield* h.setup;
      const t = yield* takeIssue(h, service);
      const reviewer = assistantTaskThreadId(t, "review");
      yield* service.deliver();
      yield* service.requestReview(t.threadId, "Ready for review: PR #1");
      yield* endTurn(h, service, t.threadId);
      yield* service.deliver();
      yield* service.submitReview(reviewer, "changes-requested", "Missing a test.", "One gap.");
      // The reviewer's turn ends with a watch loop still running in its session.
      yield* endTurn(h, service, reviewer);
      h.threads.set(reviewer, { ...h.threads.get(reviewer)!, backgroundLiveness: "monitoring" });
      const before = turnsOf(h, t.threadId).length;
      yield* service.deliver();
      // The handoff waits for the reviewer, whose session is released rather than waited on.
      assert.equal(turnsOf(h, t.threadId).length, before);
      assert.deepEqual(h.stopped, [reviewer]);
      // The provider reports the released session; that is no failure of the team's.
      yield* service.observe({
        ...eventBase(reviewer),
        type: "thread.session-set",
        payload: {
          threadId: reviewer,
          session: {
            threadId: reviewer,
            status: "stopped",
            providerName: "test",
            activeTurnId: null,
            runtimeMode: "approval-required",
            lastError: null,
            updatedAt: timestamp,
          },
        },
      });
      yield* service.deliver();
      assert.include(turnsOf(h, t.threadId).at(-1), "Code review requested changes");
      const after = yield* taskById(service, t.id);
      assert.equal(after.status, "working");
      assert.equal(after.stage, "implement");
      assert.isNull(after.error);
      // The thread that holds the issue keeps its background work.
      h.threads.set(t.threadId, { ...h.threads.get(t.threadId)!, backgroundLiveness: "working" });
      yield* service.deliver();
      assert.deepEqual(h.stopped, [reviewer]);
    }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("a waiting thread's idle session being released does not block its issue", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service } = yield* h.setup;
    const first = yield* takeIssue(h, service);
    yield* service.deliver();
    yield* service.askDecision(first.threadId, "Which copy?");
    yield* endTurn(h, service, first.threadId);
    const stop = (state: "completed" | "running") =>
      Effect.gen(function* () {
        const thread = h.threads.get(first.threadId)!;
        h.threads.set(first.threadId, {
          ...thread,
          latestTurn: {
            turnId: TurnId.make("turn-1"),
            state,
            requestedAt: timestamp,
            startedAt: timestamp,
            completedAt: state === "completed" ? timestamp : null,
            assistantMessageId: null,
          },
        });
        yield* service.observe({
          ...eventBase(first.threadId),
          type: "thread.session-set",
          payload: {
            threadId: first.threadId,
            session: {
              threadId: first.threadId,
              status: "stopped",
              providerName: "test",
              activeTurnId: null,
              runtimeMode: "approval-required",
              lastError: null,
              updatedAt: timestamp,
            },
          },
        });
        return yield* taskById(service, first.id);
      });

    const released = yield* stop("completed");
    assert.equal(released.status, "waiting");
    assert.isNull(released.error);
    // Stopped mid-turn is still a failure its team leader hears about.
    const cut = yield* stop("running");
    assert.equal(cut.status, "blocked");
    assert.equal(cut.stage, "lead");
    // The projection settles the cut turn once its session stops.
    const thread = h.threads.get(first.threadId)!;
    h.threads.set(first.threadId, {
      ...thread,
      latestTurn: { ...thread.latestTurn!, state: "interrupted" },
    });
    yield* service.deliver();
    assert.include(turnsOf(h, leadOf(first)).at(-1), "The worker for APP-1 is stopped");
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("interrupting holds every team until the person resumes it", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service } = yield* h.setup;
    const team = yield* activeTask(service);
    yield* service.control({ projectId: config.projectId, action: "interrupt" });
    yield* service.deliver();
    assert.lengthOf(
      h.commands.filter((c) => c.type === "thread.turn.start"),
      0,
    );
    yield* service.scan();
    assert.lengthOf((yield* service.board(null)).tasks, 1);
    assert.equal((yield* taskById(service, team.id)).status, "blocked");
    // Resuming the teams without the loop picks the issue back up.
    yield* service.control({ projectId: config.projectId, action: "pause" });
    yield* service.deliver();
    assert.lengthOf(turnsOf(h, leadOf(team)), 1);
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("review feedback gives the issue to a new team and never rolls back later work", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service } = yield* h.setup;
    const first = yield* takeIssue(h, service);
    yield* deliverIssue(h, service, first);
    yield* service.review({
      taskId: first.id,
      action: "request-changes",
      feedback: "Make the button clearer.",
    });
    // Sent-back work goes ahead of new issues.
    yield* service.scan();
    const followup = yield* activeTask(service);
    assert.equal(followup.issue.id, first.issue.id);
    assert.notEqual(followup.threadId, first.threadId);
    assert.equal(followup.feedback, "Make the button clearer.");
    assert.equal((yield* taskById(service, first.id)).status, "changes-requested");
    yield* service.deliver();
    assert.include(turnsOf(h, leadOf(followup))[0], "Make the button clearer.");
    const taken = yield* takeIssue(h, service, "Clearer button");
    yield* service.deliver();
    assert.include(turnsOf(h, taken.threadId)[0], "Previous review feedback:\nMake the button");
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("enforces the turn limit and an explicit retry does not reuse old command ids", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service, caller } = yield* h.setup;
    const first = yield* takeIssue(h, service);
    const lead = leadOf(first);
    yield* service.deliver();
    h.finish(first.threadId);
    yield* service.messageWorker(caller, first.id, "Fix review feedback");
    yield* service.deliver();
    h.finish(first.threadId);
    assert.isTrue(yield* service.messageWorker(caller, first.id, "Again").pipe(Effect.isFailure));
    yield* service.review({ taskId: first.id, action: "retry", feedback: "Allow another attempt" });
    yield* service.deliver();
    assert.include(turnsOf(h, lead).at(-1), "The person allowed more rounds for APP-1");
    // The leader sends the next round from its own turn.
    yield* service.messageWorker(lead, undefined, "One more attempt");
    yield* endTurn(h, service, lead);
    yield* service.deliver();
    assert.lengthOf(turnsOf(h, first.threadId), 3);
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("skipping closes decisions, cancels queued work and frees the project", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service } = yield* h.setup;
    const first = yield* takeIssue(h, service);
    yield* service.askDecision(first.threadId, "Need a choice");
    yield* service.review({ taskId: first.id, action: "skip", feedback: "Later" });
    yield* service.deliver();
    assert.lengthOf(
      (yield* service.board(null)).decisions.filter((d) => d.answer === null),
      0,
    );
    assert.lengthOf(turnsOf(h, first.threadId), 0);
    yield* service.scan();
    assert.equal((yield* activeTask(service)).issue.identifier, "APP-2");
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("refuses a second project record for the same Git repository", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service } = yield* h.setup;
    assert.isTrue(
      yield* service
        .configure({ ...config, projectId: ProjectId.make("same-repo") })
        .pipe(Effect.isFailure),
    );
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("a pending provider start blocks duplicate delivery and staging acceptance", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service, caller } = yield* h.setup;
    const first = yield* takeIssue(h, service);
    h.pendingStarts.add(first.threadId);
    yield* service.deliver();
    assert.lengthOf(turnsOf(h, first.threadId), 0);
    assert.isTrue(
      yield* service.messageWorker(caller, first.id, "More work").pipe(Effect.isFailure),
    );
    assert.isTrue(yield* service.verifyStaging(caller, first.id).pipe(Effect.isFailure));
    h.pendingStarts.delete(first.threadId);
    yield* service.deliver();
    assert.lengthOf(turnsOf(h, first.threadId), 1);
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("a team whose worktree could not be prepared is retried from the board", () =>
  Effect.gen(function* () {
    const h = harness();
    const service = yield* h.initialize;
    yield* service.configure(config);
    h.setSetupHealthy(false);
    const board = yield* service.control({ projectId: config.projectId, action: "start" });
    const blocked = board.tasks[0]!;
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.turns, 0);
    yield* service.scan();
    assert.lengthOf((yield* service.board(null)).tasks, 1);
    h.setSetupHealthy(true);
    yield* service.review({ taskId: blocked.id, action: "retry", feedback: "" });
    const recovered = yield* taskById(service, blocked.id);
    assert.equal(recovered.status, "working");
    assert.isTrue(h.threads.has(leadOf(recovered)));
    assert.lengthOf((yield* service.board(null)).tasks, 1);
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("serializes concurrent issue starts", () =>
  Effect.gen(function* () {
    const h = harness();
    const service = yield* h.initialize;
    yield* service.configure(config);
    yield* Effect.all(
      [
        service.control({ projectId: config.projectId, action: "start" }),
        service.scan(),
        service.scan(),
      ],
      { concurrency: "unbounded" },
    );
    assert.lengthOf((yield* service.board(null)).tasks, 1);
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("bounds external progress checks, blocking the issue and not the project", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service, caller } = yield* h.setup;
    const task = yield* activeTask(service);
    const lead = leadOf(task);
    for (let i = 0; i < 15; i++)
      assert.equal((yield* service.waitForExternal(lead, "Deploy is pending")).outcome, "waiting");
    assert.equal((yield* service.waitForExternal(lead, "Deploy is pending")).outcome, "limit");
    // Only the issue that waited is held; the loop and the person's other work run on.
    const board = yield* service.board(null);
    assert.equal(board.projects[0]?.status, "running");
    const blocked = board.tasks.find((t) => t.id === task.id)!;
    assert.equal(blocked.status, "blocked");
    assert.include(blocked.error!, "15 checks");
    // Retrying from the board gives the team its checks back.
    yield* service.review({ taskId: task.id, action: "retry", feedback: "Staging is up." });
    assert.equal((yield* service.waitForExternal(lead, "One more check")).outcome, "waiting");
    assert.equal((yield* service.board(null)).projects[0]?.status, "running");
    // The scan brings the wait back to the leader, not the assistant. Its start
    // and the retry go first; each queued turn is delivered and finished.
    for (const _ of [1, 2]) {
      yield* service.deliver();
      h.finish(lead);
    }
    yield* service.scan();
    assert.include(turnsOf(h, lead).at(-1), "Waiting: One more check");
    // Work from before team leaders has only the assistant to stop.
    let outcome = "waiting";
    while (outcome === "waiting")
      outcome = (yield* service.waitForExternal(caller, "Deploy is pending")).outcome;
    assert.equal(outcome, "stopped");
    const stopped = (yield* service.board(null)).projects[0]!;
    assert.equal(stopped.status, "stopped");
    assert.include(stopped.error!, "15 checks");
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("replaces a deleted assistant thread without losing its active issue", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service, caller } = yield* h.setup;
    const first = yield* activeTask(service);
    yield* service.control({ projectId: config.projectId, action: "pause" });
    h.threads.delete(caller);
    const restarted = yield* service.control({ projectId: config.projectId, action: "start" });
    assert.notEqual(restarted.projects[0]?.threadId, caller);
    assert.equal(restarted.tasks[0]?.id, first.id);
    assert.isTrue(yield* service.getAgentBoard(caller).pipe(Effect.isFailure));
  }).pipe(Effect.provide(database()), Effect.scoped),
);

const eventBase = (threadId: ThreadId) => ({
  sequence: 100,
  eventId: EventId.make("test-event"),
  aggregateKind: "thread" as const,
  aggregateId: threadId,
  occurredAt: timestamp,
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
});

it.effect("deleting a setup thread releases the project for another conversation", () =>
  Effect.gen(function* () {
    const h = harness();
    const service = yield* h.initialize;
    const draft = yield* service.beginSetup(setupInput);
    h.threads.delete(draft.threadId);
    yield* service.observe({
      ...eventBase(draft.threadId),
      type: "thread.deleted",
      payload: { threadId: draft.threadId, deletedAt: timestamp },
    });
    assert.lengthOf((yield* service.board(null)).setups ?? [], 0);
    assert.notEqual((yield* service.beginSetup(setupInput)).threadId, draft.threadId);
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("resuming setup restores its archived conversation", () =>
  Effect.gen(function* () {
    const h = harness();
    const service = yield* h.initialize;
    const draft = yield* service.beginSetup(setupInput);
    h.finish(draft.threadId);
    h.threads.set(draft.threadId, { ...h.threads.get(draft.threadId)!, archivedAt: timestamp });
    assert.equal((yield* service.beginSetup(setupInput)).threadId, draft.threadId);
    assert.isNull(h.threads.get(draft.threadId)?.archivedAt);
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("starting after the assistant was archived restores its conversation", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service, caller } = yield* h.setup;
    yield* service.review({
      taskId: (yield* activeTask(service)).id,
      action: "skip",
      feedback: "Not now",
    });
    h.finish(caller);
    h.threads.set(caller, { ...h.threads.get(caller)!, archivedAt: timestamp });
    yield* service.observe({
      ...eventBase(caller),
      type: "thread.archived",
      payload: { threadId: caller, archivedAt: timestamp, updatedAt: timestamp },
    });
    assert.equal((yield* service.board(null)).projects[0]?.status, "stopped");
    yield* service.configure({ ...config, maxWorkerTurns: 4 });
    assert.equal((yield* service.board(null)).projects[0]?.threadId, caller);
    const board = yield* service.control({ projectId: config.projectId, action: "start" });
    assert.equal(board.projects[0]?.threadId, caller);
    assert.equal(board.projects[0]?.status, "running");
    assert.isNull(h.threads.get(caller)?.archivedAt);
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("verifies staging for a worker the person already archived", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service } = yield* h.setup;
    const first = yield* takeIssue(h, service);
    yield* reachMerge(h, service, first);
    h.threads.set(first.threadId, { ...h.threads.get(first.threadId)!, archivedAt: timestamp });
    yield* leadToE2e(h, service, first);
    const tester = assistantTaskThreadId(first, "e2e");
    const delivered = yield* service.submitE2e(tester, {
      verdict: "passed",
      report: "- The page loads: passed",
      humanChecks: [],
      screenshots: [],
    });
    yield* endTurn(h, service, tester);
    assert.equal(delivered.status, "review");
    // A thread the person archived is left alone when its team closes.
    assert.lengthOf(
      h.commands.filter((c) => c.type === "thread.settle" && c.threadId === first.threadId),
      0,
    );
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("interrupting a team whose worktree setup failed stops the project", () =>
  Effect.gen(function* () {
    const h = harness();
    const service = yield* h.initialize;
    yield* service.configure(config);
    h.setSetupHealthy(false);
    yield* service.control({ projectId: config.projectId, action: "start" });
    const board = yield* service.control({ projectId: config.projectId, action: "interrupt" });
    assert.equal(board.projects[0]?.status, "stopped");
    assert.equal(board.tasks[0]?.status, "blocked");
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("a provider request that expired before it was answered closes its decision", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service, caller } = yield* h.setup;
    const activity = (kind: string, detail?: string) => ({
      ...eventBase(caller),
      type: "thread.activity-appended" as const,
      payload: {
        threadId: caller,
        activity: {
          id: EventId.make(kind),
          kind,
          summary: "Approve the command",
          tone: "approval" as const,
          turnId: null,
          createdAt: timestamp,
          payload: { requestId: "approval-1", ...(detail ? { detail } : {}) },
        },
      },
    });
    yield* service.observe(activity("approval.requested"));
    yield* service.observe(activity("provider.approval.respond.failed", "Provider unavailable"));
    assert.isNull((yield* service.board(null)).decisions[0]?.answer);
    yield* service.observe(
      activity("provider.approval.respond.failed", "Stale pending approval request: approval-1"),
    );
    assert.equal(
      (yield* service.board(null)).decisions[0]?.answer,
      "The request expired before it was answered",
    );
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect(
  "routes provider questions to their thread and tells the leader when the worker stops",
  () =>
    Effect.gen(function* () {
      const h = harness();
      const { service, caller } = yield* h.setup;
      const first = yield* takeIssue(h, service);
      yield* service.deliver();
      yield* service.observe({
        ...eventBase(first.threadId),
        type: "thread.activity-appended",
        payload: {
          threadId: first.threadId,
          activity: {
            id: EventId.make("request"),
            kind: "user-input.requested",
            summary: "Choose the behavior",
            tone: "approval",
            turnId: null,
            createdAt: timestamp,
            payload: { requestId: "request-1" },
          },
        },
      });
      const question = (yield* service.board(null)).decisions[0]!;
      assert.equal(question.kind, "user-input");
      assert.equal((yield* taskById(service, first.id)).status, "waiting");
      assert.isTrue(
        yield* service
          .answer({ decisionId: question.id, answer: "Bypass provider" })
          .pipe(Effect.isFailure),
      );
      yield* service.observe({
        ...eventBase(first.threadId),
        type: "thread.activity-appended",
        payload: {
          threadId: first.threadId,
          activity: {
            id: EventId.make("resolved"),
            kind: "user-input.resolved",
            summary: "Answered",
            tone: "info",
            turnId: null,
            createdAt: timestamp,
            payload: { requestId: "request-1" },
          },
        },
      });
      assert.equal((yield* service.board(null)).decisions[0]?.answer, "Answered in the thread");
      yield* endTurn(h, service, first.threadId);
      yield* service.deliver();
      assert.include(turnsOf(h, leadOf(first)).at(-1), "ended its turn without handing off");
      assert.equal((yield* taskById(service, first.id)).status, "working");
      // None of it needed the assistant.
      assert.lengthOf(turnsOf(h, caller), 1);
    }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("accepts a decision reply in the original thread without dispatching it twice", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service } = yield* h.setup;
    const first = yield* takeIssue(h, service);
    yield* service.deliver();
    yield* service.askDecision(first.threadId, "Keep existing access?");
    yield* service.observe({
      ...eventBase(first.threadId),
      type: "thread.message-sent",
      payload: {
        threadId: first.threadId,
        messageId: MessageId.make("human-reply"),
        role: "user",
        text: "Yes, keep it.",
        attachments: [],
        turnId: null,
        streaming: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    });
    assert.equal((yield* service.board(null)).decisions[0]?.answer, "Yes, keep it.");
    h.finish(first.threadId);
    yield* service.deliver();
    assert.lengthOf(turnsOf(h, first.threadId), 1);
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect(
  "parks automatic work until activation and replays unanswered questions before delivery",
  () =>
    Effect.gen(function* () {
      const h = harness();
      const { service, caller } = yield* h.setup;
      const first = yield* activeTask(service);
      const lead = leadOf(first);
      h.replayEvents.push({
        ...eventBase(lead),
        type: "thread.activity-appended",
        payload: {
          threadId: lead,
          activity: {
            id: EventId.make("recovered-question"),
            kind: "user-input.requested",
            summary: "A question retained across restart",
            tone: "approval",
            turnId: null,
            createdAt: timestamp,
            payload: { requestId: "recovered-request" },
          },
        },
      });
      const activation = yield* Deferred.make<void>();
      const resumed = yield* Deferred.make<void>();
      // Start's wake for the assistant is still undelivered: its turn marks delivery.
      h.onDispatch((command) =>
        command.type === "thread.turn.start" && command.threadId === caller
          ? Deferred.succeed(resumed, undefined).pipe(Effect.asVoid)
          : Effect.void,
      );
      const restarted = yield* h.makeWithWorkers.pipe(
        Effect.provideService(ServerActivation, Deferred.await(activation)),
      );
      assert.lengthOf(
        h.commands.filter((c) => c.type === "thread.turn.start"),
        0,
      );
      yield* Deferred.succeed(activation, undefined);
      yield* Deferred.await(resumed);
      const board = yield* restarted.board(null);
      assert.equal(board.decisions[0]?.question, "A question retained across restart");
      assert.equal(board.tasks[0]?.status, "waiting");
      assert.lengthOf(turnsOf(h, lead), 0);
    }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("sends the assistant its instructions once, and again after compaction", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service, caller } = yield* h.setup;
    const briefing = "You are the developer assistant for this project";
    const compaction = (state: string) =>
      service.observe({
        ...eventBase(caller),
        type: "thread.activity-appended",
        payload: {
          threadId: caller,
          activity: {
            id: EventId.make(`compaction-${state}`),
            kind: "context-compaction",
            summary: "Context compacted",
            tone: "info",
            turnId: null,
            createdAt: timestamp,
            payload: { state },
          },
        },
      });
    yield* service.deliver();
    assert.include(turnsOf(h, caller)[0], briefing);
    h.finish(caller);
    yield* compaction("compacting");
    yield* service.deliver();
    assert.lengthOf(turnsOf(h, caller), 1);
    // The assistant is not woken by the loop, so compaction restores its instructions at once.
    yield* compaction("compacted");
    yield* service.deliver();
    assert.include(turnsOf(h, caller).at(-1), briefing);
    assert.include(turnsOf(h, caller).at(-1), "Your conversation was compacted");
    h.finish(caller);
    const question = yield* service.askDecision(caller, "Which issue should go first?");
    yield* service.answer({ decisionId: question.id, answer: "APP-2" });
    yield* service.deliver();
    assert.notInclude(turnsOf(h, caller).at(-1), briefing);
    assert.include(turnsOf(h, caller).at(-1), "APP-2");
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("an idle provider session stopping does not disable the persistent assistant", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service, caller } = yield* h.setup;
    yield* service.observe({
      ...eventBase(caller),
      type: "thread.session-set",
      payload: {
        threadId: caller,
        session: {
          threadId: caller,
          status: "stopped",
          providerName: "test",
          activeTurnId: null,
          runtimeMode: "approval-required",
          lastError: null,
          updatedAt: timestamp,
        },
      },
    });
    assert.equal((yield* service.board(null)).projects[0]?.status, "running");
    yield* service.dispatchFromAssistant(caller, "APP-2", "");
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("the implementer and reviewer trade rounds without the team leader", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service } = yield* h.setup;
    const first = yield* takeIssue(h, service);
    const lead = leadOf(first);
    const reviewer = assistantTaskThreadId(first, "review");
    yield* service.deliver();
    const before = turnsOf(h, lead).length;

    // The implementer asks mid-turn; the reviewer starts only once that turn ends.
    yield* service.requestReview(first.threadId, "Ready: PR #1");
    yield* service.deliver();
    assert.lengthOf(turnsOf(h, reviewer), 0);
    yield* endTurn(h, service, first.threadId);
    yield* service.deliver();
    const created = h.threads.get(reviewer)!;
    assert.equal(created.worktreePath, `/worktrees/${first.threadId}`);
    assert.equal(created.linkedIssue?.identifier, "APP-1");
    assert.include(turnsOf(h, reviewer)[0], "You are the code reviewer");
    assert.include(turnsOf(h, reviewer)[0], "Ready: PR #1");

    const sent = yield* service.submitReview(
      reviewer,
      "changes-requested",
      "app.ts:3 is wrong",
      "",
    );
    assert.equal(sent.turns, 2);
    assert.equal(sent.stage, "implement");
    yield* endTurn(h, service, reviewer);
    yield* service.deliver();
    assert.include(turnsOf(h, first.threadId).at(-1), "app.ts:3 is wrong");

    // A re-review is the request alone; the thread already has its instructions.
    yield* service.requestReview(first.threadId, "Fixed app.ts:3");
    yield* endTurn(h, service, first.threadId);
    yield* service.deliver();
    assert.notInclude(turnsOf(h, reviewer).at(-1), "You are the code reviewer");
    assert.lengthOf(turnsOf(h, lead), before);

    yield* service.submitReview(reviewer, "approved", "Merge it.", "Checked the fix.");
    yield* endTurn(h, service, reviewer);
    yield* service.deliver();
    yield* service.reportMerged(first.threadId, "The page loads again.");
    yield* endTurn(h, service, first.threadId);
    yield* service.deliver();
    assert.lengthOf(turnsOf(h, lead), before + 1);
    assert.include(turnsOf(h, lead).at(-1), "merged into its integration branch");
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("only the approved commit can be merged, and staging checks that commit", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service, caller } = yield* h.setup;
    const first = yield* takeIssue(h, service);
    const lead = leadOf(first);
    const reviewer = assistantTaskThreadId(first, "review");
    yield* service.deliver();
    assert.isTrue(yield* service.reportMerged(first.threadId, "Early").pipe(Effect.isFailure));
    assert.isTrue(
      yield* service.submitReview(reviewer, "approved", "Not asked", "").pipe(Effect.isFailure),
    );
    yield* service.requestReview(first.threadId, "Ready");
    yield* endTurn(h, service, first.threadId);
    yield* service.deliver();
    // Neither the assistant, the leader nor the implementer can approve the work.
    for (const self of [caller, lead, first.threadId])
      assert.isTrue(
        yield* service.submitReview(self, "approved", "Self", "").pipe(Effect.isFailure),
      );
    const approved = h.git.head;
    yield* service.submitReview(reviewer, "approved", "Merge it.", "Checked the fix.");
    yield* endTurn(h, service, reviewer);
    yield* service.deliver();
    h.git.head = "c".repeat(40);
    assert.isTrue(yield* service.reportMerged(first.threadId, "Moved").pipe(Effect.isFailure));
    h.git.head = approved;
    h.git.merged = false;
    assert.isTrue(yield* service.reportMerged(first.threadId, "Unmerged").pipe(Effect.isFailure));
    assert.isTrue(yield* service.verifyStaging(lead, undefined).pipe(Effect.isFailure));
    h.git.merged = true;
    yield* service.reportMerged(first.threadId, "The page loads again.");
    yield* endTurn(h, service, first.threadId);
    yield* service.verifyStaging(lead, undefined);
    assert.equal(h.verified.at(-1)?.expectedRevision, approved);
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("a pair that runs out of rounds goes back to the team leader", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service } = yield* h.setup;
    const first = yield* takeIssue(h, service);
    const reviewer = assistantTaskThreadId(first, "review");
    yield* service.deliver();
    for (const round of [1, 2]) {
      yield* service.requestReview(first.threadId, `Round ${round}`);
      yield* endTurn(h, service, first.threadId);
      yield* service.deliver();
      yield* service.submitReview(reviewer, "changes-requested", `Still wrong ${round}`, "");
      yield* endTurn(h, service, reviewer);
      yield* service.deliver();
    }
    const stuck = yield* taskById(service, first.id);
    assert.equal(stuck.status, "blocked");
    assert.equal(stuck.stage, "lead");
    assert.include(turnsOf(h, leadOf(first)).at(-1), "is blocked");
    // The implementer received only the rounds it was allowed.
    assert.isFalse(
      h.commands.some(
        (c) => c.type === "thread.turn.start" && c.message.text.includes("Still wrong 2"),
      ),
    );
    // A blocked issue waits for the person; its leader is not nudged.
    const told = turnsOf(h, leadOf(first)).length;
    yield* endTurn(h, service, leadOf(first));
    yield* service.deliver();
    assert.lengthOf(turnsOf(h, leadOf(first)), told);
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("a thread that stops without handing off returns the issue to its team leader", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service } = yield* h.setup;
    const first = yield* takeIssue(h, service);
    const lead = leadOf(first);
    yield* service.deliver();
    const before = turnsOf(h, lead).length;
    yield* endTurn(h, service, first.threadId);
    yield* service.deliver();
    assert.equal((yield* taskById(service, first.id)).stage, "lead");
    assert.lengthOf(turnsOf(h, lead), before + 1);
    assert.include(turnsOf(h, lead).at(-1), "ended its turn without handing off");
    // A question to the person is not a stall.
    yield* service.messageWorker(lead, undefined, "Keep going");
    yield* endTurn(h, service, lead);
    yield* service.deliver();
    const asked = turnsOf(h, lead).length;
    yield* service.askDecision(first.threadId, "Which copy?");
    yield* endTurn(h, service, first.threadId);
    yield* service.deliver();
    assert.equal((yield* taskById(service, first.id)).stage, "implement");
    assert.lengthOf(turnsOf(h, lead), asked);
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect(
  "a failed e2e run goes back to the team leader and a new review voids the deployment",
  () =>
    Effect.gen(function* () {
      const h = harness();
      const { service } = yield* h.setup;
      const first = yield* takeIssue(h, service);
      const lead = leadOf(first);
      const tester = assistantTaskThreadId(first, "e2e");
      yield* reachMerge(h, service, first);
      yield* service.deliver();
      assert.isTrue(yield* service.startE2e(lead, undefined, "Too early").pipe(Effect.isFailure));
      yield* service.verifyStaging(lead, undefined);
      yield* service.startE2e(lead, undefined, "Open the page.");
      yield* endTurn(h, service, lead);
      yield* service.deliver();
      assert.include(turnsOf(h, tester).at(-1), `/evidence/${first.id}`);
      assert.include(turnsOf(h, tester).at(-1), "Brief from the team leader");
      const failed = yield* service.submitE2e(tester, {
        verdict: "failed",
        report: "- The page loads: failed, it shows a 500",
        humanChecks: [],
        screenshots: [{ path: `/evidence/${first.id}/error.png`, caption: "The 500 page" }],
      });
      assert.equal(failed.status, "working");
      assert.match(h.comments.at(-1)!.body, /^\*\*❌ Failed on staging/);
      assert.notInclude(h.comments.at(-1)!.body, "To accept");
      // Nothing shipped, so the issue's description is left alone.
      assert.lengthOf(h.descriptions, 0);
      yield* endTurn(h, service, tester);
      yield* service.deliver();
      assert.include(turnsOf(h, lead).at(-1), "failed its e2e check");
      assert.deepEqual(h.transitions, []);

      yield* service.messageWorker(lead, undefined, "Fix the 500 on the page.");
      yield* endTurn(h, service, lead);
      yield* service.deliver();
      const fixing = yield* service.requestReview(first.threadId, "Fixed the 500");
      assert.isNull(fixing.merge ?? null);
      assert.isNull(fixing.deployment);
      assert.isTrue(yield* service.startE2e(lead, undefined, "Again").pipe(Effect.isFailure));
    }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("screenshots must come from the issue's evidence folder", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service } = yield* h.setup;
    const first = yield* takeIssue(h, service);
    const tester = assistantTaskThreadId(first, "e2e");
    yield* reachMerge(h, service, first);
    yield* leadToE2e(h, service, first);
    const comments = h.comments.length;
    const attempt = yield* service
      .submitE2e(tester, {
        verdict: "passed",
        report: "- The page loads: passed",
        humanChecks: [],
        screenshots: [
          { path: `/evidence/${first.id}/page.png`, caption: "Page" },
          { path: "/home/me/.ssh/id_rsa.png", caption: "Not evidence" },
        ],
      })
      .pipe(Effect.flip);
    assert.include(attempt.detail, "outside");
    assert.lengthOf(h.uploads, 0);
    assert.lengthOf(h.comments, comments);
    assert.isTrue(
      yield* service
        .submitE2e(tester, {
          verdict: "partial",
          report: "- Email: not checked",
          humanChecks: [],
          screenshots: [],
        })
        .pipe(Effect.isFailure),
    );
    assert.equal((yield* taskById(service, first.id)).status, "working");
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect(
  "a decision on the Linear card flows back: Done accepts, moving it back asks for changes",
  () =>
    Effect.gen(function* () {
      const h = harness();
      const { service } = yield* h.setup;
      const first = yield* takeIssue(h, service);
      const delivered = yield* deliverIssue(h, service, first);
      yield* service.control({ projectId: config.projectId, action: "wake" });
      const second = yield* takeIssue(h, service);
      assert.equal(second.issue.identifier, "APP-2");
      yield* deliverIssue(h, service, second);
      const later = "2999-01-01T00:00:00.000Z";
      const person = { id: "me", name: "Me", displayName: "Me" };
      const todo = {
        id: "todo",
        name: "Todo",
        type: "unstarted" as const,
        position: 0,
        color: "#fff",
      };
      h.issues[0] = {
        ...h.issues[0]!,
        state: todo,
        comments: [
          // T3 posts as the connected account too; its own card is not feedback.
          {
            id: delivered.linearCommentIds!.at(-1)!,
            body: "card",
            url: "",
            createdAt: later,
            author: person,
          },
          {
            id: "person",
            body: "The button is still grey.",
            url: "",
            createdAt: later,
            author: person,
          },
        ],
      };
      h.issues[1] = {
        ...h.issues[1]!,
        state: { id: "done", name: "Done", type: "completed", position: 2, color: "#fff" },
      };
      yield* service.scan();
      const tasks = (yield* service.board(null)).tasks;
      const sentBack = tasks.find((t) => t.id === first.id)!;
      assert.equal(sentBack.status, "changes-requested");
      assert.equal(
        sentBack.feedback,
        "Requested in Linear (moved to Todo):\n\nThe button is still grey.",
      );
      assert.equal(tasks.find((t) => t.id === second.id)?.status, "accepted");
      // Accepting in Linear does not write the state back.
      assert.deepEqual(h.transitions, ["review", "review"]);
      // The same scan gives the sent-back issue to a new team.
      const followup = yield* activeTask(service);
      assert.equal(followup.issue.id, first.issue.id);
      assert.equal(followup.feedback, sentBack.feedback);
    }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("a delivery Linear could not move is not read as a request for changes", () =>
  Effect.gen(function* () {
    const h = harness();
    const service = yield* h.initialize;
    // The team has no "QA" state, so moving the delivered issue fails.
    yield* service.configure({ ...config, reviewState: "QA" });
    yield* service.control({ projectId: config.projectId, action: "start" });
    const first = yield* takeIssue(h, service);
    const delivered = yield* deliverIssue(h, service, first);
    assert.equal(delivered.status, "review");
    assert.isNull(delivered.deliveredState ?? null);
    assert.include(delivered.error ?? "", 'no state named "QA"');
    // The issue is still in Todo, where it started; that is not the person moving it.
    yield* service.scan();
    assert.equal((yield* taskById(service, first.id)).status, "review");
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("approving the same commit again still reaches the implementer", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service } = yield* h.setup;
    const first = yield* takeIssue(h, service);
    const reviewer = assistantTaskThreadId(first, "review");
    yield* service.deliver();
    for (const _ of [1, 2]) {
      yield* service.requestReview(first.threadId, "Ready");
      yield* endTurn(h, service, first.threadId);
      yield* service.deliver();
      yield* service.submitReview(reviewer, "approved", "Merge it.", "");
      yield* endTurn(h, service, reviewer);
      yield* service.deliver();
    }
    const approvals = turnsOf(h, first.threadId).filter((text) =>
      text.startsWith("Code review approved"),
    );
    assert.lengthOf(approvals, 2);
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("work started before team leaders keeps reporting to the assistant", () =>
  Effect.gen(function* () {
    const h = harness();
    const service = yield* h.initialize;
    yield* service.configure(config);
    // A worker the assistant started itself, from before issues had team leaders.
    const sql = yield* SqlClient.SqlClient;
    const worker = ThreadId.make("assistant-work-legacy");
    const legacy = {
      id: "legacy",
      projectId: config.projectId,
      issue: makeIssue(1),
      threadId: worker,
      status: "working",
      brief: "Fix it",
      summary: "",
      reviewInstructions: "",
      feedback: "",
      turns: 1,
      turnLimit: 2,
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
    yield* sql`INSERT INTO assistant_tasks (id, project_id, issue_id, thread_id, status, data) VALUES (${"legacy"}, ${config.projectId}, ${"issue-1"}, ${worker}, ${"working"}, ${yield* encodeJson(legacy)})`;
    h.threads.set(
      worker,
      decodeThread({
        id: worker,
        projectId: config.projectId,
        title: "APP-1: Issue 1",
        modelSelection: config.workerModelSelection,
        runtimeMode: config.runtimeMode,
        interactionMode: "default",
        branch: "assistant/app-1",
        worktreePath: "/worktrees/legacy",
        createdAt: timestamp,
        updatedAt: timestamp,
        latestTurn: null,
        session: null,
        latestUserMessageAt: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
      }),
    );
    const board = yield* service.control({ projectId: config.projectId, action: "start" });
    const caller = board.projects[0]!.threadId;
    // The loop leaves the project to the work already in it.
    assert.lengthOf(board.tasks, 1);
    yield* service.deliver();
    assert.include(turnsOf(h, caller).at(-1), "APP-1 was started before issues had team leaders");
    h.finish(caller);
    yield* endTurn(h, service, worker);
    yield* service.deliver();
    assert.equal((yield* taskById(service, "legacy")).stage, "coordinator");
    assert.include(turnsOf(h, caller).at(-1), "ended its turn without handing off");
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("a team leader's thread the person archived is brought back for its next message", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service } = yield* h.setup;
    const task = yield* takeIssue(h, service);
    const lead = leadOf(task);
    yield* service.deliver();
    // The person archives the leader's thread while its worker is running.
    h.threads.set(lead, { ...h.threads.get(lead)!, archivedAt: timestamp });
    yield* endTurn(h, service, task.threadId);
    yield* service.deliver();
    assert.isNull(h.threads.get(lead)?.archivedAt);
    assert.include(turnsOf(h, lead).at(-1), "ended its turn without handing off");
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("an accepted state Linear does not call completed still accepts the delivery", () =>
  Effect.gen(function* () {
    const h = harness();
    const service = yield* h.initialize;
    yield* service.configure({ ...config, acceptedState: "Ready to Deploy" });
    yield* service.control({ projectId: config.projectId, action: "start" });
    const task = yield* takeIssue(h, service);
    yield* deliverIssue(h, service, task);
    // The person moved the issue where the card asked them to, a started state.
    h.issues[0] = {
      ...h.issues[0]!,
      state: { id: "deploy", name: " ready to deploy ", type: "started", position: 3, color: "#f" },
    };
    yield* service.scan();
    const accepted = yield* taskById(service, task.id);
    assert.equal(accepted.status, "accepted");
    assert.include(accepted.feedback, "Accepted in Linear");
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("a review made while Linear is being read is not overwritten by the sync", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service } = yield* h.setup;
    const task = yield* takeIssue(h, service);
    yield* deliverIssue(h, service, task);
    // In Linear the issue was moved out of its delivered state, which the sync
    // reads as a request for changes.
    h.issues[0] = {
      ...h.issues[0]!,
      state: { id: "todo", name: "Todo", type: "unstarted", position: 0, color: "#fff" },
    };
    // The person sends it back from the board, with their own words, while
    // that read is in flight.
    let raced = false;
    h.whenIssueRead(() =>
      Effect.gen(function* () {
        if (raced) return;
        raced = true;
        yield* service.review({
          taskId: task.id,
          action: "request-changes",
          feedback: "The button is still grey.",
        });
      }).pipe(Effect.catch(() => Effect.void)),
    );
    yield* service.scan();
    const reviewed = yield* taskById(service, task.id);
    assert.isTrue(raced);
    assert.equal(reviewed.status, "changes-requested");
    assert.equal(reviewed.feedback, "The button is still grey.");
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("interrupting keeps an update made while its threads were stopped", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service } = yield* h.setup;
    const task = yield* takeIssue(h, service);
    const sql = yield* SqlClient.SqlClient;
    // A turn ending writes to the same row between the board read and the save.
    let raced = false;
    h.onDispatch((command) =>
      command.type === "thread.turn.interrupt" && command.threadId === leadOf(task) && !raced
        ? Effect.sync(() => {
            raced = true;
          }).pipe(
            Effect.andThen(
              sql`UPDATE assistant_tasks SET data = json_set(data, '$.summary', 'Pushed the fix') WHERE id = ${task.id}`,
            ),
            Effect.asVoid,
            Effect.orDie,
          )
        : Effect.void,
    );
    yield* service.control({ projectId: config.projectId, action: "interrupt" });
    const interrupted = yield* taskById(service, task.id);
    assert.isTrue(raced);
    assert.equal(interrupted.status, "blocked");
    assert.equal(interrupted.summary, "Pushed the fix");
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("a ready state Linear calls started is still listed and taken", () =>
  Effect.gen(function* () {
    const h = harness();
    const service = yield* h.initialize;
    h.issues[0] = {
      ...h.issues[0]!,
      state: { id: "wip", name: "In Progress", type: "started", position: 1, color: "#fff" },
    };
    yield* service.configure({ ...config, readyStates: ["In Progress"] });
    yield* service.control({ projectId: config.projectId, action: "start" });
    assert.equal((yield* activeTask(service)).issue.identifier, "APP-1");
    assert.include(h.listed.at(-1)?.stateTypes ?? [], "started");
    assert.notInclude(h.listed.at(-1)?.stateTypes ?? [], "completed");
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("another T3 project's claim on the same Linear issue does not hide it", () =>
  Effect.gen(function* () {
    const h = harness();
    const service = yield* h.initialize;
    const sql = yield* SqlClient.SqlClient;
    // A second assistant on the same Linear project is working APP-1 itself.
    const other = {
      id: "other",
      projectId: "other-project",
      issue: makeIssue(1),
      threadId: "assistant-work-other",
      status: "working",
      brief: "",
      summary: "",
      reviewInstructions: "",
      feedback: "",
      turns: 1,
      turnLimit: 2,
      deployment: null,
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      stage: "implement",
      leader: true,
      linearCommentIds: [],
    };
    yield* sql`INSERT INTO assistant_tasks (id, project_id, issue_id, thread_id, status, data) VALUES (${other.id}, ${other.projectId}, ${other.issue.id}, ${other.threadId}, ${other.status}, ${yield* encodeJson(other)})`;
    yield* service.configure(config);
    yield* service.control({ projectId: config.projectId, action: "start" });
    assert.equal((yield* activeTask(service)).issue.identifier, "APP-1");
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("a sent-back issue Linear cannot read does not hold up the others", () =>
  Effect.gen(function* () {
    const h = harness();
    const service = yield* h.initialize;
    yield* service.configure(config);
    const sql = yield* SqlClient.SqlClient;
    for (const [id, issue] of [
      ["one", makeIssue(1)],
      ["two", makeIssue(2)],
    ] as const) {
      const sentBack = {
        id,
        projectId: config.projectId,
        issue,
        threadId: `assistant-work-${id}`,
        status: "changes-requested",
        brief: "",
        summary: "",
        reviewInstructions: "",
        feedback: `Rework ${issue.identifier}`,
        turns: 1,
        turnLimit: 2,
        deployment: null,
        error: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        stage: "lead",
        leader: true,
        linearCommentIds: [],
      };
      yield* sql`INSERT INTO assistant_tasks (id, project_id, issue_id, thread_id, status, data) VALUES (${id}, ${config.projectId}, ${issue.id}, ${sentBack.threadId}, ${"changes-requested"}, ${yield* encodeJson(sentBack)})`;
    }
    h.linearFailures.add("issue-1");
    yield* service.control({ projectId: config.projectId, action: "start" });
    const active = yield* activeTask(service);
    assert.equal(active.issue.identifier, "APP-2");
    assert.equal(active.feedback, "Rework APP-2");
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("a delivered team is closed once its threads are all finished, and only once", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service } = yield* h.setup;
    const task = yield* takeIssue(h, service);
    const tester = assistantTaskThreadId(task, "e2e");
    yield* reachMerge(h, service, task);
    yield* leadToE2e(h, service, task);
    yield* service.submitE2e(tester, {
      verdict: "passed",
      report: "- The page loads: passed",
      humanChecks: [],
      screenshots: [],
    });
    // The leader is running again when the tester's turn ends; the team stays open.
    h.pendingStarts.add(leadOf(task));
    yield* endTurn(h, service, tester);
    assert.lengthOf(h.removed, 0);
    h.pendingStarts.delete(leadOf(task));
    yield* endTurn(h, service, leadOf(task));
    assert.lengthOf(h.removed, 1);
    // Whatever settles afterwards finds the team closed.
    for (const threadId of [task.threadId, tester]) yield* endTurn(h, service, threadId);
    assert.lengthOf(h.removed, 1);
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("the tester cannot be messaged before its run is started", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service } = yield* h.setup;
    const task = yield* takeIssue(h, service);
    yield* reachMerge(h, service, task);
    yield* leadToE2e(h, service, task);
    // T3 stopped between creating the tester's thread and queueing its brief.
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM assistant_messages WHERE thread_id = ${assistantTaskThreadId(task, "e2e")}`;
    const refused = yield* service
      .messageWorker(leadOf(task), undefined, "Check the header too", "e2e")
      .pipe(Effect.flip);
    assert.equal(refused.detail, "Start the tester with assistant_start_e2e first.");
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("a Linear card is posted only after the state that stops it being posted twice", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service } = yield* h.setup;
    const task = yield* takeIssue(h, service);
    // What the issue looked like in T3 as each card was posted.
    const atPost: Array<{ merge: boolean; e2e: boolean; stage: string | undefined }> = [];
    h.whenCommentPosted(() =>
      taskById(service, task.id).pipe(
        Effect.map((t) => {
          atPost.push({ merge: t.merge != null, e2e: t.e2e != null, stage: t.stage });
        }),
        Effect.orDie,
      ),
    );
    yield* deliverIssue(h, service, task);
    const merged = atPost[0]!;
    assert.isTrue(merged.merge);
    assert.equal(merged.stage, "lead");
    const tested = atPost.at(-1)!;
    assert.isTrue(tested.e2e);
    assert.notEqual(tested.stage, "e2e");
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("works two issues at once, each team in its own slot", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service } = yield* h.setupWith({ parallelIssues: 2 });
    const held = yield* heldTasks(service);
    assert.deepEqual(
      held.map((t) => t.issue.identifier),
      ["APP-1", "APP-2"],
    );
    assert.deepEqual(
      held.map((t) => t.slot),
      [0, 1],
    );
    // Linear is read once for the pass that filled both slots, and the third
    // issue waits for one of them.
    assert.lengthOf(h.listed, 1);
    yield* service.scan();
    assert.lengthOf(yield* heldTasks(service), 2);

    // The delivered team's slot goes to the next issue.
    const first = yield* takeTask(h, service, held[0]!, "Fix the page");
    yield* deliverIssue(h, service, first);
    assert.equal((yield* taskById(service, first.id)).status, "review");
    yield* service.scan();
    const working = yield* heldTasks(service);
    assert.deepEqual(
      working.map((t) => t.issue.identifier),
      ["APP-2", "APP-3"],
    );
    assert.equal(working.find((t) => t.issue.identifier === "APP-3")?.slot, 0);
    assert.equal(working.find((t) => t.issue.identifier === "APP-2")?.slot, 1);

    // A blocked team holds its slot until the person deals with it.
    const third = working.find((t) => t.issue.identifier === "APP-3")!;
    let outcome = "waiting";
    while (outcome === "waiting")
      outcome = (yield* service.waitForExternal(leadOf(third), "Deploy is pending")).outcome;
    assert.equal((yield* taskById(service, third.id)).status, "blocked");
    h.issues.push(makeIssue(4));
    yield* service.scan();
    assert.lengthOf(yield* heldTasks(service), 2);
    yield* service.review({ taskId: third.id, action: "skip", feedback: "Later" });
    yield* service.scan();
    const fourth = (yield* heldTasks(service)).find((t) => t.issue.identifier === "APP-4")!;
    assert.equal(fourth.slot, 0);
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("starting saves how many issues to work at once, and a start without it keeps it", () =>
  Effect.gen(function* () {
    const h = harness();
    const service = yield* h.initialize;
    yield* service.configure(config);
    const board = yield* service.control({
      projectId: config.projectId,
      action: "start",
      options: { autoPick: true, assignedToMe: true, parallelIssues: 3 },
    });
    assert.equal(board.projects[0]?.config.parallelIssues, 3);
    assert.lengthOf(yield* heldTasks(service), 3);
    yield* service.control({ projectId: config.projectId, action: "pause" });
    // An earlier client sends no count and keeps the one the person chose.
    const again = yield* service.control({
      projectId: config.projectId,
      action: "start",
      options: { autoPick: true, assignedToMe: true },
    });
    assert.equal(again.projects[0]?.config.parallelIssues, 3);
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("a team leader's wait is its issue's own, and blocks only that issue", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service } = yield* h.setupWith({ parallelIssues: 2 });
    const [first, second] = yield* heldTasks(service);
    // Both leaders have their start turn; nothing else is queued for them.
    yield* service.deliver();
    h.finish(leadOf(first!));
    h.finish(leadOf(second!));
    yield* service.waitForExternal(leadOf(first!), "Staging is deploying");
    const waiting = yield* taskById(service, first!.id);
    assert.equal(waiting.wait?.reason, "Staging is deploying");
    assert.equal(waiting.wait?.checks, 1);
    assert.isFalse(waiting.wait?.notified);
    // The project itself is untouched by a team leader's wait.
    assert.isNull((yield* service.board(null)).projects[0]?.error ?? null);

    // One call produces one check-again message, to that leader alone.
    yield* service.scan();
    assert.include(
      turnsOf(h, leadOf(first!)).at(-1),
      "Waiting: Staging is deploying\nCheck again.",
    );
    assert.lengthOf(turnsOf(h, leadOf(first!)), 2);
    h.finish(leadOf(first!));
    yield* service.scan();
    assert.lengthOf(turnsOf(h, leadOf(first!)), 2);
    assert.lengthOf(turnsOf(h, leadOf(second!)), 1);

    // The other team's wait is its own.
    yield* service.waitForExternal(leadOf(second!), "CI is running");
    yield* service.scan();
    assert.include(turnsOf(h, leadOf(second!)).at(-1), "Waiting: CI is running\nCheck again.");
    assert.lengthOf(turnsOf(h, leadOf(first!)), 2);

    // The fifteenth check blocks that issue; the project and its other team run on.
    let outcome = "waiting";
    while (outcome === "waiting")
      outcome = (yield* service.waitForExternal(leadOf(first!), "Staging is deploying")).outcome;
    assert.equal(outcome, "limit");
    const blocked = yield* taskById(service, first!.id);
    assert.equal(blocked.status, "blocked");
    assert.isNull(blocked.wait ?? null);
    assert.include(blocked.error!, "15 checks");
    const board = yield* service.board(null);
    assert.equal(board.projects[0]?.status, "running");
    assert.isNull(board.projects[0]?.error ?? null);
    assert.equal(board.tasks.find((t) => t.id === second!.id)?.status, "working");
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("in the worktree the e2e check runs before the merge, and staging delivers", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service } = yield* h.setupWith({ e2eEnvironment: "worktree" });
    const first = yield* takeIssue(h, service);
    const lead = leadOf(first);
    const tester = assistantTaskThreadId(first, "e2e");
    assert.equal(first.e2eEnvironment, "worktree");
    // The check runs on the commit code review approved, so there must be one.
    const early = yield* service.startE2e(lead, undefined, "Open the page.").pipe(Effect.flip);
    assert.include(early.detail, "code review approves");

    yield* approveReview(h, service, first);
    // The leader starts the check; the worker is not told to merge yet.
    assert.include(turnsOf(h, lead).at(-1), "Start the e2e check in the worktree");
    assert.lengthOf(turnsOf(h, first.threadId), 1);
    const unchecked = yield* service
      .reportMerged(first.threadId, "The page loads")
      .pipe(Effect.flip);
    assert.include(unchecked.detail, "e2e check has not passed");

    yield* service.startE2e(lead, undefined, "Open the page.");
    yield* endTurn(h, service, lead);
    yield* service.deliver();
    assert.include(turnsOf(h, tester).at(-1), `in the worktree`);
    const passed = yield* service.submitE2e(tester, {
      verdict: "passed",
      report: "- The page loads: passed",
      humanChecks: [],
      screenshots: [{ path: `/evidence/${first.id}/page.png`, caption: "The page after the fix" }],
    });
    // Nothing is on the issue yet; the worker is told to merge the tested commit.
    assert.equal(passed.status, "working");
    assert.equal(passed.e2e?.environment, "worktree");
    assert.equal(passed.e2e?.commit, h.git.head);
    assert.lengthOf(h.comments, 0);
    yield* endTurn(h, service, tester);
    yield* service.deliver();
    assert.include(turnsOf(h, first.threadId).at(-1), "Merge the PR into develop");

    yield* service.reportMerged(first.threadId, "The page loads again.");
    yield* endTurn(h, service, first.threadId);
    yield* service.deliver();
    assert.include(turnsOf(h, lead).at(-1), "Verify staging with assistant_verify_staging");
    const delivered = yield* service.verifyStaging(lead, undefined);
    assert.equal(delivered.status, "review");
    // The merged card and the e2e card, and no "deployed, e2e running" card.
    assert.lengthOf(h.comments, 2);
    assert.match(h.comments[0]!.body, /^\*\*Code review passed/);
    assert.lengthOf(
      h.comments.filter((c) => c.body.includes("To accept, move this issue to Done")),
      1,
    );
    assert.lengthOf(h.descriptions, 1);
    assert.deepEqual(h.transitions, ["review"]);
    yield* endTurn(h, service, lead);
    // A finished team's threads are settled, not archived: the person can still
    // open them from the assistant page.
    for (const role of ["lead", "implement", "review", "e2e"] as const) {
      const thread = h.threads.get(assistantTaskThreadId(first, role));
      assert.equal(thread?.settledOverride, "settled");
      assert.isNull(thread?.archivedAt);
    }
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("a commit the worktree e2e check did not cover cannot be merged", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service } = yield* h.setupWith({ e2eEnvironment: "worktree" });
    const first = yield* takeIssue(h, service);
    const lead = leadOf(first);
    const tester = assistantTaskThreadId(first, "e2e");
    yield* approveReview(h, service, first);
    yield* service.startE2e(lead, undefined, "Open the page.");
    yield* endTurn(h, service, lead);
    yield* service.deliver();
    yield* service.submitE2e(tester, {
      verdict: "passed",
      report: "- The page loads: passed",
      humanChecks: [],
      screenshots: [],
    });
    yield* endTurn(h, service, tester);
    // The worker pushes again and the reviewer approves the new commit; the
    // e2e result covers the old one.
    h.git.head = "c".repeat(40);
    yield* service.deliver();
    yield* service.requestReview(first.threadId, "One more fix");
    yield* endTurn(h, service, first.threadId);
    yield* service.deliver();
    yield* service.submitReview(
      assistantTaskThreadId(first, "review"),
      "approved",
      "Still right.",
      "Re-checked the fix.",
    );
    yield* endTurn(h, service, assistantTaskThreadId(first, "review"));
    const stale = yield* service.reportMerged(first.threadId, "Merged").pipe(Effect.flip);
    assert.include(stale.detail, "e2e check has not passed");
    assert.lengthOf(h.comments, 0);
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("a failed worktree e2e run goes to the team leader with nothing posted on Linear", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service } = yield* h.setupWith({ e2eEnvironment: "worktree" });
    const first = yield* takeIssue(h, service);
    const lead = leadOf(first);
    const tester = assistantTaskThreadId(first, "e2e");
    yield* approveReview(h, service, first);
    yield* service.startE2e(lead, undefined, "Open the page.");
    yield* endTurn(h, service, lead);
    yield* service.deliver();
    const failed = yield* service.submitE2e(tester, {
      verdict: "failed",
      report: "- The page loads: failed, it shows a 500",
      humanChecks: [],
      screenshots: [],
    });
    assert.equal(failed.e2e?.verdict, "failed");
    assert.equal(failed.stage, "lead");
    assert.lengthOf(h.comments, 0);
    yield* endTurn(h, service, tester);
    yield* service.deliver();
    assert.include(turnsOf(h, lead).at(-1), "failed its e2e check in the worktree");
    assert.isFalse(turnsOf(h, first.threadId).some((text) => text.includes("Merge the PR")));
  }).pipe(Effect.provide(database()), Effect.scoped),
);

/** A thread's turn failed the way the provider reports it. */
const sessionError = (threadId: ThreadId, lastError: string) =>
  ({
    ...eventBase(threadId),
    type: "thread.session-set",
    payload: {
      threadId,
      session: {
        threadId,
        status: "error",
        providerName: "test",
        activeTurnId: null,
        runtimeMode: "approval-required",
        lastError,
        updatedAt: timestamp,
      },
    },
  }) satisfies OrchestrationEvent;
const LIMIT_ERROR =
  "Claude usage limit reached. Send the message again once the 5-hour limit resets in 2h 10m.";

it.effect(
  "a usage limit holds the project until it resets, then the stopped thread continues",
  () =>
    Effect.gen(function* () {
      const h = harness();
      const { service } = yield* h.setupWith({ parallelIssues: 2 });
      // Two teams start at once; the second leader is idle when the limit hits the first.
      const [first, second] = yield* heldTasks(service);
      const lead = leadOf(first!);
      yield* service.deliver();
      assert.lengthOf(turnsOf(h, lead), 1);
      assert.lengthOf(turnsOf(h, leadOf(second!)), 1);
      h.finish(lead);
      yield* service.observe(sessionError(lead, LIMIT_ERROR));
      // The issue is not blocked and its leader is not told about a failure.
      const held = yield* taskById(service, first!.id);
      assert.equal(held.status, "working");
      assert.isNull(held.error);
      const board = yield* service.board(null);
      assert.equal(board.projects[0]?.status, "running");
      assert.isNull(board.projects[0]?.error);
      // The wait is read from the message, plus a minute of slack past the rounded reset.
      assert.equal(board.projects[0]?.limitedUntil, "1970-01-01T02:11:00.000Z");
      // Nothing reaches the threads meanwhile: not the resume, and no new team.
      yield* service.deliver();
      assert.lengthOf(turnsOf(h, lead), 1);
      yield* TestClock.adjust(Duration.hours(1));
      yield* service.scan();
      assert.lengthOf(turnsOf(h, lead), 1);
      assert.equal(
        (yield* service.board(null)).projects[0]?.limitedUntil,
        "1970-01-01T02:11:00.000Z",
      );
      // Once the limit resets the scan lifts the hold and the leader is told to continue.
      yield* TestClock.adjust(Duration.hours(2));
      yield* service.scan();
      assert.isNull((yield* service.board(null)).projects[0]?.limitedUntil);
      assert.lengthOf(turnsOf(h, lead), 2);
      assert.include(turnsOf(h, lead).at(-1), "usage limit stopped your previous turn");
      // The idle leader was not sent anything: only the stopped thread continues.
      assert.lengthOf(turnsOf(h, leadOf(second!)), 1);
    }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("the assistant's own turn stopped by a usage limit keeps the loop running", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service, caller } = yield* h.setup;
    yield* service.deliver();
    assert.lengthOf(turnsOf(h, caller), 1);
    h.finish(caller);
    yield* service.observe(sessionError(caller, LIMIT_ERROR));
    const board = yield* service.board(null);
    assert.equal(board.projects[0]?.status, "running");
    assert.isNull(board.projects[0]?.error);
    yield* service.deliver();
    assert.lengthOf(turnsOf(h, caller), 1);
    yield* TestClock.adjust(Duration.hours(3));
    yield* service.scan();
    const resumed = turnsOf(h, caller).at(-1);
    assert.lengthOf(turnsOf(h, caller), 2);
    assert.include(resumed, "usage limit stopped your previous turn");
    // The wake it was answering is repeated, so nothing it was told is lost.
    assert.include(resumed, "The person started the issue loop");
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("a limit failure with no reset time is tried again after a while", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service } = yield* h.setup;
    const team = yield* activeTask(service);
    yield* service.deliver();
    h.finish(leadOf(team));
    yield* service.observe(
      sessionError(leadOf(team), "Claude stopped: a usage limit blocked the request."),
    );
    assert.equal(
      (yield* service.board(null)).projects[0]?.limitedUntil,
      "1970-01-01T00:21:00.000Z",
    );
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("starting the assistant lifts a usage-limit hold and sends what waited", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service } = yield* h.setup;
    const team = yield* activeTask(service);
    const lead = leadOf(team);
    yield* service.deliver();
    h.finish(lead);
    yield* service.observe(sessionError(lead, LIMIT_ERROR));
    yield* service.deliver();
    assert.lengthOf(turnsOf(h, lead), 1);
    yield* service.control({ projectId: config.projectId, action: "start" });
    assert.isNull((yield* service.board(null)).projects[0]?.limitedUntil);
    yield* service.deliver();
    assert.lengthOf(turnsOf(h, lead), 2);
    assert.include(turnsOf(h, lead).at(-1), "usage limit stopped your previous turn");
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("a worker failing for any other reason still blocks its issue", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service } = yield* h.setup;
    const first = yield* takeIssue(h, service);
    yield* service.deliver();
    h.finish(first.threadId);
    yield* service.observe(
      sessionError(first.threadId, "Claude gave up after repeated API errors."),
    );
    const blocked = yield* taskById(service, first.id);
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.error, "Claude gave up after repeated API errors.");
    assert.isNull((yield* service.board(null)).projects[0]?.limitedUntil);
  }).pipe(Effect.provide(database()), Effect.scoped),
);
