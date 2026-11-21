import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keys } from "../src/keys.ts";
import { requestBody } from "../src/models.ts";
import { pickShell } from "../src/tools.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "island-keys-"));

test("file keystore: set, fill, mask, delete to the trash", () => {
  const d = tmp();
  const k = new Keys(path.join(d, "keys"), "file");
  k.set("API_KEY", "abcdef123456");
  assert.deepEqual(k.list(), [{ name: "API_KEY", backend: "file" }]);
  assert.equal(new Keys(path.join(d, "keys"), "file").fill("Bearer {{API_KEY}}"), "Bearer abcdef123456");
  assert.equal(k.mask("got abcdef123456 back"), "got {{API_KEY}} back");
  assert.throws(() => k.fill("{{MISSING}}"), /MISSING: not found/);
  k.delete("API_KEY", path.join(d, "trash"));
  assert.deepEqual(k.list(), []);
  assert.equal(fs.readdirSync(path.join(d, "trash", "keys")).length, 1);
});

test("DPAPI keystore: sealed to this account, opens again", { skip: process.platform !== "win32" }, () => {
  const d = tmp();
  const k = new Keys(path.join(d, "keys"), "dpapi");
  k.set("SEALED", "a value nobody else may read");
  const stored = fs.readFileSync(path.join(d, "keys", "SEALED.dpapi"), "utf8");
  assert.ok(!stored.includes("nobody else") && /^[A-Za-z0-9+/=]+$/.test(stored.trim()), "only the sealed form is on disk");
  assert.equal(new Keys(path.join(d, "keys"), "dpapi").reveal("SEALED"), "a value nobody else may read");
});

test("a model's request: its params ride along, fixed sampling settings stay out", () => {
  const b = requestBody({ url: "x", model: "m", params: { reasoning_effort: "max" } }, [], [], { temperature: 0.7, prompt_cache_options: { ttl: "1h" } });
  assert.deepEqual(b, { reasoning_effort: "max", prompt_cache_options: { ttl: "1h" }, model: "m", messages: [], stream: true });
  const own = requestBody({ url: "x", model: "m", params: { temperature: 0.2 } }, [], []);
  assert.equal(own.temperature, 0.2, "a model that takes temperature can have it set in its own params");
  assert.ok(!("reasoning_effort" in requestBody({ url: "x", model: "m", omit: ["reasoning_effort"] }, [], [], { reasoning_effort: "max" })));
});

test("the shell: bash where there is one, PowerShell or a configured shell otherwise", () => {
  assert.deepEqual(pickShell("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe").args("dir"), ["-NoProfile", "-NonInteractive", "-Command", "dir"]);
  assert.deepEqual(pickShell("/usr/bin/zsh").args("ls"), ["-c", "ls"]);
  assert.ok(pickShell().file.length > 0);
});
