import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Flat config, linted from the repo root in a single pass (`pnpm lint`).
 * Deliberately not a per-package turbo task: one config, one resolution root,
 * no chance of a package silently linting with no rules at all.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      // Prisma's client. Machine-written, replaced on every `db:generate`, and
      // not something a lint rule has any business having an opinion about.
      'packages/db/generated/**',
      'var/**',
      'next-env.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Everything here runs on Node or in a bundler that provides these. Without
    // declaring them, `no-undef` reports `process` and `console` as errors in
    // every server file.
    languageOptions: {
      globals: { ...globals.node, ...globals.es2022 },
    },
    rules: {
      // Unused args are fine when they document a signature; require a _ prefix.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      // TypeScript already reports an undefined identifier, and it does it with
      // full type information. Leaving the lint rule on as well only produces
      // false positives on ambient and DOM globals.
      'no-undef': 'off',
    },
  },
  {
    /**
     * Money is integer minor units, everywhere, with no exceptions.
     *
     * The whole correctness story of this app is that no amount is ever a
     * floating-point number: `0.1 + 0.2` is not `0.3`, and a cent lost to binary
     * rounding in a category total is a bug nobody notices until the numbers stop
     * adding up. `packages/shared/src/money` is the only place allowed to do the
     * conversion, and these two rules keep the arithmetic that reaches it
     * unambiguous rather than merely well-intentioned.
     */
    files: ['packages/shared/src/money/**/*.ts', 'services/import/src/**/*.ts'],
    rules: {
      'no-loss-of-precision': 'error',
      '@typescript-eslint/no-loss-of-precision': 'error',
    },
  },
  {
    /**
     * No hand-typed money in the E2E suite.
     *
     * A formatted amount is not a string you can write from memory. `es-ES`
     * renders `1234,56 €` rather than `1.234,56 €` — Spanish groups from five
     * digits, not four — and the character before the symbol is U+00A0, which is
     * indistinguishable from a space in every editor and every diff. Typing
     * either one by hand produces a red test against a page that is completely
     * correct, or worse a green `toContain` that matched a substring and proved
     * nothing.
     *
     * Both hazards vanish if the expected string comes from the same function
     * the app renders with, so the rule is: build it with `formatMoney` from
     * `@fin/shared`. Then a locale change moves both sides of the assertion
     * together.
     *
     * Scoped to `e2e/**` deliberately. `packages/shared/src/money/*.test.ts` is
     * exactly where literal expected strings belong, because there the formatter
     * is the code under test and asserting it against itself would prove nothing.
     */
    files: ['e2e/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          // A bare `$` is also a regex anchor and a shell sigil, so the symbol
          // has to be next to a digit to count as money. Without that, an e2e spec
          // asserting on the pattern `(a+)+$` is reported as a hand-typed euro
          // amount, and a rule that cries wolf is a rule people switch off.
          selector: 'Literal[value=/[€£¥]|\\$\\s?[0-9]|[0-9]\\s?\\$/]',
          message:
            'Do not hand-type a formatted money string. Build it with formatMoney() from ' +
            '@fin/shared: es-ES groups from five digits and separates with U+00A0, and a ' +
            'literal here will either fail against a correct page or pass without proving anything.',
        },
        {
          selector: 'TemplateElement[value.raw=/[€£¥]|\\$\\s?[0-9]|[0-9]\\s?\\$/]',
          message:
            'Do not hand-type a formatted money string in a template literal. Build it with ' +
            'formatMoney() from @fin/shared.',
        },
      ],
    },
  },
  {
    // Browser code additionally gets the DOM globals.
    files: ['apps/web/**/*.ts', 'apps/web/**/*.tsx'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  {
    /**
     * `consistent-type-imports` is off for the API, and this is not a style
     * preference.
     *
     * NestJS resolves constructor dependencies from the type metadata that
     * `emitDecoratorMetadata` writes at compile time. An `import type` erases
     * the class entirely, so the metadata records `undefined` and Nest fails to
     * inject at runtime with an error that points nowhere near the import. The
     * rule's autofix will happily make that change across every service, and the
     * result compiles cleanly and dies at boot.
     */
    files: ['apps/api/src/**/*.ts'],
    rules: { '@typescript-eslint/consistent-type-imports': 'off' },
  },
  {
    // Seeds, scripts and tests are allowed to talk to stdout.
    files: [
      'packages/db/prisma/**/*.ts',
      'scripts/**/*.mjs',
      '**/*.test.ts',
      'e2e/**/*.ts',
      // The log channel's whole purpose is to print instead of delivering.
      'services/notifications/src/channel.ts',
    ],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/*.test.ts', 'apps/api/test/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
