// @effect-diagnostics nodeBuiltinImport:off
import fsPromises from "node:fs/promises";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  WorkspaceFileSystem,
  WorkspaceFileSystemError,
  type WorkspaceFileSystemShape,
} from "../Services/WorkspaceFileSystem.ts";
import { WorkspaceEntries } from "../Services/WorkspaceEntries.ts";
import { WorkspacePaths } from "../Services/WorkspacePaths.ts";
import { IMAGE_EXTENSION_BY_MIME_TYPE, SAFE_IMAGE_FILE_EXTENSIONS } from "../../imageMime.ts";

const DEFAULT_READ_MAX_BYTES = 1024 * 1024; // 1 MiB
const HARD_READ_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB
const BINARY_SNIFF_BYTES = 8_000;

const IMAGE_MEDIA_TYPE_BY_EXTENSION: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const [mimeType, extension] of Object.entries(IMAGE_EXTENSION_BY_MIME_TYPE)) {
    map[extension] = mimeType;
  }
  map[".ico"] = "image/x-icon";
  return map;
})();

function detectImageMediaType(relativePath: string): string | undefined {
  const match = /\.[a-z0-9]+$/i.exec(relativePath);
  if (!match) {
    return undefined;
  }
  const extension = match[0].toLowerCase();
  if (!SAFE_IMAGE_FILE_EXTENSIONS.has(extension)) {
    return undefined;
  }
  return IMAGE_MEDIA_TYPE_BY_EXTENSION[extension];
}

function isProbablyBinary(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, BINARY_SNIFF_BYTES);
  for (let index = 0; index < limit; index += 1) {
    if (buffer[index] === 0) {
      return true;
    }
  }
  return false;
}

export const makeWorkspaceFileSystem = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries;

  const writeFile: WorkspaceFileSystemShape["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    yield* fileSystem.makeDirectory(path.dirname(target.absolutePath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.makeDirectory",
            detail: cause.message,
            cause,
          }),
      ),
    );
    yield* fileSystem.writeFileString(target.absolutePath, input.contents).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.writeFile",
            detail: cause.message,
            cause,
          }),
      ),
    );
    yield* workspaceEntries.invalidate(input.cwd);
    return { relativePath: target.relativePath };
  });

  const readFile: WorkspaceFileSystemShape["readFile"] = Effect.fn("WorkspaceFileSystem.readFile")(
    function* (input) {
      const target = yield* workspacePaths.resolveRelativePathWithinRoot({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
      });

      const requestedMaxBytes = input.maxBytes ?? DEFAULT_READ_MAX_BYTES;
      const maxBytes = Math.min(Math.max(1, requestedMaxBytes), HARD_READ_MAX_BYTES);

      const read = yield* Effect.tryPromise({
        try: async () => {
          const handle = await fsPromises.open(target.absolutePath, "r");
          try {
            const stat = await handle.stat();
            if (stat.isDirectory()) {
              return { kind: "directory" as const };
            }
            const byteSize = stat.size;
            const bytesToRead = Math.min(byteSize, maxBytes);
            const buffer = Buffer.alloc(bytesToRead);
            if (bytesToRead > 0) {
              await handle.read(buffer, 0, bytesToRead, 0);
            }
            return {
              kind: "file" as const,
              buffer,
              byteSize,
              truncated: byteSize > bytesToRead,
            };
          } finally {
            await handle.close();
          }
        },
        catch: (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.readFile",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });

      if (read.kind === "directory") {
        return yield* new WorkspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "workspaceFileSystem.readFile",
          detail: "Path refers to a directory, not a file.",
        });
      }

      const mediaType = detectImageMediaType(target.relativePath);
      const isBinary = mediaType !== undefined || isProbablyBinary(read.buffer);

      if (isBinary) {
        return {
          relativePath: target.relativePath,
          encoding: "base64" as const,
          contents: read.buffer.toString("base64"),
          byteSize: read.byteSize,
          truncated: read.truncated,
          ...(mediaType ? { mediaType } : {}),
        };
      }

      return {
        relativePath: target.relativePath,
        encoding: "utf8" as const,
        contents: read.buffer.toString("utf8"),
        byteSize: read.byteSize,
        truncated: read.truncated,
      };
    },
  );

  return { writeFile, readFile } satisfies WorkspaceFileSystemShape;
});

export const WorkspaceFileSystemLive = Layer.effect(WorkspaceFileSystem, makeWorkspaceFileSystem);
