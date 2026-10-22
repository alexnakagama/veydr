import { defineConfig } from 'eslint/config'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

/** Files allowed to pick a platform implementation (design D5). */
export const platformSelectors = ['src/main/index.ts', 'src/main/platform/index.ts']

const platformImportMessage =
  'Import platform implementations only from the composition root; depend on src/main/platform types instead.'
const platformReadMessage =
  'Only the composition root and src/main/platform/index.ts may read process.platform.'

// esquery regexes cannot contain `/`, so `.` stands in for the path separator.
const platformPathPatterns = ['platform.(linux|windows)', '^[.]+.(linux|windows)']
const osModule = '(node:)?(os|process)'

// Routes that evade the import/property rules: namespace imports, aliasing, globalThis,
// and non-static loads of platform implementations.
const boundarySyntax = [
    {
      selector: `ImportDeclaration[source.value=/^${osModule}$/] > ImportNamespaceSpecifier`,
      message: 'Namespace imports of os/process hide platform reads; import specific members instead.',
    },
    {
      selector: "MemberExpression[property.name='platform'][object.type='MemberExpression'][object.property.name='process']",
      message: platformReadMessage,
    },
    {
      selector: "MemberExpression[property.value='platform'][object.property.name='process']",
      message: platformReadMessage,
    },
    {
      selector: "VariableDeclarator[id.type='Identifier'][init.name='process']",
      message: 'Do not alias `process`; only the composition root may inspect the platform.',
    },
    {
      selector: "AssignmentExpression[right.name='process']",
      message: 'Do not alias `process`; only the composition root may inspect the platform.',
    },
    ...platformPathPatterns.flatMap((pattern) => [
      { selector: `ImportExpression[source.value=/${pattern}/]`, message: platformImportMessage },
      { selector: `CallExpression[callee.name='require'][arguments.0.value=/${pattern}/]`, message: platformImportMessage },
    ]),
  ]

/**
 * Stricter rules for the main process, where platform branching would be a boundary violation:
 * any `.platform` property read or destructuring (this also catches renamed default imports of
 * `os`/`process`, `require('os').platform()` and `import('node:os')` results), `getBuiltinModule`,
 * and dynamic imports whose specifier is not a string literal. The renderer reads `AppInfo.platform`
 * legitimately, so these do not apply to it.
 */
export const mainBoundarySyntax = [
  ...boundarySyntax,
  {
    selector: "MemberExpression[property.name='platform'], MemberExpression[property.value='platform']",
    message: platformReadMessage,
  },
  { selector: "ObjectPattern > Property[key.name='platform']", message: platformReadMessage },
  { selector: "CallExpression[callee.property.name='getBuiltinModule']", message: platformReadMessage },
  {
    selector: "ImportExpression[source.type!='Literal']",
    message: 'Dynamic imports in the main process must use a string literal so boundary rules can see them.',
  },
]

/** Boundary rules (design D5). Exported so the lint fixture test can assert them. */
export const boundaryRules = {
  'no-restricted-imports': [
    'error',
    {
      patterns: [
        { regex: '(^|/)platform/(linux|windows)(/|$)', message: platformImportMessage },
        { regex: '^(\\.{1,2}/)+(linux|windows)(/|$)', message: platformImportMessage },
      ],
      paths: [
        { name: 'process', importNames: ['platform'], message: platformReadMessage },
        { name: 'node:process', importNames: ['platform'], message: platformReadMessage },
        { name: 'os', importNames: ['platform'], message: platformReadMessage },
        { name: 'node:os', importNames: ['platform'], message: platformReadMessage },
      ],
    },
  ],
  // Also covers destructuring (`const { platform } = process`).
  'no-restricted-properties': [
    'error',
    { object: 'process', property: 'platform', message: platformReadMessage },
    { object: 'os', property: 'platform', message: platformReadMessage },
  ],
  'no-restricted-syntax': ['error', ...boundarySyntax],
}

export default defineConfig(
  {
    ignores: ['node_modules/', 'out/', 'out-probe/', 'dist/', 'test-results/', 'playwright-report/', 'test/lint-fixtures/'],
  },
  {
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['*.mjs', 'scripts/*.mjs', 'test/e2e/support/*.cjs'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
  },
  {
    files: ['src/**/*.{ts,tsx}', 'test/lint-fixtures/**/*.ts'],
    ignores: platformSelectors,
    rules: boundaryRules,
  },
  {
    files: ['src/main/**/*.ts', 'test/lint-fixtures/**/*.ts'],
    ignores: platformSelectors,
    rules: { 'no-restricted-syntax': ['error', ...mainBoundarySyntax] },
  },
  {
    files: ['**/*.{mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { require: 'readonly', process: 'readonly' } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
  },
)
