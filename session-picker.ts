import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { spawn } from "child_process";
import {
  registerSession,
  deregisterSession,
  cleanupStaleSessions,
  listActiveSessions,
  getActiveSessionIds,
} from "./running-sessions";

const MAX_SESSIONS = 20;

function sessionToJSON(s: SessionInfo, activeIds: Set<string>): Record<string, unknown> {
  const status = activeIds.has(s.id) ? "active" : "stopped";
  return {
    id: s.id,
    name: s.name || s.firstMessage?.slice(0, 50) || null,
    cwd: s.cwd,
    created: s.created.toISOString(),
    modified: s.modified.toISOString(),
    messageCount: s.messageCount,
    firstMessage: s.firstMessage || null,
    path: s.path,
    status,
  };
}

// ── Activation ──────────────────────────────────────────────────────

function activatePane(paneId: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const cli = spawn("wezterm", ["cli", "activate-pane", "--pane-id", paneId], {
      stdio: "ignore",
      detached: true,
    });
    cli.on("error", () => resolve({ ok: false, error: "wezterm not found" }));
    cli.on("close", (code) =>
      resolve({ ok: code === 0, error: code !== 0 ? `exit code ${code}` : undefined }),
    );
  });
}

function spawnInWezterm(cwd: string, sessionId: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const cli = spawn(
      "wezterm",
      ["cli", "spawn", "--cwd", cwd, "--", "pi", "--session", sessionId],
      { stdio: "ignore", detached: true },
    );

    cli.on("error", () => {
      // cli spawn might fail if no GUI wezterm is running — try start
      const win = spawn("wezterm", ["start", "--cwd", cwd, "--", "pi", "--session", sessionId], {
        stdio: "ignore",
        detached: true,
      });
      win.on("error", () => resolve({ ok: false, error: "wezterm not found" }));
      win.on("close", (code) =>
        resolve({
          ok: code === 0,
          error: code !== 0 ? `exit code ${code}` : undefined,
        }),
      );
    });

    cli.on("close", (code) =>
      resolve({
        ok: code === 0,
        error: code !== 0 ? `exit code ${code}` : undefined,
      }),
    );
  });
}

interface ActivateResult {
  action: "activate-pane" | "spawn" | "unknown-terminal" | "not-found";
  error?: string;
}

async function resolveAndActivate(
  sessionId: string,
  ctx?: ExtensionContext,
): Promise<ActivateResult> {
  // 1. Check active sessions
  const activeSessions = listActiveSessions();
  const active = activeSessions.find(
    (s) => s.sessionId === sessionId || s.sessionId.startsWith(sessionId),
  );

  if (active) {
    if (active.terminal === "wezterm" && active.paneId) {
      const result = await activatePane(active.paneId);
      return { action: "activate-pane", error: result.ok ? undefined : result.error };
    }
    return { action: "unknown-terminal", error: "Session is running but terminal type is unknown" };
  }

  // 2. Check historical sessions
  const sessions = await SessionManager.listAll();
  const match = sessions.find((s) => s.id === sessionId || s.id.startsWith(sessionId));

  if (match) {
    const result = await spawnInWezterm(match.cwd, match.id);
    return { action: "spawn", error: result.ok ? undefined : result.error };
  }

  return { action: "not-found", error: `No session found matching "${sessionId}"` };
}

async function showPickerAndSpawn(ctx: ExtensionContext): Promise<void> {
  const sessions = await SessionManager.listAll();

  if (sessions.length === 0) {
    ctx.ui.notify("No sessions found", "warning");
    return;
  }

  const recent = sessions.slice(0, MAX_SESSIONS);
  const activeSessions = listActiveSessions();
  const activeIds = new Set(activeSessions.map((s) => s.sessionId));

  // Get the current session ID so we can filter it out (don't show yourself)
  const sessionFile = ctx.sessionManager.getSessionFile();
  const currentSessionId = sessionFile
    ? sessionFile
        .replace(/\.jsonl?$/, "")
        .split("/")
        .pop()
    : undefined;

  // Build combined list: active first, then inactive historical (deduplicated)
  const combined: Array<{
    session: SessionInfo;
    active: boolean;
    paneId?: string;
    terminal?: string;
    display: string;
  }> = [];
  const shownIds = new Set<string>();

  // Active sessions (filter out current)
  for (const a of activeSessions) {
    if (a.sessionId === currentSessionId) continue;
    shownIds.add(a.sessionId);
    const hist = recent.find((s) => s.id === a.sessionId);
    // Prefer SessionManager name (always current, picks up /name changes), then stored fallback
    const name = hist?.name || hist?.firstMessage?.slice(0, 50) || a.sessionName || "new session";
    combined.push({
      session:
        hist ??
        ({
          id: a.sessionId,
          name: a.sessionName,
          cwd: a.cwd,
          created: new Date(a.startedAt),
          modified: new Date(a.startedAt),
          messageCount: 0,
          path: "",
        } as SessionInfo),
      active: true,
      paneId: a.paneId ?? undefined,
      terminal: a.terminal,
      display: `🟢 ${name}  —  ${a.cwd}`,
    });
  }

  // Inactive historical (skip ones already shown as active)
  for (const s of recent) {
    if (shownIds.has(s.id) || activeIds.has(s.id)) continue;
    shownIds.add(s.id);
    const name = s.name || s.firstMessage?.slice(0, 50) || s.id.slice(0, 8) + "...";
    combined.push({
      session: s,
      active: false,
      display: `   ${name}  —  ${s.cwd}`,
    });
  }

  const choices = combined.map((c) => c.display);
  const picked = await ctx.ui.select("Pick a session", choices);
  if (picked === undefined) return;

  const index = typeof picked === "string" ? choices.indexOf(picked) : picked;
  if (index < 0 || index >= combined.length) return;

  const entry = combined[index];

  if (entry.active) {
    if (entry.terminal === "wezterm" && entry.paneId) {
      const result = await activatePane(entry.paneId);
      if (!result.ok) {
        ctx.ui.notify(`Failed to activate pane: ${result.error}`, "error");
      }
    } else {
      ctx.ui.notify("Session is running but terminal type is unknown — can't switch", "warning");
    }
  } else {
    const result = await spawnInWezterm(entry.session.cwd, entry.session.id);
    if (!result.ok) {
      ctx.ui.notify(`Failed to spawn wezterm: ${result.error}`, "error");
    }
  }
}

// ── Extension entry point ───────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
  // --session-pick-json: output JSON and exit (before TUI starts)
  if (process.argv.includes("--session-pick-json")) {
    const sessions = await SessionManager.listAll();
    const recent = sessions.slice(0, MAX_SESSIONS);
    const activeIds = getActiveSessionIds();
    console.log(
      JSON.stringify(
        recent.map((s) => sessionToJSON(s, activeIds)),
        null,
        2,
      ),
    );
    process.exit(0);
  }

  // --session-pick-activate <id>: non-interactive activate
  const activateIdx = process.argv.indexOf("--session-pick-activate");
  if (activateIdx !== -1) {
    const sessionId = process.argv[activateIdx + 1];
    if (!sessionId) {
      console.error("--session-pick-activate requires a session ID argument");
      process.exit(1);
    }
    const result = await resolveAndActivate(sessionId);
    if (result.error) {
      console.error(result.error);
      process.exit(1);
    }
    process.exit(0);
  }

  pi.registerFlag("session-pick", {
    description: "Open session picker and resume in a new WezTerm tab",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("session-pick-activate", {
    description: "Activate a session by ID (activate pane if running, spawn if not)",
    type: "string",
    default: "",
  });

  pi.registerCommand("session-pick", {
    description: "Pick a session and open in a new WezTerm tab (or switch to it if running)",
    handler: async (_args, ctx) => {
      await showPickerAndSpawn(ctx);
    },
  });

  // Register on session_start
  pi.on("session_start", async (_event, ctx) => {
    const sessionManager = ctx.sessionManager;
    const sessionFile = sessionManager.getSessionFile();
    if (!sessionFile) return; // ephemeral session — skip

    const entries = sessionManager.getEntries();
    // extract session id from the session file path
    // SessionManager.getSessionFile() returns the full path, the session ID is the filename stem
    const sessionId =
      sessionFile
        .replace(/\.jsonl?$/, "")
        .split("/")
        .pop() || "unknown";

    // Try to get the current name (set via /name or session metadata)
    let sessionName = pi.getSessionName() || "";
    if (!sessionName) {
      // Fall back to the first user message
      for (const entry of entries) {
        if (entry.type === "message" && entry.role === "user") {
          const content =
            typeof entry.content === "string"
              ? entry.content
              : Array.isArray(entry.content)
                ? entry.content
                    .filter((c: { type: string }) => c.type === "text")
                    .map((c: { text: string }) => c.text)
                    .join(" ")
                : "";
          sessionName = content.slice(0, 50);
          break;
        }
      }
    }

    const terminal = process.env.WEZTERM_PANE ? "wezterm" : "unknown";
    const paneId = process.env.WEZTERM_PANE || null;

    // Clean up stale entries from previous crashes
    cleanupStaleSessions();

    registerSession({
      sessionId,
      sessionName,
      cwd: ctx.cwd,
      terminal: terminal as "wezterm" | "unknown",
      paneId,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });
  });

  // Deregister on session_shutdown
  pi.on("session_shutdown", async (_event, ctx) => {
    const sessionManager = ctx.sessionManager;
    const sessionFile = sessionManager.getSessionFile();
    if (!sessionFile) return;

    const sessionId =
      sessionFile
        .replace(/\.jsonl?$/, "")
        .split("/")
        .pop() || "unknown";
    deregisterSession(sessionId);
  });

  // Show picker on --session-pick flag
  pi.on("session_start", async (_event, ctx) => {
    if (pi.getFlag("session-pick")) {
      await showPickerAndSpawn(ctx);
      ctx.shutdown();
    }
  });
}
