import { cn } from "~/lib/utils";

/**
 * Linear's priority glyph: three rising bars, filled to the level the issue is
 * at, with urgent as a filled square and "no priority" as a faint dashed row.
 * Priority numbers follow Linear: 0 none, 1 urgent, 2 high, 3 medium, 4 low.
 */
export function issuePriorityLabel(priority: number): string {
  switch (priority) {
    case 1:
      return "Urgent";
    case 2:
      return "High priority";
    case 3:
      return "Medium priority";
    case 4:
      return "Low priority";
    default:
      return "No priority";
  }
}

const BAR_HEIGHTS = [6, 9, 12] as const;

export function IssuePriorityIcon({
  priority,
  className,
}: {
  priority: number;
  className?: string;
}) {
  const label = issuePriorityLabel(priority);
  if (priority === 1) {
    return (
      <svg
        role="img"
        aria-label={label}
        viewBox="0 0 16 16"
        className={cn("size-3.5 shrink-0 text-warning", className)}
      >
        <rect x="1" y="1" width="14" height="14" rx="3" fill="currentColor" />
        <path d="M8 4v5" stroke="var(--color-background)" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="8" cy="11.6" r="1" fill="var(--color-background)" />
      </svg>
    );
  }
  // 2 high lights all three bars, 3 medium two, 4 low one, 0 none lights nothing.
  const lit = priority === 2 ? 3 : priority === 3 ? 2 : priority === 4 ? 1 : 0;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox="0 0 16 16"
      className={cn("size-3.5 shrink-0 text-muted-foreground", className)}
    >
      {BAR_HEIGHTS.map((height, index) => (
        <rect
          key={height}
          x={1.5 + index * 5}
          y={14 - height}
          width="3"
          height={height}
          rx="1"
          fill="currentColor"
          opacity={index < lit ? 1 : 0.25}
        />
      ))}
    </svg>
  );
}
