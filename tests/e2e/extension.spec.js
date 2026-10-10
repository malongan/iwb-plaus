import {test, expect} from '@playwright/test'
import {startFakeApi, launchExtension, closeExtension, waitForExtension, setConfig} from './helpers.mjs'

/** 扩展 e2e：真实加载 build/e2e-ext，在复刻宿主 DOM 的 fixture 页面上跑端到端链路 */

let server
let context

test.beforeAll(async () => {
  server = await startFakeApi()
  context = await launchExtension({headless: true})
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

const logText = page => page.evaluate(() => document.getElementById('log').textContent || '')

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
  await page.waitForFunction(() => (document.getElementById('log').textContent || '').includes('NEWFILE:'), null, {
    timeout: 20_000
  })
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
  await page.waitForFunction(() => (document.getElementById('log').textContent || '').includes('NEWFILE:'), null, {
    timeout: 20_000
  })
  expect(await logText(page)).toContain('_800x800.png')
  await page.close()
})

test('替换模式：结果写回节点头部的 file input', async () => {
  await setConfig(context, {replaceMode: true})
  try {
    const page = await openFixture()
    await page.locator('#iwb-cutout-toolbar .iwb-cutout-btn').click()
    await page.waitForFunction(() => (document.getElementById('log').textContent || '').includes('FILE:'), null, {
      timeout: 20_000
    })
    expect(await logText(page)).toMatch(/FILE:.*_cutout\.png/)
    await page.close()
  } finally {
    await setConfig(context, {replaceMode: false})
  }
})

test('编辑器：点击紫色按钮能打开全屏编辑器', async () => {
  const page = await openFixture()
  await page.locator('#iwb-cutout-toolbar .iwb-editor-btn-icon').click()
  await expect(page.locator('#iwb-editor-overlay')).toBeVisible({timeout: 15_000})
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
      if (info && info.active) orig({url: 'http://127.0.0.1:*/fixture*'}, t => cb(t))
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
  await page.route('**/fixture*', async route => {
    const resp = await route.fetch()
    const body = (await resp.text()).replace(/iwb-ref-single/g, 'iwb-ref-renamed')
    await route.fulfill({response: resp, body})
  })
  await page.goto(server.url('/fixture'))

  // init() 3 秒后跑一次宿主契约自检
  await expect(page.locator('.iwb-cutout-toast')).toBeVisible({timeout: 10_000})
  await expect(page.locator('.iwb-cutout-toast')).toContainText('宿主页面结构可能已变化')
  await page.close()
})

test('最近一次错误：错误边界落盘后 popup 可查看与清除', async () => {
  const sw = await waitForExtension(context)
  // content 的错误边界会把未处理异常写进 chrome.storage，这里直接模拟一条
  await sw.evaluate(async () => {
    await chrome.storage.local.set({
      iwb_last_error: {message: '模拟的内部异常', source: 'window.onerror', stack: '', at: Date.now()}
    })
  })
  const extId = new URL(sw.url()).host
  const popup = await context.newPage()
  await popup.goto(`chrome-extension://${extId}/popup.html`)

  const section = popup.locator('#errSection')
  await expect(section).toBeVisible()
  await expect(popup.locator('#lastError')).toContainText('模拟的内部异常')
  await expect(popup.locator('#verText')).toHaveText(/^v\d/)

  await popup.click('#clearErrBtn')
  await expect(section).toBeHidden()
  await popup.close()
})

/**
 * 编辑器行为级（像素级）用例 —— T23 函数级拆分的前置安全网。
 * 断言的不是"元素出现了"，而是画布像素真的被改变、被撤销、被导出。
 */

/** 编辑器位图图层里"红色笔迹"的像素数（画笔默认色 #ff4444） */
async function redPixelsInEditor(page) {
  return page.evaluate(() => {
    const layers = [...document.querySelectorAll('.iwb-editor-layer-canvas')]
    let red = 0
    for (const c of layers) {
      if (!c.width || !c.height) continue
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] > 200 && d[i + 1] < 120 && d[i + 2] < 120 && d[i + 3] > 10) red++
      }
    }
    return { red, layers: layers.length }
  })
}

/** 解析注入到宿主的导出文件：尺寸 + 红/蓝像素统计 */
async function injectedFilePixels(page) {
  return page.evaluate(async () => {
    const inputs = [...document.querySelectorAll('input[type=file]')].filter((i) => i.files && i.files.length)
    if (!inputs.length) return { found: false }
    const file = inputs[inputs.length - 1].files[0]
    const bmp = await createImageBitmap(file)
    const c = document.createElement('canvas')
    c.width = bmp.width
    c.height = bmp.height
    const g = c.getContext('2d')
    g.drawImage(bmp, 0, 0)
    const d = g.getImageData(0, 0, c.width, c.height).data
    let red = 0
    let blue = 0
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 10) continue
      if (d[i] > 200 && d[i + 1] < 120 && d[i + 2] < 120) red++
      if (d[i + 2] > 200 && d[i] < 120 && d[i + 1] < 140) blue++
    }
    return { found: true, name: file.name, width: bmp.width, height: bmp.height, red, blue }
  })
}

test('编辑器行为：画笔上色 → 撤销 → 重做 → 导出（像素级）', async () => {
  const page = await openFixture()
  await page.locator('#iwb-cutout-toolbar .iwb-editor-btn-icon').click()
  await expect(page.locator('#iwb-editor-overlay')).toBeVisible({ timeout: 15_000 })

  // 位图图层已就位（原图层 + 画笔层）
  await expect.poll(async () => (await redPixelsInEditor(page)).layers).toBeGreaterThanOrEqual(2)
  const before = await redPixelsInEditor(page)
  expect(before.red).toBe(0) // 未绘制时不应有红像素

  // 加粗笔刷：3px 在 64px 画布上采样容错太低
  await page.locator('.iwb-editor-brush-preset[data-brush-size="8"]').click()

  // 画一笔。注意：不能用 .iwb-editor-canvas-stack 的 boundingBox ——
  // 它含 overlayPad(893px) 且被 translate 推到视口外，盒子中心不在可见画布上；
  // 真正可点的是图层 canvas 本身（坐标换算走的是同一套算术，产品行为正常）。
  const box = await page.locator('.iwb-editor-layer-canvas').first().boundingBox()
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx + 20, cy + 12, { steps: 8 })
  await page.mouse.up()

  await expect.poll(async () => (await redPixelsInEditor(page)).red).toBeGreaterThan(0)

  // 撤销 → 红像素归零（快照恢复真的把图层像素还原了）
  await page.locator('.iwb-editor-action[data-action="undo"]').click()
  await expect.poll(async () => (await redPixelsInEditor(page)).red, { timeout: 5_000 }).toBe(0)

  // 重做 → 红像素回来
  await page.locator('.iwb-editor-action[data-action="redo"]').click()
  await expect.poll(async () => (await redPixelsInEditor(page)).red, { timeout: 5_000 }).toBeGreaterThan(0)

  // 导出为新节点：导出的 PNG 必须同时带着原图内容（蓝）与这一笔（红）
  await page.locator('.iwb-editor-btn-new').click()
  await page.waitForFunction(
    () => (document.getElementById('log').textContent || '').includes('NEWFILE:'),
    null,
    { timeout: 15_000 }
  )
  const out = await injectedFilePixels(page)
  expect(out.found).toBe(true)
  expect(out.name).toMatch(/_edited\.png$/)
  expect(out.width).toBe(64)
  expect(out.height).toBe(64)
  expect(out.blue).toBeGreaterThan(0) // 原图内容没丢
  expect(out.red).toBeGreaterThan(0) // 这一笔在导出结果里

  await page.close()
})
