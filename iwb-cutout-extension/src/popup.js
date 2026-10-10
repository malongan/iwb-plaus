/* IWB 鲜艺抠图设置弹窗
 *
 * 默认值与数值校验全部来自 shared/config.js（唯一真源）。
 * 保存时先经 mergeConfig 归一化，因此非法输入（如内容占比 500%）不会入库。
 */

import { DEFAULT_CONFIG as DEFAULTS, mergeConfig } from './shared/config.js'
import { readLastError, clearLastError } from './shared/error-report.js'

document.addEventListener('DOMContentLoaded', () => {
  const apiUrlEl = document.getElementById('apiUrl')
  const cropEl = document.getElementById('crop')
  const autoConnectEl = document.getElementById('autoConnect')
  const autoWhiteBgEl = document.getElementById('autoWhiteBg')
  const bgSizeEl = document.getElementById('bgSize')
  const bgRatioEl = document.getElementById('bgRatio')
  const bgModeEl = document.getElementById('bgMode')
  const compressWidthEl = document.getElementById('compressWidth')
  const compressQualityEl = document.getElementById('compressQuality')
  const modeNewNodeEl = document.getElementById('modeNewNode')
  const modeReplaceEl = document.getElementById('modeReplace')
  const statusDot = document.getElementById('statusDot')
  const statusText = document.getElementById('statusText')
  const saveBtn = document.getElementById('saveBtn')
  const testBtn = document.getElementById('testBtn')
  const probeBtn = document.getElementById('probeBtn')
  const probeResult = document.getElementById('probeResult')
  const verText = document.getElementById('verText')

  verText.textContent = 'v' + chrome.runtime.getManifest().version

  // ===== 最近一次错误（由 content 的错误边界写入 chrome.storage） =====
  const errSection = document.getElementById('errSection')
  const lastErrorEl = document.getElementById('lastError')
  const clearErrBtn = document.getElementById('clearErrBtn')

  async function renderLastError() {
    const entry = await readLastError()
    if (!entry) {
      errSection.hidden = true
      return
    }
    const when = new Date(entry.at).toLocaleString()
    errSection.hidden = false
    lastErrorEl.textContent = `${when}\n[${entry.source}] ${entry.message}`
  }
  renderLastError()
  clearErrBtn.addEventListener('click', async () => {
    await clearLastError()
    renderLastError()
  })

  /** 把归一化后的配置回填到表单（让用户看到被 clamp 的结果） */
  function fillForm(config) {
    apiUrlEl.value = config.apiUrl
    cropEl.checked = config.crop
    autoConnectEl.checked = config.autoConnect
    autoWhiteBgEl.checked = config.autoWhiteBg
    bgSizeEl.value = config.bgSize
    bgRatioEl.value = Math.round(config.bgRatio * 100)
    bgModeEl.value = config.bgMode
    compressWidthEl.value = config.compressWidth
    compressQualityEl.value = config.compressQuality
    if (config.replaceMode) modeReplaceEl.checked = true
    else modeNewNodeEl.checked = true
  }

  // 加载当前配置
  chrome.runtime.sendMessage({ type: 'GET_CONFIG' }, (resp) => {
    const config = (resp && resp.success && resp.config) || mergeConfig(DEFAULTS)
    fillForm(config)
    checkApiStatus(config.apiUrl)
  })

  // 测试连接
  function checkApiStatus(url) {
    statusDot.className = 'status-dot status-checking'
    statusText.textContent = '检测中...'

    chrome.runtime.sendMessage({ type: 'PING_API', apiUrl: url }, (resp) => {
      if (resp && resp.success) {
        statusDot.className = 'status-dot status-online'
        statusText.textContent = '鲜艺抠图服务已连接'
      } else {
        statusDot.className = 'status-dot status-offline'
        statusText.textContent = '未检测到鲜艺抠图，请确保软件已启动'
      }
    })
  }

  /** 读取表单 → 归一化 → 保存 → 回填，用户能直观看到被纠正的值 */
  function save() {
    const candidate = {
      apiUrl: apiUrlEl.value.trim(),
      crop: cropEl.checked,
      autoConnect: autoConnectEl.checked,
      replaceMode: modeReplaceEl.checked,
      autoWhiteBg: autoWhiteBgEl.checked,
      bgSize: parseFloat(bgSizeEl.value),
      bgRatio: parseFloat(bgRatioEl.value) / 100, // 表单是百分比，存储是 0~1
      bgMode: bgModeEl.value,
      compressWidth: parseFloat(compressWidthEl.value),
      compressQuality: parseFloat(compressQualityEl.value)
    }
    const config = mergeConfig(candidate)

    chrome.runtime.sendMessage({ type: 'SAVE_CONFIG', config }, (resp) => {
      if (resp && resp.success) {
        fillForm(resp.config || config)
        saveBtn.textContent = '已保存'
        setTimeout(() => { saveBtn.textContent = '保存' }, 1500)
        checkApiStatus(config.apiUrl)
      }
    })
  }

  saveBtn.addEventListener('click', save)
  testBtn.addEventListener('click', () => {
    checkApiStatus(apiUrlEl.value.trim() || DEFAULTS.apiUrl)
  })

  // ===== 页面自检：把宿主 DOM 契约的命中情况直接列出来 =====
  const LEVEL_MARK = { ok: '✓', info: '·', warn: '!', error: '✕' }
  function renderProbe(results, error) {
    probeResult.hidden = false
    if (error) {
      probeResult.innerHTML = `<div class="probe-item error"><span class="mk">✕</span><span>${escapeHtml(error)}</span></div>`
      return
    }
    probeResult.innerHTML = results
      .map((r) => `<div class="probe-item ${r.ok ? r.level : 'error'}"><span class="mk">${LEVEL_MARK[r.level] || '·'}</span><span>${escapeHtml(r.name)}：<span class="dt">${escapeHtml(r.detail)}</span></span></div>`)
      .join('')
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  }

  probeBtn.addEventListener('click', () => {
    probeResult.hidden = false
    probeResult.innerHTML = '<div class="probe-item info"><span class="mk">·</span><span>检查中...</span></div>'
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0]
      if (!tab || tab.id == null) {
        renderProbe(null, '找不到当前标签页')
        return
      }
      chrome.tabs.sendMessage(tab.id, { type: 'RUN_PROBE' }, (resp) => {
        if (chrome.runtime.lastError) {
          renderProbe(null, `无法自检：${chrome.runtime.lastError.message}（请在工作台页面上打开本弹窗）`)
          return
        }
        if (!resp || !resp.success) {
          renderProbe(null, (resp && resp.error) || '页面未响应自检')
          return
        }
        renderProbe(resp.results)
      })
    })
  })
})
