/**
 * The pan/zoom arithmetic behind the expanded-diagram lightbox, kept apart from the
 * dialog so the invariant that matters — the diagram never leaves the viewport — can be
 * checked without a DOM.
 *
 * A transform is applied with its origin at the stage's top-left corner, so the stage
 * always covers the viewport exactly when `scale` is 1.
 */

/** Scale 1 is the diagram fitted to the viewport; there is nothing below it worth seeing. */
export const MIN_DIAGRAM_SCALE = 1;
export const MAX_DIAGRAM_SCALE = 8;

export interface DiagramTransform {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

export interface DiagramPoint {
  readonly x: number;
  readonly y: number;
}

export interface DiagramStageSize {
  readonly width: number;
  readonly height: number;
}

/** The diagram at rest: fitted, unpanned. */
export const FITTED_DIAGRAM_TRANSFORM: DiagramTransform = {
  scale: MIN_DIAGRAM_SCALE,
  x: 0,
  y: 0,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Holds the stage over the viewport: panning can run from "scrolled to the far edge" to
 * zero, and a fitted stage has nowhere to go at all.
 */
export function clampDiagramTransform(
  transform: DiagramTransform,
  size: DiagramStageSize,
): DiagramTransform {
  const scale = clamp(transform.scale, MIN_DIAGRAM_SCALE, MAX_DIAGRAM_SCALE);
  return {
    scale,
    x: clamp(transform.x, size.width - size.width * scale, 0),
    y: clamp(transform.y, size.height - size.height * scale, 0),
  };
}

/**
 * Scales to `scale`, keeping whatever sits under `anchor` under it — the difference
 * between zooming into the part you were looking at and zooming into the middle.
 */
export function zoomDiagramTransformTo(
  previous: DiagramTransform,
  scale: number,
  anchor: DiagramPoint,
  size: DiagramStageSize,
): DiagramTransform {
  const next = clamp(scale, MIN_DIAGRAM_SCALE, MAX_DIAGRAM_SCALE);
  const ratio = next / previous.scale;
  return clampDiagramTransform(
    {
      scale: next,
      x: anchor.x - (anchor.x - previous.x) * ratio,
      y: anchor.y - (anchor.y - previous.y) * ratio,
    },
    size,
  );
}

/** The same, for gestures that report a change rather than a target: a wheel, a pinch. */
export function zoomDiagramTransformBy(
  previous: DiagramTransform,
  factor: number,
  anchor: DiagramPoint,
  size: DiagramStageSize,
): DiagramTransform {
  return zoomDiagramTransformTo(previous, previous.scale * factor, anchor, size);
}
