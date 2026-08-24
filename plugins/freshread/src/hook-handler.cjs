"use strict";

const os = require("node:os");
const path = require("node:path");
const { FreshReadEngine, STATES, modelSafeFragment } = require("./freshread-core.cjs");
const { analyzeToolEvent, toolSucceeded } = require("./command-analyzer.cjs");
const {
  consumeToolEvidence,
  prepareObservedRead,
  prepareShellOutcome,
} = require("./tool-evidence.cjs");

function dataDirectory(env = process.env) {
  const testMode = env.FRESHREAD_TEST_MODE === "1";
  return path.resolve(
    (testMode ? env.FRESHREAD_DATA_DIR : null) ||
    env.PLUGIN_DATA ||
    path.join(os.homedir(), ".codex", "freshread-data")
  );
}

function engineFromEvent(event, options = {}) {
  const env = options.env || process.env;
  const testMode = env.FRESHREAD_TEST_MODE === "1";
  return new FreshReadEngine({
    cwd: event.cwd || options.cwd || process.cwd(),
    dataDir: options.dataDir || dataDirectory(env),
    sessionId: event.session_id || options.sessionId || "standalone",
    enabled: !(testMode && env.FRESHREAD_ENABLED === "0"),
    allowOutsideWorkspace: false,
    maxFileBytes: env.FRESHREAD_MAX_FILE_BYTES ? Number(env.FRESHREAD_MAX_FILE_BYTES) : undefined,
  });
}

function additionalContext(eventName, text) {
  return {
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: text,
    },
  };
}

function deny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

function allowUpdatedInput(event, command) {
  const original = event && event.tool_input;
  let updatedInput;
  if (original && typeof original === "object" && !Array.isArray(original)) {
    updatedInput = { ...original };
    if (typeof original.cmd === "string" && typeof original.command !== "string") updatedInput.cmd = command;
    else if (original.args && typeof original.args === "object" && typeof original.args.command === "string") {
      updatedInput.args = { ...original.args, command };
    } else updatedInput.command = command;
  } else {
    updatedInput = { command };
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput,
    },
  };
}

function commandPrompt(prompt) {
  const match = String(prompt || "").trim().match(/^\/?freshread(?:\s+(status|inspect|clear))?(?:\s+(.+))?\s*$/i);
  if (!match) return null;
  return { command: (match[1] || "status").toLowerCase(), argument: match[2] ? match[2].trim() : null };
}

function formatSingleInspection(engine, result) {
  const lines = ["FreshRead inspect", "", `${result.displayPath || result.path || "unknown"} — ${result.state}`];
  if (result.readAt) lines.push(`read: ${result.readAt}`);
  if (result.changedAt && result.state !== STATES.FRESH) lines.push(`current changed: ${result.changedAt}`);
  if (result.detail) lines.push(modelSafeFragment(result.detail));
  if (result.state !== STATES.FRESH && result.state !== STATES.UNKNOWN) lines.push("Re-read the current file before relying on remembered contents or editing it.");
  return lines.join("\n");
}

function handlePromptCommand(engine, event) {
  const parsed = commandPrompt(event.prompt);
  if (!parsed) return null;
  if (parsed.command === "clear") {
    const result = engine.clear();
    return additionalContext("UserPromptSubmit", `FreshRead cleared ${result.cleared} tracked file snapshot(s) for this session.`);
  }
  if (parsed.command === "inspect") {
    const text = parsed.argument
      ? formatSingleInspection(engine, engine.inspect(parsed.argument, { forceHash: true }))
      : engine.formatInspect(engine.checkAll());
    return additionalContext("UserPromptSubmit", text);
  }
  return additionalContext("UserPromptSubmit", engine.formatStatus(engine.checkAll()));
}

function handlePreToolUse(engine, event) {
  const analysis = analyzeToolEvent(event, "pre");
  if (!engine.enabled) return null;
  let guardedTrackedPaths = [];
  if (analysis.ambiguousShellWorkingDirectory) {
    return deny("FreshRead blocked this shell edit because Codex hooks did not provide a trustworthy per-tool working directory. Retry with fully qualified target paths.");
  }
  if (analysis.unknownWriteTarget) {
    return deny("FreshRead blocked this edit because its deterministic target path could not be identified inside the workspace. Use an explicit local path and retry.");
  }
  if (analysis.writePaths.length) {
    try {
      const guard = engine.guardEdit(analysis.writePaths);
      if (guard.blocked) return deny(guard.reason);
      guardedTrackedPaths = guard.trackedPaths || [];
    } catch (error) {
      return deny(`FreshRead could not verify the target file before editing: ${modelSafeFragment(error.message)}. Re-read the file and retry.`);
    }
  }
  const shellTool = ["bash", "shell_command", "exec_command", "unified_exec"]
    .includes(String(event.tool_name || "").toLowerCase());
  if (!shellTool) return null;
  try {
    if (analysis.writePaths.length) {
      const prepared = prepareShellOutcome(
        engine,
        event,
        [...new Set([...analysis.writePaths, ...guardedTrackedPaths])],
      );
      return prepared ? allowUpdatedInput(event, prepared.command) : null;
    }
    prepareObservedRead(engine, event);
    return null;
  } catch (error) {
    if (analysis.writePaths.length) {
      return deny(`FreshRead could not establish reliable write provenance: ${modelSafeFragment(error.message)}. Retry after fixing FreshRead.`);
    }
    return additionalContext(
      "PreToolUse",
      `FreshRead could not prepare an observed complete-file read: ${modelSafeFragment(error.message)}. This call will not refresh file freshness.`,
    );
  }
}

function handlePostToolUse(engine, event) {
  const analysis = analyzeToolEvent(event, "post");
  const warnings = [];
  const evidence = consumeToolEvidence(engine, event);
  if (evidence) {
    if (evidence.kind === "verified-read" || evidence.kind === "observed-read") {
      if (evidence.success) {
        for (const entry of evidence.entries) {
          const result = engine.recordVerifiedRead(entry, { toolName: event.tool_name, toolUseId: event.tool_use_id });
          if (result.state !== STATES.FRESH) warnings.push(`${result.displayPath || modelSafeFragment(entry.path)}: ${result.state} - ${modelSafeFragment(result.detail)}`);
        }
      } else {
        warnings.push(`complete-file read was not recorded: ${modelSafeFragment(evidence.detail || "reliable evidence was unavailable")}`);
      }
    } else if (evidence.kind === "shell-outcome" && evidence.success) {
      for (const filePath of evidence.paths) {
        const result = engine.recordSelfWrite(filePath, { toolUseId: event.tool_use_id });
        if (result.state === STATES.UNKNOWN && /unreadable|corrupt|hashing|safety limit/i.test(result.detail || "")) {
          warnings.push(`${result.displayPath || modelSafeFragment(filePath)}: ${modelSafeFragment(result.detail)}`);
        }
      }
    }
    if (!warnings.length) return null;
    return additionalContext(
      "PostToolUse",
      `FreshRead could not establish current freshness for:\n- ${warnings.join("\n- ")}\nTreat the affected remembered contents as non-fresh and re-read before editing.`,
    );
  }

  const succeeded = toolSucceeded(event.tool_response, event.tool_name);
  if (succeeded) {
    for (const filePath of analysis.writePaths) {
      const result = engine.recordSelfWrite(filePath, { toolUseId: event.tool_use_id });
      if (result.state === STATES.UNKNOWN && /unreadable|corrupt|hashing|safety limit/i.test(result.detail || "")) {
        warnings.push(`${result.displayPath || modelSafeFragment(filePath)}: ${modelSafeFragment(result.detail)}`);
      }
    }
  }
  if (!warnings.length) return null;
  return additionalContext(
    "PostToolUse",
    `FreshRead could not establish current freshness for:\n- ${warnings.join("\n- ")}\nTreat the affected remembered contents as non-fresh.`
  );
}

function handleHookEvent(event, options = {}) {
  if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("hook input must be a JSON object");
  const eventName = event.hook_event_name;
  if (typeof eventName !== "string") throw new Error("hook_event_name is required");
  const engine = options.engine || engineFromEvent(event, options);
  switch (eventName) {
    case "PreToolUse":
      return handlePreToolUse(engine, event);
    case "PostToolUse":
      return handlePostToolUse(engine, event);
    case "UserPromptSubmit":
      return handlePromptCommand(engine, event) || engine.lifecycle("UserPromptSubmit", event);
    case "SessionStart":
      return engine.lifecycle("SessionStart", event);
    case "PreCompact":
    case "PostCompact":
      return engine.lifecycle(eventName, event);
    default:
      return null;
  }
}

module.exports = {
  additionalContext,
  allowUpdatedInput,
  commandPrompt,
  dataDirectory,
  deny,
  engineFromEvent,
  formatSingleInspection,
  handleHookEvent,
  handlePostToolUse,
  handlePreToolUse,
  handlePromptCommand,
};
