#!/usr/bin/env node
"use strict";

const os = require("node:os");
const path = require("node:path");
const { FreshReadEngine } = require("../src/freshread-core.cjs");

function usage() {
  return [
    "Usage: node scripts/freshread-cli.cjs <status|inspect|clear> --session <id> [options]",
    "",
    "Options:",
    "  --cwd <path>       Workspace root (default: current directory)",
    "  --data-dir <path>  Plugin data directory",
    "  --path <path>      Inspect one tracked path",
  ].join("\n");
}

function parseArgs(argv) {
  const result = { command: argv[0] || "status", cwd: process.cwd(), dataDir: null, sessionId: null, filePath: null };
  for (let i = 1; i < argv.length; i += 1) {
    const value = argv[i + 1];
    if (argv[i] === "--cwd") result.cwd = value, i += 1;
    else if (argv[i] === "--data-dir") result.dataDir = value, i += 1;
    else if (argv[i] === "--session") result.sessionId = value, i += 1;
    else if (argv[i] === "--path") result.filePath = value, i += 1;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return result;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }
  if (!["status", "inspect", "clear"].includes(args.command) || !args.sessionId) {
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 2;
    return;
  }
  const engine = new FreshReadEngine({
    cwd: path.resolve(args.cwd),
    dataDir: path.resolve(args.dataDir || process.env.FRESHREAD_DATA_DIR || process.env.PLUGIN_DATA || path.join(os.homedir(), ".codex", "freshread-data")),
    sessionId: args.sessionId,
  });
  if (args.command === "clear") {
    const result = engine.clear();
    process.stdout.write(`Cleared ${result.cleared} tracked file snapshot(s).\n`);
  } else if (args.command === "inspect" && args.filePath) {
    const result = engine.inspect(args.filePath, { forceHash: true });
    process.stdout.write(`${result.displayPath || result.path} — ${result.state}\n${result.detail}\n`);
  } else if (args.command === "inspect") {
    process.stdout.write(`${engine.formatInspect(engine.checkAll())}\n`);
  } else {
    process.stdout.write(`${engine.formatStatus(engine.checkAll())}\n`);
  }
}

main();
