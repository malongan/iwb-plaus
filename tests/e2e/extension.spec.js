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

/**
 * 交互覆盖面扩展：onMouseDown/onMouseMove/onMouseUp 承载了所有工具的交互，
 * 在拆它们之前，先把钢笔 / 文字 / 矩形 / 裁剪四条主路径都变成像素级用例。
 */

/**
 * 矢量对象的非透明像素数。
 * 注意：矢量对象（文字/矩形/圆形/箭头/钢笔）不是画在 .iwb-editor-text 上，
 * 而是每个对象各占一张 .iwb-editor-vec-canvas（layers.js 的 vecCanvasFor）。
 */
async function vectorPixelsInEditor(page) {
  return page.evaluate(() => {
    let n = 0
    for (const c of document.querySelectorAll('.iwb-editor-vec-canvas')) {
      if (!c.width || !c.height) continue
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
      for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++
    }
    return n
  })
}

/** 第一个位图图层的画布尺寸（裁剪后应变小） */
async function layerCanvasSize(page) {
  return page.evaluate(() => {
    const c = document.querySelector('.iwb-editor-layer-canvas')
    return c ? { w: c.width, h: c.height } : null
  })
}

/** 打开编辑器并返回图层 canvas 中心坐标 */
async function openEditorCentered(page) {
  await page.locator('#iwb-cutout-toolbar .iwb-editor-btn-icon').click()
  await expect(page.locator('#iwb-editor-overlay')).toBeVisible({ timeout: 15_000 })
  const box = await page.locator('.iwb-editor-layer-canvas').first().boundingBox()
  return { cx: box.x + box.width / 2, cy: box.y + box.height / 2 }
}

test('编辑器行为：钢笔画三角形 → Enter 提交 → 撤销/重做（像素级）', async () => {
  const page = await openFixture()
  const { cx, cy } = await openEditorCentered(page)

  await page.locator('.iwb-editor-tool[data-tool="pen"]').click()
  await page.mouse.click(cx - 60, cy - 40)
  await page.mouse.click(cx + 70, cy - 10)
  await page.mouse.click(cx + 10, cy + 60)
  expect(await vectorPixelsInEditor(page)).toBe(0) // 未提交前不落矢量层

  await page.keyboard.press('Enter')
  await expect.poll(() => vectorPixelsInEditor(page), { timeout: 5_000 }).toBeGreaterThan(0)

  await page.locator('.iwb-editor-action[data-action="undo"]').click()
  await expect.poll(() => vectorPixelsInEditor(page), { timeout: 5_000 }).toBe(0)

  await page.locator('.iwb-editor-action[data-action="redo"]').click()
  await expect.poll(() => vectorPixelsInEditor(page), { timeout: 5_000 }).toBeGreaterThan(0)
  await page.close()
})

test('编辑器行为：文字输入 → 提交后落在矢量层（像素级）', async () => {
  const page = await openFixture()
  const { cx, cy } = await openEditorCentered(page)

  await page.locator('.iwb-editor-tool[data-tool="text"]').click()
  await page.mouse.click(cx - 40, cy)
  const input = page.locator('.iwb-editor-text-input')
  await expect(input).toBeVisible()
  await input.fill('AB')
  await page.keyboard.press('Enter')

  await expect.poll(() => vectorPixelsInEditor(page), { timeout: 5_000 }).toBeGreaterThan(0)
  await expect(input).toBeHidden()
  await page.close()
})

test('编辑器行为：矩形拖拽绘制 → 实心开关 → 撤销（像素级）', async () => {
  const page = await openFixture()
  const { cx, cy } = await openEditorCentered(page)

  await page.locator('.iwb-editor-tool[data-tool="rect"]').click()
  await page.mouse.move(cx - 45, cy - 30)
  await page.mouse.down()
  await page.mouse.move(cx + 45, cy + 30, { steps: 6 })
  await page.mouse.up()
  await expect.poll(() => vectorPixelsInEditor(page), { timeout: 5_000 }).toBeGreaterThan(0)

  // 切实心：填充后像素数应当增加
  const strokeCount = await vectorPixelsInEditor(page)
  await page.locator('.iwb-editor-fill-btn[data-action="toggleFill"]').click()
  await expect.poll(() => vectorPixelsInEditor(page), { timeout: 5_000 }).toBeGreaterThan(strokeCount)

  await page.locator('.iwb-editor-action[data-action="undo"]').click()
  await page.locator('.iwb-editor-action[data-action="undo"]').click()
  await expect.poll(() => vectorPixelsInEditor(page), { timeout: 5_000 }).toBe(0)
  await page.close()
})

test('编辑器行为：裁剪框拖拽 → 确认后图层尺寸真的变小（像素级）', async () => {
  const page = await openFixture()
  const { cx, cy } = await openEditorCentered(page)
  const before = await layerCanvasSize(page)
  expect(before).toEqual({ w: 64, h: 64 })

  await page.locator('.iwb-editor-tool[data-tool="crop"]').click()
  await page.mouse.move(cx - 20, cy - 10)
  await page.mouse.down()
  await page.mouse.move(cx + 20, cy + 10, { steps: 6 })
  await page.mouse.up()

  await page.locator('.iwb-editor-crop-confirm[data-action="confirmCrop"]').click()
  const after = await layerCanvasSize(page)
  expect(after.w).toBeLessThan(before.w)
  expect(after.h).toBeLessThan(before.h)
  await page.close()
})

/**
 * 拖拽路径覆盖：placement / panning / bitmapDrag / textDrag 这些分支
 * 在 onMouseMove/onMouseUp 拆分时完全没有自动化覆盖，这里补齐。
 */

/** 每个位图层的非透明像素包围盒 + 红色像素数（用于挑出画的那一层） */
async function layerBoxes(page) {
  return page.evaluate(() => {
    const out = []
    for (const c of document.querySelectorAll('.iwb-editor-layer-canvas')) {
      if (!c.width || !c.height) continue
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
      let minX = c.width
      let minY = c.height
      let maxX = -1
      let maxY = -1
      let red = 0
      for (let y = 0; y < c.height; y++) {
        for (let x = 0; x < c.width; x++) {
          const i = (y * c.width + x) * 4
          if (d[i + 3] > 8) {
            if (x < minX) minX = x
            if (x > maxX) maxX = x
            if (y < minY) minY = y
            if (y > maxY) maxY = y
            if (d[i] > 200 && d[i + 1] < 120 && d[i + 2] < 120) red++
          }
        }
      }
      out.push({ w: c.width, h: c.height, red, box: maxX < 0 ? null : { minX, minY, maxX, maxY } })
    }
    return out
  })
}

/** 矢量对象（文字/形状/钢笔）合并的非透明像素包围盒 */
async function vectorContentBox(page) {
  return page.evaluate(() => {
    let minX = 1e9
    let minY = 1e9
    let maxX = -1
    let maxY = -1
    for (const c of document.querySelectorAll('.iwb-editor-vec-canvas')) {
      if (!c.width || !c.height) continue
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
      for (let y = 0; y < c.height; y++) {
        for (let x = 0; x < c.width; x++) {
          if (d[(y * c.width + x) * 4 + 3] > 8) {
            if (x < minX) minX = x
            if (x > maxX) maxX = x
            if (y < minY) minY = y
            if (y > maxY) maxY = y
          }
        }
      }
    }
    return maxX < 0 ? null : { minX, minY, maxX, maxY }
  })
}

/** 覆盖层（选中框 / 裁剪遮罩 / 放置预览）的非透明像素数 */
async function overlayPixels(page) {
  return page.evaluate(() => {
    const c = document.querySelector('.iwb-editor-crop-overlay')
    if (!c || !c.width || !c.height) return 0
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
    let n = 0
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++
    return n
  })
}

/** 画布栈的 transform（平移用） */
async function stackTransform(page) {
  return page.evaluate(() => document.querySelector('.iwb-editor-canvas-stack').style.transform || '')
}

test('编辑器行为：位图层拖拽真的移动内容 → 撤销复位（像素级）', async () => {
  const page = await openFixture()
  const { cx, cy } = await openEditorCentered(page)

  // 先在画笔层画一笔（base 层默认锁定，画笔层才可被选中拖动）
  await page.locator('.iwb-editor-brush-preset[data-brush-size="8"]').click()
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx + 15, cy + 10, { steps: 4 })
  await page.mouse.up()
  const drawn = (await layerBoxes(page)).find((l) => l.red > 0)
  expect(drawn).toBeTruthy()
  const before = drawn.box

  // 切选择工具，拖动该层内容
  await page.locator('.iwb-editor-tool[data-tool="select"]').click()
  await page.mouse.move(cx + 5, cy + 5)
  await page.mouse.down()
  await page.mouse.move(cx + 45, cy + 35, { steps: 6 })
  await page.mouse.up()

  await expect
    .poll(async () => {
      const l = (await layerBoxes(page)).find((x) => x.red > 0)
      return l ? l.box.minX - before.minX : -999
    }, { timeout: 5_000 })
    .toBeGreaterThan(0)

  // 撤销 → 内容回到原位
  await page.locator('.iwb-editor-action[data-action="undo"]').click()
  await expect
    .poll(async () => {
      const l = (await layerBoxes(page)).find((x) => x.red > 0)
      return l ? l.box.minX : -1
    }, { timeout: 5_000 })
    .toBe(before.minX)
  await page.close()
})

test('编辑器行为：抓手平移画布 → 适应按钮复位（transform 断言）', async () => {
  const page = await openFixture()
  await openEditorCentered(page)
  const initial = await stackTransform(page)

  await page.locator('.iwb-editor-tool[data-tool="hand"]').click()
  const box = await page.locator('.iwb-editor-layer-canvas').first().boundingBox()
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx + 120, cy + 60, { steps: 8 })
  await page.mouse.up()

  const moved = await stackTransform(page)
  expect(moved).not.toBe(initial)

  await page.locator('.iwb-editor-zoom-fit[data-action="zoomFit"]').click()
  await expect.poll(() => stackTransform(page), { timeout: 5_000 }).toBe(initial)
  await page.close()
})

test('编辑器行为：文字拖拽移动 → 撤销复位（像素级）', async () => {
  const page = await openFixture()
  const { cx, cy } = await openEditorCentered(page)

  await page.locator('.iwb-editor-tool[data-tool="text"]').click()
  await page.mouse.click(cx - 40, cy - 20)
  await page.locator('.iwb-editor-text-input').fill('AB')
  await page.keyboard.press('Enter')
  const before = await vectorContentBox(page)
  expect(before).toBeTruthy()

  // 从文字【中心】拖：点文字原点会命中缩放手柄而不是移动（调试时踩过）
  const box = await page.locator('.iwb-editor-layer-canvas').first().boundingBox()
  const scale = box.width / 64
  const sx = box.x + ((before.minX + before.maxX) / 2) * scale
  const sy = box.y + ((before.minY + before.maxY) / 2) * scale

  await page.locator('.iwb-editor-tool[data-tool="select"]').click()
  await page.mouse.move(sx, sy)
  await page.mouse.down()
  await page.mouse.move(sx + 40, sy + 30, { steps: 6 })
  await page.mouse.up()

  await expect
    .poll(async () => {
      const b = await vectorContentBox(page)
      return b ? b.minX - before.minX : -999
    }, { timeout: 5_000 })
    .toBeGreaterThan(0)

  await page.locator('.iwb-editor-action[data-action="undo"]').click()
  await expect
    .poll(async () => {
      const b = await vectorContentBox(page)
      return b ? b.minX : -1
    }, { timeout: 5_000 })
    .toBe(before.minX)
  await page.close()
})

test('编辑器行为：导入图片为新图层 → 放置框拖拽 → 确认落位（像素级）', async () => {
  const page = await openFixture()
  const { cx, cy } = await openEditorCentered(page)
  const beforeLayers = (await layerBoxes(page)).length

  // 用 32×32 生成图：1×1 会被压成约 10×10 的放置框，中心距 n/s/e/w 手柄只有 8px，
  // 按下会命中手柄变成缩放而不是移动（几何事实，写死 1×1 会踩坑）
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas')
    c.width = 32
    c.height = 32
    const g = c.getContext('2d')
    g.fillStyle = '#22ff44'
    g.fillRect(4, 4, 24, 24)
    return c.toDataURL('image/png')
  })
  const pngBuf = Buffer.from(png.split(',')[1], 'base64')
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.iwb-editor-layer-add-btn[data-action="addBitmapLayer"]').click()
  ])
  await chooser.setFiles({ name: 'import.png', mimeType: 'image/png', buffer: pngBuf })

  // 放置模式：覆盖层上出现放置预览（位图层 canvas 此时还没建，确认放置后才落层）
  await expect.poll(() => overlayPixels(page), { timeout: 5_000 }).toBeGreaterThan(0)
  await expect.poll(async () => (await layerBoxes(page)).length, { timeout: 2_000 }).toBe(beforeLayers)

  // 在放置框内拖动（覆盖 onPlacementDragMove / onPlacementMouseUp），
  // 再用 Enter 确认（onKeydown 的放置分支）—— 比"点画布外"稳，不受坐标/手柄半径影响
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx + 60, cy + 40, { steps: 6 })
  await page.mouse.up()
  await page.keyboard.press('Enter')

  await expect.poll(async () => (await layerBoxes(page)).length, { timeout: 5_000 }).toBe(beforeLayers + 1)

  // 落位后的新图层确实带着导入的内容（非透明像素）
  const boxes = await layerBoxes(page)
  expect(boxes[boxes.length - 1].box).toBeTruthy()
  await page.close()
})
