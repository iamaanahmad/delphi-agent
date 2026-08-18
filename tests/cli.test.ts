import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
