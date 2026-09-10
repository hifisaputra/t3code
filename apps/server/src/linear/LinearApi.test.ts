import { assert, it, vi } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  LinearIssueNotFoundError,
  LinearOperationError,
  LinearUnavailableError,
  type LinearWorkflowState,
} from "@t3tools/contracts";

import * as LinearApi from "./LinearApi.ts";
import * as ServerSettings from "../serverSettings.ts";

const API_KEY = "lin_api_secret";
const BASE_URL = "https://linear.test.local/graphql";

const viewerData = {
  viewer: {
    id: "user-1",
    name: "Ada Lovelace",
    displayName: "ada",
    email: "ada@example.com",
    organization: { id: "org-1", name: "Acme", urlKey: "acme" },
  },
};

const issueSummary = {
  id: "issue-uuid",
  identifier: "DEL-123",
  title: "Wire up Linear",
  url: "https://linear.app/acme/issue/DEL-123",
  branchName: "ada/del-123-wire-up-linear",
  priority: 2,
  updatedAt: "2026-09-01T10:00:00.000Z",
  state: { id: "state-1", name: "In Progress", type: "started", color: "#f2c94c", position: 1 },
  team: { id: "team-1", key: "DEL", name: "Delivery" },
  assignee: null,
  project: { id: "project-1", name: "Linear", url: "https://linear.app/acme/project/linear" },
  cycle: { id: "cycle-1", number: 12, name: null },
};

const issueDetail = {
  ...issueSummary,
  description: "Store the key on the server.",
  parent: {
    id: "issue-parent",
    identifier: "DEL-100",
    title: "Integrations",
    url: "https://linear.app/acme/issue/DEL-100",
    state: { name: "Backlog" },
  },
  children: {
    nodes: [
      {
        id: "issue-child",
        identifier: "DEL-124",
        title: "Settings UI",
        url: "https://linear.app/acme/issue/DEL-124",
        state: { name: "Todo" },
      },
    ],
  },
  labels: { nodes: [{ id: "label-1", name: "integration", color: "#5e6ad2" }] },
  comments: {
    nodes: [
      {
        id: "comment-1",
        body: "Started on this.",
        url: "https://linear.app/acme/issue/DEL-123#comment-1",
        createdAt: "2026-09-01T09:00:00.000Z",
        user: { id: "user-1", name: "Ada Lovelace", displayName: "ada" },
      },
      {
        id: "comment-2",
        body: "Automated update.",
        url: "https://linear.app/acme/issue/DEL-123#comment-2",
        createdAt: "2026-09-01T09:30:00.000Z",
        user: null,
      },
    ],
  },
};

function makeLayer(input: {
  readonly response: (request: HttpClientRequest.HttpClientRequest) => Response;
  readonly apiKey?: string;
}) {
  const execute = vi.fn((request: HttpClientRequest.HttpClientRequest) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, input.response(request))),
  );

  const layer = LinearApi.layer.pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => execute(request)),
      ),
    ),
    Layer.provide(ServerSettings.layerTest({ linear: { apiKey: input.apiKey ?? API_KEY } })),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({ env: { T3CODE_LINEAR_API_BASE_URL: BASE_URL } }),
      ),
    ),
  );

  return { execute, layer };
}

function sentGraphQL(request: HttpClientRequest.HttpClientRequest): {
  readonly query: string;
  readonly variables: Record<string, unknown>;
} {
  const body = request.body;
  if (body._tag !== "Uint8Array") {
    throw new Error(`expected a JSON body, got ${body._tag}`);
  }
  return JSON.parse(new TextDecoder().decode(body.body));
}

it.effect("reports an unconfigured status without calling Linear when no key is stored", () => {
  const { execute, layer } = makeLayer({ apiKey: "", response: () => Response.json({ data: {} }) });

  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;

    assert.deepStrictEqual(yield* linear.status, { status: "unconfigured" });
    assert.strictEqual(execute.mock.calls.length, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("sends the personal key raw and reports the connected viewer", () => {
  const { execute, layer } = makeLayer({ response: () => Response.json({ data: viewerData }) });

  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;

    assert.deepStrictEqual(yield* linear.status, {
      status: "connected",
      viewer: { id: "user-1", name: "Ada Lovelace", displayName: "ada", email: "ada@example.com" },
      workspace: { id: "org-1", name: "Acme", urlKey: "acme" },
    });

    const request = execute.mock.calls[0]?.[0];
    assert.strictEqual(request?.url, BASE_URL);
    // Personal API keys go over the wire without a `Bearer` prefix.
    assert.strictEqual(request?.headers["authorization"], API_KEY);
  }).pipe(Effect.provide(layer));
});

it.effect("reports an unauthenticated status when Linear rejects the key", () => {
  const { layer } = makeLayer({
    response: () => new Response("unauthorized", { status: 401 }),
  });

  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;

    assert.deepStrictEqual(yield* linear.status, { status: "unauthenticated" });
  }).pipe(Effect.provide(layer));
});

it.effect("reports an unauthenticated status for a GraphQL authentication error", () => {
  const { layer } = makeLayer({
    response: () =>
      Response.json(
        {
          errors: [
            { message: "Authentication required", extensions: { code: "AUTHENTICATION_ERROR" } },
          ],
        },
        { status: 400 },
      ),
  });

  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;

    assert.deepStrictEqual(yield* linear.status, { status: "unauthenticated" });
  }).pipe(Effect.provide(layer));
});

it.effect("surfaces a rate limit with the moment retrying makes sense", () => {
  const { layer } = makeLayer({
    response: () => new Response("slow down", { status: 429, headers: { "Retry-After": "120" } }),
  });

  return Effect.gen(function* () {
    yield* TestClock.setTime(1_000);
    const linear = yield* LinearApi.LinearApi;

    const error = yield* Effect.flip(linear.listIssues({}));

    assert.instanceOf(error, LinearUnavailableError);
    assert.strictEqual(error.reason, "rate-limited");
    assert.strictEqual(error.retryAt, 121_000);
  }).pipe(Effect.provide(layer));
});

it.effect("turns a GraphQL error into an operation error that never repeats the key", () => {
  const { layer } = makeLayer({
    response: () =>
      Response.json({
        errors: [{ message: "Argument Validation Error", extensions: { code: "INVALID_INPUT" } }],
      }),
  });

  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;

    const error = yield* Effect.flip(linear.listIssues({}));

    assert.instanceOf(error, LinearOperationError);
    assert.strictEqual(error.operation, "listIssues");
    assert.include(error.detail, "Argument Validation Error");
    assert.notInclude(error.message, API_KEY);
  }).pipe(Effect.provide(layer));
});

it.effect("fails cleanly when Linear's response is larger than the read cap", () => {
  const oversized = `{"data":{"issues":{"nodes":[]}},"padding":"${"x".repeat(5 * 1024 * 1024)}"}`;
  const { layer } = makeLayer({ response: () => new Response(oversized) });

  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;

    const error = yield* Effect.flip(linear.listIssues({}));

    assert.instanceOf(error, LinearOperationError);
    assert.strictEqual(error.detail, "Linear's response was too large to read.");
  }).pipe(Effect.provide(layer));
});

it.effect("decodes an issue with a null assignee and its nested connections", () => {
  const { execute, layer } = makeLayer({
    response: () => Response.json({ data: { issue: issueDetail } }),
  });

  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;

    const issue = yield* linear.getIssue({ reference: "DEL-123" });

    assert.strictEqual(issue.identifier, "DEL-123");
    assert.strictEqual(issue.assignee, null);
    assert.strictEqual(issue.branchName, "ada/del-123-wire-up-linear");
    assert.deepStrictEqual(issue.parent, {
      id: "issue-parent",
      identifier: "DEL-100",
      title: "Integrations",
      url: "https://linear.app/acme/issue/DEL-100",
      stateName: "Backlog",
    });
    assert.deepStrictEqual(
      issue.children.map((child) => child.identifier),
      ["DEL-124"],
    );
    assert.deepStrictEqual(
      issue.labels.map((label) => label.name),
      ["integration"],
    );
    assert.deepStrictEqual(
      issue.comments.map((comment) => comment.author?.displayName ?? null),
      ["ada", null],
    );
    assert.strictEqual(issue.project?.name, "Linear");
    assert.deepStrictEqual(sentGraphQL(execute.mock.calls[0]![0]).variables, { id: "DEL-123" });
  }).pipe(Effect.provide(layer));
});

it.effect("reports a missing issue when Linear answers with no issue", () => {
  const { layer } = makeLayer({ response: () => Response.json({ data: { issue: null } }) });

  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;

    const error = yield* Effect.flip(linear.getIssue({ reference: "DEL-999" }));

    assert.instanceOf(error, LinearIssueNotFoundError);
  }).pipe(Effect.provide(layer));
});

it.effect("reports a missing issue for Linear's entity-not-found error", () => {
  const { layer } = makeLayer({
    response: () =>
      Response.json({
        errors: [{ message: "Entity not found: Issue - Could not find referenced Issue." }],
      }),
  });

  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;

    const error = yield* Effect.flip(linear.getIssue({ reference: "DEL-999" }));

    assert.instanceOf(error, LinearIssueNotFoundError);
  }).pipe(Effect.provide(layer));
});

it.effect("asks for the connected user's unstarted and started issues by default", () => {
  const { execute, layer } = makeLayer({
    response: () => Response.json({ data: { issues: { nodes: [issueSummary] } } }),
  });

  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;

    const result = yield* linear.listIssues({});

    assert.deepStrictEqual(
      result.issues.map((issue) => issue.identifier),
      ["DEL-123"],
    );
    assert.deepStrictEqual(sentGraphQL(execute.mock.calls[0]![0]).variables, {
      filter: {
        assignee: { isMe: { eq: true } },
        state: { type: { in: ["unstarted", "started"] } },
      },
      first: 50,
    });
  }).pipe(Effect.provide(layer));
});

it.effect("lists all assignees when requested while preserving other filters", () => {
  const { execute, layer } = makeLayer({
    response: () => Response.json({ data: { issues: { nodes: [issueSummary] } } }),
  });

  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;
    const result = yield* linear.listIssues({
      assignedToMe: false,
      teamKey: "DEL",
      projectId: "project-1",
      stateTypes: ["backlog", "unstarted", "started"],
      limit: 100,
    });

    assert.strictEqual(result.issues[0]?.assignee, null);
    assert.deepStrictEqual(sentGraphQL(execute.mock.calls[0]![0]).variables, {
      filter: {
        state: { type: { in: ["backlog", "unstarted", "started"] } },
        team: { key: { eq: "DEL" } },
        project: { id: { eq: "project-1" } },
      },
      first: 100,
    });
  }).pipe(Effect.provide(layer));
});

it.effect("filters by team and clamps the requested page size", () => {
  const { execute, layer } = makeLayer({
    response: () => Response.json({ data: { issues: { nodes: [] } } }),
  });

  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;

    yield* linear.listIssues({ teamKey: "DEL", stateTypes: ["completed"], limit: 500 });

    assert.deepStrictEqual(sentGraphQL(execute.mock.calls[0]![0]).variables, {
      filter: {
        assignee: { isMe: { eq: true } },
        state: { type: { in: ["completed"] } },
        team: { key: { eq: "DEL" } },
      },
      first: 100,
    });
  }).pipe(Effect.provide(layer));
});

it.effect("sorts the workspace's teams by key and each team's projects by name", () => {
  const { layer } = makeLayer({
    response: () =>
      Response.json({
        data: {
          teams: {
            nodes: [
              { id: "team-2", key: "OPS", name: "Operations" },
              { id: "team-1", key: "DEL", name: "Delivery" },
            ],
          },
          projects: {
            nodes: [
              {
                id: "project-2",
                name: "Zephyr",
                url: "https://linear.app/acme/project/z",
                teams: { nodes: [{ id: "team-1" }] },
              },
              {
                id: "project-1",
                name: "Atlas",
                url: "https://linear.app/acme/project/a",
                teams: { nodes: [{ id: "team-1" }, { id: "team-9" }] },
              },
            ],
          },
        },
      }),
  });

  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;

    const structure = yield* linear.workspace;

    assert.deepStrictEqual(structure, {
      teams: [
        {
          id: "team-1",
          key: "DEL",
          name: "Delivery",
          projects: [
            { id: "project-1", name: "Atlas", url: "https://linear.app/acme/project/a" },
            { id: "project-2", name: "Zephyr", url: "https://linear.app/acme/project/z" },
          ],
        },
        { id: "team-2", key: "OPS", name: "Operations", projects: [] },
      ],
    });
  }).pipe(Effect.provide(layer));
});

it.effect("reports the workspace as unavailable when Linear rejects the key", () => {
  const { layer } = makeLayer({ response: () => new Response("unauthorized", { status: 401 }) });

  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;

    const error = yield* Effect.flip(linear.workspace);

    assert.instanceOf(error, LinearUnavailableError);
    assert.strictEqual(error.reason, "unauthenticated");
  }).pipe(Effect.provide(layer));
});

it.effect("reads a team's workflow states", () => {
  const states: ReadonlyArray<LinearWorkflowState> = [
    { id: "state-1", name: "Todo", type: "unstarted", color: "#bec2c8", position: 0 },
    { id: "state-2", name: "In Progress", type: "started", color: "#f2c94c", position: 1 },
  ];
  const { layer } = makeLayer({
    response: () => Response.json({ data: { team: { states: { nodes: states } } } }),
  });

  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;

    assert.deepStrictEqual(yield* linear.workflowStates("team-1"), states);
  }).pipe(Effect.provide(layer));
});

it.effect("drops team states of a type this build does not know instead of failing", () => {
  const known: ReadonlyArray<LinearWorkflowState> = [
    { id: "state-1", name: "Todo", type: "unstarted", color: "#bec2c8", position: 0 },
    { id: "state-2", name: "In Progress", type: "started", color: "#f2c94c", position: 1 },
    { id: "state-3", name: "Duplicate", type: "duplicate", color: "#95a2b3", position: 5 },
  ];
  const unknown = { id: "state-4", name: "Parked", type: "parked", color: "#000000", position: 9 };
  const { layer } = makeLayer({
    response: () => Response.json({ data: { team: { states: { nodes: [...known, unknown] } } } }),
  });

  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;

    assert.deepStrictEqual(yield* linear.workflowStates("team-1"), known);
  }).pipe(Effect.provide(layer));
});

it.effect("fails the state move when Linear reports no success", () => {
  const { layer } = makeLayer({
    response: () => Response.json({ data: { issueUpdate: { success: false } } }),
  });

  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;

    const error = yield* Effect.flip(
      linear.updateIssueState({ issueId: "issue-uuid", stateId: "state-2" }),
    );

    assert.instanceOf(error, LinearOperationError);
    assert.strictEqual(error.operation, "updateIssueState");
  }).pipe(Effect.provide(layer));
});

it.effect("returns the created comment", () => {
  const { execute, layer } = makeLayer({
    response: () =>
      Response.json({
        data: {
          commentCreate: {
            success: true,
            comment: { id: "comment-3", url: "https://linear.app/acme/issue/DEL-123#comment-3" },
          },
        },
      }),
  });

  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;

    const comment = yield* linear.createComment({ issueId: "issue-uuid", body: "On it." });

    assert.deepStrictEqual(comment, {
      id: "comment-3",
      url: "https://linear.app/acme/issue/DEL-123#comment-3",
    });
    assert.deepStrictEqual(sentGraphQL(execute.mock.calls[0]![0]).variables, {
      issueId: "issue-uuid",
      body: "On it.",
    });
  }).pipe(Effect.provide(layer));
});

it.effect("sends only the fields the caller set", () => {
  const { execute, layer } = makeLayer({
    response: () => Response.json({ data: { issueUpdate: { success: true } } }),
  });

  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;

    yield* linear.updateIssue({
      issueId: "issue-uuid",
      title: "Wire up Linear tools",
      labelIds: ["label-1"],
    });

    const sent = sentGraphQL(execute.mock.calls[0]![0]);
    assert.deepStrictEqual(sent.variables, {
      id: "issue-uuid",
      input: { title: "Wire up Linear tools", labelIds: ["label-1"] },
    });
  }).pipe(Effect.provide(layer));
});

it.effect("fails the issue patch when Linear reports no success", () => {
  const { layer } = makeLayer({
    response: () => Response.json({ data: { issueUpdate: { success: false } } }),
  });

  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;

    const error = yield* Effect.flip(
      linear.updateIssue({ issueId: "issue-uuid", description: "New body." }),
    );

    assert.instanceOf(error, LinearOperationError);
    assert.strictEqual(error.operation, "updateIssue");
  }).pipe(Effect.provide(layer));
});

it.effect("returns the created issue summary", () => {
  const { execute, layer } = makeLayer({
    response: () =>
      Response.json({ data: { issueCreate: { success: true, issue: issueSummary } } }),
  });

  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;

    const created = yield* linear.createIssue({
      teamId: "team-1",
      title: "Wire up Linear",
      parentId: "issue-parent",
    });

    assert.strictEqual(created.identifier, "DEL-123");
    assert.deepStrictEqual(sentGraphQL(execute.mock.calls[0]![0]).variables, {
      input: { teamId: "team-1", title: "Wire up Linear", parentId: "issue-parent" },
    });
  }).pipe(Effect.provide(layer));
});

it.effect("fails issue creation when Linear answers without an issue", () => {
  const { layer } = makeLayer({
    response: () => Response.json({ data: { issueCreate: { success: true, issue: null } } }),
  });

  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;

    const error = yield* Effect.flip(linear.createIssue({ teamId: "team-1", title: "Orphan" }));

    assert.instanceOf(error, LinearOperationError);
    assert.strictEqual(error.operation, "createIssue");
  }).pipe(Effect.provide(layer));
});

it.effect("reads team and workspace labels, sorted by name regardless of case", () => {
  const { execute, layer } = makeLayer({
    response: () =>
      Response.json({
        data: {
          issueLabels: {
            nodes: [
              { id: "label-2", name: "urgent", color: "#eb5757" },
              { id: "label-1", name: "Integration", color: "#5e6ad2" },
            ],
          },
        },
      }),
  });

  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;

    assert.deepStrictEqual(yield* linear.labels("team-1"), [
      { id: "label-1", name: "Integration", color: "#5e6ad2" },
      { id: "label-2", name: "urgent", color: "#eb5757" },
    ]);

    const sent = sentGraphQL(execute.mock.calls[0]![0]);
    assert.deepStrictEqual(sent.variables, { teamId: "team-1" });
    // Workspace-level labels have no team, so the filter has to admit a null one.
    assert.isTrue(sent.query.includes("team: { null: true }"));
    assert.isTrue(sent.query.includes("$teamId: ID!"));
  }).pipe(Effect.provide(layer));
});

it.effect("reports labels as unavailable when Linear rejects the key", () => {
  const { layer } = makeLayer({ response: () => new Response("unauthorized", { status: 401 }) });

  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;

    const error = yield* Effect.flip(linear.labels("team-1"));

    assert.instanceOf(error, LinearUnavailableError);
    assert.strictEqual(error.reason, "unauthenticated");
  }).pipe(Effect.provide(layer));
});

it.effect("fetches a comment directly with its owning issue", () => {
  const comment = {
    id: "old-comment",
    body: "Original.",
    url: "https://linear.app/comment",
    issue: { id: "issue-uuid" },
  };
  const { execute, layer } = makeLayer({ response: () => Response.json({ data: { comment } }) });
  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;
    assert.deepStrictEqual(yield* linear.getComment("old-comment"), comment);
    assert.deepStrictEqual(sentGraphQL(execute.mock.calls[0]![0]).variables, { id: "old-comment" });
  }).pipe(Effect.provide(layer));
});

it.effect("updates the specified comment body", () => {
  const comment = { id: "comment-3", url: "https://linear.app/comment-3" };
  const { execute, layer } = makeLayer({
    response: () => Response.json({ data: { commentUpdate: { success: true, comment } } }),
  });
  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;
    assert.deepStrictEqual(
      yield* linear.updateComment({ id: comment.id, body: "Corrected." }),
      comment,
    );
    const request = sentGraphQL(execute.mock.calls[0]![0]);
    assert.include(request.query, "commentUpdate");
    assert.deepStrictEqual(request.variables, { id: comment.id, body: "Corrected." });
  }).pipe(Effect.provide(layer));
});

for (const payload of [
  { data: { commentUpdate: { success: false, comment: null } } },
  { data: { commentUpdate: { success: true, comment: null } } },
  { errors: [{ message: "Not authorized to edit this comment" }] },
]) {
  it.effect("surfaces rejected comment edits", () => {
    const { layer } = makeLayer({ response: () => Response.json(payload) });
    return Effect.gen(function* () {
      const linear = yield* LinearApi.LinearApi;
      const error = yield* Effect.flip(
        linear.updateComment({ id: "comment-3", body: "Corrected." }),
      );
      assert.instanceOf(error, LinearOperationError);
      assert.strictEqual(error.operation, "updateComment");
    }).pipe(Effect.provide(layer));
  });
}

for (const assigneeId of ["user-1", null]) {
  it.effect(`sends an explicit assignee patch: ${assigneeId}`, () => {
    const { execute, layer } = makeLayer({
      response: () => Response.json({ data: { issueUpdate: { success: true } } }),
    });
    return Effect.gen(function* () {
      const linear = yield* LinearApi.LinearApi;
      yield* linear.updateIssue({ issueId: "issue-uuid", assigneeId });
      assert.deepStrictEqual(sentGraphQL(execute.mock.calls[0]![0]).variables, {
        id: "issue-uuid",
        input: { assigneeId },
      });
    }).pipe(Effect.provide(layer));
  });
}

for (const reference of ["Ada", "ada@example.com", "12345678-1234-1234-1234-123456789abc"]) {
  it.effect(`resolves an assignee by ${reference}`, () => {
    const user = { id: "user-1", name: "Ada Lovelace", displayName: "ada" };
    const { execute, layer } = makeLayer({
      response: () => Response.json({ data: { users: { nodes: [user] } } }),
    });
    return Effect.gen(function* () {
      const linear = yield* LinearApi.LinearApi;
      assert.deepStrictEqual(yield* linear.resolveAssignee(reference), user);
      assert.deepStrictEqual(sentGraphQL(execute.mock.calls[0]![0]).variables, {
        filter: reference.startsWith("12345678")
          ? { id: { eq: reference } }
          : {
              or: [
                { name: { eqIgnoreCase: reference } },
                { displayName: { eqIgnoreCase: reference } },
                { email: { eqIgnoreCase: reference } },
              ],
            },
      });
    }).pipe(Effect.provide(layer));
  });
}

for (const count of [0, 2]) {
  it.effect(`rejects assignee lookup with ${count} matches`, () => {
    const { layer } = makeLayer({
      response: () =>
        Response.json({
          data: {
            users: {
              nodes: Array.from({ length: count }, (_, i) => ({
                id: `user-${i}`,
                name: "Ada",
                displayName: "ada",
              })),
            },
          },
        }),
    });
    return Effect.gen(function* () {
      const linear = yield* LinearApi.LinearApi;
      const error = yield* Effect.flip(linear.resolveAssignee("Ada"));
      assert.strictEqual(error._tag, "LinearOperationError");
    }).pipe(Effect.provide(layer));
  });
}

it.effect("sends and clears every issue planning field without losing zero estimates", () => {
  const { execute, layer } = makeLayer({
    response: () => Response.json({ data: { issueUpdate: { success: true } } }),
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    const patch = {
      projectId: "project-1",
      projectMilestoneId: "milestone-1",
      cycleId: "cycle-1",
      estimate: 0,
      priority: 1,
      dueDate: "2026-10-01",
    };
    yield* api.updateIssue({ issueId: "issue-1", ...patch });
    yield* api.updateIssue({
      issueId: "issue-1",
      projectId: null,
      projectMilestoneId: null,
      cycleId: null,
      estimate: null,
      dueDate: null,
    });
    assert.deepStrictEqual(sentGraphQL(execute.mock.calls[0]![0]).variables, {
      id: "issue-1",
      input: patch,
    });
    assert.deepStrictEqual(sentGraphQL(execute.mock.calls[1]![0]).variables, {
      id: "issue-1",
      input: {
        projectId: null,
        projectMilestoneId: null,
        cycleId: null,
        estimate: null,
        dueDate: null,
      },
    });
  }).pipe(Effect.provide(layer));
});

it.effect("paginates resource discovery and scopes milestones and cycles", () => {
  const page = {
    nodes: [{ id: "resource-1", name: "Launch" }],
    pageInfo: { hasNextPage: true, endCursor: "next" },
  };
  const { execute, layer } = makeLayer({
    response: () => Response.json({ data: { resources: page } }),
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    assert.deepStrictEqual(
      yield* api.listResources({
        kind: "milestone",
        projectId: "p1",
        exact: "Launch",
        cursor: "previous",
        limit: 200,
      }),
      page,
    );
    yield* api.listResources({ kind: "cycle", teamId: "t1", exact: "current" });
    assert.deepStrictEqual(sentGraphQL(execute.mock.calls[0]![0]).variables, {
      filter: { and: [{ name: { eqIgnoreCase: "Launch" } }, { project: { id: { eq: "p1" } } }] },
      first: 100,
      after: "previous",
    });
    assert.deepStrictEqual(sentGraphQL(execute.mock.calls[1]![0]).variables, {
      filter: { and: [{ isActive: { eq: true } }, { team: { id: { eq: "t1" } } }] },
      first: 50,
      after: null,
    });
  }).pipe(Effect.provide(layer));
});

for (const kind of ["project", "milestone", "cycle", "label"] as const) {
  it.effect(`creates or updates a ${kind} with only supported fields`, () => {
    const resource = { id: "r1", name: "Ready" };
    const { execute, layer } = makeLayer({
      response: () => Response.json({ data: { result: { success: true, resource } } }),
    });
    return Effect.gen(function* () {
      const api = yield* LinearApi.LinearApi;
      assert.deepStrictEqual(
        yield* api.saveResource({ kind, id: "r1", name: "Ready", description: null }),
        resource,
      );
      assert.deepStrictEqual(sentGraphQL(execute.mock.calls[0]![0]).variables, {
        id: "r1",
        input: { name: "Ready", description: null },
      });
    }).pipe(Effect.provide(layer));
  });
}

it.effect("rejects a resource mutation when Linear refuses it", () => {
  const { layer } = makeLayer({
    response: () => Response.json({ data: { result: { success: false, resource: null } } }),
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    const error = yield* Effect.flip(api.saveResource({ kind: "project", id: "r1", name: "No" }));
    assert.strictEqual(error._tag, "LinearOperationError");
  }).pipe(Effect.provide(layer));
});

it.effect("preserves resource creation scope and distinguishes create from update", () => {
  const resource = { id: "r1", name: "Ready" };
  const { execute, layer } = makeLayer({
    response: () => Response.json({ data: { result: { success: true, resource } } }),
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    yield* api.saveResource({ kind: "project", name: "Ready", teamIds: ["team-1"] });
    yield* api.saveResource({ kind: "milestone", name: "Ready", projectId: "project-1" });
    yield* api.saveResource({ kind: "label", name: "Ready", teamId: "team-1" });
    assert.deepStrictEqual(
      execute.mock.calls.map((call) => sentGraphQL(call[0]).variables),
      [
        { input: { name: "Ready", teamIds: ["team-1"] } },
        { input: { name: "Ready", projectId: "project-1" } },
        { input: { name: "Ready", teamId: "team-1" } },
      ],
    );
    assert.include(sentGraphQL(execute.mock.calls[0]![0]).query, "projectCreate");
  }).pipe(Effect.provide(layer));
});

it.effect("passes issue search filters and pagination through to Linear", () => {
  const pageInfo = { hasNextPage: true, endCursor: "more" };
  const { execute, layer } = makeLayer({
    response: () => Response.json({ data: { issues: { nodes: [], pageInfo } } }),
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    assert.deepStrictEqual(
      yield* api.listIssues({
        assignedToMe: false,
        assigneeId: null,
        query: "retry",
        cursor: "next",
        limit: 20,
      }),
      { issues: [], pageInfo },
    );
    assert.deepStrictEqual(sentGraphQL(execute.mock.calls[0]![0]).variables, {
      filter: {
        assignee: { null: true },
        title: { containsIgnoreCase: "retry" },
        state: { type: { in: ["unstarted", "started"] } },
      },
      first: 20,
      after: "next",
    });
  }).pipe(Effect.provide(layer));
});

const signedUpload = {
  fileUpload: {
    success: true,
    uploadFile: {
      assetUrl: "https://uploads.linear.app/acme/after.png",
      uploadUrl: "https://storage.linear.test/signed",
      headers: [{ key: "x-amz-signature", value: "signature" }],
    },
  },
};

it.effect("signs an upload, replays the signed headers, and returns the asset URL", () => {
  const { execute, layer } = makeLayer({
    response: (request) =>
      request.method === "PUT"
        ? new Response(null, { status: 200 })
        : Response.json({ data: signedUpload }),
  });

  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);

    assert.deepStrictEqual(
      yield* api.uploadFile({ fileName: "after.png", contentType: "image/png", bytes }),
      { url: "https://uploads.linear.app/acme/after.png" },
    );

    assert.deepStrictEqual(sentGraphQL(execute.mock.calls[0]![0]).variables, {
      contentType: "image/png",
      filename: "after.png",
      size: 4,
    });

    // The bytes go to storage, not through Linear's API, under the headers the
    // signature was issued for.
    const upload = execute.mock.calls[1]![0];
    assert.strictEqual(upload.url, "https://storage.linear.test/signed");
    assert.strictEqual(upload.method, "PUT");
    assert.strictEqual(upload.headers["x-amz-signature"], "signature");
    assert.strictEqual(upload.headers["cache-control"], "public, max-age=31536000");
    assert.strictEqual(upload.body._tag, "Uint8Array");
  }).pipe(Effect.provide(layer));
});

it.effect("reports the status when storage rejects the upload", () => {
  const { layer } = makeLayer({
    response: (request) =>
      request.method === "PUT"
        ? new Response("expired", { status: 403 })
        : Response.json({ data: signedUpload }),
  });

  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    const error = yield* Effect.flip(
      api.uploadFile({
        fileName: "after.png",
        contentType: "image/png",
        bytes: Uint8Array.from([1]),
      }),
    );
    assert.instanceOf(error, LinearOperationError);
    assert.include(error.detail, "HTTP 403");
  }).pipe(Effect.provide(layer));
});

it.effect("refuses an upload Linear declines to sign", () => {
  const { execute, layer } = makeLayer({
    response: () => Response.json({ data: { fileUpload: { success: false, uploadFile: null } } }),
  });

  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    const error = yield* Effect.flip(
      api.uploadFile({
        fileName: "after.png",
        contentType: "image/png",
        bytes: Uint8Array.from([1]),
      }),
    );
    assert.instanceOf(error, LinearOperationError);
    // Nothing left the machine once Linear refused to sign for it.
    assert.strictEqual(execute.mock.calls.length, 1);
  }).pipe(Effect.provide(layer));
});
