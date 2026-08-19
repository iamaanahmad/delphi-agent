import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evaluateMarket } from "../src/engine.js";
import { reconcileMarket } from "../src/reconciliation.js";
import { appendTelemetry } from "../src/telemetry.js";
import type {
  EvidenceSignal,
  MarketView,
  ReconciliationGateway,
  RiskPolicy,
  TradePlan,
  TradingGateway,
  WalletBalanceSnapshot,
} from "../src/types.js";

const market: MarketView = {
  id: "0x1000000000000000000000000000000000000001",
  question: "Did the verified threshold resolve Yes?",
  outcomes: ["Yes", "No"],
  probabilities: [0.6, 0.4],
  prices: [0.6, 0.4],
  status: "open",
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

const balance = (collateralAtomic: string): WalletBalanceSnapshot => ({
  address: "0x2000000000000000000000000000000000000002",
  ethWei: "1000000000000000",
  collateralAtomic,
  collateralDecimals: 6,
});

class LifecycleGateway implements TradingGateway {
  private walletReads = 0;
  async listOpenMarkets() { return [market]; }
  async quoteBuy(_marketId: string, _outcomeIdx: number, shares: number) { return { shares, costTst: 0.6 }; }
  async buy(_plan: TradePlan) { return { transactionHash: "0xsubmitted" }; }
  async getWalletSnapshot() {
    this.walletReads += 1;
    return this.walletReads === 1 ? balance("100000000") : balance("99400000");
  }
}

class SettledGateway implements ReconciliationGateway {
  async getWalletSnapshot() { return balance("100400000"); }
  async getMarketSettlement() { return { status: "settled" as const, winningOutcomeIdx: 0 }; }
  async listWalletPositions() {
    return [{
      outcomeIdx: 0,
      sharesAtomic: "1000000000000000000",
      redeemedOrLiquidated: true,
      tokensRedeemedAtomic: "1000000",
    }];
  }
}

test("records a complete deterministic trade-to-redemption lifecycle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "settlement-edge-lifecycle-"));
  const ledgerPath = join(directory, "ledger.jsonl");
  const fetchedAt = new Date().toISOString();
  const evidence: EvidenceSignal = {
    id: "primary",
    source: "Primary API",
    sourceUrl: "https://example.test/settlement.json",
    eventTime: "2026-08-18T00:00:00.000Z",
    freshnessTime: fetchedAt,
    freshnessType: "publication",
    publicationTime: fetchedAt,
    fetchedAt,
    probability: 0.995,
    confidence: 0.98,
    detail: "101 gte 100; age 0.0m",
  };
  const telemetry = { runId: "test-lifecycle", environment: "test" as const };
  await appendTelemetry({ ...telemetry, event: "run_started", data: {} }, ledgerPath, new Date("2026-08-18T00:00:00.000Z"));
  const decision = await evaluateMarket(
    new LifecycleGateway(),
    market,
    0,
    [evidence],
    policy,
    true,
    { receiptPath: ledgerPath, opportunityId: "fixture-opportunity", telemetry },
  );
  assert.equal(decision.transactionHash, "0xsubmitted");

  const reconciliation = await reconcileMarket(new SettledGateway(), market.id, ledgerPath, telemetry);
  assert.deepEqual(reconciliation.settlement, { available: true, value: { status: "settled", winningOutcomeIdx: 0 } });
  assert.deepEqual(reconciliation.redemption, { available: true, value: { status: "redeemed", tokensRedeemedTst: 1 } });
  assert.deepEqual(reconciliation.wallet.changeTst, { available: true, value: 0.4 });
  assert.deepEqual(reconciliation.costBasisTst, { available: true, value: 0.6 });
  assert.deepEqual(reconciliation.realizedPnlTst, { available: true, value: 0.4 });

  const entries = (await readFile(ledgerPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
    hash: string;
    previousHash: string;
    record: Record<string, unknown>;
  });
  assert.equal(entries.length, 10);
  assert.equal(entries[0]?.previousHash, "GENESIS");
  entries.slice(1).forEach((entry, index) => assert.equal(entry.previousHash, entries[index]?.hash));
  const decisionRecord = entries[1]?.record as {
    sources: Array<{ publicationTime: { available: boolean }; fetchTime: { available: boolean } }>;
    marketProbability: { value: number };
    estimate: { available: boolean };
    quote: { value: { costTst: number } };
    impact: { available: boolean };
    riskDecision: { action: string };
    transaction: { status: string; transactionHash: string };
    wallet: { changeTst: { value: number } };
  };
  assert.equal(decisionRecord.sources[0]?.publicationTime.available, true);
  assert.equal(decisionRecord.sources[0]?.fetchTime.available, true);
  assert.equal(decisionRecord.marketProbability.value, 0.6);
  assert.equal(decisionRecord.estimate.available, true);
  assert.equal(decisionRecord.quote.value.costTst, 0.6);
  assert.equal(decisionRecord.impact.available, true);
  assert.equal(decisionRecord.riskDecision.action, "buy");
  assert.deepEqual(decisionRecord.transaction, { status: "submitted", transactionHash: "0xsubmitted" });
  assert.equal(decisionRecord.wallet.changeTst.value, -0.6);
  assert.deepEqual(
    entries.filter((entry) => entry.record.type === "telemetry").map((entry) => entry.record.event),
    [
      "run_started",
      "evidence_accepted",
      "decision_made",
      "quote_obtained",
      "order_submitted",
      "settlement_observed",
      "redemption_observed",
      "realized_pnl_observed",
    ],
  );
  const pnl = entries.find((entry) => entry.record.event === "realized_pnl_observed")?.record as {
    environment: string;
    data: { realizedPnlTst: number };
  };
  assert.equal(pnl.environment, "test");
  assert.equal(pnl.data.realizedPnlTst, 0.4);
});

test("marks unsupported reconciliation fields unavailable without inventing values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "settlement-edge-lifecycle-"));
  const ledgerPath = join(directory, "ledger.jsonl");
  const record = await reconcileMarket({}, market.id, ledgerPath);
  assert.equal(record.wallet.current.available, false);
  assert.equal(record.settlement.available, false);
  assert.equal(record.positions.available, false);
  assert.equal(record.redemption.available, false);
  assert.equal(record.realizedPnlTst.available, false);
});
