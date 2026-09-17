# ADR-0004: Publish without stored npm credentials

- Status: Accepted
- Date: 2026-09-18
- Supersedes: ADR-0003

In the context of distributing one verified package through npm and GitHub, facing the
maintainer's requirement not to store an npm publishing credential in CI and npm's
[requirement that a package exist before configuring Trusted Publishing](https://docs.npmjs.com/cli/v11/commands/npm-trust/),
we decided to keep one tested tarball with a checksum and GitHub artifact attestation, publish
that exact artifact interactively for the first version, and use OIDC for subsequent versions,
against a temporary CI bootstrap token or publishing a placeholder package solely to register
its name, to avoid managing npm secrets without losing artifact traceability, accepting one
manual first publication with GitHub attestation but no npm provenance. GitHub release completion
remains conditional on the registry containing the exact verified bytes; later OIDC publications
also receive npm provenance.
