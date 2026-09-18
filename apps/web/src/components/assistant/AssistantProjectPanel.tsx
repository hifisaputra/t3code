import {
  assistantParallelIssues,
  assistantPicksIssues,
  type AssistantBoard,
  type AssistantProject,
  type AssistantTask,
  type EnvironmentId,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import { ArrowRightIcon, GitBranchIcon, GlobeIcon, Settings2Icon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "../ui/button";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from "../ui/sheet";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  activityLine,
  ProjectDispatchButton,
  ProjectMenu,
  ProjectRunButton,
  type ProjectControl,
  useProjectActivity,
  useProjectControl,
} from "./AssistantProjectCard";
import { AssistantProjectNotes } from "./AssistantProjectNotes";
import { AssistantHistory } from "./AssistantWork";
import { modelLabel, runtimeModeLabel, StatusDot, urlHost } from "./assistantUi";

export type ProjectPanelTab = "setup" | "notes" | "history";

/**
 * The details of one assistant project in a side sheet: how it is set up, the
 * notes its teams keep, and the issues it finished. The page owns which project
 * and tab are open; the sheet keeps rendering the last project while it closes.
 */
export function AssistantProjectPanel({
  environmentId,
  board,
  project,
  title,
  linearProjectName,
  providers,
  activeTasks,
  historyTasks,
  open,
  tab,
  onTabChange,
  onOpenChange,
  onEditSetup,
  onOpenThread,
}: {
  environmentId: EnvironmentId;
  board: AssistantBoard;
  project: AssistantProject | null;
  title: string;
  linearProjectName: string | null;
  providers: ReadonlyArray<ServerProvider>;
  activeTasks: ReadonlyArray<AssistantTask>;
  historyTasks: ReadonlyArray<AssistantTask>;
  open: boolean;
  tab: ProjectPanelTab;
  onTabChange: (tab: ProjectPanelTab) => void;
  onOpenChange: (open: boolean) => void;
  onEditSetup: () => void;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  return (
    <Sheet open={open && project !== null} onOpenChange={onOpenChange}>
      <SheetPopup side="right" className="max-w-xl">
        {project ? (
          <PanelContents
            environmentId={environmentId}
            board={board}
            project={project}
            title={title}
            linearProjectName={linearProjectName}
            providers={providers}
            activeTasks={activeTasks}
            historyTasks={historyTasks}
            tab={tab}
            onTabChange={onTabChange}
            onEditSetup={onEditSetup}
            onOpenThread={onOpenThread}
          />
        ) : null}
      </SheetPopup>
    </Sheet>
  );
}

function PanelContents({
  environmentId,
  board,
  project,
  title,
  linearProjectName,
  providers,
  activeTasks,
  historyTasks,
  tab,
  onTabChange,
  onEditSetup,
  onOpenThread,
}: {
  environmentId: EnvironmentId;
  board: AssistantBoard;
  project: AssistantProject;
  title: string;
  linearProjectName: string | null;
  providers: ReadonlyArray<ServerProvider>;
  activeTasks: ReadonlyArray<AssistantTask>;
  historyTasks: ReadonlyArray<AssistantTask>;
  tab: ProjectPanelTab;
  onTabChange: (tab: ProjectPanelTab) => void;
  onEditSetup: () => void;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const activity = useProjectActivity(project, activeTasks);
  const control = useProjectControl({ environmentId, project, title });
  const notesCount = project.notes?.length ?? 0;
  return (
    <>
      <SheetHeader className="gap-3 pb-3 pr-12">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <SheetTitle className="flex min-w-0 flex-1 items-center gap-2.5 text-lg">
            <StatusDot tone={activity.tone} pulse={activity.tone === "active"} />
            <span className="sr-only">{activity.status}:</span>
            <span className="truncate">{title}</span>
          </SheetTitle>
          <div className="flex shrink-0 items-center gap-1.5">
            <ProjectDispatchButton
              environmentId={environmentId}
              project={project}
              title={title}
              activeTasks={activeTasks}
            />
            <ProjectRunButton project={project} title={title} control={control} />
          </div>
        </div>
        <SheetDescription
          className={activity.tone === "attention" ? "text-warning-foreground" : undefined}
        >
          {linearProjectName ?? "Linear project"} · {activityLine(activity)}
        </SheetDescription>
        <ToggleGroup
          aria-label={`${title} details`}
          variant="segmented"
          value={[tab]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "setup" || next === "notes" || next === "history") onTabChange(next);
          }}
        >
          <Toggle value="setup">Setup</Toggle>
          <Toggle value="notes">
            Notes
            <TabCount count={notesCount} />
          </Toggle>
          <Toggle value="history">
            History
            <TabCount count={historyTasks.length} />
          </Toggle>
        </ToggleGroup>
      </SheetHeader>
      <SheetPanel>
        {tab === "setup" ? (
          <SetupTab
            project={project}
            title={title}
            providers={providers}
            activeTasks={activeTasks}
            control={control}
            onEditSetup={onEditSetup}
          />
        ) : tab === "notes" ? (
          <AssistantProjectNotes environmentId={environmentId} project={project} />
        ) : historyTasks.length > 0 ? (
          <AssistantHistory
            environmentId={environmentId}
            board={board}
            tasks={historyTasks}
            projectLabel={() => null}
            onOpenThread={onOpenThread}
          />
        ) : (
          <p className="text-muted-foreground text-sm">No finished issues yet.</p>
        )}
      </SheetPanel>
    </>
  );
}

function TabCount({ count }: { count: number }) {
  return count > 0 ? (
    <span className="ml-1 text-muted-foreground tabular-nums">{count}</span>
  ) : null;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

function SetupTab({
  project,
  title,
  providers,
  activeTasks,
  control,
  onEditSetup,
}: {
  project: AssistantProject;
  title: string;
  providers: ReadonlyArray<ServerProvider>;
  activeTasks: ReadonlyArray<AssistantTask>;
  control: ProjectControl;
  onEditSetup: () => void;
}) {
  const { config } = project;
  const stagingHost = urlHost(config.stagingUrl);
  const parallelIssues = assistantParallelIssues(config);
  // An issue in progress may stay; the server keeps its base branch and scope.
  const canEdit = project.status !== "running";
  const separateWorker =
    config.workerModelSelection.model !== config.modelSelection.model ||
    config.workerModelSelection.instanceId !== config.modelSelection.instanceId;
  return (
    <div className="flex flex-col gap-5">
      <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-2.5 text-sm">
        <Fact label="Delivers to">
          <span className="inline-flex flex-wrap items-center gap-1">
            <GitBranchIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="break-all font-mono">{config.baseBranch}</span>
            {stagingHost ? (
              <>
                <ArrowRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                <a
                  href={config.stagingUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-w-0 items-center gap-1 break-all underline-offset-2 hover:underline"
                >
                  <GlobeIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                  {stagingHost}
                </a>
              </>
            ) : null}
          </span>
        </Fact>
        <Fact label="Models">
          {modelLabel(providers, config.modelSelection)}
          {separateWorker ? ` · ${modelLabel(providers, config.workerModelSelection)} codes` : ""}
        </Fact>
        <Fact label="Permissions">{runtimeModeLabel(config.runtimeMode)}</Fact>
        {config.checkCommand?.trim() ? (
          <Fact label="Checks">
            <span className="break-all font-mono text-xs">{config.checkCommand}</span>
          </Fact>
        ) : null}
        <Fact label="Picks issues">
          {!assistantPicksIssues(config)
            ? "Only issues you dispatch"
            : config.assignedToMe
              ? "Your issues from Linear"
              : "All issues from Linear"}
        </Fact>
        <Fact label="At once">
          {parallelIssues > 1 ? `${parallelIssues} issues, each in its own worktree` : "1 issue"}
        </Fact>
      </dl>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={!canEdit} onClick={onEditSetup}>
          <Settings2Icon />
          Edit setup
        </Button>
        <ProjectMenu project={project} title={title} activeTasks={activeTasks} control={control} />
        {canEdit ? null : (
          <p className="text-muted-foreground text-xs">Pause first to edit the setup.</p>
        )}
      </div>
    </div>
  );
}
