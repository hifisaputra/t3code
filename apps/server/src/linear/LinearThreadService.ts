import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  LINEAR_DEFAULT_BRANCH_PREFIXES,
  LINEAR_DEFAULT_LABEL_BRANCH_PREFIXES,
  LinearOperationError,
  linearBranchNamesIssue,
  linearIssueBranchName,
  resolveLinearRepositoryMapping,
} from "@t3tools/contracts";
import type {
  GitManagerServiceError,
  LinearBranchNaming,
  LinearIssueNotFoundError,
  LinearPrepareIssueThreadInput,
  LinearPrepareIssueThreadResult,
  LinearRepositoryMapping,
  LinearUnavailableError,
  LinearWorkflowState,
  LinearWorkflowStateType,
} from "@t3tools/contracts";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { LinearApi } from "./LinearApi.ts";

/**
 * States an issue is moved out of when a thread starts on it. Anything already
 * started, completed, or canceled is left exactly as the team put it.
 */
const MOVABLE_STATE_TYPES: ReadonlySet<LinearWorkflowStateType> = new Set([
  "triage",
  "backlog",
  "unstarted",
]);

/**
 * Linear's own guidance: the lowest-position `started` state is the team's
 * "In Progress", whatever they called it.
 */
function lowestPositionStartedState(
  states: ReadonlyArray<LinearWorkflowState>,
): LinearWorkflowState | null {
  let lowest: LinearWorkflowState | null = null;
  for (const state of states) {
    if (state.type !== "started") continue;
    if (lowest === null || state.position < lowest.position) {
      lowest = state;
    }
  }
  return lowest;
}

/**
 * What settings the branch needs when the settings file cannot be read: no
 * mappings, and Linear's own branch name. Unreadable settings cost the thread
 * its mapping, never its branch.
 */
const FALLBACK_LINEAR_BRANCH_SETTINGS: {
  readonly repositories: ReadonlyArray<LinearRepositoryMapping>;
  readonly branchNaming: LinearBranchNaming;
} = {
  repositories: [],
  branchNaming: {
    style: "linear",
    prefixes: LINEAR_DEFAULT_BRANCH_PREFIXES,
    labelPrefixes: LINEAR_DEFAULT_LABEL_BRANCH_PREFIXES,
  },
};

/**
 * `git check-ref-format` is the authority; this catches what a hand-edited
 * branch realistically gets wrong before we shell out to git.
 */
function isValidGitBranchName(branch: string): boolean {
  if (branch.length === 0) return false;
  if (branch.startsWith("/") || branch.startsWith("-")) return false;
  if (branch.endsWith("/") || branch.endsWith(".lock")) return false;
  if (branch.includes("..") || branch.includes("@{")) return false;
  if (/[\s~^:?*[\\]/.test(branch)) return false;
  for (const character of branch) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/**
 * Turns a Linear issue into a thread's branch. The caller's branch or the
 * `linear.branchNaming` setting supplies the name, git supplies the checkout,
 * and the state transition is a courtesy that never costs the caller its
 * worktree.
 */
export class LinearThreadService extends Context.Service<
  LinearThreadService,
  {
    readonly prepareIssueThread: (
      input: LinearPrepareIssueThreadInput,
    ) => Effect.Effect<
      LinearPrepareIssueThreadResult,
      | LinearUnavailableError
      | LinearIssueNotFoundError
      | LinearOperationError
      | GitManagerServiceError
    >;
  }
>()("t3/linear/LinearThreadService") {}

export const make = Effect.gen(function* () {
  const linear = yield* LinearApi;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const projectFiles = yield* T3ProjectFileLoader.T3ProjectFileLoader;
  const serverSettings = yield* ServerSettingsService;

  /**
   * Best effort by design: the branch is already prepared by the time this
   * runs, and a workspace that rejects the transition is not a reason to strand
   * the thread that was just created for it.
   */
  const moveIssueToStarted = Effect.fn("LinearThreadService.moveIssueToStarted")(function* (issue: {
    readonly id: string;
    readonly identifier: string;
    readonly state: LinearWorkflowState;
    readonly team: { readonly id: string };
  }) {
    if (!MOVABLE_STATE_TYPES.has(issue.state.type)) {
      return null;
    }
    const settings = yield* serverSettings.getSettings;
    if (!settings.linear.moveToStartedOnThreadStart) {
      return null;
    }
    const states = yield* linear.workflowStates(issue.team.id);
    const target = lowestPositionStartedState(states);
    if (target === null || target.id === issue.state.id) {
      return null;
    }
    yield* linear.updateIssueState({ issueId: issue.id, stateId: target.id });
    return target;
  });

  const prepareIssueThread: LinearThreadService["Service"]["prepareIssueThread"] = Effect.fn(
    "LinearThreadService.prepareIssueThread",
  )(function* (input) {
    const issue = yield* linear.getIssue({ reference: input.reference });

    // The mapping row the user set in Settings wins over the repository's own
    // t3.json, which in turn wins over the remote's default branch (picked
    // inside prepareBranchThread when this is null).
    const linearSettings = yield* serverSettings.getSettings.pipe(
      Effect.map((settings) => ({
        repositories: settings.linear.repositories,
        branchNaming: settings.linear.branchNaming,
      })),
      // Unreadable settings cost the thread its mapping, never its branch.
      Effect.catch((cause) =>
        Effect.logWarning("LinearThreadService could not read its Linear settings", { cause }).pipe(
          Effect.as(FALLBACK_LINEAR_BRANCH_SETTINGS),
        ),
      ),
    );
    const mapping = resolveLinearRepositoryMapping(linearSettings.repositories, issue);

    // A branch the person edited in the dialog is taken as typed, once it is a
    // legal ref and still carries the identifier Linear links pull requests on.
    let branch: string;
    if (input.branch === undefined) {
      branch = linearIssueBranchName(issue, linearSettings.branchNaming);
    } else {
      branch = input.branch.trim();
      if (!isValidGitBranchName(branch)) {
        return yield* new LinearOperationError({
          operation: "prepareIssueThread",
          detail: `"${branch}" is not a valid git branch name.`,
        });
      }
      if (!linearBranchNamesIssue(branch, issue.identifier)) {
        return yield* new LinearOperationError({
          operation: "prepareIssueThread",
          detail: `Branch names must contain the issue identifier (${issue.identifier}) so Linear can link the pull request.`,
        });
      }
    }

    const projectFile = yield* projectFiles.load(input.cwd);
    const baseBranch =
      mapping?.baseBranch ??
      Option.match(projectFile, {
        onNone: () => null,
        onSome: (file) => file.linear?.baseBranch ?? null,
      });

    const prepared = yield* gitWorkflow.prepareBranchThread({
      cwd: input.cwd,
      branch,
      baseBranch,
      mode: input.mode,
      ...(input.threadId ? { threadId: input.threadId } : {}),
    });

    const movedToState = yield* moveIssueToStarted(issue).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("LinearThreadService could not move the issue to In Progress", {
          identifier: issue.identifier,
          cause,
        }).pipe(Effect.as(null)),
      ),
    );

    return {
      issue,
      branch: prepared.branch,
      worktreePath: prepared.worktreePath,
      baseBranch: prepared.baseBranch,
      reusedExistingBranch: prepared.reusedExistingBranch,
      movedToState,
    } satisfies LinearPrepareIssueThreadResult;
  });

  return LinearThreadService.of({ prepareIssueThread });
});

export const layer = Layer.effect(LinearThreadService, make);
