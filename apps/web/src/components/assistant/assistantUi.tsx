import type {
  EnvironmentId,
  LinearIssueSummary,
  ModelSelection,
  OrchestrationThreadShell,
  ServerProvider,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { ChevronDownIcon, ExternalLinkIcon } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { cn } from "~/lib/utils";

import ChatMarkdown from "../ChatMarkdown";
import { useOpenIssueLink } from "../ThreadStatusIndicators";
import { toastManager } from "../ui/toast";
import { isLongText } from "./assistantBoard.logic";

export type StatusTone =
  | "active"
  | "idle"
  | "waiting"
  | "paused"
  | "attention"
  | "blocked"
  | "done";

const TONE_DOT: Record<StatusTone, string> = {
  active: "bg-success",
  idle: "bg-success/60",
  waiting: "bg-info",
  paused: "bg-muted-foreground/50",
  attention: "bg-warning",
  blocked: "bg-destructive",
  done: "bg-muted-foreground/40",
};

/**
 * A status colour. `pulse` marks work that is running right now, with the same
 * stepped pulse the sidebar uses for working threads.
 */
export function StatusDot({
  tone,
  pulse = false,
  className,
}: {
  tone: StatusTone;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-2 shrink-0 rounded-full",
        TONE_DOT[tone],
        pulse && "motion-safe:animate-status-pulse",
        className,
      )}
    />
  );
}

export function SectionHeading({
  children,
  count,
  action,
}: {
  children: ReactNode;
  count?: number;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-7 items-center gap-2">
      <h2 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {children}
      </h2>
      {count !== undefined && count > 0 ? (
        <span className="rounded-full bg-muted px-1.5 font-medium text-[11px] text-muted-foreground tabular-nums">
          {count}
        </span>
      ) : null}
      {action ? <div className="ml-auto">{action}</div> : null}
    </div>
  );
}

/**
 * Agent-written markdown, clipped when long so one message cannot push the
 * rest of the board off screen.
 */
export function ExpandableMarkdown({
  text,
  environmentId,
  cwd,
  className,
  collapsedClassName = "max-h-56",
}: {
  text: string;
  environmentId: EnvironmentId;
  cwd?: string | undefined;
  className?: string;
  collapsedClassName?: string;
}) {
  const long = isLongText(text);
  const [expanded, setExpanded] = useState(false);
  const clipped = long && !expanded;
  return (
    <div className={className}>
      <div
        className={cn(
          "relative",
          clipped &&
            cn(
              "overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]",
              collapsedClassName,
            ),
        )}
      >
        <ChatMarkdown
          text={text}
          cwd={cwd}
          environmentId={environmentId}
          className="text-sm [&_p]:leading-relaxed"
        />
      </div>
      {long ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="mt-1 inline-flex items-center gap-1 rounded-sm font-medium text-muted-foreground text-xs hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <ChevronDownIcon
            aria-hidden
            className={cn("size-3.5 transition-transform", expanded && "rotate-180")}
          />
          {expanded ? "Show less" : "Show all"}
        </button>
      ) : null}
    </div>
  );
}

/** The issue's identifier, opening it in Linear. */
export function IssueLink({
  issue,
  className,
}: {
  issue: Pick<LinearIssueSummary, "identifier" | "url">;
  className?: string;
}) {
  const openIssueLink = useOpenIssueLink();
  return (
    <a
      href={issue.url}
      onClick={(event) => openIssueLink(event, issue.url)}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 font-mono text-muted-foreground text-xs underline-offset-2 hover:text-foreground hover:underline",
        className,
      )}
    >
      {issue.identifier}
      <ExternalLinkIcon aria-hidden className="size-3" />
    </a>
  );
}

export function modelLabel(
  providers: ReadonlyArray<ServerProvider>,
  selection: ModelSelection,
): string {
  const provider = providers.find((p) => p.instanceId === selection.instanceId);
  const model = provider?.models.find((m) => m.slug === selection.model);
  return model?.shortName ?? model?.name ?? selection.model;
}

export function urlHost(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

export const runtimeModeLabel = (mode: string) =>
  mode === "full-access" ? "Full access" : "Asks before commands";

/** Whether a thread is mid-turn or holding a request, so its state is still moving. */
export function threadIsBusy(
  shell: Pick<OrchestrationThreadShell, "session" | "latestTurn" | "backgroundLiveness"> | null,
): boolean {
  return (
    shell?.session?.status === "running" ||
    shell?.session?.status === "starting" ||
    shell?.latestTurn?.state === "running" ||
    shell?.backgroundLiveness === "working"
  );
}

/** The themed confirmation, falling back to the browser's when no host is mounted. */
export async function confirmDestructive(message: string): Promise<boolean> {
  return (
    (await requestConfirmDialog(message, { variant: "destructive" })) ??
    window.confirm(message.split("\n")[0])
  );
}

function failureMessage(result: {
  readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"];
}) {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs a board command with its own pending state, so one card's request does
 * not freeze every other button on the page, and reports failures where the
 * person is looking.
 */
export function useAssistantAction() {
  const [pending, setPending] = useState<string | null>(null);
  const run = useCallback(
    async (
      key: string,
      action: () => Promise<AtomCommandResult<unknown, unknown>>,
      messages: { failure: string; success?: string },
    ): Promise<boolean> => {
      setPending(key);
      try {
        const result = await action();
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result))
            toastManager.add({
              type: "error",
              title: messages.failure,
              description: failureMessage(result),
            });
          return false;
        }
        if (messages.success) toastManager.add({ type: "success", title: messages.success });
        return result._tag === "Success";
      } finally {
        setPending(null);
      }
    },
    [],
  );
  return { pending, run };
}
