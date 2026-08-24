# FreshRead release benchmark

Source tree SHA-256: 769ff2c603e652282be5c4a09a3fac249ddd50e407d2c55bc96e4b9d74873ca8
Generated: 2026-08-24T07:48:46.930Z
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
| 100 unchanged files | 6.588 ms | 26.047 ms | 50.000 ms | 19.459 / 30.000 ms | PASS |
| 1000 unchanged files | 67.147 ms | 237.581 ms | 400.000 ms | 170.434 / 300.000 ms | PASS |
| Cold hook spawn (paired AB/BA) | 468.793 ms | 459.269 ms | 500.000 ms | 20.304 / 100.000 ms | PASS |
| Populated 1000-file hook spawn | 487.214 ms | 704.823 ms | 900.000 ms | 217.610 / 400.000 ms | PASS |

### Read-registration growth

| Workload | Metadata-loop baseline | FreshRead | Absolute budget | Delta / budget | Gate |
| --- | ---: | ---: | ---: | ---: | --- |
| Exact 1000th read | 0.001 ms | 47.957 ms | 150.000 ms | 47.956 / 125.000 ms | PASS |
| Near-1000th read p95 (10 reads) | 0.002 ms | 50.061 ms | 150.000 ms | 50.059 / 125.000 ms | PASS |
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
