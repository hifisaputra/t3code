import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ProjectActionDefinition, type ProjectListActionsResult } from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";

const ProjectActionsConfigFile = Schema.Struct({
  actions: Schema.optional(Schema.Array(ProjectActionDefinition)),
});
const ProjectActionsConfigJson = fromLenientJson(ProjectActionsConfigFile);
const decodeProjectActionsConfigJson = Schema.decodeUnknownEffect(ProjectActionsConfigJson);

const EMPTY_RESULT: ProjectListActionsResult = { actions: [] };

export class ProjectActionsConfigError extends Schema.TaggedErrorClass<ProjectActionsConfigError>()(
  "ProjectActionsConfigError",
  {
    operation: Schema.Literals(["inspect", "read", "decode"]),
    cwd: Schema.String,
    configPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} project actions config at ${this.configPath}.`;
  }
}

export class ProjectActionsConfig extends Context.Service<
  ProjectActionsConfig,
  {
    /** Resolve the repo-defined actions for `cwd`, or an empty list. */
    readonly listActions: (input: { readonly cwd: string }) => Effect.Effect<ProjectListActionsResult>;
  }
>()("t3/project/ProjectActionsConfig") {}

const logProjectActionsConfigError = (error: ProjectActionsConfigError) =>
  Effect.logWarning(error).pipe(
    Effect.annotateLogs({
      operation: error.operation,
      cwd: error.cwd,
      configPath: error.configPath,
      errorTag: error._tag,
    }),
  );

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const findConfigPath = Effect.fn("ProjectActionsConfig.findConfigPath")(function* (cwd: string) {
    let current = cwd;
    while (true) {
      const candidate = path.join(current, ".t3code", "actions.json");
      const exists = yield* fileSystem.exists(candidate).pipe(
        Effect.mapError(
          (cause) =>
            new ProjectActionsConfigError({
              operation: "inspect",
              cwd,
              configPath: candidate,
              cause,
            }),
        ),
        Effect.catchTags({
          ProjectActionsConfigError: (error) =>
            logProjectActionsConfigError(error).pipe(Effect.as(false)),
        }),
      );
      if (exists) {
        return Option.some(candidate);
      }

      const parent = path.dirname(current);
      if (parent === current) {
        return Option.none();
      }
      current = parent;
    }
  });

  const readActions = Effect.fn("ProjectActionsConfig.readActions")(function* (
    cwd: string,
    configPath: string,
  ) {
    const raw = yield* fileSystem.readFileString(configPath).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectActionsConfigError({
            operation: "read",
            cwd,
            configPath,
            cause,
          }),
      ),
    );
    const parsed = yield* decodeProjectActionsConfigJson(raw).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectActionsConfigError({
            operation: "decode",
            cwd,
            configPath,
            cause,
          }),
      ),
    );
    return { actions: parsed.actions ?? [] } satisfies ProjectListActionsResult;
  });

  const listActions: ProjectActionsConfig["Service"]["listActions"] = Effect.fn(
    "ProjectActionsConfig.listActions",
  )(function* (input) {
    return yield* findConfigPath(input.cwd).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(EMPTY_RESULT),
          onSome: (configPath) => readActions(input.cwd, configPath),
        }),
      ),
      Effect.catchTags({
        ProjectActionsConfigError: (error) =>
          logProjectActionsConfigError(error).pipe(Effect.as(EMPTY_RESULT)),
      }),
    );
  });

  return ProjectActionsConfig.of({
    listActions,
  });
});

export const layer = Layer.effect(ProjectActionsConfig, make);
