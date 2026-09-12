import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as ProcessRunner from "../processRunner.ts";
import * as StagingVerifier from "./StagingVerifier.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-assistant-git-" });
  const cwd = path.join(root, "project");
  const remote = path.join(root, "origin.git");
  const worktreePath = path.join(root, "worker");
  yield* fs.makeDirectory(cwd);
  const runner = yield* ProcessRunner.ProcessRunner;
  const git = (args: string[], directory = cwd) =>
    runner.run({ command: "git", args, cwd: directory }).pipe(
      Effect.map((result) => {
        assert.equal(result.code, 0, result.stderr);
        return result.stdout.trim();
      }),
    );
  yield* git(["init", "--bare", remote]);
  yield* git(["init", "-b", "develop"]);
  yield* git(["config", "user.email", "test@example.com"]);
  yield* git(["config", "user.name", "Assistant test"]);
  yield* git(["config", "commit.gpgSign", "false"]);
  yield* fs.writeFileString(path.join(cwd, "app.txt"), "initial\n");
  yield* git(["add", "."]);
  yield* git(["commit", "-m", "initial"]);
  yield* git(["remote", "add", "origin", remote]);
  yield* git(["push", "-u", "origin", "develop"]);
  const initial = yield* git(["rev-parse", "HEAD"]);
  yield* git(["worktree", "add", "-b", "assistant/APP-1", worktreePath]);
  yield* fs.writeFileString(path.join(worktreePath, "app.txt"), "worker changes\n");
  yield* git(["commit", "-am", "worker changes"], worktreePath);
  const workerRevision = yield* git(["rev-parse", "HEAD"], worktreePath);
  const checks: ProcessRunner.ProcessRunInput[] = [];
  let receipt = {
    code: 0,
    stdout: encodeJson({ revision: workerRevision, url: "https://staging.example.test" }),
  };
  const verifier = yield* StagingVerifier.StagingVerifier.pipe(
    Effect.provide(
      StagingVerifier.layer.pipe(
        Layer.provide(
          Layer.succeed(ProcessRunner.ProcessRunner, {
            run: (input) => {
              if (input.command === "git") return runner.run(input);
              checks.push(input);
              return Effect.succeed({
                ...receipt,
                code: ChildProcessSpawner.ExitCode(receipt.code),
                stderr: "",
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              });
            },
          }),
        ),
      ),
    ),
  );
  return {
    fs,
    path,
    cwd,
    worktreePath,
    git,
    initial,
    workerRevision,
    verifier,
    checks,
    input: { cwd, worktreePath, baseBranch: "develop", command: "project-staging-health-check" },
    setReceipt: (value: typeof receipt) => {
      receipt = value;
    },
  };
});
const dependencies = ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer));

it.effect("requires the worker commit to be deployed on origin's integration branch", () =>
  Effect.gen(function* () {
    const h = yield* fixture;
    assert.equal(
      yield* h.verifier.repositoryKey(h.cwd),
      yield* h.verifier.repositoryKey(h.worktreePath),
    );
    // A provider reporting the worker revision before it reaches develop cannot release the queue.
    assert.isTrue(yield* h.verifier.verify(h.input).pipe(Effect.isFailure));
    yield* h.git(["merge", "--no-ff", "--no-edit", "assistant/APP-1"]);
    yield* h.git(["push", "origin", "develop"]);
    const deployed = yield* h.git(["rev-parse", "HEAD"]);
    h.setReceipt({
      code: 0,
      stdout: encodeJson({ revision: deployed, url: "https://staging.example.test" }),
    });
    const result = yield* h.verifier.verify(h.input);
    assert.equal(result.revision, deployed);
    assert.equal(h.checks[0]?.env?.T3_ASSISTANT_WORKER_REVISION, h.workerRevision);
    assert.equal(h.checks[0]?.env?.T3_ASSISTANT_BASE_BRANCH, "develop");
    // The previous healthy deployment is insufficient even when develop has moved forward.
    h.setReceipt({
      code: 0,
      stdout: encodeJson({ revision: h.initial, url: "https://staging.example.test" }),
    });
    assert.isTrue(yield* h.verifier.verify(h.input).pipe(Effect.isFailure));
  }).pipe(Effect.provide(dependencies), Effect.scoped),
);

it.effect("rejects dirty work, failed checks and malformed deployment receipts", () =>
  Effect.gen(function* () {
    const h = yield* fixture;
    yield* h.fs.writeFileString(h.path.join(h.worktreePath, "unfinished.txt"), "not committed");
    assert.isTrue(yield* h.verifier.verify(h.input).pipe(Effect.isFailure));
    assert.lengthOf(h.checks, 0);
    yield* h.fs.remove(h.path.join(h.worktreePath, "unfinished.txt"));
    for (const receipt of [
      { code: 1, stdout: "deployment failed" },
      { code: 0, stdout: "deploying" },
      {
        code: 0,
        stdout: encodeJson({ revision: "abc123", url: "https://staging.example.test" }),
      },
      {
        code: 0,
        stdout: encodeJson({ revision: h.workerRevision, url: "file:///etc/passwd" }),
      },
    ]) {
      h.setReceipt(receipt);
      assert.isTrue(yield* h.verifier.verify(h.input).pipe(Effect.isFailure));
    }
  }).pipe(Effect.provide(dependencies), Effect.scoped),
);
