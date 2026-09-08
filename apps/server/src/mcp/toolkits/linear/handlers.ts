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
 * `settings.linear.confirmAgentWrites` is off. Call it once every lookup has
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

export const LinearToolkitHandlersLive = LinearToolkit.toLayer({
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
      const issue = yield* resolveIssue("save_comment", scope, named(input.issueId));
      const body = input.body.trim();
      yield* confirmWrite("save_comment", scope, {
        appName: "Linear",
        change: {
          summary: `Comment on ${issue.identifier}`,
          record: { label: issue.identifier, url: issue.url },
          // The comment lands as the agent wrote it, so it is reviewed the
          // same way: as the markdown Linear will render.
          fields: [{ label: "Comment", value: body, format: "markdown" }],
        },
        args: { ...input, issueId: issue.id },
      });
      return yield* linear.createComment({ issueId: issue.id, body });
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
        input.labels === undefined
      ) {
        return yield* new LinearOperationError({
          operation: "save_issue",
          detail: "Nothing to save: pass at least one of title, description, state, or labels.",
        });
      }
      const issue = yield* resolveIssue("save_issue", scope, named(input.id));
      const resolvedState =
        state === undefined ? undefined : yield* resolveState("save_issue", issue.team.id, state);
      const resolvedLabels =
        input.labels === undefined
          ? undefined
          : yield* resolveLabels("save_issue", issue.team.id, input.labels);
      const stateId = resolvedState?.id;
      const labelIds = resolvedLabels?.map((label) => label.id);
      yield* confirmWrite("save_issue", scope, {
        appName: "Linear",
        change: {
          summary: `Update ${issue.identifier}`,
          record: { label: issue.identifier, url: issue.url },
          fields: [
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
          ...(stateId ? { stateId } : {}),
          ...(labelIds ? { labelIds } : {}),
        },
      });
      yield* linear.updateIssue({
        issueId: issue.id,
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
          ...(parentId ? { parentId } : {}),
          ...(stateId ? { stateId } : {}),
          ...(labelIds ? { labelIds } : {}),
        },
      });
      return yield* linear.createIssue({
        teamId: team.id,
        title,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(parentId !== undefined ? { parentId } : {}),
        ...(stateId !== undefined ? { stateId } : {}),
        ...(labelIds !== undefined ? { labelIds } : {}),
      });
    }),
});
