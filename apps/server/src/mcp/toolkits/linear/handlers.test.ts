import { assert, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  EnvironmentId,
  LinearOperationError,
  OrchestrationThreadShell,
  PreviewAutomationUnavailableError,
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
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer, Tool } from "effect/unstable/ai";

import * as LinearApi from "../../../linear/LinearApi.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import * as McpApprovalBroker from "../../McpApprovalBroker.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { LinearToolkitHandlersLive } from "./handlers.ts";
import { LinearToolkit } from "./tools.ts";

/** `assert.instanceOf` narrows `unknown`, not the tool's failure union. */
function operationError(error: unknown): LinearOperationError {
  assert.instanceOf(error, LinearOperationError);
  return error;
}

function unavailableError(error: unknown): PreviewAutomationUnavailableError {
  assert.instanceOf(error, PreviewAutomationUnavailableError);
  return error;
}

const environmentId = EnvironmentId.make("environment-linear-mcp");
const threadId = ThreadId.make("thread-linear-mcp");
const projectId = ProjectId.make("project-linear-mcp");

const invocation = (capabilities: ReadonlyArray<McpInvocationContext.McpCapability>) =>
  McpInvocationContext.McpInvocationContext.of({
    environmentId,
    threadId,
    providerSessionId: "provider-session-linear-mcp",
    providerInstanceId: ProviderInstanceId.make("codex"),
    capabilities: new Set(capabilities),
    issuedAt: 1,
  });

const client = McpSchema.McpServerClient.of({
  clientId: 1,
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
      createIssue: () => Effect.die("unused"),
      labels: () => Effect.die("unused"),
      createComment: () => Effect.die("unused"),
      getComment: () => Effect.die("unused"),
      updateComment: () => Effect.die("unused"),
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

const projectionLayer = (linkedIssue: { readonly id: string } | null, session: boolean = false) =>
  Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
    getTurnStartMessage: () => Effect.die("unused"),
    getImportedAgentSessionSources: () => Effect.die("unused"),
    getUserInputActivity: () => Effect.die("unused"),
    getCommandReadModel: () => Effect.die("unused"),
    getSnapshot: () => Effect.die("unused"),
    getShellSnapshot: () => Effect.die("unused"),
    getArchivedShellSnapshot: () => Effect.die("unused"),
    getSnapshotSequence: () => Effect.die("unused"),
    getCounts: () => Effect.die("unused"),
    getEventReplayStats: () => Effect.die("unused"),
    getActiveProjectByWorkspaceRoot: () => Effect.die("unused"),
    getProjectShellById: () => Effect.die("unused"),
    getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
    getThreadCheckpointContext: () => Effect.die("unused"),
    getFullThreadDiffContext: () => Effect.die("unused"),
    getThreadRuntimeContext: () => Effect.die("unused"),
    getThreadShellById: () => Effect.succeed(Option.some(threadShell(linkedIssue, session))),
    getThreadDetailById: () => Effect.die("unused"),
    getThreadDetailSnapshot: () => Effect.die("unused"),
    searchThreads: () => Effect.die("unused"),
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
        ),
        McpApprovalBroker.layer,
        ServerSettingsService.layerTest({
          linear: { confirmAgentWrites: input.confirmAgentWrites ?? false },
        }),
      ),
    ),
  );

const callTool = <Name extends keyof typeof LinearToolkit.tools>(
  name: Name,
  params: Tool.Parameters<(typeof LinearToolkit.tools)[Name]>,
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["linear"],
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
      invocation(capabilities) as McpInvocationContext.McpInvocationScope,
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
        "Nothing to save: pass at least one of title, description, state, or labels.",
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

const answer = (event: ProviderRuntimeEvent, decision: "accept" | "acceptForSession" | "decline") =>
  Effect.gen(function* () {
    const broker = yield* McpApprovalBroker.McpApprovalBroker;
    return yield* broker.respond({
      threadId,
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
