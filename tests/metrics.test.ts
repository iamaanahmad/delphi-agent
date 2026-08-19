import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureTelemetryPoints, readTelemetryPoints, syncLedgerTelemetry } from "../src/metrics.js";
import { appendLedgerRecord, type TelemetryLedgerRecord } from "../src/receipt.js";
import { appendTelemetry } from "../src/telemetry.js";

const config = { enabled: true, publicKey: "phc_fixture", host: "https://example.test" };

test("exports test-tagged lifecycle telemetry without mixing it into live events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "settlement-edge-metrics-"));
  const ledgerPath = join(directory, "ledger.jsonl");
  const at = new Date("2026-08-18T00:00:00.000Z");
  const base = { runId: "fixture-run", environment: "test" as const, marketId: "0xfixture" };
  await appendTelemetry({ ...base, event: "run_started", data: {} }, ledgerPath, at);
  await appendTelemetry({ ...base, event: "evidence_accepted", data: { sourceId: "must-not-leave-ledger" } }, ledgerPath, at);
  await appendTelemetry({ ...base, event: "decision_made", data: { action: "buy" } }, ledgerPath, at);
  await appendTelemetry({ ...base, event: "order_submitted", data: { transactionStatus: "submitted" } }, ledgerPath, at);
  await appendTelemetry({ ...base, event: "settlement_observed", data: { settlementStatus: "settled" } }, ledgerPath, at);
  await appendTelemetry({ ...base, event: "redemption_observed", data: { redemptionStatus: "redeemed", tokensRedeemedTst: 1 } }, ledgerPath, at);
  await appendTelemetry({ ...base, event: "realized_pnl_observed", data: { realizedPnlTst: 0.4 } }, ledgerPath, at);

  const points = await readTelemetryPoints(ledgerPath);
  assert.equal(points.length, 7);
  let body: { batch: Array<{ event: string; properties: Record<string, unknown> }> } | undefined;
  const fetcher = async (_input: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return new Response("ok", { status: 200 });
  };
  assert.equal(await captureTelemetryPoints(points, config, fetcher), 7);
  assert.ok(body?.batch.every((event) => event.event.startsWith("settlement_edge_test_")));
  assert.equal(body?.batch[1]?.properties.sourceId, undefined);
  assert.equal(body?.batch.at(-1)?.properties.realizedPnlTst, 0.4);
  assert.equal(await syncLedgerTelemetry(ledgerPath, ["live"], config, fetcher), 0);
});

test("uses distinct event namespaces for every non-live environment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "settlement-edge-metrics-"));
  const ledgerPath = join(directory, "ledger.jsonl");
  const at = new Date("2026-08-18T00:00:00.000Z");
  for (const environment of ["live", "dry_run", "replay", "test"] as const) {
    await appendTelemetry({ runId: environment, environment, event: "run_started", data: {} }, ledgerPath, at);
  }

  let events: string[] = [];
  const fetcher = async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { batch: Array<{ event: string }> };
    events = body.batch.map((event) => event.event);
    return new Response("ok", { status: 200 });
  };
  await captureTelemetryPoints(await readTelemetryPoints(ledgerPath), config, fetcher);
  assert.deepEqual(events, [
    "settlement_edge_run_started",
    "settlement_edge_dry_run_run_started",
    "settlement_edge_replay_run_started",
    "settlement_edge_test_run_started",
  ]);
});

test("refuses to export a tampered ledger", async () => {
  const directory = await mkdtemp(join(tmpdir(), "settlement-edge-metrics-"));
  const ledgerPath = join(directory, "ledger.jsonl");
  await appendTelemetry({ runId: "fixture", environment: "test", event: "run_started", data: {} }, ledgerPath);
  const content = await readFile(ledgerPath, "utf8");
  await writeFile(ledgerPath, content.replace("run_started", "decision_made"));
  await assert.rejects(readTelemetryPoints(ledgerPath), /hash does not match/);
});

test("refuses a hash-valid telemetry record with an unsupported schema value", async () => {
  const directory = await mkdtemp(join(tmpdir(), "settlement-edge-metrics-"));
  const ledgerPath = join(directory, "ledger.jsonl");
  const invalid = {
    type: "telemetry",
    schemaVersion: 1,
    event: "operator_secret",
    runId: "fixture",
    environment: "test",
    data: {},
  } as unknown as TelemetryLedgerRecord;
  await appendLedgerRecord(invalid, ledgerPath);
  await assert.rejects(readTelemetryPoints(ledgerPath), /unsupported telemetry record/);
});
