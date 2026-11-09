# Spec Delta

## ADDED Requirements

### Requirement: Website rebuilt when a published release changes
The website SHALL be rebuilt whenever a published release is published, edited, turned back into a draft or deleted, by sending one request to the Vercel deploy hook stored in the repository secret `VERCEL_DEPLOY_HOOK`. Only the website workflow MAY read that secret, and its job MUST NOT hold token scopes or run code from the repository. Changes to drafts MUST NOT trigger a rebuild. A missing, malformed or rejected hook MUST fail the run.

#### Scenario: Published release changes
- **WHEN** the maintainer publishes a release, or edits, unpublishes or deletes a published one
- **THEN** the website workflow sends one `POST` to the deploy hook and records the Vercel job id

#### Scenario: Draft changed
- **WHEN** a draft release is edited or deleted
- **THEN** the website workflow does not run its job

#### Scenario: Deploy hook missing or rejected
- **WHEN** `VERCEL_DEPLOY_HOOK` is not set, is not a Vercel deploy hook URL, or Vercel does not answer with a job id
- **THEN** the run fails with an error naming the problem, without printing the hook URL
