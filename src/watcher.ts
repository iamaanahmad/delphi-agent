import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { evaluateMarket } from "./engine.js";
import { fetchEvidence } from "./evidence.js";
import type { Decision, EvidenceSignal, ResolutionRule, RiskPolicy, TradingGateway } from "./types.js";

export const DEFAULT_POLL_INTERVAL_MS = 60_000;
export const DEFAULT_RETRY_BASE_MS = 1_000;
export const DEFAULT_RETRY_MAX_MS = 30_000;

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
  state?: Map<string, string>;
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

export async function runWatcherCycle(options: WatcherOptions): Promise<void> {
  const state = options.state ?? new Map<string, string>();
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
      continue;
    }

    try {
      const evidence = await Promise.all(groupedRules.map((rule) => loadEvidence(rule)));
      const currentFingerprint = fingerprint(market, groupedRules, evidence);
      if (state.get(key) === currentFingerprint) {
        options.onStatus?.({ type: "duplicate", key });
        continue;
      }

      let buyAttempted = false;
      const trackedGateway: TradingGateway = {
        listOpenMarkets: () => options.gateway.listOpenMarkets(),
        quoteBuy: (...args) => options.gateway.quoteBuy(...args),
        buy: async (plan) => {
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
        );
        state.set(key, currentFingerprint);
        options.onDecision?.(decision);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        if (buyAttempted) {
          // The gateway may have accepted the order before its response failed.
          // Fail closed until the market or evidence changes rather than risk a duplicate order.
          state.set(key, currentFingerprint);
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
  const state = options.state ?? new Map<string, string>();
  let consecutiveFailures = 0;

  while (!options.signal?.aborted) {
    try {
      await runWatcherCycle({ ...options, state });
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
