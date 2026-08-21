import { access, readFile } from "node:fs/promises";

const required = ["README.md", "docs/architecture.md", "docs/demo-script.md", "docs/competition-cutoffs.md", ".env.example", "LICENSE"];
for (const file of required) await access(file);
const readme = await readFile("README.md", "utf8");
const demoScript = await readFile("docs/demo-script.md", "utf8");
const competitionCutoffs = await readFile("docs/competition-cutoffs.md", "utf8");
const headings = ["## Problem", "## Solution", "## Architecture", "## Safety", "## Competition readiness"];
for (const heading of headings) {
  if (!readme.includes(heading)) throw new Error(`README is missing ${heading}`);
}

const observedStatus = "0 live orders, 0 TST realized competition P&L, 1,000 TST available in the registered wallet, and 70 passing tests";
for (const [name, content] of [["README", readme], ["demo script", demoScript]]) {
  if (!content.includes(observedStatus)) throw new Error(`${name} is missing the current observed competition status`);
  if (!content.includes("1.4292 TST") || !content.includes("simulated")) {
    throw new Error(`${name} must label the 1.4292 TST replay result as simulated`);
  }
}

for (const requiredCutoff of [
  "August 23, 2026 at 23:59 UTC",
  "No exact UTC cutoff is published",
  "No GitHub repository, code review, video, or BUIDL submission is required",
]) {
  if (!competitionCutoffs.includes(requiredCutoff)) {
    throw new Error(`competition cutoffs are missing: ${requiredCutoff}`);
  }
}
console.log(`Submission structure valid: ${required.length} files and ${headings.length} judge sections checked.`);
