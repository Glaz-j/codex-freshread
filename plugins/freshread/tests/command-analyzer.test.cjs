"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  analysisCommandFromEvent,
  analyzeToolEvent,
  extractPatchPaths,
  readPathsFromCommand,
  toolSucceeded,
  writePathsFromCommand,
} = require("../src/command-analyzer.cjs");

function tempFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freshread-parser-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "auth file.ts"), "needle\n");
  fs.writeFileSync(path.join(root, "src", "session.ts"), "needle\n");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function canonicalShellAnalysis(root, command) {
  return analyzeToolEvent({
    cwd: root,
    tool_name: "Bash",
    tool_input: { command },
  }, "pre");
}

function assertGuardCovers(analysis, target, message) {
  assert.ok(
    analysis.unknownWriteTarget || analysis.writePaths.includes(target),
    `${message}: expected target coverage or fail-closed unknown result`,
  );
}

test("parses PowerShell Get-Content literal paths", (t) => {
  const root = tempFixture(t);
  const paths = readPathsFromCommand("Get-Content -LiteralPath 'src/auth file.ts' -Encoding UTF8 -Raw", root, "needle");
  assert.deepEqual(paths, [path.join(root, "src", "auth file.ts")]);
});

test("unwraps the absolute PowerShell carrier emitted by canonical Windows Codex execution", { skip: process.platform !== "win32" }, (t) => {
  const root = tempFixture(t);
  const target = path.join(root, "src", "auth file.ts");
  const inner = `Get-Content -LiteralPath '${target}' -Raw -Encoding utf8`;
  const carrier = `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "${inner}"`;
  assert.equal(analysisCommandFromEvent({ tool_input: { command: carrier } }), inner);
  const analysis = analyzeToolEvent({
    cwd: root,
    tool_name: "Bash",
    tool_input: { command: carrier },
    tool_response: "needle\n\r\n",
  }, "post");
  assert.deepEqual(analysis.readPaths, [target]);
});

test("preserves Windows path separators inside PowerShell double quotes", { skip: process.platform !== "win32" }, (t) => {
  const root = tempFixture(t);
  const paths = readPathsFromCommand('Get-Content -LiteralPath ".\\src\\auth file.ts" -Raw', root, "needle");
  assert.deepEqual(paths, [path.join(root, "src", "auth file.ts")]);
});

test("parses explicit rg file targets but ignores rg --files", (t) => {
  const root = tempFixture(t);
  assert.deepEqual(
    readPathsFromCommand("rg -n needle 'src/session.ts'", root, "1:needle"),
    [path.join(root, "src", "session.ts")],
  );
  assert.deepEqual(
    readPathsFromCommand("rg needle src", root, { exit_code: 0, output: "src/session.ts:1:needle\n" }),
    [path.join(root, "src", "session.ts")],
  );
  assert.deepEqual(readPathsFromCommand("rg --files", root, "src/session.ts"), []);
});

test("parses apply_patch update, delete, add, and move targets", (t) => {
  const root = tempFixture(t);
  const patchText = [
    "*** Begin Patch",
    "*** Update File: src/auth file.ts",
    "*** Delete File: src/session.ts",
    "*** Add File: src/new.ts",
    "*** Move to: src/moved.ts",
    "*** End Patch",
  ].join("\n");
  assert.deepEqual(new Set(extractPatchPaths(patchText, root)), new Set([
    path.join(root, "src", "auth file.ts"),
    path.join(root, "src", "session.ts"),
    path.join(root, "src", "new.ts"),
    path.join(root, "src", "moved.ts"),
  ]));
});

test("apply_patch treats shell metacharacters as literal filenames and rejects partial target parsing", (t) => {
  const root = tempFixture(t);
  const literal = path.join(root, "src", "$stale.ts");
  fs.writeFileSync(literal, "stale\n");
  const literalPatch = analyzeToolEvent({
    cwd: root,
    tool_name: "apply_patch",
    tool_input: { command: "*** Begin Patch\n*** Update File: src/$stale.ts\n*** End Patch" },
  }, "pre");
  assert.deepEqual(literalPatch.writePaths, [literal]);
  assert.equal(literalPatch.unknownWriteTarget, false);

  const partial = analyzeToolEvent({
    cwd: root,
    tool_name: "apply_patch",
    tool_input: {
      command: "*** Begin Patch\n*** Update File: src/session.ts\n*** Update File: ../outside.ts\n*** End Patch",
    },
  }, "pre");
  assert.deepEqual(partial.writePaths, [path.join(root, "src", "session.ts")]);
  assert.equal(partial.unknownWriteTarget, true);
});

test("parses direct shell and PowerShell write targets", (t) => {
  const root = tempFixture(t);
  assert.deepEqual(
    writePathsFromCommand("Set-Content -LiteralPath 'src/session.ts' -Value updated", root),
    [path.join(root, "src", "session.ts")],
  );
  assert.deepEqual(
    writePathsFromCommand("echo updated >> 'src/auth file.ts'", root),
    [path.join(root, "src", "auth file.ts")],
  );
});

test("guards PowerShell inline path parameters in canonical hook payloads", (t) => {
  const root = tempFixture(t);
  const source = path.join(root, "src", "session.ts");
  const target = path.join(root, "src", "auth file.ts");
  const cases = [
    ["set", `Set-Content -LiteralPath:'${target}' -Value:'updated'`, target],
    ["add", `Add-Content -Path:'${target}' -Value:'updated'`, target],
    ["clear", `Clear-Content -LiteralPath:'${target}'`, target],
    ["remove", `Remove-Item -LiteralPath:'${target}' -Force`, target],
    ["copy", `Copy-Item -LiteralPath:'${source}' -Destination:'${target}' -Force`, target],
    ["move", `Move-Item -LiteralPath:'${source}' -Destination:'${target}' -Force`, target],
    ["rename", `Rename-Item -LiteralPath:'${target}' -NewName:'renamed file.ts'`, target],
    ["out-file", `'updated' | Out-File -FilePath:'${target}'`, target],
  ];
  for (const [name, command, expected] of cases) {
    assertGuardCovers(canonicalShellAnalysis(root, command), expected, name);
  }
});

test("Set-Content and Add-Content do not mistake a named Value argument for the target", (t) => {
  const root = tempFixture(t);
  const decoy = path.join(root, "src", "session.ts");
  const target = path.join(root, "src", "auth file.ts");
  for (const commandName of ["Set-Content", "Add-Content"]) {
    const analysis = canonicalShellAnalysis(
      root,
      `${commandName} -Value '${decoy}' '${target}'`,
    );
    assert.equal(analysis.unknownWriteTarget, false);
    assert.deepEqual(analysis.writePaths, [target]);
  }
});

test("abbreviated or unknown inline PowerShell parameters fail closed instead of guarding a decoy", (t) => {
  const root = tempFixture(t);
  const decoy = path.join(root, "src", "session.ts");
  const target = path.join(root, "src", "auth file.ts");
  const abbreviatedValue = canonicalShellAnalysis(
    root,
    `Set-Content -Val '${decoy}' '${target}'`,
  );
  assert.equal(abbreviatedValue.unknownWriteTarget, true);

  const abbreviatedDestination = canonicalShellAnalysis(
    root,
    `Copy-Item -LiteralPath:'${decoy}' -Dest:'${target}' -Force`,
  );
  assert.equal(abbreviatedDestination.unknownWriteTarget, true);
});

test("guards sed in-place targets when scripts are supplied by inline or separate options", (t) => {
  const root = tempFixture(t);
  const target = path.join(root, "src", "session.ts");
  const script = path.join(root, "script.sed");
  fs.writeFileSync(script, "s/needle/replaced/\n");
  for (const command of [
    `sed -i -es/needle/replaced/ '${target}'`,
    `sed -i --expression=s/needle/replaced/ '${target}'`,
    `sed -i -e 's/needle/replaced/' '${target}'`,
    `sed -i --expression 's/needle/replaced/' '${target}'`,
    `sed -i -f'${script}' '${target}'`,
    `sed -i --file='${script}' '${target}'`,
    `sed -i -f '${script}' '${target}'`,
    `sed -i --file '${script}' '${target}'`,
  ]) {
    const analysis = canonicalShellAnalysis(root, command);
    assert.equal(analysis.unknownWriteTarget, false, command);
    assert.deepEqual(analysis.writePaths, [target], command);
  }
});

test("sed script-file reads without an in-place flag are not treated as writes", (t) => {
  const root = tempFixture(t);
  const target = path.join(root, "src", "session.ts");
  const analysis = canonicalShellAnalysis(root, `sed --file='${path.join(root, "script.sed")}' '${target}'`);
  assert.equal(analysis.unknownWriteTarget, false);
  assert.deepEqual(analysis.writePaths, []);
});

test("guards cp and mv target directories supplied with an inline long option", (t) => {
  const root = tempFixture(t);
  const source = path.join(root, "src", "session.ts");
  const destinationDirectory = path.join(root, "src");
  for (const commandName of ["cp", "mv"]) {
    const analysis = canonicalShellAnalysis(
      root,
      `${commandName} --target-directory='${destinationDirectory}' '${source}'`,
    );
    assert.equal(analysis.unknownWriteTarget, false);
    assert.deepEqual(new Set(analysis.writePaths), new Set([destinationDirectory, source]));
  }
});

test("preserves POSIX backslash-escaped whitespace in direct and redirection targets", (t) => {
  const root = tempFixture(t);
  const redirected = path.join(root, "src", "auth file.ts");
  const removed = path.join(root, "src", "tracked -x");
  fs.writeFileSync(removed, "tracked\n");
  const escapeWhitespace = (value) => value.replace(/\s/g, (item) => `\\${item}`);

  const redirectAnalysis = canonicalShellAnalysis(
    root,
    `printf updated > ${escapeWhitespace(redirected)}`,
  );
  assert.equal(redirectAnalysis.unknownWriteTarget, false);
  assert.deepEqual(redirectAnalysis.writePaths, [redirected]);

  const removeAnalysis = canonicalShellAnalysis(root, `rm ${escapeWhitespace(removed)}`);
  assert.equal(removeAnalysis.unknownWriteTarget, false);
  assert.deepEqual(removeAnalysis.writePaths, [removed]);
});

test("recognized writer syntax that cannot be fully resolved fails closed", (t) => {
  const root = tempFixture(t);
  const target = path.join(root, "src", "session.ts");
  const analysis = canonicalShellAnalysis(root, `sed -i --mystery=value '${target}'`);
  assert.equal(analysis.unknownWriteTarget, true);
});

test("treats dash-prefixed paths after the POSIX option terminator as literal write targets", (t) => {
  const root = tempFixture(t);
  assert.deepEqual(
    writePathsFromCommand("rm -- -tracked", root),
    [path.join(root, "-tracked")],
  );
});

test("recognizes the POSIX force-clobber redirection target", (t) => {
  const root = tempFixture(t);
  const target = path.join(root, "src", "session.ts");
  assert.deepEqual(
    writePathsFromCommand(`echo updated >| "${target}"`, root),
    [target],
  );
});

test("parses both source and destination for copy and move commands", (t) => {
  const root = tempFixture(t);
  for (const command of ["Copy-Item", "Move-Item"]) {
    assert.deepEqual(
      writePathsFromCommand(`${command} -LiteralPath 'src/session.ts' -Destination 'src/result.ts'`, root),
      [path.join(root, "src", "session.ts"), path.join(root, "src", "result.ts")],
    );
  }
  assert.deepEqual(
    writePathsFromCommand("Copy-Item 'src/session.ts' -Destination 'src/result.ts'", root),
    [path.join(root, "src", "session.ts"), path.join(root, "src", "result.ts")],
  );
});

test("ignores redirection characters inside quotes", (t) => {
  const root = tempFixture(t);
  assert.deepEqual(writePathsFromCommand('echo "not a redirect > src/session.ts"', root), []);
  assert.deepEqual(
    writePathsFromCommand('echo updated > "src/session.ts"', root),
    [path.join(root, "src", "session.ts")],
  );
});

test("preserves literal directory write targets", (t) => {
  const root = tempFixture(t);
  assert.deepEqual(writePathsFromCommand("rm -rf src", root), [path.join(root, "src")]);
});

test("apply_patch analysis is exact and removes overlapping reads", (t) => {
  const root = tempFixture(t);
  const result = analyzeToolEvent({
    cwd: root,
    tool_name: "apply_patch",
    tool_input: { command: "*** Begin Patch\n*** Update File: src/session.ts\n*** End Patch" },
  }, "pre");
  assert.equal(result.coverage, "exact");
  assert.deepEqual(result.readPaths, []);
  assert.deepEqual(result.writePaths, [path.join(root, "src", "session.ts")]);
  assert.equal(result.unknownWriteTarget, false);
});

test("extracts structured Edit and Write target paths", (t) => {
  const root = tempFixture(t);
  for (const [toolName, toolInput, expected] of [
    ["Edit", { file_path: "src/session.ts", old_string: "old", new_string: "new" }, path.join(root, "src", "session.ts")],
    ["Write", { path: "src/new.ts", content: "new" }, path.join(root, "src", "new.ts")],
  ]) {
    const result = analyzeToolEvent({ cwd: root, tool_name: toolName, tool_input: toolInput }, "pre");
    assert.deepEqual(result.writePaths, [expected]);
    assert.equal(result.coverage, "exact");
    assert.equal(result.unknownWriteTarget, false);
  }
});

test("flags deterministic edit tools whose target cannot be resolved", (t) => {
  const root = tempFixture(t);
  for (const event of [
    { cwd: root, tool_name: "apply_patch", tool_input: { command: "*** Begin Patch\n*** End Patch" } },
    { cwd: root, tool_name: "Edit", tool_input: { old_string: "old", new_string: "new" } },
    { cwd: root, tool_name: "Write", tool_input: { path: "../outside.ts", content: "new" } },
  ]) {
    const result = analyzeToolEvent(event, "pre");
    assert.deepEqual(result.writePaths, []);
    assert.equal(result.unknownWriteTarget, true);
  }
});

test("resolves command paths from workdir but scopes them to the session cwd", (t) => {
  const root = tempFixture(t);
  const target = path.join(root, "config.ts");
  fs.writeFileSync(target, "config\n");
  const result = analyzeToolEvent({
    cwd: root,
    tool_name: "Bash",
    tool_input: {
      workdir: path.join(root, "src"),
      command: `Get-Content -LiteralPath '${path.join("..", "config.ts")}'`,
    },
    tool_response: { exit_code: 0, output: "config\n" },
  }, "post");
  assert.deepEqual(result.readPaths, [target]);
});

test("failed structured responses are not attributed as self writes", () => {
  assert.equal(toolSucceeded({ exit_code: 1 }), false);
  assert.equal(toolSucceeded({ isError: true }), false);
  assert.equal(toolSucceeded({}), false);
  assert.equal(toolSucceeded({ status: "failed" }), false);
  assert.equal(toolSucceeded({ ok: false }), false);
  assert.equal(toolSucceeded({ exit_code: 0 }), true);
  assert.equal(toolSucceeded({ success: true }), true);
  assert.equal(toolSucceeded("model-facing output", "Bash"), false);
  assert.equal(toolSucceeded("Exit code: 1\npatch failed", "apply_patch"), false);
  assert.equal(toolSucceeded("Exit code: 0\nSuccess. Updated the following files:\nM src/a.ts", "apply_patch"), true);
});

test("accepts canonical and compatibility shell tool names", (t) => {
  const root = tempFixture(t);
  for (const toolName of ["Bash", "shell_command", "exec_command", "unified_exec"]) {
    const analysis = analyzeToolEvent({
      cwd: root,
      tool_name: toolName,
      tool_input: { command: "Get-Content -LiteralPath 'src/session.ts'" },
      tool_response: { exit_code: 0, output: "A\n" },
    });
    assert.deepEqual(analysis.readPaths, [path.join(root, "src", "session.ts")]);
  }
});

test("dynamic and outside-workspace paths are ignored", (t) => {
  const root = tempFixture(t);
  assert.deepEqual(readPathsFromCommand("Get-Content $env:SECRET", root, "secret"), []);
  assert.deepEqual(writePathsFromCommand('Set-Content "src/$name.ts" updated', root), []);
  assert.deepEqual(writePathsFromCommand("Set-Content src/%NAME%/file.ts updated", root), []);
  assert.deepEqual(writePathsFromCommand("Set-Content src/!NAME!/file.ts updated", root), []);
  assert.deepEqual(writePathsFromCommand("Set-Content ~/file.ts updated", root), []);
  assert.deepEqual(writePathsFromCommand("Set-Content ../outside.ts x", root), []);
});

test("recognized writers fail closed when quoted literal targets contain dynamic metacharacters", (t) => {
  const root = tempFixture(t);
  const literal = path.join(root, "$tracked");
  const cases = [
    `rm -- '${literal}'`,
    `Set-Content -LiteralPath '${literal}' -Value B`,
  ];

  for (const command of cases) {
    const analysis = analyzeToolEvent({
      cwd: root,
      tool_name: "Bash",
      tool_input: { command },
    }, "pre");
    assert.deepEqual(analysis.writePaths, []);
    assert.equal(analysis.ambiguousShellWorkingDirectory, false);
    assert.equal(analysis.unknownWriteTarget, true);
  }
});

test("shell analysis fails closed on relative writes unless the hook exposes the tool workdir", (t) => {
  const root = tempFixture(t);
  const relative = analyzeToolEvent({
    cwd: root,
    tool_name: "Bash",
    tool_input: { command: "Set-Content -LiteralPath 'src/session.ts' -Value updated" },
  }, "pre");
  assert.equal(relative.ambiguousShellWorkingDirectory, true);
  assert.equal(relative.unknownWriteTarget, true);
  assert.deepEqual(relative.writePaths, []);

  const explicitWorkdir = analyzeToolEvent({
    cwd: root,
    tool_name: "Bash",
    tool_input: {
      command: "Set-Content -LiteralPath 'session.ts' -Value updated",
      workdir: path.join(root, "src"),
    },
  }, "pre");
  assert.equal(explicitWorkdir.ambiguousShellWorkingDirectory, false);
  assert.deepEqual(explicitWorkdir.writePaths, [path.join(root, "src", "session.ts")]);

  const absolute = analyzeToolEvent({
    cwd: root,
    tool_name: "Bash",
    tool_input: { command: `Set-Content -LiteralPath '${path.join(root, "src", "session.ts")}' -Value updated` },
  }, "pre");
  assert.equal(absolute.ambiguousShellWorkingDirectory, false);
  assert.deepEqual(absolute.writePaths, [path.join(root, "src", "session.ts")]);
});
