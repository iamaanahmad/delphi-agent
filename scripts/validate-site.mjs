import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const pages = [
  {
    path: "docs/index.html",
    canonical: "https://iamaanahmad.github.io/delphi-agent/",
  },
  {
    path: "docs/terms.html",
    canonical: "https://iamaanahmad.github.io/delphi-agent/terms.html",
  },
  {
    path: "docs/privacy.html",
    canonical: "https://iamaanahmad.github.io/delphi-agent/privacy.html",
  },
  {
    path: "docs/prediction-market-trading-agent-vs-forecasting-agent.html",
    canonical: "https://iamaanahmad.github.io/delphi-agent/prediction-market-trading-agent-vs-forecasting-agent.html",
  },
  {
    path: "docs/settlement-edge-vs-gnosis-prediction-market-agent.html",
    canonical: "https://iamaanahmad.github.io/delphi-agent/settlement-edge-vs-gnosis-prediction-market-agent.html",
  },
  {
    path: "docs/competition-record.html",
    canonical: "https://iamaanahmad.github.io/delphi-agent/competition-record.html",
  },
];

for (const page of pages) {
  await access(resolve(root, page.path));
  const html = await readFile(resolve(root, page.path), "utf8");
  if (!html.includes(`<link rel="canonical" href="${page.canonical}">`)) {
    throw new Error(`${page.path} is missing its canonical URL`);
  }
  if (!html.includes('<script defer src="site-analytics.js"></script>')) {
    throw new Error(`${page.path} is missing the privacy-safe visitor analytics loader`);
  }
}

const index = await readFile(resolve(root, "docs/index.html"), "utf8");
const requiredIndexText = [
  "The competition closed on August 23, 2026.",
  "1,000.0000 TST intact",
  "0 submitted orders",
  "0 ambiguous trades",
  "0.0000 TST realized P&amp;L",
  "+1.4292 TST",
  "2.5200 TST simulated cost",
  "supporting evidence, not competition performance",
  "https://github.com/iamaanahmad/delphi-agent",
  'href="competition-record.html"',
  "terms.html",
  "privacy.html",
  "mailto:dorahacks@mail.tin.computer",
];

for (const text of requiredIndexText) {
  if (!index.includes(text)) {
    throw new Error(`docs/index.html is missing required text: ${text}`);
  }
}

for (const staleText of ["Observed on August 21, 2026", "current competition result", "Active reviewed source", "See the Delphi competition"]) {
  if (index.includes(staleText)) {
    throw new Error(`docs/index.html retains stale live-competition text: ${staleText}`);
  }
}

const competitionRecordLinks = index.match(/href="competition-record\.html"/g) ?? [];
if (competitionRecordLinks.length !== 1) {
  throw new Error(`docs/index.html must link to the competition record exactly once; found ${competitionRecordLinks.length}`);
}

const privacy = await readFile(resolve(root, "docs/privacy.html"), "utf8");
for (const text of [
  "Optional lifecycle metrics are disabled by default",
  "does not include wallet addresses, balances, transaction hashes, source URLs, source identifiers, credentials, or free-form failure text",
  "Dry-run, replay, and test events use separate event names and remain outside live competition totals",
  "replay input masking stays on when the managed project enables recording",
  "limited to 280 characters",
  "does not identify visitors",
]) {
  if (!privacy.includes(text)) {
    throw new Error(`docs/privacy.html is missing required telemetry disclosure: ${text}`);
  }
}

const analytics = await readFile(resolve(root, "docs/site-analytics.js"), "utf8");
for (const text of [
  'persistence: "localStorage"',
  'person_profiles: "never"',
  'disable_session_recording: false',
  'maskAllInputs: true',
  'rageclick: true',
  'captureSiteEvent(posthog, "guide_viewed"',
  'captureSiteEvent(posthog, "guide_engaged"',
  'captureSiteEvent(posthog, "demo_engaged"',
  'captureSiteEvent(posthog, "site_state_encountered"',
  'captureSiteEvent(posthog, "feedback_submitted"',
  "posthog.startSessionRecording(true)",
  "What were you hoping to understand about Settlement Edge?",
]) {
  if (!analytics.includes(text)) {
    throw new Error(`docs/site-analytics.js is missing required visitor feedback behavior: ${text}`);
  }
}

if (!analytics.includes("FEEDBACK_MAX_LENGTH = 280") || !analytics.includes("slice(0, FEEDBACK_MAX_LENGTH)")) {
  throw new Error("docs/site-analytics.js must cap deliberate feedback at 280 characters");
}

for (const text of [
  'TEST_EVENT_PREFIX = "settlement_edge_test_site_"',
  "capture_pageview: !isTest",
  "capture_pageleave: !isTest",
  'dom_event_allowlist: isTest ? [] : ["click"]',
  "isTest ? `${TEST_EVENT_PREFIX}${eventName}` : eventName",
  'acquisition_channel: "ai_assistant"',
  'captureSiteEvent(posthog, `referral_${attribution.acquisition_channel}`)',
  "delete event.properties.$referrer",
  "delete event.properties.$initial_referrer",
]) {
  if (!analytics.includes(text)) {
    throw new Error(`docs/site-analytics.js is missing marked-test isolation: ${text}`);
  }
}

const terms = await readFile(resolve(root, "docs/terms.html"), "utf8");
if (!terms.includes("optional operator-configured PostHog metrics host")) {
  throw new Error("docs/terms.html is missing its optional metrics dependency disclosure");
}

const searchPages = [
  {
    path: "docs/prediction-market-trading-agent-vs-forecasting-agent.html",
    canonical: "https://iamaanahmad.github.io/delphi-agent/prediction-market-trading-agent-vs-forecasting-agent.html",
    required: ["Prediction market trading agent vs forecasting agent", "0 live orders", "Simulated receipt"],
  },
  {
    path: "docs/settlement-edge-vs-gnosis-prediction-market-agent.html",
    canonical: "https://iamaanahmad.github.io/delphi-agent/settlement-edge-vs-gnosis-prediction-market-agent.html",
    required: ["Settlement Edge vs Gnosis Prediction Market Agent", "0 TST realized competition P&amp;L", "returns were not assessed here"],
  },
];

const competitionRecord = await readFile(resolve(root, "docs/competition-record.html"), "utf8");
for (const text of [
  "observed unranked",
  "1,000.0000 TST",
  "0 submitted orders",
  "0 ambiguous trades",
  "0.0000 TST",
  "3,393 successful polls",
  "23:58:43.749 UTC",
  "23:59:00.005 UTC",
  "2,530 hash-valid records",
  "25 hash-valid replay records",
  "11 hours 10 minutes",
  "110 ms",
  "115 ms",
  "1.151 s",
  "Later no-trade fault-injection tests",
  "Replay output never enters the score",
  "competition-closing-record.json",
]) {
  if (!competitionRecord.includes(text)) {
    throw new Error(`docs/competition-record.html is missing required competition record text: ${text}`);
  }
}

const closingRecord = JSON.parse(await readFile(resolve(root, "docs/competition-closing-record.json"), "utf8"));
if (
  closingRecord.observedCompetitionResult.standing !== "observed unranked" ||
  closingRecord.observedCompetitionResult.submittedOrders !== 0 ||
  closingRecord.observedCompetitionResult.ambiguousTrades !== 0 ||
  closingRecord.observedCompetitionResult.realizedPnlTst !== "0.0000" ||
  closingRecord.fullWindowSentinel.successfulPolls !== 3393 ||
  closingRecord.ledgers.live.hashChainValid !== true ||
  closingRecord.ledgers.replay.hashChainValid !== true
) {
  throw new Error("docs/competition-closing-record.json does not preserve the verified closing semantics");
}

for (const page of searchPages) {
  const html = await readFile(resolve(root, page.path), "utf8");
  if (!html.includes('href="./"')) {
    throw new Error(`${page.path} is missing its home link`);
  }
  for (const text of page.required) {
    if (!html.includes(text)) {
      throw new Error(`${page.path} is missing required text: ${text}`);
    }
  }
}

if (!index.includes("prediction-market-trading-agent-vs-forecasting-agent.html") || !index.includes("settlement-edge-vs-gnosis-prediction-market-agent.html")) {
  throw new Error("docs/index.html is missing internal links to the search pages");
}

for (const relativePath of ["docs/site.css", "docs/favicon.svg", "docs/settlement-edge-demo.svg", "docs/competition-closing-record.json"]) {
  await access(resolve(root, relativePath));
}

const jsonLdScripts = [...index.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
if (jsonLdScripts.length === 0) {
  throw new Error("docs/index.html is missing JSON-LD structured data");
}

const structuredData = jsonLdScripts.flatMap((match) => {
  const value = JSON.parse(match[1]);
  return Array.isArray(value["@graph"]) ? value["@graph"] : [value];
});

for (const type of ["Organization", "SoftwareApplication"]) {
  if (!structuredData.some((entry) => entry["@type"] === type)) {
    throw new Error(`docs/index.html is missing ${type} structured data`);
  }
}

const software = structuredData.find((entry) => entry["@type"] === "SoftwareApplication");
for (const field of ["name", "url", "description", "applicationCategory", "operatingSystem", "license", "downloadUrl"]) {
  if (!software[field]) {
    throw new Error(`SoftwareApplication structured data is missing ${field}`);
  }
}

const publicFiles = ["docs/robots.txt", "docs/sitemap.xml", "docs/llms.txt"];
for (const relativePath of publicFiles) {
  await access(resolve(root, relativePath));
}

const robots = await readFile(resolve(root, "docs/robots.txt"), "utf8");
if (!robots.includes("User-agent: *") || !robots.includes("Allow: /") || !robots.includes("Sitemap: https://iamaanahmad.github.io/delphi-agent/sitemap.xml")) {
  throw new Error("docs/robots.txt is missing the public crawl or sitemap directive");
}
if (/Disallow:\s*\//.test(robots)) {
  throw new Error("docs/robots.txt blocks a public path");
}

const sitemap = await readFile(resolve(root, "docs/sitemap.xml"), "utf8");
const sitemapUrls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
const canonicalUrls = pages.map((page) => page.canonical);
if (sitemapUrls.length !== canonicalUrls.length || canonicalUrls.some((url) => !sitemapUrls.includes(url))) {
  throw new Error("docs/sitemap.xml does not contain exactly the canonical public pages");
}
if ((sitemap.match(/<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/g) ?? []).length !== canonicalUrls.length) {
  throw new Error("docs/sitemap.xml is missing a valid lastmod for each public page");
}

const llms = await readFile(resolve(root, "docs/llms.txt"), "utf8");
for (const text of ["# Settlement Edge", "0 live orders", "0 TST realized competition profit", ...canonicalUrls]) {
  if (!llms.includes(text)) {
    throw new Error(`docs/llms.txt is missing required text: ${text}`);
  }
}

console.log("Website validation passed: public proof, canonical URLs, discovery files, and structured data are valid.");
