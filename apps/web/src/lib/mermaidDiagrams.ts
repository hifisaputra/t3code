import type { MermaidConfig } from "mermaid";

import { codeFenceFor } from "../markdown-clipboard";
import { fnv1a32 } from "./diffRendering";
import { LRUCache } from "./lruCache";

/** Fence languages that mean "this block is a diagram, not code". */
const MERMAID_FENCE_LANGUAGES = new Set(["mermaid", "mmd"]);

export function isMermaidFenceLanguage(language: string): boolean {
  return MERMAID_FENCE_LANGUAGES.has(language.toLowerCase());
}

export type MermaidTheme = "light" | "dark";

/**
 * The fence a drawn diagram copies back as. The clipboard serializer skips SVG, so without
 * this a copied message would lose the diagram entirely rather than carry its source.
 */
export function mermaidFenceMarkdown(code: string): string {
  const source = code.replace(/\n+$/, "");
  const fence = codeFenceFor(source);
  return `${fence}mermaid\n${source}\n${fence}\n\n`;
}

/**
 * A diagram past this size is a paste, not an explanation — Mermaid would spend a long
 * layout pass on it and the result would not be readable in a chat column anyway.
 */
const MAX_MERMAID_SOURCE_LENGTH = 20_000;

const MAX_DIAGRAM_CACHE_ENTRIES = 120;
const MAX_DIAGRAM_CACHE_MEMORY_BYTES = 8 * 1024 * 1024;

/**
 * Streaming remounts the message, and a re-render of the same source is a full layout
 * pass — so a drawn diagram is kept by (source, theme) and repainted from the cache.
 */
const renderedSvgCache = new LRUCache<string>(
  MAX_DIAGRAM_CACHE_ENTRIES,
  MAX_DIAGRAM_CACHE_MEMORY_BYTES,
);

function mermaidCacheKey(code: string, theme: MermaidTheme): string {
  return `${fnv1a32(code).toString(36)}:${code.length}:${theme}`;
}

export function readCachedMermaidSvg(code: string, theme: MermaidTheme): string | null {
  return renderedSvgCache.get(mermaidCacheKey(code.trim(), theme));
}

const MERMAID_FONT_FAMILY =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/**
 * Mermaid's own palettes read as a third party pasted into the thread, and its color math
 * runs through a parser that does not speak the `oklch()` the app's tokens are written in
 * — so the neutral surface is restated here, in hex, per theme.
 */
const MERMAID_THEME_VARIABLES: Record<MermaidTheme, Record<string, string>> = {
  light: {
    background: "#ffffff",
    primaryColor: "#f4f4f5",
    primaryTextColor: "#27272a",
    primaryBorderColor: "#d4d4d8",
    secondaryColor: "#e4e4e7",
    tertiaryColor: "#fafafa",
    mainBkg: "#f4f4f5",
    nodeBorder: "#d4d4d8",
    lineColor: "#a1a1aa",
    textColor: "#3f3f46",
    clusterBkg: "#fafafa",
    clusterBorder: "#e4e4e7",
    edgeLabelBackground: "#ffffff",
    noteBkgColor: "#fef9c3",
    noteTextColor: "#3f3f46",
    noteBorderColor: "#fde047",
  },
  dark: {
    background: "#0a0a0a",
    primaryColor: "#27272a",
    primaryTextColor: "#e4e4e7",
    primaryBorderColor: "#52525b",
    secondaryColor: "#3f3f46",
    tertiaryColor: "#18181b",
    mainBkg: "#27272a",
    nodeBorder: "#52525b",
    lineColor: "#71717a",
    textColor: "#d4d4d8",
    clusterBkg: "#18181b",
    clusterBorder: "#3f3f46",
    edgeLabelBackground: "#18181b",
    noteBkgColor: "#3f3f46",
    noteTextColor: "#e4e4e7",
    noteBorderColor: "#52525b",
  },
};

export function mermaidConfigForTheme(theme: MermaidTheme): MermaidConfig {
  return {
    startOnLoad: false,
    // Diagram source is agent-authored and can quote anything the agent read, so labels
    // are sanitized and no click handler in the source ever runs.
    securityLevel: "strict",
    // Mermaid otherwise paints its own red error card into the document; a fence that does
    // not parse falls back to its source instead.
    suppressErrorRendering: true,
    theme: "base",
    fontFamily: MERMAID_FONT_FAMILY,
    themeVariables: {
      fontFamily: MERMAID_FONT_FAMILY,
      fontSize: "13px",
      ...MERMAID_THEME_VARIABLES[theme],
    },
    // Text labels rather than foreignObject HTML: the chat stylesheet cannot reach into
    // them, and the SVG stays self-contained.
    flowchart: { htmlLabels: false, useMaxWidth: true },
    class: { htmlLabels: false, useMaxWidth: true },
  };
}

export type MermaidRenderOutcome =
  | { readonly _tag: "Rendered"; readonly svg: string }
  | { readonly _tag: "Invalid"; readonly message: string };

type MermaidModule = typeof import("mermaid").default;

let mermaidModulePromise: Promise<MermaidModule> | null = null;

/**
 * Mermaid is a few hundred kilobytes of parsers and layout engines, so it is a chunk that
 * only a thread containing a diagram ever downloads. A failed load is forgotten so the
 * next diagram can try again.
 */
function loadMermaid(): Promise<MermaidModule> {
  mermaidModulePromise ??= import("mermaid")
    .then((module) => module.default)
    .catch((cause: unknown) => {
      mermaidModulePromise = null;
      throw cause;
    });
  return mermaidModulePromise;
}

/**
 * Mermaid keeps its config and its layout scratch space in module-level state, so two
 * diagrams rendering at once would read each other's theme. A message with several
 * diagrams draws them one after another.
 */
let renderQueue: Promise<unknown> = Promise.resolve();
let renderSequence = 0;

function enqueueRender<T>(task: () => Promise<T>): Promise<T> {
  const result = renderQueue.then(task, task);
  renderQueue = result.catch(() => undefined);
  return result;
}

function describeRenderFailure(cause: unknown): string {
  if (cause instanceof Error && cause.message) return cause.message;
  return "The diagram could not be rendered.";
}

/**
 * Draws one diagram, or explains why it cannot be drawn. Never rejects: an unparseable
 * fence is an ordinary outcome mid-stream, and the caller shows the source instead.
 */
export async function renderMermaidDiagram(input: {
  readonly code: string;
  readonly theme: MermaidTheme;
}): Promise<MermaidRenderOutcome> {
  const code = input.code.trim();
  if (code.length === 0) {
    return { _tag: "Invalid", message: "The diagram is empty." };
  }
  if (code.length > MAX_MERMAID_SOURCE_LENGTH) {
    return { _tag: "Invalid", message: "The diagram is too large to render." };
  }
  if (typeof document === "undefined") {
    return { _tag: "Invalid", message: "Diagrams need a browser to render." };
  }

  const cacheKey = mermaidCacheKey(code, input.theme);
  const cached = renderedSvgCache.get(cacheKey);
  if (cached !== null) {
    return { _tag: "Rendered", svg: cached };
  }

  return enqueueRender(async () => {
    try {
      const mermaid = await loadMermaid();
      mermaid.initialize(mermaidConfigForTheme(input.theme));
      const parsed = await mermaid.parse(code, { suppressErrors: true });
      if (!parsed) {
        return { _tag: "Invalid", message: "The diagram syntax is not valid Mermaid." } as const;
      }
      renderSequence += 1;
      const { svg } = await mermaid.render(`chat-mermaid-${renderSequence}`, code);
      renderedSvgCache.set(cacheKey, svg, svg.length * 2);
      return { _tag: "Rendered", svg } as const;
    } catch (cause) {
      return { _tag: "Invalid", message: describeRenderFailure(cause) } as const;
    }
  });
}
