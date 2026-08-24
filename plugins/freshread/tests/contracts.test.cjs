"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  BENCHMARK_PROFILES,
  SCENARIOS,
  evaluateLatencyGate,
  evaluatePairedLatencyGate,
  runSuite,
} = require("../benchmarks/run-benchmark.cjs");
const {
  auditCommandHashEvidence,
  buildChildEnv,
  buildFreshReadHookDisableOverride,
  buildMcpDisableOverride,
  finalAgentMessageEvidence,
  readBenchmarkAudit,
  readAndValidateProof,
  resolveMarketplaceName,
  validateMcpConfigIsolation,
  validateProviderConfigRead,
} = require("../benchmarks/run-live-benchmark.cjs");
const { FreshReadEngine, STATES } = require("../src/freshread-core.cjs");
const pluginRoot = path.resolve(__dirname, "..");
const WINDOWS_DISCOVERY_DENY = "__FRESHREAD_DISCOVERY_DENY__";
const WINDOWS_DISCOVERY_FALLBACK = "__FRESHREAD_DISCOVERY_FALLBACK__";

function launcherTempBase() {
  if (process.platform !== "win32") return os.tmpdir();

  // GitHub's Windows runner can expose os.tmpdir() below D:\\a, whose parent
  // may be reparse-backed. Production discovery must keep rejecting that
  // layout, so place positive launcher fixtures below the user's canonical
  // LocalAppData temp directory instead. The launcher itself still verifies
  // that every workspace and trusted Node root is fixed, unsubstituted, and
  // free of reparse components.
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const base = path.join(localAppData, "Temp");
  fs.mkdirSync(base, { recursive: true });
  return fs.realpathSync.native(base);
}

function runWindowsHook(commandWindows, options) {
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
  assert.ok(systemRoot, "SystemRoot is required for the Windows launcher contract");
  const powershell = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  return spawnSync(powershell, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    commandWindows,
  ], options);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freshread-test-"));
  const dataDir = path.join(root, ".state");
  const makeEngine = (sessionId = "session-a", extra = {}) => new FreshReadEngine({
    cwd: root,
    dataDir,
    sessionId,
    ...extra,
  });
  return {
    root,
    dataDir,
    makeEngine,
    file(relativePath, body = "A\n") {
      const target = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body);
      return target;
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function launcherFixture(t) {
  const workspace = fs.mkdtempSync(path.join(launcherTempBase(), "freshread-launcher-"));
  const attackerBin = path.join(workspace, "bin");
  const pluginData = path.join(workspace, "plugin-data");
  fs.mkdirSync(attackerBin, { recursive: true });
  fs.writeFileSync(path.join(workspace, "sample.txt"), "sample\n");
  const fakeNode = path.join(attackerBin, process.platform === "win32" ? "node.exe" : "node");
  fs.writeFileSync(fakeNode, process.platform === "win32" ? "not an executable\n" : "#!/bin/sh\nexit 97\n");
  if (process.platform !== "win32") fs.chmodSync(fakeNode, 0o755);
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  return { attackerBin, pluginData, workspace };
}

function trustedWindowsNodeFixture(t, workspace) {
  assert.equal(process.platform, "win32");
  const fixtureRoot = fs.mkdtempSync(path.join(launcherTempBase(), "freshread-trusted-runtime-"));
  const programFiles = path.join(fixtureRoot, "Program Files");
  const nodeDirectory = path.join(programFiles, "nodejs");
  const nodeExecutable = path.join(nodeDirectory, "node.exe");
  try {
    fs.mkdirSync(nodeDirectory, { recursive: true });
    // Windows keeps the currently running executable locked through every hard
    // link to the same file record. A private byte-for-byte copy remains
    // executable while allowing deterministic cleanup on Node 18 and newer.
    fs.copyFileSync(process.execPath, nodeExecutable, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    throw error;
  }

  const relativeToWorkspace = path.relative(
    fs.realpathSync.native(workspace),
    fs.realpathSync.native(nodeExecutable)
  );
  assert.ok(
    relativeToWorkspace === ".." || relativeToWorkspace.startsWith(`..${path.sep}`),
    "the trusted Node fixture must remain outside the attacker-controlled workspace"
  );

  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  return {
    nodeDirectory,
    nodeExecutable,
    env(baseEnv, pathEntries = []) {
      const env = { ...baseEnv };
      const replaced = new Set(["path", "programfiles", "programw6432", "programfiles(x86)"]);
      for (const key of Object.keys(env)) {
        if (replaced.has(key.toLowerCase())) delete env[key];
      }
      env.ProgramFiles = programFiles;
      env.ProgramW6432 = programFiles;
      env["ProgramFiles(x86)"] = programFiles;
      env.PATH = [...pathEntries, nodeDirectory].join(path.delimiter);
      return env;
    },
  };
}

test("all hook events use fixed-system launchers with a 30-second timeout", () => {
  const pluginRoot = path.resolve(__dirname, "..");
  const config = JSON.parse(fs.readFileSync(path.join(pluginRoot, "hooks", "hooks.json"), "utf8"));
  const handlers = Object.values(config.hooks).flatMap((groups) => groups.flatMap((group) => group.hooks));
  assert.equal(handlers.length, 6);
  assert.deepEqual(new Set(handlers.map((hook) => hook.command)), new Set([
    '/bin/sh "$PLUGIN_ROOT/scripts/freshread-launch.sh"',
  ]));
  assert.deepEqual(new Set(handlers.map((hook) => hook.commandWindows)), new Set([
    "& $env:SystemRoot\\System32\\cscript.exe //B //Nologo $env:PLUGIN_ROOT\\scripts\\freshread-launch.js",
  ]));
  for (const hook of handlers) {
    assert.equal(hook.timeout, 30);
    assert.doesNotMatch(hook.command, /(?:^|[\s"'])node(?:\.exe)?(?:[\s"']|$)/i);
    assert.doesNotMatch(hook.commandWindows, /(?:^|[\s"'])node(?:\.exe)?(?:[\s"']|$)/i);
    assert.doesNotMatch(hook.commandWindows, /"/, "the native PowerShell hook command must stay quote-free");
    assert.match(hook.commandWindows, /^& \$env:SystemRoot\\System32\\cscript\.exe \/\/B \/\/Nologo \$env:PLUGIN_ROOT\\scripts\\freshread-launch\.js$/);
  }
  assert.equal(fs.existsSync(path.join(pluginRoot, "scripts", "freshread-launch.cmd")), true);
  assert.equal(fs.existsSync(path.join(pluginRoot, "scripts", "freshread-launch.js")), true);
  assert.equal(fs.existsSync(path.join(pluginRoot, "scripts", "freshread-node-path.js")), true);
  assert.equal(fs.existsSync(path.join(pluginRoot, "scripts", "freshread-launch.ps1")), true);
  assert.equal(fs.existsSync(path.join(pluginRoot, "scripts", "freshread-launch.sh")), true);
  const windowsLauncher = fs.readFileSync(path.join(pluginRoot, "scripts", "freshread-launch.js"), "utf8");
  assert.match(windowsLauncher, /function discoverNode\(/, "the integrated launcher must discover Node in-process");
  assert.doesNotMatch(
    windowsLauncher,
    /freshread-node-path\.js/,
    "the integrated launcher must not spawn the legacy discovery carrier"
  );
});

test("launcher rejects workspace and relative PATH node candidates while preserving plugin environment", (t) => {
  const fx = launcherFixture(t);
  const pluginRoot = path.resolve(__dirname, "..");
  const event = {
    session_id: "launcher-contract",
    cwd: fx.workspace,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_use_id: "launcher-read",
    tool_input: { command: `Get-Content -LiteralPath '${path.join(fx.workspace, "sample.txt")}' -Raw -Encoding utf8` },
  };
  let env = { ...process.env, PLUGIN_ROOT: fs.realpathSync.native(pluginRoot), PLUGIN_DATA: fx.pluginData };
  if (process.platform === "win32") {
    const trustedNode = trustedWindowsNodeFixture(t, fx.workspace);
    env = trustedNode.env(env, [".", fx.attackerBin]);
  } else {
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === "path") delete env[key];
    }
    env.PATH = [".", fx.attackerBin, path.dirname(process.execPath)].join(path.delimiter);
  }

  let result;
  const hooksConfig = JSON.parse(fs.readFileSync(path.join(pluginRoot, "hooks", "hooks.json"), "utf8"));
  const launcherHook = hooksConfig.hooks.PreToolUse[0].hooks[0];
  if (process.platform === "win32") {
    // Codex executes commandWindows through the thread's configured shell.
    // Current Windows Codex app-server threads use PowerShell, so exercise the
    // manifest command as one native PowerShell command string.
    result = runWindowsHook(launcherHook.commandWindows, {
      cwd: fx.workspace,
      env,
      input: JSON.stringify(event),
      encoding: "utf8",
    });
  } else {
    result = spawnSync("/bin/sh", ["-c", launcherHook.command], {
      cwd: fx.workspace,
      env,
      input: JSON.stringify(event),
      encoding: "utf8",
    });
  }

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  const evidenceDir = path.join(fx.pluginData, "tool-evidence");
  assert.equal(fs.existsSync(evidenceDir), true, "PLUGIN_DATA must reach the Node hook process");
  assert.equal(fs.readdirSync(evidenceDir).filter((name) => name.endsWith(".pending.json")).length, 1);
});

test("Windows fast discovery rejects workspace PATH entries and selects a normal absolute Node", { skip: process.platform !== "win32" }, (t) => {
  const fx = launcherFixture(t);
  const trustedNode = trustedWindowsNodeFixture(t, fx.workspace);
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
  const cscript = path.join(systemRoot, "System32", "cscript.exe");
  const discovery = path.join(pluginRoot, "scripts", "freshread-node-path.js");
  const env = trustedNode.env(
    { ...process.env, PLUGIN_ROOT: fs.realpathSync.native(pluginRoot) },
    [".", fx.attackerBin]
  );
  const result = spawnSync(cscript, ["//B", "//Nologo", discovery], {
    cwd: fx.workspace,
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    path.resolve(result.stdout.trim()).toLowerCase(),
    path.resolve(trustedNode.nodeExecutable).toLowerCase()
  );
});

test("Windows fast discovery explicitly rejects reparse-backed workspaces", { skip: process.platform !== "win32" }, (t) => {
  const root = fs.mkdtempSync(path.join(launcherTempBase(), "freshread-launcher-junction-"));
  const realWorkspace = path.join(root, "real-workspace");
  const linkedWorkspace = path.join(root, "linked-workspace");
  fs.mkdirSync(realWorkspace);
  fs.symlinkSync(realWorkspace, linkedWorkspace, "junction");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
  const result = spawnSync(path.join(systemRoot, "System32", "cscript.exe"), [
    "//B", "//Nologo", path.join(pluginRoot, "scripts", "freshread-node-path.js"),
  ], {
    cwd: linkedWorkspace,
    env: { ...process.env, PLUGIN_ROOT: fs.realpathSync.native(pluginRoot), PATH: path.dirname(process.execPath) },
    encoding: "utf8",
  });
  assert.equal(result.status, 4);
  assert.equal(result.stdout.trim(), WINDOWS_DISCOVERY_DENY);
});

test("Windows hook carrier preserves a literal percent sequence in PLUGIN_ROOT", { skip: process.platform !== "win32" }, (t) => {
  const root = fs.mkdtempSync(path.join(launcherTempBase(), "freshread-percent-root-"));
  const pluginAlias = path.join(root, "plugin-%FRESHREAD_SEGMENT%");
  fs.symlinkSync(pluginRoot, pluginAlias, "junction");
  const trustedNode = trustedWindowsNodeFixture(t, root);
  t.after(() => {
    try { fs.unlinkSync(pluginAlias); } catch (error) { if (error.code !== "ENOENT") throw error; }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const hooksConfig = JSON.parse(fs.readFileSync(path.join(pluginRoot, "hooks", "hooks.json"), "utf8"));
  const commandWindows = hooksConfig.hooks.UserPromptSubmit[0].hooks[0].commandWindows;
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
  const baseEnv = {
    ...process.env,
    FRESHREAD_SEGMENT: "EXPANDED",
    PLUGIN_ROOT: pluginAlias,
  };
  const discovery = spawnSync(path.join(systemRoot, "System32", "cscript.exe"), [
    "//B", "//Nologo", path.join(pluginAlias, "scripts", "freshread-node-path.js"),
  ], {
    cwd: root,
    env: trustedNode.env(baseEnv),
    encoding: "utf8",
  });
  assert.equal(discovery.status, 5);
  assert.equal(discovery.stdout.trim(), WINDOWS_DISCOVERY_FALLBACK);

  const result = runWindowsHook(commandWindows, {
    cwd: root,
    env: trustedNode.env({ ...baseEnv, PLUGIN_DATA: path.join(root, "plugin-data") }),
    input: JSON.stringify({
      session_id: "percent-root-contract",
      cwd: root,
      hook_event_name: "UserPromptSubmit",
      prompt: "continue",
    }),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});

test("Windows fast path cannot disguise a workspace Node through an 8.3 alias", { skip: process.platform !== "win32" }, (t) => {
  const fx = launcherFixture(t);
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
  const commandProcessor = path.join(systemRoot, "System32", "cmd.exe");
  const nodeDirectory = path.dirname(process.execPath);
  const short = spawnSync(commandProcessor, ["/D", "/C", `for %I in ("${nodeDirectory}") do @echo %~sI`], {
    encoding: "utf8",
  });
  assert.equal(short.status, 0, short.stderr);
  const shortNodeDirectory = short.stdout.trim();
  if (!shortNodeDirectory || shortNodeDirectory.toLowerCase() === nodeDirectory.toLowerCase()) {
    t.skip("this volume does not expose a distinct 8.3 alias for Node");
    return;
  }
  const discovery = spawnSync(path.join(systemRoot, "System32", "cscript.exe"), [
    "//B", "//Nologo", path.join(pluginRoot, "scripts", "freshread-node-path.js"),
  ], {
    cwd: nodeDirectory,
    env: { ...process.env, PLUGIN_ROOT: fs.realpathSync.native(pluginRoot), PATH: shortNodeDirectory },
    encoding: "utf8",
  });
  assert.equal(discovery.status, 4);
  assert.equal(discovery.stdout.trim(), WINDOWS_DISCOVERY_DENY);

  const hooksConfig = JSON.parse(fs.readFileSync(path.join(pluginRoot, "hooks", "hooks.json"), "utf8"));
  const commandWindows = hooksConfig.hooks.UserPromptSubmit[0].hooks[0].commandWindows;
  const result = runWindowsHook(commandWindows, {
    cwd: nodeDirectory,
    env: {
      ...process.env,
      PLUGIN_ROOT: fs.realpathSync.native(pluginRoot),
      PLUGIN_DATA: fx.pluginData,
      PATH: shortNodeDirectory,
    },
    input: JSON.stringify({
      session_id: "short-alias-contract",
      cwd: nodeDirectory,
      hook_event_name: "UserPromptSubmit",
      prompt: "continue",
    }),
    encoding: "utf8",
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Node discovery rejected/i);
});

test("Windows launcher does not retry a SUBST workspace alias through PowerShell", { skip: process.platform !== "win32" }, (t) => {
  const fx = launcherFixture(t);
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
  const cscript = path.join(systemRoot, "System32", "cscript.exe");
  const subst = path.join(systemRoot, "System32", "subst.exe");
  const nodeDirectory = path.dirname(process.execPath);
  const driveLetter = ["R", "Q", "T", "U", "V", "W", "X", "Y", "Z"]
    .find((letter) => !fs.existsSync(`${letter}:\\`));
  assert.ok(driveLetter, "an unused drive letter is required for the SUBST launcher contract");
  const drive = `${driveLetter}:`;
  const created = spawnSync(subst, [drive, nodeDirectory], { encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  t.after(() => {
    const removed = spawnSync(subst, [drive, "/D"], { encoding: "utf8" });
    assert.equal(removed.status, 0, removed.stderr);
  });

  const env = {
    ...process.env,
    FRESHREAD_ENABLED: "0",
    FRESHREAD_TEST_MODE: "1",
    PLUGIN_DATA: fx.pluginData,
    PLUGIN_ROOT: fs.realpathSync.native(pluginRoot),
    PATH: `${drive}\\`,
  };
  const discovery = spawnSync(cscript, [
    "//B", "//Nologo", path.join(pluginRoot, "scripts", "freshread-node-path.js"),
  ], {
    cwd: nodeDirectory,
    env,
    encoding: "utf8",
  });
  assert.equal(discovery.status, 4);
  assert.equal(discovery.stdout.trim(), WINDOWS_DISCOVERY_DENY);

  const hooksConfig = JSON.parse(fs.readFileSync(path.join(pluginRoot, "hooks", "hooks.json"), "utf8"));
  const commandWindows = hooksConfig.hooks.UserPromptSubmit[0].hooks[0].commandWindows;
  const result = runWindowsHook(commandWindows, {
    cwd: nodeDirectory,
    env,
    input: JSON.stringify({
      session_id: "subst-alias-contract",
      cwd: nodeDirectory,
      hook_event_name: "UserPromptSubmit",
      prompt: "continue",
    }),
    encoding: "utf8",
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Node discovery rejected/i);
});

test("Windows launcher fails closed without any Node PATH candidate", { skip: process.platform !== "win32" }, (t) => {
  const fx = launcherFixture(t);
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
  const cscript = path.join(systemRoot, "System32", "cscript.exe");
  const env = {
    ...process.env,
    FRESHREAD_ENABLED: "0",
    FRESHREAD_TEST_MODE: "1",
    PLUGIN_DATA: fx.pluginData,
    PLUGIN_ROOT: fs.realpathSync.native(pluginRoot),
    PATH: "",
  };
  const discovery = spawnSync(cscript, [
    "//B", "//Nologo", path.join(pluginRoot, "scripts", "freshread-node-path.js"),
  ], {
    cwd: fx.workspace,
    env,
    encoding: "utf8",
  });
  assert.equal(discovery.status, 4);
  assert.equal(discovery.stdout.trim(), WINDOWS_DISCOVERY_DENY);

  const hooksConfig = JSON.parse(fs.readFileSync(path.join(pluginRoot, "hooks", "hooks.json"), "utf8"));
  const commandWindows = hooksConfig.hooks.UserPromptSubmit[0].hooks[0].commandWindows;
  const result = runWindowsHook(commandWindows, {
    cwd: fx.workspace,
    env,
    input: JSON.stringify({
      session_id: "empty-path-contract",
      cwd: fx.workspace,
      hook_event_name: "UserPromptSubmit",
      prompt: "continue",
    }),
    encoding: "utf8",
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Node discovery rejected/i);
});

test("PreToolUse launcher failure returns a protocol-level denial", (t) => {
  const fx = launcherFixture(t);
  const pluginRoot = path.resolve(__dirname, "..");
  const hooksConfig = JSON.parse(fs.readFileSync(path.join(pluginRoot, "hooks", "hooks.json"), "utf8"));
  const launcherHook = hooksConfig.hooks.PreToolUse[0].hooks[0];
  const env = { ...process.env, PLUGIN_ROOT: pluginRoot, PLUGIN_DATA: fx.pluginData };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "path") delete env[key];
  }
  env.PATH = fx.attackerBin;
  const event = {
    session_id: "launcher-failure-contract",
    cwd: fx.workspace,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_use_id: "launcher-failure-read",
    tool_input: { command: `Get-Content -LiteralPath '${path.join(fx.workspace, "sample.txt")}' -Raw -Encoding utf8` },
  };

  let result;
  if (process.platform === "win32") {
    result = runWindowsHook(launcherHook.commandWindows, {
      cwd: fx.workspace,
      env,
      input: JSON.stringify(event),
      encoding: "utf8",
    });
  } else {
    result = spawnSync("/bin/sh", ["-c", launcherHook.command], {
      cwd: fx.workspace,
      env,
      input: JSON.stringify(event),
      encoding: "utf8",
    });
  }
  if (process.platform === "win32") {
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /FreshRead launcher failed visibly/i);
  } else {
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /FreshRead launcher failed/i);
  }
});

test("benchmark contract contains all eight PRD cases", () => {
  assert.deepEqual(SCENARIOS.map((item) => item.id.slice(0, 3)), [
    "C01", "C02", "C03", "C04", "C05", "C06", "C07", "C08",
  ]);
});

function finalResponseEvents(errorParams) {
  const events = [];
  if (errorParams) events.push({ method: "error", params: { threadId: "thread-a", turnId: "turn-a", ...errorParams } });
  events.push({
    method: "item/completed",
    params: {
      threadId: "thread-a",
      turnId: "turn-a",
      item: { type: "agentMessage", phase: "final_answer", text: "DONE" },
    },
  });
  events.push({ method: "turn/completed", params: { threadId: "thread-a", turn: { id: "turn-a" } } });
  return events;
}

test("live final-response gate observes but accepts a completed structured stream retry", () => {
  const events = finalResponseEvents({
    willRetry: true,
    error: {
      message: "Reconnecting",
      additionalDetails: "request timed out",
      codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
    },
  });
  const evidence = finalAgentMessageEvidence(events, "thread-a", "turn-a", 2);
  assert.equal(evidence.passed, true);
  assert.equal(evidence.targetErrorNotificationCount, 1);
  assert.equal(evidence.targetRetriableTransportErrorNotificationCount, 1);
  assert.equal(evidence.targetTerminalErrorNotificationCount, 0);
});

test("live final-response gate rejects terminal and malformed retry errors", () => {
  for (const errorParams of [
    {
      willRetry: false,
      error: { message: "terminal", codexErrorInfo: { responseStreamDisconnected: {} } },
    },
    {
      willRetry: true,
      error: { message: "retrying", codexErrorInfo: "internalServerError" },
    },
    {
      willRetry: true,
      error: {
        message: " ",
        codexErrorInfo: { responseStreamDisconnected: {}, responseStreamConnectionFailed: {} },
      },
    },
    {
      willRetry: true,
      error: {
        message: "retrying",
        additionalDetails: 42,
        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 70000 } },
      },
    },
  ]) {
    const events = finalResponseEvents(errorParams);
    const evidence = finalAgentMessageEvidence(events, "thread-a", "turn-a", 2);
    assert.equal(evidence.passed, false);
    assert.equal(evidence.targetTerminalErrorNotificationCount, 1);
  }
});

test("live final-response gate rejects retry notifications after the terminal message", () => {
  const events = finalResponseEvents(null);
  events.splice(1, 0, {
    method: "error",
    params: {
      threadId: "thread-a",
      turnId: "turn-a",
      willRetry: true,
      error: { message: "late retry", codexErrorInfo: { responseStreamDisconnected: {} } },
    },
  });
  const evidence = finalAgentMessageEvidence(events, "thread-a", "turn-a", 2);
  assert.equal(evidence.passed, false);
  assert.equal(evidence.targetRetriableTransportErrorNotificationCount, 0);
  assert.equal(evidence.targetTerminalErrorNotificationCount, 1);
});

test("live audit binding accepts only an exact finite command variant", () => {
  const hash = (value) => crypto.createHash("sha256").update(value, "utf8").digest("hex");
  const plan = { variants: ["Get-Content 'C:\\target.txt'", "Get-Content 'C:\\\\target.txt'"] };
  const trace = { command: plan.variants[1], rawCommand: `powershell.exe -Command ${plan.variants[1]}` };
  const normalizedAudit = auditCommandHashEvidence(hash(plan.variants[0]), trace, plan);
  assert.equal(normalizedAudit.directlyObserved, false);
  assert.equal(normalizedAudit.matchedPlanVariant, 0);
  assert.equal(normalizedAudit.passed, true);
  assert.equal(auditCommandHashEvidence(hash("different command"), trace, plan).passed, false);
});

test("live benchmark requires persisted exact hook trust before starting a model turn", () => {
  const source = fs.readFileSync(path.join(pluginRoot, "benchmarks", "run-live-benchmark.cjs"), "utf8");
  assert.match(source, /hook\.trustStatus === "trusted"/);
  assert.match(source, /hook\.key === EXPECTED_HOOK_KEYS\[hook\.eventName\]/);
  assert.match(source, /\^sha256:\[0-9a-f\]\{64\}\$/);
  assert.match(source, /const expectedExecutedCommands = enabled \? 2 : 3/);
  assert.match(source, /FRESHREAD_BENCHMARK_NONCE: nonce/);
  assert.match(source, /if \(!enabled\) configOverrides\.push\(buildFreshReadHookDisableOverride\(\)\)/);
  assert.match(source, /const prefix = `\$\{label\}:\$\{run\.displayOrder\}:\$\{run\.sourcePath\}:`/);
  assert.match(source, /pair\.pre\[0\]\.completed\.eventIndex < pair\.command\.startedIndex/);
  assert.doesNotMatch(source, /completion ordinal|exclusive three-command tool ledger/);
  assert.doesNotMatch(source, /bypass_hook_trust|dangerously-bypass-hook-trust/);
  const runArm = source.slice(source.indexOf("async function runArm("), source.indexOf("function renderMarkdown("));
  assert.doesNotMatch(runArm, /FRESHREAD_ENABLED/);
  const configRead = runArm.indexOf('client.request("config/read"');
  const configIsolation = runArm.indexOf("validateMcpConfigIsolation(configRead");
  const hooksList = runArm.indexOf('client.request("hooks/list"');
  const trustFailure = runArm.indexOf('benchmarkError("HOOK_TRUST_OR_CONTRACT_MISMATCH"');
  const threadStart = runArm.indexOf('client.request("thread/start"');
  const turnStart = runArm.indexOf('client.request("turn/start"');
  assert.ok(configRead >= 0 && configRead < configIsolation && configIsolation < hooksList &&
    hooksList < trustFailure && trustFailure < threadStart && threadStart < turnStart);
  assert.doesNotMatch(source, /["']mcp_servers=\{\}["']/);
  assert.doesNotMatch(source, /["']model_providers=\{\}["']/);
  assert.match(source, /discoverEffectiveMcpServers\(codexBin, workspace, childEnv, nonce\)/);
  assert.match(source, /"-c", "features\.apps=false"/);
  assert.match(source, /event\.method === "mcpServer\/startupStatus\/updated"/);
  assert.match(source, /item\.phase === "final_answer"/);
  assert.match(source, /terminalPhase === null \|\| terminalPhase === undefined/);
  assert.match(source, /finalMessages\.length === 0 \|\| finalMessages\[0\] === terminalMessage/);
  assert.match(source, /event\.method === "error"/);
});

test("live benchmark dynamically disables the exact effective MCP inventory", () => {
  assert.equal(buildMcpDisableOverride([]), null);
  const names = ["zeta", "with.dot", 'quote"key', "back\\slash"];
  const override = buildMcpDisableOverride(names);
  assert.match(override, /^mcp_servers=\{/);
  assert.match(override, /"with\.dot"=\{enabled=false\}/);
  assert.match(override, /"quote\\"key"=\{enabled=false\}/);
  assert.match(override, /"back\\\\slash"=\{enabled=false\}/);

  const configRead = {
    origins: {},
    config: {
      model: "gpt-5.6-sol",
      model_provider: "openai",
      model_providers: {},
      features: { apps: false },
      mcp_servers: Object.fromEntries(names.map((name) => [name, { enabled: false }])),
    },
  };
  const evidence = validateMcpConfigIsolation(configRead, names);
  assert.equal(evidence.passed, true);
  assert.equal(evidence.disabledServerCount, names.length);
  configRead.config.mcp_servers.zeta.enabled = true;
  assert.throws(() => validateMcpConfigIsolation(configRead, names), /retained an enabled server/);
});

test("live benchmark baseline disables exactly the six FreshRead hooks per process", () => {
  const override = buildFreshReadHookDisableOverride();
  assert.match(override, /^hooks\.state=\{/);
  assert.equal((override.match(/=\{enabled=false\}/g) || []).length, 6);
  for (const key of [
    "freshread@personal:hooks/hooks.json:session_start:0:0",
    "freshread@personal:hooks/hooks.json:user_prompt_submit:0:0",
    "freshread@personal:hooks/hooks.json:pre_tool_use:0:0",
    "freshread@personal:hooks/hooks.json:post_tool_use:0:0",
    "freshread@personal:hooks/hooks.json:pre_compact:0:0",
    "freshread@personal:hooks/hooks.json:post_compact:0:0",
  ]) assert.match(override, new RegExp(JSON.stringify(key).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(override, /trusted_hash/);
});

test("live benchmark accepts only safe Codex marketplace identifiers", () => {
  assert.equal(resolveMarketplaceName("freshread"), "freshread");
  assert.equal(resolveMarketplaceName("team_1"), "team_1");
  assert.throws(() => resolveMarketplaceName("../cache"), /valid Codex marketplace name/);
  assert.throws(() => resolveMarketplaceName("a".repeat(65)), /valid Codex marketplace name/);
});

test("live benchmark reports missing audit evidence without losing arm diagnostics", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freshread-audit-missing-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const audit = readBenchmarkAudit(root, "a".repeat(64));
  assert.deepEqual(audit.records, []);
  assert.equal(audit.public.passed, false);
  assert.equal(audit.public.recordCount, 0);
  assert.equal(audit.public.errorCode, "BENCHMARK_AUDIT_MISSING");
  assert.match(audit.public.nonceSha256, /^[0-9a-f]{64}$/);
});

test("live benchmark reports missing collaborator proof without losing arm diagnostics", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freshread-proof-missing-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const proof = readAndValidateProof(path.join(root, "missing.json"), "a".repeat(64), path.join(root, "target.txt"));
  assert.equal(proof.valid, false);
  assert.equal(proof.errorCode, "EXTERNAL_EDIT_PROOF_MISSING");
  assert.equal(proof.marker, "<UNAVAILABLE>");
  assert.equal(proof.sha256, null);
});

test("live benchmark fails closed on provider endpoint overrides and strips endpoint env", () => {
  const clean = {
    origins: {},
    config: {
      model: "gpt-5.6-sol",
      model_provider: "openai",
      model_providers: {},
      features: { apps: false },
      mcp_servers: {},
      openai_base_url: null,
      chatgpt_base_url: null,
    },
  };
  assert.equal(validateProviderConfigRead(clean).evidence.passed, true);
  const officialDefault = validateProviderConfigRead({
    ...clean,
    config: { ...clean.config, chatgpt_base_url: "https://chatgpt.com/backend-api/" },
  });
  assert.equal(officialDefault.evidence.passed, true);
  assert.equal(officialDefault.evidence.chatgptBaseUrlOfficialDefault, true);
  assert.equal(officialDefault.evidence.chatgptBaseUrlMode, "official-default");
  assert.equal(validateProviderConfigRead({
    ...clean,
    config: { ...clean.config, chatgpt_base_url: "https://chatgpt.com/backend-api" },
  }).evidence.passed, true);
  assert.throws(() => validateProviderConfigRead({
    ...clean,
    config: { ...clean.config, openai_base_url: "https://example.invalid/v1" },
  }), /default OpenAI endpoints/);
  assert.throws(() => validateProviderConfigRead({
    ...clean,
    config: { ...clean.config, chatgpt_base_url: "https://example.invalid/backend-api" },
  }), /default OpenAI endpoints/);
  for (const rejectedChatgptBaseUrl of [
    "https://chatgpt.com.evil.invalid/backend-api/",
    "https://chatgpt.com/backend-api/?source=override",
    "https://user@chatgpt.com/backend-api/",
    "https://chatgpt.com/backend-api/codex/",
  ]) {
    assert.throws(() => validateProviderConfigRead({
      ...clean,
      config: { ...clean.config, chatgpt_base_url: rejectedChatgptBaseUrl },
    }), /default OpenAI endpoints/);
  }
  assert.throws(() => validateProviderConfigRead({
    ...clean,
    config: { ...clean.config, model_providers: { openai: { base_url: "https://example.invalid/v1" } } },
  }), /default OpenAI endpoints/);
  assert.throws(() => validateProviderConfigRead({
    ...clean,
    config: { ...clean.config, features: { apps: true } },
  }), /Apps MCP feature/);

  const previous = process.env.OPENAI_BASE_URL;
  const previousChatgpt = process.env.CHATGPT_BASE_URL;
  process.env.OPENAI_BASE_URL = "https://example.invalid/v1";
  process.env.CHATGPT_BASE_URL = "https://example.invalid/backend-api";
  try {
    const env = buildChildEnv({ FRESHREAD_TEST_MODE: "1" });
    assert.equal(Object.keys(env).some((key) => key.toUpperCase() === "OPENAI_BASE_URL"), false);
    assert.equal(Object.keys(env).some((key) => key.toUpperCase() === "CHATGPT_BASE_URL"), false);
    assert.throws(() => buildChildEnv({ OPENAI_BASE_URL: "https://example.invalid/v1" }), /endpoint override environment variables/);
    if (process.platform === "win32") {
      for (const key of ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]) {
        if (process.env[key] !== undefined) assert.equal(env[key], process.env[key]);
      }
    }
  } finally {
    if (previous === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previous;
    if (previousChatgpt === undefined) delete process.env.CHATGPT_BASE_URL;
    else process.env.CHATGPT_BASE_URL = previousChatgpt;
  }
});

test("performance latency gates require independent absolute and baseline-delta passes", () => {
  const deltaOnlyFailure = evaluateLatencyGate(10, 90, 100, 50);
  assert.equal(deltaOnlyFailure.absolutePassed, true);
  assert.equal(deltaOnlyFailure.deltaPassed, false);
  assert.equal(deltaOnlyFailure.passed, false);

  const absoluteOnlyFailure = evaluateLatencyGate(200, 250, 225, 75);
  assert.equal(absoluteOnlyFailure.absolutePassed, false);
  assert.equal(absoluteOnlyFailure.deltaPassed, true);
  assert.equal(absoluteOnlyFailure.passed, false);

  const bothPass = evaluateLatencyGate(40, 60, 100, 25);
  assert.equal(bothPass.absolutePassed, true);
  assert.equal(bothPass.deltaPassed, true);
  assert.equal(bothPass.passed, true);
  assert.equal(bothPass.p95BudgetMs, bothPass.p95AbsoluteBudgetMs);
});

test("cold hook latency uses paired delta p95 independently of the absolute gate", () => {
  const pairedPass = evaluatePairedLatencyGate(490, [-20, 15, 25, 35, 40], 500, 100);
  assert.equal(pairedPass.p95DeltaMs, 40);
  assert.equal(pairedPass.p95DeltaMs, pairedPass.pairedDeltaP95Ms);
  assert.equal(pairedPass.deltaMethod, "paired-freshread-minus-baseline");
  assert.equal(pairedPass.absolutePassed, true);
  assert.equal(pairedPass.deltaPassed, true);
  assert.equal(pairedPass.passed, true);

  const deltaOnlyFailure = evaluatePairedLatencyGate(490, [10, 20, 101], 500, 100);
  assert.equal(deltaOnlyFailure.absolutePassed, true);
  assert.equal(deltaOnlyFailure.deltaPassed, false);
  assert.equal(deltaOnlyFailure.passed, false);

  const absoluteOnlyFailure = evaluatePairedLatencyGate(501, [-50, -25, 0], 500, 100);
  assert.equal(absoluteOnlyFailure.absolutePassed, false);
  assert.equal(absoluteOnlyFailure.deltaPassed, true);
  assert.equal(absoluteOnlyFailure.passed, false);
  assert.equal(BENCHMARK_PROFILES.full.coldHookIterations, 20);
  assert.equal(BENCHMARK_PROFILES.full.coldHookAbsoluteBudgetMs, 500);
  assert.equal(BENCHMARK_PROFILES.full.coldHookDeltaBudgetMs, 100);
});

test("quick FreshRead benchmark reports scoped gates without claiming overall release eligibility", () => {
  const report = runSuite();
  assert.equal(report.schemaVersion, 3);
  assert.equal(BENCHMARK_PROFILES.quick.deterministicEligible, false);
  assert.equal(BENCHMARK_PROFILES.full.deterministicEligible, true);
  assert.equal(report.executionProfile.deterministicEligible, false);
  assert.equal(Object.hasOwn(report.executionProfile, "releaseEligible"), false);
  const failedCases = report.freshread.cases
    .filter((item) => !item.passed)
    .map(({ id, checkpoints, signals, metadataChecks }) => ({ id, checkpoints, signals, metadataChecks }));
  assert.equal(
    report.freshread.summary.requiredCasesPassed,
    8,
    `failed benchmark cases: ${JSON.stringify(failedCases)}`
  );
  assert.equal(report.freshread.summary.staleMissingRecall, 1);
  assert.equal(report.freshread.summary.freshFalsePositiveRate, 0);
  assert.equal(report.freshread.summary.unknownAsFreshCount, 0);
  assert.equal(report.freshread.summary.preEditGuardRate, 1);
  assert.equal(report.freshread.performance.unchangedCheckpointHashCalls, 0);
  for (const comparison of Object.values(report.freshread.performanceComparison.cases)) {
    // The general Node/OS matrix runs on shared hosts, so it verifies the gate
    // calculation contract without turning one quick wall-clock sample into a
    // release signal. The dedicated deterministic benchmark job retains every
    // full-profile sample and enforces the unchanged latency budgets.
    assert.equal(
      comparison.passed,
      comparison.absolutePassed && comparison.deltaPassed &&
        comparison.trackedWorkloadMatched && comparison.unchangedCheckpointHashPassed
    );
    assert.equal(comparison.p95BudgetMs, comparison.p95AbsoluteBudgetMs);
  }
  const growth = report.freshread.performanceComparison.readGrowth;
  assert.equal(growth.required, true);
  assert.equal(growth.files, 50);
  assert.equal(
    growth.nthReadLatency.passed,
    growth.nthReadLatency.absolutePassed && growth.nthReadLatency.deltaPassed
  );
  assert.equal(
    growth.nearNthReadLatency.passed,
    growth.nearNthReadLatency.absolutePassed && growth.nearNthReadLatency.deltaPassed
  );
  assert.equal(growth.linearWorkPassed, true);
  assert.ok(growth.freshread.readPhaseStatCalls <= growth.maxReadPhaseStatCalls);
  assert.equal(
    growth.passed,
    growth.nthReadLatency.passed && growth.nearNthReadLatency.passed && growth.linearWorkPassed
  );
  assert.equal(report.freshread.performanceComparison.populatedHookSpawn.required, false);
  assert.equal(report.freshread.performanceComparison.populatedHookSpawn.status, "SKIPPED_QUICK_PROFILE");
  assert.equal(BENCHMARK_PROFILES.full.populatedHookKey, "1000");
  assert.equal(BENCHMARK_PROFILES.full.populatedHookIterations, 8);
  const resumeCase = report.freshread.cases.find((item) => item.id === "C06-resume-detects-drift");
  assert.equal(resumeCase.signals[0].observed, "CONTEXT:STALE_EXTERNAL");
  assert.equal(report.launchGate.gates.deterministic.passed, true);
  assert.equal(report.launchGate.gates.handler.passed, true);
  assert.equal(report.launchGate.gates.security.passed, true);
  assert.equal(report.launchGate.gates.provenance.passed, true);
  assert.equal(report.launchGate.deterministicEligible, false);
  assert.equal(report.launchGate.releaseEligible, false);
  assert.deepEqual(report.launchGate.gates.liveLifecycle, {
    required: true,
    passed: null,
    status: "NOT_RUN",
    claim: "Live Codex lifecycle evidence is required for overall release eligibility and is not run by this deterministic benchmark.",
  });
});

test("same-content touch stays fresh but hashes only once", (t) => {
  const fx = fixture();
  t.after(() => fx.cleanup());
  const target = fx.file("src/auth.ts", "same\n");
  const engine = fx.makeEngine();
  engine.recordRead(target);
  const before = engine.metrics.hashCalls;
  const future = new Date(Date.now() + 2000);
  fs.utimesSync(target, future, future);
  assert.equal(engine.inspect(target).state, STATES.FRESH);
  assert.equal(engine.metrics.hashCalls - before, 1);
  const after = engine.metrics.hashCalls;
  assert.equal(engine.inspect(target).state, STATES.FRESH);
  assert.equal(engine.metrics.hashCalls, after);
});

test("self change followed by external change escalates to STALE_EXTERNAL", (t) => {
  const fx = fixture();
  t.after(() => fx.cleanup());
  const target = fx.file("src/auth.ts", "A\n");
  const engine = fx.makeEngine();
  engine.recordRead(target);
  fs.writeFileSync(target, "B\n");
  engine.recordSelfWrite(target);
  assert.equal(engine.inspect(target).state, STATES.STALE_SELF);
  fs.writeFileSync(target, "C\n");
  assert.equal(engine.inspect(target).state, STATES.STALE_EXTERNAL);
});

test("sessions are isolated and clear affects only the active session", (t) => {
  const fx = fixture();
  t.after(() => fx.cleanup());
  const target = fx.file("src/auth.ts", "A\n");
  const a = fx.makeEngine("session-a");
  const b = fx.makeEngine("session-b");
  a.recordRead(target);
  b.recordRead(target);
  a.clear();
  assert.equal(a.inspect(target).state, STATES.UNKNOWN);
  assert.equal(b.inspect(target).state, STATES.FRESH);
});

test("corrupt persisted state fails visible as UNKNOWN", (t) => {
  const fx = fixture();
  t.after(() => fx.cleanup());
  const target = fx.file("src/auth.ts", "A\n");
  const engine = fx.makeEngine();
  engine.recordRead(target);
  fs.writeFileSync(engine.statePath, "{not-json");
  const reloaded = fx.makeEngine();
  const result = reloaded.inspect(target);
  assert.equal(result.state, STATES.UNKNOWN);
  assert.match(result.detail || "", /state|snapshot|corrupt/i);
});

test("guard blocks stale and missing tracked files, but not unknown files", (t) => {
  const fx = fixture();
  t.after(() => fx.cleanup());
  const stale = fx.file("src/stale.ts", "A\n");
  const missing = fx.file("src/missing.ts", "A\n");
  const unknown = fx.file("src/unknown.ts", "A\n");
  const engine = fx.makeEngine();
  engine.recordRead(stale);
  engine.recordRead(missing);
  fs.writeFileSync(stale, "B\n");
  fs.unlinkSync(missing);
  const result = engine.guardEdit([stale, missing, unknown]);
  assert.equal(result.blocked, true);
  assert.deepEqual(new Set(result.files.map((item) => item.state)), new Set([STATES.STALE_EXTERNAL, STATES.MISSING]));
});

test("resume context prioritizes stale files ahead of the 100-path display cap", (t) => {
  const fx = fixture();
  t.after(() => fx.cleanup());
  const engine = fx.makeEngine();
  const fresh = Array.from({ length: 100 }, (_, index) => ({
    displayPath: `a-${String(index).padStart(3, "0")}.ts`,
    state: STATES.FRESH,
  }));
  const stale = { displayPath: "z-stale.ts", state: STATES.STALE_EXTERNAL };
  const text = engine.formatFreshnessContext({ files: [...fresh, stale], corrupt: false }, { includeFresh: true });
  assert.match(text, /z-stale\.ts: STALE_EXTERNAL/);
  assert.match(text, /1 more tracked file omitted/);
});
