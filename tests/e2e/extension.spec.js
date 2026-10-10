import { test, expect } from '@playwright/test'
import { startFakeApi, launchExtension, closeExtension, waitForExtension, setConfig } from './helpers.mjs'

/** 扩展 e2e：真实加载 build/e2e-ext，在复刻宿主 DOM 的 fixture 页面上跑端到端链路 */

let server
let context

test.beforeAll(async () => {
  server = await startFakeApi()
  context = await launchExtension({ headless: true })
  await waitForExtension(context)
})

test.afterAll(async () => {
  await closeExtension(context)
  if (server) await server.close()
})

async function openFixture() {
  const page = await context.newPage()
  await page.bringToFront()
  await page.goto(server.url('/fixture'))
  return page
}

const logText = (page) => page.evaluate(() => document.getElementById('log').textContent || '')

test('工具条：选中带图节点后注入 4 个工具按钮', async () => {
  const page = await openFixture()
  const toolbar = page.locator('#iwb-cutout-toolbar')
  await expect(toolbar).toBeVisible()
  await expect(toolbar.locator('button')).toHaveCount(4)
  await expect(toolbar.locator('.iwb-cutout-btn')).toBeVisible()
  await expect(toolbar.locator('.iwb-whitebg-btn')).toBeVisible()
  await expect(toolbar.locator('.iwb-compress-btn')).toBeVisible()
  await expect(toolbar.locator('.iwb-editor-btn-icon')).toBeVisible()
  await page.close()
})

test('抠图：读取图片 → 调本地 API → 作为新节点注入', async () => {
  const page = await openFixture()
  await page.locator('#iwb-cutout-toolbar .iwb-cutout-btn').click()

  // 新建节点模式（默认）：宿主新建节点后由扩展注入文件
  await page.waitForFunction(
    () => (document.getElementById('log').textContent || '').includes('NEWFILE:'),
    null,
    { timeout: 20_000 }
  )
  const log = await logText(page)
  expect(log).toContain('_cutout.png')

  // 假服务确实收到了原图字节
  const res = await page.request.get(server.url('/__stats'))
  const stats = await res.json()
  expect(stats.cutoutRequests.length).toBeGreaterThan(0)
  expect(stats.lastBodyBytes).toBeGreaterThan(0)
  await page.close()
})

test('白底图：生成 800x800 并作为新节点注入', async () => {
  const page = await openFixture()
  await page.locator('#iwb-cutout-toolbar .iwb-whitebg-btn').click()
  await page.waitForFunction(
    () => (document.getElementById('log').textContent || '').includes('NEWFILE:'),
    null,
    { timeout: 20_000 }
  )
  expect(await logText(page)).toContain('_800x800.png')
  await page.close()
})

test('替换模式：结果写回节点头部的 file input', async () => {
  await setConfig(context, { replaceMode: true })
  try {
    const page = await openFixture()
    await page.locator('#iwb-cutout-toolbar .iwb-cutout-btn').click()
    await page.waitForFunction(
      () => (document.getElementById('log').textContent || '').includes('FILE:'),
      null,
      { timeout: 20_000 }
    )
    expect(await logText(page)).toMatch(/FILE:.*_cutout\.png/)
    await page.close()
  } finally {
    await setConfig(context, { replaceMode: false })
  }
})

test('编辑器：点击紫色按钮能打开全屏编辑器', async () => {
  const page = await openFixture()
  await page.locator('#iwb-cutout-toolbar .iwb-editor-btn-icon').click()
  await expect(page.locator('#iwb-editor-overlay')).toBeVisible({ timeout: 15_000 })
  // 编辑器打开时工具条应被隐藏，避免悬浮在全屏层之上
  await expect(page.locator('#iwb-cutout-toolbar')).toBeHidden()
  await page.close()
})

test('自检：popup 的「自检」按钮渲染宿主契约命中情况', async () => {
  const fixturePage = await openFixture()
  const sw = await waitForExtension(context)
  const extId = new URL(sw.url()).host

  const popup = await context.newPage()
  // popup 以标签页方式打开时，"活动标签页"是它自己；这里把查询改指向 fixture 页，
  // 使 popup → background → content 的 RUN_PROBE 链路能在自动化里跑通。
  await popup.addInitScript(() => {
    const orig = chrome.tabs.query.bind(chrome.tabs)
    chrome.tabs.query = (info, cb) => {
      if (info && info.active) orig({ url: 'http://127.0.0.1:*/fixture*' }, (t) => cb(t))
      else orig(info, cb)
    }
  })
  await popup.goto(`chrome-extension://${extId}/popup.html`)

  await expect(popup.locator('#verText')).toHaveText(/^v\d/)
  await popup.click('#probeBtn')
  await expect(popup.locator('#probeResult')).toBeVisible()
  await expect(popup.locator('#probeResult')).toContainText('画布节点')
  await expect(popup.locator('#probeResult')).toContainText('图片选择器')
  await expect(popup.locator('#probeResult')).not.toContainText('宿主可能改版')

  await popup.close()
  await fixturePage.close()
})

test('诊断：宿主图片选择器失效时给出一次性告警', async () => {
  const page = await context.newPage()
  await page.bringToFront()
  // 把 fixture 里的图片类名改掉，模拟宿主改版（选择器匹配不到、但页面确实有图）
  await page.route('**/fixture*', async (route) => {
    const resp = await route.fetch()
    const body = (await resp.text()).replace(/iwb-ref-single/g, 'iwb-ref-renamed')
    await route.fulfill({ response: resp, body })
  })
  await page.goto(server.url('/fixture'))

  // init() 3 秒后跑一次宿主契约自检
  await expect(page.locator('.iwb-cutout-toast')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.iwb-cutout-toast')).toContainText('宿主页面结构可能已变化')
  await page.close()
})
