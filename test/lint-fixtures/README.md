Files here deliberately violate the platform-boundary lint rules (design D5; known limitations are listed in docs/security-baseline.md).
`npm run lint` ignores this directory; `test/unit/lint-boundaries.test.ts`
lints each file and asserts the expected rule fires. `allowed.ts` must stay clean.
