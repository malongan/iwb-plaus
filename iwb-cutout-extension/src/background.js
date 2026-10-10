/* IWB 鲜艺抠图节点 - 背景服务工作者
 * 职责：接收 content script 发来的图片数据，调用鲜艺抠图本地 HTTP API，返回结果
 * 鲜艺抠图 API: POST http://localhost:30092/rmbg?crop=true|false
 *   请求体: 二进制图片数据
 *   返回体: 二进制图片数据（透明背景 PNG）
 */

import { CONFIG_KEY, mergeConfig, readStoredConfig } from './shared/config.js'
import { base64ToBytes, bufferToDataUrl } from './shared/bytes.js'

/** 获取配置（唯一入口，读到什么就归一化成什么） */
async function getConfig() {
  const result = await chrome.storage.local.get(CONFIG_KEY)
  return readStoredConfig(result[CONFIG_KEY])
}

/** 拼接抠图接口地址 */
function cutoutUrl(config) {
  const apiUrl = String(config.apiUrl || 'http://localhost:30092').replace(/\/$/, '')
  return `${apiUrl}/rmbg?crop=${config.crop ? 'true' : 'false'}`
}

/** POST 图片字节到抠图接口，返回 dataURL */
async function postCutout(body, config) {
  const resp = await fetch(cutoutUrl(config), {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body
  })

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`鲜艺抠图 API 返回错误 ${resp.status}: ${errText}`)
  }

  return bufferToDataUrl(await resp.arrayBuffer(), 'image/png')
}

/** 通过 base64 调用抠图接口 */
async function callCutoutAPI(imageBase64, config) {
  return postCutout(base64ToBytes(imageBase64), config)
}

/**
 * 通过 URL 调用抠图接口（页面侧读不到像素时的兜底）。
 * 注意：service worker 的 fetch 受 host_permissions 限制，只有白名单域
 * （工作台自身 + localhost）能下载成功，其余会 CORS 失败，
 * 因此这里把网络层失败翻译成可操作的提示，而不是抛一句 "Failed to fetch"。
 */
async function callCutoutAPIByUrl(imageUrl, config) {
  let imgResp
  try {
    imgResp = await fetch(imageUrl, { mode: 'cors' })
  } catch {
    throw new Error('图片跨域无法下载（扩展只被授权读取工作台自身与 localhost 的图片），请先下载图片后重新上传')
  }
  if (!imgResp.ok) throw new Error(`无法下载图片: ${imgResp.status}`)

  return postCutout(await imgResp.arrayBuffer(), config)
}

// 消息处理
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'CUTOUT_IMAGE') {
    getConfig()
      .then((config) => {
        if (msg.imageUrl && !msg.imageBase64) {
          return callCutoutAPIByUrl(msg.imageUrl, config)
        }
        return callCutoutAPI(msg.imageBase64, config)
      })
      .then((resultBase64) => {
        sendResponse({ success: true, resultBase64 })
      })
      .catch((err) => {
        sendResponse({ success: false, error: err.message })
      })
    return true // 保持消息通道开放
  }

  if (msg.type === 'GET_CONFIG') {
    getConfig().then((config) => {
      sendResponse({ success: true, config })
    })
    return true
  }

  if (msg.type === 'PING_API') {
    getConfig()
      .then((config) => {
        const apiUrl = String(msg.apiUrl || config.apiUrl).replace(/\/$/, '')
        return fetch(`${apiUrl}/rmbg`, { method: 'HEAD' })
      })
      .then((resp) => {
        // 任何 HTTP 响应都说明服务可达；只有网络异常才判定离线。
        sendResponse({ success: true, status: resp.status })
      })
      .catch((err) => {
        sendResponse({ success: false, error: err.message })
      })
    return true
  }

  if (msg.type === 'SAVE_CONFIG') {
    // 保存前统一归一化，杜绝非法值（bgRatio>1、非法 apiUrl 等）入库
    const config = mergeConfig(msg.config)
    chrome.storage.local.set({ [CONFIG_KEY]: config }).then(() => {
      sendResponse({ success: true, config })
    })
    return true
  }
})
