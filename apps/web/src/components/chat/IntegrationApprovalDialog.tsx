import type {
  ApprovalRequestId,
  EnvironmentId,
  IntegrationApprovalChangeField,
  ProviderApprovalDecision,
  ProviderApprovalOption,
  ThreadId,
} from "@t3tools/contracts";
import { ExternalLinkIcon } from "lucide-react";
import { memo } from "react";

import ChatMarkdown, { ChatMarkdownAssetImage } from "../ChatMarkdown";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { ScrollArea } from "../ui/scroll-area";

interface IntegrationApprovalDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly requestId: ApprovalRequestId;
  readonly appName: string | undefined;
  readonly headline: string;
  readonly record: { readonly label: string; readonly url?: string | undefined } | undefined;
  readonly fields: ReadonlyArray<IntegrationApprovalChangeField>;
  readonly environmentId: EnvironmentId;
  /** The thread the write comes from; image fields resolve against its workspace. */
  readonly threadId: ThreadId | undefined;
  readonly options: ReadonlyArray<ProviderApprovalOption>;
  readonly isResponding: boolean;
  readonly onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

/**
 * The whole write an integration is asking to make, before it is approved.
 *
 * The row above the composer is one line and cannot be more than a summary, so
 * anything the agent wrote at length — a comment, a description that replaces
 * the one already on the issue — is only readable here. It is rendered as
 * markdown, the way the record will show it, rather than as a quoted blob:
 * approving a comment means approving how it reads.
 *
 * The decision lives in the footer for the same reason. Sending someone back
 * to the composer row to approve what they just read is a step that only
 * exists to lose the reading.
 */
export const IntegrationApprovalDialog = memo(function IntegrationApprovalDialog({
  open,
  onOpenChange,
  requestId,
  appName,
  headline,
  record,
  fields,
  environmentId,
  threadId,
  options,
  isResponding,
  onRespondToApproval,
}: IntegrationApprovalDialogProps) {
  const respond = (decision: ProviderApprovalDecision) => {
    void onRespondToApproval(requestId, decision);
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader className="pb-3">
          <DialogTitle className="truncate">{headline}</DialogTitle>
          <DialogDescription className="flex min-w-0 items-center gap-1.5">
            <span className="truncate">
              {appName ? `${appName} is asking to make this change.` : "Review this change."}
            </span>
            {record?.url ? (
              <a
                href={record.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex shrink-0 items-center gap-1 underline underline-offset-2"
              >
                {record.label}
                <ExternalLinkIcon className="size-3" />
              </a>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea scrollFade className="min-h-0 flex-1 border-border/60 border-t">
          <div className="grid gap-4 px-6 py-4">
            {fields.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                This change carries no details to review.
              </p>
            ) : (
              fields.map((field) => (
                <div key={`${field.label}:${field.value}`} className="grid min-w-0 gap-1.5">
                  <span className="font-medium text-muted-foreground text-xs">{field.label}</span>
                  {field.format === "markdown" ? (
                    <ChatMarkdown
                      text={field.value}
                      cwd={undefined}
                      environmentId={environmentId}
                      className="text-sm"
                    />
                  ) : (
                    <p className="min-w-0 text-sm break-words whitespace-pre-wrap">{field.value}</p>
                  )}
                  {field.format === "image" && threadId !== undefined ? (
                    // The bytes have not left the machine yet, so the picture
                    // comes from the thread's workspace, the same root the
                    // server read the path against.
                    <ChatMarkdownAssetImage
                      environmentId={environmentId}
                      resource={{ _tag: "workspace-file", threadId, path: field.value }}
                      alt={field.value}
                      standalone
                      maxHeightRem={20}
                    />
                  ) : null}
                </div>
              ))
            )}
          </div>
        </ScrollArea>

        <DialogFooter className="items-center">
          <p className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
            Nothing is sent until you approve.
          </p>
          {options.map((option) => (
            <Button
              key={option.decision}
              type="button"
              size="sm"
              variant={
                option.decision === "accept"
                  ? "default"
                  : option.decision === "decline"
                    ? "outline"
                    : "ghost"
              }
              className={option.decision === "decline" ? "text-destructive" : undefined}
              disabled={isResponding}
              aria-description={option.warning}
              onClick={() => respond(option.decision)}
            >
              {option.label}
            </Button>
          ))}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
});
