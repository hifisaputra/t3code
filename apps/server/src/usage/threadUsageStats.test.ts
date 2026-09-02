import { describe, expect, it } from "@effect/vitest";

import { aggregateThreadUsage } from "./threadUsageStats.ts";
import { parseRateTable } from "./usagePricing.ts";
import type { UsageRecord } from "./usageTranscripts.ts";

/** Round numbers so a cost assertion reads as tokens x rate rather than a magic float. */
const rates = parseRateTable({
  "claude-opus-5": {
    input_cost_per_token: 1e-5,
    output_cost_per_token: 1e-4,
    cache_read_input_token_cost: 1e-6,
    cache_creation_input_token_cost: 2e-5,
  },
  "claude-sonnet-5": {
    input_cost_per_token: 1e-6,
    output_cost_per_token: 1e-5,
    cache_read_input_token_cost: 1e-7,
    cache_creation_input_token_cost: 2e-6,
  },
});

let nextDedupe = 0;

function record(input: {
  model?: string;
  subagent?: { name: string | null } | null;
  uncachedInput?: number;
  cachedInput?: number;
  cacheCreation?: number;
  output?: number;
  timestampMs?: number;
  dedupeKey?: string | null;
  reportedCostUsd?: number | null;
}): UsageRecord {
  return {
    provider: "claude",
    timestampMs: input.timestampMs ?? 1_000,
    model: input.model ?? "claude-opus-5",
    sessionId: "session-1",
    subagent: input.subagent ?? null,
    totals: {
      uncachedInputTokens: input.uncachedInput ?? 0,
      cachedInputTokens: input.cachedInput ?? 0,
      cacheCreationTokens: input.cacheCreation ?? 0,
      outputTokens: input.output ?? 0,
      reasoningTokens: 0,
    },
    reportedCostUsd: input.reportedCostUsd ?? null,
    dedupeKey: input.dedupeKey === undefined ? `d${nextDedupe++}` : input.dedupeKey,
  };
}

describe("aggregateThreadUsage", () => {
  it("separates delegated work from the main agent's own", () => {
    const result = aggregateThreadUsage(
      [
        record({ uncachedInput: 1_000, output: 100 }),
        record({
          model: "claude-sonnet-5",
          subagent: { name: "Explore" },
          uncachedInput: 5_000,
          output: 200,
        }),
      ],
      rates,
    );

    expect(result.mainAgent.totals.uncachedInputTokens).toBe(1_000);
    expect(result.subagents.totals.uncachedInputTokens).toBe(5_000);
    expect(result.total.totals.uncachedInputTokens).toBe(6_000);
    expect(result.total.totals.outputTokens).toBe(300);
    // 1_000 * 1e-5 + 100 * 1e-4
    expect(result.mainAgent.costUsd).toBeCloseTo(0.02, 10);
    // 5_000 * 1e-6 + 200 * 1e-5
    expect(result.subagents.costUsd).toBeCloseTo(0.007, 10);
    expect(result.total.costUsd).toBeCloseTo(0.027, 10);
  });

  it("prices each agent at its own model's rate", () => {
    // The same token counts on a cheaper model must not inherit the parent's rate.
    const result = aggregateThreadUsage(
      [
        record({ model: "claude-opus-5", uncachedInput: 1_000 }),
        record({ model: "claude-sonnet-5", subagent: { name: "Explore" }, uncachedInput: 1_000 }),
      ],
      rates,
    );

    expect(result.mainAgent.costUsd).toBeCloseTo(0.01, 10);
    expect(result.subagents.costUsd).toBeCloseTo(0.001, 10);
  });

  it("groups subagent usage by agent and model, largest cost first", () => {
    const result = aggregateThreadUsage(
      [
        record({ subagent: { name: "Explore" }, uncachedInput: 100 }),
        record({ subagent: { name: "Explore" }, uncachedInput: 200 }),
        record({ subagent: { name: "package-builder" }, uncachedInput: 5_000 }),
      ],
      rates,
    );

    expect(result.subagentBreakdown.map((slice) => slice.agentName)).toEqual([
      "package-builder",
      "Explore",
    ]);
    expect(result.subagentBreakdown[0]?.totals.uncachedInputTokens).toBe(5_000);
    expect(result.subagentBreakdown[1]?.totals.uncachedInputTokens).toBe(300);
    expect(result.subagentBreakdown[1]?.records).toBe(2);
  });

  it("keeps one subagent's two models on separate rows", () => {
    const result = aggregateThreadUsage(
      [
        record({ model: "claude-opus-5", subagent: { name: "Explore" }, uncachedInput: 100 }),
        record({ model: "claude-sonnet-5", subagent: { name: "Explore" }, uncachedInput: 100 }),
      ],
      rates,
    );

    expect(result.subagentBreakdown).toHaveLength(2);
    expect(result.subagentBreakdown.map((slice) => slice.model).sort()).toEqual([
      "claude-opus-5",
      "claude-sonnet-5",
    ]);
  });

  it("counts an unnamed subagent as delegated rather than as the main agent", () => {
    const result = aggregateThreadUsage(
      [
        record({ uncachedInput: 1_000 }),
        record({ subagent: { name: null }, uncachedInput: 2_000 }),
      ],
      rates,
    );

    expect(result.mainAgent.totals.uncachedInputTokens).toBe(1_000);
    expect(result.subagents.totals.uncachedInputTokens).toBe(2_000);
    expect(result.mainAgentByModel).toHaveLength(1);
    expect(result.subagentBreakdown).toHaveLength(1);
    expect(result.subagentBreakdown[0]?.agentName).toBeNull();
  });

  it("drops repeats of a dedupe key rather than multiplying the bill", () => {
    // One assistant message is written once per content block, each repeating
    // the same usage object; summing them raw overcounts several times over.
    const result = aggregateThreadUsage(
      [
        record({ dedupeKey: "msg-1", uncachedInput: 1_000 }),
        record({ dedupeKey: "msg-1", uncachedInput: 1_000 }),
        record({ dedupeKey: "msg-1", uncachedInput: 1_000 }),
      ],
      rates,
    );

    expect(result.total.totals.uncachedInputTokens).toBe(1_000);
    expect(result.total.records).toBe(1);
    expect(result.duplicatesDropped).toBe(2);
  });

  it("keeps records that carry no dedupe key", () => {
    const result = aggregateThreadUsage(
      [
        record({ dedupeKey: null, uncachedInput: 500 }),
        record({ dedupeKey: null, uncachedInput: 500 }),
      ],
      rates,
    );

    expect(result.total.totals.uncachedInputTokens).toBe(1_000);
    expect(result.duplicatesDropped).toBe(0);
  });

  it("prefers a provider-reported cost over the rate table", () => {
    const result = aggregateThreadUsage(
      [record({ uncachedInput: 1_000, output: 100, reportedCostUsd: 0.5 })],
      rates,
    );

    expect(result.total.costUsd).toBe(0.5);
    expect(result.total.unpricedRecords).toBe(0);
  });

  it("reports tokens it could not price instead of billing them as free", () => {
    const result = aggregateThreadUsage(
      [record({ model: "some-unknown-model", uncachedInput: 1_000 })],
      rates,
    );

    expect(result.total.totals.uncachedInputTokens).toBe(1_000);
    expect(result.total.costUsd).toBe(0);
    expect(result.total.unpricedRecords).toBe(1);
  });

  it("values cache reads against what full input would have cost", () => {
    const result = aggregateThreadUsage([record({ cachedInput: 10_000 })], rates);

    // 10_000 read at 1e-6 instead of 1e-5.
    expect(result.total.costUsd).toBeCloseTo(0.01, 10);
    expect(result.total.cacheSavingsUsd).toBeCloseTo(0.09, 10);
  });

  it("reports the span the thread's records cover", () => {
    const result = aggregateThreadUsage(
      [
        record({ timestampMs: 5_000 }),
        record({ timestampMs: 1_000 }),
        record({ timestampMs: 9_000 }),
      ],
      rates,
    );

    expect(result.firstRecordAtMs).toBe(1_000);
    expect(result.lastRecordAtMs).toBe(9_000);
  });

  it("returns empty totals for a thread with no records", () => {
    const result = aggregateThreadUsage([], rates);

    expect(result.total.costUsd).toBe(0);
    expect(result.total.records).toBe(0);
    expect(result.mainAgentByModel).toEqual([]);
    expect(result.subagentBreakdown).toEqual([]);
    expect(result.firstRecordAtMs).toBeNull();
    expect(result.lastRecordAtMs).toBeNull();
  });
});
