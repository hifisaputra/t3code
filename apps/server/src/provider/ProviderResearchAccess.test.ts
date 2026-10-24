import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import { getResearchAccess } from "./ProviderResearchAccess.ts";

const workerId = ProviderInstanceId.make("codex-research-worker");
const unprobedId = ProviderInstanceId.make("claude-research-worker");
const disabledId = ProviderInstanceId.make("codex-research-disabled");
const calls: Array<{ instanceId: ProviderInstanceId; cwd: string }> = [];

const makeInstance = (
  instanceId: ProviderInstanceId,
  input: { readonly enabled: boolean; readonly probe: boolean },
): ProviderInstance => {
  const driverKind = ProviderDriverKind.make(input.probe ? "codex" : "claudeAgent");
  return {
    instanceId,
    driverKind,
    continuationIdentity: { driverKind, continuationKey: `test:${instanceId}` },
    displayName: String(instanceId),
    enabled: input.enabled,
    snapshot: {} as ProviderInstance["snapshot"],
    orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
    textGeneration: {} as ProviderInstance["textGeneration"],
    ...(input.probe
      ? {
          researchAccess: (cwd: string) =>
            Effect.sync(() => {
              calls.push({ instanceId, cwd });
              return `Web configuration for ${instanceId} at ${cwd}`;
            }),
        }
      : {}),
  };
};

const instances = [
  makeInstance(workerId, { enabled: true, probe: true }),
  makeInstance(unprobedId, { enabled: true, probe: false }),
  makeInstance(disabledId, { enabled: false, probe: true }),
];

const layer = Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
  getInstance: (instanceId) =>
    Effect.succeed(instances.find((instance) => instance.instanceId === instanceId)),
  listInstances: Effect.succeed(instances),
  listUnavailable: Effect.succeed([]),
  streamChanges: Stream.empty,
  subscribeChanges: Effect.never,
});

it.layer(layer)("getResearchAccess", (it) => {
  it.effect("probes the selected instance in the task worktree", () =>
    Effect.gen(function* () {
      calls.length = 0;
      const result = yield* getResearchAccess(workerId, "/worktrees/research");
      assert.equal(result, `Web configuration for ${workerId} at /worktrees/research`);
      assert.deepEqual(calls, [{ instanceId: workerId, cwd: "/worktrees/research" }]);
    }),
  );

  it.effect("reports unprobed, disabled and unknown instances without assuming web access", () =>
    Effect.gen(function* () {
      calls.length = 0;
      assert.include(
        yield* getResearchAccess(unprobedId, "/worktrees/research"),
        "Native web access is unverified",
      );
      assert.include(yield* getResearchAccess(disabledId, "/worktrees/research"), "is disabled");
      assert.include(
        yield* getResearchAccess(ProviderInstanceId.make("missing"), "/worktrees/research"),
        "cannot be checked",
      );
      assert.deepEqual(calls, []);
    }),
  );
});
