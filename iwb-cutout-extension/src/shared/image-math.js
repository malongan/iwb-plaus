/* 与 canvas/DOM 无关的纯计算，抽出来是为了能被单元测试直接覆盖 */

/** #rgb / #rrggbb → {r,g,b}（0~255） */
export function hexToRgb(hex) {
  const h = String(hex || '').replace('#', '')
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  return {
    r: parseInt(v.slice(0, 2), 16) || 0,
    g: parseInt(v.slice(2, 4), 16) || 0,
    b: parseInt(v.slice(4, 6), 16) || 0
  }
}

/** {r,g,b} / (r,g,b) → #rrggbb */
export function rgbToHex(r, g, b) {
  const to = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`
}

/** 裁剪比例字符串 "16:9" / "free" → 数值 (w/h)；非法返回 0（表示不限制） */
export function parseRatio(str) {
  if (str === 'free' || !str) return 0
  const parts = String(str).split(':')
  if (parts.length === 2) {
    const w = parseFloat(parts[0])
    const h = parseFloat(parts[1])
    if (w > 0 && h > 0) return w / h
  }
  return 0
}

/**
 * 把内容等比缩放并居中放进 box（白底大图 / 覆盖布局共用）
 * 内容最长边 = min(boxW, boxH) * ratio
 * @returns {{x:number,y:number,w:number,h:number,scale:number}} 无效输入返回全 0 矩形
 */
export function fitRect(srcW, srcH, boxW, boxH, ratio = 1) {
  if (!(srcW > 0) || !(srcH > 0) || !(boxW > 0) || !(boxH > 0)) {
    return { x: 0, y: 0, w: 0, h: 0, scale: 0 }
  }
  const r = Math.max(0.01, Math.min(1, ratio))
  const maxLen = Math.min(boxW, boxH) * r
  const scale = Math.min(maxLen / srcW, maxLen / srcH)
  const w = srcW * scale
  const h = srcH * scale
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h, scale }
}

/** 通用 clamp */
export function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v))
}
