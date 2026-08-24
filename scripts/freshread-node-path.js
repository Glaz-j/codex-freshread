// Windows Script Host fast-path discovery for freshread-launch.cmd.
// Output is one vetted absolute node.exe path, a reserved decision marker, or
// nothing when Windows Script Host itself could not execute the discovery.
(function () {
  "use strict";

  var REPARSE_POINT = 1024;
  var RESULT_DENY = "__FRESHREAD_DISCOVERY_DENY__";
  var RESULT_FALLBACK = "__FRESHREAD_DISCOVERY_FALLBACK__";
  var fso = new ActiveXObject("Scripting.FileSystemObject");
  var shell = new ActiveXObject("WScript.Shell");
  var shellApplication = new ActiveXObject("Shell.Application");
  var componentCache = {};

  function finish(result, exitCode) {
    WScript.StdOut.WriteLine(result);
    WScript.Quit(exitCode);
  }

  function deny() {
    finish(RESULT_DENY, 4);
  }

  function fallback() {
    finish(RESULT_FALLBACK, 5);
  }

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

  try {
    var substitutions = substitutedDrives();
    var workspace = normalizedLocalPath(shell.CurrentDirectory);
    var pluginRoot = normalizedLocalPath(shell.Environment("Process")("PLUGIN_ROOT"));
    var hookScript = pluginRoot ? fso.BuildPath(pluginRoot, "scripts\\freshread-hook.cjs") : null;
    var discoveryScript = pluginRoot ? fso.BuildPath(pluginRoot, "scripts\\freshread-node-path.js") : null;
    var actualDiscovery = normalizedLocalPath(WScript.ScriptFullName);
    if (!workspace || !pluginRoot || !hookScript || !discoveryScript || !actualDiscovery ||
        !isFixedUnsubstitutedPath(workspace, substitutions) ||
        !isFixedUnsubstitutedPath(pluginRoot, substitutions) ||
        containsReparsePoint(workspace, false)) deny();
    try {
      // The PowerShell resolver can safely canonicalize a plugin installation
      // reached through a junction/alias and verifies that the hook remains
      // inside the resolved PLUGIN_ROOT. Keep that compatibility path distinct
      // from unsafe workspace or Node candidates, which must be denied above.
      if (containsReparsePoint(pluginRoot, false) || !fso.FileExists(hookScript) ||
          containsReparsePoint(hookScript, true) ||
          discoveryScript.toLowerCase() !== actualDiscovery.toLowerCase() ||
          containsReparsePoint(actualDiscovery, true)) fallback();
    } catch (ignoredPluginLayout) {
      fallback();
    }

    var rawPath = String(shell.Environment("Process")("PATH") || "").split(";");
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
        // Classify unsafe directories before checking for node.exe. Otherwise a
        // workspace or aliased PATH directory could gain node.exe between this
        // process and a compatibility fallback (a check/use gap).
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

      WScript.StdOut.WriteLine(candidate);
      WScript.Quit(0);
    }
    if (unsafeCandidate) deny();
    if (compatibleCandidate) fallback();
    deny();
  } catch (ignored) {
    deny();
  }
  deny();
}());
