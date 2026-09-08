import type {
  EnvironmentId,
  LinearIssueSummary,
  LinearWorkflowStateType,
  ThreadId,
} from "@t3tools/contracts";

/**
 * Everything the issues page derives from the one list it fetches.
 *
 * The page asks the server for my issues once and narrows them here: a team,
 * project or cycle filter must not cost a round trip, and the options those
 * filters offer are the ones actually present in the rows on screen rather
 * than a second listing of the whole workspace.
 */

export interface IssueTeamFacet {
  readonly key: string;
  readonly name: string;
}

export interface IssueProjectFacet {
  readonly id: string;
  readonly name: string;
}

export interface IssueCycleFacet {
  readonly id: string;
  readonly label: string;
}

export interface IssueListFacets {
  readonly teams: ReadonlyArray<IssueTeamFacet>;
  readonly projects: ReadonlyArray<IssueProjectFacet>;
  readonly cycles: ReadonlyArray<IssueCycleFacet>;
}

export interface IssueListFilters {
  /** Team key, e.g. `DEL`. */
  readonly team?: string | undefined;
  /** Linear project id. */
  readonly project?: string | undefined;
  /** Linear cycle id. */
  readonly cycle?: string | undefined;
}

/** "Cycle 12" unless the workspace named it, in which case the name is what people call it. */
export function issueCycleLabel(cycle: NonNullable<LinearIssueSummary["cycle"]>): string {
  const name = cycle.name?.trim() ?? "";
  return name.length > 0 ? name : `Cycle ${cycle.number}`;
}

export function collectIssueListFacets(issues: ReadonlyArray<LinearIssueSummary>): IssueListFacets {
  const teams = new Map<string, IssueTeamFacet>();
  const projects = new Map<string, IssueProjectFacet>();
  // Cycles sort by their number, which the label hides once a cycle is named.
  const cycles = new Map<string, { readonly facet: IssueCycleFacet; readonly number: number }>();
  for (const issue of issues) {
    if (!teams.has(issue.team.key)) {
      teams.set(issue.team.key, { key: issue.team.key, name: issue.team.name });
    }
    if (issue.project && !projects.has(issue.project.id)) {
      projects.set(issue.project.id, { id: issue.project.id, name: issue.project.name });
    }
    if (issue.cycle && !cycles.has(issue.cycle.id)) {
      cycles.set(issue.cycle.id, {
        facet: { id: issue.cycle.id, label: issueCycleLabel(issue.cycle) },
        number: issue.cycle.number,
      });
    }
  }
  return {
    teams: [...teams.values()].toSorted((left, right) => left.name.localeCompare(right.name)),
    projects: [...projects.values()].toSorted((left, right) => left.name.localeCompare(right.name)),
    cycles: [...cycles.values()]
      .toSorted((left, right) => right.number - left.number)
      .map((entry) => entry.facet),
  };
}

export function matchesIssueFilters(issue: LinearIssueSummary, filters: IssueListFilters): boolean {
  if (filters.team && issue.team.key !== filters.team) return false;
  if (filters.project && issue.project?.id !== filters.project) return false;
  if (filters.cycle && issue.cycle?.id !== filters.cycle) return false;
  return true;
}

/** The identifier and the title are what a row shows, so they are what a search reads. */
export function matchesIssueQuery(issue: LinearIssueSummary, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return (
    issue.identifier.toLowerCase().includes(needle) || issue.title.toLowerCase().includes(needle)
  );
}

const STATE_TYPE_RANK: Record<LinearWorkflowStateType, number> = {
  started: 0,
  unstarted: 1,
  triage: 2,
  backlog: 3,
  completed: 4,
  canceled: 5,
  duplicate: 6,
};

/** Linear's `0` means "no priority", which belongs last rather than ahead of urgent. */
function priorityRank(priority: number): number {
  return priority === 0 ? Number.MAX_SAFE_INTEGER : priority;
}

function updatedAtMillis(updatedAt: string): number {
  const parsed = Date.parse(updatedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Work in progress first, then what is most urgent, then whatever moved most recently. */
export function sortIssues(
  issues: ReadonlyArray<LinearIssueSummary>,
): ReadonlyArray<LinearIssueSummary> {
  return issues.toSorted(
    (left, right) =>
      STATE_TYPE_RANK[left.state.type] - STATE_TYPE_RANK[right.state.type] ||
      priorityRank(left.priority) - priorityRank(right.priority) ||
      updatedAtMillis(right.updatedAt) - updatedAtMillis(left.updatedAt),
  );
}

export interface IssueLinkedThread {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

interface LinkedIssueThreadShell {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly updatedAt: string;
  readonly archivedAt?: string | null | undefined;
  readonly linkedIssue?: { readonly identifier: string } | null | undefined;
}

/**
 * The thread a row's "Open thread" opens, per issue identifier.
 *
 * An issue can be worked on more than once; the live one is the thread that
 * moved last. Archived threads are finished work and never win, so an issue
 * whose only thread is archived reads as unstarted and offers a new one.
 */
export function linkedThreadsByIssueIdentifier(
  shells: ReadonlyArray<LinkedIssueThreadShell>,
): ReadonlyMap<string, IssueLinkedThread> {
  const chosen = new Map<string, { readonly thread: IssueLinkedThread; readonly at: number }>();
  for (const shell of shells) {
    const identifier = shell.linkedIssue?.identifier;
    if (!identifier || shell.archivedAt != null) continue;
    const at = updatedAtMillis(shell.updatedAt);
    const held = chosen.get(identifier);
    if (held && held.at >= at) continue;
    chosen.set(identifier, {
      thread: { environmentId: shell.environmentId, threadId: shell.id },
      at,
    });
  }
  return new Map([...chosen].map(([identifier, entry]) => [identifier, entry.thread]));
}

interface IssuesEnvironmentCandidate {
  readonly environmentId: EnvironmentId;
  readonly serverConfig?: {
    readonly settings: { readonly linear: { readonly apiKey: string } };
  } | null;
}

/**
 * The servers that can answer for Linear at all: a key is stored per server,
 * and one without a key has nothing to list. The redaction marker a client
 * receives is non-empty exactly when a key is set.
 */
export function linearCapableEnvironments<A extends IssuesEnvironmentCandidate>(
  environments: ReadonlyArray<A>,
): ReadonlyArray<A> {
  return environments.filter(
    (environment) => (environment.serverConfig?.settings.linear.apiKey ?? "").length > 0,
  );
}

/** The server the URL asks for while it still has a key, else the first that does. */
export function resolveIssuesEnvironmentId(input: {
  readonly environments: ReadonlyArray<IssuesEnvironmentCandidate>;
  readonly preferred?: EnvironmentId | undefined;
}): EnvironmentId | null {
  const capable = linearCapableEnvironments(input.environments);
  const preferred = capable.find((environment) => environment.environmentId === input.preferred);
  return preferred?.environmentId ?? capable[0]?.environmentId ?? null;
}
