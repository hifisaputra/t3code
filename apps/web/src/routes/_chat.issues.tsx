import { CalendarPlanner } from "../components/calendar/CalendarPlanner";
import { CalendarAgenda } from "../components/calendar/CalendarAgenda";
import type {
  EnvironmentId,
  LinearIssueSummary,
  ProjectId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { resolveLinearRepositoryMapping } from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useDebouncedCallback } from "@tanstack/react-pacer";
import { ArrowLeftIcon, CalendarDaysIcon, CalendarRangeIcon, ListIcon } from "lucide-react";
import { useCallback, useEffectEvent, useMemo, useState } from "react";

import { LinearIssueThreadDialog } from "../components/LinearIssueThreadDialog";
import { IssueDetailPanel } from "../components/issues/IssueDetailPanel";
import { IssueListGhost } from "../components/issues/IssueGhosts";
import { IssueListToolbar } from "../components/issues/IssueListToolbar";
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
} from "../components/issues/issueListPreferences";
import { Button } from "../components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../components/ui/empty";
import { RefreshIcon } from "../components/ui/refresh-icon";
import { SidebarInset } from "../components/ui/sidebar";
import { Spinner } from "../components/ui/spinner";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
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

/** The list, or one of the two calendar views the same issues feed. */
type IssuesView = "list" | "agenda" | "plan";

const VIEW_TABS = [
  { value: "list", label: "List", Icon: ListIcon },
  { value: "agenda", label: "Agenda", Icon: CalendarDaysIcon },
  { value: "plan", label: "Plan", Icon: CalendarRangeIcon },
] as const satisfies ReadonlyArray<{ value: IssuesView; label: string; Icon: typeof ListIcon }>;

type IssuesSearch = IssueListPreferences & {
  /** The issue identifier the detail panel is showing, e.g. `DEL-123`. */
  readonly selected?: string;
  /** Which view is on screen; absent is the list. Never stored: it is where
      the reader is, not how they narrowed the issues. */
  readonly view?: "agenda" | "plan";
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
      ...(raw.view === "agenda" || raw.view === "plan" ? { view: raw.view } : {}),
    };
  },
  component: IssuesRouteView,
});

function IssuesRouteView() {
  const search = Route.useSearch();
  const view: IssuesView = search.view ?? "list";
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
  const linkedThreads = useMemo(
    () =>
      linkedThreadsByIssueIdentifier(
        threadShells.filter((thread) => thread.environmentId === environmentId),
      ),
    [threadShells, environmentId],
  );
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
    (
      patch: IssueListPreferencePatch & {
        selected?: string | undefined;
        view?: IssuesView | undefined;
      },
    ) =>
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
            ...(next.view === "agenda" || next.view === "plan" ? { view: next.view } : {}),
          };
        },
        replace: true,
      }),
    [navigate],
  );

  // A list control changes what the sidebar link should restore; the selected
  // row and the view are URL concerns and never reach storage.
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
  const changeQuery = useCallback(
    (next: string) => {
      setQueryInput(next);
      commitQueryDebounced(next);
    },
    [commitQueryDebounced],
  );

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
  const refreshing = issuesQuery.isPending;

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
    <div className="min-h-0 overflow-y-auto px-2 py-2">
      <IssueListGhost />
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
                  showAssignee={search.scope === "all"}
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
          {/* Narrow enough and the detail is the whole page, so the way back
              rides above it rather than scrolling away with the issue. */}
          <div className="sticky top-0 z-10 flex items-center border-border/60 border-b bg-background/90 px-2 py-1.5 backdrop-blur md:hidden">
            <Button size="sm" variant="ghost" onClick={() => updateSearch({ selected: undefined })}>
              <ArrowLeftIcon aria-hidden />
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
        <ToggleGroup
          aria-label="Issues view"
          variant="segmented"
          value={[view]}
          onValueChange={(next) => {
            const value = next[0];
            if (!value || value === view) return;
            updateSearch({ view: value === "list" ? undefined : (value as IssuesView) });
          }}
        >
          {VIEW_TABS.map((tab) => (
            <Toggle key={tab.value} value={tab.value} aria-label={tab.label}>
              <tab.Icon aria-hidden />
              <span className="sr-only sm:not-sr-only">{tab.label}</span>
            </Toggle>
          ))}
        </ToggleGroup>
        <div className="min-w-0 flex-1" />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Refresh issues"
                disabled={refreshing}
                onClick={() => {
                  status.refresh();
                  issuesQuery.refresh();
                }}
              />
            }
          >
            <RefreshIcon className="size-3.5" refreshing={refreshing} />
          </TooltipTrigger>
          <TooltipPopup>Refresh</TooltipPopup>
        </Tooltip>
      </WorkspacePageHeader>

      {/* The agenda is the calendar's own list of days, which none of these
          narrow; the plan reads the same filtered issues the list does. */}
      {linearConfigured && view !== "agenda" ? (
        <IssueListToolbar
          state={search.state}
          scope={search.scope === "all" ? "all" : "mine"}
          query={queryInput}
          onQueryChange={changeQuery}
          facets={facets}
          team={search.team}
          project={search.project}
          cycle={search.cycle}
          environments={linearEnvironments}
          environmentId={environmentId}
          projects={projects}
          projectId={project?.id ?? null}
          showRepositoryPicker={!everyIssueMapped}
          onPickProject={setPickedProjectId}
          onChange={updateListScope}
        >
          <span className="ml-auto flex shrink-0 items-center gap-1.5 text-muted-foreground text-xs tabular-nums">
            {visibleIssues.length === 1 ? "1 issue" : `${visibleIssues.length} issues`}
            {issues !== null && refreshing ? <Spinner className="size-3" /> : null}
          </span>
        </IssueListToolbar>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {view === "plan" && environmentId ? (
          <CalendarPlanner
            key={environmentId}
            environmentId={environmentId}
            issues={visibleIssues}
            issuesPending={issuesQuery.isPending}
            issuesError={issuesQuery.error}
            hasThread={(identifier) =>
              linkedThreads.get(identifier)?.environmentId === environmentId
            }
            onWork={(identifier) => {
              const thread = linkedThreads.get(identifier);
              if (thread?.environmentId === environmentId) openThread(thread);
              else startThread(identifier);
            }}
          />
        ) : view === "agenda" && environmentId ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-4xl px-4 py-4 sm:px-6">
              <CalendarAgenda
                key={environmentId}
                environmentId={environmentId}
                hasThread={(identifier) =>
                  linkedThreads.get(identifier)?.environmentId === environmentId
                }
                onWork={(identifier) => {
                  const thread = linkedThreads.get(identifier);
                  if (thread?.environmentId === environmentId) openThread(thread);
                  else startThread(identifier);
                }}
              />
            </div>
          </div>
        ) : (
          body
        )}
      </div>

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
