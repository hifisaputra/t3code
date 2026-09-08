/**
 * The branch row of the Linear issue dialog.
 *
 * Naming the branch is the one decision in that dialog with a wrong answer, so
 * the option list and the sentence that explains a rejected branch live here
 * rather than inside the component.
 *
 * @module linearIssueThreadDialog.logic
 */
import { linearBranchNamesIssue, normalizeLinearBranchPrefix } from "@t3tools/contracts";

/**
 * The prefixes the dialog offers, in the order they are configured.
 *
 * Spellings that mean the same namespace (`Feat`, `feat/`) collapse into one
 * option. `include` is the prefix the select already holds — a label rule can
 * name a prefix the list never mentions — and is appended when the list does
 * not carry it, so the select is never set to a value it has no item for.
 */
export function linearBranchPrefixOptions(
  prefixes: ReadonlyArray<string>,
  include?: string | null,
): ReadonlyArray<string> {
  const options: Array<string> = [];
  const candidates = include === undefined || include === null ? prefixes : [...prefixes, include];
  for (const candidate of candidates) {
    const prefix = normalizeLinearBranchPrefix(candidate);
    if (prefix.length === 0 || options.includes(prefix)) continue;
    options.push(prefix);
  }
  return options;
}

/**
 * Why the branch in the box cannot be used, or null.
 *
 * Linear links a pull request to its issue by finding the identifier in the
 * branch name, so a branch without it loses every automation the issue would
 * otherwise trigger — silently, which is why the dialog refuses it outright.
 */
export function linearBranchProblem(branch: string, identifier: string): string | null {
  const trimmed = branch.trim();
  if (trimmed.length === 0 || !linearBranchNamesIssue(trimmed, identifier)) {
    return `Must include ${identifier} so Linear links the pull request.`;
  }
  return null;
}

/**
 * The rows the "My issues" list shows for what is in the box.
 *
 * The box doubles as a filter: a word narrows the list by title, and a
 * partial identifier such as `DEL-1` narrows it by identifier, so a list of
 * twenty is scanned by typing rather than by reading. Empty shows all.
 */
export function filterLinearIssues<T extends { identifier: string; title: string }>(
  issues: ReadonlyArray<T>,
  query: string,
): ReadonlyArray<T> {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return issues;
  return issues.filter(
    (issue) =>
      issue.identifier.toLowerCase().includes(needle) || issue.title.toLowerCase().includes(needle),
  );
}

/**
 * The dialog footer's one-line account of what "Start thread" will do.
 *
 * Under `current` the thread is not going anywhere new, so the sentence names
 * the branch it stays on rather than one that is about to be cut — and says so
 * even before the checkout's status has arrived.
 */
export function linearIssueThreadLaunchSummary(input: {
  readonly mode: "local" | "worktree";
  readonly branchMode: "issue" | "current";
  readonly issueBranch: string;
  readonly currentBranch: string | null;
}): string {
  if (input.branchMode === "current") {
    return input.currentBranch === null
      ? "This checkout, on the branch it is already on"
      : `This checkout, staying on ${input.currentBranch}`;
  }
  return `${input.mode === "worktree" ? "New worktree" : "Local checkout"} on ${input.issueBranch}`;
}

const THREAD_TITLE_LIMIT = 80;

/** `DEL-123 Fix login`, cut so the sidebar row stays one line. */
export function linearIssueThreadTitle(issue: {
  readonly identifier: string;
  readonly title: string;
}): string {
  const title = `${issue.identifier} ${issue.title.trim()}`.trim();
  return title.length <= THREAD_TITLE_LIMIT
    ? title
    : `${title.slice(0, THREAD_TITLE_LIMIT).trimEnd()}…`;
}

/**
 * The first message of a thread started from an issue: the kickoff, then the
 * person's own note under it when there is one.
 *
 * The kickoff ends in a blank line that used to leave room for the caret in
 * the composer; the note takes that room now, and without a note the blank
 * line goes.
 */
export function linearIssueThreadMessage(kickoff: string, note: string): string {
  const trimmedNote = note.trim();
  return trimmedNote.length === 0 ? kickoff.trimEnd() : `${kickoff.trimEnd()}\n\n${trimmedNote}`;
}
