import "dotenv/config";
import { COMPETITION_TRADING_CUTOFF } from "./competition.js";
import { DelphiGateway } from "./gateway.js";
import {
  DEFAULT_SENTINEL_POLL_INTERVAL_MS,
  DEFAULT_SENTINEL_RECEIPT_PATH,
  DEFAULT_SENTINEL_STATE_PATH,
  runMarketSentinel,
  type SentinelEvent,
} from "./market-sentinel.js";

const option = (args: string[], name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const positive = (name: string, value: string | undefined, fallback: number) => {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be positive`);
  return parsed;
};

function printEvent(event: SentinelEvent) {
  const timestamp = new Date().toISOString();
  if (event.type === "baseline_captured") {
    console.log(`[${timestamp}] Baseline captured: ${event.markets.length} open market(s), IDs=${event.markets.map((market) => market.id).join(",") || "none"}.`);
  }
  if (event.type === "candidate_review") console.log(`[${timestamp}] Candidate ${event.market.id} rejected: ${event.reason}.`);
  if (event.type === "poll_failed") console.error(`[${timestamp}] Sentinel poll failed closed: ${event.reason}.`);
  if (event.type === "sentinel_stopped") console.log(`[${timestamp}] Sentinel stopped: ${event.reason}.`);
}

async function main() {
  const args = process.argv.slice(2);
  if (process.env.ALLOW_LIVE_TRADING === "true" || process.env.SETTLEMENT_EDGE_EXECUTE === "true") {
    throw new Error("read-only sentinel requires ALLOW_LIVE_TRADING=false and SETTLEMENT_EDGE_EXECUTE=false");
  }
  const cutoffText = option(args, "--cutoff") ?? process.env.SETTLEMENT_EDGE_SENTINEL_CUTOFF ?? COMPETITION_TRADING_CUTOFF.toISOString();
  if (Number.isNaN(Date.parse(cutoffText))) throw new Error("sentinel cutoff must be an ISO timestamp");
  const cutoff = new Date(cutoffText);
  if (cutoff > COMPETITION_TRADING_CUTOFF) {
    throw new Error(`sentinel cutoff cannot exceed competition trading close ${COMPETITION_TRADING_CUTOFF.toISOString()}`);
  }
  const intervalMs = positive("sentinel poll interval", option(args, "--interval-ms") ?? process.env.SETTLEMENT_EDGE_SENTINEL_INTERVAL_MS, DEFAULT_SENTINEL_POLL_INTERVAL_MS);
  const statePath = option(args, "--state") ?? process.env.SETTLEMENT_EDGE_SENTINEL_STATE_PATH ?? DEFAULT_SENTINEL_STATE_PATH;
  const receiptPath = option(args, "--receipts") ?? process.env.SETTLEMENT_EDGE_SENTINEL_RECEIPT_PATH ?? DEFAULT_SENTINEL_RECEIPT_PATH;
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  console.log(`Read-only market sentinel starting; interval=${intervalMs}ms cutoff=${cutoff.toISOString()} state=${statePath} receipts=${receiptPath}.`);
  const result = await runMarketSentinel({
    gateway: new DelphiGateway(),
    cutoff,
    intervalMs,
    statePath,
    receiptPath,
    once: args.includes("--once"),
    signal: controller.signal,
    onEvent: printEvent,
  });
  console.log(`Read-only market sentinel result: ${result}.`);
}

try {
  await main();
} catch (error) {
  console.error(`Settlement Edge market sentinel stopped: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
