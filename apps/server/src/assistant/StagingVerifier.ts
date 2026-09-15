import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  AssistantDeployment,
  DeveloperAssistantError,
  type AssistantDeploymentTarget,
} from "@t3tools/contracts";
import { ProcessRunner } from "../processRunner.ts";
import { checkDeployment, processFailureDetail } from "./deploymentChecks.ts";

const Receipt = Schema.Struct({
  revision: AssistantDeployment.fields.revision,
  url: AssistantDeployment.fields.url,
});

/**
 * Whether the staging deploy of a commit has landed. `pending` is every
 * ordinary not-yet: T3 watches it for the team leader. `failed` needs someone
 * to look at the deployment.
 */
export type DeployCheck =
  | { readonly outcome: "verified"; readonly deployment: AssistantDeployment }
  | { readonly outcome: "pending"; readonly detail: string }
  | { readonly outcome: "failed"; readonly detail: string };

/** How much of a check command's output the reviewer and the board keep. */
const CHECK_OUTPUT_TAIL = 8000;
/** Output above this is dropped; a check that prints more is not reporting. */
const CHECK_OUTPUT_LIMIT = 4_000_000;

const pendingDeploy = (detail: string): DeployCheck => ({ outcome: "pending", detail });
const failedDeploy = (detail: string): DeployCheck => ({ outcome: "failed", detail });
const verifiedDeploy = (deployment: AssistantDeployment): DeployCheck => ({
  outcome: "verified",
  deployment,
});

const decodeReceipt = Schema.decodeUnknownEffect(Schema.fromJsonString(Receipt));
const isAssistantError = Schema.is(DeveloperAssistantError);
/** A commit as a person reads it; a ref name is already readable. */
const label = (value: string) => (/^[0-9a-f]{40}$/.test(value) ? value.slice(0, 7) : value);

export class StagingVerifier extends Context.Service<
  StagingVerifier,
  {
    readonly repositoryKey: (cwd: string) => Effect.Effect<string, DeveloperAssistantError>;
    /** The worktree's HEAD. Uncommitted changes fail unless allowed, since an approval could not cover them. */
    readonly revision: (
      worktreePath: string,
      options?: { readonly allowUncommitted?: boolean },
    ) => Effect.Effect<string, DeveloperAssistantError>;
    /** Whether a commit is on origin's integration branch, after fetching it. */
    readonly isMerged: (input: {
      cwd: string;
      revision: string;
      baseBranch: string;
    }) => Effect.Effect<boolean, DeveloperAssistantError>;
    readonly checkDeploy: (input: {
      cwd: string;
      worktreePath: string;
      baseBranch: string;
      /** The reviewed commit; a worktree that moved past it is refused. */
      expectedRevision?: string;
      command: string;
      stagingUrl?: string;
      targets?: ReadonlyArray<AssistantDeploymentTarget>;
      targetIds?: ReadonlyArray<string>;
    }) => Effect.Effect<DeployCheck, DeveloperAssistantError>;
    /**
     * The project's own check (lint, typecheck, tests) in the team's worktree,
     * with the end of its combined output. A non-zero exit is a result, not a
     * failure: it is what refuses the review request.
     */
    readonly runCheck: (input: {
      worktreePath: string;
      command: string;
    }) => Effect.Effect<{ exitCode: number; output: string }, DeveloperAssistantError>;
    /** Remove a finished issue's worktree. Git refuses one with uncommitted changes; so does this. */
    readonly removeWorktree: (input: {
      cwd: string;
      worktreePath: string;
    }) => Effect.Effect<void, DeveloperAssistantError>;
  }
>()("t3/assistant/StagingVerifier") {}

export const layer = Layer.effect(
  StagingVerifier,
  Effect.gen(function* () {
    const runner = yield* ProcessRunner;
    const platform = yield* HostProcessPlatform;
    const gitRun = (
      cwd: string,
      args: ReadonlyArray<string>,
      timeout: "30 seconds" | "5 minutes" = "30 seconds",
    ) =>
      runner.run({ command: "git", args, cwd, timeout, maxOutputBytes: 16000 }).pipe(
        Effect.mapError(
          (error) =>
            new DeveloperAssistantError({
              detail: processFailureDetail(error, "Git verification"),
            }),
        ),
      );
    const git = Effect.fn("Assistant.git")(function* (
      cwd: string,
      args: ReadonlyArray<string>,
      timeout: "30 seconds" | "5 minutes" = "30 seconds",
    ) {
      const result = yield* gitRun(cwd, args, timeout);
      if (result.code !== 0)
        return yield* new DeveloperAssistantError({
          detail:
            "Git could not verify the repository or staging revision. Check the base branch, remote, and merge method.",
        });
      return result.stdout.trim();
    });
    /**
     * Whether `ref` contains `commit`. `git merge-base --is-ancestor` answers "no"
     * with exit code 1, which is the ordinary "staging is still on an older commit";
     * anything above that is a broken repository, ref or remote and is reported as one.
     */
    const isAncestor = Effect.fn("Assistant.isAncestor")(function* (
      cwd: string,
      commit: string,
      ref: string,
    ) {
      const result = yield* gitRun(cwd, ["merge-base", "--is-ancestor", commit, ref]);
      if (result.code === 0) return true;
      if (result.code === 1) return false;
      return yield* new DeveloperAssistantError({
        detail: `Git could not tell whether ${label(ref)} contains ${label(commit)}. Check the base branch, remote, and merge method.`,
      });
    });
    /**
     * What a deployed revision proves about the commit: nothing yet while it
     * does not contain it, and a problem for a person when the deployment is
     * not on origin's integration branch. Null once it proves the commit.
     */
    const ancestry = Effect.fn("Assistant.deployAncestry")(function* (
      cwd: string,
      commit: string,
      deployedRevision: string,
      baseBranch: string,
      /** Why the commit has not arrived yet. */
      notYet: string,
      /** Why the deployment is not one this commit can be verified against. */
      offBranch: string,
    ) {
      if (!(yield* isAncestor(cwd, commit, deployedRevision))) return pendingDeploy(notYet);
      if (!(yield* isAncestor(cwd, deployedRevision, `refs/remotes/origin/${baseBranch}`)))
        return failedDeploy(offBranch);
      return null;
    });
    // Refspecs are agent-proposed, so they are passed after `--`; a branch named
    // `--upload-pack=...` is otherwise an option to git rather than a ref.
    const fetchBase = (cwd: string, baseBranch: string) =>
      git(cwd, ["fetch", "origin", "--", baseBranch]);
    const revision = Effect.fn("Assistant.revision")(function* (
      worktreePath: string,
      options?: { readonly allowUncommitted?: boolean },
    ) {
      if (!options?.allowUncommitted && (yield* git(worktreePath, ["status", "--porcelain"]))) {
        return yield* new DeveloperAssistantError({
          detail: "The worktree has uncommitted changes. Commit the work first.",
        });
      }
      return yield* git(worktreePath, ["rev-parse", "HEAD"]);
    });
    return {
      repositoryKey: (cwd) => git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
      revision,
      isMerged: Effect.fn("Assistant.isMerged")(function* (input) {
        yield* fetchBase(input.cwd, input.baseBranch);
        return yield* isAncestor(
          input.cwd,
          input.revision,
          `refs/remotes/origin/${input.baseBranch}`,
        );
      }),
      runCheck: Effect.fn("Assistant.runCheck")(function* (input) {
        // Values are passed in the environment, never interpolated into shell code.
        const result = yield* runner
          .run({
            command: platform === "win32" ? "powershell.exe" : "/bin/sh",
            args:
              platform === "win32"
                ? ["-NoProfile", "-Command", input.command]
                : ["-c", input.command],
            cwd: input.worktreePath,
            timeout: "20 minutes",
            maxOutputBytes: CHECK_OUTPUT_LIMIT,
            outputMode: "truncate",
          })
          .pipe(
            Effect.mapError(
              (error) =>
                new DeveloperAssistantError({
                  detail: processFailureDetail(error, "The project's check command"),
                }),
            ),
          );
        const output = [result.stdout, result.stderr].filter((part) => part.trim()).join("\n");
        return {
          // A run the host killed reports no code; it did not pass either.
          exitCode: result.code ?? 1,
          output: output.slice(-CHECK_OUTPUT_TAIL),
        };
      }),
      checkDeploy: Effect.fn("Assistant.checkDeploy")(
        function* (input) {
          // The commit under verification is fixed by expectedRevision and proved to be
          // on origin's branch below, so a stray file in the shared worktree is not this
          // team leader's problem to clean up. Approvals still read HEAD strictly.
          const workerRevision = yield* revision(input.worktreePath, { allowUncommitted: true });
          if (input.expectedRevision && workerRevision !== input.expectedRevision) {
            return yield* new DeveloperAssistantError({
              detail:
                "The worktree has commits the code review has not approved. Request another review before verifying staging.",
            });
          }
          if (!input.command.trim()) {
            const configured = input.targets ?? [];
            const targets =
              input.targetIds === undefined
                ? configured
                : configured.filter((t) => input.targetIds?.includes(t.id));
            if (
              !input.stagingUrl ||
              !targets.length ||
              (input.targetIds &&
                (new Set(input.targetIds).size !== input.targetIds.length ||
                  targets.length !== input.targetIds.length))
            )
              return yield* new DeveloperAssistantError({
                detail:
                  "Select at least one known staging deployment target from the saved project setup.",
              });
            const checks = yield* Effect.forEach(targets, (target) =>
              checkDeployment(target, input.cwd, input.baseBranch, workerRevision).pipe(
                Effect.provideService(ProcessRunner, runner),
              ),
            );
            // One target's failure is the whole check's; the rest only say how
            // far along the deploy is.
            const stopped = checks.filter((check) => check.outcome === "failed");
            if (stopped.length) return failedDeploy(stopped.map((c) => c.detail).join(" "));
            const waiting = checks.filter((check) => check.outcome === "pending");
            if (waiting.length) return pendingDeploy(waiting.map((c) => c.detail).join(" "));
            const evidence = checks.flatMap((check) =>
              check.outcome === "deployed"
                ? [
                    {
                      targetId: check.targetId,
                      revision: check.revision,
                      reference: check.reference,
                    },
                  ]
                : [],
            );
            yield* fetchBase(input.cwd, input.baseBranch);
            for (const receipt of evidence) {
              const unproven = yield* ancestry(
                input.cwd,
                workerRevision,
                receipt.revision,
                input.baseBranch,
                `${receipt.targetId} is still on ${label(receipt.revision)}, which does not contain ${label(workerRevision)}. Wait for the merge to deploy.`,
                `${receipt.targetId} deployed ${label(receipt.revision)}, which is not on origin/${input.baseBranch}. If the merge landed, check the base branch, remote, and merge method.`,
              );
              if (unproven) return unproven;
            }
            return verifiedDeploy({
              revision: evidence[0]!.revision,
              url: input.stagingUrl,
              verifiedAt: DateTime.formatIso(yield* DateTime.now),
              evidence,
            });
          }
          // Values are passed in the environment, never interpolated into shell code.
          const output = yield* runner.run({
            command: platform === "win32" ? "powershell.exe" : "/bin/sh",
            args:
              platform === "win32"
                ? ["-NoProfile", "-Command", input.command]
                : ["-c", input.command],
            cwd: input.cwd,
            env: {
              T3_ASSISTANT_WORKER_REVISION: workerRevision,
              T3_ASSISTANT_BASE_BRANCH: input.baseBranch,
            },
            timeout: "90 seconds",
            maxOutputBytes: 16000,
            outputMode: "error",
          });
          // The check is written to fail while the deploy is pending, so a
          // non-zero exit is "not yet" rather than a broken deployment.
          if (output.code !== 0)
            return pendingDeploy(
              "The project's staging check has not passed yet. It fails while the deployment is pending or unhealthy.",
            );
          const receipt = yield* decodeReceipt(output.stdout.trim()).pipe(
            Effect.mapError(
              () =>
                new DeveloperAssistantError({
                  detail:
                    "The staging check must print JSON containing the deployed revision (full commit SHA) and an http(s) review URL.",
                }),
            ),
          );
          yield* fetchBase(input.cwd, input.baseBranch);
          const unproven = yield* ancestry(
            input.cwd,
            workerRevision,
            receipt.revision,
            input.baseBranch,
            `The staging check reports ${label(receipt.revision)}, which does not contain ${label(workerRevision)}. Staging is still on an older commit; wait for the merge to deploy.`,
            `The staging check reports ${label(receipt.revision)}, which is not on origin/${input.baseBranch}. If the merge landed, check the base branch, remote, and merge method.`,
          );
          if (unproven) return unproven;
          return verifiedDeploy({
            ...receipt,
            verifiedAt: DateTime.formatIso(yield* DateTime.now),
          });
        },
        Effect.mapError((error) =>
          isAssistantError(error)
            ? error
            : new DeveloperAssistantError({
                detail: "Staging verification failed or timed out. No deployment was accepted.",
              }),
        ),
      ),
      // Deleting installed dependencies can outlast the usual git timeout.
      removeWorktree: (input) =>
        git(input.cwd, ["worktree", "remove", input.worktreePath], "5 minutes").pipe(Effect.asVoid),
    };
  }),
);
