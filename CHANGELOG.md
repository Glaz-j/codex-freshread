# Changelog

All notable changes to FreshRead are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
for public releases.

> 中文提示：本文件记录面向用户的重要变化。`Unreleased` 表示尚未发布；
> 正式版本遵循语义化版本，并在 GitHub Release 中提供安装包和校验值。

## [Unreleased]

### Fixed

- Release asset publication now uses GitHub's dedicated upload endpoint and a
  tag-bound manual recovery workflow, while new releases remain drafts until
  all verified assets are present.

## [0.1.0] - 2026-08-24

### Added

- Initial public source release of FreshRead.
- Git-backed Marketplace distribution metadata and clean-install guidance.
- Repository CI, release automation, and open-source governance.
- Lifecycle-hook tracking for reliable file reads and supported edits.
- Content-identity freshness states for fresh, self-changed, externally changed,
  missing, and unknown files.
- Conservative pre-edit denial that asks Codex to re-read stale or uncertain
  targets before retrying a supported edit.
- Session persistence across supported resume and compaction lifecycle events.
- Local status, inspection, and current-session clearing diagnostics.
- Hardened Windows and POSIX launcher paths with explicit failure behavior.
- Deterministic baseline-versus-FreshRead correctness, security, and performance
  benchmarks.
- Source-bound live Codex A/B evidence for the qualified Windows workflow.
- English and Simplified Chinese documentation.

### Security

- State stores paths, hashes, timestamps, and provenance metadata rather than
  file bodies.
- Supported edit checks fail closed when freshness cannot be established.
- Launcher checks reject documented unsafe runtime and path-resolution cases.

### Known limitations

- FreshRead protects documented hook, tool, command, and path forms; it is not
  an operating-system monitor or whole-workspace audit system.
- End-to-end live release evidence is currently Windows-based. POSIX launchers
  do not yet carry the same public qualification claim.
- Unsupported or unobservable writes can remain outside the protected surface;
  consult `plugins/freshread/docs/COVERAGE.md` before relying on enforcement.
- Lifecycle warnings can miss a change that preserves the complete metadata
  tuple, including rapid same-size writes on coarse or cached timestamps;
  supported pre-edit checks still force SHA-256 before allowing an edit.

[Unreleased]: https://github.com/Glaz-j/codex-freshread/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Glaz-j/codex-freshread/releases/tag/v0.1.0
