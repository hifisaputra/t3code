import type {
  AssistantDecision,
  AssistantProject,
  AssistantTask,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import {
  ArrowUpRightIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CircleSlashIcon,
  EllipsisIcon,
  GitPullRequestIcon,
  RotateCcwIcon,
  SkipForwardIcon,
  UndoIcon,
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
import { describeTaskPhase, type TaskPhaseTone } from "./assistantBoard.logic";
import {
  confirmDestructive,
  ExpandableMarkdown,
  IssueLink,
  StatusDot,
  threadIsBusy,
  useAssistantAction,
  type StatusTone,
} from "./assistantUi";

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

export function ActiveTaskCard({
  environmentId,
  task,
  project,
  projectLabel,
  decisions,
  onOpenThread,
}: {
  environmentId: EnvironmentId;
  task: AssistantTask;
  project: AssistantProject | undefined;
  projectLabel: string | null;
  decisions: ReadonlyArray<AssistantDecision>;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const review = useAtomCommand(developerAssistant.review);
  const { pending, run } = useAssistantAction();
  const worker = useThreadShell({ environmentId, threadId: task.threadId });
  const workerBusy = threadIsBusy(worker);
  const phase = describeTaskPhase({
    task,
    workerBusy,
    workerNeedsInput: Boolean(worker?.hasPendingApprovals || worker?.hasPendingUserInput),
    step: worker?.planProgress?.step ?? null,
    hasOpenDecision: decisions.some(
      (d) => d.answer === null && (d.taskId === task.id || d.threadId === task.threadId),
    ),
  });
  const pullRequest = worker?.linkedPullRequest ?? worker?.branchPullRequest ?? null;
  const moreRounds = project?.config.maxWorkerTurns ?? 6;

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
      </div>
      <button
        type="button"
        onClick={() => onOpenThread(task.threadId)}
        className="-mt-1 text-left font-semibold text-sm leading-snug hover:underline focus-visible:underline focus-visible:outline-none"
      >
        {task.issue.title}
      </button>

      <div className={cn("flex items-start gap-2 rounded-lg px-3 py-2", PHASE_STYLE[phase.tone])}>
        <StatusDot tone={PHASE_DOT[phase.tone]} pulse={workerBusy} className="mt-1.5" />
        <div className="min-w-0">
          <p className="font-medium text-sm">{phase.label}</p>
          {phase.detail ? (
            <p className="mt-0.5 line-clamp-3 text-xs opacity-90">{phase.detail}</p>
          ) : null}
        </div>
      </div>

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
      </div>

      {task.brief.trim() ? (
        <Collapsible>
          <CollapsibleTrigger className="group inline-flex items-center gap-1 font-medium text-muted-foreground text-xs hover:text-foreground">
            <ChevronRightIcon
              aria-hidden
              className="size-3.5 transition-transform group-data-panel-open:rotate-90"
            />
            What the worker was asked to do
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <div className="mt-2 rounded-lg border border-border/60 p-3">
              <ExpandableMarkdown text={task.brief} environmentId={environmentId} />
            </div>
          </CollapsiblePanel>
        </Collapsible>
      ) : null}

      <div className="flex items-center gap-1.5">
        <Button size="sm" variant="outline" onClick={() => onOpenThread(task.threadId)}>
          <ArrowUpRightIcon />
          Open worker
        </Button>
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost"
                className="ml-auto"
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
    </article>
  );
}

const HISTORY_STATUS = {
  accepted: { icon: CircleCheckIcon, label: "Accepted", className: "text-success-foreground" },
  "changes-requested": { icon: UndoIcon, label: "Sent back", className: "text-warning-foreground" },
  skipped: { icon: CircleSlashIcon, label: "Skipped", className: "text-muted-foreground" },
} as const;

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
                onClick={() => onOpenThread(task.threadId)}
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
