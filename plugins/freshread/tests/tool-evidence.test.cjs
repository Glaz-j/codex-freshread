"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { FreshReadEngine } = require("../src/freshread-core.cjs");
const {
  consumeToolEvidence,
  exactObservedReadPlan,
  exactShellReadPlan,
  executeVerifiedRead,
  prepareShellOutcome,
  prepareObservedRead,
  prepareVerifiedRead,
} = require("../src/tool-evidence.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freshread-evidence-"));
  const dataDir = path.join(root, ".plugin-data");
  const target = path.join(root, "src", "auth file.ts");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "alpha\n");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const engine = new FreshReadEngine({ cwd: root, dataDir, sessionId: "evidence-session" });
  return {
    root,
    dataDir,
    target,
    engine,
    event(id, command) {
      return {
        cwd: root,
        session_id: "evidence-session",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_use_id: id,
        tool_input: {
          command,
          workdir: root,
          shell: process.platform === "win32" ? "powershell" : "sh",
        },
      };
    },
  };
}

function aliasedWorkspaceFixture(t) {
  const physicalParent = fs.mkdtempSync(path.join(os.tmpdir(), "freshread-evidence-physical-"));
  const aliasParent = fs.mkdtempSync(path.join(os.tmpdir(), "freshread-evidence-alias-"));
  const physicalRoot = path.join(physicalParent, "workspace");
  const outsideRoot = path.join(physicalParent, "outside");
  const aliasRoot = path.join(aliasParent, "workspace-link");
  fs.mkdirSync(physicalRoot);
  fs.mkdirSync(outsideRoot);
  fs.symlinkSync(physicalRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");
  const physicalTarget = path.join(physicalRoot, "src", "aliased.ts");
  const aliasTarget = path.join(aliasRoot, "src", "aliased.ts");
  fs.mkdirSync(path.dirname(physicalTarget), { recursive: true });
  fs.writeFileSync(physicalTarget, "aliased\n");
  const dataDir = path.join(physicalParent, ".plugin-data");
  const engine = new FreshReadEngine({ cwd: aliasRoot, dataDir, sessionId: "aliased-evidence-session" });
  t.after(() => {
    try { fs.unlinkSync(aliasRoot); } catch {}
    fs.rmSync(aliasParent, { recursive: true, force: true });
    fs.rmSync(physicalParent, { recursive: true, force: true });
  });
  return {
    aliasRoot,
    aliasTarget,
    dataDir,
    engine,
    outsideRoot,
    physicalRoot,
    physicalTarget,
    event(id) {
      return {
        cwd: aliasRoot,
        session_id: "aliased-evidence-session",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_use_id: id,
        tool_input: {
          command: canonicalReadCommand("src/aliased.ts"),
          workdir: aliasRoot,
          shell: process.platform === "win32" ? "powershell" : "sh",
        },
      };
    },
  };
}

function quoteShellLiteral(value) {
  const text = String(value);
  return process.platform === "win32"
    ? `'${text.replace(/'/g, "''")}'`
    : `'${text.replace(/'/g, `'"'"'`)}'`;
}

function canonicalReadCommand(...targets) {
  const quotedTargets = targets.map(quoteShellLiteral).join(" ");
  return process.platform === "win32"
    ? `Get-Content -LiteralPath ${quotedTargets} -Raw -Encoding utf8`
    : `cat -- ${quotedTargets}`;
}

function canonicalReadOutput(contents) {
  return process.platform === "win32" ? `${contents}\r\n` : contents;
}

test("only simple complete text reads qualify for verified rewriting", (t) => {
  const fx = fixture(t);
  const dynamicLiteral = path.join(fx.root, "src", "$name.ts");
  const commaLiteral = path.join(fx.root, "src", "a,b.ts");
  fs.writeFileSync(dynamicLiteral, "must not be read as a literal expansion\n");
  fs.writeFileSync(commaLiteral, "comma\n");
  const relativeTarget = "src/auth file.ts";
  const exact = exactShellReadPlan(fx.event("read-1", canonicalReadCommand(relativeTarget)));
  assert.deepEqual(exact.paths, [fx.target]);
  assert.equal(exactShellReadPlan(fx.event("read-2", process.platform === "win32"
    ? "Get-Content src/auth.ts | Select-Object -First 1"
    : "cat -- src/auth.ts | head -n 1")), null);
  assert.equal(exactShellReadPlan(fx.event("read-3", process.platform === "win32"
    ? "Get-Content -Tail 1 'src/auth file.ts'"
    : "head -n 1 -- 'src/auth file.ts'")), null);
  assert.equal(exactShellReadPlan(fx.event("read-4", "rg alpha src")), null);
  assert.equal(exactShellReadPlan(fx.event("read-5", process.platform === "win32"
    ? 'Get-Content "src/$name.ts" -Raw'
    : 'cat -- "src/$name.ts"')), null);
  assert.equal(exactShellReadPlan(fx.event(
    "read-6",
    `${canonicalReadCommand("src/auth.ts")}\n${canonicalReadCommand("src/other.ts")}`,
  )), null);
  const ambiguousRelative = fx.event("read-7", canonicalReadCommand(relativeTarget));
  delete ambiguousRelative.tool_input.workdir;
  assert.equal(exactShellReadPlan(ambiguousRelative), null);
  assert.equal(exactShellReadPlan(fx.event("read-8", canonicalReadCommand("src/a,b.ts"))), null);
  const duplicate = exactShellReadPlan(fx.event("read-9", canonicalReadCommand(relativeTarget, relativeTarget)));
  assert.equal(duplicate, null);
});

test("observed reads reject multi-file output because individual byte boundaries are not provable", (t) => {
  const fx = fixture(t);
  const second = path.join(fx.root, "src", "second.ts");
  fs.writeFileSync(second, "beta\n");
  const event = fx.event(
    "multi-file-boundary",
    canonicalReadCommand(fx.target, second),
  );
  assert.equal(exactObservedReadPlan(event), null);
  assert.equal(prepareObservedRead(fx.engine, event), null);
});

test("trusted reader evidence binds the bytes written to stdout to a stable SHA-256 snapshot", (t) => {
  const fx = fixture(t);
  const event = fx.event("verified-read", canonicalReadCommand("src/auth file.ts"));
  const prepared = prepareVerifiedRead(fx.engine, event);
  assert.ok(prepared);
  assert.match(prepared.command, /freshread-read\.cjs/);

  const script = path.resolve(__dirname, "..", "scripts", "freshread-read.cjs");
  const run = spawnSync(process.execPath, [script, prepared.pendingPath], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, "alpha\n");

  const evidence = consumeToolEvidence(fx.engine, event);
  assert.equal(evidence.success, true);
  assert.equal(evidence.kind, "verified-read");
  assert.equal(evidence.entries.length, 1);
  assert.equal(evidence.entries[0].path, fx.target);
  assert.match(evidence.entries[0].hash, /^[a-f0-9]{64}$/);
  assert.equal(fs.existsSync(prepared.pendingPath), false);
  assert.equal(fs.existsSync(prepared.resultPath), false);
});

test("verified evidence persists and validates the physical root of an aliased workspace", (t) => {
  const fx = aliasedWorkspaceFixture(t);
  const event = fx.event("aliased-verified-read");
  const prepared = prepareVerifiedRead(fx.engine, event);
  assert.ok(prepared);
  assert.deepEqual(prepared.plan.paths, [fx.aliasTarget]);
  const pending = JSON.parse(fs.readFileSync(prepared.pendingPath, "utf8"));
  assert.equal(path.resolve(pending.cwd), path.resolve(fx.aliasRoot));
  assert.equal(path.resolve(pending.realCwd), path.resolve(fs.realpathSync.native(fx.physicalRoot)));

  const script = path.resolve(__dirname, "..", "scripts", "freshread-read.cjs");
  const run = spawnSync(process.execPath, [script, prepared.pendingPath], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, "aliased\n");
  const evidence = consumeToolEvidence(fx.engine, event);
  assert.equal(evidence.success, true);
  assert.equal(fx.engine.recordVerifiedRead(evidence.entries[0]).state, "FRESH");
  assert.equal(fs.existsSync(fx.engine.statePath), true);
});

test("verified reader fails closed when an aliased workspace root is retargeted", (t) => {
  const fx = aliasedWorkspaceFixture(t);
  const event = fx.event("retargeted-workspace-root");
  const prepared = prepareVerifiedRead(fx.engine, event);
  assert.ok(prepared);

  fs.unlinkSync(fx.aliasRoot);
  fs.symlinkSync(fx.outsideRoot, fx.aliasRoot, process.platform === "win32" ? "junction" : "dir");
  const script = path.resolve(__dirname, "..", "scripts", "freshread-read.cjs");
  const run = spawnSync(process.execPath, [script, prepared.pendingPath], { encoding: "utf8" });
  assert.notEqual(run.status, 0);
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /workspace root changed identity/i);
});

test("observed reads record only canonical raw output that exactly matches current file bytes", (t) => {
  const fx = fixture(t);
  const event = fx.event("observed-read", canonicalReadCommand(fx.target));
  const plan = exactObservedReadPlan(event);
  assert.deepEqual(plan.paths, [fx.target]);
  const prepared = prepareObservedRead(fx.engine, event);
  assert.ok(prepared);
  const rendered = canonicalReadOutput("alpha\n");
  const evidence = consumeToolEvidence(fx.engine, { ...event, tool_response: rendered });
  assert.equal(evidence.kind, "observed-read");
  assert.equal(evidence.success, true);
  assert.equal(evidence.entries.length, 1);
  assert.match(evidence.entries[0].hash, /^[a-f0-9]{64}$/);
});

test("observed reads reject transformed, stale, structured, and empty output", (t) => {
  const fx = fixture(t);
  for (const [id, response, mutate] of [
    ["transformed-output", "alpha\nextra\n", false],
    ["stale-output", canonicalReadOutput("alpha\n"), true],
    ["structured-output", { output: "alpha\n" }, false],
  ]) {
    const event = fx.event(id, canonicalReadCommand(fx.target));
    prepareObservedRead(fx.engine, event);
    if (mutate) fs.writeFileSync(fx.target, "beta\n");
    const evidence = consumeToolEvidence(fx.engine, { ...event, tool_response: response });
    assert.equal(evidence.success, false, id);
    fs.writeFileSync(fx.target, "alpha\n");
  }

  fs.writeFileSync(fx.target, "");
  const emptyEvent = fx.event("empty-output", canonicalReadCommand(fx.target));
  prepareObservedRead(fx.engine, emptyEvent);
  const empty = consumeToolEvidence(fx.engine, { ...emptyEvent, tool_response: "" });
  assert.equal(empty.success, false);
  assert.match(empty.detail, /empty output/i);
});

test("shell outcome evidence distinguishes success from missing or failed execution", (t) => {
  const fx = fixture(t);
  const event = fx.event("write-success", process.platform === "win32"
    ? "Set-Content -LiteralPath '.\\src\\auth file.ts' -Value beta"
    : "printf 'beta\\n' > 'src/auth file.ts'");
  const prepared = prepareShellOutcome(fx.engine, event, [fx.target]);
  const shell = process.platform === "win32"
    ? [process.env.SystemRoot + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", prepared.command]]
    : ["/bin/sh", ["-c", prepared.command]];
  const run = spawnSync(shell[0], shell[1], { cwd: fx.root, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const evidence = consumeToolEvidence(fx.engine, event);
  assert.deepEqual({ kind: evidence.kind, success: evidence.success, exitCode: evidence.exitCode }, {
    kind: "shell-outcome", success: true, exitCode: 0,
  });

  const neverRan = fx.event("write-never-ran", "Set-Content src/missing.ts x");
  prepareShellOutcome(fx.engine, neverRan, [path.join(fx.root, "src", "missing.ts")]);
  const missing = consumeToolEvidence(fx.engine, neverRan);
  assert.equal(missing.success, false);
  assert.match(missing.detail, /ENOENT|cannot find|no such file/i);
});

test("verified reader binds binary output to a snapshot without persisting content", (t) => {
  const fx = fixture(t);
  fs.writeFileSync(fx.target, Buffer.from([0, 1, 2, 3]));
  const event = fx.event("binary-read", canonicalReadCommand("src/auth file.ts"));
  const prepared = prepareVerifiedRead(fx.engine, event);
  const script = path.resolve(__dirname, "..", "scripts", "freshread-read.cjs");
  const run = spawnSync(process.execPath, [script, prepared.pendingPath]);
  assert.equal(run.status, 0, run.stderr.toString("utf8"));
  assert.deepEqual(run.stdout, Buffer.from([0, 1, 2, 3]));
  const evidence = consumeToolEvidence(fx.engine, event);
  assert.equal(evidence.success, true);
  assert.match(evidence.entries[0].hash, /^[a-f0-9]{64}$/);
});

test("verified reader opens the resolved in-workspace target when its alias is retargeted before open", (t) => {
  const fx = fixture(t);
  const insideDirectory = path.join(fx.root, "inside");
  const outsideDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "freshread-reader-outside-"));
  t.after(() => fs.rmSync(outsideDirectory, { recursive: true, force: true }));
  fs.mkdirSync(insideDirectory, { recursive: true });
  fs.writeFileSync(path.join(insideDirectory, "secret.ts"), "inside\n");
  fs.writeFileSync(path.join(outsideDirectory, "secret.ts"), "outside-secret\n");
  const aliasDirectory = path.join(fx.root, "reader-link");
  fs.symlinkSync(insideDirectory, aliasDirectory, process.platform === "win32" ? "junction" : "dir");
  const aliasFile = path.join(aliasDirectory, "secret.ts");
  const event = fx.event("retarget-before-open", process.platform === "win32"
    ? "Get-Content -LiteralPath '.\\reader-link\\secret.ts' -Raw -Encoding utf8"
    : "cat reader-link/secret.ts");
  const prepared = prepareVerifiedRead(fx.engine, event);
  assert.ok(prepared);

  const outputPath = path.join(fx.root, "captured-output.bin");
  const outputFd = fs.openSync(outputPath, "w");
  const openSync = fs.openSync;
  let retargeted = false;
  fs.openSync = function retargetBeforeOpen(candidate, flags, mode) {
    if (!retargeted && [aliasFile, path.join(insideDirectory, "secret.ts")]
      .some((item) => path.resolve(String(candidate)) === path.resolve(item))) {
      retargeted = true;
      fs.unlinkSync(aliasDirectory);
      fs.symlinkSync(outsideDirectory, aliasDirectory, process.platform === "win32" ? "junction" : "dir");
    }
    return openSync.call(fs, candidate, flags, mode);
  };
  try {
    executeVerifiedRead(prepared.pendingPath, outputFd);
  } finally {
    fs.openSync = openSync;
    fs.closeSync(outputFd);
  }
  assert.equal(retargeted, true);
  assert.equal(fs.readFileSync(outputPath, "utf8"), "inside\n");
});
