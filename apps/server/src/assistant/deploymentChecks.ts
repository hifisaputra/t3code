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

/**
 * What a target says about a commit: the deployment it is serving, a deploy
 * that has not arrived yet, or one that will not arrive without someone acting.
 * T3 waits on the first and hands the second to the issue's team leader, so
 * only a broken CLI, a rejected login or unreadable output fails the check.
 */
export type DeploymentCheck =
  | {
      readonly outcome: "deployed";
      readonly targetId: string;
      readonly revision: string;
      readonly reference: string;
    }
  | { readonly outcome: "pending"; readonly detail: string }
  | { readonly outcome: "failed"; readonly detail: string };

const pending = (detail: string): DeploymentCheck => ({ outcome: "pending", detail });
const failed = (detail: string): DeploymentCheck => ({ outcome: "failed", detail });
const deployed = (targetId: string, revision: string, reference: string): DeploymentCheck => ({
  outcome: "deployed",
  targetId,
  revision,
  reference,
});
/** Railway statuses that mean the deploy is still on its way. */
const RAILWAY_PENDING = new Set(["BUILDING", "DEPLOYING", "QUEUED", "INITIALIZING", "WAITING"]);
/** Railway statuses that mean this deploy will not serve the commit. */
const RAILWAY_FAILED = new Set(["FAILED", "CRASHED", "REMOVED"]);

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
    if (own && own.status !== "completed")
      return pending(
        `${target.id}: the ${target.workflow} run for ${short(expectedRevision)} is ${own.status}.`,
      );
    if (own && own.conclusion !== "success")
      return failed(
        `${target.id}: the ${target.workflow} run for ${short(expectedRevision)} completed as ${own.conclusion ?? "unknown"}, not a successful deployment. Inspect the run.`,
      );
    const run =
      own ?? runs.find((r) => r.status === "completed" && r.conclusion === "success") ?? null;
    if (!run)
      return pending(
        runs.length
          ? `${target.id}: none of the last ${GITHUB_RUN_WINDOW} ${target.workflow} runs on ${baseBranch} succeeded, and none of them deployed ${short(expectedRevision)}.`
          : `${target.id}: ${target.workflow} has no runs on ${baseBranch} yet, so ${short(expectedRevision)} is not deployed.`,
      );
    return deployed(target.id, run.headSha, run.url);
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
  if (status.id !== target.railwayProjectId || !service)
    return failed(
      `${target.id}: the configured Railway project, environment and service do not name a service. Check the saved deployment target.`,
    );
  if (!deployment) return pending(`${target.id}: the staging service has no deployment yet.`);
  if (RAILWAY_PENDING.has(deployment.status))
    return pending(`${target.id}: its latest Railway deployment is ${deployment.status}.`);
  if (RAILWAY_FAILED.has(deployment.status))
    return failed(
      `${target.id}: its latest Railway deployment is ${deployment.status}. Inspect its deployment and worker/cron status.`,
    );
  if (
    deployment.status !== "SUCCESS" ||
    !service.activeDeployments.some((d) => d.id === deployment.id && d.status === "SUCCESS")
  )
    return failed(
      `${target.id}: the expected staging service has no successful active deployment. Inspect its deployment and worker/cron status.`,
    );
  // Another branch's deploy is in front of this commit's; ancestry decides the rest.
  if (deployment.meta?.branch !== baseBranch)
    return pending(
      `${target.id}: its latest successful deployment is from ${deployment.meta?.branch ?? "an unnamed branch"}, not ${baseBranch}.`,
    );
  if (!deployment.meta.commitHash)
    return pending(`${target.id}: its latest successful deployment names no commit yet.`);
  const revision = yield* decodeRevision(deployment.meta.commitHash).pipe(
    Effect.mapError(() =>
      unreadable(`${target.id}: Railway reported a deployment without a usable commit.`),
    ),
  );
  return deployed(target.id, revision, deployment.id);
});
