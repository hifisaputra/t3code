import {
  assistantTaskThreadId,
  assistantThreadKind,
  type AssistantDecision,
  type AssistantProject,
  type AssistantTask,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  ArrowUpRightIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CircleIcon,
  CircleSlashIcon,
  CircleXIcon,
  EllipsisIcon,
  GitPullRequestIcon,
  HandIcon,
  RotateCcwIcon,
  SkipForwardIcon,
  UndoIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { developerAssistant } from "~/state/developerAssistant";
import { useThreadShell } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatElapsedDurationLabel, formatRelativeTimeLabel } from "~/timestampFormat";

import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  describeTaskPhase,
  previewLine,
  taskPipeline,
  type PipelineStep,
  type TaskPhaseTone,
} from "./assistantBoard.logic";
import {
  confirmDestructive,
  ExpandableMarkdown,
  IssueLink,
  StatusDot,
  threadIsBusy,
  useAssistantAction,
  type StatusTone,
} from "./assistantUi";
import { THREAD_KIND } from "./threadKinds";

const PHASE_STYLE: Record<TaskPhaseTone, string> = {
  active: "bg-success/8 text-success-foreground",
  waiting: "bg-info/8 text-info-foreground",
  blocked: "bg-destructive/8 text-destructive-foreground",
  idle: "bg-muted text-muted-foreground",
};

const PHASE_DOT: Record<TaskPhaseTone, StatusTone> = {
  active: "active",
  waiting: "waiting",
  blocked: "blocked",
  idle: "paused",
};

function RoundsMeter({ used, limit }: { used: number; limit: number }) {
  const segments = Math.min(limit, 12);
  const filled = Math.round((Math.min(used, limit) / limit) * segments);
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex items-center gap-2" />}>
        <span aria-hidden className="flex gap-0.5">
          {Array.from({ length: segments }, (_, index) => (
            <span
              key={index}
              className={cn(
                "h-1.5 w-2.5 rounded-full",
                index < filled
                  ? used >= limit
                    ? "bg-destructive/70"
                    : "bg-foreground/60"
                  : "bg-muted-foreground/20",
              )}
            />
          ))}
        </span>
        <span className="tabular-nums">
          Round {Math.min(used, limit)} of {limit}
        </span>
      </TooltipTrigger>
      <TooltipPopup className="max-w-64">
        A round is one turn the worker takes on the issue. At the limit the assistant stops and asks
        you.
      </TooltipPopup>
    </Tooltip>
  );
}

/** One step on the issue's way to staging, opening the thread that does it. */
function PipelineStepButton({
  step,
  thread,
  busy,
  needsYou,
  onOpen,
}: {
  step: PipelineStep;
  thread: ThreadId | null;
  busy: boolean;
  needsYou: boolean;
  onOpen: (threadId: ThreadId) => void;
}) {
  const kind = THREAD_KIND[step.kind];
  const current = step.state === "current";
  const note = needsYou ? "Waiting for you" : busy && current ? "Working now" : step.note;
  return (
    <li className="flex min-w-0 flex-1 basis-24 items-stretch">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              // Not `disabled`: the tooltip still explains a step no thread has reached.
              aria-disabled={thread === null}
              onClick={() => thread && onOpen(thread)}
              className={cn(
                "flex w-full min-w-0 flex-col gap-0.5 rounded-lg border px-2 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                thread === null ? "cursor-default" : "hover:bg-accent/60",
                step.state === "failed"
                  ? "border-destructive/40 bg-destructive/6"
                  : needsYou
                    ? "border-info/50 bg-info/8"
                    : current
                      ? "border-foreground/25 bg-accent/40"
                      : "border-border/50",
                step.state === "todo" && "opacity-55",
              )}
            />
          }
        >
          <span className="flex min-w-0 items-center gap-1.5 text-xs">
            {step.state === "done" ? (
              <CircleCheckIcon aria-hidden className="size-3.5 shrink-0 text-success-foreground" />
            ) : step.state === "failed" ? (
              <CircleXIcon aria-hidden className="size-3.5 shrink-0 text-destructive-foreground" />
            ) : current ? (
              <StatusDot
                tone={needsYou ? "waiting" : busy ? "active" : "paused"}
                pulse={busy && !needsYou}
                className="mx-0.5"
              />
            ) : (
              <CircleIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground/50" />
            )}
            <span className={cn("truncate", current ? "font-medium" : "text-muted-foreground")}>
              {step.label}
            </span>
          </span>
          <span className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
            <kind.icon aria-hidden className={cn("size-3 shrink-0", kind.className)} />
            <span className="truncate">{note ?? kind.label}</span>
          </span>
        </TooltipTrigger>
        <TooltipPopup className="max-w-64">
          <span className="font-medium">{kind.label}.</span> {kind.does}
          {thread === null ? " Starts when the issue gets here." : null}
        </TooltipPopup>
      </Tooltip>
    </li>
  );
}

export function ActiveTaskCard({
  environmentId,
  task,
  project,
  projectLabel,
  decisions,
  onOpenThread,
  onShowDecision,
}: {
  environmentId: EnvironmentId;
  task: AssistantTask;
  project: AssistantProject | undefined;
  projectLabel: string | null;
  decisions: ReadonlyArray<AssistantDecision>;
  onOpenThread: (threadId: ThreadId) => void;
  onShowDecision: (decision: AssistantDecision) => void;
}) {
  const review = useAtomCommand(developerAssistant.review);
  const { pending, run } = useAssistantAction();
  const worker = useThreadShell({ environmentId, threadId: task.threadId });
  const reviewer = useThreadShell({
    environmentId,
    threadId: assistantTaskThreadId(task, "review"),
  });
  const tester = useThreadShell({ environmentId, threadId: assistantTaskThreadId(task, "e2e") });
  const leader = useThreadShell({ environmentId, threadId: assistantTaskThreadId(task, "lead") });
  const coordinator = project?.threadId ?? null;
  const shells = { lead: leader, implement: worker, review: reviewer, e2e: tester } as const;
  // The phase follows whichever of the issue's threads holds it.
  const holder =
    task.stage === "review"
      ? reviewer
      : task.stage === "e2e"
        ? tester
        : task.stage === "lead"
          ? leader
          : worker;
  const holderBusy = threadIsBusy(holder);
  const openDecision = decisions.find((d) => d.answer === null && d.taskId === task.id) ?? null;
  const phase = describeTaskPhase({
    task,
    workerBusy: holderBusy,
    workerNeedsInput: Boolean(holder?.hasPendingApprovals || holder?.hasPendingUserInput),
    step: holder?.planProgress?.step ?? null,
    hasOpenDecision: openDecision !== null,
  });
  const pipeline = taskPipeline(task);
  const asking = openDecision ? assistantThreadKind(openDecision.threadId) : null;
  const pullRequest = worker?.linkedPullRequest ?? worker?.branchPullRequest ?? null;
  const moreRounds = project?.config.maxWorkerTurns ?? 6;
  const phaseDetail =
    openDecision !== null
      ? `The ${THREAD_KIND[asking ?? "implement"].label.toLowerCase()} asked: ${previewLine(openDecision.question)}`
      : phase.detail;

  return (
    <article className="flex flex-col gap-3 rounded-xl border border-border/70 bg-card p-4 shadow-xs/5">
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <IssueLink issue={task.issue} />
        {projectLabel ? (
          <span className="truncate text-muted-foreground">· {projectLabel}</span>
        ) : null}
        <span className="ml-auto shrink-0 text-muted-foreground/80">
          Started {formatElapsedDurationLabel(task.createdAt)} ago
        </span>
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`More actions for ${task.issue.identifier}`}
              />
            }
          >
            {pending ? <Spinner className="size-3.5" /> : <EllipsisIcon />}
          </MenuTrigger>
          <MenuPopup align="end" className="min-w-48">
            <MenuItem
              disabled={pending !== null}
              onClick={() =>
                void run(
                  "retry",
                  () =>
                    review({
                      environmentId,
                      input: {
                        taskId: task.id,
                        action: "retry",
                        feedback: "Please inspect the blocker and continue.",
                      },
                    }),
                  {
                    failure: "Could not grant more rounds",
                    success: `${moreRounds} more rounds for ${task.issue.identifier}`,
                  },
                )
              }
            >
              <RotateCcwIcon />
              Allow {moreRounds} more rounds
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              variant="destructive"
              disabled={pending !== null}
              onClick={async () => {
                const confirmed = await confirmDestructive(
                  `Skip ${task.issue.identifier}?\nQueued work is cancelled and the project moves on. The thread and branch stay for you to inspect. A merge, deployment, migration or Linear state already made is not undone.`,
                );
                if (!confirmed) return;
                void run(
                  "skip",
                  () =>
                    review({
                      environmentId,
                      input: {
                        taskId: task.id,
                        action: "skip",
                        feedback: "Skipped from the assistant board.",
                      },
                    }),
                  {
                    failure: "Could not skip the issue",
                    success: `${task.issue.identifier} skipped`,
                  },
                );
              }}
            >
              <SkipForwardIcon />
              Skip issue…
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      <h3 className="-mt-1 font-semibold text-sm leading-snug">{task.issue.title}</h3>

      <div className={cn("flex items-start gap-2 rounded-lg px-3 py-2", PHASE_STYLE[phase.tone])}>
        <StatusDot tone={PHASE_DOT[phase.tone]} pulse={holderBusy} className="mt-1.5" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-sm">{phase.label}</p>
          {phaseDetail ? (
            <p className="mt-0.5 line-clamp-2 text-xs opacity-90">{phaseDetail}</p>
          ) : null}
        </div>
        {openDecision ? (
          <Button size="xs" className="shrink-0" onClick={() => onShowDecision(openDecision)}>
            Answer
          </Button>
        ) : null}
      </div>

      {pipeline ? (
        <ol aria-label="Progress" className="flex flex-wrap gap-1.5">
          {pipeline.map((step) => {
            const shell =
              step.kind === "coordinator" || step.kind === "setup" ? null : shells[step.kind];
            const thread = step.kind === "coordinator" ? coordinator : (shell?.id ?? null);
            const current = step.state === "current";
            return (
              <PipelineStepButton
                key={step.key}
                step={step}
                thread={thread}
                busy={current && threadIsBusy(shell)}
                needsYou={
                  current &&
                  (asking === step.kind ||
                    Boolean(shell?.hasPendingApprovals || shell?.hasPendingUserInput))
                }
                onOpen={onOpenThread}
              />
            );
          })}
        </ol>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-muted-foreground text-xs">
        <RoundsMeter used={task.turns} limit={task.turnLimit} />
        {pullRequest ? (
          <a
            href={pullRequest.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 hover:text-foreground hover:underline"
          >
            <GitPullRequestIcon aria-hidden className="size-3.5" />
            PR #{pullRequest.number}
          </a>
        ) : null}
        {worker?.branch ? (
          <span className="min-w-0 truncate font-mono text-[11px]">{worker.branch}</span>
        ) : null}
        {!pipeline ? (
          <button
            type="button"
            onClick={() => onOpenThread(task.threadId)}
            className="inline-flex items-center gap-1 hover:text-foreground hover:underline"
          >
            Worker thread
            <ArrowUpRightIcon aria-hidden className="size-3" />
          </button>
        ) : null}
      </div>

      {task.brief.trim() ? (
        <Collapsible>
          <CollapsibleTrigger className="group inline-flex items-center gap-1 font-medium text-muted-foreground text-xs hover:text-foreground">
            <ChevronRightIcon
              aria-hidden
              className="size-3.5 transition-transform group-data-panel-open:rotate-90"
            />
            {task.leader ? "The team leader's brief" : "What the assistant asked for"}
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <div className="mt-2 rounded-lg border border-border/60 p-3">
              <ExpandableMarkdown text={task.brief} environmentId={environmentId} />
            </div>
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
    </article>
  );
}

const HISTORY_STATUS = {
  accepted: { icon: CircleCheckIcon, label: "Accepted", className: "text-success-foreground" },
  "changes-requested": { icon: UndoIcon, label: "Sent back", className: "text-warning-foreground" },
  skipped: { icon: CircleSlashIcon, label: "Skipped", className: "text-muted-foreground" },
  declined: { icon: HandIcon, label: "Declined", className: "text-muted-foreground" },
} as const;

/** Issues the person put next. The loop gives each to a new team in turn. */
export function AssistantQueue({
  environmentId,
  tasks,
  projectLabel,
}: {
  environmentId: EnvironmentId;
  tasks: ReadonlyArray<AssistantTask>;
  projectLabel: (task: AssistantTask) => string | null;
}) {
  const review = useAtomCommand(developerAssistant.review);
  const { pending, run } = useAssistantAction();
  return (
    <ul className="-mx-2 flex flex-col">
      {tasks.map((task) => {
        const label = projectLabel(task);
        return (
          <li
            key={task.id}
            className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg px-2 py-1 text-sm"
          >
            <IssueLink issue={task.issue} />
            <span className="min-w-0 truncate">
              {task.issue.title}
              {label ? <span className="text-muted-foreground"> · {label}</span> : null}
            </span>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Take ${task.issue.identifier} out of the queue`}
              disabled={pending !== null}
              onClick={() =>
                void run(
                  task.id,
                  () =>
                    review({
                      environmentId,
                      input: {
                        taskId: task.id,
                        action: "skip",
                        feedback: "Taken out of the queue.",
                      },
                    }),
                  {
                    failure: "Could not take the issue out of the queue",
                    success: `${task.issue.identifier} taken out of the queue`,
                  },
                )
              }
            >
              {pending === task.id ? <Spinner className="size-3.5" /> : <XIcon />}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

const HISTORY_PREVIEW = 6;

export function AssistantHistory({
  tasks,
  projectLabel,
  onOpenThread,
}: {
  tasks: ReadonlyArray<AssistantTask>;
  projectLabel: (task: AssistantTask) => string | null;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? tasks : tasks.slice(0, HISTORY_PREVIEW);
  return (
    <div className="flex flex-col">
      <ul className="-mx-2 flex flex-col">
        {visible.map((task) => {
          const status =
            HISTORY_STATUS[task.status as keyof typeof HISTORY_STATUS] ?? HISTORY_STATUS.skipped;
          const label = projectLabel(task);
          return (
            <li key={task.id}>
              <button
                type="button"
                // A declined issue never had a worker; its leader's thread says why.
                onClick={() =>
                  onOpenThread(
                    task.status === "declined"
                      ? assistantTaskThreadId(task, "lead")
                      : task.threadId,
                  )
                }
                className="grid w-full grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <status.icon aria-hidden className={cn("size-3.5", status.className)} />
                <span className="font-mono text-muted-foreground text-xs">
                  {task.issue.identifier}
                </span>
                <span className="min-w-0 truncate">
                  {task.issue.title}
                  {label ? <span className="text-muted-foreground"> · {label}</span> : null}
                </span>
                <span className="shrink-0 text-muted-foreground text-xs">
                  {status.label} · {formatRelativeTimeLabel(task.updatedAt)}
                </span>
              </button>
              {task.status === "declined" && task.declined ? (
                <p className="line-clamp-2 px-2 pb-1 pl-8 text-muted-foreground text-xs">
                  {previewLine(task.declined.reason)}
                </p>
              ) : null}
              {task.error ? (
                <p className="px-2 pb-1 pl-8 text-destructive-foreground text-xs">{task.error}</p>
              ) : null}
            </li>
          );
        })}
      </ul>
      {tasks.length > HISTORY_PREVIEW ? (
        <Button
          size="xs"
          variant="ghost-muted"
          className="mt-1 self-start"
          onClick={() => setShowAll((value) => !value)}
        >
          {showAll ? "Show fewer" : `Show all ${tasks.length}`}
        </Button>
      ) : null}
    </div>
  );
}
