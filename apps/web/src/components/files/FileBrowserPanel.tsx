import type { EnvironmentId, ProjectEntry } from "@t3tools/contracts";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { FolderPlus, Pencil, RefreshCw, Search, Trash2, Upload } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { T3_PIERRE_ICONS } from "~/pierre-icons";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";

import { useProjectEntriesQuery } from "./projectFilesQueryState";

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

/** Parent directory of a workspace-relative path ("" when at the root). */
function parentDir(relativePath: string): string {
  const slash = relativePath.lastIndexOf("/");
  return slash === -1 ? "" : relativePath.slice(0, slash);
}

/** Join a workspace-relative directory with a child name. */
function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** Base64-encode a File without overflowing the call stack on large inputs. */
async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export default function FileBrowserPanel({
  environmentId,
  cwd,
  projectName,
  onOpenFile,
}: FileBrowserPanelProps) {
  const { resolvedTheme } = useTheme();
  const entriesQuery = useProjectEntriesQuery(environmentId, cwd);
  const entries = entriesQuery.data?.entries ?? [];
  const entryKinds = useMemo(
    () => new Map(entries.map((entry) => [entry.path, entry.kind] as const)),
    [entries],
  );
  const entryKindsRef = useRef<ReadonlyMap<string, ProjectEntry["kind"]>>(entryKinds);
  const treePaths = useMemo(() => entries.map(treePath), [entries]);
  const previousTreePathsRef = useRef<readonly string[]>([]);

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedKind, setSelectedKind] = useState<ProjectEntry["kind"] | null>(null);
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement>(null);

  const createDirectory = useAtomCommand(projectEnvironment.createDirectory);
  const deletePath = useAtomCommand(projectEnvironment.deletePath);
  const movePath = useAtomCommand(projectEnvironment.movePath);
  const writeFile = useAtomCommand(projectEnvironment.writeFile);

  const { model } = useFileTree({
    density: "compact",
    fileTreeSearchMode: "hide-non-matches",
    flattenEmptyDirectories: true,
    initialExpansion: 1,
    icons: T3_PIERRE_ICONS,
    onSelectionChange: (selectedPaths) => {
      const raw = selectedPaths.at(-1);
      if (!raw) {
        setSelectedPath(null);
        setSelectedKind(null);
        return;
      }
      const cleaned = raw.replace(/\/$/, "");
      const kind = entryKindsRef.current.get(cleaned) ?? null;
      setSelectedPath(cleaned);
      setSelectedKind(kind);
      if (kind === "file") {
        onOpenFile(cleaned);
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

  const fileCount = useMemo(
    () => entries.reduce((count, entry) => count + (entry.kind === "file" ? 1 : 0), 0),
    [entries],
  );

  // Where new folders / uploads land: inside the selected directory, the
  // selected file's parent, or the workspace root.
  const targetDir = useMemo(() => {
    if (!selectedPath) return "";
    return selectedKind === "directory" ? selectedPath : parentDir(selectedPath);
  }, [selectedKind, selectedPath]);

  const submitNewFolder = useCallback(async () => {
    const name = folderName.trim();
    if (!name || busy) return;
    setBusy(true);
    await createDirectory({
      environmentId,
      input: { cwd, relativePath: joinPath(targetDir, name) },
    });
    setBusy(false);
    setFolderName("");
    setFolderDialogOpen(false);
    entriesQuery.refresh();
  }, [busy, createDirectory, cwd, entriesQuery, environmentId, folderName, targetDir]);

  const submitRename = useCallback(async () => {
    const to = renameValue.trim();
    if (!selectedPath || !to || to === selectedPath || busy) return;
    setBusy(true);
    await movePath({
      environmentId,
      input: { cwd, fromRelativePath: selectedPath, toRelativePath: to },
    });
    setBusy(false);
    setRenameDialogOpen(false);
    entriesQuery.refresh();
  }, [busy, cwd, entriesQuery, environmentId, movePath, renameValue, selectedPath]);

  const confirmDelete = useCallback(async () => {
    if (!selectedPath || busy) return;
    setBusy(true);
    await deletePath({ environmentId, input: { cwd, relativePath: selectedPath } });
    setBusy(false);
    setDeleteDialogOpen(false);
    setSelectedPath(null);
    setSelectedKind(null);
    entriesQuery.refresh();
  }, [busy, cwd, deletePath, entriesQuery, environmentId, selectedPath]);

  const handleUpload = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return;
      setBusy(true);
      for (const file of Array.from(fileList)) {
        const contents = await fileToBase64(file);
        await writeFile({
          environmentId,
          input: {
            cwd,
            relativePath: joinPath(targetDir, file.name),
            contents,
            encoding: "base64",
          },
        });
      }
      setBusy(false);
      entriesQuery.refresh();
    },
    [cwd, entriesQuery, environmentId, targetDir, writeFile],
  );

  const iconButton =
    "rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40";

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-background"
      data-file-browser-panel={`${environmentId}:${cwd}`}
    >
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/60 px-3">
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
          className={iconButton}
          aria-label="New folder"
          disabled={busy}
          onClick={() => {
            setFolderName("");
            setFolderDialogOpen(true);
          }}
        >
          <FolderPlus className="size-3.5" />
        </button>
        <button
          type="button"
          className={iconButton}
          aria-label="Upload files"
          disabled={busy}
          onClick={() => uploadInputRef.current?.click()}
        >
          <Upload className="size-3.5" />
        </button>
        <button
          type="button"
          className={iconButton}
          aria-label="Rename or move"
          disabled={busy || !selectedPath}
          onClick={() => {
            if (!selectedPath) return;
            setRenameValue(selectedPath);
            setRenameDialogOpen(true);
          }}
        >
          <Pencil className="size-3.5" />
        </button>
        <button
          type="button"
          className={iconButton}
          aria-label="Delete"
          disabled={busy || !selectedPath}
          onClick={() => setDeleteDialogOpen(true)}
        >
          <Trash2 className="size-3.5" />
        </button>
        <button
          type="button"
          className={iconButton}
          aria-label="Search workspace files"
          onClick={() => model.openSearch()}
        >
          <Search className="size-3.5" />
        </button>
        <button
          type="button"
          className={iconButton}
          aria-label="Refresh workspace files"
          onClick={entriesQuery.refresh}
        >
          <RefreshCw className={cn("size-3.5", entriesQuery.isPending && "animate-spin")} />
        </button>
      </div>
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

      <Dialog open={folderDialogOpen} onOpenChange={setFolderDialogOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>New folder</DialogTitle>
            <DialogDescription>
              Create a folder in {targetDir ? `${targetDir}/` : "the workspace root"}.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <Input
              autoFocus
              placeholder="folder-name"
              value={folderName}
              onChange={(event) => setFolderName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submitNewFolder();
                }
              }}
            />
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setFolderDialogOpen(false)}>
              Cancel
            </Button>
            <Button type="button" disabled={busy || !folderName.trim()} onClick={submitNewFolder}>
              Create
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog open={renameDialogOpen} onOpenChange={setRenameDialogOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Rename or move</DialogTitle>
            <DialogDescription>
              Enter a new workspace-relative path. Changing the folder moves the item.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <Input
              autoFocus
              placeholder="path/to/item"
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submitRename();
                }
              }}
            />
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRenameDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={busy || !renameValue.trim() || renameValue.trim() === selectedPath}
              onClick={submitRename}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selectedPath ?? "item"}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the {selectedKind === "directory" ? "folder and its contents" : "file"} from the workspace.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeleteDialogOpen(false)}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" disabled={busy} onClick={confirmDelete}>
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
