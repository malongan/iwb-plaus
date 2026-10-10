import { defineConfig } from '@playwright/test'

/**
 * 扩展 e2e 需要持久化上下文 + --load-extension，因此不用 test.use 的默认启动方式，
 * 由每个 spec 自己调用 helpers.mjs 里的 launchExtension()。
 * Chromium 用 Playwright 自带的构建（品牌版 Chrome 137+ 已禁用 --load-extension）。
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results'
})
