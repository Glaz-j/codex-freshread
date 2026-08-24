# FreshRead benchmark

This directory contains the deterministic release benchmark. It deliberately
separates evidence levels and does not present synthetic hook events as live
Codex lifecycle coverage.

## What is compared

The stock/no-plugin and FreshRead arms execute the same stale-consumer workflow:

1. read and remember version A;
2. simulate an external user edit to version B with a USER_KEEP marker;
3. continue the requested edit;
4. measure whether the task completes, whether the user marker survives, whether
   a re-read occurred, and whether an unsafe stale edit was attempted.

The stock arm has no freshness signal or guard. The FreshRead arm can react to
the turn signal or pre-edit guard. This produces a file-outcome comparison
instead of treating a hard-coded NO_SIGNAL state as product-effect evidence.

## Deterministic gates

The deterministic release prerequisite contains independent gates:

- deterministic: the fixed EXPECTED_CASE_IDS set is exactly C01-C08, state and
  lifecycle-signal oracles pass, C07 preserves both snapshot hash and read_at,
  and the stale-consumer outcome preserves the external edit;
- handler: core stale/missing/multi-target guards plus synthetic handler checks
  for apply_patch, PowerShell copy/move destinations, prompt/resume/compact
  context, the command-preserving observed-read Pre/PostToolUse protocol, and the
  six-boundary hook configuration;
- security: failed, empty, truncated, or non-matching reads stay UNKNOWN,
  corrupt state fails closed, outside paths do not become tracked FRESH, a
  read/PostToolUse race cannot become FRESH, and persisted metadata contains no
  source body. The trusted-reader path is retained as an internal compatibility
  test, not as the default product claim;
- performance: identical 100- and 1000-file metadata-loop workloads, zero
  re-hashes on unchanged checkpoints, a same-launcher cold hook comparison with
  20 paired launches per arm in alternating AB/BA order, an
  interleaved configured-launcher comparison over a persisted 1000-file Read
  Set, and explicit near-Nth-read/linear-work gates. Every latency comparison
  must independently pass both its absolute p95 budget and its baseline-delta
  budget; the cold delta is p95 of the 20 paired `(FreshRead - baseline)`
  durations, while other delta gates compare arm-level p95 values. The two
  limits are never combined with an OR-style maximum. Cold reports retain every
  pair's raw arm durations and execution order;
- provenance: every report records a SHA-256 over the plugin source tree,
  excluding generated results, .git, and node_modules.

`liveLifecycle` is always emitted as required and `NOT_RUN` by this runner. A
separate, reproducible live probe is required before making live Codex lifecycle
claims or establishing overall release eligibility. `launchGate.passed` reports
only whether this deterministic benchmark scope passed.

## Run and artifacts

    npm run benchmark
    npm run benchmark:live
    node benchmarks/run-benchmark.cjs --out benchmarks/results/latest.json
    node benchmarks/run-benchmark.cjs --no-write-results
    node benchmarks/run-benchmark.cjs --quick --no-write-results

The CLI defaults to the full-release profile: 100/1000-file workloads, twenty
paired, AB/BA-alternating cold launches per arm, and eight interleaved launches per arm against the
persisted 1000-file state. The populated 900 ms absolute / 400 ms delta budgets
are the conservative sums of the independently enforced 400 ms scan + 500 ms
cold-process and 300 ms scan-delta + 100 ms cold-delta budgets. The exact and
near-1000th read gates use 150 ms absolute / 125 ms delta budgets and cap logical
path resolutions at 3N; these retain more than 3x headroom over the measured
optimized Windows Nth-read latency while catching the prior quadratic lookup.
Direct `runSuite()` calls default to the quick-test
profile used by `npm test`; it runs the same scenarios, outcome workflow, guard,
handler, security, provenance, and performance oracles with 10/50-file samples,
checks read growth at 50 files, and explicitly marks cold and populated launches
as skipped. A quick report has
`launchGate.deterministicEligible: false`, even when all quick gates pass. The
full profile can produce `deterministicEligible: true`, but both profiles keep
overall `launchGate.releaseEligible: false` until a separate matching live gate
passes.

A normal full run writes:

- results/latest.json: machine-readable cases, outcome comparison, matrices,
  timings, source digest, and launch decision;
- results/latest.md: human-readable baseline/FreshRead comparison;
- results/coverage.json: evidence levels and explicit non-claims.

The process exits non-zero when any required deterministic, handler, security,
or performance gate fails. --baseline-only emits only the stock arm and does not
claim a launch result.

After the final plugin build is installed, `npm run benchmark:live` requests the
same three-attempt stale-consumer sequence in fresh baseline and FreshRead
app-server threads. It uses the workspace-write sandbox and requires all six
installed FreshRead definitions to report `trusted` before either model turn;
the baseline process disables exactly those six definitions through one
nonpersistent `hooks.state` override, while the FreshRead process requires them enabled;
it does not use a blanket hook-trust bypass. The runner writes
`live-latest.json` and `live-latest.md` beside the deterministic results. Parsed
app-server evidence is retained in `live-latest.events.json` only as structured
counts/statuses/booleans/placeholders and hashes; raw protocol, model/tool output,
environment values, and machine paths are never written. The runner refuses to
start unless the same full deterministic artifact, Codex version, installed
FreshRead cache, exact six-hook metadata, and source digest match the release
contract. Before each arm it discovers the effective MCP inventory without
starting a thread; the actual process disables every discovered server and must
re-read the same all-disabled inventory before hook discovery or `thread/start`.
It also rejects custom entries or endpoint overrides for the selected built-in
OpenAI provider. The PASS gate requires three executed command lifecycles and
zero FreshRead hook lifecycle/audit records in baseline,
two executed command lifecycles plus a third pre-hook-only block in FreshRead,
exact hook-run-id/command-id joins and notification ordering, and three
FreshRead-only test PreToolUse records containing only nonce/tool/command hashes and a
decision code. Each audit command hash and executed command must independently
match the same finite, generated platform-variant set while sharing the exact
tool ID; this accounts for Codex's Windows command carrier without using fuzzy
matching. It also requires equivalent A/B runtimes, the baseline's stale
write to land, FreshRead's third pre-hook to block with the exact
`STALE_EXTERNAL` reason and no third command/Post lifecycle, the external
`USER_KEEP` edit to survive, a terminal completed agent message containing exact
`DONE` without a terminal target-turn error, and strict real Pre/PostToolUse
lifecycle order. Structured `responseStreamDisconnected` notifications with
`willRetry=true` remain counted but are non-terminal only when they precede the
successful final message and unique turn completion. A nullable message phase
follows the app-server's documented provider
compatibility rule; an explicit `final_answer` must be unique and terminal.
Each run invalidates an older PASS before work and atomically replaces run-ID
bound latest artifacts. This live artifact is the separate evidence needed by
release orchestration; the deterministic report itself never claims overall
release eligibility. C06 resume and C07 compaction remain deterministic and
synthetic hook-protocol evidence rather than live claims.

The live runner targets the `personal` marketplace by default. When validating
the public Git-backed marketplace, set `FRESHREAD_MARKETPLACE=freshread` in the
runner environment. Marketplace names are validated with Codex's identifier
rules before they are used to resolve the installed cache or hook IDs.
