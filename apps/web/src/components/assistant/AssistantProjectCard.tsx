import {
  assistantParallelIssues,
  assistantPicksIssues,
  type AssistantProject,
  type AssistantProjectConfig,
  type AssistantSetup,
  type AssistantStartOptions,
  type AssistantTask,
  type EnvironmentId,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import {
  ArrowRightIcon,
  BotIcon,
  EllipsisIcon,
  GitBranchIcon,
  GlobeIcon,
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
import { describeProjectActivity, projectLimitHold } from "./assistantBoard.logic";
import {
  confirmDestructive,
  modelLabel,
  runtimeModeLabel,
  StatusDot,
  threadIsBusy,
  urlHost,
  useAssistantAction,
  type StatusTone,
} from "./assistantUi";

function CardShell({ children, tone }: { children: ReactNode; tone?: StatusTone }) {
  return (
    <article
      className={cn(
        "flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-xs/5",
        tone === "attention" ? "border-warning/40" : "border-border/70",
      )}
    >
      {children}
    </article>
  );
}

function StatusPill({ tone, label, pulse }: { tone: StatusTone; label: string; pulse?: boolean }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground">
      <StatusDot tone={tone} pulse={pulse ?? false} className="size-1.5" />
      {label}
    </span>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-foreground">{children}</dd>
    </>
  );
}

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

export function AssistantProjectCard({
  environmentId,
  project,
  title,
  activeTasks,
  linearProjectName,
  providers,
  onEditSetup,
}: {
  environmentId: EnvironmentId;
  project: AssistantProject;
  title: string;
  activeTasks: ReadonlyArray<AssistantTask>;
  linearProjectName: string | null;
  providers: ReadonlyArray<ServerProvider>;
  onEditSetup: () => void;
}) {
  const control = useAtomCommand(developerAssistant.control);
  const { pending, run } = useAssistantAction();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const limitHold = projectLimitHold(project);
  const activity = describeProjectActivity({
    project,
    activeTasks,
    limitResumesAt: limitHold ? formatUpcomingTimestamp(limitHold, timestampFormat) : null,
  });
  const [dispatching, setDispatching] = useState(false);
  const { config } = project;
  const running = project.status === "running";
  const stopped = project.status === "stopped";
  const projectId = config.projectId;

  const act = (action: "start" | "pause" | "interrupt" | "wake", options?: AssistantStartOptions) =>
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

  // An issue in progress may stay; the server keeps its base branch and scope.
  const canEdit = !running;
  const stagingHost = urlHost(config.stagingUrl);
  const parallelIssues = assistantParallelIssues(config);

  return (
    <CardShell tone={activity.tone}>
      <div className="flex items-start gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-violet-500/10">
          <BotIcon aria-hidden className="size-4 text-violet-600 dark:text-violet-300" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-semibold text-sm">{title}</h3>
          <p className="mt-0.5 truncate text-muted-foreground text-xs">
            {linearProjectName ?? "Linear project"} ·{" "}
            {!assistantPicksIssues(config)
              ? "dispatched issues only"
              : config.assignedToMe
                ? "your issues"
                : "all issues"}
          </p>
        </div>
        <StatusPill tone={activity.tone} label={activity.status} />
      </div>

      <div
        className={cn(
          "rounded-lg px-3 py-2.5",
          activity.tone === "attention" ? "bg-warning/8" : "bg-muted/50",
        )}
      >
        <p className="flex items-center gap-2 font-medium text-sm">
          <StatusDot tone={activity.tone} pulse={activity.tone === "active"} />
          <span className="min-w-0 truncate">{activity.headline}</span>
        </p>
        {activity.detail ? (
          <p
            className={cn(
              "mt-1 line-clamp-3 text-xs",
              activity.tone === "attention" ? "text-warning-foreground" : "text-muted-foreground",
            )}
          >
            {activity.detail}
          </p>
        ) : null}
      </div>

      <dl className="grid grid-cols-[4.75rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
        <Fact label="Delivers to">
          <span className="inline-flex min-w-0 items-center gap-1">
            <GitBranchIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
            <span className="font-mono">{config.baseBranch}</span>
            {stagingHost ? (
              <>
                <ArrowRightIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
                <a
                  href={config.stagingUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-w-0 items-center gap-1 underline-offset-2 hover:underline"
                >
                  <GlobeIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
                  <span className="truncate">{stagingHost}</span>
                </a>
              </>
            ) : null}
          </span>
        </Fact>
        <Fact label="Models">
          {modelLabel(providers, config.modelSelection)}
          {config.workerModelSelection.model !== config.modelSelection.model ||
          config.workerModelSelection.instanceId !== config.modelSelection.instanceId
            ? ` · ${modelLabel(providers, config.workerModelSelection)} codes`
            : ""}
        </Fact>
        <Fact label="Permissions">{runtimeModeLabel(config.runtimeMode)}</Fact>
        {config.checkCommand?.trim() ? (
          <Fact label="Checks">
            <span className="font-mono">{config.checkCommand}</span>
          </Fact>
        ) : null}
        {parallelIssues > 1 ? (
          <Fact label="At once">{parallelIssues} issues, each in its own worktree</Fact>
        ) : null}
      </dl>

      <div className="flex flex-wrap items-center gap-1.5">
        {running ? (
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
              {(assistantPicksIssues(config)
                ? "Stop taking issues from Linear. "
                : "Stop the loop. ") +
                (parallelIssues > 1
                  ? "The teams at work finish their issues, and issues you dispatch still run."
                  : "The team at work finishes its issue, and issues you dispatch still run.")}
            </TooltipPopup>
          </Tooltip>
        ) : (
          <StartButton
            title={title}
            config={config}
            pending={pending}
            onStart={(options) => act("start", options)}
          />
        )}
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
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost"
                className="ml-auto"
                aria-label={`More actions for ${title}`}
              />
            }
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
            <MenuItem disabled={!canEdit} onClick={onEditSetup}>
              <Settings2Icon />
              {canEdit ? "Revise setup" : "Revise setup (pause first)"}
            </MenuItem>
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
      </div>
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
    </CardShell>
  );
}

export function AssistantSetupCard({
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
  const headline = busy
    ? "Inspecting the project"
    : needsReply
      ? "Waiting for you in the conversation"
      : setup.proposal
        ? "Proposal ready to review"
        : "Waiting for your reply";
  return (
    <CardShell>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-semibold text-sm">{title}</h3>
          <p className="mt-0.5 text-muted-foreground text-xs">Being set up</p>
        </div>
        <StatusPill
          tone={setup.proposal && !busy ? "attention" : "waiting"}
          label="Setup"
          pulse={busy}
        />
      </div>
      <p className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2.5 font-medium text-sm">
        <StatusDot tone={setup.proposal && !busy ? "attention" : "waiting"} pulse={busy} />
        {headline}
      </p>
      <div className="flex items-center gap-1.5">
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
                className="ml-auto"
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
    </CardShell>
  );
}
