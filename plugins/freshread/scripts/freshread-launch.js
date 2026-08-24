// Quote-safe Windows hook launcher. The manifest reaches this file through a
// native PowerShell call to fixed-system cscript with no nested shell quoting.
// This process owns hook stdio, performs the hardened Node selection in-process,
// and proxies the original JSON bytes to the selected runtime. The standalone
// discovery script remains available for the legacy cmd launcher.
(function () {
  "use strict";

  var REPARSE_POINT = 1024;
  var shell = new ActiveXObject("WScript.Shell");
  var fso = new ActiveXObject("Scripting.FileSystemObject");
  var shellApplication = new ActiveXObject("Shell.Application");
  var processEnvironment = shell.Environment("Process");
  var RESULT_DENY = "__FRESHREAD_DISCOVERY_DENY__";
  var RESULT_FALLBACK = "__FRESHREAD_DISCOVERY_FALLBACK__";
  var componentCache = {};
  var hookInput = WScript.StdIn.ReadAll();

  function normalizedLocalPath(value) {
    var text = String(value || "").replace(/^\s+|\s+$/g, "");
    if (text.length >= 2 && text.charAt(0) === '"' && text.charAt(text.length - 1) === '"') {
      text = text.substring(1, text.length - 1);
    }
    if (!/^[A-Za-z]:[\\\/]/.test(text)) return null;
    return fso.GetAbsolutePathName(text).replace(/\//g, "\\");
  }

  function pathIsWithin(root, candidate) {
    var left = String(root).replace(/[\\\/]+$/, "").toLowerCase();
    var right = String(candidate).replace(/[\\\/]+$/, "").toLowerCase();
    return right === left || right.indexOf(left + "\\") === 0;
  }

  function containsReparsePoint(absolutePath, leafIsFile) {
    var full = normalizedLocalPath(absolutePath);
    if (!full) return true;
    var root = full.substring(0, 3);
    var tail = full.substring(3).split("\\");
    var current = root;
    for (var index = 0; index < tail.length; index += 1) {
      if (!tail[index]) continue;
      var isLeaf = index === tail.length - 1;
      var cacheKey = String(current).toLowerCase() + "|" + String(tail[index]).toLowerCase() + "|" + (isLeaf && leafIsFile ? "f" : "d");
      var resolved = componentCache[cacheKey];
      if (!resolved) {
        var namespace = shellApplication.NameSpace(current);
        var shellItem = namespace && namespace.ParseName(tail[index]);
        if (!shellItem) return true;
        var canonicalPath = normalizedLocalPath(shellItem.Path);
        if (!canonicalPath || String(fso.GetFileName(canonicalPath)).toLowerCase() !== String(tail[index]).toLowerCase()) return true;
        var item = isLeaf && leafIsFile ? fso.GetFile(canonicalPath) : fso.GetFolder(canonicalPath);
        resolved = { path: String(item.Path), attributes: Number(item.Attributes) };
        componentCache[cacheKey] = resolved;
      }
      // Shell ParseName expands arbitrary 8.3 aliases to their long namespace
      // spelling. A mismatch above therefore defers to the hardened fallback.
      if ((resolved.attributes & REPARSE_POINT) !== 0) return true;
      current = resolved.path;
    }
    return false;
  }

  function substitutedDrives() {
    var result = {};
    var systemRoot = normalizedLocalPath(shell.ExpandEnvironmentStrings("%SystemRoot%"));
    if (!systemRoot) throw new Error("SystemRoot is unavailable");
    var process = shell.Exec('"' + fso.BuildPath(systemRoot, "System32\\subst.exe") + '"');
    var output = process.StdOut.ReadAll();
    if (process.ExitCode !== 0) throw new Error("cannot inspect substituted drives");
    var pattern = /^([A-Za-z]):\\:/gm;
    var match;
    while ((match = pattern.exec(output)) !== null) result[match[1].toLowerCase()] = true;
    return result;
  }

  function isFixedUnsubstitutedPath(absolutePath, substitutions) {
    var driveName = fso.GetDriveName(absolutePath);
    if (!/^[A-Za-z]:$/.test(driveName)) return false;
    var drive = fso.GetDrive(driveName);
    return Number(drive.DriveType) === 2 && !substitutions[driveName.charAt(0).toLowerCase()];
  }

  function trustedNodeRoot(candidate, substitutions) {
    var variables = ["%ProgramFiles%", "%ProgramW6432%", "%ProgramFiles(x86)%"];
    for (var index = 0; index < variables.length; index += 1) {
      var expanded = shell.ExpandEnvironmentStrings(variables[index]);
      if (!expanded || expanded === variables[index]) continue;
      var root;
      try {
        root = normalizedLocalPath(fso.BuildPath(expanded, "nodejs"));
        if (!root || !fso.FolderExists(root) || !isFixedUnsubstitutedPath(root, substitutions) ||
            containsReparsePoint(root, false)) continue;
      } catch (ignoredRoot) {
        continue;
      }
      if (pathIsWithin(root, candidate)) return true;
    }
    return false;
  }

  function discoverNode(pluginRoot, hookScript, expectedLauncher, actualLauncher) {
    try {
      var substitutions = substitutedDrives();
      var workspace = normalizedLocalPath(shell.CurrentDirectory);
      var normalizedPluginRoot = normalizedLocalPath(pluginRoot);
      var normalizedHookScript = normalizedPluginRoot ? fso.BuildPath(normalizedPluginRoot, "scripts\\freshread-hook.cjs") : null;
      var normalizedExpectedLauncher = normalizedPluginRoot ? fso.BuildPath(normalizedPluginRoot, "scripts\\freshread-launch.js") : null;
      var normalizedActualLauncher = normalizedLocalPath(actualLauncher);
      if (!workspace || !normalizedPluginRoot || !normalizedHookScript || !normalizedExpectedLauncher || !normalizedActualLauncher ||
          !isFixedUnsubstitutedPath(workspace, substitutions) ||
          !isFixedUnsubstitutedPath(normalizedPluginRoot, substitutions) ||
          containsReparsePoint(workspace, false)) return RESULT_DENY;
      try {
        // PowerShell can safely canonicalize a plugin installation reached
        // through a junction/alias. Unsafe workspace and Node candidates stay
        // hard denials and never reach this compatibility path.
        if (containsReparsePoint(normalizedPluginRoot, false) || !fso.FileExists(normalizedHookScript) ||
            containsReparsePoint(normalizedHookScript, true) ||
            normalizedExpectedLauncher.toLowerCase() !== normalizedActualLauncher.toLowerCase() ||
            containsReparsePoint(normalizedActualLauncher, true)) return RESULT_FALLBACK;
      } catch (ignoredPluginLayout) {
        return RESULT_FALLBACK;
      }

      // Keep the arguments bound to the same paths that were just classified.
      if (normalizedHookScript.toLowerCase() !== normalizedLocalPath(hookScript).toLowerCase() ||
          normalizedExpectedLauncher.toLowerCase() !== normalizedLocalPath(expectedLauncher).toLowerCase()) {
        return RESULT_DENY;
      }

      var rawPath = String(processEnvironment("PATH") || "").split(";");
      var compatibleCandidate = false;
      var unsafeCandidate = false;
      for (var index = 0; index < rawPath.length; index += 1) {
        var directory;
        try {
          directory = normalizedLocalPath(shell.ExpandEnvironmentStrings(rawPath[index]));
        } catch (ignoredDirectory) {
          directory = null;
        }
        if (!directory) {
          if (String(rawPath[index] || "").replace(/^\s+|\s+$/g, "")) unsafeCandidate = true;
          continue;
        }

        try {
          // Classify unsafe directories before checking for node.exe to avoid a
          // check/use gap if an aliased directory changes during discovery.
          if (!isFixedUnsubstitutedPath(directory, substitutions) ||
              pathIsWithin(workspace, directory) || containsReparsePoint(directory, false)) {
            unsafeCandidate = true;
            continue;
          }
        } catch (ignoredUnsafeDirectory) {
          unsafeCandidate = true;
          continue;
        }

        var candidate = fso.BuildPath(directory, "node.exe");
        if (!fso.FileExists(candidate)) continue;
        try {
          candidate = normalizedLocalPath(candidate);
          if (!candidate || pathIsWithin(workspace, candidate) || containsReparsePoint(candidate, true)) {
            unsafeCandidate = true;
            continue;
          }
          if (!trustedNodeRoot(candidate, substitutions)) {
            compatibleCandidate = true;
            continue;
          }
        } catch (ignoredCandidate) {
          unsafeCandidate = true;
          continue;
        }
        return candidate;
      }
      if (unsafeCandidate) return RESULT_DENY;
      if (compatibleCandidate) return RESULT_FALLBACK;
      return RESULT_DENY;
    } catch (ignored) {
      return RESULT_DENY;
    }
  }

  function skipWhitespace(text, index) {
    while (index < text.length && /\s/.test(text.charAt(index))) index += 1;
    return index;
  }

  function readJsonString(text, start) {
    if (text.charAt(start) !== '"') return null;
    var value = "";
    var index = start + 1;
    while (index < text.length) {
      var character = text.charAt(index);
      if (character === '"') return { value: value, end: index + 1 };
      if (character !== "\\") {
        if (character.charCodeAt(0) < 32) return null;
        value += character;
        index += 1;
        continue;
      }
      index += 1;
      if (index >= text.length) return null;
      var escape = text.charAt(index);
      var escapes = { '"': '"', "\\": "\\", "/": "/", "b": "\b", "f": "\f", "n": "\n", "r": "\r", "t": "\t" };
      if (escape === "u") {
        var hex = text.substr(index + 1, 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
        value += String.fromCharCode(parseInt(hex, 16));
        index += 5;
      } else if (Object.prototype.hasOwnProperty.call(escapes, escape)) {
        value += escapes[escape];
        index += 1;
      } else {
        return null;
      }
    }
    return null;
  }

  function skipJsonValue(text, start) {
    var index = skipWhitespace(text, start);
    if (text.charAt(index) === '"') {
      var stringValue = readJsonString(text, index);
      return stringValue ? stringValue.end : -1;
    }
    if (text.charAt(index) === "{" || text.charAt(index) === "[") {
      var openings = [];
      while (index < text.length) {
        var character = text.charAt(index);
        if (character === '"') {
          var nestedString = readJsonString(text, index);
          if (!nestedString) return -1;
          index = nestedString.end;
          continue;
        }
        if (character === "{" || character === "[") openings.push(character);
        if (character === "}" || character === "]") {
          var expected = character === "}" ? "{" : "[";
          if (!openings.length || openings.pop() !== expected) return -1;
          if (!openings.length) return index + 1;
        }
        index += 1;
      }
      return -1;
    }
    while (index < text.length && text.charAt(index) !== "," && text.charAt(index) !== "}") index += 1;
    return index;
  }

  function topLevelStringField(text, wantedKey) {
    var index = skipWhitespace(text, 0);
    if (text.charAt(index) !== "{") return null;
    index += 1;
    while (index < text.length) {
      index = skipWhitespace(text, index);
      if (text.charAt(index) === "}") return null;
      var key = readJsonString(text, index);
      if (!key) return null;
      index = skipWhitespace(text, key.end);
      if (text.charAt(index) !== ":") return null;
      index = skipWhitespace(text, index + 1);
      if (key.value === wantedKey) {
        var fieldValue = readJsonString(text, index);
        return fieldValue ? fieldValue.value : null;
      }
      index = skipJsonValue(text, index);
      if (index < 0) return null;
      index = skipWhitespace(text, index);
      if (text.charAt(index) === ",") {
        index += 1;
        continue;
      }
      if (text.charAt(index) === "}") return null;
      return null;
    }
    return null;
  }

  function jsonQuote(value) {
    return '"' + String(value).replace(/[\\"\u0000-\u001f]/g, function (character) {
      var simple = { "\\": "\\\\", '"': '\\"', "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t" };
      if (Object.prototype.hasOwnProperty.call(simple, character)) return simple[character];
      return "\\u" + ("0000" + character.charCodeAt(0).toString(16)).slice(-4);
    }) + '"';
  }

  var hookEventName = topLevelStringField(hookInput, "hook_event_name");

  function quote(value) {
    return '"' + String(value).replace(/"/g, '""') + '"';
  }

  function fail(message) {
    if (hookEventName === "PreToolUse") {
      var reason = "FreshRead launcher failed visibly: " + message + ". Re-read the target and retry after fixing FreshRead.";
      WScript.StdOut.WriteLine('{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":' + jsonQuote(reason) + "}}");
      WScript.Quit(0);
    }
    WScript.StdErr.WriteLine("FreshRead launcher failed: " + message);
    WScript.Quit(1);
  }

  function run(command, input) {
    var child = shell.Exec(command);
    child.StdIn.Write(input);
    child.StdIn.Close();
    // FreshRead writes its bounded model output to stdout. Draining stdout
    // before stderr avoids blocking that primary channel; launcher stderr is
    // intentionally short and bounded.
    var stdout = child.StdOut.ReadAll();
    var stderr = child.StdErr.ReadAll();
    return { exitCode: child.ExitCode, stdout: stdout, stderr: stderr };
  }

  function relay(result) {
    if (result.exitCode !== 0 && hookEventName === "PreToolUse") {
      fail("the trusted hook runtime did not complete");
    }
    if (result.stdout) WScript.StdOut.Write(result.stdout);
    if (result.stderr) WScript.StdErr.Write(result.stderr);
    WScript.Quit(result.exitCode === 0 ? 0 : 1);
  }

  try {
    var systemRoot = String(processEnvironment("SystemRoot") || "");
    var pluginRoot = String(processEnvironment("PLUGIN_ROOT") || "");
    if (!systemRoot || !pluginRoot) fail("required launcher state is unavailable");

    var powershell = fso.BuildPath(systemRoot, "System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    var hook = fso.BuildPath(pluginRoot, "scripts\\freshread-hook.cjs");
    var fallback = fso.BuildPath(pluginRoot, "scripts\\freshread-launch.ps1");
    var expectedLauncher = fso.GetAbsolutePathName(fso.BuildPath(pluginRoot, "scripts\\freshread-launch.js"));
    var actualLauncher = fso.GetAbsolutePathName(WScript.ScriptFullName);
    if (expectedLauncher.toLowerCase() !== actualLauncher.toLowerCase() ||
        !fso.FileExists(powershell) || !fso.FileExists(hook) || !fso.FileExists(fallback)) {
      fail("required launcher file is unavailable");
    }

    var decision = discoverNode(pluginRoot, hook, expectedLauncher, actualLauncher);
    if (decision === RESULT_DENY) {
      fail("Node discovery rejected an unsafe or unavailable execution path");
    }
    if (decision && decision !== RESULT_FALLBACK) {
      if (!/^[A-Za-z]:[\\/]/.test(decision) || !fso.FileExists(decision)) {
        fail("Node discovery returned an invalid execution path");
      }
      relay(run(quote(decision) + " " + quote(hook), hookInput));
    }

    // Discovery uses FALLBACK only for a resolvable plugin alias or vetted
    // nonstandard Node layout. Preserve the same proxied stdio contract.
    processEnvironment("FRESHREAD_POWERSHELL_FALLBACK") = "1";
    processEnvironment("FRESHREAD_FALLBACK_PATH") = fallback;
    relay(run(
      quote(powershell) + " -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " + quote("%FRESHREAD_FALLBACK_PATH%"),
      hookInput
    ));
  } catch (error) {
    fail("secure launcher orchestration failed");
  }
}());
