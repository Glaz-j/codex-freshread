"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  canonicalPath,
  isWithin,
  pathKey,
  sameMetadata,
  sha256Text,
} = require("./freshread-core.cjs");
const {
  analysisCommandFromEvent,
  commandFromEvent,
  eventWorkingDirectory,
  hasDynamicSyntax,
  isFullyQualifiedPath,
  tokenizeShell,
} = require("./command-analyzer.cjs");

const EVIDENCE_SCHEMA_VERSION = 2;
const DEFAULT_MAX_VERIFIED_READ_BYTES = 16 * 1024 * 1024;
const MAX_EVIDENCE_FILE_BYTES = 1024 * 1024;
const EVIDENCE_TTL_MS = 15 * 60 * 1000;
const ABANDONED_TTL_MS = 24 * 60 * 60 * 1000;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

function finitePositive(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function evidenceDirectory(engine) {
  return path.join(engine.dataDir, "tool-evidence");
}

function evidencePaths(engine, toolUseId) {
  if (typeof toolUseId !== "string" || !toolUseId || toolUseId.length > 512) {
    throw new Error("tool_use_id is required for verified tool evidence");
  }
  const key = sha256Text(`${engine.sessionId}\u0000${pathKey(engine.cwd)}\u0000${toolUseId}`);
  const directory = evidenceDirectory(engine);
  return {
    directory,
    pendingPath: path.join(directory, `${key}.pending.json`),
    resultPath: path.join(directory, `${key}.result.json`),
  };
}

function ensureEvidenceDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const entry = fs.lstatSync(directory);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error("FreshRead evidence directory is not a regular directory");
  }
}

function safeUnlink(filePath) {
  try {
    const entry = fs.lstatSync(filePath);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(`refusing to remove non-regular evidence path: ${path.basename(filePath)}`);
    }
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function cleanupAbandoned(directory, now = Date.now()) {
  let names;
  try {
    names = fs.readdirSync(directory).slice(0, 512);
  } catch {
    return;
  }
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.(?:pending|result)\.json$/.test(name)) continue;
    const candidate = path.join(directory, name);
    try {
      const entry = fs.lstatSync(candidate);
      if (entry.isFile() && !entry.isSymbolicLink() && now - entry.mtimeMs > ABANDONED_TTL_MS) {
        fs.unlinkSync(candidate);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function writeJsonAtomic(filePath, value) {
  const serialized = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(serialized) > MAX_EVIDENCE_FILE_BYTES) {
    throw new Error("FreshRead tool evidence exceeds its 1 MiB safety limit");
  }
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = fs.openSync(tempPath, "wx", 0o600);
  try {
    fs.writeFileSync(handle, serialized, "utf8");
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  try {
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch {}
    throw error;
  }
}

function readJsonRegular(filePath) {
  const entry = fs.lstatSync(filePath);
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Error("tool evidence path is not a regular file");
  if (entry.size > MAX_EVIDENCE_FILE_BYTES) throw new Error("tool evidence exceeds its 1 MiB safety limit");
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function realWorkspaceRoot(cwd) {
  const lexicalRoot = path.resolve(cwd);
  const realRoot = path.normalize(fs.realpathSync.native(lexicalRoot));
  if (!fs.statSync(realRoot).isDirectory()) throw new Error("workspace root is not a directory");
  return realRoot;
}

function validatePendingWorkspace(pending, engine = null) {
  if (!pending || typeof pending !== "object" || Array.isArray(pending)) {
    throw new Error("tool evidence workspace is invalid");
  }
  if (typeof pending.cwd !== "string" || !pending.cwd || !path.isAbsolute(pending.cwd)) {
    throw new Error("tool evidence cwd is invalid");
  }
  const lexicalRoot = path.resolve(pending.cwd);
  if (pathKey(lexicalRoot) !== pathKey(path.normalize(pending.cwd))) {
    throw new Error("tool evidence cwd is not canonical");
  }
  if (typeof pending.realCwd !== "string" || !pending.realCwd || !path.isAbsolute(pending.realCwd)) {
    throw new Error("tool evidence real workspace root is invalid");
  }
  const persistedRealRoot = path.normalize(pending.realCwd);
  const currentRealRoot = realWorkspaceRoot(lexicalRoot);
  if (pathKey(currentRealRoot) !== pathKey(persistedRealRoot)) {
    throw new Error("tool evidence workspace root changed identity");
  }
  if (typeof pending.allowOutsideWorkspace !== "boolean") {
    throw new Error("tool evidence workspace policy is invalid");
  }
  if (!Number.isFinite(pending.maxFileBytes) || pending.maxFileBytes <= 0 ||
      !Number.isFinite(pending.maxVerifiedReadBytes) || pending.maxVerifiedReadBytes <= 0) {
    throw new Error("tool evidence safety limits are invalid");
  }
  if (!Array.isArray(pending.paths) || !pending.paths.length || pending.paths.some((item) => typeof item !== "string")) {
    throw new Error("tool evidence paths are invalid");
  }
  for (const item of pending.paths) {
    const canonical = canonicalPath(lexicalRoot, item);
    if (!path.isAbsolute(item) || !canonical || pathKey(canonical) !== pathKey(path.normalize(item))) {
      throw new Error("tool evidence path is not canonical");
    }
    if (!pending.allowOutsideWorkspace && !isWithin(lexicalRoot, canonical)) {
      throw new Error("tool evidence path is outside the workspace scope");
    }
  }
  if (engine) {
    if (pathKey(lexicalRoot) !== pathKey(engine.cwd) ||
        pathKey(persistedRealRoot) !== pathKey(engine.realCwd) ||
        pending.allowOutsideWorkspace !== engine.allowOutsideWorkspace) {
      throw new Error("tool evidence belongs to another workspace invocation");
    }
  }
  return { lexicalRoot, realRoot: persistedRealRoot };
}

function normalizeCommandName(token) {
  return path.basename(String(token || "")).toLowerCase().replace(/\.(exe|cmd|bat|ps1|sh)$/i, "");
}

function explicitShellFlavor(event) {
  const input = event && event.tool_input;
  if (!input || typeof input !== "object" || Array.isArray(input) || !Object.hasOwn(input, "shell")) {
    return { present: false, flavor: null };
  }
  if (typeof input.shell !== "string" || !input.shell.trim()) return { present: true, flavor: null };
  const shellText = input.shell.trim();
  const parsed = shellText.match(/^"([^"]+)"/) || shellText.match(/^'([^']+)'/) || shellText.match(/^(\S+)/);
  const raw = parsed ? (parsed[1] || parsed[0]) : shellText;
  const name = normalizeCommandName(raw);
  if (["powershell", "pwsh"].includes(name)) return { present: true, flavor: "powershell" };
  if (process.platform !== "win32" && ["bash", "sh", "dash", "zsh", "ksh"].includes(name)) {
    return { present: true, flavor: "posix" };
  }
  return { present: true, flavor: null };
}

function readShellFlavor(event, commandName) {
  const hint = explicitShellFlavor(event);
  if (hint.present) return hint.flavor;
  // Current Codex hook payloads can omit the per-tool shell. Only infer a
  // dialect from commands that are unambiguously PowerShell-specific.
  return commandName === "get-content" ? "powershell" : null;
}

function writeShellFlavor(event) {
  const hint = explicitShellFlavor(event);
  if (hint.present) return hint.flavor;
  return null;
}

function resolveExactReadPath(baseDir, scopeRoot, realScopeRoot, value) {
  const cleaned = String(value || "").trim().replace(/^[,]+|[,]$/g, "");
  if (hasDynamicSyntax(cleaned) || cleaned === "-") return null;
  const candidate = canonicalPath(baseDir, cleaned);
  if (!candidate || !isWithin(scopeRoot, candidate)) return null;
  try {
    if (!fs.statSync(candidate).isFile()) return null;
    const realPath = fs.realpathSync.native(candidate);
    if (!isWithin(realScopeRoot, realPath)) return null;
  } catch {
    return null;
  }
  return candidate;
}

function exactObservedReadPlan(event) {
  const toolName = String(event && event.tool_name || "").toLowerCase();
  if (!["bash", "shell_command", "exec_command", "unified_exec"].includes(toolName)) return null;
  const source = analysisCommandFromEvent(event);
  if (/[\r\n]/.test(source)) return null;
  const tokens = tokenizeShell(source);
  if (!tokens.length || tokens.some((token) => [";", "|", "&"].includes(token))) return null;
  const name = normalizeCommandName(tokens[0]);
  if (!["cat", "gc", "get-content", "type"].includes(name)) return null;

  const rawPaths = [];
  let rawMode = false;
  let utf8Encoding = false;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    const lower = token.toLowerCase();
    if (name === "cat" && lower === "--") continue;
    if ((name === "gc" || name === "get-content") && lower === "-raw") {
      rawMode = true;
      continue;
    }
    if ((name === "gc" || name === "get-content") && lower === "-encoding") {
      const encoding = String(tokens[index + 1] || "").toLowerCase();
      if (!["utf8", "utf8nobom"].includes(encoding)) return null;
      utf8Encoding = true;
      index += 1;
      continue;
    }
    if ((name === "gc" || name === "get-content") && ["-path", "-literalpath"].includes(lower)) {
      if (!tokens[index + 1]) return null;
      if (tokens[index + 1].includes(",")) return null;
      rawPaths.push(tokens[index + 1]);
      index += 1;
      continue;
    }
    if (token.startsWith("-")) return null;
    if (token.includes(",")) return null;
    rawPaths.push(token);
  }
  // Canonical shell output has no per-file framing. Even if the concatenated
  // bytes match at PostToolUse, bytes could have moved between two files after
  // the command ran. Only one file can therefore be proven without rewriting
  // the user's command.
  if (rawPaths.length !== 1) return null;
  if (["gc", "get-content"].includes(name) && (!rawMode || !utf8Encoding)) return null;

  const scopeRoot = path.resolve(event.cwd || process.cwd());
  let realScopeRoot;
  try {
    realScopeRoot = realWorkspaceRoot(scopeRoot);
  } catch {
    return null;
  }
  const baseDir = eventWorkingDirectory(event, scopeRoot);
  const input = event && event.tool_input;
  const hasExplicitToolCwd = Boolean(
    input && typeof input === "object" && !Array.isArray(input) &&
    ((typeof input.workdir === "string" && input.workdir) || (typeof input.cwd === "string" && input.cwd))
  );
  if (!hasExplicitToolCwd && rawPaths.some((item) => !isFullyQualifiedPath(String(item).trim()))) return null;
  const resolved = rawPaths.map((item) => resolveExactReadPath(baseDir, scopeRoot, realScopeRoot, item));
  if (resolved.some((item) => !item)) return null;
  return {
    command: source,
    commandName: name,
    paths: resolved,
    cwd: baseDir,
    scopeRoot,
    realScopeRoot,
    renderMode: ["gc", "get-content"].includes(name) ? "powershell-utf8-raw" : "raw-bytes",
  };
}

function exactShellReadPlan(event) {
  const plan = exactObservedReadPlan(event);
  if (!plan) return null;
  const shellFlavor = readShellFlavor(event, plan.commandName);
  if (!shellFlavor) return null;
  if (shellFlavor === "posix" && plan.commandName !== "cat") return null;
  return { ...plan, shellFlavor };
}

function preparePending(engine, event, kind, paths, extra = {}) {
  const locations = evidencePaths(engine, event.tool_use_id);
  ensureEvidenceDirectory(locations.directory);
  cleanupAbandoned(locations.directory);
  safeUnlink(locations.pendingPath);
  safeUnlink(locations.resultPath);
  const pending = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    kind,
    token: crypto.randomBytes(32).toString("hex"),
    createdAt: new Date().toISOString(),
    toolUseId: event.tool_use_id,
    sessionId: engine.sessionId,
    cwd: engine.cwd,
    realCwd: engine.realCwd,
    allowOutsideWorkspace: engine.allowOutsideWorkspace,
    maxFileBytes: engine.maxFileBytes,
    maxVerifiedReadBytes: finitePositive(
      process.env.FRESHREAD_VERIFIED_READ_MAX_BYTES,
      DEFAULT_MAX_VERIFIED_READ_BYTES,
    ),
    paths: paths.map((item) => canonicalPath(engine.cwd, item)),
    resultPath: locations.resultPath,
    ...extra,
  };
  validatePendingWorkspace(pending, engine);
  writeJsonAtomic(locations.pendingPath, pending);
  return { ...locations, pending };
}

function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function quotePosix(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function verifiedReaderCommand(pendingPath, shellFlavor) {
  const script = path.resolve(__dirname, "..", "scripts", "freshread-read.cjs");
  if (shellFlavor === "powershell") {
    return `& ${quotePowerShell(process.execPath)} ${quotePowerShell(script)} ${quotePowerShell(pendingPath)}`;
  }
  return `${quotePosix(process.execPath)} ${quotePosix(script)} ${quotePosix(pendingPath)}`;
}

function prepareVerifiedRead(engine, event) {
  const plan = exactShellReadPlan(event);
  if (!plan) return null;
  const maxVerifiedReadBytes = finitePositive(
    process.env.FRESHREAD_VERIFIED_READ_MAX_BYTES,
    DEFAULT_MAX_VERIFIED_READ_BYTES,
  );
  let totalBytes = 0;
  for (const filePath of plan.paths) {
    try {
      const entry = fs.statSync(filePath);
      totalBytes += entry.size;
      if (!entry.isFile() || entry.size > engine.maxFileBytes || totalBytes > maxVerifiedReadBytes) return null;
    } catch {
      return null;
    }
  }
  const prepared = preparePending(engine, event, "verified-read", plan.paths, {
    commandName: plan.commandName,
  });
  return {
    ...prepared,
    plan,
    command: verifiedReaderCommand(prepared.pendingPath, plan.shellFlavor),
  };
}

function prepareObservedRead(engine, event) {
  const plan = exactObservedReadPlan(event);
  if (!plan) return null;
  const maxVerifiedReadBytes = finitePositive(
    process.env.FRESHREAD_VERIFIED_READ_MAX_BYTES,
    DEFAULT_MAX_VERIFIED_READ_BYTES,
  );
  let totalBytes = 0;
  for (const filePath of plan.paths) {
    try {
      const entry = fs.statSync(filePath);
      totalBytes += entry.size;
      if (!entry.isFile() || entry.size > engine.maxFileBytes || totalBytes > maxVerifiedReadBytes) return null;
    } catch {
      return null;
    }
  }
  return {
    ...preparePending(engine, event, "observed-read", plan.paths, {
      commandName: plan.commandName,
      renderMode: plan.renderMode,
    }),
    plan,
  };
}

function shellOutcomeCommand(originalCommand, pending, shellFlavor) {
  const resultPath = pending.resultPath;
  const tokenPrefix = pending.token.slice(0, 12);
  if (shellFlavor === "powershell") {
    const ok = `$frOk_${tokenPrefix}`;
    const code = `$frCode_${tokenPrefix}`;
    return [
      "& {",
      originalCommand,
      "}",
      `${ok} = $?`,
      `if (${ok}) { ${code} = 0 } elseif ($null -ne $LASTEXITCODE) { ${code} = [int]$LASTEXITCODE } else { ${code} = 1 }`,
      `[System.IO.File]::WriteAllText(${quotePowerShell(resultPath)}, ${quotePowerShell(`${pending.token}:`)} + [string]${code}, [System.Text.UTF8Encoding]::new($false))`,
      `exit ${code}`,
    ].join("\n");
  }
  const variable = `fr_code_${tokenPrefix}`;
  return `{\n${originalCommand}\n}\n${variable}=$?\nprintf '%s' ${quotePosix(`${pending.token}:`)}"$${variable}" > ${quotePosix(resultPath)}\nexit "$${variable}"`;
}

function prepareShellOutcome(engine, event, writePaths) {
  if (!writePaths || !writePaths.length) return null;
  const originalCommand = commandFromEvent(event);
  if (!originalCommand) return null;
  const shellFlavor = writeShellFlavor(event);
  if (!shellFlavor) return null;
  const prepared = preparePending(engine, event, "shell-outcome", writePaths);
  return {
    ...prepared,
    shellFlavor,
    command: shellOutcomeCommand(originalCommand, prepared.pending, shellFlavor),
  };
}

function validMetadata(value) {
  return Boolean(
    value && typeof value === "object" && !Array.isArray(value) &&
    typeof value.realPath === "string" && value.realPath && path.isAbsolute(value.realPath) &&
    Number.isSafeInteger(value.size) && value.size >= 0 &&
    ["mtimeNs", "ctimeNs", "dev", "ino"].every((key) => typeof value[key] === "string" && /^\d+$/.test(value[key]))
  );
}

function consumeToolEvidence(engine, event) {
  let locations;
  try {
    locations = evidencePaths(engine, event.tool_use_id);
  } catch {
    return null;
  }
  if (!fs.existsSync(locations.pendingPath)) return null;
  let pending;
  let result;
  try {
    pending = readJsonRegular(locations.pendingPath);
    if (pending.schemaVersion !== EVIDENCE_SCHEMA_VERSION || !["verified-read", "observed-read", "shell-outcome"].includes(pending.kind)) {
      throw new Error("unsupported tool evidence schema or kind");
    }
    if (pending.toolUseId !== event.tool_use_id || pending.sessionId !== engine.sessionId || pathKey(pending.cwd) !== pathKey(engine.cwd)) {
      throw new Error("tool evidence belongs to another invocation");
    }
    if (!/^[a-f0-9]{64}$/.test(pending.token || "")) throw new Error("tool evidence token is invalid");
    if (!Number.isFinite(Date.parse(pending.createdAt)) || Date.now() - Date.parse(pending.createdAt) > EVIDENCE_TTL_MS) {
      throw new Error("tool evidence expired");
    }
    const workspace = validatePendingWorkspace(pending, engine);
    if (pathKey(pending.resultPath) !== pathKey(locations.resultPath)) throw new Error("tool evidence result path is invalid");

    if (pending.kind === "observed-read") {
      result = observeReadEvidence(pending, event.tool_response);
    } else if (pending.kind === "shell-outcome") {
      const entry = fs.lstatSync(locations.resultPath);
      if (entry.isSymbolicLink() || !entry.isFile() || entry.size > 1024) throw new Error("shell outcome is not a small regular file");
      const text = fs.readFileSync(locations.resultPath, "utf8");
      const match = text.match(new RegExp(`^${pending.token}:(-?\\d+)$`));
      if (!match) throw new Error("shell outcome token is invalid");
      result = { kind: pending.kind, success: Number(match[1]) === 0, exitCode: Number(match[1]), paths: pending.paths };
    } else {
      const evidence = readJsonRegular(locations.resultPath);
      if (evidence.schemaVersion !== EVIDENCE_SCHEMA_VERSION || evidence.kind !== "verified-read" || evidence.token !== pending.token) {
        throw new Error("verified read result token is invalid");
      }
      if (!Array.isArray(evidence.entries) || evidence.entries.length !== pending.paths.length) {
        throw new Error("verified read result paths are incomplete");
      }
      const expected = new Set(pending.paths.map(pathKey));
      for (const item of evidence.entries) {
        if (!item || !expected.has(pathKey(item.path || "")) || !HASH_PATTERN.test(item.hash || "") || !validMetadata(item.metadata) ||
            (!pending.allowOutsideWorkspace && !isWithin(workspace.realRoot, path.normalize(item.metadata.realPath)))) {
          throw new Error("verified read result entry is invalid");
        }
      }
      result = { kind: pending.kind, success: true, paths: pending.paths, entries: evidence.entries };
    }
  } catch (error) {
    result = {
      kind: pending && pending.kind || "unknown",
      success: false,
      paths: pending && Array.isArray(pending.paths) ? pending.paths : [],
      detail: error.message,
    };
  } finally {
    safeUnlink(locations.resultPath);
    safeUnlink(locations.pendingPath);
  }
  return result;
}

function bigintString(value, fallbackMs) {
  if (typeof value === "bigint") return value.toString();
  return String(Math.round(Number(fallbackMs || 0) * 1_000_000));
}

function metadataFromStat(stat, realPath) {
  return {
    realPath,
    size: Number(stat.size),
    mtimeNs: bigintString(stat.mtimeNs, stat.mtimeMs),
    ctimeNs: bigintString(stat.ctimeNs, stat.ctimeMs),
    dev: String(stat.dev),
    ino: String(stat.ino),
  };
}

function stableRead(filePath, pending, remainingBytes) {
  const workspace = validatePendingWorkspace(pending);
  const canonical = canonicalPath(workspace.lexicalRoot, filePath);
  if (!canonical || (!pending.allowOutsideWorkspace && !isWithin(workspace.lexicalRoot, canonical))) {
    throw new Error("verified read path is outside the workspace scope");
  }
  const readPath = fs.realpathSync.native(canonical);
  if (!pending.allowOutsideWorkspace && !isWithin(workspace.realRoot, readPath)) {
    throw new Error("verified read symlink target is outside the workspace scope");
  }
  const descriptor = fs.openSync(readPath, "r");
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) throw new Error("verified read target is not a regular file");
    if (Number(before.size) > pending.maxFileBytes) throw new Error("verified read target exceeds the file safety limit");
    if (Number(before.size) > remainingBytes) throw new Error("verified read output exceeds its aggregate safety limit");

    const currentRealPath = fs.realpathSync.native(readPath);
    if (!pending.allowOutsideWorkspace && !isWithin(workspace.realRoot, currentRealPath)) {
      throw new Error("verified read target escaped the workspace scope");
    }
    const pathBefore = fs.statSync(readPath, { bigint: true });
    const beforeMetadata = metadataFromStat(before, currentRealPath);
    if (!sameMetadata(beforeMetadata, metadataFromStat(pathBefore, currentRealPath))) {
      throw new Error("verified read target changed identity before reading");
    }

    const buffer = Buffer.allocUnsafe(Number(before.size));
    let offset = 0;
    while (offset < buffer.length) {
      const count = fs.readSync(descriptor, buffer, offset, buffer.length - offset, null);
      if (!count) break;
      offset += count;
    }
    const overflow = Buffer.allocUnsafe(1);
    const overflowCount = fs.readSync(descriptor, overflow, 0, 1, null);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const finalRealPath = fs.realpathSync.native(readPath);
    const pathAfter = fs.statSync(readPath, { bigint: true });
    const afterMetadata = metadataFromStat(after, finalRealPath);
    if (offset !== buffer.length || overflowCount !== 0 ||
        pathKey(finalRealPath) !== pathKey(currentRealPath) ||
        !sameMetadata(beforeMetadata, afterMetadata) ||
        !sameMetadata(afterMetadata, metadataFromStat(pathAfter, finalRealPath))) {
      throw new Error("file changed during verified read");
    }
    return {
      path: canonical,
      realPath: finalRealPath,
      buffer,
      hash: crypto.createHash("sha256").update(buffer).digest("hex"),
      metadata: afterMetadata,
      readAt: new Date().toISOString(),
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function observeReadEvidence(pending, toolResponse) {
  if (typeof toolResponse !== "string") {
    throw new Error("observed read response is not the canonical raw shell string");
  }
  const responseBuffer = Buffer.from(toolResponse, "utf8");
  const maxBytes = finitePositive(pending.maxVerifiedReadBytes, DEFAULT_MAX_VERIFIED_READ_BYTES);
  if (responseBuffer.length === 0) throw new Error("empty output cannot prove a successful complete-file read");
  if (responseBuffer.length > maxBytes) throw new Error("observed read response exceeds its safety limit");

  const reads = [];
  const expected = crypto.createHash("sha256");
  let sourceBytes = 0;
  let renderedBytes = 0;
  for (const filePath of pending.paths) {
    const item = stableRead(filePath, pending, maxBytes - sourceBytes);
    sourceBytes += item.buffer.length;
    let rendered = item.buffer;
    if (pending.renderMode === "powershell-utf8-raw") {
      const hasBom = rendered.length >= 3 && rendered[0] === 0xef && rendered[1] === 0xbb && rendered[2] === 0xbf;
      const utf8Bytes = hasBom ? rendered.subarray(3) : rendered;
      const text = utf8Bytes.toString("utf8");
      if (!Buffer.from(text, "utf8").equals(utf8Bytes)) {
        throw new Error("PowerShell observed reads require valid UTF-8 file content");
      }
      rendered = Buffer.from(text + (process.platform === "win32" ? "\r\n" : "\n"), "utf8");
    } else if (pending.renderMode !== "raw-bytes") {
      throw new Error("observed read render mode is invalid");
    }
    renderedBytes += rendered.length;
    expected.update(rendered);
    reads.push(item);
  }
  if (sourceBytes === 0) throw new Error("empty file output cannot prove a successful complete-file read");
  const observedHash = crypto.createHash("sha256").update(responseBuffer).digest("hex");
  if (renderedBytes !== responseBuffer.length || expected.digest("hex") !== observedHash) {
    throw new Error("shell output does not exactly match the current complete file bytes");
  }
  return {
    kind: "observed-read",
    success: true,
    paths: pending.paths,
    entries: reads.map(({ buffer, realPath, ...item }) => item),
  };
}

function loadPendingForReader(pendingPath) {
  const absolute = path.resolve(pendingPath);
  const pending = readJsonRegular(absolute);
  if (pending.schemaVersion !== EVIDENCE_SCHEMA_VERSION || pending.kind !== "verified-read") {
    throw new Error("reader received unsupported pending evidence");
  }
  if (!/^[a-f0-9]{64}$/.test(pending.token || "") || !Array.isArray(pending.paths) || !pending.paths.length) {
    throw new Error("reader pending evidence is invalid");
  }
  validatePendingWorkspace(pending);
  const directory = path.dirname(absolute);
  if (pathKey(path.dirname(path.resolve(pending.resultPath))) !== pathKey(directory)) {
    throw new Error("reader result path escapes its evidence directory");
  }
  return pending;
}

function executeVerifiedRead(pendingPath, outputFd = 1) {
  const pending = loadPendingForReader(pendingPath);
  const maxBytes = finitePositive(pending.maxVerifiedReadBytes, DEFAULT_MAX_VERIFIED_READ_BYTES);
  const reads = [];
  let totalBytes = 0;
  for (const filePath of pending.paths) {
    const item = stableRead(filePath, pending, maxBytes - totalBytes);
    totalBytes += item.buffer.length;
    reads.push(item);
  }
  for (const item of reads) {
    let offset = 0;
    while (offset < item.buffer.length) offset += fs.writeSync(outputFd, item.buffer, offset, item.buffer.length - offset);
  }
  writeJsonAtomic(pending.resultPath, {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    kind: "verified-read",
    token: pending.token,
    entries: reads.map(({ buffer, realPath, ...item }) => item),
  });
  return reads.map(({ buffer, ...item }) => item);
}

module.exports = {
  DEFAULT_MAX_VERIFIED_READ_BYTES,
  EVIDENCE_SCHEMA_VERSION,
  consumeToolEvidence,
  evidencePaths,
  exactObservedReadPlan,
  exactShellReadPlan,
  executeVerifiedRead,
  prepareShellOutcome,
  prepareObservedRead,
  prepareVerifiedRead,
  shellOutcomeCommand,
};
