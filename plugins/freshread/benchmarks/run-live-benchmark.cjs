#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const pluginRoot = path.resolve(__dirname, "..");
const resultsDir = path.join(__dirname, "results");
const resultJsonPath = path.join(resultsDir, "live-latest.json");
const resultMarkdownPath = path.join(resultsDir, "live-latest.md");
const eventArtifactPath = path.join(resultsDir, "live-latest.events.json");
const deterministicResultPath = path.join(resultsDir, "latest.json");
const ORIGINAL = "ORIGINAL_A";
const USER_MARKER = "USER_KEEP_B";
const AGENT_MARKER = "AGENT_WRITE_C";
const MINIMUM_CODEX_VERSION = [0, 145, 0];
const APP_SERVER_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_PROTOCOL_BYTES = 32 * 1024 * 1024;
const MAX_STDERR_BYTES = 1024 * 1024;
const EXPECTED_LIVE_MODEL = "gpt-5.6-sol";
const EXPECTED_LIVE_PROVIDER = "openai";
const PLUGIN_NAME = "freshread";
const MAX_MCP_SERVER_COUNT = 256;
const MAX_MCP_OVERRIDE_BYTES = 16 * 1024;
const MAX_HOOK_OVERRIDE_BYTES = 8 * 1024;
const EXPECTED_HOOK_EVENTS = ["postCompact", "postToolUse", "preCompact", "preToolUse", "sessionStart", "userPromptSubmit"];
const ALLOWED_COMMAND_SOURCES = new Set(["agent", "unifiedExecStartup"]);
const HOOK_CONFIG_EVENTS = Object.freeze([
  ["SessionStart", "sessionStart"],
  ["UserPromptSubmit", "userPromptSubmit"],
  ["PreToolUse", "preToolUse"],
  ["PostToolUse", "postToolUse"],
  ["PreCompact", "preCompact"],
  ["PostCompact", "postCompact"],
]);
const TOOL_ACTION_TYPES = new Set([
  "commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall",
  "collabAgentToolCall", "subAgentActivity", "webSearch", "imageView",
  "sleep", "imageGeneration",
  "contextCompaction", "enteredReviewMode", "exitedReviewMode",
]);
const SAFE_ENV_NAMES = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "SYSTEMDRIVE",
  "USERPROFILE", "HOME", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "APPDATA",
  "PROGRAMDATA", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "TZ",
  "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432",
  "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)", "COMMONPROGRAMW6432",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  "CODEX_HOME",
]);
const SAFE_CREDENTIAL_ENV_NAMES = new Set([
  "OPENAI_API_KEY", "OPENAI_ORG_ID", "OPENAI_ORGANIZATION", "OPENAI_PROJECT", "OPENAI_PROJECT_ID",
]);
const FORBIDDEN_ENDPOINT_ENV_NAMES = new Set([
  "OPENAI_BASE_URL", "CHATGPT_BASE_URL", "AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_BASE_URL",
]);

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function createRunId() {
  return `${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${crypto.randomBytes(8).toString("hex")}`;
}

function benchmarkError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function resolveMarketplaceName(value = process.env.FRESHREAD_MARKETPLACE) {
  const marketplace = value || "personal";
  if (typeof marketplace !== "string" || marketplace.length > 64 || !/^[A-Za-z0-9_-]+$/.test(marketplace)) {
    throw benchmarkError("MARKETPLACE_NAME_INVALID", "FRESHREAD_MARKETPLACE must be a valid Codex marketplace name");
  }
  return marketplace;
}

const MARKETPLACE_NAME = resolveMarketplaceName();
const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
const EXPECTED_HOOK_KEYS = Object.freeze({
  sessionStart: `${PLUGIN_ID}:hooks/hooks.json:session_start:0:0`,
  userPromptSubmit: `${PLUGIN_ID}:hooks/hooks.json:user_prompt_submit:0:0`,
  preToolUse: `${PLUGIN_ID}:hooks/hooks.json:pre_tool_use:0:0`,
  postToolUse: `${PLUGIN_ID}:hooks/hooks.json:post_tool_use:0:0`,
  preCompact: `${PLUGIN_ID}:hooks/hooks.json:pre_compact:0:0`,
  postCompact: `${PLUGIN_ID}:hooks/hooks.json:post_compact:0:0`,
});

function publicFailure(error) {
  const code = error && typeof error.code === "string" && /^[A-Z0-9_]{3,80}$/.test(error.code)
    ? error.code
    : "LIVE_BENCHMARK_FAILED";
  return {
    code,
    message: "The live benchmark did not complete successfully; inspect the local process stderr for diagnostics.",
  };
}

function atomicWrite(filePath, bytes) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporary, bytes, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, filePath);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function buildChildEnv(overrides) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (FORBIDDEN_ENDPOINT_ENV_NAMES.has(upper)) continue;
    if (SAFE_ENV_NAMES.has(upper) || SAFE_CREDENTIAL_ENV_NAMES.has(upper)) env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (FORBIDDEN_ENDPOINT_ENV_NAMES.has(key.toUpperCase())) {
      throw benchmarkError("ENDPOINT_ENV_ISOLATION_FAILED", "endpoint override environment variables are forbidden in the live benchmark child");
    }
    for (const existing of Object.keys(env)) {
      if (existing.toUpperCase() === key.toUpperCase()) delete env[existing];
    }
    env[key] = value;
  }
  return env;
}

function pathIsWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function resolveCodexBinary() {
  const requested = process.env.FRESHREAD_CODEX_BIN;
  if (requested) {
    if (!path.isAbsolute(requested)) throw new Error("FRESHREAD_CODEX_BIN must be an absolute path");
    const resolved = fs.realpathSync.native(requested);
    if (!fs.statSync(resolved).isFile()) throw new Error("FRESHREAD_CODEX_BIN is not a regular file");
    return resolved;
  }
  const names = process.platform === "win32" ? ["codex.exe"] : ["codex"];
  for (const rawEntry of String(process.env.PATH || "").split(path.delimiter)) {
    if (!rawEntry || !path.isAbsolute(rawEntry)) continue;
    for (const name of names) {
      const candidate = path.join(rawEntry, name);
      try {
        const resolved = fs.realpathSync.native(candidate);
        if (fs.statSync(resolved).isFile()) return resolved;
      } catch {}
    }
  }
  throw new Error("no absolute Codex executable was found; set FRESHREAD_CODEX_BIN");
}

function parsedVersion(text) {
  const match = String(text || "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) throw new Error(`could not parse Codex version: ${String(text || "").trim()}`);
  return match.slice(1).map(Number);
}

function versionAtLeast(actual, minimum) {
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) return true;
    if (actual[index] < minimum[index]) return false;
  }
  return true;
}

function sourceTreeSha256(root) {
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (
        relative === ".git" || relative.startsWith(".git/") ||
        relative === "node_modules" || relative.startsWith("node_modules/") ||
        relative === "benchmarks/results" || relative.startsWith("benchmarks/results/")
      ) continue;
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push({ absolute, relative });
      else throw new Error(`source tree contains an unsupported filesystem entry: ${relative}`);
    }
  }
  visit(root);
  files.sort((left, right) => left.relative.localeCompare(right.relative));
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
  return { digest: digest.digest("hex"), fileCount: files.length };
}

function expectedHookContract(hooks) {
  const configuredNames = Object.keys(hooks && hooks.hooks || {}).sort();
  const expectedNames = HOOK_CONFIG_EVENTS.map(([configured]) => configured).sort();
  const exactNames = configuredNames.length === expectedNames.length &&
    configuredNames.every((name, index) => name === expectedNames[index]);
  const metadata = [];
  let valid = exactNames;
  for (const [configuredName, eventName] of HOOK_CONFIG_EVENTS) {
    const groups = hooks && hooks.hooks && hooks.hooks[configuredName];
    if (!Array.isArray(groups) || groups.length !== 1 || !Array.isArray(groups[0].hooks) || groups[0].hooks.length !== 1) {
      valid = false;
      continue;
    }
    const group = groups[0];
    const hook = group.hooks[0];
    const command = process.platform === "win32" ? hook.commandWindows : hook.command;
    if (
      hook.type !== "command" || typeof command !== "string" || !command ||
      hook.timeout !== 30 || typeof hook.statusMessage !== "string"
    ) valid = false;
    metadata.push({
      eventName,
      matcher: group.matcher ?? null,
      timeoutSec: hook.timeout,
      statusMessage: hook.statusMessage,
      additionalContextLimit: hook.additionalContextLimit ?? null,
      command,
    });
  }
  return { valid: valid && metadata.length === EXPECTED_HOOK_EVENTS.length, metadata };
}

function installedPluginEvidence(sourceDigest) {
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
  const codexHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
  const cacheRoot = path.join(codexHome, "plugins", "cache", MARKETPLACE_NAME, PLUGIN_NAME, manifest.version);
  const cacheRootEntry = fs.lstatSync(cacheRoot);
  if (cacheRootEntry.isSymbolicLink() || !cacheRootEntry.isDirectory()) {
    throw new Error("installed FreshRead cache root must be a non-link directory");
  }
  const cacheRealPath = fs.realpathSync.native(cacheRoot);
  const cacheDigest = sourceTreeSha256(cacheRealPath);
  const cachedManifest = JSON.parse(fs.readFileSync(path.join(cacheRealPath, ".codex-plugin", "plugin.json"), "utf8"));
  const hooks = JSON.parse(fs.readFileSync(path.join(cacheRealPath, "hooks", "hooks.json"), "utf8"));
  const hookContract = expectedHookContract(hooks);
  const matchesSource =
    cachedManifest.version === manifest.version &&
    cacheDigest.digest === sourceDigest.digest &&
    cacheDigest.fileCount === sourceDigest.fileCount;
  return {
    marketplace: MARKETPLACE_NAME,
    plugin: PLUGIN_NAME,
    version: manifest.version,
    cachePath: cacheRealPath,
    cacheDigest,
    matchesSource,
    hookContractValid: hookContract.valid,
    expectedHooks: hookContract.metadata,
  };
}

function publicInstalledPlugin(evidence) {
  return {
    marketplace: evidence.marketplace,
    plugin: evidence.plugin,
    version: evidence.version,
    cachePath: "<PLUGIN_CACHE>",
    cacheDigest: evidence.cacheDigest,
    matchesSource: evidence.matchesSource,
    hookContractValid: evidence.hookContractValid,
  };
}

function deterministicBenchmarkEvidence(sourceDigest) {
  const entry = fs.lstatSync(deterministicResultPath);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.size > 4 * 1024 * 1024) {
    throw benchmarkError("DETERMINISTIC_ARTIFACT_INVALID", "deterministic benchmark artifact is not a small regular file");
  }
  const bytes = fs.readFileSync(deterministicResultPath);
  const report = JSON.parse(bytes.toString("utf8"));
  const gateNames = ["deterministic", "handler", "security", "performance", "provenance"];
  const sourceMatches = report.sourceTree && report.sourceTree.digest === sourceDigest.digest &&
    report.sourceTree.fileCount === sourceDigest.fileCount;
  const fullProfile = report.executionProfile && report.executionProfile.name === "full-release" &&
    report.executionProfile.fullScale === true && report.executionProfile.deterministicEligible === true;
  const gate = report.launchGate;
  const gatesPassed = gateNames.every((name) => gate && gate.gates && gate.gates[name] && gate.gates[name].passed === true);
  const deterministicEligible = Boolean(
    gate && gate.passed === true && gate.deterministicEligible === true && gate.releaseEligible === false && gatesPassed
  );
  return {
    schemaVersion: report.schemaVersion,
    generatedAt: report.generatedAt,
    artifactSha256: sha256(bytes),
    sourceMatches,
    fullProfile,
    deterministicEligible,
    gatesPassed,
    passed: sourceMatches && fullProfile && deterministicEligible && gatesPassed,
  };
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function commandSet(target, collaborator) {
  if (process.platform === "win32") {
    const pathForms = (value) => [...new Set([value, value.replace(/\\/g, "\\\\")])];
    const readVariants = pathForms(target).map((value) => `Get-Content -LiteralPath ${psQuote(value)} -Raw -Encoding utf8`);
    const externalVariants = [];
    for (const nodePath of pathForms(process.execPath)) {
      for (const scriptPath of pathForms(collaborator)) {
        externalVariants.push(`& ${psQuote(nodePath)} ${psQuote(scriptPath)}`);
      }
    }
    const writeVariants = pathForms(target).map((value) => `Set-Content -LiteralPath ${psQuote(value)} -Value ${psQuote(AGENT_MARKER)} -Encoding utf8`);
    return [
      { label: "read", command: readVariants[0], variants: readVariants },
      { label: "external-edit", command: externalVariants[0], variants: externalVariants },
      { label: "stale-write", command: writeVariants[0], variants: writeVariants },
    ];
  }
  return [
    { label: "read", command: `cat -- ${shQuote(target)}`, variants: [`cat -- ${shQuote(target)}`] },
    { label: "external-edit", command: `${shQuote(process.execPath)} ${shQuote(collaborator)}`, variants: [`${shQuote(process.execPath)} ${shQuote(collaborator)}`] },
    { label: "stale-write", command: `printf '%s\\n' ${shQuote(AGENT_MARKER)} > ${shQuote(target)}`, variants: [`printf '%s\\n' ${shQuote(AGENT_MARKER)} > ${shQuote(target)}`] },
  ];
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeMcpServerNames(serverNames) {
  if (!Array.isArray(serverNames) || serverNames.length > MAX_MCP_SERVER_COUNT) {
    throw benchmarkError("MCP_CONFIG_ISOLATION_FAILED", "effective MCP server inventory exceeds the safe isolation limit");
  }
  const normalized = [...serverNames];
  for (const name of normalized) {
    if (typeof name !== "string" || !name || name.length > 256 || /[\u0000-\u001f\u007f]/.test(name)) {
      throw benchmarkError("MCP_CONFIG_ISOLATION_FAILED", "effective MCP server inventory contains an unsupported key");
    }
  }
  normalized.sort();
  if (new Set(normalized).size !== normalized.length) {
    throw benchmarkError("MCP_CONFIG_ISOLATION_FAILED", "effective MCP server inventory contains duplicate keys");
  }
  return normalized;
}

function buildMcpDisableOverride(serverNames) {
  const names = normalizeMcpServerNames(serverNames);
  if (names.length === 0) return null;
  const override = `mcp_servers={${names.map((name) => `${JSON.stringify(name)}={enabled=false}`).join(",")}}`;
  if (Buffer.byteLength(override, "utf8") > MAX_MCP_OVERRIDE_BYTES) {
    throw benchmarkError("MCP_CONFIG_ISOLATION_FAILED", "effective MCP server inventory exceeds the safe command-line isolation limit");
  }
  return override;
}

function buildFreshReadHookDisableOverride() {
  const keys = Object.values(EXPECTED_HOOK_KEYS).sort();
  const override = `hooks.state={${keys.map((key) => `${JSON.stringify(key)}={enabled=false}`).join(",")}}`;
  if (Buffer.byteLength(override, "utf8") > MAX_HOOK_OVERRIDE_BYTES) {
    throw benchmarkError("HOOK_BASELINE_ISOLATION_FAILED", "FreshRead hook state exceeds the safe command-line isolation limit");
  }
  return override;
}

function effectiveConfigFromRead(response) {
  if (!isPlainObject(response) || !isPlainObject(response.config) || !isPlainObject(response.origins)) {
    throw benchmarkError("CONFIG_READ_INVALID", "config/read returned no effective config object");
  }
  return response.config;
}

function isOfficialDefaultChatgptBaseUrl(value) {
  if (value === undefined || value === null) return true;
  if (typeof value !== "string") return false;
  const normalized = value.endsWith("/") ? value.slice(0, -1) : value;
  return normalized === "https://chatgpt.com/backend-api";
}

function validateProviderConfigRead(response) {
  const config = effectiveConfigFromRead(response);
  const modelProviders = config.model_providers === undefined ? {} : config.model_providers;
  const openaiBaseUrlAbsent = config.openai_base_url === undefined || config.openai_base_url === null;
  const chatgptBaseUrlOfficialDefault = isOfficialDefaultChatgptBaseUrl(config.chatgpt_base_url);
  const appsFeatureDisabled = isPlainObject(config.features) && config.features.apps === false;
  const selectedProviderCustomEntryAbsent = isPlainObject(modelProviders) &&
    !Object.hasOwn(modelProviders, EXPECTED_LIVE_PROVIDER);
  const passed = config.model === EXPECTED_LIVE_MODEL &&
    config.model_provider === EXPECTED_LIVE_PROVIDER && openaiBaseUrlAbsent && chatgptBaseUrlOfficialDefault &&
    selectedProviderCustomEntryAbsent &&
    appsFeatureDisabled;
  if (!passed) {
    throw benchmarkError(
      "MODEL_PROVIDER_ISOLATION_FAILED",
      "effective config did not preserve the requested built-in model/provider, default OpenAI endpoints, and disabled Apps MCP feature"
    );
  }
  return {
    config,
    evidence: {
      passed: true,
      model: EXPECTED_LIVE_MODEL,
      modelProvider: EXPECTED_LIVE_PROVIDER,
      selectedProviderCustomEntryAbsent: true,
      openaiBaseUrlAbsent: true,
      chatgptBaseUrlOfficialDefault: true,
      chatgptBaseUrlMode: config.chatgpt_base_url === undefined || config.chatgpt_base_url === null
        ? "absent"
        : "official-default",
      appsFeatureDisabled: true,
    },
  };
}

function mcpServerInventoryFromRead(response) {
  const { config, evidence: provider } = validateProviderConfigRead(response);
  if (!isPlainObject(config.mcp_servers)) {
    throw benchmarkError("MCP_CONFIG_ISOLATION_FAILED", "config/read returned no effective MCP server map");
  }
  const serverNames = normalizeMcpServerNames(Object.keys(config.mcp_servers));
  for (const name of serverNames) {
    if (!isPlainObject(config.mcp_servers[name])) {
      throw benchmarkError("MCP_CONFIG_ISOLATION_FAILED", "effective MCP server inventory contains an invalid entry");
    }
  }
  return { config, provider, serverNames };
}

function validateMcpConfigIsolation(response, expectedServerNames) {
  const expected = normalizeMcpServerNames(expectedServerNames);
  const { config, provider, serverNames: effective } = mcpServerInventoryFromRead(response);
  const sameInventory = expected.length === effective.length &&
    expected.every((name, index) => name === effective[index]);
  const allDisabled = effective.every((name) => config.mcp_servers[name].enabled === false);
  if (!sameInventory || !allDisabled) {
    throw benchmarkError(
      "MCP_CONFIG_ISOLATION_FAILED",
      "effective MCP configuration changed after discovery or retained an enabled server"
    );
  }
  return {
    passed: true,
    discoveryBound: true,
    discoveredServerCount: expected.length,
    effectiveServerCount: effective.length,
    disabledServerCount: effective.length,
    provider,
  };
}

function appServerClient(codexBin, workspace, env, configOverrides = []) {
  if (!Array.isArray(configOverrides) || configOverrides.some((value) => typeof value !== "string" || !value)) {
    throw new Error("app-server config overrides must be non-empty strings");
  }
  const args = [
    "app-server", "--stdio", "--strict-config",
    "-c", `model=${JSON.stringify(EXPECTED_LIVE_MODEL)}`,
    "-c", `model_provider=${JSON.stringify(EXPECTED_LIVE_PROVIDER)}`,
    "-c", "features.apps=false",
  ];
  for (const override of configOverrides) args.push("-c", override);
  const child = childProcess.spawn(codexBin, args, {
    cwd: workspace,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const pending = new Map();
  const waiters = new Set();
  const notifications = [];
  let nextId = 1;
  let stdoutBuffer = "";
  let stdoutBytes = 0;
  let stderr = "";
  let stderrBytes = 0;
  let stderrTotalBytes = 0;
  const stderrDigest = crypto.createHash("sha256");
  let fatalError = null;
  let closing = false;
  let exitResult = null;

  let resolveExit;
  const exitPromise = new Promise((resolve) => { resolveExit = resolve; });

  function fail(error) {
    if (fatalError) return;
    fatalError = error instanceof Error ? error : new Error(String(error));
    for (const entry of pending.values()) entry.reject(fatalError);
    pending.clear();
    for (const waiter of waiters) waiter.reject(fatalError);
    waiters.clear();
  }

  function send(message) {
    if (fatalError) throw fatalError;
    if (!child.stdin.writable || child.stdin.destroyed) throw new Error("Codex app-server stdin is not writable");
    child.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
  }

  function dispatchNotification(message) {
    notifications.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.method !== message.method) continue;
      let matched;
      try { matched = waiter.predicate(message); }
      catch (error) {
        fail(benchmarkError("PROTOCOL_PREDICATE_FAILED", `notification predicate failed: ${error.message}`));
        return;
      }
      if (!matched) continue;
      waiters.delete(waiter);
      waiter.resolve(message);
    }
  }

  function handleMessage(message) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      fail(new Error("Codex app-server emitted a non-object protocol message"));
      return;
    }
    if (typeof message.method === "string" && Object.hasOwn(message, "id")) {
      try {
        send({ id: message.id, error: { code: -32601, message: `Unexpected server request rejected: ${message.method}` } });
      } catch {}
      fail(new Error(`Codex app-server sent unexpected server request: ${message.method}`));
      return;
    }
    if (typeof message.method === "string") {
      dispatchNotification(message);
      return;
    }
    if (Object.hasOwn(message, "id")) {
      const key = String(message.id);
      const entry = pending.get(key);
      if (!entry) {
        fail(new Error(`Codex app-server sent a response for unknown request id ${key}`));
        return;
      }
      pending.delete(key);
      if (message.error) entry.reject(new Error(`Codex app-server ${entry.method} failed: ${textFrom(message.error) || JSON.stringify(message.error)}`));
      else entry.resolve(message.result);
      return;
    }
    fail(new Error("Codex app-server emitted an unrecognized protocol message"));
  }

  function consumeLine(line) {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); }
    catch {
      fail(new Error(`Codex app-server emitted malformed JSONL: ${line.slice(0, 500)}`));
      return;
    }
    handleMessage(message);
  }

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBytes += Buffer.byteLength(chunk);
    if (stdoutBytes > MAX_PROTOCOL_BYTES) {
      fail(new Error("Codex app-server exceeded the protocol output limit"));
      return;
    }
    stdoutBuffer += chunk;
    for (;;) {
      const newline = stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      consumeLine(line);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderrTotalBytes += Buffer.byteLength(chunk);
    stderrDigest.update(chunk);
    if (stderrBytes >= MAX_STDERR_BYTES) return;
    const room = MAX_STDERR_BYTES - stderrBytes;
    const kept = Buffer.from(chunk).subarray(0, room).toString("utf8");
    stderr += kept;
    stderrBytes += Buffer.byteLength(kept);
  });
  child.stdin.on("error", (error) => { if (!closing) fail(new Error(`Codex app-server stdin failed: ${error.message}`)); });
  child.stdout.on("error", (error) => fail(new Error(`Codex app-server stdout failed: ${error.message}`)));
  child.stderr.on("error", (error) => fail(new Error(`Codex app-server stderr failed: ${error.message}`)));
  child.on("error", (error) => fail(new Error(`unable to start Codex app-server: ${error.message}`)));
  child.on("close", (code, signal) => {
    if (stdoutBuffer.trim()) consumeLine(stdoutBuffer.replace(/\r$/, ""));
    stdoutBuffer = "";
    exitResult = { code, signal };
    resolveExit(exitResult);
    if (!closing) fail(benchmarkError("APP_SERVER_EARLY_EXIT", `Codex app-server exited before shutdown (code=${code}, signal=${signal || "none"})`));
    else if (pending.size || waiters.size) fail(benchmarkError("APP_SERVER_PENDING_ON_CLOSE", "Codex app-server closed with pending protocol operations"));
  });

  function request(method, params) {
    if (fatalError) return Promise.reject(fatalError);
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(String(id), { method, resolve, reject });
      try { send({ id, method, params }); }
      catch (error) {
        pending.delete(String(id));
        reject(error);
      }
    });
  }

  function notify(method, params) {
    const message = { method };
    if (params !== undefined) message.params = params;
    send(message);
  }

  function waitFor(method, predicate) {
    const existing = notifications.find((message) => message.method === method && predicate(message));
    if (existing) return Promise.resolve(existing);
    if (fatalError) return Promise.reject(fatalError);
    return new Promise((resolve, reject) => waiters.add({ method, predicate, resolve, reject }));
  }

  async function close() {
    closing = true;
    if (!child.stdin.destroyed) child.stdin.end();
    if (!exitResult) {
      const graceful = await Promise.race([
        exitPromise.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 3000)),
      ]);
      if (!graceful && !child.killed) {
        try { child.kill("SIGKILL"); }
        catch (error) { fail(benchmarkError("APP_SERVER_KILL_FAILED", `unable to terminate Codex app-server: ${error.message}`)); }
      }
      if (!graceful) {
        await Promise.race([
          exitPromise,
          new Promise((resolve) => setTimeout(resolve, 2000)),
        ]);
      }
    }
    if (!exitResult) fail(benchmarkError("APP_SERVER_SHUTDOWN_TIMEOUT", "Codex app-server did not exit after forced shutdown"));
    return {
      ...(exitResult || { code: null, signal: "shutdown-timeout" }),
      fatalError,
      stderrPreview: stderr.slice(0, 8000),
      stderrSummary: {
        bytes: stderrTotalBytes,
        sha256: stderrDigest.digest("hex"),
        truncatedInMemory: stderrTotalBytes > MAX_STDERR_BYTES,
      },
      protocolBytes: stdoutBytes,
    };
  }

  return { request, notify, waitFor, close, notifications };
}

function initializeRequestParams() {
  return {
    clientInfo: { name: "freshread-live-benchmark", title: "FreshRead live benchmark", version: "1.0.0" },
    capabilities: { experimentalApi: true, requestAttestation: false },
  };
}

async function discoverEffectiveMcpServers(codexBin, workspace, env, bindingSalt) {
  const client = appServerClient(codexBin, workspace, env);
  let discovered;
  let operationError = null;
  let processResult;
  try {
    discovered = await withTimeout((async () => {
      const initialize = await client.request("initialize", initializeRequestParams());
      const initializeRuntime = validateInitialize(initialize);
      client.notify("initialized");
      const configRead = await client.request("config/read", { cwd: workspace, includeLayers: false });
      const inventory = mcpServerInventoryFromRead(configRead);
      return { initializeRuntime, inventory };
    })(), APP_SERVER_TIMEOUT_MS, "Codex app-server MCP isolation discovery");
  } catch (error) {
    operationError = error;
  } finally {
    processResult = await client.close();
  }
  if (processResult.fatalError) throw processResult.fatalError;
  if (operationError) throw operationError;
  if (processResult.code !== 0 || processResult.signal !== null) {
    throw benchmarkError("MCP_DISCOVERY_PROCESS_FAILED", "MCP isolation discovery app-server did not exit cleanly");
  }
  const serverNames = discovered.inventory.serverNames;
  return {
    serverNames,
    override: buildMcpDisableOverride(serverNames),
    evidence: {
      passed: true,
      configReadBeforeThread: true,
      discoveredServerCount: serverNames.length,
      inventoryBindingSha256: sha256(Buffer.from(`${bindingSalt}\0${JSON.stringify(serverNames)}`, "utf8")),
      initialize: discovered.initializeRuntime,
      provider: discovered.inventory.provider,
      processStatus: processResult.code,
      processSignal: processResult.signal,
      process: {
        stderr: processResult.stderrSummary,
        protocolBytes: processResult.protocolBytes,
      },
    },
  };
}

function textFrom(value, seen = new Set()) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || seen.has(value)) return "";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => textFrom(item, seen)).filter(Boolean).join("\n");
  return ["aggregatedOutput", "aggregated_output", "output", "stdout", "stderr", "error", "message", "text", "content", "entries", "statusMessage"]
    .filter((key) => Object.hasOwn(value, key))
    .map((key) => textFrom(value[key], seen))
    .filter(Boolean)
    .join("\n");
}

function unwrapPowerShellCarrier(command) {
  const rawCommand = String(command || "").trim();
  const carrier = rawCommand.match(/^(?:"([^"\r\n]+)"|'([^'\r\n]+)'|(\S+))\s+(?:-(?:NoLogo|NoProfile|NonInteractive)\s+)*-(?:Command|C)\s+"([\s\S]*)"$/i);
  const executable = carrier && (carrier[1] || carrier[2] || carrier[3]);
  const carrierName = executable ? path.basename(executable).toLowerCase().replace(/\.exe$/i, "") : "";
  if (carrier && ["powershell", "pwsh"].includes(carrierName)) {
    return { command: carrier[4], carrier: carrierName };
  }
  return { command: rawCommand, carrier: "direct" };
}

function commandTrace(events, threadId, turnId, workspace) {
  const byId = new Map();
  const order = [];
  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const event = events[eventIndex];
    if (!event || !event.params || event.params.threadId !== threadId || event.params.turnId !== turnId) continue;
    const item = event && event.params && event.params.item;
    if (!item || item.type !== "commandExecution" || !["item/started", "item/completed"].includes(event.method)) continue;
    const id = item.id;
    if (typeof id !== "string" || !id) throw new Error("commandExecution item is missing an id");
    if (!byId.has(id)) byId.set(id, { id, started: null, completed: null, related: [] });
    const record = byId.get(id);
    record.related.push({ event, eventIndex });
    if (event.method === "item/started") {
      if (record.started) throw new Error(`duplicate command start for ${id}`);
      record.started = item;
      record.startedIndex = eventIndex;
      order.push(id);
    } else if (event.method === "item/completed") {
      if (record.completed) throw new Error(`duplicate command completion for ${id}`);
      record.completed = item;
      record.completedIndex = eventIndex;
    }
  }
  return order.map((id) => {
    const record = byId.get(id);
    if (!record.started || !record.completed) throw new Error(`incomplete command lifecycle for ${id}`);
    if (!(record.startedIndex < record.completedIndex)) throw new Error(`invalid command lifecycle order for ${id}`);
    if (record.started.status !== "inProgress") throw new Error(`command ${id} did not start in progress`);
    if (typeof record.started.command !== "string" || !record.started.command ||
        record.started.command !== record.completed.command) {
      throw new Error(`command ${id} changed between lifecycle events`);
    }
    if (!samePath(record.started.cwd, workspace) || !samePath(record.completed.cwd, workspace) ||
        !samePath(record.started.cwd, record.completed.cwd)) {
      throw new Error(`command ${id} changed or escaped its workspace cwd`);
    }
    if (record.started.source !== record.completed.source || !ALLOWED_COMMAND_SOURCES.has(record.started.source)) {
      throw new Error(`command ${id} has an unexpected or unstable source`);
    }
    const rawCommand = record.started.command.trim();
    const unwrapped = unwrapPowerShellCarrier(rawCommand);
    return {
      id,
      command: unwrapped.command,
      rawCommand,
      carrier: unwrapped.carrier,
      cwdMatches: true,
      source: record.started.source,
      startedIndex: record.startedIndex,
      completedIndex: record.completedIndex,
      status: record.completed.status || null,
      exitCode: record.completed.exitCode ?? null,
      output: textFrom(record.completed),
    };
  });
}

function commandVariant(command, plan) {
  return plan.variants.findIndex((variant) => variant === String(command || "").trim());
}

function commandHashVariant(commandSha256, plan) {
  return plan.variants.findIndex((variant) => sha256(Buffer.from(variant, "utf8")) === commandSha256);
}

function auditCommandHashEvidence(auditCommandSha256, traceCommand, plan) {
  const directlyObserved = Boolean(traceCommand && [traceCommand.command, traceCommand.rawCommand]
    .filter((value) => typeof value === "string")
    .some((value) => sha256(Buffer.from(value, "utf8")) === auditCommandSha256));
  const matchedPlanVariant = plan ? commandHashVariant(auditCommandSha256, plan) : -1;
  return {
    directlyObserved,
    matchedPlanVariant,
    passed: directlyObserved || matchedPlanVariant >= 0,
  };
}

function toolLedger(events, threadId, turnId, expectedCommandCount) {
  const targetActions = new Map();
  const foreignActions = new Set();
  for (const event of events) {
    if (!event || !["item/started", "item/completed"].includes(event.method) || !event.params || !event.params.item) continue;
    const item = event.params.item;
    if (!TOOL_ACTION_TYPES.has(item.type)) continue;
    const key = `${String(event.params.threadId)}:${String(event.params.turnId)}:${String(item.id)}`;
    if (event.params.threadId !== threadId || event.params.turnId !== turnId) {
      foreignActions.add(key);
      continue;
    }
    if (!targetActions.has(item.id)) targetActions.set(item.id, item.type);
    else if (targetActions.get(item.id) !== item.type) throw benchmarkError("TOOL_LEDGER_TYPE_CHANGED", "a tool item changed type during its lifecycle");
  }
  const types = [...targetActions.values()];
  return {
    targetActionCount: types.length,
    commandExecutionCount: types.filter((type) => type === "commandExecution").length,
    expectedCommandExecutionCount: expectedCommandCount,
    extraActionTypes: types.filter((type) => type !== "commandExecution").sort(),
    foreignActionCount: foreignActions.size,
    exact: types.length === expectedCommandCount && types.every((type) => type === "commandExecution") && foreignActions.size === 0,
  };
}

function successfulCommand(item) {
  return Boolean(item && item.exitCode === 0 && item.status === "completed");
}

function publicCommandTrace(trace, plans) {
  return trace.map((item, index) => {
    const output = Buffer.from(String(item.output || ""), "utf8");
    const matchedVariant = plans[index] ? commandVariant(item.command, plans[index]) : -1;
    return {
      index: index + 1,
      label: plans[index] ? plans[index].label : "unexpected",
      expectedCommandSha256: plans[index] ? sha256(Buffer.from(plans[index].command, "utf8")) : null,
      observedCommandSha256: sha256(Buffer.from(item.command, "utf8")),
      matchedVariant,
      carrier: item.carrier,
      cwdMatches: item.cwdMatches,
      status: item.status,
      exitCode: item.exitCode,
      outputBytes: output.length,
      outputSha256: sha256(output),
      outputFreshReadBlocked: /FreshRead blocked this edit/.test(item.output),
      outputStaleExternal: /STALE_EXTERNAL/.test(item.output),
    };
  });
}

function normalizedMarker(contents) {
  return String(contents || "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\n$/, "");
}

function readAndValidateProof(proofPath, nonce, target) {
  try {
    const entry = fs.lstatSync(proofPath);
    if (entry.isSymbolicLink() || !entry.isFile() || entry.size < 2 || entry.size > 8192) {
      throw benchmarkError("EXTERNAL_EDIT_PROOF_FILE_INVALID", "external-edit proof is not a small regular file");
    }
    const proof = JSON.parse(fs.readFileSync(proofPath, "utf8"));
    if (!proof || typeof proof !== "object" || Array.isArray(proof)) {
      throw benchmarkError("EXTERNAL_EDIT_PROOF_SCHEMA_INVALID", "external-edit proof has an invalid schema");
    }
    const expectedBytes = Buffer.from(`${USER_MARKER}\n`, "utf8");
    const nonceValid = proof.nonce === nonce;
    const targetMatches = samePath(proof.target, target);
    const markerMatches = proof.marker === USER_MARKER;
    const hashMatches = proof.sha256 === sha256(expectedBytes);
    const writtenAtValid = typeof proof.writtenAt === "string" && Number.isFinite(Date.parse(proof.writtenAt));
    const valid = proof.schemaVersion === 1 && nonceValid && targetMatches && markerMatches && hashMatches && writtenAtValid;
    return {
      schemaVersion: proof.schemaVersion,
      nonceValid,
      targetMatches,
      markerMatches,
      hashMatches,
      writtenAtValid,
      marker: markerMatches ? USER_MARKER : "<UNEXPECTED>",
      sha256: typeof proof.sha256 === "string" ? proof.sha256 : null,
      errorCode: valid ? null : "EXTERNAL_EDIT_PROOF_SCHEMA_INVALID",
      valid,
    };
  } catch (error) {
    const errorCode = error && error.code === "ENOENT"
      ? "EXTERNAL_EDIT_PROOF_MISSING"
      : error && typeof error.code === "string" && /^EXTERNAL_EDIT_PROOF_[A-Z_]+$/.test(error.code)
        ? error.code
        : "EXTERNAL_EDIT_PROOF_INVALID";
    return {
      schemaVersion: null,
      nonceValid: false,
      targetMatches: false,
      markerMatches: false,
      hashMatches: false,
      writtenAtValid: false,
      marker: "<UNAVAILABLE>",
      sha256: null,
      errorCode,
      valid: false,
    };
  }
}

function writeCollaborator(collaborator, target, proofPath, nonce) {
  const body = [
    '"use strict";',
    'const crypto = require("node:crypto");',
    'const fs = require("node:fs");',
    `const target = ${JSON.stringify(target)};`,
    `const proofPath = ${JSON.stringify(proofPath)};`,
    `const nonce = ${JSON.stringify(nonce)};`,
    `const marker = ${JSON.stringify(USER_MARKER)};`,
    'const bytes = Buffer.from(`${marker}\\n`, "utf8");',
    'fs.writeFileSync(target, bytes);',
    'const proof = { schemaVersion: 1, nonce, target, marker, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), writtenAt: new Date().toISOString() };',
    'const temp = `${proofPath}.${process.pid}.tmp`;',
    'fs.writeFileSync(temp, `${JSON.stringify(proof)}\\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });',
    'fs.renameSync(temp, proofPath);',
    "",
  ].join("\n");
  fs.writeFileSync(collaborator, body, { encoding: "utf8", mode: 0o700 });
}

function samePath(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || !path.isAbsolute(left) || !path.isAbsolute(right)) return false;
  let resolvedLeft = path.resolve(left);
  let resolvedRight = path.resolve(right);
  try { resolvedLeft = fs.realpathSync.native(resolvedLeft); } catch {}
  try { resolvedRight = fs.realpathSync.native(resolvedRight); } catch {}
  if (process.platform === "win32") return resolvedLeft.toLowerCase() === resolvedRight.toLowerCase();
  return resolvedLeft === resolvedRight;
}

function readBenchmarkAudit(dataDir, nonce) {
  try {
    const auditRoot = path.join(dataDir, "benchmark-audit");
    const rootEntry = fs.lstatSync(auditRoot);
    if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory() ||
        JSON.stringify(fs.readdirSync(auditRoot).sort()) !== JSON.stringify([nonce])) {
      throw benchmarkError("BENCHMARK_AUDIT_ROOT_INVALID", "benchmark audit root contains an unexpected entry or link");
    }
    const auditDirectory = path.join(auditRoot, nonce);
    const directoryEntry = fs.lstatSync(auditDirectory);
    if (directoryEntry.isSymbolicLink() || !directoryEntry.isDirectory()) {
      throw benchmarkError("BENCHMARK_AUDIT_DIRECTORY_INVALID", "benchmark audit evidence is not a regular directory");
    }
    const names = fs.readdirSync(auditDirectory).sort();
    if (names.length !== 3 || !names.every((name) => /^[0-9a-f]{64}\.json$/.test(name))) {
      throw benchmarkError("BENCHMARK_AUDIT_FILE_SET_INVALID", "benchmark audit evidence does not contain exactly three hashed PreToolUse records");
    }
    const expectedKeys = ["commandSha256", "decisionCode", "hookEvent", "nonce", "schemaVersion", "toolUseIdSha256"];
    const records = names.map((name) => {
      const absolute = path.join(auditDirectory, name);
      const entry = fs.lstatSync(absolute);
      if (entry.isSymbolicLink() || !entry.isFile() || entry.size < 2 || entry.size > 4096) {
        throw benchmarkError("BENCHMARK_AUDIT_FILE_INVALID", "benchmark audit evidence contains an unsafe file");
      }
      const value = JSON.parse(fs.readFileSync(absolute, "utf8"));
      const keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort() : [];
      const valid = keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index]) &&
        value.schemaVersion === 1 && value.nonce === nonce && value.hookEvent === "PreToolUse" &&
        typeof value.toolUseIdSha256 === "string" && /^[0-9a-f]{64}$/.test(value.toolUseIdSha256) &&
        name === `${value.toolUseIdSha256}.json` &&
        typeof value.commandSha256 === "string" && /^[0-9a-f]{64}$/.test(value.commandSha256) &&
        ["PASS", "ALLOW", "CONTEXT", "DENY_OTHER", "DENY_STALE_EXTERNAL"].includes(value.decisionCode);
      if (!valid) throw benchmarkError("BENCHMARK_AUDIT_SCHEMA_INVALID", "benchmark audit evidence failed strict schema validation");
      return value;
    });
    if (new Set(records.map((record) => record.toolUseIdSha256)).size !== records.length) {
      throw benchmarkError("BENCHMARK_AUDIT_DUPLICATE_TOOL", "benchmark audit evidence repeats a tool id hash");
    }
    return {
      records,
      public: {
        passed: true,
        recordCount: records.length,
        errorCode: null,
        nonceSha256: sha256(Buffer.from(nonce, "utf8")),
        rawToolIdsPersisted: false,
        rawCommandsPersisted: false,
        records: records.map((record) => ({
          toolUseIdSha256: record.toolUseIdSha256,
          commandSha256: record.commandSha256,
          decisionCode: record.decisionCode,
        })),
      },
    };
  } catch (error) {
    const errorCode = error && error.code === "ENOENT"
      ? "BENCHMARK_AUDIT_MISSING"
      : error && typeof error.code === "string" && /^BENCHMARK_AUDIT_[A-Z_]+$/.test(error.code)
        ? error.code
        : "BENCHMARK_AUDIT_INVALID";
    return {
      records: [],
      public: {
        passed: false,
        recordCount: 0,
        errorCode,
        nonceSha256: sha256(Buffer.from(nonce, "utf8")),
        rawToolIdsPersisted: false,
        rawCommandsPersisted: false,
        records: [],
      },
    };
  }
}

function hookToolUseId(run) {
  const label = run.eventName === "preToolUse"
    ? "pre-tool-use"
    : run.eventName === "postToolUse"
      ? "post-tool-use"
      : null;
  if (!label || !Number.isInteger(run.displayOrder) || typeof run.sourcePath !== "string") {
    throw benchmarkError("HOOK_RUN_ID_PREFIX_INVALID", "FreshRead hook lifecycle cannot be bound to a tool call");
  }
  const prefix = `${label}:${run.displayOrder}:${run.sourcePath}:`;
  if (typeof run.id !== "string" || !run.id.startsWith(prefix) || run.id.length === prefix.length) {
    throw benchmarkError("HOOK_RUN_ID_PREFIX_INVALID", "FreshRead hook lifecycle has an invalid tool-call run id");
  }
  return run.id.slice(prefix.length);
}

function hookDiscoveryEvidence(response, workspace, expectedSourcePath, expectedHooks, expectedEnabled) {
  const entries = Array.isArray(response && response.data) ? response.data : [];
  const entry = entries.find((item) => item && samePath(item.cwd, workspace));
  const hooks = Array.isArray(entry && entry.hooks) ? entry.hooks : [];
  const pluginHooks = hooks.filter((hook) => hook && hook.pluginId === PLUGIN_ID);
  const eventNames = pluginHooks.map((hook) => hook.eventName).sort();
  const warnings = entries.flatMap((item) => Array.isArray(item && item.warnings) ? item.warnings : []);
  const errors = entries.flatMap((item) => Array.isArray(item && item.errors) ? item.errors : []);
  const sortedExpected = [...expectedHooks].sort((left, right) => left.eventName.localeCompare(right.eventName));
  const sortedRuntime = [...pluginHooks].sort((left, right) => String(left.eventName).localeCompare(String(right.eventName)));
  const exactMetadata = sortedRuntime.length === sortedExpected.length && sortedRuntime.every((hook, index) => {
    const expected = sortedExpected[index];
    return hook.eventName === expected.eventName &&
      (hook.matcher ?? null) === expected.matcher &&
      Number(hook.timeoutSec) === expected.timeoutSec &&
      (hook.statusMessage ?? null) === expected.statusMessage &&
      (hook.additionalContextLimit ?? null) === expected.additionalContextLimit &&
      hook.handlerType === "command" && hook.command === expected.command && hook.async === false &&
      hook.enabled === expectedEnabled && hook.isManaged === false && hook.source === "plugin" &&
      hook.pluginId === PLUGIN_ID && samePath(hook.sourcePath, expectedSourcePath) &&
      hook.key === EXPECTED_HOOK_KEYS[hook.eventName] &&
      typeof hook.currentHash === "string" && /^sha256:[0-9a-f]{64}$/.test(hook.currentHash) &&
      hook.trustStatus === "trusted";
  });
  const passed =
    entries.length === 1 && Boolean(entry) && warnings.length === 0 && errors.length === 0 &&
    hooks.length === EXPECTED_HOOK_EVENTS.length && hooks.length === pluginHooks.length &&
    pluginHooks.length === EXPECTED_HOOK_EVENTS.length &&
    eventNames.every((eventName, index) => eventName === EXPECTED_HOOK_EVENTS[index]) &&
    pluginHooks.every((hook) => hook.enabled === expectedEnabled && hook.source === "plugin" && samePath(hook.sourcePath, expectedSourcePath)) &&
    exactMetadata;
  return {
    passed,
    workspace: "<WORKSPACE>",
    workspaceMatches: Boolean(entry && samePath(entry.cwd, workspace)),
    warningsCount: warnings.length,
    errorsCount: errors.length,
    exactMetadata,
    hooks: sortedRuntime.map((hook) => ({
      eventName: hook.eventName,
      enabled: hook.enabled,
      source: hook.source,
      pluginId: hook.pluginId,
      sourcePath: "<PLUGIN_CACHE>/hooks/hooks.json",
      trustStatus: hook.trustStatus,
      matcherSha256: hook.matcher === null || hook.matcher === undefined ? null : sha256(Buffer.from(hook.matcher, "utf8")),
      commandSha256: typeof hook.command === "string" ? sha256(Buffer.from(hook.command, "utf8")) : null,
      timeoutSec: Number(hook.timeoutSec),
      handlerType: hook.handlerType,
      currentHashSha256: typeof hook.currentHash === "string" ? sha256(Buffer.from(hook.currentHash, "utf8")) : null,
    })),
  };
}

function hookExecutionEvidence(events, expectedSourcePath, threadId, turnId, enabled, target, trace, turnCompletedIndex, audit, plans) {
  const byId = new Map();
  const targetHookEvents = events.filter((event) => event && ["hook/started", "hook/completed"].includes(event.method) &&
    event.params && event.params.threadId === threadId && event.params.turnId === turnId && event.params.run);
  const isFreshReadRun = (run) => run.source === "plugin" && samePath(run.sourcePath, expectedSourcePath) &&
    (!Object.hasOwn(run, "pluginId") || run.pluginId === null || run.pluginId === PLUGIN_ID);
  const foreignHookLifecycleEvents = targetHookEvents.filter((event) => {
    const run = event.params.run;
    return !isFreshReadRun(run);
  }).length;
  if (!enabled) {
    const disabledLifecycleAbsent = targetHookEvents.length === 0;
    const auditExact = audit.records.length === 0 && audit.public &&
      audit.public.errorCode === "BENCHMARK_AUDIT_MISSING";
    return {
      associationMethod: "exact per-process hook-state disable plus complete absence of target-turn hook lifecycle and audit evidence",
      lifecycleComplete: disabledLifecycleAbsent,
      exactSequence: disabledLifecycleAbsent,
      hookCountsExact: disabledLifecycleAbsent,
      associationExact: disabledLifecycleAbsent,
      timingExact: disabledLifecycleAbsent,
      auditExact,
      foreignHookLifecycleEvents,
      disabledLifecycleAbsent,
      disabledLifecycleEventCount: targetHookEvents.length,
      exactDenial: false,
      preToolUse: 0,
      postToolUse: 0,
      blockedAttempt: null,
      runs: [],
      passed: disabledLifecycleAbsent && foreignHookLifecycleEvents === 0 && auditExact,
    };
  }
  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const event = events[eventIndex];
    if (!event || !["hook/started", "hook/completed"].includes(event.method) || !event.params ||
        event.params.threadId !== threadId || event.params.turnId !== turnId || !event.params.run) continue;
    const run = event.params.run;
    if (!isFreshReadRun(run) ||
        !["preToolUse", "postToolUse"].includes(run.eventName)) continue;
    if (typeof run.id !== "string" || !run.id) throw benchmarkError("HOOK_RUN_ID_MISSING", "FreshRead hook lifecycle is missing a run id");
    if (!byId.has(run.id)) byId.set(run.id, { started: null, completed: null });
    const record = byId.get(run.id);
    if (event.method === "hook/started") {
      if (record.started) throw benchmarkError("HOOK_RUN_DUPLICATE_START", "FreshRead hook lifecycle has a duplicate start");
      record.started = { run, eventIndex };
    } else {
      if (record.completed) throw benchmarkError("HOOK_RUN_DUPLICATE_COMPLETION", "FreshRead hook lifecycle has a duplicate completion");
      record.completed = { run, eventIndex };
    }
  }
  const lifecycle = [...byId.values()];
  const stableFields = ["id", "eventName", "handlerType", "executionMode", "scope", "source", "pluginId", "displayOrder", "statusMessage"];
  const lifecycleComplete = lifecycle.every((record) => record.started && record.completed &&
    record.started.eventIndex < record.completed.eventIndex && record.started.run.status === "running" &&
    stableFields.every((field) => Object.is(record.started.run[field], record.completed.run[field])) &&
    samePath(record.started.run.sourcePath, record.completed.run.sourcePath));
  const completed = lifecycle.filter((record) => record.completed).sort((left, right) => left.completed.eventIndex - right.completed.eventIndex);
  const runs = completed.map((record) => record.completed.run);
  const expectedSequence = ["preToolUse", "postToolUse", "preToolUse", "postToolUse", "preToolUse"];
  const expectedStatuses = ["completed", "completed", "completed", "completed", "blocked"];
  const exactSequence = runs.length === expectedSequence.length && runs.every((run, index) =>
    run.eventName === expectedSequence[index] && run.status === expectedStatuses[index]
  );
  const preRecords = completed.filter((record) => record.completed.run.eventName === "preToolUse");
  const postRecords = completed.filter((record) => record.completed.run.eventName === "postToolUse");
  const expectedPreCount = 3;
  const expectedPostCount = 2;
  const hookCountsExact = preRecords.length === expectedPreCount && postRecords.length === expectedPostCount;
  const boundRecords = completed.map((record) => ({
    ...record,
    toolUseId: hookToolUseId(record.completed.run),
  }));
  const boundPre = boundRecords.filter((record) => record.completed.run.eventName === "preToolUse");
  const boundPost = boundRecords.filter((record) => record.completed.run.eventName === "postToolUse");
  const commandPairs = trace.map((command) => ({
    command,
    pre: boundPre.filter((record) => record.toolUseId === command.id),
    post: boundPost.filter((record) => record.toolUseId === command.id),
  }));
  const associationExact = commandPairs.every((pair) => pair.pre.length === 1 && pair.post.length === 1) &&
    new Set(commandPairs.flatMap((pair) => [pair.pre[0] && pair.pre[0].completed.run.id, pair.post[0] && pair.post[0].completed.run.id]).filter(Boolean)).size === trace.length * 2;
  let timingExact = associationExact && Number.isInteger(turnCompletedIndex);
  if (timingExact) {
    for (let index = 0; index < commandPairs.length; index += 1) {
      const pair = commandPairs[index];
      const ordered = pair.pre[0].started.eventIndex < pair.pre[0].completed.eventIndex &&
        pair.pre[0].completed.eventIndex < pair.command.startedIndex &&
        pair.command.startedIndex < pair.command.completedIndex &&
        pair.command.completedIndex < pair.post[0].started.eventIndex &&
        pair.post[0].started.eventIndex < pair.post[0].completed.eventIndex;
      const afterPrevious = index === 0 || commandPairs[index - 1].post[0].completed.eventIndex < pair.pre[0].started.eventIndex;
      if (!ordered || !afterPrevious) timingExact = false;
    }
  }
  const pairedPreIds = new Set(commandPairs.flatMap((pair) => pair.pre.map((record) => record.completed.run.id)));
  const unmatchedPre = boundPre.filter((record) => !pairedPreIds.has(record.completed.run.id));
  const thirdPreRecord = unmatchedPre.length === 1 ? unmatchedPre[0] : null;
  if (timingExact) {
    const lastPost = commandPairs[commandPairs.length - 1] && commandPairs[commandPairs.length - 1].post[0];
    timingExact = Boolean(lastPost && thirdPreRecord &&
      lastPost.completed.eventIndex < thirdPreRecord.started.eventIndex &&
      thirdPreRecord.started.eventIndex < thirdPreRecord.completed.eventIndex &&
      thirdPreRecord.completed.eventIndex < turnCompletedIndex &&
      !boundPost.some((record) => record.toolUseId === thirdPreRecord.toolUseId) &&
      !trace.some((command) => command.id === thirdPreRecord.toolUseId));
  }

  const auditBindings = boundPre.map((record) => {
    const toolUseIdSha256 = sha256(Buffer.from(record.toolUseId, "utf8"));
    const matches = audit.records.filter((candidate) => candidate.toolUseIdSha256 === toolUseIdSha256);
    const auditRecord = matches.length === 1 ? matches[0] : null;
    const traceIndex = trace.findIndex((command) => command.id === record.toolUseId);
    const executedHashEvidence = auditRecord && traceIndex >= 0
      ? auditCommandHashEvidence(auditRecord.commandSha256, trace[traceIndex], plans[traceIndex])
      : { directlyObserved: false, matchedPlanVariant: -1, passed: false };
    const blockedVariant = Boolean(auditRecord && traceIndex < 0 && plans[2])
      ? commandHashVariant(auditRecord.commandSha256, plans[2])
      : -1;
    const expectedDecision = traceIndex < 0 ? "DENY_STALE_EXTERNAL" : "PASS";
    return {
      record,
      auditRecord,
      toolUseIdSha256,
      traceIndex,
      traceCommandHashMatches: executedHashEvidence.passed,
      traceCommandHashDirectlyObserved: executedHashEvidence.directlyObserved,
      executedVariant: executedHashEvidence.matchedPlanVariant,
      blockedVariant,
      decisionMatches: Boolean(auditRecord && auditRecord.decisionCode === expectedDecision),
    };
  });
  const auditExact = auditBindings.length === 3 && audit.records.length === 3 &&
    auditBindings.every((binding) => binding.auditRecord && binding.decisionMatches &&
      (binding.traceIndex >= 0 ? binding.traceCommandHashMatches : binding.blockedVariant >= 0)) &&
    new Set(auditBindings.map((binding) => binding.toolUseIdSha256)).size === 3;
  const thirdPre = thirdPreRecord ? thirdPreRecord.completed.run : null;
  const thirdAudit = thirdPreRecord
    ? auditBindings.find((binding) => binding.record.completed.run.id === thirdPreRecord.completed.run.id) || null
    : null;
  const denialText = thirdPre ? textFrom(thirdPre.entries) : "";
  const exactDenial = Boolean(thirdPre && thirdPre.status === "blocked" && thirdAudit &&
    thirdAudit.auditRecord && thirdAudit.auditRecord.decisionCode === "DENY_STALE_EXTERNAL" && thirdAudit.blockedVariant >= 0 &&
    /FreshRead blocked this edit/.test(denialText) && /STALE_EXTERNAL/.test(denialText) &&
    denialText.includes(path.basename(target)));
  const safeRuns = boundRecords.map((record, index) => {
    const run = record.completed.run;
    const entriesText = textFrom(run.entries);
    const binding = auditBindings.find((candidate) => candidate.record.toolUseId === record.toolUseId) || null;
    return {
      ordinal: index + 1,
      eventName: run.eventName,
      status: run.status,
      toolUseIdSha256: sha256(Buffer.from(record.toolUseId, "utf8")),
      auditDecisionCode: binding && binding.auditRecord ? binding.auditRecord.decisionCode : null,
      auditCommandSha256: binding && binding.auditRecord ? binding.auditRecord.commandSha256 : null,
      auditMatchedVariant: binding ? (binding.traceIndex >= 0 ? binding.executedVariant : binding.blockedVariant) : null,
      entriesBytes: Buffer.byteLength(entriesText),
      entriesSha256: sha256(Buffer.from(entriesText, "utf8")),
      freshReadBlocked: /FreshRead blocked this edit/.test(entriesText),
      staleExternal: /STALE_EXTERNAL/.test(entriesText),
    };
  });
  return {
    associationMethod: "exact HookRunSummary run-id prefix/suffix to command item id, cross-event timing, and test-only hashed PreToolUse audit",
    lifecycleComplete,
    exactSequence,
    hookCountsExact,
    associationExact,
    timingExact,
    auditExact,
    foreignHookLifecycleEvents,
    exactDenial,
    preToolUse: runs.filter((run) => run.eventName === "preToolUse").length,
    postToolUse: runs.filter((run) => run.eventName === "postToolUse").length,
    blockedAttempt: enabled && thirdAudit && thirdAudit.auditRecord ? {
      toolUseIdSha256: thirdAudit.toolUseIdSha256,
      commandSha256: thirdAudit.auditRecord.commandSha256,
      matchedVariant: thirdAudit.blockedVariant,
      decisionCode: thirdAudit.auditRecord.decisionCode,
      noCommandLifecycle: thirdAudit.traceIndex < 0,
      noPostToolUse: thirdPreRecord ? !boundPost.some((record) => record.toolUseId === thirdPreRecord.toolUseId) : false,
    } : null,
    runs: safeRuns,
    passed: foreignHookLifecycleEvents === 0 && lifecycleComplete && exactSequence && hookCountsExact && associationExact && timingExact && auditExact && exactDenial,
  };
}

function jsonStateSummary(value) {
  const summary = { rootType: Array.isArray(value) ? "array" : value === null ? "null" : typeof value, topLevelKeys: [], nodes: 0, objects: 0, arrays: 0, strings: 0, numbers: 0, booleans: 0, nulls: 0, maxDepth: 0 };
  if (value && typeof value === "object" && !Array.isArray(value)) summary.topLevelKeys = Object.keys(value).sort();
  function visit(node, depth) {
    summary.nodes += 1;
    summary.maxDepth = Math.max(summary.maxDepth, depth);
    if (node === null) { summary.nulls += 1; return; }
    if (Array.isArray(node)) {
      summary.arrays += 1;
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (typeof node === "object") {
      summary.objects += 1;
      for (const child of Object.values(node)) visit(child, depth + 1);
      return;
    }
    if (typeof node === "string") summary.strings += 1;
    else if (typeof node === "number") summary.numbers += 1;
    else if (typeof node === "boolean") summary.booleans += 1;
  }
  visit(value, 0);
  return summary;
}

function snapshotDataDir(dataDir) {
  if (!fs.existsSync(dataDir)) return { exists: false, files: [] };
  const files = [];
  let excludedBenchmarkAudit = false;
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("FreshRead dataDir unexpectedly contains a symbolic link");
      const relative = path.relative(dataDir, absolute).split(path.sep).join("/");
      if (entry.isDirectory() && relative === "benchmark-audit") {
        excludedBenchmarkAudit = true;
        continue;
      }
      if (entry.isDirectory()) { visit(absolute); continue; }
      if (!entry.isFile()) throw new Error("FreshRead dataDir unexpectedly contains a non-regular file");
      const bytes = fs.readFileSync(absolute);
      const stat = fs.statSync(absolute);
      const metadata = {
        path: relative,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        sha256: sha256(bytes),
      };
      if (path.extname(entry.name).toLowerCase() === ".json") {
        try { metadata.jsonStateSummary = jsonStateSummary(JSON.parse(bytes.toString("utf8"))); }
        catch { metadata.jsonStateSummary = { parseable: false }; }
      }
      files.push(metadata);
    }
  }
  visit(dataDir);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { exists: true, files, excludedBenchmarkAudit };
}

async function withTimeout(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds} ms`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function validateInitialize(response) {
  const expectedOs = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
  const expectedFamily = process.platform === "win32" ? "windows" : "unix";
  const expectedCodexHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
  const passed = Boolean(
    response && typeof response.userAgent === "string" && response.userAgent &&
    response.platformOs === expectedOs && response.platformFamily === expectedFamily &&
    samePath(response.codexHome, expectedCodexHome)
  );
  if (!passed) throw benchmarkError("INITIALIZE_RUNTIME_MISMATCH", "Codex app-server initialize response did not match the requested local runtime");
  return {
    platformOs: response.platformOs,
    platformFamily: response.platformFamily,
    codexHome: "<CODEX_HOME>",
    codexHomeMatches: true,
    userAgentSha256: sha256(Buffer.from(response.userAgent, "utf8")),
  };
}

function validateThreadRuntime(response, workspace) {
  const thread = response && response.thread;
  const sandbox = response && response.sandbox;
  const roots = sandbox && sandbox.type === "workspaceWrite" && Array.isArray(sandbox.writableRoots)
    ? sandbox.writableRoots
    : [];
  const runtimeRoots = Array.isArray(response && response.runtimeWorkspaceRoots) ? response.runtimeWorkspaceRoots : [];
  const runtimeRootCoversWorkspace = runtimeRoots.some((root) => typeof root === "string" && pathIsWithin(path.resolve(root), path.resolve(workspace)));
  // In the current app-server contract, workspaceWrite.writableRoots contains
  // additional roots; an empty list leaves the primary cwd writable. Bind that
  // implicit case to the independently returned runtime workspace root.
  const explicitWritableRootCoversWorkspace = roots.some((root) =>
    typeof root === "string" && pathIsWithin(path.resolve(root), path.resolve(workspace))
  );
  const workspaceWritable = explicitWritableRootCoversWorkspace ||
    (roots.length === 0 && runtimeRootCoversWorkspace);
  const passed = Boolean(
    thread && typeof thread.id === "string" && thread.id && thread.ephemeral === true &&
    samePath(thread.cwd, workspace) && samePath(response.cwd, workspace) &&
    response.approvalPolicy === "never" && sandbox && sandbox.type === "workspaceWrite" && workspaceWritable &&
    runtimeRootCoversWorkspace && response.model === EXPECTED_LIVE_MODEL &&
    response.modelProvider === EXPECTED_LIVE_PROVIDER
  );
  if (!passed) throw benchmarkError("THREAD_RUNTIME_MISMATCH", "thread/start did not activate the requested cwd, ephemeral mode, approval policy, sandbox, or model runtime");
  return {
    cwd: "<WORKSPACE>",
    cwdMatches: true,
    ephemeral: true,
    approvalPolicy: response.approvalPolicy,
    sandbox: {
      type: sandbox.type,
      workspaceWritable,
      writableRootMode: roots.length === 0 ? "implicit-primary-cwd" : "explicit-root",
      networkAccess: Boolean(sandbox.networkAccess),
    },
    runtimeRootCoversWorkspace,
    model: response.model,
    modelProvider: response.modelProvider,
    serviceTier: response.serviceTier ?? null,
    reasoningEffort: response.reasoningEffort ?? null,
    activePermissionProfileSha256: response.activePermissionProfile && typeof response.activePermissionProfile.id === "string"
      ? sha256(Buffer.from(response.activePermissionProfile.id, "utf8"))
      : null,
  };
}

function safeMethodCounts(events) {
  const counts = {};
  for (const event of events) {
    const method = event && typeof event.method === "string" ? event.method : "<invalid>";
    counts[method] = (counts[method] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function exactTurnCompletedIndex(events, threadId, turnId) {
  const matches = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event && event.method === "turn/completed" && event.params && event.params.threadId === threadId &&
        event.params.turn && event.params.turn.id === turnId) matches.push(index);
  }
  if (matches.length !== 1) throw benchmarkError("TURN_COMPLETION_LIFECYCLE_INVALID", "target turn has no unique completion event");
  return matches[0];
}

function isStructuredRetriableStreamDisconnect(event) {
  const params = event && event.params;
  const error = params && params.error;
  const info = error && error.codexErrorInfo;
  if (!params || params.willRetry !== true) return false;
  if (!error || typeof error !== "object" || Array.isArray(error) ||
      typeof error.message !== "string" || error.message.trim() === "") {
    return false;
  }
  if (Object.hasOwn(error, "additionalDetails") && error.additionalDetails !== null &&
      typeof error.additionalDetails !== "string") return false;
  if (!info || typeof info !== "object" || Array.isArray(info)) return false;
  const infoKeys = Object.keys(info);
  if (infoKeys.length !== 1 || infoKeys[0] !== "responseStreamDisconnected") return false;
  const details = info.responseStreamDisconnected;
  if (!details || typeof details !== "object" || Array.isArray(details)) return false;
  const detailKeys = Object.keys(details);
  if (detailKeys.some((key) => key !== "httpStatusCode")) return false;
  if (Object.hasOwn(details, "httpStatusCode")) {
    const status = details.httpStatusCode;
    if (status !== null && (!Number.isInteger(status) || status < 0 || status > 65535)) return false;
  }
  return true;
}

function finalAgentMessageEvidence(events, threadId, turnId, turnCompletedIndex) {
  const completedMessages = [];
  const targetErrors = [];
  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const event = events[eventIndex];
    if (!event || !event.params || event.params.threadId !== threadId || event.params.turnId !== turnId) continue;
    if (event.method === "error") targetErrors.push({ event, eventIndex });
    if (event.method === "item/completed" && event.params.item && event.params.item.type === "agentMessage") {
      completedMessages.push({ item: event.params.item, eventIndex });
    }
  }
  const finalMessages = completedMessages.filter(({ item }) => item.phase === "final_answer");
  const terminalMessage = completedMessages.length ? completedMessages[completedMessages.length - 1] : null;
  // MessagePhase is nullable in the app-server contract because providers do
  // not emit it consistently. Preserve the documented legacy compatibility
  // behavior: when there is no explicit final_answer, the last completed
  // agentMessage is the terminal answer. An explicit final_answer, when
  // present, must still be unique and terminal.
  const terminalPhase = terminalMessage && terminalMessage.item.phase;
  const terminalPhaseCompatible = terminalPhase === "final_answer" || terminalPhase === null || terminalPhase === undefined;
  const explicitFinalCompatible = finalMessages.length <= 1 &&
    (finalMessages.length === 0 || finalMessages[0] === terminalMessage);
  const terminalText = terminalMessage && typeof terminalMessage.item.text === "string"
    ? terminalMessage.item.text
    : null;
  // App-server reports transient response-stream disconnects as target-turn
  // `error` notifications with willRetry=true. They remain visible evidence,
  // but are non-terminal only when schema-shaped, before the final agent
  // message, and followed by the target turn's unique completion event.
  const retriableErrors = targetErrors.filter(({ event, eventIndex }) =>
    isStructuredRetriableStreamDisconnect(event) && terminalMessage !== null &&
    eventIndex < terminalMessage.eventIndex && eventIndex < turnCompletedIndex
  );
  const terminalErrors = targetErrors.filter((candidate) => !retriableErrors.includes(candidate));
  const exact = terminalErrors.length === 0 && terminalMessage !== null &&
    terminalPhaseCompatible && explicitFinalCompatible && terminalText === "DONE" &&
    terminalMessage.eventIndex < turnCompletedIndex;
  return {
    passed: exact,
    completedAgentMessageCount: completedMessages.length,
    finalAnswerCount: finalMessages.length,
    targetErrorNotificationCount: targetErrors.length,
    targetRetriableTransportErrorNotificationCount: retriableErrors.length,
    targetTerminalErrorNotificationCount: terminalErrors.length,
    exactDone: terminalText === "DONE",
    terminalTextBytes: terminalText === null ? null : Buffer.byteLength(terminalText, "utf8"),
    terminalTextSha256: terminalText === null ? null : sha256(Buffer.from(terminalText, "utf8")),
    terminalPhaseMode: terminalPhase === "final_answer" ? "explicit-final" :
      terminalPhase === null || terminalPhase === undefined ? "unknown-compatible" : "incompatible",
    explicitFinalCompatible,
    beforeTurnCompleted: Boolean(terminalMessage && terminalMessage.eventIndex < turnCompletedIndex),
  };
}

function mcpRuntimeEvidence(events) {
  const startupStatuses = events.filter((event) =>
    event && event.method === "mcpServer/startupStatus/updated"
  );
  return {
    passed: startupStatuses.length === 0,
    startupStatusNotificationCount: startupStatuses.length,
    noRuntimeMcpStartupObserved: startupStatuses.length === 0,
  };
}

async function runArm(root, name, enabled, codexBin, expectedHookSourcePath, expectedHooks) {
  const workspace = path.join(root, name);
  const target = path.join(workspace, "target.txt");
  const collaborator = path.join(workspace, "external-edit.cjs");
  const proofPath = path.join(workspace, "external-edit.proof.json");
  const dataDir = path.join(workspace, ".freshread-data");
  const nonce = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(target, `${ORIGINAL}\n`, "utf8");
  writeCollaborator(collaborator, target, proofPath, nonce);
  const commands = commandSet(target, collaborator);
  const prompt = [
    "This is a controlled FreshRead A/B integration probe.",
    "Execute exactly the following three commands in order, each in its own shell/unified-execution tool call.",
    "Copy every command verbatim. Do not use apply_patch, combine commands, inspect files another way, re-read, retry, or compensate if a hook blocks a command.",
    "After the third attempt, respond exactly DONE.",
    "",
    `1. ${commands[0].command}`,
    `2. ${commands[1].command}`,
    `3. ${commands[2].command}`,
  ].join("\n");
  const childEnv = buildChildEnv({
    FRESHREAD_DATA_DIR: dataDir,
    FRESHREAD_TEST_MODE: "1",
    FRESHREAD_BENCHMARK_NONCE: nonce,
  });
  const mcpPreflight = await discoverEffectiveMcpServers(codexBin, workspace, childEnv, nonce);
  const configOverrides = [];
  if (mcpPreflight.override) configOverrides.push(mcpPreflight.override);
  if (!enabled) configOverrides.push(buildFreshReadHookDisableOverride());
  const client = appServerClient(
    codexBin,
    workspace,
    childEnv,
    configOverrides
  );
  let protocol;
  let processResult;
  try {
    protocol = await withTimeout((async () => {
      const initialize = await client.request("initialize", initializeRequestParams());
      const initializeRuntime = validateInitialize(initialize);
      client.notify("initialized");
      const configRead = await client.request("config/read", { cwd: workspace, includeLayers: false });
      const mcpIsolation = validateMcpConfigIsolation(configRead, mcpPreflight.serverNames);
      const hooks = await client.request("hooks/list", { cwds: [workspace] });
      const hookDiscovery = hookDiscoveryEvidence(hooks, workspace, expectedHookSourcePath, expectedHooks, enabled);
      if (!hookDiscovery.passed) {
        throw benchmarkError("HOOK_TRUST_OR_CONTRACT_MISMATCH", `${name} app-server hooks/list did not return the exact trusted FreshRead hook contract`);
      }
      const threadStarted = await client.request("thread/start", {
        cwd: workspace,
        ephemeral: true,
        sandbox: "workspace-write",
        approvalPolicy: "never",
        model: EXPECTED_LIVE_MODEL,
      });
      const threadRuntime = validateThreadRuntime(threadStarted, workspace);
      const threadId = threadStarted && threadStarted.thread && threadStarted.thread.id;
      if (typeof threadId !== "string" || !threadId) throw new Error("thread/start returned no thread id");
      const turnStarted = await client.request("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
        effort: "low",
      });
      const turnId = turnStarted && turnStarted.turn && turnStarted.turn.id;
      if (typeof turnId !== "string" || !turnId) throw new Error("turn/start returned no turn id");
      const turnCompleted = await client.waitFor("turn/completed", (message) =>
        message.params && message.params.threadId === threadId &&
        message.params.turn && message.params.turn.id === turnId
      );
      if (turnCompleted.params.turn.status !== "completed") {
        throw new Error(`turn ${turnId} completed with status ${turnCompleted.params.turn.status}`);
      }
      return { initializeRuntime, mcpIsolation, hookDiscovery, threadRuntime, threadId, turnId, turnCompleted };
    })(), APP_SERVER_TIMEOUT_MS, `${name} Codex app-server arm`);
  } finally {
    processResult = await client.close();
  }
  if (processResult.fatalError) throw processResult.fatalError;
  const events = client.notifications;
  const turnCompletedIndex = exactTurnCompletedIndex(events, protocol.threadId, protocol.turnId);
  const finalResponse = finalAgentMessageEvidence(events, protocol.threadId, protocol.turnId, turnCompletedIndex);
  const mcpRuntime = mcpRuntimeEvidence(events);
  const trace = commandTrace(events, protocol.threadId, protocol.turnId, workspace);
  const expectedExecutedCommands = enabled ? 2 : 3;
  const tools = toolLedger(events, protocol.threadId, protocol.turnId, expectedExecutedCommands);
  const exactSequence = tools.exact && trace.length === expectedExecutedCommands && trace.every((item, index) =>
    item.cwdMatches && commandVariant(item.command, commands[index]) >= 0
  );
  const proof = readAndValidateProof(proofPath, nonce, target);
  const finalContent = fs.readFileSync(target, "utf8");
  const benchmarkAudit = readBenchmarkAudit(dataDir, nonce);
  const hookExecution = hookExecutionEvidence(
    events, expectedHookSourcePath, protocol.threadId, protocol.turnId, enabled, target,
    trace, turnCompletedIndex, benchmarkAudit, commands
  );
  const publicTrace = publicCommandTrace(trace, commands);
  const dataDirSnapshot = snapshotDataDir(dataDir);
  const readSucceeded = successfulCommand(trace[0]);
  const externalEditProved = successfulCommand(trace[1]) && proof.valid;
  const thirdSucceeded = !enabled && successfulCommand(trace[2]);
  const thirdBlocked = Boolean(enabled && hookExecution.exactDenial && hookExecution.blockedAttempt &&
    hookExecution.blockedAttempt.noCommandLifecycle && hookExecution.blockedAttempt.noPostToolUse);
  const finalMarker = normalizedMarker(finalContent);
  const userMarkerPreserved = finalMarker === USER_MARKER;
  const agentWriteLanded = finalMarker === AGENT_MARKER;
  const finalContentEvidence = {
    category: userMarkerPreserved
      ? "USER_KEEP_B"
      : agentWriteLanded
        ? "AGENT_WRITE_C"
        : finalMarker === ORIGINAL
          ? "ORIGINAL_A"
          : "OTHER",
    bytes: Buffer.byteLength(finalContent),
    sha256: sha256(Buffer.from(finalContent, "utf8")),
  };
  const dataDirExpected = enabled
    ? Boolean(dataDirSnapshot.exists && dataDirSnapshot.excludedBenchmarkAudit && dataDirSnapshot.files.length > 0)
    : dataDirSnapshot.exists === false;
  const armPassed = Boolean(
    processResult.code === 0 && mcpPreflight.evidence.passed && protocol.mcpIsolation.passed && mcpRuntime.passed &&
    protocol.hookDiscovery.passed && finalResponse.passed && exactSequence && hookExecution.passed &&
    readSucceeded && externalEditProved && dataDirExpected &&
    (enabled
      ? thirdBlocked && userMarkerPreserved && !agentWriteLanded
      : thirdSucceeded && agentWriteLanded && !userMarkerPreserved)
  );
  const report = {
    arm: name,
    enabled,
    passed: armPassed,
    processStatus: processResult.code,
    processSignal: processResult.signal,
    processEvidence: {
      stderr: processResult.stderrSummary,
      protocolBytes: processResult.protocolBytes,
    },
    protocol: {
      threadIdSha256: sha256(Buffer.from(protocol.threadId, "utf8")),
      turnIdSha256: sha256(Buffer.from(protocol.turnId, "utf8")),
      initialize: protocol.initializeRuntime,
      mcpPreflight: mcpPreflight.evidence,
      mcpIsolation: protocol.mcpIsolation,
      threadRuntime: protocol.threadRuntime,
    },
    hookDiscovery: protocol.hookDiscovery,
    hookExecution,
    finalResponse,
    mcpRuntime,
    benchmarkAudit: {
      ...benchmarkAudit.public,
      expectedMode: enabled ? "three-hashed-records" : "absent-disabled-baseline",
      expectationPassed: hookExecution.auditExact,
    },
    toolLedger: tools,
    exactSequence,
    commandTrace: publicTrace,
    proof,
    finalContent: finalContentEvidence,
    readSucceeded,
    externalEditProved,
    thirdCommandSucceeded: thirdSucceeded,
    thirdCommandBlocked: thirdBlocked,
    userMarkerPreserved,
    agentWriteLanded,
    dataDirExpected,
    dataDirSnapshot,
  };
  const eventEvidence = {
    arm: name,
    rawProtocolPersisted: false,
    rawCommandOutputPersisted: false,
    machinePathsPersisted: false,
    notificationCount: events.length,
    notificationMethodCounts: safeMethodCounts(events),
    protocol: report.protocol,
    hookDiscovery: report.hookDiscovery,
    hookExecution: report.hookExecution,
    finalResponse: report.finalResponse,
    mcpRuntime: report.mcpRuntime,
    benchmarkAudit: report.benchmarkAudit,
    toolLedger: report.toolLedger,
    commandTrace: report.commandTrace,
  };
  return { report, eventEvidence };
}

function renderMarkdown(report) {
  const yesNo = (value) => value ? "yes" : "no";
  if (!report.baseline || !report.freshread) {
    return [
      "# FreshRead live Codex A/B",
      "",
      `Run: ${report.runId}`,
      `Generated: ${report.generatedAt}`,
      `Status: **${report.status}**`,
      "Release eligible: **no**",
      "",
      "No live PASS claim is available for this run. Raw protocol events, command output, environment values, and machine paths were not persisted.",
      "",
    ].join("\n");
  }
  return [
    "# FreshRead live Codex A/B",
    "",
    `Run: ${report.runId}`,
    `Generated: ${report.generatedAt}`,
    `Codex: ${report.codex.version} (${report.codex.sha256})`,
    `Plugin: freshread ${report.installedPlugin.version} (${report.sourceTree.digest})`,
    "",
    "| Metric | Baseline (disabled) | FreshRead |",
    "| --- | ---: | ---: |",
    `| Exact expected command lifecycle (3 executed / 2 executed + 1 pre-hook block) | ${yesNo(report.baseline.exactSequence)} | ${yesNo(report.freshread.exactSequence)} |`,
    `| Read command succeeded | ${yesNo(report.baseline.readSucceeded)} | ${yesNo(report.freshread.readSucceeded)} |`,
    `| External edit + proof succeeded | ${yesNo(report.baseline.externalEditProved)} | ${yesNo(report.freshread.externalEditProved)} |`,
    `| External USER_KEEP edit preserved | ${yesNo(report.baseline.userMarkerPreserved)} | ${yesNo(report.freshread.userMarkerPreserved)} |`,
    `| Stale agent write landed | ${yesNo(report.baseline.agentWriteLanded)} | ${yesNo(report.freshread.agentWriteLanded)} |`,
    `| Third attempt has exact FreshRead stale denial | ${yesNo(report.baseline.hookExecution.exactDenial)} | ${yesNo(report.freshread.hookExecution.exactDenial)} |`,
    `| PreToolUse audit contract (absent / 3 hashed records) | ${yesNo(report.baseline.benchmarkAudit.expectationPassed)} | ${yesNo(report.freshread.benchmarkAudit.expectationPassed)} |`,
    `| Configured MCP servers disabled and provider endpoints isolated | ${yesNo(report.baseline.protocol.mcpIsolation.passed)} | ${yesNo(report.freshread.protocol.mcpIsolation.passed)} |`,
    `| No MCP runtime startup notification | ${yesNo(report.baseline.mcpRuntime.passed)} | ${yesNo(report.freshread.mcpRuntime.passed)} |`,
    `| Exact six-hook app-server discovery | ${yesNo(report.baseline.hookDiscovery.passed)} | ${yesNo(report.freshread.hookDiscovery.passed)} |`,
    `| Exact final DONE response with no terminal target-turn error | ${yesNo(report.baseline.finalResponse.passed)} | ${yesNo(report.freshread.finalResponse.passed)} |`,
    `| Retriable stream-disconnect notifications (observed) | ${report.baseline.finalResponse.targetRetriableTransportErrorNotificationCount} | ${report.freshread.finalResponse.targetRetriableTransportErrorNotificationCount} |`,
    `| Strict target-turn tool ledger | ${yesNo(report.baseline.toolLedger.exact)} | ${yesNo(report.freshread.toolLedger.exact)} |`,
    `| Strict FreshRead hook lifecycle/order | ${yesNo(report.baseline.hookExecution.passed)} | ${yesNo(report.freshread.hookExecution.passed)} |`,
    "",
    `A/B runtime equivalent: **${yesNo(report.launchGate.runtimeEquivalent)}**`,
    `Deterministic eligible: **${yesNo(report.launchGate.deterministicEligible)}**`,
    `Live eligible: **${yesNo(report.launchGate.liveEligible)}**`,
    `Release eligible: **${yesNo(report.releaseEligible)}**`,
    `Launch gate: **${report.releaseEligible ? "PASS" : "FAIL"}**`,
    "",
    "FreshRead binds each HookRunSummary run-id suffix to the matching command item id and enforces Pre < command < Post notification timing. The blocked third attempt has no command/Post lifecycle and is bound to the requested stale-write command by a test-only SHA-256 audit record.",
    "",
    "Artifacts persist only structured counts, statuses, booleans, placeholders, and SHA-256 values. Raw protocol events, command output, environment values, and machine paths are excluded.",
    "",
  ].join("\n");
}

function writeArtifactSet(report, eventEvidence) {
  const eventDocument = {
    schemaVersion: 6,
    runId: report.runId,
    generatedAt: report.generatedAt,
    status: report.status,
    evidencePolicy: {
      rawProtocolPersisted: false,
      rawCommandOutputPersisted: false,
      environmentValuesPersisted: false,
      machinePathsPersisted: false,
    },
    ...eventEvidence,
  };
  const eventBytes = `${JSON.stringify(eventDocument, null, 2)}\n`;
  const boundReport = {
    ...report,
    eventArtifact: {
      name: path.basename(eventArtifactPath),
      runId: report.runId,
      bytes: Buffer.byteLength(eventBytes),
      sha256: sha256(Buffer.from(eventBytes, "utf8")),
    },
  };
  const markdown = `${renderMarkdown(boundReport).trimEnd()}\n`;
  const json = `${JSON.stringify(boundReport, null, 2)}\n`;
  atomicWrite(eventArtifactPath, eventBytes);
  atomicWrite(resultMarkdownPath, markdown);
  // JSON is the canonical latest pointer and is committed last. Its runId and
  // event SHA detect interruption between the three per-file atomic renames.
  atomicWrite(resultJsonPath, json);
  return { report: boundReport, markdown };
}

function writeNonPassArtifacts(runId, status, error = null) {
  const report = {
    schemaVersion: 6,
    runId,
    generatedAt: new Date().toISOString(),
    status,
    evidenceLevel: "no-live-pass-claim",
    passed: false,
    liveEligible: false,
    releaseEligible: false,
    failure: error ? publicFailure(error) : null,
  };
  return writeArtifactSet(report, { arms: {} });
}

async function main(runId) {
  const codexBin = resolveCodexBinary();
  const versionRun = childProcess.spawnSync(codexBin, ["--version"], {
    encoding: "utf8",
    windowsHide: true,
    env: buildChildEnv({ FRESHREAD_TEST_MODE: "1" }),
  });
  if (versionRun.status !== 0) throw new Error(`unable to run Codex: ${versionRun.stderr || versionRun.error || "unknown error"}`);
  const versionText = String(versionRun.stdout || "").trim();
  const versionParts = parsedVersion(versionText);
  if (!versionAtLeast(versionParts, MINIMUM_CODEX_VERSION)) {
    throw new Error(`Codex ${versionParts.join(".")} is too old; live enforcement requires >= ${MINIMUM_CODEX_VERSION.join(".")}`);
  }
  const codexHashBefore = sha256(fs.readFileSync(codexBin));
  const sourceTree = sourceTreeSha256(pluginRoot);
  const deterministicBefore = deterministicBenchmarkEvidence(sourceTree);
  if (!deterministicBefore.passed) {
    throw benchmarkError("DETERMINISTIC_PREREQUISITE_FAILED", "full deterministic benchmark evidence is missing, stale, or ineligible");
  }
  const installedPlugin = installedPluginEvidence(sourceTree);
  if (!installedPlugin.matchesSource || !installedPlugin.hookContractValid) {
    throw new Error("installed FreshRead cache does not match the validated source tree and hook contract; cachebust and reinstall first");
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freshread-live-"));
  let baseline;
  let freshread;
  try {
    const expectedHookSourcePath = path.join(installedPlugin.cachePath, "hooks", "hooks.json");
    baseline = await runArm(root, "baseline", false, codexBin, expectedHookSourcePath, installedPlugin.expectedHooks);
    freshread = await runArm(root, "freshread", true, codexBin, expectedHookSourcePath, installedPlugin.expectedHooks);
  } finally {
    const tempRoot = fs.realpathSync.native(os.tmpdir());
    const resolvedRoot = fs.realpathSync.native(root);
    if (!pathIsWithin(tempRoot, resolvedRoot) || !path.basename(resolvedRoot).startsWith("freshread-live-")) {
      throw new Error("refusing to remove an unexpected live benchmark directory");
    }
    fs.rmSync(resolvedRoot, { recursive: true, force: true });
  }
  const sourceTreeAfter = sourceTreeSha256(pluginRoot);
  const installedPluginAfter = installedPluginEvidence(sourceTreeAfter);
  const deterministicAfter = deterministicBenchmarkEvidence(sourceTreeAfter);
  const codexHashAfter = sha256(fs.readFileSync(codexBin));
  const sourceStable = sourceTreeAfter.digest === sourceTree.digest && sourceTreeAfter.fileCount === sourceTree.fileCount;
  const cacheStable = installedPluginAfter.matchesSource && installedPluginAfter.hookContractValid &&
    installedPluginAfter.version === installedPlugin.version &&
    installedPluginAfter.cacheDigest.digest === installedPlugin.cacheDigest.digest &&
    installedPluginAfter.cacheDigest.fileCount === installedPlugin.cacheDigest.fileCount;
  const deterministicStable = deterministicAfter.passed &&
    deterministicAfter.artifactSha256 === deterministicBefore.artifactSha256;
  const codexStable = codexHashAfter === codexHashBefore;
  const provenanceStable = sourceStable && cacheStable && deterministicStable && codexStable;
  const comparableRuntimeFields = ["model", "modelProvider", "serviceTier", "reasoningEffort"];
  const baselineRuntime = baseline.report.protocol.threadRuntime;
  const freshreadRuntime = freshread.report.protocol.threadRuntime;
  const runtimeEquivalent = comparableRuntimeFields.every((field) => baselineRuntime[field] === freshreadRuntime[field]) &&
    baselineRuntime.sandbox.type === freshreadRuntime.sandbox.type &&
    baselineRuntime.sandbox.workspaceWritable === freshreadRuntime.sandbox.workspaceWritable &&
    baselineRuntime.sandbox.writableRootMode === freshreadRuntime.sandbox.writableRootMode &&
    baselineRuntime.sandbox.networkAccess === freshreadRuntime.sandbox.networkAccess &&
    baselineRuntime.runtimeRootCoversWorkspace === freshreadRuntime.runtimeRootCoversWorkspace &&
    baselineRuntime.activePermissionProfileSha256 === freshreadRuntime.activePermissionProfileSha256;
  const liveEligible = Boolean(baseline.report.passed && freshread.report.passed && provenanceStable && runtimeEquivalent);
  const deterministicEligible = Boolean(deterministicBefore.passed && deterministicStable);
  const releaseEligible = deterministicEligible && liveEligible;
  const report = {
    schemaVersion: 6,
    runId,
    generatedAt: new Date().toISOString(),
    status: releaseEligible ? "PASS" : "FAIL",
    evidenceLevel: "live-codex-model-tool-hook",
    codex: { path: "<CODEX_BIN>", version: versionText, sha256: codexHashBefore, stableDuringRun: codexStable },
    sourceTree,
    installedPlugin: publicInstalledPlugin(installedPlugin),
    deterministicBenchmark: deterministicBefore,
    provenance: {
      sourceStable,
      cacheStable,
      deterministicArtifactStable: deterministicStable,
      codexBinaryStable: codexStable,
      runtimeEquivalent,
      sourceAfter: sourceTreeAfter,
      cacheAfter: installedPluginAfter.cacheDigest,
    },
    sandbox: "workspaceWrite (verified response)",
    protocol: "app-server-stdio",
    approvalPolicy: "never",
    threadPersistence: "ephemeral",
    hookTrust: "persisted exact installed hook hashes (verified trusted before thread start)",
    environmentPolicy: "minimal system (including trusted Windows program roots) + explicit OpenAI API auth and proxy variables; endpoint override variables are stripped; the baseline disables exactly six FreshRead hooks with a process-local config override; FRESHREAD_TEST_MODE=1 uses a per-arm audit nonce",
    remainingEnvironmentClaim: "Effective configured MCP servers are dynamically disabled and rebound by config/read before any thread; Apps MCP is disabled and any MCP runtime startup notification invalidates the arm; the selected built-in OpenAI provider and default endpoints are fail-closed. Other user configuration remains shared across both arms.",
    baseline: baseline.report,
    freshread: freshread.report,
    launchGate: { deterministicEligible, liveEligible, runtimeEquivalent, releaseEligible },
    liveEligible,
    releaseEligible,
    passed: releaseEligible,
  };
  const written = writeArtifactSet(report, {
    arms: { baseline: baseline.eventEvidence, freshread: freshread.eventEvidence },
  });
  process.stdout.write(written.markdown);
  if (!releaseEligible) process.exitCode = 1;
}

async function entry() {
  const runId = createRunId();
  try {
    // Invalidate any previous PASS before preflight/model work. A crash leaves an
    // explicit IN_PROGRESS non-PASS artifact rather than a stale launch claim.
    writeNonPassArtifacts(runId, "IN_PROGRESS");
    await main(runId);
  } catch (error) {
    try { writeNonPassArtifacts(runId, "FAIL", error); }
    catch (artifactError) {
      process.stderr.write(`FreshRead could not write its failure artifact: ${artifactError.stack || artifactError.message}\n`);
    }
    process.stderr.write(`FreshRead live benchmark failed: ${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  auditCommandHashEvidence,
  buildChildEnv,
  buildFreshReadHookDisableOverride,
  buildMcpDisableOverride,
  finalAgentMessageEvidence,
  mcpServerInventoryFromRead,
  readBenchmarkAudit,
  readAndValidateProof,
  resolveMarketplaceName,
  validateMcpConfigIsolation,
  validateProviderConfigRead,
};

if (require.main === module) entry();
