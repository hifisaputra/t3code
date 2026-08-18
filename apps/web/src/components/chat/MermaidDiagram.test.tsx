import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { MermaidDiagram } from "./MermaidDiagram";

const DIAGRAM = "flowchart LR\n  a --> b";

/** Before any drawing lands, the block is its source — nothing is hidden while it renders. */
function renderUndrawn(isStreaming: boolean): string {
  return renderToStaticMarkup(
    <MermaidDiagram code={DIAGRAM} theme="dark" isStreaming={isStreaming}>
      <pre>{DIAGRAM}</pre>
    </MermaidDiagram>,
  );
}

describe("MermaidDiagram", () => {
  it("shows the fence source until the diagram draws", () => {
    const html = renderUndrawn(false);

    expect(html).toContain('data-view="source"');
    expect(html).toContain("flowchart LR");
  });

  it("offers the source toggle only once there is a diagram to toggle back to", () => {
    expect(renderUndrawn(false)).not.toContain("Show diagram source");
  });

  it("keeps its copy action while streaming", () => {
    expect(renderUndrawn(true)).toContain("Copy diagram source");
  });
});
