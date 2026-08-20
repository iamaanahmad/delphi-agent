import type { TransactionLedgerState } from "./receipt.js";

export function guardedTransactionStatus(
  line: string,
  configuredMarketIds: ReadonlySet<string>,
): TransactionLedgerState["status"] | undefined {
  const envelope = JSON.parse(line) as {
    record?: {
      type?: string;
      marketId?: string;
      market?: { id?: string };
      transaction?: { status?: string };
    };
  };
  const record = envelope.record;
  if (!record || record.type === "telemetry") return undefined;
  const marketId = record.marketId ?? record.market?.id;
  if (!marketId || !configuredMarketIds.has(marketId.toLowerCase())) return undefined;
  return record.transaction?.status === "submitted" || record.transaction?.status === "ambiguous"
    ? record.transaction.status
    : undefined;
}
