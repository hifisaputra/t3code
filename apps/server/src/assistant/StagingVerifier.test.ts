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
/** The deployment a check verified; any other outcome fails the assertion. */
const verifiedDeployment = (check: StagingVerifier.DeployCheck) => {
  assert.equal(check.outcome, "verified");
  return check.outcome === "verified" ? check.deployment : null;
};

it.effect("requires the worker commit to be deployed on origin's integration branch", () =>
  Effect.gen(function* () {
    const h = yield* fixture;
    assert.equal(
      yield* h.verifier.repositoryKey(h.cwd),
      yield* h.verifier.repositoryKey(h.worktreePath),
    );
    // A provider reporting the worker revision before it reaches develop cannot release the queue.
    assert.equal((yield* h.verifier.checkDeploy(h.input)).outcome, "failed");
    yield* h.git(["merge", "--no-ff", "--no-edit", "assistant/APP-1"]);
    yield* h.git(["push", "origin", "develop"]);
    const deployed = yield* h.git(["rev-parse", "HEAD"]);
    h.setReceipt({
      code: 0,
      stdout: encodeJson({ revision: deployed, url: "https://staging.example.test" }),
    });
    assert.equal(verifiedDeployment(yield* h.verifier.checkDeploy(h.input))?.revision, deployed);
    assert.equal(h.checks[0]?.env?.T3_ASSISTANT_WORKER_REVISION, h.workerRevision);
    assert.equal(h.checks[0]?.env?.T3_ASSISTANT_BASE_BRANCH, "develop");
    // The previous healthy deployment is insufficient even when develop has moved
    // forward: staging simply has not caught up yet.
    h.setReceipt({
      code: 0,
      stdout: encodeJson({ revision: h.initial, url: "https://staging.example.test" }),
    });
    assert.equal((yield* h.verifier.checkDeploy(h.input)).outcome, "pending");
  }).pipe(Effect.provide(dependencies), Effect.scoped),
);

it.effect("runs the project's check command in the worktree and reports what it printed", () =>
  Effect.gen(function* () {
    const h = yield* fixture;
    h.setReceipt({ code: 3, stdout: "12 tests failed" });
    // A red run is a result the caller acts on, not a failure of the verifier.
    const red = yield* h.verifier.runCheck({
      worktreePath: h.worktreePath,
      command: "pnpm check",
    });
    assert.equal(red.exitCode, 3);
    assert.include(red.output, "12 tests failed");
    const call = h.checks.at(-1);
    assert.equal(call?.cwd, h.worktreePath);
    assert.equal(call?.timeout, "20 minutes");
    assert.equal(call?.outputMode, "truncate");
    assert.isTrue(call?.args?.includes("pnpm check"));
    h.setReceipt({ code: 0, stdout: "ok" });
    const green = yield* h.verifier.runCheck({
      worktreePath: h.worktreePath,
      command: "pnpm check",
    });
    assert.equal(green.exitCode, 0);
  }).pipe(Effect.provide(dependencies), Effect.scoped),
);

it.effect("reads the reviewed commit and whether origin's integration branch has it", () =>
  Effect.gen(function* () {
    const h = yield* fixture;
    assert.equal(yield* h.verifier.revision(h.worktreePath), h.workerRevision);
    const merged = { cwd: h.cwd, revision: h.workerRevision, baseBranch: "develop" };
    assert.isFalse(yield* h.verifier.isMerged(merged));
    yield* h.git(["merge", "--no-ff", "--no-edit", "assistant/APP-1"]);
    // A local merge that was never pushed is not merged.
    assert.isFalse(yield* h.verifier.isMerged(merged));
    yield* h.git(["push", "origin", "develop"]);
    assert.isTrue(yield* h.verifier.isMerged(merged));
    const deployed = yield* h.git(["rev-parse", "HEAD"]);
    h.setReceipt({
      code: 0,
      stdout: encodeJson({ revision: deployed, url: "https://staging.example.test" }),
    });
    assert.isTrue(
      yield* h.verifier
        .checkDeploy({ ...h.input, expectedRevision: h.initial })
        .pipe(Effect.isFailure),
    );
    assert.lengthOf(h.checks, 0);
    yield* h.verifier.checkDeploy({ ...h.input, expectedRevision: h.workerRevision });
    yield* h.fs.writeFileString(h.path.join(h.worktreePath, "unfinished.txt"), "not committed");
    assert.isTrue(yield* h.verifier.revision(h.worktreePath).pipe(Effect.isFailure));
  }).pipe(Effect.provide(dependencies), Effect.scoped),
);

it.effect("waits on a red staging check and rejects malformed deployment receipts", () =>
  Effect.gen(function* () {
    const h = yield* fixture;
    // The check is written to fail while the deploy is pending, so a red run waits.
    h.setReceipt({ code: 1, stdout: "deployment failed" });
    assert.equal((yield* h.verifier.checkDeploy(h.input)).outcome, "pending");
    for (const receipt of [
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
      assert.isTrue(yield* h.verifier.checkDeploy(h.input).pipe(Effect.isFailure));
    }
  }).pipe(Effect.provide(dependencies), Effect.scoped),
);

it.effect(
  "checks the latest deployment workflow and rejects stale, failed or unknown targets",
  () =>
    Effect.gen(function* () {
      const h = yield* fixture;
      yield* h.git(["merge", "--no-ff", "--no-edit", "assistant/APP-1"]);
      yield* h.git(["push", "origin", "develop"]);
      const deployed = yield* h.git(["rev-parse", "HEAD"]);
      const input = {
        ...h.input,
        command: "",
        stagingUrl: "https://staging.example.test",
        targets: [
          {
            kind: "github-actions" as const,
            id: "dashboard",
            repository: "owner/app",
            workflow: "deploy.yml",
          },
        ],
      };
      const run = {
        headSha: deployed,
        status: "completed",
        conclusion: "success",
        url: "https://github.com/owner/app/actions/runs/42",
      };
      // A deploy that has not run, is running, or built someone else's commit is
      // waited on; a run that completed unsuccessfully is the leader's to decide.
      for (const [rows, outcome] of [
        [[], "pending"],
        [
          [{ ...run, headSha: h.workerRevision, status: "in_progress", conclusion: null }],
          "pending",
        ],
        [[{ ...run, headSha: h.workerRevision, conclusion: "failure" }], "failed"],
        [[{ ...run, conclusion: "failure" }], "pending"],
        [[{ ...run, headSha: h.initial }], "pending"],
      ] as const) {
        h.setReceipt({ code: 0, stdout: encodeJson(rows) });
        assert.equal((yield* h.verifier.checkDeploy(input)).outcome, outcome);
      }
      h.setReceipt({ code: 0, stdout: encodeJson([run]) });
      const result = verifiedDeployment(yield* h.verifier.checkDeploy(input));
      assert.equal(result?.revision, deployed);
      assert.equal(result?.evidence?.[0]?.reference, run.url);
      assert.equal(h.checks[0]?.command, "gh");
      assert.isTrue(h.checks[0]?.args?.includes("--branch=develop"));
      assert.isTrue(
        yield* h.verifier.checkDeploy({ ...input, targetIds: [] }).pipe(Effect.isFailure),
      );
      assert.isTrue(
        yield* h.verifier
          .checkDeploy({ ...input, targetIds: ["production"] })
          .pipe(Effect.isFailure),
      );
    }).pipe(Effect.provide(dependencies), Effect.scoped),
);

it.effect(
  "verifies Railway services in the selected environment and keeps failed collectors blocking relevant work",
  () =>
    Effect.gen(function* () {
      const h = yield* fixture;
      yield* h.git(["merge", "--no-ff", "--no-edit", "assistant/APP-1"]);
      yield* h.git(["push", "origin", "develop"]);
      const deployed = yield* h.git(["rev-parse", "HEAD"]);
      const projectId = "00000000-0000-4000-8000-000000000001";
      const environmentId = "00000000-0000-4000-8000-000000000002";
      const webId = "00000000-0000-4000-8000-000000000003";
      const collectorId = "00000000-0000-4000-8000-000000000004";
      const input = {
        ...h.input,
        command: "",
        stagingUrl: "https://staging.example.test",
        targets: [
          {
            kind: "railway" as const,
            id: "web",
            railwayProjectId: projectId,
            environmentId,
            serviceId: webId,
          },
          {
            kind: "railway" as const,
            id: "collector",
            railwayProjectId: projectId,
            environmentId,
            serviceId: collectorId,
          },
        ],
      };
      const deployment = {
        id: "deployment",
        status: "SUCCESS",
        meta: { commitHash: deployed, branch: "develop" },
      };
      const service = (serviceId: string, status: string) => ({
        node: {
          serviceId,
          latestDeployment: { ...deployment, id: serviceId, status },
          activeDeployments: [{ ...deployment, id: serviceId, status }],
        },
      });
      const status = (envId: string, collectorStatus: string) => ({
        id: projectId,
        environments: {
          edges: [
            {
              node: {
                id: envId,
                serviceInstances: {
                  edges: [service(webId, "SUCCESS"), service(collectorId, collectorStatus)],
                },
              },
            },
          ],
        },
      });
      h.setReceipt({ code: 0, stdout: encodeJson(status(environmentId, "CRASHED")) });
      assert.equal((yield* h.verifier.checkDeploy(input)).outcome, "failed");
      // A UI-only issue may select web; collector changes must include the collector.
      const ui = verifiedDeployment(
        yield* h.verifier.checkDeploy({ ...input, targetIds: ["web"] }),
      );
      assert.deepEqual(
        ui?.evidence?.map((e) => e.targetId),
        ["web"],
      );
      h.setReceipt({ code: 0, stdout: encodeJson(status("other-environment", "SUCCESS")) });
      assert.equal((yield* h.verifier.checkDeploy(input)).outcome, "failed");
      const building = status(environmentId, "SUCCESS");
      building.environments.edges[0]!.node.serviceInstances.edges[0]!.node.latestDeployment.status =
        "DEPLOYING";
      assert.isTrue(
        yield* h.verifier
          .checkDeploy({ ...input, targetIds: ["web", "web"] })
          .pipe(Effect.isFailure),
      );
      h.setReceipt({ code: 0, stdout: encodeJson(building) });
      assert.equal((yield* h.verifier.checkDeploy(input)).outcome, "pending");
      h.setReceipt({ code: 0, stdout: encodeJson(status(environmentId, "SUCCESS")) });
      assert.lengthOf(verifiedDeployment(yield* h.verifier.checkDeploy(input))?.evidence ?? [], 2);
      assert.equal(h.checks[0]?.command, "railway");
      assert.isTrue(h.checks[0]?.args?.includes(`--environment=${environmentId}`));
    }).pipe(Effect.provide(dependencies), Effect.scoped),
);

it.effect("verifies the reviewed commit even when the shared worktree has stray files", () =>
  Effect.gen(function* () {
    const h = yield* fixture;
    yield* h.git(["merge", "--no-ff", "--no-edit", "assistant/APP-1"]);
    yield* h.git(["push", "origin", "develop"]);
    const deployed = yield* h.git(["rev-parse", "HEAD"]);
    h.setReceipt({
      code: 0,
      stdout: encodeJson({ revision: deployed, url: "https://staging.example.test" }),
    });
    // A test artifact nobody committed is not something the team leader can act on,
    // and the commit being verified is fixed by expectedRevision regardless.
    yield* h.fs.writeFileString(h.path.join(h.worktreePath, "screenshot.png"), "artifact");
    const result = verifiedDeployment(
      yield* h.verifier.checkDeploy({ ...h.input, expectedRevision: h.workerRevision }),
    );
    assert.equal(result?.revision, deployed);
    // Approvals still read HEAD strictly, so an unreviewed change cannot slip through.
    assert.isTrue(yield* h.verifier.revision(h.worktreePath).pipe(Effect.isFailure));
  }).pipe(Effect.provide(dependencies), Effect.scoped),
);

it.effect("separates a deployment that is behind from a git failure", () =>
  Effect.gen(function* () {
    const h = yield* fixture;
    // merge-base exits 1 here: the deployed commit is not on the branch at all.
    const early = yield* h.verifier.checkDeploy(h.input);
    assert.equal(early.outcome, "failed");
    assert.include(early.outcome === "failed" ? early.detail : "", "not on origin/develop");
    yield* h.git(["merge", "--no-ff", "--no-edit", "assistant/APP-1"]);
    yield* h.git(["push", "origin", "develop"]);
    // A deployment on the branch that predates the merge is simply behind.
    h.setReceipt({
      code: 0,
      stdout: encodeJson({ revision: h.initial, url: "https://staging.example.test" }),
    });
    const behind = yield* h.verifier.checkDeploy(h.input);
    assert.equal(behind.outcome, "pending");
    assert.include(
      behind.outcome === "pending" ? behind.detail : "",
      "Staging is still on an older commit",
    );
    // A revision the repository has never seen exits above 1: a real git failure.
    h.setReceipt({
      code: 0,
      stdout: encodeJson({ revision: "f".repeat(40), url: "https://staging.example.test" }),
    });
    const broken = yield* h.verifier.checkDeploy(h.input).pipe(Effect.flip);
    assert.include(broken.detail, "Git could not tell whether");
    // The same distinction keeps isMerged answering rather than failing.
    assert.isTrue(
      yield* h.verifier.isMerged({ cwd: h.cwd, revision: h.initial, baseBranch: "develop" }),
    );
  }).pipe(Effect.provide(dependencies), Effect.scoped),
);
