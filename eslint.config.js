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
      // 浏览器全局里恰好有 close/open 等同名函数：漏 import 时标识符会静默解析到
      // window.close（native），点击触发的是 "Illegal invocation" 而不是 ReferenceError，
      // no-undef 抓不到 —— 这里显式禁止把这些名字当全局用（局部声明不受影响）。
      'no-restricted-globals': ['error',
        {name: 'close', message: '禁止使用全局 close（window.close 是 native，漏 import 时会变成 Illegal invocation）'},
        {name: 'open', message: '禁止使用全局 open（window.open）'}
      ],
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
