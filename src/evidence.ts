import type { Comparator, EvidenceSignal, ResolutionRule } from "./types.js";

export function readPath(input: unknown, path: string): unknown {
  return path.split(".").filter(Boolean).reduce<unknown>((value, key) => {
    if (Array.isArray(value)) return value[Number(key)];
    if (value && typeof value === "object") return (value as Record<string, unknown>)[key];
    return undefined;
  }, input);
}

export function compare(actual: number | string, comparator: Comparator, threshold: number | string): boolean {
  if (typeof threshold === "number") {
    const value = Number(actual);
    if (!Number.isFinite(value)) throw new Error(`Expected numeric source value, received ${String(actual)}`);
    if (comparator === "gt") return value > threshold;
    if (comparator === "gte") return value >= threshold;
    if (comparator === "lt") return value < threshold;
    if (comparator === "lte") return value <= threshold;
    return value === threshold;
  }
  if (comparator !== "eq") throw new Error("String thresholds only support eq");
  return String(actual).trim().toLowerCase() === threshold.trim().toLowerCase();
}

export async function fetchEvidence(rule: ResolutionRule, now = new Date()): Promise<EvidenceSignal> {
  const response = await fetch(rule.sourceUrl, {
    headers: { accept: "application/json", "user-agent": "settlement-edge/1.0" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`${rule.sourceName} returned HTTP ${response.status}`);
  const payload: unknown = await response.json();
  const actual = readPath(payload, rule.jsonPath);
  if (actual === undefined || (typeof actual !== "number" && typeof actual !== "string")) {
    throw new Error(`Missing scalar at ${rule.jsonPath}`);
  }
  const observedValue = typeof actual === "number" ? actual : actual.trim();
  const observedAtValue = rule.observedAtPath ? readPath(payload, rule.observedAtPath) : now.toISOString();
  const observedAt = new Date(String(observedAtValue));
  if (Number.isNaN(observedAt.getTime())) throw new Error(`Invalid source timestamp at ${rule.observedAtPath}`);
  const ageMinutes = Math.max(0, (now.getTime() - observedAt.getTime()) / 60_000);
  const maxAge = rule.maxAgeMinutes ?? 15;
  const fresh = ageMinutes <= maxAge;
  const outcomeTrue = compare(observedValue, rule.comparator, rule.threshold);
  return {
    id: `${rule.marketId}:${rule.outcomeIdx}:${rule.sourceName}`,
    source: rule.sourceName,
    sourceUrl: rule.sourceUrl,
    observedAt: observedAt.toISOString(),
    probability: outcomeTrue ? 0.995 : 0.005,
    confidence: fresh ? 0.98 : 0,
    detail: `${String(observedValue)} ${rule.comparator} ${String(rule.threshold)}; age ${ageMinutes.toFixed(1)}m`,
  };
}
