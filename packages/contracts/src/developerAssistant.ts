import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection, RuntimeMode } from "./orchestration.ts";
import { LinearIssueSummary } from "./linear.ts";

export class DeveloperAssistantError extends Schema.TaggedErrorClass<DeveloperAssistantError>()(
  "DeveloperAssistantError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

const ReviewUrl = Schema.String.check(Schema.isPattern(/^https?:\/\//));
export const AssistantDeploymentTarget = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("github-actions"),
    id: TrimmedNonEmptyString,
    repository: Schema.String.check(Schema.isPattern(/^[\w.-]+\/[\w.-]+$/)),
    workflow: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("railway"),
    id: TrimmedNonEmptyString,
    railwayProjectId: Schema.String.check(Schema.isUUID()),
    environmentId: Schema.String.check(Schema.isUUID()),
    serviceId: Schema.String.check(Schema.isUUID()),
  }),
]);
export type AssistantDeploymentTarget = typeof AssistantDeploymentTarget.Type;

export const AssistantProjectConfig = Schema.Struct({
  projectId: ProjectId,
  linearProjectId: TrimmedNonEmptyString,
  assignedToMe: Schema.Boolean,
  readyStates: Schema.Array(TrimmedNonEmptyString),
  modelSelection: ModelSelection,
  workerModelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  baseBranch: TrimmedNonEmptyString,
  instructions: Schema.String.check(Schema.isMaxLength(20000)),
  stagingCheckCommand: Schema.String,
  stagingUrl: Schema.optionalKey(ReviewUrl),
  deploymentTargets: Schema.optionalKey(Schema.Array(AssistantDeploymentTarget)),
  reviewState: Schema.String,
  acceptedState: Schema.String,
  maxWorkerTurns: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 30 })),
});
export type AssistantProjectConfig = typeof AssistantProjectConfig.Type;

export const AssistantSetupInput = Schema.Struct({
  projectId: ProjectId,
  linearProjectId: TrimmedNonEmptyString,
  assignedToMe: Schema.Boolean,
  modelSelection: ModelSelection,
  workerModelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  // Permissions for the setup conversation itself; setups begun before this
  // choice existed ran supervised.
  setupRuntimeMode: RuntimeMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("approval-required" as const)),
  ),
  context: Schema.String.check(Schema.isMaxLength(20000)),
});
export type AssistantSetupInput = typeof AssistantSetupInput.Type;

export const AssistantSetupPlan = Schema.Struct({
  baseBranch: AssistantProjectConfig.fields.baseBranch,
  readyStates: AssistantProjectConfig.fields.readyStates,
  instructions: AssistantProjectConfig.fields.instructions,
  stagingCheckCommand: AssistantProjectConfig.fields.stagingCheckCommand,
  stagingUrl: AssistantProjectConfig.fields.stagingUrl,
  deploymentTargets: AssistantProjectConfig.fields.deploymentTargets,
  reviewState: AssistantProjectConfig.fields.reviewState,
  acceptedState: AssistantProjectConfig.fields.acceptedState,
  maxWorkerTurns: AssistantProjectConfig.fields.maxWorkerTurns,
});
export type AssistantSetupPlan = typeof AssistantSetupPlan.Type;

export const AssistantSetup = Schema.Struct({
  preferences: AssistantSetupInput,
  threadId: ThreadId,
  proposal: Schema.NullOr(AssistantProjectConfig),
  summary: Schema.String,
  revision: Schema.Int,
});
export type AssistantSetup = typeof AssistantSetup.Type;
export const AssistantSetupResolveInput = Schema.Struct({
  threadId: ThreadId,
  action: Schema.Literals(["save", "cancel"]),
  revision: Schema.Int,
});

export const AssistantTaskStatus = Schema.Literals([
  "preparing",
  "working",
  "waiting",
  "blocked",
  "review",
  "accepted",
  "changes-requested",
  "skipped",
]);
export type AssistantTaskStatus = typeof AssistantTaskStatus.Type;

export const AssistantDeployment = Schema.Struct({
  revision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40,64}$/)),
  url: ReviewUrl,
  verifiedAt: IsoDateTime,
  evidence: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        targetId: Schema.String,
        revision: Schema.String,
        reference: Schema.String,
      }),
    ),
  ),
});
export type AssistantDeployment = typeof AssistantDeployment.Type;

export const AssistantTask = Schema.Struct({
  id: TrimmedNonEmptyString,
  projectId: ProjectId,
  issue: LinearIssueSummary,
  threadId: ThreadId,
  status: AssistantTaskStatus,
  brief: Schema.String,
  summary: Schema.String,
  reviewInstructions: Schema.String,
  feedback: Schema.String,
  turns: Schema.Int,
  turnLimit: Schema.Int,
  deployment: Schema.NullOr(AssistantDeployment),
  error: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type AssistantTask = typeof AssistantTask.Type;

export const AssistantDecision = Schema.Struct({
  id: TrimmedNonEmptyString,
  projectId: ProjectId,
  threadId: ThreadId,
  taskId: Schema.NullOr(Schema.String),
  requestId: Schema.NullOr(Schema.String),
  kind: Schema.Literals(["decision", "user-input", "approval"]),
  question: Schema.String,
  answer: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
});
export type AssistantDecision = typeof AssistantDecision.Type;

export const AssistantProject = Schema.Struct({
  config: AssistantProjectConfig,
  threadId: ThreadId,
  status: Schema.Literals(["running", "stopped"]),
  error: Schema.NullOr(Schema.String),
});
export type AssistantProject = typeof AssistantProject.Type;

export const AssistantBoard = Schema.Struct({
  setups: Schema.optionalKey(Schema.Array(AssistantSetup)),
  projects: Schema.Array(AssistantProject),
  tasks: Schema.Array(AssistantTask),
  decisions: Schema.Array(AssistantDecision),
});
export type AssistantBoard = typeof AssistantBoard.Type;

export const AssistantControlInput = Schema.Struct({
  projectId: ProjectId,
  action: Schema.Literals(["start", "stop", "interrupt", "wake"]),
});
export const AssistantAnswerInput = Schema.Struct({
  decisionId: TrimmedNonEmptyString,
  answer: TrimmedNonEmptyString,
});
export const AssistantReviewInput = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  action: Schema.Literals(["accept", "request-changes", "skip", "retry"]),
  feedback: Schema.String,
});

export const assistantTaskHoldsProject = (status: AssistantTaskStatus): boolean =>
  status === "preparing" || status === "working" || status === "waiting" || status === "blocked";
