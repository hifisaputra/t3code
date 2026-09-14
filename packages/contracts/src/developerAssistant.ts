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

/**
 * Where the e2e tester exercises a change. `staging`: after the reviewed
 * commit is merged and deployed, on the staging deployment. `worktree`: in the
 * team's own worktree before the merge, on the commit code review approved;
 * staging is then only checked for the deploy once the merge lands.
 */
export const AssistantE2eEnvironment = Schema.Literals(["staging", "worktree"]);
export type AssistantE2eEnvironment = typeof AssistantE2eEnvironment.Type;

export const AssistantProjectConfig = Schema.Struct({
  projectId: ProjectId,
  linearProjectId: TrimmedNonEmptyString,
  /** The loop takes only issues assigned to the connected Linear user. */
  assignedToMe: Schema.Boolean,
  /**
   * The loop takes ready issues from Linear by itself. When false, the
   * assistant works only on issues the person dispatches. Absent on setups
   * from before the start options existed, which means true.
   */
  autoPick: Schema.optionalKey(Schema.Boolean),
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
  /** Absent on setups from before the choice existed, which means staging. */
  e2eEnvironment: Schema.optionalKey(AssistantE2eEnvironment),
  /**
   * How many issues the loop works at once, each with its own team and
   * worktree. Absent on setups from before it existed, which means one.
   */
  parallelIssues: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 6 })),
  ),
});
export type AssistantProjectConfig = typeof AssistantProjectConfig.Type;

/** Whether the loop picks ready issues from Linear itself; see AssistantProjectConfig.autoPick. */
export const assistantPicksIssues = (config: Pick<AssistantProjectConfig, "autoPick">): boolean =>
  config.autoPick !== false;
/** Where the e2e check runs; see AssistantProjectConfig.e2eEnvironment. */
export const assistantE2eEnvironment = (
  config: Pick<AssistantProjectConfig, "e2eEnvironment">,
): AssistantE2eEnvironment => config.e2eEnvironment ?? "staging";
/** How many issues the loop works at once; see AssistantProjectConfig.parallelIssues. */
export const assistantParallelIssues = (
  config: Pick<AssistantProjectConfig, "parallelIssues">,
): number => config.parallelIssues ?? 1;

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
  e2eEnvironment: AssistantProjectConfig.fields.e2eEnvironment,
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

/**
 * `queued`: the person picked the issue to go next. `declined`: its team leader
 * did not take it; the loop leaves it until someone changes the issue.
 */
export const AssistantTaskStatus = Schema.Literals([
  "queued",
  "preparing",
  "working",
  "waiting",
  "blocked",
  "review",
  "accepted",
  "changes-requested",
  "skipped",
  "declined",
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

/**
 * Each issue runs as a team on one worktree: a team leader that decides whether
 * to take it and makes the calls, the implementation worker, a code reviewer
 * that trades rounds with it directly, and an e2e tester that exercises staging
 * once the reviewed commit is deployed.
 */
export const AssistantThreadRole = Schema.Literals(["lead", "implement", "review", "e2e"]);
export type AssistantThreadRole = typeof AssistantThreadRole.Type;

/**
 * Who holds the issue right now: one of its threads. `coordinator` is work
 * started before issues had team leaders, held by the developer assistant.
 */
export const AssistantTaskStage = Schema.Literals([
  "lead",
  "implement",
  "review",
  "coordinator",
  "e2e",
]);
export type AssistantTaskStage = typeof AssistantTaskStage.Type;

/** Why a team leader did not take an issue, and the issue as it stood then. */
export const AssistantDecline = Schema.Struct({
  reason: Schema.String,
  /** The issue's content without T3's own comments; the issue is eligible again once it differs. */
  fingerprint: Schema.String,
  /** Linear's updatedAt when last compared, so an unchanged issue is not re-read. */
  issueUpdatedAt: Schema.String,
  at: IsoDateTime,
});
export type AssistantDecline = typeof AssistantDecline.Type;

const CommitSha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40,64}$/));

export const AssistantCodeReview = Schema.Struct({
  verdict: Schema.Literals(["approved", "changes-requested"]),
  /** The findings as sent to the implementer. */
  findings: Schema.String,
  /** A short account for the Linear update: what was checked, non-blocking notes. */
  summary: Schema.String,
  /** The worktree HEAD the verdict covers; any later commit needs another review. */
  commit: CommitSha,
  at: IsoDateTime,
});
export type AssistantCodeReview = typeof AssistantCodeReview.Type;

export const AssistantMerge = Schema.Struct({
  commit: CommitSha,
  /** What changed, written by the implementer for people who read the issue. */
  summary: Schema.String,
  at: IsoDateTime,
});
export type AssistantMerge = typeof AssistantMerge.Type;

export const AssistantE2eResult = Schema.Struct({
  verdict: Schema.Literals(["passed", "partial", "failed"]),
  report: Schema.String,
  /** What a person should still check on staging before accepting. */
  humanChecks: Schema.Array(Schema.String),
  screenshots: Schema.Array(Schema.Struct({ url: Schema.String, caption: Schema.String })),
  at: IsoDateTime,
  /** Where the run happened; absent on results from before the worktree option. */
  environment: Schema.optionalKey(AssistantE2eEnvironment),
  /** The worktree commit a run in the worktree tested; the merge must be of this commit. */
  commit: Schema.optionalKey(CommitSha),
});
export type AssistantE2eResult = typeof AssistantE2eResult.Type;

/**
 * A team leader's assistant_wait: what it waits for, how many checks so far,
 * and whether T3 has already told it to check again for the latest call.
 */
export const AssistantWait = Schema.Struct({
  reason: Schema.String,
  checks: Schema.Int,
  notified: Schema.Boolean,
});
export type AssistantWait = typeof AssistantWait.Type;

export const AssistantTask = Schema.Struct({
  id: TrimmedNonEmptyString,
  projectId: ProjectId,
  issue: LinearIssueSummary,
  /** The implementation thread; see assistantTaskThreadId for the others. */
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
  // Absent on work started before issues had review and e2e threads.
  stage: Schema.optionalKey(AssistantTaskStage),
  codeReview: Schema.optionalKey(Schema.NullOr(AssistantCodeReview)),
  merge: Schema.optionalKey(Schema.NullOr(AssistantMerge)),
  e2e: Schema.optionalKey(Schema.NullOr(AssistantE2eResult)),
  /** Comments T3 posted on the issue, so a person's later reply is told apart from them. */
  linearCommentIds: Schema.optionalKey(Schema.Array(Schema.String)),
  /** The Linear state the issue was left in on delivery; moving it elsewhere is a decision. */
  deliveredState: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** Run by a team leader. Earlier work reports to the developer assistant instead. */
  leader: Schema.optionalKey(Schema.Boolean),
  /** Picked by the person rather than the loop: its team leader takes it or asks, never declines. */
  dispatched: Schema.optionalKey(Schema.Boolean),
  declined: Schema.optionalKey(AssistantDecline),
  /**
   * Which of the project's concurrent teams this is: the smallest number, from
   * 0, that no other active team of the project holds. Project instructions
   * derive per-team resources such as development server ports from it.
   */
  slot: Schema.optionalKey(Schema.Int),
  /** The team leader's wait on something outside T3 (a deploy, CI), while it lasts. */
  wait: Schema.optionalKey(Schema.NullOr(AssistantWait)),
  /**
   * Where this issue's e2e check runs, fixed when its team starts so a setup
   * change mid-issue does not move the goalposts. Absent means staging.
   */
  e2eEnvironment: Schema.optionalKey(AssistantE2eEnvironment),
});
export type AssistantTask = typeof AssistantTask.Type;

/** Where a managed issue's e2e check runs; see AssistantTask.e2eEnvironment. */
export const assistantTaskE2eEnvironment = (
  task: Pick<AssistantTask, "e2eEnvironment">,
): AssistantE2eEnvironment => task.e2eEnvironment ?? "staging";

export const assistantTaskThreadId = (
  task: Pick<AssistantTask, "id" | "threadId">,
  role: AssistantThreadRole,
): ThreadId =>
  role === "implement" ? task.threadId : ThreadId.make(`assistant-${role}-${task.id}`);

/** What an assistant thread does: the project's developer assistant, a setup conversation, or one of an issue's threads. */
export type AssistantThreadKind = "coordinator" | "setup" | AssistantThreadRole;

const ISSUE_THREAD_ID = /^assistant-(work|review|e2e|lead|setup)-/;
const COORDINATOR_THREAD_ID = /^assistant-[0-9a-f]{8}-[0-9a-f]{4}-/;

/** Read from the thread id the server assigns, so a thread list needs no board to label its rows. */
export const assistantThreadKind = (threadId: string): AssistantThreadKind | null => {
  const match = ISSUE_THREAD_ID.exec(threadId);
  if (match)
    return match[1] === "work" ? "implement" : (match[1] as "review" | "e2e" | "lead" | "setup");
  return COORDINATOR_THREAD_ID.test(threadId) ? "coordinator" : null;
};

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

/**
 * running: the loop gives issues to teams. paused: the loop takes nothing new,
 * but teams at work and issues the person dispatches still run. stopped:
 * nothing runs until the person resumes.
 */
export const AssistantProjectStatus = Schema.Literals(["running", "paused", "stopped"]);
export type AssistantProjectStatus = typeof AssistantProjectStatus.Type;

export const AssistantProject = Schema.Struct({
  config: AssistantProjectConfig,
  threadId: ThreadId,
  status: AssistantProjectStatus,
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

/** What the person chose on the Start button; saved to the project's config. */
export const AssistantStartOptions = Schema.Struct({
  /** Pick ready issues from Linear; off means only dispatched issues run. */
  autoPick: Schema.Boolean,
  /** Only issues assigned to the connected user; off takes the project's other issues too. */
  assignedToMe: Schema.Boolean,
  /** How many issues to work at once; earlier clients send none and keep the config as it is. */
  parallelIssues: Schema.optionalKey(AssistantProjectConfig.fields.parallelIssues),
});
export type AssistantStartOptions = typeof AssistantStartOptions.Type;

export const AssistantControlInput = Schema.Struct({
  projectId: ProjectId,
  // "stop" is what earlier clients send for "pause".
  action: Schema.Literals(["start", "pause", "stop", "interrupt", "wake"]),
  /** Read on "start" only; earlier clients send none and keep the config as it is. */
  options: Schema.optionalKey(AssistantStartOptions),
});
/** The person gives one issue to the next team, ahead of the loop's own picks. */
export const AssistantDispatchInput = Schema.Struct({
  projectId: ProjectId,
  reference: TrimmedNonEmptyString,
  note: Schema.String,
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
