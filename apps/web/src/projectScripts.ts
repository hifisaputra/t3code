import {
  MAX_SCRIPT_ID_LENGTH,
  SCRIPT_RUN_COMMAND_PATTERN,
  type KeybindingCommand,
  type ProjectScript,
  type ProjectScriptIcon,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
const isScriptRunCommand = Schema.is(SCRIPT_RUN_COMMAND_PATTERN);

function normalizeScriptId(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (cleaned.length === 0) {
    return "script";
  }
  if (cleaned.length <= MAX_SCRIPT_ID_LENGTH) {
    return cleaned;
  }
  return cleaned.slice(0, MAX_SCRIPT_ID_LENGTH).replace(/-+$/g, "") || "script";
}

export const commandForProjectScript = (scriptId: string): KeybindingCommand =>
  SCRIPT_RUN_COMMAND_PATTERN.make(`script.${scriptId}.run`);

export function projectScriptIdFromCommand(command: string): string | null {
  const trimmed = command.trim();
  if (!isScriptRunCommand(trimmed)) {
    return null;
  }
  const [prefix, , suffix] = SCRIPT_RUN_COMMAND_PATTERN.parts;
  return trimmed.slice(prefix.literal.length, -suffix.literal.length);
}

export function nextProjectScriptId(name: string, existingIds: Iterable<string>): string {
  const taken = new Set(Array.from(existingIds));
  const baseId = normalizeScriptId(name);
  if (!taken.has(baseId)) return baseId;

  let suffix = 2;
  while (suffix < 10_000) {
    const candidate = `${baseId}-${suffix}`;
    const safeCandidate =
      candidate.length <= MAX_SCRIPT_ID_LENGTH
        ? candidate
        : `${baseId.slice(0, Math.max(1, MAX_SCRIPT_ID_LENGTH - String(suffix).length - 1))}-${suffix}`;
    if (!taken.has(safeCandidate)) {
      return safeCandidate;
    }
    suffix += 1;
  }

  // This last-resort fallback only triggers after exhausting thousands of suffixes.
  return `${baseId}-${Date.now()}`.slice(0, MAX_SCRIPT_ID_LENGTH);
}

export function primaryProjectScript(scripts: ReadonlyArray<ProjectScript>): ProjectScript | null {
  const regular = scripts.find((script) => !script.runOnWorktreeCreate);
  return regular ?? scripts[0] ?? null;
}

/** A runnable script discovered in a project's package.json. */
export interface PackageScriptSuggestion {
  /** Label used to prefill the action name (e.g. `build` or `web:build`). */
  name: string;
  /** The raw command the script maps to in package.json. */
  script: string;
  /** A ready-to-run shell command (e.g. `npm run build`). */
  command: string;
  /** A best-guess icon based on the script name. */
  icon: ProjectScriptIcon;
  /** Working directory (repo-root-relative) for workspace scripts; omitted for the root. */
  cwd?: string;
  /** The owning workspace package label; omitted for the root package. */
  workspace?: string;
}

/** Map a known package manager name to the command used to run a script. */
function scriptRunnerForPackageManager(packageManager: unknown): string {
  if (typeof packageManager !== "string") return "npm";
  const name = packageManager.split("@", 1)[0]?.trim().toLowerCase();
  if (name === "yarn" || name === "pnpm" || name === "bun") return name;
  return "npm";
}

/** Guess a sensible action icon from a script name. */
function guessScriptIcon(name: string): ProjectScriptIcon {
  const lower = name.toLowerCase();
  if (lower.includes("test")) return "test";
  if (lower.includes("lint") || lower.includes("format") || lower.includes("check")) return "lint";
  if (lower.includes("build") || lower.includes("compile") || lower.includes("bundle"))
    return "build";
  if (lower.includes("debug")) return "debug";
  if (
    lower.includes("dev") ||
    lower.includes("start") ||
    lower.includes("serve") ||
    lower.includes("watch")
  )
    return "play";
  return "configure";
}

function safeParseObject(contents: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  return parsed as Record<string, unknown>;
}

function lastPathSegment(path: string): string {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? path;
}

function buildScriptSuggestions(
  scripts: Record<string, unknown>,
  runner: string,
  workspace: { dir: string; label: string } | null,
): PackageScriptSuggestion[] {
  const suggestions: PackageScriptSuggestion[] = [];
  for (const [rawName, value] of Object.entries(scripts)) {
    if (typeof value !== "string") continue;
    const name = rawName.trim();
    if (name.length === 0) continue;
    if (workspace) {
      suggestions.push({
        name: `${workspace.label}:${name}`,
        script: value,
        command: `${runner} run ${name}`,
        icon: guessScriptIcon(name),
        // Run inside the workspace directory rather than the repo root.
        cwd: workspace.dir,
        workspace: workspace.label,
      });
    } else {
      suggestions.push({
        name,
        script: value,
        command: `${runner} run ${name}`,
        icon: guessScriptIcon(name),
      });
    }
  }
  return suggestions;
}

/** Detect the package-manager run command (`npm`/`yarn`/`pnpm`/`bun`) from a manifest. */
export function detectScriptRunner(contents: string): string {
  const parsed = safeParseObject(contents);
  return parsed ? scriptRunnerForPackageManager(parsed.packageManager) : "npm";
}

/**
 * Parse the `scripts` map out of a package.json file's contents into runnable
 * suggestions. Returns an empty array when the contents are not valid JSON or
 * contain no usable scripts.
 */
export function parsePackageScripts(contents: string): PackageScriptSuggestion[] {
  const parsed = safeParseObject(contents);
  if (!parsed) return [];
  const scripts = parsed.scripts;
  if (typeof scripts !== "object" || scripts === null) return [];
  const runner = scriptRunnerForPackageManager(parsed.packageManager);
  return buildScriptSuggestions(scripts as Record<string, unknown>, runner, null);
}

/**
 * Parse the `scripts` of a workspace member's package.json located at
 * `workspaceDir` (a repo-root-relative POSIX path), producing commands that run
 * inside that directory.
 */
export function parseWorkspacePackageScripts(
  contents: string,
  workspaceDir: string,
  runner: string,
): PackageScriptSuggestion[] {
  const parsed = safeParseObject(contents);
  if (!parsed) return [];
  const scripts = parsed.scripts;
  if (typeof scripts !== "object" || scripts === null) return [];
  const label =
    typeof parsed.name === "string" && parsed.name.trim().length > 0
      ? parsed.name.trim()
      : lastPathSegment(workspaceDir);
  return buildScriptSuggestions(scripts as Record<string, unknown>, runner, {
    dir: workspaceDir,
    label,
  });
}

/** Extract workspace globs from a root package.json's `workspaces` field. */
export function workspaceGlobsFromPackageJson(contents: string): string[] {
  const parsed = safeParseObject(contents);
  if (!parsed) return [];
  const workspaces = parsed.workspaces;
  let list: unknown;
  if (Array.isArray(workspaces)) {
    list = workspaces;
  } else if (
    workspaces !== null &&
    typeof workspaces === "object" &&
    Array.isArray((workspaces as Record<string, unknown>).packages)
  ) {
    list = (workspaces as Record<string, unknown>).packages;
  } else {
    return [];
  }
  return (list as unknown[]).filter((glob): glob is string => typeof glob === "string");
}

function stripYamlScalar(value: string): string {
  const trimmed = value.trim().replace(/\s+#.*$/, "");
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Extract workspace globs from a pnpm-workspace.yaml file (minimal parser). */
export function workspaceGlobsFromPnpmWorkspaceYaml(contents: string): string[] {
  const globs: string[] = [];
  let inPackages = false;
  for (const line of contents.split(/\r?\n/)) {
    if (/^\s*#/.test(line) || line.trim().length === 0) continue;
    const packagesMatch = /^packages:\s*(.*)$/.exec(line);
    if (packagesMatch) {
      const inline = (packagesMatch[1] ?? "").trim();
      if (inline.startsWith("[")) {
        for (const part of inline.replace(/^\[|\]$/g, "").split(",")) {
          const glob = stripYamlScalar(part);
          if (glob.length > 0) globs.push(glob);
        }
        inPackages = false;
      } else {
        inPackages = true;
      }
      continue;
    }
    if (inPackages) {
      const itemMatch = /^\s*-\s*(.+?)\s*$/.exec(line);
      if (itemMatch) {
        const glob = stripYamlScalar(itemMatch[1] ?? "");
        if (glob.length > 0) globs.push(glob);
        continue;
      }
      // A non-indented, non-list line ends the packages block.
      if (/^\S/.test(line)) inPackages = false;
    }
  }
  return globs;
}
