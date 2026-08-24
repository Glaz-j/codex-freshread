"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { FreshReadEngine, STATES } = require("../src/freshread-core.cjs");
const { dataDirectory, handleHookEvent } = require("../src/hook-handler.cjs");
const { recordBenchmarkAudit } = require("../scripts/freshread-hook.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freshread-hook-test-"));
  const dataDir = path.join(root, ".plugin-data");
  const target = path.join(root, "src", "auth.ts");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "A\n");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    dataDir,
    target,
    base(name, extra = {}) {
      return {
        session_id: "hook-session",
        turn_id: "turn-1",
        cwd: root,
        hook_event_name: name,
        model: "test-model",
        permission_mode: "default",
        ...extra,
      };
    },
    options: { dataDir },
    engine() {
      return new FreshReadEngine({ cwd: root, dataDir, sessionId: "hook-session" });
    },
  };
}

function aliasedHookFixture(t) {
  const physicalParent = fs.mkdtempSync(path.join(os.tmpdir(), "freshread-hook-physical-"));
  const aliasParent = fs.mkdtempSync(path.join(os.tmpdir(), "freshread-hook-alias-"));
  const physicalRoot = path.join(physicalParent, "workspace");
  const aliasRoot = path.join(aliasParent, "workspace-link");
  const dataDir = path.join(physicalParent, ".plugin-data");
  fs.mkdirSync(physicalRoot);
  fs.symlinkSync(physicalRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");
  const physicalTarget = path.join(physicalRoot, "src", "aliased.ts");
  const aliasTarget = path.join(aliasRoot, "src", "aliased.ts");
  fs.mkdirSync(path.dirname(physicalTarget), { recursive: true });
  fs.writeFileSync(physicalTarget, "A\n");
  t.after(() => {
    try { fs.unlinkSync(aliasRoot); } catch {}
    fs.rmSync(aliasParent, { recursive: true, force: true });
    fs.rmSync(physicalParent, { recursive: true, force: true });
  });
  return {
    aliasRoot,
    aliasTarget,
    dataDir,
    physicalTarget,
    base(name, extra = {}) {
      return {
        session_id: "aliased-hook-session",
        turn_id: "turn-aliased",
        cwd: aliasRoot,
        hook_event_name: name,
        model: "test-model",
        permission_mode: "default",
        ...extra,
      };
    },
    options: { dataDir },
    engine() {
      return new FreshReadEngine({ cwd: aliasRoot, dataDir, sessionId: "aliased-hook-session" });
    },
  };
}

function runUpdatedShell(command, cwd) {
  if (process.platform === "win32") {
    const powershell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], { cwd, encoding: "utf8" });
  }
  return spawnSync("/bin/sh", ["-c", command], { cwd, encoding: "utf8" });
}

function quoteShellLiteral(value) {
  const text = String(value);
  return process.platform === "win32"
    ? `'${text.replace(/'/g, "''")}'`
    : `'${text.replace(/'/g, `'"'"'`)}'`;
}

function canonicalReadCommand(target) {
  const quoted = quoteShellLiteral(target);
  return process.platform === "win32"
    ? `Get-Content -LiteralPath ${quoted} -Raw -Encoding utf8`
    : `cat -- ${quoted}`;
}

function canonicalReadOutput(contents) {
  return process.platform === "win32" ? `${contents}\r\n` : contents;
}

test("observed Pre/PostToolUse read records only output that exactly matches the file", (t) => {
  const fx = fixture(t);
  const preEvent = fx.base("PreToolUse", {
    tool_name: "Bash",
    tool_use_id: "tool-read",
    tool_input: { command: canonicalReadCommand(fx.target) },
  });
  assert.equal(handleHookEvent(preEvent, fx.options), null);
  const run = runUpdatedShell(preEvent.tool_input.command, fx.root);
  assert.equal(run.status, 0, run.stderr);
  const postEvent = fx.base("PostToolUse", {
    ...preEvent,
    hook_event_name: "PostToolUse",
    tool_input: preEvent.tool_input,
    tool_response: run.stdout,
  });
  assert.equal(handleHookEvent(postEvent, fx.options), null);
  assert.equal(fx.engine().inspect(fx.target).state, STATES.FRESH);

  fs.writeFileSync(fx.target, "B\n");
  const output = handleHookEvent(fx.base("UserPromptSubmit", { prompt: "continue" }), fx.options);
  assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(output.hookSpecificOutput.additionalContext, /STALE_EXTERNAL/);
  assert.match(output.hookSpecificOutput.additionalContext, /src[\\/]auth\.ts/);
});

test("hook read evidence and stale-edit guards work through an aliased workspace root", (t) => {
  const fx = aliasedHookFixture(t);
  const preRead = fx.base("PreToolUse", {
    tool_name: "Bash",
    tool_use_id: "aliased-hook-read",
    tool_input: { command: canonicalReadCommand(fx.aliasTarget) },
  });
  assert.equal(handleHookEvent(preRead, fx.options), null);
  const run = runUpdatedShell(preRead.tool_input.command, fx.aliasRoot);
  assert.equal(run.status, 0, run.stderr);
  const postRead = {
    ...preRead,
    hook_event_name: "PostToolUse",
    tool_response: run.stdout,
  };
  assert.equal(handleHookEvent(postRead, fx.options), null);
  assert.equal(fx.engine().inspect(fx.aliasTarget).state, STATES.FRESH);
  assert.equal(fs.existsSync(fx.engine().statePath), true);

  fs.writeFileSync(fx.physicalTarget, "B\n");
  const blocked = handleHookEvent(fx.base("PreToolUse", {
    tool_name: "apply_patch",
    tool_use_id: "aliased-hook-write",
    tool_input: { command: "*** Begin Patch\n*** Update File: src/aliased.ts\n*** End Patch" },
  }), fx.options);
  assert.equal(blocked.hookSpecificOutput.permissionDecision, "deny");
  assert.match(blocked.hookSpecificOutput.permissionDecisionReason, /STALE_EXTERNAL/);
});

test("canonical Windows PowerShell carrier establishes a snapshot and blocks a later stale write", { skip: process.platform !== "win32" }, (t) => {
  const fx = fixture(t);
  const shell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const readInner = `Get-Content -LiteralPath '${fx.target}' -Raw -Encoding utf8`;
  const readCommand = `"${shell}" -Command "${readInner}"`;
  const preRead = fx.base("PreToolUse", {
    tool_name: "Bash",
    tool_use_id: "carrier-read",
    tool_input: { command: readCommand },
  });
  assert.equal(handleHookEvent(preRead, fx.options), null);
  const rendered = canonicalReadOutput("A\n");
  assert.equal(handleHookEvent({ ...preRead, hook_event_name: "PostToolUse", tool_response: rendered }, fx.options), null);
  assert.equal(fx.engine().inspect(fx.target).state, STATES.FRESH);

  fs.writeFileSync(fx.target, "B\n");
  const writeInner = `Set-Content -LiteralPath '${fx.target}' -Value C -Encoding utf8`;
  const blocked = handleHookEvent(fx.base("PreToolUse", {
    tool_name: "Bash",
    tool_use_id: "carrier-write",
    tool_input: { command: `"${shell}" -Command "${writeInner}"` },
  }), fx.options);
  assert.equal(blocked.hookSpecificOutput.permissionDecision, "deny");
  assert.match(blocked.hookSpecificOutput.permissionDecisionReason, /STALE_EXTERNAL/);
});

test("failed PostToolUse reads never establish a FRESH snapshot", (t) => {
  const fx = fixture(t);
  const failedRead = fx.base("PostToolUse", {
    tool_name: "Bash",
    tool_use_id: "tool-read-failed",
    tool_input: { command: canonicalReadCommand(fx.target) },
    tool_response: "Get-Content failed",
  });
  assert.equal(handleHookEvent(failedRead, fx.options), null);
  assert.equal(fx.engine().inspect(fx.target).state, STATES.UNKNOWN);
});

test("a file changed after verified output but before PostToolUse is never mislabeled FRESH", (t) => {
  const fx = fixture(t);
  const pre = fx.base("PreToolUse", {
    tool_name: "Bash",
    tool_use_id: "tool-read-race",
    tool_input: { command: canonicalReadCommand(fx.target) },
  });
  assert.equal(handleHookEvent(pre, fx.options), null);
  const run = runUpdatedShell(pre.tool_input.command, fx.root);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, canonicalReadOutput("A\n"));
  fs.writeFileSync(fx.target, "B\n");
  const post = fx.base("PostToolUse", {
    tool_name: "Bash",
    tool_use_id: "tool-read-race",
    tool_input: pre.tool_input,
    tool_response: run.stdout,
  });
  const warning = handleHookEvent(post, fx.options);
  assert.match(warning.hookSpecificOutput.additionalContext, /not recorded|non-fresh/i);
  assert.equal(fx.engine().inspect(fx.target, { forceHash: true }).state, STATES.UNKNOWN);
});

test("PreToolUse blocks stale apply_patch, then a reread unlocks it", (t) => {
  const fx = fixture(t);
  fx.engine().recordRead(fx.target);
  fs.writeFileSync(fx.target, "B\n");
  const pre = fx.base("PreToolUse", {
    tool_name: "apply_patch",
    tool_use_id: "tool-edit",
    tool_input: { command: "*** Begin Patch\n*** Update File: src/auth.ts\n*** End Patch" },
  });
  const blocked = handleHookEvent(pre, fx.options);
  assert.equal(blocked.hookSpecificOutput.permissionDecision, "deny");
  assert.match(blocked.hookSpecificOutput.permissionDecisionReason, /STALE_EXTERNAL/);

  fx.engine().recordRead(fx.target);
  assert.equal(handleHookEvent(pre, fx.options), null);
});

test("deterministic edits with unresolvable targets fail closed", (t) => {
  const fx = fixture(t);
  const result = handleHookEvent(fx.base("PreToolUse", {
    tool_name: "apply_patch",
    tool_use_id: "unknown-edit",
    tool_input: { command: "*** Begin Patch\n*** End Patch" },
  }), fx.options);
  assert.equal(result.hookSpecificOutput.permissionDecision, "deny");
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /target path could not be identified/i);
});

test("FRESHREAD_ENABLED=0 bypasses every guard for a true baseline arm", (t) => {
  const fx = fixture(t);
  const result = handleHookEvent(fx.base("PreToolUse", {
    tool_name: "Bash",
    tool_use_id: "disabled-relative-write",
    tool_input: { command: "Set-Content -LiteralPath 'src/auth.ts' -Value B" },
  }), { ...fx.options, env: { ...process.env, FRESHREAD_TEST_MODE: "1", FRESHREAD_ENABLED: "0" } });
  assert.equal(result, null);
});

test("production hook mode ignores benchmark-only disable and data-directory overrides", (t) => {
  const fx = fixture(t);
  const fakeDataDir = path.join(fx.root, "unsafe-override");
  const env = {
    ...process.env,
    PLUGIN_DATA: fx.dataDir,
    FRESHREAD_ENABLED: "0",
    FRESHREAD_DATA_DIR: fakeDataDir,
  };
  assert.equal(dataDirectory(env), path.resolve(fx.dataDir));
  const result = handleHookEvent(fx.base("PreToolUse", {
    tool_name: "Bash",
    tool_use_id: "production-relative-write",
    tool_input: { command: "Set-Content -LiteralPath 'src/auth.ts' -Value B" },
  }), { env });
  assert.equal(result.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(fs.existsSync(fakeDataDir), false);
});

test("successful self edit is STALE_SELF; failed edit is not self-attributed", (t) => {
  const fx = fixture(t);
  fx.engine().recordRead(fx.target);
  fs.writeFileSync(fx.target, "B\n");
  const post = fx.base("PostToolUse", {
    tool_name: "apply_patch",
    tool_use_id: "tool-edit",
    tool_input: { command: "*** Begin Patch\n*** Update File: src/auth.ts\n*** End Patch" },
    tool_response: { exit_code: 0, output: "Done!" },
  });
  assert.equal(handleHookEvent(post, fx.options), null);
  assert.equal(fx.engine().inspect(fx.target).state, STATES.STALE_SELF);

  fx.engine().recordRead(fx.target);
  fs.writeFileSync(fx.target, "C\n");
  post.tool_response = { exit_code: 1, output: "failed" };
  assert.equal(handleHookEvent(post, fx.options), null);
  assert.equal(fx.engine().inspect(fx.target).state, STATES.STALE_EXTERNAL);
});

test("a successful directory write self-attributes every tracked descendant", (t) => {
  const fx = fixture(t);
  const sibling = path.join(fx.root, "src", "sibling.ts");
  fs.writeFileSync(sibling, "A\n");
  fx.engine().recordRead(fx.target);
  fx.engine().recordRead(sibling);

  const helper = process.platform === "win32"
    ? path.join(fx.root, "prettier.cmd")
    : path.join(fx.root, "prettier");
  if (process.platform === "win32") {
    fs.writeFileSync(helper, "@echo off\r\n> src\\auth.ts echo B\r\n> src\\sibling.ts echo B\r\n");
  } else {
    fs.writeFileSync(helper, "#!/bin/sh\nprintf 'B\\n' > src/auth.ts\nprintf 'B\\n' > src/sibling.ts\n");
    fs.chmodSync(helper, 0o700);
  }
  const command = process.platform === "win32" ? ".\\prettier.cmd --write src" : "./prettier --write src";
  const preEvent = fx.base("PreToolUse", {
    tool_name: "Bash",
    tool_use_id: "tool-directory-write",
    tool_input: {
      command,
      workdir: fx.root,
      shell: process.platform === "win32" ? "powershell" : "sh",
    },
  });
  const rewrite = handleHookEvent(preEvent, fx.options);
  assert.equal(rewrite.hookSpecificOutput.permissionDecision, "allow");
  const run = runUpdatedShell(rewrite.hookSpecificOutput.updatedInput.command, fx.root);
  assert.equal(run.status, 0, run.stderr);

  const postEvent = fx.base("PostToolUse", {
    ...preEvent,
    hook_event_name: "PostToolUse",
    tool_input: rewrite.hookSpecificOutput.updatedInput,
    tool_response: run.stdout,
  });
  assert.equal(handleHookEvent(postEvent, fx.options), null);
  assert.equal(fx.engine().inspect(fx.target, { forceHash: true }).state, STATES.STALE_SELF);
  assert.equal(fx.engine().inspect(sibling, { forceHash: true }).state, STATES.STALE_SELF);
});

test("slash commands return status, inspect, and session-local clear context", (t) => {
  const fx = fixture(t);
  fx.engine().recordRead(fx.target);
  const status = handleHookEvent(fx.base("UserPromptSubmit", { prompt: "/freshread status" }), fx.options);
  assert.match(status.hookSpecificOutput.additionalContext, /Tracked: 1 files/);
  const inspect = handleHookEvent(fx.base("UserPromptSubmit", { prompt: "/freshread inspect src/auth.ts" }), fx.options);
  assert.match(inspect.hookSpecificOutput.additionalContext, /FRESH/);
  const clear = handleHookEvent(fx.base("UserPromptSubmit", { prompt: "/freshread clear" }), fx.options);
  assert.match(clear.hookSpecificOutput.additionalContext, /cleared 1/i);
  assert.equal(fx.engine().inspect(fx.target).state, STATES.UNKNOWN);
});

test("plain FreshRead prompts expose commands when unknown slash commands are intercepted by the UI", (t) => {
  const fx = fixture(t);
  fx.engine().recordRead(fx.target);
  const status = handleHookEvent(fx.base("UserPromptSubmit", { prompt: "freshread status" }), fx.options);
  assert.match(status.hookSpecificOutput.additionalContext, /Tracked: 1 files/);
  const inspect = handleHookEvent(fx.base("UserPromptSubmit", { prompt: "freshread inspect src/auth.ts" }), fx.options);
  assert.match(inspect.hookSpecificOutput.additionalContext, /FRESH/);
});

test("explicit shell writes preserve workdir, shell, and unrelated tool arguments when wrapped", (t) => {
  const fx = fixture(t);
  fx.engine().recordRead(fx.target);
  const event = fx.base("PreToolUse", {
    tool_name: "Bash",
    tool_use_id: "preserve-tool-input",
    tool_input: {
      command: `Set-Content -LiteralPath '${fx.target}' -Value B`,
      workdir: path.dirname(fx.target),
      shell: "powershell",
      timeout_ms: 1234,
    },
  });
  const rewrite = handleHookEvent(event, fx.options);
  assert.equal(rewrite.hookSpecificOutput.permissionDecision, "allow");
  assert.equal(rewrite.hookSpecificOutput.updatedInput.workdir, path.dirname(fx.target));
  assert.equal(rewrite.hookSpecificOutput.updatedInput.shell, "powershell");
  assert.equal(rewrite.hookSpecificOutput.updatedInput.timeout_ms, 1234);
});

test("corrupt state fails closed for supported pre-edit paths", (t) => {
  const fx = fixture(t);
  const engine = fx.engine();
  engine.recordRead(fx.target);
  fs.writeFileSync(engine.statePath, "{broken");
  const pre = fx.base("PreToolUse", {
    tool_name: "apply_patch",
    tool_input: { command: "*** Begin Patch\n*** Update File: src/auth.ts\n*** End Patch" },
  });
  const result = handleHookEvent(pre, fx.options);
  assert.equal(result.hookSpecificOutput.permissionDecision, "deny");
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /unreadable|corrupt/i);
});

test("hook runner completes the observed read protocol without rewriting the command", (t) => {
  const fx = fixture(t);
  const script = path.resolve(__dirname, "..", "scripts", "freshread-hook.cjs");
  const preEvent = fx.base("PreToolUse", {
    tool_name: "Bash",
    tool_use_id: "tool-read",
    tool_input: { command: canonicalReadCommand(fx.target) },
  });
  const pre = spawnSync(process.execPath, [script], {
    input: JSON.stringify(preEvent),
    encoding: "utf8",
    env: { ...process.env, FRESHREAD_TEST_MODE: "1", FRESHREAD_DATA_DIR: fx.dataDir },
  });
  assert.equal(pre.status, 0, pre.stderr);
  assert.equal(pre.stdout, "");
  const run = runUpdatedShell(preEvent.tool_input.command, fx.root);
  assert.equal(run.status, 0, run.stderr);
  const post = spawnSync(process.execPath, [script], {
    input: JSON.stringify({
      ...preEvent,
      hook_event_name: "PostToolUse",
      tool_input: preEvent.tool_input,
      tool_response: run.stdout,
    }),
    encoding: "utf8",
    env: { ...process.env, FRESHREAD_TEST_MODE: "1", FRESHREAD_DATA_DIR: fx.dataDir },
  });
  assert.equal(post.status, 0, post.stderr);
  assert.equal(post.stdout, "");
  assert.equal(fx.engine().inspect(fx.target).state, STATES.FRESH);
});

test("hook runner rejects malformed input with the documented fail-closed exit code", () => {
  const script = path.resolve(__dirname, "..", "scripts", "freshread-hook.cjs");
  const result = spawnSync(process.execPath, [script], {
    input: "{not-json",
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /rejected conservatively/i);
});

test("benchmark-only PreToolUse audit persists hashes and decision without raw command or tool id", (t) => {
  const fx = fixture(t);
  const nonce = "a".repeat(64);
  const toolUseId = "call-private-tool-id";
  const command = "node --version";
  const record = recordBenchmarkAudit(
    fx.base("PreToolUse", {
      tool_name: "exec_command",
      tool_use_id: toolUseId,
      tool_input: { command },
    }),
    {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "FreshRead blocked this edit: src/auth.ts is STALE_EXTERNAL",
      },
    },
    {
      FRESHREAD_TEST_MODE: "1",
      FRESHREAD_BENCHMARK_NONCE: nonce,
      FRESHREAD_DATA_DIR: fx.dataDir,
    },
  );
  assert.equal(record.decisionCode, "DENY_STALE_EXTERNAL");
  const auditPath = path.join(fx.dataDir, "benchmark-audit", nonce, `${record.toolUseIdSha256}.json`);
  const bytes = fs.readFileSync(auditPath, "utf8");
  assert.doesNotMatch(bytes, new RegExp(toolUseId));
  assert.doesNotMatch(bytes, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.deepEqual(JSON.parse(bytes), record);
});

test("benchmark audit is inert outside explicit test mode", (t) => {
  const fx = fixture(t);
  const result = recordBenchmarkAudit(
    fx.base("PreToolUse", {
      tool_name: "exec_command",
      tool_use_id: "call-no-audit",
      tool_input: { command: "node --version" },
    }),
    null,
    {
      FRESHREAD_BENCHMARK_NONCE: "b".repeat(64),
      PLUGIN_DATA: fx.dataDir,
    },
  );
  assert.equal(result, null);
  assert.equal(fs.existsSync(path.join(fx.dataDir, "benchmark-audit")), false);
});

test("hooks.json includes every lifecycle event required by the PRD", () => {
  const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "hooks", "hooks.json"), "utf8"));
  assert.deepEqual(new Set(Object.keys(config.hooks)), new Set([
    "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PreCompact", "PostCompact",
  ]));
  for (const groups of Object.values(config.hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks) {
        assert.equal(typeof hook.commandWindows, "string");
        assert.match(hook.commandWindows, /PLUGIN_ROOT/);
      }
    }
  }
  assert.match(config.hooks.PreToolUse[0].matcher, /shell_command/);
  assert.match(config.hooks.PostToolUse[0].matcher, /shell_command/);
});
