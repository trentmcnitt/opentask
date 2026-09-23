import { defineConfig, globalIgnores } from 'eslint/config'
import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTs from 'eslint-config-next/typescript'
import prettier from 'eslint-config-prettier'

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    // Agent worktrees and their build output live under here — `npm run lint`
    // was walking other agents' `.next` bundles inside `.claude/worktrees/*`
    // and failing on generated code nobody asked it to check.
    '.claude/**',
  ]),
  {
    rules: {
      complexity: ['warn', 20],
      'max-depth': ['warn', 5],
      'max-nested-callbacks': ['warn', 4],
      'max-lines-per-function': ['warn', { max: 150, skipBlankLines: true, skipComments: true }],
      // Allow destructure-to-exclude pattern: const { unwanted, ...rest } = obj
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  prettier,
])

export default eslintConfig
