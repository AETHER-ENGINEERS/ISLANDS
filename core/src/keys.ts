// Her keys: one sealed file per key in keys/. On Windows each is sealed with DPAPI under the island's own account, so
// only that account can open it: not the person's account, not an administrator reading the disk, not anyone helping
// build the island. Elsewhere (Linux, CI) a key is a file only its owner may read.
//
// A key's value never enters the log, a chat, a ferry or a tool's output. Settings and tools name a key as {{NAME}};
// the island fills it in at the last moment, and anything that comes back holding a value has it masked again.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { badParams, notFound } from "./errors.ts";

export const KEY_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const PS = "powershell.exe";
const PROTECT = "Add-Type -AssemblyName System.Security; $in=[Console]::In.ReadToEnd(); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($in), $null, 'CurrentUser'))";
const UNPROTECT = "Add-Type -AssemblyName System.Security; $in=[Console]::In.ReadToEnd().Trim(); [Console]::Out.Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($in), $null, 'CurrentUser')))";
const ps = (script: string, input: string) => execFileSync(PS, ["-NoProfile", "-NonInteractive", "-Command", script], { input, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });

export class Keys {
  readonly dir: string;
  readonly backend: "dpapi" | "file";
  private cache = new Map<string, string>();

  constructor(dir: string, backend: "dpapi" | "file") {
    this.dir = path.resolve(dir);
    this.backend = backend === "dpapi" && process.platform !== "win32" ? "file" : backend;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private fileOf(name: string) {
    if (!KEY_NAME.test(name)) throw badParams(`"${name}" isn't a key name (letters, digits and _; up to 64)`);
    return path.join(this.dir, `${name}.${this.backend === "dpapi" ? "dpapi" : "key"}`);
  }

  list(): Array<{ name: string; backend: string }> {
    const ext = this.backend === "dpapi" ? ".dpapi" : ".key";
    return fs.readdirSync(this.dir).filter((f) => f.endsWith(ext)).map((f) => ({ name: f.slice(0, -ext.length), backend: this.backend })).sort((a, b) => a.name.localeCompare(b.name));
  }

  has(name: string) {
    return KEY_NAME.test(name) && fs.existsSync(this.fileOf(name));
  }

  set(name: string, value: unknown) {
    if (typeof value !== "string" || !value) throw badParams("a key's value is text");
    const file = this.fileOf(name);
    const tmp = file + ".new";
    if (this.backend === "dpapi") fs.writeFileSync(tmp, ps(PROTECT, value).trim());
    else fs.writeFileSync(tmp, value, { mode: 0o600 });
    fs.renameSync(tmp, file);
    this.cache.set(name, value);
  }

  /** The value, for the island's own use only (filling in {{NAME}}). Never handed to a ferry. */
  reveal(name: string): string {
    const hit = this.cache.get(name);
    if (hit !== undefined) return hit;
    const file = this.fileOf(name);
    let stored: string;
    try { stored = fs.readFileSync(file, "utf8"); } catch { throw notFound(`key ${name}`); }
    const value = this.backend === "dpapi" ? ps(UNPROTECT, stored) : stored;
    this.cache.set(name, value);
    return value;
  }

  /** Remove a key: its sealed file goes to the trash folder (still sealed), never left readable. */
  delete(name: string, trashDir: string) {
    const file = this.fileOf(name);
    if (!fs.existsSync(file)) throw notFound(`key ${name}`);
    const dest = path.join(trashDir, "keys", `${Date.now()}-${path.basename(file)}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(file, dest);
    this.cache.delete(name);
  }

  /** Fill in {{NAME}} from the keystore. A name that isn't there is an error, so nothing goes out half-filled. */
  fill(text: string): string {
    return text.replace(/\{\{([A-Za-z_][A-Za-z0-9_]{0,63})\}\}/g, (_m, n: string) => this.reveal(n));
  }

  /** Mask every key value this island has opened, wherever it shows up in text going to a model, a chat or a ferry. */
  mask(text: string): string {
    let out = text;
    for (const [name, value] of this.cache) if (value.length >= 6 && out.includes(value)) out = out.split(value).join(`{{${name}}}`);
    return out;
  }
}
