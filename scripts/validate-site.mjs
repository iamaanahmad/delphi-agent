import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const pages = [
  "docs/index.html",
  "docs/terms.html",
  "docs/privacy.html",
  "docs/prediction-market-trading-agent-vs-forecasting-agent.html",
  "docs/settlement-edge-vs-gnosis-prediction-market-agent.html",
];

for (const page of pages) {
  await access(resolve(root, page));
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
  if (!html.includes(`<link rel="canonical" href="${page.canonical}">`)) {
    throw new Error(`${page.path} is missing its canonical URL`);
  }
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

console.log("Website validation passed: public proof, links, and legal pages are present.");
