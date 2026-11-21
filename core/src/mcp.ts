// MCP servers as the island's children: each is started as its own process and spoken to over stdio (JSON-RPC, one
// message per line), the way pandora-mcp, pandora-multi and the mode shrine already run. A crash takes down only that
// server; it is started again the next time one of its tools is called. Their tools are offered to her as
// <server>__<tool>. Settings may name keys ({{NAME}}) in a server's environment; values never reach the log.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { McpConfig } from "./config.ts";
import type { Keys } from "./keys.ts";
import type { Tool } from "./tools.ts";

const PROTOCOL = "2025-06-18";
const CALL_TIMEOUT = 5 * 60_000;

interface McpTool { name: string; description?: string; inputSchema?: Record<string, unknown> }

export class McpServer {
  readonly name: string;
  readonly cfg: McpConfig;
  private keys: Keys;
  private child: ChildProcessWithoutNullStreams | null = null;
  private next = 1;
  private waiting = new Map<number, { ok: (v: any) => void; no: (e: Error) => void; timer: NodeJS.Timeout }>();
  private ready: Promise<void> | null = null;
  tools: McpTool[] = [];
  lastError = "";
  stderrTail = "";

  constructor(name: string, cfg: McpConfig, keys: Keys) {
    this.name = name;
    this.cfg = cfg;
    this.keys = keys;
  }

  get running() {
    return !!this.child && this.child.exitCode === null;
  }

  private send(method: string, params?: unknown, notify = false): Promise<any> {
    const child = this.child;
    if (!child) return Promise.reject(new Error(`${this.name} isn't running`));
    if (notify) { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"); return Promise.resolve(); }
    const id = this.next++;
    return new Promise((ok, no) => {
      const timer = setTimeout(() => { this.waiting.delete(id); no(new Error(`${this.name} didn't answer ${method} in time`)); }, CALL_TIMEOUT);
      this.waiting.set(id, { ok, no, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  /** Start it (if it isn't running), say hello the MCP way, and learn its tools. */
  start(): Promise<void> {
    if (this.ready && this.running) return this.ready;
    this.ready = (async () => {
      const env: Record<string, string> = { ...(process.env as Record<string, string>) };
      for (const [k, v] of Object.entries(this.cfg.env ?? {})) env[k] = this.keys.fill(v);
      const child = spawn(this.cfg.command, this.cfg.args ?? [], { cwd: this.cfg.cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      this.child = child;
      let buf = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (d: string) => {
        buf += d;
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          let m: any;
          try { m = JSON.parse(line); } catch { continue; }   // a server that prints other things on stdout
          const w = typeof m.id === "number" ? this.waiting.get(m.id) : undefined;
          if (!w) continue;
          this.waiting.delete(m.id);
          clearTimeout(w.timer);
          if (m.error) w.no(new Error(m.error.message ?? "error")); else w.ok(m.result);
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (d: string) => { this.stderrTail = (this.stderrTail + d).slice(-2000); });
      const gone = (why: string) => {
        this.lastError = why;
        for (const w of this.waiting.values()) { clearTimeout(w.timer); w.no(new Error(`${this.name} stopped: ${why}`)); }
        this.waiting.clear();
        if (this.child === child) this.child = null;
      };
      child.on("error", (e) => gone(e.message));
      child.on("exit", (code) => gone(`exit code ${code}${this.stderrTail ? `: ${this.keys.mask(this.stderrTail.trim().split("\n").pop() ?? "")}` : ""}`));
      await this.send("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "islands-core", version: "0.1" } });
      await this.send("notifications/initialized", undefined, true);
      const r = await this.send("tools/list", {});
      this.tools = Array.isArray(r?.tools) ? r.tools : [];
      this.lastError = "";
    })().catch((e) => { this.lastError = e.message; this.stop(); throw e; });
    return this.ready;
  }

  async call(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    await this.start();
    const p = this.send("tools/call", { name: tool, arguments: args });
    const r = await (signal ? Promise.race([p, new Promise<never>((_, no) => signal.addEventListener("abort", () => no(new Error("stopped")), { once: true }))]) : p);
    const parts = Array.isArray(r?.content) ? r.content : [];
    const out = parts.map((c: any) => (c?.type === "text" ? c.text : c?.type ? `[${c.type}]` : JSON.stringify(c))).join("\n");
    const text = this.keys.mask(out || JSON.stringify(r ?? {}));
    if (r?.isError) throw new Error(text);
    return text;
  }

  stop() {
    const c = this.child;
    this.child = null;
    this.ready = null;
    if (c && c.exitCode === null) c.kill();
  }
}

const toolName = (server: string, tool: string) => `${server}__${tool}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);

/** Every configured server's tools, as the island's tools. Servers that can't start are left out and say why in status. */
export async function mcpTools(servers: McpServer[]): Promise<Tool[]> {
  const out: Tool[] = [];
  await Promise.all(servers.map((s) => s.start().catch(() => {})));
  for (const s of servers) {
    for (const t of s.tools) {
      out.push({
        name: toolName(s.name, t.name),
        description: `${t.description ?? t.name} (from ${s.name})`,
        parameters: t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : { type: "object", properties: {} },
        subject: () => `${s.name}/${t.name}`,
        run: (args, ctx) => s.call(t.name, args, ctx.signal),
      });
    }
  }
  return out;
}
