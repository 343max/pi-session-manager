import { writeSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CustomEditor, SessionManager } from "@earendil-works/pi-coding-agent";
import { exec, spawn } from "child_process";
import type { ActiveSessionInfo } from "./running-sessions";
import {
  initSessionState,
  updateSessionState,
  getSessionState,
  clearSessionState,
  cleanupStaleSessions,
  listActiveSessions,
} from "./running-sessions";

const MAX_SESSIONS = 20;

// ── Shared session list helper ──────────────────────────────────────

interface SessionListEntry {
  sessionId: string;
  sessionName: string | null;
  cwd: string;
  status: "running" | "stopped";
  focusable: boolean;
  unreadOutput: boolean;
  created?: string;
  modified?: string;
}

async function getCombinedSessionList(opts?: {
  excludeSessionId?: string;
}): Promise<SessionListEntry[]> {
  const sessions = await SessionManager.listAll();
  const recent = sessions.slice(0, MAX_SESSIONS);
  const activeSessions = listActiveSessions();
  const activeIds = new Set(activeSessions.map((s) => s.sessionId));

  const combined: SessionListEntry[] = [];
  const shownIds = new Set<string>();

  // Active sessions first
  for (const a of activeSessions) {
    if (a.sessionId === opts?.excludeSessionId) continue;
    shownIds.add(a.sessionId);
    const hist = recent.find((s) => s.id === a.sessionId);
    const name = a.sessionName || hist?.name || hist?.firstMessage?.slice(0, 50) || "new session";
    combined.push({
      sessionId: a.sessionId,
      sessionName: name,
      cwd: a.cwd,
      status: "running",
      focusable: a.terminal === "wezterm" && a.paneId !== null,
      unreadOutput: a.unreadOutput === true,
      created: hist ? hist.created.toISOString() : undefined,
      modified: hist ? hist.modified.toISOString() : undefined,
    });
  }

  // Historical sessions (deduplicated)
  for (const s of recent) {
    if (shownIds.has(s.id) || activeIds.has(s.id)) continue;
    shownIds.add(s.id);
    const name = s.name || s.firstMessage?.slice(0, 50) || s.id.slice(0, 8) + "...";
    combined.push({
      sessionId: s.id,
      sessionName: name,
      cwd: s.cwd,
      status: "stopped",
      focusable: true,
      unreadOutput: false,
      created: s.created.toISOString(),
      modified: s.modified.toISOString(),
    });
  }

  return combined;
}

// ── Unread-tracking editor ────────────────────────────────────────

class UnreadTrackingEditor extends CustomEditor {
  private clearOnNextInput = false;

  handleInput(data: string): void {
    if (this.clearOnNextInput) {
      this.clearOnNextInput = false;
      updateSessionState({ unreadOutput: false });
    }
    super.handleInput(data);
  }

  armClear(): void {
    this.clearOnNextInput = true;
  }
}

let currentEditor: UnreadTrackingEditor | null = null;

// ── macOS app focus ───────────────────────────────────────────────

function focusWezTerm() {
  if (process.platform === "darwin") {
    exec("open -a WezTerm");
  }
}

// ── Activation ──────────────────────────────────────────────────────

function activatePane(paneId: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const cli = spawn("wezterm", ["cli", "activate-pane", "--pane-id", paneId], {
      stdio: "ignore",
      detached: true,
    });
    cli.on("error", () => resolve({ ok: false, error: "wezterm not found" }));
    cli.on("close", (code) => {
      if (code === 0) focusWezTerm();
      resolve({ ok: code === 0, error: code !== 0 ? `exit code ${code}` : undefined });
    });
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
      win.on("close", (code) => {
        if (code === 0) focusWezTerm();
        resolve({
          ok: code === 0,
          error: code !== 0 ? `exit code ${code}` : undefined,
        });
      });
    });

    cli.on("close", (code) => {
      if (code === 0) focusWezTerm();
      resolve({
        ok: code === 0,
        error: code !== 0 ? `exit code ${code}` : undefined,
      });
    });
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
  const sessionFile = ctx.sessionManager.getSessionFile();
  const currentSessionId = sessionFile
    ? sessionFile
        .replace(/\.jsonl?$/, "")
        .split("/")
        .pop()
    : undefined;

  const combined = await getCombinedSessionList({ excludeSessionId: currentSessionId });

  if (combined.length === 0) {
    ctx.ui.notify("No sessions found", "warning");
    return;
  }

  const choices = combined.map((c) => {
    const icon = c.status === "stopped" ? "  " : c.unreadOutput ? "🔵" : "· ";
    return `${icon} ${c.sessionName}  —  ${c.cwd}`;
  });

  const picked = await ctx.ui.select("Pick a session", choices);
  if (picked === undefined) return;

  const index = typeof picked === "string" ? choices.indexOf(picked) : picked;
  if (index < 0 || index >= combined.length) return;

  const entry = combined[index];

  if (entry.status === "running" && entry.focusable) {
    const active = listActiveSessions().find((s) => s.sessionId === entry.sessionId);
    if (active?.paneId) {
      const result = await activatePane(active.paneId);
      if (!result.ok) {
        ctx.ui.notify(`Failed to activate pane: ${result.error}`, "error");
      }
    }
  } else if (entry.status === "running") {
    ctx.ui.notify("Session is running but terminal type is unknown — can't switch", "warning");
  } else {
    const result = await spawnInWezterm(entry.cwd, entry.sessionId);
    if (!result.ok) {
      ctx.ui.notify(`Failed to spawn wezterm: ${result.error}`, "error");
    }
  }
}

// ── Extension entry point ───────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
  // --session-pick-json: output JSON and exit (before TUI starts)
  // Use writeSync(fd 1) to write directly to stdout, bypassing pi's
  // takeOverStdout() which redirects process.stdout.write → stderr in
  // non-interactive modes (e.g. when piping: pi --session-pick-json | jq).
  if (process.argv.includes("--session-pick-json")) {
    const list = await getCombinedSessionList();
    writeSync(1, JSON.stringify(list, null, 2) + "\n");
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
        if (entry.type === "message" && entry.message.role === "user") {
          const content =
            typeof entry.message.content === "string"
              ? entry.message.content
              : Array.isArray(entry.message.content)
                ? entry.message.content
                    .filter((c): c is { type: "text"; text: string } => c.type === "text")
                    .map((c) => c.text)
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

    initSessionState({
      sessionId,
      sessionName,
      cwd: ctx.cwd,
      terminal: terminal as "wezterm" | "unknown",
      paneId,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      unreadOutput: false,
    });

    // Set up unread-tracking editor
    ctx.ui.setEditorComponent((_tui, theme, keybindings) => {
      const editor = new UnreadTrackingEditor(_tui, theme, keybindings);
      currentEditor = editor;
      return editor;
    });
  });

  // Deregister on session_shutdown
  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setEditorComponent(undefined);
    currentEditor = null;
    clearSessionState();
  });

  // Refresh name and set unread flag when agent finishes
  pi.on("agent_end", () => {
    // Refresh session name
    const name = pi.getSessionName() || "";
    const state = getSessionState();
    if (state && name && name !== state.sessionName) {
      updateSessionState({ sessionName: name });
    }

    // Mark unread output
    updateSessionState({ unreadOutput: true });
    currentEditor?.armClear();
  });

  // Show picker on --session-pick flag
  pi.on("session_start", async (_event, ctx) => {
    if (pi.getFlag("session-pick")) {
      await showPickerAndSpawn(ctx);
      ctx.shutdown();
    }
  });
}
