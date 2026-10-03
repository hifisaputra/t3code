import * as DateTime from "effect/DateTime";
import type {
  LinearResourceKind,
  LinearResourceSaveInput,
} from "../../../linear/LinearResources.ts";
import {
  assistantTeamThread,
  isProviderDriverKind,
  LinearOperationError,
  type IntegrationApprovalChange,
  type LinearIssueDetail,
  type LinearIssueRelationType,
  type LinearTeamRef,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { AssistantEvidence } from "../../../assistant/AssistantEvidence.ts";
import { imageMimeTypeForFileName } from "../../../imageMime.ts";
import { LinearAgentOutbox } from "../../../linear/LinearAgentOutbox.ts";
import * as LinearApi from "../../../linear/LinearApi.ts";
import { LinearOAuth } from "../../../linear/LinearOAuth.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";
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
 * Label ids to filter a list by. With a team the names resolve as they do for
 * a write; without one, a name such as "Bug" can belong to several teams, and
 * an issue carrying any label of that name counts.
 */
const resolveLabelFilter = Effect.fn("LinearToolkit.resolveLabelFilter")(function* (
  operation: string,
  teamId: string | undefined,
  labels: ReadonlyArray<string>,
) {
  if (teamId !== undefined) {
    return (yield* resolveLabels(operation, teamId, labels)).map((label) => label.id);
  }
  const linear = yield* LinearApi.LinearApi;
  return yield* Effect.forEach(labels, (label) =>
    linear.listResources({ kind: "label", exact: label, limit: 100 }).pipe(
      Effect.flatMap((page) =>
        page.nodes.length > 0
          ? Effect.succeed(page.nodes.map((node) => node.id))
          : Effect.fail(
              new LinearOperationError({
                operation,
                detail: `Linear has no label matching "${label}". Use list_issue_labels to find it.`,
              }),
            ),
      ),
    ),
  ).pipe(Effect.map((ids) => ids.flat()));
});

type RelationInput = { readonly type: LinearIssueRelationType; readonly issue: string };

const relationPhrases: Record<LinearIssueRelationType, string> = {
  blocks: "Blocks",
  blockedBy: "Blocked by",
  related: "Related to",
  duplicateOf: "Duplicate of",
  duplicatedBy: "Duplicated by",
};

/** "Blocked by DEL-120, Related to DEL-98": relations as the approval lists them. */
const describeRelations = (
  relations: ReadonlyArray<{
    readonly type: LinearIssueRelationType;
    readonly issue: { readonly identifier: string };
  }>,
): string =>
  relations
    .map((relation) => `${relationPhrases[relation.type]} ${relation.issue.identifier}`)
    .join(", ");

/** Whether an agent's `DEL-123`, UUID, or issue link names this issue. */
const namesIssue = (
  reference: string,
  issue: { readonly id: string; readonly identifier: string },
): boolean => {
  const needle = LinearApi.issueReferenceFromText(reference).toUpperCase();
  return issue.id.toUpperCase() === needle || issue.identifier.toUpperCase() === needle;
};

/**
 * Looks up the other issue of each relation to add, skipping any `issue`
 * already has: adding a relation that exists is a no-op, not a duplicate. With
 * no `issue`, the relations are for one that does not exist yet.
 */
const resolveRelationsToAdd = Effect.fn("LinearToolkit.resolveRelationsToAdd")(function* (
  operation: string,
  relations: ReadonlyArray<RelationInput>,
  issue?: LinearIssueDetail,
) {
  const linear = yield* LinearApi.LinearApi;
  const existing = issue?.relations ?? [];
  const resolved: Array<{ type: LinearIssueRelationType; issue: LinearIssueDetail }> = [];
  for (const relation of relations) {
    const has = (otherReference: string) =>
      existing.some(
        (current) => current.type === relation.type && namesIssue(otherReference, current.issue),
      );
    if (has(relation.issue)) continue;
    const other = yield* linear.getIssue({ reference: relation.issue.trim() });
    if (issue !== undefined && other.id === issue.id) {
      return yield* new LinearOperationError({
        operation,
        detail: `${issue.identifier} cannot be related to itself.`,
      });
    }
    if (has(other.id)) continue;
    if (resolved.some((added) => added.type === relation.type && added.issue.id === other.id)) {
      continue;
    }
    resolved.push({ type: relation.type, issue: other });
  }
  return resolved;
});

/**
 * The relations to delete, matched against what `issue` has. Removing one it
 * does not have is a no-op, like adding one it already has: the re-read the
 * agent gets back shows where the issue ended up either way.
 */
const relationsToRemove = (issue: LinearIssueDetail, relations: ReadonlyArray<RelationInput>) =>
  (issue.relations ?? []).filter((current) =>
    relations.some(
      (relation) => relation.type === current.type && namesIssue(relation.issue, current.issue),
    ),
  );

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
 * `settings.linear.confirmAgentWrites` is off or the write goes out as the app
 * rather than as the user (see `confirmedWrite`). Call it once every lookup
 * has resolved and immediately before the mutation, so a mistyped state or
 * label fails on its own terms instead of interrupting the user for a write
 * that could never happen.
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
  // A write that goes out as the Linear app borrows no identity to approve.
  // The credential that decides the author decides the prompt, so the two
  // cannot drift apart.
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

/**
 * Runs a write tool's confirmation and mutation under the identity the write
 * should carry. A delegated run already carries the app credential. A
 * developer assistant team thread writes as the app too while it is connected,
 * like the assistant's own updates on the issue, so what its agents post does
 * not read as the person's. Every other thread, and every read, keeps the
 * connected account.
 */
const confirmedWrite = <A, E, R>(
  operation: string,
  scope: Scope,
  input: Parameters<typeof confirmWrite>[2],
  mutation: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const write = confirmWrite(operation, scope, input).pipe(Effect.andThen(mutation));
    if (
      (yield* LinearApi.LinearAppCredential) !== undefined ||
      assistantTeamThread(scope.threadId) === null
    ) {
      return yield* write;
    }
    const outbox = yield* LinearAgentOutbox;
    // An unreadable connection fails the write rather than posting it under
    // the person's name.
    const asApp = yield* outbox.connected.pipe(
      Effect.mapError(
        () =>
          new LinearOperationError({
            operation,
            detail: "Could not read the Linear app connection.",
          }),
      ),
    );
    if (!asApp) return yield* write;
    const oauth = yield* LinearOAuth;
    return yield* write.pipe(
      Effect.provideService(LinearApi.LinearAppCredential, oauth.accessToken(false)),
    );
  });

/**
 * Large enough for a full-page screenshot, small enough that a mistyped path
 * to a video or a database dump is refused here rather than by storage after
 * the bytes have already left the machine.
 */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

const formatBytes = (bytes: number): string =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/**
 * Where the agent's own paths are rooted: its worktree when the thread has
 * one, and the project's workspace otherwise. This is the directory the
 * provider runs in, so a path the agent just wrote is a path it can name here.
 */
const threadWorkspaceRoot = Effect.fn("LinearToolkit.threadWorkspaceRoot")(function* (
  operation: string,
  scope: Scope,
) {
  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const unreadable = new LinearOperationError({
    operation,
    detail: "Could not read this thread's workspace.",
  });
  const thread = Option.getOrUndefined(
    yield* projections.getThreadShellById(scope.threadId).pipe(Effect.mapError(() => unreadable)),
  );
  if (thread === undefined) return yield* unreadable;
  if (thread.worktreePath !== null) return thread.worktreePath;

  const project = Option.getOrUndefined(
    yield* projections
      .getProjectShellById(thread.projectId)
      .pipe(Effect.mapError(() => unreadable)),
  );
  if (project === undefined) return yield* unreadable;
  return project.workspaceRoot;
});

/**
 * The evidence folder of the assistant task the calling thread belongs to, when
 * the agent named an absolute path inside it. Team threads are told to save
 * screenshots there instead of in the worktree they share, so it is the one
 * place outside the workspace an image may come from, and only for that task.
 */
const taskEvidenceRoot = Effect.fn("LinearToolkit.taskEvidenceRoot")(function* (
  operation: string,
  scope: Scope,
  requested: string,
) {
  const path = yield* Path.Path;
  const team = assistantTeamThread(scope.threadId);
  // Task ids are UUIDs; anything else cannot name a folder of its own.
  if (team === null || !isResourceId(team.taskId) || !path.isAbsolute(requested)) return undefined;
  const evidence = yield* AssistantEvidence;
  const directory = yield* evidence.directory(team.taskId).pipe(
    Effect.mapError(
      () =>
        new LinearOperationError({
          operation,
          detail: "Could not read this task's evidence folder.",
        }),
    ),
  );
  const relative = path.relative(directory, requested);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? directory
    : undefined;
});

/**
 * Everything about an image the agent named except its bytes: enough to
 * describe the upload in an approval, and to refuse a bad path before anything
 * is read.
 *
 * The path is confined to the thread's workspace, or to its task's evidence
 * folder, twice: once as written, and again after the filesystem resolves it,
 * because a symlink inside the root can still point outside it.
 */
const inspectWorkspaceImage = Effect.fn("LinearToolkit.inspectWorkspaceImage")(function* (
  operation: string,
  scope: Scope,
  requested: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const evidenceRoot = yield* taskEvidenceRoot(operation, scope, requested);
  const root = evidenceRoot ?? (yield* threadWorkspaceRoot(operation, scope));
  const outside = new LinearOperationError({
    operation,
    detail:
      assistantTeamThread(scope.threadId) === null
        ? `"${requested}" is outside this thread's workspace. Pass a path inside it, relative to its root.`
        : `"${requested}" is outside this thread's workspace and this task's evidence folder. Pass a path relative to the workspace root, or an absolute path inside the evidence folder.`,
  });
  const unreadable = new LinearOperationError({
    operation,
    detail: `Could not read "${requested}". Pass the path of an image file inside this thread's workspace.`,
  });

  // An agent that names an absolute path is naming a place, not escaping one:
  // it is confined to the same root as any relative path.
  const asWritten = path.isAbsolute(requested) ? path.relative(root, requested) : requested;
  const resolved = yield* workspacePaths
    .resolveRelativePathWithinRoot({ workspaceRoot: root, relativePath: asWritten })
    .pipe(Effect.mapError(() => outside));

  const [canonicalRoot, canonicalFile] = yield* Effect.all([
    fileSystem.realPath(root),
    fileSystem.realPath(resolved.absolutePath),
  ]).pipe(Effect.mapError(() => unreadable));
  const canonicalRelative = path.relative(canonicalRoot, canonicalFile);
  if (
    canonicalRelative.length === 0 ||
    canonicalRelative.startsWith("..") ||
    path.isAbsolute(canonicalRelative)
  ) {
    return yield* outside;
  }

  const info = yield* fileSystem.stat(canonicalFile).pipe(Effect.mapError(() => unreadable));
  if (info.type !== "File") return yield* unreadable;

  // A workspace file is named the way the agent's tools name it; an evidence
  // file has no workspace-relative name, so it keeps its absolute one.
  const displayPath = evidenceRoot === undefined ? resolved.relativePath : resolved.absolutePath;
  const fileName = path.basename(canonicalFile);
  const contentType = imageMimeTypeForFileName(fileName);
  if (contentType === undefined) {
    return yield* new LinearOperationError({
      operation,
      detail: `"${displayPath}" is not an image this server can identify. Pass a PNG, JPEG, GIF, WebP, AVIF, BMP, TIFF, HEIC, ICO, or SVG file.`,
    });
  }
  if (info.size === 0n) {
    return yield* new LinearOperationError({
      operation,
      detail: `"${displayPath}" is empty.`,
    });
  }
  if (info.size > BigInt(MAX_UPLOAD_BYTES)) {
    return yield* new LinearOperationError({
      operation,
      detail: `"${displayPath}" is ${formatBytes(Number(info.size))}, over the ${formatBytes(MAX_UPLOAD_BYTES)} upload limit.`,
    });
  }

  return {
    contentType,
    fileName,
    displayPath,
    inWorkspace: evidenceRoot === undefined,
    sizeBytes: Number(info.size),
    // The approval can sit for minutes; re-reading after it keeps the file out
    // of memory until it is actually going somewhere.
    read: fileSystem.readFile(canonicalFile).pipe(Effect.mapError(() => unreadable)),
  };
});

/** An attachment is a link someone opens from Linear, so only web addresses qualify. */
const isWebUrl = (value: string): boolean => {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
};

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

/** The linked issue's project, named and linked, for writes that default to it. */
const linkedIssueProject = Effect.fn("LinearToolkit.linkedIssueProject")(function* (
  operation: string,
  scope: Scope,
) {
  const issue = yield* resolveIssue(operation, scope, undefined);
  if (issue.project === null) {
    return yield* new LinearOperationError({
      operation,
      detail: `${issue.identifier} has no project. Pass a project explicitly.`,
    });
  }
  return issue.project;
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
  return yield* confirmedWrite(
    `save_${kind}`,
    scope,
    {
      appName: "Linear",
      change: {
        summary: `${current ? "Update" : "Create"} ${kind}${current ? `: ${current.name ?? current.id}` : ""}`,
        ...(current?.url
          ? { record: { label: current.name ?? current.id, url: current.url } }
          : {}),
        fields: [
          ...Object.entries(patch).map(([key, value]) => ({
            label: labels[key] ?? key,
            value:
              value === null ? "None" : Array.isArray(value) ? value.join(", ") : String(value),
          })),
          ...(!current && kind === "label"
            ? [{ label: "Team", value: input.team ?? "Workspace-wide" }]
            : []),
        ],
      },
      args: {
        kind,
        ...patch,
        ...(current ? { id: current.id } : {}),
        ...(teamId ? { teamId } : {}),
      },
    },
    linear.saveResource({
      kind,
      ...patch,
      ...(current ? { id: current.id } : {}),
      ...(teamId ? { teamId } : {}),
    }),
  );
});

export const LinearToolkitHandlersLive = LinearToolkit.toLayer({
  list_issues: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("linear");
      const linear = yield* LinearApi.LinearApi;
      const team = input.team ? yield* lookupTeam("list_issues", input.team) : undefined;
      const project = input.project
        ? yield* resolveResource("project", input.project, team ? { teamId: team.id } : {})
        : undefined;
      const assignee =
        input.assignee == null ? input.assignee : yield* linear.resolveAssignee(input.assignee);
      // A milestone or cycle named by anything but its id is looked up where
      // the write tools look: the project or team given, else the linked issue's.
      const milestoneReference = named(input.milestone);
      const milestone =
        milestoneReference === undefined
          ? undefined
          : yield* resolveResource(
              "milestone",
              milestoneReference,
              project
                ? { projectId: project.id }
                : isResourceId(milestoneReference)
                  ? {}
                  : { projectId: yield* issueProject(scope) },
            );
      const cycleReference = named(input.cycle);
      const cycle =
        cycleReference === undefined
          ? undefined
          : yield* resolveResource(
              "cycle",
              cycleReference,
              team
                ? { teamId: team.id }
                : isResourceId(cycleReference)
                  ? {}
                  : { teamId: (yield* resolveTeam("list_issues", scope, undefined)).id },
            );
      const labelIds = input.labels?.length
        ? yield* resolveLabelFilter("list_issues", team?.id, input.labels)
        : undefined;
      const priorities =
        input.priority === undefined
          ? undefined
          : typeof input.priority === "number"
            ? [input.priority]
            : input.priority;
      return yield* linear.listIssues({
        assignedToMe: false,
        ...(team ? { teamKey: team.key } : {}),
        ...(project ? { projectId: project.id } : {}),
        ...(milestone ? { projectMilestoneId: milestone.id } : {}),
        ...(cycle ? { cycleId: cycle.id } : {}),
        ...(labelIds ? { labelIds } : {}),
        ...(priorities?.length ? { priorities } : {}),
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

  list_documents: (input) =>
    Effect.gen(function* () {
      yield* McpInvocationContext.requireMcpCapability("linear");
      const linear = yield* LinearApi.LinearApi;
      const project = named(input.project);
      return yield* linear.listDocuments({
        query: input.query,
        cursor: input.cursor,
        limit: input.limit,
        ...(project ? { projectId: (yield* resolveResource("project", project)).id } : {}),
      });
    }),

  get_document: (input) =>
    Effect.gen(function* () {
      yield* McpInvocationContext.requireMcpCapability("linear");
      return yield* (yield* LinearApi.LinearApi).getDocument(input.id);
    }),

  save_document: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("linear");
      const linear = yield* LinearApi.LinearApi;
      const title = named(input.title);
      if (input.title !== undefined && title === undefined) {
        return yield* new LinearOperationError({
          operation: "save_document",
          detail: "A document title must not be blank.",
        });
      }
      // Reading the document first turns a slug or link into its UUID, and
      // gives the approval the title and link of what is being changed.
      const current = input.id === undefined ? undefined : yield* linear.getDocument(input.id);
      if (current === undefined && title === undefined) {
        return yield* new LinearOperationError({
          operation: "save_document",
          detail: "A new document needs a title.",
        });
      }
      const requestedProject = named(input.project);
      const project =
        requestedProject !== undefined
          ? yield* resolveResource("project", requestedProject)
          : current === undefined
            ? yield* linkedIssueProject("save_document", scope)
            : undefined;
      if (
        current !== undefined &&
        title === undefined &&
        input.content === undefined &&
        project === undefined
      ) {
        return yield* new LinearOperationError({
          operation: "save_document",
          detail: "Pass at least one field to update.",
        });
      }
      const patch = {
        ...(title !== undefined ? { title } : {}),
        ...(input.content !== undefined ? { content: input.content } : {}),
        ...(project !== undefined ? { projectId: project.id } : {}),
      };
      return yield* confirmedWrite(
        "save_document",
        scope,
        {
          appName: "Linear",
          change: {
            summary:
              current === undefined ? "Create document" : `Update document: ${current.title}`,
            ...(current === undefined
              ? {}
              : { record: { label: current.title, url: current.url } }),
            fields: [
              ...(title === undefined ? [] : [{ label: "Title", value: title }]),
              ...(project === undefined
                ? []
                : [{ label: "Project", value: project.name ?? project.id }]),
              // Content replaces the whole document, so it is reviewed whole.
              ...(input.content === undefined
                ? []
                : [{ label: "Content", value: input.content, format: "markdown" as const }]),
            ],
          },
          args: { ...patch, ...(current === undefined ? {} : { id: current.id }) },
        },
        linear.saveDocument({ ...patch, ...(current === undefined ? {} : { id: current.id }) }),
      );
    }),

  delete_document: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("linear");
      const linear = yield* LinearApi.LinearApi;
      const document = yield* linear.getDocument(input.id);
      yield* confirmedWrite(
        "delete_document",
        scope,
        {
          appName: "Linear",
          change: {
            summary: `Delete document: ${document.title}`,
            record: { label: document.title, url: document.url },
            fields: [
              { label: "Title", value: document.title },
              ...(document.project === null
                ? []
                : [{ label: "Project", value: document.project.name ?? document.project.id }]),
            ],
          },
          args: { id: document.id },
        },
        linear.deleteDocument(document.id),
      );
      return { id: document.id, title: document.title };
    }),

  restore_document: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("linear");
      const linear = yield* LinearApi.LinearApi;
      const document = yield* linear.getDocument(input.id);
      // Nothing to bring back, so nothing to ask the user about.
      if (!document.trashed) {
        return yield* new LinearOperationError({
          operation: "restore_document",
          detail: `"${document.title}" is not in Linear's trash.`,
        });
      }
      return yield* confirmedWrite(
        "restore_document",
        scope,
        {
          appName: "Linear",
          change: {
            summary: `Restore document: ${document.title}`,
            record: { label: document.title, url: document.url },
            fields: [
              { label: "Title", value: document.title },
              ...(document.project === null
                ? []
                : [{ label: "Project", value: document.project.name ?? document.project.id }]),
            ],
          },
          args: { id: document.id },
        },
        linear.restoreDocument(document.id),
      );
    }),

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
        ...(issue.truncated?.includes("comments") ? { truncated: true } : {}),
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
      const parentId = named(input.parentId);
      if (id !== undefined && parentId !== undefined) {
        return yield* new LinearOperationError({
          operation: "save_comment",
          detail:
            "Pass parentId only when creating a reply; an edited comment stays in its thread.",
        });
      }
      const comment = id === undefined ? undefined : yield* linear.getComment(id);
      const parent = parentId === undefined ? undefined : yield* linear.getComment(parentId);
      // The comment being edited, or the one being replied to, decides the issue.
      const anchor = comment ?? parent;
      if (anchor !== undefined && anchor.issue === null) {
        return yield* new LinearOperationError({
          operation: "save_comment",
          detail: "This comment does not belong to an issue.",
        });
      }
      const issue = yield* resolveIssue(
        "save_comment",
        scope,
        named(input.issueId) ?? anchor?.issue?.id,
      );
      if (anchor !== undefined && anchor.issue?.id !== issue.id) {
        return yield* new LinearOperationError({
          operation: "save_comment",
          detail: "The comment does not belong to the specified issue.",
        });
      }
      const body = input.body.trim();
      if (
        body.length === 0 ||
        (input.id !== undefined && id === undefined) ||
        (input.parentId !== undefined && parentId === undefined)
      ) {
        return yield* new LinearOperationError({
          operation: "save_comment",
          detail: "Comment body and supplied comment ids must not be blank.",
        });
      }
      // Linear threads are one level deep, so a reply to a reply is posted
      // under the comment that starts the thread.
      const threadRoot = parent === undefined ? undefined : (parent.parentId ?? parent.id);
      return yield* confirmedWrite(
        "save_comment",
        scope,
        {
          appName: "Linear",
          change: {
            summary: `${comment !== undefined ? "Edit comment on" : parent !== undefined ? "Reply on" : "Comment on"} ${issue.identifier}`,
            record: { label: issue.identifier, url: comment?.url ?? parent?.url ?? issue.url },
            // The comment lands as the agent wrote it, so it is reviewed the
            // same way: as the markdown Linear will render.
            fields: [{ label: "Comment", value: body, format: "markdown" }],
          },
          args: {
            ...input,
            issueId: issue.id,
            ...(threadRoot === undefined ? {} : { parentId: threadRoot }),
          },
        },
        comment !== undefined
          ? linear.updateComment({ id: comment.id, body })
          : linear.createComment({
              issueId: issue.id,
              body,
              ...(threadRoot === undefined ? {} : { parentId: threadRoot }),
            }),
      );
    }),

  delete_comment: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("linear");
      const linear = yield* LinearApi.LinearApi;
      const comment = yield* linear.getComment(input.id.trim());
      if (comment.issue === null) {
        return yield* new LinearOperationError({
          operation: "delete_comment",
          detail: "This comment does not belong to an issue.",
        });
      }
      const issue = yield* resolveIssue("delete_comment", scope, comment.issue.id);
      // Whether the caller wrote the comment is Linear's call: it refuses
      // anyone else, and the refusal reaches the agent as it is.
      yield* confirmedWrite(
        "delete_comment",
        scope,
        {
          appName: "Linear",
          change: {
            summary: `Delete comment on ${issue.identifier}`,
            record: { label: issue.identifier, url: comment.url },
            fields: [{ label: "Comment", value: comment.body, format: "markdown" }],
          },
          args: { id: comment.id, issueId: issue.id },
        },
        linear.deleteComment(comment.id),
      );
      return {
        id: comment.id,
        issue: { id: issue.id, identifier: issue.identifier, url: issue.url },
      };
    }),

  upload_image: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("linear");
      const linear = yield* LinearApi.LinearApi;
      const image = yield* inspectWorkspaceImage("upload_image", scope, input.path.trim());
      const alt = named(input.alt) ?? image.fileName;
      const { url } = yield* confirmedWrite(
        "upload_image",
        scope,
        {
          appName: "Linear",
          change: {
            summary: `Upload ${image.fileName} to Linear`,
            fields: [
              // The review dialog previews `image` fields from the thread's
              // workspace, so an evidence file is shown by its path alone.
              image.inWorkspace
                ? { label: "File", value: image.displayPath, format: "image" }
                : { label: "File", value: image.displayPath },
              { label: "Type", value: `${image.contentType}, ${formatBytes(image.sizeBytes)}` },
            ],
          },
          args: input,
        },
        image.read.pipe(
          Effect.flatMap((bytes) =>
            linear.uploadFile({
              fileName: image.fileName,
              contentType: image.contentType,
              bytes,
            }),
          ),
        ),
      );
      return { url, name: image.fileName, markdown: `![${alt}](${url})` };
    }),

  create_attachment: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("linear");
      const linear = yield* LinearApi.LinearApi;
      const url = input.url.trim();
      if (!isWebUrl(url)) {
        return yield* new LinearOperationError({
          operation: "create_attachment",
          detail: `"${url}" is not a link Linear can open. Pass a full http or https URL.`,
        });
      }
      const title = named(input.title);
      if (title === undefined) {
        return yield* new LinearOperationError({
          operation: "create_attachment",
          detail: "Pass a non-empty title for the link.",
        });
      }
      const subtitle = named(input.subtitle);
      const issue = yield* resolveIssue("create_attachment", scope, named(input.issueId));
      // Linear keys an attachment by issue and URL, so this one replaces its
      // match rather than adding a second; the approval says which happens.
      const replaces = issue.attachments?.some((attachment) => attachment.url === url) ?? false;
      return yield* confirmedWrite(
        "create_attachment",
        scope,
        {
          appName: "Linear",
          change: {
            summary: `${replaces ? "Update link on" : "Attach link to"} ${issue.identifier}`,
            record: { label: issue.identifier, url: issue.url },
            fields: [
              { label: "Title", value: title },
              { label: "URL", value: url },
              ...(subtitle === undefined ? [] : [{ label: "Subtitle", value: subtitle }]),
            ],
          },
          args: { ...input, issueId: issue.id },
        },
        linear.createAttachment({
          issueId: issue.id,
          url,
          title,
          ...(subtitle === undefined ? {} : { subtitle }),
        }),
      );
    }),

  delete_attachment: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("linear");
      const linear = yield* LinearApi.LinearApi;
      const attachment = yield* linear.getAttachment(input.id.trim());
      yield* confirmedWrite(
        "delete_attachment",
        scope,
        {
          appName: "Linear",
          change: {
            summary: `Remove link from ${attachment.issue.identifier}`,
            record: { label: attachment.issue.identifier, url: attachment.issue.url },
            fields: [
              { label: "Title", value: attachment.title },
              { label: "URL", value: attachment.url },
            ],
          },
          args: { id: attachment.id, issueId: attachment.issue.id },
        },
        linear.deleteAttachment(attachment.id),
      );
      return { id: attachment.id, issue: attachment.issue };
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
        input.dueDate === undefined &&
        !input.addRelations?.length &&
        !input.removeRelations?.length
      ) {
        return yield* new LinearOperationError({
          operation: "save_issue",
          detail: "Nothing to save: pass at least one issue field to update.",
        });
      }
      const issue = yield* resolveIssue("save_issue", scope, named(input.id));
      const addedRelations = yield* resolveRelationsToAdd(
        "save_issue",
        input.addRelations ?? [],
        issue,
      );
      const removedRelations = relationsToRemove(issue, input.removeRelations ?? []);
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
      const patch = {
        ...planning.patch,
        ...(assigneeId !== undefined ? { assigneeId } : {}),
        ...(title !== undefined ? { title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(stateId !== undefined ? { stateId } : {}),
        ...(labelIds !== undefined ? { labelIds } : {}),
      };
      // Relations the issue already has (or already lacks) are the only thing
      // that can make a save land nowhere; there is nothing to ask about then.
      if (
        Object.keys(patch).length === 0 &&
        addedRelations.length === 0 &&
        removedRelations.length === 0
      ) {
        return issue;
      }
      yield* confirmedWrite(
        "save_issue",
        scope,
        {
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
              ...(resolvedState === undefined
                ? []
                : [{ label: "State", value: resolvedState.name }]),
              ...(resolvedLabels === undefined
                ? []
                : [
                    {
                      label: "Labels",
                      value: resolvedLabels.map((label) => label.name).join(", "),
                    },
                  ]),
              ...(addedRelations.length === 0
                ? []
                : [{ label: "Add relations", value: describeRelations(addedRelations) }]),
              ...(removedRelations.length === 0
                ? []
                : [{ label: "Remove relations", value: describeRelations(removedRelations) }]),
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
        },
        Effect.gen(function* () {
          if (Object.keys(patch).length > 0) {
            yield* linear.updateIssue({ issueId: issue.id, ...patch });
          }
          yield* Effect.forEach(removedRelations, (relation) =>
            linear.removeIssueRelation(relation.id),
          );
          yield* Effect.forEach(addedRelations, (relation) =>
            linear.addIssueRelation({
              issueId: issue.id,
              type: relation.type,
              otherIssueId: relation.issue.id,
            }),
          );
        }),
      );
      // Re-read so the agent sees what Linear actually stored, including the
      // state and label names it just resolved by name.
      return yield* linear.getIssue({ reference: issue.id });
    }),

  archive_issue: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("linear");
      const linear = yield* LinearApi.LinearApi;
      // The id is required, so an agent that forgot it cannot archive the
      // thread's own issue, which a team thread would do without asking.
      const reference = named(input.id);
      if (reference === undefined) {
        return yield* new LinearOperationError({
          operation: "archive_issue",
          detail: "Pass the issue to archive, such as DEL-123.",
        });
      }
      const issue = yield* linear.getIssue({ reference });
      const archived = input.archived ?? true;
      // Already where the agent wants it: nothing to ask about.
      if ((issue.archivedAt != null) === archived) return issue;
      yield* confirmedWrite(
        "archive_issue",
        scope,
        {
          appName: "Linear",
          change: {
            summary: `${archived ? "Archive" : "Restore"} ${issue.identifier}`,
            record: { label: issue.identifier, url: issue.url },
            fields: [{ label: "Title", value: issue.title }],
          },
          args: { ...input, issueId: issue.id, archived },
        },
        linear.archiveIssue({ issueId: issue.id, archived }),
      );
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
      const relations = yield* resolveRelationsToAdd("create_issue", input.relations ?? []);
      const assignee =
        input.assignee == null ? input.assignee : yield* linear.resolveAssignee(input.assignee);
      const assigneeId = assignee == null ? assignee : assignee.id;
      const stateId = resolvedState?.id;
      const labelIds = resolvedLabels?.map((label) => label.id);
      const title = input.title.trim();
      return yield* confirmedWrite(
        "create_issue",
        scope,
        {
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
                        assignee === null
                          ? "Unassigned"
                          : `${assignee.displayName} (${assignee.id})`,
                    },
                  ]),
              { label: "Title", value: title },
              ...(parent === undefined ? [] : [{ label: "Parent", value: parent.identifier }]),
              ...(resolvedState === undefined
                ? []
                : [{ label: "State", value: resolvedState.name }]),
              ...(resolvedLabels === undefined
                ? []
                : [
                    {
                      label: "Labels",
                      value: resolvedLabels.map((label) => label.name).join(", "),
                    },
                  ]),
              ...(relations.length === 0
                ? []
                : [{ label: "Relations", value: describeRelations(relations) }]),
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
        },
        Effect.gen(function* () {
          const created = yield* linear.createIssue({
            teamId: team.id,
            ...planning.patch,
            ...(assigneeId !== undefined ? { assigneeId } : {}),
            title,
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(parentId !== undefined ? { parentId } : {}),
            ...(stateId !== undefined ? { stateId } : {}),
            ...(labelIds !== undefined ? { labelIds } : {}),
          });
          // Linear has no way to relate issues inside `issueCreate`, so they are
          // linked afterwards. By then the issue exists, and the agent must hear
          // that before it retries and files a second one.
          yield* Effect.forEach(relations, (relation) =>
            linear.addIssueRelation({
              issueId: created.id,
              type: relation.type,
              otherIssueId: relation.issue.id,
            }),
          ).pipe(
            Effect.mapError(
              (error) =>
                new LinearOperationError({
                  operation: "create_issue",
                  detail: `Created ${created.identifier}, but its relations were not all saved: ${error.message} Add them with save_issue instead of creating the issue again.`,
                }),
            ),
          );
          return created;
        }),
      );
    }),
});
