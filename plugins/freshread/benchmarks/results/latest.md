# FreshRead release benchmark

Source tree SHA-256: 0e6d4f96afe7fe1ced8d1afc26cac5f8e857b55acbdd203cafc9f26d71c41f0e
Generated: 2026-08-24T14:19:40.797Z
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
| 100 unchanged files | 0.757 ms | 6.832 ms | 50.000 ms | 6.074 / 30.000 ms | PASS |
| 1000 unchanged files | 4.565 ms | 39.470 ms | 400.000 ms | 34.905 / 300.000 ms | PASS |
| Cold hook spawn (paired AB/BA) | 43.537 ms | 45.293 ms | 500.000 ms | 3.587 / 100.000 ms | PASS |
| Populated 1000-file hook spawn | 43.180 ms | 123.616 ms | 900.000 ms | 80.437 / 400.000 ms | PASS |

### Read-registration growth

| Workload | Metadata-loop baseline | FreshRead | Absolute budget | Delta / budget | Gate |
| --- | ---: | ---: | ---: | ---: | --- |
| Exact 1000th read | 0.001 ms | 35.785 ms | 150.000 ms | 35.784 / 125.000 ms | PASS |
| Near-1000th read p95 (10 reads) | 0.002 ms | 36.996 ms | 150.000 ms | 36.994 / 125.000 ms | PASS |
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
