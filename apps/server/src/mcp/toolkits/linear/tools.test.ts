import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import { Tool } from "effect/unstable/ai";

import { LinearToolkit } from "./tools.ts";

const schemaHasDescription = (schema: unknown): boolean => {
  if (!schema || typeof schema !== "object") return false;
  const record = schema as Record<string, unknown>;
  if (typeof record.description === "string" && record.description.length > 0) return true;
  return [record.anyOf, record.oneOf, record.allOf]
    .filter(Array.isArray)
    .some((members) => members.some(schemaHasDescription));
};

it("exports provider-compatible object schemas with described parameters", () => {
  for (const tool of Object.values(LinearToolkit.tools)) {
    const schema = Tool.getJsonSchema(tool) as {
      readonly type?: unknown;
      readonly properties?: Readonly<Record<string, unknown>>;
      readonly anyOf?: unknown;
      readonly oneOf?: unknown;
    };
    expect(
      tool.description?.length ?? 0,
      `${tool.name} should have a useful description`,
    ).toBeGreaterThan(40);
    expect(schema.type, `${tool.name} must export a top-level object schema`).toBe("object");
    expect(schema.anyOf, `${tool.name} must not export a root anyOf`).toBeUndefined();
    expect(schema.oneOf, `${tool.name} must not export a root oneOf`).toBeUndefined();
    for (const [field, fieldSchema] of Object.entries(schema.properties ?? {})) {
      expect(
        schemaHasDescription(fieldSchema),
        `${tool.name}.${field} should explain what data the agent must pass`,
      ).toBe(true);
    }
  }
});

it("mirrors the Linear MCP tool names so an existing skill keeps working", () => {
  expect(Object.keys(LinearToolkit.tools).sort()).toEqual([
    "create_issue",
    "get_issue",
    "list_comments",
    "list_issue_statuses",
    "list_my_issues",
    "save_comment",
    "save_issue",
  ]);
});

it("tells the agent which tools default to the thread's linked issue", () => {
  for (const name of ["get_issue", "list_comments", "save_comment", "save_issue"] as const) {
    expect(LinearToolkit.tools[name].description).toContain("linked to");
  }
});

it("marks only the reads as readonly and repeatable", () => {
  const readonlyByTool = Object.fromEntries(
    Object.values(LinearToolkit.tools).map((tool) => [
      tool.name,
      Context.get(tool.annotations, Tool.Readonly),
    ]),
  );

  expect(readonlyByTool).toEqual({
    get_issue: true,
    list_comments: true,
    list_issue_statuses: true,
    list_my_issues: true,
    save_comment: false,
    save_issue: false,
    create_issue: false,
  });

  for (const tool of Object.values(LinearToolkit.tools)) {
    // Every call leaves the server, and none of them delete anything.
    expect(Context.get(tool.annotations, Tool.OpenWorld), tool.name).toBe(true);
    expect(Context.get(tool.annotations, Tool.Destructive), tool.name).toBe(false);
  }

  // Saving the same patch twice lands the same issue; creating twice does not.
  expect(Context.get(LinearToolkit.tools.save_issue.annotations, Tool.Idempotent)).toBe(true);
  expect(Context.get(LinearToolkit.tools.create_issue.annotations, Tool.Idempotent)).toBe(false);
  expect(Context.get(LinearToolkit.tools.save_comment.annotations, Tool.Idempotent)).toBe(false);
});
