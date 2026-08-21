import "dotenv/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { COMPETITION_TRADING_CUTOFF } from "./competition.js";
import { DEFAULT_LEDGER_PATH } from "./receipt.js";
import { runSupervisorService, type SupervisorServiceEvent } from "./service-manager.js";

const option = (args: string[], name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const positive = (name: string, value: string | undefined, fallback: number) => {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be positive`);
  return parsed;
};

function printEvent(event: SupervisorServiceEvent) {
  if (event.type === "service-started") console.log(`[${event.timestamp}] Supervisor service started: ${event.reason}.`);
  if (event.type === "supervisor-started") console.log(`[${event.timestamp}] Supervisor process ${event.pid} started (restart ${event.restartNumber ?? 0}).`);
  if (event.type === "supervisor-exited") console.log(`[${event.timestamp}] Supervisor process ${event.pid} exited: code=${event.code ?? "none"} signal=${event.signal ?? "none"}.`);
  if (event.type === "orphan-watcher-stopped") console.log(`[${event.timestamp}] Orphan watcher process group ${event.pid} stopped: ${event.reason}.`);
  if (event.type === "supervisor-restart-scheduled") console.log(`[${event.timestamp}] Supervisor recovery ${event.restartNumber} scheduled in ${event.delayMs}ms.`);
  if (event.type === "service-shutdown-started") console.log(`[${event.timestamp}] Supervisor service shutdown started: ${event.reason}.`);
  if (event.type === "service-stopped") console.log(`[${event.timestamp}] Supervisor service stopped: ${event.reason}.`);
}

async function main() {
  const args = process.argv.slice(2);
  const positional = args.filter((value, index) => !value.startsWith("--") && (index === 0 || !args[index - 1]?.startsWith("--")));
  const ruleFile = positional[0] ?? "config/resolution-rules.json";
  const cutoffText = option(args, "--cutoff") ?? positional[1] ?? process.env.SETTLEMENT_EDGE_WATCH_DEADLINE;
  if (!cutoffText || Number.isNaN(Date.parse(cutoffText))) throw new Error("service requires --cutoff <ISO timestamp> or SETTLEMENT_EDGE_WATCH_DEADLINE");
  const cutoff = new Date(cutoffText);
  if (cutoff > COMPETITION_TRADING_CUTOFF) throw new Error(`cutoff cannot exceed competition trading close ${COMPETITION_TRADING_CUTOFF.toISOString()}`);
  const ledgerPath = process.env.SETTLEMENT_EDGE_RECEIPT_PATH ?? DEFAULT_LEDGER_PATH;
  const heartbeatPath = process.env.SETTLEMENT_EDGE_WATCHER_HEARTBEAT_PATH ?? `${ledgerPath}.heartbeat.json`;
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const supervisorCli = resolve(dirname(fileURLToPath(import.meta.url)), "supervisor-cli.js");
  const result = await runSupervisorService({
    command: process.execPath,
    args: [supervisorCli, ruleFile, "--cutoff", cutoff.toISOString()],
    cwd: resolve("."),
    env: process.env,
    ledgerPath,
    heartbeatPath,
    cutoff,
    restartDelayMs: positive("service restart delay", process.env.SETTLEMENT_EDGE_SERVICE_RESTART_DELAY_MS, 1_000),
    staleLockMs: positive("stale lock timeout", process.env.SETTLEMENT_EDGE_SERVICE_STALE_LOCK_MS, 3_000),
    stopGraceMs: positive("service stop grace period", process.env.SETTLEMENT_EDGE_SERVICE_STOP_GRACE_MS, 2_000),
    signal: controller.signal,
    onEvent: printEvent,
  });
  console.log(`Supervisor service result: ${result.reason}; recovered ${result.restarts} supervisor failure(s).`);
}

try {
  await main();
} catch (error) {
  console.error(`Settlement Edge supervisor service stopped: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
