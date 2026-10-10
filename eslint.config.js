import js from '@eslint/js'
import globals from 'globals'

/**
 * 关键约束：no-undef 必须是 error。
 * 阶段四会把 4114 行的 editor.js 拆成多个模块，拆分漏掉 import 时
 * esbuild 不会报错（未解析标识符会被当成全局变量），只有这条规则能抓到。
 */
export default [
  {
    ignores: [
      'node_modules/**',
      'build/**',
      'iwb-cutout-extension/dist/**',
      'test-results/**',
      'playwright-report/**',
      'coverage/**'
    ]
  },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
        ...globals.node,
        chrome: 'readonly'
      }
    },
    rules: {
      'no-undef': 'error',
      'no-empty': ['error', {allowEmptyCatch: true}],
      // 旧代码里大量"预留但未用"的字段，先降级为警告，避免掩盖 no-undef
      'no-unused-vars': ['warn', {argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none'}],
      'no-constant-condition': ['error', {checkLoops: false}]
    }
  },
  {
    files: ['tests/**/*.js', 'scripts/**/*.mjs', '*.config.js'],
    languageOptions: {
      globals: {...globals.node}
    }
  }
]
