import type { LinearIssueSummary } from "@t3tools/contracts";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { Button } from "../ui/button";
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
  linkedThread,
  onSelect,
  onStartThread,
  onOpenThread,
}: {
  issue: LinearIssueSummary;
  selected: boolean;
  /** The live thread already working this issue, when one exists. */
  linkedThread: IssueLinkedThread | null;
  onSelect: (issue: LinearIssueSummary) => void;
  onStartThread: (issue: LinearIssueSummary) => void;
  onOpenThread: (thread: IssueLinkedThread) => void;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-1 rounded-lg pr-2 transition-colors",
        selected ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(issue)}
        className="flex min-w-0 flex-1 flex-col gap-1 rounded-lg px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <span className="flex min-w-0 items-center gap-2">
          <IssueStateDot color={issue.state.color} />
          <span className="shrink-0 font-mono text-muted-foreground text-xs">
            {issue.identifier}
          </span>
          <span className="min-w-0 flex-1 truncate font-medium text-foreground text-sm">
            {issue.title}
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-2 overflow-hidden pl-4.5 text-muted-foreground/70 text-xs">
          <span className="shrink-0">{issue.team.key}</span>
          {issue.project ? <span className="max-w-40 truncate">{issue.project.name}</span> : null}
          {issue.cycle ? (
            <span className="max-w-32 shrink-0 truncate">{issueCycleLabel(issue.cycle)}</span>
          ) : null}
          <span className="shrink-0 tabular-nums">{formatRelativeTimeLabel(issue.updatedAt)}</span>
        </span>
      </button>
      {linkedThread ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="shrink-0"
          onClick={() => onOpenThread(linkedThread)}
        >
          Open thread
        </Button>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="shrink-0"
          onClick={() => onStartThread(issue)}
        >
          Start thread
        </Button>
      )}
    </div>
  );
}

/**
 * Memoized: typing in the search box re-renders the whole list, and a row whose
 * issue, selection and thread link are unchanged has nothing new to draw. The
 * route hands it stable callbacks for that to be worth anything.
 */
export const IssueRow = memo(IssueRowImpl);
