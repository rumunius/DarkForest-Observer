import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import {
  documentedExports,
  spacedClassMethods,
  namedFunctions,
  moduleLayout,
  explicitReturnGenerics,
} from './scripts/eslint_rules.mjs';

const restrictedTypeScriptSyntax = [
  {
    selector: 'TSEnumDeclaration[const=true]',
    message: 'Use a regular enum; const enum erases the runtime contract.',
  },
  {
    selector: 'TSImportEqualsDeclaration, TSExportAssignment',
    message: 'Use ES module imports and named exports.',
  },
  {
    selector: 'TSImportType',
    message: 'Use a top-level import type instead of import() annotations.',
  },
  {
    selector: 'PrivateIdentifier',
    message: 'Use TypeScript private visibility instead of #private fields.',
  },
  {
    selector:
      'TSTypeAliasDeclaration > TSUnionType > :matches(TSUndefinedKeyword, TSNullKeyword)',
    message: 'Add null or undefined where the type alias is used.',
  },
];

export default tseslint.config(
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
    plugins: {
      project: {
        rules: {
          'documented-exports': documentedExports,
          'spaced-class-methods': spacedClassMethods,
          'named-functions': namedFunctions,
          'module-layout': moduleLayout,
          'explicit-return-generics': explicitReturnGenerics,
        },
      },
    },
  },
  {
    files: ['apps/**/*.{ts,tsx}', 'packages/**/*.ts', 'scripts/*.{mjs,mts}'],
    rules: {
      'project/documented-exports': 'error',
      'project/spaced-class-methods': 'error',
      'project/named-functions': 'error',
    },
  },
  {
    linterOptions: {reportUnusedDisableDirectives: 'error'},
    rules: {
      'project/module-layout': 'error',
      curly: ['error', 'all'],
      'one-var': ['error', 'never'],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-new-wrappers': 'error',
      'no-caller': 'error',
      'no-proto': 'error',
      'guard-for-in': 'error',
      'no-return-assign': ['error', 'always'],
      'default-case': 'error',
      'default-case-last': 'error',
      eqeqeq: ['error', 'always', {null: 'ignore'}],
    },
  },
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    extends: [...tseslint.configs.recommended],
    rules: {
      '@typescript-eslint/array-type': ['error', {default: 'array-simple'}],
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        {assertionStyle: 'as', objectLiteralTypeAssertions: 'never'},
      ],
      '@typescript-eslint/no-inferrable-types': 'error',
      '@typescript-eslint/prefer-for-of': 'error',
      '@typescript-eslint/prefer-readonly': 'error',
      '@typescript-eslint/no-namespace': [
        'error',
        {allowDeclarations: false, allowDefinitionFiles: true},
      ],
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-expect-error': true,
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
        ...restrictedTypeScriptSyntax,
      ],
    },
  },
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    rules: {'project/explicit-return-generics': 'error'},
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
    rules: {
      'no-restricted-syntax': ['error', ...restrictedTypeScriptSyntax],
    },
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
  {
    files: ['tests/**/*.{ts,tsx,mts,cts}'],
    rules: {
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
    },
  },
  prettier,
  // eslint-config-prettier disables curly too; 'all' is compatible with Prettier.
  {rules: {curly: ['error', 'all']}},
);
