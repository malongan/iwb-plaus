/* base64 / bytes / File 互转的唯一实现
 *
 * 之前 background.js 与 content.js 各写了一遍 base64↔bytes 的 charCodeAt 循环，
 * 大图时这两处是热点路径，统一到这里并用更高效的写法。
 */

/** 去掉 dataURL 前缀，返回 { mime, base64 }；传普通 base64 时 mime 为 null */
export function splitDataUrl(dataUrl) {
  const s = String(dataUrl || '')
  const m = /^data:([^;,]+)?(;base64)?,/i.exec(s)
  if (!m) return { mime: null, base64: s }
  return { mime: m[1] || null, base64: s.slice(m[0].length) }
}

/** base64（可带 dataURL 前缀）→ Uint8Array */
export function base64ToBytes(input) {
  const { base64 } = splitDataUrl(input)
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/** bytes → base64（无前缀） */
export function bytesToBase64(bytes) {
  let binary = ''
  const chunk = 0x8000 // 32KB，避免超大数组爆掉 apply 参数栈
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/** bytes → dataURL */
export function bytesToDataUrl(bytes, mime = 'image/png') {
  return `data:${mime};base64,${bytesToBase64(bytes)}`
}

/** dataURL / 纯 base64 / Blob → File（Blob 直接包一层，不再过 base64 字符串往返） */
export function toFile(data, filename = 'image.png', fallbackMime = 'image/png') {
  if (data && typeof data === 'object' && typeof data.slice === 'function' && typeof data.arrayBuffer === 'function') {
    return new File([data], filename, { type: data.type || fallbackMime })
  }
  const { mime, base64 } = splitDataUrl(data)
  const bytes = base64ToBytes(base64)
  return new File([bytes], filename, { type: mime || fallbackMime })
}

/** ArrayBuffer/Uint8Array → dataURL */
export function bufferToDataUrl(buffer, mime = 'image/png') {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  return bytesToDataUrl(bytes, mime)
}
