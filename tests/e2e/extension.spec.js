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
  // 「退出」必须真的关掉编辑器，且不触发扩展错误边界
  // （回归：events.js 漏 import close 时，绑定到的是 window.close → Illegal invocation）
  await page.locator('#iwb-editor-overlay [data-action="cancel"]').click()
  await expect(page.locator('#iwb-editor-overlay')).toBeHidden()
  await expect(page.locator('#iwb-cutout-toast')).toBeHidden()
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
 * 拖拽路径补覆盖：onMouseDown/onMove/onUp 拆成「编排器 + 分发表 + 处理器」后，
 * 放置 / 平移 / 位图层拖拽 / 文字拖拽这四条分支没有任何自动化覆盖。
 * 下面 4 条用例的断言全部落在画布像素与几何上（包围盒位移、预览中心位移、
 * stack transform、图层落位），而不是"元素可见"。
 *
 * 坐标约定：编辑器内一律用「图片坐标」（0..imgW），按下前先用
 * elementFromPoint 校验目标点确实落在 canvas-stack 子树里（点不中的话
 * mousedown 根本不会派发到画布编排器上，用例会静默地什么都不做）。
 */

/** 图片坐标 → 屏幕坐标 + 命中校验。基准取第一个位图图层 canvas：
 *  它正好覆盖图片区域；与 getPos()（canvas-stack 矩形 + overlayPad 换算）
 *  只差一个 round(pad*scale) ≤ 1px 的取整误差。 */
async function imageToScreen(page, points) {
  return page.evaluate((pts) => {
    const c = document.querySelector('.iwb-editor-layer-canvas')
    const r = c.getBoundingClientRect()
    const scale = r.width / c.width
    const stack = document.querySelector('.iwb-editor-canvas-stack')
    return pts.map((p) => {
      const x = r.left + p.x * scale
      const y = r.top + p.y * scale
      const el = document.elementFromPoint(x, y)
      return { ix: p.x, iy: p.y, x, y, hit: !!el && (el === stack || stack.contains(el)), at: el ? String(el.className || el.tagName) : 'none' }
    })
  }, points)
}

function assertHit(s, label) {
  if (!s.hit) throw new Error(`${label} 未命中 canvas-stack：图片坐标 (${s.ix}, ${s.iy}) → 屏幕 (${Math.round(s.x)}, ${Math.round(s.y)})，命中的是 ${s.at}`)
}

/** 悬停到图片坐标（只移动鼠标，用于 hover 光标断言） */
async function hoverOnImage(page, at, label) {
  const [s] = await imageToScreen(page, [at])
  assertHit(s, label || 'hover')
  await page.mouse.move(s.x, s.y)
  return s
}

/** 在图片坐标上单击（按下前校验命中） */
async function clickOnImage(page, at, label) {
  const s = await hoverOnImage(page, at, label || 'click')
  await page.mouse.click(s.x, s.y)
  return s
}

/** 在图片坐标上按下并拖到另一个图片坐标（按下前校验命中） */
async function dragOnImage(page, from, to, steps, label) {
  const [a, b] = await imageToScreen(page, [from, to])
  assertHit(a, `${label || 'drag'} 起点`)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps: steps || 8 })
  await page.mouse.up()
  return { a, b }
}

/** 一组画布里「某种颜色」非透明像素的包围盒（canvas 像素坐标 = 图片坐标） */
async function colorBBox(page, selector, colorKey) {
  return page.evaluate(
    ({ selector, colorKey }) => {
      const match = {
        red: (r, g, b, a) => a > 8 && r > 200 && g < 120 && b < 120,
        green: (r, g, b, a) => a > 8 && g > 150 && r < 120 && b < 160,
        orange: (r, g, b, a) => a > 8 && r > 200 && g > 120 && g < 210 && b < 120
      }[colorKey] || ((r, g, b, a) => a > 8)
      let minX = Infinity
      let minY = Infinity
      let maxX = -1
      let maxY = -1
      let count = 0
      for (const c of document.querySelectorAll(selector)) {
        if (!c.width || !c.height) continue
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
        for (let y = 0; y < c.height; y++) {
          for (let x = 0; x < c.width; x++) {
            const i = (y * c.width + x) * 4
            if (!match(d[i], d[i + 1], d[i + 2], d[i + 3])) continue
            count++
            if (x < minX) minX = x
            if (y < minY) minY = y
            if (x > maxX) maxX = x
            if (y > maxY) maxY = y
          }
        }
      }
      return maxX < 0 ? null : { minX, minY, maxX, maxY, count }
    },
    { selector, colorKey }
  )
}

/** 位图图层里某种颜色的包围盒 */
function layerColorBBox(page, colorKey) {
  return colorBBox(page, '.iwb-editor-layer-canvas', colorKey)
}

/** 矢量对象画布（文字/形状各占一张）的非透明像素包围盒 */
function vecBBox(page) {
  return colorBBox(page, '.iwb-editor-vec-canvas', 'any')
}

/** overlay 上某种颜色的包围盒（选中框=橙 / 放置预览=绿） */
function overlayColorBBox(page, colorKey) {
  return colorBBox(page, '.iwb-editor-crop-overlay', colorKey)
}

/** 放置预览里导入图的包围盒，换算成图片坐标（overlay 比图片多一圈 overlayPad）。
 *  注意：放置框的 8 个手柄是 16×16 的白块，会盖住放置框四周，
 *  所以这里量到的是「预览中心那块没被手柄盖住的区域」，只适合做相对位移断言。 */
async function placementBox(page) {
  const box = await overlayColorBBox(page, 'green')
  if (!box) return null
  const pad = await page.evaluate(() => {
    const ov = document.querySelector('.iwb-editor-crop-overlay')
    const lc = document.querySelector('.iwb-editor-layer-canvas')
    return (ov.width - lc.width) / 2
  })
  return { minX: box.minX - pad, minY: box.minY - pad, maxX: box.maxX - pad, maxY: box.maxY - pad, count: box.count }
}

/** 画布光标：S.drawCanvasCursor 会把光标写到每一个位图图层 canvas 上 */
const canvasCursor = (page) =>
  page.evaluate(() => {
    const c = document.querySelector('.iwb-editor-layer-canvas')
    return c ? c.style.cursor || '' : ''
  })

/** 在 guess 附近网格上扫画布光标，返回第一个满足条件的图片坐标（用来精确命中手柄） */
async function findCanvasCursor(page, guess, match, radius = 8, step = 2) {
  const pts = []
  for (let dy = -radius; dy <= radius; dy += step)
    for (let dx = -radius; dx <= radius; dx += step) pts.push({ x: guess.x + dx, y: guess.y + dy })
  const spots = await imageToScreen(page, pts)
  for (const s of spots) {
    if (!s.hit) continue
    await page.mouse.move(s.x, s.y)
    const cur = await canvasCursor(page)
    if (match(cur)) return { x: s.ix, y: s.iy, cursor: cur }
  }
  return null
}

const stackTransform = (page) => page.evaluate(() => document.querySelector('.iwb-editor-canvas-stack').style.transform || '')

/** 解析 setView 写下的 translate3d(xpx, ypx, 0px) */
function parseTranslate(t) {
  const m = /translate3d\((-?\d+(?:\.\d+)?)px,\s*(-?\d+(?:\.\d+)?)px/.exec(t || '')
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null
}

test('编辑器行为：位图层拖拽移动内容 → 包围盒按位移移动 → 撤销回位（像素级）', async () => {
  const page = await openFixture()
  await openEditorCentered(page)

  // base 层锁定不可拖，先在「画笔标注」层画一笔，给可拖拽的位图层一份非空内容
  await page.locator('.iwb-editor-brush-preset[data-brush-size="8"]').click()
  const [p0, p1] = await imageToScreen(page, [{ x: 10, y: 9 }, { x: 46, y: 44 }])
  await page.mouse.move(p0.x, p0.y)
  await page.mouse.down()
  await page.mouse.move(p1.x, p1.y, { steps: 12 })
  await page.mouse.up()
  await expect.poll(async () => (await layerColorBBox(page, 'red'))?.count || 0, { timeout: 5_000 }).toBeGreaterThan(200)

  // 选择工具在内容上按下（无选中态时 hitBitmapHandle 返回 null → hitBitmapLayer → beginBitmapDrag move）
  const before = await layerColorBBox(page, 'red')
  await page.locator('.iwb-editor-tool[data-tool="select"]').click()
  const from = { x: Math.round((before.minX + before.maxX) / 2), y: Math.round((before.minY + before.maxY) / 2) }
  await dragOnImage(page, from, { x: from.x + 8, y: from.y + 5 }, 8, '位图层拖拽')

  const after = await layerColorBBox(page, 'red')
  expect(after.count).toBeGreaterThan(before.count * 0.7) // 内容被搬走而不是被擦掉
  // 右/下边缘正好平移 8/5px；左/上边缘允许 ±2px —— layerBounds 用 step=2 采样，
  // _srcBox 可能切掉最外侧 1px 墨迹，属于实现细节而非断言目标
  expect(after.maxX).toBeGreaterThanOrEqual(before.maxX + 7)
  expect(after.maxX).toBeLessThanOrEqual(before.maxX + 9)
  expect(after.maxY).toBeGreaterThanOrEqual(before.maxY + 4)
  expect(after.maxY).toBeLessThanOrEqual(before.maxY + 6)
  expect(after.minX).toBeGreaterThanOrEqual(before.minX + 6)
  expect(after.minX).toBeLessThanOrEqual(before.minX + 10)
  expect(after.minY).toBeGreaterThanOrEqual(before.minY + 3)
  expect(after.minY).toBeLessThanOrEqual(before.minY + 7)

  // 撤销 → 像素级回到原位（快照把整层像素 putImageData 回去）
  await page.locator('.iwb-editor-action[data-action="undo"]').click()
  await expect.poll(async () => layerColorBBox(page, 'red'), { timeout: 5_000 }).toEqual(before)
  await page.close()
})

test('编辑器行为：文字拖拽移动 + 缩放/旋转手柄 → 撤销回位（像素级）', async () => {
  const page = await openFixture()
  await openEditorCentered(page)

  await page.locator('.iwb-editor-tool[data-tool="text"]').click()
  await clickOnImage(page, { x: 18, y: 20 }, '文字落点')
  const input = page.locator('.iwb-editor-text-input')
  await expect(input).toBeVisible()
  await input.fill('AB')
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await vecBBox(page))?.count || 0, { timeout: 5_000 }).toBeGreaterThan(50)
  const before = await vecBBox(page)

  // 提交后文字默认是选中态（commitTextInput 设 selectedTextId）。不清掉选择的话，
  // 选择工具按下会先命中 hitTextHandle(R=12/zoom) → 走缩放手柄而不是移动。
  // 且 hideTextInput 不 blur，焦点还停在那个隐藏的 input 上，直接按 Esc 会被 isTyping 吞掉。
  await page.evaluate(() => document.activeElement && document.activeElement.blur())
  await page.keyboard.press('Escape')
  await expect.poll(async () => overlayColorBBox(page, 'orange'), { timeout: 5_000 }).toBeNull()

  // 从字形包围盒中心按下（无选中 → hitTextHandle 返回 null → hitAnyObject → textDrag move）
  const from = { x: Math.round((before.minX + before.maxX) / 2), y: Math.round((before.minY + before.maxY) / 2) }
  await dragOnImage(page, from, { x: from.x + 8, y: from.y + 5 }, 8, '文字移动')
  const moved = await vecBBox(page)
  expect(moved.minX - before.minX).toBeGreaterThanOrEqual(6)
  expect(moved.minX - before.minX).toBeLessThanOrEqual(10)
  expect(moved.minY - before.minY).toBeGreaterThanOrEqual(3)
  expect(moved.minY - before.minY).toBeLessThanOrEqual(7)
  expect(moved.count).toBe(before.count) // 纯平移：非透明像素数不变

  await page.locator('.iwb-editor-action[data-action="undo"]').click()
  await expect.poll(async () => vecBBox(page), { timeout: 5_000 }).toEqual(before)

  // 重新选中（原地按下抬起，不产生位移）：overlay 上应出现橙色选中框
  await dragOnImage(page, from, from, 1, '文字重选')
  await expect.poll(async () => overlayColorBBox(page, 'orange'), { timeout: 5_000 }).not.toBeNull()

  // 缩放手柄：文字角点附近扫到 resize 光标后，朝文字中心拖 → 字号变小 → 矢量包围盒收缩
  const scalePt = await findCanvasCursor(page, { x: before.minX, y: before.minY }, (cur) => cur.includes('resize'))
  expect(scalePt, '未在文字角点附近探到缩放手柄光标').not.toBeNull()
  const center = { x: (before.minX + before.maxX) / 2, y: (before.minY + before.maxY) / 2 }
  await dragOnImage(page, scalePt, { x: scalePt.x + (center.x - scalePt.x) * 0.4, y: scalePt.y + (center.y - scalePt.y) * 0.4 }, 6, '文字缩放')
  const scaled = await vecBBox(page)
  expect(scaled.maxX - scaled.minX).toBeLessThan(before.maxX - before.minX - 2)

  // 旋转手柄：四角外侧 26/zoom 处的圆点，扫到旋转光标后绕中心拖 → 轴对齐包围盒变形
  const rotPt = await findCanvasCursor(page, { x: scaled.maxX + 18, y: scaled.minY - 18 }, (cur) => cur.startsWith('url('))
  expect(rotPt, '未在文字角外侧探到旋转手柄光标').not.toBeNull()
  const rc = { x: (scaled.minX + scaled.maxX) / 2, y: (scaled.minY + scaled.maxY) / 2 }
  const a0 = Math.atan2(rotPt.y - rc.y, rotPt.x - rc.x)
  const radius = Math.hypot(rotPt.x - rc.x, rotPt.y - rc.y)
  const a1 = a0 + (25 * Math.PI) / 180
  await dragOnImage(page, rotPt, { x: rc.x + radius * Math.cos(a1), y: rc.y + radius * Math.sin(a1) }, 10, '文字旋转')
  const rotated = await vecBBox(page)
  const dw = Math.abs((rotated.maxX - rotated.minX) - (scaled.maxX - scaled.minX))
  const dh = Math.abs((rotated.maxY - rotated.minY) - (scaled.maxY - scaled.minY))
  expect(Math.max(dw, dh)).toBeGreaterThanOrEqual(2)
  await page.close()
})

test('编辑器行为：抓手/空格平移画布 → transform 等于鼠标位移 → 适应复位', async () => {
  const page = await openFixture()
  await openEditorCentered(page)
  const initial = await stackTransform(page)
  expect(initial).toMatch(/^translate3d\(/)

  // 抓手工具：setView 把鼠标位移直接写进 translate3d
  await page.locator('.iwb-editor-tool[data-tool="hand"]').click()
  const [a, b] = await imageToScreen(page, [{ x: 32, y: 32 }, { x: 40, y: 38 }])
  assertHit(a, '抓手拖拽起点')
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps: 8 })
  await page.mouse.up()

  const afterHand = await stackTransform(page)
  expect(afterHand).not.toBe(initial)
  const d0 = parseTranslate(initial)
  const d1 = parseTranslate(afterHand)
  expect(Math.abs(d1.x - d0.x - (b.x - a.x))).toBeLessThanOrEqual(1)
  expect(Math.abs(d1.y - d0.y - (b.y - a.y))).toBeLessThanOrEqual(1)

  // 同一个 onPanMouseDown 分支的另一个入口：任意工具下按住空格拖拽
  await page.keyboard.down('Space')
  const [a2, b2] = await imageToScreen(page, [{ x: 32, y: 32 }, { x: 36, y: 30 }])
  assertHit(a2, '空格拖拽起点')
  await page.mouse.move(a2.x, a2.y)
  await page.mouse.down()
  await page.mouse.move(b2.x, b2.y, { steps: 6 })
  await page.mouse.up()
  await page.keyboard.up('Space')

  const afterSpace = await stackTransform(page)
  expect(afterSpace).not.toBe(afterHand)
  const d2 = parseTranslate(afterSpace)
  expect(Math.abs(d2.x - d1.x - (b2.x - a2.x))).toBeLessThanOrEqual(1)
  expect(Math.abs(d2.y - d1.y - (b2.y - a2.y))).toBeLessThanOrEqual(1)

  // 适应窗口：viewX/viewY 归 null → 回到打开编辑器时的居中 transform（逐字节相同）
  await page.locator('.iwb-editor-zoom-fit[data-action="zoomFit"]').click()
  await expect.poll(() => stackTransform(page), { timeout: 5_000 }).toBe(initial)
  await page.close()
})

test('编辑器行为：导入图片为新图层 → 放置框拖拽 → 画布外点击确认落位（像素级）', async () => {
  const page = await openFixture()
  await openEditorCentered(page)
  const layersBefore = await page.locator('.iwb-editor-layer-canvas').count()
  const itemsBefore = await page.locator('.iwb-layer-item').count()
  expect(layersBefore).toBe(2)

  // 导入图必须够大：放置默认尺寸 = 画布的 50%（64×64 → 32×32）。
  // 1×1 会被压成 10×10，中心距 n/s/e/w 手柄只有 8px < R=12/zoom，按下会命中手柄变成缩放。
  const dataUrl = await page.evaluate(() => {
    const c = document.createElement('canvas')
    c.width = 32
    c.height = 32
    const g = c.getContext('2d')
    g.fillStyle = '#00c878'
    g.fillRect(0, 0, 32, 32)
    return c.toDataURL('image/png')
  })
  const png = Buffer.from(dataUrl.split(',')[1], 'base64')

  // 扩展在点击「导入图片为新图层」时才动态创建 input 并 .click()，
  // 文件选择框必须由 Playwright 拦截（先注册 waitForEvent，再等一次往返让订阅落到 CDP，最后点击）
  const chooserPromise = page.waitForEvent('filechooser', { timeout: 15_000 })
  await page.evaluate(() => 0)
  await page.locator('.iwb-editor-layer-add-btn[data-action="addBitmapLayer"]').click()
  const chooser = await chooserPromise
  await chooser.setFiles({ name: 'import-green.png', mimeType: 'image/png', buffer: png })

  // 进入放置模式：overlay 上出现绿色预览。注意放置阶段不落图层 —— 图层要确认后才 +1
  await expect.poll(async () => placementBox(page), { timeout: 10_000 }).not.toBeNull()
  const box0 = await placementBox(page)
  const center0 = { x: (box0.minX + box0.maxX) / 2, y: (box0.minY + box0.maxY) / 2 }
  expect(Math.abs(center0.x - 32)).toBeLessThanOrEqual(1) // 默认居中
  expect(Math.abs(center0.y - 32)).toBeLessThanOrEqual(1)

  // hover 光标：放置框外 → default；框内 → move（onPlacementHoverMove 的两个分支）
  await hoverOnImage(page, { x: 2, y: 38 }, '放置框外')
  await expect.poll(() => canvasCursor(page), { timeout: 5_000 }).toBe('default')
  await hoverOnImage(page, center0, '放置框内')
  await expect.poll(() => canvasCursor(page), { timeout: 5_000 }).toBe('move')

  // 拖动放置框（图片坐标 +8/+6 → 预览中心跟着走同样距离）
  await dragOnImage(page, center0, { x: center0.x + 8, y: center0.y + 6 }, 8, '放置框拖拽')
  const box1 = await placementBox(page)
  const center1 = { x: (box1.minX + box1.maxX) / 2, y: (box1.minY + box1.maxY) / 2 }
  expect(Math.abs(center1.x - center0.x - 8)).toBeLessThanOrEqual(1)
  expect(Math.abs(center1.y - center0.y - 6)).toBeLessThanOrEqual(1)
  expect(box1.count).toBe(box0.count) // 只是移动没缩放：绿色面积不变

  // 点放置框外 = 确认放置（onPlacementMouseDown 的 else 分支）。
  // 确认点取画布左缘 x=1：放置框左缘在 interior.minX-8，只要 interior.minX ≥ 20，
  // 它与最近的 w 手柄距离就 >12（R=12/zoom），不会误触手柄。
  expect(box1.minX).toBeGreaterThanOrEqual(20)
  await clickOnImage(page, { x: 1, y: Math.round(center1.y) }, '放置确认')

  await expect.poll(async () => overlayColorBBox(page, 'green'), { timeout: 5_000 }).toBeNull()
  await expect.poll(async () => page.locator('.iwb-editor-layer-canvas').count(), { timeout: 5_000 }).toBe(layersBefore + 1)
  await expect(page.locator('.iwb-layer-item')).toHaveCount(itemsBefore + 1)

  // 新图层确实落在拖拽后的位置：内容 = 整张导入图（32×32），中心 = 预览中心
  const landed = await layerColorBBox(page, 'green')
  expect(landed).not.toBeNull()
  expect(landed.maxX - landed.minX + 1).toBeGreaterThanOrEqual(30)
  expect(landed.maxX - landed.minX + 1).toBeLessThanOrEqual(33)
  expect(landed.maxY - landed.minY + 1).toBeGreaterThanOrEqual(30)
  expect(landed.maxY - landed.minY + 1).toBeLessThanOrEqual(33)
  expect(Math.abs((landed.minX + landed.maxX) / 2 - center1.x)).toBeLessThanOrEqual(2)
  expect(Math.abs((landed.minY + landed.maxY) / 2 - center1.y)).toBeLessThanOrEqual(2)
  await page.close()
})
