import {
  appendLedgerRecord,
  available,
  unavailable,
  walletChange,
  type Availability,
  type SettlementActionLedgerRecord,
  type TransactionLedgerState,
} from "./receipt.js";
import type {
  MarketSettlementSnapshot,
  PortfolioPositionSnapshot,
  SettlementGateway,
  SettlementQuote,
  WalletBalanceSnapshot,
} from "./types.js";

export interface SettlementResult {
  marketId: string;
  status: MarketSettlementSnapshot["status"] | "unavailable";
  action: SettlementActionLedgerRecord["action"];
  outcomeIndices: number[];
  expectedTokensTst?: number;
  transaction: TransactionLedgerState;
  reason?: string;
}

const positivePosition = (position: PortfolioPositionSnapshot) =>
  !position.redeemedOrLiquidated && BigInt(position.sharesAtomic) > 0n;

const tst = (atomic: string, decimals: number) => Number(BigInt(atomic)) / 10 ** decimals;

async function snapshot(gateway: SettlementGateway): Promise<Availability<WalletBalanceSnapshot>> {
  try {
    return available(await gateway.getWalletSnapshot());
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
}

export async function settlePortfolio(
  gateway: SettlementGateway,
  execute: boolean,
  ledgerPath?: string,
): Promise<SettlementResult[]> {
  const initialWallet = await gateway.getWalletSnapshot();
  const positions = (await gateway.listPortfolioPositions(initialWallet.address)).filter(positivePosition);
  const grouped = new Map<string, PortfolioPositionSnapshot[]>();
  for (const position of positions) {
    grouped.set(position.marketId, [...(grouped.get(position.marketId) ?? []), position]);
  }

  const results: SettlementResult[] = [];
  for (const [marketId, marketPositions] of grouped) {
    const outcomeIndices = [...new Set(marketPositions.map((position) => position.outcomeIdx))].sort((a, b) => a - b);
    const before = await snapshot(gateway);
    let settlement: Availability<MarketSettlementSnapshot>;
    try {
      settlement = available(await gateway.getMarketSettlement(marketId));
    } catch (error) {
      settlement = unavailable(error instanceof Error ? error.message : String(error));
    }
    let action: SettlementActionLedgerRecord["action"] = "skip";
    let quote: Availability<SettlementQuote> = unavailable(settlement.available ? `market is ${settlement.value.status}` : settlement.reason);
    let transaction: TransactionLedgerState = { status: "not_submitted" };
    let after: Availability<WalletBalanceSnapshot> = unavailable("no settlement transaction submitted");
    let reason = settlement.available ? `market is ${settlement.value.status}` : `settlement unavailable: ${settlement.reason}`;

    if (settlement.available && settlement.value.status === "settled") action = "redeem";
    if (settlement.available && (settlement.value.status === "expired" || settlement.value.status === "failed")) action = "liquidate";

    if (action !== "skip") {
      try {
        quote = available(action === "redeem"
          ? await gateway.quoteRedemption(marketId, initialWallet.address)
          : await gateway.quoteLiquidation(marketId, outcomeIndices, initialWallet.address));
        reason = execute ? "settlement transaction eligible" : "dry-run only";
      } catch (error) {
        reason = `quote unavailable: ${error instanceof Error ? error.message : String(error)}`;
        quote = unavailable(reason);
        action = "skip";
      }
    }

    if (quote.available && BigInt(quote.value.tokensOutAtomic) === 0n) {
      action = "skip";
      reason = "quote returned zero collateral";
    } else if (execute && action !== "skip" && quote.available) {
      try {
        const execution = action === "redeem"
          ? await gateway.redeem(marketId)
          : await gateway.liquidate(marketId, outcomeIndices);
        transaction = { status: "submitted", transactionHash: execution.transactionHash };
        after = await snapshot(gateway);
        reason = `${action} submitted`;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        transaction = { status: "ambiguous", error: message };
        after = await snapshot(gateway);
        reason = `${action} result ambiguous: ${message}`;
      }
    }

    const record: SettlementActionLedgerRecord = {
      type: "settlement_action",
      marketId,
      walletAddress: initialWallet.address,
      settlement,
      action,
      outcomeIndices,
      quote,
      transaction,
      wallet: { before, after, changeTst: walletChange(before, after) },
    };
    await appendLedgerRecord(record, ledgerPath);
    results.push({
      marketId,
      status: settlement.available ? settlement.value.status : "unavailable",
      action,
      outcomeIndices,
      expectedTokensTst: quote.available ? tst(quote.value.tokensOutAtomic, initialWallet.collateralDecimals) : undefined,
      transaction,
      reason,
    });
  }
  return results;
}
