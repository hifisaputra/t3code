import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { DeveloperAssistantError } from "@t3tools/contracts";
import { ServerConfig } from "../config.ts";
import { imageMimeTypeForFileName } from "../imageMime.ts";

/** Linear's free plan takes at most 10 MB per uploaded file. */
const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;

const VIDEO_MIME_TYPES: Record<string, string> = { ".mp4": "video/mp4", ".webm": "video/webm" };

export type EvidenceKind = "screenshot" | "video";

export interface EvidenceFile {
  /** The resolved file inside the evidence folder. */
  readonly path: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

const kinds: Record<
  EvidenceKind,
  {
    readonly contentType: (fileName: string, extension: string) => string | undefined;
    readonly unreadable: (file: string) => string;
    readonly wrongType: (fileName: string) => string;
    readonly tooLarge: (fileName: string) => string;
  }
> = {
  screenshot: {
    contentType: (fileName) => {
      const contentType = imageMimeTypeForFileName(fileName);
      return contentType === "image/svg+xml" ? undefined : contentType;
    },
    unreadable: (file) =>
      `Could not read the screenshot "${file}". Save PNG, JPEG or WebP files in the issue's evidence folder and pass their absolute paths.`,
    wrongType: (fileName) => `"${fileName}" is not a PNG, JPEG, WebP or GIF screenshot.`,
    tooLarge: (fileName) => `"${fileName}" must be a non-empty image under 10 MB.`,
  },
  video: {
    contentType: (_fileName, extension) => VIDEO_MIME_TYPES[extension],
    unreadable: (file) =>
      `Could not read the recording "${file}". Save MP4 or WebM files in the issue's evidence folder and pass their absolute paths.`,
    wrongType: (fileName) => `"${fileName}" is not an MP4 or WebM recording.`,
    tooLarge: (fileName) =>
      `"${fileName}" must be a non-empty recording under 10 MB, the most Linear takes per file. Record shorter clips, one per criterion, or use a smaller viewport.`,
  },
};

/**
 * Where an e2e tester leaves screenshots and recordings for T3 to put on the
 * Linear issue. The folder sits under T3's state rather than the worktree, so
 * evidence never ends up in a commit, and only files inside it can be read back.
 */
export class AssistantEvidence extends Context.Service<
  AssistantEvidence,
  {
    readonly directory: (taskId: string) => Effect.Effect<string, DeveloperAssistantError>;
    readonly read: (
      taskId: string,
      file: string,
      kind: EvidenceKind,
    ) => Effect.Effect<EvidenceFile, DeveloperAssistantError>;
  }
>()("t3/assistant/AssistantEvidence") {}

export const layer = Layer.effect(
  AssistantEvidence,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { stateDir } = yield* ServerConfig;
    const root = (taskId: string) => path.join(stateDir, "assistant-evidence", taskId);
    return {
      directory: (taskId) =>
        fs.makeDirectory(root(taskId), { recursive: true }).pipe(
          Effect.as(root(taskId)),
          Effect.mapError(
            () => new DeveloperAssistantError({ detail: "Could not create the evidence folder." }),
          ),
        ),
      read: Effect.fn("AssistantEvidence.read")(function* (taskId, file, kind) {
        const texts = kinds[kind];
        const unreadable = () => new DeveloperAssistantError({ detail: texts.unreadable(file) });
        const directory = yield* fs.realPath(root(taskId)).pipe(Effect.mapError(unreadable));
        const resolved = yield* fs
          .realPath(path.isAbsolute(file) ? file : path.join(directory, file))
          .pipe(Effect.mapError(unreadable));
        const relative = path.relative(directory, resolved);
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
          return yield* new DeveloperAssistantError({
            detail: `"${file}" is outside this issue's evidence folder ${directory}.`,
          });
        const fileName = path.basename(resolved);
        const contentType = texts.contentType(fileName, path.extname(fileName).toLowerCase());
        if (!contentType)
          return yield* new DeveloperAssistantError({ detail: texts.wrongType(fileName) });
        const info = yield* fs.stat(resolved).pipe(Effect.mapError(unreadable));
        if (info.type !== "File" || info.size === 0n || info.size > BigInt(MAX_EVIDENCE_BYTES))
          return yield* new DeveloperAssistantError({ detail: texts.tooLarge(fileName) });
        const bytes = yield* fs.readFile(resolved).pipe(Effect.mapError(unreadable));
        return { path: resolved, fileName, contentType, bytes };
      }),
    };
  }),
);
