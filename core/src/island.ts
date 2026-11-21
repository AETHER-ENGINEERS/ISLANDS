// The island's core: its home folder, vault, chats and log, and the ferry protocol's calls (docs/protocol.md).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Vault } from "./vault.ts";
import { EventLog, type IslandEvent } from "./log.ts";
import { Chats } from "./chats.ts";
import { IslandError, CODES, badParams } from "./errors.ts";

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
  private methods: Record<string, Handler>;

  constructor(home: string, { name = "island", token = crypto.randomBytes(32).toString("base64url") } = {}) {
    this.name = name;
    this.dirs = layout(home);
    this.vault = new Vault(this.dirs.vault, this.dirs.trash);
    this.log = new EventLog(this.dirs.log);
    this.chats = new Chats(this.dirs.chats, this.log);
    this.token = token;
    this.methods = this.calls();
  }

  /** Is this the island's token? (compared in constant time) */
  checkToken(t: unknown) {
    if (typeof t !== "string") return false;
    const a = crypto.createHash("sha256").update(t).digest();
    const b = crypto.createHash("sha256").update(this.token).digest();
    return crypto.timingSafeEqual(a, b);
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
