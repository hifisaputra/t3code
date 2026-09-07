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
