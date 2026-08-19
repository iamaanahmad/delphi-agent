import type {
  Comparator,
  EvidenceSignal,
  ResolutionRule,
  RuleThreshold,
  TimestampFormat,
} from "./types.js";

const MONTHS = new Map([
  ["january", 0], ["february", 1], ["march", 2], ["april", 3],
  ["may", 4], ["june", 5], ["july", 6], ["august", 7],
  ["september", 8], ["october", 9], ["november", 10], ["december", 11],
]);

function htmlText(input: string): string {
  return input
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function updatedDate(value: string): string | undefined {
  const match = /^Updated\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/i.exec(value);
  if (!match) return undefined;
  const month = MONTHS.get(match[2]!.toLowerCase());
  const day = Number(match[1]);
  const year = Number(match[3]);
  if (month === undefined || !Number.isInteger(day) || day < 1 || day > 31) return undefined;
  const date = new Date(Date.UTC(year, month, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) return undefined;
  return date.toISOString();
}

/** Converts only exact Gemini Pro model-card rows into the scalar records understood by the rule engine. */
export function parseGoogleDeepMindModelCards(html: string): { models: Array<{ name: string; version: number; updatedAt: string }> } {
  const models: Array<{ name: string; version: number; updatedAt: string }> = [];
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1]!.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((cell) => htmlText(cell[1]!));
    if (cells.length < 2) continue;
    const model = /^Gemini\s+(\d+(?:\.\d+)?)\s+Pro(?:\s+(?:Preview|Experimental))?$/i.exec(cells[0]!);
    const updatedAt = updatedDate(cells[1]!);
    if (!model || !updatedAt) continue;
    const version = Number(model[1]);
    if (!Number.isFinite(version)) continue;
    models.push({ name: cells[0]!, version, updatedAt });
  }
  return { models };
}

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

function selectedPayload(rule: ResolutionRule, payload: unknown): unknown {
  if (!rule.selection) return payload;
  const records = readPath(payload, rule.selection.recordsPath);
  if (!Array.isArray(records)) throw new Error(`Missing records array at ${rule.selection.recordsPath}`);
  const matches = records.filter((record) =>
    compare(scalarAt(record, rule.selection!.keyPath), "eq", rule.selection!.equals),
  );
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one record matching ${rule.selection.keyPath}, received ${matches.length}`);
  }
  return matches[0];
}

function aggregate(rule: ResolutionRule, payload: unknown): { actual: number; eventTime: Date; count: number } {
  const config = rule.aggregation;
  if (!config) throw new Error("Missing aggregation configuration");
  const records = readPath(payload, config.recordsPath);
  if (!Array.isArray(records)) throw new Error(`Missing records array at ${config.recordsPath}`);
  const start = parseTimestamp(config.windowStart);
  const end = parseTimestamp(config.windowEnd);
  if (end < start) throw new Error("Aggregation window ends before it starts");

  const selected: Array<{ value: number; eventTime: Date }> = [];
  for (const record of records) {
    const timestampValue = readPath(record, config.eventAtPath);
    if (timestampValue === undefined) throw new Error(`Missing scalar at ${config.eventAtPath}`);
    const eventTime = parseTimestamp(timestampValue, config.eventAtFormat);
    if (eventTime < start || eventTime > end) continue;
    const raw = readPath(record, config.valuePath);
    if (raw === "" || raw === null) continue;
    if (typeof raw !== "number" && typeof raw !== "string") throw new Error(`Missing scalar at ${config.valuePath}`);
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`Expected numeric source value, received ${String(raw)}`);
    selected.push({ value, eventTime });
  }
  if (selected.length === 0) throw new Error(`No numeric observations in ${config.windowStart}..${config.windowEnd}`);
  return {
    actual: Math.max(...selected.map((item) => item.value)),
    eventTime: new Date(Math.max(...selected.map((item) => item.eventTime.getTime()))),
    count: selected.length,
  };
}

export function extractEvidence(rule: ResolutionRule, payload: unknown, now = new Date()): EvidenceSignal {
  const scopedPayload = selectedPayload(rule, payload);
  let actual: number | string;
  let eventTime: Date;
  let aggregationDetail = "";
  let publicationTime: string | undefined;

  if (rule.aggregation) {
    const result = aggregate(rule, scopedPayload);
    actual = result.actual;
    eventTime = result.eventTime;
    aggregationDetail = ` from ${result.count} observations`;
  } else {
    if (!rule.jsonPath) throw new Error("Scalar rule requires jsonPath");
    actual = scalarAt(scopedPayload, rule.jsonPath);
    if (!rule.eventAtPath) throw new Error("Scalar rule requires eventAtPath");
    eventTime = parseTimestamp(scalarAt(scopedPayload, rule.eventAtPath), rule.eventAtFormat);
  }

  let freshnessTime: Date;
  if (rule.freshness.type === "publication") {
    freshnessTime = parseTimestamp(scalarAt(scopedPayload, rule.freshness.path), rule.freshness.format);
    publicationTime = freshnessTime.toISOString();
  } else {
    freshnessTime = now;
  }

  const conditionsMet = (rule.conditions ?? []).every((condition) =>
    compare(scalarAt(scopedPayload, condition.jsonPath), condition.comparator, condition.threshold),
  );
  const threshold = thresholdAt(scopedPayload, rule.threshold);
  const ageMinutes = (now.getTime() - freshnessTime.getTime()) / 60_000;
  const fresh = ageMinutes >= 0 && ageMinutes <= (rule.maxFreshnessAgeMinutes ?? 15);
  const outcomeTrue = compare(actual, rule.comparator, threshold);
  return {
    id: `${rule.marketId}:${rule.outcomeIdx}:${rule.sourceName}`,
    source: rule.sourceName,
    sourceUrl: rule.sourceUrl,
    eventTime: eventTime.toISOString(),
    freshnessTime: freshnessTime.toISOString(),
    freshnessType: rule.freshness.type,
    publicationTime,
    probability: conditionsMet ? (outcomeTrue ? 0.995 : 0.005) : 0.5,
    confidence: conditionsMet && fresh ? 0.98 : 0,
    detail: conditionsMet
      ? `${String(actual)} ${rule.comparator} ${String(threshold)}${aggregationDetail}; freshness age ${ageMinutes.toFixed(1)}m`
      : `required source condition not met; freshness age ${ageMinutes.toFixed(1)}m`,
  };
}

export async function fetchEvidence(rule: ResolutionRule, retrievedAt?: Date): Promise<EvidenceSignal> {
  const sourceFormat = rule.sourceFormat ?? "json";
  const response = await fetch(rule.sourceUrl, {
    headers: {
      accept: sourceFormat === "json" ? "application/json" : "text/html",
      "user-agent": "settlement-edge/1.0",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`${rule.sourceName} returned HTTP ${response.status}`);
  let payload: unknown;
  if (sourceFormat === "google-deepmind-model-cards") {
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("text/html")) {
      throw new Error(`${rule.sourceName} returned unexpected content type`);
    }
    payload = parseGoogleDeepMindModelCards(await response.text());
  } else {
    try {
      payload = await response.json();
    } catch {
      throw new Error(`${rule.sourceName} returned invalid JSON`);
    }
  }
  const fetchTime = retrievedAt ?? new Date();
  const fetchedAt = fetchTime.toISOString();
  return { ...extractEvidence(rule, payload, fetchTime), fetchedAt };
}
