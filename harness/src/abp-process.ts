// mind2web/harness/src/abp-process.ts
//
// ABP (Agent Browser Protocol) process lifecycle, owned by the TypeScript
// harness instead of an external bash driver.
//
// Each task gets a FRESH ABP process (fresh user-data-dir + session-dir) so
// GPU/browser state never accumulates across tasks — the degradation that
// crashed long-lived ABP sessions after dozens of screenshot readbacks. Cold
// start is ~2-3s, negligible vs ~170s/task.

import { spawn, spawnSync, execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface AbpLaunchOptions {
  /** Absolute path to the ABP chrome binary. */
  binPath: string;
  /** Port for --abp-port and the readiness poll. */
  port: number;
  /** How long to wait for readiness before giving up (default 45s). */
  readyTimeoutMs?: number;
  /** File to append ABP stdout/stderr to (default /tmp/abp-managed.log). */
  logPath?: string;
}

export interface AbpProcess {
  pid: number;
  port: number;
  /** SIGKILL the process group (incl. Chrome children) and free the port. */
  kill: () => Promise<void>;
}

async function isReady(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/api/v1/browser/status`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return false;
    const j = (await res.json()) as { data?: { ready?: boolean } };
    return j?.data?.ready === true;
  } catch {
    return false;
  }
}

/** Best-effort: kill any stray ABP chrome processes (e.g. from a prior crash). */
async function killStray(): Promise<void> {
  try {
    await execFileP("pkill", ["-9", "-f", "abp-chrome/abp"]);
  } catch {
    /* pkill exits non-zero when nothing matched — that's fine */
  }
}

/** Synchronous stray kill, for signal handlers where async won't complete. */
export function killStraySync(): void {
  try {
    spawnSync("pkill", ["-9", "-f", "abp-chrome/abp"]);
  } catch {
    /* ignore */
  }
}

/** Poll until the status endpoint stops reporting ready (port released). */
async function waitPortFree(port: number, tries = 10): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (!(await isReady(port))) return;
    await sleep(1000);
  }
}

function killGroup(pid: number): void {
  // `detached: true` makes the child a process-group leader; killing the
  // negated pid takes the whole group (Chrome's helper processes) with it.
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    /* group already gone */
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

/**
 * Launch a fresh ABP process and resolve once it reports ready. Throws if it
 * does not become ready within readyTimeoutMs (after cleaning up).
 */
export async function launchAbp(opts: AbpLaunchOptions): Promise<AbpProcess> {
  const readyTimeoutMs = opts.readyTimeoutMs ?? 45_000;
  const logPath = opts.logPath ?? "/tmp/abp-managed.log";

  // Clear any stray ABP holding the port, then wait for it to actually free.
  await killStray();
  await waitPortFree(opts.port);

  const userDataDir = await mkdtemp(join(tmpdir(), "abp-udd-"));
  const sessionDir = await mkdtemp(join(tmpdir(), "abp-sess-"));
  const cleanup = async () => {
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    await rm(sessionDir, { recursive: true, force: true }).catch(() => {});
  };

  const logFd = openSync(logPath, "a");
  const child = spawn(
    opts.binPath,
    [
      `--abp-port=${opts.port}`,
      "--use-mock-keychain",
      `--user-data-dir=${userDataDir}`,
      `--abp-session-dir=${sessionDir}`,
    ],
    { detached: true, stdio: ["ignore", logFd, logFd] },
  );
  closeSync(logFd); // the child keeps its own dup of the fd
  child.unref();

  // ABP/Chrome re-execs and forks helper processes, so the initial spawned
  // process can "exit" while the browser keeps running. Readiness is therefore
  // judged by the PORT, never the launcher process (this is what the bash
  // driver did). Only a spawn 'error' (e.g. missing binary) is fatal — an
  // unhandled 'error' event would otherwise throw uncaught.
  let spawnError: Error | null = null;
  child.on("error", (e) => {
    spawnError = e;
  });

  const pid = child.pid;
  if (!pid) {
    await cleanup();
    throw new Error("Failed to spawn ABP (no pid)");
  }

  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    if (spawnError) break;
    if (await isReady(opts.port)) {
      return {
        pid,
        port: opts.port,
        kill: async () => {
          killGroup(pid);
          await killStray();
          await waitPortFree(opts.port);
          await cleanup();
        },
      };
    }
    await sleep(1000);
  }

  killGroup(pid);
  await killStray();
  await cleanup();
  const err = spawnError as Error | null;
  throw new Error(
    err
      ? `Failed to spawn ABP (${err.message})`
      : `ABP did not become ready on port ${opts.port} within ${readyTimeoutMs}ms (see ${logPath})`,
  );
}
