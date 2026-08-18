import type {
  Comparator,
  EvidenceSignal,
  ResolutionRule,
  RuleThreshold,
  TimestampFormat,
} from "./types.js";

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

function scalarAt(payload: unknown, path: string): number | string {
  const value = readPath(payload, path);
  if (typeof value !== "number" && typeof value !== "string") throw new Error(`Missing scalar at ${path}`);
  return typeof value === "number" ? value : value.trim();
}

export function parseTimestamp(value: unknown, format: TimestampFormat = "iso"): Date {
  const text = String(value);
  let normalized = text;
  if (format === "wikimedia-hour") {
    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})$/.exec(text);
    if (!match) throw new Error(`Invalid wikimedia-hour timestamp: ${text}`);
    normalized = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:00:00Z`;
  } else if (format === "noaa-gmt-minute") {
    const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/.exec(text);
    if (!match) throw new Error(`Invalid noaa-gmt-minute timestamp: ${text}`);
    normalized = `${match[1]}T${match[2]}:00Z`;
  }
  const timestamp = new Date(normalized);
  if (Number.isNaN(timestamp.getTime())) throw new Error(`Invalid source timestamp: ${text}`);
  return timestamp;
}

function thresholdAt(payload: unknown, threshold: RuleThreshold): number | string {
  return typeof threshold === "object" ? scalarAt(payload, threshold.jsonPath) : threshold;
}

function aggregate(rule: ResolutionRule, payload: unknown): { actual: number; observedAt: Date; count: number } {
  const config = rule.aggregation;
  if (!config) throw new Error("Missing aggregation configuration");
  const records = readPath(payload, config.recordsPath);
  if (!Array.isArray(records)) throw new Error(`Missing records array at ${config.recordsPath}`);
  const start = parseTimestamp(config.windowStart);
  const end = parseTimestamp(config.windowEnd);
  if (end < start) throw new Error("Aggregation window ends before it starts");

  const selected: Array<{ value: number; observedAt: Date }> = [];
  for (const record of records) {
    const timestampValue = readPath(record, config.observedAtPath);
    if (timestampValue === undefined) throw new Error(`Missing scalar at ${config.observedAtPath}`);
    const observedAt = parseTimestamp(timestampValue, config.observedAtFormat);
    if (observedAt < start || observedAt > end) continue;
    const raw = readPath(record, config.valuePath);
    if (raw === "" || raw === null) continue;
    if (typeof raw !== "number" && typeof raw !== "string") throw new Error(`Missing scalar at ${config.valuePath}`);
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`Expected numeric source value, received ${String(raw)}`);
    selected.push({ value, observedAt });
  }
  if (selected.length === 0) throw new Error(`No numeric observations in ${config.windowStart}..${config.windowEnd}`);
  return {
    actual: Math.max(...selected.map((item) => item.value)),
    observedAt: new Date(Math.max(...selected.map((item) => item.observedAt.getTime()))),
    count: selected.length,
  };
}

export function extractEvidence(rule: ResolutionRule, payload: unknown, now = new Date()): EvidenceSignal {
  let actual: number | string;
  let observedAt: Date;
  let aggregationDetail = "";
  let publicationTime: string | undefined;

  if (rule.aggregation) {
    const result = aggregate(rule, payload);
    actual = result.actual;
    observedAt = result.observedAt;
    publicationTime = observedAt.toISOString();
    aggregationDetail = ` from ${result.count} observations`;
  } else {
    if (!rule.jsonPath) throw new Error("Scalar rule requires jsonPath");
    actual = scalarAt(payload, rule.jsonPath);
    const observedAtValue = rule.observedAtPath ? scalarAt(payload, rule.observedAtPath) : now.toISOString();
    observedAt = parseTimestamp(observedAtValue, rule.observedAtFormat);
    if (rule.observedAtPath) publicationTime = observedAt.toISOString();
  }

  const conditionsMet = (rule.conditions ?? []).every((condition) =>
    compare(scalarAt(payload, condition.jsonPath), condition.comparator, condition.threshold),
  );
  const threshold = thresholdAt(payload, rule.threshold);
  const ageMinutes = Math.max(0, (now.getTime() - observedAt.getTime()) / 60_000);
  const fresh = ageMinutes <= (rule.maxAgeMinutes ?? 15);
  const outcomeTrue = compare(actual, rule.comparator, threshold);
  return {
    id: `${rule.marketId}:${rule.outcomeIdx}:${rule.sourceName}`,
    source: rule.sourceName,
    sourceUrl: rule.sourceUrl,
    observedAt: observedAt.toISOString(),
    publicationTime,
    probability: conditionsMet ? (outcomeTrue ? 0.995 : 0.005) : 0.5,
    confidence: conditionsMet && fresh ? 0.98 : 0,
    detail: conditionsMet
      ? `${String(actual)} ${rule.comparator} ${String(threshold)}${aggregationDetail}; age ${ageMinutes.toFixed(1)}m`
      : `required source condition not met; age ${ageMinutes.toFixed(1)}m`,
  };
}

export async function fetchEvidence(rule: ResolutionRule, now = new Date()): Promise<EvidenceSignal> {
  const response = await fetch(rule.sourceUrl, {
    headers: { accept: "application/json", "user-agent": "settlement-edge/1.0" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`${rule.sourceName} returned HTTP ${response.status}`);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`${rule.sourceName} returned invalid JSON`);
  }
  return { ...extractEvidence(rule, payload, now), fetchedAt: new Date().toISOString() };
}
