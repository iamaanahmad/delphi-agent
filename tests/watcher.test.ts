import assert from "node:assert/strict";
import test from "node:test";
import { runWatcher, runWatcherCycle, wait } from "../src/watcher.js";
import type { Decision, EvidenceSignal, MarketView, ResolutionRule, RiskPolicy, TradePlan, TradingGateway } from "../src/types.js";

const market: MarketView = {
  id: "0x1",
  question: "Threshold crossed?",
  outcomes: ["Yes", "No"],
  probabilities: [0.6, 0.4],
  prices: [0.6, 0.4],
  status: "open",
};
const rule: ResolutionRule = {
  marketId: market.id,
  outcomeIdx: 0,
  sourceName: "Primary API",
  sourceUrl: "https://example.test/data.json",
  jsonPath: "value",
  comparator: "gte",
  threshold: 100,
};
const evidence: EvidenceSignal = {
  id: "primary",
  source: "Primary API",
  sourceUrl: rule.sourceUrl,
  observedAt: "2026-08-18T00:00:00.000Z",
  probability: 0.995,
  confidence: 0.98,
  detail: "101 gte 100; age 0.0m",
};
const policy: RiskPolicy = {
  bankrollTst: 100,
  minEdge: 0.08,
  minConfidence: 0.75,
  maxTradeTst: 10,
  maxBankrollPct: 0.1,
  maxPriceImpact: 0.03,
  maxSourceAgeMinutes: 15,
  slippagePct: 2,
  candidateShares: [1],
};

class FixtureGateway implements TradingGateway {
  listCalls = 0;
  buyCalls = 0;
  async listOpenMarkets() { this.listCalls += 1; return [market]; }
  async quoteBuy(_marketId: string, _outcomeIdx: number, shares: number) { return { shares, costTst: 0.6 * shares }; }
  async buy(_plan: TradePlan) { this.buyCalls += 1; return { transactionHash: "0xtest" }; }
}

const decision: Decision = { action: "buy", reason: "fixture", market, evidence: [evidence] };

test("polls again at the configured interval", async () => {
  const gateway = new FixtureGateway();
  const controller = new AbortController();
  const sleeps: number[] = [];
  await runWatcher({
    gateway,
    ruleFile: "unused",
    policy,
    intervalMs: 42,
    signal: controller.signal,
    loadRules: async () => [rule],
    loadEvidence: async () => evidence,
    evaluate: async () => decision,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      if (sleeps.length === 2) controller.abort();
    },
  });
  assert.equal(gateway.listCalls, 2);
  assert.deepEqual(sleeps, [42, 42]);
});

test("polls every 60 seconds by default", async () => {
  const gateway = new FixtureGateway();
  const controller = new AbortController();
  const sleeps: number[] = [];
  await runWatcher({
    gateway,
    ruleFile: "unused",
    policy,
    signal: controller.signal,
    loadRules: async () => [rule],
    loadEvidence: async () => evidence,
    evaluate: async () => decision,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      controller.abort();
    },
  });
  assert.deepEqual(sleeps, [60_000]);
});

test("backs off exponentially after transient gateway failures", async () => {
  const gateway = new FixtureGateway();
  const originalList = gateway.listOpenMarkets.bind(gateway);
  gateway.listOpenMarkets = async () => {
    gateway.listCalls += 1;
    if (gateway.listCalls <= 2) throw new Error("temporary gateway failure");
    return originalList().then((markets) => {
      gateway.listCalls -= 1;
      return markets;
    });
  };
  const controller = new AbortController();
  const sleeps: number[] = [];
  await runWatcher({
    gateway,
    ruleFile: "unused",
    policy,
    intervalMs: 60_000,
    retryBaseMs: 100,
    retryMaxMs: 1_000,
    signal: controller.signal,
    loadRules: async () => [rule],
    loadEvidence: async () => evidence,
    evaluate: async () => decision,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      if (milliseconds === 60_000) controller.abort();
    },
  });
  assert.equal(gateway.listCalls, 3);
  assert.deepEqual(sleeps, [100, 200, 60_000]);
});

test("suppresses duplicate orders for unchanged evidence and market state", async () => {
  const gateway = new FixtureGateway();
  const state = new Map<string, string>();
  let evaluations = 0;
  const options = {
    gateway,
    ruleFile: "unused",
    policy,
    execute: true,
    state,
    loadRules: async () => [rule],
    loadEvidence: async () => evidence,
    evaluate: async (trackedGateway: TradingGateway) => {
      evaluations += 1;
      await trackedGateway.buy({} as TradePlan);
      return decision;
    },
  };
  await runWatcherCycle(options);
  await runWatcherCycle(options);
  assert.equal(evaluations, 1);
  assert.equal(gateway.buyCalls, 1);
});

test("blocks a replay when an order result is ambiguous", async () => {
  const gateway = new FixtureGateway();
  gateway.buy = async () => { gateway.buyCalls += 1; throw new Error("response lost"); };
  const state = new Map<string, string>();
  const options = {
    gateway,
    ruleFile: "unused",
    policy,
    execute: true,
    state,
    loadRules: async () => [rule],
    loadEvidence: async () => evidence,
    evaluate: async (trackedGateway: TradingGateway) => {
      await trackedGateway.buy({} as TradePlan);
      return decision;
    },
  };
  await assert.rejects(runWatcherCycle(options), /watcher evaluation/);
  await runWatcherCycle(options);
  assert.equal(gateway.buyCalls, 1);
});

test("an abort signal ends an in-progress wait without waiting for the timer", async () => {
  const controller = new AbortController();
  const started = Date.now();
  const pending = wait(10_000, controller.signal);
  controller.abort();
  await pending;
  assert.ok(Date.now() - started < 1_000);
});
