# Security

## Supported versions

Security fixes go into the latest release on npm (`npm view memory-pulse version`). Upgrade with
`npx -y memory-pulse@latest install-hook`. Hooks installed for your user run a pinned copy, so running `install-hook` again is
what moves them; hooks installed with `--project` run `npx -y memory-pulse`, the latest release, on each call.

## Reporting a vulnerability

Report privately by email to security@strategic-innovations.ai, or through the repository's **Security** tab,
**Report a vulnerability**, when that button is shown. Please do not open a public issue for a vulnerability. Include the version, the host (Claude Code, Codex, the GitHub Action), and the smallest steps that
reproduce it. You will get an acknowledgement within two business days.

What counts, for this project:

- the guard lets through an edit, command or tool call that a recorded correction or a declared rule blocks, and says nothing
- a hook hangs, crashes or exits 0 where it should block
- the ledger's hash chain or seal accepts a row it should reject
- the client reads or writes outside the project and the paths it documents, or sends anything the README says stays local
- the GitHub Action reports a pass on a change it did not read

## How releases are made

Releases are published from GitHub Actions by npm trusted publishing (OIDC), so each version from 0.3.3 on carries a provenance
attestation that names the workflow and commit it was built from (0.1.0 to 0.3.2 were published before that and carry none).
`npm view memory-pulse@<version> dist.attestations` shows it. The package has no
dependencies. The workflows pin each third-party action to a full commit SHA.
