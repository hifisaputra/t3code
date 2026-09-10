import type { LinearIssueSummary } from "@t3tools/contracts";
import { ArrowUpRightIcon, MessageSquareIcon, PlayIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { IssuePriorityIcon } from "./IssuePriorityIcon";
import { issueCycleLabel, type IssueLinkedThread } from "./issueList.logic";

/**
 * Linear owns the workflow colour and sends it as hex, so the dot is the one
 * inline style on the row — the design system has no token for a colour a
 * workspace invented.
 */
export function IssueStateDot({ color, className }: { color: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("size-2.5 shrink-0 rounded-full", className)}
      style={{ backgroundColor: color }}
    />
  );
}

function IssueRowImpl({
  issue,
  selected,
  showAssignee,
  linkedThread,
  onSelect,
  onStartThread,
  onOpenThread,
}: {
  issue: LinearIssueSummary;
  selected: boolean;
  /** Only worth a slot while the list spans everyone's issues rather than mine. */
  showAssignee: boolean;
  /** The live thread already working this issue, when one exists. */
  linkedThread: IssueLinkedThread | null;
  onSelect: (issue: LinearIssueSummary) => void;
  onStartThread: (issue: LinearIssueSummary) => void;
  onOpenThread: (thread: IssueLinkedThread) => void;
}) {
  return (
    // A row is one button that covers it and a second that acts on it, which
    // nesting cannot express: the selecting button is laid over the row, and
    // the two things that answer a pointer of their own — the state tooltip and
    // the action — are positioned back above it.
    <div
      className={cn(
        "group relative grid grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg px-3 py-2 transition-colors",
        // Offscreen rows are skipped for style, layout and paint, so a long
        // list costs what the viewport shows. The intrinsic size keeps the
        // scrollbar honest while a row is skipped.
        "[contain-intrinsic-block-size:56px] [content-visibility:auto]",
        selected ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        aria-label={`${issue.identifier} ${issue.title}`}
        onClick={() => onSelect(issue)}
        className="absolute inset-0 rounded-lg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <IssuePriorityIcon priority={issue.priority} className="size-3.5" />
      <Tooltip>
        <TooltipTrigger render={<span className="relative flex" />}>
          <IssueStateDot color={issue.state.color} />
        </TooltipTrigger>
        <TooltipPopup>{issue.state.name}</TooltipPopup>
      </Tooltip>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 font-mono text-muted-foreground text-xs">
            {issue.identifier}
          </span>
          <span className="min-w-0 flex-1 truncate font-medium text-foreground text-sm">
            {issue.title}
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-2 truncate text-muted-foreground/70 text-xs">
          <span className="shrink-0">{issue.team.key}</span>
          {issue.project ? <span className="max-w-40 truncate">{issue.project.name}</span> : null}
          {issue.cycle ? (
            <span className="max-w-32 shrink-0 truncate">{issueCycleLabel(issue.cycle)}</span>
          ) : null}
          {showAssignee ? (
            <span className="max-w-32 truncate">
              {issue.assignee?.displayName ?? issue.assignee?.name ?? "Unassigned"}
            </span>
          ) : null}
          {issue.estimate ? (
            <span className="shrink-0 tabular-nums">{issue.estimate} pt</span>
          ) : null}
        </span>
      </span>
      <span className="relative flex items-center gap-2">
        {linkedThread ? (
          <Badge variant="info" size="sm" className="gap-1">
            <MessageSquareIcon aria-hidden />
            Thread
          </Badge>
        ) : null}
        <span className="shrink-0 text-[11px] text-muted-foreground/70 tabular-nums">
          {formatRelativeTimeLabel(issue.updatedAt)}
        </span>
        {/* The action is the row's second verb, so it stays out of the way
            until the row is under a pointer or holds focus. A coarse pointer
            has neither, and keeps it. */}
        {linkedThread ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100"
            onClick={() => onOpenThread(linkedThread)}
          >
            <ArrowUpRightIcon aria-hidden />
            Open thread
          </Button>
        ) : (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100"
            onClick={() => onStartThread(issue)}
          >
            <PlayIcon aria-hidden />
            Start thread
          </Button>
        )}
      </span>
    </div>
  );
}

/**
 * Memoized: typing in the search box re-renders the whole list, and a row whose
 * issue, selection and thread link are unchanged has nothing new to draw. The
 * route hands it stable callbacks for that to be worth anything.
 */
export const IssueRow = memo(IssueRowImpl);
