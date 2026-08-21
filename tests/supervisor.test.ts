import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { runWatcherSupervisor, type SupervisorEvent } from "../src/supervisor.js";

test("forced no-trade child exit is detected and recovered before cutoff", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "settlement-edge-supervisor-"));
  const ledgerPath = join(directory, "test-live-ledger.jsonl");
  const heartbeatPath = join(directory, "heartbeat.json");
  const counterPath = join(directory, "counter.txt");
  const eventPath = join(directory, "child-events.jsonl");
  const events: SupervisorEvent[] = [];
  const startedAt = Date.now();
  const cutoff = new Date(startedAt + 1_200);
  const result = await runWatcherSupervisor({
    command: process.execPath,
    args: [resolve("tests/fixtures/supervisor-child.mjs")],
    cwd: resolve("."),
    env: {
      ...process.env,
      ALLOW_LIVE_TRADING: "false",
      SETTLEMENT_EDGE_EXECUTE: "false",
      SUPERVISOR_FIXTURE_COUNTER: counterPath,
      SUPERVISOR_FIXTURE_EVENTS: eventPath,
      SUPERVISOR_FIXTURE_EXIT_ONCE: "true",
    },
    ledgerPath,
    heartbeatPath,
    configuredMarketIds: new Set(["0xtest"]),
    cutoff,
    restartDelayMs: 100,
    heartbeatTimeoutMs: 300,
    monitorIntervalMs: 25,
    lockHeartbeatIntervalMs: 50,
    staleLockMs: 1_000,
    stopGraceMs: 250,
    onEvent: (event) => events.push(event),
  });
  const firstExit = events.find((event) => event.type === "child-exited" && event.code === 23);
  const recovered = events.find((event) => event.type === "child-started" && event.restartNumber === 1);
  assert.ok(firstExit, "forced child exit must be observed");
  assert.ok(recovered, "replacement child must start");
  const recoveryMs = Date.parse(recovered.timestamp) - Date.parse(firstExit.timestamp);
  assert.ok(recoveryMs < 60_000);
  assert.equal(result.reason, "cutoff");
  assert.equal(result.restarts, 1);
  assert.ok(Date.now() - startedAt < 5_000);
  const heartbeat = JSON.parse(await readFile(heartbeatPath, "utf8")) as { status: string; reason: string; timestamp: string };
  assert.equal(heartbeat.status, "stopped");
  assert.match(heartbeat.reason, /cutoff/);
  assert.ok(Date.parse(heartbeat.timestamp) - cutoff.getTime() < 500, "cutoff stop must not drift by a monitor interval");
  const childEvents = (await readFile(eventPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; count: number });
  assert.ok(childEvents.some((event) => event.type === "forced-exit" && event.count === 1));
  assert.ok(childEvents.some((event) => event.type === "started" && event.count === 2));
  assert.ok(childEvents.some((event) => event.type === "stopped" && event.count === 2));
  await assert.rejects(stat(ledgerPath), { code: "ENOENT" });
  await assert.rejects(stat(`${ledgerPath}.writer.lock`), { code: "ENOENT" });
  context.diagnostic(`forced exit ${firstExit.timestamp}; replacement ${recovered.timestamp}; recovery ${recoveryMs}ms; cutoff stop ${heartbeat.timestamp}`);
});

test("stale child heartbeat is detected, killed, and recovered before cutoff", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "settlement-edge-supervisor-"));
  const ledgerPath = join(directory, "test-live-ledger.jsonl");
  const heartbeatPath = join(directory, "heartbeat.json");
  const counterPath = join(directory, "counter.txt");
  const eventPath = join(directory, "child-events.jsonl");
  const events: SupervisorEvent[] = [];
  const startedAt = Date.now();
  const result = await runWatcherSupervisor({
    command: process.execPath,
    args: [resolve("tests/fixtures/supervisor-child.mjs")],
    cwd: resolve("."),
    env: {
      ...process.env,
      ALLOW_LIVE_TRADING: "false",
      SETTLEMENT_EDGE_EXECUTE: "false",
      SUPERVISOR_FIXTURE_COUNTER: counterPath,
      SUPERVISOR_FIXTURE_EVENTS: eventPath,
      SUPERVISOR_FIXTURE_STALE_ONCE: "true",
    },
    ledgerPath,
    heartbeatPath,
    configuredMarketIds: new Set(["0xtest"]),
    cutoff: new Date(startedAt + 3_000),
    restartDelayMs: 100,
    heartbeatTimeoutMs: 200,
    monitorIntervalMs: 25,
    lockHeartbeatIntervalMs: 50,
    staleLockMs: 1_000,
    stopGraceMs: 250,
    onEvent: (event) => events.push(event),
  });
  const stale = events.find((event) => event.type === "child-heartbeat-stale");
  const recovered = events.find((event) => event.type === "child-started" && event.restartNumber === 1);
  assert.ok(stale, "stale heartbeat must be observed");
  assert.ok(recovered, `replacement child must start: ${JSON.stringify(events)}`);
  const recoveryMs = Date.parse(recovered.timestamp) - Date.parse(stale.timestamp);
  assert.ok(recoveryMs < 60_000);
  assert.equal(result.reason, "cutoff");
  assert.equal(result.restarts, 1);
  await assert.rejects(stat(ledgerPath), { code: "ENOENT" });
  context.diagnostic(`stale heartbeat ${stale.timestamp}; replacement ${recovered.timestamp}; recovery ${recoveryMs}ms`);
});

test("child spawn failure is supervised and retried until cutoff", async () => {
  const directory = await mkdtemp(join(tmpdir(), "settlement-edge-supervisor-"));
  const ledgerPath = join(directory, "test-live-ledger.jsonl");
  const heartbeatPath = join(directory, "heartbeat.json");
  const events: SupervisorEvent[] = [];
  const result = await runWatcherSupervisor({
    command: join(directory, "missing-watcher-command"),
    args: [],
    cwd: resolve("."),
    env: {
      ...process.env,
      ALLOW_LIVE_TRADING: "false",
      SETTLEMENT_EDGE_EXECUTE: "false",
    },
    ledgerPath,
    heartbeatPath,
    configuredMarketIds: new Set(["0xtest"]),
    cutoff: new Date(Date.now() + 400),
    restartDelayMs: 50,
    heartbeatTimeoutMs: 1_000,
    monitorIntervalMs: 20,
    lockHeartbeatIntervalMs: 50,
    staleLockMs: 1_000,
    stopGraceMs: 100,
    onEvent: (event) => events.push(event),
  });
  assert.equal(result.reason, "cutoff");
  assert.ok(result.restarts > 0);
  assert.ok(events.some((event) => event.type === "child-exited" && event.reason?.includes("ENOENT")));
  assert.ok(events.some((event) => event.type === "child-restart-scheduled"));
  await assert.rejects(stat(ledgerPath), { code: "ENOENT" });
  await assert.rejects(stat(`${ledgerPath}.writer.lock`), { code: "ENOENT" });
});
