import "dotenv/config";
import { spawn } from "node:child_process";
import { open, readFile, stat } from "node:fs/promises";
import { guardedTransactionStatus } from "../src/watch-guard.ts";

const ruleFile = process.argv[2] ?? "config/resolution-rules.json";
const deadlineText = process.argv[3] ?? process.env.SETTLEMENT_EDGE_WATCH_DEADLINE;
if (!deadlineText || Number.isNaN(Date.parse(deadlineText))) {
  throw new Error("guarded watch requires an ISO deadline argument or SETTLEMENT_EDGE_WATCH_DEADLINE");
}
const deadline = Date.parse(deadlineText);
if (Date.now() >= deadline) throw new Error("guarded watch deadline has already passed");

const rules = JSON.parse(await readFile(ruleFile, "utf8"));
const configuredMarketIds = new Set(rules.map((rule) => String(rule.marketId).toLowerCase()));
if (configuredMarketIds.size === 0) throw new Error("guarded watch requires at least one configured market");

const ledgerPath = process.env.SETTLEMENT_EDGE_RECEIPT_PATH ?? "artifacts/decision-receipts.jsonl";
let offset = (await stat(ledgerPath).catch(() => ({ size: 0 }))).size;
let remainder = "";
let stopping = false;

const child = spawn(
  "npm",
  ["run", "watch", "--", ruleFile, "--interval-ms", process.env.SETTLEMENT_EDGE_POLL_INTERVAL_MS ?? "60000"],
  { cwd: process.cwd(), env: process.env, stdio: ["ignore", "inherit", "inherit"], detached: true },
);

function stop(reason) {
  if (stopping) return;
  stopping = true;
  console.log(`Guard stopping watcher: ${reason}`);
  clearInterval(monitor);
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }, 30_000).unref();
}

async function inspectLedger() {
  if (Date.now() >= deadline) {
    stop("configured cutoff reached");
    return;
  }
  const size = (await stat(ledgerPath).catch(() => ({ size: offset }))).size;
  if (size <= offset) return;
  const handle = await open(ledgerPath, "r");
  try {
    const buffer = Buffer.alloc(size - offset);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    offset += bytesRead;
    const lines = `${remainder}${buffer.subarray(0, bytesRead).toString("utf8")}`.split("\n");
    remainder = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      const status = guardedTransactionStatus(line, configuredMarketIds);
      if (status) {
        stop(`first configured-market order result is ${status}`);
        return;
      }
    }
  } finally {
    await handle.close();
  }
}

const monitor = setInterval(() => {
  inspectLedger().catch((error) => {
    console.error(`Guard failed closed: ${error instanceof Error ? error.message : String(error)}`);
    stop("ledger monitor failed");
  });
}, 250);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => stop(`${signal} received`));
}

child.once("exit", (code, signal) => {
  clearInterval(monitor);
  console.log(`Guarded watcher exited: code=${code ?? "none"} signal=${signal ?? "none"}`);
  process.exitCode = code ?? (signal ? 1 : 0);
});

console.log(`Guard active until ${new Date(deadline).toISOString()} for ${configuredMarketIds.size} configured market(s); ledger ${ledgerPath}.`);
