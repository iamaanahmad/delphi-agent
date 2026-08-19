import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runWatcher, runWatcherCycle, wait } from "../src/watcher.js";
import type { WatcherStateEntry } from "../src/watcher.js";
import type { Decision, EvidenceSignal, MarketView, ResolutionRule, RiskPolicy, TradePlan, TradingGateway } from "../src/types.js";

const market: MarketView = {
  id: "0x1",
  question: "Threshold crossed?",
  outcomes: ["Yes", "No"],
  probabilities: [0.6, 0.4],
  prices: [0.6, 0.4],
  status: "open",
  resolvesAt: "2026-08-20T00:00:00.000Z",
};
const rule: ResolutionRule = {
  marketId: market.id,
  outcomeIdx: 0,
  sourceName: "Primary API",
  sourceUrl: "https://example.test/data.json",
  jsonPath: "value",
  comparator: "gte",
  threshold: 100,
  eventAtPath: "event_at",
  freshness: { type: "retrieval" },
  earliestDecisionAt: "2026-08-18T00:00:00.000Z",
};
const evidence: EvidenceSignal = {
  id: "primary",
  source: "Primary API",
  sourceUrl: rule.sourceUrl,
  eventTime: "2026-08-18T00:00:00.000Z",
  freshnessTime: "2026-08-18T00:00:00.000Z",
  freshnessType: "retrieval",
  probability: 0.995,
  confidence: 0.98,
  detail: "101 gte 100; freshness age 0.0m",
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
    state: new Map(),
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
    state: new Map(),
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
    state: new Map(),
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
  const state = new Map<string, WatcherStateEntry>();
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
      return { ...decision, transactionHash: "0xtest" };
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
  const state = new Map<string, WatcherStateEntry>();
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
      return { ...decision, transactionHash: "0xtest" };
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

test("persists duplicate protection across process state reloads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "settlement-edge-watcher-"));
  const stateFile = join(directory, "watcher-state.json");
  const receiptPath = join(directory, "ledger.jsonl");
  const gateway = new FixtureGateway();
  let evaluations = 0;
  const options = {
    gateway,
    ruleFile: "unused",
    policy,
    execute: true,
    stateFile,
    receiptPath,
    loadRules: async () => [rule],
    loadEvidence: async () => evidence,
    evaluate: async (trackedGateway: TradingGateway) => {
      evaluations += 1;
      await trackedGateway.buy({} as TradePlan);
      return { ...decision, transactionHash: "0xtest" };
    },
  };
  await runWatcherCycle(options);
  await runWatcherCycle(options);
  assert.equal(evaluations, 1);
  assert.equal(gateway.buyCalls, 1);
  const persisted = JSON.parse(await readFile(stateFile, "utf8")) as { opportunities: Record<string, WatcherStateEntry> };
  assert.equal(Object.values(persisted.opportunities)[0]?.status, "processed");
  assert.equal(Object.values(persisted.opportunities)[0]?.transactionHash, "0xtest");
});

test("persists ambiguous order blocking across process state reloads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "settlement-edge-watcher-"));
  const stateFile = join(directory, "watcher-state.json");
  const receiptPath = join(directory, "ledger.jsonl");
  const gateway = new FixtureGateway();
  let pendingWasDurable = false;
  gateway.buy = async () => {
    gateway.buyCalls += 1;
    const pending = JSON.parse(await readFile(stateFile, "utf8")) as { opportunities: Record<string, WatcherStateEntry> };
    pendingWasDurable = Object.values(pending.opportunities)[0]?.status === "pending";
    throw new Error("response lost");
  };
  const options = {
    gateway,
    ruleFile: "unused",
    policy,
    execute: true,
    stateFile,
    receiptPath,
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
  assert.equal(pendingWasDurable, true);
  const persisted = JSON.parse(await readFile(stateFile, "utf8")) as { opportunities: Record<string, WatcherStateEntry> };
  assert.equal(Object.values(persisted.opportunities)[0]?.status, "ambiguous");
});

test("records schema failures as terminal hash-linked ledger entries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "settlement-edge-watcher-"));
  const receiptPath = join(directory, "ledger.jsonl");
  await assert.rejects(runWatcherCycle({
    gateway: new FixtureGateway(),
    ruleFile: "unused",
    policy,
    state: new Map(),
    stateFile: false,
    receiptPath,
    loadRules: async () => [rule],
    loadEvidence: async () => { throw new Error("Missing scalar at value"); },
  }), /watcher evaluation/);
  const entries = (await readFile(receiptPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
    previousHash: string;
    record: { type: string; stage: string; terminal: boolean };
  });
  assert.equal(entries.length, 3);
  assert.equal(entries[0]?.previousHash, "GENESIS");
  assert.equal(entries[1]?.record.type, "failure");
  assert.equal(entries[1]?.record.stage, "schema");
  assert.equal(entries[1]?.record.terminal, true);
  assert.equal(entries[2]?.record.type, "telemetry");
});
