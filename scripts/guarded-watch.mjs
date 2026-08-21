// Backward-compatible entry point for existing operator commands.
// Run with tsx so the TypeScript supervisor owns recovery and the ledger lease.
await import("../src/supervisor-cli.ts");
