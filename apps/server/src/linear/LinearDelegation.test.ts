import { ProviderRuntimeIngestionService } from "../orchestration/Services/ProviderRuntimeIngestion.ts";
import * as NodeCrypto from "node:crypto";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  EventId,
  ThreadId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type OrchestrationCommand,
  type LinearIssueDetail,
} from "@t3tools/contracts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { T3ProjectFileLoader } from "../project/T3ProjectFileLoader.ts";
import { LinearOAuth } from "./LinearOAuth.ts";
import { LinearAgentApi } from "./LinearAgentApi.ts";
import { LinearApi } from "./LinearApi.ts";
import { LinearThreadService } from "./LinearThreadService.ts";
import * as Delegation from "./LinearDelegation.ts";
import Migration from "../persistence/Migrations/051_LinearDelegation.ts";

const issue: LinearIssueDetail = {
  id: "issue-1",
  identifier: "DEL-1",
  title: "A fix",
  url: "https://linear.app/test/issue/DEL-1",
  branchName: "del-1-fix",
  priority: 0,
  updatedAt: "2026-09-08T00:00:00.000Z",
  state: { id: "s", name: "Todo", type: "unstarted", position: 0, color: "#fff" },
  team: { id: "team", key: "DEL", name: "Delivery" },
  assignee: null,
  project: null,
  cycle: null,
  description: "Fix the bug",
  comments: [],
  labels: [],
  children: [],
  parent: null,
};
const original = {
  type: "AgentSessionEvent" as const,
  action: "created" as const,
  webhookTimestamp: 0,
  organizationId: "org",
  agentSession: {
    id: "session-1",
    issue: { id: "issue-1" },
    comment: { body: "Original delegation comment" },
  },
  promptContext: "Fix the bug carefully",
  guidance: "Run focused tests before finishing",
};
const encode = Schema.encodeSync(Schema.fromJsonString(Delegation.AgentEvent));
const signed = (event: typeof Delegation.AgentEvent.Type) => {
  const body = new TextEncoder().encode(encode(event));
  return { body, signature: NodeCrypto.createHmac("sha256", "secret").update(body).digest("hex") };
};
function harness(twoRepos = false, allowedTeamKeys: string[] = []) {
  const commands: OrchestrationCommand[] = [];
  const prepared: string[] = [];
  const outgoing: string[] = [];
  const projects = ["One", ...(twoRepos ? ["Two"] : [])].map((title) => ({
    id: ProjectId.make(title),
    title,
    workspaceRoot: `/repos/${title}`,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-09-08T00:00:00.000Z",
    updatedAt: "2026-09-08T00:00:00.000Z",
  }));
  const dependencies = Layer.mergeAll(
    Layer.mock(ProviderRuntimeIngestionService)({ drain: Effect.void }),
    ServerSettings.layerTest({
      linear: {
        delegation: {
          enabled: true,
          allowedTeamKeys,
          clientId: "app",
          webhookSecret: "secret",
          publicUrl: "https://t3.example.com",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        },
      },
    }),
    Layer.succeed(ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("env")),
    }),
    Layer.mock(LinearOAuth)({
      status: Effect.succeed({ connected: true, organizationId: "org" }),
      accessToken: () => Effect.succeed("token"),
    }),
    Layer.mock(LinearApi)({ getIssue: () => Effect.succeed(issue) }),
    Layer.mock(LinearAgentApi)({
      activity: (_id, _type, body) =>
        Effect.sync(() => {
          outgoing.push(body);
        }),
      links: () => Effect.void,
    }),
    Layer.mock(LinearThreadService)({
      prepareIssueThread: (input) =>
        Effect.sync(() => {
          prepared.push(input.cwd);
          return {
            issue,
            branch: issue.branchName,
            worktreePath: "/worktrees/issue",
            baseBranch: "main",
            reusedExistingBranch: false,
            movedToState: null,
          };
        }),
    }),
    Layer.mock(OrchestrationEngineService)({
      dispatch: (command) =>
        Effect.sync(() => {
          commands.push(command);
          return { sequence: commands.length };
        }),
    }),
    Layer.mock(ProjectionSnapshotQuery)({
      getShellSnapshot: () =>
        Effect.succeed({
          projects,
          threads: [],
          snapshotSequence: 0,
          updatedAt: "2026-09-08T00:00:00.000Z",
        }),
    }),
    Layer.succeed(T3ProjectFileLoader, {
      load: () => Effect.succeed(Option.some({ linear: { teams: ["DEL"] } })),
    }),
  );
  const make = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE orchestration_events (sequence INTEGER)`;
    yield* Migration;
    return yield* Delegation.make.pipe(
      Effect.provideService(Delegation.LinearDelegationWorkers, false),
    );
  }).pipe(Effect.provide(dependencies));
  return { make, commands, prepared, outgoing, projects };
}
it.effect(
  "rejects bad signatures, stale timestamps, and the wrong workspace before admission",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const service = yield* h.make;
      const { body, signature } = signed(original);
      assert.isTrue(yield* service.receive(body, "bad", "d1").pipe(Effect.isFailure));
      const stale = signed({ ...original, webhookTimestamp: -61000 });
      assert.isTrue(
        yield* service.receive(stale.body, stale.signature, "d2").pipe(Effect.isFailure),
      );
      const foreign = signed({ ...original, organizationId: "other" });
      assert.isTrue(
        yield* service.receive(foreign.body, foreign.signature, "d3").pipe(Effect.isFailure),
      );
      yield* service.receive(body, signature, "d4");
      const sql = yield* SqlClient.SqlClient;
      assert.lengthOf(yield* sql`SELECT * FROM linear_agent_deliveries`, 1);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory()), Effect.scoped);
  },
);
it.effect("deduplicates deliveries and starts one linked thread in a worktree", () => {
  const h = harness();
  return Effect.gen(function* () {
    const service = yield* h.make;
    const { body, signature } = signed(original);
    yield* service.receive(body, signature, "d1");
    yield* service.receive(body, signature, "d1");
    yield* service.process("d1");
    yield* service.process("d1");
    assert.deepEqual(h.prepared, ["/repos/One"]);
    assert.deepEqual(
      h.commands.map((c) => c.type),
      ["thread.create", "thread.turn.start"],
    );
    const created = h.commands[0];
    assert.equal(created?.type, "thread.create");
    if (created?.type === "thread.create") {
      assert.equal(created.worktreePath, "/worktrees/issue");
      assert.equal(created.linkedIssue?.identifier, "DEL-1");
    }
    const start = h.commands[1];
    assert.equal(start?.type, "thread.turn.start");
    if (start?.type === "thread.turn.start") {
      assert.include(start.message.text, "$linear-work DEL-1: A fix");
      assert.include(start.message.text, issue.url);
      assert.include(start.message.text, "get_issue and list_comments MCP tools");
      assert.include(start.message.text, original.guidance);
      assert.notInclude(start.message.text, original.promptContext);
      assert.notInclude(start.message.text, issue.description!);
      assert.notInclude(start.message.text, original.agentSession.comment.body);
    }
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory()), Effect.scoped);
});
it.effect("asks which repository to use and resumes with the original issue context", () => {
  const h = harness(true);
  return Effect.gen(function* () {
    const service = yield* h.make;
    const initial = signed(original);
    yield* service.receive(initial.body, initial.signature, "d1");
    yield* service.process("d1");
    yield* service.sendOutgoing("d1:repository");
    assert.lengthOf(h.commands, 0);
    assert.include(h.outgoing[0], "1. One\n2. Two");
    h.projects.reverse();
    const reply = signed({
      ...original,
      action: "prompted",
      agentActivity: { content: { body: "2" } },
    });
    yield* service.receive(reply.body, reply.signature, "d2");
    yield* service.process("d2");
    assert.deepEqual(h.prepared, ["/repos/Two"]);
    const start = h.commands[1];
    assert.equal(start?.type, "thread.turn.start");
    if (start?.type === "thread.turn.start") {
      assert.include(start.message.text, "$linear-work DEL-1: A fix");
      assert.include(start.message.text, "get_issue and list_comments MCP tools");
      assert.include(start.message.text, original.guidance);
      assert.notInclude(start.message.text, original.promptContext);
      assert.notInclude(start.message.text, original.agentSession.comment.body);
    }
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory()), Effect.scoped);
});

it.effect("forwards follow-up replies without copying prompt context", () => {
  const h = harness();
  return Effect.gen(function* () {
    const service = yield* h.make;
    const first = signed(original);
    yield* service.receive(first.body, first.signature, "d1");
    yield* service.process("d1");
    for (const [id, body] of [
      ["reply", "Focus on the regression"],
      ["refresh", ""],
    ] as const) {
      const next = signed({
        ...original,
        action: "prompted",
        agentActivity: { id, content: { body } },
      });
      yield* service.receive(next.body, next.signature, id);
      yield* service.process(id);
      const start = h.commands.at(-1);
      assert.equal(start?.type, "thread.turn.start");
      if (start?.type === "thread.turn.start") {
        if (body) assert.equal(start.message.text, body);
        else assert.include(start.message.text, "get_issue and list_comments MCP tools");
        assert.notInclude(start.message.text, original.promptContext);
        assert.notInclude(start.message.text, original.agentSession.comment.body);
      }
    }
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory()), Effect.scoped);
});

it.effect("re-delegation resumes the same thread and stop prevents later prompts", () => {
  const h = harness();
  return Effect.gen(function* () {
    const service = yield* h.make;
    const first = signed(original);
    yield* service.receive(first.body, first.signature, "d1");
    yield* service.process("d1");
    const next = signed({
      ...original,
      agentSession: { ...original.agentSession, id: "session-2" },
      promptContext: "Please continue",
    });
    yield* service.receive(next.body, next.signature, "d2");
    yield* service.process("d2");
    assert.lengthOf(h.prepared, 1);
    assert.equal(h.commands[2]?.type, "thread.turn.start");
    const threadId = h.commands[0]?.type === "thread.create" ? h.commands[0].threadId : undefined;
    assert.ok(threadId);
    yield* service.stop(threadId!);
    const followup = signed({
      ...original,
      action: "prompted",
      agentSession: { ...original.agentSession, id: "session-2" },
      agentActivity: { id: "activity-1", content: { body: "Do more" } },
    });
    yield* service.receive(followup.body, followup.signature, "d3");
    yield* service.process("d3");
    assert.deepEqual(
      h.commands.map((c) => c.type),
      ["thread.create", "thread.turn.start", "thread.turn.start", "thread.turn.interrupt"],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory()), Effect.scoped);
});

it.effect("does not replay a signed event under a changed delivery header", () => {
  const h = harness();
  return Effect.gen(function* () {
    const service = yield* h.make;
    const first = signed(original);
    yield* service.receive(first.body, first.signature, "d1");
    yield* service.receive(first.body, first.signature, "different-header");
    const sql = yield* SqlClient.SqlClient;
    assert.lengthOf(yield* sql`SELECT * FROM linear_agent_deliveries`, 1);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory()), Effect.scoped);
});

it.effect(
  "routes a Linear reply to a pending provider question without starting another turn",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const service = yield* h.make;
      const first = signed(original);
      yield* service.receive(first.body, first.signature, "d1");
      yield* service.process("d1");
      const threadId = ThreadId.make("linear-session-1");
      yield* service.observe({
        type: "thread.activity-appended",
        sequence: 10,
        eventId: EventId.make("question-event"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-09-08T00:00:00.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          threadId,
          activity: {
            id: EventId.make("question"),
            kind: "user-input.requested",
            summary: "Choose the behavior",
            tone: "approval",
            turnId: null,
            createdAt: "2026-09-08T00:00:00.000Z",
            payload: {
              requestId: "request-1",
              questions: [
                {
                  id: "behavior",
                  header: "Behavior",
                  options: [
                    {
                      label: "Keep the old behavior",
                      description: "Preserve compatibility",
                      value: "keep",
                    },
                  ],
                  question: "Which behavior should I implement?",
                },
              ],
            },
          },
        },
      });
      yield* service.sendOutgoing("event:10:session-1");
      assert.include(h.outgoing[0], "Which behavior");
      const answer = signed({
        ...original,
        action: "prompted",
        agentActivity: { id: "a-1", content: { body: "Keep the old behavior" } },
      });
      yield* service.receive(answer.body, answer.signature, "d2");
      yield* service.process("d2");
      const command = h.commands[2];
      assert.equal(command?.type, "thread.user-input.respond");
      if (command?.type === "thread.user-input.respond")
        assert.deepEqual(command.answers, { behavior: "keep" });
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        pending_question: string | null;
      }>`SELECT pending_question FROM linear_agent_sessions`;
      assert.isNull(rows[0]?.pending_question);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory()), Effect.scoped);
  },
);

it.effect("refuses teams outside the allowlist before preparing a worktree", () => {
  const h = harness(false, ["OTHER"]);
  return Effect.gen(function* () {
    const service = yield* h.make;
    const first = signed(original);
    yield* service.receive(first.body, first.signature, "d1");
    assert.isTrue(yield* service.process("d1").pipe(Effect.isFailure));
    assert.lengthOf(h.prepared, 0);
    assert.lengthOf(h.commands, 0);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory()), Effect.scoped);
});
