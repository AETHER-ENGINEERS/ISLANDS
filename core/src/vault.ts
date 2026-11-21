// The vault: a real folder. Vault paths ("/Pandora/SOUL.md") map straight onto files under one root, so the vault is
// an ordinary folder that shells, editors, file managers and MCP file tools all see the same way.
//
// - Every path stays inside the root; a link inside it that leads out is not followed.
// - Writes are atomic: a temporary file next to the target, renamed into place.
// - Nothing is removed outright: a delete, or a file a move replaces, goes to the island's trash, dated, keeping its
//   place in the vault.
//
// Grown from the folder host in pandora-dee's desktop try (MIT; see THIRD_PARTY_NOTICES.md).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { notFound, refused, conflict, badParams } from "./errors.ts";

export const TMP = ".islandtmp";

export interface Entry {
  path: string;
  dir: boolean;
  size: number;
  mtime: number;
}

const caseless = process.platform === "win32" || process.platform === "darwin";
const same = (a: string, b: string) => (caseless ? a.toLowerCase() === b.toLowerCase() : a === b);

export const sha256 = (data: Buffer | string) => crypto.createHash("sha256").update(data).digest("hex");

/** A time people can read in a folder name: 2026-11-21 091403 */
export function stamp(d = new Date()) {
  const t = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${t(d.getMonth() + 1)}-${t(d.getDate())} ${t(d.getHours())}${t(d.getMinutes())}${t(d.getSeconds())}`;
}

export class Vault {
  readonly root: string;
  readonly trash: string;

  constructor(root: string, trash: string) {
    this.root = path.resolve(root);
    this.trash = path.resolve(trash);
    fs.mkdirSync(this.root, { recursive: true });
  }

  private inside(full: string) {
    const r = this.root + path.sep;
    return caseless ? full.toLowerCase().startsWith(r.toLowerCase()) : full.startsWith(r);
  }

  /** Check a vault path and give its parts. "/" is allowed only where `root` is. */
  parts(vp: unknown, { root = false } = {}): string[] {
    if (typeof vp !== "string") throw badParams("a vault path is a string");
    if (!vp.startsWith("/") || vp.includes("\0") || vp.includes("\\")) throw refused(`${vp}: a vault path starts with / and uses /`);
    const parts = vp.split("/").filter(Boolean);
    for (const p of parts) {
      if (p === "." || p === "..") throw refused(`${vp}: no . or .. in vault paths`);
      if (process.platform === "win32" && (/[<>:"|?*\x00-\x1f]/.test(p) || /[. ]$/.test(p))) throw refused(`${vp}: Windows can't hold the name "${p}"`);
    }
    if (!parts.length && !root) throw refused("that is the vault itself");
    return parts;
  }

  /** The real file behind a vault path. Refuses anything that would reach outside the vault. */
  file(vp: unknown, opts: { root?: boolean } = {}): string {
    const parts = this.parts(vp, opts);
    if (!parts.length) return this.root;
    const full = path.resolve(this.root, ...parts);
    if (!this.inside(full)) throw refused(`${vp} isn't inside the vault`);
    // a link must not lead out: check the deepest part that exists
    let probe = full;
    while (!fs.existsSync(probe) && probe !== this.root) probe = path.dirname(probe);
    if (probe !== this.root) {
      const real = fs.realpathSync(probe);
      if (!this.inside(real) && !same(real, fs.realpathSync(this.root))) throw refused(`${vp} leads outside the vault`);
    }
    return full;
  }

  vaultPath(full: string) {
    return "/" + path.relative(this.root, full).split(path.sep).join("/");
  }

  stat(vp: string): Entry {
    const full = this.file(vp, { root: true });
    let st: fs.Stats;
    try { st = fs.statSync(full); } catch { throw notFound(vp); }
    return { path: vp === "" ? "/" : vp, dir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size, mtime: Math.floor(st.mtimeMs) };
  }

  list(vp = "/", recursive = true): Entry[] {
    const start = this.file(vp, { root: true });
    let st: fs.Stats;
    try { st = fs.statSync(start); } catch { throw notFound(vp); }
    if (!st.isDirectory()) throw refused(`${vp}: not a folder`);
    const out: Entry[] = [];
    const walk = (dir: string) => {
      let names: fs.Dirent[];
      try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of names) {
        const full = path.join(dir, e.name);
        if (e.name.endsWith(TMP)) continue;
        if (e.isSymbolicLink()) {
          let real = "";
          try { real = fs.realpathSync(full); } catch {}
          if (!real || !this.inside(real)) continue;
        }
        let s: fs.Stats;
        try { s = fs.statSync(full); } catch { continue; }
        if (s.isDirectory()) {
          out.push({ path: this.vaultPath(full), dir: true, size: 0, mtime: Math.floor(s.mtimeMs) });
          if (recursive) walk(full);
        } else if (s.isFile()) out.push({ path: this.vaultPath(full), dir: false, size: s.size, mtime: Math.floor(s.mtimeMs) });
      }
    };
    walk(start);
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  read(vp: string): { data: Buffer; size: number; mtime: number } {
    const full = this.file(vp);
    let st: fs.Stats;
    try { st = fs.statSync(full); } catch { throw notFound(vp); }
    if (st.isDirectory()) throw refused(`${vp}: is a folder`);
    const data = fs.readFileSync(full);
    return { data, size: data.length, mtime: Math.floor(st.mtimeMs) };
  }

  /** Write a whole file, atomically. With ifMtime, a file that changed since then is a conflict. */
  write(vp: string, data: Buffer, ifMtime?: number): Entry {
    const full = this.file(vp);
    const now = fs.existsSync(full) ? fs.statSync(full) : null;
    if (now?.isDirectory()) throw refused(`${vp}: is a folder`);
    if (ifMtime !== undefined && now && Math.floor(now.mtimeMs) !== ifMtime) throw conflict(`${vp} changed since you read it`);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const tmp = `${full}.${process.pid}.${crypto.randomBytes(4).toString("hex")}${TMP}`;
    try {
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, full);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
    const st = fs.statSync(full);
    return { path: vp, dir: false, size: st.size, mtime: Math.floor(st.mtimeMs) };
  }

  mkdir(vp: string) {
    const full = this.file(vp);
    if (fs.existsSync(full) && !fs.statSync(full).isDirectory()) throw conflict(`${vp}: a file is there`);
    fs.mkdirSync(full, { recursive: true });
    return { path: vp };
  }

  /** Move a file or folder into the trash, keeping its place in the vault. Returns where it went. */
  toTrash(full: string, batch = stamp()) {
    const dest = path.join(this.trash, batch, path.relative(this.root, full));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    let to = dest;
    for (let i = 2; fs.existsSync(to); i++) to = `${dest} (${i})`;
    try {
      fs.renameSync(full, to);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
      fs.cpSync(full, to, { recursive: true });
      fs.rmSync(full, { recursive: true, force: true });
    }
    return to;
  }

  delete(vp: string) {
    const full = this.file(vp);
    if (!fs.existsSync(full)) throw notFound(vp);
    return { path: vp, trash: this.toTrash(full) };
  }

  move(from: string, to: string) {
    const a = this.file(from), b = this.file(to);
    if (!fs.existsSync(a)) throw notFound(from);
    if (same(a, b)) return { from, to };
    const under = (x: string, y: string) => (caseless ? x.toLowerCase().startsWith(y.toLowerCase()) : x.startsWith(y));
    if (under(b + path.sep, a + path.sep)) throw refused(`can't move ${from} into itself`);
    if (fs.existsSync(b) && !same(fs.realpathSync(a), fs.realpathSync(b))) this.toTrash(b);
    fs.mkdirSync(path.dirname(b), { recursive: true });
    fs.renameSync(a, b);
    return { from, to };
  }
}
