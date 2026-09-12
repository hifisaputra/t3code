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
  stagingCheckCommand: TrimmedNonEmptyString,
  reviewState: Schema.String,
  acceptedState: Schema.String,
  maxWorkerTurns: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 30 })),
});
export type AssistantProjectConfig = typeof AssistantProjectConfig.Type;

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
  url: Schema.String.check(Schema.isPattern(/^https?:\/\//)),
  verifiedAt: IsoDateTime,
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
