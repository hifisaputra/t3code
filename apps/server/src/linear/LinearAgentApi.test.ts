import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { LinearOAuth } from "./LinearOAuth.ts";
import * as AgentApi from "./LinearAgentApi.ts";

const decodeRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ variables: Schema.Unknown })),
);
function variables(request: HttpClientRequest.HttpClientRequest) {
  if (request.body._tag !== "Uint8Array") throw new Error("Expected JSON request");
  return decodeRequest(new TextDecoder().decode(request.body.body)).variables;
}

it.effect("refreshes once after a 401 and posts activities as the app", () => {
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  const refreshes: boolean[] = [];
  const layer = AgentApi.layer.pipe(
    Layer.provide(
      Layer.mock(LinearOAuth)({
        accessToken: (force) =>
          Effect.sync(() => {
            refreshes.push(force);
            return force ? "new-token" : "old-token";
          }),
      }),
    ),
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          requests.push(request);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              requests.length === 1
                ? new Response(null, { status: 401 })
                : Response.json({ data: { agentActivityCreate: { success: true } } }),
            ),
          );
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const api = yield* AgentApi.LinearAgentApi;
    yield* api.activity("session", { type: "elicitation", body: "Which repository?" });
    assert.deepEqual(refreshes, [false, true]);
    assert.equal(requests[1]?.headers.authorization, "Bearer new-token");
    assert.deepEqual(variables(requests[1]!), {
      input: {
        agentSessionId: "session",
        content: { type: "elicitation", body: "Which repository?" },
      },
    });
  }).pipe(Effect.provide(layer));
});

function recording(data: unknown) {
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  const layer = AgentApi.layer.pipe(
    Layer.provide(Layer.mock(LinearOAuth)({ accessToken: () => Effect.succeed("token") })),
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          requests.push(request);
          return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ data })));
        }),
      ),
    ),
  );
  return { requests, layer };
}

it.effect("adds thread and pull request links without replacing existing session links", () => {
  const { requests, layer } = recording({ agentSessionUpdate: { success: true } });
  return Effect.gen(function* () {
    const api = yield* AgentApi.LinearAgentApi;
    yield* api.update("session", {
      addedExternalUrls: [{ label: "Pull request", url: "https://github.com/org/repo/pull/1" }],
    });
    assert.deepEqual(variables(requests[0]!), {
      id: "session",
      input: {
        addedExternalUrls: [{ label: "Pull request", url: "https://github.com/org/repo/pull/1" }],
      },
    });
  }).pipe(Effect.provide(layer));
});

it.effect("sends the whole plan as an array of steps", () => {
  const { requests, layer } = recording({ agentSessionUpdate: { success: true } });
  return Effect.gen(function* () {
    const api = yield* AgentApi.LinearAgentApi;
    yield* api.update("session", {
      plan: [
        { content: "Code", status: "completed" },
        { content: "Code review (round 2)", status: "inProgress" },
      ],
    });
    assert.deepEqual(variables(requests[0]!), {
      id: "session",
      input: {
        plan: [
          { content: "Code", status: "completed" },
          { content: "Code review (round 2)", status: "inProgress" },
        ],
      },
    });
  }).pipe(Effect.provide(layer));
});

it.effect("posts actions with a result and marks only ephemeral activities", () => {
  const { requests, layer } = recording({ agentActivityCreate: { success: true } });
  return Effect.gen(function* () {
    const api = yield* AgentApi.LinearAgentApi;
    yield* api.activity(
      "session",
      { type: "action", action: "Requested review", parameter: "https://pr", result: "3 findings" },
      true,
    );
    yield* api.activity("session", { type: "thought", body: "x".repeat(13000) }, false);
    assert.deepEqual(variables(requests[0]!), {
      input: {
        agentSessionId: "session",
        content: {
          type: "action",
          action: "Requested review",
          parameter: "https://pr",
          result: "3 findings",
        },
        ephemeral: true,
      },
    });
    assert.deepEqual(variables(requests[1]!), {
      input: { agentSessionId: "session", content: { type: "thought", body: "x".repeat(12000) } },
    });
  }).pipe(Effect.provide(layer));
});

it.effect("creates a session on an issue and returns its id", () => {
  const { requests, layer } = recording({
    agentSessionCreateOnIssue: { success: true, agentSession: { id: "new-session" } },
  });
  return Effect.gen(function* () {
    const api = yield* AgentApi.LinearAgentApi;
    assert.equal(yield* api.createOnIssue("issue-1"), "new-session");
    assert.deepEqual(variables(requests[0]!), { input: { issueId: "issue-1" } });
  }).pipe(Effect.provide(layer));
});

it.effect("fails when Linear creates no session", () => {
  const { layer } = recording({ agentSessionCreateOnIssue: { success: false } });
  return Effect.gen(function* () {
    const api = yield* AgentApi.LinearAgentApi;
    assert.isTrue(yield* api.createOnIssue("issue-1").pipe(Effect.isFailure));
  }).pipe(Effect.provide(layer));
});
