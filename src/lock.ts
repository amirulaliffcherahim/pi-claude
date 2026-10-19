import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";

const STALE_LOCK_MS = 30_000;
const MAX_WAIT_MS = 8_000;

export interface CredentialLock {
  release(): Promise<void>;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return code === "EPERM";
  }
}

function tryBreakStaleLock(lockPath: string): void {
  try {
    const stat = statSync(lockPath);
    const ageMs = Date.now() - stat.mtimeMs;
    const raw = readFileSync(lockPath, "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    if (ageMs > STALE_LOCK_MS || (Number.isInteger(pid) && !isPidAlive(pid))) {
      unlinkSync(lockPath);
    }
  } catch {
    // Already gone or unreadable
  }
}

export async function acquireCredentialLock(lockPath: string): Promise<CredentialLock> {
  const start = Date.now();
  let delay = 50;

  for (;;) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        writeSync(fd, `${process.pid}\n`);
      } finally {
        closeSync(fd);
      }
      let released = false;
      return {
        async release() {
          if (released) return;
          released = true;
          try {
            unlinkSync(lockPath);
          } catch {
            // Ignore
          }
        },
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== "EEXIST") throw error;
      tryBreakStaleLock(lockPath);
      if (Date.now() - start >= MAX_WAIT_MS) {
        return {
          async release() {},
        };
      }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 500);
    }
  }
}
