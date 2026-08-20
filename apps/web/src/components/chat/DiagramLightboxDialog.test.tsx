import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { DiagramLightboxDialog } from "./DiagramLightboxDialog";

const DIAGRAM = {
  svg: '<svg id="chat-mermaid-1" viewBox="0 0 200 100"><text>alpha</text></svg>',
  code: "flowchart LR\n  a --> b",
};

function render(): string {
  return renderToStaticMarkup(<DiagramLightboxDialog diagram={DIAGRAM} onClose={() => {}} />);
}

describe("DiagramLightboxDialog", () => {
  it("hosts the SVG the fence already drew rather than rendering it again", () => {
    expect(render()).toContain('viewBox="0 0 200 100"');
  });

  it("opens fitted, with zooming out unavailable until there is something to zoom out of", () => {
    const html = render();

    expect(html).toContain("100%");
    expect(html).toMatch(/aria-label="Zoom out"[^>]*disabled|disabled[^>]*aria-label="Zoom out"/);
  });

  it("offers the zoom controls and a way out", () => {
    const html = render();

    expect(html).toContain('aria-label="Zoom in"');
    expect(html).toContain('aria-label="Fit diagram to screen"');
    expect(html).toContain('aria-label="Close diagram preview"');
  });

  it("still copies out as the fence it came from", () => {
    expect(render()).toContain("flowchart LR");
  });
});
