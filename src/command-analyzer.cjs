"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { canonicalPath, isWithin, pathKey } = require("./freshread-core.cjs");

const READ_COMMANDS = new Set([
  "cat",
  "gc",
  "get-content",
  "head",
  "tail",
  "type",
  "format-hex",
  "select-string",
]);
const DIRECT_WRITE_COMMANDS = new Set([
  "add-content",
  "clear-content",
  "del",
  "erase",
  "remove-item",
  "rm",
  "set-content",
  "touch",
]);
const COPY_MOVE_COMMANDS = new Set(["copy-item", "cp", "move-item", "mv", "rename-item", "ren"]);
const READ_OPTION_VALUES = new Set([
  "-encoding",
  "-filter",
  "-include",
  "-exclude",
  "-readcount",
  "-tail",
  "-totalcount",
]);
const PATH_OPTIONS = new Set(["-literalpath", "-path"]);
const SET_ADD_OPTION_VALUES = new Set([...READ_OPTION_VALUES, "-value"]);
const OUT_FILE_OPTION_VALUES = new Set([...READ_OPTION_VALUES, "-inputobject"]);
const COPY_MOVE_PATH_OPTIONS = new Set([
  ...PATH_OPTIONS,
  "-destination",
  "-newname",
  "-t",
  "--target-directory",
]);
const OUT_FILE_PATH_OPTIONS = new Set([...PATH_OPTIONS, "-filepath"]);

function commandFromEvent(event) {
  const input = event && event.tool_input;
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return "";
  return input.command || input.cmd || (input.args && input.args.command) || "";
}

function unwrapKnownShellCarrier(source) {
  const text = String(source || "").trim();
  const match = text.match(/^(?:"([^"\r\n]+)"|(\S+))\s+(?:-(?:NoLogo|NoProfile|NonInteractive)\s+)*-(?:Command|C)\s+"([\s\S]*)"$/i);
  if (!match) return text;
  const executable = match[1] || match[2];
  const executableName = path.basename(executable).toLowerCase().replace(/\.exe$/i, "");
  const absoluteExecutable = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(executable) || path.isAbsolute(executable);
  if (!absoluteExecutable || !["powershell", "pwsh"].includes(executableName)) return text;
  return match[3];
}

function analysisCommandFromEvent(event) {
  return unwrapKnownShellCarrier(commandFromEvent(event));
}

function eventWorkingDirectory(event, fallbackCwd) {
  const input = event && event.tool_input;
  const requested = input && typeof input === "object" ? input.workdir || input.cwd : null;
  return canonicalPath(fallbackCwd, requested || fallbackCwd) || path.resolve(fallbackCwd);
}

function tokenizeShell(source) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaped = false;
  const push = () => {
    if (current) tokens.push(current);
    current = "";
  };
  for (let i = 0; i < String(source).length; i += 1) {
    const char = source[i];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"') {
        // PowerShell treats backslashes as ordinary path separators inside
        // double quotes. Only consume one when it is escaping a quote in a
        // POSIX-style command; otherwise preserve it verbatim.
        if (source[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          current += char;
        }
      }
      else if (char === "`" && quote === '"') escaped = true;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      push();
      continue;
    }
    if (";|&".includes(char)) {
      push();
      tokens.push(char);
      continue;
    }
    if (char === "\\") {
      const next = source[i + 1];
      if (next && /[\s;|&<>]/.test(next)) {
        current += next;
        i += 1;
      } else {
        current += char;
      }
      continue;
    }
    current += char;
  }
  push();
  return tokens;
}

function commandSegments(source) {
  const tokens = tokenizeShell(source);
  const segments = [];
  let segment = [];
  for (const token of tokens) {
    if ([";", "|", "&"].includes(token)) {
      if (segment.length) segments.push(segment);
      segment = [];
    } else {
      segment.push(token);
    }
  }
  if (segment.length) segments.push(segment);
  return segments;
}

function normalizeCommandName(token) {
  return path.basename(String(token || "")).toLowerCase().replace(/\.(exe|cmd|bat|ps1|sh)$/i, "");
}

function cleanCandidate(value) {
  return String(value || "")
    .trim()
    .replace(/^[,([{]+/, "")
    .replace(/[,\])}]+$/, "");
}

function hasDynamicSyntax(value) {
  const text = String(value || "");
  return !text ||
    /[*?\[\]{}\n\r$`]/.test(text) ||
    /%[^%\r\n]+%/.test(text) ||
    /![^!\r\n]+!/.test(text) ||
    /^~(?:[\\/]|$)/.test(text) ||
    /^(https?|file):\/\//i.test(text);
}

function isFullyQualifiedPath(value) {
  if (process.platform === "win32") {
    return /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(value);
  }
  return path.isAbsolute(value);
}

function resolveCandidate(baseDir, value, {
  mustExist = false,
  scopeRoot = baseDir,
  absoluteOnly = false,
  diagnostics = null,
} = {}) {
  const cleaned = cleanCandidate(value);
  if (hasDynamicSyntax(cleaned) || cleaned === "-" || /^\d+$/.test(cleaned)) {
    if (diagnostics && Array.isArray(diagnostics.unresolvedTargets)) {
      diagnostics.unresolvedTargets.push(String(value || ""));
    }
    return null;
  }
  if (absoluteOnly && !isFullyQualifiedPath(cleaned)) {
    if (diagnostics) diagnostics.relativeTargets.push(cleaned);
    return null;
  }
  const candidate = canonicalPath(baseDir, cleaned);
  if (!candidate || !isWithin(scopeRoot, candidate)) {
    if (diagnostics && Array.isArray(diagnostics.unresolvedTargets)) {
      diagnostics.unresolvedTargets.push(String(value || ""));
    }
    return null;
  }
  if (mustExist) {
    try {
      if (!fs.statSync(candidate).isFile()) return null;
    } catch {
      return null;
    }
  }
  return candidate;
}

function resolveLiteralCandidate(baseDir, value, scopeRoot = baseDir) {
  const literal = String(value || "").trim();
  if (!literal || /[\0\r\n]/.test(literal)) return null;
  const candidate = canonicalPath(baseDir, literal);
  if (!candidate || !isWithin(scopeRoot, candidate)) return null;
  return candidate;
}

function dedupe(paths) {
  const map = new Map();
  for (const filePath of paths.filter(Boolean)) map.set(pathKey(filePath), filePath);
  return [...map.values()];
}

function inlineOption(token) {
  const match = String(token || "").match(/^(-{1,2}[A-Za-z][A-Za-z0-9-]*)([:=])([\s\S]*)$/);
  return match ? { name: match[1].toLowerCase(), value: match[3] } : null;
}

function markUnresolved(diagnostics, value) {
  if (diagnostics && Array.isArray(diagnostics.unresolvedTargets)) {
    diagnostics.unresolvedTargets.push(String(value || "unknown write target"));
  }
}

function optionPathTokenGroups(
  tokens,
  commandIndex,
  pathOptions = PATH_OPTIONS,
  optionValues = READ_OPTION_VALUES,
  diagnostics = null,
) {
  const explicit = [];
  const positional = [];
  const ordered = [];
  let skipNext = false;
  let optionsEnded = false;
  for (let i = commandIndex + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    const lower = token.toLowerCase();
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (!optionsEnded && token === "--") {
      optionsEnded = true;
      continue;
    }
    const inline = !optionsEnded ? inlineOption(token) : null;
    if (inline && pathOptions.has(inline.name)) {
      if (inline.value) {
        const values = inline.value.split(",");
        explicit.push(...values);
        ordered.push(...values);
      } else {
        markUnresolved(diagnostics, token);
      }
      continue;
    }
    if (inline && optionValues.has(inline.name)) continue;
    if (inline) {
      // An unrecognized inline option can hide its value from positional
      // parsing (notably abbreviated PowerShell parameters such as -Dest:).
      // Do not guess whether it is a path or a non-path value.
      markUnresolved(diagnostics, token);
      continue;
    }
    if (!optionsEnded && pathOptions.has(lower)) {
      if (tokens[i + 1] && tokens[i + 1] !== "--") {
        const values = tokens[i + 1].split(",");
        explicit.push(...values);
        ordered.push(...values);
        i += 1;
      } else {
        markUnresolved(diagnostics, token);
      }
      continue;
    }
    if (!optionsEnded && optionValues.has(lower)) {
      if (tokens[i + 1] && tokens[i + 1] !== "--") skipNext = true;
      else markUnresolved(diagnostics, token);
      continue;
    }
    if (!optionsEnded && token.startsWith("-")) {
      const knownNames = [...pathOptions, ...optionValues];
      if (knownNames.some((name) => name.startsWith(lower))) {
        // PowerShell permits unambiguous parameter abbreviations. Without the
        // complete command metadata, treating the following token as
        // positional can guard a decoy instead of the real target.
        markUnresolved(diagnostics, token);
      }
      continue;
    }
    const values = token.split(",");
    positional.push(...values);
    ordered.push(...values);
  }
  return { explicit, positional, ordered };
}

function optionPathTokens(tokens, commandIndex) {
  const { explicit, positional } = optionPathTokenGroups(tokens, commandIndex);
  return explicit.length ? explicit : positional;
}

function hasNamedOption(tokens, commandIndex, name) {
  const expected = String(name).toLowerCase();
  return tokens.slice(commandIndex + 1).some((token) => {
    const parsed = inlineOption(token);
    return token.toLowerCase() === expected || (parsed && parsed.name === expected);
  });
}

function sedWriteTargetTokens(tokens, commandIndex, diagnostics = null) {
  const targets = [];
  let optionsEnded = false;
  let explicitScript = false;
  let implicitScriptConsumed = false;
  for (let index = commandIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    const lower = token.toLowerCase();
    if (!optionsEnded && token === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && ["-e", "--expression", "-f", "--file"].includes(lower)) {
      explicitScript = true;
      if (tokens[index + 1] && tokens[index + 1] !== "--") index += 1;
      else markUnresolved(diagnostics, token);
      continue;
    }
    if (!optionsEnded && (
      /^-e.+/.test(token) || /^-f.+/.test(token) ||
      /^--(?:expression|file)=.+/i.test(token)
    )) {
      explicitScript = true;
      continue;
    }
    if (!optionsEnded && (lower === "-l" || lower === "--line-length")) {
      if (tokens[index + 1] && tokens[index + 1] !== "--") index += 1;
      else markUnresolved(diagnostics, token);
      continue;
    }
    if (!optionsEnded && /^--line-length=.+/i.test(token)) continue;
    if (!optionsEnded && token.startsWith("-")) {
      const knownSwitch = /^(?:-i.*|-n|-e|-r|-s|-u|-z|-b|--in-place(?:=.*)?|--quiet|--silent|--regexp-extended|--separate|--unbuffered|--null-data|--binary|--follow-symlinks|--posix|--sandbox|--debug)$/i.test(token);
      if (!knownSwitch) markUnresolved(diagnostics, token);
      continue;
    }
    if (!explicitScript && !implicitScriptConsumed) {
      implicitScriptConsumed = true;
      continue;
    }
    targets.push(token);
  }
  if (!targets.length) markUnresolved(diagnostics, "sed -i input file");
  return targets;
}

function isSedInPlaceOption(token) {
  const value = String(token || "").toLowerCase();
  return value === "--in-place" || value.startsWith("--in-place=") || /^-[^-]*i/.test(value);
}

function responseText(response, seen = new Set()) {
  if (typeof response === "string") return response;
  if (response == null || typeof response !== "object" || seen.has(response)) return "";
  seen.add(response);
  if (Array.isArray(response)) return response.map((item) => responseText(item, seen)).filter(Boolean).join("\n");
  const preferredKeys = ["output", "stdout", "aggregated_output", "text", "content"];
  return preferredKeys
    .filter((key) => Object.hasOwn(response, key))
    .map((key) => responseText(response[key], seen))
    .filter(Boolean)
    .join("\n");
}

function responseFilePaths(response, baseDir, scopeRoot = baseDir) {
  const paths = [];
  for (const line of responseText(response).split(/\r?\n/)) {
    const match = line.match(/^(.+?):\d+(?::\d+)?:/);
    if (!match) continue;
    const candidate = resolveCandidate(baseDir, match[1], { mustExist: true, scopeRoot });
    if (candidate) paths.push(candidate);
  }
  return dedupe(paths);
}

function readPathsFromCommand(command, baseDir, response, scopeRoot = baseDir) {
  const paths = [];
  for (const tokens of commandSegments(command)) {
    if (!tokens.length) continue;
    const names = tokens.map(normalizeCommandName);
    const index = names.findIndex((name) => READ_COMMANDS.has(name) || name === "rg" || name === "ripgrep" || name === "sed");
    if (index < 0) continue;
    const name = names[index];
    if ((name === "rg" || name === "ripgrep") && tokens.some((token) => token === "--files" || token.startsWith("--files="))) continue;
    let candidates = optionPathTokens(tokens, index);
    if (name === "sed") candidates = candidates.slice(1);
    if (name === "rg" || name === "ripgrep") {
      // The first positional argument is normally the search pattern.
      if (candidates.length > 1) candidates = candidates.slice(1);
      paths.push(...responseFilePaths(response, baseDir, scopeRoot));
    }
    for (const candidate of candidates) {
      const resolved = resolveCandidate(baseDir, candidate, { mustExist: true, scopeRoot });
      if (resolved) paths.push(resolved);
    }
  }
  return dedupe(paths);
}

function readShellWord(source, start) {
  let value = "";
  let quote = null;
  let index = start;
  while (index < source.length) {
    const char = source[index];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === "`" && quote === '"' && index + 1 < source.length) {
        index += 1;
        value += source[index];
      } else if (char === "\\" && quote === '"' && source[index + 1] === '"') {
        index += 1;
        value += source[index];
      } else {
        value += char;
      }
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      index += 1;
      continue;
    }
    if (char === "\\" && source[index + 1] && /[\s;|&<>]/.test(source[index + 1])) {
      index += 1;
      value += source[index];
      index += 1;
      continue;
    }
    if (/\s/.test(char) || ";|&".includes(char)) break;
    value += char;
    index += 1;
  }
  return { value, nextIndex: index };
}

function redirectionPaths(command, baseDir, scopeRoot = baseDir, options = {}) {
  const paths = [];
  const source = String(command || "");
  let quote = null;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "`" && quote === '"') index += 1;
      else if (char === "\\" && quote === '"' && source[index + 1] === '"') index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (["\\", "`", "^"].includes(char) && source[index + 1] === ">") {
      index += 1;
      continue;
    }
    if (char !== ">" || source[index - 1] === "<") continue;
    if (source[index + 1] === ">" || source[index + 1] === "|") index += 1;
    let targetStart = index + 1;
    while (/\s/.test(source[targetStart] || "")) targetStart += 1;
    if (!source[targetStart] || ";|&<>".includes(source[targetStart])) continue;
    const parsed = readShellWord(source, targetStart);
    const candidate = resolveCandidate(baseDir, parsed.value, { scopeRoot, ...options });
    if (candidate) paths.push(candidate);
    index = Math.max(index, parsed.nextIndex - 1);
  }
  return paths;
}

function writePathsFromCommand(command, baseDir, scopeRoot = baseDir, options = {}) {
  const paths = [...redirectionPaths(command, baseDir, scopeRoot, options)];
  for (const tokens of commandSegments(command)) {
    if (!tokens.length) continue;
    const names = tokens.map(normalizeCommandName);
    const commandIndex = names.findIndex((name) =>
      DIRECT_WRITE_COMMANDS.has(name) || COPY_MOVE_COMMANDS.has(name) || name === "out-file" || name === "sed" || name === "prettier"
    );
    if (commandIndex < 0) continue;
    const name = names[commandIndex];
    if (name === "sed" && !tokens.some(isSedInPlaceOption)) continue;
    if (name === "prettier" && !tokens.some((token) => token === "--write" || token === "-w")) continue;
    let candidates;
    if (COPY_MOVE_COMMANDS.has(name)) {
      const groups = optionPathTokenGroups(
        tokens,
        commandIndex,
        COPY_MOVE_PATH_OPTIONS,
        READ_OPTION_VALUES,
        options.diagnostics,
      );
      candidates = groups.ordered;
    } else if (name === "sed") {
      candidates = sedWriteTargetTokens(tokens, commandIndex, options.diagnostics);
    } else if (name === "out-file") {
      const groups = optionPathTokenGroups(
        tokens,
        commandIndex,
        OUT_FILE_PATH_OPTIONS,
        OUT_FILE_OPTION_VALUES,
        options.diagnostics,
      );
      candidates = groups.explicit.length ? groups.explicit : groups.positional.slice(-1);
    } else if (name === "set-content" || name === "add-content") {
      const groups = optionPathTokenGroups(
        tokens,
        commandIndex,
        PATH_OPTIONS,
        SET_ADD_OPTION_VALUES,
        options.diagnostics,
      );
      candidates = groups.explicit.length ? groups.explicit : groups.positional;
      if (!groups.explicit.length && !hasNamedOption(tokens, commandIndex, "-value")) {
        candidates = candidates.slice(0, 1);
      }
    } else {
      const groups = optionPathTokenGroups(
        tokens,
        commandIndex,
        PATH_OPTIONS,
        READ_OPTION_VALUES,
        options.diagnostics,
      );
      candidates = groups.explicit.length ? groups.explicit : groups.positional;
    }
    if (name === "prettier") {
      candidates = candidates.filter((token) => token !== "--write" && token !== "-w");
    }
    if (!candidates.length) markUnresolved(options.diagnostics, `${name} target`);
    for (const candidate of candidates) {
      const resolved = resolveCandidate(baseDir, candidate, { scopeRoot, ...options });
      if (resolved) paths.push(resolved);
    }
  }
  return dedupe(paths);
}

function extractPatchPaths(patchText, baseDir, scopeRoot = baseDir, diagnostics = null) {
  const writes = [];
  const text = String(patchText || "");
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+?)\s*$/) || line.match(/^\*\*\* Move to:\s*(.+?)\s*$/);
    if (!match) continue;
    if (diagnostics) diagnostics.targetCount += 1;
    const resolved = resolveLiteralCandidate(baseDir, match[1], scopeRoot);
    if (resolved) writes.push(resolved);
    else if (diagnostics) diagnostics.rejectedCount += 1;
  }
  return dedupe(writes);
}

function collectPathArguments(value, output = []) {
  if (!value || typeof value !== "object") return output;
  for (const [key, child] of Object.entries(value)) {
    if (["path", "file", "file_path", "filepath", "filename"].includes(key.toLowerCase()) && typeof child === "string") output.push(child);
    else if (Array.isArray(child)) child.forEach((item) => collectPathArguments(item, output));
    else if (child && typeof child === "object") collectPathArguments(child, output);
  }
  return output;
}

function toolSucceeded(response, toolName = "") {
  if (typeof response === "string") {
    const canonicalTool = String(toolName || "").toLowerCase();
    if (["apply_patch", "edit", "write"].includes(canonicalTool)) {
      return /^(?:Exit code:\s*0\b[\s\S]*\bSuccess\.|Success\.)/i.test(response.trim());
    }
    // Codex intentionally sends Bash hooks only raw stdout/stderr, without an
    // exit code. A string therefore cannot prove success. Direct integrations
    // with an explicit compatible shell can use nonce-bound outcome evidence;
    // canonical hook payloads remain conservatively unattributed.
    return false;
  }
  if (!response || typeof response !== "object") return false;
  if (response.isError === true || response.error) return false;
  let hasPositiveSignal = false;
  for (const key of ["exit_code", "exitCode", "statusCode"]) {
    if (typeof response[key] === "number") {
      hasPositiveSignal = true;
      if (response[key] !== 0) return false;
    }
  }
  for (const key of ["success", "ok"]) {
    if (typeof response[key] === "boolean") {
      hasPositiveSignal = true;
      if (!response[key]) return false;
    }
  }
  return hasPositiveSignal;
}

function analyzeToolEvent(event, phase = "post") {
  const cwd = path.resolve(event.cwd || process.cwd());
  const baseDir = eventWorkingDirectory(event, cwd);
  const toolName = String(event.tool_name || "");
  const canonicalTool = toolName.toLowerCase();
  let readPaths = [];
  let writePaths = [];
  let coverage = "unsupported";
  let deterministicWriteTool = false;
  let incompleteDeterministicTargets = false;
  let ambiguousShellWorkingDirectory = false;

  if (["apply_patch", "edit", "write"].includes(canonicalTool)) {
    deterministicWriteTool = true;
    if (canonicalTool === "apply_patch") {
      const diagnostics = { targetCount: 0, rejectedCount: 0 };
      writePaths = extractPatchPaths(commandFromEvent(event), baseDir, cwd, diagnostics);
      incompleteDeterministicTargets = diagnostics.rejectedCount > 0;
    } else {
      const rawPaths = collectPathArguments(event.tool_input);
      writePaths = rawPaths.map((item) => resolveLiteralCandidate(baseDir, item, cwd)).filter(Boolean);
      incompleteDeterministicTargets = writePaths.length !== rawPaths.length;
      if (!writePaths.length && commandFromEvent(event)) {
        const diagnostics = { targetCount: 0, rejectedCount: 0 };
        writePaths = extractPatchPaths(commandFromEvent(event), baseDir, cwd, diagnostics);
        incompleteDeterministicTargets ||= diagnostics.rejectedCount > 0;
      }
    }
    coverage = writePaths.length ? "exact" : "unsupported";
  } else if (["bash", "shell_command", "exec_command", "unified_exec"].includes(canonicalTool)) {
    const command = analysisCommandFromEvent(event);
    const input = event && event.tool_input;
    const hasExplicitToolCwd = Boolean(
      input && typeof input === "object" && !Array.isArray(input) &&
      ((typeof input.workdir === "string" && input.workdir) || (typeof input.cwd === "string" && input.cwd))
    );
    const writeDiagnostics = { relativeTargets: [], unresolvedTargets: [] };
    writePaths = writePathsFromCommand(command, baseDir, cwd, {
      absoluteOnly: !hasExplicitToolCwd,
      diagnostics: writeDiagnostics,
    });
    ambiguousShellWorkingDirectory = writeDiagnostics.relativeTargets.length > 0;
    incompleteDeterministicTargets = writeDiagnostics.unresolvedTargets.length > 0;
    if (phase === "post") readPaths = readPathsFromCommand(command, baseDir, event.tool_response, cwd);
    coverage = readPaths.length || writePaths.length ? "heuristic" : "unsupported";
  } else if (
    canonicalTool === "view_image" ||
    /(?:^|__)(?:read_file|get_file|view_file|read_text)(?:$|__)/i.test(toolName)
  ) {
    readPaths = collectPathArguments(event.tool_input)
      .map((item) => resolveCandidate(baseDir, item, { mustExist: true, scopeRoot: cwd }))
      .filter(Boolean);
    coverage = readPaths.length ? "exact" : "unsupported";
  }

  const writeKeys = new Set(writePaths.map(pathKey));
  readPaths = readPaths.filter((filePath) => !writeKeys.has(pathKey(filePath)));
  return {
    toolName,
    command: analysisCommandFromEvent(event),
    cwd: baseDir,
    readPaths: dedupe(readPaths),
    writePaths: dedupe(writePaths),
    unknownWriteTarget: (deterministicWriteTool && (writePaths.length === 0 || incompleteDeterministicTargets)) ||
      (!deterministicWriteTool && incompleteDeterministicTargets) ||
      Boolean(ambiguousShellWorkingDirectory),
    ambiguousShellWorkingDirectory: Boolean(ambiguousShellWorkingDirectory),
    coverage,
  };
}

module.exports = {
  analysisCommandFromEvent,
  analyzeToolEvent,
  collectPathArguments,
  commandFromEvent,
  eventWorkingDirectory,
  extractPatchPaths,
  hasDynamicSyntax,
  isFullyQualifiedPath,
  readPathsFromCommand,
  responseText,
  responseFilePaths,
  tokenizeShell,
  toolSucceeded,
  unwrapKnownShellCarrier,
  writePathsFromCommand,
};
