#!/usr/bin/env node
"use strict";

const { FreshReadEngine } = require("../../src/freshread-core.cjs");

const [cwd, dataDir, sessionId, filePath, operation = "read"] = process.argv.slice(2);
const engine = new FreshReadEngine({ cwd, dataDir, sessionId, lockTimeoutMs: 10_000 });
if (operation === "read") engine.recordRead(filePath, { toolName: "concurrency-test" });
else if (operation === "self") engine.recordSelfWrite(filePath, { toolUseId: "concurrency-test" });
else throw new Error(`unsupported worker operation: ${operation}`);
