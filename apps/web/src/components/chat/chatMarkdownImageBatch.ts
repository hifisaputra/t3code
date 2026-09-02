import { classifyMarkdownImageSource } from "@t3tools/client-runtime/markdown-images";
import type { AssetResource, ScopedThreadRef } from "@t3tools/contracts";

import { normalizeMarkdownLinkDestination, rewriteMarkdownFileUriHref } from "../../markdown-links";

/** `![alt](src "title")`, with an optional `<…>`-wrapped destination. */
const MARKDOWN_IMAGE_PATTERN = /!\[[^\]]*]\(\s*(<[^>]*>|[^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g;

/** ```fences``` and `inline code` carry example markdown that must not mint anything. */
const FENCED_CODE_PATTERN = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[^\n]*$|$)/gm;
const INLINE_CODE_PATTERN = /(`+)(?:[^`]|(?!\1)`)*\1/g;

/**
 * Blank out code spans while preserving offsets, so an image inside a fenced example is
 * not collected. Newlines are kept so the fence pattern keeps matching line-anchored.
 */
function withoutCodeSpans(text: string): string {
  const blank = (match: string) => match.replaceAll(/[^\n]/g, " ");
  return text.replaceAll(FENCED_CODE_PATTERN, blank).replaceAll(INLINE_CODE_PATTERN, blank);
}

function unwrapDestination(destination: string): string {
  const trimmed = destination.trim();
  return trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1) : trimmed;
}

/**
 * Every workspace-backed image in a message, in source order and de-duplicated, as the
 * asset resources that render them.
 *
 * Collected from the source text up front rather than as each `img` renders, so the whole
 * message resolves in one batched request instead of one round trip per image. A message
 * carrying tens of images is otherwise dominated by that serial minting, and its later
 * images appear long after its first.
 *
 * Only inline `![alt](src)` images are found here. Reference-style and raw-HTML images
 * fall through to per-image resolution, which is correct but unbatched.
 */
export function collectChatMarkdownImageResources(input: {
  readonly text: string;
  /** Anchors relative paths — the same base the `img` renderer classifies against. */
  readonly imageBaseDir: string | undefined;
  readonly threadRef: ScopedThreadRef | undefined;
}): ReadonlyArray<AssetResource> {
  if (!input.threadRef || !input.text.includes("![")) return [];

  const threadId = input.threadRef.threadId;
  const resources: AssetResource[] = [];
  const seen = new Set<string>();

  for (const match of withoutCodeSpans(input.text).matchAll(MARKDOWN_IMAGE_PATTERN)) {
    const rawDestination = match[1];
    if (!rawDestination) continue;
    const destination = normalizeMarkdownLinkDestination(unwrapDestination(rawDestination));
    const href = rewriteMarkdownFileUriHref(destination) ?? destination;
    const source = classifyMarkdownImageSource(href, input.imageBaseDir);
    // Direct http(s)/data/blob sources render from their own URL, and blocked ones never
    // render at all; neither needs a signed URL.
    if (source._tag !== "WorkspaceFile") continue;
    if (seen.has(source.path)) continue;
    seen.add(source.path);
    resources.push({ _tag: "media-file", threadId, path: source.path });
  }

  return resources;
}
