import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';

// Graduate a scope only after the full typed audit for that scope is clean.
export const typedFiles = [
  'packages/contracts/src/**/*.ts',
  'scripts/*.d.mts',
  'apps/web/src/data/**/*.ts',
  'apps/web/src/components/cut_frame.tsx',
  'apps/match-worker/src/domain/**/*.ts',
  'apps/match-worker/src/rpc/**/*.ts',
  'apps/match-worker/src/security/**/*.ts',
  'apps/match-worker/src/platform/security.ts',
  'apps/match-worker/src/services/accounts.ts',
  'apps/match-worker/src/services/engine.ts',
  'apps/match-worker/src/services/life.ts',
  'apps/match-worker/src/scheduler/events.ts',
];

/** Audit uses the same policy, expanding only the type-checked file scope. */
export function createLintConfig({typecheckAll = false} = {}) {
  return tseslint.config(
    {
      ignores: [
        '**/node_modules/**',
        '**/dist/**',
        '**/.wrangler/**',
        '**/coverage/**',
        '**/.private/**',
        '**/.tmp/**',
        '**/.firecrawl/**',
        '**/.tavily/**',
        '**/.codegraph/**',
      ],
    },
    js.configs.recommended,
    {
      linterOptions: {reportUnusedDisableDirectives: 'error'},
      rules: {
        curly: ['error', 'all'],
        'one-var': ['error', 'never'],
        'no-var': 'error',
        'prefer-const': 'error',
        'no-eval': 'error',
        'no-new-func': 'error',
        'no-new-wrappers': 'error',
        eqeqeq: ['error', 'always', {null: 'ignore'}],
      },
    },
    {
      files: ['**/*.{ts,tsx,mts,cts}'],
      extends: [...tseslint.configs.recommended],
      rules: {
        '@typescript-eslint/array-type': ['error', {default: 'array-simple'}],
        '@typescript-eslint/consistent-type-definitions': [
          'error',
          'interface',
        ],
        '@typescript-eslint/consistent-type-imports': 'error',
        '@typescript-eslint/no-namespace': [
          'error',
          {allowDeclarations: false, allowDefinitionFiles: true},
        ],
        '@typescript-eslint/ban-ts-comment': [
          'error',
          {
            'ts-expect-error': 'allow-with-description',
            'ts-ignore': true,
            'ts-nocheck': true,
            'ts-check': false,
            minimumDescriptionLength: 10,
          },
        ],
        '@typescript-eslint/naming-convention': [
          'error',
          {
            selector: 'default',
            format: ['camelCase'],
            leadingUnderscore: 'allow',
          },
          {
            selector: 'variable',
            format: ['camelCase', 'UPPER_CASE', 'PascalCase'],
            leadingUnderscore: 'allow',
          },
          {selector: 'function', format: ['camelCase', 'PascalCase']},
          {selector: 'typeLike', format: ['PascalCase']},
          {
            selector: [
              'property',
              'parameterProperty',
              'method',
              'accessor',
              'enumMember',
              'import',
            ],
            format: null,
          },
        ],
        'no-restricted-syntax': [
          'error',
          {
            selector: 'ExportDefaultDeclaration',
            message:
              'Use named exports; framework entry points have explicit exceptions.',
          },
        ],
      },
    },
    {
      files: typecheckAll ? ['**/*.{ts,tsx,mts,cts}'] : typedFiles,
      extends: [...tseslint.configs.recommendedTypeChecked],
      languageOptions: {
        parserOptions: {
          tsconfigRootDir: import.meta.dirname,
          project: [
            'apps/web/tsconfig.app.json',
            'apps/web/tsconfig.functions.json',
            'apps/match-worker/tsconfig.json',
            'packages/contracts/tsconfig.json',
            'tsconfig.tools.json',
            'tests/tsconfig.frontend.json',
            'tests/tsconfig.json',
          ],
        },
      },
    },
    {
      files: ['apps/web/src/**/*.{ts,tsx}'],
      plugins: {'react-hooks': reactHooks},
      rules: {
        'react-hooks/rules-of-hooks': 'error',
        'react-hooks/exhaustive-deps': 'error',
      },
    },
    {
      files: [
        '**/vite.config.ts',
        'vitest*.config.ts',
        'apps/match-worker/src/index.ts',
      ],
      rules: {'no-restricted-syntax': 'off'},
    },
    {
      files: ['apps/web/src/**/*.{ts,tsx}', 'packages/contracts/src/**/*.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              'cloudflare:*',
              '@darkforest/match-worker',
              '@darkforest/match-worker/*',
              '**/match-worker/**',
              '**/functions/**',
            ],
          },
        ],
      },
    },
    prettier,
    // eslint-config-prettier disables curly too; 'all' is compatible with Prettier.
    {rules: {curly: ['error', 'all']}},
  );
}

export default createLintConfig();
