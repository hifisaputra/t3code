import type { AssistantDeployment } from "@t3tools/contracts";

const link = (label: string, url: string) =>
  /^https?:\/\//.test(url) ? `[${label}](${url})` : label;

const host = (url: string) => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};

/**
 * The comment T3 posts on the Linear issue once staging verifies a delivery:
 * the assistant's account of the work, then the facts T3 checked itself, so a
 * reader in Linear sees what changed and where to look without opening T3.
 */
export function deliveryComment(input: {
  readonly comment: string | undefined;
  readonly deployment: AssistantDeployment;
  readonly pullRequest: { readonly number: number; readonly url: string } | null;
}): string {
  const { deployment, pullRequest } = input;
  const facts = [
    `Staging: ${link(host(deployment.url), deployment.url)}`,
    pullRequest ? `Pull request: ${link(`#${pullRequest.number}`, pullRequest.url)}` : null,
    `Verified commit: \`${deployment.revision.slice(0, 7)}\``,
    deployment.evidence?.length
      ? `Deployments: ${deployment.evidence
          .map((entry) => link(entry.targetId, entry.reference))
          .join(", ")}`
      : null,
  ].filter((line): line is string => line !== null);
  const body = input.comment?.trim();
  const footer = facts.map((line) => `- ${line}`).join("\n");
  return body
    ? `${body}\n\n---\n\n**Verified on staging**\n\n${footer}`
    : `**Delivered and verified on staging**\n\n${footer}`;
}

/** A Linear failure's own sentence, which names the fix better than a generic one. */
export function linearFailureDetail(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    if ("detail" in error && typeof error.detail === "string" && error.detail) return error.detail;
    if ("reason" in error && error.reason === "unconfigured") return "Linear is not connected.";
  }
  return "Linear did not accept the request.";
}
