<div align="center">

# FreshRead

**File-context freshness guardrails for Codex**

FreshRead detects when a supported local file that Codex reliably read has
changed and stops supported edits until Codex reads the current content again.

English · [简体中文](README.zh-CN.md)

</div>

> [!IMPORTANT]
> FreshRead is a conservative, tool-level guardrail. It protects the supported
> read and write paths described below; it is not an operating-system file
> monitor and does not claim whole-workspace coverage.

## Why FreshRead

Coding agents make decisions from file content already present in their
conversation context. That context can become stale when a user, formatter,
build step, Git operation, or another process changes the file after it was
read.

Without a freshness check, a later edit can silently overwrite those newer
changes. FreshRead adds a deterministic check at Codex lifecycle boundaries:

```text
Codex reads a file
        ↓
FreshRead records a content snapshot
        ↓
The file changes after that read
        ↓
Codex prepares a supported edit
        ↓
FreshRead blocks the edit and asks Codex to re-read
```

The task can then continue against current filesystem reality instead of an
expired memory of the file.

## Highlights

- **Automatic protection** — no command is required during normal work.
- **Content-based edit checks** — supported pre-edit checks force SHA-256;
  lifecycle scans use a bounded metadata fast path and hash when metadata
  changes.
- **Synchronous edit guard** — supported stale edits are denied before the
  underlying tool executes.
- **Observable provenance** — changes are labelled by matching current-session
  observed-write evidence; unmatched changes remain conservatively external.
- **Resume and compaction support** — session metadata survives supported
  lifecycle transitions.
- **Local by design** — no FreshRead-operated service, database, telemetry, or
  direct network request.
- **Fail-closed safety** — corrupt state or a failed trusted runtime cannot be
  mistaken for fresh context on supported edit paths.

## Quick start

### Requirements

- A Codex app or CLI session backed by the plugin and lifecycle-hook runtime.
  The IDE extension and a regular ChatGPT Work composer are not supported
  enforcement-verification surfaces.
- Node.js 18.18 or newer available as `node`.
- On Windows, Codex 0.145.0 or newer with a PowerShell-backed hook command shell
  for the supported enforcement path.

### Install

FreshRead is currently distributed as a local personal-marketplace build; this
README does not claim a public-directory listing. In an environment where this
checkout is registered in the default personal marketplace, install it with:

```text
codex plugin add freshread@personal
```

Run the command with a supported Codex 0.145.0+ binary and verify it with
`codex --version`. Do not rely on a legacy 0.132.0 Windows hook runner for
FreshRead enforcement, even if that binary can discover or list the plugin.

After installation or an update:

1. Start a new Codex CLI session.
2. Enter `/hooks` in the CLI.
3. Review, trust, and enable the six FreshRead hook definitions.
4. Start a new Codex thread before testing the installed build.

`/hooks` is a **Codex CLI command**. It is not a FreshRead command and is not
available in the ChatGPT Work composer.

Codex records trust against the current hook-definition hash. If an update
changes that hash, the hook is skipped until it is reviewed again. See the
[Codex hooks documentation](https://learn.chatgpt.com/docs/hooks) for the host
trust model.

### Use it

Work normally. Once the plugin is enabled and its hooks are trusted, qualifying
reads and supported edits are protected automatically.

These optional diagnostics are ordinary prompts, without a leading slash:

```text
freshread status
freshread inspect
freshread inspect src/auth.ts
freshread clear
```

| Prompt | Purpose |
| --- | --- |
| `freshread status` | Show state counts for the current session. |
| `freshread inspect` | List tracked files and their current states. |
| `freshread inspect <path>` | Inspect one tracked path. |
| `freshread clear` | Clear only the current session's Read Set. |

Normal use should not require command maintenance. If FreshRead blocks an edit,
re-read the named file from the filesystem and retry the edit.
Do not use `freshread clear` merely to bypass a stale or unknown state.

## State model

FreshRead tracks only files backed by a reliable, complete read observation.

| State | Meaning | Safe next step |
| --- | --- | --- |
| `FRESH` | Current content matches the last reliable read. | Continue. |
| `STALE_SELF` | Content changed through an observed Codex write after the last read. | Re-read before relying on or editing it again. |
| `STALE_EXTERNAL` | Content changed without matching current-session Codex write evidence. | Re-read before relying on or editing it. |
| `MISSING` | The previously read path no longer exists. | Re-check the path and task intent. |
| `UNKNOWN` | No reliable snapshot exists or the current identity cannot be proven. | Treat freshness as unknown; do not assume it is safe. |

`STALE` means the remembered snapshot expired. It does not mean the current code
is semantically wrong.

## How it works

FreshRead is a local Codex plugin composed of one skill and six lifecycle hooks:

- `SessionStart` checks restored session state.
- `UserPromptSubmit` reports explicit FreshRead diagnostics and checks the Read
  Set at a new turn.
- `PreToolUse` identifies supported read/write targets and blocks unsafe edits.
- `PostToolUse` validates successful complete reads and records snapshots or
  observed write evidence.
- `PreCompact` and `PostCompact` re-check persistent metadata around context
  compaction; `SessionStart` with a compact source re-injects relevant context.

For a reliable read, FreshRead records the canonical path, SHA-256 content
identity, size, high-resolution mtime/ctime metadata, read time, and observable
tool provenance. Persistent state is stored under the Codex-provided
`PLUGIN_DATA` directory, not in the source repository.

## Supported coverage

FreshRead intentionally accepts only evidence it can bind conservatively to a
local file.

Supported paths include:

- exact add, update, delete, and move targets from `apply_patch`, plus supported
  structured `Edit` and `Write` targets;
- complete, non-empty, single-file shell reads with literal local paths and
  exact canonical output;
- supported PowerShell reads using `Get-Content`/`gc -Raw -Encoding utf8`;
- recognized literal-path shell writes such as `Set-Content`, `Out-File`,
  redirection, delete, copy, move, rename, `sed -i`, and `prettier --write`;
- synchronous pre-edit protection for recognized targets, with conservative
  self-write attribution only when the tool result provides sufficient proof.

Deliberately not treated as reliable snapshots:

- partial, transformed, or search reads such as `head`, `tail`, `rg`,
  `Select-String`, and mixed pipelines;
- dynamic paths, globs, arbitrary scripts, or subprocesses that open files
  internally;
- MCP, hosted, image, or specialized tool outputs that cannot bind delivered
  bytes to a stable local snapshot;
- empty or truncated output, unsupported encodings, and complete reads larger
  than 16 MiB by default;
- files outside the session workspace, outside-workspace symlink targets,
  non-regular files, and files larger than 256 MiB by default;
- changes that race between the synchronous pre-edit check and the actual
  write;
- relative observed reads when the hook payload omits tool-level `workdir` or
  `cwd`; use a fully qualified path in that situation, while recognized relative
  shell writes fail closed;
- writes sent later through `write_stdin` to an already-running tool process;
  the host does not emit a new `PreToolUse` event for that continuation, so do
  not use persistent shell sessions for writes that require FreshRead coverage;
- reliable per-subagent isolation when the host exposes only the parent session
  identifier.

Unsupported reads continue normally but do not refresh the Read Set. See
[Coverage and known risks](docs/COVERAGE.md) for the complete contract.

## Privacy and security

- Persistent FreshRead state stores hashes and metadata, not source-file
  contents.
- Stored metadata includes absolute paths and session identifiers so resume can
  work.
- Absolute paths, hashes, and identifiers may still be sensitive; protect the
  Codex plugin data directory accordingly.
- File bytes read by Codex still follow Codex's normal tool-output and
  data-processing path.
- FreshRead makes no direct network requests and has no operated backend.
- State writes use a per-session lock, bounded files, restrictive modes where
  supported, and temporary-file replacement.
- Model-visible paths and diagnostics neutralize control and bidirectional text
  formatting characters.
- Launchers reject unsafe Node resolution and workspace-local runtimes. On
  Windows, they also reject ambiguous aliases and unsupported reparse or drive
  layouts.

FreshRead V0 does not automatically expire old session-state files.
`freshread clear` clears only the current session. To remove all retained
FreshRead metadata, close Codex and explicitly remove the plugin's
Codex-provided data directory. Uninstalling stops the hooks; do not assume it
purges retained data unless the active Codex version explicitly confirms that
behavior.

## Release evidence

The release suite compares the same stale-context consumer task with FreshRead
disabled and enabled.

| Outcome | Baseline | FreshRead |
| --- | ---: | ---: |
| External user change preserved | No | Yes |
| Re-read before the protected edit | No | Yes |
| Unsafe stale edit landed | Yes | No |
| Third stale edit attempt | Executed | Blocked before execution |

The performance gate covers 100/1000-file scans, read-registration growth,
cold-hook startup, and a real configured hook over a populated 1000-file state.
Absolute latency and baseline-delta budgets must both pass. Overall release
eligibility also requires the deterministic and live reports to match the same
source digest. The checked-in matching deterministic, security, performance,
and live Codex app-server gates pass.

- [Latest deterministic benchmark](benchmarks/results/latest.md)
- [Latest live Codex A/B](benchmarks/results/live-latest.md)
- [Benchmark contract](docs/BENCHMARK.md)

The evidence proves the deliberately canonical supported workflow. It is not a
claim of whole-workspace or operating-system audit coverage. The current live
release evidence is Windows-based; other platform launchers do not yet carry the
same end-to-end live A/B qualification claim. Resume and compaction scenarios
remain deterministic/synthetic evidence unless a report explicitly labels them
as live.

## Development

FreshRead ships runnable CommonJS files and has no compilation or `dist/` step.
Node.js performs syntax checks and executes the plugin directly.

```text
npm run check
npm test
npm run benchmark
```

Run the live gate only after installing the exact source build, trusting its
current hooks, and starting a new Codex session:

```text
npm run benchmark:live
```

Project layout:

```text
.codex-plugin/plugin.json   Plugin identity and UI metadata
skills/freshread/           Model-facing workflow instructions
hooks/hooks.json            Lifecycle registration
scripts/                    Cross-platform launchers and hook entry points
src/                        State machine, command analysis, and evidence logic
tests/                      Unit, contract, edge-case, and hardening tests
benchmarks/                 Deterministic and live A/B release gates
docs/                       Detailed coverage and benchmark contracts
```

When updating a locally installed build, edit the development source, validate
it, update the manifest cachebuster, reinstall from the marketplace, and start a
new thread. Do not edit the installed cache directly.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| FreshRead appears inactive | Confirm the plugin is enabled, start a new session, and review its hooks with `/hooks` in Codex CLI. |
| `/hooks` shows “no command” | You are likely in the ChatGPT Work composer; open Codex CLI for hook review. |
| An edit is blocked | Re-read every named target from the filesystem, then retry. Do not bypass an `UNKNOWN` state. |
| State is reported as corrupt | Use `freshread clear` only as an explicit recovery action, then re-read every file needed by the task. |
| Hook launch fails on Windows | Verify Node.js 18.18+ and a supported Codex 0.145.0+ runtime. Treat protection as unavailable until the hook is healthy. |
| An update is not visible | Reinstall the plugin and start a new thread; Codex runs the installed cache copy. |

## License

[MIT](LICENSE) © 2026 FreshRead contributors.
