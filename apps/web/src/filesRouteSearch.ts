export interface FilesRouteSearch {
  files?: "1" | undefined;
  filePath?: string | undefined;
  filesFull?: "1" | undefined;
}

function isFilesOpenValue(value: unknown): boolean {
  return value === "1" || value === 1 || value === true;
}

function normalizeSearchString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function stripFilesSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<T, "files" | "filePath" | "filesFull"> {
  const { files: _files, filePath: _filePath, filesFull: _filesFull, ...rest } = params;
  return rest as Omit<T, "files" | "filePath" | "filesFull">;
}

export function parseFilesRouteSearch(search: Record<string, unknown>): FilesRouteSearch {
  const files = isFilesOpenValue(search.files) ? "1" : undefined;
  const filePath = files ? normalizeSearchString(search.filePath) : undefined;
  const filesFull = files && isFilesOpenValue(search.filesFull) ? "1" : undefined;

  return {
    ...(files ? { files } : {}),
    ...(filePath ? { filePath } : {}),
    ...(filesFull ? { filesFull } : {}),
  };
}
