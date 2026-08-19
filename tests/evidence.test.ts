import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { compare, extractEvidence, parseGoogleDeepMindModelCards, readPath } from "../src/evidence.js";
import type { ResolutionRule } from "../src/types.js";

const loadJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(new URL(path, import.meta.url), "utf8")) as unknown;

const liveRules = async (): Promise<ResolutionRule[]> =>
  JSON.parse(await readFile(new URL("../config/resolution-rules.json", import.meta.url), "utf8")) as ResolutionRule[];

const postCloseRules = async (): Promise<ResolutionRule[]> =>
  JSON.parse(await readFile(new URL("../fixtures/live-rules/post-close-rules.json", import.meta.url), "utf8")) as ResolutionRule[];

test("reads nested object and array paths", () => {
  assert.equal(readPath({ data: [{ value: 42 }] }, "data.0.value"), 42);
});

test("evaluates numeric and string settlement rules", () => {
  assert.equal(compare(101, "gte", 100), true);
  assert.equal(compare("settled", "eq", "SETTLED"), true);
  assert.equal(compare(99, "gt", 100), false);
});

test("reviewed fixtures preserve both retired post-close Yes outcomes", async () => {
  const rules = await postCloseRules();
  const fixture = await loadJson("../fixtures/live-rules/match.json") as Record<string, unknown>;
  assert.equal(rules.length, 2);
  assert.deepEqual(rules.map((rule) => rule.marketId), [
    "0x360274d153c58566943cb21088dd95e45638bda3",
    "0xbf1ce7c9d751b92bfac4acefe0e87d82b1d30163",
  ]);
  const observations = [
    extractEvidence(rules[0]!, fixture.noaa, new Date("2026-08-21T00:00:00Z")),
    extractEvidence(rules[1]!, fixture.mls, new Date("2026-08-20T02:00:00Z")),
  ];
  for (const observation of observations) {
    assert.equal(observation.probability, 0.995);
    assert.equal(observation.confidence, 0.98);
  }
  assert.match(observations[0]!.detail, /5\.181 gt 5\.18 from 3 observations/);
});

test("reviewed fixtures preserve exact non-match boundaries", async () => {
  const rules = await postCloseRules();
  const fixture = await loadJson("../fixtures/live-rules/non-match.json") as Record<string, unknown>;
  const observations = [
    extractEvidence(rules[0]!, fixture.noaa, new Date("2026-08-21T00:00:00Z")),
    extractEvidence(rules[1]!, fixture.mls, new Date("2026-08-20T02:00:00Z")),
  ];
  assert.deepEqual(observations.map((item) => item.probability), [0.005, 0.005]);
});

test("a freshly retrieved older event can carry confidence", async () => {
  const fixture = await loadJson("../fixtures/live-rules/stale.json");
  const historicalRule: ResolutionRule = {
    marketId: "0x7fb6eb62585de2fde740bfe4b4bae0c279919021",
    outcomeIdx: 0,
    sourceName: "Wikimedia Pageviews API",
    sourceUrl: "https://wikimedia.org/api/rest_v1/metrics/pageviews/",
    jsonPath: "items.0.views",
    comparator: "gt",
    threshold: 2250,
    eventAtPath: "items.0.timestamp",
    eventAtFormat: "wikimedia-hour",
    freshness: { type: "retrieval" },
  };
  const observation = extractEvidence(historicalRule, fixture, new Date("2026-08-20T00:01:00Z"));
  assert.equal(observation.probability, 0.995);
  assert.equal(observation.confidence, 0.98);
  assert.equal(observation.eventTime, "2026-08-18T00:00:00.000Z");
  assert.equal(observation.freshnessTime, "2026-08-20T00:01:00.000Z");
  assert.equal(observation.freshnessType, "retrieval");
});

const publicationRule: ResolutionRule = {
  marketId: "0x1111111111111111111111111111111111111111",
  outcomeIdx: 0,
  sourceName: "Published source",
  sourceUrl: "https://example.test/data.json",
  jsonPath: "value",
  comparator: "gte",
  threshold: 1,
  eventAtPath: "event_at",
  freshness: { type: "publication", path: "published_at" },
  maxFreshnessAgeMinutes: 15,
};

test("fresh publication of an older event passes at the freshness boundary", () => {
  const observation = extractEvidence(publicationRule, {
    value: 2,
    event_at: "2026-08-01T00:00:00Z",
    published_at: "2026-08-18T00:00:00Z",
  }, new Date("2026-08-18T00:15:00Z"));
  assert.equal(observation.eventTime, "2026-08-01T00:00:00.000Z");
  assert.equal(observation.freshnessTime, "2026-08-18T00:00:00.000Z");
  assert.equal(observation.publicationTime, "2026-08-18T00:00:00.000Z");
  assert.equal(observation.confidence, 0.98);
});

test("stale and future publication timestamps cannot carry confidence", () => {
  const payload = { value: 2, event_at: "2026-08-01T00:00:00Z" };
  const stale = extractEvidence(publicationRule, {
    ...payload,
    published_at: "2026-08-18T00:00:00Z",
  }, new Date("2026-08-18T00:15:00.001Z"));
  const future = extractEvidence(publicationRule, {
    ...payload,
    published_at: "2026-08-18T00:00:00.001Z",
  }, new Date("2026-08-18T00:00:00Z"));
  assert.equal(stale.confidence, 0);
  assert.equal(future.confidence, 0);
});

test("absent and malformed publication timestamps fail closed", () => {
  const payload = { value: 2, event_at: "2026-08-01T00:00:00Z" };
  assert.throws(
    () => extractEvidence(publicationRule, payload, new Date("2026-08-18T00:00:00Z")),
    /Missing scalar at published_at/,
  );
  assert.throws(
    () => extractEvidence(publicationRule, { ...payload, published_at: "not-a-date" }, new Date("2026-08-18T00:00:00Z")),
    /Invalid source timestamp/,
  );
});

test("malformed aggregate source data fails closed", async () => {
  const rules = await postCloseRules();
  const fixture = await loadJson("../fixtures/live-rules/malformed.json");
  assert.throws(
    () => extractEvidence(rules[0]!, fixture, new Date("2026-08-21T00:00:00Z")),
    /Expected numeric source value|Missing scalar/,
  );
});

test("a scheduled MLS match is not treated as a draw", async () => {
  const rules = await postCloseRules();
  const fixture = await loadJson("../fixtures/live-rules/non-match.json") as { mls: Record<string, unknown> };
  const match = (fixture.mls.schedule as Array<Record<string, unknown>>)[0]!;
  match.match_status = "scheduled";
  const observation = extractEvidence(rules[1]!, fixture.mls, new Date("2026-08-20T00:00:00Z"));
  assert.equal(observation.probability, 0.5);
  assert.equal(observation.confidence, 0);
});

test("MLS selection fails closed unless exactly one match id is present", async () => {
  const rules = await postCloseRules();
  const fixture = await loadJson("../fixtures/live-rules/match.json") as { mls: { schedule: unknown[] } };
  const mlsRule = rules[1]!;
  assert.throws(
    () => extractEvidence(mlsRule, { schedule: [] }, new Date("2026-08-20T02:00:00Z")),
    /Expected exactly one record.*received 0/,
  );
  assert.throws(
    () => extractEvidence(mlsRule, { schedule: [fixture.mls.schedule[0], fixture.mls.schedule[0]] }, new Date("2026-08-20T02:00:00Z")),
    /Expected exactly one record.*received 2/,
  );
});

test("Google DeepMind model-card rows expose only exact Gemini Pro versions", async () => {
  const rules = await liveRules();
  assert.equal(rules.length, 1);
  const rule = rules[0]!;
  const payload = parseGoogleDeepMindModelCards(`
    <table><tbody>
      <tr><th scope="row">Gemini 3.5 Flash</th><td>Updated 18 August 2026</td></tr>
      <tr><th scope="row">Gemini 3 Pro</th><td>Updated 18 August 2026</td></tr>
      <tr><th scope="row">Gemini 3.5 Pro</th><td>Updated 20 August 2026</td></tr>
      <tr><th scope="row">Gemini 4 Pro Image</th><td>Updated 20 August 2026</td></tr>
    </tbody></table>
  `);
  assert.deepEqual(payload.models, [
    { name: "Gemini 3 Pro", version: 3, updatedAt: "2026-08-18T00:00:00.000Z" },
    { name: "Gemini 3.5 Pro", version: 3.5, updatedAt: "2026-08-20T00:00:00.000Z" },
  ]);
  const observation = extractEvidence(rule, payload, new Date("2026-08-20T12:00:00Z"));
  assert.equal(observation.probability, 0.995);
  assert.equal(observation.confidence, 0.98);
});

test("Google DeepMind model-card extraction rejects ambiguous and post-cutoff rows", async () => {
  const rules = await liveRules();
  const rule = rules[0]!;
  const payload = parseGoogleDeepMindModelCards(`
    <table><tbody>
      <tr><th scope="row">Gemini 3.5 Pro</th><td>Coming soon</td></tr>
      <tr><th scope="row">Gemini 4 Pro</th><td>Updated 21 August 2026</td></tr>
      <tr><th scope="row">Nano Banana Pro</th><td>Updated 20 August 2026</td></tr>
    </tbody></table>
  `);
  assert.deepEqual(payload.models, [{ name: "Gemini 4 Pro", version: 4, updatedAt: "2026-08-21T00:00:00.000Z" }]);
  assert.throws(
    () => extractEvidence(rule, payload, new Date("2026-08-21T01:00:00Z")),
    /No numeric observations/,
  );
});
