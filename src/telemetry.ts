import { appendLedgerRecord, type TelemetryLedgerRecord } from "./receipt.js";
import { captureTelemetryPoints, loadMetricsConfig, readTelemetryPoints } from "./metrics.js";

export interface TelemetryContext {
  runId: string;
  environment: TelemetryLedgerRecord["environment"];
}

export async function appendTelemetry(
  record: Omit<TelemetryLedgerRecord, "type" | "schemaVersion">,
  path?: string,
  timestamp = new Date(),
): Promise<string> {
  const telemetryRecord: TelemetryLedgerRecord = { type: "telemetry", schemaVersion: 1, ...record };
  const hash = await appendLedgerRecord(telemetryRecord, path, timestamp);
  const config = loadMetricsConfig();
  if (config.enabled) {
    try {
      const verified = (await readTelemetryPoints(path)).find((point) => point.hash === hash);
      if (!verified) throw new Error("new telemetry record was not found after ledger verification");
      await captureTelemetryPoints([verified], config);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Settlement Edge metrics warning: ${detail}. The hash-linked ledger remains the retry source.\n`);
    }
  }
  return hash;
}
