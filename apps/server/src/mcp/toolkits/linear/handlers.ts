import * as DateTime from "effect/DateTime";
import type {
  LinearResourceKind,
  LinearResourceSaveInput,
} from "../../../linear/LinearResources.ts";
import {
  isProviderDriverKind,
  LinearOperationError,
  type IntegrationApprovalChange,
  type LinearTeamRef,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as LinearApi from "../../../linear/LinearApi.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { McpApprovalBroker } from "../../McpApprovalBroker.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { LinearToolkit } from "./tools.ts";

type Scope = McpInvocationContext.McpInvocationScope;

/**
 * Tool parameters arrive as raw strings. Identifiers and names are matched
 * trimmed, and a blank one reads as "not given" rather than as a lookup that
 * cannot match anything.
 */
const named = (value: string | undefined): string | undefined => {
  const text = value?.trim() ?? "";
  return text.length > 0 ? text : undefined;
};

/**
 * The issue every tool falls back to when the agent named none: the one the
 * thread was started from. A thread with no link is not an error the agent can
 * retry its way out of, so the sentence tells it what to pass instead.
 */
const linkedIssueReference = Effect.fn("LinearToolkit.linkedIssueReference")(function* (
  operation: string,
  scope: Scope,
) {
  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const shell = yield* projections.getThreadShellById(scope.threadId).pipe(
    Effect.mapError(
      () =>
        new LinearOperationError({
          operation,
          detail: "Could not read this thread's linked issue.",
        }),
    ),
  );
  const linkedIssue = Option.getOrUndefined(shell)?.linkedIssue;
  if (linkedIssue === null || linkedIssue === undefined) {
    return yield* new LinearOperationError({
      operation,
      detail:
        "This thread is not linked to a Linear issue. Pass the issue identifier, such as DEL-123.",
    });
  }
  return linkedIssue.id;
});

/**
 * Reads the issue before anything is written to it. Linear's mutations want
 * UUIDs and the writes here also need the issue's team, so an agent-supplied
 * `DEL-123` costs one extra read rather than a second class of failure.
 */
const resolveIssue = Effect.fn("LinearToolkit.resolveIssue")(function* (
  operation: string,
  scope: Scope,
  reference: string | undefined,
) {
  const linear = yield* LinearApi.LinearApi;
  const target = reference ?? (yield* linkedIssueReference(operation, scope));
  return yield* linear.getIssue({ reference: target });
});

const lookupTeam = Effect.fn("LinearToolkit.lookupTeam")(function* (
  operation: string,
  team: string,
) {
  const linear = yield* LinearApi.LinearApi;
  const { teams } = yield* linear.workspace;
  const needle = team.toLocaleLowerCase();
  const match =
    teams.find((candidate) => candidate.id === team) ??
    teams.find((candidate) => candidate.key.toLocaleLowerCase() === needle) ??
    teams.find((candidate) => candidate.name.toLocaleLowerCase() === needle);
  if (match === undefined) {
    return yield* new LinearOperationError({
      operation,
      detail: `Linear has no team matching "${team}". Teams in this workspace: ${teams
        .map((candidate) => candidate.key)
        .join(", ")}.`,
    });
  }
  return { id: match.id, key: match.key, name: match.name } satisfies LinearTeamRef;
});

const resolveTeam = Effect.fn("LinearToolkit.resolveTeam")(function* (
  operation: string,
  scope: Scope,
  team: string | undefined,
) {
  if (team !== undefined) return yield* lookupTeam(operation, team);
  const issue = yield* resolveIssue(operation, scope, undefined);
  return issue.team;
});

const resolveState = Effect.fn("LinearToolkit.resolveState")(function* (
  operation: string,
  teamId: string,
  state: string,
) {
  const linear = yield* LinearApi.LinearApi;
  const states = yield* linear.workflowStates(teamId);
  const needle = state.toLocaleLowerCase();
  const match =
    states.find((candidate) => candidate.id === state) ??
    states.find((candidate) => candidate.name.toLocaleLowerCase() === needle);
  if (match === undefined) {
    return yield* new LinearOperationError({
      operation,
      detail: `This team has no workflow state matching "${state}". Its states: ${states
        .map((candidate) => candidate.name)
        .join(", ")}.`,
    });
  }
  return match;
});

const resolveLabels = Effect.fn("LinearToolkit.resolveLabels")(function* (
  operation: string,
  teamId: string,
  labels: ReadonlyArray<string>,
) {
  const linear = yield* LinearApi.LinearApi;
  const available = yield* linear.labels(teamId);
  const resolved: Array<(typeof available)[number]> = [];
  const unknown: Array<string> = [];
  for (const label of labels) {
    const needle = label.toLocaleLowerCase();
    const match =
      available.find((candidate) => candidate.id === label) ??
      available.find((candidate) => candidate.name.toLocaleLowerCase() === needle);
    if (match === undefined) unknown.push(label);
    else resolved.push(match);
  }
  if (unknown.length > 0) {
    return yield* new LinearOperationError({
      operation,
      detail: `Linear has no label matching ${unknown
        .map((label) => `"${label}"`)
        .join(", ")}. Labels available here: ${available
        .map((candidate) => candidate.name)
        .join(", ")}.`,
    });
  }
  return resolved;
});

/**
 * The approval row is one line above the composer, so its `detail` is a
 * summary. The change travels beside it in full — see `describeChange` — and
 * the review dialog is what the person actually reads before approving.
 */
const MAX_DETAIL_CHARS = 400;

const clampDetail = (text: string): string => {
  const trimmed = text.trim();
  return trimmed.length > MAX_DETAIL_CHARS
    ? `${trimmed.slice(0, MAX_DETAIL_CHARS)}\u2026`
    : trimmed;
};

/**
 * The short `detail` for a change, derived rather than written twice so the row
 * and the review dialog can never describe different writes.
 *
 * A change that is one piece of prose — a comment — reads as a headline with
 * the prose under it. A set of edited fields reads as a list of what each one
 * becomes.
 */
const describeChange = (change: IntegrationApprovalChange): string => {
  const [first] = change.fields;
  const body =
    change.fields.length === 1 && first?.format === "markdown"
      ? `\n\n${first.value}`
      : change.fields.map((field) => `\n${field.label}: ${field.value}`).join("");
  return clampDetail(`${change.summary}${body}`);
};

/**
 * Asks the user before a Linear write lands, unless
 * `settings.linear.confirmAgentWrites` is off or the run is delegated and
 * writes as the app rather than as the user. Call it once every lookup has
 * resolved and immediately before the mutation, so a mistyped state or label
 * fails on its own terms instead of interrupting the user for a write that
 * could never happen.
 *
 * An `acceptForSession` grant is keyed to the provider session, so a user who
 * allowed one write is not asked again for the rest of that agent run.
 */
const confirmWrite = Effect.fn("LinearToolkit.confirmWrite")(function* (
  operation: string,
  scope: Scope,
  input: {
    readonly appName: string;
    readonly change: IntegrationApprovalChange;
    readonly args: unknown;
  },
) {
  const serverSettings = yield* ServerSettingsService;
  // Read per call: the toggle can change in Settings while a session runs.
  const settings = yield* serverSettings.getSettings.pipe(
    Effect.mapError(
      () =>
        new LinearOperationError({
          operation,
          detail: "The server could not read its Linear settings.",
        }),
    ),
  );
  if (!settings.linear.confirmAgentWrites) return;
  // A delegated run writes as the Linear app, not as the user, so there is no
  // borrowed identity to approve. The credential that decides the author
  // decides the prompt, so the two cannot drift apart.
  if ((yield* LinearApi.LinearAppCredential) !== undefined) return;

  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const shell = yield* projections.getThreadShellById(scope.threadId).pipe(
    Effect.mapError(
      () =>
        new LinearOperationError({
          operation,
          detail: "Could not ask for confirmation: this thread could not be read.",
        }),
    ),
  );
  // The approval rides the thread's runtime event stream, so it needs the
  // session the agent is speaking through to address the card at all.
  const session = Option.getOrUndefined(shell)?.session;
  const provider = session?.providerName;
  if (!session || provider === null || provider === undefined || !isProviderDriverKind(provider)) {
    return yield* new LinearOperationError({
      operation,
      detail: "Could not ask for confirmation: this thread has no active session.",
    });
  }

  const broker = yield* McpApprovalBroker;
  const decision = yield* broker.request({
    threadId: scope.threadId,
    providerInstanceId: scope.providerInstanceId ?? session.providerInstanceId,
    provider,
    ...(session.activeTurnId === null ? {} : { turnId: session.activeTurnId }),
    sessionKey: `${scope.threadId}:${scope.providerSessionId}`,
    appName: input.appName,
    detail: describeChange(input.change),
    change: input.change,
    args: input.args,
  });

  if (decision === "decline") {
    return yield* new LinearOperationError({
      operation,
      detail:
        "The user declined this change in T3 Code. Do not retry it; ask them what they want instead.",
    });
  }
  if (decision === "cancel") {
    return yield* new LinearOperationError({
      operation,
      detail: "The user did not approve this change in time. Ask them, then try again.",
    });
  }
});

const isResourceId = (value: string | undefined) =>
  value !== undefined &&
  /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value.trim());

const resolveResource = Effect.fn("LinearToolkit.resolveResource")(function* (
  kind: LinearResourceKind,
  reference: string,
  scope: { teamId?: string | undefined; projectId?: string | undefined } = {},
) {
  const linear = yield* LinearApi.LinearApi;
  if (!reference.trim())
    return yield* new LinearOperationError({
      operation: "resolveResource",
      detail: `Pass a non-empty ${kind} name or ID.`,
    });
  const result = yield* linear.listResources({ kind, exact: reference, ...scope, limit: 2 });
  if (result.nodes.length !== 1 || result.pageInfo.hasNextPage)
    return yield* new LinearOperationError({
      operation: "resolveResource",
      detail: result.nodes.length
        ? `More than one ${kind} matches "${reference}". Use its ID.`
        : `No ${kind} matches "${reference}" in the selected team or project. Use the corresponding list tool.`,
    });
  return result.nodes[0]!;
});

const issueProject = Effect.fn("LinearToolkit.issueProject")(function* (
  scope: Scope,
  reference?: string | undefined,
) {
  if (reference) return (yield* resolveResource("project", reference)).id;
  const issue = yield* resolveIssue("project", scope, undefined);
  if (!issue.project)
    return yield* new LinearOperationError({
      operation: "project",
      detail: "This issue has no project. Pass a project explicitly.",
    });
  return issue.project.id;
});

function validDate(value: string): boolean {
  const date = DateTime.make(value);
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Option.isSome(date) &&
    DateTime.formatIsoDateUtc(date.value) === value
  );
}

const resolveIssuePlanning = Effect.fn("LinearToolkit.resolveIssuePlanning")(function* (
  input: {
    project?: string | undefined | null;
    milestone?: string | undefined | null;
    cycle?: string | undefined | null;
    estimate?: number | undefined | null;
    priority?: number | undefined;
    dueDate?: string | undefined | null;
  },
  teamId: string,
  currentProjectId: string | null,
) {
  const patch: {
    projectId?: string | null;
    projectMilestoneId?: string | null;
    cycleId?: string | null;
    estimate?: number | null;
    priority?: number;
    dueDate?: string | null;
  } = {};
  const fields: Array<{ label: string; value: string }> = [];
  let projectId = currentProjectId;
  if (input.project !== undefined) {
    const project =
      input.project === null ? null : yield* resolveResource("project", input.project, { teamId });
    projectId = project?.id ?? null;
    patch.projectId = projectId;
    fields.push({ label: "Project", value: project?.name ?? "None" });
  }
  if (input.milestone !== undefined) {
    if (input.milestone !== null && !projectId)
      return yield* new LinearOperationError({
        operation: "save_issue",
        detail: "Set a project before assigning a milestone.",
      });
    const milestone =
      input.milestone === null
        ? null
        : yield* resolveResource("milestone", input.milestone, { projectId: projectId! });
    patch.projectMilestoneId = milestone?.id ?? null;
    fields.push({ label: "Milestone", value: milestone?.name ?? "None" });
  } else if (input.project !== undefined && projectId !== currentProjectId) {
    patch.projectMilestoneId = null;
    fields.push({ label: "Milestone", value: "None (project changed)" });
  }
  if (input.cycle !== undefined) {
    const cycle =
      input.cycle === null ? null : yield* resolveResource("cycle", input.cycle, { teamId });
    patch.cycleId = cycle?.id ?? null;
    fields.push({
      label: "Cycle",
      value: cycle ? (cycle.name ?? `Cycle ${cycle.number}`) : "None",
    });
  }
  if (input.estimate !== undefined) {
    patch.estimate = input.estimate;
    fields.push({
      label: "Estimate",
      value: input.estimate === null ? "None" : String(input.estimate),
    });
  }
  if (input.priority !== undefined) {
    patch.priority = input.priority;
    fields.push({
      label: "Priority",
      value: ["None", "Urgent", "High", "Medium", "Low"][input.priority]!,
    });
  }
  if (input.dueDate !== undefined) {
    if (input.dueDate !== null && !validDate(input.dueDate))
      return yield* new LinearOperationError({
        operation: "save_issue",
        detail: "Use a valid YYYY-MM-DD due date, or null to clear it.",
      });
    patch.dueDate = input.dueDate;
    fields.push({ label: "Due date", value: input.dueDate ?? "None" });
  }
  return { patch, fields };
});

const listResources = Effect.fn("LinearToolkit.listResources")(function* (
  kind: LinearResourceKind,
  input: {
    query?: string | undefined;
    cursor?: string | undefined;
    limit?: number | undefined;
    team?: string | undefined;
    project?: string | undefined;
  },
) {
  const scope = yield* McpInvocationContext.requireMcpCapability("linear");
  const linear = yield* LinearApi.LinearApi;
  const teamId = input.team
    ? (yield* lookupTeam("list_resources", input.team)).id
    : kind === "cycle"
      ? (yield* resolveTeam("list_cycles", scope, undefined)).id
      : undefined;
  const projectId = kind === "milestone" ? yield* issueProject(scope, input.project) : undefined;
  return yield* linear.listResources({
    kind,
    ...input,
    ...(teamId ? { teamId } : {}),
    ...(projectId ? { projectId } : {}),
  });
});

const saveResource = Effect.fn("LinearToolkit.saveResource")(function* (
  kind: LinearResourceSaveInput["kind"],
  input: {
    id?: string | undefined;
    name?: string | undefined;
    description?: string | undefined | null;
    teams?: ReadonlyArray<string> | undefined;
    team?: string | undefined;
    project?: string | undefined;
    startDate?: string | undefined | null;
    targetDate?: string | undefined | null;
    startsAt?: string | undefined;
    endsAt?: string | undefined;
    color?: string | undefined;
  },
) {
  const scope = yield* McpInvocationContext.requireMcpCapability("linear");
  const linear = yield* LinearApi.LinearApi;
  const teamId = input.team
    ? (yield* lookupTeam("save_resource", input.team)).id
    : kind === "cycle" && !isResourceId(input.id)
      ? (yield* resolveTeam("update_cycle", scope, undefined)).id
      : undefined;
  const projectId = input.project
    ? (yield* resolveResource("project", input.project)).id
    : kind === "milestone" && !input.id
      ? yield* issueProject(scope)
      : undefined;
  const current = input.id
    ? yield* resolveResource(kind, input.id, {
        ...(teamId ? { teamId } : {}),
        ...(projectId && !isResourceId(input.id) ? { projectId } : {}),
      })
    : undefined;
  if (!current && kind === "cycle")
    return yield* new LinearOperationError({
      operation: "update_cycle",
      detail: "Pass an existing cycle ID or name; Linear schedules new cycles automatically.",
    });
  const teamIds = input.teams
    ? yield* Effect.forEach(input.teams, (team) =>
        lookupTeam("save_project", team).pipe(Effect.map((t) => t.id)),
      )
    : kind === "project" && !current
      ? [(yield* resolveTeam("save_project", scope, undefined)).id]
      : undefined;
  const name = input.name?.trim();
  if ((!current && !name) || (input.name !== undefined && !name))
    return yield* new LinearOperationError({
      operation: "save_resource",
      detail: "A non-empty name is required.",
    });
  if (teamIds && !teamIds.length)
    return yield* new LinearOperationError({
      operation: "save_project",
      detail: "A project must have at least one team.",
    });
  for (const value of [input.startDate, input.targetDate])
    if (value != null && !validDate(value))
      return yield* new LinearOperationError({
        operation: "save_resource",
        detail: "Dates must be valid YYYY-MM-DD dates.",
      });
  for (const value of [input.startsAt, input.endsAt])
    if (value !== undefined && !Number.isFinite(Date.parse(value)))
      return yield* new LinearOperationError({
        operation: "update_cycle",
        detail: "Cycle dates must be valid ISO 8601 timestamps.",
      });
  const start = input.startsAt ?? current?.startsAt;
  const end = input.endsAt ?? current?.endsAt;
  if (kind === "cycle" && start && end && Date.parse(start) >= Date.parse(end))
    return yield* new LinearOperationError({
      operation: "update_cycle",
      detail: "Cycle end must be after its start.",
    });
  const patch = {
    ...(name !== undefined ? { name } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(teamIds !== undefined ? { teamIds } : {}),
    ...(projectId !== undefined ? { projectId } : {}),
    ...(input.startDate !== undefined ? { startDate: input.startDate } : {}),
    ...(input.targetDate !== undefined ? { targetDate: input.targetDate } : {}),
    ...(input.startsAt !== undefined ? { startsAt: input.startsAt } : {}),
    ...(input.endsAt !== undefined ? { endsAt: input.endsAt } : {}),
    ...(input.color !== undefined ? { color: input.color } : {}),
  };
  if (current && !Object.keys(patch).length)
    return yield* new LinearOperationError({
      operation: "save_resource",
      detail: "Pass at least one field to update.",
    });
  const labels: Record<string, string> = {
    name: "Name",
    description: "Description",
    teamIds: "Teams",
    projectId: "Project",
    startDate: "Start date",
    targetDate: "Target date",
    startsAt: "Starts at",
    endsAt: "Ends at",
    color: "Color",
  };
  yield* confirmWrite(`save_${kind}`, scope, {
    appName: "Linear",
    change: {
      summary: `${current ? "Update" : "Create"} ${kind}${current ? `: ${current.name ?? current.id}` : ""}`,
      ...(current?.url ? { record: { label: current.name ?? current.id, url: current.url } } : {}),
      fields: [
        ...Object.entries(patch).map(([key, value]) => ({
          label: labels[key] ?? key,
          value: value === null ? "None" : Array.isArray(value) ? value.join(", ") : String(value),
        })),
        ...(!current && kind === "label"
          ? [{ label: "Team", value: input.team ?? "Workspace-wide" }]
          : []),
      ],
    },
    args: { kind, ...patch, ...(current ? { id: current.id } : {}), ...(teamId ? { teamId } : {}) },
  });
  return yield* linear.saveResource({
    kind,
    ...patch,
    ...(current ? { id: current.id } : {}),
    ...(teamId ? { teamId } : {}),
  });
});

export const LinearToolkitHandlersLive = LinearToolkit.toLayer({
  list_issues: (input) =>
    Effect.gen(function* () {
      yield* McpInvocationContext.requireMcpCapability("linear");
      const linear = yield* LinearApi.LinearApi;
      const team = input.team ? yield* lookupTeam("list_issues", input.team) : undefined;
      const project = input.project
        ? yield* resolveResource("project", input.project, team ? { teamId: team.id } : {})
        : undefined;
      const assignee =
        input.assignee == null ? input.assignee : yield* linear.resolveAssignee(input.assignee);
      return yield* linear.listIssues({
        assignedToMe: false,
        ...(team ? { teamKey: team.key } : {}),
        ...(project ? { projectId: project.id } : {}),
        ...(assignee !== undefined ? { assigneeId: assignee?.id ?? null } : {}),
        ...(input.query !== undefined ? { query: input.query } : {}),
        ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.stateTypes !== undefined ? { stateTypes: input.stateTypes } : {}),
      });
    }),
  list_projects: (input) => listResources("project", input),
  list_milestones: (input) => listResources("milestone", input),
  list_cycles: (input) => listResources("cycle", input),
  list_issue_labels: (input) => listResources("label", input),
  list_users: (input) => listResources("user", input),
  list_teams: (input) => listResources("team", input),
  get_project: (input) =>
    Effect.gen(function* () {
      yield* McpInvocationContext.requireMcpCapability("linear");
      return yield* resolveResource("project", input.query);
    }),
  get_milestone: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("linear");
      if (!input.project && isResourceId(input.query)) {
        return yield* (yield* LinearApi.LinearApi).getResource("milestone", input.query.trim());
      }
      const projectId = yield* issueProject(scope, input.project);
      return yield* resolveResource("milestone", input.query, { projectId });
    }),
  get_user: (input) =>
    Effect.gen(function* () {
      yield* McpInvocationContext.requireMcpCapability("linear");
      const linear = yield* LinearApi.LinearApi;
      const user = yield* linear.resolveAssignee(input.query);
      return yield* linear.getResource("user", user.id);
    }),
  get_team: (input) =>
    Effect.gen(function* () {
      yield* McpInvocationContext.requireMcpCapability("linear");
      const linear = yield* LinearApi.LinearApi;
      const team = yield* lookupTeam("get_team", input.query);
      return yield* linear.getResource("team", team.id);
    }),
  save_project: (input) => saveResource("project", input),
  save_milestone: (input) => saveResource("milestone", input),
  update_cycle: (input) => saveResource("cycle", input),
  save_issue_label: (input) => saveResource("label", input),
  get_issue: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("linear");
      return yield* resolveIssue("get_issue", scope, named(input.id));
    }),

  list_comments: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("linear");
      const issue = yield* resolveIssue("list_comments", scope, named(input.issueId));
      return {
        issue: { id: issue.id, identifier: issue.identifier, url: issue.url },
        comments: issue.comments,
      };
    }),

  list_issue_statuses: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("linear");
      const linear = yield* LinearApi.LinearApi;
      const team = yield* resolveTeam("list_issue_statuses", scope, named(input.team));
      const states = yield* linear.workflowStates(team.id);
      return {
        team,
        states: [...states].sort((left, right) => left.position - right.position),
      };
    }),

  list_my_issues: (input) =>
    Effect.gen(function* () {
      yield* McpInvocationContext.requireMcpCapability("linear");
      const linear = yield* LinearApi.LinearApi;
      return yield* linear.listIssues({
        ...(input.teamKey !== undefined ? { teamKey: input.teamKey } : {}),
        ...(input.stateTypes !== undefined ? { stateTypes: input.stateTypes } : {}),
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      });
    }),

  save_comment: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("linear");
      const linear = yield* LinearApi.LinearApi;
      const id = named(input.id);
      const comment = id === undefined ? undefined : yield* linear.getComment(id);
      if (comment !== undefined && comment.issue === null) {
        return yield* new LinearOperationError({
          operation: "save_comment",
          detail: "This comment does not belong to an issue.",
        });
      }
      const issue = yield* resolveIssue(
        "save_comment",
        scope,
        named(input.issueId) ?? comment?.issue?.id,
      );
      if (comment !== undefined && comment.issue?.id !== issue.id) {
        return yield* new LinearOperationError({
          operation: "save_comment",
          detail: "The comment does not belong to the specified issue.",
        });
      }
      const body = input.body.trim();
      if (body.length === 0 || (input.id !== undefined && id === undefined)) {
        return yield* new LinearOperationError({
          operation: "save_comment",
          detail: "Comment body and supplied comment id must not be blank.",
        });
      }
      yield* confirmWrite("save_comment", scope, {
        appName: "Linear",
        change: {
          summary: `${comment === undefined ? "Comment on" : "Edit comment on"} ${issue.identifier}`,
          record: { label: issue.identifier, url: comment?.url ?? issue.url },
          // The comment lands as the agent wrote it, so it is reviewed the
          // same way: as the markdown Linear will render.
          fields: [{ label: "Comment", value: body, format: "markdown" }],
        },
        args: { ...input, issueId: issue.id },
      });
      return yield* comment === undefined
        ? linear.createComment({ issueId: issue.id, body })
        : linear.updateComment({ id: comment.id, body });
    }),

  save_issue: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("linear");
      const linear = yield* LinearApi.LinearApi;
      const title = named(input.title);
      const state = named(input.state);
      if (
        title === undefined &&
        input.description === undefined &&
        state === undefined &&
        input.labels === undefined &&
        input.assignee === undefined &&
        input.project === undefined &&
        input.milestone === undefined &&
        input.cycle === undefined &&
        input.estimate === undefined &&
        input.priority === undefined &&
        input.dueDate === undefined
      ) {
        return yield* new LinearOperationError({
          operation: "save_issue",
          detail: "Nothing to save: pass at least one issue field to update.",
        });
      }
      const issue = yield* resolveIssue("save_issue", scope, named(input.id));
      const resolvedState =
        state === undefined ? undefined : yield* resolveState("save_issue", issue.team.id, state);
      const resolvedLabels =
        input.labels === undefined
          ? undefined
          : yield* resolveLabels("save_issue", issue.team.id, input.labels);
      const resolvedAssignee =
        input.assignee === undefined || input.assignee === null
          ? input.assignee
          : yield* linear.resolveAssignee(input.assignee);
      const assigneeId =
        resolvedAssignee === undefined || resolvedAssignee === null
          ? resolvedAssignee
          : resolvedAssignee.id;
      const planning = yield* resolveIssuePlanning(input, issue.team.id, issue.project?.id ?? null);
      const stateId = resolvedState?.id;
      const labelIds = resolvedLabels?.map((label) => label.id);
      yield* confirmWrite("save_issue", scope, {
        appName: "Linear",
        change: {
          summary: `Update ${issue.identifier}`,
          record: { label: issue.identifier, url: issue.url },
          fields: [
            ...planning.fields,
            ...(resolvedAssignee === undefined
              ? []
              : [
                  {
                    label: "Assignee",
                    value:
                      resolvedAssignee === null
                        ? "Unassigned"
                        : `${resolvedAssignee.displayName} (${resolvedAssignee.id})`,
                  },
                ]),
            ...(title === undefined ? [] : [{ label: "Title", value: title }]),
            ...(resolvedState === undefined ? [] : [{ label: "State", value: resolvedState.name }]),
            ...(resolvedLabels === undefined
              ? []
              : [
                  {
                    label: "Labels",
                    value: resolvedLabels.map((label) => label.name).join(", "),
                  },
                ]),
            // The description replaces what the issue says now, so it is shown
            // whole. A character count is not something anyone can approve.
            ...(input.description === undefined
              ? []
              : [
                  {
                    label: "Description",
                    value: input.description,
                    format: "markdown" as const,
                  },
                ]),
          ],
        },
        args: {
          ...input,
          issueId: issue.id,
          ...planning.patch,
          ...(assigneeId !== undefined ? { assigneeId } : {}),
          ...(stateId ? { stateId } : {}),
          ...(labelIds ? { labelIds } : {}),
        },
      });
      yield* linear.updateIssue({
        issueId: issue.id,
        ...planning.patch,
        ...(assigneeId !== undefined ? { assigneeId } : {}),
        ...(title !== undefined ? { title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(stateId !== undefined ? { stateId } : {}),
        ...(labelIds !== undefined ? { labelIds } : {}),
      });
      // Re-read so the agent sees what Linear actually stored, including the
      // state and label names it just resolved by name.
      return yield* linear.getIssue({ reference: issue.id });
    }),

  create_issue: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("linear");
      const linear = yield* LinearApi.LinearApi;
      // Both the team and the parent default to the thread's issue, so it is
      // read at most once no matter which of the two the agent left out.
      const linkedIssue = yield* Effect.cached(resolveIssue("create_issue", scope, undefined));
      const requestedTeam = named(input.team);
      const team =
        requestedTeam === undefined
          ? (yield* linkedIssue).team
          : yield* lookupTeam("create_issue", requestedTeam);
      const requestedParent = input.parentId === null ? null : named(input.parentId);
      const parent =
        requestedParent === null
          ? undefined
          : requestedParent === undefined
            ? yield* linkedIssue
            : yield* linear.getIssue({ reference: requestedParent });
      const parentId = parent?.id;
      const state = named(input.state);
      const resolvedState =
        state === undefined ? undefined : yield* resolveState("create_issue", team.id, state);
      const resolvedLabels =
        input.labels === undefined
          ? undefined
          : yield* resolveLabels("create_issue", team.id, input.labels);
      const planning = yield* resolveIssuePlanning(input, team.id, null);
      const assignee =
        input.assignee == null ? input.assignee : yield* linear.resolveAssignee(input.assignee);
      const assigneeId = assignee == null ? assignee : assignee.id;
      const stateId = resolvedState?.id;
      const labelIds = resolvedLabels?.map((label) => label.id);
      const title = input.title.trim();
      yield* confirmWrite("create_issue", scope, {
        appName: "Linear",
        change: {
          summary: `Create issue in ${team.key}`,
          ...(parent === undefined
            ? {}
            : { record: { label: parent.identifier, url: parent.url } }),
          fields: [
            ...planning.fields,
            ...(assignee === undefined
              ? []
              : [
                  {
                    label: "Assignee",
                    value:
                      assignee === null ? "Unassigned" : `${assignee.displayName} (${assignee.id})`,
                  },
                ]),
            { label: "Title", value: title },
            ...(parent === undefined ? [] : [{ label: "Parent", value: parent.identifier }]),
            ...(resolvedState === undefined ? [] : [{ label: "State", value: resolvedState.name }]),
            ...(resolvedLabels === undefined
              ? []
              : [
                  {
                    label: "Labels",
                    value: resolvedLabels.map((label) => label.name).join(", "),
                  },
                ]),
            ...(input.description === undefined
              ? []
              : [
                  {
                    label: "Description",
                    value: input.description,
                    format: "markdown" as const,
                  },
                ]),
          ],
        },
        args: {
          ...input,
          teamId: team.id,
          ...planning.patch,
          ...(assigneeId !== undefined ? { assigneeId } : {}),
          ...(parentId ? { parentId } : {}),
          ...(stateId ? { stateId } : {}),
          ...(labelIds ? { labelIds } : {}),
        },
      });
      return yield* linear.createIssue({
        teamId: team.id,
        ...planning.patch,
        ...(assigneeId !== undefined ? { assigneeId } : {}),
        title,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(parentId !== undefined ? { parentId } : {}),
        ...(stateId !== undefined ? { stateId } : {}),
        ...(labelIds !== undefined ? { labelIds } : {}),
      });
    }),
});
