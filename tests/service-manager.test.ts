import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { ledgerLockDirectory, type LedgerWriterOwner } from "../src/ledger-lock.js";
import { runSupervisorService, type SupervisorServiceEvent } from "../src/service-manager.js";

const wait = (milliseconds: number) => new Promise<void>((resolveWait) => setTimeout(resolveWait, milliseconds));

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await wait(20);
  }
  throw new Error(`condition did not become true within ${timeoutMs}ms`);
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function liveWriterCardinality(ledgerPath: string): Promise<number> {
  const owner = await readJson<LedgerWriterOwner>(join(ledgerLockDirectory(ledgerPath), "owner.json"));
  return owner && alive(owner.pid) ? 1 : 0;
}

test("detached service retires an orphan watcher and restores exactly one writer before cutoff", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "settlement-edge-service-"));
  const ledgerPath = join(directory, "live.jsonl");
  const heartbeatPath = join(directory, "heartbeat.json");
  const counterPath = join(directory, "counter.txt");
  const eventPath = join(directory, "fixture-events.jsonl");
  const events: SupervisorServiceEvent[] = [];
  await writeFile(ledgerPath, `${JSON.stringify({ record: { type: "failure", transaction: { status: "not_submitted" } } })}\n`, "utf8");
  const cutoff = new Date(Date.now() + 2_500);
  const service = runSupervisorService({
    command: process.execPath,
    args: [resolve("dist/tests/fixtures/service-supervisor.js")],
    cwd: resolve("."),
    env: {
      ...process.env,
      ALLOW_LIVE_TRADING: "false",
      SETTLEMENT_EDGE_EXECUTE: "false",
      SERVICE_FIXTURE_LEDGER: ledgerPath,
      SETTLEMENT_EDGE_WATCHER_HEARTBEAT_PATH: heartbeatPath,
      SUPERVISOR_FIXTURE_COUNTER: counterPath,
      SUPERVISOR_FIXTURE_EVENTS: eventPath,
      SERVICE_FIXTURE_IGNORE_SIGTERM: "true",
    },
    ledgerPath,
    heartbeatPath,
    cutoff,
    restartDelayMs: 100,
    staleLockMs: 200,
    stopGraceMs: 300,
    onEvent: (event) => events.push(event),
  });

  const firstOwner = await waitFor(() => readJson<LedgerWriterOwner>(join(ledgerLockDirectory(ledgerPath), "owner.json")));
  const firstHeartbeat = await waitFor(() => readJson<{ pid: number; status: string }>(heartbeatPath));
  assert.equal(firstOwner.pid, events.find((event) => event.type === "supervisor-started")?.pid);
  assert.equal(firstHeartbeat.status, "running");
  assert.equal(alive(firstOwner.pid), true);
  assert.equal(alive(firstHeartbeat.pid), true);
  assert.equal(await liveWriterCardinality(ledgerPath), 1);
  const forcedAt = Date.now();
  process.kill(-firstOwner.pid, "SIGKILL");

  const secondOwner = await waitFor(async () => {
    const owner = await readJson<LedgerWriterOwner>(join(ledgerLockDirectory(ledgerPath), "owner.json"));
    return owner && owner.pid !== firstOwner.pid && alive(owner.pid) ? owner : undefined;
  }, 5_000);
  const recovered = events.find((event) => event.type === "supervisor-started" && event.pid === secondOwner.pid);
  assert.ok(recovered, `replacement supervisor must be observed: ${JSON.stringify(events)}`);
  const recoveryMs = Date.parse(recovered.timestamp) - forcedAt;
  assert.ok(recoveryMs < 10_000, `supervisor recovery took ${recoveryMs}ms`);
  assert.equal(events.filter((event) => event.type === "orphan-watcher-stopped").length, 1);
  assert.equal(alive(firstHeartbeat.pid), false);
  assert.equal(alive(secondOwner.pid), true);
  assert.equal(await liveWriterCardinality(ledgerPath), 1);

  const result = await service;
  assert.equal(result.reason, "cutoff");
  assert.equal(result.restarts, 1);
  const shutdownStartedAt = Date.parse(events.find((event) => event.type === "service-shutdown-started")?.timestamp ?? "");
  const stoppedAt = Date.parse(events.find((event) => event.type === "service-stopped")?.timestamp ?? "");
  assert.ok(
    Number.isFinite(shutdownStartedAt) && shutdownStartedAt <= cutoff.getTime() - 250,
    `graceful shutdown started only ${cutoff.getTime() - shutdownStartedAt}ms before cutoff`,
  );
  assert.ok(Number.isFinite(stoppedAt) && stoppedAt <= cutoff.getTime(), `service stopped ${stoppedAt - cutoff.getTime()}ms after cutoff`);
  await assert.rejects(stat(ledgerLockDirectory(ledgerPath)), { code: "ENOENT" });
  const ledger = (await readFile(ledgerPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { record?: { transaction?: { status?: string } } });
  assert.equal(ledger.filter((line) => ["submitted", "ambiguous"].includes(line.record?.transaction?.status ?? "")).length, 0);
  const fixtureEvents = (await readFile(eventPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; pid?: number; watcherPid?: number; liveSwitches?: string[] });
  assert.equal(fixtureEvents.filter((event) => event.type === "fixture-supervisor-started").length, 2);
  assert.ok(fixtureEvents.filter((event) => event.type === "fixture-supervisor-started").every((event) => event.liveSwitches?.join(",") === "false,false"));
  const replacementFixture = fixtureEvents.filter((event) => event.type === "fixture-supervisor-started").at(-1);
  assert.equal(alive(secondOwner.pid), false);
  assert.equal(alive(replacementFixture?.watcherPid ?? 0), false);
  assert.equal(events.filter((event) => event.type === "orphan-watcher-stopped").length, 2);
  context.diagnostic(`forced supervisor ${firstOwner.pid}; orphan watcher ${firstHeartbeat.pid}; replacement ${secondOwner.pid}; recovery ${recoveryMs}ms; zero orders`);
});

test("signal shutdown force-cleans a supervisor that ignores SIGTERM", async () => {
  const directory = await mkdtemp(join(tmpdir(), "settlement-edge-service-signal-"));
  const ledgerPath = join(directory, "live.jsonl");
  const heartbeatPath = join(directory, "heartbeat.json");
  const controller = new AbortController();
  await writeFile(ledgerPath, "", "utf8");
  const service = runSupervisorService({
    command: process.execPath,
    args: [resolve("dist/tests/fixtures/service-supervisor.js")],
    cwd: resolve("."),
    env: {
      ...process.env,
      ALLOW_LIVE_TRADING: "false",
      SETTLEMENT_EDGE_EXECUTE: "false",
      SERVICE_FIXTURE_LEDGER: ledgerPath,
      SETTLEMENT_EDGE_WATCHER_HEARTBEAT_PATH: heartbeatPath,
      SUPERVISOR_FIXTURE_COUNTER: join(directory, "counter.txt"),
      SUPERVISOR_FIXTURE_EVENTS: join(directory, "events.jsonl"),
      SERVICE_FIXTURE_IGNORE_SIGTERM: "true",
    },
    ledgerPath,
    heartbeatPath,
    cutoff: new Date(Date.now() + 10_000),
    restartDelayMs: 100,
    staleLockMs: 200,
    stopGraceMs: 150,
    signal: controller.signal,
  });
  const owner = await waitFor(() => readJson<LedgerWriterOwner>(join(ledgerLockDirectory(ledgerPath), "owner.json")));
  const heartbeat = await waitFor(() => readJson<{ pid: number }>(heartbeatPath));
  controller.abort();
  const result = await service;
  assert.equal(result.reason, "signal");
  assert.equal(alive(owner.pid), false);
  assert.equal(alive(heartbeat.pid), false);
  await assert.rejects(stat(ledgerLockDirectory(ledgerPath)), { code: "ENOENT" });
});

test("abnormal exit too near cutoff clears the dead lease without restarting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "settlement-edge-service-near-cutoff-"));
  const ledgerPath = join(directory, "live.jsonl");
  const heartbeatPath = join(directory, "heartbeat.json");
  const events: SupervisorServiceEvent[] = [];
  await writeFile(ledgerPath, "", "utf8");
  const service = runSupervisorService({
    command: process.execPath,
    args: [resolve("dist/tests/fixtures/service-supervisor.js")],
    cwd: resolve("."),
    env: {
      ...process.env,
      ALLOW_LIVE_TRADING: "false",
      SETTLEMENT_EDGE_EXECUTE: "false",
      SERVICE_FIXTURE_LEDGER: ledgerPath,
      SETTLEMENT_EDGE_WATCHER_HEARTBEAT_PATH: heartbeatPath,
      SUPERVISOR_FIXTURE_COUNTER: join(directory, "counter.txt"),
      SUPERVISOR_FIXTURE_EVENTS: join(directory, "events.jsonl"),
    },
    ledgerPath,
    heartbeatPath,
    cutoff: new Date(Date.now() + 1_000),
    restartDelayMs: 100,
    staleLockMs: 1_000,
    stopGraceMs: 250,
    onEvent: (event) => events.push(event),
  });
  const owner = await waitFor(() => readJson<LedgerWriterOwner>(join(ledgerLockDirectory(ledgerPath), "owner.json")));
  const heartbeat = await waitFor(() => readJson<{ pid: number }>(heartbeatPath));
  process.kill(-owner.pid, "SIGKILL");
  const result = await service;
  assert.equal(result.reason, "cutoff");
  assert.equal(result.restarts, 0);
  assert.equal(events.filter((event) => event.type === "supervisor-started").length, 1);
  assert.equal(alive(heartbeat.pid), false);
  await assert.rejects(stat(ledgerLockDirectory(ledgerPath)), { code: "ENOENT" });
});
