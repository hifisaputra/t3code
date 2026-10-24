import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as McpApprovalBroker from "../mcp/McpApprovalBroker.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as IntegrationApprovalReactor from "./IntegrationApprovalReactor.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("The provider never sees integration approvals"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerOrchestrator = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "integration-approval" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);
const layerTest = IntegrationApprovalReactor.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(layerOrchestrator, McpApprovalBroker.layer)),
);

const nextBrokerEvent = (broker: McpApprovalBroker.McpApprovalBroker["Service"]) =>
  Stream.runCollect(Stream.take(broker.streamEvents, 1)).pipe(
    Effect.map(([event]) => event as ProviderRuntimeEvent),
  );

const change = {
  summary: "Comment on DEL-123",
  record: { label: "DEL-123", url: "https://linear.app/t3/issue/DEL-123" },
  fields: [{ label: "Comment", value: "Shipped it." }],
};

it.effect(
  "shows a server tool's approval in the thread and answers the broker, not the provider",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const broker = yield* McpApprovalBroker.McpApprovalBroker;
        const reactor = yield* IntegrationApprovalReactor.IntegrationApprovalReactor;
        const threadId = ThreadId.make("thread:integration-approval");
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create-integration-approval"),
          threadId,
          projectId: ProjectId.make("project:integration-approval"),
          title: "Linear work",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });

        const decision = yield* Effect.forkScoped(
          broker.request({
            threadId,
            providerInstanceId: instanceId,
            provider: adapter.driver,
            sessionKey: `${threadId}:session`,
            appName: "Linear",
            detail: "Comment on DEL-123",
            change,
          }),
        );
        yield* reactor.handleBrokerEvent(yield* nextBrokerEvent(broker));

        const opened = yield* projections.getThreadProjection(threadId);
        const request = opened.runtimeRequests[0]!;
        assert.equal(request.kind, "integration");
        assert.equal(request.status, "pending");
        const item = opened.turnItems.find((candidate) => candidate.type === "approval_request");
        assert.deepInclude(item, {
          requestId: request.id,
          requestKind: "integration",
          prompt: "Comment on DEL-123",
          appName: "Linear",
          change,
          status: "waiting",
        });
        const shell = yield* projections.getThreadShell(threadId);
        assert.equal(shell?.pendingRuntimeRequest?.id, request.id);
        assert.equal(shell?.pendingRuntimeRequest?.kind, "integration");

        // No provider session exists: the answer still reaches the waiting tool.
        const answered = yield* orchestrator.dispatch({
          type: "runtime-request.respond",
          commandId: CommandId.make("approve-integration"),
          threadId,
          requestId: RuntimeRequestId.make(request.id),
          decision: "accept",
        });
        for (const stored of answered.storedEvents) {
          yield* reactor.handleDomainEvent(stored.event);
        }
        assert.equal(yield* Fiber.join(decision), "accept");

        // The broker's own settlement arrives after the answer and changes nothing.
        yield* reactor.handleBrokerEvent(yield* nextBrokerEvent(broker));
        const settled = yield* projections.getThreadProjection(threadId);
        assert.deepInclude(settled.runtimeRequests[0], { status: "resolved", decision: "accept" });
        assert.equal(
          settled.turnItems.find((candidate) => candidate.type === "approval_request")?.status,
          "completed",
        );
        assert.isNull((yield* projections.getThreadShell(threadId))?.pendingRuntimeRequest);
      }),
    ).pipe(Effect.provide(layerTest)),
);

it.effect("settles the card when the broker gives up on an unanswered approval", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const broker = yield* McpApprovalBroker.McpApprovalBroker;
      const reactor = yield* IntegrationApprovalReactor.IntegrationApprovalReactor;
      const threadId = ThreadId.make("thread:integration-approval-timeout");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-integration-approval-timeout"),
        threadId,
        projectId: ProjectId.make("project:integration-approval"),
        title: "Linear work",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });

      const decision = yield* Effect.forkScoped(
        broker.request({
          threadId,
          providerInstanceId: instanceId,
          provider: adapter.driver,
          sessionKey: `${threadId}:session`,
          appName: "Linear",
          detail: "Comment on DEL-123",
        }),
      );
      yield* reactor.handleBrokerEvent(yield* nextBrokerEvent(broker));
      yield* Fiber.interrupt(decision);
      yield* reactor.handleBrokerEvent(yield* nextBrokerEvent(broker));

      const settled = yield* projections.getThreadProjection(threadId);
      assert.deepInclude(settled.runtimeRequests[0], { status: "resolved", decision: "cancel" });
      assert.equal(
        settled.turnItems.find((candidate) => candidate.type === "approval_request")?.status,
        "cancelled",
      );
      assert.isNull((yield* projections.getThreadShell(threadId))?.pendingRuntimeRequest);
    }),
  ).pipe(Effect.provide(layerTest)),
);
