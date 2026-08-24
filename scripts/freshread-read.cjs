#!/usr/bin/env node
"use strict";

const { executeVerifiedRead } = require("../src/tool-evidence.cjs");

function main() {
  if (process.argv.length !== 3) throw new Error("expected one pending-evidence path");
  executeVerifiedRead(process.argv[2]);
}

try {
  main();
} catch (error) {
  process.stderr.write(`FreshRead verified read failed: ${error.message}\n`);
  process.exitCode = 1;
}
