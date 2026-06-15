import * as Schema from "effect/Schema";
import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

const PROJECT_SEARCH_ENTRIES_MAX_LIMIT = 200;
const PROJECT_WRITE_FILE_PATH_MAX_LENGTH = 512;
const PROJECT_LIST_DIRECTORY_PATH_MAX_LENGTH = 512;
const PROJECT_READ_FILE_PATH_MAX_LENGTH = 512;

export const ProjectSearchEntriesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_SEARCH_ENTRIES_MAX_LIMIT)),
});
export type ProjectSearchEntriesInput = typeof ProjectSearchEntriesInput.Type;

const ProjectEntryKind = Schema.Literals(["file", "directory"]);

export const ProjectEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: ProjectEntryKind,
  parentPath: Schema.optional(TrimmedNonEmptyString),
});
export type ProjectEntry = typeof ProjectEntry.Type;

export const ProjectSearchEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type ProjectSearchEntriesResult = typeof ProjectSearchEntriesResult.Type;

export class ProjectSearchEntriesError extends Schema.TaggedErrorClass<ProjectSearchEntriesError>()(
  "ProjectSearchEntriesError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const ProjectWriteFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH)),
  contents: Schema.String,
});
export type ProjectWriteFileInput = typeof ProjectWriteFileInput.Type;

export const ProjectWriteFileResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
});
export type ProjectWriteFileResult = typeof ProjectWriteFileResult.Type;

export class ProjectWriteFileError extends Schema.TaggedErrorClass<ProjectWriteFileError>()(
  "ProjectWriteFileError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const ProjectListDirectoryInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  // Workspace-root-relative POSIX directory path. Omit to list the workspace root.
  relativePath: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_LIST_DIRECTORY_PATH_MAX_LENGTH)),
  ),
});
export type ProjectListDirectoryInput = typeof ProjectListDirectoryInput.Type;

export const ProjectListDirectoryResult = Schema.Struct({
  // Workspace-root-relative POSIX path of the listed directory; omitted for the root.
  relativePath: Schema.optional(TrimmedNonEmptyString),
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type ProjectListDirectoryResult = typeof ProjectListDirectoryResult.Type;

export class ProjectListDirectoryError extends Schema.TaggedErrorClass<ProjectListDirectoryError>()(
  "ProjectListDirectoryError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const ProjectFileEncoding = Schema.Literals(["utf8", "base64"]);
export type ProjectFileEncoding = typeof ProjectFileEncoding.Type;

export const ProjectReadFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_READ_FILE_PATH_MAX_LENGTH)),
  // Optional client-requested read cap; the server clamps this to its own hard limit.
  maxBytes: Schema.optional(PositiveInt),
});
export type ProjectReadFileInput = typeof ProjectReadFileInput.Type;

export const ProjectReadFileResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
  // "utf8" for decoded text, "base64" for binary payloads (images and other binaries).
  encoding: ProjectFileEncoding,
  contents: Schema.String,
  // Full size of the file on disk, regardless of how many bytes were returned.
  byteSize: NonNegativeInt,
  // True when the returned contents were capped below the full file size.
  truncated: Schema.Boolean,
  // Detected media type (e.g. "image/png") when known; used by the viewer for previews.
  mediaType: Schema.optional(TrimmedNonEmptyString),
});
export type ProjectReadFileResult = typeof ProjectReadFileResult.Type;

export class ProjectReadFileError extends Schema.TaggedErrorClass<ProjectReadFileError>()(
  "ProjectReadFileError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
