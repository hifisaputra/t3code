import { describe, expect, it } from "vite-plus/test";

import {
  clampDiagramTransform,
  FITTED_DIAGRAM_TRANSFORM,
  MAX_DIAGRAM_SCALE,
  MIN_DIAGRAM_SCALE,
  zoomDiagramTransformBy,
  zoomDiagramTransformTo,
} from "./diagramZoom";

const STAGE = { width: 1000, height: 600 };

/** Where a stage coordinate lands on screen under a transform. */
function project(
  transform: { scale: number; x: number; y: number },
  point: { x: number; y: number },
): { x: number; y: number } {
  return { x: point.x * transform.scale + transform.x, y: point.y * transform.scale + transform.y };
}

describe("diagram zoom", () => {
  it("keeps the diagram covering the viewport when panned past its edge", () => {
    const panned = clampDiagramTransform({ scale: 2, x: 400, y: -5000 }, STAGE);

    expect(panned.x).toBe(0);
    expect(panned.y).toBe(STAGE.height - STAGE.height * 2);
  });

  it("pins a fitted diagram in place — there is nothing to pan to", () => {
    expect(clampDiagramTransform({ scale: 1, x: 120, y: -80 }, STAGE)).toEqual(
      FITTED_DIAGRAM_TRANSFORM,
    );
  });

  it("holds the anchored point still while scaling", () => {
    const anchor = { x: 300, y: 200 };
    const zoomed = zoomDiagramTransformTo(FITTED_DIAGRAM_TRANSFORM, 3, anchor, STAGE);
    // The stage coordinate under the cursor before the zoom is still under it after.
    const stagePoint = { x: anchor.x, y: anchor.y };

    expect(project(zoomed, stagePoint).x).toBeCloseTo(anchor.x, 6);
    expect(project(zoomed, stagePoint).y).toBeCloseTo(anchor.y, 6);
  });

  it("stays anchored across successive gesture steps", () => {
    const anchor = { x: 820, y: 90 };
    let transform = FITTED_DIAGRAM_TRANSFORM;
    for (let step = 0; step < 4; step += 1) {
      transform = zoomDiagramTransformBy(transform, 1.3, anchor, STAGE);
    }

    expect(transform.scale).toBeCloseTo(1.3 ** 4, 6);
    expect(project(transform, anchor).x).toBeCloseTo(anchor.x, 6);
    expect(project(transform, anchor).y).toBeCloseTo(anchor.y, 6);
  });

  it("bottoms out at the fitted scale and tops out at the maximum", () => {
    const anchor = { x: 500, y: 300 };
    const out = zoomDiagramTransformBy(FITTED_DIAGRAM_TRANSFORM, 0.01, anchor, STAGE);
    const deep = zoomDiagramTransformTo(FITTED_DIAGRAM_TRANSFORM, 1000, anchor, STAGE);

    expect(out).toEqual(FITTED_DIAGRAM_TRANSFORM);
    expect(deep.scale).toBe(MAX_DIAGRAM_SCALE);
    expect(MIN_DIAGRAM_SCALE).toBe(1);
  });

  it("re-centres a zoomed-out diagram rather than leaving it hanging off an edge", () => {
    const cornerZoom = zoomDiagramTransformTo(
      FITTED_DIAGRAM_TRANSFORM,
      4,
      { x: STAGE.width, y: STAGE.height },
      STAGE,
    );
    const backToFit = zoomDiagramTransformTo(cornerZoom, 1, { x: 0, y: 0 }, STAGE);

    expect(backToFit).toEqual(FITTED_DIAGRAM_TRANSFORM);
  });
});
