import type { EnvironmentId, ProjectHistory, ProjectHistoryDay } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildDayBars,
  buildProjectOptions,
  dayBarHeightPercent,
  dayBoundsMs,
  dayStartMs,
  formatDurationMs,
  formatZonedDayKey,
  historyProjectKey,
  intervalToLanePercent,
  laneColorClass,
  MIN_DAY_BAR_PERCENT,
  resolveSelectedProject,
  summarizeHistory,
} from "./historyPage.logic";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("formatDurationMs", () => {
  it("names anything shorter than a minute", () => {
    expect(formatDurationMs(0)).toBe("under a minute");
    expect(formatDurationMs(59_999)).toBe("under a minute");
    expect(formatDurationMs(-5)).toBe("under a minute");
    expect(formatDurationMs(Number.NaN)).toBe("under a minute");
  });

  it("uses whole minutes under an hour", () => {
    expect(formatDurationMs(60_000)).toBe("1m");
    expect(formatDurationMs(42 * MINUTE + 59_000)).toBe("42m");
    expect(formatDurationMs(HOUR - 1)).toBe("59m");
  });

  it("uses hours and minutes up to a day", () => {
    expect(formatDurationMs(3 * HOUR + 12 * MINUTE)).toBe("3h 12m");
    expect(formatDurationMs(2 * HOUR)).toBe("2h");
    expect(formatDurationMs(24 * HOUR - MINUTE)).toBe("23h 59m");
  });

  it("uses days and hours past a day", () => {
    expect(formatDurationMs(24 * HOUR)).toBe("1d");
    expect(formatDurationMs(28 * HOUR)).toBe("1d 4h");
    expect(formatDurationMs(50 * HOUR + 30 * MINUTE)).toBe("2d 2h");
  });
});

describe("dayStartMs", () => {
  it("resolves midnight in the requested zone", () => {
    expect(dayStartMs("2026-09-15", "UTC")).toBe(Date.parse("2026-09-15T00:00:00Z"));
    expect(dayStartMs("2026-09-15", "Asia/Singapore")).toBe(Date.parse("2026-09-14T16:00:00Z"));
    expect(dayStartMs("2026-01-15", "America/New_York")).toBe(Date.parse("2026-01-15T05:00:00Z"));
  });

  it("rejects a malformed day", () => {
    expect(dayStartMs("not-a-day", "UTC")).toBeNull();
  });
});

describe("dayBoundsMs", () => {
  it("spans exactly 24 hours on an ordinary day", () => {
    const bounds = dayBoundsMs("2026-09-15", "Asia/Singapore");
    expect(bounds).not.toBeNull();
    expect(bounds!.endMs - bounds!.startMs).toBe(24 * HOUR);
  });

  it("spans 23 hours across a spring-forward transition", () => {
    const bounds = dayBoundsMs("2026-03-08", "America/New_York");
    expect(bounds).not.toBeNull();
    expect(bounds!.endMs - bounds!.startMs).toBe(23 * HOUR);
  });

  it("spans 25 hours across a fall-back transition", () => {
    const bounds = dayBoundsMs("2026-11-01", "America/New_York");
    expect(bounds).not.toBeNull();
    expect(bounds!.endMs - bounds!.startMs).toBe(25 * HOUR);
  });
});

describe("formatZonedDayKey", () => {
  it("buckets an instant into the viewer's calendar day", () => {
    expect(formatZonedDayKey(Date.parse("2026-09-14T16:30:00Z"), "Asia/Singapore")).toBe(
      "2026-09-15",
    );
    expect(formatZonedDayKey(Date.parse("2026-09-14T16:30:00Z"), "UTC")).toBe("2026-09-14");
  });
});

describe("intervalToLanePercent", () => {
  const zone = "UTC";

  it("places an interval proportionally across the day", () => {
    const span = intervalToLanePercent(
      { start: "2026-09-15T06:00:00Z", end: "2026-09-15T12:00:00Z" },
      "2026-09-15",
      zone,
    );
    expect(span).toEqual({ leftPercent: 25, widthPercent: 25 });
  });

  it("clips an interval that started the evening before", () => {
    const span = intervalToLanePercent(
      { start: "2026-09-14T22:00:00Z", end: "2026-09-15T06:00:00Z" },
      "2026-09-15",
      zone,
    );
    expect(span).toEqual({ leftPercent: 0, widthPercent: 25 });
  });

  it("clips an interval that runs past midnight", () => {
    const span = intervalToLanePercent(
      { start: "2026-09-15T18:00:00Z", end: "2026-09-16T04:00:00Z" },
      "2026-09-15",
      zone,
    );
    expect(span).toEqual({ leftPercent: 75, widthPercent: 25 });
  });

  it("clamps an interval that swallows the whole day", () => {
    const span = intervalToLanePercent(
      { start: "2026-09-10T00:00:00Z", end: "2026-09-20T00:00:00Z" },
      "2026-09-15",
      zone,
    );
    expect(span).toEqual({ leftPercent: 0, widthPercent: 100 });
  });

  it("drops an interval from another day", () => {
    expect(
      intervalToLanePercent(
        { start: "2026-09-13T01:00:00Z", end: "2026-09-13T02:00:00Z" },
        "2026-09-15",
        zone,
      ),
    ).toBeNull();
  });

  it("keeps a zero-length interval inside the day", () => {
    const span = intervalToLanePercent(
      { start: "2026-09-15T12:00:00Z", end: "2026-09-15T12:00:00Z" },
      "2026-09-15",
      zone,
    );
    expect(span).toEqual({ leftPercent: 50, widthPercent: 0 });
  });

  it("buckets against the viewer's zone, not UTC", () => {
    const span = intervalToLanePercent(
      { start: "2026-09-14T16:00:00Z", end: "2026-09-14T22:00:00Z" },
      "2026-09-15",
      "Asia/Singapore",
    );
    expect(span).toEqual({ leftPercent: 0, widthPercent: 25 });
  });

  it("drops an unparseable interval", () => {
    expect(
      intervalToLanePercent({ start: "nonsense", end: "nonsense" }, "2026-09-15", zone),
    ).toBeNull();
  });
});

describe("dayBarHeightPercent", () => {
  it("leaves quiet days empty", () => {
    expect(dayBarHeightPercent(0, 10 * HOUR)).toBe(0);
    expect(dayBarHeightPercent(5 * HOUR, 0)).toBe(0);
  });

  it("scales against the tallest day", () => {
    expect(dayBarHeightPercent(5 * HOUR, 10 * HOUR)).toBe(50);
    expect(dayBarHeightPercent(10 * HOUR, 10 * HOUR)).toBe(100);
  });

  it("keeps a short day visible", () => {
    expect(dayBarHeightPercent(MINUTE, 100 * HOUR)).toBe(MIN_DAY_BAR_PERCENT);
  });

  it("never overflows the track", () => {
    expect(dayBarHeightPercent(20 * HOUR, 10 * HOUR)).toBe(100);
  });
});

function history(overrides: Partial<ProjectHistory> = {}): ProjectHistory {
  return {
    projectId: "project-1",
    timeZone: "UTC",
    sinceDay: "2026-09-13",
    untilDay: "2026-09-15",
    readAt: "2026-09-15T12:00:00Z",
    days: [],
    threads: [],
    ...overrides,
  } as unknown as ProjectHistory;
}

function day(
  dayKey: string,
  activeMs: number,
  turns: number,
  threadIds: readonly string[],
): ProjectHistoryDay {
  return {
    day: dayKey,
    activeMs,
    turns,
    threads: threadIds.map((threadId) => ({
      threadId,
      title: threadId,
      branch: null,
      linkedIssue: null,
      archivedAt: null,
      turns: 1,
      activeMs,
      firstActivityAt: `${dayKey}T09:00:00Z`,
      lastActivityAt: `${dayKey}T10:00:00Z`,
      running: false,
      intervals: [{ start: `${dayKey}T09:00:00Z`, end: `${dayKey}T10:00:00Z` }],
    })),
  } as unknown as ProjectHistoryDay;
}

describe("buildDayBars", () => {
  it("renders one bar per calendar day with quiet days empty", () => {
    const bars = buildDayBars(
      ["2026-09-13", "2026-09-14", "2026-09-15"],
      history({
        days: [day("2026-09-15", 2 * HOUR, 4, ["t1"]), day("2026-09-13", HOUR, 2, ["t2"])],
      }),
      "2026-09-15",
    );
    expect(bars.map((bar) => bar.heightPercent)).toEqual([50, 0, 100]);
    expect(bars.map((bar) => bar.isToday)).toEqual([false, false, true]);
    expect(bars[1]?.turns).toBe(0);
  });

  it("renders an empty window without a history", () => {
    const bars = buildDayBars(["2026-09-15"], null, "2026-09-15");
    expect(bars).toEqual([
      { day: "2026-09-15", activeMs: 0, turns: 0, heightPercent: 0, isToday: true },
    ]);
  });
});

describe("summarizeHistory", () => {
  it("counts each thread once across days", () => {
    const summary = summarizeHistory(
      history({
        days: [day("2026-09-15", 2 * HOUR, 4, ["t1", "t2"]), day("2026-09-13", HOUR, 2, ["t1"])],
      }),
    );
    expect(summary).toEqual({ activeMs: 3 * HOUR, activeDays: 2, threads: 2, turns: 6 });
  });

  it("is empty without a history", () => {
    expect(summarizeHistory(null)).toEqual({
      activeMs: 0,
      activeDays: 0,
      threads: 0,
      turns: 0,
    });
  });
});

describe("laneColorClass", () => {
  it("cycles through the palette and handles a negative index", () => {
    expect(laneColorClass(0)).toBe(laneColorClass(6));
    expect(laneColorClass(-1)).toBe(laneColorClass(5));
  });
});

const ENV_A = "env-a" as EnvironmentId;
const ENV_B = "env-b" as EnvironmentId;

function project(id: string, title: string, environmentId: EnvironmentId) {
  return { id, title, environmentId } as unknown as Parameters<
    typeof buildProjectOptions
  >[0][number];
}

describe("buildProjectOptions", () => {
  it("leaves labels bare with one environment and unique titles", () => {
    const options = buildProjectOptions(
      [project("p1", "t3code", ENV_A), project("p2", "marketing", ENV_A)],
      new Map([[ENV_A, "This device"]]),
    );
    expect(options.map((option) => option.label)).toEqual(["t3code", "marketing"]);
    expect(options[0]?.key).toBe(historyProjectKey(ENV_A, "p1"));
  });

  it("qualifies labels once a second environment is connected", () => {
    const options = buildProjectOptions(
      [project("p1", "t3code", ENV_A), project("p2", "t3code", ENV_B)],
      new Map([
        [ENV_A, "This device"],
        [ENV_B, "Mac mini"],
      ]),
    );
    expect(options.map((option) => option.label)).toEqual([
      "t3code · This device",
      "t3code · Mac mini",
    ]);
  });
});

describe("resolveSelectedProject", () => {
  const options = buildProjectOptions(
    [project("p1", "t3code", ENV_A), project("p2", "marketing", ENV_A)],
    new Map([[ENV_A, "This device"]]),
  );

  it("prefers the project named in the URL", () => {
    const selected = resolveSelectedProject(
      options,
      { environmentId: ENV_A, projectId: "p2" },
      { environmentId: ENV_A, projectId: "p1" },
    );
    expect(selected?.projectId).toBe("p2");
  });

  it("falls back to the active thread's project when the URL names nothing", () => {
    const selected = resolveSelectedProject(
      options,
      { environmentId: null, projectId: null },
      {
        environmentId: ENV_A,
        projectId: "p2",
      },
    );
    expect(selected?.projectId).toBe("p2");
  });

  it("falls back to the first project when the URL names a stale one", () => {
    const selected = resolveSelectedProject(
      options,
      { environmentId: ENV_A, projectId: "gone" },
      null,
    );
    expect(selected?.projectId).toBe("p1");
  });

  it("has nothing to select without projects", () => {
    expect(resolveSelectedProject([], { environmentId: null, projectId: null }, null)).toBeNull();
  });
});
