import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import type { ProjectReadFileResult } from "@t3tools/contracts";
import {
  BookOpenIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CodeIcon,
  Maximize2Icon,
  Minimize2Icon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

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
import { selectProjectByRef, useStore } from "../store";
import { createThreadSelectorByRef } from "../storeSelectors";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import { VscodeEntryIcon } from "./chat/VscodeEntryIcon";
import ChatMarkdown from "./ChatMarkdown";
import { DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { RightPanelTabs } from "./RightPanelTabs";
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

  // Fetch the selected file's contents.
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
  }, [filePath, cwd, environmentId]);

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
                <button
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-1.5 py-1 pr-2 text-left text-[13px] transition-colors",
                    isSelected
                      ? "bg-accent text-accent-foreground"
                      : "text-foreground/90 hover:bg-accent/50",
                  )}
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
                  <VscodeEntryIcon pathValue={entry.path} kind={entry.kind} theme={resolvedTheme} />
                  <span className="truncate">{basenameOf(entry.path)}</span>
                </button>
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
    [dirStates, expanded, filePath, loadDir, resolvedTheme, selectFile, toggleDir],
  );

  const headerRow = (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-2 [-webkit-app-region:no-drag]">
        <RightPanelTabs active="files" />
        <span className="truncate text-xs text-muted-foreground/80">
          {filePath ? basenameOf(filePath) : (activeProject?.name ?? "Files")}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
        {!filePath ? (
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
        <div className="flex min-h-0 w-64 shrink-0 flex-col overflow-auto border-r border-border/60 py-1">
          {renderDir("", 0)}
        </div>
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
      <div className="min-h-0 flex-1 overflow-auto py-1">{renderDir("", 0)}</div>
    );
  }

  return (
    <DiffPanelShell mode={mode} header={headerRow}>
      <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col">
        {body}
      </div>
    </DiffPanelShell>
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
