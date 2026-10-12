/* 全扩展唯一的默认配置与校验逻辑
 *
 * 此前同样的默认值在 background.js / popup.js / content.js 各写了一遍，
 * 且三份已经不同步（background 缺 bgMode、compress*），导致调用方各自兜底。
 * 现在三处都从这里 import。
 */

/** @typedef {'white'|'transparent'} BgMode */

/** 配置在 chrome.storage.local 中的键名 */
export const CONFIG_KEY = 'iwb_cutout_config'

/** 默认值（同时是非法输入的回落值） */
export const DEFAULT_CONFIG = Object.freeze({
  apiUrl: 'http://localhost:30092',
  crop: true, // 抠图后裁掉多余透明像素
  autoConnect: true, // 新节点模式下自动连线
  replaceMode: false, // false=创建新节点，true=替换原图
  autoWhiteBg: false, // 抠图后直接生成白底大图
  bgSize: 800, // 白底画布边长
  bgRatio: 0.85, // 内容占画布比例 0~1
  bgMode: 'white', // white=白底 / transparent=透明底
  compressWidth: 1024, // 压缩目标宽度
  compressQuality: 80, // 压缩质量 10~100
  // 编辑/抠图/白底/压缩读图时优先取宿主存的原图（IndexedDB/Cache 引用），
  // 失败回落画布上的 ≤1024px 预览图。关闭后行为与旧版一致（只用预览图）。
  useOriginalImage: true
})

const clamp = (n, min, max) => Math.min(max, Math.max(min, n))

/** 数值解析：非有限数回落默认值 */
function num(v, fallback, min, max) {
  const n = typeof v === 'number' ? v : parseFloat(v)
  if (!Number.isFinite(n)) return fallback
  return clamp(n, min, max)
}

/** API 地址：只接受 http(s)，去掉结尾斜杠与多余路径 */
export function normalizeApiUrl(v) {
  const raw = String(v == null ? '' : v).trim()
  if (!raw) return DEFAULT_CONFIG.apiUrl

  // 带协议（含 ://）原样解析；不带协议的 "localhost:30092" 补 http://
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
  const candidate = hasScheme ? raw : `http://${raw}`

  try {
    const u = new URL(candidate)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return DEFAULT_CONFIG.apiUrl
    if (!u.hostname) return DEFAULT_CONFIG.apiUrl
    // origin 天然不含结尾斜杠/路径/查询串，保证 `${api}/rmbg` 拼接正确
    return u.origin
  } catch {
    return DEFAULT_CONFIG.apiUrl
  }
}

/**
 * 把任意来源（storage、表单、页面内存）的配置归一化成合法配置。
 * 未提供的字段回落到默认值，非法值被 clamp/纠正。
 * @param {Record<string, unknown>} [raw]
 */
export function mergeConfig(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const d = DEFAULT_CONFIG
  return {
    apiUrl: normalizeApiUrl(r.apiUrl != null ? r.apiUrl : d.apiUrl),
    crop: r.crop != null ? !!r.crop : d.crop,
    autoConnect: r.autoConnect != null ? !!r.autoConnect : d.autoConnect,
    replaceMode: r.replaceMode != null ? !!r.replaceMode : d.replaceMode,
    autoWhiteBg: r.autoWhiteBg != null ? !!r.autoWhiteBg : d.autoWhiteBg,
    bgSize: Math.round(num(r.bgSize != null ? r.bgSize : d.bgSize, d.bgSize, 64, 4096)),
    // 旧实现允许输入 500 存成 5.0，这里 clamp 到 0.1~1
    bgRatio: num(r.bgRatio != null ? r.bgRatio : d.bgRatio, d.bgRatio, 0.1, 1),
    bgMode: r.bgMode === 'transparent' ? 'transparent' : 'white',
    compressWidth: Math.round(num(r.compressWidth != null ? r.compressWidth : d.compressWidth, d.compressWidth, 64, 8192)),
    compressQuality: Math.round(num(r.compressQuality != null ? r.compressQuality : d.compressQuality, d.compressQuality, 10, 100)),
    useOriginalImage: r.useOriginalImage != null ? !!r.useOriginalImage : d.useOriginalImage
  }
}

/** 读取 storage 中的完整配置（background 使用） */
export function readStoredConfig(stored) {
  return mergeConfig(stored && typeof stored === 'object' ? stored : {})
}
