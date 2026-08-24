# Security Policy

FreshRead participates in Codex lifecycle hooks and may deny supported file
edits. Security reports are handled privately so users have time to update
before technical details are published.

> 中文提示：请勿在公开 Issue 中披露漏洞、利用步骤、私有文件内容、Token 或本机路径。
> 请通过下方的 GitHub 私密漏洞报告入口提交。

## Supported versions

Security fixes are provided for the latest tagged release.

| Version | Supported |
| --- | --- |
| Latest tagged release | Yes |
| Older releases | No |
| Unreleased `main` branch | Best effort; not a supported release |

When a fix is available, users should upgrade to the newest release and review
the updated hook definitions before trusting them.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting flow:

[Report a vulnerability privately](https://github.com/Glaz-j/codex-freshread/security/advisories/new)

If that form is unavailable, use the private contact information published on
the [`@Glaz-j` GitHub profile](https://github.com/Glaz-j). If neither private
channel is available, open a minimal issue asking the repository owner to
establish one, without identifying the vulnerable component or including
reproduction steps.

Include as much of the following as is safe:

- affected FreshRead version, tag, and commit;
- Codex, Node.js, operating-system, and installation versions;
- whether the plugin came from the Git-backed Marketplace or a release archive;
- affected hook event, launcher, tool, path form, or state transition;
- impact and realistic attack prerequisites;
- minimal reproduction steps or a proof of concept;
- whether the behavior reproduces with the latest release; and
- any proposed mitigation.

Do not include access tokens, credentials, private repository content, raw user
files, unnecessary absolute paths, or personal information. Sanitize logs and
protocol evidence before attaching them.

## Security-relevant scope

Examples of reports we want to receive privately include:

- a supported stale edit bypassing the pre-edit guard;
- a fail-open path after corrupt state or launcher failure;
- path, symlink, reparse-point, alias, or workspace-boundary confusion;
- command injection or execution of an untrusted Node.js binary;
- writes outside the documented workspace or plugin-data boundary;
- unsafe hook-definition or Marketplace supply-chain behavior;
- unauthorized disclosure of stored paths, hashes, provenance, or session data;
- state forgery that changes a supported security decision; and
- benchmark or release-provenance defects that create a false passing claim.

Coverage gaps already documented in
`plugins/freshread/docs/COVERAGE.md` are not automatically vulnerabilities.
However, a documented limitation is security-relevant if FreshRead presents it
as protected, fails less safely than documented, or exposes a practical path to
cross a stated trust boundary.

## Response targets

These are targets, not guarantees:

- acknowledgement within 3 business days;
- initial triage within 7 business days;
- a status update at least every 14 days while remediation is active; and
- coordinated publication after a fix and reasonable upgrade window exist.

The maintainer will confirm the affected versions, assess severity, prepare and
test a fix, and coordinate a release. Credit is offered unless the reporter
prefers to remain anonymous.

Please allow the project time to investigate and release a fix before public
disclosure. If we cannot reproduce the report or consider it outside the stated
security boundary, we will explain why through the private advisory.

## Safe testing

- Test only systems, repositories, and accounts you own or are authorized to
  use.
- Use synthetic files and isolated workspaces.
- Do not access, modify, retain, or publish another person's data.
- Stop testing if it could affect other users or shared infrastructure.
- Do not use social engineering, denial of service, or credential attacks.

Good-faith research that follows this policy is appreciated. This policy does
not authorize activity prohibited by law or by the terms of any third-party
service.

## Handling secrets

FreshRead does not need project credentials. Never commit tokens or secrets to
this repository, benchmark fixtures, issue reports, or release artifacts. If a
secret is accidentally committed, revoke and rotate it immediately; deleting
the latest copy is not sufficient because Git history retains prior content.
