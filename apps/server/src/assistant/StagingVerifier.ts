import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { AssistantDeployment, DeveloperAssistantError } from "@t3tools/contracts";
import { ProcessRunner } from "../processRunner.ts";

const Receipt = Schema.Struct({
  revision: AssistantDeployment.fields.revision,
  url: AssistantDeployment.fields.url,
});

const decodeReceipt = Schema.decodeUnknownEffect(Schema.fromJsonString(Receipt));
const isAssistantError = Schema.is(DeveloperAssistantError);

export class StagingVerifier extends Context.Service<
  StagingVerifier,
  {
    readonly repositoryKey: (cwd: string) => Effect.Effect<string, DeveloperAssistantError>;
    readonly verify: (input: {
      cwd: string;
      worktreePath: string;
      baseBranch: string;
      command: string;
    }) => Effect.Effect<AssistantDeployment, DeveloperAssistantError>;
  }
>()("t3/assistant/StagingVerifier") {}

export const layer = Layer.effect(
  StagingVerifier,
  Effect.gen(function* () {
    const runner = yield* ProcessRunner;
    const platform = yield* HostProcessPlatform;
    const git = Effect.fn("Assistant.git")(
      function* (cwd: string, args: ReadonlyArray<string>) {
        const result = yield* runner.run({
          command: "git",
          args,
          cwd,
          timeout: "30 seconds",
          maxOutputBytes: 16000,
        });
        if (result.code !== 0)
          return yield* new DeveloperAssistantError({
            detail:
              "Git could not verify the repository or staging revision. Check the base branch, remote, and merge method.",
          });
        return result.stdout.trim();
      },
      Effect.mapError((error) =>
        isAssistantError(error)
          ? error
          : new DeveloperAssistantError({ detail: "Could not run Git verification." }),
      ),
    );
    return {
      repositoryKey: (cwd) => git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
      verify: Effect.fn("Assistant.verifyStaging")(
        function* (input) {
          if (yield* git(input.worktreePath, ["status", "--porcelain"])) {
            return yield* new DeveloperAssistantError({
              detail: "Commit the worker's changes before verifying staging.",
            });
          }
          const workerRevision = yield* git(input.worktreePath, ["rev-parse", "HEAD"]);
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
          yield* git(input.cwd, ["fetch", "origin", input.baseBranch]);
          yield* git(input.cwd, ["merge-base", "--is-ancestor", workerRevision, receipt.revision]);
          yield* git(input.cwd, [
            "merge-base",
            "--is-ancestor",
            receipt.revision,
            `refs/remotes/origin/${input.baseBranch}`,
          ]);
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
    };
  }),
);
