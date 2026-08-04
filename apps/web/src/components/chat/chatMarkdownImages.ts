import { normalizeMarkdownLinkDestination, rewriteMarkdownFileUriHref } from "../../markdown-links";
import { openImageLightbox } from "./imageLightboxStore";

const MARKDOWN_IMAGE_PATTERN = /!\[([^\]]*)]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;

export const EMPTY_IMAGE_SRC_BY_HREF: ReadonlyMap<string, string | null> = new Map();

export function normalizeMarkdownLinkHrefKey(href: string): string {
  const normalizedHref = normalizeMarkdownLinkDestination(href);
  return rewriteMarkdownFileUriHref(normalizedHref) ?? normalizedHref;
}

/** http(s) images render straight from their URL — no asset token needed. */
export function isExternalImageHref(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

export interface MarkdownImageRef {
  /** Normalized markdown destination — the key every image lookup goes through. */
  readonly href: string;
  readonly alt: string;
}

/**
 * Every `![alt](src)` in the message, in source order. Images are collected up-front
 * (rather than as each `img` renders) so a message can carry any number of them: their
 * asset URLs are minted as one batch, and the whole set is what the lightbox pages
 * through.
 */
export function extractMarkdownImageRefs(text: string): MarkdownImageRef[] {
  const refs: MarkdownImageRef[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(MARKDOWN_IMAGE_PATTERN)) {
    const rawSrc = match[2]?.trim();
    if (!rawSrc) continue;
    const href = normalizeMarkdownLinkHrefKey(rawSrc);
    if (seen.has(href)) continue;
    seen.add(href);
    refs.push({ href, alt: match[1]?.trim() ?? "" });
  }
  return refs;
}

/** A markdown image whose displayable source has been (or is being) resolved. */
export interface ChatMarkdownImageEntry {
  readonly href: string;
  readonly name: string;
  /** Resolved and displayable, or null while pending / unresolvable. */
  readonly src: string | null;
}

export interface ChatMarkdownImageCollection {
  /** Every image in the message, in source order — the lightbox pages through these. */
  readonly entries: ReadonlyArray<ChatMarkdownImageEntry>;
  readonly entryByHref: ReadonlyMap<string, ChatMarkdownImageEntry>;
  /** Whether the batch resolver has settled this href (resolved or given up). */
  readonly isSettled: (href: string) => boolean;
  /**
   * Ask for an image the up-front scan missed — reference-style markdown
   * (`![a][ref]`) and images inside raw HTML never match the `![](…)` pattern.
   */
  readonly request: (href: string) => void;
}

export function buildChatMarkdownImageCollection(
  entries: ReadonlyArray<ChatMarkdownImageEntry>,
  isSettled: (href: string) => boolean,
  request: (href: string) => void,
): ChatMarkdownImageCollection {
  return {
    entries,
    entryByHref: new Map(entries.map((entry) => [entry.href, entry])),
    isSettled,
    request,
  };
}

/**
 * Open the message's images in the app-wide lightbox, starting at `href`. Images that
 * haven't resolved are left out so navigation never lands on an empty frame.
 */
export function openMarkdownImageLightbox(
  collection: ChatMarkdownImageCollection,
  href: string,
): void {
  const displayable = collection.entries.flatMap((entry) =>
    entry.src === null ? [] : [{ src: entry.src, name: entry.name, href: entry.href }],
  );
  const index = displayable.findIndex((entry) => entry.href === href);
  if (index < 0) return;
  openImageLightbox({
    images: displayable.map((entry) => ({ src: entry.src, name: entry.name })),
    index,
  });
}
