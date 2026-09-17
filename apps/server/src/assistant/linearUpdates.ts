import * as NodeCrypto from "node:crypto";
import type {
  AssistantCodeReview,
  AssistantDeployment,
  AssistantE2eResult,
  AssistantMerge,
  LinearIssueDetail,
} from "@t3tools/contracts";

/**
 * The comments T3 posts on a managed Linear issue as it moves through its
 * phases: merged after code review, deployed to staging, and the e2e result.
 * The last one is the card a person decides from, so it stands alone. An issue
 * its team leader did not take gets one comment saying why.
 */

type PullRequest = { readonly number: number; readonly url: string } | null;

const link = (label: string, url: string) =>
  /^https?:\/\//.test(url) ? `[${label}](${url})` : label;

const host = (url: string) => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};

const bullets = (lines: ReadonlyArray<string | null>) =>
  lines
    .filter((line): line is string => line !== null)
    .map((line) => `- ${line}`)
    .join("\n");

const pullRequestLine = (pullRequest: PullRequest) =>
  pullRequest ? `Pull request: ${link(`#${pullRequest.number}`, pullRequest.url)}` : null;

const deploymentLines = (deployment: AssistantDeployment) => [
  `Staging: ${link(host(deployment.url), deployment.url)}`,
  `Deployed commit: \`${deployment.revision.slice(0, 7)}\``,
  deployment.evidence?.length
    ? `Deployments: ${deployment.evidence.map((entry) => link(entry.targetId, entry.reference)).join(", ")}`
    : null,
];

const sections = (...parts: ReadonlyArray<string | null | undefined>) =>
  parts
    .map((part) => part?.trim())
    .filter(Boolean)
    .join("\n\n");

export function mergedComment(input: {
  readonly merge: AssistantMerge;
  readonly review: AssistantCodeReview;
  readonly pullRequest: PullRequest;
  readonly baseBranch: string;
  /** A worktree e2e run that already passed on the merged commit, when there was one. */
  readonly e2e?: AssistantE2eResult | null;
  /** The issue runs no e2e test, so staging is the last step before review. */
  readonly noE2e?: boolean;
}): string {
  const tested = input.e2e?.environment === "worktree" && input.e2e.verdict !== "failed";
  return sections(
    tested
      ? `**Code review passed · e2e passed in the development environment · merged into \`${input.baseBranch}\`**`
      : `**Code review passed · merged into \`${input.baseBranch}\`**`,
    input.merge.summary,
    input.review.summary ? `**Code review:** ${input.review.summary}` : null,
    tested && input.e2e?.humanChecks.length
      ? "The e2e check passed what it could and left some checks for a person; they come with the result once staging is verified."
      : null,
    bullets([
      pullRequestLine(input.pullRequest),
      `Reviewed commit: \`${input.merge.commit.slice(0, 7)}\``,
    ]),
    tested || input.noE2e
      ? "Next: staging deploy. The issue moves to review once it is verified there."
      : "Next: staging deploy, then an e2e check on staging.",
  );
}

export function deployedComment(input: { readonly deployment: AssistantDeployment }): string {
  return sections(
    "**Deployed to staging · e2e check running**",
    bullets(deploymentLines(input.deployment)),
  );
}

const HEADLINES: Record<"staging" | "worktree", Record<AssistantE2eResult["verdict"], string>> = {
  staging: {
    passed: "**✅ Verified on staging: ready to accept**",
    partial: "**👀 Verified on staging, with checks for a person**",
    failed: "**❌ Failed on staging: back with the team for a fix**",
  },
  worktree: {
    passed:
      "**✅ Verified in the development environment and deployed to staging: ready to accept**",
    partial:
      "**👀 Verified in the development environment and deployed to staging, with checks for a person**",
    failed: "**❌ Failed in the development environment: back with the team for a fix**",
  },
};

const SMOKE_HEADLINES: Record<
  "staging" | "worktree",
  Record<AssistantE2eResult["verdict"], string>
> = {
  staging: {
    passed: "**✅ Smoke test passed on staging: ready to accept**",
    partial: "**👀 Smoke test passed on staging, with checks for a person**",
    failed: "**❌ Smoke test failed on staging: back with the team for a fix**",
  },
  worktree: {
    passed:
      "**✅ Smoke test passed in the development environment and deployed to staging: ready to accept**",
    partial:
      "**👀 Smoke test passed in the development environment and deployed to staging, with checks for a person**",
    failed: "**❌ Smoke test failed in the development environment: back with the team for a fix**",
  },
};

const RESULTS: Record<NonNullable<AssistantE2eResult["checks"]>[number]["result"], string> = {
  passed: "✅ passed",
  failed: "❌ failed",
  "not-checked": "👀 not checked",
  skipped: "➖ not in the smoke test",
};

/** One line of text, for a table cell or a list item. */
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** A table cell: one line, and no pipe that would end the column early. */
const cell = (text: string) => oneLine(text).replace(/\|/g, "\\|");

/**
 * A section Linear shows collapsed under its title. A line starting with `+++`
 * inside would end it (or open another), so such a line is escaped.
 */
const collapsed = (title: string, content: string) =>
  `+++ ${title}\n\n${content.trim().replace(/^(\s*)\+\+\+/gm, "$1\\+++")}\n\n+++`;

type E2eCheck = NonNullable<AssistantE2eResult["checks"]>[number];

/** Where a check's screenshot sits in the card's numbered screenshots, when it has one. */
const screenshotRef = (check: E2eCheck, screenshots: AssistantE2eResult["screenshots"]) =>
  check.screenshot && screenshots[check.screenshot - 1] ? ` (screenshot ${check.screenshot})` : "";

const criterionName = (check: E2eCheck, criteria: ReadonlyArray<string>) =>
  criteria[check.criterion - 1] ?? `Criterion ${check.criterion}`;

/** One row per acceptance criterion with its result; the evidence sits collapsed below. */
const checksTable = (
  checks: ReadonlyArray<E2eCheck>,
  criteria: ReadonlyArray<string>,
  screenshots: AssistantE2eResult["screenshots"],
) =>
  [
    "| Criterion | Result |",
    "| --- | --- |",
    ...checks.map(
      (check) =>
        `| ${cell(criterionName(check, criteria))} | ${RESULTS[check.result]}${screenshotRef(check, screenshots)} |`,
    ),
  ].join("\n");

/** What the tester saw for each criterion, for a reader who opens it. */
const evidenceList = (
  checks: ReadonlyArray<E2eCheck>,
  criteria: ReadonlyArray<string>,
  screenshots: AssistantE2eResult["screenshots"],
) =>
  checks
    .map((check) => {
      const evidence = oneLine(check.evidence);
      return `${check.criterion}. **${oneLine(criterionName(check, criteria))}** ${RESULTS[check.result]}${screenshotRef(check, screenshots)}${evidence ? `: ${evidence}` : ""}`;
    })
    .join("\n");

/** Why the issue's team leader did not take it, and what brings it back. */
export function declinedComment(reason: string): string {
  return sections(
    "**Not taken by the developer assistant**",
    reason,
    "The assistant picks this issue up again once it changes: an edit to the description, labels, priority or state, or a new comment.",
  );
}

/** How many of a person's newest comments the fingerprint reads. */
const FINGERPRINT_COMMENTS = 20;

/**
 * What the issue says, as a person would change it. T3's own comments are left
 * out, so posting one never makes a declined issue look edited.
 *
 * Linear returns the newest comments first and T3 reads a window of 50, so on a
 * long thread its own comment pushes an older one out of the window. Only the
 * newest {@link FINGERPRINT_COMMENTS} comments a person wrote are hashed, so what
 * leaves the far end of the window does not, by itself, make the issue look changed.
 */
export function issueFingerprint(
  issue: LinearIssueDetail,
  postedIds: ReadonlyArray<string>,
): string {
  const posted = new Set(postedIds);
  const content = {
    title: issue.title,
    description: issue.description ?? "",
    priority: issue.priority,
    state: issue.state.id,
    assignee: issue.assignee?.id ?? null,
    milestone: issue.milestone?.id ?? null,
    labels: issue.labels.map((label) => label.id).toSorted(),
    parent: issue.parent?.id ?? null,
    children: issue.children.map((child) => `${child.id}:${child.stateName}`).toSorted(),
    comments: issue.comments
      .filter((c) => !posted.has(c.id))
      .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-FINGERPRINT_COMMENTS)
      .map((c) => `${c.id}:${c.body}`),
  };
  return NodeCrypto.createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

/**
 * The card a person decides from, written for someone reading the issue rather
 * than the engineering: what to check, the result per criterion, what the
 * tester flagged and every screenshot up top, with the evidence and the
 * tester's full report collapsed below. What shipped is in the description.
 */
export function e2eComment(input: {
  readonly e2e: AssistantE2eResult;
  readonly merge: AssistantMerge | null;
  readonly deployment: AssistantDeployment;
  readonly pullRequest: PullRequest;
  readonly acceptedState: string;
  /** The issue's acceptance criteria, to name the rows of the checks table. */
  readonly criteria?: ReadonlyArray<string> | null;
  /** The run was a smoke test of some criteria rather than the full test. */
  readonly smoke?: boolean;
}): string {
  const { e2e } = input;
  const delivered = e2e.verdict !== "failed";
  const worktree = e2e.environment === "worktree";
  const criteria = input.criteria ?? [];
  const checks = e2e.checks?.length && criteria.length ? e2e.checks : null;
  const report = e2e.report.trim();
  const commit = worktree && e2e.commit ? e2e.commit.slice(0, 7) : null;
  const notes = (e2e.worthALook ?? []).map(oneLine).filter(Boolean);
  return sections(
    (input.smoke ? SMOKE_HEADLINES : HEADLINES)[worktree ? "worktree" : "staging"][e2e.verdict],
    e2e.humanChecks.length
      ? `**Check before accepting**\n\n${e2e.humanChecks.map((check, i) => `${i + 1}. ${check}`).join("\n")}`
      : null,
    checks ? checksTable(checks, criteria, e2e.screenshots) : null,
    notes.length ? `**Worth a look**\n\n${bullets(notes)}` : null,
    e2e.screenshots.length
      ? [
          "**Screenshots**",
          ...e2e.screenshots.map(
            (shot, i) =>
              `*Screenshot ${i + 1}: ${shot.caption}*\n\n![${shot.caption}](${shot.url})`,
          ),
        ].join("\n\n")
      : null,
    checks
      ? collapsed("Evidence per criterion", evidenceList(checks, criteria, e2e.screenshots))
      : null,
    // Without criteria the report is the only record of what was checked, so it stays open.
    report && checks
      ? collapsed(`Tester's full report${commit ? ` (tested commit ${commit})` : ""}`, report)
      : null,
    report && !checks
      ? `${worktree ? `**${input.smoke ? "Smoke test" : "E2E check"} in the worktree${commit ? ` (commit \`${commit}\`)` : ""}**` : `**${input.smoke ? "Smoke test" : "E2E check"} on staging**`}\n\n${report}`
      : null,
    ...deliveryFooter({ ...input, delivered }),
  );
}

/** What closes a delivery card: where to read what shipped, how to accept, and where it runs. */
const deliveryFooter = (input: {
  readonly delivered: boolean;
  readonly merge: AssistantMerge | null;
  readonly deployment: AssistantDeployment;
  readonly pullRequest: PullRequest;
  readonly acceptedState: string;
}) => {
  const accept = input.acceptedState.trim() || "a completed state";
  return [
    "---",
    // Delivery writes the implementer's summary into the description's "What shipped".
    input.delivered && input.merge?.summary.trim()
      ? "What shipped is in the issue description."
      : null,
    input.delivered
      ? `To accept, move this issue to ${accept}. To ask for changes, move it back to an earlier state and comment what should change.`
      : null,
    bullets([...deploymentLines(input.deployment), pullRequestLine(input.pullRequest)]),
  ];
};

/**
 * The card for an issue delivered without an e2e test, because nothing a user
 * sees or does changed. Its first line is the verdict and says who decided.
 */
export function noE2eComment(input: {
  /** Why no test ran, as the team leader or the board recorded it. */
  readonly reason: string;
  /** Who set the depth to none. */
  readonly decidedBy: "lead" | "review" | "person" | undefined;
  readonly merge: AssistantMerge | null;
  readonly deployment: AssistantDeployment;
  readonly pullRequest: PullRequest;
  readonly acceptedState: string;
}): string {
  const reason = oneLine(input.reason).replace(/[.\s]+$/, "");
  return sections(
    input.decidedBy === "person"
      ? "**No e2e test: set by the person on the board**"
      : `**No e2e test: ${reason || "nothing a user sees changed"}** (decided by the team leader)`,
    ...deliveryFooter({ ...input, delivered: true }),
  );
}

/** The markers around T3's own section of an issue description, so it is replaced and never duplicated. */
export const DELIVERED_MARKER_START = "<!-- t3:delivered -->";
export const DELIVERED_MARKER_END = "<!-- /t3:delivered -->";
const DELIVERED_BLOCK = /<!-- t3:delivered -->[\s\S]*?<!-- \/t3:delivered -->/;

/**
 * The issue's description once staging verifies the work: the person's own text
 * untouched above, and below it a "What shipped" section a non-engineer can
 * read. A redelivery after changes were requested replaces that section in
 * place. Engineering detail (commits, pull requests) stays in the comments.
 */
export function deliveredDescription(input: {
  readonly current: string | null;
  readonly merge: AssistantMerge | null;
  /** Null when the issue was delivered without an e2e test. */
  readonly e2e: AssistantE2eResult | null;
  readonly deployment: AssistantDeployment;
  readonly acceptedState: string;
}): string {
  const accept = input.acceptedState.trim() || "a completed state";
  const section = [
    DELIVERED_MARKER_START,
    sections(
      "## What shipped",
      `Delivered to staging and waiting to be accepted. Move this issue to ${accept} to accept it.`,
      input.merge?.summary.trim() ||
        "See the developer assistant's comments below for what changed.",
      input.e2e?.humanChecks.length
        ? `**Check before accepting**\n\n${input.e2e.humanChecks.map((check, i) => `${i + 1}. ${check}`).join("\n")}`
        : null,
      `Staging: ${link(host(input.deployment.url), input.deployment.url)}`,
    ),
    DELIVERED_MARKER_END,
  ].join("\n");
  const current = input.current?.trim() ?? "";
  if (!current) return section;
  // A function replacement, so a summary containing `$&` is kept as written.
  if (DELIVERED_BLOCK.test(current)) return current.replace(DELIVERED_BLOCK, () => section);
  return `${current}\n\n${section}`;
}

/** A Linear failure's own sentence, which names the fix better than a generic one. */
export function linearFailureDetail(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    if ("detail" in error && typeof error.detail === "string" && error.detail) return error.detail;
    if ("reason" in error && error.reason === "unconfigured") return "Linear is not connected.";
  }
  return "Linear did not accept the request.";
}

/**
 * Marks where replies on a delivered team's Linear session start in its task's
 * feedback. Text before it is the earlier send-back the team worked from; only
 * the text after it goes into the next send-back, without the marker, so a
 * new team's feedback never carries one.
 */
export const SESSION_NOTES_MARKER = "Replies on the Linear agent session, for a send-back:";

/** The task's feedback with a reply from its Linear session added for a send-back. */
export function withSessionNote(feedback: string, note: string): string {
  if (feedback.includes(SESSION_NOTES_MARKER)) return `${feedback}\n\n${note.trim()}`;
  return [feedback.trim(), `${SESSION_NOTES_MARKER}\n\n${note.trim()}`]
    .filter(Boolean)
    .join("\n\n");
}

/** The replies from the Linear session stored in a task's feedback, or null. */
export function sessionNotes(feedback: string): string | null {
  const at = feedback.indexOf(SESSION_NOTES_MARKER);
  return at < 0 ? null : feedback.slice(at + SESSION_NOTES_MARKER.length).trim() || null;
}

/**
 * What a person asked for when they moved a delivered issue back in Linear:
 * their comments since the e2e card, leaving out the ones T3 posted itself,
 * then what they replied on the team's session.
 */
export function linearFeedback(input: {
  readonly comments: ReadonlyArray<{
    id: string;
    body: string;
    createdAt: string;
    authorIsApp?: boolean;
  }>;
  readonly since: string;
  readonly postedIds: ReadonlyArray<string>;
  readonly stateName: string;
  readonly notes?: string | null;
}): string {
  const posted = new Set(input.postedIds);
  const notes = input.notes?.trim() ?? "";
  const replies = input.comments
    .filter(
      (c) =>
        !posted.has(c.id) &&
        // An agent session's own replies show as comments by the app, not the person.
        !c.authorIsApp &&
        c.createdAt > input.since &&
        c.body.trim() &&
        // A reply on the session can also show as a comment; the stored note has it once.
        !(notes && notes.includes(c.body.trim())),
    )
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((c) => c.body.trim());
  if (notes) replies.push(notes);
  return replies.length
    ? `Requested in Linear (moved to ${input.stateName}):\n\n${replies.join("\n\n")}`
    : `Moved back to ${input.stateName} in Linear without a comment. Ask the person what should change.`;
}
