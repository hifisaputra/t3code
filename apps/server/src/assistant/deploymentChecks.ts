import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  AssistantDeployment,
  DeveloperAssistantError,
  type AssistantDeploymentTarget,
} from "@t3tools/contracts";
import { ProcessRunner, type ProcessRunError } from "../processRunner.ts";

const GitHubRuns = Schema.Array(
  Schema.Struct({
    headSha: AssistantDeployment.fields.revision,
    status: Schema.String,
    conclusion: Schema.NullOr(Schema.String),
    url: Schema.String,
  }),
);
const RailwayDeployment = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  meta: Schema.NullOr(
    Schema.Struct({
      commitHash: Schema.optionalKey(Schema.NullOr(Schema.String)),
      branch: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
});
const RailwayStatus = Schema.Struct({
  id: Schema.String,
  environments: Schema.Struct({
    edges: Schema.Array(
      Schema.Struct({
        node: Schema.Struct({
          id: Schema.String,
          serviceInstances: Schema.Struct({
            edges: Schema.Array(
              Schema.Struct({
                node: Schema.Struct({
                  serviceId: Schema.String,
                  latestDeployment: Schema.NullOr(RailwayDeployment),
                  activeDeployments: Schema.Array(RailwayDeployment),
                }),
              }),
            ),
          }),
        }),
      }),
    ),
  }),
});
/**
 * A process that never produced output: a CLI that is missing or unauthenticated,
 * a run that outlived its timeout, or one that flooded the pipe. `outputMode: "error"`
 * turns all three into a failure rather than a result, so the caller only ever sees
 * this through the error channel; saying which one it was is what the person can act on.
 */
export const processFailureDetail = (error: ProcessRunError, subject: string): string => {
  switch (error._tag) {
    case "ProcessSpawnError":
      return `${subject}: \`${error.command}\` could not be started. Install it on the T3 server, put it on PATH, and sign it in.`;
    case "ProcessTimeoutError":
      return `${subject}: \`${error.command}\` timed out after ${Math.round(error.timeoutMs / 1000)}s. Check the provider's availability and the server's network access.`;
    case "ProcessOutputLimitError":
      return `${subject}: \`${error.command}\` printed more than ${error.maxBytes} bytes on ${error.stream}. Narrow what the check reports.`;
    default:
      return `${subject}: \`${error.command}\` failed. ${error.message}`;
  }
};

const decodeGitHub = Schema.decodeUnknownEffect(Schema.fromJsonString(GitHubRuns));
const decodeRailway = Schema.decodeUnknownEffect(Schema.fromJsonString(RailwayStatus));
const decodeRevision = Schema.decodeUnknownEffect(AssistantDeployment.fields.revision);

/** How far back a busy branch is searched for the run that deployed a commit. */
const GITHUB_RUN_WINDOW = 20;
const short = (revision: string) => revision.slice(0, 7);

// These commands are fixed read operations. Proposed setup cannot introduce shell
// code into the server's process runner; custom scripts remain an explicit option.
export const checkDeployment = Effect.fn("Assistant.checkDeployment")(function* (
  target: AssistantDeploymentTarget,
  cwd: string,
  baseBranch: string,
  /** The commit the caller is waiting to see deployed. */
  expectedRevision: string,
) {
  const runner = yield* ProcessRunner;
  const result = yield* runner
    .run({
      command: target.kind === "github-actions" ? "gh" : "railway",
      args:
        target.kind === "github-actions"
          ? [
              "run",
              "list",
              `--repo=${target.repository}`,
              `--workflow=${target.workflow}`,
              `--branch=${baseBranch}`,
              `--limit=${GITHUB_RUN_WINDOW}`,
              "--json=headSha,status,conclusion,url",
            ]
          : [
              "status",
              `--project=${target.railwayProjectId}`,
              `--environment=${target.environmentId}`,
              "--json",
            ],
      cwd,
      timeout: "30 seconds",
      maxOutputBytes: 2_000_000,
      outputMode: "error",
    })
    // A missing, unauthenticated, slow or noisy CLI fails the run rather than
    // returning one, and each of those is a different thing to go and fix.
    .pipe(
      Effect.mapError(
        (error) =>
          new DeveloperAssistantError({
            detail: processFailureDetail(error, `Could not inspect ${target.id}`),
          }),
      ),
    );
  if (result.code !== 0)
    return yield* new DeveloperAssistantError({
      detail: `Could not inspect ${target.id}. Check the deployment CLI's authentication and access on the T3 server.`,
    });
  const unreadable = (detail: string) => new DeveloperAssistantError({ detail });
  if (target.kind === "github-actions") {
    const runs = yield* decodeGitHub(result.stdout).pipe(
      Effect.mapError(() =>
        unreadable(`${target.id}: T3 could not read what \`gh run list\` returned.`),
      ),
    );
    // gh lists newest first. Another merge on a busy branch puts someone else's
    // run at the front, so look for the run that built this commit before falling
    // back to the newest successful deployment; the caller checks by ancestry
    // whether that one already carries this commit.
    const own = runs.find((run) => run.headSha === expectedRevision);
    if (own && (own.status !== "completed" || own.conclusion !== "success"))
      return yield* new DeveloperAssistantError({
        detail: `${target.id}: the ${target.workflow} run for ${short(expectedRevision)} is ${own.conclusion ?? own.status}, not a successful deployment. Inspect pending, failed, or skipped deployments.`,
      });
    const run =
      own ?? runs.find((r) => r.status === "completed" && r.conclusion === "success") ?? null;
    if (!run)
      return yield* new DeveloperAssistantError({
        detail: runs.length
          ? `${target.id}: none of the last ${GITHUB_RUN_WINDOW} ${target.workflow} runs on ${baseBranch} succeeded, and none of them deployed ${short(expectedRevision)}. Inspect pending, failed, or skipped deployments.`
          : `${target.id}: ${target.workflow} has no runs on ${baseBranch} yet. ${short(expectedRevision)} is not deployed; wait for the deployment to start.`,
      });
    return { targetId: target.id, revision: run.headSha, reference: run.url };
  }
  const status = yield* decodeRailway(result.stdout).pipe(
    Effect.mapError(() =>
      unreadable(`${target.id}: T3 could not read what \`railway status\` returned.`),
    ),
  );
  const environment = status.environments.edges.find(
    (e) => e.node.id === target.environmentId,
  )?.node;
  const service = environment?.serviceInstances.edges.find(
    (s) => s.node.serviceId === target.serviceId,
  )?.node;
  const deployment = service?.latestDeployment;
  if (
    status.id !== target.railwayProjectId ||
    !deployment ||
    deployment.status !== "SUCCESS" ||
    deployment.meta?.branch !== baseBranch ||
    !deployment.meta.commitHash ||
    !service?.activeDeployments.some((d) => d.id === deployment.id && d.status === "SUCCESS")
  )
    return yield* new DeveloperAssistantError({
      detail: `${target.id}: the expected staging service has no successful active deployment from ${baseBranch}. Inspect its deployment and worker/cron status.`,
    });
  const revision = yield* decodeRevision(deployment.meta.commitHash).pipe(
    Effect.mapError(() =>
      unreadable(`${target.id}: Railway reported a deployment without a usable commit.`),
    ),
  );
  return { targetId: target.id, revision, reference: deployment.id };
});
