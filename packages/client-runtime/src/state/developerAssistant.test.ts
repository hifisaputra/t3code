import { assert, it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId, ThreadId, type AssistantBoard } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import { getAssistantSetupState } from "./developerAssistant.ts";

const projectId = ProjectId.make("app");
const secondProjectId = ProjectId.make("another-app");
const emptyBoard: AssistantBoard = { projects: [], tasks: [], decisions: [] };
const configuredBoard: AssistantBoard = {
  ...emptyBoard,
  projects: [
    {
      threadId: ThreadId.make("assistant-app"),
      status: "stopped",
      error: null,
      config: {
        projectId,
        linearProjectId: "linear-app",
        assignedToMe: true,
        readyStates: [],
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "assistant-model" },
        workerModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "worker-model",
        },
        runtimeMode: "approval-required",
        baseBranch: "develop",
        instructions: "",
        stagingCheckCommand: "node scripts/check-staging.mjs",
        reviewState: "In Review",
        acceptedState: "Done",
        maxWorkerTurns: 6,
      },
    },
  ],
};

it.effect("enables setup after the first snapshot while the board subscription remains open", () =>
  Effect.gen(function* () {
    const updates = yield* Queue.unbounded<AssistantBoard>();
    const atom = Atom.make(Stream.fromQueue(updates));
    const registry = AtomRegistry.make();
    yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
    yield* AtomRegistry.mount(registry, atom);
    const readSetup = () =>
      getAssistantSetupState([projectId, secondProjectId], {
        data: Option.getOrNull(AsyncResult.value(registry.get(atom))),
        error: null,
      });

    assert.equal(readSetup().unavailableReason, "loading");
    yield* Queue.offer(updates, emptyBoard);
    yield* AtomRegistry.getResult(registry, atom);

    // This is the real stream state that previously kept the button disabled.
    assert.isTrue(registry.get(atom).waiting);
    assert.equal(readSetup().unavailableReason, null);
    assert.deepEqual(readSetup().availableProjectIds, [projectId, secondProjectId]);

    const preferences = configuredBoard.projects[0]!.config;
    yield* Queue.offer(updates, {
      ...emptyBoard,
      setups: [
        {
          preferences: {
            ...preferences,
            setupRuntimeMode: "approval-required",
            context: "Inspect staging",
          },
          threadId: ThreadId.make("assistant-setup-app"),
          proposal: null,
          summary: "",
          revision: 0,
        },
      ],
    });
    yield* AtomRegistry.toStreamResult(registry, atom).pipe(
      Stream.filter((board) => board.setups?.length === 1),
      Stream.runHead,
    );
    assert.deepEqual(readSetup().availableProjectIds, [secondProjectId]);

    // Cancelling an unfinished conversation makes the project available again.
    yield* Queue.offer(updates, emptyBoard);
    yield* AtomRegistry.toStreamResult(registry, atom).pipe(
      Stream.filter((board) => !board.setups?.length && !board.projects.length),
      Stream.runHead,
    );
    assert.deepEqual(readSetup().availableProjectIds, [projectId, secondProjectId]);

    yield* Queue.offer(updates, configuredBoard);
    yield* AtomRegistry.toStreamResult(registry, atom).pipe(
      Stream.filter((board) => board.projects.length === 1),
      Stream.runHead,
    );
    assert.isTrue(registry.get(atom).waiting);
    assert.equal(readSetup().unavailableReason, null);
    assert.deepEqual(readSetup().availableProjectIds, [secondProjectId]);
  }).pipe(Effect.scoped),
);

it("explains missing projects, existing assistants, and connection failures", () => {
  assert.equal(
    getAssistantSetupState([], { data: emptyBoard, error: null }).unavailableReason,
    "no-projects",
  );
  assert.equal(
    getAssistantSetupState([projectId], { data: configuredBoard, error: null }).unavailableReason,
    "all-configured",
  );
  assert.equal(
    getAssistantSetupState([projectId], { data: emptyBoard, error: "Disconnected" })
      .unavailableReason,
    "connection",
  );
});
