import { assistantThreadKind, type EnvironmentId, type ThreadId } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { developerAssistant } from "~/state/developerAssistant";
import { useEnvironmentQuery } from "~/state/query";

import { blockingCount, buildInbox, threadHasOpenQuestion } from "./assistantBoard.logic";
import { THREAD_KIND } from "./threadKinds";

/**
 * Whether one of the developer assistant's threads asked the person something
 * that is still open. Those questions live on the assistant board, not the
 * thread, so only assistant threads read it (one shared subscription).
 */
export function useAssistantThreadAsksYou(input: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  live: boolean;
}): boolean {
  const kind = assistantThreadKind(input.threadId);
  const board = useEnvironmentQuery(
    input.live && kind !== null && kind !== "setup"
      ? developerAssistant.board({ environmentId: input.environmentId, input: {} })
      : null,
  );
  return threadHasOpenQuestion(board.data, input.threadId);
}

/** What an assistant thread does, for a thread list row. Nothing for other threads. */
export function AssistantThreadTag({
  threadId,
  iconOnly = false,
  className,
}: {
  threadId: ThreadId;
  iconOnly?: boolean;
  className?: string;
}) {
  const kind = assistantThreadKind(threadId);
  if (kind === null) return null;
  const { icon: Icon, label, className: tint } = THREAD_KIND[kind];
  return (
    <span
      role="img"
      aria-label={kind === "coordinator" ? "Developer assistant" : `Assistant ${label}`}
      className={cn("inline-flex shrink-0 items-center gap-1 text-xs", tint, className)}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      {iconOnly ? null : <span className="font-medium">{label}</span>}
    </span>
  );
}

/**
 * How many things hold an assistant still until the person acts, on the
 * server the assistant page opens by default.
 */
export function useAssistantBlockingCount(environmentId: EnvironmentId | null): number {
  const board = useEnvironmentQuery(
    environmentId ? developerAssistant.board({ environmentId, input: {} }) : null,
  );
  return board.data ? blockingCount(buildInbox(board.data)) : 0;
}
