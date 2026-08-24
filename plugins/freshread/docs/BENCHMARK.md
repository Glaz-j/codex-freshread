# Benchmark contract

FreshRead uses two complementary baselines:

- `stock/no-plugin` runs the same stale-consumer workflow without a freshness
  signal or guard and measures task completion, preservation of the simulated
  user's edit, re-reading, and unsafe stale edits.
- `metadata-loop baseline` performs the same 100/1000-file stat workload without
  persistence/classification. Cold and populated-process comparisons use the
  same configured launcher with FreshRead disabled; the populated arms alternate
  order over one persisted 1000-file Read Set.

The deterministic trace suite covers the PRD cases:

| Case | Oracle |
| --- | --- |
| C01 unchanged after read | `FRESH` |
| C02 external change | `STALE_EXTERNAL` |
| C03 observed Codex write | `STALE_SELF` |
| C04 stale file re-read | `FRESH` |
| C05 deletion | `MISSING` |
| C06 process reload/resume | stale detected |
| C07 compaction/reload | metadata persists |
| C08 no reliable snapshot | `UNKNOWN` |

The full deterministic prerequisite has independent deterministic, handler,
security, performance, and provenance gates. It requires fixed case IDs C01-C08, 8/8
oracles, 100% stale/missing signal recall, zero fresh false positives, zero
`UNKNOWN`-as-`FRESH`, a 100% core/handler guard matrix, preservation of the
external edit in the stale-consumer workflow, no source bodies in state, zero
hashes on unchanged checkpoints, bounded 100/1000-file p95, successful cold and
populated hook spawns, bounded exact/near-Nth-read latency, linear read-registration
path work, and a SHA-256 binding the report to the tested source tree. Absolute
latency and baseline-delta budgets are separate mandatory gates. For the full
profile, populated-hook budgets are 900 ms absolute / 400 ms delta (the sum of
the component scan and cold-launch budgets); 1000th-read budgets are 150 ms
absolute / 125 ms delta, with at most three logical path resolutions per read.

Additional tests cover command parsing, the command-preserving observed-read
protocol and its race window, nonce-bound outcomes for explicitly hinted shell
writes, structured `apply_patch` success, Windows/POSIX launchers, concurrent
writers, session isolation, corruption recovery, alias/realpath bypasses,
literal directory writes, deep state validation, size limits, and repository
noise. The trusted-reader path remains an internal compatibility test and is not
the default product protocol.

Deterministic state accuracy does not prove that a model obeys a warning. Release
evidence therefore distinguishes hook-protocol/live integration from trace replay
and never presents the synthetic baseline as an LLM task-success measurement.
`npm test` uses a quick profile; only a full `npm run benchmark` can set
`deterministicEligible: true`. The deterministic report always leaves overall
`releaseEligible: false` and marks `liveLifecycle` as required but `NOT_RUN`.
Overall release eligibility requires a separate live Codex A/B PASS bound to the
same source digest.
Run it after installing the final plugin build with `npm run benchmark:live`;
set `FRESHREAD_CODEX_BIN` when the desired current Codex executable is not on
`PATH`. The runner uses the `personal` marketplace by default; set
`FRESHREAD_MARKETPLACE=freshread` when validating the public Git-backed
marketplace installation. Review and trust the exact installed FreshRead
definitions in `/hooks` first. The runner requires all six definitions to report `trusted` before it
starts either model turn; it does not use a blanket trust bypass. The live runner
talks to that executable's app-server over stdio, uses
fresh ephemeral threads and the workspace-write sandbox, and writes
`benchmarks/results/live-latest.{json,md}`. It also writes
`live-latest.events.json` with a privacy-minimized protocol summary: counts,
statuses, booleans, placeholders, and hashes only, never raw model/tool output,
environment values, or machine paths. The gate requires Codex 0.145+, an
absolute executable identity, the same full deterministic artifact and source
digest before and after the run, a matching installed cache, exactly six trusted
FreshRead hooks with exact runtime metadata and no discovery warnings/errors
(disabled by one process-local `hooks.state` override in baseline and enabled in FreshRead),
an effective-configuration preflight that discovers and then individually
disables every configured MCP server, a second pre-thread configuration read
that binds the same all-disabled inventory, and the built-in OpenAI provider with
no custom provider entry or endpoint override,
an exclusive arm-specific target-turn tool ledger (three executed commands in
baseline with no FreshRead hook lifecycle/audit; two executed commands plus one
blocked pre-hook in FreshRead), exact run-id-to-command association, cross-event
`Pre < command < Post` ordering, exactly three FreshRead-only test audit records
whose tool IDs join exactly and whose command hashes match the same finite
generated platform-variant set as the executed command,
the third FreshRead pre-hook's exact
`STALE_EXTERNAL` block with no command/Post lifecycle, equivalent
A/B model/runtime settings, a terminal completed agent message containing exact
`DONE` with no terminal target-turn error notification, and the expected final
file outcomes. Schema-shaped `responseStreamDisconnected` notifications with
`willRetry=true` are retained as observable retry evidence and accepted only
when they precede the successful final message and unique turn completion. The
runner accepts a nullable message phase only because the app-server
protocol documents that providers do not emit it consistently; any explicit
`final_answer` must be unique and terminal. Every run
first invalidates an older PASS; latest artifacts use a run ID, atomic per-file
replacement, and an event-artifact SHA-256 binding.

The live A/B intentionally exercises one canonical supported read/write path.
It does not convert C06 resume or C07 compaction into live evidence; those cases
remain deterministic state plus synthetic hook-protocol coverage in V0.
