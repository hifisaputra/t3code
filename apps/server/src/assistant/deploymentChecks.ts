import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  AssistantDeployment,
  DeveloperAssistantError,
  type AssistantDeploymentTarget,
} from "@t3tools/contracts";
import { ProcessRunner } from "../processRunner.ts";

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
const decodeGitHub = Schema.decodeUnknownEffect(Schema.fromJsonString(GitHubRuns));
const decodeRailway = Schema.decodeUnknownEffect(Schema.fromJsonString(RailwayStatus));
const decodeRevision = Schema.decodeUnknownEffect(AssistantDeployment.fields.revision);

// These commands are fixed read operations. Proposed setup cannot introduce shell
// code into the server's process runner; custom scripts remain an explicit option.
export const checkDeployment = Effect.fn("Assistant.checkDeployment")(function* (
  target: AssistantDeploymentTarget,
  cwd: string,
  baseBranch: string,
) {
  const runner = yield* ProcessRunner;
  const result = yield* runner.run({
    command: target.kind === "github-actions" ? "gh" : "railway",
    args:
      target.kind === "github-actions"
        ? [
            "run",
            "list",
            `--repo=${target.repository}`,
            `--workflow=${target.workflow}`,
            `--branch=${baseBranch}`,
            "--limit=1",
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
  });
  if (result.code !== 0 || result.timedOut || result.stdoutTruncated)
    return yield* new DeveloperAssistantError({
      detail: `Could not inspect ${target.id}. Check the deployment CLI's authentication and access on the T3 server.`,
    });
  if (target.kind === "github-actions") {
    const runs = yield* decodeGitHub(result.stdout);
    const run = runs[0];
    if (!run || run.status !== "completed" || run.conclusion !== "success")
      return yield* new DeveloperAssistantError({
        detail: `${target.id}: the latest staging workflow has not succeeded. Inspect pending, failed, or skipped deployments.`,
      });
    return { targetId: target.id, revision: run.headSha, reference: run.url };
  }
  const status = yield* decodeRailway(result.stdout);
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
  const revision = yield* decodeRevision(deployment.meta.commitHash);
  return { targetId: target.id, revision, reference: deployment.id };
});
