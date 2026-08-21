import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const counterPath = process.env.SUPERVISOR_FIXTURE_COUNTER;
const eventPath = process.env.SUPERVISOR_FIXTURE_EVENTS;
const heartbeatPath = process.env.SETTLEMENT_EDGE_WATCHER_HEARTBEAT_PATH;
const token = process.env.SETTLEMENT_EDGE_LEDGER_WRITER_TOKEN;
if (!counterPath || !eventPath || !heartbeatPath || !token) throw new Error("supervisor fixture environment is incomplete");

let count = 0;
try {
  count = Number(await readFile(counterPath, "utf8"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
count += 1;
await mkdir(dirname(counterPath), { recursive: true });
await writeFile(counterPath, String(count), "utf8");
await appendFile(eventPath, `${JSON.stringify({ type: "started", count, pid: process.pid, timestamp: new Date().toISOString() })}\n`, "utf8");

let heartbeatPending = Promise.resolve();
function heartbeat(status, reason) {
  heartbeatPending = heartbeatPending.then(async () => {
    const temporary = `${heartbeatPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({
      version: 1,
      token,
      pid: process.pid,
      status,
      timestamp: new Date().toISOString(),
      ...(reason ? { reason } : {}),
    })}\n`, "utf8");
    await rename(temporary, heartbeatPath);
  });
  return heartbeatPending;
}

await heartbeat("running");
const timer = setInterval(() => void heartbeat("running"), 25);
const keepalive = setInterval(() => {}, 1_000);

async function stop(signal) {
  clearInterval(timer);
  clearInterval(keepalive);
  await heartbeat("stopped", signal);
  await appendFile(eventPath, `${JSON.stringify({ type: "stopped", count, pid: process.pid, signal, timestamp: new Date().toISOString() })}\n`, "utf8");
  process.exit(0);
}

process.once("SIGTERM", () => void stop("SIGTERM"));
process.once("SIGINT", () => void stop("SIGINT"));

if (count === 1 && process.env.SUPERVISOR_FIXTURE_EXIT_ONCE === "true") {
  setTimeout(async () => {
    clearInterval(timer);
    clearInterval(keepalive);
    await appendFile(eventPath, `${JSON.stringify({ type: "forced-exit", count, pid: process.pid, timestamp: new Date().toISOString() })}\n`, "utf8");
    process.exit(23);
  }, 100);
}

if (count === 1 && process.env.SUPERVISOR_FIXTURE_STALE_ONCE === "true") {
  setTimeout(async () => {
    clearInterval(timer);
    await appendFile(eventPath, `${JSON.stringify({ type: "heartbeat-paused", count, pid: process.pid, timestamp: new Date().toISOString() })}\n`, "utf8");
  }, 75);
}
