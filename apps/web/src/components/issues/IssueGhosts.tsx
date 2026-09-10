/**
 * Loading states for the issues surface — the first list, and a detail panel
 * opening — drawn as bars in the geometry of the content they stand for.
 *
 * The bars share the app-wide skeleton tone (`muted-foreground` at low alpha,
 * which reads on both themes) and one `animate-skeleton` pulse applied on the
 * container, so any number of bars costs a single opacity animation.
 */
import { cn } from "~/lib/utils";

function GhostBar({ className }: { className?: string | undefined }) {
  return <div aria-hidden className={cn("h-3 rounded bg-muted-foreground/15", className)} />;
}

/** Widths cycle rather than randomize, so the ghost renders the same on every pass. */
const TITLE_WIDTHS = ["w-3/5", "w-2/5", "w-1/2", "w-2/3", "w-2/5", "w-3/5", "w-1/2", "w-4/5"];
const META_WIDTHS = ["w-2/5", "w-1/3", "w-2/5", "w-1/4", "w-1/3", "w-2/5", "w-1/3", "w-1/4"];

/** Rows in the list's own grid — priority, state dot, title over meta, time. */
export function IssueListGhost({ rows = 8 }: { rows?: number }) {
  return (
    <div
      role="status"
      aria-label="Loading issues"
      className="flex flex-col gap-0.5 motion-safe:animate-skeleton"
    >
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="grid grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg px-3 py-2"
        >
          <GhostBar className="size-3.5 rounded-sm" />
          <GhostBar className="size-2.5 rounded-full" />
          <div className="min-w-0 space-y-1.5">
            <GhostBar className={cn("h-3.5", TITLE_WIDTHS[index % TITLE_WIDTHS.length])} />
            <GhostBar className={META_WIDTHS[index % META_WIDTHS.length]} />
          </div>
          <GhostBar className="w-10" />
        </div>
      ))}
    </div>
  );
}

/** The detail panel's shape: header, the facts card, and the description under it. */
export function IssueDetailGhost() {
  return (
    <div
      role="status"
      aria-label="Loading issue"
      className="flex flex-col gap-5 p-4 motion-safe:animate-skeleton sm:p-5"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-center gap-2">
            <GhostBar className="w-16" />
            <GhostBar className="h-5 w-20 rounded-full" />
            <GhostBar className="size-3.5 rounded-sm" />
          </div>
          <GhostBar className="h-4 w-4/5 max-w-md" />
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <GhostBar className="h-7 w-24 rounded-md" />
          <GhostBar className="size-7 rounded-md" />
        </div>
      </div>

      <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 rounded-lg border border-border/60 bg-card p-3">
        {["w-2/3", "w-1/2", "w-3/5", "w-2/5"].map((width) => (
          <div key={width} className="contents">
            <GhostBar className="w-14" />
            <GhostBar className={width} />
          </div>
        ))}
      </div>

      <div className="space-y-2">
        <GhostBar className="w-full" />
        <GhostBar className="w-11/12" />
        <GhostBar className="w-2/3" />
      </div>
    </div>
  );
}
