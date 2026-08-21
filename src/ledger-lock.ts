import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export const LEDGER_WRITER_TOKEN_ENV = "SETTLEMENT_EDGE_LEDGER_WRITER_TOKEN";
export const DEFAULT_STALE_LOCK_MS = 60_000;

export interface LedgerWriterOwner {
  version: 1;
  token: string;
  pid: number;
  acquiredAt: string;
  heartbeatAt: string;
  ledgerPath: string;
}

export interface LedgerWriterLease {
  token: string;
  lockDirectory: string;
  ownerFile: string;
  heartbeat: () => Promise<void>;
  release: () => Promise<void>;
}

interface AcquireOptions {
  staleAfterMs?: number;
  now?: () => Date;
  pid?: number;
  token?: string;
  isProcessAlive?: (pid: number) => boolean;
}

export const ledgerLockDirectory = (ledgerPath: string) => `${resolve(ledgerPath)}.writer.lock`;

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readOwner(ownerFile: string): Promise<LedgerWriterOwner> {
  const owner = JSON.parse(await readFile(ownerFile, "utf8")) as Partial<LedgerWriterOwner>;
  if (
    owner.version !== 1
    || typeof owner.token !== "string"
    || typeof owner.pid !== "number"
    || typeof owner.acquiredAt !== "string"
    || typeof owner.heartbeatAt !== "string"
    || typeof owner.ledgerPath !== "string"
  ) {
    throw new Error("ledger writer lock has invalid owner metadata; inspect it before recovery");
  }
  return owner as LedgerWriterOwner;
}

async function writeOwner(ownerFile: string, owner: LedgerWriterOwner): Promise<void> {
  const temporary = `${ownerFile}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(owner, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, ownerFile);
}

export async function assertLedgerWriterAuthorized(
  ledgerPath: string,
  token = process.env[LEDGER_WRITER_TOKEN_ENV],
): Promise<void> {
  const ownerFile = `${ledgerLockDirectory(ledgerPath)}/owner.json`;
  let owner: LedgerWriterOwner;
  try {
    owner = await readOwner(ownerFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      try {
        await stat(ledgerLockDirectory(ledgerPath));
      } catch (lockError) {
        if ((lockError as NodeJS.ErrnoException).code === "ENOENT") return;
        throw lockError;
      }
      throw new Error("ledger writer lease exists without owner metadata; refusing to write");
    }
    throw error;
  }
  if (!token || token !== owner.token) {
    throw new Error(`ledger has an active writer lease owned by PID ${owner.pid}`);
  }
}

export async function acquireLedgerWriterLease(
  ledgerPath: string,
  options: AcquireOptions = {},
): Promise<LedgerWriterLease> {
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_LOCK_MS;
  if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) throw new Error("stale lock timeout must be positive");
  const now = options.now ?? (() => new Date());
  const pid = options.pid ?? process.pid;
  const token = options.token ?? randomUUID();
  const isProcessAlive = options.isProcessAlive ?? processIsAlive;
  const lockDirectory = ledgerLockDirectory(ledgerPath);
  const ownerFile = `${lockDirectory}/owner.json`;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await mkdir(lockDirectory, { recursive: false, mode: 0o700 });
      const timestamp = now().toISOString();
      let owner: LedgerWriterOwner = {
        version: 1,
        token,
        pid,
        acquiredAt: timestamp,
        heartbeatAt: timestamp,
        ledgerPath: resolve(ledgerPath),
      };
      await writeOwner(ownerFile, owner);
      let released = false;
      return {
        token,
        lockDirectory,
        ownerFile,
        heartbeat: async () => {
          if (released) return;
          const current = await readOwner(ownerFile);
          if (current.token !== token) throw new Error("ledger writer lease ownership changed");
          owner = { ...owner, heartbeatAt: now().toISOString() };
          await writeOwner(ownerFile, owner);
        },
        release: async () => {
          if (released) return;
          const current = await readOwner(ownerFile);
          if (current.token !== token) throw new Error("refusing to release another ledger writer's lease");
          const releasedDirectory = `${lockDirectory}.released.${token}`;
          await rename(lockDirectory, releasedDirectory);
          released = true;
          await rm(releasedDirectory, { recursive: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let existing: LedgerWriterOwner;
      try {
        existing = await readOwner(ownerFile);
      } catch (ownerError) {
        if ((ownerError as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error("ledger writer lease exists without owner metadata; inspect it before recovery");
        }
        throw ownerError;
      }
      const heartbeatTime = Date.parse(existing.heartbeatAt);
      if (!Number.isFinite(heartbeatTime)) throw new Error("ledger writer lock heartbeat is invalid; inspect it before recovery");
      const ageMs = now().getTime() - heartbeatTime;
      if (ageMs <= staleAfterMs || isProcessAlive(existing.pid)) {
        throw new Error(`ledger has an active writer lease owned by PID ${existing.pid}`);
      }
      const staleDirectory = `${lockDirectory}.stale.${existing.token}.${randomUUID()}`;
      try {
        await rename(lockDirectory, staleDirectory);
      } catch (renameError) {
        if ((renameError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw renameError;
      }
      await rm(staleDirectory, { recursive: true });
    }
  }
  throw new Error("could not acquire ledger writer lease after stale-lock recovery");
}
