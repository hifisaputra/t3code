import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/unstable/ai";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type AssistantSetup,
} from "@t3tools/contracts";
import { DeveloperAssistant } from "../../../assistant/DeveloperAssistant.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { AssistantToolkit, AssistantToolkitHandlers } from "./tools.ts";

it.effect(
  "serves setup tools through MCP with the authenticated thread and validates proposals",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("assistant-setup-test");
      const draft: AssistantSetup = {
        threadId,
        revision: 0,
        summary: "",
        proposal: null,
        preferences: {
          projectId: ProjectId.make("project"),
          linearProjectId: "linear",
          assignedToMe: true,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
          workerModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
          runtimeMode: "approval-required",
          setupRuntimeMode: "approval-required",
          context: "Existing staging",
        },
      };
      const callers: ThreadId[] = [];
      const layer = McpServer.toolkit(AssistantToolkit).pipe(
        Layer.provide(AssistantToolkitHandlers),
        Layer.provideMerge(
          Layer.mock(DeveloperAssistant)({
            getSetup: (caller) =>
              Effect.sync(() => {
                callers.push(caller);
                return { setup: draft, instructions: "Inspect the existing deployment." };
              }),
            proposeSetup: (caller, plan, summary) =>
              Effect.sync(() => {
                callers.push(caller);
                return {
                  ...draft,
                  revision: 1,
                  summary,
                  proposal: { ...plan, ...draft.preferences },
                };
              }),
          }),
        ),
        Layer.provideMerge(McpServer.McpServer.layer),
      );
      yield* Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const call = (
          input: { name: string; arguments: Record<string, unknown> },
          capabilities: ReadonlySet<"linear" | "preview"> = invocation.capabilities,
        ) =>
          server
            .callTool(input)
            .pipe(Effect.provideService(McpInvocationContext, { ...invocation, capabilities }));
        const brief = yield* call({ name: "assistant_get_setup", arguments: {} });
        assert.isFalse(brief.isError);
        assert.deepEqual(callers, [threadId]);
        const invalid = yield* call({
          name: "assistant_propose_setup",
          arguments: { plan: { baseBranch: "develop" }, summary: "Missing setup" },
        }).pipe(Effect.flip);
        assert.equal(invalid._tag, "InvalidParams");
        assert.lengthOf(callers, 1);
        const proposed = yield* call({
          name: "assistant_propose_setup",
          arguments: {
            plan: {
              baseBranch: "develop",
              readyStates: [],
              instructions: "Verify staging",
              stagingCheckCommand: "",
              stagingUrl: "https://staging.example.test",
              deploymentTargets: [
                {
                  kind: "github-actions",
                  id: "web",
                  repository: "owner/app",
                  workflow: "deploy.yml",
                },
              ],
              reviewState: "In Review",
              acceptedState: "Done",
              maxWorkerTurns: 6,
            },
            summary: "Uses the existing staging workflow",
          },
        });
        assert.isFalse(proposed.isError);
        assert.lengthOf(callers, 2);
        const denied = yield* call({ name: "assistant_get_setup", arguments: {} }, new Set());
        assert.isTrue(denied.isError);
        assert.lengthOf(callers, 2);
      }).pipe(
        Effect.provide(layer),
        Effect.provideService(
          McpSchema.McpServerClient,
          McpSchema.McpServerClient.of({
            clientId: 1,
            protocolVersion: "2025-06-18",
            initializePayload: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "assistant-test", version: "1" },
            },
            getClient: Effect.die("unused"),
          }),
        ),
      );
    }).pipe(Effect.scoped),
);

it.effect("pausing and waiting answer the agent with text instead of an internal error", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const layer = McpServer.toolkit(AssistantToolkit).pipe(
      Layer.provide(AssistantToolkitHandlers),
      Layer.provideMerge(
        Layer.mock(DeveloperAssistant)({
          pause: () => Effect.sync(() => void calls.push("pause")),
          waitForExternal: () =>
            Effect.sync(() => {
              calls.push("wait");
              return { outcome: "waiting" as const };
            }),
        }),
      ),
      Layer.provideMerge(McpServer.McpServer.layer),
    );
    yield* Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const call = (input: { name: string; arguments: Record<string, unknown> }) =>
        server.callTool(input).pipe(Effect.provideService(McpInvocationContext, invocation));
      const paused = yield* call({ name: "assistant_pause", arguments: {} });
      assert.isFalse(paused.isError);
      const text = paused.content[0];
      assert.include(text?.type === "text" ? text.text : "", "Paused");
      const waiting = yield* call({
        name: "assistant_wait",
        arguments: { reason: "Staging deploy is running" },
      });
      assert.isFalse(waiting.isError);
      const waitText = waiting.content[0];
      assert.include(
        waitText?.type === "text" ? waitText.text : "",
        "T3 checks back in about a minute",
      );
      assert.deepEqual(calls, ["pause", "wait"]);
    }).pipe(
      Effect.provide(layer),
      Effect.provideService(
        McpSchema.McpServerClient,
        McpSchema.McpServerClient.of({
          clientId: 1,
          protocolVersion: "2025-06-18",
          initializePayload: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "assistant-test", version: "1" },
          },
          getClient: Effect.die("unused"),
        }),
      ),
    );
  }).pipe(Effect.scoped),
);

const invocation = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("assistant-setup-test"),
  providerSessionId: "session",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["linear"] as const),
  issuedAt: 1,
};
