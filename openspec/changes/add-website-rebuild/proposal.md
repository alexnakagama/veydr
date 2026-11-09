# Proposal

## Why

The landing page [veydr-web.vercel.app](https://veydr-web.vercel.app) (repository `alexnakagama/veydr-web`, hosted on Vercel) shows the current version, the download links, the package sizes and the `.deb` SHA-256. It reads them from the GitHub Releases API when it is built. Nothing rebuilds it when a release is published, so after every release the site keeps offering the previous version until someone redeploys it by hand.

## What Changes

- Add `.github/workflows/website.yml`. When a release is published, edited, turned back into a draft or deleted, it sends one request to a Vercel deploy hook, which rebuilds the site from its own `master`. It can also be run by hand. Changes to drafts start nothing, since the site never shows drafts.
- The hook URL is stored as the repository secret `VERCEL_DEPLOY_HOOK`. The job has no token scopes (`permissions: {}`), uses no action, and checks out nothing, so no repository code runs next to the secret.
- A missing, malformed or rejected hook fails the run with an error that names the problem, so a release that did not reach the site shows up as a red run.
- Extend the workflow policy test: `VERCEL_DEPLOY_HOOK` may be read only in `website.yml`, as `RELEASE_DEPLOY_KEY` may be read only in `release.yml`.
- Document the workflow and the one-time setup (creating the hook and the secret) in `docs/ci.md`.
- Not in this change: anything in the release workflow itself, deploying from this repository, or the site's own code (it lives in `alexnakagama/veydr-web`).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `release-automation`: a published release also updates the website.

## Impact

- **New files**: `.github/workflows/website.yml`, this change.
- **Changed files**: `test/unit/workflow-policy.test.ts`, `docs/ci.md`.
- **Repository settings**: a new Actions secret, `VERCEL_DEPLOY_HOOK`.
- **Product**: unchanged.
