import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { acquireLedgerWriterLease } from "./ledger-lock.js";
import { serializeLedgerValue } from "./receipt.js";
import type { MarketView, TradingGateway } from "./types.js";

export const DEFAULT_SENTINEL_STATE_PATH = "artifacts/new-market-sentinel-state.json";
export const DEFAULT_SENTINEL_RECEIPT_PATH = "artifacts/new-market-review-receipts.jsonl";
export const DEFAULT_SENTINEL_POLL_INTERVAL_MS = 60_000;
export const SENTINEL_QUOTE_SHARES = 0.1;

export interface MarketSnapshot extends MarketView {
  fingerprint: string;
}

export interface SentinelState {
  version: 1;
  cutoff: string;
  baselineCapturedAt: string;
  baseline: Record<string, MarketSnapshot>;
  reviewedFingerprints: Record<string, string>;
  lastPollAt: string;
  successfulPolls: number;
}

export interface QuoteProbe {
  outcomeIdx: number;
  outcome: string;
  shares: number;
  result:
    | { available: true; costTst: number }
    | { available: false; reason: string };
}

export type SentinelEvent =
  | {
      type: "baseline_captured";
      cutoff: string;
      pollIntervalMs: number;
      markets: MarketSnapshot[];
    }
  | {
      type: "candidate_review";
      market: MarketSnapshot;
      change: "new_market" | "material_market_change";
      previousFingerprint?: string;
      quoteProbes: QuoteProbe[];
      safetyGates: {
        exactWording: { passed: false; reason: string };
        closeTime: { passed: boolean; reason: string };
        officialSourceTiming: { passed: false; reason: string };
        settlementSemantics: { passed: false; reason: string };
        quote: { passed: boolean; reason: string };
        buildTestsPreflight: { passed: false; reason: string };
        existingRiskControls: { passed: false; reason: string };
      };
      verdict: "reject";
      reason: string;
      configurationChanged: false;
      watcherArmed: false;
      liveSwitchesRequiredFalse: true;
      transaction: { status: "not_submitted" };
    }
  | {
      type: "poll_failed";
      reason: string;
      transaction: { status: "not_submitted" };
    }
  | {
      type: "sentinel_stopped";
      reason: "cutoff" | "signal" | "once";
      transaction: { status: "not_submitted" };
    };

export interface SentinelEnvelope {
  version: 1;
  timestamp: string;
  previousHash: string;
  event: SentinelEvent;
  hash: string;
}

export interface MarketSentinelOptions {
  gateway: TradingGateway;
  cutoff: Date;
  statePath?: string;
  receiptPath?: string;
  intervalMs?: number;
  signal?: AbortSignal;
  once?: boolean;
  now?: () => Date;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  onEvent?: (event: SentinelEvent) => void;
}

const boundedError = (error: unknown) => {
  const detail = error instanceof Error ? error.message : String(error);
  return detail.replace(/[\r\n]+/g, " ").slice(0, 500);
};

const normalizedId = (marketId: string) => marketId.toLowerCase();

export function marketFingerprint(market: MarketView): string {
  return createHash("sha256").update(serializeLedgerValue({
    id: normalizedId(market.id),
    question: market.question.trim(),
    outcomes: market.outcomes.map((outcome) => outcome.trim()),
    resolvesAt: market.resolvesAt ?? null,
  })).digest("hex");
}

function snapshotMarket(market: MarketView): MarketSnapshot {
  return {
    ...market,
    id: normalizedId(market.id),
    outcomes: [...market.outcomes],
    probabilities: [...market.probabilities],
    prices: [...market.prices],
    fingerprint: marketFingerprint(market),
  };
}

async function readState(path: string): Promise<SentinelState | undefined> {
  try {
    const state = JSON.parse(await readFile(path, "utf8")) as Partial<SentinelState>;
    if (
      state.version !== 1
      || typeof state.cutoff !== "string"
      || typeof state.baselineCapturedAt !== "string"
      || !state.baseline
      || !state.reviewedFingerprints
      || typeof state.lastPollAt !== "string"
      || !Number.isInteger(state.successfulPolls)
    ) {
      throw new Error("sentinel state is invalid; inspect it before recovery");
    }
    return state as SentinelState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeState(path: string, state: SentinelState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

export async function readAndVerifySentinelReceipts(path: string): Promise<SentinelEnvelope[]> {
  let content: string;
  try {
    content = (await readFile(path, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (!content) return [];
  const envelopes = content.split("\n").map((line) => JSON.parse(line) as SentinelEnvelope);
  let previousHash = "GENESIS";
  for (const envelope of envelopes) {
    if (envelope.version !== 1 || envelope.previousHash !== previousHash || typeof envelope.timestamp !== "string") {
      throw new Error("sentinel receipt chain is invalid; inspect it before recovery");
    }
    const body = {
      version: 1 as const,
      timestamp: envelope.timestamp,
      previousHash: envelope.previousHash,
      event: envelope.event,
    };
    const expected = createHash("sha256").update(serializeLedgerValue(body)).digest("hex");
    if (expected !== envelope.hash) throw new Error("sentinel receipt hash does not match; inspect it before recovery");
    previousHash = envelope.hash;
  }
  return envelopes;
}

async function appendSentinelReceipt(path: string, event: SentinelEvent, timestamp: Date): Promise<string> {
  const receipts = await readAndVerifySentinelReceipts(path);
  const previousHash = receipts.at(-1)?.hash ?? "GENESIS";
  const body = {
    version: 1 as const,
    timestamp: timestamp.toISOString(),
    previousHash,
    event,
  };
  const hash = createHash("sha256").update(serializeLedgerValue(body)).digest("hex");
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${serializeLedgerValue({ ...body, hash })}\n`, { encoding: "utf8", mode: 0o600 });
  return hash;
}

async function quoteCandidate(gateway: TradingGateway, market: MarketSnapshot): Promise<QuoteProbe[]> {
  return Promise.all(market.outcomes.map(async (outcome, outcomeIdx): Promise<QuoteProbe> => {
    try {
      const quote = await gateway.quoteBuy(market.id, outcomeIdx, SENTINEL_QUOTE_SHARES);
      return {
        outcomeIdx,
        outcome,
        shares: SENTINEL_QUOTE_SHARES,
        result: { available: true, costTst: quote.costTst },
      };
    } catch (error) {
      return {
        outcomeIdx,
        outcome,
        shares: SENTINEL_QUOTE_SHARES,
        result: { available: false, reason: boundedError(error) },
      };
    }
  }));
}

function reviewEvent(
  market: MarketSnapshot,
  quoteProbes: QuoteProbe[],
  cutoff: Date,
  now: Date,
  previousFingerprint?: string,
): Extract<SentinelEvent, { type: "candidate_review" }> {
  const resolvesAt = market.resolvesAt ? Date.parse(market.resolvesAt) : Number.NaN;
  const closePassed = Number.isFinite(resolvesAt) && resolvesAt > now.getTime() && resolvesAt <= cutoff.getTime();
  const anyQuote = quoteProbes.some((probe) => probe.result.available);
  return {
    type: "candidate_review",
    market,
    change: previousFingerprint ? "material_market_change" : "new_market",
    previousFingerprint,
    quoteProbes,
    safetyGates: {
      exactWording: { passed: false, reason: "no human-reviewed mapping from the exact question and outcomes to a resolution rule exists" },
      closeTime: {
        passed: closePassed,
        reason: closePassed
          ? `market close ${market.resolvesAt} is in the future and no later than the competition cutoff`
          : "market close is missing, already passed, or later than the competition trading cutoff",
      },
      officialSourceTiming: { passed: false, reason: "no reviewed official source proves a decisive publication strictly before this market closes" },
      settlementSemantics: { passed: false, reason: "settlement semantics have not been independently mapped and boundary-tested" },
      quote: {
        passed: anyQuote,
        reason: anyQuote
          ? `at least one read-only ${SENTINEL_QUOTE_SHARES}-share quote returned; profitability is not inferred without evidence`
          : `all read-only ${SENTINEL_QUOTE_SHARES}-share quote probes failed`,
      },
      buildTestsPreflight: { passed: false, reason: "no rule was added, so rule-specific build, tests, and preflight were not eligible to run" },
      existingRiskControls: { passed: false, reason: "evidence, confidence, quote, impact, slippage, duplicate-order, and 10 TST gates cannot pass without a reviewed rule" },
    },
    verdict: "reject",
    reason: "fail closed: the candidate lacks a reviewed exact settlement mapping and proven pre-close official evidence timing",
    configurationChanged: false,
    watcherArmed: false,
    liveSwitchesRequiredFalse: true,
    transaction: { status: "not_submitted" },
  };
}

export async function runMarketSentinelCycle(
  gateway: TradingGateway,
  cutoff: Date,
  statePath: string,
  receiptPath: string,
  intervalMs = DEFAULT_SENTINEL_POLL_INTERVAL_MS,
  now = new Date(),
  onEvent?: (event: SentinelEvent) => void,
): Promise<{ state: SentinelState; reviews: number; baselineCreated: boolean }> {
  const markets = (await gateway.listOpenMarkets()).map(snapshotMarket);
  const existing = await readState(statePath);
  if (!existing) {
    const baseline = Object.fromEntries(markets.map((market) => [market.id, market]));
    const state: SentinelState = {
      version: 1,
      cutoff: cutoff.toISOString(),
      baselineCapturedAt: now.toISOString(),
      baseline,
      reviewedFingerprints: {},
      lastPollAt: now.toISOString(),
      successfulPolls: 1,
    };
    const event: SentinelEvent = {
      type: "baseline_captured",
      cutoff: cutoff.toISOString(),
      pollIntervalMs: intervalMs,
      markets,
    };
    await appendSentinelReceipt(receiptPath, event, now);
    await writeState(statePath, state);
    onEvent?.(event);
    return { state, reviews: 0, baselineCreated: true };
  }
  if (existing.cutoff !== cutoff.toISOString()) {
    throw new Error(`sentinel state cutoff ${existing.cutoff} does not match requested cutoff ${cutoff.toISOString()}`);
  }

  let reviews = 0;
  for (const market of markets) {
    const baselineFingerprint = existing.baseline[market.id]?.fingerprint;
    const previousFingerprint = existing.reviewedFingerprints[market.id];
    if (baselineFingerprint === market.fingerprint || previousFingerprint === market.fingerprint) continue;
    const probes = await quoteCandidate(gateway, market);
    const event = reviewEvent(market, probes, cutoff, now, previousFingerprint ?? baselineFingerprint);
    await appendSentinelReceipt(receiptPath, event, now);
    existing.reviewedFingerprints[market.id] = market.fingerprint;
    reviews += 1;
    onEvent?.(event);
  }
  existing.lastPollAt = now.toISOString();
  existing.successfulPolls += 1;
  await writeState(statePath, existing);
  return { state: existing, reviews, baselineCreated: false };
}

const defaultSleep = (milliseconds: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  if (signal?.aborted) return resolve();
  const timer = setTimeout(resolve, milliseconds);
  signal?.addEventListener("abort", () => {
    clearTimeout(timer);
    resolve();
  }, { once: true });
});

export async function runMarketSentinel(options: MarketSentinelOptions): Promise<"cutoff" | "signal" | "once"> {
  const statePath = options.statePath ?? DEFAULT_SENTINEL_STATE_PATH;
  const receiptPath = options.receiptPath ?? DEFAULT_SENTINEL_RECEIPT_PATH;
  const intervalMs = options.intervalMs ?? DEFAULT_SENTINEL_POLL_INTERVAL_MS;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? defaultSleep;
  if (!Number.isFinite(options.cutoff.getTime())) throw new Error("sentinel cutoff must be a valid date");
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error("sentinel poll interval must be positive");
  if (now().getTime() >= options.cutoff.getTime()) throw new Error("sentinel cutoff has already passed");

  const lease = await acquireLedgerWriterLease(receiptPath, { staleAfterMs: Math.max(intervalMs * 2, 120_000) });
  const heartbeat = setInterval(() => void lease.heartbeat(), Math.min(5_000, intervalMs));
  heartbeat.unref();
  let stopReason: "cutoff" | "signal" | "once" = "cutoff";
  try {
    while (!options.signal?.aborted && now().getTime() < options.cutoff.getTime()) {
      try {
        await runMarketSentinelCycle(options.gateway, options.cutoff, statePath, receiptPath, intervalMs, now(), options.onEvent);
      } catch (error) {
        const event: SentinelEvent = {
          type: "poll_failed",
          reason: boundedError(error),
          transaction: { status: "not_submitted" },
        };
        await appendSentinelReceipt(receiptPath, event, now());
        options.onEvent?.(event);
      }
      if (options.once) {
        stopReason = "once";
        break;
      }
      const remaining = options.cutoff.getTime() - now().getTime();
      if (remaining <= 0) break;
      await sleep(Math.min(intervalMs, remaining), options.signal);
    }
    if (options.signal?.aborted) stopReason = "signal";
    const event: SentinelEvent = {
      type: "sentinel_stopped",
      reason: stopReason,
      transaction: { status: "not_submitted" },
    };
    await appendSentinelReceipt(receiptPath, event, now());
    options.onEvent?.(event);
    return stopReason;
  } finally {
    clearInterval(heartbeat);
    await lease.release();
  }
}
