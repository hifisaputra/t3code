import * as Schema from "effect/Schema";
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Linear issues as T3 Code shows them. Every field here is fetched live from
 * Linear by the server; nothing is mirrored into the database. The only thing a
 * thread stores is the link (`ThreadLinkedIssue` in orchestration.ts), which is
 * why the identifier and the URL are the load-bearing fields on the summary.
 */

/** An issue identifier such as `DEL-123`, or a Linear issue id (UUID). */
export const LinearIssueReference = TrimmedNonEmptyString;
export type LinearIssueReference = typeof LinearIssueReference.Type;

/**
 * Linear's workflow state types. `duplicate` is the closed-as-duplicate state
 * every team carries; it counts as finished, like `completed` and `canceled`.
 */
export const LinearWorkflowStateType = Schema.Literals([
  "triage",
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
  "duplicate",
]);
export type LinearWorkflowStateType = typeof LinearWorkflowStateType.Type;

export const LinearWorkflowState = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  type: LinearWorkflowStateType,
  /** Hex colour from Linear, e.g. `#f2c94c`. */
  color: Schema.String,
  /** Sort position inside its type; the lowest `started` state is "In Progress". */
  position: Schema.Number,
});
export type LinearWorkflowState = typeof LinearWorkflowState.Type;

export const LinearUser = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
});
export type LinearUser = typeof LinearUser.Type;

export const LinearTeamRef = Schema.Struct({
  id: TrimmedNonEmptyString,
  key: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
});
export type LinearTeamRef = typeof LinearTeamRef.Type;

export const LinearProjectRef = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  url: Schema.String,
});
export type LinearProjectRef = typeof LinearProjectRef.Type;

export const LinearCycleRef = Schema.Struct({
  id: TrimmedNonEmptyString,
  number: Schema.Int,
  /** Cycles are numbered; a name is optional in Linear. */
  name: Schema.NullOr(Schema.String),
});
export type LinearCycleRef = typeof LinearCycleRef.Type;

export const LinearIssueLabel = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  color: Schema.String,
});
export type LinearIssueLabel = typeof LinearIssueLabel.Type;

const LinearIssueSummaryFields = {
  id: TrimmedNonEmptyString,
  identifier: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  url: Schema.String,
  /**
   * Linear's own suggested branch, built from the workspace's git branch
   * format. Threads started from an issue check this out verbatim so Linear's
   * PR automations recognise the work.
   */
  branchName: TrimmedNonEmptyString,
  /** 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
  priority: Schema.Int,
  state: LinearWorkflowState,
  team: LinearTeamRef,
  assignee: Schema.NullOr(LinearUser),
  project: Schema.NullOr(LinearProjectRef),
  cycle: Schema.NullOr(LinearCycleRef),
  /** ISO 8601. */
  updatedAt: Schema.String,
};

export const LinearIssueSummary = Schema.Struct(LinearIssueSummaryFields);
export type LinearIssueSummary = typeof LinearIssueSummary.Type;

export const LinearIssueRelative = Schema.Struct({
  id: TrimmedNonEmptyString,
  identifier: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  url: Schema.String,
  stateName: TrimmedNonEmptyString,
});
export type LinearIssueRelative = typeof LinearIssueRelative.Type;

export const LinearIssueComment = Schema.Struct({
  id: TrimmedNonEmptyString,
  body: Schema.String,
  url: Schema.String,
  /** ISO 8601. */
  createdAt: Schema.String,
  author: Schema.NullOr(LinearUser),
});
export type LinearIssueComment = typeof LinearIssueComment.Type;

export const LinearIssueDetail = Schema.Struct({
  ...LinearIssueSummaryFields,
  /** Markdown, as Linear stores it. */
  description: Schema.NullOr(Schema.String),
  comments: Schema.Array(LinearIssueComment),
  parent: Schema.NullOr(LinearIssueRelative),
  children: Schema.Array(LinearIssueRelative),
  labels: Schema.Array(LinearIssueLabel),
});
export type LinearIssueDetail = typeof LinearIssueDetail.Type;

/** A team and the projects it owns, for pickers that map Linear onto checkouts. */
export const LinearWorkspaceTeam = Schema.Struct({
  ...LinearTeamRef.fields,
  projects: Schema.Array(LinearProjectRef),
});
export type LinearWorkspaceTeam = typeof LinearWorkspaceTeam.Type;

export const LinearWorkspaceStructure = Schema.Struct({
  teams: Schema.Array(LinearWorkspaceTeam),
});
export type LinearWorkspaceStructure = typeof LinearWorkspaceStructure.Type;

/**
 * The mapping row an issue falls under: a row naming the issue's Linear
 * project beats a row naming its team, and the first match wins within a kind.
 * Shared by the dialog, the issues page, the server's base-branch choice and
 * the delegation reactor, so all four agree on where an issue lands.
 */
export function resolveLinearRepositoryMapping<
  Mapping extends {
    readonly teamKey: string | null;
    readonly linearProjectId: string | null;
  },
>(
  mappings: ReadonlyArray<Mapping>,
  issue: {
    readonly team: { readonly key: string };
    readonly project: { readonly id: string } | null;
  },
): Mapping | null {
  const projectId = issue.project?.id ?? null;
  if (projectId !== null) {
    const byProject = mappings.find((mapping) => mapping.linearProjectId === projectId);
    if (byProject) return byProject;
  }
  const teamKey = issue.team.key.toUpperCase();
  return (
    mappings.find(
      (mapping) => mapping.linearProjectId === null && mapping.teamKey?.toUpperCase() === teamKey,
    ) ?? null
  );
}

export const LinearWorkspace = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  urlKey: TrimmedNonEmptyString,
});
export type LinearWorkspace = typeof LinearWorkspace.Type;

/**
 * What Settings shows next to the key. `unconfigured` is "no key",
 * `unauthenticated` is "Linear rejected the key", `failed` is everything else
 * (network, rate limit) with a sentence the UI can print as-is.
 */
export const LinearConnectionStatus = Schema.Union([
  Schema.Struct({ status: Schema.Literal("unconfigured") }),
  Schema.Struct({ status: Schema.Literal("unauthenticated") }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    detail: TrimmedNonEmptyString,
    /** Epoch millis after which retrying makes sense; set for rate limits. */
    retryAt: Schema.optional(Schema.Number),
  }),
  Schema.Struct({
    status: Schema.Literal("connected"),
    viewer: Schema.Struct({
      ...LinearUser.fields,
      email: Schema.optional(TrimmedNonEmptyString),
    }),
    workspace: LinearWorkspace,
  }),
]);
export type LinearConnectionStatus = typeof LinearConnectionStatus.Type;

/** Issues ordered by newest activity, assigned to the connected user by default. */
export const LinearListIssuesInput = Schema.Struct({
  /** Defaults to true; false includes other assignees and unassigned issues. */
  assignedToMe: Schema.optional(Schema.Boolean),
  teamKey: Schema.optional(TrimmedNonEmptyString),
  /** Defaults to `unstarted` and `started` when absent. */
  stateTypes: Schema.optional(Schema.Array(LinearWorkflowStateType)),
  projectId: Schema.optional(TrimmedNonEmptyString),
  /** Server clamps to its own maximum. */
  limit: Schema.optional(PositiveInt),
});
export type LinearListIssuesInput = typeof LinearListIssuesInput.Type;

export const LinearListIssuesResult = Schema.Struct({
  issues: Schema.Array(LinearIssueSummary),
});
export type LinearListIssuesResult = typeof LinearListIssuesResult.Type;

export const LinearGetIssueInput = Schema.Struct({
  reference: LinearIssueReference,
});
export type LinearGetIssueInput = typeof LinearGetIssueInput.Type;

/**
 * How the thread gets its branch.
 *
 * `issue` checks Linear's branch out — the identifier in the name is what
 * links the pull request back to the issue later. `current` leaves the
 * checkout alone: nothing is created or switched, and the thread runs on
 * whatever branch is already there, which is what a small fix on a branch
 * that already exists wants.
 */
export const LinearIssueThreadBranchMode = Schema.Literals(["issue", "current"]);
export type LinearIssueThreadBranchMode = typeof LinearIssueThreadBranchMode.Type;

/**
 * Check out Linear's branch for an issue and hand back everything a thread
 * needs. `threadId` lets the setup script run for a thread that already
 * exists; the dialog usually calls without one, then creates the thread.
 */
export const LinearPrepareIssueThreadInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  reference: LinearIssueReference,
  mode: Schema.Literals(["local", "worktree"]),
  /**
   * The branch the person settled on in the dialog. Absent, the server names
   * it from the `linear.branchNaming` setting via `linearIssueBranchName`.
   * Must contain the issue identifier, so Linear still links the pull request.
   */
  branch: Schema.optional(TrimmedNonEmptyString),
  /** Defaults to `issue`. Under `current`, `branch` is ignored and git is left alone. */
  branchMode: Schema.optional(LinearIssueThreadBranchMode),
  threadId: Schema.optional(ThreadId),
});
export type LinearPrepareIssueThreadInput = typeof LinearPrepareIssueThreadInput.Type;

export const LinearPrepareIssueThreadResult = Schema.Struct({
  issue: LinearIssueDetail,
  /**
   * The branch the thread runs on: the one that was checked out under the
   * `issue` branch mode, the checkout's own under `current`. Null only under
   * `current`, when the checkout has no branch to report — a detached HEAD, or
   * a directory git does not track.
   */
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  /** What the branch was cut from. Null under the `current` mode, which cuts nothing. */
  baseBranch: Schema.NullOr(TrimmedNonEmptyString),
  /**
   * True when the branch already existed locally or on the remote and was
   * checked out as-is. Always false under the `current` mode, where no branch
   * was looked for in the first place.
   */
  reusedExistingBranch: Schema.Boolean,
  /** The state the issue was moved to, or null when it was left alone. */
  movedToState: Schema.NullOr(LinearWorkflowState),
});
export type LinearPrepareIssueThreadResult = typeof LinearPrepareIssueThreadResult.Type;

export const LinearUnavailableReason = Schema.Literals([
  "unconfigured",
  "unauthenticated",
  "rate-limited",
]);
export type LinearUnavailableReason = typeof LinearUnavailableReason.Type;

/**
 * Linear cannot be talked to right now. The message is a stable sentence the
 * UI shows as-is; `retryAt` is set when Linear said when to come back.
 */
export class LinearUnavailableError extends Schema.TaggedErrorClass<LinearUnavailableError>()(
  "LinearUnavailableError",
  {
    reason: LinearUnavailableReason,
    retryAt: Schema.optional(Schema.Number),
  },
  { httpApiStatus: 503 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(LinearUnavailableError)(this, { status: 503 });
  }

  override get message(): string {
    switch (this.reason) {
      case "unconfigured":
        return "Linear is not connected. Add an API key in Settings → Integrations.";
      case "unauthenticated":
        return "Linear rejected the API key. Replace it in Settings → Integrations.";
      case "rate-limited":
        return "Linear is rate limiting this server. Try again in a moment.";
    }
  }
}

export class LinearIssueNotFoundError extends Schema.TaggedErrorClass<LinearIssueNotFoundError>()(
  "LinearIssueNotFoundError",
  {
    reference: LinearIssueReference,
  },
  { httpApiStatus: 404 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(LinearIssueNotFoundError)(this, { status: 404 });
  }

  override get message(): string {
    return `Linear issue ${this.reference} was not found or is not visible to the connected user.`;
  }
}

export class LinearOperationError extends Schema.TaggedErrorClass<LinearOperationError>()(
  "LinearOperationError",
  {
    operation: Schema.String,
    detail: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
  { httpApiStatus: 502 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(LinearOperationError)(this, { status: 502 });
  }

  override get message(): string {
    return `Linear operation ${this.operation} failed: ${this.detail}`;
  }
}

/** The part of an issue that decides its branch name. */
export interface LinearBranchNameIssue {
  readonly identifier: string;
  readonly title: string;
  readonly branchName: string;
  readonly labels?: ReadonlyArray<{ readonly name: string }> | undefined;
}

/** The settings half, kept structural so callers can pass a settings row or a literal. */
export interface LinearBranchNamingRule {
  readonly style: "linear" | "prefixed";
  readonly prefixes: ReadonlyArray<string>;
  readonly labelPrefixes: ReadonlyArray<{ readonly label: string; readonly prefix: string }>;
}

/**
 * The prefix an issue starts with under the `prefixed` style: the first label
 * rule whose label the issue carries, else the first configured prefix, else
 * `feat`. Label and prefix comparisons ignore case.
 */
export function defaultLinearBranchPrefix(
  issue: Pick<LinearBranchNameIssue, "labels">,
  naming: Pick<LinearBranchNamingRule, "prefixes" | "labelPrefixes">,
): string {
  const labels = new Set((issue.labels ?? []).map((label) => label.name.trim().toLowerCase()));
  for (const rule of naming.labelPrefixes) {
    if (labels.has(rule.label.trim().toLowerCase())) {
      return normalizeLinearBranchPrefix(rule.prefix);
    }
  }
  return normalizeLinearBranchPrefix(naming.prefixes[0] ?? "feat");
}

/**
 * `del-177-fix-login`: what follows the namespace in Linear's own branch name,
 * which already carries the identifier and a slug of the title. When the
 * workspace's format put something else there, the slug is rebuilt from the
 * title so the identifier is always present.
 */
export function linearIssueBranchSuffix(
  issue: Pick<LinearBranchNameIssue, "identifier" | "title" | "branchName">,
): string {
  const identifier = issue.identifier.trim().toLowerCase();
  const lastSegment =
    issue.branchName
      .trim()
      .split("/")
      .findLast((part) => part.length > 0) ?? "";
  if (lastSegment.toLowerCase().includes(identifier)) {
    return lastSegment;
  }
  const slug = issue.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");
  return slug.length > 0 ? `${identifier}-${slug}` : identifier;
}

/**
 * The branch a thread for `issue` checks out. Under `linear` it is the issue's
 * own `branchName` verbatim; under `prefixed` it is `<prefix>/<suffix>`, with
 * `prefix` the caller's choice when given, else `defaultLinearBranchPrefix`.
 */
export function linearIssueBranchName(
  issue: LinearBranchNameIssue,
  naming: LinearBranchNamingRule,
  prefixOverride?: string | null,
): string {
  if (naming.style === "linear") {
    return issue.branchName.trim();
  }
  const prefix =
    prefixOverride !== undefined && prefixOverride !== null && prefixOverride.trim().length > 0
      ? normalizeLinearBranchPrefix(prefixOverride)
      : defaultLinearBranchPrefix(issue, naming);
  return `${prefix}/${linearIssueBranchSuffix(issue)}`;
}

/** `feat/` and ` Feat ` both mean `feat`; a prefix is a single namespace. */
export function normalizeLinearBranchPrefix(prefix: string): string {
  return prefix
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
}

/**
 * Whether Linear would still link a pull request from this branch to the
 * issue: it looks for the identifier anywhere in the branch name, case
 * aside. The server refuses a hand-edited branch that fails this.
 */
export function linearBranchNamesIssue(branch: string, identifier: string): boolean {
  return branch.toLowerCase().includes(identifier.trim().toLowerCase());
}
