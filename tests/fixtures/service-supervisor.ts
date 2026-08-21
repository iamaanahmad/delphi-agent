import { spawn, type ChildProcess } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { acquireLedgerWriterLease } from "../../src/ledger-lock.js";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`service supervisor fixture requires ${name}`);
  return value;
};
const ledgerPath = required("SERVICE_FIXTURE_LEDGER");
const heartbeatPath = required("SETTLEMENT_EDGE_WATCHER_HEARTBEAT_PATH");
const counterPath = required("SUPERVISOR_FIXTURE_COUNTER");
const eventPath = required("SUPERVISOR_FIXTURE_EVENTS");

const staleLockMs = Number(process.env.SETTLEMENT_EDGE_SUPERVISOR_STALE_LOCK_MS ?? 3_000);
const lease = await acquireLedgerWriterLease(ledgerPath, { staleAfterMs: staleLockMs });
let watcher: ChildProcess | undefined;
let stopping = false;
let leaseTimer: NodeJS.Timeout | undefined;

async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  if (leaseTimer) clearInterval(leaseTimer);
  if (watcher?.pid) {
    try {
      process.kill(-watcher.pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    await new Promise<void>((resolveExit) => watcher?.once("exit", () => resolveExit()));
  }
  await lease.release();
  await appendFile(eventPath, `${JSON.stringify({ type: "fixture-supervisor-stopped", pid: process.pid, signal, timestamp: new Date().toISOString() })}\n`, "utf8");
  process.exit(0);
}

if (process.env.SERVICE_FIXTURE_IGNORE_SIGTERM === "true") process.on("SIGTERM", () => {});
else process.once("SIGTERM", () => void stop("SIGTERM"));
process.once("SIGINT", () => void stop("SIGINT"));

watcher = spawn(process.execPath, [resolve("tests/fixtures/supervisor-child.mjs")], {
  cwd: resolve("."),
  env: {
    ...process.env,
    SETTLEMENT_EDGE_LEDGER_WRITER_TOKEN: lease.token,
    SETTLEMENT_EDGE_WATCHER_HEARTBEAT_PATH: heartbeatPath,
  },
  stdio: ["ignore", "ignore", "ignore"],
  detached: true,
});
if (!watcher.pid) throw new Error("service supervisor fixture could not obtain watcher PID");
await appendFile(eventPath, `${JSON.stringify({
  type: "fixture-supervisor-started",
  pid: process.pid,
  watcherPid: watcher.pid,
  liveSwitches: [process.env.ALLOW_LIVE_TRADING, process.env.SETTLEMENT_EDGE_EXECUTE],
  timestamp: new Date().toISOString(),
})}\n`, "utf8");
leaseTimer = setInterval(() => void lease.heartbeat(), 25);
