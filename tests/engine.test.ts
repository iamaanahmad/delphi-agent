import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evaluateMarket } from "../src/engine.js";
import { ReplayGateway } from "../src/gateway.js";
import type { EvidenceSignal, MarketView, RiskPolicy } from "../src/types.js";

const market: MarketView = { id: "0x1", question: "Verified?", outcomes: ["Yes", "No"], probabilities: [0.55, 0.45], prices: [0.55, 0.45], status: "open" };
const policy: RiskPolicy = { bankrollTst: 100, minEdge: 0.08, minConfidence: 0.75, maxTradeTst: 10, maxBankrollPct: 0.1, maxPriceImpact: 0.03, maxSourceAgeMinutes: 15, slippagePct: 2, candidateShares: [0.25, 0.5, 1, 2, 4] };
const evidence: EvidenceSignal = { id: "primary", source: "Primary API", sourceUrl: "https://example.test", observedAt: new Date().toISOString(), probability: 0.995, confidence: 0.98, detail: "threshold crossed" };

test("creates a dry-run plan when evidence and quote pass", async () => {
  const directory = await mkdtemp(join(tmpdir(), "settlement-edge-engine-"));
  const decision = await evaluateMarket(new ReplayGateway([market]), market, 0, [evidence], policy, false, { receiptPath: join(directory, "ledger.jsonl") });
  assert.equal(decision.action, "buy");
  assert.match(decision.reason, /dry-run/);
  assert.equal(decision.transactionHash, undefined);
});

test("stops on stale evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "settlement-edge-engine-"));
  const stale = { ...evidence, observedAt: "2020-01-01T00:00:00.000Z" };
  const decision = await evaluateMarket(new ReplayGateway([market]), market, 0, [stale], policy, false, { receiptPath: join(directory, "ledger.jsonl") });
  assert.equal(decision.action, "skip");
  assert.match(decision.reason, /fresh/);
});
