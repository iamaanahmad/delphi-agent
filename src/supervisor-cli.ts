import "dotenv/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COMPETITION_TRADING_CUTOFF } from "./competition.js";
import { DEFAULT_LEDGER_PATH } from "./receipt.js";
import { loadResolutionRules } from "./watcher.js";
import { runWatcherSupervisor, type SupervisorEvent } from "./supervisor.js";

const option = (args: string[], name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const positive = (name: string, value: string | undefined, fallback: number) => {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be positive`);
  return parsed;
};

function printEvent(event: SupervisorEvent) {
  if (event.type === "supervisor-started") console.log(`[${event.timestamp}] Supervisor started: ${event.reason}.`);
  if (event.type === "child-started") console.log(`[${event.timestamp}] Watcher child ${event.pid} started (restart ${event.restartNumber ?? 0}).`);
  if (event.type === "child-exited") console.log(`[${event.timestamp}] Watcher child ${event.pid} exited: code=${event.code ?? "none"} signal=${event.signal ?? "none"}${event.reason ? ` reason=${event.reason}` : ""}.`);
  if (event.type === "child-restart-scheduled") console.log(`[${event.timestamp}] Watcher recovery ${event.restartNumber} scheduled in ${event.delayMs}ms.`);
  if (event.type === "child-heartbeat-stale") console.error(`[${event.timestamp}] Watcher child ${event.pid} heartbeat stale: ${event.reason}.`);
  if (event.type === "supervisor-stopped") console.log(`[${event.timestamp}] Supervisor stopped: ${event.reason}.`);
}

async function main() {
  const args = process.argv.slice(2);
  const positional = args.filter((value, index) => !value.startsWith("--") && (index === 0 || !args[index - 1]?.startsWith("--")));
  const ruleFile = positional[0] ?? "config/resolution-rules.json";
  const cutoffText = option(args, "--cutoff") ?? positional[1] ?? process.env.SETTLEMENT_EDGE_WATCH_DEADLINE;
  if (!cutoffText || Number.isNaN(Date.parse(cutoffText))) throw new Error("supervise requires --cutoff <ISO timestamp> or SETTLEMENT_EDGE_WATCH_DEADLINE");
  const cutoff = new Date(cutoffText);
  if (cutoff > COMPETITION_TRADING_CUTOFF) throw new Error(`cutoff cannot exceed competition trading close ${COMPETITION_TRADING_CUTOFF.toISOString()}`);
  const rules = await loadResolutionRules(ruleFile);
  const configuredMarketIds = new Set(rules.map((rule) => rule.marketId.toLowerCase()));
  const ledgerPath = process.env.SETTLEMENT_EDGE_RECEIPT_PATH ?? DEFAULT_LEDGER_PATH;
  const heartbeatPath = process.env.SETTLEMENT_EDGE_WATCHER_HEARTBEAT_PATH ?? `${ledgerPath}.heartbeat.json`;
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const watcherCli = resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");
  const result = await runWatcherSupervisor({
    command: process.execPath,
    args: [watcherCli, "watch", ruleFile, "--interval-ms", process.env.SETTLEMENT_EDGE_POLL_INTERVAL_MS ?? "60000"],
    cwd: resolve("."),
    env: process.env,
    ledgerPath,
    heartbeatPath,
    configuredMarketIds,
    cutoff,
    restartDelayMs: positive("restart delay", process.env.SETTLEMENT_EDGE_SUPERVISOR_RESTART_DELAY_MS, 1_000),
    heartbeatTimeoutMs: positive("heartbeat timeout", process.env.SETTLEMENT_EDGE_SUPERVISOR_HEARTBEAT_TIMEOUT_MS, 30_000),
    monitorIntervalMs: positive("monitor interval", process.env.SETTLEMENT_EDGE_SUPERVISOR_MONITOR_INTERVAL_MS, 250),
    staleLockMs: positive("stale lock timeout", process.env.SETTLEMENT_EDGE_SUPERVISOR_STALE_LOCK_MS, 60_000),
    signal: controller.signal,
    onEvent: printEvent,
  });
  console.log(`Supervisor result: ${result.reason}; recovered ${result.restarts} child failure(s).`);
  if (result.reason === "monitor-failure") process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  console.error(`Settlement Edge supervisor stopped: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
