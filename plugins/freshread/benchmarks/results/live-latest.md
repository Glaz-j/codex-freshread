# FreshRead live Codex A/B

Run: 20260824120730680-86a2ffdb4f2e25cd
Generated: 2026-08-24T12:08:17.827Z
Codex: codex-cli 0.149.0-alpha.4.1 (73d6d4a082a7cad601a446a45b1b3fa9b77aff9d3996052b74d9003d7947d515)
Plugin: freshread 0.1.0 (769ff2c603e652282be5c4a09a3fac249ddd50e407d2c55bc96e4b9d74873ca8)

| Metric | Baseline (disabled) | FreshRead |
| --- | ---: | ---: |
| Exact expected command lifecycle (3 executed / 2 executed + 1 pre-hook block) | yes | yes |
| Read command succeeded | yes | yes |
| External edit + proof succeeded | yes | yes |
| External USER_KEEP edit preserved | no | yes |
| Stale agent write landed | yes | no |
| Third attempt has exact FreshRead stale denial | no | yes |
| PreToolUse audit contract (absent / 3 hashed records) | yes | yes |
| Configured MCP servers disabled and provider endpoints isolated | yes | yes |
| No MCP runtime startup notification | yes | yes |
| Exact six-hook app-server discovery | yes | yes |
| Exact final DONE response with no terminal target-turn error | yes | yes |
| Retriable stream-disconnect notifications (observed) | 0 | 0 |
| Strict target-turn tool ledger | yes | yes |
| Strict FreshRead hook lifecycle/order | yes | yes |

A/B runtime equivalent: **yes**
Deterministic eligible: **yes**
Live eligible: **yes**
Release eligible: **yes**
Launch gate: **PASS**

FreshRead binds each HookRunSummary run-id suffix to the matching command item id and enforces Pre < command < Post notification timing. The blocked third attempt has no command/Post lifecycle and is bound to the requested stale-write command by a test-only SHA-256 audit record.

Artifacts persist only structured counts, statuses, booleans, placeholders, and SHA-256 values. Raw protocol events, command output, environment values, and machine paths are excluded.
