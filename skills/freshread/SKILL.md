---
name: freshread
description: Inspect and manage FreshRead file-context freshness for the current Codex session. Use when the user asks for FreshRead status, inspection, clearing, stale-context diagnosis, or help after FreshRead blocks an edit. Do not use as a generic repository or Git change monitor.
---

# FreshRead

FreshRead hooks run automatically for qualifying supported reads. They track file snapshots from those reads, compare the tracked Read Set with filesystem reality at lifecycle boundaries, and guard supported edits. A reported hook failure or timeout means the guard is unavailable until repaired.

When FreshRead reports `STALE_SELF`, `STALE_EXTERNAL`, or `MISSING`, re-read the named path from the filesystem before relying on remembered content. Retry a blocked edit only after the re-read establishes a new snapshot. Treat `UNKNOWN` as unknown; never describe it as fresh.

The user-facing commands are handled by the `UserPromptSubmit` hook:

- `freshread status` returns state counts for this session.
- `freshread inspect` lists tracked paths and details; an optional path narrows the result.
- `freshread clear` clears only this session's Read Set. Clear state only when the user explicitly requests it.

Coverage is intentionally file-level and bounded. `apply_patch` targets are guarded exactly, and recognized structured or canonical success can be attributed as `STALE_SELF`. The default observed-read protocol does not rewrite commands: `PreToolUse` registers one literal-path, non-empty complete-file candidate, and `PostToolUse` records it only when the complete canonical raw string exactly matches the stable current file rendering. PowerShell reads require `Get-Content`/`gc -Raw -Encoding utf8`; when a canonical payload omits tool-level `workdir`/`cwd`, use a fully qualified path. Shell writes are guarded before execution, but a canonical payload without a shell hint is not rewritten or self-attributed; nonce-bound write evidence requires an explicit compatible shell hint. Search/partial reads, empty or truncated output, arbitrary scripts, opaque shell pipelines, MCP/hosted reads, specialized tool paths, and external processes are not reliable snapshots. Do not claim whole-workspace or operating-system audit coverage.

If automatic behavior is absent, ask the user to open `/hooks` and trust the current FreshRead hook definition. Do not edit files under `PLUGIN_DATA` manually; use `freshread clear` for recovery.
