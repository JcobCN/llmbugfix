import tsParser from '@typescript-eslint/parser';
export default [
  { ignores: ['**/dist/**', '**/node_modules/**'] },
  { files: ['**/*.ts'], ignores: ['**/*.d.ts'], languageOptions: { parser: tsParser }, rules: { 'no-undef': 'off', 'no-unused-vars': 'off' } },
];
