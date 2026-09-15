/**
 * Project history: what was worked on each day, and how long each thread took.
 *
 * One project at a time, read from that project's own environment. The page
 * owns selection and window arithmetic; everything it renders comes out of
 * `historyPage.logic` or straight off the contract.
 *
 * @module components/history/HistoryPage
 */
import { useAtomValue } from "@effect/atom-react";
import type { ProjectHistoryInput } from "@t3tools/contracts";
import { enumerateDays, formatDayShort } from "@t3tools/shared/usageFormat";
import { useMemo, useState } from "react";

import { isElectron } from "../../env";
import { useClientSettings } from "../../hooks/useSettings";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { cn } from "../../lib/utils";
import { useProjects } from "../../state/entities";
import { useProjectHistory } from "../../state/history";
import { environmentPresentations } from "../../state/presentation";
import { resolveTimestampLocale } from "../../timestampFormat";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { HistoryTimeline } from "./HistoryTimeline";
import {
  buildDayBars,
  buildProjectOptions,
  formatDurationMs,
  makeHistoryWindow,
  type HistoryDayBar,
  resolveSelectedProject,
  summarizeHistory,
} from "./historyPage.logic";
import {
  readHistoryPagePreferences,
  saveHistoryPagePreferences,
  type HistoryPagePreferences,
} from "./historyPagePreferences";

const WINDOW_OPTIONS = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
] as const;

function isHistoryWindowDays(value: number): value is HistoryPagePreferences["windowDays"] {
  return WINDOW_OPTIONS.some((option) => option.days === value);
}

export interface HistoryPageProps {
  readonly environmentParam: string | null;
  readonly projectParam: string | null;
  readonly onScopeChange: (environmentId: string | null, projectId: string | null) => void;
}

export function HistoryPage({ environmentParam, projectParam, onScopeChange }: HistoryPageProps) {
  const [windowDays, setWindowDays] = useState<HistoryPagePreferences["windowDays"]>(
    () => readHistoryPagePreferences().windowDays,
  );
  const historyWindow = useMemo(() => makeHistoryWindow(windowDays), [windowDays]);

  const projects = useProjects();
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const environmentLabels = useMemo(
    () =>
      new Map(
        Array.from(presentations, ([environmentId, presentation]) => [
          environmentId,
          presentation.entry.target.label,
        ]),
      ),
    [presentations],
  );
  const options = useMemo(
    () => buildProjectOptions(projects, environmentLabels),
    [environmentLabels, projects],
  );

  // The project behind the active thread or draft, so opening History from a
  // conversation lands on the project that conversation belongs to.
  const { activeDraftThread, activeThread } = useHandleNewThread();
  const activeThreadTarget = activeThread ?? activeDraftThread;
  const activeProject = useMemo(
    () =>
      activeThreadTarget
        ? {
            environmentId: activeThreadTarget.environmentId,
            projectId: activeThreadTarget.projectId,
          }
        : null,
    [activeThreadTarget],
  );

  const selected = useMemo(
    () =>
      resolveSelectedProject(
        options,
        { environmentId: environmentParam, projectId: projectParam },
        activeProject,
      ),
    [activeProject, environmentParam, options, projectParam],
  );

  const target = useMemo(() => {
    if (selected === null) return null;
    const input: ProjectHistoryInput = {
      projectId: selected.project.id,
      sinceDay: historyWindow.sinceDay,
      untilDay: historyWindow.untilDay,
      timeZone: historyWindow.timeZone,
    };
    return { environmentId: selected.environmentId, input };
  }, [historyWindow, selected]);

  const { history, isPending, error, refresh } = useProjectHistory(target);

  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const locale = useMemo(
    () => resolveTimestampLocale(globalThis.window?.desktopBridge?.getSystemLocale?.() ?? null),
    [],
  );

  const days = useMemo(
    () => enumerateDays(historyWindow.sinceDay, historyWindow.untilDay),
    [historyWindow.sinceDay, historyWindow.untilDay],
  );
  const bars = useMemo(
    () => buildDayBars(days, history, historyWindow.untilDay),
    [days, history, historyWindow.untilDay],
  );
  const summary = useMemo(() => summarizeHistory(history), [history]);
  const lifetimeByThread = useMemo(
    () => new Map((history?.threads ?? []).map((totals) => [totals.threadId, totals])),
    [history],
  );

  const selectWindow = (value: number) => {
    if (!isHistoryWindowDays(value)) return;
    setWindowDays(value);
    saveHistoryPagePreferences({ windowDays: value });
  };

  const windowLabel = `${formatDayShort(historyWindow.sinceDay)} to ${formatDayShort(historyWindow.untilDay)}`;
  const showSkeleton = isPending && history === null;

  const topbarContent = (
    <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 py-2 xl:flex">
      <WorkspaceBreadcrumb ariaLabel="History breadcrumb" className="col-span-2 min-w-0">
        <WorkspaceBreadcrumbItem>
          <h1>History</h1>
        </WorkspaceBreadcrumbItem>
        <WorkspaceBreadcrumbSeparator />
        <WorkspaceBreadcrumbItem current className="min-w-10">
          <Select
            disabled={options.length === 0}
            value={selected?.key ?? ""}
            onValueChange={(value) => {
              const option = options.find((candidate) => candidate.key === value);
              if (option) onScopeChange(option.environmentId, option.projectId);
            }}
          >
            <SelectTrigger
              aria-label="History project"
              size="compact"
              variant="ghost"
              className="w-auto min-w-0"
            >
              <SelectValue>{selected?.label ?? "No project"}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="start" alignItemWithTrigger={false}>
              {options.map((option) => (
                <SelectItem key={option.key} value={option.key}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
      <span className="hidden min-w-0 truncate text-xs text-muted-foreground 2xl:block">
        {windowLabel}
      </span>
      <div className="col-span-2 ms-auto flex min-w-0 items-center justify-end gap-2">
        <ToggleGroup
          aria-label="History period"
          variant="segmented"
          value={[String(windowDays)]}
          onValueChange={(next) => {
            const value = next[0];
            if (value) selectWindow(Number(value));
          }}
        >
          {WINDOW_OPTIONS.map((option) => (
            <Toggle key={option.days} value={String(option.days)}>
              {option.label}
            </Toggle>
          ))}
        </ToggleGroup>
      </div>
    </div>
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron} className="h-auto">
          {topbarContent}
        </WorkspacePageHeader>

        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">
            {error === null ? null : (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-foreground">
                <span>{error}</span>
                <Button onClick={refresh} size="sm" variant="outline">
                  Retry
                </Button>
              </div>
            )}

            {/* A failure with nothing cached renders only the row above, which
                already says what went wrong and offers the retry. */}
            {selected === null ? (
              <p className="text-sm text-muted-foreground">
                {projects.length === 0
                  ? "Connect an environment to see project history."
                  : "Select a project to see its history."}
              </p>
            ) : showSkeleton ? (
              <HistorySkeleton />
            ) : error !== null && history === null ? null : (
              <>
                <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <HistoryStat label="Active time" value={formatDurationMs(summary.activeMs)} />
                  <HistoryStat label="Days active" value={String(summary.activeDays)} />
                  <HistoryStat label="Threads" value={String(summary.threads)} />
                  <HistoryStat label="Turns" value={String(summary.turns)} />
                </section>

                <section className="flex min-w-0 flex-col gap-2">
                  <h2 className="text-sm font-medium text-foreground">Activity</h2>
                  <div className="flex h-20 min-w-0 items-end gap-px">
                    {bars.map((bar) => (
                      <HistoryDayBarColumn key={bar.day} bar={bar} />
                    ))}
                  </div>
                  <div className="flex items-center justify-between text-[10px] text-muted-foreground tabular-nums">
                    <span>{formatDayShort(historyWindow.sinceDay)}</span>
                    <span>{formatDayShort(historyWindow.untilDay)}</span>
                  </div>
                </section>

                {history === null || history.days.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No turns in this window for {selected.project.title}.
                  </p>
                ) : (
                  <HistoryTimeline
                    days={history.days}
                    environmentId={selected.environmentId}
                    lifetimeByThread={lifetimeByThread}
                    locale={locale}
                    timestampFormat={timestampFormat}
                    timeZone={history.timeZone}
                  />
                )}
              </>
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

/** One day of the window chart. Quiet days keep their column so the axis stays even. */
function HistoryDayBarColumn({ bar }: { readonly bar: HistoryDayBar }) {
  const durationLabel = bar.activeMs === 0 ? "no activity" : formatDurationMs(bar.activeMs);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            aria-label={`${formatDayShort(bar.day)}, ${durationLabel}`}
            className="flex h-full min-w-0 flex-1 items-end rounded-sm outline-hidden ring-ring focus-visible:ring-2"
            role="img"
            tabIndex={0}
          >
            <div
              className={cn(
                "w-full rounded-t-[2px]",
                bar.heightPercent === 0 ? "bg-muted" : bar.isToday ? "bg-primary" : "bg-primary/60",
              )}
              style={{ height: `${Math.max(bar.heightPercent, 2)}%` }}
            />
          </div>
        }
      />
      <TooltipPopup side="top">
        {formatDayShort(bar.day)} · {durationLabel}
      </TooltipPopup>
    </Tooltip>
  );
}

function HistoryStat({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-md border border-border px-3 py-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="truncate text-base font-medium text-foreground tabular-nums">{value}</span>
    </div>
  );
}

function HistorySkeleton() {
  return (
    <>
      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {["Active time", "Days active", "Threads", "Turns"].map((label) => (
          <div
            key={label}
            className="flex flex-col gap-1 rounded-md border border-border px-3 py-2"
          >
            <span className="text-xs text-muted-foreground">{label}</span>
            <Skeleton className="h-5 w-16" />
          </div>
        ))}
      </section>
      <Skeleton className="h-20 w-full" />
      {[0, 1, 2].map((section) => (
        <section key={section} className="flex flex-col gap-3">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </section>
      ))}
    </>
  );
}
