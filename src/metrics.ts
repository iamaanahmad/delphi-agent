import { createHash } from "node:crypto";
import {
  readLedger,
  serializeLedgerValue,
  TELEMETRY_ENVIRONMENTS,
  TELEMETRY_EVENT_NAMES,
  type LedgerEnvelope,
  type TelemetryEventData,
  type TelemetryLedgerRecord,
} from "./receipt.js";

export const METRIC_EVENT_PREFIX = "settlement_edge";

export interface MetricsConfig {
  enabled: boolean;
  publicKey?: string;
  host?: string;
}

export interface TelemetryPoint {
  hash: string;
  timestamp: string;
  record: TelemetryLedgerRecord;
}

export function loadMetricsConfig(env: NodeJS.ProcessEnv = process.env): MetricsConfig {
  return {
    enabled: env.SETTLEMENT_EDGE_METRICS_ENABLED === "true",
    publicKey: env.SETTLEMENT_EDGE_POSTHOG_KEY,
    host: env.SETTLEMENT_EDGE_POSTHOG_HOST,
  };
}

function requireConfig(config: MetricsConfig): { publicKey: string; host: string } {
  if (!config.enabled) throw new Error("metrics export is disabled; set SETTLEMENT_EDGE_METRICS_ENABLED=true");
  if (!config.publicKey) throw new Error("SETTLEMENT_EDGE_POSTHOG_KEY is required when metrics export is enabled");
  if (!config.host) throw new Error("SETTLEMENT_EDGE_POSTHOG_HOST is required when metrics export is enabled");
  const host = new URL(config.host);
  if (host.protocol !== "https:") throw new Error("SETTLEMENT_EDGE_POSTHOG_HOST must use HTTPS");
  return { publicKey: config.publicKey, host: host.toString().replace(/\/$/, "") };
}

function isTelemetryRecord(value: unknown): value is TelemetryLedgerRecord {
  const candidate = value as { type?: unknown; schemaVersion?: unknown; event?: unknown; environment?: unknown; runId?: unknown; data?: unknown };
  return Boolean(
    value
    && typeof value === "object"
    && candidate.type === "telemetry"
    && candidate.schemaVersion === 1
    && typeof candidate.event === "string"
    && TELEMETRY_EVENT_NAMES.includes(candidate.event as TelemetryLedgerRecord["event"])
    && typeof candidate.environment === "string"
    && TELEMETRY_ENVIRONMENTS.includes(candidate.environment as TelemetryLedgerRecord["environment"])
    && typeof candidate.runId === "string"
    && candidate.runId.length > 0
    && candidate.runId.length <= 128
    && candidate.data !== null
    && typeof candidate.data === "object",
  );
}

function verifiedEnvelope(envelope: LedgerEnvelope | Record<string, unknown>, expectedPreviousHash: string): LedgerEnvelope {
  const version = envelope.version;
  const timestamp = envelope.timestamp;
  const previousHash = envelope.previousHash;
  const hash = envelope.hash;
  if ((version !== 1 && version !== 2) || typeof timestamp !== "string" || typeof previousHash !== "string" || typeof hash !== "string") {
    throw new Error("ledger contains an unsupported envelope");
  }
  if (previousHash !== expectedPreviousHash) throw new Error("ledger hash chain is broken");
  const raw = envelope as Record<string, unknown>;
  const body = version === 2
    ? { version, timestamp, previousHash, record: raw.record }
    : { version, timestamp, previousHash, decision: raw.decision };
  const computed = createHash("sha256").update(serializeLedgerValue(body)).digest("hex");
  if (computed !== hash) throw new Error("ledger record hash does not match its contents");
  return envelope as unknown as LedgerEnvelope;
}

export async function readTelemetryPoints(ledgerPath?: string): Promise<TelemetryPoint[]> {
  const envelopes = await readLedger(ledgerPath);
  const points: TelemetryPoint[] = [];
  let expectedPreviousHash = "GENESIS";
  for (const rawEnvelope of envelopes) {
    const envelope = verifiedEnvelope(rawEnvelope, expectedPreviousHash);
    expectedPreviousHash = envelope.hash;
    if (envelope.version === 2 && (envelope.record as { type?: unknown }).type === "telemetry") {
      if (!isTelemetryRecord(envelope.record)) throw new Error("ledger contains an unsupported telemetry record");
      points.push({ hash: envelope.hash, timestamp: envelope.timestamp, record: envelope.record });
    }
  }
  return points;
}

function remoteEventName(record: TelemetryLedgerRecord): string {
  const environmentPrefix = record.environment === "live"
    ? METRIC_EVENT_PREFIX
    : `${METRIC_EVENT_PREFIX}_${record.environment}`;
  return `${environmentPrefix}_${record.event}`;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function allowedData(data: TelemetryEventData): TelemetryEventData {
  return {
    sourceCount: finite(data.sourceCount),
    stage: ["market", "source", "schema", "transaction"].includes(String(data.stage)) ? data.stage : undefined,
    action: ["buy", "skip"].includes(String(data.action)) ? data.action : undefined,
    quoteCostTst: finite(data.quoteCostTst),
    quoteShares: finite(data.quoteShares),
    transactionStatus: ["not_submitted", "submitted", "ambiguous"].includes(String(data.transactionStatus)) ? data.transactionStatus : undefined,
    settlementStatus: ["open", "awaiting_settlement", "settled", "expired", "failed"].includes(String(data.settlementStatus)) ? data.settlementStatus : undefined,
    redemptionStatus: ["redeemed", "not_redeemed", "no_position"].includes(String(data.redemptionStatus)) ? data.redemptionStatus : undefined,
    tokensRedeemedTst: finite(data.tokensRedeemedTst),
    realizedPnlTst: finite(data.realizedPnlTst),
  };
}

function captureEvent(point: TelemetryPoint) {
  const { record } = point;
  const bounded = (value: string | undefined) => value?.slice(0, 128);
  return {
    event: remoteEventName(record),
    timestamp: point.timestamp,
    properties: {
      distinct_id: "settlement-edge-cli",
      $insert_id: point.hash,
      environment: record.environment,
      schema_version: record.schemaVersion,
      run_id: bounded(record.runId),
      market_id: bounded(record.marketId),
      opportunity_id: bounded(record.opportunityId),
      source_record_hash: bounded(record.sourceRecordHash),
      ...allowedData(record.data),
    },
  };
}

export async function captureTelemetryPoints(
  points: TelemetryPoint[],
  config = loadMetricsConfig(),
  fetcher: typeof fetch = fetch,
): Promise<number> {
  if (points.length === 0) return 0;
  const { publicKey, host } = requireConfig(config);
  const response = await fetcher(`${host}/batch/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: publicKey, batch: points.map(captureEvent) }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`metrics ingestion failed with HTTP ${response.status}`);
  return points.length;
}

export async function syncLedgerTelemetry(
  ledgerPath: string | undefined,
  environments: TelemetryLedgerRecord["environment"][] = ["live"],
  config = loadMetricsConfig(),
  fetcher: typeof fetch = fetch,
): Promise<number> {
  const allowed = new Set(environments);
  const points = (await readTelemetryPoints(ledgerPath)).filter((point) => allowed.has(point.record.environment));
  return captureTelemetryPoints(points, config, fetcher);
}
