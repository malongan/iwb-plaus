/* 错误边界：把"扩展内部炸了"从静默的 console 变成用户可感知、可反馈的信息
 *
 * 此前所有失败路径都只 console.error，用户看到的只是"按钮点了没反应"。
 * 现在：
 *   1. installErrorBoundary() 捕获未处理异常 / Promise 拒绝（编辑器、工具条、注入链路都在其中）
 *   2. recordError() 落盘到 chrome.storage.local['iwb_last_error']，popup 能读到
 *   3. 通过 onFatal 回调弹一次 toast（带节流，避免刷屏）
 * chrome / window 均可注入，便于在 node/jsdom 下单测。
 */

export const LAST_ERROR_KEY = 'iwb_last_error'

/** 同类错误的提示节流窗口（节流状态由每个边界实例各自持有，见 installErrorBoundary） */
const TOAST_THROTTLE_MS = 10_000

function toEntry(err, source) {
  const message = err && err.message ? String(err.message) : String(err)
  return {
    message,
    source: source || 'unknown',
    stack: err && err.stack ? String(err.stack).split('\n').slice(0, 5).join('\n') : '',
    at: Date.now()
  }
}

/**
 * 记录一次错误（落盘，供 popup「最近一次错误」展示）
 * @returns {Promise<{message:string,source:string,stack:string,at:number}>}
 */
export async function recordError(err, source, chromeRef = globalThis.chrome) {
  const entry = toEntry(err, source)
  try {
    if (chromeRef && chromeRef.storage && chromeRef.storage.local) {
      await chromeRef.storage.local.set({ [LAST_ERROR_KEY]: entry })
    }
  } catch {
    // 落盘失败不能影响主流程
  }
  return entry
}

/** 读取最近一次错误 */
export async function readLastError(chromeRef = globalThis.chrome) {
  try {
    if (chromeRef && chromeRef.storage && chromeRef.storage.local) {
      const res = await chromeRef.storage.local.get(LAST_ERROR_KEY)
      return res[LAST_ERROR_KEY] || null
    }
  } catch {
    /* ignore */
  }
  return null
}

/** 清除最近一次错误 */
export async function clearLastError(chromeRef = globalThis.chrome) {
  try {
    if (chromeRef && chromeRef.storage && chromeRef.storage.local) {
      await chromeRef.storage.local.remove(LAST_ERROR_KEY)
    }
  } catch {
    /* ignore */
  }
}

/**
 * 安装全局错误边界
 * @param {{onFatal?: (entry:object)=>void, windowRef?: any, chromeRef?: any}} [opts]
 * @returns {{dispose: ()=>void}} 可卸载（测试与编辑器关闭时用）
 */
export function installErrorBoundary(opts = {}) {
  const w = opts.windowRef || globalThis
  const chromeRef = opts.chromeRef
  const onFatal = typeof opts.onFatal === 'function' ? opts.onFatal : null
  /** 节流状态归本实例（同一 source 10 秒内只提示一次） */
  const lastToastAt = new Map()

  const handle = async (err, source) => {
    const entry = await recordError(err, source, chromeRef)
    if (!onFatal) return
    const now = Date.now()
    const prev = lastToastAt.get(entry.source) || 0
    if (now - prev >= TOAST_THROTTLE_MS) {
      lastToastAt.set(entry.source, now)
      try {
        onFatal(entry)
      } catch {
        /* 提示失败不能再抛 */
      }
    }
    return entry
  }

  const onError = (event) => {
    // error 事件里可能是资源加载失败（event.target 有值），只处理脚本异常
    if (event && event.target && event.target !== w && event.target.tagName) return
    const err = (event && (event.error || event.reason)) || (event && event.message) || event
    handle(err, 'window.onerror')
  }
  const onRejection = (event) => handle((event && event.reason) || event, 'unhandledrejection')

  if (typeof w.addEventListener === 'function') {
    w.addEventListener('error', onError)
    w.addEventListener('unhandledrejection', onRejection)
  }

  return {
    dispose() {
      if (typeof w.removeEventListener === 'function') {
        w.removeEventListener('error', onError)
        w.removeEventListener('unhandledrejection', onRejection)
      }
    }
  }
}

/** 面向用户的一句话摘要（toast 用） */
export function describeError(entry) {
  if (!entry) return '发生未知错误'
  const msg = entry.message || '未知错误'
  return `扩展内部错误（${entry.source}）：${msg.slice(0, 120)} — 详见插件弹窗「最近一次错误」`
}
