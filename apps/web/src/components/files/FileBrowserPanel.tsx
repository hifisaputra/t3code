import type { EnvironmentId, ProjectEntry } from "@t3tools/contracts";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { Download, RefreshCw, Search, Upload } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { base64ToBytes, bytesToBase64 } from "~/lib/base64";
import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { T3_PIERRE_ICONS } from "~/pierre-icons";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";

import { useProjectEntriesQuery } from "./projectFilesQueryState";

/** Skip uploads larger than this; base64 over the websocket makes big files impractical. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Directory portion of a workspace-relative path ("" for a root-level entry). */
function parentDirectory(relativePath: string): string {
  const separatorIndex = relativePath.lastIndexOf("/");
  return separatorIndex === -1 ? "" : relativePath.slice(0, separatorIndex);
}

/** Final path segment (file name) of a workspace-relative path. */
function baseName(relativePath: string): string {
  const separatorIndex = relativePath.lastIndexOf("/");
  return separatorIndex === -1 ? relativePath : relativePath.slice(separatorIndex + 1);
}

/** Save raw bytes to the client's machine via a temporary object URL. */
function saveBytesAsFile(bytes: Uint8Array<ArrayBuffer>, fileName: string): void {
  const url = URL.createObjectURL(new Blob([bytes]));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

interface FileBrowserPanelProps {
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  onOpenFile: (relativePath: string) => void;
}

const TREE_UNSAFE_CSS = `
  :host {
    --trees-bg-override: transparent;
    --trees-selected-bg-override: color-mix(in srgb, currentColor 12%, transparent);
    --trees-hover-bg-override: color-mix(in srgb, currentColor 7%, transparent);
    --trees-border-color-override: color-mix(in srgb, currentColor 14%, transparent);
    --trees-font-family-override: var(--font-sans);
    --trees-font-size-override: 12px;
  }
  button[data-type='item'] { border-radius: 5px; }
`;

function treePath(entry: ProjectEntry): string {
  return entry.kind === "directory" ? `${entry.path}/` : entry.path;
}

export default function FileBrowserPanel({
  environmentId,
  cwd,
  projectName,
  onOpenFile,
}: FileBrowserPanelProps) {
  const { resolvedTheme } = useTheme();
  const entriesQuery = useProjectEntriesQuery(environmentId, cwd);
  const writeFile = useAtomCommand(projectEnvironment.writeFile);
  const downloadFile = useAtomCommand(projectEnvironment.readFileForDownload);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // Directory (workspace-relative, "" = root) that uploads land in, driven by the tree selection.
  const [uploadDirectory, setUploadDirectory] = useState("");
  // Currently-selected file path (null when a directory or nothing is selected).
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const handleDownload = useCallback(async () => {
    if (!selectedFile) return;
    setIsDownloading(true);
    setDownloadError(null);
    try {
      const result = await downloadFile({
        environmentId,
        input: { cwd, relativePath: selectedFile, encoding: "base64" },
      });
      if (result._tag !== "Success") {
        setDownloadError(`Could not download ${baseName(selectedFile)}.`);
        return;
      }
      if (result.value.truncated) {
        setDownloadError(`${baseName(selectedFile)} is too large to download (over 50MB).`);
        return;
      }
      saveBytesAsFile(base64ToBytes(result.value.contents), baseName(selectedFile));
    } finally {
      setIsDownloading(false);
    }
  }, [cwd, downloadFile, environmentId, selectedFile]);

  const handleUpload = useCallback(
    async (fileList: FileList | null) => {
      const files = fileList ? Array.from(fileList) : [];
      if (files.length === 0) return;
      setIsUploading(true);
      setUploadError(null);
      const skipped: string[] = [];
      try {
        for (const file of files) {
          if (file.size > MAX_UPLOAD_BYTES) {
            skipped.push(file.name);
            continue;
          }
          const bytes = new Uint8Array(await file.arrayBuffer());
          const result = await writeFile({
            environmentId,
            input: {
              cwd,
              relativePath: uploadDirectory ? `${uploadDirectory}/${file.name}` : file.name,
              contents: bytesToBase64(bytes),
              encoding: "base64",
            },
          });
          if (result._tag === "Failure") {
            skipped.push(file.name);
          }
        }
        entriesQuery.refresh();
        setUploadError(
          skipped.length > 0
            ? `Could not upload ${skipped.length === files.length ? "" : "some "}${
                skipped.length === 1 ? "file" : "files"
              }: ${skipped.join(", ")} (over ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB or write failed)`
            : null,
        );
      } finally {
        setIsUploading(false);
      }
    },
    [cwd, entriesQuery, environmentId, uploadDirectory, writeFile],
  );
  const entries = entriesQuery.data?.entries ?? [];
  const entryKinds = useMemo(
    () => new Map(entries.map((entry) => [entry.path, entry.kind] as const)),
    [entries],
  );
  const entryKindsRef = useRef<ReadonlyMap<string, ProjectEntry["kind"]>>(entryKinds);
  const treePaths = useMemo(() => entries.map(treePath), [entries]);
  const previousTreePathsRef = useRef<readonly string[]>([]);

  const { model } = useFileTree({
    density: "compact",
    fileTreeSearchMode: "hide-non-matches",
    flattenEmptyDirectories: true,
    initialExpansion: 1,
    icons: T3_PIERRE_ICONS,
    onSelectionChange: (selectedPaths) => {
      const selectedPath = selectedPaths.at(-1)?.replace(/\/$/, "");
      if (!selectedPath) {
        setUploadDirectory("");
        setSelectedFile(null);
        return;
      }
      const kind = entryKindsRef.current.get(selectedPath);
      if (kind === "file") {
        // Upload alongside the file being viewed; the file itself is downloadable.
        setUploadDirectory(parentDirectory(selectedPath));
        setSelectedFile(selectedPath);
        onOpenFile(selectedPath);
      } else if (kind === "directory") {
        setUploadDirectory(selectedPath);
        setSelectedFile(null);
      }
    },
    paths: [],
    search: true,
    unsafeCSS: TREE_UNSAFE_CSS,
  });

  useEffect(() => {
    if (previousTreePathsRef.current === treePaths) return;
    entryKindsRef.current = entryKinds;
    previousTreePathsRef.current = treePaths;
    model.resetPaths(treePaths);
  }, [entryKinds, model, treePaths]);

  // Reset selection-derived state when switching projects so it never points into a stale tree.
  useEffect(() => {
    setUploadDirectory("");
    setSelectedFile(null);
  }, [cwd]);

  const fileCount = useMemo(
    () => entries.reduce((count, entry) => count + (entry.kind === "file" ? 1 : 0), 0),
    [entries],
  );

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-background"
      data-file-browser-panel={`${environmentId}:${cwd}`}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-foreground">{projectName}</div>
          <div className="truncate text-[10px] leading-none text-muted-foreground">
            {entriesQuery.isPending && entriesQuery.data === null
              ? "Indexing…"
              : `${fileCount.toLocaleString()} files`}
            {entriesQuery.data?.truncated ? " · partial" : ""}
          </div>
        </div>
        <button
          type="button"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Search workspace files"
          onClick={() => model.openSearch()}
        >
          <Search className="size-3.5" />
        </button>
        <input
          ref={uploadInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            void handleUpload(event.target.files);
            event.target.value = "";
          }}
        />
        <button
          type="button"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
          aria-label={`Upload files to ${uploadDirectory ? `${projectName}/${uploadDirectory}` : projectName}`}
          title={`Upload to ${uploadDirectory ? `${uploadDirectory}/` : "project root"}`}
          disabled={isUploading}
          onClick={() => uploadInputRef.current?.click()}
        >
          <Upload className={cn("size-3.5", isUploading && "animate-pulse")} />
        </button>
        <button
          type="button"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
          aria-label={
            selectedFile ? `Download ${baseName(selectedFile)}` : "Select a file to download"
          }
          title={selectedFile ? `Download ${baseName(selectedFile)}` : "Select a file to download"}
          disabled={!selectedFile || isDownloading}
          onClick={() => void handleDownload()}
        >
          <Download className={cn("size-3.5", isDownloading && "animate-pulse")} />
        </button>
        <button
          type="button"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Refresh workspace files"
          onClick={entriesQuery.refresh}
        >
          <RefreshCw className={cn("size-3.5", entriesQuery.isPending && "animate-spin")} />
        </button>
      </div>
      {(uploadError || downloadError) && (
        <div className="shrink-0 border-b border-border/60 px-3 py-1.5 text-[10px] leading-relaxed text-destructive">
          {uploadError ?? downloadError}
        </div>
      )}
      {entriesQuery.error && entriesQuery.data === null ? (
        <div className="p-4 text-xs leading-relaxed text-destructive">{entriesQuery.error}</div>
      ) : (
        <FileTree
          model={model}
          aria-label={`${projectName} files`}
          className="min-h-0 flex-1 overflow-hidden"
          style={{
            colorScheme: resolvedTheme,
            ["--trees-fg-override" as string]: "var(--foreground)",
          }}
        />
      )}
    </div>
  );
}
