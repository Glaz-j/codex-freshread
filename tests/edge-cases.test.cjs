"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { FreshReadEngine, STATES } = require("../src/freshread-core.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freshread-edge-"));
  const dataDir = path.join(root, ".plugin-data");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    dataDir,
    engine(sessionId = "edge-session", extra = {}) {
      return new FreshReadEngine({ cwd: root, dataDir, sessionId, ...extra });
    },
    file(relativePath, content) {
      const target = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
      return target;
    },
  };
}

function runWorker(args) {
  const script = path.resolve(__dirname, "helpers", "state-worker.cjs");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`worker exited ${code}: ${stderr}`)));
  });
}

test("concurrent hook processes do not lose snapshots or corrupt state", async (t) => {
  const fx = fixture(t);
  const files = Array.from({ length: 32 }, (_, index) => fx.file(`src/file-${index}.ts`, `export const n = ${index};\n`));
  await Promise.all(files.map((filePath) => runWorker([fx.root, fx.dataDir, "shared-session", filePath, "read"])));
  const report = fx.engine("shared-session").checkAll();
  assert.equal(report.corrupt, false);
  assert.equal(report.summary.tracked, files.length);
  assert.equal(report.summary.FRESH, files.length);
});

test("the same path can be stale-self in one session and stale-external in another", (t) => {
  const fx = fixture(t);
  const target = fx.file("src/shared.ts", "A\n");
  const first = fx.engine("session-one");
  const second = fx.engine("session-two");
  first.recordRead(target);
  second.recordRead(target);
  fs.writeFileSync(target, "B\n");
  first.recordSelfWrite(target);
  assert.equal(first.inspect(target).state, STATES.STALE_SELF);
  assert.equal(second.inspect(target).state, STATES.STALE_EXTERNAL);
});

test("content identity wins for delete/recreate and restored content", (t) => {
  const fx = fixture(t);
  const target = fx.file("src/auth.ts", "AAAA\n");
  const engine = fx.engine();
  engine.recordRead(target);
  fs.unlinkSync(target);
  assert.equal(engine.inspect(target).state, STATES.MISSING);
  fs.writeFileSync(target, "BBBB\n");
  assert.equal(engine.inspect(target).state, STATES.STALE_EXTERNAL);
  fs.writeFileSync(target, "AAAA\n");
  assert.equal(engine.inspect(target).state, STATES.FRESH);
});

test("same-size change with restored mtime is still detected through ctime/hash", (t) => {
  const fx = fixture(t);
  const target = fx.file("src/auth.ts", "AAAA\n");
  const engine = fx.engine();
  engine.recordRead(target);
  const original = fs.statSync(target);
  fs.writeFileSync(target, "BBBB\n");
  fs.utimesSync(target, original.atime, original.mtime);
  assert.equal(engine.inspect(target).state, STATES.STALE_EXTERNAL);
});

test("no-op self write remains FRESH", (t) => {
  const fx = fixture(t);
  const target = fx.file("src/auth.ts", "same\n");
  const engine = fx.engine();
  engine.recordRead(target);
  fs.writeFileSync(target, "same\n");
  engine.recordSelfWrite(target);
  assert.equal(engine.inspect(target).state, STATES.FRESH);
});

test("binary, empty, Unicode, and spaced file paths are tracked without storing content", (t) => {
  const fx = fixture(t);
  const files = [
    fx.file("src/empty.bin", Buffer.alloc(0)),
    fx.file("src/data.bin", Buffer.from([0, 1, 2, 255])),
    fx.file("src/中文 空格.ts", "const secretMarker = 'DO_NOT_PERSIST';\n"),
  ];
  const engine = fx.engine();
  for (const filePath of files) assert.equal(engine.recordRead(filePath).state, STATES.FRESH);
  assert.equal(engine.checkAll().summary.FRESH, files.length);
  const persisted = fs.readFileSync(engine.statePath, "utf8");
  assert.doesNotMatch(persisted, /DO_NOT_PERSIST/);
});

test("untracked repository noise does not increase checkpoint stat or hash work", (t) => {
  const fx = fixture(t);
  const tracked = fx.file("src/tracked.ts", "tracked\n");
  const engine = fx.engine();
  engine.recordRead(tracked);
  for (let index = 0; index < 2000; index += 1) fx.file(`noise/noise-${index}.txt`, "noise\n");
  const statBefore = engine.metrics.statCalls;
  const hashBefore = engine.metrics.hashCalls;
  const report = engine.checkAll();
  assert.equal(report.summary.tracked, 1);
  assert.equal(engine.metrics.statCalls - statBefore, 1);
  assert.equal(engine.metrics.hashCalls - hashBefore, 0);
});

test("recording ordinary files keeps path-resolution work linear", (t) => {
  const fx = fixture(t);
  const engine = fx.engine();
  const files = Array.from({ length: 100 }, (_, index) =>
    fx.file(`src/linear-${index}.ts`, `export const n = ${index};\n`));
  for (const filePath of files) assert.equal(engine.recordRead(filePath).state, STATES.FRESH);
  assert.equal(engine.checkAll().summary.tracked, files.length);
  assert.ok(engine.metrics.statCalls <= files.length * 4,
    `expected linear path-resolution work, observed ${engine.metrics.statCalls} stat calls`);
});

test("oversized and outside-workspace symlink targets fail visible as UNKNOWN", (t) => {
  const fx = fixture(t);
  const oversized = fx.file("src/large.bin", Buffer.alloc(32));
  const engine = fx.engine("limited", { maxFileBytes: 16 });
  const largeResult = engine.recordRead(oversized);
  assert.equal(largeResult.state, STATES.UNKNOWN);
  assert.match(largeResult.detail, /safety limit/);

  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "freshread-outside-"));
  t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));
  const outside = path.join(outsideRoot, "outside.ts");
  fs.writeFileSync(outside, "outside\n");
  const link = path.join(fx.root, "src", "outside-link.ts");
  fs.symlinkSync(outside, link, "file");
  const linkResult = fx.engine().recordRead(link);
  assert.equal(linkResult.state, STATES.UNKNOWN);
  assert.match(linkResult.detail, /outside the workspace/);
});

test("clear repairs corrupt state and leaves a valid empty session", (t) => {
  const fx = fixture(t);
  const target = fx.file("src/auth.ts", "A\n");
  const engine = fx.engine();
  engine.recordRead(target);
  fs.writeFileSync(engine.statePath, "{broken");
  assert.equal(fx.engine().clear().cleared, 0);
  const report = fx.engine().checkAll();
  assert.equal(report.corrupt, false);
  assert.equal(report.summary.tracked, 0);
});
