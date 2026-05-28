import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { spawn } from "child_process";

const MAX_SESSIONS = 20;

function sessionToJSON(s: SessionInfo): Record<string, unknown> {
  return {
    id: s.id,
    name: s.name || s.firstMessage?.slice(0, 50) || null,
    cwd: s.cwd,
    created: s.created.toISOString(),
    modified: s.modified.toISOString(),
    messageCount: s.messageCount,
    firstMessage: s.firstMessage || null,
    path: s.path,
  };
}

async function showPickerAndSpawn(ctx: ExtensionContext): Promise<void> {
  const sessions = await SessionManager.listAll();

  if (sessions.length === 0) {
    ctx.ui.notify("No sessions found", "warning");
    return;
  }

  const recent = sessions.slice(0, MAX_SESSIONS);

  const choices = recent.map((s) => {
    const name = s.name || s.firstMessage?.slice(0, 50) || s.id.slice(0, 8) + "...";
    return `${name}  —  ${s.cwd}`;
  });

  const picked = await ctx.ui.select("Pick a session", choices);
  if (picked === undefined) return;

  const index = typeof picked === "string" ? choices.indexOf(picked) : picked;
  if (index < 0 || index >= recent.length) return;

  const session = recent[index];
  await openInWezterm(session.cwd, session.id, ctx);
}

function openInWezterm(
  cwd: string,
  sessionId: string,
  ctx: ExtensionContext,
): Promise<void> {
  return new Promise((resolve) => {
    // Try wezterm cli spawn (existing multiplexer / tab)
    const cli = spawn(
      "wezterm",
      ["cli", "spawn", "--cwd", cwd, "--", "pi", "--session", sessionId],
      { stdio: "ignore", detached: true },
    );

    cli.on("error", () => {
      // wezterm not installed or not found
      ctx.ui.notify("wezterm not found — is it installed?", "error");
      resolve();
    });

    cli.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      // cli spawn failed (no multiplexer running) — fall back to new window
      const win = spawn(
        "wezterm",
        ["start", "--cwd", cwd, "--", "pi", "--session", sessionId],
        { stdio: "ignore", detached: true },
      );

      win.on("error", () => {
        ctx.ui.notify("Failed to open wezterm", "error");
        resolve();
      });

      win.on("close", () => resolve());
    });
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerFlag("session-pick", {
    description: "Open session picker and resume in a new WezTerm tab",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("session-pick-json", {
    description: "Output recent sessions as JSON (for scripting)",
    type: "boolean",
    default: false,
  });

  pi.registerCommand("session-pick", {
    description: "Pick a session and open in a new WezTerm tab",
    handler: async (_args, ctx) => {
      await showPickerAndSpawn(ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (pi.getFlag("session-pick-json")) {
      const sessions = await SessionManager.listAll();
      const recent = sessions.slice(0, MAX_SESSIONS);
      console.log(JSON.stringify(recent.map(sessionToJSON), null, 2));
      ctx.shutdown();
      return;
    }

    if (pi.getFlag("session-pick")) {
      await showPickerAndSpawn(ctx);
      ctx.shutdown();
    }
  });
}
