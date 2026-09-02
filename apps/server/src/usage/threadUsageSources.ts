/**
 * Locating the transcript files that belong to one thread.
 *
 * Pure path and cursor logic; the service around it owns the filesystem.
 *
 * @module threadUsageSources
 */

/**
 * Session ids a Claude thread may have written under, newest intent first.
 *
 * `resume` is the session the next turn will continue, and is what a live
 * thread writes to. `resumeSessionAt` records the session it resumed *from*;
 * it usually has no transcript of its own, but when it does its records belong
 * to the same conversation. Both are returned because reading an extra file
 * costs one miss while skipping a real one silently undercounts, and records
 * copied forward on resume de-duplicate by `dedupeKey` anyway.
 */
export function claudeSessionIdsFromResumeCursor(resumeCursor: unknown): readonly string[] {
  if (!resumeCursor || typeof resumeCursor !== "object" || Array.isArray(resumeCursor)) {
    return [];
  }
  const cursor = resumeCursor as Record<string, unknown>;
  const ids: string[] = [];
  const push = (value: unknown) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    // Session ids name files; anything with a separator would escape the
    // projects directory when joined.
    if (trimmed.length === 0 || trimmed.includes("/") || trimmed.includes("\\")) return;
    if (trimmed === "." || trimmed === "..") return;
    if (!ids.includes(trimmed)) ids.push(trimmed);
  };
  // `resume` is canonical; older cursors wrote `sessionId` instead.
  push(cursor["resume"]);
  push(cursor["sessionId"]);
  push(cursor["resumeSessionAt"]);
  return ids;
}

/** The workspace a thread ran in, used only to rank likely project directories. */
export function cwdFromRuntimePayload(runtimePayload: unknown): string | null {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return null;
  }
  const cwd = (runtimePayload as Record<string, unknown>)["cwd"];
  return typeof cwd === "string" && cwd.length > 0 ? cwd : null;
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
