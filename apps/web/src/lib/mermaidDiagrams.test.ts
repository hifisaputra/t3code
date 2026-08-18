import { describe, expect, it } from "vite-plus/test";

import {
  isMermaidFenceLanguage,
  mermaidConfigForTheme,
  mermaidFenceMarkdown,
  renderMermaidDiagram,
} from "./mermaidDiagrams";

describe("isMermaidFenceLanguage", () => {
  it("recognizes the fence languages that mean diagram", () => {
    expect(isMermaidFenceLanguage("mermaid")).toBe(true);
    expect(isMermaidFenceLanguage("Mermaid")).toBe(true);
    expect(isMermaidFenceLanguage("mmd")).toBe(true);
  });

  it("leaves ordinary code fences alone", () => {
    expect(isMermaidFenceLanguage("ts")).toBe(false);
    expect(isMermaidFenceLanguage("text")).toBe(false);
    expect(isMermaidFenceLanguage("mermaidjs")).toBe(false);
  });
});

describe("mermaidConfigForTheme", () => {
  it("keeps agent-authored diagram source from executing or drawing its own errors", () => {
    const config = mermaidConfigForTheme("dark");
    expect(config.securityLevel).toBe("strict");
    expect(config.suppressErrorRendering).toBe(true);
    expect(config.startOnLoad).toBe(false);
  });

  it("themes each mode separately", () => {
    const light = mermaidConfigForTheme("light").themeVariables;
    const dark = mermaidConfigForTheme("dark").themeVariables;
    expect(light?.textColor).not.toBe(dark?.textColor);
    expect(light?.mainBkg).not.toBe(dark?.mainBkg);
  });

  it("states colors in a syntax Mermaid's color math can parse", () => {
    for (const theme of ["light", "dark"] as const) {
      const variables = mermaidConfigForTheme(theme).themeVariables ?? {};
      const colors = Object.entries(variables).filter(([name]) => !name.startsWith("font"));
      expect(colors.length).toBeGreaterThan(0);
      for (const [, value] of colors) {
        expect(value).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });
});

describe("mermaidFenceMarkdown", () => {
  it("copies a drawn diagram back as the fence it came from", () => {
    expect(mermaidFenceMarkdown("flowchart LR\n  a --> b\n")).toBe(
      "```mermaid\nflowchart LR\n  a --> b\n```\n\n",
    );
  });

  it("opens a longer fence when the diagram contains one", () => {
    expect(mermaidFenceMarkdown('flowchart LR\n  a["```"] --> b')).toBe(
      '````mermaid\nflowchart LR\n  a["```"] --> b\n````\n\n',
    );
  });
});

describe("renderMermaidDiagram", () => {
  it("reports empty source instead of loading Mermaid for it", async () => {
    const outcome = await renderMermaidDiagram({ code: "   \n  ", theme: "light" });
    expect(outcome._tag).toBe("Invalid");
  });

  it("refuses a diagram too large to be readable", async () => {
    const outcome = await renderMermaidDiagram({
      code: `graph TD\n${"  a --> b\n".repeat(5000)}`,
      theme: "light",
    });
    expect(outcome).toEqual({ _tag: "Invalid", message: "The diagram is too large to render." });
  });
});
