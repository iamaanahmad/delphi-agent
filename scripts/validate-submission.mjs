import { access, readFile } from "node:fs/promises";

const required = ["README.md", "docs/architecture.md", "docs/demo-script.md", ".env.example", "LICENSE"];
for (const file of required) await access(file);
const readme = await readFile("README.md", "utf8");
const headings = ["## Problem", "## Solution", "## Architecture", "## Safety", "## Competition readiness"];
for (const heading of headings) {
  if (!readme.includes(heading)) throw new Error(`README is missing ${heading}`);
}
console.log(`Submission structure valid: ${required.length} files and ${headings.length} judge sections checked.`);
