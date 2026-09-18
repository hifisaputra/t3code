import {
  assistantParallelIssues,
  assistantPicksIssues,
  type AssistantProject,
  type AssistantProjectConfig,
  type AssistantSetup,
  type AssistantStartOptions,
  type AssistantTask,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  ArrowRightIcon,
  ChevronRightIcon,
  EllipsisIcon,
  MessageSquareIcon,
  OctagonXIcon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  SendIcon,
  Settings2Icon,
  XIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { usePrimarySettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { developerAssistant } from "~/state/developerAssistant";
import { useThreadShell } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatUpcomingTimestamp } from "~/timestampFormat";

import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Label } from "../ui/label";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AssistantDispatchDialog } from "./AssistantDispatchDialog";
import {
  describeProjectActivity,
  projectLimitHold,
  type ProjectActivity,
} from "./assistantBoard.logic";
import {
  confirmDestructive,
  StatusDot,
  threadIsBusy,
  urlHost,
  useAssistantAction,
  type StatusTone,
} from "./assistantUi";

function StartOption({
  label,
  hint,
  checked,
  disabled,
  onCheckedChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className={cn(disabled === true && "opacity-56")}>
      <Label className="items-start gap-2.5 font-normal">
        <Checkbox
          className="mt-0.5"
          checked={checked}
          disabled={disabled ?? false}
          onCheckedChange={(next) => onCheckedChange(next === true)}
        />
        <span className="min-w-0 flex-1">{label}</span>
      </Label>
      <p className="mt-1 pl-7 text-muted-foreground text-xs">{hint}</p>
    </div>
  );
}

const PARALLEL_CHOICES = [1, 2, 3, 4, 5, 6];

/**
 * Start asks how the loop should run before it runs: whether it picks issues
 * from Linear itself, whose issues it may take, and how many it works at once.
 * All three are saved to the project, so the popover opens on what it is set
 * to now.
 */
function StartButton({
  title,
  config,
  pending,
  onStart,
}: {
  title: string;
  config: AssistantProjectConfig;
  pending: string | null;
  onStart: (options: AssistantStartOptions) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [autoPick, setAutoPick] = useState(true);
  const [anyAssignee, setAnyAssignee] = useState(false);
  const [parallelIssues, setParallelIssues] = useState(1);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setAutoPick(assistantPicksIssues(config));
          setAnyAssignee(!config.assignedToMe);
          setParallelIssues(assistantParallelIssues(config));
        }
        setOpen(next);
      }}
    >
      <PopoverTrigger render={<Button size="sm" disabled={pending !== null} />}>
        {pending === "start" ? <Spinner className="size-3.5" /> : <PlayIcon />}
        Start
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-80 max-w-[calc(100vw-2rem)]" viewportClassName="p-4">
        <PopoverTitle className="font-medium text-sm">Start {title}</PopoverTitle>
        <div className="mt-3 flex flex-col gap-3">
          <StartOption
            label="Pick issues from Linear automatically"
            hint="Off: the assistant works only on issues you dispatch."
            checked={autoPick}
            onCheckedChange={setAutoPick}
          />
          <StartOption
            label="Take issues not assigned to me too"
            hint="Off: only issues assigned to you in Linear."
            checked={anyAssignee}
            disabled={!autoPick}
            onCheckedChange={setAnyAssignee}
          />
          <div>
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0 text-sm">Issues at once</span>
              <Select
                value={String(parallelIssues)}
                onValueChange={(next) => setParallelIssues(Number(next))}
              >
                <SelectTrigger size="sm" className="w-16 min-w-0" aria-label="Issues at once">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false} matchTriggerWidth={false}>
                  {PARALLEL_CHOICES.map((count) => (
                    <SelectItem key={count} value={String(count)}>
                      {count}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <p className="mt-1 text-muted-foreground text-xs">
              Each issue gets its own team and worktree. Your project instructions must keep their
              ports and databases apart.
            </p>
          </div>
        </div>
        <Button
          size="sm"
          className="mt-4 w-full"
          disabled={pending !== null}
          onClick={async () => {
            await onStart({ autoPick, assignedToMe: !anyAssignee, parallelIssues });
            setOpen(false);
          }}
        >
          <PlayIcon />
          Start
        </Button>
      </PopoverPopup>
    </Popover>
  );
}

/** The project's status in words, with a usage-limit reset in the person's clock format. */
export function useProjectActivity(
  project: AssistantProject,
  activeTasks: ReadonlyArray<AssistantTask>,
): ProjectActivity {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const limitHold = projectLimitHold(project);
  return describeProjectActivity({
    project,
    activeTasks,
    limitResumesAt: limitHold ? formatUpcomingTimestamp(limitHold, timestampFormat) : null,
  });
}

/** The headline and its detail as one line. */
export function activityLine(activity: ProjectActivity): string {
  return activity.detail ? `${activity.headline} · ${activity.detail}` : activity.headline;
}

type ProjectAction = "start" | "pause" | "interrupt" | "wake";

/**
 * The project's loop commands with one pending state, shared by every control a
 * surface shows for the project so one request disables the rest.
 */
export function useProjectControl({
  environmentId,
  project,
  title,
}: {
  environmentId: EnvironmentId;
  project: AssistantProject;
  title: string;
}) {
  const control = useAtomCommand(developerAssistant.control);
  const { pending, run } = useAssistantAction();
  const stopped = project.status === "stopped";
  const projectId = project.config.projectId;
  const act = (action: ProjectAction, options?: AssistantStartOptions) =>
    run(
      action,
      () =>
        control({
          environmentId,
          input: { projectId, action, ...(options ? { options } : {}) },
        }),
      {
        failure:
          action === "start"
            ? `Could not start ${title}`
            : action === "wake"
              ? "Could not check for work"
              : action === "pause" && stopped
                ? `Could not resume ${title}`
                : `Could not pause ${title}`,
      },
    );
  return { pending, act };
}

export type ProjectControl = ReturnType<typeof useProjectControl>;

/** Pause while the loop runs, otherwise Start with its options popover. */
export function ProjectRunButton({
  project,
  title,
  control: { pending, act },
}: {
  project: AssistantProject;
  title: string;
  control: ProjectControl;
}) {
  const { config } = project;
  if (project.status !== "running")
    return (
      <StartButton
        title={title}
        config={config}
        pending={pending}
        onStart={(options) => act("start", options)}
      />
    );
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="sm"
            variant="outline"
            disabled={pending !== null}
            onClick={() => void act("pause")}
          />
        }
      >
        {pending === "pause" ? <Spinner className="size-3.5" /> : <PauseIcon />}
        Pause
      </TooltipTrigger>
      <TooltipPopup className="max-w-64">
        {(assistantPicksIssues(config) ? "Stop taking issues from Linear. " : "Stop the loop. ") +
          (assistantParallelIssues(config) > 1
            ? "The teams at work finish their issues, and issues you dispatch still run."
            : "The team at work finishes its issue, and issues you dispatch still run.")}
      </TooltipPopup>
    </Tooltip>
  );
}

/** Dispatch one issue to the project, with the dialog it opens. */
export function ProjectDispatchButton({
  environmentId,
  project,
  title,
  activeTasks,
}: {
  environmentId: EnvironmentId;
  project: AssistantProject;
  title: string;
  activeTasks: ReadonlyArray<AssistantTask>;
}) {
  const [dispatching, setDispatching] = useState(false);
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={<Button size="sm" variant="outline" onClick={() => setDispatching(true)} />}
        >
          <SendIcon />
          Dispatch
        </TooltipTrigger>
        <TooltipPopup className="max-w-64">
          Give one issue to the next team, ahead of the loop&apos;s own picks.
        </TooltipPopup>
      </Tooltip>
      {dispatching ? (
        <AssistantDispatchDialog
          environmentId={environmentId}
          project={project}
          activeTasks={activeTasks}
          title={title}
          open
          onOpenChange={setDispatching}
        />
      ) : null}
    </>
  );
}

/**
 * The project's less common commands. `onEditSetup` adds the revise item, for
 * surfaces that do not show their own Edit setup button.
 */
export function ProjectMenu({
  project,
  title,
  activeTasks,
  control: { pending, act },
  onEditSetup,
}: {
  project: AssistantProject;
  title: string;
  activeTasks: ReadonlyArray<AssistantTask>;
  control: ProjectControl;
  onEditSetup?: () => void;
}) {
  const stopped = project.status === "stopped";
  // An issue in progress may stay; the server keeps its base branch and scope.
  const canEdit = project.status !== "running";
  const parallelIssues = assistantParallelIssues(project.config);
  return (
    <Menu>
      <MenuTrigger
        render={<Button size="icon-sm" variant="ghost" aria-label={`More actions for ${title}`} />}
      >
        <EllipsisIcon />
      </MenuTrigger>
      <MenuPopup align="end" className="min-w-52">
        {stopped ? (
          <MenuItem disabled={pending !== null} onClick={() => void act("pause")}>
            <PlayIcon />
            Resume teams, loop paused
          </MenuItem>
        ) : (
          <MenuItem disabled={pending !== null} onClick={() => void act("wake")}>
            <RefreshCwIcon />
            Check for work now
          </MenuItem>
        )}
        {onEditSetup ? (
          <MenuItem disabled={!canEdit} onClick={onEditSetup}>
            <Settings2Icon />
            {canEdit ? "Revise setup" : "Revise setup (pause first)"}
          </MenuItem>
        ) : null}
        <MenuSeparator />
        <MenuItem
          variant="destructive"
          disabled={pending !== null || (stopped && activeTasks.length === 0)}
          onClick={async () => {
            const confirmed = await confirmDestructive(
              parallelIssues > 1
                ? `Interrupt ${title}?\nThis stops the loop and every team mid-turn and closes their terminals. The issues and their branches stay as they are: start again or resume the teams later.`
                : `Interrupt ${title}?\nThis stops the loop and the team mid-turn and closes its terminals. The issue and its branch stay as they are: start again or resume the teams later.`,
            );
            if (confirmed) void act("interrupt");
          }}
        >
          <OctagonXIcon />
          Interrupt all work
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

/** Where the project's work lands: its base branch and the staging host. */
export function DeliveryChip({
  baseBranch,
  stagingUrl,
  className,
}: {
  baseBranch: string;
  stagingUrl: string | undefined;
  className?: string;
}) {
  const host = urlHost(stagingUrl);
  return (
    <span
      className={cn(
        "inline-flex min-w-0 shrink items-center gap-1 rounded-full border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground",
        className,
      )}
    >
      <span className="truncate font-mono">{baseBranch}</span>
      {host ? (
        <>
          <ArrowRightIcon aria-hidden className="size-3 shrink-0" />
          <span className="truncate">{host}</span>
        </>
      ) : null}
    </span>
  );
}

function RowShell({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return (
    <li
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 sm:flex-nowrap",
        tone === "attention" && "bg-warning/8 shadow-[inset_3px_0_0_var(--color-warning)]",
      )}
    >
      {children}
    </li>
  );
}

/** A status line that fits one row, with the whole text on hover. */
function RowStatus({
  title,
  status,
  line,
  tone,
  pulse,
}: {
  title: string;
  status: string;
  line: string;
  tone: StatusTone;
  pulse: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2.5 max-sm:basis-full">
      <StatusDot tone={tone} pulse={pulse} />
      <span className="sr-only">{status}:</span>
      <h3 className="max-w-40 shrink-0 truncate font-semibold text-sm">{title}</h3>
      <Tooltip>
        <TooltipTrigger
          render={
            <p
              className={cn(
                "min-w-0 truncate text-sm",
                tone === "attention" ? "text-warning-foreground" : "text-muted-foreground",
              )}
            />
          }
        >
          {line}
        </TooltipTrigger>
        <TooltipPopup className="max-w-80">{line}</TooltipPopup>
      </Tooltip>
    </div>
  );
}

/** One assistant project in the page's list: its status, delivery and main controls. */
export function AssistantProjectRow({
  environmentId,
  project,
  title,
  activeTasks,
  onEditSetup,
  onOpenDetails,
}: {
  environmentId: EnvironmentId;
  project: AssistantProject;
  title: string;
  activeTasks: ReadonlyArray<AssistantTask>;
  onEditSetup: () => void;
  onOpenDetails: () => void;
}) {
  const activity = useProjectActivity(project, activeTasks);
  const control = useProjectControl({ environmentId, project, title });
  return (
    <RowShell tone={activity.tone}>
      <RowStatus
        title={title}
        status={activity.status}
        line={activityLine(activity)}
        tone={activity.tone}
        pulse={activity.tone === "active"}
      />
      <DeliveryChip
        baseBranch={project.config.baseBranch}
        stagingUrl={project.config.stagingUrl}
        className="max-w-56 max-md:hidden"
      />
      <div className="flex shrink-0 items-center gap-1.5 max-sm:ml-4.5">
        <ProjectRunButton project={project} title={title} control={control} />
        <ProjectDispatchButton
          environmentId={environmentId}
          project={project}
          title={title}
          activeTasks={activeTasks}
        />
        <Button size="sm" variant="ghost" onClick={onOpenDetails}>
          Details
          <ChevronRightIcon />
        </Button>
        <ProjectMenu
          project={project}
          title={title}
          activeTasks={activeTasks}
          control={control}
          onEditSetup={onEditSetup}
        />
      </div>
    </RowShell>
  );
}

/** A project whose setup conversation has not been saved yet, in the same list. */
export function AssistantSetupRow({
  environmentId,
  setup,
  title,
  onOpenThread,
  onReview,
}: {
  environmentId: EnvironmentId;
  setup: AssistantSetup;
  title: string;
  onOpenThread: (threadId: ThreadId) => void;
  onReview: () => void;
}) {
  const resolve = useAtomCommand(developerAssistant.resolveSetup);
  const { pending, run } = useAssistantAction();
  const thread = useThreadShell({ environmentId, threadId: setup.threadId });
  const busy = threadIsBusy(thread);
  const needsReply = !busy && (thread?.hasPendingApprovals || thread?.hasPendingUserInput);
  const tone = setup.proposal && !busy ? "attention" : "waiting";
  const headline = busy
    ? "Inspecting the project"
    : needsReply
      ? "Waiting for you in the conversation"
      : setup.proposal
        ? "Proposal ready to review"
        : "Waiting for your reply";
  return (
    <RowShell tone={tone}>
      <RowStatus
        title={title}
        status="Being set up"
        line={`Setup · ${headline}`}
        tone={tone}
        pulse={busy}
      />
      <div className="flex shrink-0 items-center gap-1.5 max-sm:ml-4.5">
        {setup.proposal ? (
          <Button size="sm" onClick={onReview}>
            Review setup
          </Button>
        ) : null}
        <Button
          size="sm"
          variant={setup.proposal ? "outline" : "default"}
          onClick={() => onOpenThread(setup.threadId)}
        >
          <MessageSquareIcon />
          {setup.proposal ? "Chat" : "Continue in chat"}
        </Button>
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`More actions for ${title} setup`}
              />
            }
          >
            <EllipsisIcon />
          </MenuTrigger>
          <MenuPopup align="end" className="min-w-44">
            <MenuItem
              variant="destructive"
              disabled={pending !== null}
              onClick={async () => {
                const confirmed = await confirmDestructive(
                  `Cancel the setup for ${title}?\nThe conversation stays in your history. Nothing it proposed is applied.`,
                );
                if (!confirmed) return;
                void run(
                  "cancel",
                  () =>
                    resolve({
                      environmentId,
                      input: {
                        threadId: setup.threadId,
                        revision: setup.revision,
                        action: "cancel",
                      },
                    }),
                  { failure: "Could not cancel the setup", success: "Setup cancelled" },
                );
              }}
            >
              <XIcon />
              Cancel setup
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    </RowShell>
  );
}
