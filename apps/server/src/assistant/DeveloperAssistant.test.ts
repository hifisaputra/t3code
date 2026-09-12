import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Stream from "effect/Stream";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
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
  type AssistantProjectConfig,
  type LinearIssueDetail,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { LinearApi } from "../linear/LinearApi.ts";
import { LinearThreadService } from "../linear/LinearThreadService.ts";
import {
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
} from "../orchestration/Errors.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionService } from "../orchestration/Services/ProviderRuntimeIngestion.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import * as Settings from "../serverSettings.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { ServerActivation } from "../serverActivation.ts";
import Migration from "../persistence/Migrations/052_DeveloperAssistant.ts";
import SetupMigration from "../persistence/Migrations/053_AssistantSetup.ts";
import * as Assistant from "./DeveloperAssistant.ts";
import { StagingVerifier } from "./StagingVerifier.ts";

const decodeThread = Schema.decodeUnknownSync(OrchestrationThreadShell);
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
  // Like the real projection, lookups hide archived threads unless asked.
  const visibleThread = (id: ThreadId, options?: { readonly includeArchived?: boolean }) =>
    Option.fromNullishOr(threads.get(id)).pipe(
      Option.filter((t) => options?.includeArchived === true || t.archivedAt === null),
    );
  const issues = [makeIssue(1), makeIssue(2), makeIssue(3)];
  const transitions: string[] = [];
  const pendingStarts = new Set<ThreadId>();
  let stagingHealthy = true;
  let setupHealthy = true;
  const dependencies = Layer.mergeAll(
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
      repositoryKey: () => Effect.succeed("/repos/app/.git"),
      verify: () =>
        stagingHealthy
          ? Effect.succeed({
              revision: "a".repeat(40),
              url: "https://staging.example.com",
              verifiedAt: timestamp,
            })
          : Effect.fail(new DeveloperAssistantError({ detail: "Deployment failed" })),
    }),
    Layer.mock(LinearApi)({
      status: Effect.succeed({
        status: "connected",
        viewer: { id: "me", name: "Me", displayName: "Me" },
        workspace: { id: "workspace", name: "Workspace", urlKey: "workspace" },
      }),
      listIssues: () => Effect.succeed({ issues }),
      getIssue: ({ reference }) =>
        Effect.succeed(
          issues.find((i) => i.id === reference || i.identifier === reference) ?? issues[0]!,
        ),
      workflowStates: () =>
        Effect.succeed([
          { id: "review", name: "In Review", type: "started", position: 1, color: "#fff" },
          { id: "done", name: "Done", type: "completed", position: 2, color: "#fff" },
        ]),
      updateIssueState: ({ stateId }) =>
        Effect.sync(() => {
          transitions.push(stateId);
        }),
    }),
    Layer.mock(LinearThreadService)({
      prepareIssueThread: (input) =>
        setupHealthy
          ? Effect.succeed({
              issue: issues.find((i) => i.id === input.reference)!,
              branch: input.branch!,
              baseBranch: input.baseBranch!,
              worktreePath: `/worktrees/${input.threadId}`,
              reusedExistingBranch: false,
              movedToState: null,
            })
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
                : command.type === "thread.archive"
                  ? (!target || target.archivedAt !== null) && "Thread is missing or archived."
                  : "threadId" in command && !target && "Thread does not exist.";
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
          if (thread && command.type === "thread.turn.start")
            threads.set(thread.id, {
              ...thread,
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
              messages: [],
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
    return yield* make;
  });
  const setup = Effect.gen(function* () {
    const service = yield* initialize;
    yield* service.configure(config);
    const board = yield* service.control({ projectId: config.projectId, action: "start" });
    return { service, caller: board.projects[0]!.threadId };
  });
  return {
    initialize,
    setup,
    make,
    makeWithWorkers: Assistant.make.pipe(Effect.provide(dependencies)),
    replayEvents,
    onDispatch: (observer: typeof dispatchObserver) => {
      dispatchObserver = observer;
    },
    commands,
    issues,
    threads,
    transitions,
    pendingStarts,
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

const setupInput = {
  projectId: config.projectId,
  linearProjectId: config.linearProjectId,
  assignedToMe: true,
  modelSelection: config.modelSelection,
  workerModelSelection: config.workerModelSelection,
  runtimeMode: "full-access" as const,
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
      yield* service
        .startIssue(draft.threadId, "APP-1", "Not allowed during setup")
        .pipe(Effect.isFailure),
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

it.effect("blocks setup during managed work and blocks starting while setup is in progress", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service, caller } = yield* h.setup;
    assert.isTrue(yield* service.beginSetup(setupInput).pipe(Effect.isFailure));
    const task = yield* service.startIssue(caller, "APP-1", "Implement");
    yield* service.control({ projectId: config.projectId, action: "stop" });
    assert.isTrue(yield* service.beginSetup(setupInput).pipe(Effect.isFailure));
    yield* service.review({ taskId: task.id, action: "skip", feedback: "Set up first" });
    const draft = yield* service.beginSetup(setupInput);
    assert.isTrue(
      yield* service
        .control({ projectId: config.projectId, action: "start" })
        .pipe(Effect.isFailure),
    );
    assert.isTrue(yield* service.configure(config).pipe(Effect.isFailure));
    const cancelled = yield* service.resolveSetup({
      threadId: draft.threadId,
      action: "cancel",
      revision: 0,
    });
    assert.equal(cancelled.projects[0]?.config.stagingCheckCommand, "check-staging");
    assert.equal(cancelled.projects[0]?.status, "stopped");
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

it.effect("claims an issue once and prevents a second worker until staging succeeds", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service, caller } = yield* h.setup;
    const first = yield* service.startIssue(caller, "APP-1", "Fix it");
    assert.equal((yield* service.startIssue(caller, "APP-1", "Duplicate")).id, first.id);
    assert.isTrue(yield* service.startIssue(caller, "APP-2", "Next").pipe(Effect.isFailure));
    yield* service.deliver();
    assert.equal(
      h.commands.find((c) => c.type === "thread.turn.start" && c.threadId === first.threadId)?.type,
      "thread.turn.start",
    );
    h.finish(first.threadId);
    h.setStagingHealthy(false);
    assert.isTrue(
      yield* service
        .verifyStaging(caller, first.id, "Done", "Check the page")
        .pipe(Effect.isFailure),
    );
    assert.isTrue(yield* service.startIssue(caller, "APP-2", "Next").pipe(Effect.isFailure));
    h.setStagingHealthy(true);
    const delivered = yield* service.verifyStaging(caller, first.id, "Done", "Check the page");
    assert.equal(delivered.status, "review");
    assert.equal(h.threads.get(first.threadId)?.archivedAt, timestamp);
    const next = yield* service.startIssue(caller, "APP-2", "Next");
    assert.notEqual(first.id, next.id);
    assert.deepEqual(h.transitions, ["review"]);
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("rejects other threads, projects, assignees and work that is not ready", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service, caller } = yield* h.setup;
    assert.isTrue(
      yield* service
        .startIssue(ThreadId.make("stranger"), "APP-1", "Take over")
        .pipe(Effect.isFailure),
    );
    h.issues[0] = { ...h.issues[0]!, project: null };
    assert.isTrue(
      yield* service.startIssue(caller, "APP-1", "Wrong project").pipe(Effect.isFailure),
    );
    h.issues[0] = { ...makeIssue(1), assignee: null };
    assert.isTrue(
      yield* service.startIssue(caller, "APP-1", "Wrong assignee").pipe(Effect.isFailure),
    );
    h.issues[0] = { ...makeIssue(1), state: { ...makeIssue(1).state, type: "backlog" } };
    assert.isTrue(yield* service.startIssue(caller, "APP-1", "Not ready").pipe(Effect.isFailure));
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("retains ownership and queued turns across service recreation", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service, caller } = yield* h.setup;
    const first = yield* service.startIssue(caller, "APP-1", "Fix it");
    const restarted = yield* h.make;
    assert.equal((yield* restarted.board(null)).tasks[0]?.id, first.id);
    assert.isTrue(
      yield* restarted.startIssue(caller, "APP-2", "Duplicate work").pipe(Effect.isFailure),
    );
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
    const first = yield* service.startIssue(caller, "APP-1", "Fix it");
    yield* service.deliver();
    h.finish(first.threadId);
    const decision = yield* service.askDecision(
      first.threadId,
      "Should existing users keep access?",
    );
    assert.isTrue(
      yield* service.messageWorker(caller, first.id, "Just guess").pipe(Effect.isFailure),
    );
    assert.isTrue(
      yield* service.verifyStaging(caller, first.id, "Done", "Check").pipe(Effect.isFailure),
    );
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

it.effect("stopping prevents new dispatches and resuming preserves the worker", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service, caller } = yield* h.setup;
    const first = yield* service.startIssue(caller, "APP-1", "Fix it");
    yield* service.control({ projectId: config.projectId, action: "stop" });
    yield* service.deliver();
    assert.lengthOf(
      h.commands.filter((c) => c.type === "thread.turn.start"),
      0,
    );
    assert.isTrue(yield* service.startIssue(caller, "APP-2", "Next").pipe(Effect.isFailure));
    yield* service.control({ projectId: config.projectId, action: "start" });
    yield* service.deliver();
    assert.lengthOf(
      h.commands.filter((c) => c.type === "thread.turn.start" && c.threadId === first.threadId),
      1,
    );
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("review feedback starts a fresh worker and never rolls back later deployed work", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service, caller } = yield* h.setup;
    const first = yield* service.startIssue(caller, "APP-1", "Fix it");
    yield* service.deliver();
    h.finish(first.threadId);
    yield* service.verifyStaging(caller, first.id, "Done", "Check page");
    yield* service.review({
      taskId: first.id,
      action: "request-changes",
      feedback: "Make the button clearer.",
    });
    const followup = yield* service.startIssue(caller, "APP-1", "Address review feedback");
    assert.notEqual(followup.threadId, first.threadId);
    assert.equal(followup.feedback, "Make the button clearer.");
    assert.equal(
      (yield* service.board(null)).tasks.find((t) => t.id === first.id)?.status,
      "changes-requested",
    );
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("enforces the turn limit and an explicit retry does not reuse old command ids", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service, caller } = yield* h.setup;
    const first = yield* service.startIssue(caller, "APP-1", "Fix it");
    yield* service.deliver();
    h.finish(first.threadId);
    yield* service.messageWorker(caller, first.id, "Fix review feedback");
    yield* service.deliver();
    h.finish(first.threadId);
    assert.isTrue(yield* service.messageWorker(caller, first.id, "Again").pipe(Effect.isFailure));
    yield* service.review({ taskId: first.id, action: "retry", feedback: "Allow another attempt" });
    yield* service.messageWorker(caller, first.id, "One more attempt");
    yield* service.deliver();
    assert.lengthOf(
      h.commands.filter((c) => c.type === "thread.turn.start" && c.threadId === first.threadId),
      3,
    );
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("skipping closes decisions, cancels queued work and frees the project", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service, caller } = yield* h.setup;
    const first = yield* service.startIssue(caller, "APP-1", "Fix it");
    yield* service.askDecision(first.threadId, "Need a choice");
    yield* service.review({ taskId: first.id, action: "skip", feedback: "Later" });
    yield* service.deliver();
    assert.lengthOf(
      (yield* service.board(null)).decisions.filter((d) => d.answer === null),
      0,
    );
    assert.lengthOf(
      h.commands.filter((c) => c.type === "thread.turn.start" && c.threadId === first.threadId),
      0,
    );
    yield* service.startIssue(caller, "APP-2", "Next");
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
    const first = yield* service.startIssue(caller, "APP-1", "Fix it");
    h.pendingStarts.add(first.threadId);
    yield* service.deliver();
    assert.lengthOf(
      h.commands.filter((c) => c.type === "thread.turn.start" && c.threadId === first.threadId),
      0,
    );
    assert.isTrue(
      yield* service.messageWorker(caller, first.id, "More work").pipe(Effect.isFailure),
    );
    assert.isTrue(
      yield* service.verifyStaging(caller, first.id, "Done", "Check").pipe(Effect.isFailure),
    );
    h.pendingStarts.delete(first.threadId);
    yield* service.deliver();
    assert.lengthOf(
      h.commands.filter((c) => c.type === "thread.turn.start" && c.threadId === first.threadId),
      1,
    );
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("recovers failed worktree setup in the same claimed worker", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service, caller } = yield* h.setup;
    h.setSetupHealthy(false);
    const first = yield* service.startIssue(caller, "APP-1", "Fix it");
    assert.equal(first.status, "blocked");
    assert.equal(first.turns, 0);
    assert.isTrue(yield* service.startIssue(caller, "APP-2", "Next").pipe(Effect.isFailure));
    h.setSetupHealthy(true);
    const recovered = yield* service.messageWorker(caller, first.id, "Retry setup");
    assert.equal(recovered.threadId, first.threadId);
    assert.equal(recovered.turns, 1);
    assert.equal((yield* service.board(null)).tasks.length, 1);
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("serializes concurrent issue starts", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service, caller } = yield* h.setup;
    const results = yield* Effect.all(
      ["APP-1", "APP-2"].map((issue) =>
        service.startIssue(caller, issue, "Fix it").pipe(Effect.result),
      ),
      { concurrency: "unbounded" },
    );
    assert.lengthOf(
      results.filter((r) => r._tag === "Success"),
      1,
    );
    assert.lengthOf((yield* service.board(null)).tasks, 1);
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("bounds external progress checks and allows an explicit restart", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service, caller } = yield* h.setup;
    for (let i = 0; i < 16; i++) yield* service.waitForExternal(caller, "Deploy is pending");
    const paused = (yield* service.board(null)).projects[0]!;
    assert.equal(paused.status, "stopped");
    assert.include(paused.error!, "15 checks");
    yield* service.control({ projectId: config.projectId, action: "start" });
    yield* service.waitForExternal(caller, "One more check");
    assert.equal((yield* service.board(null)).projects[0]?.status, "running");
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("replaces a deleted coordinator without losing its active issue", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service, caller } = yield* h.setup;
    const first = yield* service.startIssue(caller, "APP-1", "Fix it");
    yield* service.control({ projectId: config.projectId, action: "stop" });
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

it.effect("starting after the coordinator was archived restores its conversation", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service, caller } = yield* h.setup;
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
    const { service, caller } = yield* h.setup;
    const first = yield* service.startIssue(caller, "APP-1", "Fix it");
    yield* service.deliver();
    h.finish(first.threadId);
    h.threads.set(first.threadId, { ...h.threads.get(first.threadId)!, archivedAt: timestamp });
    const delivered = yield* service.verifyStaging(caller, first.id, "Done", "Check the page");
    assert.equal(delivered.status, "review");
    assert.lengthOf(
      h.commands.filter((c) => c.type === "thread.archive" && c.threadId === first.threadId),
      0,
    );
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("interrupting a worker whose worktree setup failed stops the project", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service, caller } = yield* h.setup;
    h.setSetupHealthy(false);
    const first = yield* service.startIssue(caller, "APP-1", "Fix it");
    assert.equal(first.status, "blocked");
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
  "routes provider questions to their thread and wakes the coordinator on worker completion",
  () =>
    Effect.gen(function* () {
      const h = harness();
      const { service, caller } = yield* h.setup;
      const first = yield* service.startIssue(caller, "APP-1", "Fix it");
      yield* service.deliver();
      h.finish(caller);
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
      assert.equal((yield* service.board(null)).tasks[0]?.status, "waiting");
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
      h.finish(first.threadId);
      yield* service.observe({
        ...eventBase(first.threadId),
        type: "thread.session-set",
        payload: {
          threadId: first.threadId,
          session: {
            threadId: first.threadId,
            status: "ready",
            providerName: "test",
            activeTurnId: null,
            runtimeMode: "approval-required",
            lastError: null,
            updatedAt: timestamp,
          },
        },
      });
      yield* service.deliver();
      const wakeups = h.commands.filter(
        (c) => c.type === "thread.turn.start" && c.threadId === caller,
      );
      assert.lengthOf(wakeups, 2);
      assert.equal((yield* service.board(null)).tasks[0]?.status, "working");
    }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("accepts a decision reply in the original thread without dispatching it twice", () =>
  Effect.gen(function* () {
    const h = harness();
    const { service, caller } = yield* h.setup;
    const first = yield* service.startIssue(caller, "APP-1", "Fix it");
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
    assert.lengthOf(
      h.commands.filter((c) => c.type === "thread.turn.start" && c.threadId === first.threadId),
      1,
    );
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect(
  "parks automatic work until activation and replays unanswered questions before delivery",
  () =>
    Effect.gen(function* () {
      const h = harness();
      const { service, caller } = yield* h.setup;
      const first = yield* service.startIssue(caller, "APP-1", "Fix it");
      h.replayEvents.push({
        ...eventBase(first.threadId),
        type: "thread.activity-appended",
        payload: {
          threadId: first.threadId,
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
      assert.lengthOf(
        h.commands.filter((c) => c.type === "thread.turn.start" && c.threadId === first.threadId),
        0,
      );
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
    yield* service.startIssue(caller, "APP-1", "Start when work arrives");
  }).pipe(Effect.provide(database()), Effect.scoped),
);
