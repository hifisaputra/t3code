import { describe, expect, it } from "vite-plus/test";

import {
  closeDiagramLightbox,
  openDiagramLightbox,
  useDiagramLightboxStore,
} from "./diagramLightboxStore";

const DIAGRAM = { svg: "<svg />", code: "flowchart LR\n  a --> b" };

describe("diagram lightbox store", () => {
  it("holds one expanded diagram at a time and gives it back up", () => {
    expect(useDiagramLightboxStore.getState().diagram).toBeNull();

    openDiagramLightbox(DIAGRAM);
    expect(useDiagramLightboxStore.getState().diagram).toEqual(DIAGRAM);

    openDiagramLightbox({ svg: "<svg id='second' />", code: "graph TD" });
    expect(useDiagramLightboxStore.getState().diagram?.code).toBe("graph TD");

    closeDiagramLightbox();
    expect(useDiagramLightboxStore.getState().diagram).toBeNull();
  });
});
