import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);

async function runWithoutApiKey(command: "scan" | "run") {
  const env = { ...process.env };
  delete env.DELPHI_API_ACCESS_KEY;
  try {
    await run(process.execPath, ["--import", "tsx", "src/cli.ts", command], {
      cwd: process.cwd(),
      env,
    });
    assert.fail(`${command} should fail without a Delphi API key`);
  } catch (error) {
    return error as { code: number; stderr: string };
  }
}

test("scan reports a concise credential gate without a stack trace", async () => {
  const result = await runWithoutApiKey("scan");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Settlement Edge stopped: Requires apiKey/);
  assert.doesNotMatch(result.stderr, /at DelphiClient/);
});

test("one-shot evaluation reports the same credential gate", async () => {
  const result = await runWithoutApiKey("run");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Settlement Edge stopped: Requires apiKey/);
  assert.doesNotMatch(result.stderr, /at DelphiClient/);
});

test("deterministic replay labels simulated cost and P&L", async () => {
  const result = await run(process.execPath, ["--import", "tsx", "src/cli.ts", "replay", "fixtures/wikipedia-threshold.json"], {
    cwd: process.cwd(),
    env: process.env,
  });
  assert.match(result.stdout, /SIMULATED REPLAY \(no live order or realized P&L\)/);
  assert.match(result.stdout, /4 shares for 2\.5200 TST/);
  assert.match(result.stdout, /Expected P&L:1\.4292 TST \(not realized\)/);
  assert.match(result.stdout, /dry-run only/);
});

test("both active-market replays write safe receipts without an order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "settlement-edge-active-pack-"));
  const receiptPath = join(directory, "receipts.jsonl");
  const env = {
    ...process.env,
    ALLOW_LIVE_TRADING: "false",
    SETTLEMENT_EDGE_EXECUTE: "false",
    SETTLEMENT_EDGE_RECEIPT_PATH: receiptPath,
  };
  try {
    for (const fixture of ["fixtures/active-market-skc.json", "fixtures/active-market-battery.json"]) {
      const result = await run(process.execPath, ["--import", "tsx", "src/cli.ts", "replay", fixture], {
        cwd: process.cwd(),
        env,
      });
      assert.match(result.stdout, /SIMULATED REPLAY \(no live order or realized P&L\)/);
      assert.match(result.stdout, /dry-run only/);
      assert.doesNotMatch(result.stdout, /Transaction:/);
    }
    const records = (await readFile(receiptPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
      record: { type: string; transaction: { status: string; transactionHash?: string } };
    });
    assert.equal(records.length, 2);
    assert.ok(records.every(({ record }) => record.type === "decision"));
    assert.ok(records.every(({ record }) => record.transaction.status === "not_submitted"));
    assert.ok(records.every(({ record }) => record.transaction.transactionHash === undefined));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
