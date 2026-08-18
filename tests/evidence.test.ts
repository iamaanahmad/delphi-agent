import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { compare, extractEvidence, readPath } from "../src/evidence.js";
import type { ResolutionRule } from "../src/types.js";

const loadJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(new URL(path, import.meta.url), "utf8")) as unknown;

const liveRules = async (): Promise<ResolutionRule[]> =>
  JSON.parse(await readFile(new URL("../config/resolution-rules.json", import.meta.url), "utf8")) as ResolutionRule[];

test("reads nested object and array paths", () => {
  assert.equal(readPath({ data: [{ value: 42 }] }, "data.0.value"), 42);
});

test("evaluates numeric and string settlement rules", () => {
  assert.equal(compare(101, "gte", 100), true);
  assert.equal(compare("settled", "eq", "SETTLED"), true);
  assert.equal(compare(99, "gt", 100), false);
});

test("reviewed fixtures match all three live Yes outcomes", async () => {
  const rules = await liveRules();
  const fixture = await loadJson("../fixtures/live-rules/match.json") as Record<string, unknown>;
  assert.equal(rules.length, 3);
  assert.deepEqual(rules.map((rule) => rule.marketId), [
    "0x7fb6eb62585de2fde740bfe4b4bae0c279919021",
    "0x360274d153c58566943cb21088dd95e45638bda3",
    "0xbf1ce7c9d751b92bfac4acefe0e87d82b1d30163",
  ]);
  const observations = [
    extractEvidence(rules[0]!, fixture.wikimedia, new Date("2026-08-18T23:00:00Z")),
    extractEvidence(rules[1]!, fixture.noaa, new Date("2026-08-21T00:00:00Z")),
    extractEvidence(rules[2]!, fixture.mls, new Date("2026-08-20T02:00:00Z")),
  ];
  for (const observation of observations) {
    assert.equal(observation.probability, 0.995);
    assert.equal(observation.confidence, 0.98);
  }
  assert.match(observations[1]!.detail, /5\.181 gt 5\.18 from 3 observations/);
});

test("reviewed fixtures preserve exact non-match boundaries", async () => {
  const rules = await liveRules();
  const fixture = await loadJson("../fixtures/live-rules/non-match.json") as Record<string, unknown>;
  const observations = [
    extractEvidence(rules[0]!, fixture.wikimedia, new Date("2026-08-18T23:00:00Z")),
    extractEvidence(rules[1]!, fixture.noaa, new Date("2026-08-21T00:00:00Z")),
    extractEvidence(rules[2]!, fixture.mls, new Date("2026-08-20T02:00:00Z")),
  ];
  assert.deepEqual(observations.map((item) => item.probability), [0.005, 0.005, 0.005]);
});

test("stale reviewed evidence is retained but cannot carry confidence", async () => {
  const rules = await liveRules();
  const fixture = await loadJson("../fixtures/live-rules/stale.json");
  const observation = extractEvidence(rules[0]!, fixture, new Date("2026-08-20T00:01:00Z"));
  assert.equal(observation.probability, 0.995);
  assert.equal(observation.confidence, 0);
  assert.equal(observation.observedAt, "2026-08-18T00:00:00.000Z");
});

test("malformed aggregate source data fails closed", async () => {
  const rules = await liveRules();
  const fixture = await loadJson("../fixtures/live-rules/malformed.json");
  assert.throws(
    () => extractEvidence(rules[1]!, fixture, new Date("2026-08-21T00:00:00Z")),
    /Expected numeric source value|Missing scalar/,
  );
});

test("a scheduled MLS match is not treated as a draw", async () => {
  const rules = await liveRules();
  const fixture = await loadJson("../fixtures/live-rules/non-match.json") as { mls: Record<string, unknown> };
  const match = fixture.mls.match_information as Record<string, unknown>;
  match.match_status = "scheduled";
  const observation = extractEvidence(rules[2]!, fixture.mls, new Date("2026-08-20T00:00:00Z"));
  assert.equal(observation.probability, 0.5);
  assert.equal(observation.confidence, 0);
});
