import type {
  ApprovalRequestId,
  EnvironmentId,
  IntegrationApprovalChangeField,
  ProviderApprovalDecision,
  ThreadId,
} from "@t3tools/contracts";
import { memo, useState } from "react";
import { type PendingApproval } from "../../session-logic";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { DEFAULT_APPROVAL_OPTIONS } from "./ComposerPendingApprovalActions";
import { IntegrationApprovalDialog } from "./IntegrationApprovalDialog";

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
  environmentId: EnvironmentId;
  /** Lets the review dialog show an image the agent is about to send. */
  threadId?: ThreadId | undefined;
  isResponding: boolean;
  onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
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

const collapseWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();

/**
 * What an integration approval is asking for, in the two shapes it comes in.
 *
 * Our own integration tools send the change structured, field by field. A
 * provider's own approval — or a row persisted before that existed — carries
 * only the detail text, whose first line is the headline and whose remainder
 * reads as one block. Both end up as fields so the row and the review dialog
 * have one thing to render.
 */
export function integrationApprovalView(
  approval: Pick<PendingApproval, "change" | "detail">,
  fallbackHeadline: string,
): {
  readonly headline: string;
  readonly preview: string;
  readonly record: { readonly label: string; readonly url?: string | undefined } | undefined;
  readonly fields: ReadonlyArray<IntegrationApprovalChangeField>;
} {
  const change = approval.change;
  if (change) {
    return {
      headline: change.summary,
      preview: integrationApprovalPreview(change.fields),
      record: change.record,
      fields: change.fields,
    };
  }
  const { headline, body } = splitIntegrationDetail(approval.detail ?? "");
  const fields = body ? [{ label: "Change", value: body } as const] : [];
  return {
    headline: headline || fallbackHeadline,
    preview: collapseWhitespace(body),
    record: undefined,
    fields,
  };
}

/**
 * The row's one line about the change. Prose the agent wrote stands on its own;
 * a set of edited fields reads better as `Title: … · State: …`, since a bare
 * value there says nothing about what it is going to become.
 */
export function integrationApprovalPreview(
  fields: ReadonlyArray<IntegrationApprovalChangeField>,
): string {
  const [first] = fields;
  if (first === undefined) return "";
  if (fields.length === 1) return collapseWhitespace(first.value);
  return fields.map((field) => `${field.label}: ${collapseWhitespace(field.value)}`).join(" · ");
}

export const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel({
  approval,
  pendingCount,
  environmentId,
  threadId,
  isResponding,
  onRespondToApproval,
  className,
}: ComposerPendingApprovalPanelProps) {
  const [reviewOpen, setReviewOpen] = useState(false);
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
    const { headline, preview, record, fields } = integrationApprovalView(approval, fallbackLabel);
    return (
      <span
        aria-label={fallbackLabel}
        className={cn("flex min-w-0 flex-1 items-center gap-2 py-0.5", className)}
        role="group"
      >
        {approval.appName ? (
          <span className="shrink-0 rounded-sm bg-background/60 px-1.5 py-0.5 text-[10px] font-medium text-foreground">
            {approval.appName}
          </span>
        ) : null}
        <span
          aria-label={detailAriaLabel}
          className="flex min-w-0 flex-1 items-baseline gap-1.5"
          data-approval-detail="summary"
        >
          <span className="shrink-0 text-[11px] font-medium text-foreground">{headline}</span>
          {preview ? (
            <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
              {preview}
            </span>
          ) : null}
        </span>
        <Button
          type="button"
          size="micro"
          variant="ghost-muted"
          className="shrink-0 font-normal"
          data-approval-review="open"
          onClick={() => setReviewOpen(true)}
        >
          Review
        </Button>
        {pendingBadge}
        <IntegrationApprovalDialog
          open={reviewOpen}
          onOpenChange={setReviewOpen}
          requestId={approval.requestId}
          appName={approval.appName}
          headline={headline}
          record={record}
          fields={fields}
          environmentId={environmentId}
          threadId={threadId}
          options={approval.options ?? DEFAULT_APPROVAL_OPTIONS}
          isResponding={isResponding}
          onRespondToApproval={onRespondToApproval}
        />
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
