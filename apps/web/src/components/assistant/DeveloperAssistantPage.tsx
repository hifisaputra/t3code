import {
  assistantTaskHoldsProject,
  type AssistantBoard,
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
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { AssistantProjectCard, AssistantSetupCard } from "./AssistantProjectCard";
import { AssistantSetupDialog } from "./AssistantSetupDialog";
import { AssistantSetupSheet } from "./AssistantSetupReview";
import { InboxItemCard, type InboxContext } from "./AssistantInbox";
import { ActiveTaskCard, AssistantHistory } from "./AssistantWork";
import { activeTaskFor, buildInbox, historyTasks } from "./assistantBoard.logic";
import { SectionHeading } from "./assistantUi";

export function DeveloperAssistantPage() {
  const { environments } = useEnvironments();
  const { environment: chosen } = useSearch({ from: "/_chat/assistant" });
  const navigate = useNavigate();
  const environment =
    environments.find((e) => e.environmentId === chosen) ??
    environments.find((e) => e.serverConfig?.settings.linear.apiKey) ??
    environments[0];
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
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
      </WorkspacePageHeader>
      {environment ? (
        <AssistantEnvironment key={environment.environmentId} environment={environment} />
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No environment</EmptyTitle>
            <EmptyDescription>Connect a T3 server to use the developer assistant.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </SidebarInset>
  );
}

type SetupDialogState = { key: number; projectId: ProjectId | null } | null;

function AssistantEnvironment({ environment }: { environment: EnvironmentPresentation }) {
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

  const openThread = (threadId: ThreadId) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams({ environmentId, threadId }),
    });
  const openSetup = (projectId: ProjectId | null) => setDialog({ key: Date.now(), projectId });

  if (board.data === null) {
    return board.error ? (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Could not reach the assistant</EmptyTitle>
          <EmptyDescription>{board.error}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    ) : (
      <BoardGhost />
    );
  }

  const data = board.data;
  const projectTitle = (id: ProjectId) => projects.find((p) => p.id === id)?.title ?? "Project";
  const multiple = data.projects.length + (data.setups?.length ?? 0) > 1;
  const projectLabel = (id: ProjectId) => (multiple ? projectTitle(id) : null);
  const inbox = buildInbox(data);
  const stuck = new Set(inbox.flatMap((item) => (item.kind === "stuck" ? [item.task.id] : [])));
  const active = data.tasks.filter((t) => assistantTaskHoldsProject(t.status) && !stuck.has(t.id));
  const history = historyTasks(data);
  const linearProjectName = (id: string) =>
    workspace.data?.teams.flatMap((t) => t.projects).find((p) => p.id === id)?.name ?? null;
  const reviewingSetup = data.setups?.find((s) => s.threadId === reviewing) ?? null;
  const inboxContext: InboxContext = {
    environmentId,
    projectLabel,
    projectTitle,
    tasks: data.tasks,
    projects: data.projects,
    onOpenThread: openThread,
    onReviewSetup: (setup: AssistantSetup) => setReviewing(setup.threadId),
  };
  const empty = !hasProjects && (data.setups?.length ?? 0) === 0;
  const canAdd = setupState.unavailableReason === null;
  // Hidden rather than disabled when every repository already has one: there
  // is nothing to add, and a dead button would only raise the question.
  const addButton = canAdd ? (
    <Button size="xs" variant="ghost" onClick={() => openSetup(null)}>
      <PlusIcon />
      Add project
    </Button>
  ) : null;

  return (
    <main className="min-h-0 flex-1 overflow-y-auto">
      {empty ? (
        <Onboarding
          environment={environment}
          hasRepository={projects.length > 0}
          onAdd={() => openSetup(null)}
          canAdd={canAdd}
        />
      ) : (
        <div className="mx-auto grid w-full max-w-6xl gap-6 px-4 py-5 sm:px-6 lg:grid-cols-[minmax(0,1fr)_19rem] lg:gap-8 lg:py-6">
          <aside className="flex flex-col gap-3 lg:sticky lg:top-6 lg:order-last lg:self-start">
            <SectionHeading action={addButton}>Projects</SectionHeading>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
              {data.setups?.map((setup) => (
                <AssistantSetupCard
                  key={setup.threadId}
                  environmentId={environmentId}
                  setup={setup}
                  title={projectTitle(setup.preferences.projectId)}
                  onOpenThread={openThread}
                  onReview={() => setReviewing(setup.threadId)}
                />
              ))}
              {data.projects.map((project) => (
                <AssistantProjectCard
                  key={project.config.projectId}
                  environmentId={environmentId}
                  project={project}
                  title={projectTitle(project.config.projectId)}
                  activeTask={activeTaskFor(data, project.config.projectId)}
                  linearProjectName={linearProjectName(project.config.linearProjectId)}
                  providers={environment.serverConfig?.providers ?? []}
                  onOpenThread={openThread}
                  onEditSetup={() => openSetup(project.config.projectId)}
                />
              ))}
            </div>
          </aside>

          <div className="flex min-w-0 flex-col gap-8">
            <section aria-label="Needs you" className="flex flex-col gap-3">
              <SectionHeading count={inbox.length}>Needs you</SectionHeading>
              {inbox.length > 0 ? (
                inbox.map((item) => (
                  <InboxItemCard key={item.key} item={item} context={inboxContext} />
                ))
              ) : (
                <CaughtUp board={data} />
              )}
            </section>

            <section aria-label="In progress" className="flex flex-col gap-3">
              <SectionHeading count={active.length}>In progress</SectionHeading>
              {active.length > 0 ? (
                active.map((task) => (
                  <ActiveTaskCard
                    key={task.id}
                    environmentId={environmentId}
                    task={task}
                    project={data.projects.find((p) => p.config.projectId === task.projectId)}
                    projectLabel={projectLabel(task.projectId)}
                    decisions={data.decisions}
                    onOpenThread={openThread}
                  />
                ))
              ) : (
                <p className="text-muted-foreground text-sm">
                  No issue is being worked on right now.
                </p>
              )}
            </section>

            {history.length > 0 ? (
              <section aria-label="History" className="flex flex-col gap-2">
                <SectionHeading>History</SectionHeading>
                <AssistantHistory
                  tasks={history}
                  projectLabel={(task) => projectLabel(task.projectId)}
                  onOpenThread={openThread}
                />
              </section>
            ) : null}
          </div>
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
              ? (data.projects.find((p) => p.config.projectId === dialog.projectId)?.config ?? null)
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
    </main>
  );
}

function CaughtUp({ board }: { board: AssistantBoard }) {
  const running = board.projects.some((p) => p.status === "running");
  return (
    <div className="flex items-start gap-3 rounded-xl border border-border/70 border-dashed px-4 py-4">
      <CircleCheckIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-success-foreground" />
      <div className="min-w-0">
        <p className="font-medium text-sm">Nothing needs you right now</p>
        <p className="mt-0.5 text-muted-foreground text-sm">
          {running
            ? "Questions and finished work show up here. You can leave this page; the assistant keeps going on the server."
            : board.projects.length > 0
              ? "Every project is paused. Press Start on one to let it take issues."
              : "Finish a setup to start taking issues."}
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
    <div className="mx-auto grid w-full max-w-6xl gap-6 px-4 py-5 sm:px-6 lg:grid-cols-[minmax(0,1fr)_19rem] lg:gap-8 lg:py-6">
      <div className="flex flex-col gap-3 lg:order-last">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-52 rounded-xl" />
      </div>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-28 rounded-xl" />
      </div>
    </div>
  );
}
