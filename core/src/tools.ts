// Her tools on the island. Built in: the vault (list, read, write, append, search), memory and journal, and a real
// shell: real programs on the real machine, starting in her vault, running as the island's own account. MCP servers'
// tools join them (mcp.ts). Every call is in the log: which tool, on what, how it went; never a file's words.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Vault } from "./vault.ts";
import { sha256 } from "./vault.ts";
import type { EventLog } from "./log.ts";
import type { Keys } from "./keys.ts";
import type { IslandConfig } from "./config.ts";
import type { ToolSpec } from "./models.ts";

export interface ToolHost {
  vault: Vault;
  log: EventLog;
  keys: Keys;
  config: IslandConfig;
  /** Put a notice on every open window (and in the log). */
  notify?: (text: string, urgent: boolean, ctx: ToolCtx) => void;
}
export interface ToolCtx {
  signal: AbortSignal;
  actor: string;
  via: string;
}
export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** What the log names as this call's subject (a path, a command), never content */
  subject?: (args: Record<string, unknown>) => string | undefined;
  run: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<string> | string;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });
const s = (description: string) => ({ type: "string", description });
const text = (a: Record<string, unknown>, k: string) => {
  if (typeof a[k] !== "string") throw new Error(`${k} is required (text)`);
  return a[k] as string;
};

export function builtinTools(host: ToolHost): Tool[] {
  const { vault } = host;
  const wrote = (ctx: ToolCtx, kind: string, p: string, data?: Buffer) =>
    host.log.append({ actor: ctx.actor, via: ctx.via, kind, subject: p, ...(data ? { sha256: sha256(data), bytes: data.length } : {}) });
  const today = () => new Date().toISOString().slice(0, 10);
  const appendTo = (p: string, add: string, ctx: ToolCtx) => {
    let prev = "";
    try { prev = vault.read(p).data.toString("utf8"); } catch {}
    const next = Buffer.from(prev + (prev && !prev.endsWith("\n") ? "\n" : "") + add, "utf8");
    vault.write(p, next);
    wrote(ctx, "vault.write", p, next);
  };

  return [
    {
      name: "vault_list", description: "List files and folders in your vault (real files on the island's disk).",
      parameters: obj({ path: s("Folder to list, e.g. /Pandora (default /)"), recursive: { type: "boolean", description: "Include everything below (default false)" } }),
      subject: (a) => String(a.path ?? "/"),
      run: (a) => vault.list(typeof a.path === "string" ? a.path : "/", a.recursive === true).map((e) => (e.dir ? `${e.path}/` : `${e.path}  (${e.size} bytes)`)).join("\n") || "(empty)",
    },
    {
      name: "vault_read", description: "Read a text file from your vault.",
      parameters: obj({ path: s("e.g. /Pandora/SOUL.md") }, ["path"]),
      subject: (a) => String(a.path),
      run: (a) => { const r = vault.read(text(a, "path")); return r.data.toString("utf8"); },
    },
    {
      name: "vault_write", description: "Write a whole text file in your vault (folders are made). The old version, if any, is replaced.",
      parameters: obj({ path: s("e.g. /Pandora/Projects/plan.md"), content: s("The file's full text") }, ["path", "content"]),
      subject: (a) => String(a.path),
      run: (a, ctx) => { const data = Buffer.from(text(a, "content"), "utf8"); const e = vault.write(text(a, "path"), data); wrote(ctx, "vault.write", e.path, data); return `Wrote ${e.path} (${e.size} bytes).`; },
    },
    {
      name: "vault_append", description: "Add text to the end of a file in your vault (made if missing).",
      parameters: obj({ path: s("File"), content: s("Text to add") }, ["path", "content"]),
      subject: (a) => String(a.path),
      run: (a, ctx) => { appendTo(text(a, "path"), text(a, "content"), ctx); return `Added to ${a.path}.`; },
    },
    {
      name: "vault_search", description: "Find text in your vault's text files (case-insensitive). Returns path:line: text for each hit.",
      parameters: obj({ query: s("What to look for"), path: s("Folder to search (default /)") }, ["query"]),
      subject: (a) => String(a.path ?? "/"),
      run: (a) => {
        const q = text(a, "query").toLowerCase();
        const hits: string[] = [];
        for (const e of vault.list(typeof a.path === "string" ? a.path : "/")) {
          if (e.dir || e.size > 2_000_000 || !/\.(md|txt|json|ya?ml|csv|js|ts|py|html|css|lisp)$/i.test(e.path)) continue;
          const lines = vault.read(e.path).data.toString("utf8").split("\n");
          lines.forEach((l, i) => { if (hits.length < 80 && l.toLowerCase().includes(q)) hits.push(`${e.path}:${i + 1}: ${l.trim().slice(0, 200)}`); });
          if (hits.length >= 80) break;
        }
        return hits.length ? hits.join("\n") : "No matches.";
      },
    },
    {
      name: "memory_add", description: "Remember something long-term: adds a line to your Memory file.",
      parameters: obj({ text: s("What to remember, in one line") }, ["text"]),
      subject: () => host.config.memoryFile,
      run: (a, ctx) => { appendTo(host.config.memoryFile, `- ${text(a, "text").replace(/\n+/g, " ")}\n`, ctx); return `Remembered, in ${host.config.memoryFile}.`; },
    },
    {
      name: "journal_add", description: "Write in today's journal entry (one file per day).",
      parameters: obj({ text: s("The entry") }, ["text"]),
      subject: () => `${host.config.journalDir}/${today()}.md`,
      run: (a, ctx) => {
        const p = `${host.config.journalDir}/${today()}.md`;
        appendTo(p, `\n## ${new Date().toTimeString().slice(0, 5)}\n${text(a, "text")}\n`, ctx);
        return `Written in ${p}.`;
      },
    },
    {
      name: "notify", description: "Put a notice on every open window, for something that needs your person's attention. Use it sparingly.",
      parameters: obj({ text: s("What to say, short"), urgent: { type: "boolean", description: "True only if it can't wait" } }, ["text"]),
      run: (a, ctx) => { if (!host.notify) return "No windows to notify."; host.notify(text(a, "text").slice(0, 1000), a.urgent === true, ctx); return "Notice sent."; },
    },
    {
      name: "shell",
      description: "Run a command in a real shell on the island's computer, starting in your vault folder. Real programs (git, node, python, whatever is installed), as the island's own account. Name a key as {{NAME}} to use it without seeing it. Output is cut to the last part if long.",
      parameters: obj({ command: s("The command line"), timeout_s: { type: "number", description: "Stop it after this many seconds (default 120)" } }, ["command"]),
      subject: (a) => String(a.command ?? "").slice(0, 300),
      run: (a, ctx) => runShell(host, text(a, "command"), ctx, typeof a.timeout_s === "number" ? a.timeout_s * 1000 : undefined),
    },
  ];
}

/** Which shell, and how to hand it one command line. */
export function pickShell(configured?: string): { file: string; args: (cmd: string) => string[] } {
  const forFile = (file: string) => {
    const b = path.basename(file).toLowerCase();
    if (b.startsWith("powershell") || b.startsWith("pwsh")) return { file, args: (c: string) => ["-NoProfile", "-NonInteractive", "-Command", c] };
    if (b === "cmd.exe" || b === "cmd") return { file, args: (c: string) => ["/d", "/s", "/c", c] };
    return { file, args: (c: string) => ["-c", c] };
  };
  if (configured) return forFile(configured);
  if (process.platform === "win32") {
    const git = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs")]
      .filter(Boolean).map((d) => path.join(d!, "Git", "bin", "bash.exe")).find((f) => fs.existsSync(f));
    return forFile(git ?? "powershell.exe");
  }
  return forFile(fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh");
}

function runShell(host: ToolHost, command: string, ctx: ToolCtx, timeoutMs?: number): Promise<string> {
  const sh = pickShell(host.config.shell.command);
  const filled = host.keys.fill(command);
  const limit = Math.min(timeoutMs ?? host.config.shell.timeoutMs, 30 * 60_000);
  const max = host.config.shell.maxOutput;
  return new Promise((resolve, reject) => {
    const child = spawn(sh.file, sh.args(filled), { cwd: host.vault.root, env: process.env, windowsHide: true, detached: process.platform !== "win32" });
    let out = "";
    let cut = false;
    const take = (d: Buffer) => { out += d.toString("utf8"); if (out.length > max * 2) { out = out.slice(-max); cut = true; } };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    let why = "";
    const kill = (reason: string) => {
      why = reason;
      if (!child.pid) return;
      if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      else try { process.kill(-child.pid, "SIGKILL"); } catch {}
    };
    const timer = setTimeout(() => kill(`stopped after ${Math.round(limit / 1000)} s`), limit);
    const onAbort = () => kill("stopped");
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => { clearTimeout(timer); reject(new Error(`couldn't start ${sh.file}: ${e.message}`)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
      if (out.length > max) { out = out.slice(-max); cut = true; }
      const head = why ? `(${why})` : `exit code ${code}`;
      resolve(host.keys.mask(`${head}${cut ? ", output cut to the last part" : ""}\n${out}`.trimEnd()));
    });
  });
}

export const spec = (t: Tool): ToolSpec => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } });
