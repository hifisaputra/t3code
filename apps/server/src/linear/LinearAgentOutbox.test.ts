import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { EnvironmentId, LinearOperationError } from "@t3tools/contracts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import { LinearOAuth } from "./LinearOAuth.ts";
import { LinearAgentApi } from "./LinearAgentApi.ts";
import * as Outbox from "./LinearAgentOutbox.ts";
import Migration from "../persistence/Migrations/051_LinearDelegation.ts";
import SessionTaskMigration from "../persistence/Migrations/058_LinearAgentSessionTask.ts";

function harness() {
  const sent: string[] = [];
  let failNext = false;
  const record = (entry: string) =>
    Effect.suspend(() => {
      if (failNext) {
        failNext = false;
        return Effect.fail(new LinearOperationError({ operation: "agentSession", detail: "Down" }));
      }
      sent.push(entry);
      return Effect.void;
    });
  const dependencies = Layer.mergeAll(
    ServerSettings.layerTest({
      linear: { delegation: { enabled: true, publicUrl: "https://t3.example.com/" } },
    }),
    Layer.succeed(ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("env")),
    }),
    Layer.mock(LinearOAuth)({
      status: Effect.succeed({ connected: true, organizationId: "org" }),
    }),
    Layer.mock(LinearAgentApi)({
      activity: (_id, content, ephemeral) =>
        record(
          `${content.type}:${content.type === "action" ? content.action : content.body}${ephemeral ? ":ephemeral" : ""}`,
        ),
      update: (_id, input) =>
        record(
          `update:${input.plan?.map((step) => `${step.content}=${step.status}`).join(",") ?? ""}:${input.addedExternalUrls?.map((link) => link.url).join(",") ?? ""}`,
        ),
      createOnIssue: () => Effect.succeed("created-session"),
    }),
  );
  const make = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE orchestration_events (sequence INTEGER)`;
    yield* Migration;
    yield* SessionTaskMigration;
    return yield* Outbox.make.pipe(Effect.provideService(Outbox.LinearAgentOutboxWorkers, false));
  }).pipe(Effect.provide(dependencies));
  return {
    make,
    sent,
    failOnce: () => {
      failNext = true;
    },
  };
}

it.effect("sends a session's updates in order and stops at the first failure", () => {
  const h = harness();
  return Effect.gen(function* () {
    const outbox = yield* h.make;
    yield* outbox.enqueue("a", "s", { type: "thought", body: "first" });
    yield* outbox.enqueue("b", "s", {
      type: "action",
      action: "Merged",
      parameter: "abc",
      ephemeral: true,
    });
    yield* outbox.enqueue("a", "s", { type: "thought", body: "duplicate id is ignored" });
    h.failOnce();
    assert.isTrue(yield* outbox.send("s").pipe(Effect.isFailure));
    assert.deepEqual(h.sent, []);
    yield* outbox.send("s");
    yield* outbox.send("s");
    assert.deepEqual(h.sent, ["thought:first", "action:Merged:ephemeral"]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory()), Effect.scoped);
});

it.effect("resolves a task sync when sent and re-arms it after it was sent", () => {
  const h = harness();
  return Effect.gen(function* () {
    const outbox = yield* h.make;
    let stage = "Code";
    yield* outbox.enqueue("sync-1", "s", { type: "syncTask", taskId: "task" });
    yield* outbox.enqueue("note", "s", { type: "thought", body: "note" });
    // Without a resolver the sync waits and holds back what came after it.
    assert.isTrue(yield* outbox.send("s").pipe(Effect.isFailure));
    assert.deepEqual(h.sent, []);
    yield* outbox.enqueue("sync-2", "s", { type: "syncTask", taskId: "task" });
    yield* outbox.setTaskSync(() =>
      Effect.succeed({
        plan: [{ content: stage, status: "inProgress" as const }],
        links: [{ label: "Thread", url: "https://t3/thread" }],
      }),
    );
    stage = "Code review";
    yield* outbox.send("s");
    // The replaced sync moved behind the note and reads the task as it is now.
    assert.deepEqual(h.sent, ["thought:note", "update:Code review=inProgress:https://t3/thread"]);
    stage = "Merge";
    yield* outbox.enqueue("sync-3", "s", { type: "syncTask", taskId: "task" });
    yield* outbox.send("s");
    assert.equal(h.sent.at(-1), "update:Merge=inProgress:https://t3/thread");
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory()), Effect.scoped);
});

it.effect("records a created session against its task and builds thread links", () => {
  const h = harness();
  return Effect.gen(function* () {
    const outbox = yield* h.make;
    assert.equal(yield* outbox.createSession("issue-1", "task-1"), "created-session");
    const sql = yield* SqlClient.SqlClient;
    assert.deepEqual(
      yield* sql`SELECT id, issue_id, thread_id, status, context, task_id FROM linear_agent_sessions`,
      [
        {
          id: "created-session",
          issue_id: "issue-1",
          thread_id: null,
          status: "active",
          context: "{}",
          task_id: "task-1",
        },
      ],
    );
    assert.deepEqual(yield* outbox.threadLink("thread 1"), {
      label: "T3 Code thread",
      url: "https://t3.example.com/env/thread%201",
    });
    assert.isTrue(yield* outbox.connected);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory()), Effect.scoped);
});

it.effect("hands a team reply to the registered handler and fails without one", () => {
  const h = harness();
  return Effect.gen(function* () {
    const outbox = yield* h.make;
    const input = {
      deliveryId: "d1",
      sessionId: "s",
      taskId: "task",
      body: "Blue, please",
      signal: null,
    };
    assert.isTrue(yield* outbox.teamPrompt(input).pipe(Effect.isFailure));
    const handled: Outbox.TeamPromptInput[] = [];
    yield* outbox.setTeamPrompt((next) =>
      Effect.sync(() => {
        handled.push(next);
      }),
    );
    yield* outbox.teamPrompt(input);
    assert.deepEqual(handled, [input]);
    yield* outbox.setTeamPrompt(() =>
      Effect.fail(new LinearOperationError({ operation: "agentSession", detail: "Busy" })),
    );
    assert.isTrue(yield* outbox.teamPrompt(input).pipe(Effect.isFailure));
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory()), Effect.scoped);
});
