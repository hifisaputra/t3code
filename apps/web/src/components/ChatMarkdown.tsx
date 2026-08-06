import { useAtomValue } from "@effect/atom-react";
import { DiffsHighlighter, getSharedHighlighter, SupportedLanguages } from "@pierre/diffs";
import {
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  GlobeIcon,
  Maximize2Icon,
  Minimize2Icon,
  WrapTextIcon,
} from "lucide-react";
import type { ScopedThreadRef, ServerProviderSkill } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { isWorkspaceImagePreviewPath } from "@t3tools/shared/filePreview";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import React, {
  Children,
  Suspense,
  type ClipboardEvent as ReactClipboardEvent,
  type MouseEvent as ReactMouseEvent,
  createContext,
  isValidElement,
  use,
  useCallback,
  useContext,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import { defaultUrlTransform } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { renderSkillInlineMarkdownChildren } from "./chat/SkillInlineText";
import { CHAT_FILE_TAG_CHIP_CLASS_NAME, FileTagChipContent } from "./chat/FileTagChip";
import { PierreEntryIcon } from "./chat/PierreEntryIcon";
import { hasSpecificPierreIconForFileName, syntheticFileNameForLanguageId } from "../pierre-icons";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { Button } from "./ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "./ui/collapsible";
import { ScrollArea } from "./ui/scroll-area";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { useOpenInPreferredEditor } from "../editorPreferences";
import { resolveDiffThemeName, type DiffThemeName } from "../lib/diffRendering";
import { fnv1a32 } from "../lib/diffRendering";
import { LRUCache } from "../lib/lruCache";
import { useTheme } from "../hooks/useTheme";
import { getClientSettings } from "../hooks/useSettings";
import {
  chatMarkdownClipboardPayload,
  serializeTableElementToCsv,
  serializeTableElementToMarkdown,
} from "../markdown-clipboard";
import { resolveMarkdownFileLinkMeta, rewriteMarkdownFileUriHref } from "../markdown-links";
import { readLocalApi } from "../localApi";
import { cn } from "../lib/utils";
import { useRightPanelStore } from "../rightPanelStore";
import { useActiveEnvironmentId } from "../state/entities";
import { serverEnvironment } from "../state/server";
import { assetEnvironment } from "../state/assets";
import { usePreparedConnection } from "../state/session";
import { previewEnvironment } from "../state/preview";
import { useAtomCommand } from "../state/use-atom-command";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { isPreviewSupportedInRuntime } from "../previewStateStore";
import { IMAGE_GALLERY_MARKER, remarkImageGallery } from "./chat/remarkImageGallery";
import {
  buildChatMarkdownImageCollection,
  extractMarkdownImageRefs,
  isExternalImageHref,
  normalizeMarkdownLinkHrefKey,
  openMarkdownImageLightbox,
  retainResolvedImageSrc,
  type ChatMarkdownImageCollection,
  type MarkdownImageRef,
} from "./chat/chatMarkdownImages";
import {
  forgetWorkspaceImageUrl,
  readCachedWorkspaceImageSrc,
  readWorkspaceImageUrl,
  rememberWorkspaceImageUrl,
  workspaceImageCacheKey,
} from "./chat/workspaceImageUrlCache";
import {
  isBrowserPreviewFile,
  openFileInPreview,
  openUrlInPreview,
  resolveWorkspaceFileAssets,
  resolveWorkspaceFileAssetUrl,
  BrowserPreviewUnavailableError,
} from "../browser/openFileInPreview";
import { isElectron } from "../env";

class CodeHighlightErrorBoundary extends React.Component<
  { fallback: ReactNode; children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { fallback: ReactNode; children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  override render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

interface ChatMarkdownProps {
  text: string;
  cwd: string | undefined;
  threadRef?: ScopedThreadRef | undefined;
  onTaskListChange?: ((input: { markerOffset: number; checked: boolean }) => void) | undefined;
  isStreaming?: boolean;
  skills?: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  className?: string;
  /** Treat single newlines as hard breaks — chat-style user input. */
  lineBreaks?: boolean;
}

const EMPTY_MARKDOWN_SKILLS: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">> = [];

const CODE_FENCE_LANGUAGE_REGEX = /(?:^|\s)language-([^\s]+)/;
const MAX_HIGHLIGHT_CACHE_ENTRIES = 500;
const MAX_HIGHLIGHT_CACHE_MEMORY_BYTES = 50 * 1024 * 1024;

interface MarkdownActionFailureContext {
  readonly operation: string;
  readonly target?: string;
  readonly format?: "markdown" | "csv";
  readonly language?: string;
  readonly fenceTitle?: string;
  readonly copyTarget?: string;
}

function reportMarkdownActionFailure(context: MarkdownActionFailureContext, cause: unknown): void {
  console.error("[chat-markdown] action failed", context, cause);
}

const highlightedCodeCache = new LRUCache<string>(
  MAX_HIGHLIGHT_CACHE_ENTRIES,
  MAX_HIGHLIGHT_CACHE_MEMORY_BYTES,
);
const highlighterPromiseCache = new Map<string, Promise<DiffsHighlighter>>();

function findTaskListMarkerOffset(markdown: string, listItemStart: number): number | null {
  const firstLineEnd = markdown.indexOf("\n", listItemStart);
  const firstLine = markdown.slice(
    listItemStart,
    firstLineEnd === -1 ? markdown.length : firstLineEnd,
  );
  const match = firstLine.match(/^(?:\s*(?:[-+*]|\d+[.)])\s+)(\[[ xX]\])/);
  if (!match?.[1]) return null;
  return listItemStart + firstLine.indexOf(match[1]);
}
const CHAT_MARKDOWN_SANITIZE_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    "*": (defaultSchema.attributes?.["*"] ?? []).filter((attribute) => attribute !== "title"),
    code: [...(defaultSchema.attributes?.code ?? []), "dataCodeMeta"],
    p: [...(defaultSchema.attributes?.p ?? []), IMAGE_GALLERY_MARKER],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "file"],
  },
} satisfies Parameters<typeof rehypeSanitize>[0];

function extractFenceLanguage(className: string | undefined): string {
  const match = className?.match(CODE_FENCE_LANGUAGE_REGEX);
  const raw = match?.[1] ?? "text";
  // Shiki doesn't bundle a gitignore grammar; ini is a close match (#685)
  return raw === "gitignore" ? "ini" : raw;
}

const FENCE_TITLE_ATTR_REGEX = /(?:^|\s)(?:title|file(?:name)?)=(?:"([^"]+)"|'([^']+)'|(\S+))/i;
const FENCE_FILENAME_TOKEN_REGEX = /^[\w@][\w@./-]*\.[A-Za-z0-9]+$/;

/** Pulls a filename out of fence meta: ```ts title="x.ts" / ```ts src/main.ts */
function extractFenceTitle(meta: string | undefined): string | null {
  if (!meta) return null;
  const attrMatch = FENCE_TITLE_ATTR_REGEX.exec(meta);
  const attrTitle = attrMatch?.[1] ?? attrMatch?.[2] ?? attrMatch?.[3];
  if (attrTitle) return attrTitle;
  return meta.split(/\s+/).find((candidate) => FENCE_FILENAME_TOKEN_REGEX.test(candidate)) ?? null;
}

function extractPreCodeMeta(node: unknown): string | undefined {
  const children = (
    node as
      | {
          children?: Array<{
            type?: string;
            tagName?: string;
            data?: { meta?: unknown };
            properties?: { dataCodeMeta?: unknown };
          }>;
        }
      | undefined
  )?.children;
  const codeNode = children?.find((child) => child?.type === "element" && child.tagName === "code");
  const meta = codeNode?.properties?.dataCodeMeta ?? codeNode?.data?.meta;
  return typeof meta === "string" && meta.trim().length > 0 ? meta.trim() : undefined;
}

type MarkdownAstNode = {
  type?: string;
  meta?: unknown;
  data?: {
    hProperties?: Record<string, unknown>;
  };
  children?: MarkdownAstNode[];
};

function remarkPreserveCodeMeta() {
  return (tree: MarkdownAstNode) => {
    const visit = (node: MarkdownAstNode) => {
      if (node.type === "code" && typeof node.meta === "string" && node.meta.trim().length > 0) {
        node.data = {
          ...node.data,
          hProperties: {
            ...node.data?.hProperties,
            dataCodeMeta: node.meta.trim(),
          },
        };
      }
      node.children?.forEach(visit);
    };

    visit(tree);
  };
}

function nodeToPlainText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child) => nodeToPlainText(child)).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return nodeToPlainText(node.props.children);
  }
  return "";
}

function extractCodeBlock(
  children: ReactNode,
): { className: string | undefined; code: string } | null {
  const childNodes = Children.toArray(children);
  if (childNodes.length !== 1) {
    return null;
  }

  const onlyChild = childNodes[0];
  if (
    !isValidElement<{ className?: string; children?: ReactNode }>(onlyChild) ||
    onlyChild.type !== "code"
  ) {
    return null;
  }

  return {
    className: onlyChild.props.className,
    code: nodeToPlainText(onlyChild.props.children),
  };
}

function createHighlightCacheKey(code: string, language: string, themeName: DiffThemeName): string {
  return `${fnv1a32(code).toString(36)}:${code.length}:${language}:${themeName}`;
}

function estimateHighlightedSize(html: string, code: string): number {
  return Math.max(html.length * 2, code.length * 3);
}

function getHighlighterPromise(language: string): Promise<DiffsHighlighter> {
  const cached = highlighterPromiseCache.get(language);
  if (cached) return cached;

  const promise = getSharedHighlighter({
    themes: [resolveDiffThemeName("dark"), resolveDiffThemeName("light")],
    langs: [language as SupportedLanguages],
    preferredHighlighter: "shiki-js",
  }).catch((err) => {
    highlighterPromiseCache.delete(language);
    if (language === "text") {
      // "text" itself failed — Shiki cannot initialize at all, surface the error
      throw err;
    }
    // Language not supported by Shiki — fall back to "text"
    return getHighlighterPromise("text");
  });
  highlighterPromiseCache.set(language, promise);
  return promise;
}

function readInitialWordWrapSetting(): boolean {
  return getClientSettings().wordWrap;
}

function MarkdownTable({ children, ...props }: React.ComponentProps<"table">) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tableRef = useRef<HTMLTableElement | null>(null);
  const [expanded, setExpanded] = useState(readInitialWordWrapSetting);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const expandLabel = expanded ? "Collapse table cells" : "Expand table cells";
  const copyLabel = copied ? "Copied" : "Copy table";

  function toggleExpanded() {
    const table = tableRef.current;
    if (!table) return;

    if (!expanded) {
      const rows = [...table.rows];
      const columnWidths = rows.reduce<number[]>((widths, row) => {
        [...row.cells].forEach((cell, columnIndex) => {
          widths[columnIndex] = Math.max(
            widths[columnIndex] ?? 0,
            cell.getBoundingClientRect().width,
          );
        });
        return widths;
      }, []);

      [...(table.tHead?.rows[0]?.cells ?? [])].forEach((cell, columnIndex) => {
        cell.style.minWidth = `${columnWidths[columnIndex] ?? cell.getBoundingClientRect().width}px`;
      });
    }

    setExpanded((value) => !value);
  }

  const handleCopy = useCallback((format: "markdown" | "csv") => {
    const table = containerRef.current?.querySelector("table");
    if (!table || typeof navigator === "undefined" || navigator.clipboard == null) {
      return;
    }
    const text =
      format === "markdown"
        ? serializeTableElementToMarkdown(table)
        : serializeTableElementToCsv(table);
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        if (copiedTimerRef.current != null) {
          clearTimeout(copiedTimerRef.current);
        }
        setCopied(true);
        copiedTimerRef.current = setTimeout(() => {
          setCopied(false);
          copiedTimerRef.current = null;
        }, 1200);
      })
      .catch((cause) => {
        reportMarkdownActionFailure({ operation: "copy-table", format }, cause);
      });
  }, []);

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    },
    [],
  );

  return (
    <div
      ref={containerRef}
      className="chat-markdown-table-container"
      data-expanded={expanded ? "true" : "false"}
    >
      <ScrollArea
        chainVerticalScroll
        scrollFade
        hideScrollbars
        className="w-full max-w-full rounded-none"
      >
        <table ref={tableRef} {...props}>
          {children}
        </table>
      </ScrollArea>
      <div className="chat-markdown-table-footer select-none">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="chat-markdown-chrome-action"
                aria-pressed={expanded}
                onClick={toggleExpanded}
                aria-label={expandLabel}
              />
            }
          >
            {expanded ? <Minimize2Icon className="size-3" /> : <Maximize2Icon className="size-3" />}
          </TooltipTrigger>
          <TooltipPopup side="top">{expandLabel}</TooltipPopup>
        </Tooltip>
        <Menu>
          <Tooltip>
            <TooltipTrigger
              render={
                <MenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="chat-markdown-chrome-action"
                      aria-label={copyLabel}
                    />
                  }
                />
              }
            >
              {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
            </TooltipTrigger>
            <TooltipPopup side="top">{copyLabel}</TooltipPopup>
          </Tooltip>
          <MenuPopup align="end">
            <MenuItem onClick={() => handleCopy("markdown")}>Copy as Markdown</MenuItem>
            <MenuItem onClick={() => handleCopy("csv")}>Copy as CSV</MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    </div>
  );
}

function MarkdownDetails({
  children,
  open = false,
}: Pick<React.ComponentProps<"details">, "children" | "open">) {
  const [isOpen, setIsOpen] = useState(open);
  const childNodes = Children.toArray(children);
  const summaryIndex = childNodes.findIndex(
    (child) => isValidElement(child) && child.type === "summary",
  );
  const summaryNode = summaryIndex >= 0 ? childNodes[summaryIndex] : null;
  const summary =
    isValidElement<{ children?: ReactNode }>(summaryNode) && summaryNode.props.children
      ? summaryNode.props.children
      : "Details";
  const content = childNodes.filter((_, index) => index !== summaryIndex);

  return (
    <Collapsible
      defaultOpen={open}
      onOpenChange={setIsOpen}
      className="chat-markdown-details my-2 border-y border-border/60"
      data-markdown-details=""
      data-markdown-details-open={isOpen ? "true" : "false"}
    >
      <CollapsibleTrigger
        className="flex w-full items-center gap-2 py-2 text-left text-sm font-medium text-foreground data-panel-open:[&_svg]:rotate-90"
        data-markdown-details-summary=""
      >
        <ChevronRightIcon
          className="size-4 shrink-0 text-muted-foreground transition-transform"
          aria-hidden
        />
        <span>{summary}</span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="pb-3 ps-6 text-foreground/80" data-markdown-details-content="">
          {content}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

/**
 * Filename titles render icon + text; language-only titles render just the
 * icon (redundant next to its own name) and fall back to the language text
 * when no specific icon exists or it fails to load.
 */
function MarkdownCodeBlockTitleContent({
  fenceTitle,
  language,
  theme,
}: {
  fenceTitle: string | null;
  language: string;
  theme: "light" | "dark";
}) {
  if (fenceTitle) {
    return (
      <>
        <PierreEntryIcon pathValue={fenceTitle} kind="file" theme={theme} className="size-3.5" />
        <span className="truncate">{fenceTitle}</span>
      </>
    );
  }

  const fileName = syntheticFileNameForLanguageId(language);
  if (!hasSpecificPierreIconForFileName(fileName)) {
    return <span className="truncate">{language}</span>;
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="inline-flex shrink-0 rounded-sm" aria-label={`Language: ${language}`} />
        }
      >
        <PierreEntryIcon pathValue={fileName} kind="file" theme={theme} className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">{language}</TooltipPopup>
    </Tooltip>
  );
}

function MarkdownCodeBlock({
  code,
  language,
  fenceTitle,
  theme,
  children,
}: {
  code: string;
  language: string;
  fenceTitle: string | null;
  theme: "light" | "dark";
  children: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const [wrapped, setWrapped] = useState(readInitialWordWrapSetting);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapLabel = wrapped ? "Disable line wrap" : "Wrap lines";
  const copyLabel = copied ? "Copied" : "Copy code";

  const handleCopy = useCallback(() => {
    if (typeof navigator === "undefined" || navigator.clipboard == null) {
      return;
    }
    void navigator.clipboard
      .writeText(code)
      .then(() => {
        if (copiedTimerRef.current != null) {
          clearTimeout(copiedTimerRef.current);
        }
        setCopied(true);
        copiedTimerRef.current = setTimeout(() => {
          setCopied(false);
          copiedTimerRef.current = null;
        }, 1200);
      })
      .catch((cause) => {
        reportMarkdownActionFailure(
          {
            operation: "copy-code-block",
            language,
            ...(fenceTitle ? { fenceTitle } : {}),
          },
          cause,
        );
      });
  }, [code, fenceTitle, language]);

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    },
    [],
  );

  return (
    <div
      className="chat-markdown-codeblock leading-snug"
      data-language={language}
      data-wrap={wrapped ? "true" : "false"}
    >
      <div className="chat-markdown-codeblock-header select-none">
        <span className="chat-markdown-codeblock-title">
          <MarkdownCodeBlockTitleContent
            fenceTitle={fenceTitle}
            language={language}
            theme={theme}
          />
        </span>
        <span className="flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="chat-markdown-chrome-action"
                  aria-pressed={wrapped}
                  onClick={() => setWrapped((value) => !value)}
                  aria-label={wrapLabel}
                />
              }
            >
              <WrapTextIcon className="size-3" />
            </TooltipTrigger>
            <TooltipPopup side="top">{wrapLabel}</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="chat-markdown-chrome-action"
                  onClick={handleCopy}
                  aria-label={copyLabel}
                />
              }
            >
              {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
            </TooltipTrigger>
            <TooltipPopup side="top">{copyLabel}</TooltipPopup>
          </Tooltip>
        </span>
      </div>
      {children}
    </div>
  );
}

interface SuspenseShikiCodeBlockProps {
  className: string | undefined;
  code: string;
  themeName: DiffThemeName;
  isStreaming: boolean;
}

function SuspenseShikiCodeBlock({
  className,
  code,
  themeName,
  isStreaming,
}: SuspenseShikiCodeBlockProps) {
  const language = extractFenceLanguage(className);
  const cacheKey = createHighlightCacheKey(code, language, themeName);
  const cachedHighlightedHtml = !isStreaming ? highlightedCodeCache.get(cacheKey) : null;

  if (cachedHighlightedHtml != null) {
    return (
      <div
        className="chat-markdown-shiki"
        dangerouslySetInnerHTML={{ __html: cachedHighlightedHtml }}
      />
    );
  }

  return (
    <UncachedShikiCodeBlock
      code={code}
      language={language}
      themeName={themeName}
      cacheKey={cacheKey}
      isStreaming={isStreaming}
    />
  );
}

interface UncachedShikiCodeBlockProps {
  code: string;
  language: string;
  themeName: DiffThemeName;
  cacheKey: string;
  isStreaming: boolean;
}

function UncachedShikiCodeBlock({
  code,
  language,
  themeName,
  cacheKey,
  isStreaming,
}: UncachedShikiCodeBlockProps) {
  const highlighter = use(getHighlighterPromise(language));
  const highlightedHtml = useMemo(() => {
    try {
      return highlighter.codeToHtml(code, { lang: language, theme: themeName });
    } catch (error) {
      // Log highlighting failures for debugging while falling back to plain text
      console.warn(
        `Code highlighting failed for language "${language}", falling back to plain text.`,
        error instanceof Error ? error.message : error,
      );
      // If highlighting fails for this language, render as plain text
      return highlighter.codeToHtml(code, { lang: "text", theme: themeName });
    }
  }, [code, highlighter, language, themeName]);

  useEffect(() => {
    if (!isStreaming) {
      highlightedCodeCache.set(
        cacheKey,
        highlightedHtml,
        estimateHighlightedSize(highlightedHtml, code),
      );
    }
  }, [cacheKey, code, highlightedHtml, isStreaming]);

  return (
    <div className="chat-markdown-shiki" dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
  );
}

interface MarkdownFileLinkProps {
  href: string;
  targetPath: string;
  iconPath: string;
  displayPath: string;
  workspaceRelativePath: string | null;
  line?: number | undefined;
  label: string;
  copyMarkdown: string;
  theme: "light" | "dark";
  threadRef?: ScopedThreadRef | undefined;
  onOpen: (targetPath: string) => Promise<AtomCommandResult<unknown, unknown>>;
  onOpenInBrowser?: (() => Promise<AtomCommandResult<unknown, unknown>>) | undefined;
  className?: string | undefined;
}

const MARKDOWN_LINK_HREF_PATTERN = /\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
const MARKDOWN_FILE_LINK_CLASS_NAME =
  "chat-markdown-file-link cursor-pointer transition-colors hover:bg-accent/70";

function pathParentSegments(path: string): string[] {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  return segments.slice(0, -1);
}

function buildFileLinkParentSuffixByPath(filePaths: ReadonlyArray<string>): Map<string, string> {
  const groups = new Map<string, Set<string>>();
  for (const filePath of filePaths) {
    const pathSegments = filePath
      .replaceAll("\\", "/")
      .split("/")
      .filter((segment) => segment.length > 0);
    const basename = pathSegments[pathSegments.length - 1];
    if (!basename) continue;
    const group = groups.get(basename) ?? new Set<string>();
    group.add(filePath);
    groups.set(basename, group);
  }

  const suffixByPath = new Map<string, string>();
  for (const group of groups.values()) {
    const uniquePaths = [...group];
    if (uniquePaths.length < 2) continue;

    const parentSegmentsByPath = new Map(
      uniquePaths.map((filePath) => [filePath, pathParentSegments(filePath)]),
    );
    const minUniqueDepthByPath = new Map<string, number>();

    for (const filePath of uniquePaths) {
      const segments = parentSegmentsByPath.get(filePath) ?? [];
      let resolvedDepth = segments.length;
      for (let depth = 1; depth <= segments.length; depth += 1) {
        const candidate = segments.slice(-depth).join("/");
        const collision = uniquePaths.some((otherPath) => {
          if (otherPath === filePath) return false;
          const otherSegments = parentSegmentsByPath.get(otherPath) ?? [];
          return otherSegments.slice(-depth).join("/") === candidate;
        });
        if (!collision) {
          resolvedDepth = depth;
          break;
        }
      }
      minUniqueDepthByPath.set(filePath, resolvedDepth);
    }

    for (const filePath of uniquePaths) {
      const segments = parentSegmentsByPath.get(filePath) ?? [];
      if (segments.length === 0) continue;
      const minUniqueDepth = minUniqueDepthByPath.get(filePath) ?? 1;
      const suffixDepth = Math.min(segments.length, Math.max(minUniqueDepth, 2));
      suffixByPath.set(filePath, segments.slice(-suffixDepth).join("/"));
    }
  }

  return suffixByPath;
}

function extractMarkdownLinkHrefs(text: string): string[] {
  const hrefs: string[] = [];
  for (const match of text.matchAll(MARKDOWN_LINK_HREF_PATTERN)) {
    const href = match[1]?.trim();
    if (!href) continue;
    hrefs.push(href);
  }
  return hrefs;
}

const MARKDOWN_LINK_FAVICON_CLASS_NAME = "block size-full shrink-0 select-none";

/** Hosts whose favicon request already failed this session — skip straight to the globe. */
const failedFaviconHosts = new Set<string>();

function resolveExternalLinkHost(href: string | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.hostname || null;
  } catch {
    return null;
  }
}

const MarkdownLinkFavicon = memo(function MarkdownLinkFavicon({ host }: { host: string }) {
  const [failedHost, setFailedHost] = useState<string | null>(null);
  return (
    <span className="chat-markdown-link-favicon" aria-hidden>
      {failedHost === host || failedFaviconHosts.has(host) ? (
        <GlobeIcon className={MARKDOWN_LINK_FAVICON_CLASS_NAME} />
      ) : (
        <img
          src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`}
          alt=""
          loading="lazy"
          draggable={false}
          className={cn(MARKDOWN_LINK_FAVICON_CLASS_NAME, "rounded-sm")}
          onError={() => {
            failedFaviconHosts.add(host);
            setFailedHost(host);
          }}
        />
      )}
    </span>
  );
});

function leadingExternalLinkTextLength(text: string): number {
  const protocol = /^(?:https?:\/\/)/i.exec(text)?.[0];
  if (protocol) return protocol.length;
  return Math.min(text.length, 1);
}

function breakableExternalLinkText(text: string): ReactNode[] {
  return Array.from(text, (character, index) => (
    <React.Fragment key={`${index}:${character}`}>
      {character}
      <wbr />
    </React.Fragment>
  ));
}

function plainHastText(node: unknown): string | null {
  if (!node || typeof node !== "object" || !("children" in node) || !Array.isArray(node.children)) {
    return null;
  }
  const parts = node.children.map((child) => {
    if (
      child &&
      typeof child === "object" &&
      "type" in child &&
      child.type === "text" &&
      "value" in child &&
      typeof child.value === "string"
    ) {
      return child.value;
    }
    return null;
  });
  return parts.every((part) => part !== null) ? parts.join("") : null;
}

const SANITIZED_FRAGMENT_PREFIX = "user-content-";

function decodeMarkdownFragmentId(href: string): string {
  const encodedId = href.slice(1);
  try {
    return decodeURIComponent(encodedId);
  } catch {
    return encodedId;
  }
}

function normalizeSanitizedFragmentId(id: string): string {
  let normalizedId = id;
  while (normalizedId.startsWith(SANITIZED_FRAGMENT_PREFIX)) {
    normalizedId = normalizedId.slice(SANITIZED_FRAGMENT_PREFIX.length);
  }
  return normalizedId;
}

function findMarkdownFragmentTarget(anchor: HTMLAnchorElement, href: string): HTMLElement | null {
  const decodedId = decodeMarkdownFragmentId(href);
  const normalizedId = normalizeSanitizedFragmentId(decodedId);
  const matchesFragment = (element: HTMLElement) =>
    element.id === decodedId || normalizeSanitizedFragmentId(element.id) === normalizedId;
  const markdownRoot = anchor.closest<HTMLElement>(".chat-markdown");
  if (markdownRoot) {
    const localTargets = Array.from(markdownRoot.querySelectorAll<HTMLElement>("[id]"));
    const localTarget = localTargets.find(matchesFragment);
    if (localTarget) return localTarget;
  }

  return (
    document.getElementById(decodedId) ??
    Array.from(document.querySelectorAll<HTMLElement>("[id]")).find(matchesFragment) ??
    null
  );
}

function handleMarkdownFragmentClick(event: ReactMouseEvent<HTMLAnchorElement>, href: string) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return;
  }

  const target = findMarkdownFragmentTarget(event.currentTarget, href);
  if (!target) return;

  event.preventDefault();
  const nextUrl = new URL(window.location.href);
  nextUrl.hash = href.slice(1);
  window.history.pushState(window.history.state, "", nextUrl);
  target.scrollIntoView({ block: "nearest" });
}

function MarkdownExternalLinkContent({
  host,
  plainText,
  children,
}: {
  host: string;
  plainText: string | null;
  children: ReactNode;
}) {
  if (plainText) {
    const leadingLength = leadingExternalLinkTextLength(plainText);
    return (
      <>
        <span className="chat-markdown-link-leading">
          <MarkdownLinkFavicon host={host} />
          {plainText.slice(0, leadingLength)}
        </span>
        {breakableExternalLinkText(plainText.slice(leadingLength))}
      </>
    );
  }

  const childNodes = Children.toArray(children);
  const firstChild = childNodes[0];

  if (typeof firstChild === "string" && firstChild.length > 0) {
    const leadingLength = leadingExternalLinkTextLength(firstChild);
    return (
      <>
        <span className="chat-markdown-link-leading">
          <MarkdownLinkFavicon host={host} />
          {firstChild.slice(0, leadingLength)}
        </span>
        {breakableExternalLinkText(firstChild.slice(leadingLength))}
        {childNodes.slice(1)}
      </>
    );
  }

  return (
    <>
      <span className="chat-markdown-link-leading">
        <MarkdownLinkFavicon host={host} />
        {firstChild}
      </span>
      {childNodes.slice(1)}
    </>
  );
}

const MarkdownFileLink = memo(function MarkdownFileLink({
  href,
  targetPath,
  iconPath,
  displayPath,
  workspaceRelativePath,
  line,
  label,
  copyMarkdown,
  theme,
  threadRef,
  onOpen,
  onOpenInBrowser,
  className,
}: MarkdownFileLinkProps) {
  const handleOpenInEditor = useCallback(() => {
    void (async () => {
      try {
        const result = await onOpen(targetPath);
        if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
          return;
        }
        reportMarkdownActionFailure(
          { operation: "open-file-in-editor", target: targetPath },
          result.cause,
        );
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open file",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      } catch (cause) {
        reportMarkdownActionFailure(
          { operation: "open-file-in-editor", target: targetPath },
          cause,
        );
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open file",
            description: cause instanceof Error ? cause.message : "An error occurred.",
          }),
        );
      }
    })();
  }, [onOpen, targetPath]);

  const handleOpenInFilePreview = useCallback(() => {
    if (!threadRef || !workspaceRelativePath) {
      handleOpenInEditor();
      return;
    }
    useRightPanelStore.getState().openFile(threadRef, workspaceRelativePath, line);
  }, [handleOpenInEditor, line, threadRef, workspaceRelativePath]);

  const handleOpenInBrowser = useCallback(() => {
    if (!onOpenInBrowser) {
      return;
    }
    void (async () => {
      try {
        const result = await onOpenInBrowser();
        if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
          return;
        }
        reportMarkdownActionFailure(
          { operation: "open-file-in-browser", target: targetPath },
          result.cause,
        );
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open file in browser",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      } catch (cause) {
        reportMarkdownActionFailure(
          { operation: "open-file-in-browser", target: targetPath },
          cause,
        );
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open file in browser",
            description: cause instanceof Error ? cause.message : "An error occurred.",
          }),
        );
      }
    })();
  }, [onOpenInBrowser, targetPath]);

  const handleCopy = useCallback(
    (value: string, title: string) => {
      if (typeof window === "undefined" || !navigator.clipboard?.writeText) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Failed to copy ${title.toLowerCase()}`,
            description: "Clipboard API unavailable.",
          }),
        );
        return;
      }

      void navigator.clipboard.writeText(value).then(
        () => {
          toastManager.add({
            type: "success",
            title: `${title} copied`,
            description: value,
          });
        },
        (error) => {
          reportMarkdownActionFailure(
            { operation: "copy-file-path", target: targetPath, copyTarget: title },
            error,
          );
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: `Failed to copy ${title.toLowerCase()}`,
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        },
      );
    },
    [targetPath],
  );

  const handleContextMenu = useCallback(
    async (event: ReactMouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      event.stopPropagation();

      const api = readLocalApi();
      if (!api) return;

      try {
        const clicked = await api.contextMenu.show(
          [
            { id: "open", label: "Open in editor" },
            ...(onOpenInBrowser
              ? ([{ id: "open-in-browser", label: "Open in integrated browser" }] as const)
              : []),
            { id: "copy-relative", label: "Copy relative path" },
            { id: "copy-full", label: "Copy full path" },
          ] as const,
          { x: event.clientX, y: event.clientY },
        );

        if (clicked === "open") {
          handleOpenInEditor();
          return;
        }
        if (clicked === "open-in-browser") {
          handleOpenInBrowser();
          return;
        }
        if (clicked === "copy-relative") {
          handleCopy(displayPath, "Relative path");
          return;
        }
        if (clicked === "copy-full") {
          handleCopy(targetPath, "Full path");
        }
      } catch (cause) {
        reportMarkdownActionFailure(
          { operation: "show-file-context-menu", target: targetPath },
          cause,
        );
      }
    },
    [displayPath, handleCopy, handleOpenInBrowser, handleOpenInEditor, onOpenInBrowser, targetPath],
  );

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <a
            href={href}
            className={cn(CHAT_FILE_TAG_CHIP_CLASS_NAME, MARKDOWN_FILE_LINK_CLASS_NAME, className)}
            data-markdown-copy={copyMarkdown}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (onOpenInBrowser) {
                handleOpenInBrowser();
                return;
              }
              handleOpenInFilePreview();
            }}
            onContextMenu={handleContextMenu}
          >
            <FileTagChipContent path={iconPath} label={label} theme={theme} selectable />
          </a>
        }
      />
      <TooltipPopup
        side="top"
        className="max-w-[min(40rem,calc(100vw-2rem))] font-mono text-[11px] leading-tight"
      >
        <div className="markdown-file-link-tooltip-scroll overflow-x-auto whitespace-nowrap">
          {displayPath}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}, areMarkdownFileLinkPropsEqual);

function areMarkdownFileLinkPropsEqual(
  previous: Readonly<MarkdownFileLinkProps>,
  next: Readonly<MarkdownFileLinkProps>,
): boolean {
  return (
    previous.href === next.href &&
    previous.targetPath === next.targetPath &&
    previous.iconPath === next.iconPath &&
    previous.displayPath === next.displayPath &&
    previous.workspaceRelativePath === next.workspaceRelativePath &&
    previous.line === next.line &&
    previous.label === next.label &&
    previous.copyMarkdown === next.copyMarkdown &&
    previous.theme === next.theme &&
    previous.threadRef === next.threadRef &&
    previous.onOpen === next.onOpen &&
    previous.onOpenInBrowser === next.onOpenInBrowser &&
    previous.className === next.className
  );
}

/** Resolves a set of workspace paths to displayable URLs, one slot per path, in order. */
type WorkspaceImageUrlResolver = (
  filePaths: ReadonlyArray<string>,
) => Promise<ReadonlyArray<string | null>>;

const EMPTY_IMAGE_HREFS: ReadonlyArray<string> = [];

/** Two attempts cover an expired token; beyond that the image is genuinely gone. */
const MAX_IMAGE_RESOLVE_ATTEMPTS = 2;

const ChatMarkdownImageCollectionContext = createContext<ChatMarkdownImageCollection | null>(null);

/** Standalone images keep their natural width; gallery images fill a square grid cell. */
const ChatMarkdownImageLayoutContext = createContext<"standalone" | "gallery">("standalone");

/**
 * Wider grids for bigger sets, but never so narrow that a cell stops being readable.
 * `auto-fit` then reflows the row on narrow viewports.
 */
function galleryGridColumns(count: number): string {
  const minCellPx = count >= 9 ? 108 : count >= 5 ? 132 : 160;
  return `repeat(auto-fit, minmax(${minCellPx}px, 1fr))`;
}

interface ChatMarkdownImageProps extends React.ComponentProps<"img"> {
  href: string;
  displayPath: string;
  alt: string;
  /** Workspace images show their path on hover; external URLs don't need the tooltip. */
  showPathTooltip: boolean;
}

/**
 * Renders one markdown image. Workspace-relative images (`![alt](.t3-images/shot.png)`)
 * read their signed asset URL from the message-level batch in context — resolving them
 * together is what lets a single message carry several images. Clicking opens the
 * lightbox on the whole set.
 */
const ChatMarkdownImage = memo(function ChatMarkdownImage({
  href,
  displayPath,
  alt,
  showPathTooltip,
  className,
  ...props
}: ChatMarkdownImageProps) {
  const collection = useContext(ChatMarkdownImageCollectionContext);
  const layout = useContext(ChatMarkdownImageLayoutContext);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const entry = collection?.entryByHref.get(href) ?? null;
  const assetUrl = entry?.src ?? null;
  const requestImage = collection?.request;
  const isKnownImage = entry !== null;

  // The up-front scan of the message text misses reference-style markdown and raw
  // HTML images, so an unknown href asks to join the batch.
  useEffect(() => {
    if (!isKnownImage && requestImage && href) requestImage(href);
  }, [href, isKnownImage, requestImage]);

  const inGallery = layout === "gallery";

  // Unresolvable (missing file, disconnected environment, expired token) — degrade to
  // the alt text rather than a broken-image icon.
  if ((assetUrl === null && collection?.isSettled(href) === true) || failedSrc === assetUrl) {
    return (
      <span
        className={cn(
          "chat-markdown-image-fallback text-xs text-muted-foreground",
          // Keep the cell so the rest of the grid doesn't reflow around the gap.
          inGallery &&
            "flex aspect-square items-center justify-center rounded-md border border-border/60 p-2 text-center",
        )}
      >
        {alt || displayPath}
      </span>
    );
  }

  if (assetUrl === null) {
    return (
      <span
        className={cn(
          "chat-markdown-image-loading animate-pulse bg-muted",
          inGallery
            ? "block aspect-square size-full rounded-md"
            : "inline-block h-4 w-24 rounded-sm align-middle",
        )}
        aria-busy="true"
        aria-label={alt || displayPath}
      />
    );
  }

  const isGalleryCell = inGallery;
  const image = (
    <button
      type="button"
      className={cn(
        "chat-markdown-image-button cursor-zoom-in border-0 bg-transparent p-0 text-left",
        isGalleryCell
          ? "block size-full overflow-hidden rounded-md border border-border/60"
          : "block",
      )}
      aria-label={`Open ${alt || displayPath} in the image viewer`}
      onClick={() => {
        if (collection) openMarkdownImageLightbox(collection, href);
      }}
    >
      <img
        {...props}
        src={assetUrl}
        alt={alt}
        loading="lazy"
        className={cn(
          "chat-markdown-image",
          isGalleryCell
            ? "aspect-square size-full object-cover transition-transform duration-200 hover:scale-[1.03]"
            : "my-2 h-auto max-w-full rounded-md border border-border/60",
          className,
        )}
        onError={() => {
          setFailedSrc(assetUrl);
          // A URL kept from an earlier mount can outlive its token; asking for a fresh one
          // swaps `assetUrl` and clears the fallback below on the next render.
          collection?.retry(href);
        }}
      />
    </button>
  );

  // In a grid the path tooltip would fire on every cell the pointer crosses.
  if (!showPathTooltip || isGalleryCell) return image;

  return (
    <Tooltip>
      <TooltipTrigger render={image} />
      <TooltipPopup side="top" className="font-mono text-[11px] leading-tight">
        {displayPath}
      </TooltipPopup>
    </Tooltip>
  );
});

function ChatMarkdown({
  text,
  cwd,
  threadRef,
  onTaskListChange,
  isStreaming = false,
  skills = EMPTY_MARKDOWN_SKILLS,
  className,
  lineBreaks = false,
}: ChatMarkdownProps) {
  const { resolvedTheme } = useTheme();
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
  });
  const createAssetUrls = useAtomQueryRunner(assetEnvironment.createUrlBatch, {
    reportFailure: false,
  });
  const openPreview = useAtomCommand(previewEnvironment.open, {
    reportFailure: false,
  });
  const preparedConnection = usePreparedConnection(threadRef?.environmentId ?? null);
  const environmentId = useActiveEnvironmentId();
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const openInPreferredEditor = useOpenInPreferredEditor(
    environmentId,
    serverConfig?.availableEditors ?? [],
  );
  const diffThemeName = resolveDiffThemeName(resolvedTheme);
  const markdownFileLinkMetaByHref = useMemo(() => {
    const metaByHref = new Map<
      string,
      NonNullable<ReturnType<typeof resolveMarkdownFileLinkMeta>>
    >();
    for (const href of extractMarkdownLinkHrefs(text)) {
      const normalizedHref = normalizeMarkdownLinkHrefKey(href);
      if (metaByHref.has(normalizedHref)) continue;
      const meta = resolveMarkdownFileLinkMeta(normalizedHref, cwd);
      if (meta) {
        metaByHref.set(normalizedHref, meta);
      }
    }
    return metaByHref;
  }, [cwd, text]);
  const fileLinkParentSuffixByPath = useMemo(() => {
    const filePaths = [...markdownFileLinkMetaByHref.values()].map((meta) => meta.filePath);
    return buildFileLinkParentSuffixByPath(filePaths);
  }, [markdownFileLinkMetaByHref]);
  const markdownUrlTransform = useCallback((href: string) => {
    return rewriteMarkdownFileUriHref(href) ?? defaultUrlTransform(href);
  }, []);
  // Re-emit highlighted content as markdown so copying out of the rendered
  // view keeps links, emphasis, lists, and code fences intact.
  const handleCopy = useCallback((event: ReactClipboardEvent<HTMLDivElement>) => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !event.clipboardData) return;
    const payload = chatMarkdownClipboardPayload(selection);
    if (!payload) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", payload.text);
    event.clipboardData.setData("text/html", payload.html);
  }, []);
  const openExternalLinkInPreview = useCallback(
    (url: string) => {
      if (!threadRef) {
        return Promise.resolve(
          AsyncResult.failure<void, BrowserPreviewUnavailableError>(
            Cause.fail(
              new BrowserPreviewUnavailableError({
                message: "Thread context is unavailable.",
              }),
            ),
          ),
        );
      }
      return openUrlInPreview({ threadRef, url, openPreview });
    },
    [openPreview, threadRef],
  );
  const openMarkdownFileInPreview = useCallback(
    (path: string) => {
      if (!threadRef || preparedConnection._tag === "None") {
        return Promise.resolve(
          AsyncResult.failure<void, BrowserPreviewUnavailableError>(
            Cause.fail(
              new BrowserPreviewUnavailableError({
                message: "Environment is not connected.",
              }),
            ),
          ),
        );
      }
      const httpBaseUrl = preparedConnection.value.httpBaseUrl;
      if (!isElectron) {
        // There is no in-app browser on web, so open the backend-served file in
        // a new tab. Open the tab synchronously (still within the click gesture)
        // so it isn't blocked as a popup, then point it at the resolved asset
        // URL once it's available.
        const tab = typeof window === "undefined" ? null : window.open("", "_blank");
        if (tab) tab.opener = null;
        return (async () => {
          const assetUrlResult = await resolveWorkspaceFileAssetUrl({
            threadRef,
            filePath: path,
            httpBaseUrl,
            createAssetUrl,
          });
          if (assetUrlResult._tag === "Failure") {
            tab?.close();
            return assetUrlResult;
          }
          if (tab) {
            tab.location.href = assetUrlResult.value;
          } else {
            window.open(assetUrlResult.value, "_blank", "noopener,noreferrer");
          }
          return AsyncResult.success(undefined);
        })();
      }
      return openFileInPreview({
        threadRef,
        filePath: path,
        httpBaseUrl,
        createAssetUrl,
        openPreview,
      });
    },
    [createAssetUrl, openPreview, preparedConnection, threadRef],
  );
  /**
   * Mint signed asset URLs for the message's workspace images — cached ones for free, the
   * rest in a single round trip. A path resolves to null when it can't be served (no
   * thread context, disconnected environment, or the path escapes the workspace root).
   */
  const resolveWorkspaceImageUrls = useCallback<WorkspaceImageUrlResolver>(
    async (filePaths) => {
      if (!threadRef || preparedConnection._tag === "None") return filePaths.map(() => null);
      // A URL minted for this file by any earlier mount is still good, and reusing it is
      // what keeps the browser cache warm — a fresh token is a fresh URL, and a fresh URL
      // is a full re-download.
      const cacheKeys = filePaths.map((filePath) =>
        workspaceImageCacheKey(threadRef.environmentId, filePath),
      );
      const cached = cacheKeys.map((cacheKey) => readWorkspaceImageUrl(cacheKey));
      const missingIndexes = cached.flatMap((url, index) => (url === null ? [index] : []));
      if (missingIndexes.length === 0) return cached;

      const missingPaths = missingIndexes.map((index) => filePaths[index] as string);
      const result = await resolveWorkspaceFileAssets({
        threadRef,
        filePaths: missingPaths,
        httpBaseUrl: preparedConnection.value.httpBaseUrl,
        createAssetUrls,
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          reportMarkdownActionFailure(
            { operation: "resolve-markdown-images", target: missingPaths.join(", ") },
            result.cause,
          );
        }
        return cached;
      }
      const resolved = [...cached];
      missingIndexes.forEach((targetIndex, batchIndex) => {
        const asset = result.value[batchIndex] ?? null;
        if (asset === null) return;
        rememberWorkspaceImageUrl(cacheKeys[targetIndex] as string, asset);
        resolved[targetIndex] = asset.url;
      });
      return resolved;
    },
    [createAssetUrls, preparedConnection, threadRef],
  );
  const canRenderWorkspaceImages = Boolean(threadRef) && preparedConnection._tag === "Some";
  // Collect the message's images once, keyed by normalized destination. Recomputing the
  // list from `text` on every streamed token would restart resolution, so the key string
  // is what the memo below keys on: it only changes when the set of images changes.
  const markdownImageRefsKey = useMemo(
    () => JSON.stringify(extractMarkdownImageRefs(text)),
    [text],
  );
  const markdownImageRefs = useMemo(
    () => JSON.parse(markdownImageRefsKey) as MarkdownImageRef[],
    [markdownImageRefsKey],
  );
  // Images the `![](…)` scan cannot see (reference-style markdown, raw HTML) register
  // themselves as they render and join the same batch.
  const [requestedImageHrefs, setRequestedImageHrefs] =
    useState<ReadonlyArray<string>>(EMPTY_IMAGE_HREFS);
  const requestImageHref = useCallback((href: string) => {
    setRequestedImageHrefs((current) => (current.includes(href) ? current : [...current, href]));
  }, []);
  const markdownImageEntryRefs = useMemo<ReadonlyArray<MarkdownImageRef>>(() => {
    const knownHrefs = new Set(markdownImageRefs.map((ref) => ref.href));
    return [
      ...markdownImageRefs,
      ...requestedImageHrefs
        .filter((href) => !knownHrefs.has(href))
        .map((href) => ({ href, alt: "" })),
    ];
  }, [markdownImageRefs, requestedImageHrefs]);
  const workspaceImageTargets = useMemo(() => {
    return markdownImageEntryRefs.flatMap((ref) => {
      const meta = resolveMarkdownFileLinkMeta(ref.href, cwd);
      return meta && isWorkspaceImagePreviewPath(meta.filePath)
        ? [{ href: ref.href, filePath: meta.filePath }]
        : [];
    });
  }, [cwd, markdownImageEntryRefs]);
  // Asset URLs are minted by the thread's environment, not whichever one is on screen.
  const imageEnvironmentId = threadRef?.environmentId ?? null;
  // Seed from the process-wide cache so a thread the user already visited paints its
  // images on the first render, with no round trip and no cache-busting re-mint.
  const [workspaceImageSrcByHref, setWorkspaceImageSrcByHref] = useState<
    ReadonlyMap<string, string | null>
  >(() => readCachedWorkspaceImageSrc(imageEnvironmentId, workspaceImageTargets));
  const workspaceImageSrcRef = useRef(workspaceImageSrcByHref);
  const workspaceImageResolverRef = useRef<WorkspaceImageUrlResolver | null>(null);
  const imageResolveAttemptsRef = useRef<Map<string, number>>(new Map());
  const [imageResolveNonce, setImageResolveNonce] = useState(0);
  const applyWorkspaceImageSrc = useCallback((next: ReadonlyMap<string, string | null>) => {
    workspaceImageSrcRef.current = next;
    setWorkspaceImageSrcByHref(next);
  }, []);
  // Mint the asset URLs for every workspace image in the message as one batch — one
  // request for the whole message, not one per image. Doing it here rather than inside
  // each <img> is what makes that batching possible, and it survives the component
  // remounts that streaming causes.
  useEffect(() => {
    // A new resolver means a new connection (or thread): the failures are worth retrying,
    // the resolved URLs are worth keeping.
    if (workspaceImageResolverRef.current !== resolveWorkspaceImageUrls) {
      workspaceImageResolverRef.current = resolveWorkspaceImageUrls;
      const retained = retainResolvedImageSrc(workspaceImageSrcRef.current);
      if (retained !== workspaceImageSrcRef.current) applyWorkspaceImageSrc(retained);
    }
    if (!canRenderWorkspaceImages) return;
    const pending = workspaceImageTargets.filter(
      (target) => !workspaceImageSrcRef.current.has(target.href),
    );
    if (pending.length === 0) return;
    let cancelled = false;
    void (async () => {
      const urls = await resolveWorkspaceImageUrls(pending.map((target) => target.filePath)).catch(
        (cause: unknown) => {
          reportMarkdownActionFailure(
            {
              operation: "resolve-markdown-images",
              target: pending.map((t) => t.filePath).join(", "),
            },
            cause,
          );
          return pending.map(() => null);
        },
      );
      if (cancelled) return;
      const next = new Map(workspaceImageSrcRef.current);
      pending.forEach((target, index) => next.set(target.href, urls[index] ?? null));
      applyWorkspaceImageSrc(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    applyWorkspaceImageSrc,
    canRenderWorkspaceImages,
    imageResolveNonce,
    resolveWorkspaceImageUrls,
    workspaceImageTargets,
  ]);
  // An image whose URL the browser rejected — an expired or revoked token — is the one
  // case worth re-minting for. Forgetting the cached URL sends the batch above back out.
  const retryImageHref = useCallback(
    (href: string) => {
      const attempts = imageResolveAttemptsRef.current.get(href) ?? 0;
      if (attempts >= MAX_IMAGE_RESOLVE_ATTEMPTS) return;
      imageResolveAttemptsRef.current.set(href, attempts + 1);
      const meta = resolveMarkdownFileLinkMeta(href, cwd);
      if (meta && imageEnvironmentId && isWorkspaceImagePreviewPath(meta.filePath)) {
        forgetWorkspaceImageUrl(workspaceImageCacheKey(imageEnvironmentId, meta.filePath));
      }
      const next = new Map(workspaceImageSrcRef.current);
      next.delete(href);
      applyWorkspaceImageSrc(next);
      setImageResolveNonce((nonce) => nonce + 1);
    },
    [applyWorkspaceImageSrc, cwd, imageEnvironmentId],
  );
  const markdownImageCollection = useMemo<ChatMarkdownImageCollection>(() => {
    const entries = markdownImageEntryRefs.map((ref) => {
      const meta = resolveMarkdownFileLinkMeta(ref.href, cwd);
      const isWorkspaceImage = Boolean(meta && isWorkspaceImagePreviewPath(meta.filePath));
      const src =
        isWorkspaceImage && canRenderWorkspaceImages
          ? (workspaceImageSrcByHref.get(ref.href) ?? null)
          : isExternalImageHref(ref.href)
            ? ref.href
            : null;
      return { href: ref.href, name: ref.alt || meta?.basename || ref.href, src };
    });
    return buildChatMarkdownImageCollection({
      entries,
      isSettled: (href) => workspaceImageSrcByHref.has(href),
      request: requestImageHref,
      retry: retryImageHref,
    });
  }, [
    canRenderWorkspaceImages,
    cwd,
    markdownImageEntryRefs,
    requestImageHref,
    retryImageHref,
    workspaceImageSrcByHref,
  ]);
  const markdownComponents = useMemo<Components>(
    () => ({
      img({ node: _node, src, alt, ...props }) {
        const altText = alt ?? "";
        const rawSrc = typeof src === "string" ? src : "";
        const href = rawSrc ? normalizeMarkdownLinkHrefKey(rawSrc) : "";
        // Only workspace-relative paths are rewritten; http(s) images already render
        // natively and are left untouched apart from becoming lightbox-openable.
        const imageMeta = href ? resolveMarkdownFileLinkMeta(href, cwd) : null;
        const isWorkspaceImage =
          Boolean(imageMeta && isWorkspaceImagePreviewPath(imageMeta.filePath)) &&
          canRenderWorkspaceImages;
        if (!isWorkspaceImage && !isExternalImageHref(href)) {
          // The sanitizer drops disallowed protocols (data:, javascript:) by removing
          // `src` entirely — keep it absent rather than emitting src="", which makes
          // browsers re-request the current page.
          return rawSrc ? (
            <img {...props} src={rawSrc} alt={altText} />
          ) : (
            <img {...props} alt={altText} />
          );
        }
        return (
          <ChatMarkdownImage
            {...props}
            href={href}
            displayPath={isWorkspaceImage && imageMeta ? imageMeta.displayPath : href}
            alt={altText || (isWorkspaceImage ? (imageMeta?.basename ?? "") : "")}
            showPathTooltip={isWorkspaceImage}
          />
        );
      },
      p({ node, children, ...props }) {
        // A run of image-only paragraphs was merged by remarkImageGallery — render the
        // set as a grid instead of a column of full-width images.
        const galleryCount = Number(node?.properties?.[IMAGE_GALLERY_MARKER] ?? 0);
        if (galleryCount >= 2) {
          return (
            <div
              className="chat-markdown-image-gallery my-2 grid gap-1.5"
              style={{ gridTemplateColumns: galleryGridColumns(galleryCount) }}
            >
              <ChatMarkdownImageLayoutContext.Provider value="gallery">
                {children}
              </ChatMarkdownImageLayoutContext.Provider>
            </div>
          );
        }
        return <p {...props}>{renderSkillInlineMarkdownChildren(children, skills)}</p>;
      },
      li({ node, children, ...props }) {
        const listItemStart = node?.position?.start.offset;
        const markerOffset =
          typeof listItemStart === "number" ? findTaskListMarkerOffset(text, listItemStart) : null;
        return (
          <li {...props} data-task-marker-offset={markerOffset ?? undefined}>
            {renderSkillInlineMarkdownChildren(children, skills)}
          </li>
        );
      },
      input({ node: _node, type, checked, disabled: _disabled, ...props }) {
        if (type !== "checkbox" || !onTaskListChange) {
          return (
            <input
              {...props}
              type={type}
              checked={checked}
              disabled={_disabled}
              readOnly={type === "checkbox"}
            />
          );
        }
        return (
          <input
            {...props}
            type="checkbox"
            name="markdown-task"
            aria-label="Toggle task"
            checked={checked}
            onChange={(event) => {
              const markerOffset = Number(
                event.currentTarget.closest("li")?.dataset.taskMarkerOffset,
              );
              if (!Number.isSafeInteger(markerOffset)) return;
              onTaskListChange({ markerOffset, checked: event.currentTarget.checked });
            }}
          />
        );
      },
      a({ node, href, children, ...props }) {
        const normalizedHref = href ? normalizeMarkdownLinkHrefKey(href) : "";
        const fileLinkMeta = normalizedHref ? markdownFileLinkMetaByHref.get(normalizedHref) : null;
        if (!fileLinkMeta) {
          const faviconHost = resolveExternalLinkHost(href);
          const isSameDocumentLink = href?.startsWith("#") ?? false;
          const onClick = props.onClick;
          const canOpenInPreview = Boolean(threadRef) && isPreviewSupportedInRuntime();
          const link = (
            <a
              {...props}
              href={href}
              target={isSameDocumentLink ? undefined : "_blank"}
              rel={isSameDocumentLink ? undefined : "noopener noreferrer"}
              onClick={(event) => {
                onClick?.(event);
                if (isSameDocumentLink && href) {
                  handleMarkdownFragmentClick(event, href);
                }
              }}
              onContextMenu={(event) => {
                if (!canOpenInPreview || !href) return;
                event.preventDefault();
                event.stopPropagation();
                const api = readLocalApi();
                if (!api) return;
                void (async () => {
                  let operation = "show-link-context-menu";
                  try {
                    const clicked = await api.contextMenu.show(
                      [
                        { id: "open-in-browser", label: "Open in integrated browser" },
                        { id: "open-external", label: "Open in system browser" },
                      ] as const,
                      { x: event.clientX, y: event.clientY },
                    );
                    if (clicked === "open-in-browser") {
                      operation = "open-link-in-preview";
                      const result = await openExternalLinkInPreview(href);
                      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                        reportMarkdownActionFailure({ operation, target: href }, result.cause);
                      }
                      return;
                    }
                    if (clicked === "open-external") {
                      operation = "open-link-external";
                      await api.shell.openExternal(href);
                    }
                  } catch (cause) {
                    reportMarkdownActionFailure({ operation, target: href }, cause);
                  }
                })();
              }}
            >
              {faviconHost ? (
                <MarkdownExternalLinkContent host={faviconHost} plainText={plainHastText(node)}>
                  {children}
                </MarkdownExternalLinkContent>
              ) : (
                children
              )}
            </a>
          );
          if (!faviconHost || !href) {
            return link;
          }
          return (
            <Tooltip>
              <TooltipTrigger render={link} />
              <TooltipPopup
                side="top"
                className="max-w-[min(36rem,calc(100vw-2rem))] whitespace-normal leading-tight wrap-anywhere"
              >
                {href}
              </TooltipPopup>
            </Tooltip>
          );
        }

        const parentSuffix = fileLinkParentSuffixByPath.get(fileLinkMeta.filePath);
        const labelParts = [fileLinkMeta.basename];
        if (typeof parentSuffix === "string" && parentSuffix.length > 0) {
          labelParts.push(parentSuffix);
        }
        if (fileLinkMeta.line) {
          labelParts.push(
            `L${fileLinkMeta.line}${fileLinkMeta.column ? `:C${fileLinkMeta.column}` : ""}`,
          );
        }

        return (
          <MarkdownFileLink
            href={fileLinkMeta.targetPath}
            targetPath={fileLinkMeta.targetPath}
            iconPath={fileLinkMeta.filePath}
            displayPath={fileLinkMeta.displayPath}
            workspaceRelativePath={fileLinkMeta.workspaceRelativePath}
            line={fileLinkMeta.line}
            label={labelParts.join(" · ")}
            copyMarkdown={`[${fileLinkMeta.basename}](${normalizedHref})`}
            theme={resolvedTheme}
            threadRef={threadRef}
            onOpen={openInPreferredEditor}
            onOpenInBrowser={
              threadRef && isBrowserPreviewFile(fileLinkMeta.filePath)
                ? () => openMarkdownFileInPreview(fileLinkMeta.filePath)
                : undefined
            }
            className={props.className}
          />
        );
      },
      table({ node: _node, ...props }) {
        return <MarkdownTable {...props} />;
      },
      details({ node: _node, children, open: detailsOpen }) {
        return <MarkdownDetails open={detailsOpen}>{children}</MarkdownDetails>;
      },
      pre({ node, children, ...props }) {
        const codeBlock = extractCodeBlock(children);
        if (!codeBlock) {
          return <pre {...props}>{children}</pre>;
        }

        const language = extractFenceLanguage(codeBlock.className);
        const fenceTitle = extractFenceTitle(extractPreCodeMeta(node));
        return (
          <MarkdownCodeBlock
            code={codeBlock.code}
            language={language}
            fenceTitle={fenceTitle}
            theme={resolvedTheme}
          >
            <CodeHighlightErrorBoundary fallback={<pre {...props}>{children}</pre>}>
              <Suspense fallback={<pre {...props}>{children}</pre>}>
                <SuspenseShikiCodeBlock
                  className={codeBlock.className}
                  code={codeBlock.code}
                  themeName={diffThemeName}
                  isStreaming={isStreaming}
                />
              </Suspense>
            </CodeHighlightErrorBoundary>
          </MarkdownCodeBlock>
        );
      },
    }),
    [
      canRenderWorkspaceImages,
      cwd,
      diffThemeName,
      fileLinkParentSuffixByPath,
      isStreaming,
      markdownFileLinkMetaByHref,
      onTaskListChange,
      openInPreferredEditor,
      openExternalLinkInPreview,
      openMarkdownFileInPreview,
      resolvedTheme,
      skills,
      text,
      threadRef,
    ],
  );

  return (
    <div
      className={cn(
        "chat-markdown w-full min-w-0 text-sm leading-relaxed text-foreground/80",
        className,
      )}
      onCopy={handleCopy}
    >
      <ChatMarkdownImageCollectionContext.Provider value={markdownImageCollection}>
        <ReactMarkdown
          remarkPlugins={
            lineBreaks
              ? [remarkGfm, remarkBreaks, remarkPreserveCodeMeta, remarkImageGallery]
              : [remarkGfm, remarkPreserveCodeMeta, remarkImageGallery]
          }
          rehypePlugins={[rehypeRaw, [rehypeSanitize, CHAT_MARKDOWN_SANITIZE_SCHEMA]]}
          components={markdownComponents}
          urlTransform={markdownUrlTransform}
        >
          {text}
        </ReactMarkdown>
      </ChatMarkdownImageCollectionContext.Provider>
    </div>
  );
}

export default memo(ChatMarkdown);
