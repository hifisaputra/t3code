import { ProjectId, ThreadId, type AssistantTask } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { reviewOutcomeLine, reviewSummary } from "./reviewCard.logic";

type E2e = NonNullable<AssistantTask["e2e"]>;

const e2e = (overrides: Partial<E2e> = {}): E2e => ({
  verdict: "passed",
  report: "",
  humanChecks: [],
  screenshots: [],
  at: "2026-09-13T00:00:00.000Z",
  ...overrides,
});

const task = (overrides: Partial<AssistantTask> = {}): AssistantTask => ({
  id: "task-1",
  projectId: ProjectId.make("project-1"),
  issue: {
    id: "issue-1",
    identifier: "SPI-1",
    title: "Refunds",
    url: "https://linear.app/x/issue/SPI-1",
  } as AssistantTask["issue"],
  threadId: ThreadId.make("worker-1"),
  status: "review",
  brief: "",
  summary: "",
  reviewInstructions: "",
  feedback: "",
  turns: 1,
  turnLimit: 6,
  deployment: null,
  error: null,
  createdAt: "2026-09-13T00:00:00.000Z",
  updatedAt: "2026-09-13T00:00:00.000Z",
  ...overrides,
});

describe("reviewSummary", () => {
  it("offers a quick accept for a clean pass and keeps it collapsed", () => {
    const summary = reviewSummary(
      task({
        e2e: e2e({
          checks: [
            { criterion: 1, result: "passed", evidence: "" },
            { criterion: 2, result: "passed", evidence: "" },
            { criterion: 3, result: "skipped", evidence: "" },
          ],
          screenshots: [{ url: "u", caption: "c" }],
        }),
      }),
    );
    expect(summary.kind).toBe("Ready to accept");
    expect(summary.nothingToCheck).toBe(true);
    expect(summary.startsOpen).toBe(false);
    expect(reviewOutcomeLine(summary)).toBe(
      "Passed e2e on staging · 2 of 2 criteria passed · 1 screenshot · nothing left for you to check",
    );
  });

  it("opens and withholds the quick accept when the person has checks", () => {
    const summary = reviewSummary(
      task({ e2e: e2e({ verdict: "partial", humanChecks: ["Read the email"] }) }),
    );
    expect(summary.kind).toBe("Check and accept");
    expect(summary.nothingToCheck).toBe(false);
    expect(summary.startsOpen).toBe(true);
    expect(reviewOutcomeLine(summary)).toBe("Partly passed e2e on staging · 1 check for you");
  });

  it("withholds the quick accept for an unchecked criterion", () => {
    const summary = reviewSummary(
      task({
        e2e: e2e({ checks: [{ criterion: 1, result: "not-checked", evidence: "" }] }),
      }),
    );
    expect(summary.nothingToCheck).toBe(false);
    expect(summary.criteria?.label).toBe("0 of 1 criteria passed");
  });

  it("leaves work without a tester to the person's own check", () => {
    const summary = reviewSummary(task({ e2ePlan: null }));
    expect(summary.nothingToCheck).toBe(false);
    expect(summary.startsOpen).toBe(false);
    expect(summary.verdict).toEqual({ label: "Verified on staging", tone: "verified" });
  });

  it("counts recordings next to screenshots", () => {
    const summary = reviewSummary(
      task({
        e2e: e2e({
          screenshots: [{ url: "u", caption: "c" }],
          videos: [
            { url: "v1", caption: "Checkout", path: "/tmp/e2e/checkout.mp4" },
            { url: "v2", caption: "Refund" },
          ],
        }),
      }),
    );
    expect(summary.videos).toBe(2);
    expect(reviewOutcomeLine(summary)).toBe(
      "Passed e2e on staging · 1 screenshot · 2 recordings · nothing left for you to check",
    );
    expect(
      reviewOutcomeLine(reviewSummary(task({ e2e: e2e({ videos: [{ url: "v", caption: "" }] }) }))),
    ).toContain("· 1 recording ·");
  });

  it("reports settled engineering checks", () => {
    const summary = reviewSummary(
      task({ e2e: e2e({ engineeringChecks: ["Logs"], engineeringSettled: "Read the logs" }) }),
    );
    expect(summary.engineering).toEqual({
      label: "Engineering checks settled",
      detail: "Read the logs",
    });
  });
});
