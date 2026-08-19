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
];

for (const page of pages) {
  await access(resolve(root, page.path));
  const html = await readFile(resolve(root, page.path), "utf8");
  if (!html.includes(`<link rel="canonical" href="${page.canonical}">`)) {
    throw new Error(`${page.path} is missing its canonical URL`);
  }
}

const index = await readFile(resolve(root, "docs/index.html"), "utf8");
const requiredIndexText = [
  "0 live orders",
  "0 TST",
  "+1.4292 TST",
  "2.5200 TST simulated cost",
  "https://github.com/iamaanahmad/delphi-agent",
  "https://dorahacks.io/hackathon/delphi-agent-competition/detail",
  "terms.html",
  "privacy.html",
  "mailto:dorahacks@mail.tin.computer",
];

for (const text of requiredIndexText) {
  if (!index.includes(text)) {
    throw new Error(`docs/index.html is missing required text: ${text}`);
  }
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

for (const relativePath of ["docs/site.css", "docs/favicon.svg", "docs/settlement-edge-demo.svg"]) {
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
