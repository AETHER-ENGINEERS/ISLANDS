// The island's core: its home folder, vault, chats and log, and the ferry protocol's calls (docs/protocol.md).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Vault } from "./vault.ts";
import { EventLog, type IslandEvent } from "./log.ts";
import { Chats } from "./chats.ts";
import { IslandError, CODES, badParams, conflict } from "./errors.ts";
import { loadConfig, type IslandConfig } from "./config.ts";
import { Keys } from "./keys.ts";
import { Threads } from "./threads.ts";
import { builtinTools, type Tool } from "./tools.ts";
import { McpServer, mcpTools } from "./mcp.ts";
import { runTurn, nowContext } from "./agent.ts";
import { Providers } from "./providers.ts";
import { Scheduler, previewWhen } from "./schedules.ts";

export const PROTOCOL = "islands/0.1";
export const VERSION: string = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/** The island's home: every folder it keeps, made if missing. */
export function layout(home: string) {
  const h = path.resolve(home);
  const dirs = { home: h, vault: path.join(h, "vault"), chats: path.join(h, "chats"), log: path.join(h, "log"), state: path.join(h, "state"), keys: path.join(h, "keys"), runs: path.join(h, "runs"), config: path.join(h, "config"), trash: path.join(h, "trash"), backups: path.join(h, "backups") };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  return dirs;
}

/** One ferry's connection, as the island sees it. */
export interface Session {
  id: string;
  hello: boolean;
  ferry: string;
  actor: string;
  notify: (method: string, params: unknown) => void;
  stop?: () => void;
}

type Handler = (params: Record<string, unknown>, s: Session) => unknown;

const str = (p: Record<string, unknown>, k: string, opt = false): string => {
  const v = p[k];
  if (v === undefined && opt) return undefined as unknown as string;
  if (typeof v !== "string") throw badParams(`${k} is text`);
  return v;
};

export class Island {
  readonly name: string;
  readonly dirs: ReturnType<typeof layout>;
  readonly vault: Vault;
  readonly log: EventLog;
  readonly chats: Chats;
  readonly token: string;
  readonly startedAt = new Date().toISOString();
  readonly sessions = new Set<Session>();
  readonly config: IslandConfig;
  readonly keys: Keys;
  readonly threads: Threads;
  readonly mcp: McpServer[];
  readonly providers: Providers;
  readonly scheduler: Scheduler;
  private methods: Record<string, Handler>;
  private toolCache: Tool[] | null = null;

  constructor(home: string, { name = "island", token = crypto.randomBytes(32).toString("base64url") } = {}) {
    this.name = name;
    this.dirs = layout(home);
    this.vault = new Vault(this.dirs.vault, this.dirs.trash);
    this.log = new EventLog(this.dirs.log);
    this.chats = new Chats(this.dirs.chats, this.log);
    this.token = token;
    this.config = loadConfig(this.dirs.config);
    this.keys = new Keys(this.dirs.keys, this.config.keystore);
    this.threads = new Threads(this.dirs.runs, this.log, (m, p) => this.broadcast(m, p));
    this.providers = new Providers(this.dirs.state, this.config, this.keys);
    this.scheduler = new Scheduler(this);
    this.mcp = Object.entries(this.config.mcp).filter(([, c]) => !c.disabled).map(([n, c]) => new McpServer(n, c, this.keys));
    this.methods = this.calls();
  }

  /** Is this the island's token? (compared in constant time) */
  checkToken(t: unknown) {
    if (typeof t !== "string") return false;
    const a = crypto.createHash("sha256").update(t).digest();
    const b = crypto.createHash("sha256").update(this.token).digest();
    return crypto.timingSafeEqual(a, b);
  }

  /** Tell every ferry that has said hello. */
  broadcast(method: string, params: unknown) {
    for (const s of this.sessions) if (s.hello) { try { s.notify(method, params); } catch {} }
  }

  /** Her tools: the built-in ones, then every MCP server's (servers are started the first time). */
  async tools(): Promise<Tool[]> {
    if (this.toolCache && this.mcp.every((m) => m.running || m.lastError)) return this.toolCache;
    const host = {
      vault: this.vault, log: this.log, keys: this.keys, config: this.config,
      notify: (text: string, urgent: boolean, ctx: { actor: string; via: string }) => {
        const t = this.keys.mask(text);
        this.log.append({ actor: ctx.actor, via: ctx.via, kind: "notice", urgent, bytes: Buffer.byteLength(t) });
        this.broadcast("notice", { text: t, urgent, from: ctx.actor, at: new Date().toISOString() });
      },
    };
    this.toolCache = [...builtinTools(host), ...(await mcpTools(this.mcp))];
    return this.toolCache;
  }

  /** Stop the children (MCP servers); running threads are marked interrupted when the island starts again. */
  shutdown() {
    this.scheduler.stop();
    for (const m of this.mcp) m.stop();
  }

  private via(s: Session) {
    return `ferry:${s.ferry}`;
  }

  private calls(): Record<string, Handler> {
    const v = this.vault;
    return {
      "island.status": () => ({
        name: this.name, version: VERSION, protocol: PROTOCOL, startedAt: this.startedAt, seq: this.log.last,
        vault: (() => { const all = v.list("/"); return { files: all.filter((e) => !e.dir).length, dirs: all.filter((e) => e.dir).length }; })(),
        chats: this.chats.list().length,
        models: { default: this.config.models.default, names: Object.keys(this.config.models.list) },
        mcp: this.mcp.map((m) => ({ name: m.name, running: m.running, tools: m.tools.length, error: m.lastError || undefined })),
        threads: this.threads.running().length,
        schedules: this.scheduler.all().length,
        heartbeat: this.scheduler.heartbeat()?.enabled === true,
        ferries: [...this.sessions].filter((x) => x.hello).map((x) => ({ ferry: x.ferry, as: x.actor })),
      }),

      "vault.list": (p) => ({ entries: v.list(p.path === undefined ? "/" : str(p, "path"), p.recursive !== false) }),
      "vault.read": (p) => {
        const r = v.read(str(p, "path"));
        const out: Record<string, unknown> = { path: p.path, size: r.size, mtime: r.mtime };
        if (p.encoding === "base64") out.base64 = r.data.toString("base64");
        else out.text = r.data.toString("utf8");
        return out;
      },
      "vault.write": (p, s) => {
        let data: Buffer;
        if (typeof p.text === "string") data = Buffer.from(p.text, "utf8");
        else if (typeof p.base64 === "string") data = Buffer.from(p.base64, "base64");
        else throw badParams("give text or base64");
        if (p.ifMtime !== undefined && typeof p.ifMtime !== "number") throw badParams("ifMtime is a number");
        const e = v.write(str(p, "path"), data, p.ifMtime as number | undefined);
        this.log.append({ actor: s.actor, via: this.via(s), kind: "vault.write", subject: e.path, sha256: crypto.createHash("sha256").update(data).digest("hex"), bytes: data.length });
        return { path: e.path, size: e.size, mtime: e.mtime };
      },
      "vault.mkdir": (p, s) => {
        const r = v.mkdir(str(p, "path"));
        this.log.append({ actor: s.actor, via: this.via(s), kind: "vault.mkdir", subject: r.path });
        return r;
      },
      "vault.move": (p, s) => {
        const r = v.move(str(p, "from"), str(p, "to"));
        this.log.append({ actor: s.actor, via: this.via(s), kind: "vault.move", subject: r.from, to: r.to });
        return r;
      },
      "vault.delete": (p, s) => {
        const r = v.delete(str(p, "path"));
        this.log.append({ actor: s.actor, via: this.via(s), kind: "vault.delete", subject: r.path, trash: path.relative(this.dirs.home, r.trash).split(path.sep).join("/") });
        return r;
      },

      "chat.list": () => ({ chats: this.chats.list() }),
      "chat.create": (p, s) => ({ chat: this.chats.create(p.title, s.actor, this.via(s)) }),
      "chat.open": (p) => this.chats.open(str(p, "id")),
      "chat.post": (p, s) => this.chats.post(str(p, "id"), p.role, p.content, s.actor, this.via(s)),
      "chat.rename": (p, s) => ({ chat: this.chats.rename(str(p, "id"), p.title, s.actor, this.via(s)) }),
      "chat.send": (p, s) => {
        const id = str(p, "id");
        if (typeof p.content !== "string" || !p.content.trim()) throw badParams("content is text");
        if (p.model !== undefined && (typeof p.model !== "string" || !this.config.models.list[p.model])) throw badParams(`no model called ${String(p.model)}`);
        if (p.purpose !== undefined && typeof p.purpose !== "string") throw badParams("purpose is text");
        if (p.params !== undefined && (typeof p.params !== "object" || p.params === null || Array.isArray(p.params))) throw badParams("params is an object");
        if (this.threads.running(id).length) throw conflict("she's already answering in this chat; wait, or stop that turn");
        const posted = this.chats.post(id, "user", this.keys.mask(p.content), s.actor, this.via(s));
        const t = this.threads.start({ kind: "turn", title: p.content.slice(0, 80), chat: id, by: this.config.self, via: this.via(s) },
          (ctx) => runTurn(this, id, { model: p.model as string | undefined, params: p.params as Record<string, unknown> | undefined, purpose: (p.purpose as string | undefined) ?? "chat" }, ctx));
        return { n: posted.n, thread: t.id };
      },

      "threads.list": (p) => ({ threads: this.threads.list(num(p.limit, 50)) }),
      "thread.get": (p) => ({ thread: this.threads.get(str(p, "id")) }),
      "thread.cancel": (p, s) => {
        const t = this.threads.cancel(str(p, "id"));
        this.log.append({ actor: s.actor, via: this.via(s), kind: "thread.cancel", thread: t.id });
        return { thread: t };
      },

      "keys.list": () => ({ keys: this.keys.list() }),
      "keys.set": (p, s) => {
        const name = str(p, "name");
        this.keys.set(name, p.value);
        this.log.append({ actor: s.actor, via: this.via(s), kind: "key.set", key: name });
        return { name, backend: this.keys.backend };
      },
      "keys.delete": (p, s) => {
        const name = str(p, "name");
        this.keys.delete(name, this.dirs.trash);
        this.log.append({ actor: s.actor, via: this.via(s), kind: "key.delete", key: name });
        return { name };
      },

      "now.get": async () => ({ time: new Date().toISOString(), context: await nowContext(this, await this.tools(), AbortSignal.timeout(10000)) }),
      "tools.list": async () => ({ tools: (await this.tools()).map((t) => ({ name: t.name, description: t.description })) }),
      "providers.list": () => ({ providers: this.providers.list(), chain: this.providers.chain(undefined, "chat") }),
      "schedule.list": () => ({ schedules: this.scheduler.list() }),
      "schedule.when": (p) => previewWhen(str(p, "when"), num(p.count, 3)),
      "schedule.create": (p, s) => ({ schedule: this.scheduler.create(p, s.actor, this.via(s)) }),
      "schedule.update": (p, s) => ({ schedule: this.scheduler.update(str(p, "id"), p, s.actor, this.via(s)) }),
      "schedule.delete": (p, s) => this.scheduler.delete(str(p, "id"), s.actor, this.via(s)),
      "schedule.run": (p, s) => {
        const thread = this.scheduler.run(str(p, "id"), s.actor, this.via(s));
        if (!thread) throw conflict("it's still running from last time, or it had nothing to do (see schedule.list)");
        return { thread };
      },
      "heartbeat.status": () => {
        const hb = this.scheduler.list().find((x) => x.id === "heartbeat");
        if (!hb) return { enabled: false, configured: false };
        // her last answer from the heartbeat's own chat: what the beat came to
        let result: { text: string; at: string; model?: string } | undefined;
        try {
          if (hb.chat) {
            const m = [...this.chats.open(hb.chat).messages].reverse().find((x: any) => x.role === "assistant" && typeof x.content === "string" && x.content.trim()) as any;
            if (m) result = { text: m.content.length > 4000 ? m.content.slice(0, 4000) + "…" : m.content, at: m.at, model: m.model };
          }
        } catch {}
        return { enabled: hb.enabled, configured: true, paused: !hb.enabled, every: hb.when, model: hb.model ?? this.config.models.roles?.heartbeat ?? this.config.models.default, lastRun: hb.lastRun, lastStatus: hb.lastStatus, next: hb.next, running: hb.running, chat: hb.chat, result };
      },
      "heartbeat.set": (p, s) => {
        if (typeof p.on !== "boolean") throw badParams("on is true (beat) or false (pause)");
        this.scheduler.setHeartbeat(p.on, s.actor, this.via(s));
        return this.methods["heartbeat.status"]({}, s);
      },
      "models.list": () => ({
        default: this.config.models.default, fallback: this.config.models.fallback ?? [], roles: this.config.models.roles ?? {},
        models: Object.entries(this.config.models.list).map(([name, m]) => {
          const ready = this.providers.check(name);
          let host = "";
          try { host = new URL(this.providers.resolve(name).cfg.url).host; } catch {}
          return { name, model: m.model, provider: this.providers.providerOf(name), host, ready: ready.ok, ...(ready.ok ? {} : { why: ready.why }) };
        }),
      }),

      "events.since": (p) => this.log.since(num(p.fromSeq, 0), { limit: num(p.limit, 1000), kinds: kinds(p.kinds) }),
      "events.subscribe": (p, s) => {
        s.stop?.();
        const want = kinds(p.kinds);
        const match = (e: IslandEvent) => !want?.length || want.some((k) => e.kind.startsWith(k));
        // the replay and the live feed join without a gap or a repeat: what's in the log now is read in this same turn
        // as the listener is attached; anything newer waits until the replay is out. The answer goes first.
        const { events } = this.log.since(num(p.fromSeq, 0), { kinds: want });
        const seq = this.log.last;
        const pending: IslandEvent[] = [];
        let replayed = false;
        const stop = this.log.listen((e) => { if (!match(e)) return; if (replayed) s.notify("event", e); else pending.push(e); });
        s.stop = stop;
        setImmediate(() => {
          if (s.stop !== stop) return;   // unsubscribed (or resubscribed) meanwhile
          for (const e of events) s.notify("event", e);
          replayed = true;
          for (const e of pending) s.notify("event", e);
        });
        return { seq };
      },
      "events.unsubscribe": (_p, s) => { s.stop?.(); s.stop = undefined; return {}; },
    };
  }

  /** Answer one call from a ferry. island.hello is handled first; nothing else is answered before it. */
  async call(method: string, params: unknown, s: Session): Promise<unknown> {
    const p = (params && typeof params === "object" && !Array.isArray(params) ? params : {}) as Record<string, unknown>;
    if (method === "island.hello") {
      if (!this.checkToken(p.token)) throw new IslandError(CODES.noHello, "this island doesn't know that token");
      if (p.protocol !== undefined && p.protocol !== PROTOCOL) throw new IslandError(CODES.noHello, `this island speaks ${PROTOCOL}, not ${String(p.protocol)}`);
      const f = (p.ferry && typeof p.ferry === "object" ? p.ferry : {}) as Record<string, unknown>;
      s.hello = true;
      s.ferry = typeof f.name === "string" && /^[\w.-]{1,40}$/.test(f.name) ? f.name : "ferry";
      s.actor = typeof p.as === "string" && /^[\w .'-]{1,60}$/.test(p.as) ? p.as : "someone";
      this.log.append({ actor: s.actor, via: this.via(s), kind: "ferry.hello", ferry: s.ferry, version: typeof f.version === "string" ? f.version.slice(0, 40) : undefined });
      return { island: { name: this.name, version: VERSION, protocol: PROTOCOL }, seq: this.log.last, as: s.actor };
    }
    if (!s.hello) throw new IslandError(CODES.noHello, "say island.hello first");
    const h = this.methods[method];
    if (!h) throw new IslandError(CODES.noMethod, `no such call: ${method}`);
    return await h(p, s);
  }

  open(notify: Session["notify"]): Session {
    const s: Session = { id: crypto.randomBytes(6).toString("hex"), hello: false, ferry: "", actor: "", notify };
    this.sessions.add(s);
    return s;
  }

  close(s: Session) {
    s.stop?.();
    this.sessions.delete(s);
    if (s.hello) this.log.append({ actor: s.actor, via: this.via(s), kind: "ferry.bye", ferry: s.ferry });
  }
}

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : d);
const kinds = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);
