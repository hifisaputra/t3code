/**
 * Linear issue references as a person writes them: the bare identifier, the
 * `#`-prefixed one a chat client autolinks, or the URL copied out of Linear.
 *
 * Everything resolves to the upper-cased identifier (`DEL-123`) because that is
 * what `linear.getIssue` and `linear.prepareIssueThread` take. A pull request
 * reference must not parse here — the branch menu offers both entries off the
 * same typed text, so an overlap would offer the wrong one.
 */

/** `DEL-123`, optionally `#`-prefixed. Team keys are letters and digits. */
const ISSUE_IDENTIFIER_PATTERN = /^#?([A-Za-z][A-Za-z0-9]*-\d+)$/;

/** `https://linear.app/<workspace>/issue/DEL-123[/<slug>][/?#…]` */
const ISSUE_URL_PATTERN =
  /^https:\/\/linear\.app\/[^/\s]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:\/[^?#\s]*)?(?:[?#].*)?$/;

/** True when the input is a Linear issue URL, whichever form the identifier takes. */
export function isLinearIssueUrl(input: string): boolean {
  return ISSUE_URL_PATTERN.test(input.trim());
}

/**
 * The issue identifier behind a reference, upper-cased, or null when the input
 * is not one.
 */
export function parseLinearIssueReference(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const urlMatch = ISSUE_URL_PATTERN.exec(trimmed);
  if (urlMatch?.[1]) {
    return urlMatch[1].toUpperCase();
  }

  const identifierMatch = ISSUE_IDENTIFIER_PATTERN.exec(trimmed);
  if (identifierMatch?.[1]) {
    return identifierMatch[1].toUpperCase();
  }

  return null;
}
