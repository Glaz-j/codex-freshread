#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const EXPECTED_STATES = new Set([
  "UNKNOWN",
  "FRESH",
  "STALE_SELF",
  "STALE_EXTERNAL",
  "MISSING",
]);
const POSITIVE_STATES = new Set(["STALE_SELF", "STALE_EXTERNAL", "MISSING"]);
const EXPECTED_CASE_IDS = Object.freeze([
  "C01-unchanged-read",
  "C02-external-change",
  "C03-self-change",
  "C04-reread-refreshes",
  "C05-missing-file",
  "C06-resume-detects-drift",
  "C07-compaction-persists-metadata",
  "C08-untracked-is-unknown",
]);

// `runSuite()` is the contract-test entry point and intentionally defaults to
// the quick profile. The CLI always selects `full` unless --quick is explicit,
// so release artifacts can never silently inherit the reduced test workload.
const BENCHMARK_PROFILES = Object.freeze({
  quick: Object.freeze({
    name: "quick-test",
    fullScale: false,
    deterministicEligible: false,
    performanceCases: Object.freeze([
      Object.freeze({ key: "quick-10", files: 10, iterations: 2, absoluteBudgetMs: 50, deltaBudgetMs: 30 }),
      Object.freeze({ key: "quick-50", files: 50, iterations: 1, absoluteBudgetMs: 100, deltaBudgetMs: 75 }),
    ]),
    coldHookIterations: 0,
    coldHookAbsoluteBudgetMs: null,
    coldHookDeltaBudgetMs: null,
    readGrowthKey: "quick-50",
    readTailSampleCount: 10,
    nthReadAbsoluteBudgetMs: 100,
    nthReadDeltaBudgetMs: 75,
    maxReadStatCallsPerFile: 3,
    populatedHookKey: null,
    populatedHookIterations: 0,
    populatedHookAbsoluteBudgetMs: null,
    populatedHookDeltaBudgetMs: null,
  }),
  full: Object.freeze({
    name: "full-release",
    fullScale: true,
    deterministicEligible: true,
    performanceCases: Object.freeze([
      Object.freeze({ key: "100", files: 100, iterations: 20, absoluteBudgetMs: 50, deltaBudgetMs: 30 }),
      Object.freeze({ key: "1000", files: 1000, iterations: 8, absoluteBudgetMs: 400, deltaBudgetMs: 300 }),
    ]),
    coldHookIterations: 20,
    coldHookAbsoluteBudgetMs: 500,
    coldHookDeltaBudgetMs: 100,
    readGrowthKey: "1000",
    readTailSampleCount: 10,
    nthReadAbsoluteBudgetMs: 150,
    nthReadDeltaBudgetMs: 125,
    maxReadStatCallsPerFile: 3,
    populatedHookKey: "1000",
    populatedHookIterations: 8,
    populatedHookAbsoluteBudgetMs: 900,
    populatedHookDeltaBudgetMs: 400,
  }),
});

const SCENARIOS = [
  {
    id: "C01-unchanged-read",
    expected: "FRESH",
    events: [
      ["seed", "src/auth.ts", "export const role = 'user';\n"],
      ["read", "src/auth.ts"],
      ["lifecycle", "UserPromptSubmit", {}, "NONE"],
      ["inspect", "src/auth.ts"],
    ],
  },
  {
    id: "C02-external-change",
    expected: "STALE_EXTERNAL",
    events: [
      ["seed", "src/auth.ts", "export const role = 'user';\n"],
      ["read", "src/auth.ts"],
      ["externalWrite", "src/auth.ts", "export const role = 'root';\n"],
      ["lifecycle", "UserPromptSubmit", {}, "STALE_EXTERNAL"],
      ["inspect", "src/auth.ts"],
    ],
  },
  {
    id: "C03-self-change",
    expected: "STALE_SELF",
    events: [
      ["seed", "src/auth.ts", "export const role = 'user';\n"],
      ["read", "src/auth.ts"],
      ["selfWrite", "src/auth.ts", "export const role = 'root';\n"],
      ["lifecycle", "UserPromptSubmit", {}, "STALE_SELF"],
      ["inspect", "src/auth.ts"],
    ],
  },
  {
    id: "C04-reread-refreshes",
    expected: "FRESH",
    events: [
      ["seed", "src/auth.ts", "export const role = 'user';\n"],
      ["read", "src/auth.ts"],
      ["externalWrite", "src/auth.ts", "export const role = 'root';\n"],
      ["lifecycle", "UserPromptSubmit", {}, "STALE_EXTERNAL"],
      ["inspect", "src/auth.ts", "STALE_EXTERNAL"],
      ["read", "src/auth.ts"],
      ["lifecycle", "UserPromptSubmit", {}, "NONE"],
      ["inspect", "src/auth.ts"],
    ],
  },
  {
    id: "C05-missing-file",
    expected: "MISSING",
    events: [
      ["seed", "src/auth.ts", "export const role = 'user';\n"],
      ["read", "src/auth.ts"],
      ["externalDelete", "src/auth.ts"],
      ["lifecycle", "UserPromptSubmit", {}, "MISSING"],
      ["inspect", "src/auth.ts"],
    ],
  },
  {
    id: "C06-resume-detects-drift",
    expected: "STALE_EXTERNAL",
    events: [
      ["seed", "src/auth.ts", "export const role = 'user';\n"],
      ["seed", "src/session.ts", "export const active = true;\n"],
      ["read", "src/auth.ts"],
      ["read", "src/session.ts"],
      ["externalWrite", "src/auth.ts", "export const role = 'root';\n"],
      ["reload"],
      ["lifecycle", "SessionStart", { source: "resume" }, "STALE_EXTERNAL"],
      ["inspect", "src/auth.ts"],
    ],
  },
  {
    id: "C07-compaction-persists-metadata",
    expected: "FRESH",
    events: [
      ["seed", "src/auth.ts", "export const role = 'user';\n"],
      ["read", "src/auth.ts"],
      ["captureMetadata", "src/auth.ts"],
      ["lifecycle", "PreCompact", { trigger: "manual" }],
      ["reload"],
      ["lifecycle", "PostCompact", { trigger: "manual" }],
      ["lifecycle", "SessionStart", { source: "compact" }, "FRESH"],
      ["assertMetadata", "src/auth.ts"],
      ["inspect", "src/auth.ts"],
    ],
  },
  {
    id: "C08-untracked-is-unknown",
    expected: "UNKNOWN",
    events: [
      ["seed", "src/unknown.ts", "export const unknown = true;\n"],
      ["inspect", "src/unknown.ts"],
    ],
  },
];

class StockAdapter {
  constructor(options) {
    this.options = options;
    this.metrics = { statCalls: 0, hashCalls: 0, bytesHashed: 0 };
  }
  recordRead() { return { state: "NO_SIGNAL" }; }
  recordSelfWrite() { return { state: "NO_SIGNAL" }; }
  inspect(file) {
    return { path: file, state: "NO_SIGNAL", snapshotHash: null, readAt: null };
  }
  checkAll() { return { files: [], summary: emptySummary(), output: null }; }
  lifecycle() { return null; }
  guardEdit() { return { blocked: false, files: [], reason: null }; }
  clear() { return { cleared: 0 }; }
}

class MetadataLoopBaseline {
  constructor() {
    this.paths = new Set();
    this.metrics = { statCalls: 0, hashCalls: 0, bytesHashed: 0 };
  }
  recordRead(filePath) { this.paths.add(path.resolve(filePath)); }
  checkAll() {
    let fresh = 0;
    for (const filePath of this.paths) {
      this.metrics.statCalls += 1;
      try {
        if (fs.statSync(filePath).isFile()) fresh += 1;
      } catch {}
    }
    const summary = emptySummary();
    summary.tracked = this.paths.size;
    summary.FRESH = fresh;
    summary.MISSING = this.paths.size - fresh;
    return { files: [], summary };
  }
}

function emptySummary() {
  return {
    tracked: 0,
    UNKNOWN: 0,
    FRESH: 0,
    STALE_SELF: 0,
    STALE_EXTERNAL: 0,
    MISSING: 0,
  };
}

function loadCandidateModules() {
  const core = require("../src/freshread-core.cjs");
  const hooks = require("../src/hook-handler.cjs");
  return {
    FreshReadEngine: core.FreshReadEngine,
    STATES: core.STATES,
    handleHookEvent: hooks.handleHookEvent,
    candidateFactory: function candidateFactory(options) {
      return new core.FreshReadEngine(options);
    },
  };
}

function writeFile(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

// Fixture determinism only: these synthetic scenarios intentionally exercise a
// metadata-observable external edit within the V0 lifecycle-scan contract.
// Advance mtime so coarse host timestamp ticks cannot hide the synthetic edit.
function writeObservableExternalMutation(target, content, previousStat) {
  const before = previousStat || fs.statSync(target);
  fs.writeFileSync(target, content);
  const observableTime = new Date(Math.max(Date.now(), before.mtimeMs) + 2000);
  fs.utimesSync(target, observableTime, observableTime);
  return target;
}

function makeOptions(root, dataDir, sessionId, enabled) {
  return {
    cwd: root,
    dataDir,
    sessionId: sessionId || "bench-session",
    enabled: enabled !== false,
  };
}

function makeHookEvent(root, sessionId, eventName, extra) {
  return Object.assign({
    session_id: sessionId,
    turn_id: "bench-turn",
    cwd: root,
    hook_event_name: eventName,
    model: "benchmark-model",
    permission_mode: "default",
  }, extra || {});
}

function runUpdatedShell(command, cwd) {
  if (process.platform === "win32") {
    const powershell = path.join(
      process.env.SystemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe"
    );
    return childProcess.spawnSync(
      powershell,
      ["-NoProfile", "-NonInteractive", "-Command", command],
      { cwd, encoding: "utf8" }
    );
  }
  return childProcess.spawnSync("/bin/sh", ["-c", command], { cwd, encoding: "utf8" });
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

function canonicalCopyMoveCommand(kind, source, destination) {
  const sourcePath = quoteShellLiteral(source);
  const destinationPath = quoteShellLiteral(destination);
  if (process.platform === "win32") {
    const commandName = kind === "shell-copy" ? "Copy-Item" : "Move-Item";
    return `${commandName} -LiteralPath ${sourcePath} -Destination ${destinationPath}`;
  }
  const commandName = kind === "shell-copy" ? "cp" : "mv";
  return `${commandName} -- ${sourcePath} ${destinationPath}`;
}

function configuredHookLauncher() {
  const hooksConfig = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "hooks", "hooks.json"), "utf8"));
  const promptHook = hooksConfig.hooks.UserPromptSubmit[0].hooks[0];
  if (process.platform === "win32") {
    return {
      executable: path.join(
        process.env.SystemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe"
      ),
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        promptHook.commandWindows,
      ],
      windowsVerbatimArguments: false,
    };
  }
  return {
    executable: "/bin/sh",
    args: ["-c", promptHook.command],
    windowsVerbatimArguments: false,
  };
}

function aggregateMetrics(adapters) {
  const result = {};
  for (const adapter of adapters) {
    for (const [key, value] of Object.entries(adapter.metrics || {})) {
      if (typeof value === "number") result[key] = (result[key] || 0) + value;
    }
  }
  return result;
}

function runScenario(adapterFactory, scenario) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "freshread-bench-"));
  const dataDir = path.join(tempRoot, ".state");
  let adapter = adapterFactory(makeOptions(tempRoot, dataDir, "bench-session", true));
  const adapters = [adapter];
  let observed = null;
  let capturedMetadata = null;
  const checkpoints = [];
  const signals = [];
  const metadataChecks = [];
  try {
    for (const event of scenario.events) {
      const op = event[0];
      const relativePath = event[1];
      const value = event[2];
      const expectedSignal = event[3];
      const target = relativePath && !["SessionStart", "PreCompact", "PostCompact", "UserPromptSubmit"].includes(relativePath)
        ? path.join(tempRoot, relativePath)
        : null;
      switch (op) {
        case "seed":
          writeFile(tempRoot, relativePath, value);
          break;
        case "externalWrite":
          writeObservableExternalMutation(target, value);
          break;
        case "externalDelete":
          fs.unlinkSync(target);
          break;
        case "read":
          adapter.recordRead(target, { toolName: "benchmark" });
          break;
        case "selfWrite":
          writeFile(tempRoot, relativePath, value);
          adapter.recordSelfWrite(target, { toolUseId: "bench-" + scenario.id });
          break;
        case "inspect":
          observed = adapter.inspect(target);
          checkpoints.push({ expected: value || scenario.expected, observed: observed.state });
          break;
        case "captureMetadata": {
          const result = adapter.inspect(target, { forceHash: true });
          capturedMetadata = { snapshotHash: result.snapshotHash || null, readAt: result.readAt || null };
          break;
        }
        case "assertMetadata": {
          const result = adapter.inspect(target, { forceHash: true });
          const passed = Boolean(
            capturedMetadata &&
            capturedMetadata.snapshotHash &&
            capturedMetadata.readAt &&
            result.snapshotHash === capturedMetadata.snapshotHash &&
            result.readAt === capturedMetadata.readAt
          );
          metadataChecks.push({
            expected: "snapshotHash and readAt preserved",
            observed: passed ? "PRESERVED" : "NOT_PRESERVED",
            passed,
          });
          break;
        }
        case "reload":
          adapter = adapterFactory(makeOptions(tempRoot, dataDir, "bench-session", true));
          adapters.push(adapter);
          break;
        case "lifecycle": {
          const output = adapter.lifecycle(relativePath, value || {});
          if (expectedSignal) {
            const text = output ? JSON.stringify(output) : "";
            const passed = expectedSignal === "NONE" ? !output : text.includes(expectedSignal);
            const matchedState = POSITIVE_STATES.has(expectedSignal) && text.includes(expectedSignal)
              ? expectedSignal
              : [...EXPECTED_STATES].find(function findState(state) { return text.includes(state); });
            signals.push({
              event: relativePath,
              expected: expectedSignal,
              observed: output ? "CONTEXT" + (matchedState ? ":" + matchedState : "") : "NONE",
              passed,
            });
          }
          break;
        }
        default:
          throw new Error("Unknown benchmark operation: " + op);
      }
    }
    return {
      id: scenario.id,
      expected: scenario.expected,
      observed: observed ? observed.state : "NO_SIGNAL",
      checkpoints,
      signals,
      metadataChecks,
      metrics: aggregateMetrics(adapters),
      passed:
        checkpoints.every(function checkpointPassed(item) { return item.observed === item.expected; }) &&
        signals.every(function signalPassed(item) { return item.passed; }) &&
        metadataChecks.every(function metadataPassed(item) { return item.passed; }),
    };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function scenarioIntegrity() {
  const actual = SCENARIOS.map(function scenarioId(item) { return item.id; });
  const passed =
    actual.length === EXPECTED_CASE_IDS.length &&
    actual.every(function sameId(id, index) { return id === EXPECTED_CASE_IDS[index]; });
  return { expected: [...EXPECTED_CASE_IDS], actual, passed };
}

function summarize(name, results, guardSummary) {
  let positives = 0;
  let detected = 0;
  let freshChecks = 0;
  let freshWarnings = 0;
  let unknownAsFresh = 0;
  let checkpointCount = 0;
  let exactCheckpoints = 0;
  const resultById = new Map(results.map(function keyed(result) { return [result.id, result]; }));
  for (const result of results) {
    for (const checkpoint of result.checkpoints) {
      checkpointCount += 1;
      if (checkpoint.observed === checkpoint.expected) exactCheckpoints += 1;
      if (checkpoint.expected === "UNKNOWN" && checkpoint.observed === "FRESH") unknownAsFresh += 1;
    }
    for (const signal of result.signals) {
      if (POSITIVE_STATES.has(signal.expected)) {
        positives += 1;
        if (signal.passed) detected += 1;
      }
      if (signal.expected === "NONE") {
        freshChecks += 1;
        if (signal.observed !== "NONE") freshWarnings += 1;
      }
    }
  }
  return {
    name,
    requiredCasesPassed: EXPECTED_CASE_IDS.filter(function expectedPassed(id) {
      const result = resultById.get(id);
      return Boolean(result && result.passed);
    }).length,
    requiredCasesTotal: EXPECTED_CASE_IDS.length,
    exactAccuracy: checkpointCount ? exactCheckpoints / checkpointCount : 0,
    staleMissingRecall: positives ? detected / positives : 0,
    freshFalsePositiveRate: freshChecks ? freshWarnings / freshChecks : 0,
    unknownAsFreshCount: unknownAsFresh,
    preEditGuardRate: guardSummary ? guardSummary.guardRate : 0,
  };
}

function runOutcomeWorkflow(adapterFactory, armName) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "freshread-outcome-"));
  const dataDir = path.join(tempRoot, ".state");
  const target = writeFile(
    tempRoot,
    "src/auth.ts",
    "// BASE_VERSION=A\nexport const role = 'user';\n"
  );
  const adapter = adapterFactory(makeOptions(tempRoot, dataDir, "outcome-session", true));
  const requestedMarker = "export const auditEnabled = true;";
  const userMarker = "// USER_KEEP: role migrated externally";
  try {
    const remembered = fs.readFileSync(target, "utf8");
    adapter.recordRead(target, { toolName: "outcome-workflow" });
    writeObservableExternalMutation(
      target,
      "// BASE_VERSION=B\n" + userMarker + "\nexport const role = 'root';\n"
    );
    const signal = adapter.lifecycle("UserPromptSubmit", { prompt: "continue the edit" });
    const guard = adapter.guardEdit([target]);
    const rereadBeforeEdit = Boolean(signal) || Boolean(guard.blocked);
    let editBase = remembered;
    if (rereadBeforeEdit) {
      editBase = fs.readFileSync(target, "utf8");
      adapter.recordRead(target, { toolName: "outcome-reread" });
    }
    const finalBody = editBase.replace(/\s*$/, "\n") + requestedMarker + "\n";
    fs.writeFileSync(target, finalBody);
    adapter.recordSelfWrite(target, { toolUseId: "outcome-write" });
    const taskOutcome = finalBody.includes(requestedMarker);
    const userModificationPreserved =
      finalBody.includes(userMarker) &&
      finalBody.includes("export const role = 'root';");
    return {
      arm: armName,
      taskOutcome,
      userModificationPreserved,
      taskSuccess: taskOutcome && userModificationPreserved,
      rereadBeforeEdit,
      unsafeStaleEdit: !rereadBeforeEdit,
      staleSignalObserved: Boolean(signal),
      guardBlocked: Boolean(guard.blocked),
      finalSha256: crypto.createHash("sha256").update(finalBody).digest("hex"),
    };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function outputDenied(output) {
  return Boolean(
    output &&
    output.hookSpecificOutput &&
    output.hookSpecificOutput.permissionDecision === "deny"
  );
}

function runCoreGuardCase(adapterFactory, armName, kind) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "freshread-guard-core-"));
  const dataDir = path.join(tempRoot, ".state");
  const adapter = adapterFactory(makeOptions(tempRoot, dataDir, "guard-" + kind, true));
  const expectedBlocked = armName === "freshread";
  try {
    const first = writeFile(tempRoot, "src/first.ts", "A\n");
    const second = writeFile(tempRoot, "src/second.ts", "A\n");
    adapter.recordRead(first, { toolName: "guard-matrix" });
    if (kind === "missing") fs.unlinkSync(first);
    else writeObservableExternalMutation(first, "B\n");
    if (kind === "multi-target") adapter.recordRead(second, { toolName: "guard-matrix" });
    const targets = kind === "multi-target" ? [first, second] : [first];
    const result = adapter.guardEdit(targets);
    return {
      id: kind + "-core",
      level: "core",
      expectedBlocked,
      blocked: Boolean(result.blocked),
      states: (result.files || []).map(function stateOf(item) { return item.state; }),
      passed: Boolean(result.blocked) === expectedBlocked,
    };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function runHandlerGuardCase(modules, adapterFactory, armName, kind) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "freshread-guard-handler-"));
  const dataDir = path.join(tempRoot, ".state");
  const sessionId = "handler-" + kind;
  const adapter = adapterFactory(makeOptions(tempRoot, dataDir, sessionId, true));
  const expectedBlocked = armName === "freshread";
  try {
    const source = writeFile(tempRoot, "src/source.ts", "source\n");
    const destination = writeFile(tempRoot, "src/destination.ts", "A\n");
    adapter.recordRead(destination, { toolName: "guard-matrix" });
    writeObservableExternalMutation(destination, "B\n");
    let event;
    if (kind === "apply-patch") {
      event = makeHookEvent(tempRoot, sessionId, "PreToolUse", {
        tool_name: "apply_patch",
        tool_use_id: "guard-apply-patch",
        tool_input: {
          command: "*** Begin Patch\n*** Update File: src/destination.ts\n*** End Patch",
        },
      });
    } else {
      event = makeHookEvent(tempRoot, sessionId, "PreToolUse", {
        tool_name: "Bash",
        tool_use_id: "guard-" + kind,
        tool_input: {
          command: canonicalCopyMoveCommand(kind, source, destination),
        },
      });
    }
    const output = armName === "freshread"
      ? modules.handleHookEvent(event, { dataDir })
      : null;
    const blocked = outputDenied(output);
    return {
      id: kind + "-handler",
      level: "handler",
      expectedBlocked,
      blocked,
      reasonContainsStale:
        blocked &&
        String(output.hookSpecificOutput.permissionDecisionReason || "").includes("STALE_EXTERNAL"),
      passed:
        blocked === expectedBlocked &&
        (!expectedBlocked || String(output.hookSpecificOutput.permissionDecisionReason || "").includes("STALE_EXTERNAL")),
    };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function runGuardMatrix(modules, adapterFactory, armName) {
  const cases = [
    runCoreGuardCase(adapterFactory, armName, "stale-external"),
    runCoreGuardCase(adapterFactory, armName, "missing"),
    runCoreGuardCase(adapterFactory, armName, "multi-target"),
    runHandlerGuardCase(modules, adapterFactory, armName, "apply-patch"),
    runHandlerGuardCase(modules, adapterFactory, armName, "shell-copy"),
    runHandlerGuardCase(modules, adapterFactory, armName, "shell-move"),
  ];
  const guarded = cases.filter(function expected(item) { return item.expectedBlocked; });
  return {
    cases,
    passed: cases.every(function casePassed(item) { return item.passed; }),
    guardRate: guarded.length
      ? guarded.filter(function blocked(item) { return item.blocked; }).length / guarded.length
      : 0,
  };
}

function runHandlerProtocolMatrix(modules) {
  const results = [];
  function runSignalCase(id, eventName, payload, expectedState) {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "freshread-handler-signal-"));
    const dataDir = path.join(tempRoot, ".state");
    const sessionId = "signal-" + id;
    const target = writeFile(tempRoot, "src/auth.ts", "A\n");
    try {
      const engine = new modules.FreshReadEngine(makeOptions(tempRoot, dataDir, sessionId, true));
      engine.recordRead(target, { toolName: "handler-signal" });
      if (expectedState === "STALE_EXTERNAL") writeObservableExternalMutation(target, "B\n");
      const event = makeHookEvent(tempRoot, sessionId, eventName, payload);
      const output = modules.handleHookEvent(event, { dataDir });
      const text = output ? JSON.stringify(output) : "";
      results.push({
        id,
        expected: expectedState,
        observed: output ? "CONTEXT" : "NONE",
        passed: text.includes(expectedState),
      });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }
  runSignalCase("user-prompt-stale-signal", "UserPromptSubmit", { prompt: "continue" }, "STALE_EXTERNAL");
  runSignalCase("resume-stale-signal", "SessionStart", { source: "resume" }, "STALE_EXTERNAL");
  runSignalCase("compact-fresh-metadata-signal", "SessionStart", { source: "compact" }, "FRESH");

  {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "freshread-handler-read-"));
    const dataDir = path.join(tempRoot, ".state");
    const sessionId = "handler-observed-read";
    const target = writeFile(tempRoot, "src/auth.ts", "A\n");
    let caseResult;
    try {
      const observedCommand = canonicalReadCommand(target);
      const preEvent = makeHookEvent(tempRoot, sessionId, "PreToolUse", {
        tool_name: "Bash",
        tool_use_id: "handler-observed-read",
        tool_input: { command: observedCommand },
      });
      const preOutput = modules.handleHookEvent(preEvent, { dataDir });
      const execution = runUpdatedShell(preEvent.tool_input.command, tempRoot);
      const postEvent = makeHookEvent(tempRoot, sessionId, "PostToolUse", {
        tool_name: "Bash",
        tool_use_id: "handler-observed-read",
        tool_input: preEvent.tool_input,
        tool_response: execution.stdout,
      });
      const postOutput = execution.status === 0
        ? modules.handleHookEvent(postEvent, { dataDir })
        : null;
      const state = new modules.FreshReadEngine(
        makeOptions(tempRoot, dataDir, sessionId, true)
      ).inspect(target).state;
      caseResult = {
        id: "observed-pre-post-read-protocol",
        expected: "FRESH",
        observed: state,
        executionStatus: execution.status,
        postWarning: Boolean(postOutput),
        commandPreserved: preEvent.tool_input.command === observedCommand &&
          !Boolean(preOutput && preOutput.hookSpecificOutput && preOutput.hookSpecificOutput.updatedInput),
        passed: !preOutput && execution.status === 0 && !postOutput && state === "FRESH",
      };
    } catch (error) {
      caseResult = {
        id: "observed-pre-post-read-protocol",
        expected: "FRESH",
        observed: "ERROR",
        detail: error.message,
        passed: false,
      };
    } finally {
      results.push(caseResult);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }

  const hooksPath = path.resolve(__dirname, "..", "hooks", "hooks.json");
  let configPassed = false;
  let configDetail = null;
  try {
    const config = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
    const expectedEvents = [
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "PreCompact",
      "PostCompact",
    ];
    configPassed =
      expectedEvents.every(function hasEvent(name) { return Array.isArray(config.hooks[name]); }) &&
      JSON.stringify(config.hooks.PreToolUse).includes("apply_patch") &&
      JSON.stringify(config.hooks.PostToolUse).includes("Bash") &&
      (
        JSON.stringify(config).includes("freshread-hook.cjs") ||
        JSON.stringify(config).includes("freshread-launch")
      );
  } catch (error) {
    configDetail = error.message;
  }
  results.push({
    id: "hooks-config-contract",
    expected: "valid six-boundary config",
    observed: configPassed ? "VALID" : "INVALID",
    detail: configDetail,
    passed: configPassed,
  });
  return {
    evidenceLevel: "synthetic-handler",
    cases: results,
    passed: results.every(function handlerPassed(item) { return item.passed; }),
  };
}

function runSecurityMatrix(modules) {
  const results = [];
  {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "freshread-security-failed-read-"));
    const dataDir = path.join(tempRoot, ".state");
    const sessionId = "security-failed-read";
    const target = writeFile(tempRoot, "src/auth.ts", "A\n");
    try {
      modules.handleHookEvent(makeHookEvent(tempRoot, sessionId, "PostToolUse", {
        tool_name: "Bash",
        tool_input: { command: canonicalReadCommand(target) },
        tool_response: { exit_code: 1, output: "failed" },
      }), { dataDir });
      const state = new modules.FreshReadEngine(makeOptions(tempRoot, dataDir, sessionId, true)).inspect(target).state;
      results.push({
        id: "failed-read-never-fresh",
        expected: "UNKNOWN",
        observed: state,
        passed: state === "UNKNOWN",
      });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }
  {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "freshread-security-read-race-"));
    const dataDir = path.join(tempRoot, ".state");
    const sessionId = "security-read-race";
    const target = writeFile(tempRoot, "src/auth.ts", "A\n");
    let caseResult;
    try {
      const preEvent = makeHookEvent(tempRoot, sessionId, "PreToolUse", {
        tool_name: "Bash",
        tool_use_id: "security-read-race",
        tool_input: { command: canonicalReadCommand(target) },
      });
      const preOutput = modules.handleHookEvent(preEvent, { dataDir });
      const execution = runUpdatedShell(preEvent.tool_input.command, tempRoot);
      if (execution.status === 0) writeObservableExternalMutation(target, "B\n");
      const warning = execution.status === 0
        ? modules.handleHookEvent(makeHookEvent(tempRoot, sessionId, "PostToolUse", {
            tool_name: "Bash",
            tool_use_id: "security-read-race",
            tool_input: preEvent.tool_input,
            tool_response: execution.stdout,
          }), { dataDir })
        : null;
      const state = new modules.FreshReadEngine(
        makeOptions(tempRoot, dataDir, sessionId, true)
      ).inspect(target, { forceHash: true }).state;
      const warningText = warning ? JSON.stringify(warning) : "";
      caseResult = {
        id: "read-posttool-race-never-fresh",
        expected: "UNKNOWN (never FRESH)",
        observed: state,
        warningObserved: Boolean(warning),
        warningNamesRisk:
          /not recorded|non-fresh/i.test(warningText),
        passed:
          !preOutput &&
          execution.status === 0 &&
          Boolean(warning) &&
          /not recorded|non-fresh/i.test(warningText) &&
          state === "UNKNOWN",
      };
    } catch (error) {
      caseResult = {
        id: "read-posttool-race-never-fresh",
        expected: "UNKNOWN (never FRESH)",
        observed: "ERROR",
        detail: error.message,
        passed: false,
      };
    } finally {
      results.push(caseResult);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }
  {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "freshread-security-corrupt-"));
    const dataDir = path.join(tempRoot, ".state");
    const sessionId = "security-corrupt";
    const target = writeFile(tempRoot, "src/auth.ts", "A\n");
    try {
      const engine = new modules.FreshReadEngine(makeOptions(tempRoot, dataDir, sessionId, true));
      engine.recordRead(target);
      fs.writeFileSync(engine.statePath, "{broken");
      const output = modules.handleHookEvent(makeHookEvent(tempRoot, sessionId, "PreToolUse", {
        tool_name: "apply_patch",
        tool_input: {
          command: "*** Begin Patch\n*** Update File: src/auth.ts\n*** End Patch",
        },
      }), { dataDir });
      results.push({
        id: "corrupt-state-fails-closed",
        expected: "DENY",
        observed: outputDenied(output) ? "DENY" : "ALLOW",
        passed: outputDenied(output),
      });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }
  {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "freshread-security-scope-"));
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "freshread-security-outside-"));
    const dataDir = path.join(tempRoot, ".state");
    const outside = writeFile(outsideRoot, "outside.ts", "outside\n");
    try {
      const engine = new modules.FreshReadEngine(makeOptions(tempRoot, dataDir, "security-scope", true));
      const state = engine.recordRead(outside).state;
      results.push({
        id: "outside-workspace-never-tracked-fresh",
        expected: "UNKNOWN",
        observed: state,
        passed: state === "UNKNOWN" && engine.checkAll().summary.tracked === 0,
      });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  }
  {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "freshread-security-content-"));
    const dataDir = path.join(tempRoot, ".state");
    const marker = "SOURCE_CONTENT_MUST_NOT_PERSIST_8f423";
    const target = writeFile(tempRoot, "src/secret.ts", marker + "\n");
    try {
      const engine = new modules.FreshReadEngine(makeOptions(tempRoot, dataDir, "security-content", true));
      engine.recordRead(target);
      const persisted = fs.readFileSync(engine.statePath, "utf8");
      results.push({
        id: "state-does-not-store-source-content",
        expected: "NO_SOURCE_BODY",
        observed: persisted.includes(marker) ? "SOURCE_BODY_FOUND" : "NO_SOURCE_BODY",
        passed: !persisted.includes(marker),
      });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }
  return {
    cases: results,
    passed: results.every(function securityPassed(item) { return item.passed; }),
  };
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort(function numeric(a, b) { return a - b; });
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

function evaluateLatencyGate(baselineP95Ms, freshreadP95Ms, absoluteBudgetMs, deltaBudgetMs) {
  const p95DeltaMs = freshreadP95Ms - baselineP95Ms;
  const absolutePassed = freshreadP95Ms <= absoluteBudgetMs;
  const deltaPassed = p95DeltaMs <= deltaBudgetMs;
  return {
    p95DeltaMs,
    // Retained as a compatibility alias for consumers of schemaVersion 3.
    p95BudgetMs: absoluteBudgetMs,
    p95AbsoluteBudgetMs: absoluteBudgetMs,
    p95DeltaBudgetMs: deltaBudgetMs,
    absolutePassed,
    deltaPassed,
    passed: absolutePassed && deltaPassed,
  };
}

function evaluatePairedLatencyGate(freshreadP95Ms, pairedDeltasMs, absoluteBudgetMs, deltaBudgetMs) {
  const pairedDeltaP50Ms = percentile(pairedDeltasMs, 0.5);
  const pairedDeltaP95Ms = percentile(pairedDeltasMs, 0.95);
  const pairedDeltaP99Ms = percentile(pairedDeltasMs, 0.99);
  const absolutePassed = freshreadP95Ms <= absoluteBudgetMs;
  const deltaPassed = pairedDeltaP95Ms <= deltaBudgetMs;
  return {
    // Compatibility alias: for the cold gate this is now the paired delta p95.
    p95DeltaMs: pairedDeltaP95Ms,
    p95BudgetMs: absoluteBudgetMs,
    p95AbsoluteBudgetMs: absoluteBudgetMs,
    p95DeltaBudgetMs: deltaBudgetMs,
    deltaMethod: "paired-freshread-minus-baseline",
    pairedDeltaP50Ms,
    pairedDeltaP95Ms,
    pairedDeltaP99Ms,
    absolutePassed,
    deltaPassed,
    passed: absolutePassed && deltaPassed,
  };
}

function runPerformance(adapterFactory, fileCount, iterations, options = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "freshread-perf-"));
  const dataDir = path.join(tempRoot, ".state");
  const sessionId = "perf-" + fileCount;
  const adapter = adapterFactory(makeOptions(tempRoot, dataDir, sessionId, true));
  const paths = [];
  try {
    for (let index = 0; index < fileCount; index += 1) {
      const target = writeFile(tempRoot, "src/file-" + index + ".ts", "export const n = " + index + ";\n");
      paths.push(target);
    }
    const tailCount = Math.max(1, Math.min(fileCount, Number(options.readTailSampleCount) || 1));
    const tailReadSamples = [];
    const readPhaseStarted = performance.now();
    for (let index = 0; index < paths.length; index += 1) {
      const sampleThisRead = index >= paths.length - tailCount;
      const readStarted = sampleThisRead ? performance.now() : 0;
      const target = paths[index];
      adapter.recordRead(target, { toolName: "benchmark-performance" });
      if (sampleThisRead) tailReadSamples.push(performance.now() - readStarted);
    }
    const readPhaseDurationMs = performance.now() - readPhaseStarted;
    const readPhaseMetrics = {
      statCalls: adapter.metrics.statCalls || 0,
      hashCalls: adapter.metrics.hashCalls || 0,
      bytesHashed: adapter.metrics.bytesHashed || 0,
      stateReads: adapter.metrics.stateReads || 0,
      stateWrites: adapter.metrics.stateWrites || 0,
    };
    const beforeHashes = adapter.metrics.hashCalls || 0;
    const samples = [];
    for (let index = 0; index < iterations; index += 1) {
      const started = performance.now();
      adapter.checkAll();
      samples.push(performance.now() - started);
    }
    const finalReport = adapter.checkAll();
    const populatedHookSpawn = Number(options.populatedHookIterations) > 0
      ? runPopulatedHookSpawn(tempRoot, dataDir, sessionId, Number(options.populatedHookIterations), fileCount)
      : null;
    return {
      seededFiles: paths.length,
      trackedFiles: finalReport.summary.tracked,
      iterations: samples.length,
      p50Ms: percentile(samples, 0.5),
      p95Ms: percentile(samples, 0.95),
      p99Ms: percentile(samples, 0.99),
      unchangedCheckpointHashCalls: (adapter.metrics.hashCalls || 0) - beforeHashes,
      statCalls: adapter.metrics.statCalls || 0,
      bytesHashed: adapter.metrics.bytesHashed || 0,
      readPhaseDurationMs,
      nthReadMs: tailReadSamples[tailReadSamples.length - 1],
      nearNthReadSampleCount: tailReadSamples.length,
      nearNthReadP95Ms: percentile(tailReadSamples, 0.95),
      readPhaseStatCalls: readPhaseMetrics.statCalls,
      readPhaseHashCalls: readPhaseMetrics.hashCalls,
      readPhaseBytesHashed: readPhaseMetrics.bytesHashed,
      readPhaseStateReads: readPhaseMetrics.stateReads,
      readPhaseStateWrites: readPhaseMetrics.stateWrites,
      populatedHookSpawn,
    };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function runHookInvocation(launcher, tempRoot, dataDir, event, enabled, pluginRoot) {
  const started = performance.now();
  const result = childProcess.spawnSync(launcher.executable, launcher.args, {
    cwd: tempRoot,
    input: JSON.stringify(event),
    encoding: "utf8",
    env: Object.assign({}, process.env, {
      PLUGIN_ROOT: pluginRoot,
      PLUGIN_DATA: dataDir,
      FRESHREAD_TEST_MODE: "1",
      FRESHREAD_DATA_DIR: dataDir,
      FRESHREAD_ENABLED: enabled ? "1" : "0",
    }),
    windowsVerbatimArguments: launcher.windowsVerbatimArguments,
  });
  return {
    elapsedMs: performance.now() - started,
    status: result.status,
    signal: result.signal || null,
    stderr: String(result.stderr || result.error && result.error.message || "").trim(),
  };
}

function summarizeHookInvocations(enabled, invocations) {
  const samples = invocations.map(function elapsed(item) { return item.elapsedMs; });
  return {
    enabled,
    iterations: samples.length,
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    p99Ms: percentile(samples, 0.99),
    failures: invocations
      .filter(function failed(item) { return item.status !== 0; })
      .map(function publicFailure(item) {
        return { status: item.status, signal: item.signal, stderr: item.stderr };
      }),
  };
}

function runPopulatedHookSpawn(tempRoot, dataDir, sessionId, iterations, fileCount) {
  const launcher = configuredHookLauncher();
  const pluginRoot = fs.realpathSync.native(path.resolve(__dirname, ".."));
  const event = makeHookEvent(tempRoot, sessionId, "UserPromptSubmit", { prompt: "continue" });
  const arms = { baseline: [], freshread: [] };
  for (let index = 0; index < iterations; index += 1) {
    const order = index % 2 === 0 ? [false, true] : [true, false];
    for (const enabled of order) {
      const result = runHookInvocation(launcher, tempRoot, dataDir, event, enabled, pluginRoot);
      arms[enabled ? "freshread" : "baseline"].push(result);
    }
  }
  return {
    fileCount,
    order: "interleaved-and-alternating",
    baseline: summarizeHookInvocations(false, arms.baseline),
    freshread: summarizeHookInvocations(true, arms.freshread),
  };
}

function publicHookInvocation(invocation) {
  return {
    durationMs: invocation.elapsedMs,
    status: invocation.status,
    signal: invocation.signal,
  };
}

function runColdHookSpawn(iterations) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "freshread-cold-hook-"));
  const dataDir = path.join(tempRoot, ".state");
  const launcher = configuredHookLauncher();
  const event = makeHookEvent(tempRoot, "cold-hook-session", "UserPromptSubmit", { prompt: "continue" });
  const pluginRoot = fs.realpathSync.native(path.resolve(__dirname, ".."));
  const arms = { baseline: [], freshread: [] };
  const pairs = [];
  try {
    for (let index = 0; index < iterations; index += 1) {
      const enabledOrder = index % 2 === 0 ? [false, true] : [true, false];
      const pair = {
        pairIndex: index,
        order: enabledOrder.map(function armName(enabled) { return enabled ? "freshread" : "baseline"; }),
        baseline: null,
        freshread: null,
        deltaMs: null,
      };
      for (const enabled of enabledOrder) {
        const arm = enabled ? "freshread" : "baseline";
        const invocation = runHookInvocation(launcher, tempRoot, dataDir, event, enabled, pluginRoot);
        arms[arm].push(invocation);
        pair[arm] = publicHookInvocation(invocation);
      }
      pair.deltaMs = pair.freshread.durationMs - pair.baseline.durationMs;
      pairs.push(pair);
    }
    return {
      order: "paired-interleaved-and-alternating-ab-ba",
      iterationsPerArm: iterations,
      baseline: summarizeHookInvocations(false, arms.baseline),
      freshread: summarizeHookInvocations(true, arms.freshread),
      pairs,
    };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function runColdHookGate(profile) {
  if (profile.coldHookIterations > 0) {
    const raw = runColdHookSpawn(profile.coldHookIterations);
    const latency = evaluatePairedLatencyGate(
      raw.freshread.p95Ms,
      raw.pairs.map(function pairedDelta(pair) { return pair.deltaMs; }),
      profile.coldHookAbsoluteBudgetMs,
      profile.coldHookDeltaBudgetMs,
    );
    return Object.assign({}, latency, raw, {
      required: true,
      status: "RUN",
      passed:
        latency.passed &&
        raw.baseline.failures.length === 0 &&
        raw.freshread.failures.length === 0,
    });
  }

  const skipped = {
    enabled: null,
    iterations: 0,
    p50Ms: null,
    p95Ms: null,
    p99Ms: null,
    failures: [],
  };
  return {
    required: false,
    status: "SKIPPED_QUICK_PROFILE",
    order: null,
    iterationsPerArm: 0,
    pairs: [],
    baseline: Object.assign({}, skipped, { enabled: false }),
    freshread: Object.assign({}, skipped, { enabled: true }),
    p95DeltaMs: null,
    p95BudgetMs: null,
    p95AbsoluteBudgetMs: null,
    p95DeltaBudgetMs: null,
    deltaMethod: "paired-freshread-minus-baseline",
    pairedDeltaP50Ms: null,
    pairedDeltaP95Ms: null,
    pairedDeltaP99Ms: null,
    absolutePassed: null,
    deltaPassed: null,
    passed: true,
  };
}

function runPerformanceSuite(candidateFactory, profile) {
  // Empty-state process-startup latency is measured before the high-churn
  // 100/1000-file workloads. Those workloads intentionally create and rewrite
  // growing state files; running the cold gate afterward would mix startup with
  // order-dependent host resource pressure and background work. The gate still
  // retains all 20 AB/BA pairs and both latency budgets.
  const cold = runColdHookGate(profile);
  const cases = profile.performanceCases;
  const baseline = {};
  const freshread = {};
  const comparisons = {};
  for (const item of cases) {
    const key = item.key;
    baseline[key] = runPerformance(function makeBaseline() {
      return new MetadataLoopBaseline();
    }, item.files, item.iterations, { readTailSampleCount: profile.readTailSampleCount });
    freshread[key] = runPerformance(candidateFactory, item.files, item.iterations, {
      readTailSampleCount: profile.readTailSampleCount,
      populatedHookIterations: key === profile.populatedHookKey ? profile.populatedHookIterations : 0,
    });
    const latency = evaluateLatencyGate(
      baseline[key].p95Ms,
      freshread[key].p95Ms,
      item.absoluteBudgetMs,
      item.deltaBudgetMs,
    );
    const trackedWorkloadMatched =
      baseline[key].trackedFiles === item.files &&
      freshread[key].trackedFiles === item.files;
    comparisons[key] = Object.assign({}, latency, {
      trackedWorkloadMatched,
      unchangedCheckpointHashPassed: freshread[key].unchangedCheckpointHashCalls === 0,
      passed:
        latency.passed &&
        trackedWorkloadMatched &&
        freshread[key].unchangedCheckpointHashCalls === 0,
    });
  }

  const growthBaseline = baseline[profile.readGrowthKey];
  const growthFreshRead = freshread[profile.readGrowthKey];
  const nthReadLatency = evaluateLatencyGate(
    growthBaseline.nthReadMs,
    growthFreshRead.nthReadMs,
    profile.nthReadAbsoluteBudgetMs,
    profile.nthReadDeltaBudgetMs,
  );
  const nearNthReadLatency = evaluateLatencyGate(
    growthBaseline.nearNthReadP95Ms,
    growthFreshRead.nearNthReadP95Ms,
    profile.nthReadAbsoluteBudgetMs,
    profile.nthReadDeltaBudgetMs,
  );
  const maxReadPhaseStatCalls = growthFreshRead.seededFiles * profile.maxReadStatCallsPerFile;
  const linearWorkPassed =
    growthFreshRead.readPhaseStatCalls <= maxReadPhaseStatCalls &&
    growthFreshRead.readPhaseHashCalls === growthFreshRead.seededFiles &&
    growthFreshRead.readPhaseStateReads <= growthFreshRead.seededFiles &&
    growthFreshRead.readPhaseStateWrites <= growthFreshRead.seededFiles;
  const readGrowth = {
    required: true,
    status: "RUN",
    key: profile.readGrowthKey,
    files: growthFreshRead.seededFiles,
    baseline: {
      nthReadMs: growthBaseline.nthReadMs,
      nearNthReadP95Ms: growthBaseline.nearNthReadP95Ms,
      readPhaseDurationMs: growthBaseline.readPhaseDurationMs,
      readPhaseStatCalls: growthBaseline.readPhaseStatCalls,
    },
    freshread: {
      nthReadMs: growthFreshRead.nthReadMs,
      nearNthReadP95Ms: growthFreshRead.nearNthReadP95Ms,
      nearNthReadSampleCount: growthFreshRead.nearNthReadSampleCount,
      readPhaseDurationMs: growthFreshRead.readPhaseDurationMs,
      readPhaseStatCalls: growthFreshRead.readPhaseStatCalls,
      readPhaseHashCalls: growthFreshRead.readPhaseHashCalls,
      readPhaseStateReads: growthFreshRead.readPhaseStateReads,
      readPhaseStateWrites: growthFreshRead.readPhaseStateWrites,
    },
    nthReadLatency,
    nearNthReadLatency,
    maxReadPhaseStatCalls,
    maxReadStatCallsPerFile: profile.maxReadStatCallsPerFile,
    linearWorkPassed,
    passed: nthReadLatency.passed && nearNthReadLatency.passed && linearWorkPassed,
  };

  let populated;
  if (profile.populatedHookIterations > 0) {
    const raw = freshread[profile.populatedHookKey].populatedHookSpawn;
    const latency = evaluateLatencyGate(
      raw.baseline.p95Ms,
      raw.freshread.p95Ms,
      profile.populatedHookAbsoluteBudgetMs,
      profile.populatedHookDeltaBudgetMs,
    );
    populated = Object.assign({}, latency, raw, {
      required: true,
      status: "RUN",
      passed:
        latency.passed &&
        raw.baseline.failures.length === 0 &&
        raw.freshread.failures.length === 0,
    });
  } else {
    const skipped = {
      enabled: null,
      iterations: 0,
      p50Ms: null,
      p95Ms: null,
      p99Ms: null,
      failures: [],
    };
    populated = {
      required: false,
      status: "SKIPPED_QUICK_PROFILE",
      fileCount: null,
      order: null,
      baseline: Object.assign({}, skipped, { enabled: false }),
      freshread: Object.assign({}, skipped, { enabled: true }),
      p95DeltaMs: null,
      p95BudgetMs: null,
      p95AbsoluteBudgetMs: null,
      p95DeltaBudgetMs: null,
      absolutePassed: null,
      deltaPassed: null,
      passed: true,
    };
  }
  return {
    profile: profile.name,
    primaryKey: cases[0].key,
    baseline,
    freshread,
    comparisons,
    readGrowth,
    coldHookSpawn: cold,
    populatedHookSpawn: populated,
    passed:
      Object.values(comparisons).every(function perfPassed(item) { return item.passed; }) &&
      readGrowth.passed &&
      (!cold.required || cold.passed) &&
      (!populated.required || populated.passed),
  };
}

function sourceTreeSha256(pluginRoot) {
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(pluginRoot, absolute).split(path.sep).join("/");
      if (
        relative === ".git" ||
        relative.startsWith(".git/") ||
        relative === "node_modules" ||
        relative.startsWith("node_modules/") ||
        relative === "benchmarks/results" ||
        relative.startsWith("benchmarks/results/")
      ) continue;
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push({ absolute, relative });
    }
  }
  visit(pluginRoot);
  files.sort(function byRelative(a, b) { return a.relative.localeCompare(b.relative); });
  const digest = crypto.createHash("sha256");
  for (const file of files) {
    const contents = fs.readFileSync(file.absolute);
    digest.update(file.relative);
    digest.update("\0");
    digest.update(String(contents.length));
    digest.update("\0");
    digest.update(contents);
    digest.update("\0");
  }
  return {
    algorithm: "SHA-256",
    digest: digest.digest("hex"),
    fileCount: files.length,
    excludes: ["node_modules/**", ".git/**", "benchmarks/results/**"],
  };
}

function gateResult(passed, evidence, violations) {
  return { passed: Boolean(passed), evidence, violations: violations || [] };
}

function resolveBenchmarkProfile(options) {
  const key = options && options.profile ? options.profile : "quick";
  const profile = BENCHMARK_PROFILES[key];
  if (!profile) throw new Error("Unknown benchmark profile: " + key);
  return profile;
}

function runSuite(options) {
  const baselineOnly = Boolean(options && options.baselineOnly);
  const profile = resolveBenchmarkProfile(options);
  const integrity = scenarioIntegrity();
  const stockFactory = function stockFactory(engineOptions) {
    return new StockAdapter(engineOptions);
  };
  const stockResults = SCENARIOS.map(function runStock(scenario) {
    return runScenario(stockFactory, scenario);
  });
  const stockOutcome = runOutcomeWorkflow(stockFactory, "stock/no-plugin");
  const report = {
    schemaVersion: 3,
    generatedAt: new Date().toISOString(),
    sourceTree: sourceTreeSha256(path.resolve(__dirname, "..")),
    environment: { platform: process.platform, arch: process.arch, node: process.version },
    executionProfile: {
      name: profile.name,
      fullScale: profile.fullScale,
      deterministicEligible: profile.deterministicEligible,
      performanceWorkloads: profile.performanceCases.map(function workload(item) {
        return { key: item.key, files: item.files, iterations: item.iterations };
      }),
      coldHookIterations: profile.coldHookIterations,
      readGrowthKey: profile.readGrowthKey,
      populatedHookKey: profile.populatedHookKey,
      populatedHookIterations: profile.populatedHookIterations,
    },
    expectedCaseIds: [...EXPECTED_CASE_IDS],
    scenarioIntegrity: integrity,
    scenarios: SCENARIOS.map(function scenarioSummary(item) {
      return { id: item.id, expected: item.expected };
    }),
    baseline: {
      summary: summarize("stock/no-plugin", stockResults, null),
      cases: stockResults,
      outcome: stockOutcome,
    },
  };
  if (baselineOnly) return report;

  const modules = loadCandidateModules();
  const candidateFactory = modules.candidateFactory;
  const candidateResults = SCENARIOS.map(function runCandidate(scenario) {
    return runScenario(candidateFactory, scenario);
  });
  const freshOutcome = runOutcomeWorkflow(candidateFactory, "freshread");
  const baselineGuard = runGuardMatrix(modules, stockFactory, "stock");
  const freshGuard = runGuardMatrix(modules, candidateFactory, "freshread");
  const handlerProtocol = runHandlerProtocolMatrix(modules);
  const security = runSecurityMatrix(modules);
  const performanceSuite = runPerformanceSuite(candidateFactory, profile);
  const primaryPerformanceKey = performanceSuite.primaryKey;
  const freshSummary = summarize("freshread", candidateResults, freshGuard);

  report.baseline.guardMatrix = baselineGuard;
  report.freshread = {
    summary: freshSummary,
    cases: candidateResults,
    outcome: freshOutcome,
    guard: { blocked: freshGuard.guardRate === 1, files: [], matrix: freshGuard.cases },
    guardMatrix: freshGuard,
    handlerProtocol,
    security,
    performance: Object.assign({}, performanceSuite.freshread[primaryPerformanceKey], {
      cases: performanceSuite.freshread,
      coldHookSpawn: performanceSuite.coldHookSpawn.freshread,
      populatedHookSpawn: performanceSuite.populatedHookSpawn.freshread,
      readGrowth: performanceSuite.readGrowth.freshread,
    }),
    performanceBaseline: Object.assign({}, performanceSuite.baseline[primaryPerformanceKey], {
      cases: performanceSuite.baseline,
      coldHookSpawn: performanceSuite.coldHookSpawn.baseline,
      populatedHookSpawn: performanceSuite.populatedHookSpawn.baseline,
      readGrowth: performanceSuite.readGrowth.baseline,
    }),
    performanceComparison: {
      cases: performanceSuite.comparisons,
      readGrowth: performanceSuite.readGrowth,
      coldHookSpawn: performanceSuite.coldHookSpawn,
      populatedHookSpawn: performanceSuite.populatedHookSpawn,
    },
  };
  report.outcomeComparison = {
    taskOutcomeDelta: Number(freshOutcome.taskOutcome) - Number(stockOutcome.taskOutcome),
    userModificationPreservationDelta:
      Number(freshOutcome.userModificationPreserved) - Number(stockOutcome.userModificationPreserved),
    unsafeStaleEditDelta:
      Number(freshOutcome.unsafeStaleEdit) - Number(stockOutcome.unsafeStaleEdit),
  };

  const deterministicViolations = [];
  if (!integrity.passed) deterministicViolations.push("PRD case IDs differ from fixed EXPECTED_CASE_IDS");
  if (freshSummary.requiredCasesPassed !== EXPECTED_CASE_IDS.length) deterministicViolations.push("PRD cases are not 8/8");
  if (freshSummary.staleMissingRecall !== 1) deterministicViolations.push("stale/missing signal recall is below 100%");
  if (freshSummary.freshFalsePositiveRate !== 0) deterministicViolations.push("fresh false-positive signal rate is non-zero");
  if (freshSummary.unknownAsFreshCount !== 0) deterministicViolations.push("UNKNOWN was classified as FRESH");
  if (!freshOutcome.taskSuccess) deterministicViolations.push("FreshRead workflow did not preserve the user edit and complete the task");
  if (!stockOutcome.taskOutcome || stockOutcome.userModificationPreserved) {
    deterministicViolations.push("stock baseline did not exercise the intended stale-consumer harm");
  }

  const handlerViolations = [];
  if (!freshGuard.passed) {
    for (const item of freshGuard.cases.filter(function failed(item) { return !item.passed; })) {
      handlerViolations.push("guard matrix failed: " + item.id);
    }
  }
  if (!handlerProtocol.passed) {
    for (const item of handlerProtocol.cases.filter(function failed(item) { return !item.passed; })) {
      handlerViolations.push("handler protocol failed: " + item.id);
    }
  }
  const securityViolations = security.cases
    .filter(function failed(item) { return !item.passed; })
    .map(function describe(item) { return "security matrix failed: " + item.id; });
  const performanceViolations = [];
  for (const [files, item] of Object.entries(performanceSuite.comparisons)) {
    if (!item.absolutePassed) performanceViolations.push(files + "-file unchanged absolute p95 budget failed");
    if (!item.deltaPassed) performanceViolations.push(files + "-file unchanged baseline-delta p95 budget failed");
    if (!item.trackedWorkloadMatched) performanceViolations.push(files + "-file tracked workload did not match");
    if (!item.unchangedCheckpointHashPassed) performanceViolations.push(files + "-file unchanged checkpoint re-hashed content");
  }
  if (!performanceSuite.readGrowth.nthReadLatency.absolutePassed) {
    performanceViolations.push(performanceSuite.readGrowth.files + "th-read absolute latency budget failed");
  }
  if (!performanceSuite.readGrowth.nthReadLatency.deltaPassed) {
    performanceViolations.push(performanceSuite.readGrowth.files + "th-read baseline-delta latency budget failed");
  }
  if (!performanceSuite.readGrowth.nearNthReadLatency.absolutePassed) {
    performanceViolations.push("near-" + performanceSuite.readGrowth.files + "th-read p95 absolute budget failed");
  }
  if (!performanceSuite.readGrowth.nearNthReadLatency.deltaPassed) {
    performanceViolations.push("near-" + performanceSuite.readGrowth.files + "th-read p95 baseline-delta budget failed");
  }
  if (!performanceSuite.readGrowth.linearWorkPassed) {
    performanceViolations.push(performanceSuite.readGrowth.files + "-file read-registration linear-work gate failed");
  }
  if (performanceSuite.coldHookSpawn.required) {
    if (!performanceSuite.coldHookSpawn.absolutePassed) performanceViolations.push("cold hook absolute p95 budget failed");
    if (!performanceSuite.coldHookSpawn.deltaPassed) performanceViolations.push("cold hook baseline-delta p95 budget failed");
    if (performanceSuite.coldHookSpawn.baseline.failures.length || performanceSuite.coldHookSpawn.freshread.failures.length) {
      performanceViolations.push("cold hook spawn execution failed");
    }
  }
  if (performanceSuite.populatedHookSpawn.required) {
    if (!performanceSuite.populatedHookSpawn.absolutePassed) {
      performanceViolations.push("populated hook absolute p95 budget failed");
    }
    if (!performanceSuite.populatedHookSpawn.deltaPassed) {
      performanceViolations.push("populated hook baseline-delta p95 budget failed");
    }
    if (performanceSuite.populatedHookSpawn.baseline.failures.length ||
        performanceSuite.populatedHookSpawn.freshread.failures.length) {
      performanceViolations.push("populated hook spawn execution failed");
    }
  }
  const provenancePassed = Boolean(report.sourceTree.digest);
  const gatesPassed =
    deterministicViolations.length === 0 &&
    handlerViolations.length === 0 &&
    securityViolations.length === 0 &&
    performanceViolations.length === 0 &&
    provenancePassed;

  report.launchGate = {
    scope: profile.fullScale
      ? "deterministic + synthetic-handler + security + full local-performance"
      : "deterministic + synthetic-handler + security + quick local-performance",
    profile: profile.name,
    passed: gatesPassed,
    deterministicEligible: profile.deterministicEligible && gatesPassed,
    releaseEligible: false,
    gates: {
      deterministic: gateResult(deterministicViolations.length === 0, {
        scenarioIntegrity: integrity,
        requiredCasesPassed: freshSummary.requiredCasesPassed,
        outcomeComparison: report.outcomeComparison,
      }, deterministicViolations),
      handler: gateResult(handlerViolations.length === 0, {
        guardMatrix: freshGuard,
        protocol: handlerProtocol,
      }, handlerViolations),
      security: gateResult(securityViolations.length === 0, security, securityViolations),
      performance: gateResult(performanceViolations.length === 0, performanceSuite, performanceViolations),
      provenance: gateResult(
        provenancePassed,
        report.sourceTree,
        provenancePassed ? [] : ["source tree SHA-256 was not produced"]
      ),
      liveLifecycle: {
        required: true,
        passed: null,
        status: "NOT_RUN",
        claim: "Live Codex lifecycle evidence is required for overall release eligibility and is not run by this deterministic benchmark.",
      },
    },
    violations: [
      ...deterministicViolations,
      ...handlerViolations,
      ...securityViolations,
      ...performanceViolations,
      ...(provenancePassed ? [] : ["source tree SHA-256 was not produced"]),
    ],
  };
  return report;
}

function formatPercent(value) {
  return (Number(value || 0) * 100).toFixed(1) + "%";
}
function yesNo(value) { return value ? "yes" : "no"; }
function statusWord(value) { return value ? "PASS" : "FAIL"; }

function reportMarkdown(report) {
  const lines = [
    "# FreshRead release benchmark",
    "",
    "Source tree SHA-256: " + report.sourceTree.digest,
    "Generated: " + report.generatedAt,
    "Execution profile: " + report.executionProfile.name,
    "",
  ];
  if (!report.freshread) {
    lines.push("Baseline-only run; no launch decision was produced.", "");
    return lines.join("\n");
  }
  lines.push(
    "Status: **" + statusWord(report.launchGate.passed) + "** for " + report.launchGate.scope + ".",
    "Deterministic prerequisites eligible: **" + yesNo(report.launchGate.deterministicEligible) + "**.",
    "Overall release eligible: **no**; a matching live lifecycle PASS is still required.",
    "",
    "Live lifecycle gate: **REQUIRED / NOT RUN**.",
    "",
    "## Baseline versus FreshRead outcome",
    "",
    "| Metric | Stock / no plugin | FreshRead |",
    "| --- | ---: | ---: |",
    "| Requested task completed | " + yesNo(report.baseline.outcome.taskOutcome) + " | " + yesNo(report.freshread.outcome.taskOutcome) + " |",
    "| User external modification preserved | " + yesNo(report.baseline.outcome.userModificationPreserved) + " | " + yesNo(report.freshread.outcome.userModificationPreserved) + " |",
    "| Re-read before edit | " + yesNo(report.baseline.outcome.rereadBeforeEdit) + " | " + yesNo(report.freshread.outcome.rereadBeforeEdit) + " |",
    "| Unsafe stale edit | " + yesNo(report.baseline.outcome.unsafeStaleEdit) + " | " + yesNo(report.freshread.outcome.unsafeStaleEdit) + " |",
    "",
    "## Deterministic metrics",
    "",
    "| Metric | Stock / no plugin | FreshRead |",
    "| --- | ---: | ---: |",
    "| Required PRD cases | " + report.baseline.summary.requiredCasesPassed + "/8 | " + report.freshread.summary.requiredCasesPassed + "/8 |",
    "| Exact state accuracy | " + formatPercent(report.baseline.summary.exactAccuracy) + " | " + formatPercent(report.freshread.summary.exactAccuracy) + " |",
    "| Stale/missing signal recall | " + formatPercent(report.baseline.summary.staleMissingRecall) + " | " + formatPercent(report.freshread.summary.staleMissingRecall) + " |",
    "| Fresh signal false-positive rate | " + formatPercent(report.baseline.summary.freshFalsePositiveRate) + " | " + formatPercent(report.freshread.summary.freshFalsePositiveRate) + " |",
    "| Guard matrix rate | " + formatPercent(report.baseline.guardMatrix.guardRate) + " | " + formatPercent(report.freshread.guardMatrix.guardRate) + " |",
    "",
    "## Performance",
    "",
    "Absolute latency and baseline-delta budgets are independent and must both pass.",
    "",
    "| Workload | Metadata-loop baseline p95 | FreshRead p95 | Absolute budget | Delta / budget | Gate |",
    "| --- | ---: | ---: | ---: | ---: | --- |"
  );
  for (const [key, comparison] of Object.entries(report.freshread.performanceComparison.cases)) {
    const baseline = report.freshread.performanceBaseline.cases[key];
    const fresh = report.freshread.performance.cases[key];
    lines.push(
      "| " + baseline.seededFiles + " unchanged files | " +
      baseline.p95Ms.toFixed(3) + " ms | " +
      fresh.p95Ms.toFixed(3) + " ms | " +
      comparison.p95AbsoluteBudgetMs.toFixed(3) + " ms | " +
      comparison.p95DeltaMs.toFixed(3) + " / " + comparison.p95DeltaBudgetMs.toFixed(3) + " ms | " +
      statusWord(comparison.passed) + " |"
    );
  }
  const cold = report.freshread.performanceComparison.coldHookSpawn;
  if (cold.required) {
    lines.push(
      "| Cold hook spawn (paired AB/BA) | " +
      cold.baseline.p95Ms.toFixed(3) + " ms | " +
      cold.freshread.p95Ms.toFixed(3) + " ms | " +
      cold.p95AbsoluteBudgetMs.toFixed(3) + " ms | " +
      cold.p95DeltaMs.toFixed(3) + " / " + cold.p95DeltaBudgetMs.toFixed(3) + " ms | " +
      statusWord(cold.passed) + " |"
    );
  } else {
    lines.push("| Cold hook spawn | skipped | skipped | full profile only | skipped | " + cold.status + " |");
  }
  const populated = report.freshread.performanceComparison.populatedHookSpawn;
  if (populated.required) {
    lines.push(
      "| Populated " + populated.fileCount + "-file hook spawn | " +
      populated.baseline.p95Ms.toFixed(3) + " ms | " +
      populated.freshread.p95Ms.toFixed(3) + " ms | " +
      populated.p95AbsoluteBudgetMs.toFixed(3) + " ms | " +
      populated.p95DeltaMs.toFixed(3) + " / " + populated.p95DeltaBudgetMs.toFixed(3) + " ms | " +
      statusWord(populated.passed) + " |"
    );
  } else {
    lines.push("| Populated hook spawn | skipped | skipped | full profile only | skipped | " + populated.status + " |");
  }
  const growth = report.freshread.performanceComparison.readGrowth;
  lines.push(
    "",
    "### Read-registration growth",
    "",
    "| Workload | Metadata-loop baseline | FreshRead | Absolute budget | Delta / budget | Gate |",
    "| --- | ---: | ---: | ---: | ---: | --- |",
    "| Exact " + growth.files + "th read | " +
      growth.baseline.nthReadMs.toFixed(3) + " ms | " +
      growth.freshread.nthReadMs.toFixed(3) + " ms | " +
      growth.nthReadLatency.p95AbsoluteBudgetMs.toFixed(3) + " ms | " +
      growth.nthReadLatency.p95DeltaMs.toFixed(3) + " / " +
      growth.nthReadLatency.p95DeltaBudgetMs.toFixed(3) + " ms | " +
      statusWord(growth.nthReadLatency.passed) + " |",
    "| Near-" + growth.files + "th read p95 (" + growth.freshread.nearNthReadSampleCount + " reads) | " +
      growth.baseline.nearNthReadP95Ms.toFixed(3) + " ms | " +
      growth.freshread.nearNthReadP95Ms.toFixed(3) + " ms | " +
      growth.nearNthReadLatency.p95AbsoluteBudgetMs.toFixed(3) + " ms | " +
      growth.nearNthReadLatency.p95DeltaMs.toFixed(3) + " / " +
      growth.nearNthReadLatency.p95DeltaBudgetMs.toFixed(3) + " ms | " +
      statusWord(growth.nearNthReadLatency.passed) + " |",
    "| Read-phase logical path resolutions | " +
      growth.baseline.readPhaseStatCalls + " | " + growth.freshread.readPhaseStatCalls + " | " +
      growth.maxReadPhaseStatCalls + " max | n/a | " + statusWord(growth.linearWorkPassed) + " |"
  );
  lines.push(
    "",
    "## Launch gates",
    "",
    "| Gate | Result |",
    "| --- | --- |"
  );
  for (const [name, gate] of Object.entries(report.launchGate.gates)) {
    lines.push("| " + name + " | " + (gate.passed == null ? gate.status : statusWord(gate.passed)) + " |");
  }
  if (report.launchGate.violations.length) {
    lines.push("", "## Violations", "");
    for (const violation of report.launchGate.violations) lines.push("- " + violation);
  }
  lines.push("");
  return lines.join("\n");
}

function coverageArtifact(report) {
  return {
    schemaVersion: 2,
    generatedAt: report.generatedAt,
    sourceTree: report.sourceTree,
    evidence: {
      deterministicState: report.launchGate ? statusWord(report.launchGate.gates.deterministic.passed) : "NOT_RUN",
      syntheticHandler: report.launchGate ? statusWord(report.launchGate.gates.handler.passed) : "NOT_RUN",
      security: report.launchGate ? statusWord(report.launchGate.gates.security.passed) : "NOT_RUN",
      coldHookProcess: report.launchGate
        ? (report.launchGate.gates.performance.evidence.coldHookSpawn.required
          ? statusWord(report.launchGate.gates.performance.evidence.coldHookSpawn.passed)
          : report.launchGate.gates.performance.evidence.coldHookSpawn.status)
        : "NOT_RUN",
      populatedHookProcess: report.launchGate
        ? (report.launchGate.gates.performance.evidence.populatedHookSpawn.required
          ? statusWord(report.launchGate.gates.performance.evidence.populatedHookSpawn.passed)
          : report.launchGate.gates.performance.evidence.populatedHookSpawn.status)
        : "NOT_RUN",
      readRegistrationGrowth: report.launchGate
        ? statusWord(report.launchGate.gates.performance.evidence.readGrowth.passed)
        : "NOT_RUN",
      liveCodexLifecycle: "NOT_RUN_NOT_CLAIMED",
    },
    testedHandlerBoundaries: report.launchGate
      ? {
          UserPromptSubmit: "synthetic handler",
          SessionStartResume: "synthetic handler",
          SessionStartCompact: "synthetic handler",
          PreToolUseApplyPatch: "synthetic handler",
          PreToolUseShellCopyMove: "synthetic handler",
          hookProcessStdinStdout: report.executionProfile.coldHookIterations > 0
            ? "cold process smoke"
            : "not run in quick profile",
          populatedUserPromptSubmit: report.executionProfile.populatedHookIterations > 0
            ? "configured launcher with persisted 1000-file Read Set"
            : "not run in quick profile",
        }
      : {},
    liveCoverage: {
      status: "NOT_RUN",
      requiredForThisDeterministicGate: false,
      claim: "No live Codex lifecycle coverage is inferred from synthetic events.",
    },
    knownExclusions: [
      "arbitrary subprocess-internal file access",
      "dynamic paths and opaque mixed pipelines",
      "TOCTOU changes after PreToolUse and before the actual write",
      "live Codex resume and compaction lifecycle behavior",
      "model compliance beyond the deterministic stale-consumer workflow",
    ],
  };
}

function writeArtifacts(report, jsonPath) {
  const resolvedJson = path.resolve(jsonPath);
  const directory = path.dirname(resolvedJson);
  const baseName = path.basename(resolvedJson, path.extname(resolvedJson));
  const markdownPath = path.join(directory, baseName + ".md");
  const coveragePath = path.join(directory, "coverage.json");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(resolvedJson, JSON.stringify(report, null, 2) + "\n");
  fs.writeFileSync(markdownPath, reportMarkdown(report).trimEnd() + "\n");
  fs.writeFileSync(coveragePath, JSON.stringify(coverageArtifact(report), null, 2) + "\n");
  return { json: resolvedJson, markdown: markdownPath, coverage: coveragePath };
}

function parseArgs(argv) {
  const result = { baselineOnly: false, out: null, writeResults: true, profile: "full" };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--baseline-only") result.baselineOnly = true;
    else if (argv[index] === "--quick") result.profile = "quick";
    else if (argv[index] === "--out") result.out = argv[++index];
    else if (argv[index] === "--no-write-results") result.writeResults = false;
    else throw new Error("Unknown argument: " + argv[index]);
  }
  return result;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const report = runSuite(args);
  if (!args.baselineOnly && args.writeResults) {
    const outputPath = args.out || path.resolve(__dirname, "results", "latest.json");
    writeArtifacts(report, outputPath);
  } else if (args.out) {
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(path.resolve(args.out), JSON.stringify(report, null, 2) + "\n");
  }
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  if (report.launchGate && !report.launchGate.passed) process.exitCode = 1;
}

module.exports = {
  BENCHMARK_PROFILES,
  EXPECTED_CASE_IDS,
  EXPECTED_STATES,
  POSITIVE_STATES,
  SCENARIOS,
  coverageArtifact,
  evaluateLatencyGate,
  evaluatePairedLatencyGate,
  reportMarkdown,
  runSuite,
  sourceTreeSha256,
  writeArtifacts,
};
