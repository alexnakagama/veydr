# Tasks

## 1. Workflow

- [x] 1.1 Add `.github/workflows/website.yml` (design W1–W4). Verify: `actionlint` reports nothing; `npm test` passes.
- [x] 1.2 Allow `secrets.VERCEL_DEPLOY_HOOK` only in `website.yml` in `test/unit/workflow-policy.test.ts`, and add tests that run the step with a fake `curl`. Tag `release-automation/published-release-changes`, `draft-changed` and `deploy-hook-missing-or-rejected`. Verify: `npm test` and `npm run spec-coverage` pass.

## 2. Documentation

- [x] 2.1 Add `website.yml` to the pipeline overview in `docs/ci.md`, add a "Website" section with the one-time setup, and update the workflow security rules. Verify: the section exists and the rules match the test.

## 3. On GitHub

- [ ] 3.1 Create the deploy hook in Vercel (project `veydr-web`, branch `master`) and store it as the Actions secret `VERCEL_DEPLOY_HOOK`.
- [ ] 3.2 After merging, run **Actions → Website → Run workflow** on `master`. Verify: the run passes, its notice names a Vercel job, and a new deployment appears in Vercel. Record it under [Run records](../../../docs/ci.md#run-records).
- [ ] 3.3 With the next published release, check that the run starts by itself and the site shows the new version.
