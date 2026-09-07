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
