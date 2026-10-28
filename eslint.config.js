import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/', 'build-test/', '**/build-mcpb/', '**/node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/scripts/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', URL: 'readonly', fetch: 'readonly', setTimeout: 'readonly' },
    },
  },
  {
    // Tests and e2e scripts match ANSI escapes (\x1b) on purpose.
    files: ['**/test/**/*.ts', '**/scripts/**/*.mjs'],
    rules: { 'no-control-regex': 'off' },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
