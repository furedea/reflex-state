# Releasing ReflexState

The release workflow is [release_please.yml](../.github/workflows/release_please.yml). It keeps
versioning and distribution in separate jobs in one workflow, following the agent-harness
release flow. Build provenance and npm publication use the same tested tarball.

## Prepare the first preview

Keep implementation review and publication separate. Open the implementation pull request and
require its CI checks, including the Node.js 22 and 24 package smoke tests, to pass before merge.
Do not dispatch the release workflow, create a release tag, or enable auto-merge while preparing it.

Before publication:

1. Review the [verification evidence and outstanding live checks](spec/phase0_findings.md).
   A provider request rejected for missing credentials or exhausted quota is not live validation.
   Record a short Pi demonstration only after the real edit/test/resume flow succeeds.
2. In the repository's **About** settings, use `package.json`'s `description` and `keywords` as
   the source for the GitHub description and topics. Keep npm and GitHub discovery text aligned.
3. Check `npm view reflex-state name version dist-tags --json` and confirm ownership before
   publishing. A registry 404 is only a point-in-time observation, not a reservation or a
   guarantee that the account can publish that name.
4. Complete the account setup below. A maintainer must configure credentials through GitHub
   and npm; never put their values into repository files, PR text, or chat.
5. Review the [draft preview notes](preview_notes.md) and replace their draft status only when
   the release is actually published. Keep unverified integrations explicit.

## Account setup

Before merging the first Release Please PR:

1. Set the repository secret `RELEASE_PLEASE_TOKEN` to a GitHub token with access to this
   repository and Contents, Issues, and Pull requests write permissions. This follows the
   agent-harness convention and lets generated release PRs trigger CI. The built-in
   `GITHUB_TOKEN` would not trigger those checks.
2. Enable GitHub immutable releases in the repository settings. The workflow creates a draft,
   attaches all assets, and publishes it only after npm succeeds. Drafts remain resumable;
   published releases must be corrected with a new version. Use **Settings → General → Releases
   → Enable release immutability**; this setting does not publish a release.
3. If `reflex-state` does not yet exist on npm, reserve first publication for this workflow.
   Set `NPM_BOOTSTRAP_TOKEN` to a short-lived npm granular credential authorized to create the
   package and publish from CI (including the required 2FA bypass). The workflow uses it only
   when the package itself does not exist and publishes with explicit provenance. Confirm
   package-name availability and account ownership before merging the release PR.
4. Once the package exists, register an npm Trusted Publisher with owner `furedea`, repository
   `reflex-state`, and workflow filename `release_please.yml`. Allow direct `npm publish`.
   Revoke the bootstrap credential and remove its GitHub secret. Existing packages always
   use OIDC; a leftover bootstrap credential is ignored.

Trusted Publisher settings belong to an existing npm package. Staged publishing also cannot
create a brand-new package. The bootstrap step closes that first-publication gap while retaining
provenance for the first preview. No npm credentials are needed to build or check a package locally.

Sources: [release-please authentication](https://github.com/googleapis/release-please-action#other-actions-on-release-please-prs),
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/),
[npm provenance](https://docs.npmjs.com/generating-provenance-statements/),
and [staged publishing prerequisites](https://docs.npmjs.com/staged-publishing/).

## Release a preview

Use Conventional Commits for changes merged to `main`. Release Please maintains a release PR
with the package version, release manifest, and changelog. Review and merge that PR when ready
to publish. The first version is `0.1.0-alpha.1`; later preview changes increment the alpha
sequence. Before 1.0, compatible changes use patch bumps and breaking changes use minor bumps,
following agent-harness's compatibility convention. Promotion to 1.0 is deliberate.

The workflow checks that the tag, package version, GitHub prerelease status, and npm channel
agree. It checks the source, builds once, packs once, installs that tarball in an empty
directory, loads the extension through Pi's real loader, and exercises the packaged CLI.
GitHub receives the tarball, `checksums.txt`, and `provenance.json`. npm receives the identical
tarball under `next`. Generated GitHub source archives are separate from this built package.

For local verification:

```sh
pnpm check
pnpm package:check
```

`package:check` uses npm to install production dependencies in a temporary directory. It does
not call a model provider or TypeSafe. CI also runs this package check on Node.js 22 and 24.
Live provider and Jev compatibility still require the opt-in checks documented in the README.

## Resume a failed draft

Run the workflow at the same tag you are resuming:

```sh
gh workflow run release_please.yml --repo furedea/reflex-state \
  --ref v0.1.0-alpha.1 -f tag_name=v0.1.0-alpha.1
```

Do not select `main` and merely pass an old tag as input. Attestation records the workflow's
source commit; the workflow rejects a different checked-out commit. This also handles a
release created by a later `main` run after its release PR merged.

Only drafts can be resumed. Attachments may be replaced while a release is a draft. If npm
already has the version, the publisher compares its SHA-512 integrity to the newly tested
tarball and skips publication only when they match. A different digest fails without replacing
the npm version. Fix code or build differences in a new version instead of moving a release tag.

## Verify a downloaded artifact

Download the tarball and `checksums.txt` into the same directory, then run:

```sh
sha256sum -c checksums.txt
gh attestation verify reflex-state-0.1.0-alpha.1.tgz --repo furedea/reflex-state
```

On macOS, use `shasum -a 256 -c checksums.txt`. Attestation establishes the build's origin and
artifact digest; it does not establish correctness or absence of vulnerabilities.

## Promote to a stable release

Change `prerelease` to `false` and `versioning` to `default` in `release_please_config.json`,
remove `prerelease-type`, and change `publishConfig.tag` to `latest` in `package.json`.
Use a `Release-As: 0.1.0` commit footer for the first stable version and inspect the release PR.
Publish a new stable package version; do not retag the alpha tarball as the stable release.

The version manifest tracks the last release and is maintained by Release Please. Its initial
`0.0.0` value means no release has been published; it is not an npm package version to publish.
