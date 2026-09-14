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
}): string {
  return sections(
    `**Code review passed · merged into \`${input.baseBranch}\`**`,
    input.merge.summary,
    input.review.summary ? `**Code review:** ${input.review.summary}` : null,
    bullets([
      pullRequestLine(input.pullRequest),
      `Reviewed commit: \`${input.merge.commit.slice(0, 7)}\``,
    ]),
    "Next: staging deploy, then an e2e check on staging.",
  );
}

export function deployedComment(input: { readonly deployment: AssistantDeployment }): string {
  return sections(
    "**Deployed to staging · e2e check running**",
    bullets(deploymentLines(input.deployment)),
  );
}

const HEADLINES: Record<AssistantE2eResult["verdict"], string> = {
  passed: "**✅ Verified on staging: ready to accept**",
  partial: "**👀 Verified on staging, with checks for a person**",
  failed: "**❌ Failed on staging: back with the team for a fix**",
};

/** Why the issue's team leader did not take it, and what brings it back. */
export function declinedComment(reason: string): string {
  return sections(
    "**Not taken by the developer assistant**",
    reason,
    "The assistant picks this issue up again once it changes: an edit to the description, labels, priority or state, or a new comment.",
  );
}

/**
 * What the issue says, as a person would change it. T3's own comments are left
 * out, so posting one never makes a declined issue look edited.
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
    comments: issue.comments.filter((c) => !posted.has(c.id)).map((c) => `${c.id}:${c.body}`),
  };
  return NodeCrypto.createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

export function e2eComment(input: {
  readonly e2e: AssistantE2eResult;
  readonly merge: AssistantMerge | null;
  readonly deployment: AssistantDeployment;
  readonly pullRequest: PullRequest;
  readonly acceptedState: string;
}): string {
  const { e2e } = input;
  const delivered = e2e.verdict !== "failed";
  const accept = input.acceptedState.trim() || "a completed state";
  return sections(
    HEADLINES[e2e.verdict],
    e2e.humanChecks.length
      ? `**Check before accepting**\n\n${e2e.humanChecks.map((check, i) => `${i + 1}. ${check}`).join("\n")}`
      : null,
    delivered && input.merge ? `**What changed**\n\n${input.merge.summary}` : null,
    `**Staging check**\n\n${e2e.report}`,
    ...e2e.screenshots.map((shot) => `*${shot.caption}*\n\n![${shot.caption}](${shot.url})`),
    "---",
    delivered
      ? `To accept, move this issue to ${accept}. To ask for changes, move it back to an earlier state and comment what should change.`
      : null,
    bullets([...deploymentLines(input.deployment), pullRequestLine(input.pullRequest)]),
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
  readonly e2e: AssistantE2eResult;
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
      input.e2e.humanChecks.length
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
 * What a person asked for when they moved a delivered issue back in Linear:
 * their comments since the e2e card, leaving out the ones T3 posted itself.
 */
export function linearFeedback(input: {
  readonly comments: ReadonlyArray<{ id: string; body: string; createdAt: string }>;
  readonly since: string;
  readonly postedIds: ReadonlyArray<string>;
  readonly stateName: string;
}): string {
  const posted = new Set(input.postedIds);
  const replies = input.comments
    .filter((c) => !posted.has(c.id) && c.createdAt > input.since && c.body.trim())
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((c) => c.body.trim());
  return replies.length
    ? `Requested in Linear (moved to ${input.stateName}):\n\n${replies.join("\n\n")}`
    : `Moved back to ${input.stateName} in Linear without a comment. Ask the person what should change.`;
}
