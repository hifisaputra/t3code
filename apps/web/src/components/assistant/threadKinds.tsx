import type { AssistantThreadKind, AssistantTaskTrack } from "@t3tools/contracts";
import {
  BotIcon,
  CodeXmlIcon,
  FlagIcon,
  MonitorCheckIcon,
  ScanEyeIcon,
  Settings2Icon,
} from "lucide-react";

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
  lead: {
    label: "Team leader",
    icon: FlagIcon,
    className: "text-rose-600 dark:text-rose-300",
    does: "Leads one issue: decides whether the team takes it, briefs the worker, checks staging, starts the e2e test, and decides what happens when something fails.",
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
    does: "Tests the change like a person would, in the team's worktree or on staging, and takes screenshots.",
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

export function threadKind(kind: AssistantThreadKind, track?: AssistantTaskTrack) {
  const base = THREAD_KIND[kind];
  if (track !== "research") return base;
  if (kind === "implement") return { ...base, does: "Researches on the public web." };
  if (kind === "review") return { ...base, label: "Fact check", does: "Fact-checks the report." };
  if (kind === "lead")
    return {
      ...base,
      does: "Scopes the research, briefs the worker, and coordinates the fact check.",
    };
  return base;
}

export function ResearchBadge({ track }: { track?: AssistantTaskTrack | undefined }) {
  return track === "research" ? (
    <span className="shrink-0 rounded border border-info/25 bg-info/5 px-1.5 py-0.5 text-[10px] font-medium text-info-foreground">
      Research
    </span>
  ) : null;
}
