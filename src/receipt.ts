import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Decision } from "./types.js";

const previousHashes = new Map<string, string>();
const serialize = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);

async function getPreviousHash(path: string): Promise<string> {
  const cached = previousHashes.get(path);
  if (cached) return cached;
  try {
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    const last = lines.at(-1);
    if (!last) return "GENESIS";
    const parsed = JSON.parse(last) as { hash?: unknown };
    return typeof parsed.hash === "string" ? parsed.hash : "GENESIS";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "GENESIS";
    throw error;
  }
}

export async function appendReceipt(decision: Decision, path = "artifacts/decision-receipts.jsonl") {
  const previousHash = await getPreviousHash(path);
  const body = {
    version: 1,
    timestamp: new Date().toISOString(),
    previousHash,
    decision,
  };
  const hash = createHash("sha256").update(serialize(body)).digest("hex");
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${serialize({ ...body, hash })}\n`, "utf8");
  previousHashes.set(path, hash);
  return hash;
}
