import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { evaluateMarket } from "./engine.js";
import { fetchEvidence } from "./evidence.js";
import { appendLedgerRecord, available, unavailable } from "./receipt.js";
import type { Decision, EvidenceSignal, ResolutionRule, RiskPolicy, TradingGateway } from "./types.js";

export const DEFAULT_POLL_INTERVAL_MS = 60_000;
export const DEFAULT_RETRY_BASE_MS = 1_000;
export const DEFAULT_RETRY_MAX_MS = 30_000;
export const DEFAULT_WATCHER_STATE_PATH = "artifacts/watcher-state.json";

export interface WatcherStateEntry {
  fingerprint: string;
  status: "pending" | "processed" | "ambiguous";
  transactionHash?: string;
  updatedAt: string;
}

export type WatcherStatus =
  | { type: "cycle"; marketCount: number; ruleGroupCount: number }
  | { type: "duplicate"; key: string }
  | { type: "missing-market"; marketId: string }
  | { type: "retry"; delayMs: number; error: Error }
  | { type: "ambiguous-order"; key: string; error: Error }
  | { type: "stopped" };

export interface WatcherOptions {
  gateway: TradingGateway;
  ruleFile: string;
  policy: RiskPolicy;
  execute?: boolean;
  intervalMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  signal?: AbortSignal;
  state?: Map<string, WatcherStateEntry>;
  stateFile?: string | false;
  receiptPath?: string;
  loadRules?: () => Promise<ResolutionRule[]>;
  loadEvidence?: (rule: ResolutionRule) => Promise<EvidenceSignal>;
  evaluate?: typeof evaluateMarket;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  onDecision?: (decision: Decision) => void;
  onStatus?: (status: WatcherStatus) => void;
}

function positive(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

export async function loadResolutionRules(ruleFile: string): Promise<ResolutionRule[]> {
  const rules = JSON.parse(await readFile(ruleFile, "utf8")) as ResolutionRule[];
  if (!Array.isArray(rules) || rules.length === 0) throw new Error("Rule file must contain at least one resolution rule");
  return rules;
}

export function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

function groupRules(rules: ResolutionRule[]): Map<string, ResolutionRule[]> {
  const groups = new Map<string, ResolutionRule[]>();
  for (const rule of rules) {
    const key = `${rule.marketId.toLowerCase()}:${rule.outcomeIdx}`;
    groups.set(key, [...(groups.get(key) ?? []), rule]);
  }
  return groups;
}

function evidenceState(signal: EvidenceSignal) {
  return {
    id: signal.id,
    source: signal.source,
    sourceUrl: signal.sourceUrl,
    probability: signal.probability,
    confidence: signal.confidence,
    detail: signal.detail.replace(/; age [\d.]+m$/, ""),
  };
}

function fingerprint(market: Decision["market"], rules: ResolutionRule[], evidence: EvidenceSignal[]): string {
  const state = {
    market: {
      id: market.id.toLowerCase(),
      probabilities: market.probabilities,
      prices: market.prices,
      status: market.status,
    },
    rules,
    evidence: evidence.map(evidenceState),
  };
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}

interface WatcherStateFile {
  version: 1;
  opportunities: Record<string, WatcherStateEntry>;
}

export async function loadWatcherState(path = DEFAULT_WATCHER_STATE_PATH): Promise<Map<string, WatcherStateEntry>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<WatcherStateFile>;
    if (parsed.version !== 1 || !parsed.opportunities || typeof parsed.opportunities !== "object") {
      throw new Error("watcher state has an unsupported schema");
    }
    return new Map(Object.entries(parsed.opportunities));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
}

export async function persistWatcherState(state: Map<string, WatcherStateEntry>, path = DEFAULT_WATCHER_STATE_PATH): Promise<void> {
  const body: WatcherStateFile = { version: 1, opportunities: Object.fromEntries(state) };
  const temporary = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function storeState(
  state: Map<string, WatcherStateEntry>,
  key: string,
  entry: WatcherStateEntry,
  stateFile: string | false,
) {
  state.set(key, entry);
  if (stateFile) await persistWatcherState(state, stateFile);
}

export function failedStage(error: Error): "source" | "schema" {
  return /Missing|Expected|Invalid|records array|observations|threshold/i.test(error.message) ? "schema" : "source";
}

export async function recordOpportunityFailure(
  market: Decision["market"] | undefined,
  rules: ResolutionRule[],
  opportunityId: string,
  reason: string,
  stage: "market" | "source" | "schema" | "transaction",
  receiptPath?: string,
  transaction: { status: "not_submitted" | "ambiguous"; error?: string } = { status: "not_submitted" },
) {
  const first = rules[0];
  if (!first) return;
  const marketProbability = market?.probabilities[first.outcomeIdx];
  await appendLedgerRecord({
    type: "failure",
    opportunityId,
    terminal: true,
    stage,
    marketId: first.marketId,
    outcomeIdx: first.outcomeIdx,
    rules,
    reason,
    marketProbability: marketProbability === undefined ? unavailable("market probability is unavailable") : available(marketProbability),
    riskDecision: { action: "skip", reason },
    transaction,
  }, receiptPath);
}

export async function runWatcherCycle(options: WatcherOptions): Promise<void> {
  const stateFile = options.stateFile === undefined
    ? (options.state ? false : DEFAULT_WATCHER_STATE_PATH)
    : options.stateFile;
  const state = options.state ?? (stateFile ? await loadWatcherState(stateFile) : new Map<string, WatcherStateEntry>());
  const loadRules = options.loadRules ?? (() => loadResolutionRules(options.ruleFile));
  const loadEvidence = options.loadEvidence ?? fetchEvidence;
  const evaluate = options.evaluate ?? evaluateMarket;
  const rules = await loadRules();
  const groups = groupRules(rules);
  const markets = await options.gateway.listOpenMarkets();
  options.onStatus?.({ type: "cycle", marketCount: markets.length, ruleGroupCount: groups.size });

  const errors: Error[] = [];
  for (const [key, groupedRules] of groups) {
    if (options.signal?.aborted) break;
    const first = groupedRules[0];
    if (!first) continue;
    const market = markets.find((candidate) => candidate.id.toLowerCase() === first.marketId.toLowerCase());
    if (!market) {
      options.onStatus?.({ type: "missing-market", marketId: first.marketId });
      await recordOpportunityFailure(undefined, groupedRules, createHash("sha256").update(JSON.stringify(groupedRules)).digest("hex"), "open competition market not found", "market", options.receiptPath);
      continue;
    }

    try {
      let evidence: EvidenceSignal[];
      try {
        evidence = await Promise.all(groupedRules.map((rule) => loadEvidence(rule)));
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        const failureId = createHash("sha256").update(JSON.stringify({ key, rules: groupedRules })).digest("hex");
        await recordOpportunityFailure(market, groupedRules, failureId, failure.message, failedStage(failure), options.receiptPath);
        throw failure;
      }
      const currentFingerprint = fingerprint(market, groupedRules, evidence);
      if (state.get(key)?.fingerprint === currentFingerprint) {
        options.onStatus?.({ type: "duplicate", key });
        continue;
      }

      let buyAttempted = false;
      const trackedGateway: TradingGateway = {
        listOpenMarkets: () => options.gateway.listOpenMarkets(),
        quoteBuy: (...args) => options.gateway.quoteBuy(...args),
        buy: async (plan) => {
          await storeState(state, key, {
            fingerprint: currentFingerprint,
            status: "pending",
            updatedAt: new Date().toISOString(),
          }, stateFile);
          buyAttempted = true;
          return options.gateway.buy(plan);
        },
      };
      try {
        const decision = await evaluate(
          trackedGateway,
          market,
          first.outcomeIdx,
          evidence,
          options.policy,
          options.execute ?? false,
          { receiptPath: options.receiptPath, opportunityId: currentFingerprint },
        );
        if (buyAttempted && !decision.transactionHash) {
          throw new Error("order returned without a transaction hash");
        }
        await storeState(state, key, {
          fingerprint: currentFingerprint,
          status: "processed",
          transactionHash: decision.transactionHash,
          updatedAt: new Date().toISOString(),
        }, stateFile);
        options.onDecision?.(decision);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        if (buyAttempted) {
          // The gateway may have accepted the order before its response failed.
          // Fail closed until the market or evidence changes rather than risk a duplicate order.
          await storeState(state, key, {
            fingerprint: currentFingerprint,
            status: "ambiguous",
            updatedAt: new Date().toISOString(),
          }, stateFile);
          await recordOpportunityFailure(market, groupedRules, currentFingerprint, failure.message, "transaction", options.receiptPath, { status: "ambiguous", error: failure.message });
          options.onStatus?.({ type: "ambiguous-order", key, error: failure });
        }
        throw failure;
      }
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, `${errors.length} watcher evaluation(s) failed`);
}

export async function runWatcher(options: WatcherOptions): Promise<void> {
  const intervalMs = positive("poll interval", options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const retryBaseMs = positive("retry base", options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS);
  const retryMaxMs = positive("retry maximum", options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS);
  if (retryMaxMs < retryBaseMs) throw new Error("retry maximum must be at least retry base");
  const sleep = options.sleep ?? wait;
  const stateFile = options.stateFile === undefined
    ? (options.state ? false : DEFAULT_WATCHER_STATE_PATH)
    : options.stateFile;
  const state = options.state ?? (stateFile ? await loadWatcherState(stateFile) : new Map<string, WatcherStateEntry>());
  let consecutiveFailures = 0;

  while (!options.signal?.aborted) {
    try {
      await runWatcherCycle({ ...options, state, stateFile });
      consecutiveFailures = 0;
      await sleep(intervalMs, options.signal);
    } catch (error) {
      if (options.signal?.aborted) break;
      const failure = error instanceof Error ? error : new Error(String(error));
      const delayMs = Math.min(retryBaseMs * (2 ** consecutiveFailures), retryMaxMs);
      consecutiveFailures += 1;
      options.onStatus?.({ type: "retry", delayMs, error: failure });
      await sleep(delayMs, options.signal);
    }
  }
  options.onStatus?.({ type: "stopped" });
}
