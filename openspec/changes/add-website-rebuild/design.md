# Design

## Context

The site is static. Its build reads the releases from the GitHub API, picks the newest published release that has both packages and `SHA256SUMS`, and renders the links and checksums. Rebuilding it is enough to update it. Vercel offers deploy hooks for this: a secret URL that, on a `POST`, builds the latest commit of one branch.

## Decisions

### W1: A separate workflow on `release` events, not a step in `release.yml`

`release.yml` ends with a **draft**. The site must change when the maintainer publishes it by hand, which happens after that workflow has finished. GitHub starts workflows for `release` events caused by a person; the draft that `publish` creates with the job token starts nothing, and drafts don't matter to the site anyway.

Event types: `published`, `edited` (the prerelease flag or the files of a published release can change), `unpublished` and `deleted`. GitHub also sends `edited` and `deleted` for drafts; the job's `if:` skips those. `unpublished` arrives with `draft` already `true`, so the condition names it explicitly. `workflow_dispatch` allows a rebuild by hand, for example after rotating the hook.

### W2: Nothing runs next to the secret but one `curl`

The job has `permissions: {}`, no checkout and no action. The hook is passed through `env:` and used as `"$DEPLOY_HOOK"`, never in an expression inside the script. The script checks that the value is a Vercel deploy hook URL before sending anything, so a wrong secret fails without being sent elsewhere, and it never prints the URL (GitHub masks secrets in logs as well).

Anyone holding the hook URL can start a build of the site's `master`, nothing else: it cannot change what gets built. Rotating it means creating a new hook in Vercel and replacing the secret.

### W3: Fail loudly, retry briefly

`curl --fail-with-body --retry 3 --retry-all-errors --max-time 30`. A retried `POST` at worst queues a second build of the same commit. The run succeeds only if Vercel answers with a job id, which is written to the run as a notice; otherwise the run fails with the reason. The site keeps serving its previous deployment whenever a build fails, so a failed request never takes it down.

### W4: Concurrency

One group, `website`, with `cancel-in-progress: true`: the site always builds from the current list of releases, so only the newest request matters.

## Risks

- **The secret is missing or stale.** The run fails with an error naming `VERCEL_DEPLOY_HOOK`; `docs/ci.md#website` explains how to create it.
- **GitHub API rate limits during the site's build.** Handled on the site side (`GITHUB_TOKEN` in Vercel, retries, and a production build that fails instead of publishing stale data).
