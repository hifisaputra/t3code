import { MaximizeIcon, MinusIcon, PlusIcon, XIcon } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import {
  clampDiagramTransform,
  FITTED_DIAGRAM_TRANSFORM,
  MAX_DIAGRAM_SCALE,
  MIN_DIAGRAM_SCALE,
  zoomDiagramTransformBy,
  zoomDiagramTransformTo,
  type DiagramPoint,
  type DiagramTransform,
} from "../../lib/diagramZoom";
import { mermaidFenceMarkdown } from "../../lib/mermaidDiagrams";
import { Button } from "../ui/button";
import type { ExpandedDiagram } from "./diagramLightboxStore";

/** One press of a zoom button, one keyboard step. */
const ZOOM_STEP = 1.5;
/** What a double-click zooms to, so one gesture actually gets you somewhere. */
const DOUBLE_CLICK_SCALE = 2.5;
const WHEEL_ZOOM_SENSITIVITY = 0.0025;
/** A wheel reporting lines rather than pixels; roughly one text line. */
const WHEEL_LINE_HEIGHT_PX = 16;
/** Below this, a pointer press is a click rather than a pan. */
const DRAG_SLOP_PX = 4;

interface DiagramLightboxDialogProps {
  readonly diagram: ExpandedDiagram;
  readonly onClose: () => void;
}

/**
 * A diagram, filling the screen and zoomable. Mermaid draws diagrams to fit a chat
 * column, which is too small to read a dense flowchart in — so the fence's own SVG is
 * re-hosted here on a pan/zoom stage rather than drawn again at another size.
 */
export const DiagramLightboxDialog = memo(function DiagramLightboxDialog({
  diagram,
  onClose,
}: DiagramLightboxDialogProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [transform, setTransform] = useState<DiagramTransform>(FITTED_DIAGRAM_TRANSFORM);
  const [isPanning, setIsPanning] = useState(false);

  const zoomBy = useCallback((factor: number, origin?: DiagramPoint) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const anchor = origin ?? { x: rect.width / 2, y: rect.height / 2 };
    setTransform((previous) => zoomDiagramTransformBy(previous, factor, anchor, rect));
  }, []);

  const zoomTo = useCallback((scale: number, origin: DiagramPoint) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setTransform((previous) => zoomDiagramTransformTo(previous, scale, origin, rect));
  }, []);

  const resetZoom = useCallback(() => setTransform(FITTED_DIAGRAM_TRANSFORM), []);

  // React's own wheel listener is passive, and a diagram that scrolls the thread behind
  // it while you zoom is unusable — so the stage takes the event directly.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = container.getBoundingClientRect();
      const delta = event.deltaMode === 1 ? event.deltaY * WHEEL_LINE_HEIGHT_PX : event.deltaY;
      zoomBy(Math.exp(-delta * WHEEL_ZOOM_SENSITIVITY), {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, [zoomBy]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        zoomBy(ZOOM_STEP);
        return;
      }
      if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        zoomBy(1 / ZOOM_STEP);
        return;
      }
      if (event.key !== "0") return;
      event.preventDefault();
      resetZoom();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, resetZoom, zoomBy]);

  /** Live pointers, so a second finger turns a pan into a pinch. */
  const pointersRef = useRef(new Map<number, DiagramPoint>());
  const pinchDistanceRef = useRef<number | null>(null);
  const panRef = useRef<{
    pointerId: number;
    start: DiagramPoint;
    origin: DiagramTransform;
  } | null>(null);
  /** Set once a press has travelled far enough to be a drag rather than a click. */
  const draggedRef = useRef(false);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointersRef.current.size === 2) {
        const [first, second] = [...pointersRef.current.values()];
        if (first && second) {
          pinchDistanceRef.current = Math.hypot(second.x - first.x, second.y - first.y);
        }
        panRef.current = null;
        setIsPanning(false);
        return;
      }
      if (pointersRef.current.size !== 1) return;
      draggedRef.current = false;
      panRef.current = {
        pointerId: event.pointerId,
        start: { x: event.clientX, y: event.clientY },
        origin: transform,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [transform],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!pointersRef.current.has(event.pointerId)) return;
      pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

      if (pointersRef.current.size >= 2) {
        const [first, second] = [...pointersRef.current.values()];
        const previousDistance = pinchDistanceRef.current;
        if (!first || !second || previousDistance == null || previousDistance === 0) return;
        const distance = Math.hypot(second.x - first.x, second.y - first.y);
        pinchDistanceRef.current = distance;
        const rect = containerRef.current?.getBoundingClientRect();
        zoomBy(distance / previousDistance, {
          x: (first.x + second.x) / 2 - (rect?.left ?? 0),
          y: (first.y + second.y) / 2 - (rect?.top ?? 0),
        });
        return;
      }

      const pan = panRef.current;
      if (!pan || pan.pointerId !== event.pointerId) return;
      const dx = event.clientX - pan.start.x;
      const dy = event.clientY - pan.start.y;
      if (!draggedRef.current && Math.hypot(dx, dy) < DRAG_SLOP_PX) return;
      // A fitted diagram has nothing to pan to; the press is only ever a click.
      if (pan.origin.scale <= MIN_DIAGRAM_SCALE) return;
      draggedRef.current = true;
      setIsPanning(true);
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setTransform(
        clampDiagramTransform(
          { scale: pan.origin.scale, x: pan.origin.x + dx, y: pan.origin.y + dy },
          rect,
        ),
      );
    },
    [zoomBy],
  );

  const endPointer = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size < 2) pinchDistanceRef.current = null;
    if (panRef.current?.pointerId === event.pointerId) panRef.current = null;
    setIsPanning(false);
  }, []);

  /**
   * Clicking the empty space around a fitted diagram dismisses it, the way the image
   * lightbox does. Anything drawn — a node, an edge — is a double-click target instead,
   * so the two gestures never land on the same pixel.
   */
  const onStageClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (draggedRef.current) {
        draggedRef.current = false;
        return;
      }
      if (transform.scale > MIN_DIAGRAM_SCALE) return;
      const target = event.target as Element | null;
      // The SVG element covers the whole stage, so "empty" means the letterboxing
      // around the drawing — the root itself — as well as the stage behind it.
      const isEmptySpace =
        target === null || target.tagName.toLowerCase() === "svg" || target.closest("svg") === null;
      if (isEmptySpace) onClose();
    },
    [onClose, transform.scale],
  );

  const onStageDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const origin = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      if (transform.scale > MIN_DIAGRAM_SCALE) {
        resetZoom();
        return;
      }
      zoomTo(DOUBLE_CLICK_SCALE, origin);
    },
    [resetZoom, transform.scale, zoomTo],
  );

  const zoomedIn = transform.scale > MIN_DIAGRAM_SCALE;
  // Fitted, the stage behaves like the image lightbox's backdrop — clicking the empty
  // space around the diagram dismisses it. Zoomed, the same surface is a thing you drag.
  const cursor = zoomedIn ? (isPanning ? "grabbing" : "grab") : "zoom-out";

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 [-webkit-app-region:no-drag]"
      role="dialog"
      aria-modal="true"
      aria-label="Expanded diagram"
    >
      <div
        ref={containerRef}
        className="absolute inset-0 touch-none overflow-hidden overscroll-contain"
        style={{ cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onClick={onStageClick}
        onDoubleClick={onStageDoubleClick}
      >
        <div
          className="absolute inset-0 p-6 sm:p-12"
          style={{
            transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
            transformOrigin: "0 0",
            willChange: "transform",
          }}
        >
          <div
            className="chat-diagram-lightbox-stage size-full select-none"
            // The diagram copies back out as the fence it came from — the clipboard
            // serializer has no way to read an SVG.
            data-markdown-copy={mermaidFenceMarkdown(diagram.code)}
            // Already-sanitized markup: Mermaid drew it under securityLevel "strict".
            dangerouslySetInnerHTML={{ __html: diagram.svg }}
          />
        </div>
      </div>

      <div
        className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center"
        role="toolbar"
        aria-label="Diagram zoom"
      >
        <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-white/15 bg-black/60 p-1 text-white/90 backdrop-blur">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-8 rounded-full text-white/90 hover:bg-white/10 hover:text-white"
            aria-label="Zoom out"
            disabled={transform.scale <= MIN_DIAGRAM_SCALE}
            onClick={() => zoomBy(1 / ZOOM_STEP)}
          >
            <MinusIcon className="size-4" />
          </Button>
          <button
            type="button"
            className="min-w-14 rounded-full px-2 text-xs tabular-nums text-white/80 hover:text-white"
            aria-label="Reset zoom"
            onClick={resetZoom}
          >
            {Math.round(transform.scale * 100)}%
          </button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-8 rounded-full text-white/90 hover:bg-white/10 hover:text-white"
            aria-label="Zoom in"
            disabled={transform.scale >= MAX_DIAGRAM_SCALE}
            onClick={() => zoomBy(ZOOM_STEP)}
          >
            <PlusIcon className="size-4" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-8 rounded-full text-white/90 hover:bg-white/10 hover:text-white"
            aria-label="Fit diagram to screen"
            disabled={!zoomedIn}
            onClick={resetZoom}
          >
            <MaximizeIcon className="size-4" />
          </Button>
        </div>
      </div>

      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="absolute right-2 top-2 z-10 text-white/90 hover:bg-white/10 hover:text-white sm:right-4 sm:top-4"
        onClick={onClose}
        aria-label="Close diagram preview"
      >
        <XIcon className="size-5" />
      </Button>
    </div>
  );
});
