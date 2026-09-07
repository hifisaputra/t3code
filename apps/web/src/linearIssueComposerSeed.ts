import type { LinearIssueDetail } from "@t3tools/contracts";

/**
 * The ticket, as the composer seeds it when a thread starts from a Linear
 * issue.
 *
 * The block is fenced so the agent reads it as quoted material rather than as
 * the instruction, and tagged `linear-issue` so a skill can find it. Two
 * trailing newlines leave the caret below the block for the person's own
 * instruction.
 *
 * Descriptions and comment threads on a long-running ticket can dwarf the rest
 * of a turn, so both are capped: the agent has `get_issue` (phase 4) or the URL
 * for the rest.
 */

const DESCRIPTION_LIMIT = 6000;
const COMMENTS_LIMIT = 6000;
const TRUNCATION_MARKER = "\n… truncated";

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit).trimEnd()}${TRUNCATION_MARKER}`;
}

/** `2026-09-07` from an ISO timestamp, or the raw value when it is not one. */
function formatDay(createdAt: string): string {
  const parsed = new Date(createdAt);
  return Number.isNaN(parsed.getTime()) ? createdAt : parsed.toISOString().slice(0, 10);
}

/**
 * A fence long enough that nothing inside can close it. Descriptions are
 * markdown written by people who paste code, so three backticks is not safe.
 */
function fenceFor(body: string): string {
  const longestRun = [...body.matchAll(/`+/g)].reduce(
    (longest, match) => Math.max(longest, match[0].length),
    0,
  );
  return "`".repeat(Math.max(3, longestRun + 1));
}

function comment(entry: LinearIssueDetail["comments"][number]): string {
  const author = entry.author?.displayName ?? entry.author?.name ?? "Unknown";
  // Continuation lines are indented so a multi-paragraph comment stays one
  // list item instead of ending the list.
  const body = entry.body.trim().replaceAll("\n", "\n  ");
  return `- **${author}** (${formatDay(entry.createdAt)}): ${body}`;
}

export function formatLinearIssueForComposer(issue: LinearIssueDetail): string {
  const assignee = issue.assignee?.displayName ?? issue.assignee?.name ?? "unassigned";
  const lines = [
    `${issue.identifier}: ${issue.title}`,
    issue.url,
    `State: ${issue.state.name} · Team: ${issue.team.key} · Assignee: ${assignee}`,
  ];

  const description = issue.description?.trim() ?? "";
  if (description.length > 0) {
    lines.push("", truncate(description, DESCRIPTION_LIMIT));
  }

  if (issue.comments.length > 0) {
    const comments = truncate(issue.comments.map(comment).join("\n"), COMMENTS_LIMIT);
    lines.push("", "Comments", comments);
  }

  const body = lines.join("\n");
  const fence = fenceFor(body);
  return `${fence}linear-issue\n${body}\n${fence}\n\n`;
}
