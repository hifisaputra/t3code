import { assert, it, describe } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";

import * as ProjectActionsConfig from "./ProjectActionsConfig.ts";

const TestLayer = ProjectActionsConfig.layer.pipe(
  Layer.provide(NodeServices.layer),
  Layer.provideMerge(NodeServices.layer),
);

describe("ProjectActionsConfig", () => {
  it.layer(TestLayer)("returns an empty list when no config exists", (it) => {
    it.effect("returns no actions", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-actions-config-test-",
        });
        const config = yield* ProjectActionsConfig.ProjectActionsConfig;
        const result = yield* config.listActions({ cwd: root });

        assert.deepEqual(result.actions, []);
      }),
    );
  });

  it.layer(TestLayer)("discovers .t3code/actions.json from nested workspaces", (it) => {
    it.effect("returns the configured actions", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-actions-config-test-",
        });
        const configDir = path.join(root, ".t3code");
        const nested = path.join(root, "packages", "app");
        yield* fileSystem.makeDirectory(configDir, { recursive: true });
        yield* fileSystem.makeDirectory(nested, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(configDir, "actions.json"),
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          JSON.stringify({
            actions: [
              { label: "Run tests", command: "pnpm test" },
              { label: "Dev", command: "pnpm dev", cwd: "apps/web" },
            ],
          }),
        );

        const config = yield* ProjectActionsConfig.ProjectActionsConfig;
        const result = yield* config.listActions({ cwd: nested });

        assert.equal(result.actions.length, 2);
        assert.deepEqual(result.actions[0], { label: "Run tests", command: "pnpm test" });
        assert.deepEqual(result.actions[1], {
          label: "Dev",
          command: "pnpm dev",
          cwd: "apps/web",
        });
      }),
    );
  });

  it.layer(TestLayer)("treats a missing actions array as empty", (it) => {
    it.effect("returns no actions", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-actions-config-test-",
        });
        const configDir = path.join(root, ".t3code");
        yield* fileSystem.makeDirectory(configDir, { recursive: true });
        yield* fileSystem.writeFileString(path.join(configDir, "actions.json"), "{}");

        const config = yield* ProjectActionsConfig.ProjectActionsConfig;
        const result = yield* config.listActions({ cwd: root });

        assert.deepEqual(result.actions, []);
      }),
    );
  });

  it.layer(TestLayer)("falls back to empty when config JSON is malformed", (it) => {
    it.effect("returns empty and logs the decode failure", () => {
      const messages: unknown[] = [];
      const logger = Logger.make<unknown, void>(({ message }) => {
        messages.push(message);
      });

      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-actions-config-test-",
        });
        const configDir = path.join(root, ".t3code");
        yield* fileSystem.makeDirectory(configDir, { recursive: true });
        yield* fileSystem.writeFileString(path.join(configDir, "actions.json"), "{not json");

        const config = yield* ProjectActionsConfig.ProjectActionsConfig;
        const result = yield* config.listActions({ cwd: root });

        assert.deepEqual(result.actions, []);
        const [error] = messages[0] as ReadonlyArray<unknown>;
        assert.instanceOf(error, ProjectActionsConfig.ProjectActionsConfigError);
        assert.equal(
          error.message,
          "Failed to decode project actions config at " +
            path.join(configDir, "actions.json") +
            ".",
        );
        assert.deepInclude(error, {
          operation: "decode",
          cwd: root,
          configPath: path.join(configDir, "actions.json"),
          _tag: "ProjectActionsConfigError",
        });
      }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
    });
  });

  it.layer(TestLayer)("falls back to empty when an action entry is invalid", (it) => {
    it.effect("returns empty (a malformed entry fails the whole decode)", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-actions-config-test-",
        });
        const configDir = path.join(root, ".t3code");
        yield* fileSystem.makeDirectory(configDir, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(configDir, "actions.json"),
          // missing required `command`
          `{"actions":[{"label":"Broken"}]}`,
        );

        const config = yield* ProjectActionsConfig.ProjectActionsConfig;
        const result = yield* config.listActions({ cwd: root });

        assert.deepEqual(result.actions, []);
      }),
    );
  });
});
