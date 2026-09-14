import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  DeveloperAssistantError,
  OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type AssistantProjectConfig,
  type AssistantSetupInput,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import { LinearApi } from "../linear/LinearApi.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as Settings from "../serverSettings.ts";
import Migration from "../persistence/Migrations/052_DeveloperAssistant.ts";
import SetupMigration from "../persistence/Migrations/053_AssistantSetup.ts";
import { StagingVerifier } from "./StagingVerifier.ts";
import { isValidBranchName, makeSetup, validateDeploymentConfig } from "./AssistantSetup.ts";

describe("isValidBranchName", () => {
  it("accepts the names people actually use", () => {
    for (const branch of ["main", "develop", "release/2026.09", "feature/a.b-c_d"])
      expect(isValidBranchName(branch), branch).toBe(true);
  });

  it("refuses names git would read as an option or reject outright", () => {
    for (const branch of [
      "--upload-pack=touch /tmp/pwned",
      "-q",
      "",
      "release/../main",
      "has space",
      "has\ttab",
      "wip~1",
      "wip^",
      "refs:main",
      "glob*",
      "question?",
      "bracket[1]",
      "back\\slash",
      "trailing/",
      "/leading",
      "main.lock",
      "release/.hidden",
      "trailing.",
      "@",
      "main@{1}",
    ])
      expect(isValidBranchName(branch), branch).toBe(false);
  });
});

describe("validateDeploymentConfig", () => {
  const config: AssistantProjectConfig = {
    projectId: ProjectId.make("project"),
    linearProjectId: "linear",
    assignedToMe: true,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
    workerModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
    runtimeMode: "full-access",
    baseBranch: "develop",
    readyStates: [],
    instructions: "",
    stagingCheckCommand: "",
    stagingUrl: "https://staging.example.test",
    deploymentTargets: [
      {
        kind: "github-actions" as const,
        id: "web",
        repository: "owner/app",
        workflow: "deploy.yml",
      },
    ],
    reviewState: "In Review",
    acceptedState: "Done",
    maxWorkerTurns: 6,
  };

  it("passes a setup a person could save", () => {
    expect(validateDeploymentConfig(config)).toBeNull();
  });

  it("refuses a base branch that would change what a git command means", () => {
    const error = validateDeploymentConfig({
      ...config,
      baseBranch: "--upload-pack=touch /tmp/pwned",
    });
    expect(error?.detail).toContain("is not a usable branch name");
  });
});

const timestamp = "2026-09-12T00:00:00.000Z";
const isAssistantError = Schema.is(DeveloperAssistantError);
const decodeThread = Schema.decodeUnknownSync(OrchestrationThreadShell);
const project = {
  id: ProjectId.make("project"),
  title: "Next app",
  workspaceRoot: "/repos/app",
  defaultModelSelection: null,
  scripts: [],
  createdAt: timestamp,
  updatedAt: timestamp,
};
const preferences: AssistantSetupInput = {
  projectId: project.id,
  linearProjectId: "linear-project",
  assignedToMe: true,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "assistant-model" },
  workerModelSelection: {
    instanceId: ProviderInstanceId.make("claudeCode"),
    model: "worker-model",
  },
  runtimeMode: "approval-required",
  setupRuntimeMode: "approval-required",
  context: "Inspect the existing staging deployment.",
};
const plan = {
  baseBranch: "develop",
  readyStates: [],
  instructions: "Use the staging database.",
  stagingCheckCommand: "",
  stagingUrl: "https://staging.example.test",
  deploymentTargets: [
    { kind: "github-actions" as const, id: "web", repository: "owner/app", workflow: "deploy.yml" },
  ],
  reviewState: "In Review",
  acceptedState: "Done",
  maxWorkerTurns: 6,
};

const harness = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE orchestration_events (sequence INTEGER)`;
  yield* Migration;
  yield* SetupMigration;
  const commands: OrchestrationCommand[] = [];
  const seen = new Set<string>();
  const threads = new Map<ThreadId, OrchestrationThreadShell>();
  const busy = new Set<ThreadId>();
  const dependencies = Layer.mergeAll(
    Settings.layerTest({ linear: { agentAccess: true, apiKey: "test-key" } }),
    Layer.mock(StagingVerifier)({ repositoryKey: () => Effect.succeed("/repos/app/.git") }),
    Layer.mock(LinearApi)({
      status: Effect.succeed({
        status: "connected",
        viewer: { id: "me", name: "Me", displayName: "Me" },
        workspace: { id: "workspace", name: "Workspace", urlKey: "workspace" },
      }),
    }),
    Layer.mock(ProjectionSnapshotQuery)({
      getProjectShellById: () => Effect.succeed(Option.some(project)),
      getThreadShellById: (id) => Effect.succeed(Option.fromNullishOr(threads.get(id))),
    }),
    Layer.mock(OrchestrationEngineService)({
      dispatch: (command) =>
        Effect.sync(() => {
          if (!seen.has(command.commandId)) {
            seen.add(command.commandId);
            commands.push(command);
            if (command.type === "thread.create")
              threads.set(
                command.threadId,
                decodeThread({
                  ...command,
                  id: command.threadId,
                  updatedAt: timestamp,
                  latestTurn: null,
                  session: null,
                  latestUserMessageAt: null,
                  hasPendingApprovals: false,
                  hasPendingUserInput: false,
                  hasActionableProposedPlan: false,
                }),
              );
          }
          return { sequence: commands.length };
        }),
    }),
  );
  const setup = yield* makeSetup({
    changed: Effect.void,
    threadBusy: (thread) => Effect.succeed(busy.has(thread.id)),
    configure: () => Effect.void,
  }).pipe(Effect.provide(dependencies));
  const starts = () => commands.filter((c) => c.type === "thread.turn.start");
  return { setup, busy, starts };
});
const database = NodeSqliteClient.layerMemory;

it.effect("a reopened setup takes the person's new choices and says what changed", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const first = yield* h.setup.begin(preferences);
    yield* h.setup.propose(first.threadId, plan, "Deploy through GitHub Actions.");
    const revised = yield* h.setup.begin({
      ...preferences,
      linearProjectId: "other-linear-project",
      context: "Use the new staging project instead.",
    });
    assert.equal(revised.threadId, first.threadId);
    assert.equal(revised.preferences.linearProjectId, "other-linear-project");
    assert.equal(revised.preferences.context, "Use the new staging project instead.");
    // The proposal was written from the old brief, so it cannot be saved as this one.
    assert.isNull(revised.proposal);
    assert.isAbove(revised.revision, first.revision);
    const starts = h.starts();
    assert.lengthOf(starts, 2);
    assert.include(
      starts[1]?.type === "thread.turn.start" ? starts[1].message.text : "",
      "Use the new staging project instead.",
    );
    // Reopening without changing anything still reuses the running turn.
    yield* h.setup.begin({
      ...preferences,
      linearProjectId: "other-linear-project",
      context: "Use the new staging project instead.",
    });
    assert.lengthOf(h.starts(), 2);
  }).pipe(Effect.provide(database()), Effect.scoped),
);

it.effect("refuses to rewrite the brief under a turn that is still running", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const draft = yield* h.setup.begin(preferences);
    h.busy.add(draft.threadId);
    const error = yield* h.setup
      .begin({ ...preferences, context: "Changed my mind." })
      .pipe(Effect.flip);
    assert.isTrue(isAssistantError(error));
    assert.include(isAssistantError(error) ? error.detail : "", "before changing its brief");
    // An unchanged reopen is not a rewrite, so it still resumes the conversation.
    assert.equal((yield* h.setup.begin(preferences)).threadId, draft.threadId);
  }).pipe(Effect.provide(database()), Effect.scoped),
);
