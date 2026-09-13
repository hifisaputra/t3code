import type {
  AssistantCodeReview,
  AssistantDeployment,
  AssistantE2eResult,
  AssistantMerge,
} from "@t3tools/contracts";

/**
 * The comments T3 posts on a managed Linear issue as it moves through its
 * phases: merged after code review, deployed to staging, and the e2e result.
 * The last one is the card a person decides from, so it stands alone.
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
  failed: "**❌ Failed on staging: back with the assistant for a fix**",
};

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
