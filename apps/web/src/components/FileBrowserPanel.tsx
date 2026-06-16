import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import type { EnvironmentId, ProjectReadFileResult } from "@t3tools/contracts";
import {
  BookOpenIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CodeIcon,
  EllipsisVerticalIcon,
  FolderIcon,
  FolderInputIcon,
  FolderPlusIcon,
  Maximize2Icon,
  Minimize2Icon,
  PencilIcon,
  RefreshCwIcon,
  SaveIcon,
  SquarePenIcon,
  Trash2Icon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import {
  type ChangeEvent as ReactChangeEvent,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  Suspense,
  lazy,
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
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "./ui/menu";
import { Toggle, ToggleGroup } from "./ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

// CodeMirror and its language modes are heavy; keep them out of the main bundle
// and only load them when the user actually enters edit mode.
const FileEditor = lazy(() => import("./FileEditor"));

interface FileBrowserPanelProps {
  mode?: DiffPanelMode;
}

// Larger cap for binary previews (images, PDFs) so they aren't truncated; text
// reads use the server default. The server clamps this to its own hard limit.
const PREVIEW_READ_MAX_BYTES = 5 * 1024 * 1024;

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

function isPdfPath(path: string): boolean {
  return extensionOf(path) === ".pdf";
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
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Default each markdown file to the rendered view, and abandon any in-progress
  // edit, whenever a different file is opened.
  useEffect(() => {
    setMarkdownView("rendered");
    setEditing(false);
    setEditError(null);
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
    const maxBytes =
      isImagePath(filePath) || isPdfPath(filePath) ? PREVIEW_READ_MAX_BYTES : undefined;
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

  const fileData = fileState.status === "loaded" ? fileState.data : undefined;
  // Editing is limited to fully-loaded UTF-8 text. Truncated reads are excluded
  // because saving the partial contents would destroy the rest of the file.
  const canEdit = Boolean(
    filePath && fileData && fileData.encoding === "utf8" && !fileData.truncated,
  );
  const editDirty = editing && fileData ? editValue !== fileData.contents : false;

  const beginEdit = useCallback(() => {
    if (!fileData || fileData.encoding !== "utf8") {
      return;
    }
    setEditValue(fileData.contents);
    setEditError(null);
    setEditing(true);
  }, [fileData]);

  const cancelEdit = useCallback(() => {
    setEditing(false);
    setEditError(null);
  }, []);

  const saveEdit = useCallback(async () => {
    if (!filePath || !cwd || !environmentId) {
      return;
    }
    const projects = readEnvironmentConnection(environmentId)?.client.projects;
    if (!projects) {
      setEditError("Not connected.");
      return;
    }
    setEditSaving(true);
    setEditError(null);
    try {
      await projects.writeFile({
        cwd,
        relativePath: filePath,
        contents: editValue,
        encoding: "utf8",
      });
      setEditing(false);
      // Re-read so the viewer reflects the saved contents and updated byte size.
      refreshFile();
    } catch (error) {
      setEditError(messageOfError(error));
    } finally {
      setEditSaving(false);
    }
  }, [filePath, cwd, environmentId, editValue, refreshFile]);

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

  const moveFormId = useId();
  const [moveState, setMoveState] = useState<{
    open: boolean;
    mode: "rename" | "move";
    sourcePath: string;
    sourceKind: "file" | "directory";
    value: string;
  }>({ open: false, mode: "rename", sourcePath: "", sourceKind: "file", value: "" });

  const openRename = useCallback((path: string, kind: "file" | "directory") => {
    setActionError(null);
    setMoveState({
      open: true,
      mode: "rename",
      sourcePath: path,
      sourceKind: kind,
      value: basenameOf(path),
    });
  }, []);

  const openMove = useCallback((path: string, kind: "file" | "directory") => {
    setActionError(null);
    setMoveState({
      open: true,
      mode: "move",
      sourcePath: path,
      sourceKind: kind,
      value: parentDirOf(path),
    });
  }, []);

  const submitMove = useCallback(async () => {
    if (!cwd || !environmentId) {
      return;
    }
    const projects = readEnvironmentConnection(environmentId)?.client.projects;
    if (!projects) {
      setActionError("Not connected.");
      return;
    }
    const { mode, sourcePath, sourceKind, value } = moveState;
    let toPath: string;
    if (mode === "rename") {
      const name = value.trim().replace(/\/+$/, "");
      if (!name) {
        return;
      }
      const parentDir = parentDirOf(sourcePath);
      toPath = parentDir ? `${parentDir}/${name}` : name;
    } else {
      const destDir = value.trim().replace(/^\/+|\/+$/g, "");
      toPath = destDir ? `${destDir}/${basenameOf(sourcePath)}` : basenameOf(sourcePath);
    }
    if (toPath === sourcePath) {
      setMoveState((previous) => ({ ...previous, open: false }));
      return;
    }
    try {
      await projects.movePath({ cwd, fromRelativePath: sourcePath, toRelativePath: toPath });
      setMoveState((previous) => ({ ...previous, open: false }));
      const sourceParent = parentDirOf(sourcePath);
      const destParent = parentDirOf(toPath);
      loadDir(sourceParent);
      if (destParent !== sourceParent) {
        loadDir(destParent);
      }
      setExpanded((previous) => {
        const next = new Set(previous);
        next.delete(sourcePath);
        if (destParent) {
          next.add(destParent);
        }
        return next;
      });
      // Keep the viewer pointed at the file if it (or its parent) was moved.
      if (filePath === sourcePath) {
        selectFile(toPath);
      } else if (sourceKind === "directory" && filePath?.startsWith(`${sourcePath}/`)) {
        selectFile(`${toPath}${filePath.slice(sourcePath.length)}`);
      }
    } catch (error) {
      setActionError(messageOfError(error));
    }
  }, [cwd, environmentId, moveState, loadDir, filePath, selectFile]);

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
                  <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100 has-[[data-popup-open]]:opacity-100">
                    <Menu>
                      <MenuTrigger
                        render={
                          <button
                            type="button"
                            className={ROW_ACTION_BUTTON_CLASS}
                            aria-label={`Actions for ${basenameOf(entry.path)}`}
                          />
                        }
                      >
                        <EllipsisVerticalIcon className="size-3.5" />
                      </MenuTrigger>
                      <MenuPopup align="end">
                        {isDirectory ? (
                          <MenuItem onClick={() => openCreateFolder(entry.path)}>
                            <FolderPlusIcon />
                            New folder
                          </MenuItem>
                        ) : null}
                        <MenuItem onClick={() => openRename(entry.path, entry.kind)}>
                          <PencilIcon />
                          Rename
                        </MenuItem>
                        <MenuItem onClick={() => openMove(entry.path, entry.kind)}>
                          <FolderInputIcon />
                          Move
                        </MenuItem>
                        <MenuSeparator />
                        <MenuItem
                          variant="destructive"
                          onClick={() => requestDelete(entry.path, entry.kind)}
                        >
                          <Trash2Icon />
                          Delete
                        </MenuItem>
                      </MenuPopup>
                    </Menu>
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
      openRename,
      openMove,
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
        {showBack && !editing ? (
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
          {editDirty ? <span className="ml-1 text-primary">•</span> : null}
        </span>
        {editing ? (
          <>
            <Button
              size="xs"
              variant="outline"
              className="shrink-0"
              onClick={cancelEdit}
              disabled={editSaving}
            >
              Cancel
            </Button>
            <Button
              size="xs"
              className="shrink-0"
              onClick={() => void saveEdit()}
              disabled={editSaving || !editDirty}
            >
              <SaveIcon />
              {editSaving ? "Saving…" : "Save"}
            </Button>
          </>
        ) : (
          <>
            {markdownToggle}
            {canEdit ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      className={cn(ACTION_BUTTON_CLASS, "size-6")}
                      aria-label="Edit file"
                      onClick={beginEdit}
                    >
                      <SquarePenIcon className="size-3.5" />
                    </button>
                  }
                />
                <TooltipPopup side="bottom">Edit file</TooltipPopup>
              </Tooltip>
            ) : null}
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
            <Menu>
              <MenuTrigger
                render={
                  <button
                    type="button"
                    className={cn(ACTION_BUTTON_CLASS, "size-6")}
                    aria-label="File actions"
                  />
                }
              >
                <EllipsisVerticalIcon className="size-3.5" />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem onClick={() => openRename(filePath, "file")}>
                  <PencilIcon />
                  Rename
                </MenuItem>
                <MenuItem onClick={() => openMove(filePath, "file")}>
                  <FolderInputIcon />
                  Move
                </MenuItem>
                <MenuSeparator />
                <MenuItem variant="destructive" onClick={() => requestDelete(filePath, "file")}>
                  <Trash2Icon />
                  Delete
                </MenuItem>
              </MenuPopup>
            </Menu>
          </>
        )}
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

  const editorPane =
    filePath && editing ? (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {editError ? (
          <div className="shrink-0 border-b border-destructive/30 bg-destructive/10 px-3 py-1 text-[11px] text-destructive/90">
            {editError}
          </div>
        ) : null}
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground/60">
                Loading editor…
              </div>
            }
          >
            <FileEditor
              value={editValue}
              filePath={filePath}
              theme={resolvedTheme}
              onChange={setEditValue}
            />
          </Suspense>
        </div>
      </div>
    ) : null;

  // Show the editor in place of the read-only viewer while editing.
  const content = editing ? editorPane : viewer;

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
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {filePath ? (
            <>
              {renderFilePathBar(false)}
              {content}
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
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {renderFilePathBar(true)}
        {content}
      </div>
    ) : (
      <div className="flex min-h-0 flex-1 flex-col">
        {uploadBanner}
        {treeScroll}
      </div>
    );
  }

  const moveBaseName = basenameOf(moveState.sourcePath);
  const moveDestDir = moveState.value.trim().replace(/^\/+|\/+$/g, "");
  const moveResolvedPath = moveDestDir ? `${moveDestDir}/${moveBaseName}` : moveBaseName;
  const moveSubmitDisabled =
    moveState.mode === "rename"
      ? moveState.value.trim().length === 0
      : moveResolvedPath === moveState.sourcePath;

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

      <Dialog
        open={moveState.open}
        onOpenChange={(open) => setMoveState((previous) => ({ ...previous, open }))}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              {moveState.mode === "rename" ? "Rename" : "Move"}{" "}
              {moveState.sourceKind === "directory" ? "folder" : "file"}
            </DialogTitle>
            <DialogDescription>
              {moveState.mode === "rename"
                ? `Enter a new name for “${basenameOf(moveState.sourcePath)}”.`
                : `Choose a destination folder for “${basenameOf(moveState.sourcePath)}”.`}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {moveState.mode === "rename" ? (
              <form
                id={moveFormId}
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitMove();
                }}
              >
                <Input
                  autoFocus
                  placeholder="name"
                  value={moveState.value}
                  onChange={(event) =>
                    setMoveState((previous) => ({ ...previous, value: event.target.value }))
                  }
                />
              </form>
            ) : cwd && environmentId ? (
              <div className="space-y-2">
                <MoveFolderPicker
                  cwd={cwd}
                  environmentId={environmentId}
                  sourcePath={moveState.sourcePath}
                  sourceKind={moveState.sourceKind}
                  selectedDir={moveState.value}
                  onSelect={(dir) => setMoveState((previous) => ({ ...previous, value: dir }))}
                  theme={resolvedTheme}
                />
                <p
                  className="truncate text-[11px] text-muted-foreground/70"
                  title={moveResolvedPath}
                >
                  Destination: {moveResolvedPath}
                </p>
              </div>
            ) : null}
            {actionError ? <p className="mt-2 text-sm text-destructive">{actionError}</p> : null}
          </DialogPanel>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setMoveState((previous) => ({ ...previous, open: false }))}
            >
              Cancel
            </Button>
            <Button
              {...(moveState.mode === "rename"
                ? { form: moveFormId, type: "submit" as const }
                : { type: "button" as const, onClick: () => void submitMove() })}
              disabled={moveSubmitDisabled}
            >
              {moveState.mode === "rename" ? "Rename" : "Move here"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}

function PdfPreview(props: { contents: string; fileName: string }) {
  const { contents, fileName } = props;
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  // Build a blob: URL from the base64 payload so the browser's native PDF
  // viewer can render it in an iframe (avoids a multi-MB data: URI in the DOM).
  useEffect(() => {
    let objectUrl: string | null = null;
    setUrl(null);
    setFailed(false);
    try {
      const binary = atob(contents);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      objectUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      setUrl(objectUrl);
    } catch {
      setFailed(true);
    }
    return () => {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [contents]);

  if (failed) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
        Unable to preview this PDF.
      </div>
    );
  }
  if (!url) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-muted-foreground/60">
        Loading PDF…
      </div>
    );
  }
  return (
    <object data={url} type="application/pdf" title={fileName} className="min-h-0 w-full flex-1">
      <div className="flex h-full flex-col items-center justify-center gap-2 px-5 text-center text-xs text-muted-foreground/70">
        <span>This browser can&apos;t display PDFs inline.</span>
        <a href={url} download={fileName} className="text-primary underline">
          Download {fileName}
        </a>
      </div>
    </object>
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

  const isPdf =
    data.encoding === "base64" && (data.mediaType === "application/pdf" || isPdfPath(filePath));
  if (isPdf) {
    if (data.truncated) {
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          PDF is too large to preview ({formatBytes(data.byteSize)}).
        </div>
      );
    }
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <PdfPreview contents={data.contents} fileName={basenameOf(filePath)} />
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
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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

interface FolderPickerDirState {
  status: "loading" | "loaded" | "error";
  entries: ReadonlyArray<string>;
  error?: string;
}

function MoveFolderPicker(props: {
  cwd: string;
  environmentId: EnvironmentId;
  sourcePath: string;
  sourceKind: "file" | "directory";
  selectedDir: string;
  onSelect: (dir: string) => void;
  theme: "light" | "dark";
}) {
  const { cwd, environmentId, sourcePath, sourceKind, selectedDir, onSelect, theme } = props;
  const [dirChildren, setDirChildren] = useState<Map<string, FolderPickerDirState>>(
    () => new Map(),
  );
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const dirChildrenRef = useRef(dirChildren);
  useEffect(() => {
    dirChildrenRef.current = dirChildren;
  }, [dirChildren]);

  const loadDir = useCallback(
    (dirPath: string) => {
      const setState = (state: FolderPickerDirState) =>
        setDirChildren((previous) => new Map(previous).set(dirPath, state));
      const projects = readEnvironmentConnection(environmentId)?.client.projects;
      if (!projects) {
        setState({ status: "error", entries: [], error: "Not connected." });
        return;
      }
      setState({ status: "loading", entries: [] });
      projects
        .listDirectory({ cwd, ...(dirPath ? { relativePath: dirPath } : {}) })
        .then((result) => {
          const entries = result.entries
            .filter(
              (entry) =>
                entry.kind === "directory" &&
                // Can't move a folder into itself or a descendant.
                !(sourceKind === "directory" && entry.path === sourcePath),
            )
            .map((entry) => entry.path);
          setState({ status: "loaded", entries });
        })
        .catch((error: unknown) => {
          setState({ status: "error", entries: [], error: messageOfError(error) });
        });
    },
    [cwd, environmentId, sourcePath, sourceKind],
  );

  useEffect(() => {
    loadDir("");
  }, [loadDir]);

  const toggle = useCallback(
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
      if (!dirChildrenRef.current.has(dirPath)) {
        loadDir(dirPath);
      }
    },
    [loadDir],
  );

  const renderChildren = (dirPath: string, depth: number): ReactNode => {
    const state = dirChildren.get(dirPath);
    const indent = 8 + depth * 14;
    if (!state || state.status === "loading") {
      return (
        <div className="px-2 py-1 text-xs text-muted-foreground/60" style={{ paddingLeft: indent }}>
          Loading…
        </div>
      );
    }
    if (state.status === "error") {
      return (
        <div
          className="flex items-center gap-2 px-2 py-1 text-xs text-destructive/80"
          style={{ paddingLeft: indent }}
        >
          <span className="truncate">{state.error}</span>
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
    return state.entries.map((childPath) => {
      const isExpanded = expanded.has(childPath);
      const isSelected = selectedDir === childPath;
      return (
        <div key={childPath}>
          <div
            className={cn(
              "flex items-center text-[13px]",
              isSelected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
            )}
            style={{ paddingLeft: indent }}
          >
            <button
              type="button"
              className="flex size-5 shrink-0 items-center justify-center text-muted-foreground/70"
              aria-label={isExpanded ? "Collapse folder" : "Expand folder"}
              onClick={() => toggle(childPath)}
            >
              {isExpanded ? (
                <ChevronDownIcon className="size-3.5" />
              ) : (
                <ChevronRightIcon className="size-3.5" />
              )}
            </button>
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-2 text-left"
              onClick={() => onSelect(childPath)}
            >
              <VscodeEntryIcon pathValue={childPath} kind="directory" theme={theme} />
              <span className="truncate">{basenameOf(childPath)}</span>
            </button>
          </div>
          {isExpanded ? renderChildren(childPath, depth + 1) : null}
        </div>
      );
    });
  };

  return (
    <div className="max-h-72 min-h-40 overflow-auto rounded-md border border-border/60 bg-background/40">
      <button
        type="button"
        className={cn(
          "flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[13px]",
          selectedDir === "" ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
        )}
        onClick={() => onSelect("")}
      >
        <FolderIcon className="size-4 text-muted-foreground/80" />
        <span className="font-medium">Project root</span>
      </button>
      {renderChildren("", 0)}
    </div>
  );
}
