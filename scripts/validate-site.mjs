import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const pages = ["docs/index.html", "docs/terms.html", "docs/privacy.html"];

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

for (const relativePath of ["docs/site.css", "docs/favicon.svg", "docs/settlement-edge-demo.svg"]) {
  await access(resolve(root, relativePath));
}

console.log("Website validation passed: public proof, links, and legal pages are present.");
