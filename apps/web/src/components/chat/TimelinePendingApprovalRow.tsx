import {
  FULL_ACCESS_OVERRIDE_QUESTION,
  fullAccessOverrideExplanation,
} from "@t3tools/client-runtime/state/thread-requests";
import { ShieldIcon } from "lucide-react";
import { memo, use, useState, type ComponentProps } from "react";
import { type PendingApproval } from "../../session-logic";
import { Button, InlineButton } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  ComposerPendingApprovalActions,
  DEFAULT_APPROVAL_OPTIONS,
} from "./ComposerPendingApprovalActions";
import { integrationApprovalView } from "./ComposerPendingApprovalPanel.logic";
import { IntegrationApprovalDialog } from "./IntegrationApprovalDialog";
import { ToolActivityIconView, type WorkEntryIconName } from "./TimelineToolActivityIcon";
import { TimelineRowCtx } from "./timelineRowContext";
import { WorkLogRow } from "./WorkLog";

const APPROVAL_PRESENTATION = {
  command: { icon: "terminal", label: "Command approval", detailLabel: "Command" },
  "file-change": { icon: "square-pen", label: "File change approval", detailLabel: "File change" },
  "file-read": { icon: "eye", label: "File read approval", detailLabel: "File to read" },
  permission: {
    icon: "wrench",
    label: "App permission approval",
    detailLabel: "Permission request",
  },
  "mcp-elicitation": {
    icon: "hammer",
    label: "App access approval",
    detailLabel: "App access request",
  },
  integration: { icon: "globe", label: "Integration approval", detailLabel: "Requested change" },
} satisfies Record<
  PendingApproval["requestKind"],
  { icon: WorkEntryIconName; label: string; detailLabel: string }
>;

export const TimelinePendingApprovalRow = memo(function TimelinePendingApprovalRow({
  approval,
}: {
  approval: PendingApproval;
}) {
  const { respondingRequestIds, canOperateThread, onRespondToApproval } = use(TimelineRowCtx);
  const presentation = APPROVAL_PRESENTATION[approval.requestKind];
  const canRespond = approval.responseCapability === "live";
  const integration =
    approval.requestKind === "integration"
      ? integrationApprovalView(approval, presentation.label)
      : null;
  return (
    <WorkLogRow
      role="group"
      aria-label={presentation.label}
      data-v2-item-type="approval_request"
      wrapLabel
      icon={
        <ToolActivityIconView
          icon={undefined}
          fallbackName={presentation.icon}
          className="block size-4 shrink-0 stroke-2 text-icon-muted"
          muted
        />
      }
      label={
        integration ? (
          <span
            aria-label={presentation.detailLabel}
            className="flex min-w-0 items-baseline gap-1.5 text-xs"
            data-approval-detail="summary"
          >
            <span className="shrink-0 font-medium text-foreground">{integration.headline}</span>
            {integration.preview ? (
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {integration.preview}
              </span>
            ) : null}
          </span>
        ) : (
          <code
            aria-label={presentation.detailLabel}
            className="block max-h-40 min-w-0 overflow-auto whitespace-pre-wrap font-mono text-xs leading-5 text-foreground select-text! wrap-anywhere [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
            data-approval-detail="complete"
            tabIndex={0}
          >
            {approval.detail || presentation.label}
          </code>
        )
      }
    >
      <div className="ms-7.5 flex min-w-0 flex-col gap-1 pb-1 text-xs">
        {approval.appName ? (
          <span className="text-muted-foreground wrap-anywhere">{approval.appName}</span>
        ) : null}
        {approval.reason ? (
          <span className="text-muted-foreground select-text wrap-anywhere">{approval.reason}</span>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {canRespond ? (
            <>
              <span className="inline-flex items-center gap-1 text-warning">
                <ShieldIcon aria-hidden className="size-3 shrink-0" />
                Waiting for approval
              </span>
              {onRespondToApproval ? (
                <>
                  <span aria-hidden className="text-muted-foreground">
                    ·
                  </span>
                  <ComposerPendingApprovalActions
                    presentation="inline"
                    requestId={approval.requestId}
                    disabled={!canOperateThread}
                    isResponding={respondingRequestIds.includes(approval.requestId)}
                    canRespond={canRespond}
                    options={approval.options}
                    onRespondToApproval={onRespondToApproval}
                  />
                  {integration ? (
                    <IntegrationApprovalReview
                      approval={approval}
                      view={integration}
                      isResponding={respondingRequestIds.includes(approval.requestId)}
                      onRespondToApproval={onRespondToApproval}
                    />
                  ) : null}
                </>
              ) : null}
            </>
          ) : (
            <span className="text-warning">
              Provider process is gone. Interrupt or restart the run to respond.
            </span>
          )}
          {approval.fullAccessOverride ? (
            <Popover>
              <PopoverTrigger openOnHover render={<InlineButton tone="muted" />}>
                {FULL_ACCESS_OVERRIDE_QUESTION}
              </PopoverTrigger>
              <PopoverPopup
                aria-label={FULL_ACCESS_OVERRIDE_QUESTION}
                tooltipStyle
                side="top"
                className="max-w-[min(22rem,calc(100vw-2rem))] whitespace-normal"
              >
                {fullAccessOverrideExplanation(approval.fullAccessOverride)}
              </PopoverPopup>
            </Popover>
          ) : null}
        </div>
      </div>
    </WorkLogRow>
  );
});

/** Opens the full record and field-by-field change an integration write would make. */
function IntegrationApprovalReview({
  approval,
  view,
  isResponding,
  onRespondToApproval,
}: {
  approval: PendingApproval;
  view: ReturnType<typeof integrationApprovalView>;
  isResponding: boolean;
  onRespondToApproval: NonNullable<
    ComponentProps<typeof IntegrationApprovalDialog>["onRespondToApproval"]
  >;
}) {
  const { threadRef, activeThreadEnvironmentId } = use(TimelineRowCtx);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        size="micro"
        variant="ghost-muted"
        data-approval-review="open"
        onClick={() => setOpen(true)}
      >
        Review
      </Button>
      <IntegrationApprovalDialog
        open={open}
        onOpenChange={setOpen}
        requestId={approval.requestId}
        appName={approval.appName}
        headline={view.headline}
        record={view.record}
        fields={view.fields}
        environmentId={threadRef?.environmentId ?? activeThreadEnvironmentId}
        threadId={threadRef?.threadId}
        options={approval.options ?? DEFAULT_APPROVAL_OPTIONS}
        isResponding={isResponding || approval.responseCapability !== "live"}
        onRespondToApproval={onRespondToApproval}
      />
    </>
  );
}
