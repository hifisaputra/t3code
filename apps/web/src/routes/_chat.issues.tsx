import type {
  EnvironmentId,
  LinearIssueSummary,
  ProjectId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { resolveLinearRepositoryMapping } from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useDebouncedCallback } from "@tanstack/react-pacer";
import { SearchIcon } from "lucide-react";
import { useCallback, useEffectEvent, useMemo, useState } from "react";

import { LinearIssueThreadDialog } from "../components/LinearIssueThreadDialog";
import { IssueDetailPanel } from "../components/issues/IssueDetailPanel";
import { IssueRow } from "../components/issues/IssueRow";
import { IssuesUnavailableState } from "../components/issues/IssuesUnavailableState";
import {
  collectIssueListFacets,
  linearCapableEnvironments,
  linkedThreadsByIssueIdentifier,
  matchesIssueFilters,
  matchesIssueQuery,
  resolveIssuesEnvironmentId,
  sortIssues,
  type IssueLinkedThread,
} from "../components/issues/issueList.logic";
import {
  issueListPreferences,
  issueListStateTypes,
  writeIssueListPreferences,
  type IssueListPreferencePatch,
  type IssueListPreferences,
  type IssueListStateFilter,
} from "../components/issues/issueListPreferences";
import { Button } from "../components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../components/ui/empty";
import { Input } from "../components/ui/input";
import { RefreshIcon } from "../components/ui/refresh-icon";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { SidebarInset } from "../components/ui/sidebar";
import { Switch } from "../components/ui/switch";
import { Spinner } from "../components/ui/spinner";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { useProjects, useThreadShells } from "../state/entities";
import { useEnvironments } from "../state/environments";
import { linearEnvironment } from "../state/linear";
import { useEnvironmentQuery } from "../state/query";
import { buildThreadRouteParams } from "../threadRoutes";

/** One fetch feeds every client-side filter; the server clamps anything larger. */
const ISSUE_LIST_LIMIT = 100;
const SEARCH_DEBOUNCE_MS = 250;
/** Base UI selects carry a string value, so "no filter" needs one of its own. */
const ALL = "__all__";

const STATE_OPTIONS = [
  { value: "open", label: "Open" },
  { value: "active", label: "Active" },
  { value: "todo", label: "Todo" },
  { value: "backlog", label: "Backlog" },
] as const satisfies ReadonlyArray<{ value: IssueListStateFilter; label: string }>;

type IssuesSearch = IssueListPreferences & {
  /** The issue identifier the detail panel is showing, e.g. `DEL-123`. */
  readonly selected?: string;
};

const boundedSearchValue = (raw: unknown): string | undefined =>
  typeof raw === "string" && raw.trim().length > 0 ? raw.slice(0, 200) : undefined;

export const Route = createFileRoute("/_chat/issues")({
  validateSearch: (raw: Record<string, unknown>): IssuesSearch => {
    const team = boundedSearchValue(raw.team);
    const project = boundedSearchValue(raw.project);
    const cycle = boundedSearchValue(raw.cycle);
    const q = boundedSearchValue(raw.q);
    const selected = boundedSearchValue(raw.selected);
    return {
      state:
        raw.state === "active" || raw.state === "todo" || raw.state === "backlog"
          ? raw.state
          : "open",
      ...(typeof raw.environmentId === "string" && raw.environmentId
        ? { environmentId: raw.environmentId as EnvironmentId }
        : {}),
      ...(raw.scope === "all" ? { scope: "all" } : {}),
      ...(team ? { team } : {}),
      ...(project ? { project } : {}),
      ...(cycle ? { cycle } : {}),
      ...(q ? { q } : {}),
      ...(selected ? { selected } : {}),
    };
  },
  component: IssuesRouteView,
});

function IssuesRouteView() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { environments } = useEnvironments();
  const allProjects = useProjects();
  const threadShells = useThreadShells();

  const linearEnvironments = useMemo(() => linearCapableEnvironments(environments), [environments]);
  const environmentId = useMemo(
    () => resolveIssuesEnvironmentId({ environments, preferred: search.environmentId }),
    [environments, search.environmentId],
  );

  const projects = useMemo(
    () => allProjects.filter((project) => project.environmentId === environmentId),
    [allProjects, environmentId],
  );
  // Where an issue with no mapping starts. Nothing persists it: the page is
  // about issues, and the project is only the checkout the chosen one lands in.
  const [pickedProjectId, setPickedProjectId] = useState<ProjectId | null>(null);
  const project =
    projects.find((candidate) => candidate.id === pickedProjectId) ?? projects[0] ?? null;
  const repositories = useMemo(
    () =>
      environments.find((environment) => environment.environmentId === environmentId)?.serverConfig
        ?.settings.linear.repositories ?? [],
    [environmentId, environments],
  );

  const status = useEnvironmentQuery(
    environmentId ? linearEnvironment.status({ environmentId, input: {} }) : null,
  );
  const issuesQuery = useEnvironmentQuery(
    environmentId
      ? linearEnvironment.issues({
          environmentId,
          input: {
            stateTypes: issueListStateTypes(search.state),
            limit: ISSUE_LIST_LIMIT,
            assignedToMe: search.scope !== "all",
          },
        })
      : null,
  );
  const issues = issuesQuery.data?.issues ?? null;

  const facets = useMemo(() => collectIssueListFacets(issues ?? []), [issues]);
  const filters = useMemo(
    () => ({ team: search.team, project: search.project, cycle: search.cycle }),
    [search.cycle, search.project, search.team],
  );
  const query = search.q ?? "";
  // What is in the box, which is also what the rows are narrowed by: the filter
  // is local, so waiting for the URL to settle would only add lag to typing.
  const [queryInput, setQueryInput] = useState(query);
  const visibleIssues = useMemo(
    () =>
      sortIssues(
        (issues ?? []).filter(
          (issue) => matchesIssueFilters(issue, filters) && matchesIssueQuery(issue, queryInput),
        ),
      ),
    [filters, issues, queryInput],
  );
  const linkedThreads = useMemo(() => linkedThreadsByIssueIdentifier(threadShells), [threadShells]);
  // The fallback only matters for issues nothing maps, so it disappears once
  // every issue on screen already knows its repository.
  const everyIssueMapped = useMemo(
    () =>
      visibleIssues.length > 0 &&
      visibleIssues.every((issue) => resolveLinearRepositoryMapping(repositories, issue) !== null),
    [repositories, visibleIssues],
  );

  // Rebuilt rather than spread so a cleared control leaves the URL instead of
  // lingering as an explicit `undefined`.
  const updateSearch = useCallback(
    (patch: IssueListPreferencePatch & { selected?: string | undefined }) =>
      void navigate({
        search: (previous: IssuesSearch): IssuesSearch => {
          const next = { ...previous, ...patch };
          return {
            state: next.state ?? previous.state,
            ...(next.scope === "all" ? { scope: "all" } : {}),
            ...(next.environmentId ? { environmentId: next.environmentId } : {}),
            ...(next.team ? { team: next.team } : {}),
            ...(next.project ? { project: next.project } : {}),
            ...(next.cycle ? { cycle: next.cycle } : {}),
            ...(next.q ? { q: next.q } : {}),
            ...(next.selected ? { selected: next.selected } : {}),
          };
        },
        replace: true,
      }),
    [navigate],
  );

  // A list control changes what the sidebar link should restore; the selected
  // row is a URL concern and never reaches storage.
  const updateListScope = useCallback(
    (patch: IssueListPreferencePatch) => {
      writeIssueListPreferences(
        issueListPreferences({ ...search, ...patch, state: patch.state ?? search.state }),
      );
      updateSearch(patch);
    },
    [search, updateSearch],
  );

  const commitQuery = useEffectEvent((next: string) => {
    const trimmed = next.trim();
    if (trimmed === query) return;
    updateListScope({ q: trimmed.length > 0 ? trimmed : undefined });
  });
  // The URL is shared and stored, so it settles once the typing stops rather
  // than recording every keystroke as a destination.
  const commitQueryDebounced = useDebouncedCallback(commitQuery, { wait: SEARCH_DEBOUNCE_MS });

  const [dialog, setDialog] = useState<{ reference: string; key: number } | null>(null);
  const openThread = useCallback(
    (thread: IssueLinkedThread) =>
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams({
          environmentId: thread.environmentId,
          threadId: thread.threadId,
        }),
      }),
    [navigate],
  );
  const startThread = useCallback((identifier: string) => {
    setDialog({ reference: identifier, key: Date.now() });
  }, []);
  const selectIssue = useCallback(
    (issue: LinearIssueSummary) => updateSearch({ selected: issue.identifier }),
    [updateSearch],
  );
  const startThreadForIssue = useCallback(
    (issue: LinearIssueSummary) => startThread(issue.identifier),
    [startThread],
  );

  const handleStarted = useCallback(
    (threadRef: ScopedThreadRef) => {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [navigate],
  );

  const filtered = Boolean(search.team || search.project || search.cycle || queryInput.trim());
  const selectedIdentifier = search.selected ?? null;
  const selectedLinkedThread = selectedIdentifier
    ? (linkedThreads.get(selectedIdentifier) ?? null)
    : null;

  // No server holds a key, or the one that did says it is gone: both are the
  // same missing setup, and the filters have nothing to filter until it exists.
  const linearConfigured = environmentId !== null && status.data?.status !== "unconfigured";

  const body = !linearConfigured ? (
    <IssuesUnavailableState
      title="Linear is not connected"
      message="Connect Linear in Settings → Integrations to see your issues."
      showSettingsLink
    />
  ) : status.data?.status === "unauthenticated" ? (
    <IssuesUnavailableState
      title="Linear rejected the key"
      message="The stored API key no longer works. Replace it in Settings → Integrations."
      showSettingsLink
      onRetry={status.refresh}
      refreshing={status.isPending}
    />
  ) : status.data?.status === "failed" ? (
    <IssuesUnavailableState
      message={status.data.detail}
      onRetry={status.refresh}
      refreshing={status.isPending}
    />
  ) : issues === null && issuesQuery.isPending ? (
    <div className="flex items-center gap-2 p-6 text-muted-foreground text-xs">
      <Spinner className="size-3.5" />
      Loading issues...
    </div>
  ) : issues === null ? (
    <IssuesUnavailableState
      message={issuesQuery.error ?? "Linear did not return any issues."}
      onRetry={issuesQuery.refresh}
      refreshing={issuesQuery.isPending}
    />
  ) : (
    <div
      className={cn(
        "grid min-h-0 flex-1",
        selectedIdentifier
          ? "grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]"
          : "grid-cols-1",
      )}
    >
      <div
        className={cn(
          "min-h-0 overflow-y-auto px-2 py-2",
          selectedIdentifier ? "hidden md:block" : undefined,
        )}
      >
        {visibleIssues.length === 0 ? (
          <Empty className="py-16">
            <EmptyHeader>
              <EmptyTitle>{filtered ? "No issues match" : "Nothing assigned"}</EmptyTitle>
              <EmptyDescription>
                {filtered
                  ? "Widen the team, project or cycle filter, or clear the search."
                  : search.scope === "all"
                    ? "No issues in this state."
                    : "No issues assigned to you in this state."}
              </EmptyDescription>
            </EmptyHeader>
            {filtered ? (
              <EmptyContent>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setQueryInput("");
                    updateListScope({
                      team: undefined,
                      project: undefined,
                      cycle: undefined,
                      q: undefined,
                    });
                  }}
                >
                  Clear filters
                </Button>
              </EmptyContent>
            ) : null}
          </Empty>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {visibleIssues.map((issue) => (
              <li key={issue.id}>
                <IssueRow
                  issue={issue}
                  selected={issue.identifier === selectedIdentifier}
                  linkedThread={linkedThreads.get(issue.identifier) ?? null}
                  onSelect={selectIssue}
                  onStartThread={startThreadForIssue}
                  onOpenThread={openThread}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
      {selectedIdentifier ? (
        <div className="min-h-0 overflow-y-auto border-border/60 md:border-l">
          <div className="px-4 pt-3 md:hidden">
            <Button size="sm" variant="ghost" onClick={() => updateSearch({ selected: undefined })}>
              Back to issues
            </Button>
          </div>
          <IssueDetailPanel
            key={selectedIdentifier}
            environmentId={environmentId}
            identifier={selectedIdentifier}
            cwd={project?.workspaceRoot ?? null}
            linkedThread={selectedLinkedThread}
            onStartThread={startThread}
            onOpenThread={openThread}
          />
        </div>
      ) : null}
    </div>
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <WorkspacePageHeader electron={isElectron} className="border-border border-b">
        <h1 className="truncate font-medium text-sm">Issues</h1>
        <div className="min-w-0 flex-1" />
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Refresh issues"
          disabled={issuesQuery.isPending}
          onClick={() => {
            status.refresh();
            issuesQuery.refresh();
          }}
        >
          <RefreshIcon className="size-3.5" refreshing={issuesQuery.isPending} />
        </Button>
      </WorkspacePageHeader>

      {/* The topbar is one fixed-height row, so the controls sit under it where
          they can wrap instead of overflowing a narrow window. */}
      {linearConfigured ? (
        <div className="flex flex-wrap items-center gap-2 border-border/60 border-b px-3 py-2 sm:px-5">
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={search.scope !== "all"}
              onCheckedChange={(checked) => updateListScope({ scope: checked ? undefined : "all" })}
              aria-label="Assigned to me only"
            />
            Assigned to me only
          </label>
          <FilterSelect
            label="State"
            value={search.state}
            options={STATE_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
            onChange={(next) => updateListScope({ state: next as IssueListStateFilter })}
          />
          {linearEnvironments.length > 1 ? (
            <FilterSelect
              label="Server"
              value={environmentId ?? ALL}
              options={linearEnvironments.map((environment) => ({
                value: environment.environmentId,
                label: environment.label,
              }))}
              onChange={(next) => updateListScope({ environmentId: next as EnvironmentId })}
            />
          ) : null}
          {facets.teams.length > 1 ? (
            <FilterSelect
              label="Team"
              value={search.team ?? ALL}
              allLabel="All teams"
              options={facets.teams.map((team) => ({ value: team.key, label: team.name }))}
              onChange={(next) => updateListScope({ team: next === ALL ? undefined : next })}
            />
          ) : null}
          {facets.projects.length > 1 ? (
            <FilterSelect
              label="Project"
              value={search.project ?? ALL}
              allLabel="All projects"
              options={facets.projects.map((entry) => ({ value: entry.id, label: entry.name }))}
              onChange={(next) => updateListScope({ project: next === ALL ? undefined : next })}
            />
          ) : null}
          {facets.cycles.length > 1 ? (
            <FilterSelect
              label="Cycle"
              value={search.cycle ?? ALL}
              allLabel="All cycles"
              options={facets.cycles.map((cycle) => ({ value: cycle.id, label: cycle.label }))}
              onChange={(next) => updateListScope({ cycle: next === ALL ? undefined : next })}
            />
          ) : null}
          {projects.length > 1 && !everyIssueMapped ? (
            <FilterSelect
              label="Default repository"
              value={project?.id ?? ALL}
              options={projects.map((entry) => ({ value: entry.id, label: entry.title }))}
              onChange={(next) => setPickedProjectId(next as ProjectId)}
            />
          ) : null}
          <div className="relative min-w-40 flex-1 sm:max-w-64">
            <SearchIcon
              aria-hidden
              className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 size-3.5 text-muted-foreground"
            />
            <Input
              value={queryInput}
              placeholder="Search issues"
              aria-label="Search issues"
              className="h-8 pl-8 text-sm"
              onChange={(event) => {
                setQueryInput(event.target.value);
                commitQueryDebounced(event.target.value);
              }}
            />
          </div>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{body}</div>

      {environmentId && dialog ? (
        <LinearIssueThreadDialog
          key={dialog.key}
          open
          environmentId={environmentId}
          projects={projects}
          defaultProjectId={project?.id ?? null}
          initialReference={dialog.reference}
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
          onStarted={handleStarted}
        />
      ) : null}
    </SidebarInset>
  );
}

function FilterSelect({
  label,
  value,
  allLabel,
  options,
  onChange,
}: {
  label: string;
  value: string;
  /** Present only for a filter that can be cleared back to everything. */
  allLabel?: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  const active = options.find((option) => option.value === value);
  return (
    <Select value={value} onValueChange={(next) => onChange(String(next))}>
      <SelectTrigger size="sm" className="w-auto min-w-28" aria-label={label}>
        <SelectValue>
          <span className="truncate">{active?.label ?? allLabel ?? label}</span>
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="start" alignItemWithTrigger={false}>
        {allLabel ? (
          <SelectItem hideIndicator value={ALL}>
            {allLabel}
          </SelectItem>
        ) : null}
        {options.map((option) => (
          <SelectItem hideIndicator key={option.value} value={option.value}>
            <span className="truncate">{option.label}</span>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
