import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { settlePortfolio } from "../src/settlement.js";
import type {
  MarketSettlementSnapshot,
  PortfolioPositionSnapshot,
  SettlementExecution,
  SettlementGateway,
  SettlementQuote,
  WalletBalanceSnapshot,
} from "../src/types.js";

const wallet = (collateralAtomic = "10000000"): WalletBalanceSnapshot => ({
  address: "0x2000000000000000000000000000000000000002",
  ethWei: "1000000000000000",
  collateralAtomic,
  collateralDecimals: 6,
});

const position = (marketId: string, outcomeIdx = 0): PortfolioPositionSnapshot => ({
  marketId,
  outcomeIdx,
  sharesAtomic: "1000000000000000000",
  redeemedOrLiquidated: false,
  tokensRedeemedAtomic: "0",
});

class SettlementFixtureGateway implements SettlementGateway {
  redeemed: string[] = [];
  liquidated: Array<{ marketId: string; outcomeIndices: number[] }> = [];
  walletReads = 0;

  constructor(
    readonly positions: PortfolioPositionSnapshot[],
    readonly settlements: Record<string, MarketSettlementSnapshot | Error>,
  ) {}

  async getWalletSnapshot() {
    this.walletReads += 1;
    return wallet(this.walletReads > 2 ? "12000000" : "10000000");
  }

  async listPortfolioPositions() { return this.positions; }

  async getMarketSettlement(marketId: string) {
    const settlement = this.settlements[marketId];
    if (settlement instanceof Error) throw settlement;
    if (!settlement) throw new Error("missing settlement fixture");
    return settlement;
  }

  async quoteRedemption(): Promise<SettlementQuote> {
    return { sharesAtomic: ["1000000000000000000"], tokensOutAtomic: "1000000" };
  }

  async quoteLiquidation(_marketId: string, outcomeIndices: number[]): Promise<SettlementQuote> {
    return { sharesAtomic: outcomeIndices.map(() => "1000000000000000000"), tokensOutAtomic: "2000000" };
  }

  async redeem(marketId: string): Promise<SettlementExecution> {
    this.redeemed.push(marketId);
    return { transactionHash: "0xredeemed", sharesAtomic: ["1000000000000000000"], tokensOutAtomic: "1000000" };
  }

  async liquidate(marketId: string, outcomeIndices: number[]): Promise<SettlementExecution> {
    this.liquidated.push({ marketId, outcomeIndices });
    return {
      transactionHash: "0xliquidated",
      sharesAtomic: outcomeIndices.map(() => "1000000000000000000"),
      tokensOutAtomic: "2000000",
    };
  }
}

test("dry-run quotes eligible exits without submitting transactions", async () => {
  const settled = "0x1000000000000000000000000000000000000001";
  const expired = "0x1000000000000000000000000000000000000002";
  const open = "0x1000000000000000000000000000000000000003";
  const gateway = new SettlementFixtureGateway(
    [position(settled), position(expired, 0), position(expired, 1), position(open)],
    {
      [settled]: { status: "settled", winningOutcomeIdx: 0 },
      [expired]: { status: "expired", winningOutcomeIdx: null },
      [open]: { status: "open", winningOutcomeIdx: null },
    },
  );
  const directory = await mkdtemp(join(tmpdir(), "settlement-edge-settle-"));
  const ledgerPath = join(directory, "ledger.jsonl");
  const results = await settlePortfolio(gateway, false, ledgerPath);

  assert.deepEqual(results.map(({ status, action, expectedTokensTst }) => ({ status, action, expectedTokensTst })), [
    { status: "settled", action: "redeem", expectedTokensTst: 1 },
    { status: "expired", action: "liquidate", expectedTokensTst: 2 },
    { status: "open", action: "skip", expectedTokensTst: undefined },
  ]);
  assert.deepEqual(gateway.redeemed, []);
  assert.deepEqual(gateway.liquidated, []);
  const entries = (await readFile(ledgerPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(entries.length, 3);
  assert.ok(entries.every((entry) => entry.record.type === "settlement_action"));
  assert.ok(entries.every((entry) => entry.record.transaction.status === "not_submitted"));
});

test("live mode redeems settled markets and liquidates failed markets", async () => {
  const settled = "0x1000000000000000000000000000000000000001";
  const failed = "0x1000000000000000000000000000000000000002";
  const gateway = new SettlementFixtureGateway(
    [position(settled), position(failed, 0), position(failed, 1)],
    {
      [settled]: { status: "settled", winningOutcomeIdx: 0 },
      [failed]: { status: "failed", winningOutcomeIdx: null },
    },
  );
  const directory = await mkdtemp(join(tmpdir(), "settlement-edge-settle-"));
  const results = await settlePortfolio(gateway, true, join(directory, "ledger.jsonl"));

  assert.deepEqual(gateway.redeemed, [settled]);
  assert.deepEqual(gateway.liquidated, [{ marketId: failed, outcomeIndices: [0, 1] }]);
  assert.deepEqual(results.map((result) => result.transaction), [
    { status: "submitted", transactionHash: "0xredeemed" },
    { status: "submitted", transactionHash: "0xliquidated" },
  ]);
});

test("one unavailable market fails closed without blocking other positions", async () => {
  const broken = "0x1000000000000000000000000000000000000001";
  const settled = "0x1000000000000000000000000000000000000002";
  const gateway = new SettlementFixtureGateway(
    [position(broken), position(settled)],
    {
      [broken]: new Error("rpc unavailable"),
      [settled]: { status: "settled", winningOutcomeIdx: 0 },
    },
  );
  const directory = await mkdtemp(join(tmpdir(), "settlement-edge-settle-"));
  const results = await settlePortfolio(gateway, false, join(directory, "ledger.jsonl"));

  assert.equal(results[0]?.status, "unavailable");
  assert.equal(results[0]?.action, "skip");
  assert.equal(results[1]?.action, "redeem");
});
