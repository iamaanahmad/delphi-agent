import { spawn, type ChildProcess } from "node:child_process";
import { open, readFile, stat } from "node:fs/promises";
import { assertLedgerWriterAuthorized, acquireLedgerWriterLease, LEDGER_WRITER_TOKEN_ENV } from "./ledger-lock.js";
import { writeWatcherHeartbeat, type WatcherHeartbeat } from "./heartbeat.js";
import { guardedTransactionStatus } from "./watch-guard.js";

export type SupervisorStopReason = "cutoff" | "configured-market-order" | "signal" | "monitor-failure";

export interface SupervisorEvent {
  type: "supervisor-started" | "child-started" | "child-exited" | "child-restart-scheduled" | "child-heartbeat-stale" | "supervisor-stopped";
  timestamp: string;
  pid?: number;
  code?: number | null;
  signal?: NodeJS.Signals | null;
  restartNumber?: number;
  delayMs?: number;
  reason?: string;
}

export interface WatcherSupervisorOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  ledgerPath: string;
  heartbeatPath: string;
  configuredMarketIds: Set<string>;
  cutoff: Date;
  restartDelayMs?: number;
  heartbeatTimeoutMs?: number;
  monitorIntervalMs?: number;
  lockHeartbeatIntervalMs?: number;
  staleLockMs?: number;
  stopGraceMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: SupervisorEvent) => void;
}

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function positive(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}

function terminateChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

export async function runWatcherSupervisor(options: WatcherSupervisorOptions): Promise<{ reason: SupervisorStopReason; restarts: number }> {
  const restartDelayMs = positive("restart delay", options.restartDelayMs ?? 1_000);
  const heartbeatTimeoutMs = positive("heartbeat timeout", options.heartbeatTimeoutMs ?? 30_000);
  const monitorIntervalMs = positive("monitor interval", options.monitorIntervalMs ?? 250);
  const lockHeartbeatIntervalMs = positive("lock heartbeat interval", options.lockHeartbeatIntervalMs ?? 5_000);
  const stopGraceMs = positive("stop grace period", options.stopGraceMs ?? 5_000);
  if (!Number.isFinite(options.cutoff.getTime())) throw new Error("supervisor cutoff must be a valid date");
  if (Date.now() >= options.cutoff.getTime()) throw new Error("supervisor cutoff has already passed");
  if (options.configuredMarketIds.size === 0) throw new Error("supervisor requires at least one configured market");

  const lease = await acquireLedgerWriterLease(options.ledgerPath, { staleAfterMs: options.staleLockMs });
  const emit = (event: Omit<SupervisorEvent, "timestamp">) => options.onEvent?.({ ...event, timestamp: new Date().toISOString() });
  let child: ChildProcess | undefined;
  let stopping = false;
  let stopReason: SupervisorStopReason | undefined;
  let restarts = 0;
  let lastHeartbeatAt = Date.now();
  let offset = (await stat(options.ledgerPath).catch(() => ({ size: 0 }))).size;
  let remainder = "";
  let restartTimer: NodeJS.Timeout | undefined;
  let monitorTimer: NodeJS.Timeout | undefined;
  let leaseTimer: NodeJS.Timeout | undefined;
  let cutoffTimer: NodeJS.Timeout | undefined;
  let resolveStopped!: () => void;
  let stopFailure: Error | undefined;
  const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });

  const stop = async (reason: SupervisorStopReason, detail: string) => {
    if (stopping) return;
    stopping = true;
    stopReason = reason;
    if (restartTimer) clearTimeout(restartTimer);
    if (monitorTimer) clearInterval(monitorTimer);
    if (leaseTimer) clearInterval(leaseTimer);
    if (cutoffTimer) clearTimeout(cutoffTimer);
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = waitForChildExit(child);
      terminateChild(child, "SIGTERM");
      const graceful = await Promise.race([exited.then(() => true), delay(stopGraceMs).then(() => false)]);
      if (!graceful) {
        terminateChild(child, "SIGKILL");
        await exited;
      }
    }
    try {
      await writeWatcherHeartbeat(options.heartbeatPath, {
        version: 1,
        token: lease.token,
        pid: process.pid,
        status: "stopped",
        timestamp: new Date().toISOString(),
        reason: detail,
      });
    } catch (error) {
      stopFailure = error instanceof Error ? error : new Error(String(error));
    }
    try {
      await lease.release();
    } catch (error) {
      stopFailure ??= error instanceof Error ? error : new Error(String(error));
    } finally {
      emit({ type: "supervisor-stopped", reason: detail });
      resolveStopped();
    }
  };

  const spawnChild = () => {
    if (stopping || Date.now() >= options.cutoff.getTime()) {
      void stop("cutoff", "configured cutoff reached before restart");
      return;
    }
    lastHeartbeatAt = Date.now();
    child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: {
        ...options.env,
        [LEDGER_WRITER_TOKEN_ENV]: lease.token,
        SETTLEMENT_EDGE_WATCHER_HEARTBEAT_PATH: options.heartbeatPath,
      },
      stdio: ["ignore", "inherit", "inherit"],
      detached: true,
    });
    const current = child;
    emit({ type: "child-started", pid: current.pid, restartNumber: restarts });
    let ended = false;
    const childEnded = (code: number | null, signal: NodeJS.Signals | null, reason?: string) => {
      if (ended) return;
      ended = true;
      emit({ type: "child-exited", pid: current.pid, code, signal, reason });
      if (stopping || current !== child) return;
      child = undefined;
      if (Date.now() >= options.cutoff.getTime()) {
        void stop("cutoff", "configured cutoff reached after child exit");
        return;
      }
      restarts += 1;
      emit({ type: "child-restart-scheduled", restartNumber: restarts, delayMs: restartDelayMs });
      restartTimer = setTimeout(spawnChild, restartDelayMs);
    };
    current.once("error", (error) => childEnded(null, null, error.message));
    current.once("exit", (code, signal) => childEnded(code, signal));
  };

  const inspectHeartbeat = async () => {
    if (!child?.pid) return;
    try {
      const heartbeat = JSON.parse(await readFile(options.heartbeatPath, "utf8")) as Partial<WatcherHeartbeat>;
      if (
        heartbeat.version === 1
        && heartbeat.token === lease.token
        && heartbeat.pid === child.pid
        && heartbeat.status === "running"
        && typeof heartbeat.timestamp === "string"
      ) {
        const timestamp = Date.parse(heartbeat.timestamp);
        if (Number.isFinite(timestamp)) lastHeartbeatAt = Math.max(lastHeartbeatAt, timestamp);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (Date.now() - lastHeartbeatAt > heartbeatTimeoutMs) {
      emit({ type: "child-heartbeat-stale", pid: child.pid, reason: `no valid heartbeat for ${Date.now() - lastHeartbeatAt}ms` });
      terminateChild(child, "SIGKILL");
      lastHeartbeatAt = Date.now();
    }
  };

  const inspectLedger = async () => {
    await assertLedgerWriterAuthorized(options.ledgerPath, lease.token);
    const size = (await stat(options.ledgerPath).catch(() => ({ size: offset }))).size;
    if (size < offset) throw new Error("active ledger was truncated while supervised");
    if (size === offset) return;
    const handle = await open(options.ledgerPath, "r");
    try {
      const buffer = Buffer.alloc(size - offset);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      offset += bytesRead;
      const lines = `${remainder}${buffer.subarray(0, bytesRead).toString("utf8")}`.split("\n");
      remainder = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        const status = guardedTransactionStatus(line, options.configuredMarketIds);
        if (status) {
          await stop("configured-market-order", `first configured-market order result is ${status}`);
          return;
        }
      }
    } finally {
      await handle.close();
    }
  };

  emit({ type: "supervisor-started", reason: `cutoff ${options.cutoff.toISOString()}` });
  spawnChild();
  cutoffTimer = setTimeout(() => void stop("cutoff", "configured cutoff reached"), options.cutoff.getTime() - Date.now());
  leaseTimer = setInterval(() => void lease.heartbeat().catch((error) => void stop("monitor-failure", error.message)), lockHeartbeatIntervalMs);
  monitorTimer = setInterval(() => {
    if (Date.now() >= options.cutoff.getTime()) {
      void stop("cutoff", "configured cutoff reached");
      return;
    }
    void Promise.all([inspectHeartbeat(), inspectLedger()]).catch((error) => void stop("monitor-failure", error instanceof Error ? error.message : String(error)));
  }, monitorIntervalMs);
  options.signal?.addEventListener("abort", () => void stop("signal", "shutdown signal received"), { once: true });
  await stopped;
  if (stopFailure) throw stopFailure;
  return { reason: stopReason ?? "monitor-failure", restarts };
}
