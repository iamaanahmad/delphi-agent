import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";

interface AnalyticsHarness {
  captureSiteEvent: (posthog: { capture: (name: string, properties: Record<string, unknown>) => void }, eventName: string, extra?: Record<string, unknown>) => void;
  loadPostHog: () => void;
  window: {
    posthog: {
      _i: Array<[string, Record<string, unknown>, string]>;
    };
  };
}

function normalize<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function loadHarness(search: string): Promise<AnalyticsHarness> {
  const source = await readFile(new URL("../docs/site-analytics.js", import.meta.url), "utf8");
  const exposed = source.replace(
    "  loadPostHog();\n})();",
    "  globalThis.__analyticsHarness = { captureSiteEvent, loadPostHog, window };\n})();",
  );
  assert.notEqual(exposed, source, "analytics harness hook must match the production loader");

  const window = {
    location: {
      origin: "https://iamaanahmad.github.io",
      pathname: "/delphi-agent/",
      search,
    },
  };
  const document = {
    createElement: () => ({}),
    getElementsByTagName: () => [{ parentNode: { insertBefore: () => undefined } }],
  };
  const context = {
    URL,
    URLSearchParams,
    document,
    globalThis: null as unknown,
    window,
  };
  context.globalThis = context;
  runInNewContext(exposed, context);
  return (context as typeof context & { __analyticsHarness: AnalyticsHarness }).__analyticsHarness;
}

test("marked site analytics use an isolated event namespace and disable automatic live events", async () => {
  const harness = await loadHarness("?analytics_test=true");
  const captured: Array<{ name: string; properties: Record<string, unknown> }> = [];
  harness.captureSiteEvent(
    { capture: (name, properties) => captured.push({ name, properties }) },
    "demo_engaged",
    { component: "decision_receipt" },
  );
  assert.deepEqual(normalize(captured), [
    {
      name: "settlement_edge_test_site_demo_engaged",
      properties: { route: "/delphi-agent/", is_test: true, component: "decision_receipt" },
    },
  ]);

  harness.loadPostHog();
  const initialization = harness.window.posthog._i.at(0);
  assert.ok(initialization);
  const config = initialization[1];
  assert.equal(config.capture_pageview, false);
  assert.equal(config.capture_pageleave, false);
  assert.deepEqual(normalize(config.autocapture), { dom_event_allowlist: [], element_allowlist: ["a", "button"] });
});

test("ordinary visitors retain the existing live site event contract", async () => {
  const harness = await loadHarness("");
  const captured: Array<{ name: string; properties: Record<string, unknown> }> = [];
  harness.captureSiteEvent(
    { capture: (name, properties) => captured.push({ name, properties }) },
    "guide_viewed",
    { guide: "trading-vs-forecasting" },
  );
  assert.deepEqual(normalize(captured), [
    {
      name: "guide_viewed",
      properties: { route: "/delphi-agent/", is_test: false, guide: "trading-vs-forecasting" },
    },
  ]);

  harness.loadPostHog();
  const initialization = harness.window.posthog._i.at(0);
  assert.ok(initialization);
  const config = initialization[1];
  assert.equal(config.capture_pageview, true);
  assert.equal(config.capture_pageleave, true);
  assert.deepEqual(normalize(config.autocapture), { dom_event_allowlist: ["click"], element_allowlist: ["a", "button"] });
});
