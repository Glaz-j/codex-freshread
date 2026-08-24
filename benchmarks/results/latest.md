# FreshRead release benchmark

Source tree SHA-256: ca338d7ec6b088cdfe04138729820f79075260a38d8adcc47a25d41e2b69ed8c
Generated: 2026-08-24T06:10:24.032Z
Execution profile: full-release

Status: **PASS** for deterministic + synthetic-handler + security + full local-performance.
Deterministic prerequisites eligible: **yes**.
Overall release eligible: **no**; a matching live lifecycle PASS is still required.

Live lifecycle gate: **REQUIRED / NOT RUN**.

## Baseline versus FreshRead outcome

| Metric | Stock / no plugin | FreshRead |
| --- | ---: | ---: |
| Requested task completed | yes | yes |
| User external modification preserved | no | yes |
| Re-read before edit | no | yes |
| Unsafe stale edit | yes | no |

## Deterministic metrics

| Metric | Stock / no plugin | FreshRead |
| --- | ---: | ---: |
| Required PRD cases | 0/8 | 8/8 |
| Exact state accuracy | 0.0% | 100.0% |
| Stale/missing signal recall | 0.0% | 100.0% |
| Fresh signal false-positive rate | 0.0% | 0.0% |
| Guard matrix rate | 0.0% | 100.0% |

## Performance

Absolute latency and baseline-delta budgets are independent and must both pass.

| Workload | Metadata-loop baseline p95 | FreshRead p95 | Absolute budget | Delta / budget | Gate |
| --- | ---: | ---: | ---: | ---: | --- |
| 100 unchanged files | 7.461 ms | 32.396 ms | 50.000 ms | 24.935 / 30.000 ms | PASS |
| 1000 unchanged files | 74.841 ms | 254.413 ms | 400.000 ms | 179.573 / 300.000 ms | PASS |
| Cold hook spawn (paired AB/BA) | 468.660 ms | 466.524 ms | 500.000 ms | 17.515 / 100.000 ms | PASS |
| Populated 1000-file hook spawn | 492.324 ms | 764.327 ms | 900.000 ms | 272.002 / 400.000 ms | PASS |

### Read-registration growth

| Workload | Metadata-loop baseline | FreshRead | Absolute budget | Delta / budget | Gate |
| --- | ---: | ---: | ---: | ---: | --- |
| Exact 1000th read | 0.002 ms | 47.796 ms | 150.000 ms | 47.794 / 125.000 ms | PASS |
| Near-1000th read p95 (10 reads) | 0.003 ms | 49.001 ms | 150.000 ms | 48.998 / 125.000 ms | PASS |
| Read-phase logical path resolutions | 0 | 2999 | 3000 max | n/a | PASS |

## Launch gates

| Gate | Result |
| --- | --- |
| deterministic | PASS |
| handler | PASS |
| security | PASS |
| performance | PASS |
| provenance | PASS |
| liveLifecycle | NOT_RUN |
