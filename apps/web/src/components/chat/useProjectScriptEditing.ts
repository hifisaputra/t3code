import type {
  KeybindingCommand,
  ProjectId,
  ProjectScript,
  EnvironmentId,
} from "@t3tools/contracts";
import { AuthSettingsWriteScope, EnvironmentAuthorizationError } from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import {
  executeAtomQuery,
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { resolveProjectScripts } from "@t3tools/shared/projectScripts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  decodeProjectScriptKeybindingRule,
  keybindingValueForCommand,
} from "../../lib/projectScriptKeybindings";
import {
  buildProjectScript,
  commandForProjectScript,
  detectScriptRunner,
  nextProjectScriptId,
  parsePackageScripts,
  parseWorkspacePackageScripts,
  projectScriptIdFromCommand,
  releaseClaimedRoles,
  workspaceGlobsFromPackageJson,
  workspaceGlobsFromPnpmWorkspaceYaml,
  type PackageScriptSuggestion,
} from "../../projectScripts";
import {
  getProjectEntriesQueryAtom,
  getProjectFileQueryAtom,
} from "../files/projectFilesQueryState";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useProjects } from "../../state/entities";
import { type NewProjectScriptInput } from "../ProjectScriptsControl";
import { stackedThreadToast, toastManager } from "../ui/toast";

// Cap how many workspace package.json manifests we read when auto-detecting scripts.
const MAX_WORKSPACE_PACKAGES = 100;

/**
 * Suggests scripts from the project's package.json and its workspace packages'
 * manifests, so the script editor can offer them instead of a blank command.
 */
async function loadPackageScriptSuggestions(
  environmentId: EnvironmentId,
  cwd: string,
): Promise<PackageScriptSuggestion[]> {
  const readText = async (relativePath: string): Promise<string | null> => {
    const result = await executeAtomQuery(
      appAtomRegistry,
      getProjectFileQueryAtom(environmentId, cwd, relativePath),
      { reportDefect: false, reportFailure: false },
    );
    return Option.getOrNull(AsyncResult.value(result))?.contents ?? null;
  };

  const rootManifest = await readText("package.json");
  if (rootManifest === null) return [];

  const suggestions = parsePackageScripts(rootManifest);

  // Gather workspace globs from package.json `workspaces` and pnpm-workspace.yaml.
  const globs = new Set(workspaceGlobsFromPackageJson(rootManifest));
  const pnpmWorkspace = await readText("pnpm-workspace.yaml");
  if (pnpmWorkspace) {
    for (const glob of workspaceGlobsFromPnpmWorkspaceYaml(pnpmWorkspace)) globs.add(glob);
  }
  if (globs.size === 0) return suggestions;

  // The workspace listing is a recursive, gitignore-aware tree, so resolve globs against it
  // rather than listing each base directory separately.
  const listing = await executeAtomQuery(
    appAtomRegistry,
    getProjectEntriesQueryAtom(environmentId, cwd),
    { reportDefect: false, reportFailure: false },
  );
  const directoryPaths = (Option.getOrNull(AsyncResult.value(listing))?.entries ?? [])
    .filter((entry) => entry.kind === "directory")
    .map((entry) => entry.path.replace(/\/+$/, ""));

  const candidateDirs = new Set<string>();
  for (const raw of globs) {
    const glob = raw.trim().replace(/\/+$/, "");
    if (glob.length === 0 || glob.startsWith("!")) continue;
    const starIndex = glob.indexOf("*");
    if (starIndex === -1) {
      candidateDirs.add(glob);
      continue;
    }
    // Glob like `packages/*`: match direct children of the base directory.
    const base = glob.slice(0, starIndex).replace(/\/+$/, "");
    for (const dir of directoryPaths) {
      if (base.length === 0) {
        if (!dir.includes("/")) candidateDirs.add(dir);
      } else if (dir.startsWith(`${base}/`)) {
        const remainder = dir.slice(base.length + 1);
        if (remainder.length > 0 && !remainder.includes("/")) candidateDirs.add(dir);
      }
    }
  }

  const runner = detectScriptRunner(rootManifest);
  const workspaceSuggestions = await Promise.all(
    [...candidateDirs].slice(0, MAX_WORKSPACE_PACKAGES).map(async (dir) => {
      const manifest = await readText(`${dir}/package.json`);
      return manifest ? parseWorkspacePackageScripts(manifest, dir, runner) : [];
    }),
  );
  for (const list of workspaceSuggestions) suggestions.push(...list);
  return suggestions;
}

/**
 * Adds, edits, and deletes the active project's scripts. A script's keyboard
 * shortcut lives in the environment's keybindings, so each change writes the
 * script settings first and then reconciles the shortcut.
 */
export function useProjectScriptEditing(input: {
  readonly environmentId: EnvironmentId;
  readonly project: EnvironmentProject | null;
  readonly scripts: ReadonlyArray<ProjectScript>;
  readonly settings: UnifiedSettings;
}) {
  const { environmentId, project, scripts, settings } = input;
  const allProjects = useProjects();
  const updateProjectScriptSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  const upsertKeybinding = useAtomCommand(serverEnvironment.upsertKeybinding, {
    reportFailure: false,
  });
  const removeKeybinding = useAtomCommand(serverEnvironment.removeKeybinding, {
    reportFailure: false,
  });
  const persistProjectScripts = async (input: {
    projectId: ProjectId;
    projectCwd: string;
    previousScripts: ReadonlyArray<ProjectScript>;
    nextScripts: ReadonlyArray<ProjectScript>;
    keybinding: NewProjectScriptInput["keybinding"];
    keybindingCommand: KeybindingCommand | null;
  }): Promise<AtomCommandResult<void, unknown>> => {
    const serverConfig = appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId));
    const previousKeybinding = keybindingValueForCommand(
      serverConfig?.keybindings ?? [],
      input.keybindingCommand,
    );
    const isDeletingScript = !input.nextScripts.some(
      (script) => commandForProjectScript(script.id) === input.keybindingCommand,
    );
    const changesKeybinding =
      input.keybinding !== undefined &&
      (input.keybinding?.trim() || null) !== previousKeybinding &&
      (!isDeletingScript || readEnvironmentScope(environmentId, AuthSettingsWriteScope));
    if (changesKeybinding && !readEnvironmentScope(environmentId, AuthSettingsWriteScope)) {
      return AsyncResult.failure(
        Cause.fail(
          new EnvironmentAuthorizationError({
            requiredScope: AuthSettingsWriteScope,
            message: "This connection cannot change keyboard shortcuts.",
          }),
        ),
      );
    }
    const keybindingRule = changesKeybinding
      ? decodeProjectScriptKeybindingRule({
          keybinding: input.keybinding,
          command: input.keybindingCommand,
        })
      : null;
    const updateResult = mapAtomCommandResult(
      await updateProjectScriptSettings({
        environmentId,
        input: {
          patch:
            serverConfig?.environment.capabilities.projectSettingsOverrides === true
              ? {
                  projectSettingsOverrides: {
                    [input.projectId]: {
                      ...settings.projectSettingsOverrides[input.projectId],
                      defaultProjectScripts: input.nextScripts,
                    },
                  },
                }
              : {
                  projectScriptOverrides: {
                    [input.projectId]: input.nextScripts,
                  },
                },
        },
      }),
      () => undefined,
    );
    if (updateResult._tag === "Failure") {
      return updateResult;
    }

    if (!changesKeybinding) return updateResult;
    if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope)) {
      return AsyncResult.failure(
        Cause.fail(
          new EnvironmentAuthorizationError({
            requiredScope: AuthSettingsWriteScope,
            message: isDeletingScript
              ? "The script was deleted, but its keyboard shortcut could not be removed because permission changed."
              : "The script was saved, but this connection can no longer change keyboard shortcuts.",
          }),
        ),
      );
    }

    const scriptId = input.keybindingCommand
      ? projectScriptIdFromCommand(input.keybindingCommand)
      : null;
    if (!keybindingRule && !input.previousScripts.some((script) => script.id === scriptId)) {
      return updateResult;
    }
    const retainedElsewhere =
      !input.nextScripts.some((script) => script.id === scriptId) &&
      (settings.defaultProjectScripts.some((script) => script.id === scriptId) ||
        Object.entries(settings.projectSettingsOverrides).some(
          ([projectId, entry]) =>
            projectId !== input.projectId &&
            entry.defaultProjectScripts?.some((script) => script.id === scriptId),
        ) ||
        allProjects.some(
          (other) =>
            other.environmentId === environmentId &&
            other.id !== input.projectId &&
            resolveProjectScripts(settings, other).some((script) => script.id === scriptId),
        ));
    if (!keybindingRule && retainedElsewhere) return updateResult;

    const previousRules = (serverConfig?.keybindings ?? []).flatMap((binding) => {
      if (binding.command !== input.keybindingCommand || binding.whenAst) return [];
      const previous = decodeProjectScriptKeybindingRule({
        keybinding: keybindingValueForCommand([binding], input.keybindingCommand),
        command: input.keybindingCommand,
      });
      return previous ? [previous] : [];
    });
    const previous = previousRules.at(-1);
    for (const rule of keybindingRule ? previousRules.slice(0, -1) : previousRules) {
      const result = await removeKeybinding({ environmentId, input: rule });
      if (result._tag === "Failure") return mapAtomCommandResult(result, () => undefined);
    }
    return keybindingRule
      ? mapAtomCommandResult(
          await upsertKeybinding({
            environmentId,
            input:
              previous && previous.key !== keybindingRule.key
                ? { ...keybindingRule, replace: previous }
                : keybindingRule,
          }),
          () => undefined,
        )
      : updateResult;
  };
  const saveProjectScript = async (
    input: NewProjectScriptInput,
  ): Promise<AtomCommandResult<void, unknown>> => {
    if (!project) {
      return AsyncResult.success(undefined);
    }
    const nextId = nextProjectScriptId(
      input.name,
      scripts.map((script) => script.id),
    );
    const nextScript = buildProjectScript(nextId, input);
    const nextScripts = [
      ...scripts.map((script) => releaseClaimedRoles(script, input)),
      nextScript,
    ];

    return persistProjectScripts({
      projectId: project.id,
      projectCwd: project.workspaceRoot,
      previousScripts: scripts,
      nextScripts,
      keybinding: input.keybinding,
      keybindingCommand: commandForProjectScript(nextId),
    });
  };
  const updateProjectScript = async (
    scriptId: string,
    input: NewProjectScriptInput,
  ): Promise<AtomCommandResult<void, unknown>> => {
    if (!project) {
      return AsyncResult.success(undefined);
    }
    const existingScript = scripts.find((script) => script.id === scriptId);
    if (!existingScript) {
      return AsyncResult.failure(Cause.fail(new Error("Script not found.")));
    }

    const updatedScript = buildProjectScript(existingScript.id, input);
    const nextScripts = scripts.map((script) =>
      script.id === scriptId ? updatedScript : releaseClaimedRoles(script, input),
    );

    return persistProjectScripts({
      projectId: project.id,
      projectCwd: project.workspaceRoot,
      previousScripts: scripts,
      nextScripts,
      keybinding: input.keybinding,
      keybindingCommand: commandForProjectScript(scriptId),
    });
  };
  const deleteProjectScript = async (
    scriptId: string,
  ): Promise<AtomCommandResult<void, unknown>> => {
    if (!project) {
      return AsyncResult.success(undefined);
    }
    const nextScripts = scripts.filter((script) => script.id !== scriptId);

    const deletedName = scripts.find((s) => s.id === scriptId)?.name;

    const result = await persistProjectScripts({
      projectId: project.id,
      projectCwd: project.workspaceRoot,
      previousScripts: scripts,
      nextScripts,
      keybinding: null,
      keybindingCommand: commandForProjectScript(scriptId),
    });
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: `Deleted action "${deletedName ?? "Unknown"}"`,
      });
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not delete action",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        }),
      );
    }
    return result;
  };
  const loadPackageScripts = async (): Promise<PackageScriptSuggestion[]> =>
    project ? loadPackageScriptSuggestions(environmentId, project.workspaceRoot) : [];
  return {
    loadPackageScripts: useStableCallback(loadPackageScripts),
    saveProjectScript: useStableCallback(saveProjectScript),
    updateProjectScript: useStableCallback(updateProjectScript),
    deleteProjectScript: useStableCallback(deleteProjectScript),
  };
}
