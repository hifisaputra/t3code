import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  GitCommandError,
  LinearIssueNotFoundError,
  LinearOperationError,
  ProjectId,
  type LinearBranchNaming,
  type LinearIssueDetail,
  type LinearRepositoryMapping,
  type LinearWorkflowState,
  type T3ProjectFile,
} from "@t3tools/contracts";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as LinearApi from "./LinearApi.ts";
import * as LinearThreadService from "./LinearThreadService.ts";

const TODO_STATE: LinearWorkflowState = {
  id: "state-todo",
  name: "Todo",
  type: "unstarted",
  color: "#e2e2e2",
  position: 0,
};

const IN_PROGRESS_STATE: LinearWorkflowState = {
  id: "state-in-progress",
  name: "In Progress",
  type: "started",
  color: "#f2c94c",
  position: 1,
};

const IN_REVIEW_STATE: LinearWorkflowState = {
  id: "state-in-review",
  name: "In Review",
  type: "started",
  color: "#5e6ad2",
  // Deliberately listed before In Progress: the lowest position wins, not the order.
  position: 2,
};

const TEAM_STATES: ReadonlyArray<LinearWorkflowState> = [
  IN_REVIEW_STATE,
  { id: "state-done", name: "Done", type: "completed", color: "#0f0", position: 0 },
  IN_PROGRESS_STATE,
  TODO_STATE,
];

function makeIssue(
  state: LinearWorkflowState,
  labels: LinearIssueDetail["labels"] = [],
): LinearIssueDetail {
  return {
    id: "issue-uuid",
    identifier: "DEL-123",
    title: "Wire up Linear",
    url: "https://linear.app/acme/issue/DEL-123",
    branchName: "ada/del-123-wire-up-linear",
    priority: 2,
    updatedAt: "2026-09-01T10:00:00.000Z",
    state,
    team: { id: "team-1", key: "DEL", name: "Delivery" },
    assignee: null,
    description: null,
    comments: [],
    parent: null,
    children: [],
    labels,
    project: null,
    cycle: null,
  };
}

interface PreparedBranchCall {
  readonly cwd: string;
  readonly branch: string;
  readonly baseBranch: string | null;
  readonly mode: "local" | "worktree";
}

function makeHarness(input?: {
  readonly issue?: LinearIssueDetail;
  readonly getIssueError?: LinearIssueNotFoundError;
  readonly updateIssueStateFails?: boolean;
  readonly moveToStartedOnThreadStart?: boolean;
  readonly projectFile?: T3ProjectFile;
  readonly linearRepositories?: ReadonlyArray<LinearRepositoryMapping>;
  readonly linearBranchNaming?: Partial<LinearBranchNaming>;
  /** What the checkout is on, for the branch mode that stays on it. */
  readonly checkoutBranch?: string | null;
  readonly localStatusFails?: boolean;
}) {
  const gitCalls: PreparedBranchCall[] = [];
  const statusCwds: string[] = [];
  const movedStateIds: string[] = [];

  const linearLayer = Layer.mock(LinearApi.LinearApi)({
    getIssue: () =>
      input?.getIssueError
        ? Effect.fail(input.getIssueError)
        : Effect.succeed(input?.issue ?? makeIssue(TODO_STATE)),
    workflowStates: () => Effect.succeed(TEAM_STATES),
    updateIssueState: ({ stateId }) => {
      if (input?.updateIssueStateFails) {
        return Effect.fail(
          new LinearOperationError({
            operation: "updateIssueState",
            detail: "Linear refused to move the issue to that state.",
          }),
        );
      }
      movedStateIds.push(stateId);
      return Effect.void;
    },
  });

  const gitLayer = Layer.mock(GitWorkflowService.GitWorkflowService)({
    localStatus: (statusInput) => {
      statusCwds.push(statusInput.cwd);
      if (input?.localStatusFails) {
        return Effect.fail(
          new GitCommandError({
            operation: "localStatus",
            command: "git status",
            cwd: statusInput.cwd,
            exitCode: 128,
            detail: "fatal: not a git repository",
          }),
        );
      }
      return Effect.succeed({
        isRepo: true,
        hasPrimaryRemote: true,
        isDefaultRef: false,
        refName: input?.checkoutBranch === undefined ? "release/24.3" : input.checkoutBranch,
        hasWorkingTreeChanges: false,
        workingTree: { files: [], insertions: 0, deletions: 0 },
      });
    },
    prepareBranchThread: (branchInput) =>
      Effect.sync(() => {
        gitCalls.push({
          cwd: branchInput.cwd,
          branch: branchInput.branch,
          baseBranch: branchInput.baseBranch,
          mode: branchInput.mode,
        });
        return {
          branch: branchInput.branch,
          worktreePath: "/tmp/worktrees/del-123",
          baseBranch: branchInput.baseBranch ?? "main",
          reusedExistingBranch: false,
        };
      }),
  });

  const projectFileLayer = Layer.succeed(
    T3ProjectFileLoader.T3ProjectFileLoader,
    T3ProjectFileLoader.T3ProjectFileLoader.of({
      load: () =>
        Effect.succeed(
          input?.projectFile === undefined ? Option.none() : Option.some(input.projectFile),
        ),
    }),
  );

  const layer = LinearThreadService.layer.pipe(
    Layer.provide(linearLayer),
    Layer.provide(gitLayer),
    Layer.provide(projectFileLayer),
    Layer.provide(
      ServerSettings.layerTest({
        linear: {
          moveToStartedOnThreadStart: input?.moveToStartedOnThreadStart ?? true,
          ...(input?.linearRepositories ? { repositories: input.linearRepositories } : {}),
          ...(input?.linearBranchNaming ? { branchNaming: input.linearBranchNaming } : {}),
        },
      }),
    ),
  );

  return { layer, gitCalls, statusCwds, movedStateIds };
}

const input = {
  cwd: "/repos/t3code",
  reference: "DEL-123",
  mode: "worktree",
} as const;

it.effect("checks out the issue's own branch and moves the issue to In Progress", () => {
  const { layer, gitCalls, movedStateIds } = makeHarness();

  return Effect.gen(function* () {
    const service = yield* LinearThreadService.LinearThreadService;

    const result = yield* service.prepareIssueThread(input);

    assert.strictEqual(result.branch, "ada/del-123-wire-up-linear");
    assert.strictEqual(result.worktreePath, "/tmp/worktrees/del-123");
    assert.strictEqual(result.baseBranch, "main");
    assert.strictEqual(result.reusedExistingBranch, false);
    // The lowest-position started state, not the first one Linear listed.
    assert.deepStrictEqual(result.movedToState, IN_PROGRESS_STATE);
    assert.deepStrictEqual(movedStateIds, ["state-in-progress"]);
    assert.deepStrictEqual(gitCalls, [
      {
        cwd: "/repos/t3code",
        branch: "ada/del-123-wire-up-linear",
        baseBranch: null,
        mode: "worktree",
      },
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("leaves an issue that is already started where the team put it", () => {
  const { layer, gitCalls, movedStateIds } = makeHarness({ issue: makeIssue(IN_REVIEW_STATE) });

  return Effect.gen(function* () {
    const service = yield* LinearThreadService.LinearThreadService;

    const result = yield* service.prepareIssueThread(input);

    assert.strictEqual(result.movedToState, null);
    assert.deepStrictEqual(movedStateIds, []);
    assert.strictEqual(gitCalls.length, 1);
  }).pipe(Effect.provide(layer));
});

it.effect("leaves the issue alone when the setting is off", () => {
  const { layer, movedStateIds } = makeHarness({ moveToStartedOnThreadStart: false });

  return Effect.gen(function* () {
    const service = yield* LinearThreadService.LinearThreadService;

    const result = yield* service.prepareIssueThread(input);

    assert.strictEqual(result.movedToState, null);
    assert.deepStrictEqual(movedStateIds, []);
  }).pipe(Effect.provide(layer));
});

it.effect("keeps the prepared branch when Linear refuses the state transition", () => {
  const { layer, gitCalls } = makeHarness({ updateIssueStateFails: true });

  return Effect.gen(function* () {
    const service = yield* LinearThreadService.LinearThreadService;

    const result = yield* service.prepareIssueThread(input);

    assert.strictEqual(result.branch, "ada/del-123-wire-up-linear");
    assert.strictEqual(result.movedToState, null);
    assert.strictEqual(gitCalls.length, 1);
  }).pipe(Effect.provide(layer));
});

it.effect("passes the base branch from t3.json through to git", () => {
  const { layer, gitCalls } = makeHarness({
    projectFile: { linear: { baseBranch: "develop" } },
  });

  return Effect.gen(function* () {
    const service = yield* LinearThreadService.LinearThreadService;

    const result = yield* service.prepareIssueThread(input);

    assert.strictEqual(gitCalls[0]?.baseBranch, "develop");
    assert.strictEqual(result.baseBranch, "develop");
  }).pipe(Effect.provide(layer));
});

it.effect("prefers the mapping row's base branch over t3.json", () => {
  const { layer, gitCalls } = makeHarness({
    projectFile: { linear: { baseBranch: "develop" } },
    linearRepositories: [
      {
        teamKey: "del",
        linearProjectId: null,
        projectId: ProjectId.make("project-1"),
        baseBranch: "release",
      },
    ],
  });

  return Effect.gen(function* () {
    const service = yield* LinearThreadService.LinearThreadService;

    const result = yield* service.prepareIssueThread(input);

    assert.strictEqual(gitCalls[0]?.baseBranch, "release");
    assert.strictEqual(result.baseBranch, "release");
  }).pipe(Effect.provide(layer));
});

it.effect("falls through to t3.json when the mapping row has no base branch", () => {
  const { layer, gitCalls } = makeHarness({
    projectFile: { linear: { baseBranch: "develop" } },
    linearRepositories: [
      {
        teamKey: "DEL",
        linearProjectId: null,
        projectId: ProjectId.make("project-1"),
        baseBranch: null,
      },
    ],
  });

  return Effect.gen(function* () {
    const service = yield* LinearThreadService.LinearThreadService;

    const result = yield* service.prepareIssueThread(input);

    assert.strictEqual(gitCalls[0]?.baseBranch, "develop");
    assert.strictEqual(result.baseBranch, "develop");
  }).pipe(Effect.provide(layer));
});

it.effect("never touches git when the issue does not resolve", () => {
  const { layer, gitCalls } = makeHarness({
    getIssueError: new LinearIssueNotFoundError({ reference: "DEL-999" }),
  });

  return Effect.gen(function* () {
    const service = yield* LinearThreadService.LinearThreadService;

    const error = yield* Effect.flip(
      service.prepareIssueThread({ ...input, reference: "DEL-999" }),
    );

    assert.instanceOf(error, LinearIssueNotFoundError);
    assert.deepStrictEqual(gitCalls, []);
  }).pipe(Effect.provide(layer));
});

it.effect("names the branch from the repository's convention under the prefixed style", () => {
  const { layer, gitCalls } = makeHarness({
    issue: makeIssue(TODO_STATE, [{ id: "label-bug", name: "Bug", color: "#eb5757" }]),
    linearBranchNaming: { style: "prefixed" },
  });

  return Effect.gen(function* () {
    const service = yield* LinearThreadService.LinearThreadService;

    const result = yield* service.prepareIssueThread(input);

    assert.strictEqual(result.branch, "fix/del-123-wire-up-linear");
    assert.strictEqual(gitCalls[0]?.branch, "fix/del-123-wire-up-linear");
  }).pipe(Effect.provide(layer));
});

it.effect("falls back to the first configured prefix when no label rule matches", () => {
  const { layer, gitCalls } = makeHarness({
    linearBranchNaming: { style: "prefixed" },
  });

  return Effect.gen(function* () {
    const service = yield* LinearThreadService.LinearThreadService;

    const result = yield* service.prepareIssueThread(input);

    assert.strictEqual(result.branch, "feat/del-123-wire-up-linear");
    assert.strictEqual(gitCalls[0]?.branch, "feat/del-123-wire-up-linear");
  }).pipe(Effect.provide(layer));
});

it.effect("checks out the branch the caller settled on in the dialog", () => {
  const { layer, gitCalls } = makeHarness({ linearBranchNaming: { style: "prefixed" } });

  return Effect.gen(function* () {
    const service = yield* LinearThreadService.LinearThreadService;

    const result = yield* service.prepareIssueThread({ ...input, branch: "chore/DEL-123-rename" });

    assert.strictEqual(result.branch, "chore/DEL-123-rename");
    assert.strictEqual(gitCalls[0]?.branch, "chore/DEL-123-rename");
  }).pipe(Effect.provide(layer));
});

it.effect("refuses a branch Linear could not link back to the issue", () => {
  const { layer, gitCalls } = makeHarness();

  return Effect.gen(function* () {
    const service = yield* LinearThreadService.LinearThreadService;

    const error = yield* Effect.flip(
      service.prepareIssueThread({ ...input, branch: "feat/rename-the-thing" }),
    );

    assert.instanceOf(error, LinearOperationError);
    assert.include(error.message, "DEL-123");
    assert.deepStrictEqual(gitCalls, []);
  }).pipe(Effect.provide(layer));
});

it.effect("refuses a branch git would reject as a ref", () => {
  const { layer, gitCalls } = makeHarness();

  return Effect.gen(function* () {
    const service = yield* LinearThreadService.LinearThreadService;

    const error = yield* Effect.flip(
      service.prepareIssueThread({ ...input, branch: "feat/del-123 bad" }),
    );

    assert.instanceOf(error, LinearOperationError);
    assert.include(error.message, "not a valid git branch name");
    assert.deepStrictEqual(gitCalls, []);
  }).pipe(Effect.provide(layer));
});

it.effect("stays on the checkout's branch and never touches git under the current mode", () => {
  const { layer, gitCalls, statusCwds, movedStateIds } = makeHarness();

  return Effect.gen(function* () {
    const service = yield* LinearThreadService.LinearThreadService;

    const result = yield* service.prepareIssueThread({
      ...input,
      branchMode: "current",
      // Named anyway, the way the dialog leaves a branch in its box: the mode
      // decides, so this is ignored rather than checked out.
      branch: "ada/del-123-wire-up-linear",
    });

    assert.deepStrictEqual(gitCalls, []);
    assert.deepStrictEqual(statusCwds, ["/repos/t3code"]);
    assert.strictEqual(result.branch, "release/24.3");
    assert.strictEqual(result.worktreePath, null);
    assert.strictEqual(result.baseBranch, null);
    assert.strictEqual(result.reusedExistingBranch, false);
    // The issue still moves: that is about the work starting, not the branch.
    assert.deepStrictEqual(result.movedToState, IN_PROGRESS_STATE);
    assert.deepStrictEqual(movedStateIds, ["state-in-progress"]);
  }).pipe(Effect.provide(layer));
});

it.effect("starts the thread even when the checkout has no branch to report", () => {
  const { layer, gitCalls } = makeHarness({ localStatusFails: true });

  return Effect.gen(function* () {
    const service = yield* LinearThreadService.LinearThreadService;

    const result = yield* service.prepareIssueThread({ ...input, branchMode: "current" });

    assert.strictEqual(result.branch, null);
    assert.deepStrictEqual(gitCalls, []);
    assert.deepStrictEqual(result.movedToState, IN_PROGRESS_STATE);
  }).pipe(Effect.provide(layer));
});

it.effect("reports a detached checkout as no branch rather than failing", () => {
  const { layer } = makeHarness({ checkoutBranch: null });

  return Effect.gen(function* () {
    const service = yield* LinearThreadService.LinearThreadService;

    const result = yield* service.prepareIssueThread({ ...input, branchMode: "current" });

    assert.strictEqual(result.branch, null);
  }).pipe(Effect.provide(layer));
});

it.effect("uses the assistant's explicit integration branch ahead of repository mappings", () => {
  const { layer, gitCalls } = makeHarness({
    projectFile: { linear: { baseBranch: "main" } },
    linearRepositories: [
      {
        teamKey: "DEL",
        linearProjectId: null,
        projectId: ProjectId.make("project-1"),
        baseBranch: "release",
      },
    ],
  });
  return Effect.gen(function* () {
    const service = yield* LinearThreadService.LinearThreadService;
    const result = yield* service.prepareIssueThread({ ...input, baseBranch: "develop" });
    assert.strictEqual(gitCalls[0]?.baseBranch, "develop");
    assert.strictEqual(result.baseBranch, "develop");
  }).pipe(Effect.provide(layer));
});
