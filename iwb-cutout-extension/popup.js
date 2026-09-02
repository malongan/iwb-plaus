/* IWB 鲜艺抠图设置弹窗 */

const DEFAULTS = {
  apiUrl: 'http://localhost:30092',
  crop: true,
  autoConnect: true,
  replaceMode: false,
  autoWhiteBg: false,
  bgSize: 800,
  bgRatio: 0.85,
  compressWidth: 1024,
  compressQuality: 80
}

document.addEventListener('DOMContentLoaded', () => {
  const apiUrlEl = document.getElementById('apiUrl')
  const cropEl = document.getElementById('crop')
  const autoConnectEl = document.getElementById('autoConnect')
  const autoWhiteBgEl = document.getElementById('autoWhiteBg')
  const bgSizeEl = document.getElementById('bgSize')
  const bgRatioEl = document.getElementById('bgRatio')
  const compressWidthEl = document.getElementById('compressWidth')
  const compressQualityEl = document.getElementById('compressQuality')
  const modeNewNodeEl = document.getElementById('modeNewNode')
  const modeReplaceEl = document.getElementById('modeReplace')
  const statusDot = document.getElementById('statusDot')
  const statusText = document.getElementById('statusText')
  const saveBtn = document.getElementById('saveBtn')
  const testBtn = document.getElementById('testBtn')

  // 加载当前配置
  chrome.runtime.sendMessage({ type: 'GET_CONFIG' }, (resp) => {
    const config = (resp && resp.success && resp.config) || DEFAULTS
    apiUrlEl.value = config.apiUrl || DEFAULTS.apiUrl
    cropEl.checked = config.crop !== false
    autoConnectEl.checked = config.autoConnect !== false
    autoWhiteBgEl.checked = config.autoWhiteBg === true
    bgSizeEl.value = config.bgSize || DEFAULTS.bgSize
    bgRatioEl.value = Math.round((config.bgRatio || DEFAULTS.bgRatio) * 100)
    compressWidthEl.value = config.compressWidth || DEFAULTS.compressWidth
    compressQualityEl.value = config.compressQuality || DEFAULTS.compressQuality
    if (config.replaceMode) {
      modeReplaceEl.checked = true
    } else {
      modeNewNodeEl.checked = true
    }
    checkApiStatus(config.apiUrl || DEFAULTS.apiUrl)
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

  // 保存配置
  saveBtn.addEventListener('click', () => {
    let bgSize = parseInt(bgSizeEl.value, 10)
    let bgRatio = parseFloat(bgRatioEl.value) / 100
    let compressWidth = parseInt(compressWidthEl.value, 10)
    let compressQuality = parseInt(compressQualityEl.value, 10)
    if (!bgSize || bgSize < 64) bgSize = DEFAULTS.bgSize
    if (!bgRatio || bgRatio < 0.1) bgRatio = DEFAULTS.bgRatio
    if (!compressWidth || compressWidth < 64) compressWidth = DEFAULTS.compressWidth
    if (!compressQuality || compressQuality < 10) compressQuality = DEFAULTS.compressQuality
    compressQuality = Math.min(100, compressQuality)

    const config = {
      apiUrl: apiUrlEl.value.trim() || DEFAULTS.apiUrl,
      crop: cropEl.checked,
      autoConnect: autoConnectEl.checked,
      replaceMode: modeReplaceEl.checked,
      autoWhiteBg: autoWhiteBgEl.checked,
      bgSize,
      bgRatio,
      compressWidth,
      compressQuality
    }
    chrome.runtime.sendMessage({ type: 'SAVE_CONFIG', config }, (resp) => {
      if (resp && resp.success) {
        saveBtn.textContent = '已保存'
        setTimeout(() => { saveBtn.textContent = '保存' }, 1500)
        checkApiStatus(config.apiUrl)
      }
    })
  })

  // 测试连接按钮
  testBtn.addEventListener('click', () => {
    const url = apiUrlEl.value.trim() || DEFAULTS.apiUrl
    checkApiStatus(url)
  })
})
