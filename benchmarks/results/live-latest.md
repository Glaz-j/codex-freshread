# FreshRead live Codex A/B

Run: 20260824061217937-e086e618829e98b4
Generated: 2026-08-24T06:17:12.416Z
Codex: codex-cli 0.149.0-alpha.4.1 (81cae94fbac1ba51713614347892d4895d66cc4b17c800f4259284616d009c6f)
Plugin: freshread 0.1.0+codex.20260824060943 (ca338d7ec6b088cdfe04138729820f79075260a38d8adcc47a25d41e2b69ed8c)

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
| Retriable stream-disconnect notifications (observed) | 4 | 4 |
| Strict target-turn tool ledger | yes | yes |
| Strict FreshRead hook lifecycle/order | yes | yes |

A/B runtime equivalent: **yes**
Deterministic eligible: **yes**
Live eligible: **yes**
Release eligible: **yes**
Launch gate: **PASS**

FreshRead binds each HookRunSummary run-id suffix to the matching command item id and enforces Pre < command < Post notification timing. The blocked third attempt has no command/Post lifecycle and is bound to the requested stale-write command by a test-only SHA-256 audit record.

Artifacts persist only structured counts, statuses, booleans, placeholders, and SHA-256 values. Raw protocol events, command output, environment values, and machine paths are excluded.
