import { memo } from "react";
import { type PendingApproval } from "../../session-logic";
import { cn } from "~/lib/utils";

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
  className?: string;
}

/**
 * An integration write arrives as "what" on the first line and the content it
 * will send after a blank line, so the two are shown as a headline and a body
 * rather than one preformatted block the row cannot wrap.
 */
export function splitIntegrationDetail(detail: string): {
  readonly headline: string;
  readonly body: string;
} {
  const normalized = detail.replace(/\r\n/g, "\n").trim();
  const [headline = "", ...rest] = normalized.split("\n");
  return { headline: headline.trim(), body: rest.join("\n").trim() };
}

export const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel({
  approval,
  pendingCount,
  className,
}: ComposerPendingApprovalPanelProps) {
  const fallbackLabel =
    approval.requestKind === "mcp-elicitation"
      ? "App access approval"
      : approval.requestKind === "integration"
        ? "Integration approval"
        : approval.requestKind === "command"
          ? "Command approval"
          : approval.requestKind === "file-read"
            ? "File read approval"
            : "File change approval";
  const detailAriaLabel =
    approval.requestKind === "mcp-elicitation"
      ? "App access request"
      : approval.requestKind === "integration"
        ? "Requested change"
        : approval.requestKind === "command"
          ? "Command"
          : approval.requestKind === "file-read"
            ? "File to read"
            : "File change";
  const pendingBadge =
    pendingCount > 1 ? (
      <span className="shrink-0 text-[10px] font-medium text-muted-foreground tabular-nums">
        1/{pendingCount}
      </span>
    ) : null;

  if (approval.requestKind === "integration") {
    const { headline, body } = splitIntegrationDetail(approval.detail ?? "");
    return (
      <span
        aria-label={fallbackLabel}
        className={cn("flex min-w-0 flex-1 flex-col gap-1 py-0.5", className)}
        role="group"
      >
        <span className="flex min-w-0 items-center gap-2">
          {approval.appName ? (
            <span className="max-w-32 shrink-0 truncate text-[11px] font-medium text-foreground">
              {approval.appName}
            </span>
          ) : null}
          <span className="min-w-0 flex-1 truncate text-[11px] text-foreground/85">
            {headline || fallbackLabel}
          </span>
          {pendingBadge}
        </span>
        {body ? (
          <span
            aria-label={detailAriaLabel}
            className="block max-h-28 min-w-0 overflow-y-auto rounded-sm bg-background/50 px-2 py-1.5 text-[11px] leading-snug break-words whitespace-pre-wrap text-foreground/80 [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
            data-approval-detail="complete"
            tabIndex={0}
          >
            {body}
          </span>
        ) : null}
      </span>
    );
  }

  return (
    <span
      aria-label={fallbackLabel}
      className={cn("flex min-w-0 flex-1 items-center gap-2", className)}
      role="group"
    >
      {approval.appName ? (
        <span className="max-w-32 shrink truncate text-[11px] font-medium text-foreground">
          {approval.appName}
        </span>
      ) : null}
      <code
        aria-label={detailAriaLabel}
        className="block max-h-20 min-w-0 flex-1 overflow-auto whitespace-pre font-mono text-[11px] text-foreground/85 [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 [&::-webkit-scrollbar]:h-1.5"
        data-approval-detail="complete"
        tabIndex={0}
      >
        {approval.detail || fallbackLabel}
      </code>
      {pendingBadge}
    </span>
  );
});
