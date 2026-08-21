/* IWB 鲜艺抠图节点 - 背景服务工作者
 * 职责：接收 content script 发来的图片数据，调用鲜艺抠图本地 HTTP API，返回结果
 * 鲜艺抠图 API: POST http://localhost:30092/rmbg?crop=true|false
 *   请求体: 二进制图片数据
 *   返回体: 二进制图片数据（透明背景 PNG）
 */

// 默认配置
const DEFAULT_CONFIG = {
  apiUrl: 'http://localhost:30092',
  crop: true,         // 自动裁剪透明像素
  autoConnect: true,  // 抠图后自动连接原节点和新节点
  replaceMode: false, // false=创建新节点，true=替换原图
  autoWhiteBg: false, // 抠图后自动转白底大图
  bgSize: 800,        // 白底画布边长
  bgRatio: 0.85       // 内容占画布比例
}

// 获取配置
async function getConfig() {
  const result = await chrome.storage.local.get('iwb_cutout_config')
  return { ...DEFAULT_CONFIG, ...(result.iwb_cutout_config || {}) }
}

// 调用鲜艺抠图 API
async function callCutoutAPI(imageBase64, config) {
  const base64Data = imageBase64.split(',')[1] || imageBase64
  const binaryString = atob(base64Data)
  const bytes = new Uint8Array(binaryString.length)
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }

  const apiUrl = String(config.apiUrl || 'http://localhost:30092').replace(/\/$/, '')
  const url = `${apiUrl}/rmbg?crop=${config.crop ? 'true' : 'false'}`
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: bytes
  })

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`鲜艺抠图 API 返回错误 ${resp.status}: ${errText}`)
  }

  const resultBuffer = await resp.arrayBuffer()
  const resultBytes = new Uint8Array(resultBuffer)
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < resultBytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, resultBytes.subarray(i, i + chunkSize))
  }
  const resultBase64 = btoa(binary)
  return `data:image/png;base64,${resultBase64}`
}

// 通过 URL 调用鲜艺抠图（用于在线图片 URL）
async function callCutoutAPIByUrl(imageUrl, config) {
  const apiUrl = String(config.apiUrl || 'http://localhost:30092').replace(/\/$/, '')
  const url = `${apiUrl}/rmbg?crop=${config.crop ? 'true' : 'false'}`
  // 先下载图片，再以二进制方式发送
  const imgResp = await fetch(imageUrl, { mode: 'cors' })
  if (!imgResp.ok) throw new Error(`无法下载图片: ${imgResp.status}`)
  const imgBuffer = await imgResp.arrayBuffer()
  const imgBytes = new Uint8Array(imgBuffer)

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: imgBytes
  })

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`鲜艺抠图 API 返回错误 ${resp.status}: ${errText}`)
  }

  const resultBuffer = await resp.arrayBuffer()
  const resultBytes = new Uint8Array(resultBuffer)
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < resultBytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, resultBytes.subarray(i, i + chunkSize))
  }
  const resultBase64 = btoa(binary)
  return `data:image/png;base64,${resultBase64}`
}

// 消息处理
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'CUTOUT_IMAGE') {
    getConfig().then(config => {
      if (msg.imageUrl && !msg.imageBase64) {
        return callCutoutAPIByUrl(msg.imageUrl, config)
      }
      return callCutoutAPI(msg.imageBase64, config)
    }).then(resultBase64 => {
      sendResponse({ success: true, resultBase64 })
    }).catch(err => {
      sendResponse({ success: false, error: err.message })
    })
    return true // 保持消息通道开放
  }

  if (msg.type === 'GET_CONFIG') {
    getConfig().then(config => {
      sendResponse({ success: true, config })
    })
    return true
  }

  if (msg.type === 'PING_API') {
    getConfig().then(config => {
      const apiUrl = String(msg.apiUrl || config.apiUrl).replace(/\/$/, '')
      return fetch(`${apiUrl}/rmbg`, { method: 'HEAD' })
    }).then(resp => {
      // 任何 HTTP 响应都说明服务可达；只有网络异常才判定离线。
      sendResponse({ success: true, status: resp.status })
    }).catch(err => {
      sendResponse({ success: false, error: err.message })
    })
    return true
  }

  if (msg.type === 'SAVE_CONFIG') {
    chrome.storage.local.set({ iwb_cutout_config: msg.config }).then(() => {
      sendResponse({ success: true })
    })
    return true
  }
})
