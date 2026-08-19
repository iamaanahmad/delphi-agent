import assert from "node:assert/strict";
import test from "node:test";
import { assessRuleTiming } from "../src/rule-timing.js";
import type { MarketView, ResolutionRule } from "../src/types.js";

const market: MarketView = {
  id: "0x1111111111111111111111111111111111111111",
  question: "Can evidence arrive before close?",
  outcomes: ["Yes", "No"],
  probabilities: [0.5, 0.5],
  prices: [0.5, 0.5],
  status: "open",
  resolvesAt: "2026-08-20T17:00:00Z",
};

const rule: ResolutionRule = {
  marketId: market.id,
  outcomeIdx: 0,
  sourceName: "Official source",
  sourceUrl: "https://example.test/data.json",
  comparator: "gt",
  threshold: 1,
  freshness: { type: "retrieval" },
  aggregation: {
    recordsPath: "data",
    valuePath: "value",
    eventAtPath: "time",
    reducer: "max",
    windowStart: "2026-08-20T18:00:00Z",
    windowEnd: "2026-08-20T23:00:00Z",
  },
};

test("rejects an evidence window that starts after market close", () => {
  const result = assessRuleTiming(rule, market);
  assert.equal(result.feasible, false);
  assert.match(result.reason, /not before market close/);
});

test("accepts a declared decisive signal before market close", () => {
  const result = assessRuleTiming({
    ...rule,
    aggregation: undefined,
    jsonPath: "value",
    eventAtPath: "time",
    earliestDecisionAt: "2026-08-20T16:00:00Z",
  }, market);
  assert.equal(result.feasible, true);
});
