"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { FreshReadEngine, STATES, displayPath, modelSafeFragment, pathKey } = require("../src/freshread-core.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freshread-core-hardening-"));
  const dataDir = path.join(root, ".state");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    dataDir,
    engine(sessionId = "hardening-session", extra = {}) {
      return new FreshReadEngine({ cwd: root, dataDir, sessionId, ...extra });
    },
    file(relativePath, content = "A\n") {
      const target = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
      return target;
    },
  };
}

function linkDirectory(target, alias) {
  fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
}

function unlinkDirectory(alias) {
  fs.unlinkSync(alias);
}

function readEvidence(engine, filePath) {
  const capture = engine._capture(filePath, null, true);
  assert.equal(capture.kind, "file");
  return {
    path: capture.path,
    hash: capture.hash,
    metadata: capture.metadata,
    readAt: new Date().toISOString(),
  };
}

test("display paths neutralize line and bidi control characters", (t) => {
  const fx = fixture(t);
  const unsafe = path.join(fx.root, "line\u2028break-\u2029-bidi\u202e-\u2066.ts");
  const displayed = displayPath(fx.root, unsafe);

  assert.equal(displayed, "line?break-?-bidi?-?.ts");
  assert.doesNotMatch(displayed, /[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/);
});

test("model-visible diagnostic fragments neutralize control and bidi injection", () => {
  const safe = modelSafeFragment("first\nsecond\u202e\u2066\0tail");
  assert.equal(safe, "first?second???tail");
  assert.doesNotMatch(safe, /[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/);
});

test("realpath identity bridges a directory alias and its real file path", (t) => {
  const fx = fixture(t);
  const realFile = fx.file("actual/auth.ts", "A\n");
  const aliasDirectory = path.join(fx.root, "linked");
  linkDirectory(path.dirname(realFile), aliasDirectory);
  const aliasFile = path.join(aliasDirectory, path.basename(realFile));
  const engine = fx.engine();

  assert.equal(engine.recordRead(aliasFile).state, STATES.FRESH);
  const persisted = JSON.parse(fs.readFileSync(engine.statePath, "utf8"));
  assert.ok(persisted.files[pathKey(realFile)]);
  assert.equal(pathKey(persisted.files[pathKey(realFile)].identityPath), pathKey(realFile));

  fs.writeFileSync(realFile, "B\n");
  const externalGuard = engine.guardEdit([realFile]);
  assert.equal(externalGuard.blocked, true);
  assert.equal(externalGuard.files[0].state, STATES.STALE_EXTERNAL);

  assert.equal(engine.recordRead(aliasFile).state, STATES.FRESH);
  fs.writeFileSync(realFile, "C\n");
  assert.equal(engine.recordSelfWrite(realFile).state, STATES.STALE_SELF);
  const aliasGuard = engine.guardEdit([aliasFile]);
  assert.equal(aliasGuard.blocked, true);
  assert.equal(aliasGuard.files[0].state, STATES.STALE_SELF);
});

test("legacy alias-keyed state migrates and guards writes through the real path", (t) => {
  const fx = fixture(t);
  const realFile = fx.file("actual/config.ts", "A\n");
  const aliasDirectory = path.join(fx.root, "legacy-link");
  linkDirectory(path.dirname(realFile), aliasDirectory);
  const aliasFile = path.join(aliasDirectory, path.basename(realFile));
  const engine = fx.engine("legacy-session");
  engine.recordRead(aliasFile);

  const legacy = JSON.parse(fs.readFileSync(engine.statePath, "utf8"));
  const record = Object.values(legacy.files)[0];
  delete record.identityPath;
  legacy.files = { [pathKey(aliasFile)]: record };
  fs.writeFileSync(engine.statePath, `${JSON.stringify(legacy)}\n`);

  fs.writeFileSync(realFile, "B\n");
  const reloaded = fx.engine("legacy-session");
  const result = reloaded.guardEdit([realFile]);
  assert.equal(result.blocked, true);
  assert.equal(result.files[0].state, STATES.STALE_EXTERNAL);

  const migrated = JSON.parse(fs.readFileSync(reloaded.statePath, "utf8"));
  assert.ok(migrated.files[pathKey(realFile)]);
  assert.equal(pathKey(migrated.files[pathKey(realFile)].identityPath), pathKey(realFile));
  assert.equal(migrated.files[pathKey(aliasFile)], undefined);
});

test("removing a read alias is MISSING even while its former target remains", (t) => {
  const fx = fixture(t);
  const realFile = fx.file("actual/kept.ts", "A\n");
  const aliasDirectory = path.join(fx.root, "removed-link");
  linkDirectory(path.dirname(realFile), aliasDirectory);
  const aliasFile = path.join(aliasDirectory, path.basename(realFile));
  const engine = fx.engine("removed-alias-session");

  assert.equal(engine.recordRead(aliasFile).state, STATES.FRESH);
  unlinkDirectory(aliasDirectory);
  assert.equal(fs.existsSync(realFile), true);

  const result = engine.inspect(realFile, { forceHash: true });
  assert.equal(result.state, STATES.MISSING);
  assert.equal(result.path, aliasFile);
});

test("retargeted aliases remain valid state and resolve from the new real path", (t) => {
  const fx = fixture(t);
  const original = fx.file("original/config.ts", "A\n");
  const replacement = fx.file("replacement/config.ts", "B\n");
  const aliasDirectory = path.join(fx.root, "retargeted-link");
  linkDirectory(path.dirname(original), aliasDirectory);
  const aliasFile = path.join(aliasDirectory, "config.ts");
  const engine = fx.engine("retargeted-alias-session");

  engine.recordRead(aliasFile);
  unlinkDirectory(aliasDirectory);
  linkDirectory(path.dirname(replacement), aliasDirectory);

  const result = engine.inspect(replacement, { forceHash: true });
  assert.equal(result.state, STATES.STALE_EXTERNAL);
  const persisted = JSON.parse(fs.readFileSync(engine.statePath, "utf8"));
  const record = persisted.files[pathKey(original)];
  assert.ok(record);
  assert.equal(pathKey(record.identityPath), pathKey(original));
  assert.equal(pathKey(record.observation.metadata.realPath), pathKey(replacement));

  const reloaded = fx.engine("retargeted-alias-session").checkAll({ forceHash: true });
  assert.equal(reloaded.corrupt, false);
  assert.equal(reloaded.files[0].state, STATES.STALE_EXTERNAL);

  assert.equal(engine.recordRead(aliasFile).state, STATES.FRESH);
  const reread = JSON.parse(fs.readFileSync(engine.statePath, "utf8"));
  assert.equal(Object.keys(reread.files).length, 1);
  assert.equal(reread.files[pathKey(original)], undefined);
  assert.ok(reread.files[pathKey(replacement)]);
});

test("self writes through a retargeted alias keep the read-time identity key", (t) => {
  const fx = fixture(t);
  const original = fx.file("original/self.ts", "A\n");
  const replacement = fx.file("replacement/self.ts", "B\n");
  const aliasDirectory = path.join(fx.root, "self-link");
  linkDirectory(path.dirname(original), aliasDirectory);
  const aliasFile = path.join(aliasDirectory, "self.ts");
  const engine = fx.engine("retargeted-self-session");

  engine.recordRead(aliasFile);
  unlinkDirectory(aliasDirectory);
  linkDirectory(path.dirname(replacement), aliasDirectory);
  fs.writeFileSync(replacement, "C\n");

  assert.equal(engine.recordSelfWrite(replacement).state, STATES.STALE_SELF);
  const persisted = JSON.parse(fs.readFileSync(engine.statePath, "utf8"));
  assert.ok(persisted.files[pathKey(original)]);
  assert.equal(persisted.files[pathKey(replacement)], undefined);
  assert.equal(pathKey(persisted.files[pathKey(original)].identityPath), pathKey(original));
  assert.equal(pathKey(persisted.files[pathKey(original)].observation.metadata.realPath), pathKey(replacement));

  const reloaded = fx.engine("retargeted-self-session").inspect(replacement, { forceHash: true });
  assert.equal(reloaded.state, STATES.STALE_SELF);
});

test("guarding a directory checks every tracked descendant but not siblings", (t) => {
  const fx = fixture(t);
  const missing = fx.file("src/missing.ts", "A\n");
  const stale = fx.file("src/nested/stale.ts", "A\n");
  const sibling = fx.file("other/sibling.ts", "A\n");
  const engine = fx.engine();
  engine.recordRead(missing);
  engine.recordRead(stale);
  engine.recordRead(sibling);

  fs.unlinkSync(missing);
  fs.writeFileSync(stale, "B\n");
  fs.writeFileSync(sibling, "B\n");

  const result = engine.guardEdit([path.join(fx.root, "src")]);
  assert.equal(result.blocked, true);
  assert.deepEqual(
    new Set(result.files.map((item) => item.state)),
    new Set([STATES.MISSING, STATES.STALE_EXTERNAL])
  );
  assert.equal(result.files.some((item) => /sibling\.ts$/.test(item.displayPath)), false);
  assert.deepEqual(
    new Set(result.trackedPaths.map(pathKey)),
    new Set([pathKey(missing), pathKey(stale)])
  );
});

test("guarding a real directory finds descendants reached through a retargeted alias", (t) => {
  const fx = fixture(t);
  const original = fx.file("original/nested/guard.ts", "A\n");
  const replacement = fx.file("replacement/nested/guard.ts", "B\n");
  const aliasDirectory = path.join(fx.root, "guard-link");
  linkDirectory(path.join(fx.root, "original"), aliasDirectory);
  const aliasFile = path.join(aliasDirectory, "nested", "guard.ts");
  const engine = fx.engine("retargeted-directory-session");

  engine.recordRead(aliasFile);
  unlinkDirectory(aliasDirectory);
  linkDirectory(path.join(fx.root, "replacement"), aliasDirectory);

  const result = engine.guardEdit([path.dirname(replacement)]);
  assert.equal(result.blocked, true);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].state, STATES.STALE_EXTERNAL);
  assert.equal(fs.existsSync(original), true);
});

test("guarding a real file also checks every alias record currently resolving to it", (t) => {
  const fx = fixture(t);
  const original = fx.file("original/shared.ts", "same\n");
  const replacement = fx.file("replacement/shared.ts", "same\n");
  const aliasDirectory = path.join(fx.root, "shared-link");
  linkDirectory(path.dirname(original), aliasDirectory);
  const aliasFile = path.join(aliasDirectory, "shared.ts");
  const engine = fx.engine("multi-alias-guard-session");

  engine.recordRead(aliasFile);
  engine.recordRead(replacement);
  unlinkDirectory(aliasDirectory);
  linkDirectory(path.dirname(replacement), aliasDirectory);

  const result = engine.guardEdit([replacement]);
  assert.equal(result.blocked, true);
  assert.equal(result.files.some((item) => item.state === STATES.STALE_EXTERNAL), true);
  assert.deepEqual(
    new Set(result.trackedPaths.map(pathKey)),
    new Set([pathKey(aliasFile), pathKey(replacement)]),
  );
});

test("hard-link aliases cannot bypass guards and receive self-write attribution", (t) => {
  const fx = fixture(t);
  const original = fx.file("hardlinks/original.ts", "A\n");
  const alias = path.join(fx.root, "hardlinks", "alias.ts");
  fs.linkSync(original, alias);
  const engine = fx.engine("hard-link-session");

  engine.recordRead(original);
  fs.writeFileSync(alias, "B\n");
  const blocked = engine.guardEdit([alias]);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.files.some((item) => item.state === STATES.STALE_EXTERNAL), true);

  engine.recordRead(original);
  fs.writeFileSync(alias, "C\n");
  const attributed = engine.recordSelfWrite(alias, { toolUseId: "hard-link-write" });
  assert.equal(attributed.state, STATES.STALE_SELF);
  assert.equal(engine.inspect(original, { forceHash: true }).state, STATES.STALE_SELF);
});

test("a historical hard link is blocked after the remembered lexical path is replaced", (t) => {
  const fx = fixture(t);
  const original = fx.file("replaced-hardlink/original.ts", "X\n");
  const alias = path.join(fx.root, "replaced-hardlink", "alias.ts");
  fs.linkSync(original, alias);
  const engine = fx.engine("replaced-hard-link-session");
  engine.recordRead(original);

  const replacement = path.join(fx.root, "replaced-hardlink", "replacement.tmp");
  fs.writeFileSync(replacement, "X\n");
  fs.unlinkSync(original);
  fs.renameSync(replacement, original);
  fs.writeFileSync(alias, "Y\n");

  const result = engine.guardEdit([alias]);
  assert.equal(result.blocked, true);
  assert.equal(result.files.some((item) => item.state === STATES.STALE_EXTERNAL), true);
  assert.match(result.files.map((item) => item.detail).join("\n"), /read path now resolves elsewhere/i);
});

test("a missing write target through an outside-workspace junction fails closed", (t) => {
  const fx = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "freshread-outside-write-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const aliasDirectory = path.join(fx.root, "escape-link");
  linkDirectory(outside, aliasDirectory);

  const target = path.join(aliasDirectory, "new.ts");
  const result = fx.engine("outside-write-session").guardEdit([target]);
  assert.equal(result.blocked, true);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].state, STATES.UNKNOWN);
  assert.match(result.files[0].detail, /outside the workspace scope/i);
});

test("a stale lock owner cannot delete a replacement owner's lock", (t) => {
  const fx = fixture(t);
  const first = fx.engine("lock-session", { lockTimeoutMs: 100, staleLockMs: 1000 });
  const second = fx.engine("lock-session", { lockTimeoutMs: 100, staleLockMs: 1000 });
  assert.ok(first.staleLockMs >= first.lockTimeoutMs * 2);

  const staleToken = first._acquireLock();
  const staleOwnerPath = first._lockOwnerPath(staleToken);
  fs.writeFileSync(staleOwnerPath, "{invalid owner json\n");
  const old = new Date(Date.now() - first.staleLockMs - 5000);
  fs.utimesSync(staleOwnerPath, old, old);
  fs.utimesSync(first.lockPath, old, old);

  const replacementToken = second._acquireLock();
  const replacementOwnerPath = second._lockOwnerPath(replacementToken);
  assert.equal(fs.existsSync(replacementOwnerPath), true);

  first._releaseLock(staleToken);
  assert.equal(fs.existsSync(second.lockPath), true);
  assert.equal(fs.existsSync(replacementOwnerPath), true);

  second._releaseLock(replacementToken);
  assert.equal(fs.existsSync(second.lockPath), false);
});

test("an old lock owned by a live process is never reclaimed", (t) => {
  const fx = fixture(t);
  const engine = fx.engine("live-lock-session", { lockTimeoutMs: 100, staleLockMs: 1000 });
  const token = engine._acquireLock();
  const ownerPath = engine._lockOwnerPath(token);
  const old = new Date(Date.now() - engine.staleLockMs - 5000);
  fs.utimesSync(ownerPath, old, old);
  fs.utimesSync(engine.lockPath, old, old);

  assert.equal(engine._tryReclaimStaleLock(), false);
  assert.equal(fs.existsSync(ownerPath), true);
  engine._releaseLock(token);
});

test("release does not strand an empty lock after transient directory contention", (t) => {
  const fx = fixture(t);
  const engine = fx.engine("release-contention-session", { lockTimeoutMs: 250, staleLockMs: 1000 });
  const token = engine._acquireLock();
  const rmdirSync = fs.rmdirSync;
  let injected = false;
  fs.rmdirSync = function patchedRmdirSync(candidate) {
    if (!injected && pathKey(candidate) === pathKey(engine.lockPath)) {
      injected = true;
      const error = new Error("simulated transient directory contention");
      error.code = "ENOTEMPTY";
      throw error;
    }
    return rmdirSync.call(fs, candidate);
  };
  t.after(() => { fs.rmdirSync = rmdirSync; });

  engine._releaseLock(token);
  assert.equal(injected, true);
  assert.equal(fs.existsSync(engine.lockPath), false);
});

test("release stops if a different owner marker appears during cleanup", (t) => {
  const fx = fixture(t);
  const engine = fx.engine("release-owner-race-session", { lockTimeoutMs: 250, staleLockMs: 1000 });
  const token = engine._acquireLock();
  const ownerPath = engine._lockOwnerPath(token);
  const replacementToken = "00000000-0000-4000-8000-000000000000";
  const replacementOwnerPath = engine._lockOwnerPath(replacementToken);
  const unlinkSync = fs.unlinkSync;
  let injected = false;
  fs.unlinkSync = function patchedUnlinkSync(candidate) {
    if (!injected && pathKey(candidate) === pathKey(ownerPath)) {
      injected = true;
      unlinkSync.call(fs, candidate);
      fs.writeFileSync(
        replacementOwnerPath,
        `${JSON.stringify({ token: replacementToken, pid: process.pid, createdAt: new Date().toISOString() })}\n`,
        { flag: "wx" }
      );
      return;
    }
    return unlinkSync.call(fs, candidate);
  };
  try {
    assert.throws(() => engine._releaseLock(token), /different owner/i);
  } finally {
    fs.unlinkSync = unlinkSync;
  }

  assert.equal(injected, true);
  assert.equal(fs.existsSync(engine.lockPath), true);
  assert.equal(fs.existsSync(replacementOwnerPath), true);
  engine._releaseLock(replacementToken);
});

test("a transient Windows EPERM while creating the lock is retried as contention", { skip: process.platform !== "win32" }, (t) => {
  const fx = fixture(t);
  const engine = fx.engine("transient-lock-session", { lockTimeoutMs: 250, staleLockMs: 1000 });
  const mkdirSync = fs.mkdirSync;
  let injected = false;
  fs.mkdirSync = function patchedMkdirSync(candidate, options) {
    if (!injected && pathKey(candidate) === pathKey(engine.lockPath)) {
      injected = true;
      const error = new Error("simulated transient Windows lock contention");
      error.code = "EPERM";
      throw error;
    }
    return mkdirSync.call(fs, candidate, options);
  };
  t.after(() => { fs.mkdirSync = mkdirSync; });

  const token = engine._acquireLock();
  assert.equal(injected, true);
  assert.equal(typeof token, "string");
  engine._releaseLock(token);
});

test("a persistent Windows EPERM while creating the lock reaches its deadline", { skip: process.platform !== "win32" }, (t) => {
  const fx = fixture(t);
  const engine = fx.engine("persistent-lock-session", { lockTimeoutMs: 40, staleLockMs: 1000 });
  const mkdirSync = fs.mkdirSync;
  let attempts = 0;
  fs.mkdirSync = function patchedMkdirSync(candidate, options) {
    if (pathKey(candidate) === pathKey(engine.lockPath)) {
      attempts += 1;
      const error = new Error("simulated persistent Windows lock denial");
      error.code = "EPERM";
      throw error;
    }
    return mkdirSync.call(fs, candidate, options);
  };
  t.after(() => { fs.mkdirSync = mkdirSync; });

  assert.throws(() => engine._acquireLock(), /timed out waiting/i);
  assert.ok(attempts >= 2);
  assert.ok(attempts < 20);
});

test("EACCES while probing an old lock owner is treated as possibly alive", (t) => {
  const fx = fixture(t);
  const engine = fx.engine("access-denied-owner-session", { lockTimeoutMs: 100, staleLockMs: 1000 });
  const token = engine._acquireLock();
  const ownerPath = engine._lockOwnerPath(token);
  const old = new Date(Date.now() - engine.staleLockMs - 5000);
  fs.utimesSync(ownerPath, old, old);
  fs.utimesSync(engine.lockPath, old, old);
  const kill = process.kill;
  process.kill = function deniedKill() {
    const error = new Error("simulated access denial");
    error.code = "EACCES";
    throw error;
  };
  try {
    assert.equal(engine._tryReclaimStaleLock(), false);
    assert.equal(fs.existsSync(ownerPath), true);
  } finally {
    process.kill = kill;
  }
  engine._releaseLock(token);
});

test("nested persisted state is validated before use and before write", (t) => {
  const fx = fixture(t);
  const target = fx.file("src/auth.ts", "A\n");
  const engine = fx.engine("validation-session");
  engine.recordRead(target);

  const invalid = JSON.parse(fs.readFileSync(engine.statePath, "utf8"));
  Object.values(invalid.files)[0].snapshot.metadata.size = "2";
  fs.writeFileSync(engine.statePath, `${JSON.stringify(invalid)}\n`);

  const report = fx.engine("validation-session").checkAll();
  assert.equal(report.corrupt, true);
  assert.equal(report.summary.tracked, 0);
  assert.match(report.detail, /snapshot\.metadata\.size is invalid/);

  const invalidForWrite = engine._emptyState();
  invalidForWrite.files[pathKey(target)] = { path: target };
  assert.throws(
    () => engine._writeState(invalidForWrite),
    /refusing to write invalid FreshRead state/
  );
});

test("state serialization is rejected before writing more than 16 MiB", (t) => {
  const fx = fixture(t);
  const engine = fx.engine("oversized-state-session");
  const state = engine._emptyState();
  state.padding = "x".repeat(16 * 1024 * 1024);

  assert.throws(() => engine._writeState(state), /exceeds 16 MiB safety limit/);
  assert.equal(fs.existsSync(engine.statePath), false);
  assert.deepEqual(
    fs.existsSync(engine.sessionDir)
      ? fs.readdirSync(engine.sessionDir).filter((name) => name.includes(".tmp"))
      : [],
    []
  );
});

test("verified reads preserve emitted bytes when the file changes before PostToolUse", (t) => {
  const fx = fixture(t);
  const target = fx.file("src/verified.ts", "A\n");
  const engine = fx.engine("verified-drift-session");
  const evidence = readEvidence(engine, target);

  fs.writeFileSync(target, "B\n");
  const result = engine.recordVerifiedRead(evidence, { toolName: "Bash", toolUseId: "read-1" });
  assert.equal(result.state, STATES.STALE_EXTERNAL);
  assert.equal(result.snapshotHash, evidence.hash);
  assert.notEqual(result.currentHash, evidence.hash);

  const persisted = JSON.parse(fs.readFileSync(engine.statePath, "utf8"));
  const record = persisted.files[pathKey(target)];
  assert.equal(record.snapshot.hash, evidence.hash);
  assert.equal(record.snapshot.readAt, evidence.readAt);
  assert.equal(record.observation.hash, result.currentHash);
  assert.equal(record.externalSinceRead, true);
});

test("verified reads treat an identical-byte alias retarget as external drift", (t) => {
  const fx = fixture(t);
  const original = fx.file("original/verified.ts", "same\n");
  const replacement = fx.file("replacement/verified.ts", "same\n");
  const aliasDirectory = path.join(fx.root, "verified-link");
  linkDirectory(path.dirname(original), aliasDirectory);
  const aliasFile = path.join(aliasDirectory, "verified.ts");
  const engine = fx.engine("verified-retarget-session");
  const evidence = readEvidence(engine, aliasFile);

  unlinkDirectory(aliasDirectory);
  linkDirectory(path.dirname(replacement), aliasDirectory);
  const result = engine.recordVerifiedRead(evidence);
  assert.equal(result.state, STATES.STALE_EXTERNAL);
  assert.equal(result.snapshotHash, result.currentHash);

  const report = fx.engine("verified-retarget-session").checkAll({ forceHash: true });
  assert.equal(report.corrupt, false);
  assert.equal(report.files[0].state, STATES.STALE_EXTERNAL);
});

test("verified read evidence is deeply validated before state mutation", (t) => {
  const fx = fixture(t);
  const target = fx.file("src/evidence.ts", "A\n");
  const source = fx.engine("evidence-source-session");
  const evidence = readEvidence(source, target);
  const outside = path.join(path.dirname(fx.root), "outside.ts");
  const cases = [
    { ...evidence, hash: "not-a-hash" },
    { ...evidence, readAt: "not-a-time" },
    { ...evidence, path: outside },
    { ...evidence, metadata: { ...evidence.metadata, size: "2" } },
    { ...evidence, metadata: { ...evidence.metadata, realPath: outside } },
    { ...evidence, realPath: path.join(fx.root, "different.ts") },
  ];

  cases.forEach((invalid, index) => {
    const engine = fx.engine(`invalid-evidence-${index}`);
    assert.equal(engine.recordVerifiedRead(invalid).state, STATES.UNKNOWN);
    assert.equal(fs.existsSync(engine.statePath), false);
  });
});
