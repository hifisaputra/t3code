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

/** Which of the assistant's threads a section of the project instructions is written for. */
export const AssistantInstructionAudience = Schema.Literals([
  "assistant",
  "lead",
  "implement",
  "review",
  "e2e",
]);
export type AssistantInstructionAudience = typeof AssistantInstructionAudience.Type;

/**
 * Character budgets for the project instructions: the shared policy once
 * sections are present, each section, and everything together. The setup
 * refuses a plan over budget so that repository facts end up in repository
 * documents, which every thread can read, rather than in every prompt.
 */
export const ASSISTANT_INSTRUCTION_BUDGET = { shared: 4000, section: 6000, total: 20000 } as const;

const InstructionSection = Schema.String.check(
  Schema.isMaxLength(ASSISTANT_INSTRUCTION_BUDGET.section),
);
/**
 * What each of the assistant's threads is told beyond the shared policy. A
 * thread receives the policy and its own section only, so the tester's
 * credentials never reach the worker and the reviewer's standard never reaches
 * the tester.
 */
export const AssistantRoleInstructions = Schema.Struct({
  assistant: Schema.optionalKey(InstructionSection),
  lead: Schema.optionalKey(InstructionSection),
  implement: Schema.optionalKey(InstructionSection),
  review: Schema.optionalKey(InstructionSection),
  e2e: Schema.optionalKey(InstructionSection),
});
export type AssistantRoleInstructions = typeof AssistantRoleInstructions.Type;

/** A Claude Code skill name, as the composer's `$name` mention accepts it. */
export const AssistantSkillName = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/),
  Schema.isMaxLength(100),
);
/**
 * A skill from the repository's own `.claude/skills` per team role, invoked
 * with the role thread's first message so it carries the project's method for
 * that role. Repository skills are shared by every T3 instance working the
 * repository; a person's user-scope skills are not accepted.
 */
export const AssistantRoleSkills = Schema.Struct({
  lead: Schema.optionalKey(AssistantSkillName),
  implement: Schema.optionalKey(AssistantSkillName),
  review: Schema.optionalKey(AssistantSkillName),
  e2e: Schema.optionalKey(AssistantSkillName),
});
export type AssistantRoleSkills = typeof AssistantRoleSkills.Type;

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
  /**
   * The project's assistant policy. With `roleInstructions` present this is the
   * part every thread shares; on setups from before sections existed it is
   * everything, and goes to every thread as it is.
   */
  instructions: Schema.String.check(Schema.isMaxLength(ASSISTANT_INSTRUCTION_BUDGET.total)),
  roleInstructions: Schema.optionalKey(AssistantRoleInstructions),
  /**
   * The repository's own non-mutating check (lint, typecheck, tests), which T3
   * runs in the team's worktree when the worker requests review; a red run
   * refuses the request before a review round is spent. Absent or empty: T3
   * runs nothing and the reviewer runs the checks itself.
   */
  checkCommand: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))),
  roleSkills: Schema.optionalKey(AssistantRoleSkills),
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
/**
 * The project instructions one of the assistant's threads receives: the shared
 * policy, then the section written for that audience when the setup has one.
 * Empty when the setup has neither.
 */
export const assistantInstructionsFor = (
  config: Pick<AssistantProjectConfig, "instructions" | "roleInstructions">,
  audience: AssistantInstructionAudience,
): string =>
  [config.instructions.trim(), config.roleInstructions?.[audience]?.trim() ?? ""]
    .filter(Boolean)
    .join("\n\n");

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
  roleInstructions: AssistantProjectConfig.fields.roleInstructions,
  checkCommand: AssistantProjectConfig.fields.checkCommand,
  roleSkills: AssistantProjectConfig.fields.roleSkills,
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

/** Who holds the issue right now: one of its threads. */
export const AssistantTaskStage = Schema.Literals(["lead", "implement", "review", "e2e"]);
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

/**
 * The e2e test the team leader planned on taking the issue. T3 starts the
 * tester with it once staging verifies (or, in the worktree, once review
 * approves), so the leader is not woken for the handoff.
 */
export const AssistantE2ePlan = Schema.Struct({
  /** The tester brief: pages or endpoints affected, data it needs, what to clean up. */
  brief: Schema.String,
  /** The deployment targets the change affects; absent means all. */
  targetIds: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type AssistantE2ePlan = typeof AssistantE2ePlan.Type;

/**
 * What the implementer says the tester should test, given with its latest
 * review request. The approved commit's notes join the leader's plan in the
 * tester's brief; planChanged sends the start of e2e back to the leader.
 */
export const AssistantTestNotes = Schema.Struct({
  notes: Schema.String,
  /** The work differs from the leader's brief in a way the test depends on. */
  planChanged: Schema.Boolean,
  /** The commit the review request was for. */
  commit: CommitSha,
  at: IsoDateTime,
});
export type AssistantTestNotes = typeof AssistantTestNotes.Type;

/**
 * The issue's acceptance criteria as its team leader listed them when taking
 * it: each one a check a person could perform on the product. The worker and
 * reviewer see them numbered; the tester reports one result per criterion.
 */
export const AssistantCriteria = Schema.Array(
  TrimmedNonEmptyString.check(Schema.isMaxLength(300)),
).check(Schema.isMinLength(1), Schema.isMaxLength(12));
export type AssistantCriteria = typeof AssistantCriteria.Type;

export const AssistantE2eCheckResult = Schema.Literals(["passed", "failed", "not-checked"]);
export type AssistantE2eCheckResult = typeof AssistantE2eCheckResult.Type;
/** The tester's result for one criterion. */
export const AssistantE2eCheck = Schema.Struct({
  /** 1-based position in the task's criteria. */
  criterion: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 12 })),
  result: AssistantE2eCheckResult,
  /** What was done and seen; for a failure, expected versus actual. */
  evidence: Schema.String,
  /** 1-based position in the result's screenshots, when one proves it. */
  screenshot: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 12 }))),
});
export type AssistantE2eCheck = typeof AssistantE2eCheck.Type;

export const AssistantE2eVerdict = Schema.Literals(["passed", "partial", "failed"]);
export type AssistantE2eVerdict = typeof AssistantE2eVerdict.Type;
/**
 * The verdict the per-criterion results add up to: one failure fails the run,
 * otherwise anything left for a person makes it partial.
 */
export const assistantE2eVerdict = (
  checks: ReadonlyArray<Pick<AssistantE2eCheck, "result">>,
): AssistantE2eVerdict =>
  checks.some((check) => check.result === "failed")
    ? "failed"
    : checks.some((check) => check.result === "not-checked")
      ? "partial"
      : "passed";

export const AssistantE2eResult = Schema.Struct({
  verdict: AssistantE2eVerdict,
  report: Schema.String,
  /** One result per criterion; absent on runs of issues taken before criteria were recorded. */
  checks: Schema.optionalKey(Schema.Array(AssistantE2eCheck)),
  /** What a person should still check on staging before accepting. */
  humanChecks: Schema.Array(Schema.String),
  /**
   * What the tester wants the person to look at that is not a failure: leftover
   * wording, inconsistencies, odd behavior outside the criteria. Absent when none.
   */
  worthALook: Schema.optionalKey(Schema.Array(Schema.String)),
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

/** A run of the project's check command, recorded with the review request it gated. */
export const AssistantCheckRun = Schema.Struct({
  command: Schema.String,
  commit: CommitSha,
  exitCode: Schema.Int,
  /** The end of the combined output, at most 8,000 characters. */
  output: Schema.String,
  at: IsoDateTime,
});
export type AssistantCheckRun = typeof AssistantCheckRun.Type;

/**
 * A staging deploy T3 watches for the team leader: which targets (null for
 * all), for which merged commit, since when, how many checks so far, and what
 * the last check reported. The leader hears once it verifies, fails or times out.
 */
export const AssistantDeployWait = Schema.Struct({
  targetIds: Schema.NullOr(Schema.Array(Schema.String)),
  commit: CommitSha,
  since: IsoDateTime,
  checks: Schema.Int,
  detail: Schema.String,
});
export type AssistantDeployWait = typeof AssistantDeployWait.Type;

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
  /** Always true: every issue runs with a team leader. Kept so stored tasks decode. */
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
  /** Listed by the team leader on taking the issue; absent on issues taken before then. */
  criteria: Schema.optionalKey(AssistantCriteria),
  /** The last run of the project's check command for a review request. */
  checks: Schema.optionalKey(Schema.NullOr(AssistantCheckRun)),
  /** The staging deploy T3 is watching for the team leader, while it lasts. */
  deployWait: Schema.optionalKey(Schema.NullOr(AssistantDeployWait)),
  /**
   * The e2e test planned when the issue was taken. Absent on issues taken
   * before then: their leader is woken to verify staging and start e2e itself.
   */
  e2ePlan: Schema.optionalKey(Schema.NullOr(AssistantE2ePlan)),
  /** The implementer's test notes from its latest review request. */
  testNotes: Schema.optionalKey(Schema.NullOr(AssistantTestNotes)),
  /**
   * When T3 closed the team: every thread settled and the worktree removed (or
   * kept by git for uncommitted changes). Absent while a delivered or declined
   * issue's team is still open, and on issues closed before this was recorded.
   */
  teamClosedAt: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
  /**
   * The team's Linear agent session, while the Linear app is connected: one the
   * team opened itself, or the delegation it was started from.
   */
  linearSession: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({ id: Schema.String, origin: Schema.Literals(["delegated", "created"]) }),
    ),
  ),
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

/** What an assistant thread does: a setup conversation or one of an issue's threads. */
export type AssistantThreadKind = "setup" | AssistantThreadRole;

const ISSUE_THREAD_ID = /^assistant-(work|review|e2e|lead|setup)-/;
const TEAM_THREAD_ID = /^assistant-(work|review|e2e|lead)-(.+)$/;

/**
 * The managed issue one of a team's threads belongs to, and which of its
 * threads it is, read from the id the server assigns (see
 * assistantTaskThreadId). Null for a setup conversation and every thread that
 * is not the assistant's.
 */
export const assistantTeamThread = (
  threadId: string,
): { readonly taskId: string; readonly role: AssistantThreadRole } | null => {
  const match = TEAM_THREAD_ID.exec(threadId);
  if (!match) return null;
  return {
    taskId: match[2]!,
    role: match[1] === "work" ? "implement" : (match[1] as "review" | "e2e" | "lead"),
  };
};

/** Read from the thread id the server assigns, so a thread list needs no board to label its rows. */
export const assistantThreadKind = (threadId: string): AssistantThreadKind | null => {
  const match = ISSUE_THREAD_ID.exec(threadId);
  if (match)
    return match[1] === "work" ? "implement" : (match[1] as "review" | "e2e" | "lead" | "setup");
  return null;
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
  status: AssistantProjectStatus,
  error: Schema.NullOr(Schema.String),
  /**
   * The provider's usage limit stopped one of the project's threads. Until this
   * time nothing is sent to its threads and no team starts; then the stopped
   * threads are told to continue. Absent or null when no limit is in force.
   */
  limitedUntil: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
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

export type PipelineStepKey = "take" | "code" | "review" | "merge" | "staging" | "e2e";
export type PipelineStepState = "done" | "current" | "failed" | "todo";

export interface PipelineStep {
  readonly key: PipelineStepKey;
  readonly label: string;
  /** The thread that does this step. */
  readonly kind: AssistantThreadKind;
  readonly state: PipelineStepState;
  readonly note: string | null;
}

export type PipelineStepDef = {
  readonly key: PipelineStepKey;
  readonly label: string;
  readonly kind: AssistantThreadKind;
};

export const TO_STAGING: ReadonlyArray<PipelineStepDef> = [
  { key: "code", label: "Code", kind: "implement" },
  { key: "review", label: "Code review", kind: "review" },
  { key: "merge", label: "Merge", kind: "implement" },
  { key: "staging", label: "Staging", kind: "lead" },
  { key: "e2e", label: "E2E test", kind: "e2e" },
];
// With the e2e check in the team's worktree it runs on the approved commit,
// before the merge; staging is then only the deploy to verify.
export const TO_STAGING_WORKTREE_E2E: ReadonlyArray<PipelineStepDef> = [
  { key: "code", label: "Code", kind: "implement" },
  { key: "review", label: "Code review", kind: "review" },
  { key: "e2e", label: "E2E test", kind: "e2e" },
  { key: "merge", label: "Merge", kind: "implement" },
  { key: "staging", label: "Staging", kind: "lead" },
];
export const TAKE_ON: PipelineStepDef = { key: "take", label: "Take on", kind: "lead" };
export const LED_PIPELINE: ReadonlyArray<PipelineStepDef> = [TAKE_ON, ...TO_STAGING];
export const LED_WORKTREE_PIPELINE: ReadonlyArray<PipelineStepDef> = [
  TAKE_ON,
  ...TO_STAGING_WORKTREE_E2E,
];

/**
 * Where an issue is on its way to staging, from what the server recorded.
 * Work started before issues had review and e2e threads has no pipeline.
 */
export function assistantTaskPipeline(task: AssistantTask): ReadonlyArray<PipelineStep> | null {
  if (task.stage === undefined) return null;
  const inWorktree = assistantTaskE2eEnvironment(task) === "worktree";
  const steps = inWorktree ? LED_WORKTREE_PIPELINE : LED_PIPELINE;
  const offset = 1;
  const approved = task.codeReview?.verdict === "approved";
  const e2eFailed = task.e2e?.verdict === "failed";
  const e2ePassed = Boolean(task.e2e) && !e2eFailed;
  const at = (() => {
    if (task.status === "review" || task.status === "accepted") return steps.length;
    if (task.stage === "lead" && task.turns === 0) return 0;
    if (inWorktree)
      switch (task.stage) {
        case "review":
          return offset + 1;
        case "e2e":
          return offset + 2;
        // The worker merges the approved commit once the worktree run passed;
        // sent back after that, it is coding again.
        case "implement":
          return offset + (approved && e2ePassed && !task.merge ? 3 : 0);
        case "lead":
          // A failed run keeps the issue on its step while the leader decides.
          if (e2eFailed) return offset + 2;
          if (task.deployment) return steps.length;
          if (task.merge) return offset + 4;
          if (e2ePassed) return offset + 3;
          return offset + (approved ? 2 : 0);
      }
    switch (task.stage) {
      case "review":
        return offset + 1;
      case "e2e":
        return offset + 4;
      // Back with the worker after a failed e2e run, the earlier approval,
      // merge and deployment are still on record; it is coding again.
      case "implement":
        return offset + (approved && !task.merge ? 2 : 0);
      case "lead":
        return offset + (task.deployment ? 4 : task.merge ? 3 : approved ? 2 : 0);
    }
  })();
  const stepAt = (key: PipelineStepKey) => steps.findIndex((step) => step.key === key);
  const codeAt = stepAt("code");
  const e2eAt = stepAt("e2e");
  const stagingAt = stepAt("staging");
  const changesRequested = task.codeReview?.verdict === "changes-requested";
  const notes: Partial<Record<PipelineStepKey, string>> = {
    ...(changesRequested && at === codeAt
      ? { code: "Fixing review findings", review: "Changes requested" }
      : {}),
    ...(e2eFailed && at === codeAt ? { code: "Fixing the e2e failure" } : {}),
    ...(task.deployment && at > stagingAt
      ? { staging: `${task.deployment.revision.slice(0, 7)} deployed` }
      : {}),
    ...(task.e2e && at >= e2eAt && task.stage !== "e2e"
      ? {
          e2e: e2eFailed
            ? inWorktree
              ? "Failed in the worktree"
              : "Failed on staging"
            : task.e2e.verdict === "partial"
              ? "Passed, with checks for you"
              : "Passed",
        }
      : {}),
  };
  return steps.map((step, index) => ({
    ...step,
    state:
      index < at
        ? "done"
        : index > at
          ? "todo"
          : step.key === "e2e" && e2eFailed && task.stage === "lead"
            ? "failed"
            : "current",
    note: notes[step.key] ?? null,
  }));
}

export type AssistantLinearPlanStatus = "pending" | "inProgress" | "completed" | "canceled";

export interface AssistantLinearPlanStep {
  readonly content: string;
  readonly status: AssistantLinearPlanStatus;
}

/** The last step of every plan: the person accepts the work or sends it back. */
export const ASSISTANT_LINEAR_PLAN_CHECK = "Your check";

/**
 * The checklist a Linear agent session shows for a managed issue: the steps of
 * its pipeline, then the person's own check. An issue declined or skipped
 * cancels the steps it never finished. Empty for work with no pipeline.
 */
export function assistantLinearPlan(task: AssistantTask): ReadonlyArray<AssistantLinearPlanStep> {
  const pipeline = assistantTaskPipeline(task);
  if (pipeline === null) return [];
  const ended = task.status === "declined" || task.status === "skipped";
  const steps = pipeline.map((step): AssistantLinearPlanStep => {
    const label = step.state === "failed" ? `${step.label} (failed)` : step.label;
    const content = step.note ? `${label}: ${step.note}` : label;
    if (step.state === "done") return { content, status: "completed" };
    if (ended) return { content, status: "canceled" };
    return { content, status: step.state === "todo" ? "pending" : "inProgress" };
  });
  const check: AssistantLinearPlanStatus =
    task.status === "accepted"
      ? "completed"
      : task.status === "review"
        ? "inProgress"
        : ended
          ? "canceled"
          : "pending";
  return [...steps, { content: ASSISTANT_LINEAR_PLAN_CHECK, status: check }];
}
