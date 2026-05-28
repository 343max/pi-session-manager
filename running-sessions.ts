import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFile } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const RUNNING_DIR = join(tmpdir(), "pi-running-sessions");

interface ActiveSessionInfo {
  sessionId: string;
  sessionName: string;
  cwd: string;
  terminal: "wezterm" | "unknown";
  paneId: string | null;
  pid: number;
  startedAt: string;
  unreadOutput: boolean;
}

function ensureDir(): void {
  if (!existsSync(RUNNING_DIR)) {
    mkdirSync(RUNNING_DIR, { recursive: true });
  }
}

export function deregisterSession(sessionId: string): void {
  const file = join(RUNNING_DIR, `${sessionId}.json`);
  try {
    unlinkSync(file);
  } catch {
    // already gone — fine
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function cleanupStaleSessions(): void {
  ensureDir();
  for (const entry of readdirSync(RUNNING_DIR)) {
    if (!entry.endsWith(".json")) continue;
    const file = join(RUNNING_DIR, entry);
    try {
      const raw = readFileSync(file, "utf-8");
      const info = JSON.parse(raw) as ActiveSessionInfo;
      if (!isProcessAlive(info.pid)) {
        unlinkSync(file);
      }
    } catch {
      // corrupt or unreadable — remove
      try { unlinkSync(file); } catch { /* ignore */ }
    }
  }
}

export function listActiveSessions(): ActiveSessionInfo[] {
  cleanupStaleSessions();
  ensureDir();
  const sessions: ActiveSessionInfo[] = [];
  for (const entry of readdirSync(RUNNING_DIR)) {
    if (!entry.endsWith(".json")) continue;
    const file = join(RUNNING_DIR, entry);
    try {
      const raw = readFileSync(file, "utf-8");
      const info = JSON.parse(raw) as ActiveSessionInfo;
      // double-check liveness (cleanupStale already ran, but belt-and-suspenders)
      if (isProcessAlive(info.pid)) {
        sessions.push(info);
      } else {
        unlinkSync(file);
      }
    } catch {
      try { unlinkSync(file); } catch { /* ignore */ }
    }
  }
  // most recent first
  sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return sessions;
}

export function getActiveSessionIds(): Set<string> {
  return new Set(listActiveSessions().map((s) => s.sessionId));
}

// ── In-memory session state manager ──────────────────────────────

let currentState: ActiveSessionInfo | null = null;

/** Write state to disk. Async, fire-and-forget. */
function writeSessionState(state: ActiveSessionInfo): void {
  ensureDir();
  const file = join(RUNNING_DIR, `${state.sessionId}.json`);
  writeFile(file, JSON.stringify(state, null, 2), () => {});
}

/** Set initial state and write to disk. */
export function initSessionState(info: ActiveSessionInfo): void {
  currentState = info;
  writeSessionState(info);
}

/** Merge partial update into in-memory state and write to disk. */
export function updateSessionState(update: Partial<ActiveSessionInfo>): void {
  if (!currentState) return;
  currentState = { ...currentState, ...update };
  writeSessionState(currentState);
}

/** Read current in-memory state. */
export function getSessionState(): ActiveSessionInfo | null {
  return currentState;
}

/** Deregister and clear. */
export function clearSessionState(): void {
  if (currentState) {
    deregisterSession(currentState.sessionId);
  }
  currentState = null;
}

export type { ActiveSessionInfo };
