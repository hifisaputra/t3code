import { describe, expect, it } from "vite-plus/test";

import {
  decodeLinearPickerValue,
  encodeLinearPickerValue,
  formatLinearBranchPrefixes,
  linearConnectionSentence,
  linearPickerLabel,
  linearPickerOptions,
  nextLinearLabelRuleLabel,
  nextLinearPickerTarget,
  parseLinearBranchPrefixes,
} from "./LinearSettings.logic";

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

describe("linearConnectionSentence", () => {
  it("names the viewer and the workspace when connected", () => {
    expect(
      linearConnectionSentence(
        {
          status: "connected",
          viewer: { id: "u1", name: "Ada Lovelace", displayName: "ada" },
          workspace: { id: "w1", name: "T3 Tools", urlKey: "t3tools" },
        },
        NOW,
      ),
    ).toBe("Connected as ada in T3 Tools");
  });

  it("separates a missing key from a rejected one", () => {
    expect(linearConnectionSentence({ status: "unconfigured" }, NOW)).toBe("Not connected");
    expect(linearConnectionSentence({ status: "unauthenticated" }, NOW)).toBe(
      "Linear rejected the API key",
    );
  });

  it("prints the server's sentence unchanged when there is nothing to wait for", () => {
    expect(
      linearConnectionSentence({ status: "failed", detail: "Linear did not respond." }, NOW),
    ).toBe("Linear did not respond.");
  });

  it("rounds a retry deadline up so the label never invites an early retry", () => {
    expect(
      linearConnectionSentence(
        { status: "failed", detail: "Linear is rate limiting this server", retryAt: NOW + 61_000 },
        NOW,
      ),
    ).toBe("Linear is rate limiting this server. Retry after 2m.");
  });

  it("drops a retry deadline that has already passed", () => {
    expect(
      linearConnectionSentence(
        { status: "failed", detail: "Linear is rate limiting this server.", retryAt: NOW - 1 },
        NOW,
      ),
    ).toBe("Linear is rate limiting this server.");
  });
});

const TEAMS = [
  {
    id: "team-del",
    key: "DEL",
    name: "Delivery",
    projects: [
      { id: "p-web", name: "Web app", url: "https://linear.app/p-web" },
      { id: "p-api", name: "API", url: "https://linear.app/p-api" },
    ],
  },
  {
    id: "team-inf",
    key: "INF",
    name: "Infra",
    // Linear lets a project span teams; the picker must not offer it twice.
    projects: [{ id: "p-api", name: "API", url: "https://linear.app/p-api" }],
  },
];

describe("linearPickerOptions", () => {
  it("lists each team followed by its projects", () => {
    expect(linearPickerOptions(TEAMS)).toEqual([
      { value: "team:DEL", label: "DEL · Delivery", kind: "team" },
      { value: "project:p-web", label: "DEL / Web app", kind: "project" },
      { value: "project:p-api", label: "DEL / API", kind: "project" },
      { value: "team:INF", label: "INF · Infra", kind: "team" },
    ]);
  });

  it("has nothing to offer before the workspace answers", () => {
    expect(linearPickerOptions([])).toEqual([]);
  });
});

describe("linear picker values", () => {
  it("round-trips a team and a project", () => {
    const team = { teamKey: "DEL", linearProjectId: null };
    const project = { teamKey: null, linearProjectId: "p-web" };
    expect(decodeLinearPickerValue(encodeLinearPickerValue(team))).toEqual(team);
    expect(decodeLinearPickerValue(encodeLinearPickerValue(project))).toEqual(project);
  });

  it("prefers the project when a row somehow carries both", () => {
    expect(encodeLinearPickerValue({ teamKey: "DEL", linearProjectId: "p-web" })).toBe(
      "project:p-web",
    );
  });

  it("refuses anything the select could not have produced", () => {
    expect(decodeLinearPickerValue("")).toBeNull();
    expect(decodeLinearPickerValue("team:")).toBeNull();
    expect(decodeLinearPickerValue("project:")).toBeNull();
    expect(decodeLinearPickerValue("DEL")).toBeNull();
  });
});

describe("linearPickerLabel", () => {
  const options = linearPickerOptions(TEAMS);

  it("names a row from the workspace", () => {
    expect(linearPickerLabel(options, { teamKey: "DEL", linearProjectId: null })).toBe(
      "DEL · Delivery",
    );
  });

  it("still says what a row points at when the workspace has not loaded", () => {
    expect(linearPickerLabel([], { teamKey: null, linearProjectId: "p-web" })).toBe(
      "Project p-web",
    );
    expect(linearPickerLabel([], { teamKey: "DEL", linearProjectId: null })).toBe("DEL");
  });
});

describe("nextLinearPickerTarget", () => {
  const options = linearPickerOptions(TEAMS);

  it("skips what is already mapped", () => {
    expect(
      nextLinearPickerTarget(options, [
        { teamKey: "DEL", linearProjectId: null },
        { teamKey: null, linearProjectId: "p-web" },
      ]),
    ).toEqual({ teamKey: null, linearProjectId: "p-api" });
  });

  it("repeats the first option once everything is mapped", () => {
    const all = options.map((option) => decodeLinearPickerValue(option.value)!);
    expect(nextLinearPickerTarget(options, all)).toEqual({ teamKey: "DEL", linearProjectId: null });
  });

  it("has nothing to add before the workspace answers", () => {
    expect(nextLinearPickerTarget([], [])).toBeNull();
  });
});

describe("linear branch prefixes", () => {
  it("reads a typed line as a normalized list", () => {
    expect(parseLinearBranchPrefixes("feat, Fix ,bug/")).toEqual(["feat", "fix", "bug"]);
  });

  it("drops blanks and repeats rather than saving them", () => {
    expect(parseLinearBranchPrefixes("feat,,  , feat , FEAT/")).toEqual(["feat"]);
    expect(parseLinearBranchPrefixes("")).toEqual([]);
    expect(parseLinearBranchPrefixes("   ,  ")).toEqual([]);
  });

  it("round-trips a saved list back into the box", () => {
    const prefixes = ["feat", "fix", "bug", "chore"];
    expect(parseLinearBranchPrefixes(formatLinearBranchPrefixes(prefixes))).toEqual(prefixes);
  });
});

describe("nextLinearLabelRuleLabel", () => {
  it("names the first rule", () => {
    expect(nextLinearLabelRuleLabel([])).toBe("New label");
    expect(nextLinearLabelRuleLabel([{ label: "Bug" }])).toBe("New label");
  });

  it("never repeats a label a rule already claims", () => {
    expect(nextLinearLabelRuleLabel([{ label: "New label" }])).toBe("New label 2");
    expect(nextLinearLabelRuleLabel([{ label: " new LABEL " }, { label: "New label 2" }])).toBe(
      "New label 3",
    );
  });
});
