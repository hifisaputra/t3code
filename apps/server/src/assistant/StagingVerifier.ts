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
    readonly verify: (input: {
      cwd: string;
      worktreePath: string;
      baseBranch: string;
      /** The reviewed commit; a worktree that moved past it is refused. */
      expectedRevision?: string;
      command: string;
      stagingUrl?: string;
      targets?: ReadonlyArray<AssistantDeploymentTarget>;
      targetIds?: ReadonlyArray<string>;
    }) => Effect.Effect<AssistantDeployment, DeveloperAssistantError>;
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
    const requireAncestor = Effect.fn("Assistant.requireAncestor")(function* (
      cwd: string,
      commit: string,
      ref: string,
      /** What the person should do while the commit has not arrived yet. */
      notYet: string,
    ) {
      if (!(yield* isAncestor(cwd, commit, ref)))
        return yield* new DeveloperAssistantError({ detail: notYet });
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
      verify: Effect.fn("Assistant.verifyStaging")(
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
            const evidence = yield* Effect.forEach(targets, (target) =>
              checkDeployment(target, input.cwd, input.baseBranch, workerRevision).pipe(
                Effect.provideService(ProcessRunner, runner),
              ),
            );
            yield* fetchBase(input.cwd, input.baseBranch);
            for (const receipt of evidence) {
              yield* requireAncestor(
                input.cwd,
                workerRevision,
                receipt.revision,
                `${receipt.targetId} is still on ${label(receipt.revision)}, which does not contain ${label(workerRevision)}. Wait for the merge to deploy, then verify again.`,
              );
              yield* requireAncestor(
                input.cwd,
                receipt.revision,
                `refs/remotes/origin/${input.baseBranch}`,
                `${receipt.targetId} deployed ${label(receipt.revision)}, which is not on origin/${input.baseBranch} yet. Wait for the merge to land and deploy; if it already landed, check the base branch, remote, and merge method.`,
              );
            }
            return {
              revision: evidence[0]!.revision,
              url: input.stagingUrl,
              verifiedAt: DateTime.formatIso(yield* DateTime.now),
              evidence,
            };
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
          if (output.code !== 0)
            return yield* new DeveloperAssistantError({
              detail:
                "The staging check did not pass. The project remains occupied; inspect deployment health and retry when it is ready.",
            });
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
          yield* requireAncestor(
            input.cwd,
            workerRevision,
            receipt.revision,
            `The staging check reports ${label(receipt.revision)}, which does not contain ${label(workerRevision)}. Staging is still on an older commit; wait for the merge to deploy, then verify again.`,
          );
          yield* requireAncestor(
            input.cwd,
            receipt.revision,
            `refs/remotes/origin/${input.baseBranch}`,
            `The staging check reports ${label(receipt.revision)}, which is not on origin/${input.baseBranch} yet. Wait for the merge to land and deploy; if it already landed, check the base branch, remote, and merge method.`,
          );
          return { ...receipt, verifiedAt: DateTime.formatIso(yield* DateTime.now) };
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
