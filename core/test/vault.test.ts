import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Vault } from "../src/vault.ts";
import { IslandError, CODES } from "../src/errors.ts";

const setup = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "island-vault-"));
  return { d, v: new Vault(path.join(d, "vault"), path.join(d, "trash")) };
};
const code = (f: () => unknown) => { try { f(); } catch (e) { return e instanceof IslandError ? e.code : -1; } return 0; };

test("a vault path is an ordinary file in the folder", () => {
  const { d, v } = setup();
  const e = v.write("/Pandora/SOUL.md", Buffer.from("# Pandora Dee Fae"));
  assert.equal(fs.readFileSync(path.join(d, "vault", "Pandora", "SOUL.md"), "utf8"), "# Pandora Dee Fae");
  assert.equal(e.size, 17);
  assert.equal(v.read("/Pandora/SOUL.md").data.toString(), "# Pandora Dee Fae");
  assert.deepEqual(v.list("/").map((x) => [x.path, x.dir]), [["/Pandora", true], ["/Pandora/SOUL.md", false]]);
});

test("what someone else writes in the folder is what the vault reads", () => {
  const { d, v } = setup();
  fs.mkdirSync(path.join(d, "vault", "notes"), { recursive: true });
  fs.writeFileSync(path.join(d, "vault", "notes", "dropped.md"), "dropped in by Mrrowr-murrr");
  assert.equal(v.read("/notes/dropped.md").data.toString(), "dropped in by Mrrowr-murrr");
});

test("paths can't reach outside the vault", () => {
  const { d, v } = setup();
  for (const bad of ["/../x.md", "/a/../../x.md", "x.md", "/a\\..\\x.md", "/a/./b.md"]) assert.equal(code(() => v.write(bad, Buffer.from("x"))), CODES.refused, bad);
  assert.equal(code(() => v.write("/", Buffer.from("x"))), CODES.refused);
  assert.equal(code(() => v.read(42 as unknown as string)), CODES.badParams);
  assert.ok(!fs.existsSync(path.join(d, "x.md")));
  if (process.platform === "win32") assert.equal(code(() => v.write("/con:x.md", Buffer.from("x"))), CODES.refused);
  else {
    fs.mkdirSync(path.join(d, "elsewhere"));
    fs.writeFileSync(path.join(d, "elsewhere", "secret"), "s");
    fs.symlinkSync(path.join(d, "elsewhere"), path.join(d, "vault", "link"));
    assert.equal(code(() => v.read("/link/secret")), CODES.refused);
    assert.equal(code(() => v.write("/link/new", Buffer.from("x"))), CODES.refused);
    assert.ok(!v.list("/").some((e) => e.path.startsWith("/link")), "a link out of the vault isn't listed");
  }
});

test("writes are whole: a stale temp file is never listed, and ifMtime catches a change", () => {
  const { d, v } = setup();
  const first = v.write("/a.md", Buffer.from("one"));
  fs.writeFileSync(path.join(d, "vault", "a.md.123.abcd.islandtmp"), "half");
  assert.deepEqual(v.list("/").map((e) => e.path), ["/a.md"]);
  assert.equal(code(() => v.write("/a.md", Buffer.from("two"), first.mtime - 1000)), CODES.conflict);
  assert.equal(v.read("/a.md").data.toString(), "one");
  v.write("/a.md", Buffer.from("two"), first.mtime);
  assert.equal(v.read("/a.md").data.toString(), "two");
});

test("nothing is removed outright: deletes and replaced files go to the trash", () => {
  const { d, v } = setup();
  v.write("/notes/a.md", Buffer.from("a"));
  v.write("/notes/b.md", Buffer.from("b"));
  const r = v.delete("/notes/a.md");
  assert.ok(!fs.existsSync(path.join(d, "vault", "notes", "a.md")));
  assert.equal(fs.readFileSync(r.trash, "utf8"), "a");
  assert.ok(r.trash.startsWith(path.join(d, "trash")) && r.trash.endsWith(path.join("notes", "a.md")));
  v.write("/c.md", Buffer.from("c"));
  v.move("/c.md", "/notes/b.md");
  assert.equal(v.read("/notes/b.md").data.toString(), "c");
  const trashed: string[] = [];
  const walk = (x: string) => { for (const e of fs.readdirSync(x, { withFileTypes: true })) e.isDirectory() ? walk(path.join(x, e.name)) : trashed.push(fs.readFileSync(path.join(x, e.name), "utf8")); };
  walk(path.join(d, "trash"));
  assert.deepEqual(trashed.sort(), ["a", "b"]);
  assert.equal(code(() => v.move("/notes", "/notes/inner")), CODES.refused);
  assert.equal(code(() => v.delete("/missing.md")), CODES.notFound);
});
