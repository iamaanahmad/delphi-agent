import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  Decision,
  MarketSettlementSnapshot,
  PositionSnapshot,
  ResolutionRule,
  RiskPolicy,
  WalletBalanceSnapshot,
  SettlementQuote,
} from "./types.js";

const previousHashes = new Map<string, string>();
export const DEFAULT_LEDGER_PATH = "artifacts/decision-receipts.jsonl";
export const DEFAULT_REPLAY_LEDGER_PATH = "artifacts/replay-receipts.jsonl";
export const serializeLedgerValue = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);

export type Availability<T> =
  | { available: true; value: T }
  | { available: false; reason: string };

export interface TransactionLedgerState {
  status: "not_submitted" | "submitted" | "ambiguous";
  transactionHash?: string;
  error?: string;
}

export interface DecisionLedgerRecord {
  type: "decision";
  opportunityId: string;
  terminal: true;
  market: Decision["market"];
  outcomeIdx: number;
  sources: Array<{
    id: string;
    name: string;
    url: string;
    publicationTime: Availability<string>;
    fetchTime: Availability<string>;
    probability: number;
    confidence: number;
    detail: string;
  }>;
  marketProbability: Availability<number>;
  estimate: Availability<NonNullable<Decision["estimate"]>>;
  quote: Availability<{
    shares: number;
    costTst: number;
    averagePrice: number;
  }>;
  impact: Availability<number>;
  riskDecision: {
    action: Decision["action"];
    reason: string;
    policy: RiskPolicy;
  };
  transaction: TransactionLedgerState;
  wallet: {
    before: Availability<WalletBalanceSnapshot>;
    after: Availability<WalletBalanceSnapshot>;
    changeTst: Availability<number>;
  };
}

export interface FailureLedgerRecord {
  type: "failure";
  opportunityId: string;
  terminal: true;
  stage: "market" | "source" | "schema" | "transaction";
  marketId: string;
  outcomeIdx: number;
  rules: ResolutionRule[];
  reason: string;
  marketProbability: Availability<number>;
  riskDecision: { action: "skip"; reason: string };
  transaction: TransactionLedgerState;
}

export interface ReconciliationLedgerRecord {
  type: "reconciliation";
  marketId: string;
  wallet: {
    current: Availability<WalletBalanceSnapshot>;
    changeTst: Availability<number>;
  };
  settlement: Availability<MarketSettlementSnapshot>;
  positions: Availability<PositionSnapshot[]>;
  redemption: Availability<{
    status: "redeemed" | "not_redeemed" | "no_position";
    tokensRedeemedTst: number;
  }>;
  costBasisTst: Availability<number>;
  realizedPnlTst: Availability<number>;
}

export interface SettlementActionLedgerRecord {
  type: "settlement_action";
  marketId: string;
  walletAddress: string;
  settlement: Availability<MarketSettlementSnapshot>;
  action: "redeem" | "liquidate" | "skip";
  outcomeIndices: number[];
  quote: Availability<SettlementQuote>;
  transaction: TransactionLedgerState;
  wallet: {
    before: Availability<WalletBalanceSnapshot>;
    after: Availability<WalletBalanceSnapshot>;
    changeTst: Availability<number>;
  };
}

export type TelemetryEnvironment = "live" | "dry_run" | "replay" | "test";

export const TELEMETRY_ENVIRONMENTS = ["live", "dry_run", "replay", "test"] as const satisfies readonly TelemetryEnvironment[];

export type TelemetryEventName =
  | "run_started"
  | "evidence_accepted"
  | "evidence_rejected"
  | "decision_made"
  | "quote_obtained"
  | "order_submitted"
  | "order_failed"
  | "settlement_observed"
  | "redemption_observed"
  | "realized_pnl_observed";

export const TELEMETRY_EVENT_NAMES = [
  "run_started",
  "evidence_accepted",
  "evidence_rejected",
  "decision_made",
  "quote_obtained",
  "order_submitted",
  "order_failed",
  "settlement_observed",
  "redemption_observed",
  "realized_pnl_observed",
] as const satisfies readonly TelemetryEventName[];

export interface TelemetryEventData {
  sourceId?: string;
  sourceCount?: number;
  stage?: FailureLedgerRecord["stage"];
  action?: Decision["action"];
  quoteCostTst?: number;
  quoteShares?: number;
  transactionStatus?: TransactionLedgerState["status"];
  settlementStatus?: MarketSettlementSnapshot["status"];
  redemptionStatus?: "redeemed" | "not_redeemed" | "no_position";
  tokensRedeemedTst?: number;
  realizedPnlTst?: number;
}

export interface TelemetryLedgerRecord {
  type: "telemetry";
  schemaVersion: 1;
  event: TelemetryEventName;
  runId: string;
  environment: TelemetryEnvironment;
  marketId?: string;
  opportunityId?: string;
  sourceRecordHash?: string;
  data: TelemetryEventData;
}

export type LedgerRecord = DecisionLedgerRecord | FailureLedgerRecord | ReconciliationLedgerRecord | SettlementActionLedgerRecord | TelemetryLedgerRecord;

export interface LedgerEnvelope {
  version: 2;
  timestamp: string;
  previousHash: string;
  record: LedgerRecord;
  hash: string;
}

async function getPreviousHash(path: string): Promise<string> {
  const cached = previousHashes.get(path);
  if (cached) return cached;
  try {
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    const last = lines.at(-1);
    if (!last) return "GENESIS";
    const parsed = JSON.parse(last) as { hash?: unknown };
    return typeof parsed.hash === "string" ? parsed.hash : "GENESIS";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "GENESIS";
    throw error;
  }
}

export async function appendLedgerRecord(record: LedgerRecord, path = DEFAULT_LEDGER_PATH, timestamp = new Date()) {
  const previousHash = await getPreviousHash(path);
  const body = {
    version: 2 as const,
    timestamp: timestamp.toISOString(),
    previousHash,
    record,
  };
  const hash = createHash("sha256").update(serializeLedgerValue(body)).digest("hex");
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${serializeLedgerValue({ ...body, hash })}\n`, "utf8");
  previousHashes.set(path, hash);
  return hash;
}

export async function readLedger(path = DEFAULT_LEDGER_PATH): Promise<Array<LedgerEnvelope | Record<string, unknown>>> {
  try {
    const content = (await readFile(path, "utf8")).trim();
    return content ? content.split("\n").map((line) => JSON.parse(line) as LedgerEnvelope | Record<string, unknown>) : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

// Compatibility entry point for callers that still produce the original v1 decision receipt.
export async function appendReceipt(decision: Decision, path = DEFAULT_LEDGER_PATH) {
  const previousHash = await getPreviousHash(path);
  const body = { version: 1, timestamp: new Date().toISOString(), previousHash, decision };
  const hash = createHash("sha256").update(serializeLedgerValue(body)).digest("hex");
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${serializeLedgerValue({ ...body, hash })}\n`, "utf8");
  previousHashes.set(path, hash);
  return hash;
}

export const available = <T>(value: T): Availability<T> => ({ available: true, value });
export const unavailable = <T>(reason: string): Availability<T> => ({ available: false, reason });

export function walletChange(before: Availability<WalletBalanceSnapshot>, after: Availability<WalletBalanceSnapshot>): Availability<number> {
  if (!before.available) return unavailable(before.reason);
  if (!after.available) return unavailable(after.reason);
  if (before.value.collateralDecimals !== after.value.collateralDecimals) return unavailable("wallet balance decimals changed");
  const scale = 10 ** before.value.collateralDecimals;
  return available(Number(BigInt(after.value.collateralAtomic) - BigInt(before.value.collateralAtomic)) / scale);
}
