import "dotenv/config";
import { formatPreflight, preflightPassed, runPreflight } from "./preflight.js";

const results = await runPreflight({ ruleFile: process.argv[2] ?? "config/resolution-rules.json" });
console.log(formatPreflight(results));
process.exitCode = preflightPassed(results) ? 0 : 1;
