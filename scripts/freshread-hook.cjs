#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { dataDirectory, handleHookEvent } = require("../src/hook-handler.cjs");
const { analyzeToolEvent, commandFromEvent } = require("../src/command-analyzer.cjs");

const MAX_STDIN_BYTES = 16 * 1024 * 1024;

function auditDecisionCode(output) {
  const specific = output && output.hookSpecificOutput;
  if (!specific || typeof specific !== "object") return "PASS";
  if (specific.permissionDecision === "deny") {
    const reason = String(specific.permissionDecisionReason || "");
    return /FreshRead blocked this edit/.test(reason) && /STALE_EXTERNAL/.test(reason)
      ? "DENY_STALE_EXTERNAL"
      : "DENY_OTHER";
  }
  if (specific.permissionDecision === "allow") return "ALLOW";
  if (typeof specific.additionalContext === "string" && specific.additionalContext) return "CONTEXT";
  return "PASS";
}

function recordBenchmarkAudit(event, output, env = process.env) {
  if (env.FRESHREAD_TEST_MODE !== "1" || !env.FRESHREAD_BENCHMARK_NONCE) return null;
  const nonce = String(env.FRESHREAD_BENCHMARK_NONCE);
  if (!/^[0-9a-f]{64}$/.test(nonce)) throw new Error("benchmark nonce is invalid");
  if (!event || event.hook_event_name !== "PreToolUse") return null;
  const toolUseId = event.tool_use_id;
  const command = commandFromEvent(event);
  if (typeof toolUseId !== "string" || !toolUseId || toolUseId.length > 4096) {
    throw new Error("benchmark PreToolUse input has no bounded tool_use_id");
  }
  if (typeof command !== "string" || !command || Buffer.byteLength(command, "utf8") > MAX_STDIN_BYTES) {
    throw new Error("benchmark PreToolUse input has no bounded command");
  }
  const toolUseIdSha256 = crypto.createHash("sha256").update(toolUseId, "utf8").digest("hex");
  const record = {
    schemaVersion: 1,
    nonce,
    hookEvent: "PreToolUse",
    toolUseIdSha256,
    commandSha256: crypto.createHash("sha256").update(command, "utf8").digest("hex"),
    decisionCode: auditDecisionCode(output),
  };
  const auditDirectory = path.join(dataDirectory(env), "benchmark-audit", nonce);
  fs.mkdirSync(auditDirectory, { recursive: true, mode: 0o700 });
  const auditPath = path.join(auditDirectory, `${toolUseIdSha256}.json`);
  const bytes = `${JSON.stringify(record)}\n`;
  try {
    fs.writeFileSync(auditPath, bytes, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST" || fs.readFileSync(auditPath, "utf8") !== bytes) throw error;
  }
  return record;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = "";
    let bytes = 0;
    let settled = false;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk, "utf8");
      if (bytes > MAX_STDIN_BYTES) {
        settled = true;
        process.stdin.pause();
        const error = new Error("hook input exceeds the 16 MiB safety limit");
        error.failClosed = true;
        reject(error);
        return;
      }
      input += chunk;
    });
    process.stdin.on("end", () => {
      if (!settled) {
        settled = true;
        resolve(input);
      }
    });
    process.stdin.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

function looksLikePotentialWrite(event) {
  if (!event || event.hook_event_name !== "PreToolUse") return false;
  const canonicalTool = String(event.tool_name || "").toLowerCase();
  if (["apply_patch", "edit", "write"].includes(canonicalTool)) return true;
  try {
    const analysis = analyzeToolEvent(event, "pre");
    if (analysis.unknownWriteTarget || analysis.writePaths.length) return true;
  } catch {}
  const command = commandFromEvent(event);
  return /(?:^|[\s;|&])(?:set-content|add-content|clear-content|remove-item|rm|del|erase|touch|copy-item|cp|move-item|mv|rename-item|ren|out-file|prettier)\b|>{1,2}/i.test(command);
}

async function main() {
  let event;
  try {
    const input = await readStdin();
    try {
      event = JSON.parse(input);
    } catch (error) {
      error.failClosed = true;
      throw error;
    }
    const output = handleHookEvent(event);
    recordBenchmarkAudit(event, output);
    if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (error) {
    const message = `FreshRead hook failed visibly: ${error.message}`;
    if (!event && error.failClosed) {
      process.stderr.write(`${message}. Hook input was rejected conservatively.\n`);
      process.exitCode = 2;
      return;
    }
    if (looksLikePotentialWrite(event)) {
      process.stdout.write(`${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `${message}. Re-read the target and retry after fixing FreshRead.`,
        },
      })}\n`);
      return;
    }
    if (event && event.hook_event_name === "PreToolUse") {
      process.stdout.write(`${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: `${message}. This read will not refresh FreshRead state.`,
        },
      })}\n`);
      return;
    }
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { MAX_STDIN_BYTES, auditDecisionCode, looksLikePotentialWrite, readStdin, recordBenchmarkAudit };
