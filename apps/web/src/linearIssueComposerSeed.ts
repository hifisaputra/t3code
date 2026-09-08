import {
  isProviderSkillUserInvocable,
  resolveProviderSkillsForCwd,
} from "@t3tools/client-runtime/providerSkills";
import type { LinearIssueDetail, ServerProvider } from "@t3tools/contracts";

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
 * of a turn, so both are capped: the agent has the URL for the rest. Only the
 * no-tools kickoff quotes this; see {@link formatLinearIssueKickoff}.
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

/** The runbook a thread started from an issue should follow when it is installed. */
export const LINEAR_WORK_SKILL_NAME = "linear-work";

const INSTRUCTION =
  "Restate what done looks like in one to three lines. If a product decision is missing or the brief is unclear, ask me and stop. Otherwise start.";

/**
 * Whether any provider on this server can run the `linear-work` skill, so the
 * kickoff may mention it.
 *
 * A mention only dispatches for a skill the provider actually discovered and
 * left invocable (see `planClaudeSkillDispatch` on the server); an unknown
 * `$name` stays literal text in the prompt, which reads as noise.
 */
export function hasLinearWorkSkill(
  providers: ReadonlyArray<ServerProvider>,
  cwd?: string | null,
): boolean {
  return providers.some((provider) =>
    resolveProviderSkillsForCwd(provider, cwd).some(
      (skill) =>
        skill.name.trim().toLowerCase() === LINEAR_WORK_SKILL_NAME &&
        isProviderSkillUserInvocable(skill),
    ),
  );
}

/**
 * What the composer seeds when a thread starts from a Linear issue: an
 * instruction to work the ticket, not the ticket itself.
 *
 * The skill mention leads the prompt because Claude Code turns the last known
 * `$name` into `/name <everything after it>`, and that trailing text becomes
 * the skill's ARGUMENTS. Putting the identifier and URL on the mention's own
 * line and the line below hands the skill the issue it is about.
 *
 * The fenced ticket (see {@link formatLinearIssueForComposer}) only comes back
 * when the agent has no Linear tools: with `get_issue` and `list_comments` the
 * agent reads a fresher, complete ticket itself, and quoting a capped copy in
 * the prompt would only spend the turn's context on a worse one.
 *
 * Two trailing newlines leave the caret below for the person's own note.
 */
export function formatLinearIssueKickoff(
  issue: LinearIssueDetail,
  options: { agentTools: boolean; skill: boolean },
): string {
  const heading = options.skill
    ? `$${LINEAR_WORK_SKILL_NAME} ${issue.identifier}: ${issue.title}`
    : `Work on Linear issue ${issue.identifier}: ${issue.title}`;
  const lines = [heading, issue.url];

  if (options.agentTools) {
    if (!options.skill) {
      lines.push(
        "",
        `Read the issue and its comments with the get_issue and list_comments tools before doing anything else. ${INSTRUCTION}`,
      );
    }
    return `${lines.join("\n")}\n\n`;
  }

  if (!options.skill) {
    lines.push("", `The ticket is quoted below. ${INSTRUCTION}`);
  }
  return `${lines.join("\n")}\n\n${formatLinearIssueForComposer(issue)}`;
}
