/**
 * Locating the transcript files that belong to one thread.
 *
 * Pure path and cursor logic; the service around it owns the filesystem.
 *
 * @module threadUsageSources
 */

/** What locating a thread's transcripts needs from one of its provider threads. */
export interface ThreadProviderThreadSource {
  readonly driver: string;
  readonly nativeThreadRef: { readonly nativeId: string | null } | null;
}

/**
 * Claude session ids a thread wrote under, one per Claude provider thread (a
 * fork or provider switch opens another). Ids name transcript files, so one
 * with a path separator, which would escape the projects directory when
 * joined, is skipped.
 */
export function claudeSessionIdsFromProviderThreads(
  providerThreads: ReadonlyArray<ThreadProviderThreadSource>,
  claudeDriver: string,
): readonly string[] {
  const ids: string[] = [];
  for (const providerThread of providerThreads) {
    if (providerThread.driver !== claudeDriver) continue;
    const trimmed = providerThread.nativeThreadRef?.nativeId?.trim() ?? "";
    if (trimmed.length === 0 || trimmed.includes("/") || trimmed.includes("\\")) continue;
    if (trimmed === "." || trimmed === "..") continue;
    if (!ids.includes(trimmed)) ids.push(trimmed);
  }
  return ids;
}

/**
 * Claude's directory name for a workspace.
 *
 * Only a hint: the exact rule is Claude's business and has changed, so callers
 * try this directory first and fall back to searching every project directory
 * rather than trusting it.
 */
export function claudeProjectDirHint(cwd: string): string {
  return cwd.replaceAll(/[/.]/g, "-");
}

/**
 * Orders project directories so the thread's own workspace is examined first.
 *
 * A hit on the first directory ends the search, which is what keeps this from
 * stat-ing every project on a machine with hundreds of them.
 */
export function orderProjectDirs(
  projectDirs: readonly string[],
  cwd: string | null,
): readonly string[] {
  if (cwd === null) return projectDirs;
  const hint = claudeProjectDirHint(cwd);
  const preferred: string[] = [];
  const rest: string[] = [];
  for (const dir of projectDirs) {
    // A worktree or named-agent run appends a suffix to the workspace slug, so
    // prefix matching catches those too.
    (dir === hint || dir.startsWith(`${hint}-`) ? preferred : rest).push(dir);
  }
  return [...preferred, ...rest];
}
