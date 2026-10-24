import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
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
  openSession: () => Effect.die("No provider process needed for metadata"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "linked-issue" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const linkedIssue = {
  provider: "linear",
  id: "issue-uuid",
  identifier: "DEL-123",
  url: "https://linear.app/t3/issue/DEL-123/do-the-thing",
} as const;

it.effect("links an issue at creation, keeps it across updates, and unlinks it with null", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:linked-issue");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-linked-issue"),
      threadId,
      projectId: ProjectId.make("project:linked-issue"),
      title: "DEL-123",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      linkedIssue,
      createdBy: "user",
      creationSource: "web",
    });
    assert.deepEqual((yield* projections.getThread(threadId)).linkedIssue, linkedIssue);
    assert.deepEqual((yield* projections.getThreadShell(threadId))?.linkedIssue, linkedIssue);

    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("rename-linked-issue"),
      threadId,
      title: "Renamed",
    });
    const renamed = yield* projections.getThreadShell(threadId);
    assert.equal(renamed?.title, "Renamed");
    assert.deepEqual(renamed?.linkedIssue, linkedIssue);

    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("unlink-issue"),
      threadId,
      linkedIssue: null,
    });
    assert.isNull((yield* projections.getThreadShell(threadId))?.linkedIssue);
    const snapshot = yield* projections.getShellSnapshot();
    assert.isNull(snapshot.threads.find((thread) => thread.id === threadId)?.linkedIssue);

    const relinked = { ...linkedIssue, identifier: "DEL-124" };
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("relink-issue"),
      threadId,
      linkedIssue: relinked,
    });
    assert.deepEqual((yield* projections.getThreadShell(threadId))?.linkedIssue, relinked);
  }).pipe(Effect.provide(layerTest)),
);
