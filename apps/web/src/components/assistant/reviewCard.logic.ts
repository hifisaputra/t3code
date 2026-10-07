import {
  assistantE2eEvidenceCounts,
  assistantResearchCounts,
  assistantTaskReports,
  type AssistantE2eSummary,
  type AssistantE2eVerdict,
  type AssistantTaskSummary,
} from "@t3tools/contracts";

import { engineeringChecksLine, reportWords } from "./assistantBoard.logic";

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
  engineering: { label: string; detail: string | null } | null;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function verdictLabel(task: AssistantTaskSummary, e2e: AssistantE2eSummary | null) {
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
export function reviewSummary(task: AssistantTaskSummary): ReviewSummary {
  if (assistantTaskReports(task)) {
    const words = reportWords(task.track);
    const research = task.research;
    const total = Math.max(task.criteria?.length ?? 0, research?.checks.length ?? 0);
    const answered = research?.checks.filter((check) => check.result === "answered").length ?? 0;
    const approved =
      research?.review?.verdict === "approved" && research.review.revision === research.revision;
    return {
      kind: "Check and accept",
      verdict: {
        label: approved ? words.checked : words.awaitingCheck,
        tone: approved ? "verified" : "partial",
      },
      criteria: {
        passed: answered,
        total,
        label:
          task.track === "ops"
            ? `${answered} of ${total} done`
            : `${answered} of ${total} questions answered`,
      },
      // An ops change's links are not sources; its line reads like a delivery's.
      ...(task.track === "ops"
        ? {}
        : { sources: research ? assistantResearchCounts(research).sources : 0 }),
      screenshots: research ? assistantResearchCounts(research).screenshots : 0,
      videos: 0,
      humanChecks: 0,
      nothingToCheck: false,
      engineering: null,
    };
  }
  const e2e = task.e2e ?? null;
  const evidence = e2e ? assistantE2eEvidenceCounts(e2e) : { screenshots: 0, videos: 0 };
  const humanChecks = e2e?.humanChecks.length ?? 0;
  const ran = (e2e?.checks ?? []).filter((check) => check.result !== "skipped");
  const passed = ran.filter((check) => check.result === "passed").length;
  const open = ran.length - passed;
  const settled = e2e?.engineeringChecks?.length && e2e.engineeringSettled !== undefined;
  const pending = engineeringChecksLine(task);
  return {
    kind: humanChecks > 0 || e2e?.verdict === "failed" ? "Check and accept" : "Ready to accept",
    verdict: { label: verdictLabel(task, e2e), tone: e2e?.verdict ?? "verified" },
    criteria:
      ran.length > 0
        ? { passed, total: ran.length, label: `${passed} of ${ran.length} criteria passed` }
        : null,
    screenshots: evidence.screenshots,
    videos: evidence.videos,
    humanChecks,
    nothingToCheck: e2e !== null && e2e.verdict !== "failed" && humanChecks === 0 && open === 0,
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
