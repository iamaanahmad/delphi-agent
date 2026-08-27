import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";

interface AnalyticsHarness {
  bindPrimaryAction: (posthog: { capture: (name: string, properties: Record<string, unknown>) => void }) => void;
  classifyReferrer: (value: string) => { acquisition_channel: string; referral_source: string };
  captureSiteEvent: (posthog: { capture: (name: string, properties: Record<string, unknown>) => void }, eventName: string, extra?: Record<string, unknown>) => void;
  loadPostHog: () => void;
  sanitizeEvent: (event: { properties: Record<string, unknown> }) => { properties: Record<string, unknown> };
  window: {
    posthog: {
      _i: Array<[string, Record<string, unknown>, string]>;
    };
  };
}

function normalize<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function loadHarness(search: string, referrer = ""): Promise<AnalyticsHarness> {
  const source = await readFile(new URL("../docs/site-analytics.js", import.meta.url), "utf8");
  const exposed = source.replace(
    "  loadPostHog();\n})();",
    "  globalThis.__analyticsHarness = { bindPrimaryAction, classifyReferrer, captureSiteEvent, loadPostHog, sanitizeEvent, window };\n})();",
  );
  assert.notEqual(exposed, source, "analytics harness hook must match the production loader");

  const window = {
    location: {
      origin: "https://iamaanahmad.github.io",
      pathname: "/delphi-agent/",
      search,
    },
    sessionStorage: {
      values: new Map<string, string>(),
      getItem(key: string) {
        return this.values.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        this.values.set(key, value);
      },
    },
  };
  const primaryActionListeners = new Map<string, () => void>();
  const document = {
    referrer,
    createElement: () => ({}),
    getElementsByTagName: () => [{ parentNode: { insertBefore: () => undefined } }],
    querySelector: (selector: string) =>
      selector === "main .hero .primary-action"
        ? {
            addEventListener: (name: string, listener: () => void) => primaryActionListeners.set(name, listener),
          }
        : null,
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
  const harness = (context as typeof context & { __analyticsHarness: AnalyticsHarness }).__analyticsHarness;
  return Object.assign(harness, { primaryActionListeners });
}

test("homepage primary action emits one explicit outcome event with bounded properties", async () => {
  const harness = (await loadHarness("?analytics_test=true&analytics_test_source=chatgpt")) as AnalyticsHarness & {
    primaryActionListeners: Map<string, () => void>;
  };
  const captured: Array<{ name: string; properties: Record<string, unknown> }> = [];
  harness.bindPrimaryAction({ capture: (name, properties) => captured.push({ name, properties }) });
  harness.primaryActionListeners.get("click")?.();

  assert.deepEqual(normalize(captured), [
    {
      name: "settlement_edge_test_site_primary_cta_clicked",
      properties: {
        route: "/delphi-agent/",
        is_test: true,
        acquisition_channel: "ai_assistant",
        referral_source: "chatgpt",
        cta: "view_open_source_agent",
        destination: "github_repository",
      },
    },
  ]);
});

test("marked site analytics use an isolated event namespace and disable automatic live events", async () => {
  const harness = await loadHarness("?analytics_test=true&analytics_test_source=chatgpt");
  const captured: Array<{ name: string; properties: Record<string, unknown> }> = [];
  harness.captureSiteEvent(
    { capture: (name, properties) => captured.push({ name, properties }) },
    "demo_engaged",
    { component: "decision_receipt" },
  );
  harness.captureSiteEvent({ capture: (name, properties) => captured.push({ name, properties }) }, "referral_ai_assistant");
  assert.deepEqual(normalize(captured), [
    {
      name: "settlement_edge_test_site_demo_engaged",
      properties: {
        route: "/delphi-agent/",
        is_test: true,
        acquisition_channel: "ai_assistant",
        referral_source: "chatgpt",
        component: "decision_receipt",
      },
    },
    {
      name: "settlement_edge_test_site_referral_ai_assistant",
      properties: {
        route: "/delphi-agent/",
        is_test: true,
        acquisition_channel: "ai_assistant",
        referral_source: "chatgpt",
      },
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
      properties: {
        route: "/delphi-agent/",
        is_test: false,
        acquisition_channel: "direct",
        referral_source: "direct",
        guide: "trading-vs-forecasting",
      },
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

test("referrers map to bounded AI, search, direct, and other attribution", async () => {
  const harness = await loadHarness("");
  assert.deepEqual(normalize(harness.classifyReferrer("https://chatgpt.com/c/secret?prompt=private")), {
    acquisition_channel: "ai_assistant",
    referral_source: "chatgpt",
  });
  assert.deepEqual(normalize(harness.classifyReferrer("https://www.google.co.uk/search?q=settlement+edge")), {
    acquisition_channel: "search",
    referral_source: "search",
  });
  assert.deepEqual(normalize(harness.classifyReferrer("")), {
    acquisition_channel: "direct",
    referral_source: "direct",
  });
  assert.deepEqual(normalize(harness.classifyReferrer("https://example.com/private/path?token=secret")), {
    acquisition_channel: "other",
    referral_source: "other",
  });
});

test("event sanitization removes raw referrers and keeps bounded attribution", async () => {
  const harness = await loadHarness("", "https://claude.ai/chat/secret?prompt=private");
  const sanitized = harness.sanitizeEvent({
    properties: {
      $current_url: "https://iamaanahmad.github.io/delphi-agent/?campaign=private",
      $referrer: "https://claude.ai/chat/secret?prompt=private",
      $initial_referrer: "https://claude.ai/chat/secret?prompt=private",
    },
  });
  assert.deepEqual(normalize(sanitized.properties), {
    $current_url: "https://iamaanahmad.github.io/delphi-agent/",
    acquisition_channel: "ai_assistant",
    referral_source: "claude",
  });
});
