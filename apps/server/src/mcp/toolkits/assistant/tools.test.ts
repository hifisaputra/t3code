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
  type AssistantTask,
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

it.effect("waiting answers the agent with text instead of an internal error", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const layer = McpServer.toolkit(AssistantToolkit).pipe(
      Layer.provide(AssistantToolkitHandlers),
      Layer.provideMerge(
        Layer.mock(DeveloperAssistant)({
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
      // The retired assistant chat's tools are gone.
      const tools = Object.keys(AssistantToolkit.tools);
      for (const removed of [
        "assistant_pause",
        "assistant_get_board",
        "assistant_dispatch_issue",
        "assistant_answer_decision",
      ])
        assert.notInclude(tools, removed);
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
      assert.deepEqual(calls, ["wait"]);
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

const managedTask = {
  id: "task",
  projectId: ProjectId.make("project"),
  issue: {
    id: "issue",
    identifier: "APP-1",
    title: "Issue 1",
    url: "https://linear.app/test/issue/APP-1",
    branchName: "app-1",
    priority: 3,
    state: { id: "todo", name: "Todo", type: "unstarted" as const, position: 0, color: "#fff" },
    team: { id: "team", key: "APP", name: "App" },
    assignee: null,
    project: null,
    cycle: null,
    updatedAt: "2026-09-15T00:00:00.000Z",
  },
  threadId: ThreadId.make("assistant-work-task"),
  status: "working" as const,
  brief: "",
  summary: "",
  reviewInstructions: "",
  feedback: "",
  turns: 1,
  turnLimit: 6,
  deployment: null,
  error: null,
  createdAt: "2026-09-15T00:00:00.000Z",
  updatedAt: "2026-09-15T00:00:00.000Z",
} satisfies AssistantTask;

it.effect("carries acceptance criteria, per-criterion checks and the deploy note", () =>
  Effect.gen(function* () {
    const taken: Array<ReadonlyArray<string>> = [];
    const reported: Array<unknown> = [];
    const layer = McpServer.toolkit(AssistantToolkit).pipe(
      Layer.provide(AssistantToolkitHandlers),
      Layer.provideMerge(
        Layer.mock(DeveloperAssistant)({
          acceptIssue: (_caller, _brief, criteria) =>
            Effect.sync(() => {
              taken.push(criteria);
              return { ...managedTask, criteria };
            }),
          submitE2e: (_caller, input) =>
            Effect.sync(() => {
              reported.push(input);
              return managedTask;
            }),
          verifyStaging: () =>
            Effect.succeed({
              task: {
                ...managedTask,
                deployWait: {
                  targetIds: ["web"],
                  commit: "b".repeat(40),
                  since: "2026-09-15T00:00:00.000Z",
                  checks: 1,
                  detail: "web is still building.",
                },
              },
              outcome: "watching" as const,
            }),
        }),
      ),
      Layer.provideMerge(McpServer.McpServer.layer),
    );
    yield* Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const call = (input: { name: string; arguments: Record<string, unknown> }) =>
        server.callTool(input).pipe(Effect.provideService(McpInvocationContext, invocation));
      const missing = yield* call({
        name: "assistant_accept_issue",
        arguments: { brief: "Fix it" },
      }).pipe(Effect.flip);
      assert.equal(missing._tag, "InvalidParams");
      const empty = yield* call({
        name: "assistant_accept_issue",
        arguments: { brief: "Fix it", criteria: [] },
      }).pipe(Effect.flip);
      assert.equal(empty._tag, "InvalidParams");
      const accepted = yield* call({
        name: "assistant_accept_issue",
        arguments: { brief: "Fix it", criteria: [" The page loads ", "The email arrives"] },
      });
      assert.isFalse(accepted.isError);
      assert.deepEqual(taken, [["The page loads", "The email arrives"]]);

      const submitted = yield* call({
        name: "assistant_submit_e2e",
        arguments: {
          report: "The email never arrived.",
          humanChecks: [],
          worthALook: ["  The footer says Read more. ", "   "],
          screenshots: [{ path: "/evidence/task/page.png", caption: "The page" }],
          checks: [
            { criterion: 1, result: "passed", evidence: "Loaded", screenshot: 1 },
            { criterion: 2, result: "failed", evidence: "No email" },
          ],
        },
      });
      assert.isFalse(submitted.isError);
      // The verdict is T3's to derive, so the tester need not send one.
      assert.deepEqual(reported, [
        {
          checks: [
            { criterion: 1, result: "passed", evidence: "Loaded", screenshot: 1 },
            { criterion: 2, result: "failed", evidence: "No email" },
          ],
          report: "The email never arrived.",
          humanChecks: [],
          worthALook: ["The footer says Read more."],
          screenshots: [{ path: "/evidence/task/page.png", caption: "The page" }],
        },
      ]);
      const bad = yield* call({
        name: "assistant_submit_e2e",
        arguments: {
          report: "Report",
          humanChecks: [],
          screenshots: [],
          checks: [{ criterion: 0, result: "passed", evidence: "" }],
        },
      }).pipe(Effect.flip);
      assert.equal(bad._tag, "InvalidParams");

      const watching = yield* call({ name: "assistant_verify_staging", arguments: {} });
      assert.isFalse(watching.isError);
      const note = watching.content[0];
      assert.include(
        note?.type === "text" ? note.text : "",
        "Staging is still deploying: web is still building.",
      );
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
