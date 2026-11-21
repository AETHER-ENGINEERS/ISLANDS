// Moving in: a full backup from her Atelier (pandora-dee / Jade Vault, "Export everything") brought into the island.
//
// - Vault files: written into the vault. A file the island already has with the same contents is left alone; with
//   other contents, the island's stays and the backup's is saved beside it, marked "from the Atelier <time>".
// - Chats: each Atelier session becomes an island chat file, with its messages' times, her thinking, tool calls and
//   tool results kept whole (the shapes the island sends back to models). Errors and compactions become notes.
// - Schedules: brought in switched off (prompt schedules as prompts; command schedules as notes for her to look at,
//   since the Atelier's shell was BusyBox and the island's is real). She turns them on from the window.
// - Keys and settings are never brought in: her keys go in through a window, sealed to the island's account. The
//   report names what the backup carried and what was left out.
// Running it again brings nothing in twice. It runs while the core is stopped, so the island's log has one writer.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { Vault, sha256, stamp } from "./vault.ts";
import { EventLog } from "./log.ts";
import { layout } from "./island.ts";
import { parseWhen } from "./schedules.ts";

export interface ImportReport {
  vault: { written: number; same: number; beside: string[]; refused: string[] };
  chats: { imported: number; skipped: number; messages: number };
  schedules: { imported: number; notes: string[] };
  leftOut: string[];
  file: string;
}

/** Read a backup: plain JSON, or gzipped JSON. */
export function readBackup(file: string): any {
  let buf = fs.readFileSync(file);
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  const data = JSON.parse(buf.toString("utf8"));
  if (data?.app !== "jade-vault" || !data.vault) throw new Error("that isn't a Pandora Dee or Jade Vault backup");
  return data;
}

const chatId = (sid: string) => `atelier-${String(sid).toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 48) || crypto.randomBytes(4).toString("hex")}`;
const iso = (t: unknown, fallback: string) => (typeof t === "number" && t > 0 ? new Date(t).toISOString() : typeof t === "string" && !Number.isNaN(Date.parse(t)) ? new Date(t).toISOString() : fallback);

/** One Atelier session's messages, as island chat lines (without n). */
export function convertMessages(msgs: any[], fallbackAt: string, who: { person: string; self: string }) {
  const out: Array<Record<string, unknown>> = [];
  let seq = 0;
  const pending: Array<{ id: string; name: string }> = [];
  for (const m of Array.isArray(msgs) ? msgs : []) {
    if (!m || typeof m !== "object") continue;
    const at = iso(m.ts, fallbackAt);
    if (m.role === "user") out.push({ role: "user", content: String(m.content ?? ""), at, by: m._hb ? "heartbeat" : who.person });
    else if (m.role === "assistant") {
      if (m._error) { out.push({ role: "system", content: `(an error in the Atelier: ${String(m._error).slice(0, 2000)})`, at, by: who.self }); continue; }
      const line: Record<string, unknown> = { role: "assistant", content: String(m.content ?? ""), at, by: who.self };
      if (typeof m.thinking === "string" && m.thinking) line.reasoning_content = m.thinking;
      if (typeof m.model === "string") line.model = m.model;
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        line.tool_calls = m.tool_calls.map((tc: any) => {
          const id = String(tc._id ?? tc.id ?? `call_import_${++seq}`);
          const name = String(tc.function?.name ?? "tool");
          const a = tc.function?.arguments;
          pending.push({ id, name });
          return { id, type: "function", function: { name, arguments: typeof a === "string" ? a : JSON.stringify(a ?? {}) } };
        });
      }
      out.push(line);
    } else if (m.role === "tool") {
      const name = String(m.tool_name ?? "tool");
      let i = pending.findIndex((p) => (m._for ? p.id === m._for : p.name === name));
      if (i < 0) i = 0;
      const id = pending.length ? pending.splice(i, 1)[0].id : `call_import_${++seq}`;
      out.push({ role: "tool", content: String(m.content ?? ""), at, by: who.self, tool_call_id: id, name });
    } else if (m.role === "compaction") out.push({ role: "system", content: `(earlier turns, compacted in the Atelier)\n${String(m.summary ?? "")}`, at, by: who.self });
    else if (m.role === "system") out.push({ role: "system", content: String(m.content ?? ""), at, by: who.self });
  }
  return out;
}

export function importBackup(home: string, file: string, opts: { person?: string; self?: string; now?: Date } = {}): ImportReport {
  const dirs = layout(home);
  const info = path.join(dirs.state, "core.json");
  if (fs.existsSync(info)) {
    const pid = JSON.parse(fs.readFileSync(info, "utf8")).pid;
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch (e) { alive = (e as NodeJS.ErrnoException).code === "EPERM"; }
    if (alive) throw new Error(`the island's core is running (pid ${pid}): stop it first (the harbor service, or Ctrl+C), so the move-in is the only writer`);
  }
  const data = readBackup(file);
  const now = opts.now ?? new Date();
  const when = stamp(now);
  const who = { person: opts.person ?? "someone", self: opts.self ?? "pandora" };
  const vault = new Vault(dirs.vault, dirs.trash);
  const log = new EventLog(dirs.log);
  const via = `import:${path.basename(file)}`;
  const report: ImportReport = { vault: { written: 0, same: 0, beside: [], refused: [] }, chats: { imported: 0, skipped: 0, messages: 0 }, schedules: { imported: 0, notes: [] }, leftOut: [], file: "" };

  // ---- the vault ----
  for (const d of Array.isArray(data.vault.dirs) ? data.vault.dirs : []) { try { vault.mkdir(d); } catch {} }
  for (const [p, v] of Object.entries<any>(data.vault.files ?? {})) {
    const bytes = typeof v === "string" ? Buffer.from(v, "utf8") : v?.base64 ? Buffer.from(v.base64, "base64") : Buffer.from(JSON.stringify(v), "utf8");
    try {
      let target = p;
      try {
        const have = vault.read(p).data;
        if (have.equals(bytes)) { report.vault.same++; continue; }
        const dot = p.lastIndexOf("."), slash = p.lastIndexOf("/");
        const [stem, ext] = dot > slash + 1 ? [p.slice(0, dot), p.slice(dot)] : [p, ""];
        target = `${stem} (from the Atelier ${when})${ext}`;
        // a copy beside it from an earlier move-in, with these same contents, is enough
        const parent = p.slice(0, slash) || "/";
        const base = stem.slice(slash + 1);
        const earlier = (() => { try { return vault.list(parent, false); } catch { return []; } })()
          .filter((e) => !e.dir && e.path.slice(e.path.lastIndexOf("/") + 1).startsWith(`${base} (from the Atelier `) && e.path.endsWith(ext));
        if (earlier.some((e) => { try { return vault.read(e.path).data.equals(bytes); } catch { return false; } })) { report.vault.same++; continue; }
        report.vault.beside.push(target);
      } catch (e) {
        if ((e as { code?: number }).code !== -32001) throw e;   // not there yet: write it as it is
      }
      vault.write(target, bytes);
      log.append({ actor: who.person, via, kind: "vault.write", subject: target, sha256: sha256(bytes), bytes: bytes.length });
      report.vault.written++;
    } catch (e) { report.vault.refused.push(`${p}: ${(e as Error).message}`); }
  }

  // ---- chats ----
  const db = data.db ?? {};
  const index: any[] = Array.isArray(db.sessions) ? db.sessions : [];
  const ids = new Set<string>([...index.map((s) => String(s.id)), ...Object.keys(db).filter((k) => k.startsWith("session:")).map((k) => k.slice(8))]);
  for (const sid of ids) {
    const s = db[`session:${sid}`];
    if (!s || !Array.isArray(s.messages)) continue;
    const id = chatId(sid);
    const fileOf = path.join(dirs.chats, `${id}.jsonl`);
    if (fs.existsSync(fileOf)) { report.chats.skipped++; continue; }
    const updated = iso(s.updated ?? index.find((x) => String(x.id) === sid)?.updated, now.toISOString());
    const first = s.messages.find((m: any) => typeof m?.ts === "number")?.ts;
    const created = iso(first, updated);
    const lines = convertMessages(s.messages, updated, who);
    const meta = { type: "chat", id, title: String(s.title || "From the Atelier").slice(0, 200), created, from: "atelier" };
    const body = [JSON.stringify(meta), ...lines.map((l, i) => JSON.stringify({ type: "message", n: i + 1, ...l }))].join("\n") + "\n";
    fs.writeFileSync(fileOf, body, { flag: "wx" });
    log.append({ actor: who.person, via, kind: "chat.create", chat: id, messages: lines.length });
    report.chats.imported++;
    report.chats.messages += lines.length;
  }

  // ---- schedules (switched off) ----
  const schedFile = path.join(dirs.config, "schedules.json");
  let scheds: any[] = [];
  try { scheds = JSON.parse(fs.readFileSync(schedFile, "utf8")); } catch {}
  const known = new Set(scheds.map((x) => x.from).filter(Boolean));
  for (const s of Array.isArray(db.schedules) ? db.schedules : []) {
    const from = `atelier:${s.id}`;
    if (known.has(from)) continue;
    const name = String(s.name || s.prompt || "Atelier schedule").slice(0, 100);
    const whenText = String(s.cron || "");
    let ok = false;
    try { if (whenText && !s.once) { parseWhen(whenText); ok = true; } } catch {}
    if (!ok) { report.schedules.notes.push(`"${name}" (${s.whenText || s.cron || "once"}): its time isn't one the island reads yet; set it again from the window`); continue; }
    if (s.kind && s.kind !== "prompt" && !s.prompt) { report.schedules.notes.push(`"${name}": a ${s.kind} schedule (${s.command || s.flow || s.playbook || ""}); the island's shell is real, not BusyBox, so it's left for you to set up again`); continue; }
    scheds.push({ id: `sch-${crypto.randomBytes(4).toString("hex")}`, name, when: whenText, prompt: String(s.prompt), enabled: false, created: now.toISOString(), from });
    report.schedules.imported++;
  }
  if (report.schedules.imported) {
    const tmp = schedFile + ".new";
    fs.writeFileSync(tmp, JSON.stringify(scheds, null, 2));
    fs.renameSync(tmp, schedFile);
  }

  // ---- what stayed behind ----
  if (data.includesKeys) report.leftOut.push("API keys: the backup carries some. Put them in from the window's Keys tab; they're sealed to the island's account there.");
  report.leftOut.push("Atelier settings (models, providers, themes): the island has its own config/island.json.");
  const other = Object.keys(db).filter((k) => k !== "sessions" && k !== "schedules" && !k.startsWith("session:"));
  if (other.length) report.leftOut.push(`Other Atelier records, kept in the backup file: ${other.slice(0, 30).join(", ")}${other.length > 30 ? " …" : ""}`);
  if (data.storage && Object.keys(data.storage).length) report.leftOut.push(`Atelier browser storage entries: ${Object.keys(data.storage).length}, kept in the backup file.`);

  // ---- the report, in her vault ----
  const lines = [
    `# Moving in from the Atelier`,
    ``,
    `- From: \`${path.basename(file)}\` (exported ${String(data.exportedAt ?? "?").slice(0, 19).replace("T", " ")})`,
    `- Moved in: ${now.toString()}`,
    ``,
    `## Vault`,
    `- ${report.vault.written} files written, ${report.vault.same} already here as they were.`,
    ...(report.vault.beside.length ? [`- ${report.vault.beside.length} were already here with other contents. Yours here stayed, and the Atelier's version is beside each:`, ...report.vault.beside.map((b) => `  - \`${b}\``)] : []),
    ...(report.vault.refused.length ? [`- Couldn't bring in:`, ...report.vault.refused.map((r) => `  - ${r}`)] : []),
    ``,
    `## Chats`,
    `- ${report.chats.imported} chats (${report.chats.messages} messages)${report.chats.skipped ? `, ${report.chats.skipped} already here` : ""}.`,
    ``,
    `## Schedules`,
    `- ${report.schedules.imported} brought in, switched off: turn them on from the window when you want them.`,
    ...report.schedules.notes.map((n) => `- ${n}`),
    ``,
    `## Left in the backup`,
    ...report.leftOut.map((n) => `- ${n}`),
    ``,
  ].join("\n");
  const rp = `/Pandora/Island/Moving in ${when}.md`;
  vault.write(rp, Buffer.from(lines, "utf8"));
  report.file = rp;
  log.append({ actor: who.person, via, kind: "island.import", files: report.vault.written, beside: report.vault.beside.length, chats: report.chats.imported, schedules: report.schedules.imported, report: rp });
  return report;
}
