import {
  FULL_ACCESS_OVERRIDE_QUESTION,
  fullAccessOverrideExplanation,
} from "@t3tools/client-runtime/state/thread-requests";
import type {
  EnvironmentId,
  ProviderApprovalDecision,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import { memo, useState } from "react";
import { type PendingApproval } from "../../session-logic";
import { Button, InlineButton } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { composerFloatingLayerProps } from "./composerEventScope";
import { DEFAULT_APPROVAL_OPTIONS } from "./ComposerPendingApprovalActions";
import { IntegrationApprovalDialog } from "./IntegrationApprovalDialog";
import { integrationApprovalView } from "./ComposerPendingApprovalPanel.logic";
import { cn } from "~/lib/utils";

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
  environmentId: EnvironmentId;
  /** Lets the review dialog show an image the agent is about to send. */
  threadId?: ThreadId | undefined;
  isResponding: boolean;
  onRespondToApproval: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
  className?: string;
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
  const Detail = approval.requestKind === "mcp-elicitation" ? "span" : "code";
  const fallbackLabel =
    approval.requestKind === "mcp-elicitation"
      ? "App access approval"
      : approval.requestKind === "integration"
        ? "Integration approval"
        : approval.requestKind === "command"
          ? "Command approval"
          : approval.requestKind === "file-read"
            ? "File read approval"
            : approval.requestKind === "permission"
              ? "App permission approval"
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
            : approval.requestKind === "permission"
              ? "Permission request"
              : "File change";
  const header = (
    <span className="flex w-full min-w-0 items-center gap-2 text-2xs text-muted-foreground">
      <span className="shrink-0 font-medium text-warning">{fallbackLabel}</span>
      {approval.appName ? <span className="min-w-0 truncate">{approval.appName}</span> : null}
      {approval.fullAccessOverride ? (
        <Popover>
          <PopoverTrigger openOnHover render={<InlineButton tone="muted" />}>
            {FULL_ACCESS_OVERRIDE_QUESTION}
          </PopoverTrigger>
          <PopoverPopup
            {...composerFloatingLayerProps}
            aria-label={FULL_ACCESS_OVERRIDE_QUESTION}
            tooltipStyle
            side="top"
            className="max-w-[min(22rem,calc(100vw-2rem))] whitespace-normal"
          >
            {fullAccessOverrideExplanation(approval.fullAccessOverride)}
          </PopoverPopup>
        </Popover>
      ) : null}
      {pendingCount > 1 ? (
        <span className="ml-auto shrink-0 tabular-nums">1/{pendingCount}</span>
      ) : null}
    </span>
  );

  if (approval.requestKind === "integration") {
    const { headline, preview, record, fields } = integrationApprovalView(approval, fallbackLabel);
    return (
      <span
        aria-label={fallbackLabel}
        className={cn("flex min-w-0 flex-1 flex-col items-start gap-1", className)}
        role="group"
      >
        {header}
        <span className="flex w-full min-w-0 items-center gap-2">
          <span
            aria-label={detailAriaLabel}
            className="flex min-w-0 flex-1 items-baseline gap-1.5 text-xs"
            data-approval-detail="summary"
          >
            <span className="shrink-0 font-medium text-foreground">{headline}</span>
            {preview ? (
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{preview}</span>
            ) : null}
          </span>
          <Button
            type="button"
            size="micro"
            variant="ghost-muted"
            className="shrink-0"
            data-approval-review="open"
            onClick={() => setReviewOpen(true)}
          >
            Review
          </Button>
        </span>
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
          isResponding={isResponding || approval.responseCapability !== "live"}
          onRespondToApproval={onRespondToApproval}
        />
      </span>
    );
  }

  return (
    <span
      aria-label={fallbackLabel}
      className={cn("flex min-w-0 flex-1 flex-col items-start gap-1", className)}
      role="group"
    >
      {header}
      <Detail
        aria-label={detailAriaLabel}
        className={cn(
          "block w-full min-w-0 overflow-auto text-xs text-foreground [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 [&::-webkit-scrollbar]:h-1.5",
          approval.requestKind === "mcp-elicitation"
            ? "max-h-20 whitespace-pre-wrap font-sans wrap-break-word"
            : "max-h-40 whitespace-pre-wrap font-mono wrap-anywhere",
        )}
        data-approval-detail="complete"
        tabIndex={0}
      >
        {approval.responseCapability === "not_resumable"
          ? "Provider process is gone. Interrupt or restart the run to respond."
          : approval.detail || fallbackLabel}
      </Detail>
      {approval.reason ? (
        <span className="w-full min-w-0 text-2xs text-muted-foreground wrap-break-word">
          {approval.reason}
        </span>
      ) : null}
    </span>
  );
});
