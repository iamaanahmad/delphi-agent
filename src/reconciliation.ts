import {
  appendLedgerRecord,
  available,
  readLedger,
  unavailable,
  type Availability,
  type DecisionLedgerRecord,
  type ReconciliationLedgerRecord,
} from "./receipt.js";
import type {
  MarketSettlementSnapshot,
  PositionSnapshot,
  ReconciliationGateway,
  WalletBalanceSnapshot,
} from "./types.js";

async function readField<T>(reader: (() => Promise<T>) | undefined, unsupportedReason: string): Promise<Availability<T>> {
  if (!reader) return unavailable(unsupportedReason);
  try {
    return available(await reader());
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
}

function isDecisionRecord(value: unknown): value is DecisionLedgerRecord {
  return Boolean(value && typeof value === "object" && (value as { type?: unknown }).type === "decision");
}

function atomicToTst(value: string, decimals: number): number {
  return Number(BigInt(value)) / (10 ** decimals);
}

function sumSubmittedCost(records: DecisionLedgerRecord[], marketId: string): Availability<number> {
  const matching = records.filter((record) =>
    record.market.id.toLowerCase() === marketId.toLowerCase()
    && record.transaction.status === "submitted",
  );
  if (matching.length === 0) return unavailable("no submitted trade exists in this ledger");
  let total = 0;
  for (const record of matching) {
    if (!record.wallet.before.available || !record.wallet.after.available) {
      return unavailable("a submitted trade is missing before-and-after wallet balances");
    }
    if (record.wallet.before.value.collateralDecimals !== record.wallet.after.value.collateralDecimals) {
      return unavailable("wallet balance decimals changed during a submitted trade");
    }
    const spentAtomic = BigInt(record.wallet.before.value.collateralAtomic) - BigInt(record.wallet.after.value.collateralAtomic);
    if (spentAtomic < 0n) return unavailable("wallet balance increased during a submitted trade, so cost basis is ambiguous");
    total += atomicToTst(spentAtomic.toString(), record.wallet.before.value.collateralDecimals);
  }
  return available(total);
}

function firstWalletBefore(records: DecisionLedgerRecord[], marketId: string): Availability<WalletBalanceSnapshot> {
  const record = records.find((candidate) =>
    candidate.market.id.toLowerCase() === marketId.toLowerCase()
    && candidate.transaction.status === "submitted"
    && candidate.wallet.before.available,
  );
  return record?.wallet.before ?? unavailable("no pre-trade wallet balance exists in this ledger");
}

function redemptionState(
  positions: Availability<PositionSnapshot[]>,
  wallet: Availability<WalletBalanceSnapshot>,
): ReconciliationLedgerRecord["redemption"] {
  if (!positions.available) return unavailable(positions.reason);
  if (!wallet.available) return unavailable("collateral decimals are unavailable");
  if (positions.value.length === 0) return available({ status: "no_position", tokensRedeemedTst: 0 });
  const redeemed = positions.value.filter((position) => position.redeemedOrLiquidated);
  const tokensRedeemedTst = redeemed.reduce(
    (total, position) => total + atomicToTst(position.tokensRedeemedAtomic, wallet.value.collateralDecimals),
    0,
  );
  return available({
    status: redeemed.length === positions.value.length ? "redeemed" : "not_redeemed",
    tokensRedeemedTst,
  });
}

function reconciledWalletChange(
  before: Availability<WalletBalanceSnapshot>,
  current: Availability<WalletBalanceSnapshot>,
): Availability<number> {
  if (!before.available) return unavailable(before.reason);
  if (!current.available) return unavailable(current.reason);
  if (before.value.collateralDecimals !== current.value.collateralDecimals) return unavailable("wallet balance decimals changed");
  return available(atomicToTst(
    (BigInt(current.value.collateralAtomic) - BigInt(before.value.collateralAtomic)).toString(),
    before.value.collateralDecimals,
  ));
}

export async function reconcileMarket(
  gateway: ReconciliationGateway,
  marketId: string,
  ledgerPath?: string,
): Promise<ReconciliationLedgerRecord> {
  const envelopes = await readLedger(ledgerPath);
  const decisions = envelopes.flatMap((envelope) => {
    const record = (envelope as { version?: unknown; record?: unknown }).version === 2
      ? (envelope as { record?: unknown }).record
      : undefined;
    return isDecisionRecord(record) ? [record] : [];
  });
  const wallet = await readField(
    gateway.getWalletSnapshot ? () => gateway.getWalletSnapshot!() : undefined,
    "SDK adapter does not expose wallet balances",
  );
  const settlement: Availability<MarketSettlementSnapshot> = await readField(
    gateway.getMarketSettlement ? () => gateway.getMarketSettlement!(marketId) : undefined,
    "SDK adapter does not expose settlement state",
  );
  const positions: Availability<PositionSnapshot[]> = wallet.available
    ? await readField(
      gateway.listWalletPositions ? () => gateway.listWalletPositions!(marketId, wallet.value.address) : undefined,
      "SDK adapter does not expose wallet positions",
    )
    : unavailable("wallet address is unavailable, so positions cannot be queried");
  const costBasisTst = sumSubmittedCost(decisions, marketId);
  const redemption = redemptionState(positions, wallet);
  const before = firstWalletBefore(decisions, marketId);
  const changeTst = reconciledWalletChange(before, wallet);
  const realizedPnlTst: Availability<number> = redemption.available && redemption.value.status === "redeemed" && costBasisTst.available
    ? available(redemption.value.tokensRedeemedTst - costBasisTst.value)
    : unavailable(
      !redemption.available
        ? redemption.reason
        : redemption.value.status !== "redeemed"
          ? "position has not been redeemed"
          : costBasisTst.available ? "realized P&L is unavailable" : costBasisTst.reason,
    );
  const record: ReconciliationLedgerRecord = {
    type: "reconciliation",
    marketId,
    wallet: { current: wallet, changeTst },
    settlement,
    positions,
    redemption,
    costBasisTst,
    realizedPnlTst,
  };
  await appendLedgerRecord(record, ledgerPath);
  return record;
}
