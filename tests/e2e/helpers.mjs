import { chromium } from '@playwright/test'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(here, '../..')
export const EXT_PATH = path.join(ROOT, 'build/e2e-ext')

/** 鲜艺抠图默认端口 —— 直接占住它，扩展无需改配置就会打到我们的假服务 */
export const API_PORT = 30092

/** 1x1 PNG，作为"抠图结果"返回 */
const CUTOUT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
)

/**
 * 起一个进程内的假服务：
 *   GET  /fixture  -> 复刻宿主 DOM 的测试页
 *   HEAD /rmbg     -> 200（popup 的"测试连接"用）
 *   POST /rmbg     -> 记录收到的字节数并返回透明 PNG
 *   GET  /__stats  -> 测试断言用的计数
 */
export function startFakeApi() {
  const fixtureHtml = fs.readFileSync(path.join(here, 'fixture.html'))
  const stats = { cutoutRequests: [], lastBodyBytes: 0 }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${API_PORT}`)

    if (url.pathname === '/rmbg') {
      if (req.method === 'HEAD') {
        res.writeHead(200)
        res.end()
        return
      }
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const body = Buffer.concat(chunks)
        stats.lastBodyBytes = body.length
        stats.cutoutRequests.push({ bytes: body.length, query: url.search })
        res.writeHead(200, { 'Content-Type': 'image/png' })
        res.end(CUTOUT_PNG)
      })
      return
    }

    if (url.pathname === '/__stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(stats))
      return
    }

    if (url.pathname === '/fixture' || url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(fixtureHtml)
      return
    }

    res.writeHead(404)
    res.end('not found')
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(API_PORT, '127.0.0.1', () => {
      resolve({
        stats,
        url: (p) => `http://127.0.0.1:${API_PORT}${p}`,
        close: () => new Promise((r) => server.close(r))
      })
    })
  })
}

/**
 * 定位 Chromium 可执行文件。
 * 本机沙箱不允许 Playwright 往 ~/Library/Caches/ms-playwright 写安装锁，
 * 所以优先复用缓存目录里已有的构建；找不到就交给 Playwright 自己解析。
 */
function resolveChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  const roots = [
    path.join(os.homedir(), 'Library/Caches/ms-playwright'),
    path.join(os.homedir(), '.cache/ms-playwright'),
    process.env.PLAYWRIGHT_BROWSERS_PATH
  ].filter(Boolean)

  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    let dirs = []
    try {
      dirs = fs.readdirSync(root).filter((d) => d.startsWith('chromium-')).sort().reverse()
    } catch {
      continue
    }
    for (const d of dirs) {
      const candidates = [
        path.join(root, d, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
        path.join(root, d, 'chrome-linux', 'chrome'),
        path.join(root, d, 'chrome-linux64', 'chrome')
      ]
      const hit = candidates.find((c) => fs.existsSync(c))
      if (hit) return hit
    }
  }
  return undefined
}

/** 启动加载了扩展的持久化上下文 */
export async function launchExtension({ headless = true } = {}) {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error(`e2e 扩展目录缺失：${EXT_PATH}（先跑 node scripts/build.mjs --e2e）`)
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iwb-e2e-profile-'))
  const executablePath = resolveChromium()
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless,
    executablePath,
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`]
  })
  context.__userDataDir = userDataDir
  return context
}

/** 等待扩展的 MV3 service worker 就绪（顺带确认扩展真的加载成功了） */
export async function waitForExtension(context, timeout = 15_000) {
  const existing = context.serviceWorkers()[0]
  if (existing) return existing
  try {
    return await context.waitForEvent('serviceworker', { timeout })
  } catch {
    throw new Error('扩展 service worker 未启动 —— 扩展可能没加载成功（检查 build/e2e-ext 是否存在）')
  }
}

/** 关闭上下文并清理临时 profile */
export async function closeExtension(context) {
  if (!context) return
  await context.close().catch(() => {})
  if (context.__userDataDir) {
    fs.rmSync(context.__userDataDir, { recursive: true, force: true })
  }
}

/** 读取扩展当前配置（测试用来设置 replaceMode 之类） */
export async function setConfig(context, patch) {
  const sw = await waitForExtension(context)
  return sw.evaluate(async (p) => {
    const KEY = 'iwb_cutout_config'
    const cur = (await chrome.storage.local.get(KEY))[KEY] || {}
    const next = { ...cur, ...p }
    await chrome.storage.local.set({ [KEY]: next })
    return next
  }, patch)
}
