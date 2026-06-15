import {
  type DiffsHighlighter,
  getSharedHighlighter,
  type SupportedLanguages,
} from "@pierre/diffs";

import { resolveDiffThemeName } from "./diffRendering";

const highlighterPromiseCache = new Map<string, Promise<DiffsHighlighter>>();

/**
 * Resolve a shared Shiki highlighter for the given language, preloaded with both
 * the light and dark diff themes. Falls back to the plain "text" grammar when a
 * language is unsupported so callers always receive a usable highlighter.
 *
 * Shared by the chat markdown code blocks and the file-browser viewer.
 */
export function getHighlighterPromise(language: string): Promise<DiffsHighlighter> {
  const cached = highlighterPromiseCache.get(language);
  if (cached) return cached;

  const promise = getSharedHighlighter({
    themes: [resolveDiffThemeName("dark"), resolveDiffThemeName("light")],
    langs: [language as SupportedLanguages],
    preferredHighlighter: "shiki-js",
  }).catch((err) => {
    highlighterPromiseCache.delete(language);
    if (language === "text") {
      // "text" itself failed — Shiki cannot initialize at all, surface the error.
      throw err;
    }
    // Language not supported by Shiki — fall back to "text".
    return getHighlighterPromise("text");
  });
  highlighterPromiseCache.set(language, promise);
  return promise;
}
