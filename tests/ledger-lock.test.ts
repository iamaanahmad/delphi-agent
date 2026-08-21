import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireLedgerWriterLease, LEDGER_WRITER_TOKEN_ENV, ledgerLockDirectory } from "../src/ledger-lock.js";
import { appendLedgerRecord } from "../src/receipt.js";

const failureRecord = {
  type: "failure" as const,
  opportunityId: "fixture",
  terminal: true as const,
  stage: "source" as const,
  marketId: "0xtest",
  outcomeIdx: 0,
  rules: [],
  reason: "fixture",
  marketProbability: { available: false as const, reason: "fixture" },
  riskDecision: { action: "skip" as const, reason: "fixture" },
  transaction: { status: "not_submitted" as const },
};

test("active ledger lease excludes a second supervisor and unauthorized writer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "settlement-edge-lock-"));
  const ledgerPath = join(directory, "live.jsonl");
  const lease = await acquireLedgerWriterLease(ledgerPath, { staleAfterMs: 1_000 });
  await assert.rejects(acquireLedgerWriterLease(ledgerPath, { staleAfterMs: 1_000 }), /active writer lease/);
  await assert.rejects(appendLedgerRecord(failureRecord, ledgerPath), /active writer lease/);

  const previous = process.env[LEDGER_WRITER_TOKEN_ENV];
  process.env[LEDGER_WRITER_TOKEN_ENV] = lease.token;
  try {
    await appendLedgerRecord(failureRecord, ledgerPath);
  } finally {
    if (previous === undefined) delete process.env[LEDGER_WRITER_TOKEN_ENV];
    else process.env[LEDGER_WRITER_TOKEN_ENV] = previous;
  }
  const lines = (await readFile(ledgerPath, "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0] ?? "{}").record.transaction.status, "not_submitted");
  await lease.release();
});

test("stale lock is recovered only after its heartbeat expires and owner is dead", async () => {
  const directory = await mkdtemp(join(tmpdir(), "settlement-edge-lock-"));
  const ledgerPath = join(directory, "live.jsonl");
  const lockDirectory = ledgerLockDirectory(ledgerPath);
  await mkdir(lockDirectory, { recursive: true });
  await writeFile(join(lockDirectory, "owner.json"), JSON.stringify({
    version: 1,
    token: "abandoned",
    pid: 999_999,
    acquiredAt: "2026-08-21T00:00:00.000Z",
    heartbeatAt: "2026-08-21T00:00:00.000Z",
    ledgerPath,
  }), "utf8");
  const lease = await acquireLedgerWriterLease(ledgerPath, {
    staleAfterMs: 60_000,
    now: () => new Date("2026-08-21T00:02:00.000Z"),
    isProcessAlive: () => false,
  });
  assert.notEqual(lease.token, "abandoned");
  await lease.release();
});

test("stale-looking lock remains fail-closed while its owner is alive", async () => {
  const directory = await mkdtemp(join(tmpdir(), "settlement-edge-lock-"));
  const ledgerPath = join(directory, "live.jsonl");
  const lockDirectory = ledgerLockDirectory(ledgerPath);
  await mkdir(lockDirectory, { recursive: true });
  await writeFile(join(lockDirectory, "owner.json"), JSON.stringify({
    version: 1,
    token: "live-owner",
    pid: 42,
    acquiredAt: "2026-08-21T00:00:00.000Z",
    heartbeatAt: "2026-08-21T00:00:00.000Z",
    ledgerPath,
  }), "utf8");
  await assert.rejects(acquireLedgerWriterLease(ledgerPath, {
    staleAfterMs: 60_000,
    now: () => new Date("2026-08-21T00:02:00.000Z"),
    isProcessAlive: () => true,
  }), /active writer lease/);
});

test("writer fails closed while a lock is missing owner metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "settlement-edge-lock-"));
  const ledgerPath = join(directory, "live.jsonl");
  await mkdir(ledgerLockDirectory(ledgerPath), { recursive: true });
  await assert.rejects(appendLedgerRecord(failureRecord, ledgerPath), /without owner metadata/);
  await assert.rejects(acquireLedgerWriterLease(ledgerPath), /without owner metadata/);
});
