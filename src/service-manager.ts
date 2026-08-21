import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { clearDeadLedgerWriterLease, ledgerLockDirectory, type LedgerWriterOwner } from "./ledger-lock.js";
import type { WatcherHeartbeat } from "./heartbeat.js";

export type SupervisorServiceStopReason = "cutoff" | "clean-exit" | "signal";

export interface SupervisorServiceEvent {
  type:
    | "service-started"
    | "supervisor-started"
    | "supervisor-exited"
    | "orphan-watcher-stopped"
    | "supervisor-restart-scheduled"
    | "service-shutdown-started"
    | "service-stopped";
  timestamp: string;
  pid?: number;
  code?: number | null;
  signal?: NodeJS.Signals | null;
  restartNumber?: number;
  delayMs?: number;
  reason?: string;
}

export interface SupervisorServiceOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  ledgerPath: string;
  heartbeatPath: string;
  cutoff: Date;
  restartDelayMs?: number;
  staleLockMs?: number;
  stopGraceMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: SupervisorServiceEvent) => void;
}

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function positive(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function terminateProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processIsAlive(pid) && Date.now() < deadline) await delay(25);
  return !processIsAlive(pid);
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function retireOrphanWatcher(
  exitedSupervisorPid: number,
  ledgerPath: string,
  heartbeatPath: string,
  stopGraceMs: number,
  force = false,
): Promise<{ owner?: LedgerWriterOwner; watcherPid?: number }> {
  const owner = await readJson<LedgerWriterOwner>(`${ledgerLockDirectory(ledgerPath)}/owner.json`);
  if (!owner) return {};
  if (owner.pid !== exitedSupervisorPid) {
    throw new Error(`ledger writer lease belongs to unexpected supervisor PID ${owner.pid}; refusing an unsafe restart`);
  }
  if (!Number.isFinite(Date.parse(owner.heartbeatAt))) {
    throw new Error("ledger writer lease has an invalid heartbeat timestamp; refusing an unsafe restart");
  }
  const heartbeat = await readJson<WatcherHeartbeat>(heartbeatPath);
  if (
    !heartbeat
    || heartbeat.version !== 1
    || heartbeat.token !== owner.token
    || !["running", "stopped"].includes(heartbeat.status)
    || !Number.isInteger(heartbeat.pid)
    || heartbeat.pid <= 1
  ) {
    throw new Error("supervisor exited without a matching watcher heartbeat; refusing an unsafe restart");
  }
  if (heartbeat.status === "stopped" && processIsAlive(heartbeat.pid)) {
    throw new Error("watcher reports stopped but its process is still alive; refusing an unsafe restart");
  }
  if (!processIsAlive(heartbeat.pid)) return { owner };
  terminateProcessGroup(heartbeat.pid, force ? "SIGKILL" : "SIGTERM");
  let exited = await waitForProcessExit(heartbeat.pid, stopGraceMs);
  if (!exited && !force) {
    terminateProcessGroup(heartbeat.pid, "SIGKILL");
    exited = await waitForProcessExit(heartbeat.pid, stopGraceMs);
  }
  if (!exited) {
    throw new Error(`orphan watcher process group ${heartbeat.pid} did not stop; refusing an unsafe restart`);
  }
  return { owner, watcherPid: heartbeat.pid };
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function deadlinePromise(cutoff: Date): Promise<"cutoff"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("cutoff"), Math.max(0, cutoff.getTime() - Date.now()));
    timer.unref();
  });
}

export async function runSupervisorService(
  options: SupervisorServiceOptions,
): Promise<{ reason: SupervisorServiceStopReason; restarts: number }> {
  const restartDelayMs = positive("service restart delay", options.restartDelayMs ?? 1_000);
  const staleLockMs = positive("stale lock timeout", options.staleLockMs ?? 3_000);
  const stopGraceMs = positive("service stop grace period", options.stopGraceMs ?? 2_000);
  if (!Number.isFinite(options.cutoff.getTime())) throw new Error("service cutoff must be a valid date");
  if (Date.now() >= options.cutoff.getTime()) throw new Error("service cutoff has already passed");
  // Begin graceful shutdown one full grace period before the hard deadline so
  // the supervisor, watcher, and lease are all gone no later than the cutoff.
  const shutdownAt = new Date(options.cutoff.getTime() - stopGraceMs);
  const hardCleanupReserveMs = Math.max(1, Math.min(250, Math.floor(stopGraceMs / 3)));
  const hardStopAt = new Date(options.cutoff.getTime() - hardCleanupReserveMs);
  const emit = (event: Omit<SupervisorServiceEvent, "timestamp">) => options.onEvent?.({ ...event, timestamp: new Date().toISOString() });
  let restarts = 0;
  let child: ChildProcess | undefined;
  const abort = new Promise<"signal">((resolve) => {
    if (options.signal?.aborted) resolve("signal");
    else options.signal?.addEventListener("abort", () => resolve("signal"), { once: true });
  });
  emit({ type: "service-started", reason: `cutoff ${options.cutoff.toISOString()}` });

  const stopChild = async (
    exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
    reason: "cutoff" | "signal",
  ) => {
    if (!child?.pid) return;
    const supervisorPid = child.pid;
    if (child.exitCode === null && child.signalCode === null) {
      terminateProcessGroup(child.pid, "SIGTERM");
      const gracefulWaitMs = reason === "cutoff"
        ? Math.max(0, hardStopAt.getTime() - Date.now())
        : stopGraceMs;
      let timeout: NodeJS.Timeout | undefined;
      const graceful = await Promise.race([
        exited.then(() => true),
        new Promise<false>((resolve) => { timeout = setTimeout(() => resolve(false), gracefulWaitMs); }),
      ]).finally(() => { if (timeout) clearTimeout(timeout); });
      if (!graceful) {
        terminateProcessGroup(child.pid, "SIGKILL");
        await exited;
      }
    } else {
      await exited;
    }
    const cleanupWaitMs = reason === "cutoff"
      ? Math.max(1, options.cutoff.getTime() - Date.now())
      : stopGraceMs;
    const retired = await retireOrphanWatcher(
      supervisorPid,
      options.ledgerPath,
      options.heartbeatPath,
      cleanupWaitMs,
      true,
    );
    if (retired.watcherPid) emit({ type: "orphan-watcher-stopped", pid: retired.watcherPid, reason: `${reason} shutdown forced cleanup` });
    if (retired.owner) await clearDeadLedgerWriterLease(options.ledgerPath, retired.owner);
  };

  while (Date.now() < shutdownAt.getTime()) {
    child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: {
        ...options.env,
        SETTLEMENT_EDGE_SUPERVISOR_STALE_LOCK_MS: String(staleLockMs),
      },
      stdio: ["ignore", "inherit", "inherit"],
      detached: true,
    });
    if (!child.pid) throw new Error("supervisor service could not obtain the child PID");
    const supervisorPid = child.pid;
    const exited = waitForExit(child);
    emit({ type: "supervisor-started", pid: supervisorPid, restartNumber: restarts });
    const outcome = await Promise.race([exited, deadlinePromise(shutdownAt), abort]);
    if (outcome === "cutoff" || outcome === "signal") {
      emit({ type: "service-shutdown-started", reason: outcome });
      await stopChild(exited, outcome);
      emit({ type: "service-stopped", reason: outcome });
      return { reason: outcome, restarts };
    }
    emit({ type: "supervisor-exited", pid: supervisorPid, code: outcome.code, signal: outcome.signal });
    if (outcome.code === 0 && outcome.signal === null) {
      const retired = await retireOrphanWatcher(supervisorPid, options.ledgerPath, options.heartbeatPath, stopGraceMs, true);
      if (retired.watcherPid) emit({ type: "orphan-watcher-stopped", pid: retired.watcherPid, reason: "clean supervisor exit cleanup" });
      if (retired.owner) await clearDeadLedgerWriterLease(options.ledgerPath, retired.owner);
      emit({ type: "service-stopped", reason: "supervisor exited cleanly" });
      return { reason: "clean-exit", restarts };
    }

    const retired = await retireOrphanWatcher(supervisorPid, options.ledgerPath, options.heartbeatPath, stopGraceMs);
    if (retired.watcherPid) emit({ type: "orphan-watcher-stopped", pid: retired.watcherPid, reason: "previous supervisor exited abnormally" });
    const leaseReadyAt = retired.owner ? Date.parse(retired.owner.heartbeatAt) + staleLockMs + 25 : Date.now();
    const restartAt = Math.max(Date.now() + restartDelayMs, leaseReadyAt);
    const restartWaitMs = Math.max(0, restartAt - Date.now());
    if (restartAt >= shutdownAt.getTime()) {
      if (retired.owner) await clearDeadLedgerWriterLease(options.ledgerPath, retired.owner);
      break;
    }
    restarts += 1;
    emit({ type: "supervisor-restart-scheduled", restartNumber: restarts, delayMs: restartWaitMs });
    const restartOutcome = await Promise.race([delay(restartWaitMs).then(() => "restart" as const), deadlinePromise(shutdownAt), abort]);
    if (restartOutcome !== "restart") {
      if (retired.owner) await clearDeadLedgerWriterLease(options.ledgerPath, retired.owner);
      emit({ type: "service-shutdown-started", reason: restartOutcome });
      emit({ type: "service-stopped", reason: restartOutcome });
      return { reason: restartOutcome, restarts };
    }
  }
  emit({ type: "service-shutdown-started", reason: "cutoff" });
  emit({ type: "service-stopped", reason: "cutoff" });
  return { reason: "cutoff", restarts };
}
