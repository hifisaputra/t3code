import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type AssistantProjectConfig,
  type AssistantTask,
} from "@t3tools/contracts";
import {
  e2eBrief,
  e2eInstructions,
  leadInstructions,
  reviewerInstructions,
  workerInstructions,
} from "./prompts.ts";

const timestamp = "2026-09-15T00:00:00.000Z";
const config: AssistantProjectConfig = {
  projectId: ProjectId.make("project"),
  linearProjectId: "linear",
  assignedToMe: true,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
  workerModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
  runtimeMode: "full-access",
  baseBranch: "develop",
  readyStates: [],
  instructions: "The shared policy: ask before a migration.",
  roleInstructions: {
    // Left in stored setups by the retired assistant chat; no thread reads it.
    assistant: "ASSISTANT SECTION",
    lead: "LEAD SECTION",
    implement: "IMPLEMENT SECTION",
    review: "REVIEW SECTION",
    e2e: "E2E SECTION",
  },
  stagingCheckCommand: "",
  stagingUrl: "https://staging.example.test",
  reviewState: "In Review",
  acceptedState: "Done",
  maxWorkerTurns: 6,
};
const task: AssistantTask = {
  id: "task",
  projectId: config.projectId,
  issue: {
    id: "issue",
    identifier: "APP-1",
    title: "Export the report",
    url: "https://linear.app/test/issue/APP-1",
    branchName: "app-1",
    priority: 3,
    updatedAt: timestamp,
    state: { id: "todo", name: "Todo", type: "unstarted", position: 0, color: "#fff" },
    team: { id: "team", key: "APP", name: "App" },
    assignee: null,
    project: null,
    cycle: null,
  },
  threadId: ThreadId.make("assistant-work-task"),
  status: "working",
  brief: "Add the export button to the report page.",
  summary: "",
  reviewInstructions: "",
  feedback: "",
  turns: 0,
  turnLimit: 6,
  deployment: null,
  error: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const withCriteria: AssistantTask = {
  ...task,
  criteria: ["The report page shows an Export button.", "Export downloads a CSV of the rows."],
};
const prompts = (
  project: AssistantProjectConfig,
  issue: AssistantTask = task,
): Record<string, string> => ({
  lead: leadInstructions(project, issue),
  implement: workerInstructions(project, issue),
  review: reviewerInstructions(project, issue),
  e2e: e2eInstructions(project, issue, "/evidence", "Test the export."),
});

describe("project instructions by audience", () => {
  it("sends each thread the shared policy and only its own section", () => {
    const written = prompts(config);
    for (const [audience, text] of Object.entries(written)) {
      expect(text, audience).toContain("The shared policy: ask before a migration.");
      expect(text, audience).toContain(`${audience.toUpperCase()} SECTION`);
      expect(text, audience).not.toContain("ASSISTANT SECTION");
      for (const other of Object.keys(written).filter((name) => name !== audience))
        expect(text, `${audience} has ${other}`).not.toContain(`${other.toUpperCase()} SECTION`);
    }
  });

  it("sends a setup written before sections had one string to every thread", () => {
    const { roleInstructions: _sections, ...old } = config;
    for (const [audience, text] of Object.entries(
      prompts({ ...old, instructions: "One string for everyone." }),
    ))
      expect(text, audience).toContain("One string for everyone.");
  });
});

describe("acceptance criteria", () => {
  it("numbers them for the worker, the reviewer and the tester", () => {
    const written = prompts(config, withCriteria);
    for (const audience of ["implement", "review", "e2e"]) {
      expect(written[audience], audience).toContain("Acceptance criteria:");
      expect(written[audience], audience).toContain("1. The report page shows an Export button.");
      expect(written[audience], audience).toContain("2. Export downloads a CSV of the rows.");
    }
    expect(written.e2e).toContain("one entry per criterion");
    // Notes that are not failures have their own list; failures stay in checks.
    expect(written.e2e).toContain(
      "- worthALook: what the person should look at that is not a failure",
    );
    expect(written.e2e).toContain("A failure goes in checks, not here.");
  });

  it("leaves an issue taken before criteria existed on the free-text path", () => {
    const written = prompts(config);
    for (const audience of ["implement", "review", "e2e"])
      expect(written[audience], audience).not.toContain("Acceptance criteria:");
    expect(written.e2e).toContain("- passed: every criterion was verified");
  });

  it("prefixes them to the team leader's brief for the tester", () => {
    expect(e2eBrief(withCriteria, "Test the export.")).toBe(
      "Acceptance criteria:\n1. The report page shows an Export button.\n2. Export downloads a CSV of the rows.\nTest the export.",
    );
    expect(e2eBrief(task, "Test the export.")).toBe("Test the export.");
  });
});

describe("the project's check command", () => {
  it("tells the worker to run it and the reviewer that T3 already did", () => {
    const written = prompts({ ...config, checkCommand: "bun run check" });
    expect(written.implement).toContain("T3 runs `bun run check` in this worktree");
    expect(written.review).toContain("T3 ran the project's check command before this request");
    expect(written.e2e).not.toContain("check command");
  });

  it("says nothing about a check the project does not have", () => {
    const written = prompts(config);
    expect(written.implement).not.toContain("when you request review; a red run");
    expect(written.review).not.toContain("T3 ran the project's check command");
  });
});

describe("role skills", () => {
  it("tells only the roles with a skill which one wins", () => {
    const written = prompts({ ...config, roleSkills: { implement: "worker-method" } });
    expect(written.implement).toContain("The skill invoked with this message");
    expect(written.review).not.toContain("The skill invoked with this message");
  });
});

describe("the team leader and the staging deploy", () => {
  it("hands the deploy to T3 and keeps assistant_wait for other waits", () => {
    const lead = leadInstructions(config, task);
    expect(lead).toContain("watches it and messages you when it is verified or fails");
    expect(lead).not.toContain("call assistant_wait with the reason while staging");
    expect(lead.match(/assistant_wait/g)).toHaveLength(1);
  });
});
