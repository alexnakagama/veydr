# Spec Delta

## Purpose

Defines how Veydr's Linux packages are built and released from CI: how a version is chosen and validated, what a release must pass, what it publishes, and what a failed release leaves behind.

## ADDED Requirements

### Requirement: Manually triggered release with a maintainer-chosen version
A release SHALL start only when the maintainer triggers the release workflow by hand on `master`, giving a version. Pushes and tags MUST NOT start a release.

#### Scenario: Release started from master
- **WHEN** the maintainer runs the release workflow on `master` with version `0.1.0`
- **THEN** the workflow prepares release `v0.1.0`

#### Scenario: Release started from another branch
- **WHEN** the release workflow is run on any ref other than `master`
- **THEN** it fails before building anything

### Requirement: Version validation
The requested version SHALL be a semantic version without a leading `v` and without build metadata. It MUST be strictly greater than the current `package.json` version and than every existing `vX.Y.Z` tag. Its tag MUST NOT already exist.

#### Scenario: Malformed version
- **WHEN** the requested version is `1.2`, `v1.2.3`, or `1.2.3+build.5`
- **THEN** validation fails with a message naming the expected format

#### Scenario: Version not greater than the latest
- **WHEN** the latest release tag is `v0.2.0` and the requested version is `0.2.0` or `0.1.9`
- **THEN** validation fails, naming the latest version

#### Scenario: Prerelease version
- **WHEN** the requested version has a prerelease suffix such as `0.3.0-rc.1`
- **THEN** validation succeeds and the release is marked as a prerelease

#### Scenario: Prerelease ordering
- **WHEN** the latest release tag is `v0.3.0-rc.1` and the requested version is `0.3.0`
- **THEN** validation succeeds

### Requirement: Release gate before anything is published
The release SHALL bump the version in `package.json` and `package-lock.json`. On that bumped tree it SHALL run the full verification, the end-to-end tests, packaging with the packaging tests, the distribution smoke matrix, and the packaged acceptance pass. The version commit and the tag MUST be pushed only after all of them succeed.

#### Scenario: Gate fails
- **WHEN** any gate check fails during a release
- **THEN** no commit, tag, or release is created on the remote, and the same version can be requested again

#### Scenario: Gate passes
- **WHEN** every gate check succeeds
- **THEN** one commit that changes only `package.json` and `package-lock.json` is pushed to `master`, and the tag `vX.Y.Z` pointing at it is pushed

#### Scenario: Packages carry the release version
- **WHEN** the release gate builds the packages
- **THEN** they are named `Veydr-X.Y.Z-amd64.deb` and `Veydr-X.Y.Z-x86_64.AppImage` for the requested version, following the configured artifact naming

### Requirement: Draft release with verifiable artifacts
A successful release SHALL create a draft GitHub Release for the tag, with notes generated from the changes since the previous release. Attached to it SHALL be:
- the `.deb` and AppImage packages;
- a `SHA256SUMS` file covering every attached package;
- the acceptance record of the run that tested those packages.

The release MUST NOT be published automatically.

#### Scenario: Draft created
- **WHEN** a release succeeds
- **THEN** a draft release for `vX.Y.Z` exists, with the packages, `SHA256SUMS`, and the acceptance record attached, and is not visible to the public until the maintainer publishes it

#### Scenario: Checksums match
- **WHEN** a user downloads a package and `SHA256SUMS` from a release
- **THEN** `sha256sum -c SHA256SUMS` succeeds for that package

### Requirement: Build provenance
Every package attached to a release SHALL have a build provenance attestation. The attestation ties the package's digest to the release workflow run and the source commit the run started from. The tagged commit is that source commit plus the version bump.

#### Scenario: Verifying a release package
- **WHEN** a user runs `gh attestation verify` on a downloaded package for the Veydr repository
- **THEN** verification succeeds and names the release workflow and the source commit, which is the parent of the tagged commit

### Requirement: Manual package builds
The maintainer SHALL be able to build the Linux packages from any branch, tag, or commit without creating a release. The resulting `.deb`, AppImage, and `SHA256SUMS` are kept as downloadable workflow artifacts for a limited period. A manual build MUST NOT change the version, push commits or tags, or create a release.

#### Scenario: Building a branch
- **WHEN** the maintainer runs the build workflow for a branch
- **THEN** the run produces the packages and `SHA256SUMS` as workflow artifacts, and the repository's branches, tags, and releases are unchanged

#### Scenario: Optional smoke matrix on a manual build
- **WHEN** the maintainer runs the build workflow with the smoke option enabled
- **THEN** the distribution smoke matrix runs against the built packages and its results are attached to the run
