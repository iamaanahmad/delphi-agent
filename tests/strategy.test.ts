import assert from "node:assert/strict";
import test from "node:test";
import { ReplayGateway } from "../src/gateway.js";
import { estimateProbability, sizeTrade } from "../src/strategy.js";
import type { EvidenceSignal, MarketView, RiskPolicy } from "../src/types.js";

const market: MarketView = {
  id: "0x1", question: "Threshold crossed?", outcomes: ["Yes", "No"],
  probabilities: [0.6, 0.4], prices: [0.6, 0.4], status: "open",
};
const policy: RiskPolicy = {
  bankrollTst: 100, minEdge: 0.08, minConfidence: 0.75, maxTradeTst: 10,
  maxBankrollPct: 0.1, maxPriceImpact: 0.03, maxSourceAgeMinutes: 15,
  slippagePct: 2, candidateShares: [0.25, 0.5, 1, 2, 4],
};
const signal = (probability: number): EvidenceSignal => ({
  id: "source", source: "Primary API", sourceUrl: "https://example.test",
  eventTime: "2026-08-18T00:00:00.000Z", freshnessTime: new Date().toISOString(), freshnessType: "retrieval", probability, confidence: 0.98, detail: "fixture",
});

test("shrinks a source probability by confidence", () => {
  const estimate = estimateProbability([signal(0.99)], 0.6);
  assert.ok(estimate.probability > 0.95 && estimate.probability < 0.99);
  assert.ok(estimate.confidence >= 0.97);
});

test("source disagreement collapses confidence", () => {
  const estimate = estimateProbability([signal(0.99), signal(0.01)], 0.6);
  assert.ok(estimate.disagreement > 0.4);
  assert.ok(estimate.confidence < 0.2);
});

test("selects the most profitable quote inside all caps", async () => {
  const plan = await sizeTrade(new ReplayGateway([market]), market, 0, 0.98, 0.98, policy);
  assert.ok(plan);
  assert.ok(plan.costTst <= 10);
  assert.ok(plan.priceImpact <= 0.03);
  assert.ok(plan.expectedProfitTst > 0);
});

test("rejects an edge below the threshold", async () => {
  const plan = await sizeTrade(new ReplayGateway([market]), market, 0, 0.65, 0.98, policy);
  assert.equal(plan, undefined);
});
