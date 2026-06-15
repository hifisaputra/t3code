import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ServerConfig } from "../../config.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { WorkspaceEntries } from "../Services/WorkspaceEntries.ts";
import { WorkspaceFileSystem } from "../Services/WorkspaceFileSystem.ts";
import { WorkspaceEntriesLive } from "./WorkspaceEntries.ts";
import { WorkspaceFileSystemLive } from "./WorkspaceFileSystem.ts";
import { WorkspacePathsLive } from "./WorkspacePaths.ts";

const ProjectLayer = WorkspaceFileSystemLive.pipe(
  Layer.provide(WorkspacePathsLive),
  Layer.provide(WorkspaceEntriesLive.pipe(Layer.provide(WorkspacePathsLive))),
);

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(ProjectLayer),
  Layer.provideMerge(WorkspaceEntriesLive.pipe(Layer.provide(WorkspacePathsLive))),
  Layer.provideMerge(WorkspacePathsLive),
  Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-workspace-files-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-workspace-files-",
  });
});

const writeTextFile = Effect.fn("writeTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents = "",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
});

it.layer(TestLayer)("WorkspaceFileSystemLive", (it) => {
  describe("writeFile", () => {
    it.effect("writes files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });
        const saved = yield* fileSystem
          .readFileString(path.join(cwd, "plans/effect-rpc.md"))
          .pipe(Effect.orDie);

        expect(result).toEqual({ relativePath: "plans/effect-rpc.md" });
        expect(saved).toBe("# Plan\n");
      }),
    );

    it.effect("invalidates workspace entry search cache after writes", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries;
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/existing.ts", "export {};\n");

        const beforeWrite = yield* workspaceEntries.search({
          cwd,
          query: "rpc",
          limit: 10,
        });
        expect(beforeWrite).toEqual({
          entries: [],
          truncated: false,
        });

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });

        const afterWrite = yield* workspaceEntries.search({
          cwd,
          query: "rpc",
          limit: 10,
        });
        expect(afterWrite.entries).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: "plans/effect-rpc.md" })]),
        );
        expect(afterWrite.truncated).toBe(false);
      }),
    );

    it.effect("rejects writes outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "../escape.md",
            contents: "# nope\n",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );

        const escapedPath = path.resolve(cwd, "..", "escape.md");
        const escapedStat = yield* fileSystem
          .stat(escapedPath)
          .pipe(Effect.orElseSucceed(() => null));
        expect(escapedStat).toBeNull();
      }),
    );

    it.effect("writes base64-encoded contents as raw bytes", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "assets/logo.png",
          contents: Buffer.from(bytes).toString("base64"),
          encoding: "base64",
        });

        const saved = yield* fileSystem
          .readFile(path.join(cwd, "assets/logo.png"))
          .pipe(Effect.orDie);
        expect([...saved]).toEqual([...bytes]);
      }),
    );
  });

  describe("readFile", () => {
    it.effect("reads text files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/main.ts", "export const answer = 42;\n");

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "src/main.ts",
        });

        expect(result.encoding).toBe("utf8");
        expect(result.contents).toBe("export const answer = 42;\n");
        expect(result.truncated).toBe(false);
        expect(result.byteSize).toBe(26);
        expect(result.relativePath).toBe("src/main.ts");
        expect(result.mediaType).toBeUndefined();
      }),
    );

    it.effect("truncates text files beyond the requested byte cap", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "big.txt", "abcdefgh");

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "big.txt",
          maxBytes: 4,
        });

        expect(result.encoding).toBe("utf8");
        expect(result.contents).toBe("abcd");
        expect(result.truncated).toBe(true);
        expect(result.byteSize).toBe(8);
      }),
    );

    it.effect("returns base64 contents and a media type for images", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
        yield* fileSystem.writeFile(path.join(cwd, "logo.png"), bytes).pipe(Effect.orDie);

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "logo.png",
        });

        expect(result.encoding).toBe("base64");
        expect(result.mediaType).toBe("image/png");
        expect(result.truncated).toBe(false);
        expect(result.contents).toBe(Buffer.from(bytes).toString("base64"));
      }),
    );

    it.effect("rejects reading a directory", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/main.ts", "export {};\n");

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "src" })
          .pipe(Effect.flip);

        expect(error._tag).toBe("WorkspaceFileSystemError");
        if (error._tag === "WorkspaceFileSystemError") {
          expect(error.detail).toContain("directory");
        }
      }),
    );

    it.effect("rejects reads outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "../escape.md" })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );
      }),
    );
  });

  describe("deletePath", () => {
    it.effect("deletes a file", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/old.ts", "export {};\n");

        yield* workspaceFileSystem.deletePath({ cwd, relativePath: "src/old.ts" });

        const exists = yield* fileSystem.exists(path.join(cwd, "src/old.ts")).pipe(Effect.orDie);
        expect(exists).toBe(false);
      }),
    );

    it.effect("deletes a directory recursively", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "pkg/nested/a.ts", "export {};\n");
        yield* writeTextFile(cwd, "pkg/b.ts", "export {};\n");

        yield* workspaceFileSystem.deletePath({ cwd, relativePath: "pkg" });

        const exists = yield* fileSystem.exists(path.join(cwd, "pkg")).pipe(Effect.orDie);
        expect(exists).toBe(false);
      }),
    );

    it.effect("rejects deletes outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;

        const error = yield* workspaceFileSystem
          .deletePath({ cwd, relativePath: "../escape" })
          .pipe(Effect.flip);

        expect(error.message).toContain("must be relative to the project root");
      }),
    );
  });

  describe("createDirectory", () => {
    it.effect("creates nested directories", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;

        const result = yield* workspaceFileSystem.createDirectory({
          cwd,
          relativePath: "src/components",
        });

        expect(result.relativePath).toBe("src/components");
        const stat = yield* fileSystem.stat(path.join(cwd, "src/components")).pipe(Effect.orDie);
        expect(stat.type).toBe("Directory");
      }),
    );

    it.effect("rejects directories outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;

        const error = yield* workspaceFileSystem
          .createDirectory({ cwd, relativePath: "../escape" })
          .pipe(Effect.flip);

        expect(error.message).toContain("must be relative to the project root");
      }),
    );
  });

  describe("movePath", () => {
    it.effect("renames a file within the same directory", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/old.ts", "export const a = 1;\n");

        const result = yield* workspaceFileSystem.movePath({
          cwd,
          fromRelativePath: "src/old.ts",
          toRelativePath: "src/new.ts",
        });

        expect(result).toEqual({ fromRelativePath: "src/old.ts", toRelativePath: "src/new.ts" });
        const oldExists = yield* fileSystem.exists(path.join(cwd, "src/old.ts")).pipe(Effect.orDie);
        const moved = yield* fileSystem
          .readFileString(path.join(cwd, "src/new.ts"))
          .pipe(Effect.orDie);
        expect(oldExists).toBe(false);
        expect(moved).toBe("export const a = 1;\n");
      }),
    );

    it.effect("moves a file into another directory, creating parents", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "a.ts", "export {};\n");

        yield* workspaceFileSystem.movePath({
          cwd,
          fromRelativePath: "a.ts",
          toRelativePath: "lib/nested/a.ts",
        });

        const moved = yield* fileSystem
          .exists(path.join(cwd, "lib/nested/a.ts"))
          .pipe(Effect.orDie);
        expect(moved).toBe(true);
      }),
    );

    it.effect("refuses to overwrite an existing destination", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "a.ts", "a\n");
        yield* writeTextFile(cwd, "b.ts", "b\n");

        const error = yield* workspaceFileSystem
          .movePath({ cwd, fromRelativePath: "a.ts", toRelativePath: "b.ts" })
          .pipe(Effect.flip);

        expect(error._tag).toBe("WorkspaceFileSystemError");
        if (error._tag === "WorkspaceFileSystemError") {
          expect(error.detail).toContain("already exists");
        }
      }),
    );

    it.effect("rejects moves outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "a.ts", "a\n");

        const error = yield* workspaceFileSystem
          .movePath({ cwd, fromRelativePath: "a.ts", toRelativePath: "../escape.ts" })
          .pipe(Effect.flip);

        expect(error.message).toContain("must be relative to the project root");
      }),
    );
  });
});
