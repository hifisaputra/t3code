/**
 * Pure helpers behind the History page: window arithmetic, duration and day
 * labels, and the geometry the day chart and the 24-hour strip render with.
 *
 * Everything here is deliberately free of React and of atom state so the
 * timeline rows stay cheap to render and the maths stays testable.
 *
 * @module components/history/historyPage.logic
 */
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectHistory, ProjectHistoryInterval } from "@t3tools/contracts";
import { HistoryDay } from "@t3tools/contracts";
import { makeWindow } from "@t3tools/shared/usageFormat";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export interface HistoryWindow {
  readonly sinceDay: HistoryDay;
  readonly untilDay: HistoryDay;
  readonly timeZone: string;
}

/**
 * The inclusive `days`-long window ending today, in the viewer's zone.
 *
 * Reuses the usage window so both pages agree on what "the last 30 days" means
 * around a daylight-saving transition; only the three fields history cares
 * about survive.
 */
export function makeHistoryWindow(days: number, now?: Date): HistoryWindow {
  const window = now === undefined ? makeWindow(days) : makeWindow(days, now);
  return {
    sinceDay: HistoryDay.make(window.sinceDay),
    untilDay: HistoryDay.make(window.untilDay),
    timeZone: window.timeZone,
  };
}

/**
 * Agent working time, rounded down to the unit that reads naturally at that
 * scale. Anything shorter than a minute is noise, so it is named rather than
 * printed as `0m`.
 */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < MINUTE_MS) return "under a minute";

  if (ms < HOUR_MS) return `${Math.floor(ms / MINUTE_MS)}m`;

  if (ms < DAY_MS) {
    const hours = Math.floor(ms / HOUR_MS);
    const minutes = Math.floor((ms - hours * HOUR_MS) / MINUTE_MS);
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  }

  const days = Math.floor(ms / DAY_MS);
  const hours = Math.floor((ms - days * DAY_MS) / HOUR_MS);
  return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
}

const zoneFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getZoneFormatter(timeZone: string): Intl.DateTimeFormat | null {
  const cached = zoneFormatterCache.get(timeZone);
  if (cached) return cached;
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    zoneFormatterCache.set(timeZone, formatter);
    return formatter;
  } catch {
    // An unknown zone degrades to UTC rather than blanking the timeline.
    return null;
  }
}

/** How far the zone's wall clock runs ahead of UTC at an instant, in ms. */
function zoneOffsetMs(instantMs: number, timeZone: string): number {
  const formatter = getZoneFormatter(timeZone);
  if (formatter === null) return 0;
  const parts = formatter.formatToParts(new Date(instantMs));
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  const asUtc = Date.UTC(
    read("year"),
    read("month") - 1,
    read("day"),
    read("hour"),
    read("minute"),
    read("second"),
  );
  return asUtc - instantMs;
}

/** Epoch ms of midnight starting `day` in `timeZone`, or null for a malformed day. */
export function dayStartMs(day: string, timeZone: string): number | null {
  const [year, month, dayOfMonth] = day.split("-").map((part) => Number(part));
  if (
    year === undefined ||
    month === undefined ||
    dayOfMonth === undefined ||
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(dayOfMonth)
  ) {
    return null;
  }
  const wallClockMs = Date.UTC(year, month - 1, dayOfMonth);
  // One correction pass is enough: the guess is at most an offset away, and a
  // transition never moves the clock by more than the offset itself.
  const guess = wallClockMs - zoneOffsetMs(wallClockMs, timeZone);
  const corrected = wallClockMs - zoneOffsetMs(guess, timeZone);
  return corrected;
}

export interface DayBounds {
  readonly startMs: number;
  /** Exclusive: the next day's midnight, so DST days are 23 or 25 hours long. */
  readonly endMs: number;
}

export function dayBoundsMs(day: string, timeZone: string): DayBounds | null {
  const startMs = dayStartMs(day, timeZone);
  if (startMs === null) return null;
  const nextDay = new Date(startMs + 36 * HOUR_MS);
  const nextDayKey = formatZonedDayKey(nextDay.getTime(), timeZone);
  const endMs =
    nextDayKey === null ? startMs + DAY_MS : (dayStartMs(nextDayKey, timeZone) ?? startMs + DAY_MS);
  return { startMs, endMs: endMs > startMs ? endMs : startMs + DAY_MS };
}

/** `YYYY-MM-DD` for an instant as seen in `timeZone`. */
export function formatZonedDayKey(instantMs: number, timeZone: string): string | null {
  const formatter = getZoneFormatter(timeZone);
  if (formatter === null) return null;
  const parts = formatter.formatToParts(new Date(instantMs));
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const year = read("year");
  const month = read("month");
  const day = read("day");
  if (!year || !month || !day) return null;
  return `${year}-${month}-${day}`;
}

export interface LaneSpan {
  /** Distance from the start of the 24-hour strip, 0-100. */
  readonly leftPercent: number;
  /** Width of the block, clamped so it cannot run past the strip. */
  readonly widthPercent: number;
}

/**
 * Where a work interval sits on one day's 24-hour strip.
 *
 * An interval that starts the evening before or runs past midnight is clipped
 * to the day being drawn, so a session appears on both days' strips rather
 * than overflowing either. Returns null when the interval does not touch the
 * day at all.
 */
export function intervalToLanePercent(
  interval: ProjectHistoryInterval,
  day: string,
  timeZone: string,
): LaneSpan | null {
  const bounds = dayBoundsMs(day, timeZone);
  if (bounds === null) return null;

  const startMs = Date.parse(interval.start);
  const endMs = Date.parse(interval.end);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return null;

  const span = bounds.endMs - bounds.startMs;
  if (span <= 0) return null;

  const earliest = Math.min(startMs, endMs);
  const latest = Math.max(startMs, endMs);
  const overlaps = latest > bounds.startMs && earliest < bounds.endMs;
  // A turn that started and finished inside the same millisecond still belongs
  // to its day; it renders at minimum width rather than disappearing.
  const instantInsideDay =
    earliest === latest && earliest >= bounds.startMs && earliest < bounds.endMs;
  if (!overlaps && !instantInsideDay) return null;

  const left = clampPercent(((earliest - bounds.startMs) / span) * 100);
  const right = clampPercent(((latest - bounds.startMs) / span) * 100);
  return { leftPercent: left, widthPercent: clampPercent(right - left) };
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

/** Hour marks drawn on the 24-hour axis. */
export const HISTORY_HOUR_TICKS = [0, 6, 12, 18, 24] as const;

/**
 * Bar height for the window chart, as a percentage of the tallest day.
 *
 * A day with any work at all gets a visible stub: the point of the chart is
 * "which days did I work", and a two-minute day rounding to nothing would lie.
 */
export const MIN_DAY_BAR_PERCENT = 8;

export function dayBarHeightPercent(activeMs: number, maxActiveMs: number): number {
  if (!Number.isFinite(activeMs) || activeMs <= 0) return 0;
  if (!Number.isFinite(maxActiveMs) || maxActiveMs <= 0) return 0;
  const share = (activeMs / maxActiveMs) * 100;
  return Math.min(100, Math.max(MIN_DAY_BAR_PERCENT, share));
}

export interface HistoryDayBar {
  readonly day: string;
  readonly activeMs: number;
  readonly turns: number;
  readonly heightPercent: number;
  readonly isToday: boolean;
}

/** One bar per calendar day in the window, quiet days included but empty. */
export function buildDayBars(
  days: readonly string[],
  history: ProjectHistory | null,
  todayKey: string,
): readonly HistoryDayBar[] {
  const byDay = new Map<string, { activeMs: number; turns: number }>();
  for (const entry of history?.days ?? []) {
    byDay.set(entry.day, { activeMs: entry.activeMs, turns: entry.turns });
  }
  let max = 0;
  for (const entry of byDay.values()) {
    if (entry.activeMs > max) max = entry.activeMs;
  }
  return days.map((day) => {
    const entry = byDay.get(day);
    const activeMs = entry?.activeMs ?? 0;
    return {
      day,
      activeMs,
      turns: entry?.turns ?? 0,
      heightPercent: dayBarHeightPercent(activeMs, max),
      isToday: day === todayKey,
    };
  });
}

export interface HistorySummary {
  readonly activeMs: number;
  readonly activeDays: number;
  readonly threads: number;
  readonly turns: number;
}

const EMPTY_SUMMARY: HistorySummary = { activeMs: 0, activeDays: 0, threads: 0, turns: 0 };

/** Window totals for the summary strip. Threads are counted once each. */
export function summarizeHistory(history: ProjectHistory | null): HistorySummary {
  if (history === null) return EMPTY_SUMMARY;
  let activeMs = 0;
  let turns = 0;
  const threadIds = new Set<string>();
  for (const day of history.days) {
    activeMs += day.activeMs;
    turns += day.turns;
    for (const thread of day.threads) threadIds.add(thread.threadId);
  }
  return { activeMs, activeDays: history.days.length, threads: threadIds.size, turns };
}

/**
 * Lane colours. Theme tokens rather than hex so the strip follows the palette,
 * and a fixed cycle so a thread keeps its colour for the whole day.
 */
const LANE_COLOR_CLASSES = [
  "bg-primary/70",
  "bg-info/70",
  "bg-success/70",
  "bg-warning/70",
  "bg-destructive/60",
  "bg-primary/40",
] as const;

export function laneColorClass(index: number): string {
  const count = LANE_COLOR_CLASSES.length;
  const slot = ((index % count) + count) % count;
  return LANE_COLOR_CLASSES[slot] ?? LANE_COLOR_CLASSES[0];
}

export interface HistoryProjectOption {
  /** Stable select value; also the search-param pair the page writes. */
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: string;
  readonly label: string;
  readonly project: EnvironmentProject;
}

export function historyProjectKey(environmentId: string, projectId: string): string {
  return `${environmentId}|${projectId}`;
}

/**
 * Select options for the header.
 *
 * The environment only shows up in the label when it disambiguates something:
 * one environment, or unique titles, and the extra noun is just clutter.
 */
export function buildProjectOptions(
  projects: readonly EnvironmentProject[],
  environmentLabels: ReadonlyMap<EnvironmentId, string>,
): readonly HistoryProjectOption[] {
  const environmentIds = new Set(projects.map((project) => project.environmentId));
  const titleCounts = new Map<string, number>();
  for (const project of projects) {
    titleCounts.set(project.title, (titleCounts.get(project.title) ?? 0) + 1);
  }
  const multipleEnvironments = environmentIds.size > 1;

  return projects.map((project) => {
    const environmentLabel = environmentLabels.get(project.environmentId);
    const collides = (titleCounts.get(project.title) ?? 0) > 1;
    const qualify = environmentLabel !== undefined && (collides || multipleEnvironments);
    return {
      key: historyProjectKey(project.environmentId, project.id),
      environmentId: project.environmentId,
      projectId: project.id,
      label: qualify ? `${project.title} · ${environmentLabel}` : project.title,
      project,
    };
  });
}

/**
 * The project the page opens on: the one named in the URL when it still
 * exists, else the active thread's project, else the first one.
 */
export function resolveSelectedProject(
  options: readonly HistoryProjectOption[],
  requested: { readonly environmentId: string | null; readonly projectId: string | null },
  activeProject: { readonly environmentId: string; readonly projectId: string } | null,
): HistoryProjectOption | null {
  if (options.length === 0) return null;

  if (requested.projectId !== null) {
    const match = options.find(
      (option) =>
        option.projectId === requested.projectId &&
        (requested.environmentId === null || option.environmentId === requested.environmentId),
    );
    if (match) return match;
  }

  if (activeProject !== null) {
    const match = options.find(
      (option) =>
        option.projectId === activeProject.projectId &&
        option.environmentId === activeProject.environmentId,
    );
    if (match) return match;
  }

  return options[0] ?? null;
}

const dayHeadingFormatterCache = new Map<string, Intl.DateTimeFormat>();

/**
 * `Mon, 15 Sep`. Formatted in UTC because the day key is already a wall-clock
 * day in the reporting zone, so re-interpreting it locally would shift it.
 */
export function formatDayHeading(day: string, locale?: string): string {
  const parsed = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(parsed)) return day;
  const cacheKey = locale ?? "";
  let formatter = dayHeadingFormatterCache.get(cacheKey);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(locale, {
      timeZone: "UTC",
      weekday: "short",
      day: "numeric",
      month: "short",
    });
    dayHeadingFormatterCache.set(cacheKey, formatter);
  }
  return formatter.format(new Date(parsed));
}

/** `4 threads`, `1 thread`. */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
