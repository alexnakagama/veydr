import { describe, expect, it } from 'vitest'

// Task 3.3 rehearsal (add-github-actions): a deliberately failing unit test, to prove that a
// failing `unit` job makes `ci-ok` fail. Reverted on the same throwaway pull request.
describe('ci-ok rehearsal', () => {
  it('fails on purpose', () => {
    expect(1 + 1).toBe(3)
  })
})
