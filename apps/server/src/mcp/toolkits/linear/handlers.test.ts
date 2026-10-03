import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  EnvironmentId,
  LinearOperationError,
  OrchestrationProjectShell,
  OrchestrationThreadShell,
  McpCapabilityUnavailableError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type LinearIssueDetail,
  type LinearIssueLabel,
  type LinearIssueSummary,
  type LinearWorkflowState,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer, Tool } from "effect/unstable/ai";

import * as AssistantEvidence from "../../../assistant/AssistantEvidence.ts";
import * as ServerConfig from "../../../config.ts";
import { LinearAgentOutbox } from "../../../linear/LinearAgentOutbox.ts";
import * as LinearApi from "../../../linear/LinearApi.ts";
import { LinearOAuth } from "../../../linear/LinearOAuth.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";
import * as McpApprovalBroker from "../../McpApprovalBroker.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { LinearToolkitHandlersLive } from "./handlers.ts";
import { LinearToolkit } from "./tools.ts";

/** `assert.instanceOf` narrows `unknown`, not the tool's failure union. */
function operationError(error: unknown): LinearOperationError {
  assert.instanceOf(error, LinearOperationError);
  return error;
}

function unavailableError(error: unknown): McpCapabilityUnavailableError {
  assert.instanceOf(error, McpCapabilityUnavailableError);
  return error;
}

const environmentId = EnvironmentId.make("environment-linear-mcp");
const threadId = ThreadId.make("thread-linear-mcp");
const projectId = ProjectId.make("project-linear-mcp");

const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
  caller: ThreadId = threadId,
) =>
  McpInvocationContext.McpInvocationContext.of({
    environmentId,
    threadId: caller,
    providerSessionId: "provider-session-linear-mcp",
    providerInstanceId: ProviderInstanceId.make("codex"),
    capabilities: new Set(capabilities),
    issuedAt: 1,
  });

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "linear-mcp-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "linear-mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const states: ReadonlyArray<LinearWorkflowState> = [
  { id: "state-2", name: "In Progress", type: "started", color: "#f2c94c", position: 2 },
  { id: "state-1", name: "Todo", type: "unstarted", color: "#bec2c8", position: 1 },
];

const labels: ReadonlyArray<LinearIssueLabel> = [
  { id: "label-1", name: "integration", color: "#5e6ad2" },
  { id: "label-2", name: "urgent", color: "#eb5757" },
];

const issue: LinearIssueDetail = {
  id: "issue-uuid",
  identifier: "DEL-123",
  title: "Wire up Linear",
  url: "https://linear.app/acme/issue/DEL-123",
  branchName: "ada/del-123-wire-up-linear",
  priority: 2,
  updatedAt: "2026-09-01T10:00:00.000Z",
  state: states[1]!,
  team: { id: "team-1", key: "DEL", name: "Delivery" },
  assignee: null,
  project: null,
  cycle: null,
  description: "Store the key on the server.",
  comments: [
    {
      id: "comment-1",
      body: "Started on this.",
      url: "https://linear.app/acme/issue/DEL-123#comment-1",
      createdAt: "2026-09-01T09:00:00.000Z",
      author: null,
    },
  ],
  parent: null,
  children: [],
  labels: [],
};

const createdIssue: LinearIssueSummary = {
  id: "issue-child-uuid",
  identifier: "DEL-124",
  title: "Follow up",
  url: "https://linear.app/acme/issue/DEL-124",
  branchName: "ada/del-124-follow-up",
  priority: 0,
  updatedAt: "2026-09-01T11:00:00.000Z",
  state: states[1]!,
  team: issue.team,
  assignee: null,
  project: null,
  cycle: null,
};

type LinearApiService = typeof LinearApi.LinearApi.Service;

const linearApiLayer = (overrides: Partial<LinearApiService>) =>
  Layer.succeed(
    LinearApi.LinearApi,
    LinearApi.LinearApi.of({
      status: Effect.die("unused"),
      getIssue: () => Effect.die("unused"),
      listIssues: () => Effect.die("unused"),
      workspace: Effect.die("unused"),
      workflowStates: () => Effect.die("unused"),
      updateIssueState: () => Effect.die("unused"),
      updateIssue: () => Effect.die("unused"),
      resolveAssignee: () => Effect.die("unused"),
      listResources: () => Effect.die("unused"),
      getResource: () => Effect.die("unused"),
      saveResource: () => Effect.die("unused"),
      createIssue: () => Effect.die("unused"),
      addIssueRelation: () => Effect.die("unused"),
      removeIssueRelation: () => Effect.die("unused"),
      archiveIssue: () => Effect.die("unused"),
      labels: () => Effect.die("unused"),
      createComment: () => Effect.die("unused"),
      getComment: () => Effect.die("unused"),
      updateComment: () => Effect.die("unused"),
      uploadFile: () => Effect.die("unused"),
      deleteComment: () => Effect.die("unused"),
      createAttachment: () => Effect.die("unused"),
      getAttachment: () => Effect.die("unused"),
      deleteAttachment: () => Effect.die("unused"),
      listDocuments: () => Effect.die("unused"),
      getDocument: () => Effect.die("unused"),
      saveDocument: () => Effect.die("unused"),
      deleteDocument: () => Effect.die("unused"),
      restoreDocument: () => Effect.die("unused"),
      ...overrides,
    }),
  );

const decodeThreadShell = Schema.decodeUnknownSync(OrchestrationThreadShell);

const threadShell = (linkedIssue: { readonly id: string } | null, session: boolean = false) =>
  decodeThreadShell({
    id: threadId,
    projectId,
    title: "Linear MCP test",
    modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4"),
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    session: session
      ? {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: "codex",
          runtimeMode: "full-access",
          activeTurnId: "turn-1",
          lastError: null,
          updatedAt: "2026-01-01T00:00:00.000Z",
        }
      : null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    linkedIssue:
      linkedIssue === null
        ? null
        : {
            provider: "linear",
            id: linkedIssue.id,
            identifier: "DEL-123",
            url: "https://linear.app/acme/issue/DEL-123",
          },
  });

const decodeProjectShell = Schema.decodeUnknownSync(OrchestrationProjectShell);

const projectShell = (workspaceRoot: string) =>
  decodeProjectShell({
    id: projectId,
    title: "Linear MCP test",
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

const projectionLayer = (
  linkedIssue: { readonly id: string } | null,
  session: boolean = false,
  workspaceRoot?: string,
) =>
  Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
    getTurnStartMessage: () => Effect.die("unused"),
    getImportedAgentSessionSources: () => Effect.die("unused"),
    listActivitiesByKind: () => Effect.die("unused"),
    getDeletedWorktreeThreads: () => Effect.die("unused"),
    getProjectShells: () => Effect.die("unused"),
    getUserInputActivity: () => Effect.die("unused"),
    getCommandReadModel: () => Effect.die("unused"),
    getSnapshot: () => Effect.die("unused"),
    getShellSnapshot: () => Effect.die("unused"),
    getArchivedShellSnapshot: () => Effect.die("unused"),
    getSnapshotSequence: () => Effect.die("unused"),
    getCounts: () => Effect.die("unused"),
    getEventReplayStats: () => Effect.die("unused"),
    getActiveProjectByWorkspaceRoot: () => Effect.die("unused"),
    getProjectShellById: () =>
      workspaceRoot === undefined
        ? Effect.die("unused")
        : Effect.succeed(Option.some(projectShell(workspaceRoot))),
    getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
    getThreadCheckpointContext: () => Effect.die("unused"),
    getFullThreadDiffContext: () => Effect.die("unused"),
    getThreadRuntimeContext: () => Effect.die("unused"),
    getThreadShellById: () => Effect.succeed(Option.some(threadShell(linkedIssue, session))),
    getThreadDetailById: () => Effect.die("unused"),
    getThreadDetailSnapshot: () => Effect.die("unused"),
    searchThreads: () => Effect.die("unused"),
    listThreadsWithPullRequests: () => Effect.die("unused"),
  });

/**
 * Most tests are about resolution, not confirmation, so writes are unconfirmed
 * unless a test asks for it; `confirmAgentWrites` defaults to on in production.
 */
const testLayer = (input: {
  readonly linear: Partial<LinearApiService>;
  readonly linkedIssue?: { readonly id: string } | null;
  readonly confirmAgentWrites?: boolean;
  readonly session?: boolean;
  /** Set for the tools that read files the agent named, unset for the rest. */
  readonly workspaceRoot?: string;
  /** T3's base directory, for the tests that read a team thread's evidence. */
  readonly evidenceBaseDir?: string;
  /** Whether the Linear app is connected with delegation on; off by default. */
  readonly appConnected?: boolean;
}) =>
  // `provideMerge` because the toolkit's own `handle` keeps the tool
  // dependencies in its requirements; the layer has to satisfy both sides.
  LinearToolkitHandlersLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        linearApiLayer(input.linear),
        projectionLayer(
          input.linkedIssue === undefined ? { id: issue.id } : input.linkedIssue,
          input.session ?? input.confirmAgentWrites === true,
          input.workspaceRoot,
        ),
        McpApprovalBroker.layer,
        ServerSettingsService.layerTest({
          linear: { confirmAgentWrites: input.confirmAgentWrites ?? false },
        }),
        WorkspacePaths.layer.pipe(Layer.provide(NodeServices.layer)),
        input.evidenceBaseDir === undefined
          ? Layer.mock(AssistantEvidence.AssistantEvidence)({})
          : evidenceLayer(input.evidenceBaseDir),
        Layer.mock(LinearAgentOutbox)({
          connected: Effect.succeed(input.appConnected ?? false),
        }),
        Layer.mock(LinearOAuth)({ accessToken: () => Effect.succeed("app-token") }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const evidenceLayer = (baseDir: string) =>
  AssistantEvidence.layer.pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
    Layer.provide(NodeServices.layer),
  );

const callTool = <Name extends keyof typeof LinearToolkit.tools>(
  name: Name,
  params: Tool.Parameters<(typeof LinearToolkit.tools)[Name]>,
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["linear"],
  caller: ThreadId = threadId,
) =>
  Effect.gen(function* () {
    const built = yield* LinearToolkit;
    return yield* built.handle(name, params).pipe(
      Stream.unwrap,
      Stream.run(Sink.last()),
      Effect.flatMap(Effect.fromOption),
      Effect.map((output) => output.result),
    );
  }).pipe(
    Effect.provideService(
      McpInvocationContext.McpInvocationContext,
      invocation(capabilities, caller) as McpInvocationContext.McpInvocationScope,
    ),
  );

it.effect("reads the thread's linked issue when the agent names none", () => {
  const requested: Array<string> = [];

  return callTool("get_issue", {}).pipe(
    Effect.map((result) => {
      assert.deepStrictEqual(requested, [issue.id]);
      assert.strictEqual((result as LinearIssueDetail).identifier, "DEL-123");
    }),
    Effect.provide(
      testLayer({
        linear: {
          getIssue: (input) =>
            Effect.sync(() => {
              requested.push(input.reference);
              return issue;
            }),
        },
      }),
    ),
  );
});

it.effect("tells the agent to name an issue when the thread is linked to none", () =>
  Effect.flip(callTool("get_issue", {})).pipe(
    Effect.map((error) => {
      assert.include(operationError(error).detail, "not linked to a Linear issue");
    }),
    Effect.provide(testLayer({ linear: {}, linkedIssue: null })),
  ),
);

it.effect("refuses every Linear tool when the credential lacks the capability", () =>
  Effect.flip(callTool("get_issue", { id: "DEL-123" }, ["preview"])).pipe(
    Effect.map((error) => {
      assert.strictEqual(unavailableError(error).capability, "linear");
    }),
    Effect.provide(testLayer({ linear: {} })),
  ),
);

it.effect("lists a team's states in board order, resolved by team key", () => {
  const requestedTeams: Array<string> = [];

  return callTool("list_issue_statuses", { team: "del" }).pipe(
    Effect.map((result) => {
      const listed = result as { readonly team: { readonly id: string }; readonly states: unknown };
      assert.deepStrictEqual(requestedTeams, ["team-1"]);
      assert.strictEqual(listed.team.id, "team-1");
      assert.deepStrictEqual(listed.states, [states[1], states[0]]);
    }),
    Effect.provide(
      testLayer({
        linear: {
          workspace: Effect.succeed({
            teams: [{ id: "team-1", key: "DEL", name: "Delivery", projects: [] }],
          }),
          workflowStates: (teamId) =>
            Effect.sync(() => {
              requestedTeams.push(teamId);
              return states;
            }),
        },
      }),
    ),
  );
});

it.effect("saves a state and labels the agent named in words", () => {
  const patches: Array<unknown> = [];

  return callTool("save_issue", { state: "in progress", labels: ["Urgent"] }).pipe(
    Effect.map(() => {
      assert.deepStrictEqual(patches, [
        { issueId: "issue-uuid", stateId: "state-2", labelIds: ["label-2"] },
      ]);
    }),
    Effect.provide(
      testLayer({
        linear: {
          getIssue: () => Effect.succeed(issue),
          workflowStates: () => Effect.succeed(states),
          labels: () => Effect.succeed(labels),
          updateIssue: (patch) => Effect.sync(() => void patches.push(patch)),
        },
      }),
    ),
  );
});

it.effect("refuses a save that would change nothing", () =>
  Effect.flip(callTool("save_issue", { id: "DEL-123" })).pipe(
    Effect.map((error) => {
      assert.strictEqual(
        operationError(error).detail,
        "Nothing to save: pass at least one issue field to update.",
      );
    }),
    Effect.provide(testLayer({ linear: {} })),
  ),
);

it.effect("names the labels it could not match", () =>
  Effect.flip(callTool("save_issue", { labels: ["ghost"] })).pipe(
    Effect.map((error) => {
      const { detail } = operationError(error);
      assert.include(detail, '"ghost"');
      assert.include(detail, "integration, urgent");
    }),
    Effect.provide(
      testLayer({
        linear: { getIssue: () => Effect.succeed(issue), labels: () => Effect.succeed(labels) },
      }),
    ),
  ),
);

it.effect("files a new issue under the thread's issue by default", () => {
  const created: Array<unknown> = [];

  return callTool("create_issue", { title: "Follow up" }).pipe(
    Effect.map((result) => {
      assert.deepStrictEqual(created, [
        { teamId: "team-1", title: "Follow up", parentId: "issue-uuid" },
      ]);
      assert.strictEqual((result as LinearIssueSummary).identifier, "DEL-124");
    }),
    Effect.provide(
      testLayer({
        linear: {
          getIssue: () => Effect.succeed(issue),
          createIssue: (input) =>
            Effect.sync(() => {
              created.push(input);
              return createdIssue;
            }),
        },
      }),
    ),
  );
});

it.effect("creates a standalone issue when the agent passes a null parent", () => {
  const created: Array<unknown> = [];

  return callTool("create_issue", { title: "Follow up", parentId: null }).pipe(
    Effect.map(() => {
      // The team still comes from the thread's issue; only the parent is dropped.
      assert.deepStrictEqual(created, [{ teamId: "team-1", title: "Follow up" }]);
    }),
    Effect.provide(
      testLayer({
        linear: {
          getIssue: () => Effect.succeed(issue),
          createIssue: (input) =>
            Effect.sync(() => {
              created.push(input);
              return createdIssue;
            }),
        },
      }),
    ),
  );
});

it.effect("returns the issue's comments with the issue they belong to", () =>
  callTool("list_comments", {}).pipe(
    Effect.map((result) => {
      assert.deepStrictEqual(result, {
        issue: { id: issue.id, identifier: issue.identifier, url: issue.url },
        comments: issue.comments,
      });
    }),
    Effect.provide(testLayer({ linear: { getIssue: () => Effect.succeed(issue) } })),
  ),
);

it.effect("says when the issue has more comments than it read", () =>
  callTool("list_comments", {}).pipe(
    Effect.map((result) => {
      assert.isTrue((result as { readonly truncated?: boolean }).truncated);
    }),
    Effect.provide(
      testLayer({
        linear: { getIssue: () => Effect.succeed({ ...issue, truncated: ["comments"] }) },
      }),
    ),
  ),
);

it.effect("advertises the Linear tools on the MCP server itself", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;

    const advertised = yield* server
      .callTool({ name: "get_issue", arguments: {} })
      .pipe(
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          invocation(["linear"]) as McpInvocationContext.McpInvocationScope,
        ),
        Effect.provideService(McpSchema.McpServerClient, client),
      );

    assert.strictEqual(advertised.isError, false);
    assert.strictEqual(
      (advertised.structuredContent as { readonly identifier: string }).identifier,
      "DEL-123",
    );
  }).pipe(
    Effect.provide(
      McpServer.toolkit(LinearToolkit).pipe(
        Layer.provide(LinearToolkitHandlersLive),
        Layer.provideMerge(
          Layer.mergeAll(
            linearApiLayer({ getIssue: () => Effect.succeed(issue) }),
            projectionLayer({ id: issue.id }),
            McpApprovalBroker.layer,
            ServerSettingsService.layerTest({ linear: { confirmAgentWrites: false } }),
            Layer.mock(AssistantEvidence.AssistantEvidence)({}),
          ),
        ),
        Layer.provideMerge(McpServer.McpServer.layer),
      ),
    ),
  ),
);

/** The next event the broker raises; the queue buffers, so this never races the tool call. */
const nextApprovalEvent = Effect.gen(function* () {
  const broker = yield* McpApprovalBroker.McpApprovalBroker;
  const [event] = yield* Stream.runCollect(Stream.take(broker.streamEvents, 1));
  return event as ProviderRuntimeEvent;
});

/** The parts of an approval a test reads: its one-line summary, the change, and the call it guards. */
const decodeApprovalReview = Schema.decodeUnknownEffect(
  Schema.Struct({ detail: Schema.String, change: Schema.Unknown, args: Schema.Unknown }),
);

const answer = (event: ProviderRuntimeEvent, decision: "accept" | "acceptForSession" | "decline") =>
  Effect.gen(function* () {
    const broker = yield* McpApprovalBroker.McpApprovalBroker;
    return yield* broker.respond({
      threadId: event.threadId,
      requestId: ApprovalRequestId.make(String(event.requestId)),
      decision,
    });
  });

it.effect("asks before it comments, and writes only once the user approves", () => {
  const created: Array<unknown> = [];

  return Effect.scoped(
    Effect.gen(function* () {
      const pending = yield* Effect.forkScoped(callTool("save_comment", { body: "Shipped it." }));

      const opened = yield* nextApprovalEvent;
      assert.strictEqual(opened.type, "request.opened");
      assert.deepStrictEqual(opened.payload, {
        requestType: "integration_write_approval",
        appName: "Linear",
        detail: "Comment on DEL-123\n\nShipped it.",
        options: [
          { decision: "decline", label: "Decline" },
          { decision: "acceptForSession", label: "Allow for this session" },
          { decision: "accept", label: "Approve" },
        ],
        // The row shows the detail; the review dialog reads this, so the
        // comment travels whole and marked as the markdown Linear renders.
        change: {
          summary: "Comment on DEL-123",
          record: { label: "DEL-123", url: issue.url },
          fields: [{ label: "Comment", value: "Shipped it.", format: "markdown" }],
        },
        args: { body: "Shipped it.", issueId: issue.id },
      });
      // Nothing is written while the card is open.
      assert.deepStrictEqual(created, []);

      assert.isTrue(yield* answer(opened, "accept"));
      yield* Fiber.join(pending);
      assert.deepStrictEqual(created, [{ issueId: issue.id, body: "Shipped it." }]);
    }),
  ).pipe(
    Effect.provide(
      testLayer({
        linear: {
          getIssue: () => Effect.succeed(issue),
          createComment: (input) =>
            Effect.sync(() => {
              created.push(input);
              return {
                id: "comment-2",
                url: "https://linear.app/acme/issue/DEL-123#comment-2",
              };
            }),
        },
        confirmAgentWrites: true,
      }),
    ),
  );
});

// A delegated run writes as the app, so the write borrows nobody's name and
// the approval would have no one to address. Completing without an answer is
// the proof: a confirmed write parks on the broker until the user replies.
it.effect("writes without asking when the run is delegated", () => {
  const created: Array<string> = [];

  return callTool("save_comment", { body: "Shipped it." }).pipe(
    Effect.provideService(LinearApi.LinearAppCredential, Effect.succeed("app-token")),
    Effect.map(() => {
      assert.deepStrictEqual(created, ["Shipped it."]);
    }),
    Effect.provide(
      testLayer({
        linear: {
          getIssue: () => Effect.succeed(issue),
          createComment: (input) =>
            Effect.sync(() => {
              created.push(input.body);
              return {
                id: "comment-3",
                url: "https://linear.app/acme/issue/DEL-123#comment-3",
              };
            }),
        },
        confirmAgentWrites: true,
      }),
    ),
  );
});

/** The identity a stubbed Linear call ran under: the app's token, or the person's key. */
const author = Effect.gen(function* () {
  const credential = yield* LinearApi.LinearAppCredential;
  return credential === undefined ? "person" : yield* credential.pipe(Effect.orDie);
});

const teamThreadId = ThreadId.make("assistant-review-task-1");

const commentAuthors = (input: {
  readonly thread: ThreadId;
  readonly appConnected: boolean;
  readonly confirmAgentWrites?: boolean;
}) => {
  const authors: Array<string> = [];
  return callTool("save_comment", { body: "Reviewed." }, ["linear"], input.thread).pipe(
    Effect.map(() => authors),
    Effect.provide(
      testLayer({
        linear: {
          getIssue: () => Effect.succeed(issue),
          createComment: () =>
            author.pipe(
              Effect.map((name) => {
                authors.push(name);
                return { id: "comment-4", url: "https://linear.app/acme/issue/DEL-123#comment-4" };
              }),
            ),
        },
        appConnected: input.appConnected,
        confirmAgentWrites: input.confirmAgentWrites ?? false,
      }),
    ),
  );
};

// Completing with confirmation on is part of the proof: a write that goes out
// as the app has no borrowed identity to approve, as for a delegated run.
it.effect("posts a team thread's comment as the Linear app while it is connected", () =>
  commentAuthors({ thread: teamThreadId, appConnected: true, confirmAgentWrites: true }).pipe(
    Effect.map((authors) => assert.deepStrictEqual(authors, ["app-token"])),
  ),
);

it.effect("posts a team thread's comment as the person when the app is not connected", () =>
  commentAuthors({ thread: teamThreadId, appConnected: false }).pipe(
    Effect.map((authors) => assert.deepStrictEqual(authors, ["person"])),
  ),
);

it.effect("posts an ordinary thread's comment as the person even with the app connected", () =>
  commentAuthors({ thread: threadId, appConnected: true }).pipe(
    Effect.map((authors) => assert.deepStrictEqual(authors, ["person"])),
  ),
);

it.effect("files a team thread's issue as the app and keeps its reads on the person", () => {
  const calls: Array<string> = [];
  return callTool("create_issue", { title: "Follow up" }, ["linear"], teamThreadId).pipe(
    Effect.map(() => assert.deepStrictEqual(calls, ["getIssue:person", "createIssue:app-token"])),
    Effect.provide(
      testLayer({
        linear: {
          getIssue: () =>
            author.pipe(
              Effect.map((name) => {
                calls.push(`getIssue:${name}`);
                return issue;
              }),
            ),
          createIssue: () =>
            author.pipe(
              Effect.map((name) => {
                calls.push(`createIssue:${name}`);
                return createdIssue;
              }),
            ),
        },
        appConnected: true,
      }),
    ),
  );
});

it.effect("tells the agent to stop when the user declines, without calling Linear", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const pending = yield* Effect.forkScoped(
        Effect.flip(callTool("save_comment", { body: "Shipped it." })),
      );
      const opened = yield* nextApprovalEvent;
      yield* answer(opened, "decline");

      const error = operationError(yield* Fiber.join(pending));
      assert.strictEqual(error.operation, "save_comment");
      assert.include(error.detail, "declined this change");
    }),
  ).pipe(
    Effect.provide(
      testLayer({
        linear: {
          getIssue: () => Effect.succeed(issue),
          createComment: () => Effect.die("Linear must not be called for a declined write"),
        },
        confirmAgentWrites: true,
      }),
    ),
  ),
);

it.effect("asks once when the user allows the rest of the session", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const first = yield* Effect.forkScoped(callTool("save_comment", { body: "First." }));
      yield* answer(yield* nextApprovalEvent, "acceptForSession");
      yield* Fiber.join(first);

      // Nobody answers this one: it can only finish because the grant holds.
      yield* callTool("save_comment", { body: "Second." });
    }),
  ).pipe(
    Effect.provide(
      testLayer({
        linear: {
          getIssue: () => Effect.succeed(issue),
          createComment: () =>
            Effect.succeed({
              id: "comment-2",
              url: "https://linear.app/acme/issue/DEL-123#comment-2",
            }),
        },
        confirmAgentWrites: true,
      }),
    ),
  ),
);

it.effect("summarizes the fields a confirmed issue update would change", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const pending = yield* Effect.forkScoped(
        callTool("save_issue", { state: "in progress", labels: ["Urgent"], title: "Renamed" }),
      );
      const opened = yield* nextApprovalEvent;
      assert.strictEqual(
        (opened.payload as { readonly detail: string }).detail,
        "Update DEL-123\nTitle: Renamed\nState: In Progress\nLabels: urgent",
      );
      assert.deepStrictEqual(
        (opened.payload as { readonly change: { readonly fields: unknown } }).change.fields,
        [
          { label: "Title", value: "Renamed" },
          { label: "State", value: "In Progress" },
          { label: "Labels", value: "urgent" },
        ],
      );
      yield* answer(opened, "accept");
      yield* Fiber.join(pending);
    }),
  ).pipe(
    Effect.provide(
      testLayer({
        linear: {
          getIssue: () => Effect.succeed(issue),
          workflowStates: () => Effect.succeed(states),
          labels: () => Effect.succeed(labels),
          updateIssue: () => Effect.void,
        },
        confirmAgentWrites: true,
      }),
    ),
  ),
);

it.effect("sends the description it would overwrite, whole, for review", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const description = `## Plan\n\n${"long line ".repeat(60)}`;
      const pending = yield* Effect.forkScoped(callTool("save_issue", { description }));
      const opened = yield* nextApprovalEvent;

      const { change, detail } = opened.payload as {
        readonly change: { readonly fields: ReadonlyArray<Record<string, unknown>> };
        readonly detail: string;
      };
      // A description replaces what the issue says now, so approving it means
      // reading it. The row's detail is still clipped to one line's worth.
      assert.deepStrictEqual(change.fields, [
        { label: "Description", value: description, format: "markdown" },
      ]);
      assert.isBelow(detail.length, description.length);

      yield* answer(opened, "accept");
      yield* Fiber.join(pending);
    }),
  ).pipe(
    Effect.provide(
      testLayer({
        linear: {
          getIssue: () => Effect.succeed(issue),
          updateIssue: () => Effect.void,
        },
        confirmAgentWrites: true,
      }),
    ),
  ),
);

it.effect("never raises an approval when confirmation is off", () =>
  Effect.gen(function* () {
    const broker = yield* McpApprovalBroker.McpApprovalBroker;
    yield* callTool("save_comment", { body: "Shipped it." });
    assert.isFalse(
      yield* broker.respond({
        threadId,
        requestId: ApprovalRequestId.make("any"),
        decision: "accept",
      }),
    );
  }).pipe(
    Effect.provide(
      testLayer({
        linear: {
          getIssue: () => Effect.succeed(issue),
          createComment: () =>
            Effect.succeed({
              id: "comment-2",
              url: "https://linear.app/acme/issue/DEL-123#comment-2",
            }),
        },
        session: true,
      }),
    ),
  ),
);

it.effect("refuses to write when the thread has no session to ask through", () =>
  Effect.flip(callTool("save_comment", { body: "Shipped it." })).pipe(
    Effect.map((error) => {
      assert.include(operationError(error).detail, "no active session");
    }),
    Effect.provide(
      testLayer({
        linear: {
          getIssue: () => Effect.succeed(issue),
          createComment: () => Effect.die("Linear must not be called without a confirmation"),
        },
        confirmAgentWrites: true,
        session: false,
      }),
    ),
  ),
);

for (const decision of ["accept", "decline"] as const) {
  it.effect(`edits a comment only after approval: ${decision}`, () => {
    const updated: Array<unknown> = [];
    return Effect.scoped(
      Effect.gen(function* () {
        const pending = yield* Effect.forkScoped(
          Effect.result(
            callTool("save_comment", { id: "old-comment", body: "Corrected finding." }),
          ),
        );
        const opened = yield* nextApprovalEvent;
        const review = yield* Schema.decodeUnknownEffect(Schema.Struct({ detail: Schema.String }))(
          opened.payload,
        );
        assert.include(review.detail, "Edit comment on DEL-123");
        assert.include(review.detail, "Corrected finding.");
        assert.deepStrictEqual(updated, []);
        yield* answer(opened, decision);
        yield* Fiber.join(pending);
        assert.deepStrictEqual(
          updated,
          decision === "accept" ? [{ id: "old-comment", body: "Corrected finding." }] : [],
        );
      }),
    ).pipe(
      Effect.provide(
        testLayer({
          linear: {
            getComment: () =>
              Effect.succeed({
                id: "old-comment",
                body: "Original.",
                url: issue.url + "#old-comment",
                issue: { id: issue.id },
              }),
            getIssue: (id) => {
              assert.deepStrictEqual(id, { reference: issue.id });
              return Effect.succeed(issue);
            },
            updateComment: (input) =>
              Effect.sync(() => {
                updated.push(input);
                return { id: input.id, url: issue.url + "#old-comment" };
              }),
          },
          confirmAgentWrites: true,
        }),
      ),
    );
  });
}

it.effect("rejects a comment from a different issue before approval or mutation", () =>
  Effect.gen(function* () {
    const error = operationError(
      yield* Effect.flip(
        callTool("save_comment", { id: "other-comment", issueId: issue.id, body: "Changed." }),
      ),
    );
    assert.include(error.detail, "does not belong");
  }).pipe(
    Effect.provide(
      testLayer({
        linear: {
          getComment: () =>
            Effect.succeed({
              id: "other-comment",
              body: "Original.",
              url: issue.url,
              issue: { id: "other-issue" },
            }),
          getIssue: () => Effect.succeed(issue),
        },
        confirmAgentWrites: true,
      }),
    ),
  ),
);

it.effect("replies at the root of the thread the agent named, on that comment's issue", () => {
  const created: Array<unknown> = [];
  const read: Array<string> = [];
  return callTool("save_comment", { parentId: "reply-1", body: "Agreed." }).pipe(
    Effect.map(() => {
      // The parent's issue wins over the thread's link, and a reply to a reply
      // joins the thread its parent belongs to.
      assert.deepStrictEqual(read, [issue.id]);
      assert.deepStrictEqual(created, [
        { issueId: issue.id, body: "Agreed.", parentId: "comment-1" },
      ]);
    }),
    Effect.provide(
      testLayer({
        linear: {
          getComment: (id) =>
            Effect.succeed({
              id,
              body: "Should we ship?",
              url: `${issue.url}#${id}`,
              issue: { id: issue.id },
              parentId: "comment-1",
            }),
          getIssue: ({ reference }) => {
            read.push(reference);
            return Effect.succeed(issue);
          },
          createComment: (input) =>
            Effect.sync(() => {
              created.push(input);
              return { id: "reply-2", url: `${issue.url}#reply-2` };
            }),
        },
        linkedIssue: { id: "linked-elsewhere" },
      }),
    ),
  );
});

it.effect("replies under a top-level comment directly", () => {
  const created: Array<unknown> = [];
  return callTool("save_comment", { parentId: "comment-1", body: "Agreed." }).pipe(
    Effect.map(() => {
      assert.deepStrictEqual(created, [
        { issueId: issue.id, body: "Agreed.", parentId: "comment-1" },
      ]);
    }),
    Effect.provide(
      testLayer({
        linear: {
          getComment: (id) =>
            Effect.succeed({
              id,
              body: "Started on this.",
              url: `${issue.url}#${id}`,
              issue: { id: issue.id },
              parentId: null,
            }),
          getIssue: () => Effect.succeed(issue),
          createComment: (input) =>
            Effect.sync(() => {
              created.push(input);
              return { id: "reply-2", url: `${issue.url}#reply-2` };
            }),
        },
      }),
    ),
  );
});

it.effect("refuses to move an edited comment into another thread", () =>
  Effect.gen(function* () {
    const error = operationError(
      yield* Effect.flip(
        callTool("save_comment", { id: "comment-1", parentId: "comment-2", body: "Moved." }),
      ),
    );
    assert.include(error.detail, "only when creating a reply");
  }).pipe(Effect.provide(testLayer({ linear: {} }))),
);

for (const decision of ["accept", "decline"] as const) {
  it.effect(`deletes a comment only after approval: ${decision}`, () => {
    const deleted: Array<string> = [];
    return Effect.scoped(
      Effect.gen(function* () {
        const pending = yield* Effect.forkScoped(
          Effect.result(callTool("delete_comment", { id: "old-comment" })),
        );
        const opened = yield* nextApprovalEvent;
        const review = yield* decodeApprovalReview(opened.payload);
        // The person sees what disappears before it does.
        assert.strictEqual(review.detail, "Delete comment on DEL-123\n\nWrong finding.");
        assert.deepStrictEqual(review.args, { id: "old-comment", issueId: issue.id });
        assert.deepStrictEqual(deleted, []);
        yield* answer(opened, decision);
        const result = yield* Fiber.join(pending);
        assert.deepStrictEqual(deleted, decision === "accept" ? ["old-comment"] : []);
        if (decision === "accept") {
          assert.deepStrictEqual(result._tag === "Success" ? result.success : undefined, {
            id: "old-comment",
            issue: { id: issue.id, identifier: issue.identifier, url: issue.url },
          });
        }
      }),
    ).pipe(
      Effect.provide(
        testLayer({
          linear: {
            getComment: () =>
              Effect.succeed({
                id: "old-comment",
                body: "Wrong finding.",
                url: issue.url + "#old-comment",
                issue: { id: issue.id },
              }),
            getIssue: () => Effect.succeed(issue),
            deleteComment: (id) =>
              Effect.sync(() => {
                deleted.push(id);
              }),
          },
          confirmAgentWrites: true,
        }),
      ),
    );
  });
}

for (const assignee of ["Ada", null]) {
  it.effect(`updates assignment with ${assignee}`, () => {
    const patches: unknown[] = [];
    return callTool("save_issue", { assignee }).pipe(
      Effect.map(() =>
        assert.deepStrictEqual(patches, [
          {
            issueId: issue.id,
            assigneeId: assignee === null ? null : "user-1",
          },
        ]),
      ),
      Effect.provide(
        testLayer({
          linear: {
            getIssue: () => Effect.succeed(issue),
            resolveAssignee: (reference) => {
              assert.equal(reference, "Ada");
              return Effect.succeed({ id: "user-1", name: "Ada Lovelace", displayName: "ada" });
            },
            updateIssue: (patch) => Effect.sync(() => void patches.push(patch)),
          },
        }),
      ),
    );
  });
}

it.effect("shows the assignee for approval and does not reassign after rejection", () => {
  const patches: unknown[] = [];
  return Effect.scoped(
    Effect.gen(function* () {
      const pending = yield* Effect.forkScoped(
        callTool("save_issue", { assignee: "Ada" }).pipe(Effect.flip),
      );
      const opened = yield* nextApprovalEvent;
      assert.deepStrictEqual(
        (opened.payload as { readonly change: { readonly fields: unknown } }).change.fields,
        [{ label: "Assignee", value: "ada (user-1)" }],
      );
      yield* answer(opened, "decline");
      yield* Fiber.join(pending);
      assert.deepStrictEqual(patches, []);
    }),
  ).pipe(
    Effect.provide(
      testLayer({
        linear: {
          getIssue: () => Effect.succeed(issue),
          resolveAssignee: () =>
            Effect.succeed({ id: "user-1", name: "Ada Lovelace", displayName: "ada" }),
          updateIssue: (patch) => Effect.sync(() => void patches.push(patch)),
        },
        confirmAgentWrites: true,
      }),
    ),
  );
});

it.effect(
  "resolves project, milestone, and cycle in context and returns stored planning fields",
  () => {
    const patches: unknown[] = [];
    const lookups: unknown[] = [];
    const updated = { ...issue, estimate: 3, milestone: { id: "milestone-1", name: "Launch" } };
    return callTool("save_issue", {
      project: "Website",
      milestone: "Launch",
      cycle: "current",
      estimate: 3,
      priority: 2,
      dueDate: "2026-10-01",
      labels: ["Urgent"],
    }).pipe(
      Effect.map((result) => {
        assert.deepStrictEqual(patches, [
          {
            issueId: issue.id,
            projectId: "project-1",
            projectMilestoneId: "milestone-1",
            cycleId: "cycle-1",
            estimate: 3,
            priority: 2,
            dueDate: "2026-10-01",
            labelIds: ["label-2"],
          },
        ]);
        assert.deepStrictEqual(lookups, [
          { kind: "project", exact: "Website", teamId: issue.team.id, limit: 2 },
          { kind: "milestone", exact: "Launch", projectId: "project-1", limit: 2 },
          { kind: "cycle", exact: "current", teamId: issue.team.id, limit: 2 },
        ]);
        assert.deepStrictEqual(result, updated);
      }),
      Effect.provide(
        testLayer({
          linear: {
            getIssue: () => Effect.succeed(patches.length ? updated : issue),
            listResources: (input) =>
              Effect.sync(() => {
                lookups.push(input);
                return {
                  nodes: [{ id: `${input.kind}-1`, name: input.exact! }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                };
              }),
            labels: () => Effect.succeed(labels),
            updateIssue: (patch) => Effect.sync(() => void patches.push(patch)),
          },
        }),
      ),
    );
  },
);

it.effect("clears project and its milestone while preserving omitted fields", () => {
  const patches: unknown[] = [];
  return callTool("save_issue", { project: null, estimate: 0 }).pipe(
    Effect.map(() =>
      assert.deepStrictEqual(patches, [
        { issueId: issue.id, projectId: null, projectMilestoneId: null, estimate: 0 },
      ]),
    ),
    Effect.provide(
      testLayer({
        linear: {
          getIssue: () =>
            Effect.succeed({
              ...issue,
              project: { id: "p1", name: "Old", url: "https://linear.app/project/p1" },
            }),
          updateIssue: (patch) => Effect.sync(() => void patches.push(patch)),
        },
      }),
    ),
  );
});

it.effect("refuses a milestone without a project before any write", () =>
  Effect.flip(callTool("save_issue", { milestone: "Launch" })).pipe(
    Effect.map((error) => assert.include(operationError(error).detail, "Set a project")),
    Effect.provide(
      testLayer({ linear: { getIssue: () => Effect.succeed({ ...issue, project: null }) } }),
    ),
  ),
);

it.effect("rejects ambiguous project names before writing", () =>
  Effect.flip(callTool("save_issue", { project: "Website" })).pipe(
    Effect.map((error) => assert.include(operationError(error).detail, "More than one project")),
    Effect.provide(
      testLayer({
        linear: {
          getIssue: () => Effect.succeed(issue),
          listResources: () =>
            Effect.succeed({
              nodes: [
                { id: "p1", name: "Website" },
                { id: "p2", name: "Website" },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            }),
        },
      }),
    ),
  ),
);

it.effect("creates issues with planning metadata", () => {
  const created: unknown[] = [];
  return callTool("create_issue", {
    title: "Plan",
    project: "Website",
    milestone: "Launch",
    cycle: "12",
    estimate: 2,
  }).pipe(
    Effect.map(() =>
      assert.deepStrictEqual(created, [
        {
          teamId: issue.team.id,
          title: "Plan",
          parentId: issue.id,
          projectId: "project-1",
          projectMilestoneId: "milestone-1",
          cycleId: "cycle-1",
          estimate: 2,
        },
      ]),
    ),
    Effect.provide(
      testLayer({
        linear: {
          getIssue: () => Effect.succeed(issue),
          listResources: (input) =>
            Effect.succeed({
              nodes: [{ id: `${input.kind}-1`, name: input.exact! }],
              pageInfo: { hasNextPage: false, endCursor: null },
            }),
          createIssue: (input) =>
            Effect.sync(() => {
              created.push(input);
              return issue;
            }),
        },
      }),
    ),
  );
});

it.effect("resource creation waits for approval and rejection performs no write", () => {
  const writes: unknown[] = [];
  return Effect.scoped(
    Effect.gen(function* () {
      const pending = yield* Effect.forkScoped(
        callTool("save_issue_label", { name: "Regression", color: "#ff0000" }).pipe(Effect.flip),
      );
      const opened = yield* nextApprovalEvent;
      assert.include((opened.payload as { detail: string }).detail, "Regression");
      assert.deepStrictEqual(writes, []);
      yield* answer(opened, "decline");
      yield* Fiber.join(pending);
      assert.deepStrictEqual(writes, []);
    }),
  ).pipe(
    Effect.provide(
      testLayer({
        linear: {
          saveResource: (input) =>
            Effect.sync(() => {
              writes.push(input);
              return { id: "label-1", name: "Regression" };
            }),
        },
        confirmAgentWrites: true,
      }),
    ),
  );
});

it.effect("creates a project in the linked issue's team", () => {
  const writes: unknown[] = [];
  return callTool("save_project", { name: "Website", targetDate: "2026-10-01" }).pipe(
    Effect.map(() =>
      assert.deepStrictEqual(writes, [
        { kind: "project", name: "Website", teamIds: [issue.team.id], targetDate: "2026-10-01" },
      ]),
    ),
    Effect.provide(
      testLayer({
        linear: {
          getIssue: () => Effect.succeed(issue),
          saveResource: (input) =>
            Effect.sync(() => {
              writes.push(input);
              return { id: "project-1", name: "Website" };
            }),
        },
      }),
    ),
  );
});

it.effect("lists cycles with pagination in the linked team", () => {
  const calls: unknown[] = [];
  return callTool("list_cycles", { cursor: "next", limit: 10 }).pipe(
    Effect.map(() =>
      assert.deepStrictEqual(calls, [
        { kind: "cycle", cursor: "next", limit: 10, teamId: issue.team.id },
      ]),
    ),
    Effect.provide(
      testLayer({
        linear: {
          getIssue: () => Effect.succeed(issue),
          listResources: (input) =>
            Effect.sync(() => {
              calls.push(input);
              return { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
            }),
        },
      }),
    ),
  );
});

it.effect("searches issues across assignees with a title and cursor", () => {
  const calls: unknown[] = [];
  return callTool("list_issues", {
    query: "retry",
    assignee: null,
    cursor: "next",
    limit: 20,
  }).pipe(
    Effect.map(() =>
      assert.deepStrictEqual(calls, [
        { assignedToMe: false, query: "retry", assigneeId: null, cursor: "next", limit: 20 },
      ]),
    ),
    Effect.provide(
      testLayer({
        linear: {
          listIssues: (input) =>
            Effect.sync(() => {
              calls.push(input);
              return { issues: [], pageInfo: { hasNextPage: false, endCursor: null } };
            }),
        },
      }),
    ),
  );
});

it.effect(
  "filters issues by labels, milestone, cycle and priority resolved within the team",
  () => {
    const lookups: unknown[] = [];
    const listed: unknown[] = [];
    return callTool("list_issues", {
      team: "DEL",
      project: "Launch",
      milestone: "Beta",
      cycle: "current",
      labels: ["Urgent"],
      priority: 1,
    }).pipe(
      Effect.map(() => {
        assert.deepStrictEqual(lookups, [
          { kind: "project", exact: "Launch", teamId: "team-1", limit: 2 },
          { kind: "milestone", exact: "Beta", projectId: "project-1", limit: 2 },
          { kind: "cycle", exact: "current", teamId: "team-1", limit: 2 },
        ]);
        assert.deepStrictEqual(listed, [
          {
            assignedToMe: false,
            teamKey: "DEL",
            projectId: "project-1",
            projectMilestoneId: "milestone-1",
            cycleId: "cycle-1",
            labelIds: ["label-2"],
            priorities: [1],
          },
        ]);
      }),
      Effect.provide(
        testLayer({
          linear: {
            workspace: Effect.succeed({ teams: [{ ...issue.team, projects: [] }] }),
            labels: () => Effect.succeed(labels),
            listResources: (input) =>
              Effect.sync(() => {
                lookups.push(input);
                return {
                  nodes: [{ id: `${input.kind}-1`, name: input.exact ?? null }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                };
              }),
            listIssues: (input) =>
              Effect.sync(() => {
                listed.push(input);
                return { issues: [] };
              }),
          },
        }),
      ),
    );
  },
);

it.effect("matches label names across teams and finds a cycle by name in the linked team", () => {
  const milestoneId = "12345678-1234-1234-1234-123456789abc";
  const lookups: unknown[] = [];
  const listed: unknown[] = [];
  return callTool("list_issues", {
    milestone: milestoneId,
    cycle: "Sprint 4",
    labels: ["bug", "regression"],
    priority: [1, 2],
  }).pipe(
    Effect.map(() => {
      // The milestone's id needs no project, and the cycle's name falls back to
      // the linked issue's team; label names are not narrowed to any team.
      assert.deepStrictEqual(lookups, [
        { kind: "milestone", exact: milestoneId, limit: 2 },
        { kind: "cycle", exact: "Sprint 4", teamId: issue.team.id, limit: 2 },
        { kind: "label", exact: "bug", limit: 100 },
        { kind: "label", exact: "regression", limit: 100 },
      ]);
      assert.deepStrictEqual(listed, [
        {
          assignedToMe: false,
          projectMilestoneId: milestoneId,
          cycleId: "cycle-1",
          labelIds: ["bug-team-1", "bug-team-2", "regression-1"],
          priorities: [1, 2],
        },
      ]);
    }),
    Effect.provide(
      testLayer({
        linear: {
          getIssue: () => Effect.succeed(issue),
          listResources: (input) =>
            Effect.sync(() => {
              lookups.push(input);
              const ids =
                input.kind === "milestone"
                  ? [milestoneId]
                  : input.exact === "bug"
                    ? ["bug-team-1", "bug-team-2"]
                    : [`${input.exact === "regression" ? "regression" : input.kind}-1`];
              return {
                nodes: ids.map((id) => ({ id, name: input.exact ?? null })),
                pageInfo: { hasNextPage: false, endCursor: null },
              };
            }),
          listIssues: (input) =>
            Effect.sync(() => {
              listed.push(input);
              return { issues: [] };
            }),
        },
      }),
    ),
  );
});

it.effect("names a label filter that matches nothing instead of listing no issues", () =>
  Effect.flip(callTool("list_issues", { labels: ["nope"] })).pipe(
    Effect.map((error) =>
      assert.strictEqual(
        operationError(error).detail,
        'Linear has no label matching "nope". Use list_issue_labels to find it.',
      ),
    ),
    Effect.provide(
      testLayer({
        linear: {
          listResources: () =>
            Effect.succeed({ nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }),
        },
      }),
    ),
  ),
);

it.effect("archives an issue only once the user approves, then reads it back", () => {
  const archived: unknown[] = [];
  let stored: LinearIssueDetail = issue;
  return Effect.scoped(
    Effect.gen(function* () {
      const pending = yield* Effect.forkScoped(callTool("archive_issue", { id: "DEL-123" }));
      const opened = yield* nextApprovalEvent;
      assert.deepStrictEqual((opened.payload as { change: unknown }).change, {
        summary: "Archive DEL-123",
        record: { label: "DEL-123", url: issue.url },
        fields: [{ label: "Title", value: issue.title }],
      });
      assert.deepStrictEqual(archived, []);
      yield* answer(opened, "accept");
      const result = yield* Fiber.join(pending);
      assert.deepStrictEqual(archived, [{ issueId: issue.id, archived: true }]);
      assert.strictEqual((result as LinearIssueDetail).archivedAt, "2026-09-02T00:00:00.000Z");
    }),
  ).pipe(
    Effect.provide(
      testLayer({
        linear: {
          getIssue: () => Effect.sync(() => stored),
          archiveIssue: (input) =>
            Effect.sync(() => {
              archived.push(input);
              stored = { ...issue, archivedAt: "2026-09-02T00:00:00.000Z" };
            }),
        },
        confirmAgentWrites: true,
      }),
    ),
  );
});

it.effect("restores an archived issue, and leaves one already in place without asking", () => {
  const archived: unknown[] = [];
  const archivedIssue: LinearIssueDetail = { ...issue, archivedAt: "2026-09-02T00:00:00.000Z" };
  return Effect.gen(function* () {
    yield* callTool("archive_issue", { id: "DEL-123", archived: false });
    // Archiving an issue that is already archived writes nothing; with
    // confirmation off a write would land, so the empty list is the proof.
    yield* callTool("archive_issue", { id: "DEL-123", archived: true });
    assert.deepStrictEqual(archived, [{ issueId: issue.id, archived: false }]);
  }).pipe(
    Effect.provide(
      testLayer({
        linear: {
          getIssue: () => Effect.succeed(archivedIssue),
          archiveIssue: (input) => Effect.sync(() => void archived.push(input)),
        },
      }),
    ),
  );
});

it.effect("does not archive when the user declines", () => {
  const archived: unknown[] = [];
  return Effect.scoped(
    Effect.gen(function* () {
      const pending = yield* Effect.forkScoped(
        Effect.flip(callTool("archive_issue", { id: "DEL-123" })),
      );
      yield* answer(yield* nextApprovalEvent, "decline");
      assert.include(operationError(yield* Fiber.join(pending)).detail, "declined");
      assert.deepStrictEqual(archived, []);
    }),
  ).pipe(
    Effect.provide(
      testLayer({
        linear: {
          getIssue: () => Effect.succeed(issue),
          archiveIssue: (input) => Effect.sync(() => void archived.push(input)),
        },
        confirmAgentWrites: true,
      }),
    ),
  );
});

it.effect("rejects impossible due dates without writing", () =>
  Effect.flip(callTool("save_issue", { dueDate: "2026-02-30" })).pipe(
    Effect.map((error) => assert.include(operationError(error).detail, "valid YYYY-MM-DD")),
    Effect.provide(testLayer({ linear: { getIssue: () => Effect.succeed(issue) } })),
  ),
);

it.effect("includes cleared planning fields in the approval before writing", () => {
  const patches: unknown[] = [];
  return Effect.scoped(
    Effect.gen(function* () {
      const pending = yield* Effect.forkScoped(
        callTool("save_issue", { milestone: null, cycle: null, estimate: null }),
      );
      const opened = yield* nextApprovalEvent;
      assert.deepStrictEqual((opened.payload as { change: { fields: unknown } }).change.fields, [
        { label: "Milestone", value: "None" },
        { label: "Cycle", value: "None" },
        { label: "Estimate", value: "None" },
      ]);
      assert.deepStrictEqual(patches, []);
      yield* answer(opened, "accept");
      yield* Fiber.join(pending);
      assert.deepStrictEqual(patches, [
        { issueId: issue.id, projectMilestoneId: null, cycleId: null, estimate: null },
      ]);
    }),
  ).pipe(
    Effect.provide(
      testLayer({
        linear: {
          getIssue: () => Effect.succeed(issue),
          updateIssue: (patch) => Effect.sync(() => void patches.push(patch)),
        },
        confirmAgentWrites: true,
      }),
    ),
  );
});

it.effect("edits a cycle by ID without requiring a linked issue", () => {
  const id = "12345678-1234-1234-1234-123456789abc";
  const writes: unknown[] = [];
  return callTool("update_cycle", { id, name: "Sprint" }).pipe(
    Effect.map(() => assert.deepStrictEqual(writes, [{ kind: "cycle", id, name: "Sprint" }])),
    Effect.provide(
      testLayer({
        linear: {
          listResources: () =>
            Effect.succeed({
              nodes: [{ id, name: "Old" }],
              pageInfo: { hasNextPage: false, endCursor: null },
            }),
          saveResource: (input) =>
            Effect.sync(() => {
              writes.push(input);
              return { id, name: "Sprint" };
            }),
        },
      }),
    ),
  );
});

/** A PNG signature is enough: the server names the type from the extension. */
const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const withWorkspace = <A, E, R>(
  run: (input: {
    readonly root: string;
    readonly write: (relativePath: string, bytes: Uint8Array) => Effect.Effect<void>;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-linear-upload-" });
    return yield* run({
      root,
      write: (relativePath, bytes) =>
        Effect.gen(function* () {
          const target = path.join(root, relativePath);
          yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
          yield* fileSystem.writeFile(target, bytes);
        }).pipe(Effect.orDie),
    });
  }).pipe(Effect.provide(NodeServices.layer));

it.effect("uploads a workspace image and hands back markdown to embed", () =>
  withWorkspace(({ root, write }) =>
    Effect.gen(function* () {
      yield* write("shots/after.png", pngBytes);
      const uploaded: Array<{ readonly fileName: string; readonly contentType: string }> = [];

      const result = yield* callTool("upload_image", {
        path: "shots/after.png",
        alt: "The empty state, after",
      }).pipe(
        Effect.provide(
          testLayer({
            workspaceRoot: root,
            linear: {
              uploadFile: (input) =>
                Effect.sync(() => {
                  uploaded.push({ fileName: input.fileName, contentType: input.contentType });
                  assert.deepStrictEqual(input.bytes, pngBytes);
                  return { url: "https://uploads.linear.app/acme/after.png" };
                }),
            },
          }),
        ),
      );

      assert.deepStrictEqual(uploaded, [{ fileName: "after.png", contentType: "image/png" }]);
      assert.deepStrictEqual(result, {
        url: "https://uploads.linear.app/acme/after.png",
        name: "after.png",
        markdown: "![The empty state, after](https://uploads.linear.app/acme/after.png)",
      });
    }),
  ),
);

it.effect("names the file in the markdown when the agent wrote no alt text", () =>
  withWorkspace(({ root, write }) =>
    Effect.gen(function* () {
      yield* write("after.png", pngBytes);

      const result = yield* callTool("upload_image", { path: "after.png" }).pipe(
        Effect.provide(
          testLayer({
            workspaceRoot: root,
            linear: {
              uploadFile: () => Effect.succeed({ url: "https://uploads.linear.app/a.png" }),
            },
          }),
        ),
      );

      assert.strictEqual(
        (result as { readonly markdown: string }).markdown,
        "![after.png](https://uploads.linear.app/a.png)",
      );
    }),
  ),
);

it.effect("refuses a path that climbs out of the thread's workspace", () =>
  withWorkspace(({ root }) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        callTool("upload_image", { path: "../elsewhere/secret.png" }).pipe(
          Effect.provide(testLayer({ workspaceRoot: root, linear: {} })),
        ),
      );
      assert.include(operationError(error).detail, "outside this thread's workspace");
    }),
  ),
);

it.effect("refuses a file it cannot identify as an image", () =>
  withWorkspace(({ root, write }) =>
    Effect.gen(function* () {
      yield* write("notes.txt", new TextEncoder().encode("not an image"));

      const error = yield* Effect.flip(
        callTool("upload_image", { path: "notes.txt" }).pipe(
          Effect.provide(testLayer({ workspaceRoot: root, linear: {} })),
        ),
      );
      assert.include(operationError(error).detail, "not an image");
    }),
  ),
);

it.effect("asks before the bytes leave the machine when confirmation is on", () =>
  withWorkspace(({ root, write }) =>
    Effect.gen(function* () {
      yield* write("shots/after.png", pngBytes);
      const uploaded: Array<string> = [];

      return yield* Effect.scoped(
        Effect.gen(function* () {
          const pending = yield* Effect.forkScoped(
            callTool("upload_image", { path: "shots/after.png" }),
          );
          const opened = yield* nextApprovalEvent;

          assert.strictEqual(opened.type, "request.opened");
          assert.deepStrictEqual(opened.payload, {
            requestType: "integration_write_approval",
            appName: "Linear",
            detail: "Upload after.png to Linear\nFile: shots/after.png\nType: image/png, 1 KB",
            options: [
              { decision: "decline", label: "Decline" },
              { decision: "acceptForSession", label: "Allow for this session" },
              { decision: "accept", label: "Approve" },
            ],
            // The review dialog shows the file that is about to leave the
            // machine, its type, and its size.
            change: {
              summary: "Upload after.png to Linear",
              fields: [
                { label: "File", value: "shots/after.png", format: "image" },
                { label: "Type", value: "image/png, 1 KB" },
              ],
            },
            args: { path: "shots/after.png" },
          });
          // Nothing leaves the machine while the card is open.
          assert.deepStrictEqual(uploaded, []);

          assert.isTrue(yield* answer(opened, "accept"));
          yield* Fiber.join(pending);
          assert.deepStrictEqual(uploaded, ["after.png"]);
        }),
      ).pipe(
        Effect.provide(
          testLayer({
            workspaceRoot: root,
            confirmAgentWrites: true,
            linear: {
              uploadFile: (input) =>
                Effect.sync(() => {
                  uploaded.push(input.fileName);
                  return { url: "https://uploads.linear.app/acme/after.png" };
                }),
            },
          }),
        ),
      );
    }),
  ),
);

const blocker: LinearIssueDetail = {
  ...issue,
  id: "issue-110",
  identifier: "DEL-110",
  title: "Store the key",
  url: "https://linear.app/acme/issue/DEL-110",
};

const sibling: LinearIssueDetail = {
  ...issue,
  id: "issue-98",
  identifier: "DEL-98",
  title: "Integrations page",
  url: "https://linear.app/acme/issue/DEL-98",
};

const relativeOf = (other: LinearIssueDetail) => ({
  id: other.id,
  identifier: other.identifier,
  title: other.title,
  url: other.url,
  stateName: other.state.name,
});

/** DEL-123 as Linear has it once DEL-110 blocks it. */
const blockedIssue: LinearIssueDetail = {
  ...issue,
  relations: [{ id: "relation-1", type: "blockedBy", issue: relativeOf(blocker) }],
};

const issuesByReference = (...known: ReadonlyArray<LinearIssueDetail>) => ({
  getIssue: ({ reference }: { readonly reference: string }) => {
    const found = known.find(
      (candidate) => candidate.id === reference || candidate.identifier === reference,
    );
    return found === undefined
      ? Effect.die(`unexpected lookup of ${reference}`)
      : Effect.succeed(found);
  },
});

it.effect("creates an issue, then links it to the issues the agent named", () => {
  const writes: Array<unknown> = [];

  return callTool("create_issue", {
    title: "Follow up",
    parentId: null,
    relations: [
      { type: "blockedBy", issue: "DEL-110" },
      { type: "related", issue: "DEL-98" },
      // Named twice, linked once.
      { type: "blockedBy", issue: "issue-110" },
    ],
  }).pipe(
    Effect.map((result) => {
      assert.strictEqual((result as LinearIssueSummary).identifier, "DEL-124");
      assert.deepStrictEqual(writes, [
        { createIssue: "Follow up" },
        { issueId: createdIssue.id, type: "blockedBy", otherIssueId: blocker.id },
        { issueId: createdIssue.id, type: "related", otherIssueId: sibling.id },
      ]);
    }),
    Effect.provide(
      testLayer({
        linear: {
          ...issuesByReference(issue, blocker, sibling),
          createIssue: (input) =>
            Effect.sync(() => {
              writes.push({ createIssue: input.title });
              return createdIssue;
            }),
          addIssueRelation: (input) => Effect.sync(() => void writes.push(input)),
        },
      }),
    ),
  );
});

it.effect("tells the agent the issue exists when its relations fail to save", () =>
  Effect.flip(
    callTool("create_issue", {
      title: "Follow up",
      parentId: null,
      relations: [{ type: "blockedBy", issue: "DEL-110" }],
    }),
  ).pipe(
    Effect.map((error) => {
      const { detail } = operationError(error);
      assert.include(detail, "Created DEL-124");
      assert.include(detail, "instead of creating the issue again");
    }),
    Effect.provide(
      testLayer({
        linear: {
          ...issuesByReference(issue, blocker),
          createIssue: () => Effect.succeed(createdIssue),
          addIssueRelation: () =>
            Effect.fail(
              new LinearOperationError({
                operation: "addIssueRelation",
                detail: "Linear refused to relate the issues.",
              }),
            ),
        },
      }),
    ),
  ),
);

it.effect("adds and removes relations, skipping the ones already in place", () => {
  const writes: Array<unknown> = [];
  const linked: LinearIssueDetail = {
    ...blockedIssue,
    relations: [
      ...blockedIssue.relations!,
      { id: "relation-2", type: "blocks", issue: relativeOf(sibling) },
    ],
  };

  return callTool("save_issue", {
    addRelations: [
      // Already there: neither looked up nor duplicated.
      { type: "blockedBy", issue: "del-110" },
      { type: "related", issue: "DEL-98" },
    ],
    removeRelations: [
      { type: "blocks", issue: "DEL-98" },
      // Not there: nothing to remove.
      { type: "duplicateOf", issue: "DEL-98" },
    ],
  }).pipe(
    Effect.map(() => {
      // Only relations changed, so the issue itself is not patched.
      assert.deepStrictEqual(writes, [
        { remove: "relation-2" },
        { issueId: issue.id, type: "related", otherIssueId: sibling.id },
      ]);
    }),
    Effect.provide(
      testLayer({
        linear: {
          ...issuesByReference(linked, sibling),
          updateIssue: () => Effect.die("no issue field changed"),
          removeIssueRelation: (id) => Effect.sync(() => void writes.push({ remove: id })),
          addIssueRelation: (input) => Effect.sync(() => void writes.push(input)),
        },
      }),
    ),
  );
});

it.effect("returns the issue without asking when its relations are already as requested", () =>
  callTool("save_issue", {
    addRelations: [{ type: "blockedBy", issue: "DEL-110" }],
    removeRelations: [{ type: "related", issue: "DEL-98" }],
  }).pipe(
    Effect.map((result) => {
      assert.deepStrictEqual(result, blockedIssue);
    }),
    Effect.provide(
      testLayer({
        // An approval would park this call forever, so finishing proves none was raised.
        confirmAgentWrites: true,
        linear: {
          ...issuesByReference(blockedIssue),
          removeIssueRelation: () => Effect.die("nothing to remove"),
          addIssueRelation: () => Effect.die("nothing to add"),
        },
      }),
    ),
  ),
);

it.effect("refuses to relate an issue to itself", () =>
  Effect.flip(
    callTool("save_issue", { addRelations: [{ type: "related", issue: "DEL-123" }] }),
  ).pipe(
    Effect.map((error) => {
      assert.include(operationError(error).detail, "cannot be related to itself");
    }),
    Effect.provide(testLayer({ linear: issuesByReference(issue) })),
  ),
);

it.effect("lists relation changes for review and writes none of them on decline", () => {
  const writes: Array<unknown> = [];
  return Effect.scoped(
    Effect.gen(function* () {
      const pending = yield* Effect.forkScoped(
        Effect.flip(
          callTool("save_issue", {
            title: "Renamed",
            addRelations: [{ type: "related", issue: "DEL-98" }],
            removeRelations: [{ type: "blockedBy", issue: "DEL-110" }],
          }),
        ),
      );
      const opened = yield* nextApprovalEvent;
      assert.deepStrictEqual(
        (opened.payload as { readonly change: { readonly fields: unknown } }).change.fields,
        [
          { label: "Title", value: "Renamed" },
          { label: "Add relations", value: "Related to DEL-98" },
          { label: "Remove relations", value: "Blocked by DEL-110" },
        ],
      );
      yield* answer(opened, "decline");
      yield* Fiber.join(pending);
      assert.deepStrictEqual(writes, []);
    }),
  ).pipe(
    Effect.provide(
      testLayer({
        confirmAgentWrites: true,
        linear: {
          ...issuesByReference(blockedIssue, sibling),
          updateIssue: (input) => Effect.sync(() => void writes.push(input)),
          removeIssueRelation: (id) => Effect.sync(() => void writes.push(id)),
          addIssueRelation: (input) => Effect.sync(() => void writes.push(input)),
        },
      }),
    ),
  );
});

const taskId = "7252e40a-1f3b-4c5d-8e9f-0a1b2c3d4e5f";
const otherTaskId = "8363f51b-2a4c-4d6e-9fa0-1b2c3d4e5f60";
const e2eThreadId = ThreadId.make(`assistant-e2e-${taskId}`);

/**
 * A workspace plus a T3 base directory whose evidence folders are the real
 * ones `AssistantEvidence` hands a team thread. `save` writes a screenshot into
 * a task's folder and returns its absolute path.
 */
const withEvidence = <A, E, R>(
  run: (input: {
    readonly root: string;
    readonly baseDir: string;
    readonly folder: (task: string) => Effect.Effect<string>;
    readonly save: (task: string, fileName: string) => Effect.Effect<string>;
  }) => Effect.Effect<A, E, R>,
) =>
  withWorkspace(({ root }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-linear-evidence-" });
      const evidence = yield* AssistantEvidence.AssistantEvidence.pipe(
        Effect.provide(evidenceLayer(baseDir)),
      );
      const folder = (task: string) => evidence.directory(task).pipe(Effect.orDie);
      return yield* run({
        root,
        baseDir,
        folder,
        save: (task, fileName) =>
          Effect.gen(function* () {
            const file = path.join(yield* folder(task), fileName);
            yield* fileSystem.writeFile(file, pngBytes).pipe(Effect.orDie);
            return file;
          }),
      });
    }),
  );

it.effect("uploads a screenshot from the evidence folder of the caller's own task", () =>
  withEvidence(({ root, baseDir, save }) =>
    Effect.gen(function* () {
      const file = yield* save(taskId, "c3-home.png");
      const uploaded: Array<string> = [];

      return yield* Effect.scoped(
        Effect.gen(function* () {
          const pending = yield* Effect.forkScoped(
            callTool("upload_image", { path: file }, ["linear"], e2eThreadId),
          );
          const opened = yield* nextApprovalEvent;
          // The dialog previews workspace files only, so evidence is shown by its path.
          assert.deepStrictEqual(
            (opened.payload as { readonly change: { readonly fields: unknown } }).change.fields,
            [
              { label: "File", value: file },
              { label: "Type", value: "image/png, 1 KB" },
            ],
          );
          yield* answer(opened, "accept");
          const result = yield* Fiber.join(pending);
          assert.deepStrictEqual(uploaded, ["c3-home.png"]);
          assert.strictEqual(
            (result as { readonly markdown: string }).markdown,
            "![c3-home.png](https://uploads.linear.app/acme/c3-home.png)",
          );
        }),
      ).pipe(
        Effect.provide(
          testLayer({
            workspaceRoot: root,
            evidenceBaseDir: baseDir,
            confirmAgentWrites: true,
            linear: {
              uploadFile: (input) =>
                Effect.sync(() => {
                  uploaded.push(input.fileName);
                  assert.deepStrictEqual(input.bytes, pngBytes);
                  return { url: "https://uploads.linear.app/acme/c3-home.png" };
                }),
            },
          }),
        ),
      );
    }),
  ),
);

it.effect("refuses another task's evidence, by path, by traversal, or through a symlink", () =>
  withEvidence(({ root, baseDir, folder, save }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const theirs = yield* save(otherTaskId, "theirs.png");
      const own = yield* folder(taskId);
      yield* fileSystem.symlink(theirs, path.join(own, "link.png")).pipe(Effect.orDie);

      for (const requested of [
        theirs,
        // Written inside the caller's folder, resolved outside it.
        `${own}/../${otherTaskId}/theirs.png`,
        path.join(own, "link.png"),
      ]) {
        const error = yield* Effect.flip(
          callTool("upload_image", { path: requested }, ["linear"], e2eThreadId).pipe(
            Effect.provide(
              testLayer({
                workspaceRoot: root,
                evidenceBaseDir: baseDir,
                linear: { uploadFile: () => Effect.die("nothing may be uploaded") },
              }),
            ),
          ),
        );
        assert.include(operationError(error).detail, "outside this thread's workspace", requested);
      }
    }),
  ),
);

it.effect("still confines a thread outside the assistant's team to its workspace", () =>
  withEvidence(({ root, baseDir, save }) =>
    Effect.gen(function* () {
      const file = yield* save(taskId, "c3-home.png");

      const error = yield* Effect.flip(
        callTool("upload_image", { path: file }).pipe(
          Effect.provide(
            testLayer({
              workspaceRoot: root,
              evidenceBaseDir: baseDir,
              linear: { uploadFile: () => Effect.die("nothing may be uploaded") },
            }),
          ),
        ),
      );
      assert.strictEqual(
        operationError(error).detail,
        `"${file}" is outside this thread's workspace. Pass a path inside it, relative to its root.`,
      );
    }),
  ),
);

const stagingLink = {
  id: "attachment-1",
  title: "Staging preview",
  subtitle: null,
  url: "https://staging.example.com/del-123",
  sourceType: null,
};

for (const [current, summary] of [
  [[], "Attach link to DEL-123"],
  // Linear updates the attachment it already has for this URL.
  [[stagingLink], "Update link on DEL-123"],
] as const) {
  it.effect(`attaches a link only after approval: ${summary}`, () => {
    const created: Array<unknown> = [];
    return Effect.scoped(
      Effect.gen(function* () {
        const pending = yield* Effect.forkScoped(
          callTool("create_attachment", {
            url: ` ${stagingLink.url} `,
            title: "Staging preview",
            subtitle: "Build 42",
          }),
        );
        const opened = yield* nextApprovalEvent;
        const review = yield* decodeApprovalReview(opened.payload);
        assert.deepStrictEqual(review.change, {
          summary,
          record: { label: "DEL-123", url: issue.url },
          fields: [
            { label: "Title", value: "Staging preview" },
            { label: "URL", value: stagingLink.url },
            { label: "Subtitle", value: "Build 42" },
          ],
        });
        assert.deepStrictEqual(created, []);
        yield* answer(opened, "accept");
        yield* Fiber.join(pending);
        assert.deepStrictEqual(created, [
          {
            issueId: issue.id,
            url: stagingLink.url,
            title: "Staging preview",
            subtitle: "Build 42",
          },
        ]);
      }),
    ).pipe(
      Effect.provide(
        testLayer({
          linear: {
            getIssue: () => Effect.succeed({ ...issue, attachments: current }),
            createAttachment: (input) =>
              Effect.sync(() => {
                created.push(input);
                return { ...stagingLink, subtitle: input.subtitle ?? null };
              }),
          },
          confirmAgentWrites: true,
        }),
      ),
    );
  });
}

it.effect("refuses to attach something that is not a web link, before asking", () =>
  Effect.gen(function* () {
    const error = operationError(
      yield* Effect.flip(
        callTool("create_attachment", { url: "file:///etc/passwd", title: "Secrets" }),
      ),
    );
    assert.include(error.detail, "http or https");
  }).pipe(Effect.provide(testLayer({ linear: {}, confirmAgentWrites: true }))),
);

for (const decision of ["accept", "decline"] as const) {
  it.effect(`removes an attachment only after approval: ${decision}`, () => {
    const deleted: Array<string> = [];
    return Effect.scoped(
      Effect.gen(function* () {
        const pending = yield* Effect.forkScoped(
          Effect.result(callTool("delete_attachment", { id: "attachment-1" })),
        );
        const opened = yield* nextApprovalEvent;
        const review = yield* decodeApprovalReview(opened.payload);
        assert.strictEqual(
          review.detail,
          `Remove link from DEL-123\nTitle: Staging preview\nURL: ${stagingLink.url}`,
        );
        assert.deepStrictEqual(review.args, { id: "attachment-1", issueId: issue.id });
        assert.deepStrictEqual(deleted, []);
        yield* answer(opened, decision);
        const result = yield* Fiber.join(pending);
        assert.deepStrictEqual(deleted, decision === "accept" ? ["attachment-1"] : []);
        assert.strictEqual(result._tag, decision === "accept" ? "Success" : "Failure");
      }),
    ).pipe(
      Effect.provide(
        testLayer({
          linear: {
            getAttachment: () =>
              Effect.succeed({
                ...stagingLink,
                issue: { id: issue.id, identifier: issue.identifier, url: issue.url },
              }),
            deleteAttachment: (id) =>
              Effect.sync(() => {
                deleted.push(id);
              }),
          },
          confirmAgentWrites: true,
        }),
      ),
    );
  });
}

const launchPlan = {
  id: "document-uuid",
  title: "Launch plan",
  url: "https://linear.app/acme/document/launch-plan-0f1e2d3c4b5a",
  updatedAt: "2026-09-02T10:00:00.000Z",
  project: { id: "project-1", name: "Launch" },
  content: "# Launch",
  trashed: false,
};
const launchProject = {
  id: "project-1",
  name: "Launch",
  url: "https://linear.app/acme/project/launch",
};

it.effect("lists documents in a project the agent named", () => {
  const listed: Array<unknown> = [];
  return callTool("list_documents", { project: "Launch", query: "plan" }).pipe(
    Effect.map(() => {
      assert.deepStrictEqual(listed, [
        { query: "plan", cursor: undefined, limit: undefined, projectId: "project-1" },
      ]);
    }),
    Effect.provide(
      testLayer({
        linear: {
          listResources: () =>
            Effect.succeed({
              nodes: [{ id: "project-1", name: "Launch" }],
              pageInfo: { hasNextPage: false, endCursor: null },
            }),
          listDocuments: (input) =>
            Effect.sync(() => {
              listed.push(input);
              return { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
            }),
        },
      }),
    ),
  );
});

it.effect("creates a document in the linked issue's project once approved", () => {
  const saved: Array<unknown> = [];
  return Effect.scoped(
    Effect.gen(function* () {
      const pending = yield* Effect.forkScoped(
        callTool("save_document", { title: " Launch plan ", content: "# Launch" }),
      );
      const opened = yield* nextApprovalEvent;
      const review = yield* decodeApprovalReview(opened.payload);
      assert.deepStrictEqual(review.change, {
        summary: "Create document",
        fields: [
          { label: "Title", value: "Launch plan" },
          { label: "Project", value: "Launch" },
          { label: "Content", value: "# Launch", format: "markdown" },
        ],
      });
      assert.deepStrictEqual(saved, []);
      yield* answer(opened, "accept");
      assert.deepStrictEqual(yield* Fiber.join(pending), launchPlan);
      assert.deepStrictEqual(saved, [
        { title: "Launch plan", content: "# Launch", projectId: "project-1" },
      ]);
    }),
  ).pipe(
    Effect.provide(
      testLayer({
        linear: {
          getIssue: () => Effect.succeed({ ...issue, project: launchProject }),
          saveDocument: (input) =>
            Effect.sync(() => {
              saved.push(input);
              return launchPlan;
            }),
        },
        confirmAgentWrites: true,
      }),
    ),
  );
});

it.effect("updates only the fields given, addressing the document by its UUID", () => {
  const saved: Array<unknown> = [];
  return callTool("save_document", { id: launchPlan.url, content: "# Launch v2" }).pipe(
    Effect.map(() => {
      assert.deepStrictEqual(saved, [{ id: "document-uuid", content: "# Launch v2" }]);
    }),
    Effect.provide(
      testLayer({
        linear: {
          getDocument: () => Effect.succeed(launchPlan),
          saveDocument: (input) =>
            Effect.sync(() => {
              saved.push(input);
              return launchPlan;
            }),
        },
      }),
    ),
  );
});

it.effect("refuses a new document without a title before reading anything", () =>
  Effect.gen(function* () {
    const error = operationError(
      yield* Effect.flip(callTool("save_document", { content: "# Untitled" })),
    );
    assert.include(error.detail, "needs a title");
  }).pipe(Effect.provide(testLayer({ linear: {} }))),
);

for (const decision of ["accept", "decline"] as const) {
  it.effect(`deletes a document only after approval: ${decision}`, () => {
    const deleted: Array<string> = [];
    return Effect.scoped(
      Effect.gen(function* () {
        const pending = yield* Effect.forkScoped(
          Effect.result(callTool("delete_document", { id: "0f1e2d3c4b5a" })),
        );
        const opened = yield* nextApprovalEvent;
        const review = yield* decodeApprovalReview(opened.payload);
        assert.strictEqual(
          review.detail,
          "Delete document: Launch plan\nTitle: Launch plan\nProject: Launch",
        );
        assert.deepStrictEqual(review.args, { id: "document-uuid" });
        assert.deepStrictEqual(deleted, []);
        yield* answer(opened, decision);
        const result = yield* Fiber.join(pending);
        assert.deepStrictEqual(deleted, decision === "accept" ? ["document-uuid"] : []);
        assert.strictEqual(result._tag, decision === "accept" ? "Success" : "Failure");
      }),
    ).pipe(
      Effect.provide(
        testLayer({
          linear: {
            getDocument: () => Effect.succeed(launchPlan),
            deleteDocument: (id) =>
              Effect.sync(() => {
                deleted.push(id);
              }),
          },
          confirmAgentWrites: true,
        }),
      ),
    );
  });
}

for (const decision of ["accept", "decline"] as const) {
  it.effect(`restores a trashed document only after approval: ${decision}`, () => {
    const restored: Array<string> = [];
    return Effect.scoped(
      Effect.gen(function* () {
        const pending = yield* Effect.forkScoped(
          Effect.result(callTool("restore_document", { id: launchPlan.url })),
        );
        const opened = yield* nextApprovalEvent;
        const review = yield* decodeApprovalReview(opened.payload);
        assert.strictEqual(
          review.detail,
          "Restore document: Launch plan\nTitle: Launch plan\nProject: Launch",
        );
        assert.deepStrictEqual(review.args, { id: "document-uuid" });
        assert.deepStrictEqual(restored, []);
        yield* answer(opened, decision);
        const result = yield* Fiber.join(pending);
        assert.deepStrictEqual(restored, decision === "accept" ? ["document-uuid"] : []);
        assert.deepStrictEqual(
          result._tag === "Success" ? result.success : undefined,
          decision === "accept" ? launchPlan : undefined,
        );
      }),
    ).pipe(
      Effect.provide(
        testLayer({
          linear: {
            getDocument: () => Effect.succeed({ ...launchPlan, trashed: true }),
            restoreDocument: (id) =>
              Effect.sync(() => {
                restored.push(id);
                return launchPlan;
              }),
          },
          confirmAgentWrites: true,
        }),
      ),
    );
  });
}

it.effect("refuses to restore a document that is not in the trash, without asking", () =>
  Effect.gen(function* () {
    const error = operationError(
      yield* Effect.flip(callTool("restore_document", { id: "document-uuid" })),
    );
    assert.include(error.detail, "not in Linear's trash");
  }).pipe(
    Effect.provide(
      testLayer({
        linear: {
          getDocument: () => Effect.succeed(launchPlan),
          restoreDocument: () => Effect.die("Linear must not be called"),
        },
        confirmAgentWrites: true,
      }),
    ),
  ),
);
