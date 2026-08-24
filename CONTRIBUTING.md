# Contributing to FreshRead

Thank you for helping make FreshRead safer and more useful. Contributions of
code, tests, documentation, compatibility reports, and reproducible benchmark
evidence are welcome.

> 中文提示：欢迎提交代码、测试、文档和兼容性报告。请先阅读本文件；安全漏洞不要
> 公开提交 Issue，请按 [SECURITY.md](SECURITY.md) 私下报告。

By participating, you agree to follow the
[Code of Conduct](CODE_OF_CONDUCT.md). By submitting a contribution, you agree
that it may be distributed under the project's [MIT License](LICENSE).

## Before you start

- Search existing issues and pull requests before opening a duplicate.
- Use a GitHub issue for a reproducible bug or a focused feature request.
- Discuss broad architectural changes before investing in a large patch.
- Report security-sensitive findings privately as described in
  [SECURITY.md](SECURITY.md).
- Keep changes narrowly scoped. Unrelated cleanup makes safety review harder.

FreshRead is a guardrail, so false assurances are more harmful than explicit
limitations. New behavior must fail safely, document its coverage boundary, and
include tests for both the protected and unsupported paths.

## Repository layout

The repository-level Marketplace metadata and project governance live at the
repository root. The installable plugin lives at `plugins/freshread/`:

```text
.agents/plugins/marketplace.json   Git-backed Marketplace catalog
.github/                           Repository automation and templates
plugins/freshread/
  .codex-plugin/plugin.json        Plugin identity and interface metadata
  hooks/hooks.json                 Codex lifecycle hook declarations
  skills/freshread/                Model-facing workflow instructions
  scripts/                         Hook launchers and command entry points
  src/                             Freshness state and guard logic
  tests/                           Unit, contract, edge-case, and hardening tests
  benchmarks/                      Deterministic and live release evidence
  docs/                            Coverage and benchmark contracts
```

Do not edit a copy under Codex's installed plugin cache. Change the source tree,
reinstall the plugin, and start a new Codex thread.

## Development setup

Requirements:

- Git
- Node.js 18.18 or newer; testing the current active LTS is recommended
- A supported Codex build for installation or lifecycle-hook testing

The plugin currently has no third-party runtime packages and no compilation
step. From the repository root:

```shell
node tools/validate-release.mjs --plugin-root plugins/freshread --marketplace .agents/plugins/marketplace.json
cd plugins/freshread
npm run check
npm test
```

`npm run check` performs JavaScript syntax validation. `npm test` runs the
deterministic test suite serially.

## Testing expectations

Every behavior change should include:

- a regression test that fails without the change;
- a success-path test and the relevant conservative-denial or failure path;
- Windows and POSIX considerations when launcher or path behavior changes;
- updated coverage documentation when the protected surface changes.

Run before opening a pull request:

```shell
cd plugins/freshread
npm run check
npm test
node benchmarks/run-benchmark.cjs --no-write-results
```

The no-write benchmark is the normal pull-request check. `npm run benchmark`
writes source-bound release evidence under
`plugins/freshread/benchmarks/results/` and should be used only when
intentionally refreshing a release candidate's checked-in artifacts. Do not
hand-edit generated benchmark artifacts or claim results produced from a
different source digest.

### Live lifecycle benchmark

`npm run benchmark:live` is a release gate, not a routine unit test. Run it only
when all of the following are true:

1. the exact candidate source has passed the deterministic benchmark;
2. that exact plugin build is installed from the intended Marketplace;
3. all current FreshRead hooks have been reviewed, trusted, and enabled;
4. the Codex executable and environment meet the benchmark contract; and
5. no source file changes during the run.

The live report must match the deterministic source digest. Never weaken a
latency, security, provenance, or exact-lifecycle gate merely to turn a failing
release candidate green. Diagnose the regression or document an intentional,
reviewed contract change.

## Making a change

1. Fork the repository and create a focused branch from `main`.
2. Add or update tests before changing externally visible claims.
3. Implement the smallest safe change.
4. Run the checks above.
5. Update relevant documentation and `CHANGELOG.md`.
6. Open a pull request using the repository template.

Preferred commit subjects follow Conventional Commit style:

```text
fix: preserve freshness evidence across resume
feat: recognize a new reliable read carrier
docs: clarify Marketplace installation
test: cover a launcher denial path
```

This convention helps release-note generation, but a clear, reviewable history
is more important than mechanical formatting.

## Pull-request requirements

A pull request should:

- explain the user-visible problem and the chosen safety behavior;
- identify affected hook events, tools, platforms, and state transitions;
- include exact commands and results used for verification;
- disclose benchmark changes and their source digest;
- avoid secrets, raw private file contents, machine paths, or unsanitized
  protocol captures;
- update documentation and the changelog when behavior or support changes; and
- remain small enough to review as one coherent change.

Maintainers may request additional compatibility or live evidence for changes
to launchers, hook definitions, path canonicalization, persistence, command
analysis, or pre-edit denial behavior.

## Documentation

The English and Simplified Chinese READMEs describe the same product. If a
change affects installation, safety, coverage, commands, or compatibility,
update both:

- `README.md`
- `README.zh-CN.md`

Detailed contracts belong in `plugins/freshread/docs/`. Avoid claiming support
outside tested lifecycle events, tools, platforms, or path forms.

## Release changes

Only maintainers publish releases. A release candidate must have:

- aligned Marketplace, plugin, package, tag, and changelog versions;
- passing required CI and plugin validation;
- deterministic benchmark evidence bound to the candidate source;
- the required matching live lifecycle evidence;
- a clean-install verification from the Git-backed Marketplace;
- a reproducible plugin archive and published SHA-256 checksum; and
- release notes that state supported platforms and known limitations.

Publish from an immutable annotated `vX.Y.Z` tag. If asset publication fails
after the tagged source and package have passed, fix the workflow on `main` and
use **Actions → Release → Run workflow** with that existing tag. The recovery
path checks out and revalidates the tag; never move or overwrite a published
release tag to pick up a workflow fix.

See [CHANGELOG.md](CHANGELOG.md) for the public history.

## Getting help

Use a GitHub issue with the appropriate template for bugs, feature requests, or
compatibility reports. Include versions and a minimal reproduction, but redact
workspace content, tokens, account details, local usernames, and absolute paths
that are not necessary to understand the problem.
