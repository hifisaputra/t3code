import {
  CheckIcon,
  CodeIcon,
  CopyIcon,
  Maximize2Icon,
  TriangleAlertIcon,
  WorkflowIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import {
  mermaidFenceMarkdown,
  readCachedMermaidSvg,
  renderMermaidDiagram,
  type MermaidTheme,
} from "../../lib/mermaidDiagrams";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { openDiagramLightbox } from "./diagramLightboxStore";

/**
 * How long the source has to stop changing before a streaming diagram is drawn. Mermaid
 * parses and lays out the whole diagram on every attempt, so redrawing per token would
 * spend that work on text that is still arriving.
 */
const STREAM_SETTLE_MS = 350;

interface MermaidDiagramProps {
  readonly code: string;
  readonly theme: MermaidTheme;
  readonly isStreaming: boolean;
  /** The fence's highlighted source — shown until the diagram draws, and behind the toggle after. */
  readonly children: ReactNode;
}

interface MermaidRenderState {
  readonly svg: string | null;
  readonly error: string | null;
}

/** The fence's code, held still while the message streams. */
function useSettledCode(code: string, isStreaming: boolean): string {
  const [settledCode, setSettledCode] = useState(code);

  useEffect(() => {
    if (!isStreaming) return;
    const timer = setTimeout(() => setSettledCode(code), STREAM_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [code, isStreaming]);

  return isStreaming ? settledCode : code;
}

/**
 * One ```mermaid fence, drawn. The block wears the same chrome as a code block — the
 * diagram is what you see, and the toggle puts its source back.
 */
export function MermaidDiagram({ code, theme, isStreaming, children }: MermaidDiagramProps) {
  const settledCode = useSettledCode(code, isStreaming);
  const [state, setState] = useState<MermaidRenderState>(() => ({
    svg: readCachedMermaidSvg(code, theme),
    error: null,
  }));
  const [showSource, setShowSource] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const cachedSvg = readCachedMermaidSvg(settledCode, theme);
    if (cachedSvg !== null) {
      setState({ svg: cachedSvg, error: null });
      return;
    }
    let cancelled = false;
    void renderMermaidDiagram({ code: settledCode, theme }).then((outcome) => {
      if (cancelled) return;
      setState((previous) =>
        outcome._tag === "Rendered"
          ? { svg: outcome.svg, error: null }
          : // A diagram that stops parsing is usually one that is still being written —
            // keep the last drawing rather than flashing back to source.
            { svg: previous.svg, error: outcome.message },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [settledCode, theme]);

  const handleCopy = useCallback(() => {
    if (typeof navigator === "undefined" || navigator.clipboard == null) return;
    void navigator.clipboard
      .writeText(code)
      .then(() => {
        if (copiedTimerRef.current != null) clearTimeout(copiedTimerRef.current);
        setCopied(true);
        copiedTimerRef.current = setTimeout(() => {
          setCopied(false);
          copiedTimerRef.current = null;
        }, 1200);
      })
      .catch((cause: unknown) => {
        console.error("[chat-markdown] action failed", { operation: "copy-diagram" }, cause);
      });
  }, [code]);

  const svg = state.svg;
  const handleExpand = useCallback(() => {
    if (svg !== null) openDiagramLightbox({ svg, code });
  }, [code, svg]);

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    },
    [],
  );

  const showsDiagram = state.svg !== null && !showSource;
  // A fence that never drew is only worth flagging once the message is finished; before
  // that it is simply incomplete.
  const showsFailure = state.svg === null && state.error !== null && !isStreaming;
  const toggleLabel = showsDiagram ? "Show diagram source" : "Show diagram";
  const copyLabel = copied ? "Copied" : "Copy diagram source";
  const expandLabel = "Expand diagram";

  return (
    <div
      className="chat-markdown-codeblock border border-border/70 bg-secondary leading-snug dark:border-transparent dark:bg-input/32"
      data-language="mermaid"
      data-view={showsDiagram ? "diagram" : "source"}
    >
      <div className="chat-markdown-codeblock-header select-none">
        <span className="chat-markdown-codeblock-title">
          <WorkflowIcon className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">Diagram</span>
          {showsFailure ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="inline-flex shrink-0 items-center gap-1 text-amber-600 dark:text-amber-500" />
                }
              >
                <TriangleAlertIcon className="size-3 shrink-0" aria-hidden />
                unrenderable
              </TooltipTrigger>
              <TooltipPopup side="top" className="max-w-80 whitespace-normal leading-tight">
                {state.error}
              </TooltipPopup>
            </Tooltip>
          ) : null}
        </span>
        <span className="flex items-center gap-0.5" role="toolbar" aria-label="Diagram actions">
          {state.svg === null ? null : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="chat-markdown-chrome-action"
                    aria-pressed={showSource}
                    onClick={() => setShowSource((value) => !value)}
                    aria-label={toggleLabel}
                  />
                }
              >
                <CodeIcon className="size-3" />
              </TooltipTrigger>
              <TooltipPopup side="top">{toggleLabel}</TooltipPopup>
            </Tooltip>
          )}
          {showsDiagram ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="chat-markdown-chrome-action"
                    onClick={handleExpand}
                    aria-label={expandLabel}
                  />
                }
              >
                <Maximize2Icon className="size-3" />
              </TooltipTrigger>
              <TooltipPopup side="top">{expandLabel}</TooltipPopup>
            </Tooltip>
          ) : null}
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
      {showsDiagram ? (
        // A diagram drawn to fit a chat column is often too small to read, so the block
        // itself is the way into the full-screen, zoomable view.
        <button
          type="button"
          className="chat-markdown-mermaid w-full cursor-zoom-in border-0 bg-transparent text-left"
          // Copying the message out of the rendered view would otherwise drop the diagram:
          // the clipboard serializer skips SVG. It copies back as the fence it came from.
          data-markdown-copy={mermaidFenceMarkdown(code)}
          aria-label={expandLabel}
          onClick={handleExpand}
          // Mermaid sanitizes the labels it draws (securityLevel: "strict") and the markup
          // it returns is its own SVG.
          dangerouslySetInnerHTML={{ __html: state.svg as string }}
        />
      ) : (
        children
      )}
    </div>
  );
}
