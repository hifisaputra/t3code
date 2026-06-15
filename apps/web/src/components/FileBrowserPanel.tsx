import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import type { ProjectReadFileResult } from "@t3tools/contracts";
import {
  BookOpenIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CodeIcon,
  FolderPlusIcon,
  Maximize2Icon,
  Minimize2Icon,
  RefreshCwIcon,
  Trash2Icon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import {
  type ChangeEvent as ReactChangeEvent,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import * as Schema from "effect/Schema";

import {
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
} from "../environments/runtime";
import { parseFilesRouteSearch } from "../filesRouteSearch";
import { stripDiffSearchParams } from "../diffRouteSearch";
import { useTheme } from "../hooks/useTheme";
import { getHighlighterPromise } from "../lib/codeHighlight";
import { resolveDiffThemeName } from "../lib/diffRendering";
import { cn } from "~/lib/utils";
import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";
import { selectProjectByRef, useStore } from "../store";
import { createThreadSelectorByRef } from "../storeSelectors";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import { VscodeEntryIcon } from "./chat/VscodeEntryIcon";
import ChatMarkdown from "./ChatMarkdown";
import { DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { RightPanelTabs } from "./RightPanelTabs";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Toggle, ToggleGroup } from "./ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

interface FileBrowserPanelProps {
  mode?: DiffPanelMode;
}

// Larger cap for images so previews aren't truncated; text reads use the server default.
const IMAGE_READ_MAX_BYTES = 5 * 1024 * 1024;

// Above this panel width the tree and viewer sit side by side; below it (mobile,
// tablet, narrow dock) the viewer replaces the tree as a master-detail view.
const SPLIT_MIN_WIDTH = 640;

const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

const TREE_DEFAULT_WIDTH = 256;
const TREE_MIN_WIDTH = 180;
const TREE_MAX_WIDTH = 480;
const TREE_WIDTH_STORAGE_KEY = "t3code_file_browser_tree_width";

function clampTreeWidth(width: number): number {
  return Math.min(TREE_MAX_WIDTH, Math.max(TREE_MIN_WIDTH, width));
}

const IMAGE_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".tiff",
  ".webp",
]);

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdx"]);

const SHIKI_LANGUAGE_ALIASES: Record<string, string> = {
  cjs: "javascript",
  cts: "typescript",
  gitignore: "ini",
  mjs: "javascript",
  mts: "typescript",
  yml: "yaml",
};

interface DirState {
  status: "loading" | "loaded" | "error";
  entries: ReadonlyArray<{ path: string; kind: "file" | "directory" }>;
  truncated: boolean;
  error?: string;
}

interface FileState {
  status: "idle" | "loading" | "loaded" | "error";
  data?: ProjectReadFileResult;
  error?: string;
}

function basenameOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}

function parentDirOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

function extensionOf(path: string): string {
  const match = /\.[a-z0-9]+$/i.exec(basenameOf(path));
  return match ? match[0].toLowerCase() : "";
}

function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionOf(path));
}

function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXTENSIONS.has(extensionOf(path));
}

function languageForPath(path: string): string {
  const extension = extensionOf(path).slice(1);
  if (!extension) {
    return "text";
  }
  return SHIKI_LANGUAGE_ALIASES[extension] ?? extension;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function dragHasFiles(event: ReactDragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Failed to read file."));
        return;
      }
      // readAsDataURL yields "data:<mime>;base64,<payload>" — keep only the payload.
      const commaIndex = result.indexOf(",");
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file."));
    reader.readAsDataURL(file);
  });
}

function messageOfError(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  return "Something went wrong.";
}

function HighlightedCode(props: { code: string; language: string; themeName: string }) {
  const { code, language, themeName } = props;
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    getHighlighterPromise(language)
      .then((highlighter) => {
        if (cancelled) {
          return;
        }
        try {
          setHtml(highlighter.codeToHtml(code, { lang: language, theme: themeName }));
        } catch {
          try {
            setHtml(highlighter.codeToHtml(code, { lang: "text", theme: themeName }));
          } catch {
            setHtml(null);
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHtml(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [code, language, themeName]);

  if (html === null) {
    return (
      <pre className="m-0 overflow-auto whitespace-pre p-3 text-xs leading-relaxed">
        <code>{code}</code>
      </pre>
    );
  }

  return (
    <div
      className="file-viewer-shiki overflow-auto text-xs leading-relaxed [&_pre]:m-0 [&_pre]:p-3"
      // Shiki emits trusted, theme-styled markup; no user HTML is interpolated.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

const ACTION_BUTTON_CLASS =
  "inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-border/70 text-muted-foreground transition-colors hover:border-border hover:text-foreground";

const ROW_ACTION_BUTTON_CLASS =
  "inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground/70 transition-colors hover:bg-background/70 hover:text-foreground";

export default function FileBrowserPanel({ mode = "inline" }: FileBrowserPanelProps) {
  const navigate = useNavigate();
  const { resolvedTheme } = useTheme();
  const themeName = resolveDiffThemeName(resolvedTheme);

  const threadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const filesSearch = useSearch({
    strict: false,
    select: (search) => parseFilesRouteSearch(search),
  });
  const filePath = filesSearch.filePath ?? null;
  const isMaximized = filesSearch.filesFull === "1";

  const activeThread = useStore(useMemo(() => createThreadSelectorByRef(threadRef), [threadRef]));
  const activeProjectId = activeThread?.projectId ?? null;
  const activeProject = useStore((store) =>
    activeThread && activeProjectId
      ? selectProjectByRef(store, {
          environmentId: activeThread.environmentId,
          projectId: activeProjectId,
        })
      : undefined,
  );
  const environmentId = activeThread?.environmentId ?? null;
  const cwd = activeThread?.worktreePath ?? activeProject?.cwd ?? null;
  const sessionKey = `${environmentId ?? ""}::${cwd ?? ""}`;

  const [dirStates, setDirStates] = useState<Map<string, DirState>>(() => new Map());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [fileState, setFileState] = useState<FileState>({ status: "idle" });
  const [markdownView, setMarkdownView] = useState<"rendered" | "source">("rendered");

  // Default each markdown file to the rendered view when it is first opened.
  useEffect(() => {
    setMarkdownView("rendered");
  }, [filePath]);

  // Switch between split (tree + viewer) and master-detail based on panel width.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [isSplit, setIsSplit] = useState(false);
  useEffect(() => {
    const element = bodyRef.current;
    if (!element) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setIsSplit(width >= SPLIT_MIN_WIDTH);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const [treeWidth, setTreeWidth] = useState<number>(() => {
    const stored = getLocalStorageItem(TREE_WIDTH_STORAGE_KEY, Schema.Finite);
    return stored == null ? TREE_DEFAULT_WIDTH : clampTreeWidth(stored);
  });
  const startTreeResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = treeWidth;
      let latest = startWidth;
      const onMove = (moveEvent: PointerEvent) => {
        latest = clampTreeWidth(startWidth + (moveEvent.clientX - startX));
        setTreeWidth(latest);
      };
      const onUp = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.body.style.removeProperty("user-select");
        document.body.style.removeProperty("cursor");
        setLocalStorageItem(TREE_WIDTH_STORAGE_KEY, latest, Schema.Finite);
      };
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    },
    [treeWidth],
  );

  const dirStatesRef = useRef(dirStates);
  useEffect(() => {
    dirStatesRef.current = dirStates;
  }, [dirStates]);

  const sessionKeyRef = useRef(sessionKey);

  const loadDir = useCallback(
    (dirPath: string) => {
      const key = sessionKey;
      const setDir = (state: DirState) =>
        setDirStates((previous) => new Map(previous).set(dirPath, state));

      if (!cwd || !environmentId) {
        setDir({ status: "error", entries: [], truncated: false, error: "No active project." });
        return;
      }
      const projects = readEnvironmentConnection(environmentId)?.client.projects;
      if (!projects) {
        setDir({ status: "error", entries: [], truncated: false, error: "Not connected." });
        return;
      }

      setDir({ status: "loading", entries: [], truncated: false });
      projects
        .listDirectory({ cwd, ...(dirPath ? { relativePath: dirPath } : {}) })
        .then((result) => {
          if (sessionKeyRef.current !== key) {
            return;
          }
          setDir({
            status: "loaded",
            entries: result.entries.map((entry) => ({ path: entry.path, kind: entry.kind })),
            truncated: result.truncated,
          });
        })
        .catch((error: unknown) => {
          if (sessionKeyRef.current !== key) {
            return;
          }
          setDir({
            status: "error",
            entries: [],
            truncated: false,
            error: messageOfError(error),
          });
        });
    },
    [cwd, environmentId, sessionKey],
  );

  // Reset and reload the tree whenever the active workspace changes.
  useEffect(() => {
    sessionKeyRef.current = sessionKey;
    setDirStates(new Map());
    setExpanded(new Set());
    if (cwd && environmentId) {
      loadDir("");
    }
  }, [sessionKey, cwd, environmentId, loadDir]);

  // Recover the root listing once a (re)connection becomes available.
  useEffect(() => {
    return subscribeEnvironmentConnections(() => {
      if (!environmentId || !cwd) {
        return;
      }
      const rootState = dirStatesRef.current.get("");
      if (
        (!rootState || rootState.status === "error") &&
        readEnvironmentConnection(environmentId)?.client.projects
      ) {
        loadDir("");
      }
    });
  }, [environmentId, cwd, loadDir]);

  // Fetch the selected file's contents. The reload token lets the refresh
  // button re-read the file (e.g. after the agent edits it on disk).
  const [fileReloadToken, setFileReloadToken] = useState(0);
  useEffect(() => {
    if (!filePath || !cwd || !environmentId) {
      setFileState({ status: "idle" });
      return;
    }
    const projects = readEnvironmentConnection(environmentId)?.client.projects;
    if (!projects) {
      setFileState({ status: "error", error: "Not connected." });
      return;
    }
    let cancelled = false;
    setFileState({ status: "loading" });
    const maxBytes = isImagePath(filePath) ? IMAGE_READ_MAX_BYTES : undefined;
    projects
      .readFile({ cwd, relativePath: filePath, ...(maxBytes ? { maxBytes } : {}) })
      .then((result) => {
        if (!cancelled) {
          setFileState({ status: "loaded", data: result });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setFileState({ status: "error", error: messageOfError(error) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [filePath, cwd, environmentId, fileReloadToken]);
  const refreshFile = useCallback(() => setFileReloadToken((token) => token + 1), []);

  const toggleDir = useCallback(
    (dirPath: string) => {
      setExpanded((previous) => {
        const next = new Set(previous);
        if (next.has(dirPath)) {
          next.delete(dirPath);
        } else {
          next.add(dirPath);
        }
        return next;
      });
      if (!dirStatesRef.current.has(dirPath)) {
        loadDir(dirPath);
      }
    },
    [loadDir],
  );

  const closePanel = useCallback(() => {
    if (!threadRef) {
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
      search: { diff: undefined, files: undefined },
    });
  }, [navigate, threadRef]);

  const toggleMaximize = useCallback(() => {
    if (!threadRef) {
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
      replace: true,
      search: (previous) => ({
        ...previous,
        files: "1",
        filesFull: isMaximized ? undefined : "1",
      }),
    });
  }, [isMaximized, navigate, threadRef]);

  // Allow Escape to leave full-screen mode (matches the sheet/overlay convention).
  useEffect(() => {
    if (!isMaximized) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        toggleMaximize();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isMaximized, toggleMaximize]);

  const selectFile = useCallback(
    (path: string) => {
      if (!threadRef) {
        return;
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
        replace: true,
        search: (previous) => ({ ...stripDiffSearchParams(previous), files: "1", filePath: path }),
      });
    },
    [navigate, threadRef],
  );

  const clearFile = useCallback(() => {
    if (!threadRef) {
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
      replace: true,
      search: (previous) => {
        const { filePath: _filePath, ...rest } = previous;
        return { ...rest, files: "1" };
      },
    });
  }, [navigate, threadRef]);

  // Upload: write dropped/picked files into a target directory via writeFile.
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadTargetRef = useRef<string>("");
  const [uploadState, setUploadState] = useState<{
    status: "idle" | "uploading" | "error";
    message?: string;
  }>({ status: "idle" });
  const [dropTargetDir, setDropTargetDir] = useState<string | null>(null);

  const uploadFiles = useCallback(
    async (targetDir: string, fileList: FileList | File[]) => {
      if (!cwd || !environmentId) {
        return;
      }
      const projects = readEnvironmentConnection(environmentId)?.client.projects;
      if (!projects) {
        setUploadState({ status: "error", message: "Not connected." });
        return;
      }
      const files = Array.from(fileList);
      if (files.length === 0) {
        return;
      }
      setUploadState({ status: "uploading" });
      try {
        for (const file of files) {
          if (file.size > UPLOAD_MAX_BYTES) {
            throw new Error(
              `${file.name} exceeds the ${formatBytes(UPLOAD_MAX_BYTES)} upload limit.`,
            );
          }
          const base64 = await readFileAsBase64(file);
          const relativePath = targetDir ? `${targetDir}/${file.name}` : file.name;
          await projects.writeFile({ cwd, relativePath, contents: base64, encoding: "base64" });
        }
        setUploadState({ status: "idle" });
      } catch (error) {
        setUploadState({ status: "error", message: messageOfError(error) });
      }
      loadDir(targetDir);
      if (targetDir) {
        setExpanded((previous) => new Set(previous).add(targetDir));
      }
    },
    [cwd, environmentId, loadDir],
  );

  const openUploadPicker = useCallback((targetDir: string) => {
    uploadTargetRef.current = targetDir;
    fileInputRef.current?.click();
  }, []);

  const onUploadInputChange = useCallback(
    (event: ReactChangeEvent<HTMLInputElement>) => {
      const files = event.target.files;
      if (files && files.length > 0) {
        void uploadFiles(uploadTargetRef.current, files);
      }
      event.target.value = "";
    },
    [uploadFiles],
  );

  const onDirDragOver = useCallback(
    (targetDir: string) => (event: ReactDragEvent<HTMLElement>) => {
      if (!dragHasFiles(event)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "copy";
      }
      setDropTargetDir(targetDir);
    },
    [],
  );

  const onDirDrop = useCallback(
    (targetDir: string) => (event: ReactDragEvent<HTMLElement>) => {
      if (!dragHasFiles(event)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setDropTargetDir(null);
      const files = event.dataTransfer?.files;
      if (files && files.length > 0) {
        void uploadFiles(targetDir, files);
      }
    },
    [uploadFiles],
  );

  const onDropZoneDragLeave = useCallback(
    (targetDir: string) => (event: ReactDragEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
        setDropTargetDir((current) => (current === targetDir ? null : current));
      }
    },
    [],
  );

  const createFolderFormId = useId();
  const [createFolderState, setCreateFolderState] = useState<{
    open: boolean;
    parentDir: string;
  }>({ open: false, parentDir: "" });
  const [newFolderName, setNewFolderName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<{
    path: string;
    kind: "file" | "directory";
  } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const openCreateFolder = useCallback((parentDir: string) => {
    setNewFolderName("");
    setActionError(null);
    setCreateFolderState({ open: true, parentDir });
  }, []);

  const submitCreateFolder = useCallback(async () => {
    const name = newFolderName.trim();
    if (!name || !cwd || !environmentId) {
      return;
    }
    const projects = readEnvironmentConnection(environmentId)?.client.projects;
    if (!projects) {
      setActionError("Not connected.");
      return;
    }
    const parentDir = createFolderState.parentDir;
    const relativePath = parentDir ? `${parentDir}/${name}` : name;
    try {
      await projects.createDirectory({ cwd, relativePath });
      setCreateFolderState({ open: false, parentDir: "" });
      loadDir(parentDir);
      if (parentDir) {
        setExpanded((previous) => new Set(previous).add(parentDir));
      }
    } catch (error) {
      setActionError(messageOfError(error));
    }
  }, [newFolderName, cwd, environmentId, createFolderState.parentDir, loadDir]);

  const requestDelete = useCallback((path: string, kind: "file" | "directory") => {
    setActionError(null);
    setDeleteTarget({ path, kind });
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget || !cwd || !environmentId) {
      return;
    }
    const projects = readEnvironmentConnection(environmentId)?.client.projects;
    if (!projects) {
      setActionError("Not connected.");
      return;
    }
    const target = deleteTarget;
    try {
      await projects.deletePath({ cwd, relativePath: target.path });
      setDeleteTarget(null);
      loadDir(parentDirOf(target.path));
      setExpanded((previous) => {
        const next = new Set(previous);
        next.delete(target.path);
        return next;
      });
      if (
        filePath === target.path ||
        (target.kind === "directory" && filePath?.startsWith(`${target.path}/`))
      ) {
        clearFile();
      }
    } catch (error) {
      setActionError(messageOfError(error));
    }
  }, [deleteTarget, cwd, environmentId, loadDir, filePath, clearFile]);

  const renderDir = useCallback(
    (dirPath: string, depth: number): ReactNode => {
      const state = dirStates.get(dirPath);
      const indent = 8 + depth * 12;

      if (!state || state.status === "loading") {
        return (
          <div
            className="px-3 py-1 text-xs text-muted-foreground/60"
            style={{ paddingLeft: indent }}
          >
            Loading…
          </div>
        );
      }
      if (state.status === "error") {
        return (
          <div
            className="flex flex-wrap items-center gap-2 px-3 py-1 text-xs text-destructive/80"
            style={{ paddingLeft: indent }}
          >
            <span className="truncate">{state.error ?? "Failed to load."}</span>
            <button
              type="button"
              className="rounded-sm border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
              onClick={() => loadDir(dirPath)}
            >
              Retry
            </button>
          </div>
        );
      }
      if (state.entries.length === 0) {
        return (
          <div
            className="px-3 py-1 text-xs text-muted-foreground/50 italic"
            style={{ paddingLeft: indent }}
          >
            Empty
          </div>
        );
      }

      return (
        <>
          {state.entries.map((entry) => {
            const isDirectory = entry.kind === "directory";
            const isExpanded = expanded.has(entry.path);
            const isSelected = entry.path === filePath;
            return (
              <div key={entry.path}>
                <div
                  className={cn(
                    "group/row flex items-center pr-1 transition-colors",
                    isSelected
                      ? "bg-accent text-accent-foreground"
                      : "text-foreground/90 hover:bg-accent/50",
                    isDirectory &&
                      dropTargetDir === entry.path &&
                      "bg-primary/15 ring-1 ring-inset ring-primary/50",
                  )}
                  {...(isDirectory
                    ? {
                        onDragOver: onDirDragOver(entry.path),
                        onDrop: onDirDrop(entry.path),
                        onDragLeave: onDropZoneDragLeave(entry.path),
                      }
                    : {})}
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left text-[13px]"
                    style={{ paddingLeft: indent }}
                    onClick={() => (isDirectory ? toggleDir(entry.path) : selectFile(entry.path))}
                    aria-expanded={isDirectory ? isExpanded : undefined}
                  >
                    <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground/70">
                      {isDirectory ? (
                        isExpanded ? (
                          <ChevronDownIcon className="size-3.5" />
                        ) : (
                          <ChevronRightIcon className="size-3.5" />
                        )
                      ) : null}
                    </span>
                    <VscodeEntryIcon
                      pathValue={entry.path}
                      kind={entry.kind}
                      theme={resolvedTheme}
                    />
                    <span className="truncate">{basenameOf(entry.path)}</span>
                  </button>
                  <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100">
                    {isDirectory ? (
                      <button
                        type="button"
                        className={ROW_ACTION_BUTTON_CLASS}
                        aria-label={`New folder in ${basenameOf(entry.path)}`}
                        onClick={() => openCreateFolder(entry.path)}
                      >
                        <FolderPlusIcon className="size-3.5" />
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className={cn(ROW_ACTION_BUTTON_CLASS, "hover:text-destructive")}
                      aria-label={`Delete ${basenameOf(entry.path)}`}
                      onClick={() => requestDelete(entry.path, entry.kind)}
                    >
                      <Trash2Icon className="size-3.5" />
                    </button>
                  </div>
                </div>
                {isDirectory && isExpanded ? renderDir(entry.path, depth + 1) : null}
              </div>
            );
          })}
          {state.truncated ? (
            <div
              className="px-3 py-1 text-[11px] text-muted-foreground/50 italic"
              style={{ paddingLeft: indent }}
            >
              Listing truncated…
            </div>
          ) : null}
        </>
      );
    },
    [
      dirStates,
      expanded,
      filePath,
      loadDir,
      resolvedTheme,
      selectFile,
      toggleDir,
      dropTargetDir,
      onDirDragOver,
      onDirDrop,
      onDropZoneDragLeave,
      openCreateFolder,
      requestDelete,
    ],
  );

  const treeVisible = isSplit || !filePath;

  const headerRow = (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-2 [-webkit-app-region:no-drag]">
        <RightPanelTabs active="files" />
        <span className="truncate text-xs text-muted-foreground/80">
          {filePath ? basenameOf(filePath) : (activeProject?.name ?? "Files")}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
        {treeVisible ? (
          <>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    className={ACTION_BUTTON_CLASS}
                    aria-label="Upload files"
                    onClick={() => openUploadPicker("")}
                  >
                    <UploadIcon className="size-3.5" />
                  </button>
                }
              />
              <TooltipPopup side="bottom">Upload to project root</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    className={ACTION_BUTTON_CLASS}
                    aria-label="New folder"
                    onClick={() => openCreateFolder("")}
                  >
                    <FolderPlusIcon className="size-3.5" />
                  </button>
                }
              />
              <TooltipPopup side="bottom">New folder in project root</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    className={ACTION_BUTTON_CLASS}
                    aria-label="Refresh files"
                    onClick={() => loadDir("")}
                  >
                    <RefreshCwIcon className="size-3.5" />
                  </button>
                }
              />
              <TooltipPopup side="bottom">Refresh</TooltipPopup>
            </Tooltip>
          </>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className={ACTION_BUTTON_CLASS}
                aria-label={isMaximized ? "Exit full screen" : "Full screen"}
                onClick={toggleMaximize}
              >
                {isMaximized ? (
                  <Minimize2Icon className="size-3.5" />
                ) : (
                  <Maximize2Icon className="size-3.5" />
                )}
              </button>
            }
          />
          <TooltipPopup side="bottom">
            {isMaximized ? "Exit full screen" : "Full screen"}
          </TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className={ACTION_BUTTON_CLASS}
                aria-label="Close panel"
                onClick={closePanel}
              >
                <XIcon className="size-3.5" />
              </button>
            }
          />
          <TooltipPopup side="bottom">Close panel</TooltipPopup>
        </Tooltip>
      </div>
    </>
  );

  const markdownToggle =
    filePath &&
    isMarkdownPath(filePath) &&
    fileState.status === "loaded" &&
    fileState.data?.encoding === "utf8" ? (
      <ToggleGroup
        className="shrink-0"
        variant="outline"
        size="xs"
        value={[markdownView]}
        onValueChange={(value) => {
          const next = value[0];
          if (next === "rendered" || next === "source") {
            setMarkdownView(next);
          }
        }}
      >
        <Toggle aria-label="Rendered markdown" value="rendered">
          <BookOpenIcon className="size-3" />
        </Toggle>
        <Toggle aria-label="Markdown source" value="source">
          <CodeIcon className="size-3" />
        </Toggle>
      </ToggleGroup>
    ) : null;

  const renderFilePathBar = (showBack: boolean) =>
    filePath ? (
      <div className="flex items-center gap-2 border-b border-border/60 px-2 py-1.5">
        {showBack ? (
          <button
            type="button"
            className={cn(ACTION_BUTTON_CLASS, "size-6")}
            aria-label="Back to files"
            onClick={clearFile}
          >
            <ChevronLeftIcon className="size-3.5" />
          </button>
        ) : null}
        <span
          className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/80"
          title={filePath}
        >
          {filePath}
        </span>
        {markdownToggle}
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className={cn(ACTION_BUTTON_CLASS, "size-6")}
                aria-label="Refresh file"
                onClick={refreshFile}
              >
                <RefreshCwIcon className="size-3.5" />
              </button>
            }
          />
          <TooltipPopup side="bottom">Refresh file</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className={cn(ACTION_BUTTON_CLASS, "size-6 hover:text-destructive")}
                aria-label="Delete file"
                onClick={() => requestDelete(filePath, "file")}
              >
                <Trash2Icon className="size-3.5" />
              </button>
            }
          />
          <TooltipPopup side="bottom">Delete file</TooltipPopup>
        </Tooltip>
      </div>
    ) : null;

  const viewer = filePath ? (
    <FileContentView
      fileState={fileState}
      filePath={filePath}
      themeName={themeName}
      cwd={cwd}
      markdownView={markdownView}
    />
  ) : null;

  const uploadBanner =
    uploadState.status === "idle" ? null : (
      <div
        className={cn(
          "shrink-0 border-b px-3 py-1 text-[11px]",
          uploadState.status === "error"
            ? "border-destructive/30 bg-destructive/10 text-destructive/90"
            : "border-border/50 bg-muted/30 text-muted-foreground/80",
        )}
      >
        {uploadState.status === "uploading" ? "Uploading…" : uploadState.message}
      </div>
    );

  // Tree scroll area doubles as a drop zone targeting the workspace root.
  const treeScroll = (
    <div
      className={cn(
        "min-h-0 flex-1 overflow-auto py-1",
        dropTargetDir === "" && "bg-primary/5 ring-1 ring-inset ring-primary/40",
      )}
      onDragOver={onDirDragOver("")}
      onDrop={onDirDrop("")}
      onDragLeave={onDropZoneDragLeave("")}
    >
      {renderDir("", 0)}
    </div>
  );

  let body: ReactNode;
  if (!activeThread || !cwd) {
    body = (
      <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
        Select a thread with a project to browse its files.
      </div>
    );
  } else if (isSplit) {
    // Wide layout: tree and viewer side by side.
    body = (
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 shrink-0 flex-col" style={{ width: treeWidth }}>
          {uploadBanner}
          {treeScroll}
        </div>
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize file tree"
          className="w-1 shrink-0 cursor-col-resize touch-none bg-border/50 transition-colors hover:bg-border active:bg-border"
          onPointerDown={startTreeResize}
        />
        <div className="flex min-h-0 flex-1 flex-col">
          {filePath ? (
            <>
              {renderFilePathBar(false)}
              {viewer}
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/60">
              Select a file to preview.
            </div>
          )}
        </div>
      </div>
    );
  } else {
    // Narrow layout: viewer replaces the tree (master-detail).
    body = filePath ? (
      <div className="flex min-h-0 flex-1 flex-col">
        {renderFilePathBar(true)}
        {viewer}
      </div>
    ) : (
      <div className="flex min-h-0 flex-1 flex-col">
        {uploadBanner}
        {treeScroll}
      </div>
    );
  }

  return (
    <>
      <DiffPanelShell mode={mode} header={headerRow}>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={onUploadInputChange}
        />
        <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col">
          {body}
        </div>
      </DiffPanelShell>

      <Dialog
        open={createFolderState.open}
        onOpenChange={(open) => setCreateFolderState((previous) => ({ ...previous, open }))}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>New folder</DialogTitle>
            <DialogDescription>
              {createFolderState.parentDir
                ? `Create a folder inside ${createFolderState.parentDir}.`
                : "Create a folder in the project root."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <form
              id={createFolderFormId}
              onSubmit={(event) => {
                event.preventDefault();
                void submitCreateFolder();
              }}
            >
              <Input
                autoFocus
                placeholder="folder-name"
                value={newFolderName}
                onChange={(event) => setNewFolderName(event.target.value)}
              />
              {actionError ? <p className="mt-2 text-sm text-destructive">{actionError}</p> : null}
            </form>
          </DialogPanel>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setCreateFolderState((previous) => ({ ...previous, open: false }))}
            >
              Cancel
            </Button>
            <Button
              form={createFolderFormId}
              type="submit"
              disabled={newFolderName.trim().length === 0}
            >
              Create folder
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
          }
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {deleteTarget?.kind === "directory" ? "folder" : "file"}
              {deleteTarget ? ` “${basenameOf(deleteTarget.path)}”` : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.kind === "directory"
                ? "This permanently deletes the folder and everything inside it."
                : "This permanently deletes the file."}{" "}
              This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {actionError ? <p className="px-1 text-sm text-destructive">{actionError}</p> : null}
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button variant="destructive" onClick={() => void confirmDelete()}>
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

function FileContentView(props: {
  fileState: FileState;
  filePath: string;
  themeName: string;
  cwd: string | null;
  markdownView: "rendered" | "source";
}) {
  const { fileState, filePath, themeName, cwd, markdownView } = props;

  if (fileState.status === "loading" || fileState.status === "idle") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-muted-foreground/60">
        Loading file…
      </div>
    );
  }
  if (fileState.status === "error") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-5 text-center text-xs text-destructive/80">
        {fileState.error ?? "Failed to read file."}
      </div>
    );
  }

  const data = fileState.data;
  if (!data) {
    return null;
  }

  const isImage = data.encoding === "base64" && (data.mediaType?.startsWith("image/") ?? false);
  if (isImage) {
    if (data.truncated) {
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Image is too large to preview ({formatBytes(data.byteSize)}).
        </div>
      );
    }
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-[repeating-conic-gradient(theme(colors.muted.DEFAULT)_0%_25%,transparent_0%_50%)] bg-[length:16px_16px] p-4">
        <img
          src={`data:${data.mediaType};base64,${data.contents}`}
          alt={basenameOf(filePath)}
          className="max-h-full max-w-full object-contain"
        />
      </div>
    );
  }

  if (data.encoding === "base64") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
        Binary file ({formatBytes(data.byteSize)}). Preview not available.
      </div>
    );
  }

  const renderMarkdown = isMarkdownPath(filePath) && markdownView === "rendered";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {data.truncated ? (
        <div className="border-b border-border/50 bg-muted/30 px-3 py-1 text-[11px] text-muted-foreground/70">
          Showing the first part of this file ({formatBytes(data.byteSize)} total).
        </div>
      ) : null}
      {renderMarkdown ? (
        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
          <ChatMarkdown text={data.contents} cwd={cwd ?? undefined} isStreaming={false} />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <HighlightedCode
            code={data.contents}
            language={languageForPath(filePath)}
            themeName={themeName}
          />
        </div>
      )}
    </div>
  );
}
