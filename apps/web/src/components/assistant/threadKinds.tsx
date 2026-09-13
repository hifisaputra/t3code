import type { AssistantThreadKind } from "@t3tools/contracts";
import { BotIcon, CodeXmlIcon, MonitorCheckIcon, ScanEyeIcon, Settings2Icon } from "lucide-react";

import { cn } from "~/lib/utils";

/**
 * One name, icon and colour per kind of assistant thread, shared by the board
 * and the sidebar so a thread reads the same wherever it shows up.
 */
export const THREAD_KIND: Record<
  AssistantThreadKind,
  {
    readonly label: string;
    readonly icon: typeof BotIcon;
    readonly className: string;
    readonly does: string;
  }
> = {
  coordinator: {
    label: "Assistant",
    icon: BotIcon,
    className: "text-violet-600 dark:text-violet-300",
    does: "The developer assistant. Picks issues, starts and routes the threads below, and talks to you. Answer any question here.",
  },
  implement: {
    label: "Worker",
    icon: CodeXmlIcon,
    className: "text-sky-600 dark:text-sky-400",
    does: "Writes the code in the issue's worktree, opens the PR, and merges it once code review approves.",
  },
  review: {
    label: "Code review",
    icon: ScanEyeIcon,
    className: "text-amber-700 dark:text-amber-300",
    does: "Reviews each commit the worker pushes. Nothing merges without its approval.",
  },
  e2e: {
    label: "E2E test",
    icon: MonitorCheckIcon,
    className: "text-emerald-700 dark:text-emerald-300",
    does: "Tests the deployed change on staging like a person would and takes screenshots.",
  },
  setup: {
    label: "Setup",
    icon: Settings2Icon,
    className: "text-muted-foreground",
    does: "The conversation that sets up the assistant for a project.",
  },
};

export function ThreadKindIcon({
  kind,
  className,
}: {
  kind: AssistantThreadKind;
  className?: string;
}) {
  const { icon: Icon, className: tint } = THREAD_KIND[kind];
  return <Icon aria-hidden className={cn("size-3.5 shrink-0", tint, className)} />;
}
