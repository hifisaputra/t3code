import {
  assistantTaskThreadId,
  type AssistantBoard,
  type AssistantTask,
  type AssistantTaskTrack,
  type AssistantThreadRole,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { ArchiveRestoreIcon, CircleCheckIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useThreadActions } from "~/hooks/useThreadActions";
import { cn } from "~/lib/utils";
import { useThreadShell } from "~/state/entities";

import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { taskIsFinished, teamRoleOrder, threadHasOpenQuestion } from "./assistantBoard.logic";
import { StatusDot, threadIsBusy, useAssistantAction } from "./assistantUi";
import { ThreadKindIcon, threadKind, ResearchBadge } from "./threadKinds";

/** One issue's four conversations, keyed by the role each plays. */
export type TeamShells = Readonly<Record<AssistantThreadRole, EnvironmentThreadShell | null>>;

/**
 * The live shell of each of an issue's threads. Review and e2e threads are
 * created only when the issue reaches them, and a thread archived before the
 * server started settling them is gone from the live shells too, so any of
 * these can be null.
 */
export function useTeamShells(
  environmentId: EnvironmentId,
  task: Pick<AssistantTask, "id" | "threadId"> | null,
): TeamShells {
  const ref = (role: AssistantThreadRole) =>
    task === null ? null : { environmentId, threadId: assistantTaskThreadId(task, role) };
  return {
    lead: useThreadShell(ref("lead")),
    implement: useThreadShell(ref("implement")),
    review: useThreadShell(ref("review")),
    e2e: useThreadShell(ref("e2e")),
  };
}

/** The thread that holds the issue right now, whose turn the phase describes. */
export function teamHolder(
  task: Pick<AssistantTask, "stage">,
  shells: TeamShells,
): EnvironmentThreadShell | null {
  switch (task.stage) {
    case "lead":
      return shells.lead;
    case "review":
      return shells.review;
    case "e2e":
      return shells.e2e;
    default:
      return shells.implement;
  }
}

/**
 * Whether one of the issue's threads was ever created, from what the record
 * shows of it. Review and e2e threads exist only once the issue reached them,
 * a worker only once it was briefed, and a team leader only for led work; a
 * thread that never existed has nothing to restore.
 */
export function teamThreadEverRan(
  task: Pick<AssistantTask, "leader" | "turns" | "codeReview" | "e2e" | "research">,
  role: AssistantThreadRole,
): boolean {
  switch (role) {
    case "lead":
      return task.leader === true;
    case "implement":
      return task.turns > 0;
    case "review":
      return task.codeReview != null || task.research != null;
    case "e2e":
      return task.e2e != null;
  }
}

type ChipSize = "sm" | "md";

const CHIP_SIZE: Record<ChipSize, string> = {
  sm: "gap-1 px-1.5 py-0.5 text-[11px]",
  md: "gap-1.5 px-2 py-1 text-xs",
};

/** What the chip says about its thread, most urgent first. */
type ChipState = "busy" | "waiting" | "done" | "idle" | "missing" | "archived";

function ChipMarker({ state, pending }: { state: ChipState; pending: boolean }) {
  if (pending) return <Spinner className="size-3 shrink-0" />;
  switch (state) {
    case "busy":
      return <StatusDot tone="active" pulse />;
    case "waiting":
      return <StatusDot tone="waiting" />;
    case "done":
      return <CircleCheckIcon aria-hidden className="size-3 shrink-0 text-success-foreground/80" />;
    case "idle":
      return <StatusDot tone="paused" />;
    case "archived":
      return <ArchiveRestoreIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />;
    case "missing":
      return null;
  }
}

function TeamChipButton({
  track,
  role,
  size,
  state,
  finished,
  holder,
  current,
  pending,
  onClick,
}: {
  role: AssistantThreadRole;
  track?: AssistantTaskTrack | undefined;
  size: ChipSize;
  state: ChipState;
  /** A finished issue: a thread that is missing now never started. */
  finished: boolean;
  /** The thread the issue is with right now, drawn a shade stronger. */
  holder: boolean;
  /** The thread the person is already reading. */
  current: boolean;
  pending: boolean;
  onClick: (() => void) | null;
}) {
  const kind = threadKind(role, track);
  const label = kind.label;
  const note =
    state === "missing"
      ? finished
        ? "Never started."
        : "Not started yet."
      : state === "archived"
        ? "Archived: click to restore and open."
        : null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            // Not `disabled`: the tooltip still explains a thread that never started.
            aria-disabled={onClick === null}
            aria-current={current ? "true" : undefined}
            aria-label={
              state === "archived"
                ? `Restore and open the ${label.toLowerCase()} thread`
                : state === "missing"
                  ? `${label}: ${finished ? "never started" : "not started yet"}`
                  : `Open the ${label.toLowerCase()} thread`
            }
            onClick={() => onClick?.()}
            className={cn(
              "inline-flex min-w-0 items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              CHIP_SIZE[size],
              onClick === null ? "cursor-default" : "hover:bg-accent",
              current
                ? "border-foreground/30 bg-accent/60 font-medium"
                : holder
                  ? "border-foreground/25 bg-accent/40 font-medium"
                  : "border-border/60",
              state === "missing" && "border-dashed text-muted-foreground/70",
              state === "archived" && "text-muted-foreground",
            )}
          />
        }
      >
        <ThreadKindIcon kind={role} className={cn("size-3", state === "missing" && "opacity-50")} />
        <span className="truncate">{label}</span>
        <ChipMarker state={state} pending={pending} />
      </TooltipTrigger>
      <TooltipPopup className="max-w-64">
        <span className="font-medium">{label}.</span> {kind.does}
        {note ? ` ${note}` : null}
        {current ? " You are reading it." : null}
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * A finished issue's thread that was archived rather than settled. Restoring it
 * is the only way back into the conversation, so the chip does that and then
 * opens it. Its own component: `useThreadActions` is a large hook, and only a
 * chip that can actually restore should pay for it.
 */
function RestoreTeamChip({
  track,
  environmentId,
  threadId,
  role,
  size,
  holder,
  onOpenThread,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  role: AssistantThreadRole;
  track?: AssistantTaskTrack | undefined;
  size: ChipSize;
  holder: boolean;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const { unarchiveThread } = useThreadActions();
  const { pending, run } = useAssistantAction();
  const restore = () => {
    if (pending) return;
    void run("restore", () => unarchiveThread({ environmentId, threadId }), {
      failure: `Could not restore the ${threadKind(role, track).label.toLowerCase()} thread`,
    }).then((restored) => {
      if (restored) onOpenThread(threadId);
    });
  };
  return (
    <TeamChipButton
      track={track}
      role={role}
      size={size}
      state="archived"
      finished
      holder={holder}
      current={false}
      pending={pending !== null}
      onClick={restore}
    />
  );
}

/**
 * The four conversations of one issue's team, in the order the work moves
 * through them, each showing what its thread is doing and opening it on click.
 */
export function TeamThreads({
  environmentId,
  task,
  board,
  onOpenThread,
  size = "md",
  current,
  label,
}: {
  environmentId: EnvironmentId;
  task: AssistantTask;
  /** Only needed where a thread may be holding an unanswered question. */
  board?: AssistantBoard | null;
  onOpenThread: (threadId: ThreadId) => void;
  size?: ChipSize;
  /** The role of the thread the person is already reading, if any. */
  current?: AssistantThreadRole | null;
  label?: ReactNode;
}) {
  const shells = useTeamShells(environmentId, task);
  const finished = taskIsFinished(task);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      {label ? (
        <span className="mr-0.5 shrink-0 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
          {label}
        </span>
      ) : null}
      <ResearchBadge track={task.track} />
      {teamRoleOrder
        .filter((role) => task.track !== "research" || role !== "e2e")
        .map((role) => {
          const threadId = assistantTaskThreadId(task, role);
          const shell = shells[role];
          const holder = task.stage === role && !finished;
          // A finished issue's missing thread is archived only if it once ran:
          // the record says which of the four ever did.
          if (shell === null && finished && teamThreadEverRan(task, role))
            return (
              <RestoreTeamChip
                track={task.track}
                key={role}
                environmentId={environmentId}
                threadId={threadId}
                role={role}
                size={size}
                holder={holder}
                onOpenThread={onOpenThread}
              />
            );
          const waiting =
            Boolean(shell?.hasPendingApprovals || shell?.hasPendingUserInput) ||
            threadHasOpenQuestion(board ?? null, threadId);
          const state: ChipState =
            shell === null
              ? "missing"
              : threadIsBusy(shell)
                ? "busy"
                : waiting
                  ? "waiting"
                  : finished
                    ? "done"
                    : "idle";
          return (
            <TeamChipButton
              track={task.track}
              key={role}
              role={role}
              size={size}
              state={state}
              finished={finished}
              holder={holder}
              current={current === role}
              pending={false}
              onClick={shell === null ? null : () => onOpenThread(threadId)}
            />
          );
        })}
    </div>
  );
}
