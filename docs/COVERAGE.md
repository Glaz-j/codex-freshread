# Coverage contract

## Hook boundaries

| Boundary | Behavior |
| --- | --- |
| `PreToolUse` observed shell read | Leave one simple complete-file command unchanged and register a pending candidate. |
| `PostToolUse` observed shell read | Accept only a non-empty canonical raw shell string whose complete expected rendering exactly matches a stable current file read; do not infer a general Bash exit status. |
| `UserPromptSubmit` | Check the Read Set and inject concise non-fresh context. |
| `SessionStart` | Check on startup/resume/clear; restore compact metadata on `source=compact`. |
| `PreCompact` / `PostCompact` | Re-check and persist metadata without storing file contents. |
| `PreToolUse` edit | Force-hash recognized tracked targets and deny non-fresh edits. |
| `PostToolUse` edit | Attribute `apply_patch`/`Edit`/`Write` only after recognized structured or canonical success; attribute shell writes only after a nonce-bound result from an explicitly compatible shell wrapper. |

Codex documents and emits the canonical hook tool name `Bash` for shell and
unified execution. FreshRead also accepts `shell_command`, `exec_command`, and
`unified_exec` as defensive compatibility aliases in direct integrations. It
accepts `apply_patch` with `Edit`/`Write` aliases. Hosted tools, MCP/local reads
without byte-bound evidence, and some specialized paths are not covered.

The formally tracked read surface is deliberately narrower than path discovery:
one non-empty full file read by literal-path `cat` or Windows `type`, or by
PowerShell `Get-Content`/`gc` with both `-Raw` and `-Encoding utf8`. `PreToolUse`
does not rewrite the command. `PostToolUse` promotes the read only when the
canonical raw string contains the complete expected rendering and it exactly
matches a stable current file read. Empty, truncated, transformed, or
encoding-mismatched output is not promoted. When the canonical tool payload has
no tool-level `workdir`/`cwd`, the path must be fully qualified; FreshRead does
not substitute the hook session `cwd`. These restrictions are necessary because
Codex runs `PostToolUse` after both successful and failed Bash commands and its
raw Bash hook response carries no general exit-code field.

Recognized shell writes are still checked synchronously before execution. If the
canonical payload has no shell hint, FreshRead cannot safely choose wrapper
syntax: it leaves the command unchanged and does not later classify it as a
self-write. A nonce-bound wrapper is available only for an explicit compatible
shell hint. Without a tool-level `workdir`/`cwd`, recognized relative shell-write
targets fail closed.

## Classification invariants

1. No reliable snapshot means `UNKNOWN`, never `FRESH`.
2. A content hash equal to the read hash is `FRESH`, even after metadata changes.
3. A changed hash equal to the last observed successful self-write hash is
   `STALE_SELF` unless external drift was already detected after the read.
4. Other changed content is `STALE_EXTERNAL`.
5. A removed tracked path is `MISSING`.
6. A re-read replaces the snapshot and is the general stale-to-fresh reset.
7. A failed write is never self-attributed.
8. Only the session Read Set is checked; repository noise is not enumerated.
9. A read snapshot identifies stable filesystem bytes whose expected command
   rendering exactly matched the canonical `PostToolUse` string. A mismatch
   produces no snapshot.
10. A lexical alias that disappears is `MISSING`; alias/realpath identity cannot
    bypass a guard, and alias retargeting is non-fresh even when bytes match.

## Security boundaries

FreshRead tracks only paths lexically and physically inside `cwd`. It rejects
outside-workspace symlink targets and non-regular files. Its default maximum file
size is 256 MiB and can be changed with `FRESHREAD_MAX_FILE_BYTES`.
Observed shell reads have a separate 16 MiB output cap, configurable with the
compatibility setting `FRESHREAD_VERIFIED_READ_MAX_BYTES`. Above it, or when the
response is empty, incomplete, transformed, or encoding-incompatible, the
original command still runs but the read remains untracked.

The metadata fast path compares size, nanosecond mtime/ctime, device, inode, and
resolved path before reusing a prior hash. A changed candidate is streamed through
SHA-256 and checked again after hashing. Deliberate metadata forgery that preserves
all compared fields is outside V0's threat model; pre-edit checks force a hash.

State is keyed by read-time resolved identity while retaining the lexical path.
Guards resolve both aliases and real paths and expand literal directory targets
over tracked descendants. Lock ownership uses a nonce file; stale cleanup checks
that the recorded process is no longer alive and a former owner cannot remove a
replacement lock.

On Windows, Codex 0.145.0+ with a PowerShell-backed hook command shell is
required. Codex executes `commandWindows` through the thread shell; the hook
declaration is therefore a native, quote-free PowerShell call directly to the
fixed-system `cscript.exe`. PowerShell expands `PLUGIN_ROOT` as one argument and
then the WSH launcher performs the hardened Node lookup without a nested shell
quoting layer. The fixed `cscript.exe` fast path ignores relative PATH entries,
rejects a Node binary inside the workspace, and accepts only the canonical
Program Files `nodejs` installation when the workspace, plugin, discovery script,
and Node component chains are on fixed, non-`SUBST` drives with no unsafe alias.
A safely resolvable plugin alias or vetted nonstandard Node installation can use
the fixed PowerShell component-resolving compatibility path. UNC, `SUBST`, 8.3-
disguised, workspace-local, ambiguous, or missing Node candidates are explicit
denials and are not retried. The remaining trust boundary is the user's vetted
absolute Node installation. If the manifest Windows path cannot start a trusted
Node process for `PreToolUse`, its WSH carrier emits a valid protocol denial, so
a launcher failure cannot silently open the edit guard. Non-edit lifecycle
failures remain visible hook errors. The POSIX and compatibility launchers use
Codex's blocking-error exit code. Any reported hook timeout or runtime failure
still means the guard must be treated as unavailable until repaired.

Normal hook operation always uses the workspace boundary and Codex-provided
`PLUGIN_DATA`. The isolated benchmark-only mode, enabled explicitly with
`FRESHREAD_TEST_MODE=1`, can redirect its data directory and allows low-level
disabled-mode tests. The live baseline instead disables the exact six hooks with
a nonpersistent process config override. Production mode ignores test overrides and has no ambient
outside-workspace switch.

Session state persists to support resume and contains paths, hashes, timestamps,
and session/tool provenance but not file bodies. V0 has no automatic historical
session retention sweep: `freshread clear` clears only the current Read Set, and
a full purge requires deleting the FreshRead plugin data directory while Codex
is closed or uninstalling the plugin.

Subagent hook inputs can share the parent `session_id`. FreshRead therefore treats
observable subagent writes as current-session self writes. Cross-agent isolated
Read Sets require a stable actor id and are not claimed in V0.
