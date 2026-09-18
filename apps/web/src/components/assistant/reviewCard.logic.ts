import type { AssistantE2eResult, AssistantE2eVerdict, AssistantTask } from "@t3tools/contracts";

import { engineeringChecksLine } from "./assistantBoard.logic";

export type ReviewVerdictTone = AssistantE2eVerdict | "verified";

export interface ReviewSummary {
  kind: "Check and accept" | "Ready to accept";
  sources?: number;
  verdict: { label: string; tone: ReviewVerdictTone };
  /** Criteria the tester passed out of those it ran; skipped ones are not counted. */
  criteria: { passed: number; total: number; label: string } | null;
  screenshots: number;
  videos: number;
  humanChecks: number;
  /** A tester ran and left nothing for the person: no checks, no failed or unchecked criterion. */
  nothingToCheck: boolean;
  /** Worth opening on first sight: the person has checks to do or the run did not pass. */
  startsOpen: boolean;
  engineering: { label: string; detail: string | null } | null;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function verdictLabel(task: AssistantTask, e2e: AssistantE2eResult | null) {
  if (!e2e)
    return task.e2ePlan?.depth === "none"
      ? "No e2e test, verified on staging"
      : "Verified on staging";
  const where = e2e.environment === "worktree" ? "in the worktree" : "on staging";
  switch (e2e.verdict) {
    case "passed":
      return e2e.environment === "worktree"
        ? "Passed e2e in the worktree, deployed to staging"
        : "Passed e2e on staging";
    case "partial":
      return `Partly passed e2e ${where}`;
    case "failed":
      return `Failed e2e ${where}`;
  }
}

/** What an issue waiting for acceptance amounts to, for its inbox card. */
export function reviewSummary(task: AssistantTask): ReviewSummary {
  if (task.track === "research") {
    const research = task.research;
    const total = Math.max(task.criteria?.length ?? 0, research?.checks.length ?? 0);
    const answered = research?.checks.filter((check) => check.result === "answered").length ?? 0;
    const approved =
      research?.review?.verdict === "approved" && research.review.revision === research.revision;
    return {
      kind: "Check and accept",
      verdict: {
        label: approved ? "Fact-check approved" : "Awaiting fact-check approval",
        tone: approved ? "verified" : "partial",
      },
      criteria: { passed: answered, total, label: `${answered} of ${total} questions answered` },
      sources: research?.sources.length ?? 0,
      screenshots: research?.screenshots.length ?? 0,
      videos: 0,
      humanChecks: 0,
      nothingToCheck: false,
      startsOpen: true,
      engineering: null,
    };
  }
  const e2e = task.e2e ?? null;
  const humanChecks = e2e?.humanChecks.length ?? 0;
  const ran = (e2e?.checks ?? []).filter((check) => check.result !== "skipped");
  const passed = ran.filter((check) => check.result === "passed").length;
  const open = ran.length - passed;
  const settled = e2e?.engineeringChecks?.length && e2e.engineeringSettled !== undefined;
  const pending = engineeringChecksLine(task);
  return {
    kind: humanChecks > 0 ? "Check and accept" : "Ready to accept",
    verdict: { label: verdictLabel(task, e2e), tone: e2e?.verdict ?? "verified" },
    criteria:
      ran.length > 0
        ? { passed, total: ran.length, label: `${passed} of ${ran.length} criteria passed` }
        : null,
    screenshots: e2e?.screenshots.length ?? 0,
    videos: e2e?.videos?.length ?? 0,
    humanChecks,
    nothingToCheck: e2e !== null && e2e.verdict !== "failed" && humanChecks === 0 && open === 0,
    startsOpen: humanChecks > 0 || (e2e !== null && e2e.verdict !== "passed"),
    engineering: settled
      ? { label: "Engineering checks settled", detail: e2e.engineeringSettled?.trim() || null }
      : pending
        ? { label: pending, detail: null }
        : null,
  };
}

/** The muted line under a collapsed review card's title. */
export function reviewOutcomeLine(summary: ReviewSummary): string {
  if (summary.sources !== undefined) {
    return [
      summary.criteria?.label,
      plural(summary.sources, "source"),
      plural(summary.screenshots, "screenshot"),
    ]
      .filter(Boolean)
      .join(" · ");
  }
  return [
    summary.verdict.label,
    summary.criteria?.label,
    summary.screenshots ? plural(summary.screenshots, "screenshot") : null,
    summary.videos ? plural(summary.videos, "recording") : null,
    summary.humanChecks
      ? `${plural(summary.humanChecks, "check")} for you`
      : summary.nothingToCheck
        ? "nothing left for you to check"
        : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
