import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface WatcherHeartbeat {
  version: 1;
  token: string;
  pid: number;
  status: "running" | "stopped";
  timestamp: string;
  reason?: string;
}

export async function writeWatcherHeartbeat(path: string, heartbeat: WatcherHeartbeat): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(heartbeat, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

export function startWatcherHeartbeat(path: string, token: string, intervalMs: number, onError?: (error: Error) => void) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error("heartbeat interval must be positive");
  let stopped = false;
  let failed = false;
  let pending = Promise.resolve();
  const write = (status: WatcherHeartbeat["status"], reason?: string) => {
    pending = pending.then(() => writeWatcherHeartbeat(path, {
      version: 1,
      token,
      pid: process.pid,
      status,
      timestamp: new Date().toISOString(),
      ...(reason ? { reason } : {}),
    }));
    void pending.catch((error: unknown) => {
      if (failed) return;
      failed = true;
      onError?.(error instanceof Error ? error : new Error(String(error)));
    });
    return pending;
  };
  void write("running");
  const timer = setInterval(() => void write("running"), intervalMs);
  timer.unref();
  return {
    stop: async (reason: string) => {
      if (stopped) return pending;
      stopped = true;
      clearInterval(timer);
      await write("stopped", reason);
    },
  };
}
