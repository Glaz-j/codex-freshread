## Summary

<!-- What user-visible problem does this pull request solve? -->

## Safety behavior

<!--
Describe the intended behavior when evidence is fresh, stale, missing, corrupt,
unsupported, or unavailable. Identify affected hooks, tools, commands, paths,
platforms, and trust boundaries.
-->

## Change type

- [ ] Bug fix
- [ ] Feature
- [ ] Security hardening
- [ ] Compatibility or launcher change
- [ ] Refactor with no intended behavior change
- [ ] Documentation or governance
- [ ] Benchmark or release tooling

## Verification

Commands run from `plugins/freshread/`:

- [ ] `npm run check`
- [ ] `npm test`
- [ ] `node benchmarks/run-benchmark.cjs --no-write-results`, when behavior or benchmark contracts changed
- [ ] `npm run benchmark`, only when intentionally refreshing source-bound release evidence
- [ ] Exact installed-build validation, when hooks, launchers, Marketplace metadata, or packaging changed
- [ ] `npm run benchmark:live`, when required by the release contract

Paste a concise result summary:

```text
Command:
Result:
Source digest, if applicable:
```

## Benchmark impact

<!--
State "none" with a reason, or list changed gates, before/after metrics,
environment, source digest, and links to generated evidence. Generated evidence
must not be edited by hand.
-->

## Compatibility

| Surface | Tested result |
| --- | --- |
| Windows | |
| macOS | |
| Linux | |
| Codex version(s) | |
| Node.js version(s) | |

## Documentation and release notes

- [ ] English and Simplified Chinese README claims remain aligned
- [ ] Coverage/benchmark contracts are updated where needed
- [ ] `CHANGELOG.md` is updated, or the change is not user-visible
- [ ] Installation, upgrade, rollback, and trust implications are documented

## Security and privacy

- [ ] No secrets, private file contents, raw credentials, personal paths, or unsanitized protocol captures are included
- [ ] New failure paths fail safely within the documented protection boundary
- [ ] Tests cover relevant denial and corruption paths
- [ ] I reviewed launcher, path-resolution, persistence, and supply-chain impact

## Checklist

- [ ] The pull request is focused and contains no unrelated cleanup
- [ ] New behavior has regression tests
- [ ] Public claims do not exceed demonstrated coverage
- [ ] I have read `CONTRIBUTING.md` and will follow `CODE_OF_CONDUCT.md`
