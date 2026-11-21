// Chats as files: chats/<id>.jsonl, a first line with the chat's details, then one line per message. Readable with
// any editor, without the island running. The log records that a message was added and its fingerprint, not its words.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { EventLog } from "./log.ts";
import { sha256 } from "./vault.ts";
import { notFound, badParams } from "./errors.ts";

export interface ChatMeta {
  type: "chat";
  id: string;
  title: string;
  created: string;
}
export interface Message {
  n: number;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  at: string;
  by: string;
  [field: string]: unknown;
}
const ROLES = new Set(["user", "assistant", "system", "tool"]);
const ID = /^[a-z0-9-]{6,64}$/;

export class Chats {
  readonly dir: string;
  readonly log: EventLog;

  constructor(dir: string, log: EventLog) {
    this.dir = path.resolve(dir);
    this.log = log;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private fileOf(id: unknown) {
    if (typeof id !== "string" || !ID.test(id)) throw badParams("that isn't a chat id");
    return path.join(this.dir, `${id}.jsonl`);
  }

  private load(id: string): { meta: ChatMeta; messages: Message[] } {
    const file = this.fileOf(id);
    let text: string;
    try { text = fs.readFileSync(file, "utf8"); } catch { throw notFound(`chat ${id}`); }
    const lines = text.split("\n").filter(Boolean);
    let meta: ChatMeta | null = null;
    const messages: Message[] = [];
    for (const line of lines) {
      let o: Record<string, unknown>;
      try { o = JSON.parse(line); } catch { continue; }   // a line cut short by a crash is skipped, the rest still reads
      if (o.type === "chat") meta = o as unknown as ChatMeta;
      else if (o.type === "rename" && meta) meta = { ...(meta as ChatMeta), title: String(o.title) };
      else if (o.type === "message") { const { type: _t, ...m } = o; messages.push(m as unknown as Message); }
    }
    if (!meta) throw notFound(`chat ${id}`);
    return { meta, messages };
  }

  list() {
    const out: Array<{ id: string; title: string; created: string; updated: string; messages: number }> = [];
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const id = f.slice(0, -6);
      try {
        const { meta, messages } = this.load(id);
        const updated = messages.length ? messages[messages.length - 1].at : meta.created;
        out.push({ id, title: meta.title, created: meta.created, updated, messages: messages.length });
      } catch {}
    }
    return out.sort((a, b) => (a.updated < b.updated ? 1 : -1));
  }

  create(title: unknown, actor: string, via: string) {
    const created = new Date().toISOString();
    const id = `${created.slice(0, 10)}-${crypto.randomBytes(4).toString("hex")}`;
    const meta: ChatMeta = { type: "chat", id, title: typeof title === "string" && title.trim() ? title.trim().slice(0, 200) : "New chat", created };
    fs.writeFileSync(this.fileOf(id), JSON.stringify(meta) + "\n", { flag: "wx" });
    this.log.append({ actor, via, kind: "chat.create", chat: id });
    return { id, title: meta.title, created };
  }

  open(id: string) {
    const { meta, messages } = this.load(id);
    return { chat: { id: meta.id, title: meta.title, created: meta.created }, messages };
  }

  post(id: string, role: unknown, content: unknown, actor: string, via: string) {
    if (typeof content !== "string") throw badParams("content is text");
    const r = role === undefined ? "user" : role;
    if (typeof r !== "string" || !ROLES.has(r)) throw badParams("role is user, assistant, system or tool");
    const { messages } = this.load(id);
    const at = new Date().toISOString();
    const n = messages.length ? messages[messages.length - 1].n + 1 : 1;
    fs.appendFileSync(this.fileOf(id), JSON.stringify({ type: "message", n, role: r, content, at, by: actor }) + "\n");
    this.log.append({ actor, via, kind: "chat.message", chat: id, n, role: r, sha256: sha256(content), bytes: Buffer.byteLength(content) });
    return { n, at };
  }

  rename(id: string, title: unknown, actor: string, via: string) {
    if (typeof title !== "string" || !title.trim()) throw badParams("a title is text");
    this.load(id);
    fs.appendFileSync(this.fileOf(id), JSON.stringify({ type: "rename", title: title.trim().slice(0, 200), at: new Date().toISOString(), by: actor }) + "\n");
    this.log.append({ actor, via, kind: "chat.rename", chat: id });
    return this.open(id).chat;
  }
}
