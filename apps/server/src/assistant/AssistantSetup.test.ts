import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  AssistantProjectConfig,
  AssistantTask,
  DeveloperAssistantError,
  OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
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
import { isValidBranchName, makeSetup, validateSetupPlan } from "./AssistantSetup.ts";

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

describe("validateSetupPlan", () => {
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
    expect(validateSetupPlan(config)).toBeNull();
  });

  it("refuses a base branch that would change what a git command means", () => {
    const error = validateSetupPlan({
      ...config,
      baseBranch: "--upload-pack=touch /tmp/pwned",
    });
    expect(error?.detail).toContain("is not a usable branch name");
  });

  it("refuses a shared policy over its budget once sections are written", () => {
    const error = validateSetupPlan({
      ...config,
      instructions: "x".repeat(4001),
      roleInstructions: { lead: "Take the issues labelled ready." },
    });
    expect(error?.detail).toContain("The shared policy is 4,001 characters");
    expect(error?.detail).toContain("its budget is 4,000 once role sections are present");
  });

  it("refuses a section over its own budget", () => {
    const error = validateSetupPlan({ ...config, roleInstructions: { e2e: "x".repeat(6001) } });
    expect(error?.detail).toContain("The e2e section is 6,001 characters");
    expect(error?.detail).toContain("its budget is 6,000");
  });

  it("passes sections that fit", () => {
    expect(
      validateSetupPlan({
        ...config,
        instructions: "x".repeat(4000),
        roleInstructions: { lead: "x".repeat(6000), e2e: "x".repeat(6000) },
      }),
    ).toBeNull();
  });

  it("leaves a setup without sections on the old single-string limit", () => {
    expect(validateSetupPlan({ ...config, instructions: "x".repeat(19000) })).toBeNull();
    expect(validateSetupPlan({ ...config, instructions: "x".repeat(20001) })?.detail).toContain(
      "the budget is 20,000",
    );
  });
});

const timestamp = "2026-09-12T00:00:00.000Z";
const isAssistantError = Schema.is(DeveloperAssistantError);
const encodeConfig = Schema.encodeSync(Schema.fromJsonString(AssistantProjectConfig));
const encodeTask = Schema.encodeSync(Schema.fromJsonString(AssistantTask));
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

/** The config a saved proposal becomes, for the rows a revision reads back. */
const saved: AssistantProjectConfig = {
  ...plan,
  projectId: project.id,
  linearProjectId: preferences.linearProjectId,
  assignedToMe: preferences.assignedToMe,
  modelSelection: preferences.modelSelection,
  workerModelSelection: preferences.workerModelSelection,
  runtimeMode: preferences.runtimeMode,
};
const partialTask = (number: number, humanChecks: ReadonlyArray<string>): AssistantTask => ({
  id: `task-${number}`,
  projectId: project.id,
  issue: {
    id: `issue-${number}`,
    identifier: `APP-${number}`,
    title: `Issue ${number}`,
    url: `https://linear.app/test/issue/APP-${number}`,
    branchName: `app-${number}`,
    priority: 3,
    updatedAt: timestamp,
    state: { id: "done", name: "Done", type: "completed", position: 0, color: "#fff" },
    team: { id: "team", key: "APP", name: "App" },
    assignee: null,
    project: null,
    cycle: null,
  },
  threadId: ThreadId.make(`assistant-work-task-${number}`),
  status: "review",
  brief: "",
  summary: "",
  reviewInstructions: "",
  feedback: "",
  turns: 1,
  turnLimit: 6,
  deployment: null,
  error: null,
  createdAt: timestamp,
  updatedAt: `2026-09-1${number}T00:00:00.000Z`,
  e2e: {
    verdict: "partial",
    report: "Checked what staging allowed.",
    humanChecks,
    screenshots: [],
    at: timestamp,
  },
});

const harness = (options?: { workspaceRoot?: string; claudeHome?: string }) =>
  Effect.gen(function* () {
    const shell = options?.workspaceRoot
      ? { ...project, workspaceRoot: options.workspaceRoot }
      : project;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE orchestration_events (sequence INTEGER)`;
    yield* Migration;
    yield* SetupMigration;
    const commands: OrchestrationCommand[] = [];
    const seen = new Set<string>();
    const threads = new Map<ThreadId, OrchestrationThreadShell>();
    const busy = new Set<ThreadId>();
    const dependencies = Layer.mergeAll(
      Settings.layerTest({
        linear: { agentAccess: true, apiKey: "test-key" },
        ...(options?.claudeHome
          ? { providers: { claudeAgent: { homePath: options.claudeHome } } }
          : {}),
      }),
      Layer.mock(StagingVerifier)({ repositoryKey: () => Effect.succeed("/repos/app/.git") }),
      Layer.mock(LinearApi)({
        status: Effect.succeed({
          status: "connected",
          viewer: { id: "me", name: "Me", displayName: "Me" },
          workspace: { id: "workspace", name: "Workspace", urlKey: "workspace" },
        }),
      }),
      Layer.mock(ProjectionSnapshotQuery)({
        getProjectShellById: () => Effect.succeed(Option.some(shell)),
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
    const h = yield* harness();
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
    const h = yield* harness();
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

it.effect("takes a role skill the repository carries and refuses one it does not", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const temp = yield* fs.makeTempDirectoryScoped({ prefix: "t3-assistant-setup-" });
    const workspace = path.join(temp, "workspace");
    yield* fs.makeDirectory(path.join(workspace, ".claude", "skills", "app-e2e"), {
      recursive: true,
    });
    yield* fs.writeFileString(
      path.join(workspace, ".claude", "skills", "app-e2e", "SKILL.md"),
      "---\nname: app-e2e\ndescription: Exercise the app on staging.\n---\n\n# Run it\n",
    );
    const h = yield* harness({ workspaceRoot: workspace, claudeHome: path.join(temp, "claude") });
    const draft = yield* h.setup.begin(preferences);
    // The setup conversation is told which skills the repository has.
    assert.include((yield* h.setup.read(draft.threadId)).instructions, "app-e2e (Exercise the app");
    const proposed = yield* h.setup.propose(
      draft.threadId,
      { ...plan, roleSkills: { e2e: "app-e2e" } },
      "The tester follows the repository's own skill.",
    );
    assert.equal(proposed.proposal?.roleSkills?.e2e, "app-e2e");
    const error = yield* h.setup
      .propose(
        draft.threadId,
        { ...plan, roleSkills: { review: "my-review-method" } },
        "A skill that only exists on one machine.",
      )
      .pipe(Effect.flip);
    assert.include(
      isAssistantError(error) ? error.detail : "",
      '"my-review-method" is not a skill in this repository\'s .claude/skills (found: app-e2e)',
    );
  }).pipe(Effect.provide(Layer.mergeAll(database(), NodeServices.layer)), Effect.scoped),
);

it.effect("shows a revision what recent deliveries left for a person to check", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const h = yield* harness();
    const draft = yield* h.setup.begin(preferences);
    yield* sql`INSERT INTO assistant_projects (project_id, repository_key, thread_id, config)
      VALUES (${project.id}, ${"/repos/app/.git"}, ${"assistant-coordinator"}, ${encodeConfig(saved)})`;
    // Nothing is appended before the project has delivered anything partial.
    assert.notInclude(
      (yield* h.setup.read(draft.threadId)).instructions,
      "Human checks from recent deliveries",
    );
    for (const task of [
      partialTask(1, ["Check the invoice PDF on staging."]),
      partialTask(2, ["Check the welcome email arrives."]),
    ])
      yield* sql`INSERT INTO assistant_tasks (id, project_id, issue_id, thread_id, status, data)
        VALUES (${task.id}, ${task.projectId}, ${task.issue.id}, ${task.threadId}, ${task.status}, ${encodeTask(task)})`;
    const instructions = (yield* h.setup.read(draft.threadId)).instructions;
    assert.include(instructions, "Human checks from recent deliveries:");
    assert.include(instructions, "- Check the invoice PDF on staging.");
    assert.include(instructions, "- Check the welcome email arrives.");
    // Newest first, so the setup reads the latest delivery's checks at the top.
    assert.isBelow(instructions.indexOf("APP-2:"), instructions.indexOf("APP-1:"));
  }).pipe(Effect.provide(database()), Effect.scoped),
);
