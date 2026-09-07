"use client";

/**
 * Typed window-event bus for "start a thread from a Linear issue".
 *
 * The dialog lives in `ChatView`, which owns the active project and the draft
 * session it needs. The command palette and any other surface that merely
 * wants to ask for it dispatch here instead of prop-drilling through the
 * router, the same way the preview panel is reached.
 */

const EVENT_NAME = "t3code:open-linear-issue-dialog";

export function openLinearIssueDialogRequest(reference?: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<string | null>(EVENT_NAME, { detail: reference ?? null }));
}

export function subscribeLinearIssueDialogRequest(
  listener: (reference: string | null) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<string | null>).detail;
    listener(typeof detail === "string" ? detail : null);
  };
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}
