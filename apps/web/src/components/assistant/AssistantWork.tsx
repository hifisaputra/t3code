import {
  assistantParallelIssues,
  assistantTaskE2eEnvironment,
  assistantThreadKind,
  type AssistantBoard,
  type AssistantCheckRun,
  type AssistantDecision,
  type AssistantE2eCheckResult,
  type AssistantE2eDepth,
  type AssistantProject,
  type AssistantTask,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  ArrowUpRightIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleIcon,
  CircleSlashIcon,
  CircleXIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  GitPullRequestIcon,
  HandIcon,
  ImageIcon,
  RotateCcwIcon,
  SkipForwardIcon,
  UndoIcon,
  XIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { developerAssistant } from "~/state/developerAssistant";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatElapsedDurationLabel, formatRelativeTimeLabel } from "~/timestampFormat";

import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  describeE2ePlan,
  describeTaskPhase,
  e2eDepthChange,
  e2eDepthLabel,
  previewLine,
  taskOutcome,
  taskPipeline,
  teamRoleOrder,
  type PipelineStep,
  type TaskPhaseTone,
} from "./assistantBoard.logic";
import { teamHolder, TeamThreads, useTeamShells } from "./AssistantTeam";
import {
  CommitChip,
  confirmDestructive,
  ExpandableMarkdown,
  IssueLink,
  StatusDot,
  threadIsBusy,
  threadKeepsTeamWaiting,
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
  const skipped = step.state === "skipped";
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
                skipped && "border-dashed opacity-55",
              )}
            />
          }
        >
          <span className="flex min-w-0 items-center gap-1.5 text-xs">
            {step.state === "done" ? (
              <CircleCheckIcon aria-hidden className="size-3.5 shrink-0 text-success-foreground" />
            ) : step.state === "failed" ? (
              <CircleXIcon aria-hidden className="size-3.5 shrink-0 text-destructive-foreground" />
            ) : skipped ? (
              <CircleDashedIcon
                aria-hidden
                className="size-3.5 shrink-0 text-muted-foreground/60"
              />
            ) : current ? (
              <StatusDot
                tone={needsYou ? "waiting" : busy ? "active" : "paused"}
                pulse={busy && !needsYou}
                className="mx-0.5"
              />
            ) : (
              <CircleIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground/50" />
            )}
            <span
              className={cn(
                "truncate",
                current ? "font-medium" : "text-muted-foreground",
                skipped && "line-through",
              )}
            >
              {step.label}
            </span>
          </span>
          <span className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
            <kind.icon aria-hidden className={cn("size-3 shrink-0", kind.className)} />
            <span className="truncate">{note ?? kind.label}</span>
          </span>
        </TooltipTrigger>
        <TooltipPopup className="max-w-64">
          {skipped ? (
            "This issue runs no e2e test."
          ) : (
            <>
              <span className="font-medium">{kind.label}.</span> {kind.does}
              {thread === null ? " Starts when the issue gets here." : null}
            </>
          )}
        </TooltipPopup>
      </Tooltip>
    </li>
  );
}

/** An issue the person handed over, rather than one the loop picked: from the board or Linear. */
function DispatchedChip({ fromLinear }: { fromLinear: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="shrink-0 rounded-md border border-border/60 px-1.5 py-0.5 text-[11px] text-muted-foreground" />
        }
      >
        {fromLinear ? "From Linear" : "Dispatched by you"}
      </TooltipTrigger>
      <TooltipPopup className="max-w-64">
        {fromLinear
          ? "Delegated to the T3 Code app in Linear. Its team reports in that session, and its team leader takes it or asks about it, never declining it."
          : "You picked this issue for the assistant. Its team leader takes it or asks you about it, and never declines it."}
      </TooltipPopup>
    </Tooltip>
  );
}

const E2E_CHECK_RESULT: Record<AssistantE2eCheckResult, { label: string; className: string }> = {
  passed: { label: "Passed", className: "text-success-foreground" },
  failed: { label: "Failed", className: "text-destructive-foreground" },
  "not-checked": { label: "Not checked", className: "text-muted-foreground" },
  skipped: { label: "Not in smoke test", className: "text-muted-foreground" },
};

const E2E_DEPTHS: ReadonlyArray<AssistantE2eDepth> = ["full", "smoke", "none"];
const E2E_DEPTH_CHANGED: Record<AssistantE2eDepth, string> = {
  full: "Full e2e test",
  smoke: "Smoke test",
  none: "No e2e test",
};

/**
 * How deep the issue's e2e test goes, who set it, and the tester brief. On an
 * active issue the person can change the depth until the test starts.
 */
function E2ePlanDetails({
  environmentId,
  task,
  editable,
}: {
  environmentId: EnvironmentId;
  task: AssistantTask;
  editable: boolean;
}) {
  const setE2eDepth = useAtomCommand(developerAssistant.setE2eDepth);
  const { pending, run } = useAssistantAction();
  const summary = describeE2ePlan(task);
  if (!summary || !task.e2ePlan) return null;
  const change = e2eDepthChange(task);
  const brief = task.e2ePlan.brief.trim();
  const choose = async (depth: AssistantE2eDepth) => {
    if (depth === summary.depth) return;
    if (depth === "none") {
      const confirmed = await confirmDestructive(
        `No e2e test will run for ${task.issue.identifier}.\nThe issue comes to you once staging is verified.`,
      );
      if (!confirmed) return;
    }
    void run(depth, () => setE2eDepth({ environmentId, input: { taskId: task.id, depth } }), {
      failure: "Could not change the e2e test",
      success: `${E2E_DEPTH_CHANGED[depth]} for ${task.issue.identifier}`,
    });
  };
  const control = (
    <ToggleGroup
      aria-label={`E2E test depth for ${task.issue.identifier}`}
      variant="segmented"
      value={[pending ?? summary.depth]}
      disabled={!change.allowed || pending !== null}
      onValueChange={(value) => {
        const next = value[0];
        if (next === "full" || next === "smoke" || next === "none") void choose(next);
      }}
    >
      {E2E_DEPTHS.map((depth) => (
        <Toggle key={depth} value={depth}>
          {e2eDepthLabel(depth)}
        </Toggle>
      ))}
    </ToggleGroup>
  );
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="font-medium text-muted-foreground uppercase tracking-wide">E2E test</span>
        {editable ? (
          change.allowed ? (
            control
          ) : (
            <Tooltip>
              <TooltipTrigger render={<span className="inline-flex" />}>{control}</TooltipTrigger>
              <TooltipPopup className="max-w-64">{change.reason}</TooltipPopup>
            </Tooltip>
          )
        ) : (
          <span className="font-medium">{summary.label}</span>
        )}
        {pending ? <Spinner className="size-3.5" /> : null}
        {summary.setBy ? <span className="text-muted-foreground">{summary.setBy}</span> : null}
      </div>
      {summary.detail ? (
        <p className="text-muted-foreground text-xs">
          {summary.depth === "none" ? `Why: ${summary.detail}` : summary.detail}
        </p>
      ) : null}
      {brief && summary.depth !== "none" ? (
        <Collapsible>
          <CollapsibleTrigger className="group inline-flex items-center gap-1 font-medium text-muted-foreground text-xs hover:text-foreground">
            <ChevronRightIcon
              aria-hidden
              className="size-3.5 transition-transform group-data-panel-open:rotate-90"
            />
            The tester&apos;s brief
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <div className="mt-2 rounded-lg border border-border/60 p-3">
              <ExpandableMarkdown text={brief} environmentId={environmentId} />
            </div>
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
    </div>
  );
}

/**
 * What the team leader said the issue has to do, numbered as every thread sees
 * them, each with the tester's result once the e2e run reports one.
 */
function CriteriaList({ task }: { task: AssistantTask }) {
  const criteria = task.criteria;
  if (!criteria || criteria.length === 0) return null;
  const checks = task.e2e?.checks ?? null;
  const screenshots = task.e2e?.screenshots ?? [];
  return (
    <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm marker:text-muted-foreground">
      {criteria.map((criterion, index) => {
        const check = checks?.find((entry) => entry.criterion === index + 1) ?? null;
        const result = check ? E2E_CHECK_RESULT[check.result] : null;
        const shot = check?.screenshot ? (screenshots[check.screenshot - 1] ?? null) : null;
        // Criteria are distinct checks, so the text identifies a row; the number
        // comes from the position, which is what the tester's results index into.
        return (
          <li key={criterion}>
            <span>{criterion}</span>
            {result ? (
              <span className={cn("ml-1.5 font-medium text-xs", result.className)}>
                {result.label}
              </span>
            ) : null}
            {check?.evidence.trim() ? (
              <p className="mt-0.5 whitespace-pre-line text-muted-foreground text-xs">
                {check.evidence}
              </p>
            ) : null}
            {shot ? (
              <a
                href={shot.url}
                target="_blank"
                rel="noreferrer"
                className="mt-0.5 inline-flex max-w-full items-center gap-1 text-muted-foreground text-xs hover:text-foreground hover:underline"
              >
                <ImageIcon aria-hidden className="size-3.5 shrink-0" />
                <span className="min-w-0 truncate">{shot.caption || "Screenshot"}</span>
              </a>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The project's own check command as T3 ran it for the last review request. A
 * red run never reached the reviewer: the worker was sent back with this output.
 */
function CheckRunLine({ checks }: { checks: AssistantCheckRun }) {
  const passed = checks.exitCode === 0;
  const line = (
    <>
      <span className={passed ? "text-success-foreground" : "text-destructive-foreground"}>
        {passed ? "Checks passed" : `Checks failed (exit ${checks.exitCode})`}
      </span>{" "}
      at <span className="font-mono">{checks.commit.slice(0, 7)}</span>
    </>
  );
  if (!checks.output.trim()) return <p className="text-muted-foreground text-xs">{line}</p>;
  return (
    <Collapsible>
      <CollapsibleTrigger className="group inline-flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground">
        <ChevronRightIcon
          aria-hidden
          className="size-3.5 shrink-0 transition-transform group-data-panel-open:rotate-90"
        />
        {line}
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="mt-1.5 rounded-lg border border-border/60 p-2">
          {checks.command.trim() ? (
            <p className="mb-1 break-all font-mono text-[11px] text-muted-foreground">
              {checks.command}
            </p>
          ) : null}
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px]">
            {checks.output}
          </pre>
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

export function ActiveTaskCard({
  environmentId,
  task,
  project,
  projectLabel,
  decisions,
  board,
  onOpenThread,
  onShowDecision,
}: {
  environmentId: EnvironmentId;
  task: AssistantTask;
  project: AssistantProject | undefined;
  projectLabel: string | null;
  decisions: ReadonlyArray<AssistantDecision>;
  board: AssistantBoard;
  onOpenThread: (threadId: ThreadId) => void;
  onShowDecision: (decision: AssistantDecision) => void;
}) {
  const review = useAtomCommand(developerAssistant.review);
  const { pending, run } = useAssistantAction();
  const shells = useTeamShells(environmentId, task);
  const worker = shells.implement;
  // The phase follows whichever of the issue's threads holds it.
  const holder = teamHolder(task, shells);
  const holderBusy = threadIsBusy(holder);
  // The issue's threads share one worktree: a handoff waits while a teammate runs on.
  const waitingOn =
    holderBusy || task.stage === undefined
      ? null
      : (teamRoleOrder.find(
          (role) => shells[role] !== holder && threadKeepsTeamWaiting(shells[role]),
        ) ?? null);
  const openDecision = decisions.find((d) => d.answer === null && d.taskId === task.id) ?? null;
  const phase = describeTaskPhase({
    task,
    workerBusy: holderBusy,
    workerNeedsInput: Boolean(holder?.hasPendingApprovals || holder?.hasPendingUserInput),
    step: holder?.planProgress?.step ?? null,
    hasOpenDecision: openDecision !== null,
    waitingOn,
  });
  const pipeline = taskPipeline(task);
  const asking = openDecision ? assistantThreadKind(openDecision.threadId) : null;
  const pullRequest = worker?.linkedPullRequest ?? worker?.branchPullRequest ?? null;
  const moreRounds = project?.config.maxWorkerTurns ?? 6;
  // Only worth saying when the project runs several teams: then the number is
  // what its instructions key ports and databases off.
  const slot = project && assistantParallelIssues(project.config) > 1 ? (task.slot ?? null) : null;
  const phaseDetail =
    openDecision !== null
      ? `The ${THREAD_KIND[asking ?? "implement"].label.toLowerCase()} asked: ${previewLine(openDecision.question)}`
      : phase.detail;

  return (
    <article className="flex flex-col gap-3 rounded-xl border border-border/70 bg-card p-4 shadow-xs/5">
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <IssueLink issue={task.issue} />
        {task.dispatched ? (
          <DispatchedChip fromLinear={task.linearSession?.origin === "delegated"} />
        ) : null}
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
          {task.deployWait ? (
            <p className="mt-0.5 line-clamp-2 text-xs opacity-90">
              Watching the staging deploy of{" "}
              <span className="font-mono">{task.deployWait.commit.slice(0, 7)}</span> ·{" "}
              {task.deployWait.checks} check{task.deployWait.checks === 1 ? "" : "s"}
              {task.deployWait.detail.trim() ? ` · ${task.deployWait.detail}` : ""}
            </p>
          ) : null}
        </div>
        {openDecision ? (
          <Button size="xs" className="shrink-0" onClick={() => onShowDecision(openDecision)}>
            Answer
          </Button>
        ) : null}
      </div>

      <TeamThreads
        label="Team"
        environmentId={environmentId}
        task={task}
        board={board}
        onOpenThread={onOpenThread}
      />

      {pipeline ? (
        <ol aria-label="Progress" className="flex flex-wrap gap-1.5">
          {pipeline.map((step) => {
            const shell = step.kind === "setup" ? null : shells[step.kind];
            const thread = shell?.id ?? null;
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
        {slot !== null ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="rounded-md border border-border/60 px-1.5 py-0.5 text-[11px]" />
              }
            >
              Slot {slot}
            </TooltipTrigger>
            <TooltipPopup className="max-w-64">
              Which of the project&apos;s teams this one is. Its instructions give each slot its own
              development ports and databases.
            </TooltipPopup>
          </Tooltip>
        ) : null}
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

      {task.checks ? <CheckRunLine checks={task.checks} /> : null}

      {task.criteria?.length ? (
        <div>
          <p className="mb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
            Acceptance criteria
          </p>
          <CriteriaList task={task} />
        </div>
      ) : null}

      <E2ePlanDetails environmentId={environmentId} task={task} editable />

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

const CODE_REVIEW_VERDICT = {
  approved: "Approved",
  "changes-requested": "Changes requested",
} as const;

const E2E_VERDICT = {
  passed: "Passed",
  partial: "Passed, with checks for you",
  failed: "Failed",
} as const;

/** One part of the record, folded away until the person wants it. */
function RecordSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group inline-flex items-center gap-1 font-medium text-muted-foreground text-xs hover:text-foreground">
        <ChevronRightIcon
          aria-hidden
          className="size-3.5 transition-transform group-data-panel-open:rotate-90"
        />
        {title}
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="mt-2 rounded-lg border border-border/60 p-3">{children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

/**
 * What the team did with a finished issue, and the way back into its four
 * conversations. Mounted only while its row is open, so a long history costs
 * nothing until the person opens a row.
 */
function HistoryRecord({
  environmentId,
  board,
  task,
  onOpenThread,
}: {
  environmentId: EnvironmentId;
  board: AssistantBoard | null;
  task: AssistantTask;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const shells = useTeamShells(environmentId, task);
  const worker = shells.implement;
  const outcome = taskOutcome(task);
  // Null once the worker thread is archived: the shell it came from is gone.
  const pullRequest = worker?.linkedPullRequest ?? worker?.branchPullRequest ?? null;
  const inWorktree = assistantTaskE2eEnvironment(task) === "worktree";
  return (
    <div className="mt-1 mb-2 ml-2 flex flex-col gap-3 rounded-lg border border-border/60 bg-card px-3 py-3">
      <div className="flex flex-col gap-1.5">
        <p className="text-sm">
          <span className="font-medium">{outcome.label}</span>
          <span className="text-muted-foreground">
            {" · "}
            {formatRelativeTimeLabel(task.updatedAt)} · started{" "}
            {formatRelativeTimeLabel(task.createdAt)}
          </span>
        </p>
        {outcome.detail ? (
          <blockquote className="border-border/70 border-l-2 pl-2.5 text-muted-foreground text-sm">
            {outcome.detail}
          </blockquote>
        ) : null}
        {task.error ? <p className="text-destructive-foreground text-xs">{task.error}</p> : null}
      </div>

      <TeamThreads
        label="Team"
        size="sm"
        environmentId={environmentId}
        task={task}
        board={board}
        onOpenThread={onOpenThread}
      />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-muted-foreground text-xs">
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
        {task.deployment ? (
          <>
            <a
              href={task.deployment.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 hover:text-foreground hover:underline"
            >
              <ExternalLinkIcon aria-hidden className="size-3.5" />
              Staging
            </a>
            <CommitChip revision={task.deployment.revision} />
          </>
        ) : null}
        {task.dispatched ? (
          <DispatchedChip fromLinear={task.linearSession?.origin === "delegated"} />
        ) : null}
        {task.e2e ? <span>{inWorktree ? "E2E in the worktree" : "E2E on staging"}</span> : null}
        {task.slot !== undefined ? (
          <span className="rounded-md border border-border/60 px-1.5 py-0.5 text-[11px]">
            Slot {task.slot}
          </span>
        ) : null}
      </div>

      {task.checks ? <CheckRunLine checks={task.checks} /> : null}

      {task.merge?.summary.trim() ? (
        <RecordSection title="What shipped">
          <ExpandableMarkdown text={task.merge.summary} environmentId={environmentId} />
        </RecordSection>
      ) : null}
      {task.criteria?.length ? (
        <RecordSection title="Acceptance criteria">
          <CriteriaList task={task} />
        </RecordSection>
      ) : null}
      {task.codeReview ? (
        <RecordSection title="Code review">
          <p className="mb-2 font-medium text-xs">{CODE_REVIEW_VERDICT[task.codeReview.verdict]}</p>
          {task.codeReview.summary.trim() ? (
            <ExpandableMarkdown text={task.codeReview.summary} environmentId={environmentId} />
          ) : null}
        </RecordSection>
      ) : null}
      {task.e2e ? (
        <RecordSection title="E2E check">
          <p className="mb-2 font-medium text-xs">{E2E_VERDICT[task.e2e.verdict]}</p>
          {task.e2ePlan ? (
            <div className="mb-2">
              <E2ePlanDetails environmentId={environmentId} task={task} editable={false} />
            </div>
          ) : null}
          {task.e2e.report.trim() ? (
            <ExpandableMarkdown text={task.e2e.report} environmentId={environmentId} />
          ) : null}
          {task.e2e.humanChecks.length > 0 ? (
            <div className="mt-2">
              <p className="mb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
                Checks for you
              </p>
              <ul className="flex list-disc flex-col gap-1 pl-4 text-sm">
                {task.e2e.humanChecks.map((check) => (
                  <li key={check}>{check}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {task.e2e.worthALook?.length ? (
            <div className="mt-2">
              <p className="mb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
                Worth a look
              </p>
              <ul className="flex list-disc flex-col gap-1 pl-4 text-sm">
                {task.e2e.worthALook.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {task.e2e.screenshots.length > 0 ? (
            <ul className="mt-2 flex flex-col gap-1">
              {task.e2e.screenshots.map((shot) => (
                <li key={shot.url}>
                  <a
                    href={shot.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground hover:underline"
                  >
                    <ImageIcon aria-hidden className="size-3.5 shrink-0" />
                    <span className="min-w-0 truncate">{shot.caption || "Screenshot"}</span>
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
        </RecordSection>
      ) : null}
      {!task.e2e && task.e2ePlan ? (
        <RecordSection title="E2E check">
          <E2ePlanDetails environmentId={environmentId} task={task} editable={false} />
        </RecordSection>
      ) : null}
      {task.reviewInstructions.trim() ? (
        <RecordSection title="How to check it">
          <ExpandableMarkdown text={task.reviewInstructions} environmentId={environmentId} />
        </RecordSection>
      ) : null}
      {task.brief.trim() ? (
        <RecordSection
          title={task.leader ? "The team leader's brief" : "What the assistant asked for"}
        >
          <ExpandableMarkdown text={task.brief} environmentId={environmentId} />
        </RecordSection>
      ) : null}
      {task.summary.trim() ? (
        <RecordSection title="Summary">
          <ExpandableMarkdown text={task.summary} environmentId={environmentId} />
        </RecordSection>
      ) : null}
    </div>
  );
}

function HistoryRow({
  environmentId,
  board,
  task,
  projectLabel,
  expanded,
  onToggle,
  onOpenThread,
}: {
  environmentId: EnvironmentId;
  board: AssistantBoard | null;
  task: AssistantTask;
  projectLabel: string | null;
  expanded: boolean;
  onToggle: () => void;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const status =
    HISTORY_STATUS[task.status as keyof typeof HISTORY_STATUS] ?? HISTORY_STATUS.skipped;
  return (
    <li>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="grid w-full grid-cols-[auto_auto_minmax(0,1fr)_auto_auto] items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <status.icon aria-hidden className={cn("size-3.5", status.className)} />
        <span className="font-mono text-muted-foreground text-xs">{task.issue.identifier}</span>
        <span className="min-w-0 truncate">
          {task.issue.title}
          {projectLabel ? <span className="text-muted-foreground"> · {projectLabel}</span> : null}
        </span>
        <span className="shrink-0 text-muted-foreground text-xs">
          {status.label} · {formatRelativeTimeLabel(task.updatedAt)}
        </span>
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-90",
          )}
        />
      </button>
      {expanded ? (
        <HistoryRecord
          environmentId={environmentId}
          board={board}
          task={task}
          onOpenThread={onOpenThread}
        />
      ) : (
        <>
          {task.status === "declined" && task.declined ? (
            <p className="line-clamp-2 px-2 pb-1 pl-8 text-muted-foreground text-xs">
              {previewLine(task.declined.reason)}
            </p>
          ) : null}
          {task.error ? (
            <p className="px-2 pb-1 pl-8 text-destructive-foreground text-xs">{task.error}</p>
          ) : null}
        </>
      )}
    </li>
  );
}

/** Finished issues, each row opening the record of what its team did. */
export function AssistantHistory({
  environmentId,
  board,
  tasks,
  projectLabel,
  onOpenThread,
}: {
  environmentId: EnvironmentId;
  board: AssistantBoard | null;
  tasks: ReadonlyArray<AssistantTask>;
  projectLabel: (task: AssistantTask) => string | null;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  // Several records may be open at once, so comparing two issues does not mean
  // opening one and losing the other.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const visible = showAll ? tasks : tasks.slice(0, HISTORY_PREVIEW);
  return (
    <div className="flex flex-col">
      <ul className="-mx-2 flex flex-col">
        {visible.map((task) => (
          <HistoryRow
            key={task.id}
            environmentId={environmentId}
            board={board}
            task={task}
            projectLabel={projectLabel(task)}
            expanded={expanded.has(task.id)}
            onToggle={() => toggle(task.id)}
            onOpenThread={onOpenThread}
          />
        ))}
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
