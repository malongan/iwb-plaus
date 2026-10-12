/* 宿主原图字节解析：把工作区里的图片引用还原成可编辑的 dataURL
 *
 * 背景：宿主画布为了性能只渲染 ≤1024px 的预览图（解码即缩放），
 * 原图字节以引用形式存在宿主的两处存储里：
 *   {__blob: 'imgblob_<hash>_<len>'}  → IndexedDB  iwb_web(v3) / store 'images'
 *   {__cache: '/__iwb_cache__/<hash>'} → Cache Storage 'iwb-images-local'
 * 两者都与页面同源，内容脚本可直接读取（无需宿主配合、无需 MAIN world）。
 *
 * 依赖全部经 deps 注入（idb/caches/origin/F FileReader），便于 jsdom 单测；
 * 解析失败一律返回 null，绝不抛错 —— 调用方负责回落到 DOM 预览图。
 */

/** 宿主图片 Blob 仓库的 IndexedDB 契约（与宿主 src/storage-indexeddb.js 默认值一致） */
export const HOST_IDB_NAME = 'iwb_web'
export const HOST_IDB_VERSION = 3
export const HOST_IDB_IMAGES_STORE = 'images'
/** 宿主 Cache Storage 名（与宿主 app.js CACHE_NAME / sw.js 一致） */
export const HOST_IMAGE_CACHE = 'iwb-images-local'

/** Blob → dataURL（优先 FileReader，兼容无 Blob.arrayBuffer 的环境） */
export function blobToDataUrl(blob, FileReaderCtor = globalThis.FileReader) {
  if (!blob) return Promise.resolve(null)
  if (typeof FileReaderCtor === 'function') {
    return new Promise((resolve) => {
      const reader = new FileReaderCtor()
      reader.onloadend = () => resolve(typeof reader.result === 'string' ? reader.result : null)
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(blob)
    })
  }
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer().then((buf) => {
      const bytes = new Uint8Array(buf)
      let bin = ''
      const chunk = 0x8000
      for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
      const mime = blob.type || 'image/png'
      return `data:${mime};base64,${btoa(bin)}`
    }).catch(() => null)
  }
  return Promise.resolve(null)
}

/** 打开宿主图片库 IndexedDB（不可用/版本不符时返回 null） */
function openHostIdb(indexedDB) {
  return new Promise((resolve) => {
    if (!indexedDB || typeof indexedDB.open !== 'function') { resolve(null); return }
    let req
    try { req = indexedDB.open(HOST_IDB_NAME, HOST_IDB_VERSION) } catch { resolve(null); return }
    req.onupgradeneeded = () => { /* 库不存在时由宿主负责建；这里不建以免版本漂移 */ }
    req.onsuccess = () => resolve(req.result || null)
    req.onerror = () => resolve(null)
    req.onblocked = () => resolve(null)
  })
}

/** 从 IndexedDB images store 读一个 Blob */
async function idbGetBlob(indexedDB, key) {
  const db = await openHostIdb(indexedDB)
  if (!db) return null
  try {
    if (!db.objectStoreNames.contains(HOST_IDB_IMAGES_STORE)) return null
    const value = await new Promise((resolve) => {
      const tx = db.transaction(HOST_IDB_IMAGES_STORE, 'readonly')
      const req = tx.objectStore(HOST_IDB_IMAGES_STORE).get(key)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
    })
    // 兼容 Blob 本体与历史的 { type, bytes } 形态
    if (value && typeof value === 'object' && typeof value.slice === 'function') return value
    return null
  } catch {
    return null
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
}

/** 从 Cache Storage 读虚拟路径对应的字节 */
async function cacheMatch(cachesRef, origin, path) {
  if (!cachesRef || typeof cachesRef.open !== 'function' || !path) return null
  try {
    const cache = await cachesRef.open(HOST_IMAGE_CACHE)
    if (!cache || typeof cache.match !== 'function') return null
    const url = /^https?:/i.test(path) ? path : (String(origin || '') + path)
    const resp = await cache.match(new Request(url))
    return resp && typeof resp.blob === 'function' ? await resp.blob() : null
  } catch {
    return null
  }
}

/**
 * 把宿主的图片引用解析成 { base64 } / { url } / { blobUrl }（与 getNodeImage 同形）。
 * @param {*} value 宿主 node.data.data / node.data.url 的原始值
 * @param {{indexedDB?:IDBFactory, caches?:CacheStorage, origin?:string, FileReader?:Function}} [deps]
 * @returns {Promise<{base64?:string, url?:string, blobUrl?:string}|null>} null=解析不了（调用方回落预览图）
 */
export async function resolveImageDataRef(value, deps = {}) {
  if (value == null || value === '') return null
  const FileReaderCtor = deps.FileReader || globalThis.FileReader

  // 字符串形态：dataURL / blob URL / 远端 URL
  if (typeof value === 'string') {
    if (value.startsWith('data:')) return { base64: value }
    if (value.startsWith('blob:')) return { blobUrl: value }
    if (/^https?:/i.test(value)) return { url: value }
    return null
  }

  if (typeof value === 'object') {
    // 新形态主通道：IDB Blob
    if (typeof value.__blob === 'string' && value.__blob) {
      const blob = await idbGetBlob(deps.indexedDB || globalThis.indexedDB, value.__blob)
      const base64 = await blobToDataUrl(blob, FileReaderCtor)
      return base64 ? { base64 } : null
    }
    // 旧形态/兜底：Cache Storage 虚拟路径
    if (typeof value.__cache === 'string' && value.__cache) {
      const blob = await cacheMatch(deps.caches || globalThis.caches, deps.origin || globalThis.location?.origin, value.__cache)
      const base64 = await blobToDataUrl(blob, FileReaderCtor)
      return base64 ? { base64 } : null
    }
    // 历史 {__idb} 引用：宿主读到时会自行迁移成 {__blob}，这里不重复实现
  }
  return null
}
