import type { ProjectScript } from "@t3tools/contracts";

interface ProjectScriptRuntimeEnvInput {
  project: {
    cwd: string;
  };
  worktreePath?: string | null;
  extraEnv?: Record<string, string>;
}

export function projectScriptCwd(input: {
  project: {
    cwd: string;
  };
  worktreePath?: string | null;
}): string {
  return input.worktreePath ?? input.project.cwd;
}

/**
 * Resolve a script's working directory against the base directory the terminal
 * opens in. A relative `scriptCwd` is joined onto `baseCwd`; an absolute one is
 * returned as-is. An empty/undefined `scriptCwd` runs at `baseCwd`.
 */
export function resolveProjectScriptCwd(baseCwd: string, scriptCwd: string | undefined): string {
  const relative = scriptCwd?.trim();
  if (!relative) return baseCwd;
  if (relative.startsWith("/") || /^[A-Za-z]:[\\/]/.test(relative)) return relative;
  const separator = baseCwd.includes("\\") && !baseCwd.includes("/") ? "\\" : "/";
  const trimmedBase = baseCwd.replace(/[\\/]+$/, "");
  const trimmedRelative = relative.replace(/^\.[\\/]/, "").replace(/^[\\/]+/, "");
  return `${trimmedBase}${separator}${trimmedRelative}`;
}

export function projectScriptRuntimeEnv(
  input: ProjectScriptRuntimeEnvInput,
): Record<string, string> {
  const env: Record<string, string> = {
    T3CODE_PROJECT_ROOT: input.project.cwd,
  };
  if (input.worktreePath) {
    env.T3CODE_WORKTREE_PATH = input.worktreePath;
  }
  if (input.extraEnv) {
    return { ...env, ...input.extraEnv };
  }
  return env;
}

export function setupProjectScript(scripts: readonly ProjectScript[]): ProjectScript | null {
  return scripts.find((script) => script.runOnWorktreeCreate) ?? null;
}
