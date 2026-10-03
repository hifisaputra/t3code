import { assert, it, vi } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
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
  relations: {
    nodes: [
      {
        id: "relation-blocks",
        type: "blocks",
        relatedIssue: {
          id: "issue-130",
          identifier: "DEL-130",
          title: "Ship the integration",
          url: "https://linear.app/acme/issue/DEL-130",
          state: { name: "Todo" },
        },
      },
      {
        id: "relation-similar",
        type: "similar",
        relatedIssue: {
          id: "issue-131",
          identifier: "DEL-131",
          title: "Looks alike",
          url: "https://linear.app/acme/issue/DEL-131",
          state: { name: "Todo" },
        },
      },
    ],
  },
  inverseRelations: {
    nodes: [
      {
        id: "relation-blocked-by",
        type: "blocks",
        issue: {
          id: "issue-110",
          identifier: "DEL-110",
          title: "Store the key",
          url: "https://linear.app/acme/issue/DEL-110",
          state: { name: "In Progress" },
        },
      },
      {
        id: "relation-duplicated-by",
        type: "duplicate",
        issue: {
          id: "issue-140",
          identifier: "DEL-140",
          title: "Linear wiring",
          url: "https://linear.app/acme/issue/DEL-140",
          state: null,
        },
      },
      {
        id: "relation-related",
        type: "related",
        issue: {
          id: "issue-98",
          identifier: "DEL-98",
          title: "Integrations page",
          url: "https://linear.app/acme/issue/DEL-98",
          state: { name: "Done" },
        },
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
        parentId: null,
      },
      {
        id: "comment-2",
        body: "Automated update.",
        url: "https://linear.app/acme/issue/DEL-123#comment-2",
        createdAt: "2026-09-01T09:30:00.000Z",
        user: null,
        parentId: "comment-1",
      },
    ],
  },
  attachments: {
    nodes: [
      {
        id: "attachment-1",
        title: "Staging preview",
        subtitle: null,
        url: "https://staging.example.com/del-123",
        sourceType: null,
      },
    ],
  },
};

function makeLayer(input: {
  /** `null` is a request Linear never answers. */
  readonly response: (request: HttpClientRequest.HttpClientRequest) => Response | null;
  readonly apiKey?: string;
}) {
  const execute = vi.fn((request: HttpClientRequest.HttpClientRequest) => {
    const response = input.response(request);
    return response === null
      ? Effect.never
      : Effect.succeed(HttpClientResponse.fromWeb(request, response));
  });

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

const UUID = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;

/** A create's variables without the client id it generated, once that id is checked to be a UUID. */
function withoutClientId(variables: Record<string, unknown>): Record<string, unknown> {
  const nested = typeof variables.input === "object" && variables.input !== null;
  const { id, ...rest } = (nested ? variables.input : variables) as Record<string, unknown>;
  assert.match(String(id), UUID);
  return nested ? { ...variables, input: rest } : rest;
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

it.effect("names the field Linear rejected and its explanation", () => {
  const { layer } = makeLayer({
    response: () =>
      Response.json(
        {
          errors: [
            {
              message: "Argument Validation Error",
              path: ["projectCreate"],
              extensions: {
                code: "INVALID_INPUT",
                type: "invalid input",
                userError: true,
                userPresentableMessage: "name must be shorter than or equal to 80 characters",
                validationErrors: [
                  {
                    target: { name: "x".repeat(120), teamIds: ["team-1"] },
                    value: "x".repeat(120),
                    property: "name",
                    children: [],
                    constraints: {
                      maxLength: "name must be shorter than or equal to 80 characters",
                    },
                  },
                ],
              },
            },
          ],
          data: null,
        },
        { status: 400 },
      ),
  });

  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;

    const error = yield* Effect.flip(
      api.saveResource({ kind: "project", name: "x".repeat(120), teamIds: ["team-1"] }),
    );

    assert.instanceOf(error, LinearOperationError);
    assert.strictEqual(
      error.message,
      "Linear operation saveResource failed: Linear rejected the request: Argument Validation Error. name must be shorter than or equal to 80 characters. Rejected field: name",
    );
  }).pipe(Effect.provide(layer));
});

it.effect("reads nested rejected fields and keeps a long rejection short", () => {
  const constraint = (property: string) => ({
    property,
    children: [],
    constraints: {
      isUuid: `${property} must be a UUID${property === "teamId" ? "" : ` ${"because ".repeat(30)}`}`,
    },
  });
  const { layer } = makeLayer({
    response: () =>
      Response.json({
        errors: [
          {
            message: "Argument Validation Error",
            extensions: {
              code: "INVALID_INPUT",
              validationErrors: [
                {
                  property: "input",
                  children: ["teamId", "stateId", "projectId", "cycleId"].map(constraint),
                },
              ],
            },
          },
        ],
      }),
  });

  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;

    const error = yield* Effect.flip(linear.createIssue({ teamId: "DEL", title: "Broken" }));

    assert.instanceOf(error, LinearOperationError);
    assert.isTrue(
      error.detail.startsWith(
        "Linear rejected the request: Argument Validation Error. Rejected fields: input.teamId (teamId must be a UUID), input.stateId (stateId must be a UUID because",
      ),
    );
    assert.isTrue(error.detail.endsWith("…"));
    assert.isAtMost(error.detail.length, 400);
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
    // A reply names the comment it answers; a top-level comment has no key at all.
    assert.deepStrictEqual(
      issue.comments.map((comment) => comment.parentId),
      [undefined, "comment-1"],
    );
    assert.isFalse("parentId" in issue.comments[0]!);
    assert.deepStrictEqual(issue.attachments, issueDetail.attachments.nodes);
    assert.strictEqual(issue.project?.name, "Linear");
    assert.strictEqual(issue.truncated, undefined);
    // An issue whose lists fit their first page is one request.
    assert.strictEqual(execute.mock.calls.length, 1);
    assert.deepStrictEqual(sentGraphQL(execute.mock.calls[0]![0]).variables, { id: "DEL-123" });
  }).pipe(Effect.provide(layer));
});

it.effect("reads relations in both directions from the issue's own side", () => {
  const { layer } = makeLayer({
    response: () => Response.json({ data: { issue: issueDetail } }),
  });

  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;

    const issue = yield* linear.getIssue({ reference: "DEL-123" });

    // A relation stored on another issue reads inverted here, and Linear's
    // own `similar` suggestions are left out.
    assert.deepStrictEqual(
      issue.relations?.map((relation) => [relation.id, relation.type, relation.issue.identifier]),
      [
        ["relation-blocks", "blocks", "DEL-130"],
        ["relation-blocked-by", "blockedBy", "DEL-110"],
        ["relation-duplicated-by", "duplicatedBy", "DEL-140"],
        ["relation-related", "related", "DEL-98"],
      ],
    );
    assert.deepStrictEqual(issue.relations?.[1]?.issue, {
      id: "issue-110",
      identifier: "DEL-110",
      title: "Store the key",
      url: "https://linear.app/acme/issue/DEL-110",
      stateName: "In Progress",
    });
  }).pipe(Effect.provide(layer));
});

it.effect("stores a blocked-by relation on the issue that does the blocking", () => {
  const { execute, layer } = makeLayer({
    response: () => Response.json({ data: { issueRelationCreate: { success: true } } }),
  });

  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;

    yield* linear.addIssueRelation({
      issueId: "issue-uuid",
      type: "blockedBy",
      otherIssueId: "issue-110",
    });
    yield* linear.addIssueRelation({
      issueId: "issue-uuid",
      type: "duplicateOf",
      otherIssueId: "issue-140",
    });

    assert.deepStrictEqual(
      execute.mock.calls.map(([request]) => withoutClientId(sentGraphQL(request).variables)),
      [
        { input: { type: "blocks", issueId: "issue-110", relatedIssueId: "issue-uuid" } },
        { input: { type: "duplicate", issueId: "issue-uuid", relatedIssueId: "issue-140" } },
      ],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("deletes a relation by id and fails when Linear refuses", () => {
  const { execute, layer } = makeLayer({
    response: () => Response.json({ data: { issueRelationDelete: { success: false } } }),
  });

  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;

    const error = yield* Effect.flip(linear.removeIssueRelation("relation-blocks"));

    assert.instanceOf(error, LinearOperationError);
    assert.strictEqual(error.operation, "removeIssueRelation");
    assert.deepStrictEqual(sentGraphQL(execute.mock.calls[0]![0]).variables, {
      id: "relation-blocks",
    });
  }).pipe(Effect.provide(layer));
});

it.effect("archives with issueArchive and restores with issueUnarchive", () => {
  const { execute, layer } = makeLayer({
    response: () => Response.json({ data: { result: { success: true } } }),
  });
  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;
    yield* linear.archiveIssue({ issueId: "issue-uuid", archived: true });
    yield* linear.archiveIssue({ issueId: "issue-uuid", archived: false });
    const [archive, restore] = execute.mock.calls.map(([request]) => sentGraphQL(request));
    assert.include(archive!.query, "issueArchive(id: $id)");
    assert.include(restore!.query, "issueUnarchive(id: $id)");
    assert.deepStrictEqual(archive!.variables, { id: "issue-uuid" });
    assert.deepStrictEqual(restore!.variables, { id: "issue-uuid" });
  }).pipe(Effect.provide(layer));
});

it.effect("fails the archive when Linear reports no success", () => {
  const { layer } = makeLayer({
    response: () => Response.json({ data: { result: { success: false } } }),
  });
  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;
    const error = yield* Effect.flip(
      linear.archiveIssue({ issueId: "issue-uuid", archived: true }),
    );
    assert.instanceOf(error, LinearOperationError);
    assert.strictEqual(error.detail, "Linear refused to archive the issue.");
  }).pipe(Effect.provide(layer));
});

it.effect("reads when an issue was archived", () => {
  const { execute, layer } = makeLayer({
    response: () =>
      Response.json({
        data: { issue: { ...issueDetail, archivedAt: "2026-09-02T00:00:00.000Z" } },
      }),
  });
  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;
    const issue = yield* linear.getIssue({ reference: "DEL-123" });
    assert.strictEqual(issue.archivedAt, "2026-09-02T00:00:00.000Z");
    assert.include(sentGraphQL(execute.mock.calls[0]![0]).query, "archivedAt");
  }).pipe(Effect.provide(layer));
});

const commentNode = (index: number) => ({
  id: `comment-page-${index}`,
  body: `Comment ${index}`,
  url: `https://linear.app/acme/issue/DEL-123#comment-page-${index}`,
  createdAt: "2026-09-01T09:00:00.000Z",
  user: null,
});

const commentPage = (from: number, count: number, endCursor: string | null) => ({
  nodes: Array.from({ length: count }, (_, offset) => commentNode(from + offset)),
  pageInfo: { hasNextPage: endCursor !== null, endCursor },
});

it.effect("reads the rest of a list that outgrows its first page", () => {
  const { execute, layer } = makeLayer({
    response: (request) =>
      sentGraphQL(request).query.includes("T3CodeIssueListPage")
        ? Response.json({ data: { issue: { page: commentPage(2, 1, null) } } })
        : Response.json({
            data: {
              issue: {
                ...issueDetail,
                comments: {
                  ...issueDetail.comments,
                  pageInfo: { hasNextPage: true, endCursor: "after-2" },
                },
              },
            },
          }),
  });

  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;
    const issue = yield* linear.getIssue({ reference: "DEL-123" });

    assert.deepStrictEqual(
      issue.comments.map((comment) => comment.id),
      ["comment-1", "comment-2", "comment-page-2"],
    );
    assert.strictEqual(issue.truncated, undefined);
    const [first, next] = execute.mock.calls.map(([request]) => sentGraphQL(request));
    assert.include(first!.query, "comments(first: 50) {");
    assert.include(next!.query, "page: comments(first: 100, after: $after)");
    // The follow-up addresses the issue by its UUID, not the reference typed.
    assert.deepStrictEqual(next!.variables, { id: "issue-uuid", after: "after-2" });
  }).pipe(Effect.provide(layer));
});

it.effect("stops at a few hundred and says which list it cut short", () => {
  let pages = 0;
  const { execute, layer } = makeLayer({
    response: (request) => {
      if (!sentGraphQL(request).query.includes("T3CodeIssueListPage")) {
        return Response.json({
          data: { issue: { ...issueDetail, comments: commentPage(0, 50, "page-0") } },
        });
      }
      pages += 1;
      return Response.json({
        data: { issue: { page: commentPage(pages * 100 - 50, 100, `page-${pages}`) } },
      });
    },
  });

  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;
    const issue = yield* linear.getIssue({ reference: "DEL-123" });

    assert.strictEqual(issue.comments.length, 250);
    assert.deepStrictEqual(issue.truncated, ["comments"]);
    assert.strictEqual(execute.mock.calls.length, 3);
  }).pipe(Effect.provide(layer));
});

it.effect("looks an issue up by the identifier in a pasted Linear link", () => {
  const { execute, layer } = makeLayer({
    response: () => Response.json({ data: { issue: issueDetail } }),
  });

  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;

    const issue = yield* linear.getIssue({
      reference: "https://linear.app/acme/issue/DEL-123/wire-up-linear?view=board",
    });

    assert.strictEqual(issue.identifier, "DEL-123");
    assert.deepStrictEqual(sentGraphQL(execute.mock.calls[0]![0]).variables, { id: "DEL-123" });
  }).pipe(Effect.provide(layer));
});

it("reduces Linear links to identifiers and leaves other references alone", () => {
  assert.strictEqual(
    LinearApi.issueReferenceFromText("https://linear.app/acme/issue/del-7/slug"),
    "DEL-7",
  );
  assert.strictEqual(
    LinearApi.issueReferenceFromText(" https://linear.app/acme/issue/DEL-7 "),
    "DEL-7",
  );
  assert.strictEqual(LinearApi.issueReferenceFromText(" DEL-7 "), "DEL-7");
  assert.strictEqual(
    LinearApi.issueReferenceFromText("0f1c1f3e-4c4e-4f1b-9d3a-2c3b4a5d6e7f"),
    "0f1c1f3e-4c4e-4f1b-9d3a-2c3b4a5d6e7f",
  );
  assert.strictEqual(
    LinearApi.issueReferenceFromText("https://linear.app/acme/project/roadmap-1"),
    "https://linear.app/acme/project/roadmap-1",
  );
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
    assert.deepStrictEqual(withoutClientId(sentGraphQL(execute.mock.calls[0]![0]).variables), {
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
    assert.deepStrictEqual(withoutClientId(sentGraphQL(execute.mock.calls[0]![0]).variables), {
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
      execute.mock.calls.map((call) => withoutClientId(sentGraphQL(call[0]).variables)),
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
        and: [
          {
            or: [
              { title: { containsIgnoreCase: "retry" } },
              { description: { containsIgnoreCase: "retry" } },
            ],
          },
        ],
        state: { type: { in: ["unstarted", "started"] } },
      },
      first: 20,
      after: "next",
    });
  }).pipe(Effect.provide(layer));
});

it.effect("filters issues by labels, milestone, cycle and priority", () => {
  const { execute, layer } = makeLayer({
    response: () => Response.json({ data: { issues: { nodes: [] } } }),
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    yield* api.listIssues({
      assignedToMe: false,
      labelIds: ["label-1", "label-2"],
      projectMilestoneId: "milestone-1",
      cycleId: "cycle-1",
      priorities: [1, 2],
    });
    assert.deepStrictEqual(sentGraphQL(execute.mock.calls[0]![0]).variables.filter, {
      state: { type: { in: ["unstarted", "started"] } },
      labels: { some: { id: { in: ["label-1", "label-2"] } } },
      projectMilestone: { id: { eq: "milestone-1" } },
      cycle: { id: { eq: "cycle-1" } },
      priority: { in: [1, 2] },
    });
  }).pipe(Effect.provide(layer));
});

it.effect(
  "finds every word of a query in the title or description, and identifiers by number",
  () => {
    const { execute, layer } = makeLayer({
      response: () => Response.json({ data: { issues: { nodes: [] } } }),
    });
    return Effect.gen(function* () {
      const api = yield* LinearApi.LinearApi;
      yield* api.listIssues({ assignedToMe: false, query: "renderer  media spi-210" });
      const filter = sentGraphQL(execute.mock.calls[0]![0]).variables.filter as {
        readonly and: unknown;
      };
      assert.deepStrictEqual(filter.and, [
        {
          or: [
            { title: { containsIgnoreCase: "renderer" } },
            { description: { containsIgnoreCase: "renderer" } },
          ],
        },
        {
          or: [
            { title: { containsIgnoreCase: "media" } },
            { description: { containsIgnoreCase: "media" } },
          ],
        },
        {
          or: [
            { title: { containsIgnoreCase: "spi-210" } },
            { description: { containsIgnoreCase: "spi-210" } },
            { team: { key: { eqIgnoreCase: "spi" } }, number: { eq: 210 } },
          ],
        },
      ]);
    }).pipe(Effect.provide(layer));
  },
);

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

it.effect("passes a caller-owned UUID when creating a retryable comment", () => {
  const id = "778d7e70-33e7-46fd-a41a-d68c1ce109fe";
  const { execute, layer } = makeLayer({
    response: () =>
      Response.json({
        data: { commentCreate: { success: true, comment: { id, url: "https://linear.app/c" } } },
      }),
  });
  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;
    yield* linear.createComment({ id, issueId: "issue-uuid", body: "Report" });
    assert.deepStrictEqual(sentGraphQL(execute.mock.calls[0]![0]).variables, {
      id,
      issueId: "issue-uuid",
      body: "Report",
    });
  }).pipe(Effect.provide(layer));
});

/** Runs `effect` while moving the test clock, so backoff and attempt timeouts never wait in real time. */
const withTestClock = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(effect);
    for (let step = 0; step < 20; step += 1) yield* TestClock.adjust("5 seconds");
    return yield* Fiber.join(fiber);
  });

it.effect("retries a brief Linear outage and returns the answer", () => {
  let calls = 0;
  const { execute, layer } = makeLayer({
    response: () =>
      (calls += 1) === 1
        ? new Response("upstream unavailable", { status: 503 })
        : Response.json({ data: { issue: issueDetail } }),
  });

  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;

    const issue = yield* withTestClock(linear.getIssue({ reference: "DEL-123" }));

    assert.strictEqual(issue.identifier, "DEL-123");
    assert.strictEqual(execute.mock.calls.length, 2);
  }).pipe(Effect.provide(layer));
});

it.effect("waits out a short rate limit before retrying", () => {
  let calls = 0;
  const { execute, layer } = makeLayer({
    response: () =>
      (calls += 1) === 1
        ? new Response("slow down", { status: 429, headers: { "Retry-After": "3" } })
        : Response.json({ data: { issueUpdate: { success: true } } }),
  });

  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;

    yield* withTestClock(linear.updateIssue({ issueId: "issue-uuid", title: "Renamed" }));

    assert.strictEqual(execute.mock.calls.length, 2);
  }).pipe(Effect.provide(layer));
});

it.effect("does not retry a rejected key", () => {
  const { execute, layer } = makeLayer({
    response: () => new Response("unauthorized", { status: 401 }),
  });

  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;

    const error = yield* withTestClock(Effect.flip(linear.getIssue({ reference: "DEL-123" })));

    assert.instanceOf(error, LinearUnavailableError);
    assert.strictEqual(error.reason, "unauthenticated");
    assert.strictEqual(execute.mock.calls.length, 1);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "retries a timed-out comment with the same id and reads it back once Linear has it",
  () => {
    const url = "https://linear.app/acme/issue/DEL-123#comment-9";
    const { execute, layer } = makeLayer({
      response: (request) => {
        const { query, variables } = sentGraphQL(request);
        if (query.includes("T3CodeGetComment")) {
          return Response.json({
            data: {
              comment: { id: variables.id, body: "On it.", url, issue: { id: "issue-uuid" } },
            },
          });
        }
        // The first post lands but its answer never arrives; the retry finds the id taken.
        return execute.mock.calls.length === 1
          ? null
          : Response.json({
              errors: [
                {
                  message: "Entity with the given id already exists",
                  extensions: { code: "INVALID_INPUT" },
                },
              ],
            });
      },
    });

    return Effect.gen(function* () {
      const linear = yield* LinearApi.LinearApi;

      const comment = yield* withTestClock(
        linear.createComment({ issueId: "issue-uuid", body: "On it." }),
      );

      const sent = execute.mock.calls.map(([request]) => sentGraphQL(request));
      assert.strictEqual(sent.length, 3);
      const id = sent[0]!.variables.id;
      assert.match(String(id), UUID);
      assert.strictEqual(sent[1]!.variables.id, id);
      assert.include(sent[2]!.query, "T3CodeGetComment");
      assert.deepStrictEqual(comment, { id, url });
    }).pipe(Effect.provide(layer));
  },
);

it.effect("does not repeat an upload Linear may already have signed", () => {
  const { execute, layer } = makeLayer({
    response: () => new Response("upstream unavailable", { status: 503 }),
  });

  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;

    const error = yield* withTestClock(
      Effect.flip(
        api.uploadFile({
          fileName: "after.png",
          contentType: "image/png",
          bytes: Uint8Array.from([1]),
        }),
      ),
    );

    assert.instanceOf(error, LinearOperationError);
    assert.strictEqual(
      error.detail,
      "Linear returned HTTP 503. Linear may have applied it, so it was not sent again.",
    );
    assert.strictEqual(execute.mock.calls.length, 1);
  }).pipe(Effect.provide(layer));
});

it.effect("posts a reply under the comment it names", () => {
  const { execute, layer } = makeLayer({
    response: () =>
      Response.json({
        data: {
          commentCreate: { success: true, comment: { id: "reply-1", url: "https://linear.app/r" } },
        },
      }),
  });
  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;
    yield* linear.createComment({ issueId: "issue-uuid", body: "Agreed.", parentId: "comment-1" });
    const request = sentGraphQL(execute.mock.calls[0]![0]);
    assert.include(request.query, "parentId: $parentId");
    const { id, ...variables } = request.variables;
    assert.match(String(id), UUID);
    assert.deepStrictEqual(variables, {
      issueId: "issue-uuid",
      body: "Agreed.",
      parentId: "comment-1",
    });
  }).pipe(Effect.provide(layer));
});

it.effect("counts a retried comment delete that finds nothing as done", () => {
  const { execute, layer } = makeLayer({
    response: () =>
      execute.mock.calls.length === 1
        ? new Response("upstream unavailable", { status: 503 })
        : Response.json({
            errors: [{ message: "Entity not found", extensions: { code: "ENTITY_NOT_FOUND" } }],
          }),
  });
  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;
    yield* withTestClock(linear.deleteComment("comment-3"));
    assert.strictEqual(execute.mock.calls.length, 2);
  }).pipe(Effect.provide(layer));
});

it.effect("deletes a comment by id", () => {
  const { execute, layer } = makeLayer({
    response: () => Response.json({ data: { commentDelete: { success: true } } }),
  });
  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;
    yield* linear.deleteComment("comment-3");
    const request = sentGraphQL(execute.mock.calls[0]![0]);
    assert.include(request.query, "commentDelete");
    assert.deepStrictEqual(request.variables, { id: "comment-3" });
  }).pipe(Effect.provide(layer));
});

for (const [payload, expected] of [
  [
    {
      errors: [
        { message: "You can only delete your own comments", extensions: { code: "FORBIDDEN" } },
      ],
    },
    "Linear lets only a comment's author delete it.",
  ],
  [
    { data: { commentDelete: { success: false } } },
    "Linear lets only a comment's author delete it.",
  ],
  [
    { errors: [{ message: "Entity not found", extensions: { code: "ENTITY_NOT_FOUND" } }] },
    "Comment not found or inaccessible.",
  ],
] as const) {
  it.effect(`tells the agent why Linear refused a deletion: ${expected}`, () => {
    const { layer } = makeLayer({ response: () => Response.json(payload) });
    return Effect.gen(function* () {
      const linear = yield* LinearApi.LinearApi;
      const error = yield* Effect.flip(linear.deleteComment("comment-3"));
      assert.instanceOf(error, LinearOperationError);
      assert.strictEqual(error.operation, "deleteComment");
      assert.include(error.detail, expected);
    }).pipe(Effect.provide(layer));
  });
}

it.effect("attaches a link with its title and subtitle", () => {
  const attachment = {
    id: "attachment-2",
    title: "Dashboard",
    subtitle: "Production",
    url: "https://grafana.example.com/d/1",
    sourceType: null,
  };
  const { execute, layer } = makeLayer({
    response: () => Response.json({ data: { attachmentCreate: { success: true, attachment } } }),
  });
  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;
    assert.deepStrictEqual(
      yield* linear.createAttachment({
        issueId: "issue-uuid",
        url: attachment.url,
        title: "Dashboard",
        subtitle: "Production",
      }),
      attachment,
    );
    const request = sentGraphQL(execute.mock.calls[0]![0]);
    assert.include(request.query, "attachmentCreate");
    assert.deepStrictEqual(request.variables, {
      input: {
        issueId: "issue-uuid",
        url: attachment.url,
        title: "Dashboard",
        subtitle: "Production",
      },
    });
  }).pipe(Effect.provide(layer));
});

it.effect("reads an attachment with the issue it hangs on", () => {
  const attachment = {
    id: "attachment-1",
    title: "Staging preview",
    subtitle: null,
    url: "https://staging.example.com/del-123",
    sourceType: null,
    issue: {
      id: "issue-uuid",
      identifier: "DEL-123",
      url: "https://linear.app/acme/issue/DEL-123",
    },
  };
  const { layer } = makeLayer({ response: () => Response.json({ data: { attachment } }) });
  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;
    assert.deepStrictEqual(yield* linear.getAttachment("attachment-1"), attachment);
  }).pipe(Effect.provide(layer));
});

it.effect("reports a missing attachment in plain words", () => {
  const { layer } = makeLayer({
    response: () =>
      Response.json({
        errors: [{ message: "Entity not found", extensions: { code: "ENTITY_NOT_FOUND" } }],
      }),
  });
  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;
    const error = yield* Effect.flip(linear.getAttachment("attachment-9"));
    assert.instanceOf(error, LinearOperationError);
    assert.strictEqual(error.detail, "Attachment not found or inaccessible.");
  }).pipe(Effect.provide(layer));
});

it.effect("removes an attachment by id and fails when Linear refuses", () => {
  const { execute, layer } = makeLayer({
    response: () => Response.json({ data: { attachmentDelete: { success: false } } }),
  });
  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;
    const error = yield* Effect.flip(linear.deleteAttachment("attachment-1"));
    assert.instanceOf(error, LinearOperationError);
    assert.strictEqual(error.operation, "deleteAttachment");
    const request = sentGraphQL(execute.mock.calls[0]![0]);
    assert.include(request.query, "attachmentDelete");
    assert.deepStrictEqual(request.variables, { id: "attachment-1" });
  }).pipe(Effect.provide(layer));
});

const launchPlan = {
  id: "document-uuid",
  title: "Launch plan",
  url: "https://linear.app/acme/document/launch-plan-0f1e2d3c4b5a",
  updatedAt: "2026-09-02T10:00:00.000Z",
  project: { id: "project-1", name: "Linear" },
  content: "# Launch\n\nShip it.",
  // Linear sends null, not false, for a document outside the trash.
  trashed: null,
};
/** `launchPlan` as the API hands it back. */
const launchPlanRead = { ...launchPlan, trashed: false };

it.effect("finds documents by title or content in a project, newest first, without content", () => {
  const { content: _content, trashed: _trashed, ...summary } = launchPlan;
  const { execute, layer } = makeLayer({
    response: () =>
      Response.json({
        data: {
          documents: {
            nodes: [summary],
            pageInfo: { hasNextPage: true, endCursor: "cursor-2" },
          },
        },
      }),
  });
  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;
    const page = yield* linear.listDocuments({
      query: " launch ",
      projectId: "project-1",
      cursor: "cursor-1",
      limit: 500,
    });
    assert.deepStrictEqual(page, {
      nodes: [summary],
      pageInfo: { hasNextPage: true, endCursor: "cursor-2" },
    });
    const request = sentGraphQL(execute.mock.calls[0]![0]);
    assert.include(request.query, "orderBy: updatedAt");
    assert.notInclude(request.query, "content");
    assert.deepStrictEqual(request.variables, {
      filter: {
        and: [
          {
            or: [
              { title: { containsIgnoreCase: "launch" } },
              { searchableContent: { contains: "launch" } },
            ],
          },
          { project: { id: { eq: "project-1" } } },
        ],
      },
      first: 100,
      after: "cursor-1",
    });
  }).pipe(Effect.provide(layer));
});

it.effect("reads a document by the slug id at the end of a pasted link", () => {
  const { execute, layer } = makeLayer({
    response: () => Response.json({ data: { document: launchPlan } }),
  });
  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;
    assert.deepStrictEqual(yield* linear.getDocument(launchPlan.url), launchPlanRead);
    assert.deepStrictEqual(sentGraphQL(execute.mock.calls[0]![0]).variables, {
      id: "0f1e2d3c4b5a",
    });
  }).pipe(Effect.provide(layer));
});

it("reduces document links to slug ids and leaves other references alone", () => {
  assert.strictEqual(
    LinearApi.documentReferenceFromText(
      "https://linear.app/acme/document/launch-plan-0f1e2d3c4b5a",
    ),
    "0f1e2d3c4b5a",
  );
  assert.strictEqual(LinearApi.documentReferenceFromText(" document-uuid "), "document-uuid");
  assert.strictEqual(
    LinearApi.documentReferenceFromText("https://example.com/notes"),
    "https://example.com/notes",
  );
});

it.effect("reports a missing document in plain words", () => {
  const { layer } = makeLayer({
    response: () =>
      Response.json({
        errors: [{ message: "Entity not found", extensions: { code: "ENTITY_NOT_FOUND" } }],
      }),
  });
  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;
    const error = yield* Effect.flip(linear.getDocument("missing"));
    assert.instanceOf(error, LinearOperationError);
    assert.strictEqual(error.detail, "Document not found or inaccessible.");
  }).pipe(Effect.provide(layer));
});

for (const id of [undefined, "document-uuid"]) {
  it.effect(`${id ? "updates" : "creates"} a document with only the fields given`, () => {
    const { execute, layer } = makeLayer({
      response: () => Response.json({ data: { result: { success: true, document: launchPlan } } }),
    });
    return Effect.gen(function* () {
      const linear = yield* LinearApi.LinearApi;
      const saved = yield* linear.saveDocument({
        ...(id ? { id } : { title: "Launch plan", projectId: "project-1" }),
        content: launchPlan.content,
      });
      assert.deepStrictEqual(saved, launchPlanRead);
      const request = sentGraphQL(execute.mock.calls[0]![0]);
      assert.include(request.query, id ? "documentUpdate" : "documentCreate");
      if (id) {
        assert.deepStrictEqual(request.variables, { id, input: { content: launchPlan.content } });
      } else {
        // A create sends the id it would reuse on a retry.
        const { id: createdId, ...input } = request.variables.input as Record<string, unknown>;
        assert.match(String(createdId), UUID);
        assert.deepStrictEqual(input, {
          title: "Launch plan",
          content: launchPlan.content,
          projectId: "project-1",
        });
      }
    }).pipe(Effect.provide(layer));
  });
}

it.effect("trashes a document by id and fails when Linear refuses", () => {
  const { execute, layer } = makeLayer({
    response: () => Response.json({ data: { documentDelete: { success: false } } }),
  });
  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;
    const error = yield* Effect.flip(linear.deleteDocument("document-uuid"));
    assert.instanceOf(error, LinearOperationError);
    assert.strictEqual(error.operation, "deleteDocument");
    const request = sentGraphQL(execute.mock.calls[0]![0]);
    assert.include(request.query, "documentDelete");
    assert.deepStrictEqual(request.variables, { id: "document-uuid" });
  }).pipe(Effect.provide(layer));
});

it.effect("reads a trashed document as trashed", () => {
  const { layer } = makeLayer({
    response: () => Response.json({ data: { document: { ...launchPlan, trashed: true } } }),
  });
  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;
    const document = yield* linear.getDocument("document-uuid");
    assert.isTrue(document.trashed);
  }).pipe(Effect.provide(layer));
});

it.effect("restores a trashed document and returns it as it now reads", () => {
  const { execute, layer } = makeLayer({
    response: () =>
      Response.json({ data: { documentUnarchive: { success: true, entity: launchPlan } } }),
  });
  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;
    assert.deepStrictEqual(yield* linear.restoreDocument("document-uuid"), launchPlanRead);
    const request = sentGraphQL(execute.mock.calls[0]![0]);
    assert.include(request.query, "documentUnarchive");
    assert.deepStrictEqual(request.variables, { id: "document-uuid" });
  }).pipe(Effect.provide(layer));
});

it.effect("fails a restore Linear refuses", () => {
  const { layer } = makeLayer({
    response: () =>
      Response.json({ data: { documentUnarchive: { success: false, entity: null } } }),
  });
  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;
    const error = yield* Effect.flip(linear.restoreDocument("document-uuid"));
    assert.instanceOf(error, LinearOperationError);
    assert.strictEqual(error.operation, "restoreDocument");
  }).pipe(Effect.provide(layer));
});
