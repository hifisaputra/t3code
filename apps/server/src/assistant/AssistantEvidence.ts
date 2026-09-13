import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { DeveloperAssistantError } from "@t3tools/contracts";
import { ServerConfig } from "../config.ts";
import { imageMimeTypeForFileName } from "../imageMime.ts";

const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;

export interface EvidenceImage {
  readonly fileName: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

/**
 * Where an e2e tester leaves screenshots for T3 to put on the Linear issue.
 * The folder sits under T3's state rather than the worktree, so evidence never
 * ends up in a commit, and only files inside it can be read back.
 */
export class AssistantEvidence extends Context.Service<
  AssistantEvidence,
  {
    readonly directory: (taskId: string) => Effect.Effect<string, DeveloperAssistantError>;
    readonly read: (
      taskId: string,
      file: string,
    ) => Effect.Effect<EvidenceImage, DeveloperAssistantError>;
  }
>()("t3/assistant/AssistantEvidence") {}

export const layer = Layer.effect(
  AssistantEvidence,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { stateDir } = yield* ServerConfig;
    const root = (taskId: string) => path.join(stateDir, "assistant-evidence", taskId);
    const unreadable = (file: string) =>
      new DeveloperAssistantError({
        detail: `Could not read the screenshot "${file}". Save PNG, JPEG or WebP files in the issue's evidence folder and pass their absolute paths.`,
      });
    return {
      directory: (taskId) =>
        fs.makeDirectory(root(taskId), { recursive: true }).pipe(
          Effect.as(root(taskId)),
          Effect.mapError(
            () => new DeveloperAssistantError({ detail: "Could not create the evidence folder." }),
          ),
        ),
      read: Effect.fn("AssistantEvidence.read")(function* (taskId, file) {
        const directory = yield* fs
          .realPath(root(taskId))
          .pipe(Effect.mapError(() => unreadable(file)));
        const resolved = yield* fs
          .realPath(path.isAbsolute(file) ? file : path.join(directory, file))
          .pipe(Effect.mapError(() => unreadable(file)));
        const relative = path.relative(directory, resolved);
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
          return yield* new DeveloperAssistantError({
            detail: `"${file}" is outside this issue's evidence folder ${directory}.`,
          });
        const fileName = path.basename(resolved);
        const contentType = imageMimeTypeForFileName(fileName);
        if (!contentType || contentType === "image/svg+xml")
          return yield* new DeveloperAssistantError({
            detail: `"${fileName}" is not a PNG, JPEG, WebP or GIF screenshot.`,
          });
        const info = yield* fs.stat(resolved).pipe(Effect.mapError(() => unreadable(file)));
        if (info.type !== "File" || info.size === 0n || info.size > BigInt(MAX_SCREENSHOT_BYTES))
          return yield* new DeveloperAssistantError({
            detail: `"${fileName}" must be a non-empty image under 10 MB.`,
          });
        const bytes = yield* fs.readFile(resolved).pipe(Effect.mapError(() => unreadable(file)));
        return { fileName, contentType, bytes };
      }),
    };
  }),
);
