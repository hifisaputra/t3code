import {
  assistantTaskHoldsProject,
  type AssistantBoard,
  type AssistantDecision,
  type AssistantSetup,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { getAssistantSetupState } from "@t3tools/client-runtime/state/developerAssistant";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import {
  BotIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleIcon,
  PlusIcon,
  ServerIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { isElectron } from "~/env";
import { cn } from "~/lib/utils";
import { developerAssistant } from "~/state/developerAssistant";
import { useProjects } from "~/state/entities";
import { useEnvironments, type EnvironmentPresentation } from "~/state/environments";
import { linearEnvironment } from "~/state/linear";
import { useEnvironmentQuery } from "~/state/query";
import { buildThreadRouteParams } from "~/threadRoutes";

import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset, SidebarTrigger } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { AssistantProjectRow, AssistantSetupRow } from "./AssistantProjectCard";
import { AssistantProjectPanel, type ProjectPanelTab } from "./AssistantProjectPanel";
import { AssistantSetupDialog } from "./AssistantSetupDialog";
import { AssistantSetupSheet } from "./AssistantSetupReview";
import { inboxElementId, InboxItemCard, type InboxContext } from "./AssistantInbox";
import { ActiveTaskCard, AssistantHistory, AssistantQueue } from "./AssistantWork";
import { activeTasksFor, buildInbox, historyTasks, queuedTasks } from "./assistantBoard.logic";
import { SectionHeading, StatusDot } from "./assistantUi";

const NEEDS_YOU_ID = "assistant-needs-you";

export function DeveloperAssistantPage() {
  const { environments } = useEnvironments();
  const { environment: chosen } = useSearch({ from: "/_chat/assistant" });
  const environment =
    environments.find((e) => e.environmentId === chosen) ??
    environments.find((e) => e.serverConfig?.settings.linear.apiKey) ??
    environments[0];
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      {environment ? (
        <AssistantEnvironment
          key={environment.environmentId}
          environment={environment}
          environments={environments}
        />
      ) : (
        <>
          <PageHeader environments={environments} environment={undefined} />
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No environment</EmptyTitle>
              <EmptyDescription>
                Connect a T3 server to use the developer assistant.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </>
      )}
    </SidebarInset>
  );
}

/** The page title and environment switch, with a short summary of the board on the right. */
function PageHeader({
  environments,
  environment,
  summary,
}: {
  environments: ReadonlyArray<EnvironmentPresentation>;
  environment: EnvironmentPresentation | undefined;
  summary?: ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <WorkspacePageHeader electron={isElectron} className="border-border border-b">
      <SidebarTrigger className="md:hidden" />
      <BotIcon aria-hidden className="size-4 text-muted-foreground" />
      <h1 className="truncate font-medium text-sm">Developer assistant</h1>
      {environments.length > 1 && environment ? (
        <Select
          value={environment.environmentId}
          onValueChange={(next) =>
            void navigate({ to: "/assistant", search: { environment: next as EnvironmentId } })
          }
        >
          <SelectTrigger
            size="xs"
            variant="ghost"
            className="w-auto max-w-48"
            aria-label="Environment"
          >
            <SelectValue>
              <span className="flex min-w-0 items-center gap-1.5">
                <ServerIcon className="size-3.5" />
                <span className="truncate">{environment.label}</span>
              </span>
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="start" alignItemWithTrigger={false}>
            {environments.map((e) => (
              <SelectItem key={e.environmentId} value={e.environmentId}>
                {e.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : null}
      {summary ? <div className="ml-auto flex shrink-0 items-center">{summary}</div> : null}
    </WorkspacePageHeader>
  );
}

/**
 * The header's one-line answer to "does anything need me?". A count scrolls to
 * the Needs you section; otherwise a quiet line says why nothing does.
 */
function BoardSummary({ board, needsYou }: { board: AssistantBoard; needsYou: number }) {
  if (needsYou > 0)
    return (
      <Button
        size="xs"
        variant="ghost"
        onClick={() =>
          document
            .getElementById(NEEDS_YOU_ID)
            ?.scrollIntoView({ behavior: "smooth", block: "start" })
        }
      >
        <StatusDot tone="attention" className="size-1.5" />
        {needsYou === 1 ? "1 needs you" : `${needsYou} need you`}
      </Button>
    );
  const running = board.projects.some((p) => p.status !== "stopped");
  return (
    <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
      {running ? (
        <>
          <CircleCheckIcon aria-hidden className="size-3.5 text-success-foreground" />
          Nothing needs you
        </>
      ) : board.projects.length > 0 ? (
        "Every project is stopped"
      ) : (
        "Finish a setup to start"
      )}
    </span>
  );
}

type SetupDialogState = { key: number; projectId: ProjectId | null } | null;
type PanelState = { projectId: ProjectId; tab: ProjectPanelTab; open: boolean } | null;

function AssistantEnvironment({
  environment,
  environments,
}: {
  environment: EnvironmentPresentation;
  environments: ReadonlyArray<EnvironmentPresentation>;
}) {
  const environmentId = environment.environmentId;
  const navigate = useNavigate();
  const allProjects = useProjects();
  const projects = useMemo(
    () => allProjects.filter((p) => p.environmentId === environmentId),
    [allProjects, environmentId],
  );
  const board = useEnvironmentQuery(developerAssistant.board({ environmentId, input: {} }));
  const setupState = getAssistantSetupState(
    projects.map((project) => project.id),
    board,
  );
  const hasProjects = (board.data?.projects.length ?? 0) > 0;
  const workspace = useEnvironmentQuery(
    hasProjects ? linearEnvironment.workspace({ environmentId, input: {} }) : null,
  );
  const [dialog, setDialog] = useState<SetupDialogState>(null);
  const [reviewing, setReviewing] = useState<ThreadId | null>(null);
  // Kept after closing so the sheet still has its project while it animates out.
  const [panel, setPanel] = useState<PanelState>(null);
  const [recentFilter, setRecentFilter] = useState<ProjectId | null>(null);
  // Several rows may be open at once, so a half-written answer survives opening another.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const showDecision = (decision: AssistantDecision) => {
    const key = `decision:${decision.id}`;
    setExpanded((current) => new Set(current).add(key));
    requestAnimationFrame(() =>
      document
        .getElementById(inboxElementId(key))
        ?.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
  };

  const openThread = (threadId: ThreadId) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams({ environmentId, threadId }),
    });
  const openSetup = (projectId: ProjectId | null) => setDialog({ key: Date.now(), projectId });
  const openPanel = (projectId: ProjectId, tab: ProjectPanelTab = "setup") =>
    setPanel({ projectId, tab, open: true });
  const closePanel = () => setPanel((current) => (current ? { ...current, open: false } : null));

  if (board.data === null) {
    return (
      <>
        <PageHeader environments={environments} environment={environment} />
        {board.error ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>Could not reach the assistant</EmptyTitle>
              <EmptyDescription>{board.error}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <BoardGhost />
        )}
      </>
    );
  }

  const data = board.data;
  const projectTitle = (id: ProjectId) => projects.find((p) => p.id === id)?.title ?? "Project";
  // A project being revised has both a row and a setup row; it is still one
  // assistant, so names only appear once two repositories are really involved.
  const assistantProjectIds = new Set<ProjectId>([
    ...data.projects.map((p) => p.config.projectId),
    ...(data.setups ?? []).map((s) => s.preferences.projectId),
  ]);
  const multiple = assistantProjectIds.size > 1;
  const projectLabel = (id: ProjectId) => (multiple ? projectTitle(id) : null);
  const inbox = buildInbox(data);
  const stuck = new Set(inbox.flatMap((item) => (item.kind === "stuck" ? [item.task.id] : [])));
  const active = data.tasks.filter((t) => assistantTaskHoldsProject(t.status) && !stuck.has(t.id));
  const history = historyTasks(data);
  const queued = queuedTasks(data);
  // A filter on a project that has since been removed falls back to every project.
  const filterProject =
    data.projects.length > 1 && data.projects.some((p) => p.config.projectId === recentFilter)
      ? recentFilter
      : null;
  const recent = filterProject ? history.filter((t) => t.projectId === filterProject) : history;
  const linearProjectName = (id: string) =>
    workspace.data?.teams.flatMap((t) => t.projects).find((p) => p.id === id)?.name ?? null;
  const reviewingSetup = data.setups?.find((s) => s.threadId === reviewing) ?? null;
  const panelProject = panel
    ? (data.projects.find((p) => p.config.projectId === panel.projectId) ?? null)
    : null;
  const inboxContext: InboxContext = {
    environmentId,
    projectLabel,
    projectTitle,
    tasks: data.tasks,
    projects: data.projects,
    onOpenThread: openThread,
    onReviewSetup: (setup: AssistantSetup) => setReviewing(setup.threadId),
    isExpanded: (key) => expanded.has(key),
    onToggle: toggle,
  };
  const empty = !hasProjects && (data.setups?.length ?? 0) === 0;
  // A dropped stream still leaves a usable snapshot: the reason only hides the
  // button when there is genuinely nothing to add.
  const canAdd =
    setupState.unavailableReason === null ||
    (setupState.unavailableReason === "connection" && setupState.availableProjectIds.length > 0);
  // Hidden rather than disabled when every repository already has one: there
  // is nothing to add, and a dead button would only raise the question.
  const addButton = canAdd ? (
    <Button size="xs" variant="ghost" onClick={() => openSetup(null)}>
      <PlusIcon />
      Add project
    </Button>
  ) : null;

  return (
    <>
      <PageHeader
        environments={environments}
        environment={environment}
        summary={empty ? null : <BoardSummary board={data} needsYou={inbox.length} />}
      />
      <main className="min-h-0 flex-1 overflow-y-auto">
        {board.error ? <StaleBoardWarning reason={board.error} /> : null}
        {empty ? (
          <Onboarding
            environment={environment}
            hasRepository={projects.length > 0}
            onAdd={() => openSetup(null)}
            canAdd={canAdd}
          />
        ) : (
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 py-5 sm:px-6 lg:py-6">
            <section aria-label="Assistants" className="flex flex-col gap-2">
              <SectionHeading action={addButton}>
                {multiple ? "Assistants" : "Assistant"}
              </SectionHeading>
              <ul className="flex flex-col divide-y divide-border/70 overflow-hidden rounded-xl border border-border/70 bg-card shadow-xs/5">
                {data.setups?.map((setup) => (
                  <AssistantSetupRow
                    key={setup.threadId}
                    environmentId={environmentId}
                    setup={setup}
                    title={projectTitle(setup.preferences.projectId)}
                    onOpenThread={openThread}
                    onReview={() => setReviewing(setup.threadId)}
                  />
                ))}
                {data.projects.map((project) => (
                  <AssistantProjectRow
                    key={project.config.projectId}
                    environmentId={environmentId}
                    project={project}
                    title={projectTitle(project.config.projectId)}
                    activeTasks={activeTasksFor(data, project.config.projectId)}
                    onEditSetup={() => openSetup(project.config.projectId)}
                    onOpenDetails={() => openPanel(project.config.projectId)}
                  />
                ))}
              </ul>
            </section>

            {inbox.length > 0 ? (
              <section
                id={NEEDS_YOU_ID}
                aria-label="Needs you"
                className="flex scroll-mt-4 flex-col gap-3"
              >
                <SectionHeading count={inbox.length}>Needs you</SectionHeading>
                {inbox.map((item) => (
                  <InboxItemCard key={item.key} item={item} context={inboxContext} />
                ))}
              </section>
            ) : null}

            <section aria-label="In progress" className="flex flex-col gap-2">
              <SectionHeading count={active.length}>In progress</SectionHeading>
              {active.length > 0 ? (
                <div className="flex flex-col gap-3">
                  {active.map((task) => (
                    <ActiveTaskCard
                      key={task.id}
                      environmentId={environmentId}
                      task={task}
                      project={data.projects.find((p) => p.config.projectId === task.projectId)}
                      projectLabel={projectLabel(task.projectId)}
                      decisions={data.decisions}
                      board={data}
                      onOpenThread={openThread}
                      onShowDecision={showDecision}
                    />
                  ))}
                </div>
              ) : (
                <p className="text-muted-foreground text-sm">
                  No team at work.
                  {data.projects.length > 0 && queued.length === 0
                    ? " Dispatch an issue to start one."
                    : ""}
                </p>
              )}
            </section>

            {queued.length > 0 ? (
              <section aria-label="Up next" className="flex flex-col gap-2">
                <SectionHeading count={queued.length}>Up next</SectionHeading>
                <AssistantQueue
                  environmentId={environmentId}
                  tasks={queued}
                  projectLabel={(task) => projectLabel(task.projectId)}
                />
              </section>
            ) : null}

            {history.length > 0 ? (
              <section aria-label="Recent" className="flex flex-col gap-2">
                <SectionHeading
                  action={
                    data.projects.length > 1 ? (
                      <ToggleGroup
                        aria-label="Show recent issues for"
                        variant="segmented"
                        value={[filterProject ?? "all"]}
                        onValueChange={(value) => {
                          const next = value[0];
                          if (next) setRecentFilter(next === "all" ? null : (next as ProjectId));
                        }}
                      >
                        <Toggle value="all">All</Toggle>
                        {data.projects.map((project) => (
                          <Toggle key={project.config.projectId} value={project.config.projectId}>
                            {projectTitle(project.config.projectId)}
                          </Toggle>
                        ))}
                      </ToggleGroup>
                    ) : null
                  }
                >
                  Recent
                </SectionHeading>
                {recent.length > 0 ? (
                  <AssistantHistory
                    key={filterProject ?? "all"}
                    environmentId={environmentId}
                    board={data}
                    tasks={recent}
                    projectLabel={(task) => (filterProject ? null : projectLabel(task.projectId))}
                    onOpenThread={openThread}
                  />
                ) : (
                  <p className="text-muted-foreground text-sm">
                    {filterProject ? projectTitle(filterProject) : "This project"} has not finished
                    an issue yet.
                  </p>
                )}
              </section>
            ) : null}
          </div>
        )}

        {dialog ? (
          <AssistantSetupDialog
            key={dialog.key}
            open
            onOpenChange={(open) => {
              if (!open) setDialog(null);
            }}
            environment={environment}
            projectIds={dialog.projectId ? [dialog.projectId] : setupState.availableProjectIds}
            initial={
              dialog.projectId
                ? (data.projects.find((p) => p.config.projectId === dialog.projectId)?.config ??
                  null)
                : null
            }
            pendingSetup={
              dialog.projectId
                ? (data.setups?.find((s) => s.preferences.projectId === dialog.projectId) ?? null)
                : null
            }
            onStarted={openThread}
          />
        ) : null}
        <AssistantSetupSheet
          setup={reviewingSetup}
          environmentId={environmentId}
          open={reviewingSetup !== null}
          onOpenChange={(open) => {
            if (!open) setReviewing(null);
          }}
          onOpenThread={openThread}
        />
        <AssistantProjectPanel
          environmentId={environmentId}
          board={data}
          project={panelProject}
          title={panelProject ? projectTitle(panelProject.config.projectId) : ""}
          linearProjectName={
            panelProject ? linearProjectName(panelProject.config.linearProjectId) : null
          }
          providers={environment.serverConfig?.providers ?? []}
          activeTasks={panelProject ? activeTasksFor(data, panelProject.config.projectId) : []}
          historyTasks={
            panelProject ? history.filter((t) => t.projectId === panelProject.config.projectId) : []
          }
          open={panel?.open ?? false}
          tab={panel?.tab ?? "setup"}
          onTabChange={(tab) => setPanel((current) => (current ? { ...current, tab } : null))}
          onOpenChange={(open) => {
            if (!open) closePanel();
          }}
          onEditSetup={() => {
            closePanel();
            if (panelProject) openSetup(panelProject.config.projectId);
          }}
          onOpenThread={(threadId) => {
            closePanel();
            openThread(threadId);
          }}
        />
      </main>
    </>
  );
}

/**
 * The board keeps rendering its last snapshot when the stream drops, so say so
 * rather than letting stale rows look live. The page stays usable meanwhile.
 */
function StaleBoardWarning({ reason }: { reason: string }) {
  return (
    <div
      role="status"
      className="mx-auto flex w-full max-w-4xl items-start gap-2.5 px-4 pt-4 sm:px-6"
    >
      <div className="flex min-w-0 flex-1 items-start gap-2.5 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2">
        <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning-foreground" />
        <p className="min-w-0 text-sm text-warning-foreground">
          The board is not updating: {reason.replace(/[.\s]+$/, "")}. Reconnecting…
        </p>
      </div>
    </div>
  );
}

function Step({ done, children }: { done: boolean; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      {done ? (
        <CircleCheckIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-success-foreground" />
      ) : (
        <CircleIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground/60" />
      )}
      <span className={cn("text-sm", done && "text-muted-foreground")}>{children}</span>
    </li>
  );
}

/** First visit: what the assistant does, and what has to be true before it can. */
function Onboarding({
  environment,
  hasRepository,
  canAdd,
  onAdd,
}: {
  environment: EnvironmentPresentation;
  hasRepository: boolean;
  canAdd: boolean;
  onAdd: () => void;
}) {
  const linear = environment.serverConfig?.settings.linear;
  const linearConnected = Boolean(linear?.apiKey);
  const agentAccess = Boolean(linear?.agentAccess);
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6 px-4 py-12 sm:py-16">
      <Empty className="flex-none p-0 md:p-0">
        <EmptyMedia variant="icon">
          <BotIcon />
        </EmptyMedia>
        <EmptyHeader className="max-w-md">
          <EmptyTitle>Hand your Linear issues to an assistant</EmptyTitle>
          <EmptyDescription>
            It picks the next issue, runs a coding worker in its own worktree, reviews and merges
            the work, and checks it on staging. You answer its questions and review what lands.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
      <div className="rounded-xl border border-border/70 bg-card p-5">
        <p className="mb-3 font-medium text-sm">Before you start</p>
        <ul className="flex flex-col gap-2.5">
          <Step done={linearConnected}>
            Connect Linear in{" "}
            <Link to="/settings/integrations" className="underline underline-offset-2">
              Settings → Integrations
            </Link>
            .
          </Step>
          <Step done={agentAccess}>Turn on Linear agent access in the same place.</Step>
          <Step done={hasRepository}>Add your repository as a project from the sidebar.</Step>
          <li className="flex items-start gap-2.5">
            <CircleDashedIcon
              aria-hidden
              className="mt-0.5 size-4 shrink-0 text-muted-foreground/60"
            />
            <span className="text-muted-foreground text-sm">
              An integration branch that deploys to staging on every push. The assistant checks the
              rest during setup.
            </span>
          </li>
        </ul>
        <Button className="mt-5 w-full sm:w-auto" disabled={!canAdd} onClick={onAdd}>
          <PlusIcon />
          Add a project
        </Button>
      </div>
    </div>
  );
}

function BoardGhost() {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 py-5 sm:px-6 lg:py-6">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-28 rounded-xl" />
      </div>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-20 rounded-xl" />
      </div>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-40 rounded-xl" />
      </div>
    </div>
  );
}
