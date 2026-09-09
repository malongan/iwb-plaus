/* IWB 鲜艺抠图节点 - 内容脚本
 * 在生图工作台画布中，为每个图片节点 (type: 'ref') 注入「抠图」按钮
 * 点击后：读取图片 → 调用鲜艺抠图 → 通过 file input 注入结果（新建节点或替换原图）
 *
 * 工作原理：
 * - 读取图片：从 DOM 中 <img> 的 src 获取 base64 或 URL
 * - 调用 API：通过 background.js 调用 localhost:30092/rmbg
 * - 注入结果：通过 DataTransfer 设置 file input.files 并 dispatch change 事件
 *   这样会走应用自身的 onChange 处理器，正确更新 React 状态
 */

(function () {
  'use strict'

  // ============ 配置 ============
  let config = {
    crop: true,
    autoConnect: true,
    replaceMode: false,
    autoWhiteBg: false,   // 抠图后自动生成白底图
    bgSize: 800,          // 白底画布尺寸（宽高一致）
    bgRatio: 0.85,        // 内容占画布比例（0~1）
    bgMode: 'white'       // 大图背景：white=白底 / transparent=透明底
  }

  function loadConfig() {
    chrome.runtime.sendMessage({ type: 'GET_CONFIG' }, (resp) => {
      if (resp && resp.success && resp.config) {
        config = resp.config
      }
    })
  }
  loadConfig()

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.iwb_cutout_config) {
      config = { ...config, ...(changes.iwb_cutout_config.newValue || {}) }
    }
  })

  // ============ 图标 ============
  const SCISSORS_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><path d="M8.12 8.12 12 12"/><path d="M20 4 8.12 15.88"/><circle cx="6" cy="18" r="3"/><path d="M14.8 14.8 20 20"/></svg>`

  // 白底 800x800 图标：外框=画布，内块=内容占 85%
  const WHITE_BG_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><rect x="7.9" y="7.9" width="8.2" height="8.2" rx="1" fill="currentColor" stroke="none" opacity="0.4"/></svg>`

  // 图片编辑器图标：图层+画笔（表示图层化编辑能力）
  const EDITOR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 2 7l10 5 10-5-10-5Z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/></svg>`

  // ============ 状态 ============
  const processingNodes = new Set()

  // 加载遮罩
  const overlay = document.createElement('div')
  overlay.id = 'iwb-cutout-overlay'
  overlay.className = 'iwb-cutout-overlay'
  overlay.innerHTML = '<div class="iwb-cutout-spinner"></div><span class="iwb-cutout-text">鲜艺抠图处理中...</span>'
  overlay.style.display = 'none'

  // Toast
  let toastEl = null
  let toastTimer = null

  // ============ 核心逻辑 ============

  /** 从 DOM 节点读取图片数据 */
  function getImageFromNode(nodeEl) {
    // 兼容图片元素自身带 class，以及 class 挂在图片容器上的两种结构。
    let img = nodeEl.querySelector('img.iwb-ref-single, .iwb-ref-single img, .iwb-ref-show img')
    // 输出节点的图片
    if (!img) img = nodeEl.querySelector('img.iwb-out-cell-img, .iwb-out-cell-img img, img.iwb-result-thumb, .iwb-result-thumb img')
    if (!img) return null

    const src = img.currentSrc || img.src
    if (!src) return null
    if (src.startsWith('data:')) return { base64: src }
    if (src.startsWith('blob:')) return { blobUrl: src }
    return { url: src }
  }

  /** 将 blob URL 转为 base64 */
  async function blobUrlToBase64(blobUrl) {
    try {
      const resp = await fetch(blobUrl)
      const blob = await resp.blob()
      return new Promise((resolve) => {
        const reader = new FileReader()
        reader.onloadend = () => resolve(reader.result)
        reader.readAsDataURL(blob)
      })
    } catch (e) {
      return null
    }
  }

  /** 加载图片（优先 fetch 转 blob，避免 canvas 跨域污染） */
  async function loadImageSafe(src) {
    function loadVia(url) {
      return new Promise((resolve, reject) => {
        const img = new Image()
        img.onload = () => resolve(img)
        img.onerror = () => reject(new Error('图片加载失败'))
        img.src = url
      })
    }
    // http(s) URL 先尝试 CORS fetch 转 blob
    if (/^https?:/i.test(src)) {
      try {
        const resp = await fetch(src, { mode: 'cors' })
        if (resp.ok) {
          const blob = await resp.blob()
          const url = URL.createObjectURL(blob)
          try {
            return await loadVia(url)
          } finally {
            setTimeout(() => URL.revokeObjectURL(url), 5000)
          }
        }
      } catch (e) { /* 跨域失败则直接加载，可能污染 canvas */ }
    }
    // 未能以 CORS 方式获取的远程图片不能安全导出为 base64，避免后续出现含糊的 canvas tainted 错误。
    if (/^https?:/i.test(src)) {
      throw new Error('远程图片禁止跨域读取')
    }
    return loadVia(src)
  }

  /**
   * 透明图 → 白底图
   * @param {{base64?:string, url?:string, blobUrl?:string}} imageData 图片数据
   * @param {number} size 画布边长（如 800）
   * @param {number} ratio 内容占画布比例（如 0.85 → 内容最长边 = size*ratio）
   * @returns {Promise<string>} dataURL（PNG）
   */
  async function makeWhiteBgImage(imageData, size, ratio, mode) {
    mode = mode === 'transparent' ? 'transparent' : 'white'
    let src = imageData.base64
    if (!src && imageData.blobUrl) src = await blobUrlToBase64(imageData.blobUrl)
    if (!src) src = imageData.url
    if (!src) throw new Error('无法获取图片数据')

    const img = await loadImageSafe(src)
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')

    // 白底模式才填充白色；透明底模式保留透明背景
    if (mode === 'white') {
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, size, size)
    }

    // 内容等比缩放到 size*ratio，居中
    const maxLen = size * ratio
    const scale = Math.min(maxLen / img.width, maxLen / img.height)
    const w = img.width * scale
    const h = img.height * scale
    const x = (size - w) / 2
    const y = (size - h) / 2
    ctx.drawImage(img, x, y, w, h)

    return canvas.toDataURL('image/png')
  }

  /** base64 转 File 对象 */
  function base64ToFile(base64Data, filename) {
    const parts = base64Data.split(',')
    const mime = (parts[0].match(/:(.*?);/) || [])[1] || 'image/png'
    const base64 = parts[1] || parts[0]
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return new File([bytes], filename || 'cutout.png', { type: mime })
  }

  /** 执行抠图 */
  async function performCutout(nodeEl) {
    const nodeId = nodeEl.getAttribute('data-node-id')
    if (!nodeId) { showToast('无法获取节点 ID', 'error'); return }
    if (processingNodes.has(nodeId)) { showToast('该节点正在处理中', 'info'); return }

    processingNodes.add(nodeId)
    setButtonProcessing(nodeEl, true)
    showOverlay()

    try {
      // 1. 读取图片
      const imgData = getImageFromNode(nodeEl)
      if (!imgData) { showToast('未找到图片，请确保节点中有图片', 'error'); return }

      let imageBase64 = imgData.base64

      // 统一在页面上下文读取图片，避免 background fetch 图片 URL 时丢失页面鉴权/CORS 信息。
      if (!imageBase64 && imgData.blobUrl) {
        imageBase64 = await blobUrlToBase64(imgData.blobUrl)
      }
      if (!imageBase64 && imgData.url) {
        try {
          const img = await loadImageSafe(imgData.url)
          const canvas = document.createElement('canvas')
          canvas.width = img.naturalWidth || img.width
          canvas.height = img.naturalHeight || img.height
          if (!canvas.width || !canvas.height) throw new Error('图片尺寸无效')
          canvas.getContext('2d').drawImage(img, 0, 0)
          imageBase64 = canvas.toDataURL('image/png')
        } catch (e) {
          // 页面侧可能被 CORS/鉴权拦截，交给扩展后台按 URL 下载。
          if (!/^https?:/i.test(imgData.url)) throw new Error('无法读取图片数据')
        }
      }
      if (!imageBase64 && !imgData.url) throw new Error('无法读取图片数据')

      // 2. 调用鲜艺抠图 API；页面转 base64 失败时由 background 按 URL 下载。
      const resp = await chrome.runtime.sendMessage({
        type: 'CUTOUT_IMAGE',
        imageBase64: imageBase64 || null,
        imageUrl: imageBase64 ? null : imgData.url
      })

      if (!resp || !resp.success) {
        throw new Error(resp?.error || '抠图 API 调用失败')
      }

      let cutoutBase64 = resp.resultBase64
      const sourceName = getNodeImageName(nodeEl) || 'image'
      let cutoutName = sourceName.replace(/\.[^.]+$/, '') + '_cutout.png'

      // 可选：抠图后自动转白底图
      if (config.autoWhiteBg) {
        showToast('抠图完成，正在生成白底图...', 'info')
        const whiteBase64 = await makeWhiteBgImage({ base64: cutoutBase64 }, config.bgSize, config.bgRatio)
        cutoutBase64 = whiteBase64
        cutoutName = sourceName.replace(/\.[^.]+$/, '') + '_800x800.png'
      }

      // 3. 注入结果到画布
      if (config.replaceMode) {
        await injectReplaceImage(nodeEl, cutoutBase64, cutoutName)
      } else {
        await injectNewNode(cutoutBase64, cutoutName)
      }

      showToast(config.replaceMode ? '抠图完成，已替换原图' : '抠图完成，新节点已创建', 'success')
    } catch (err) {
      console.error('[IWB抠图] 失败:', err)
      showToast(`抠图失败: ${err.message}`, 'error')
    } finally {
      hideOverlay()
      processingNodes.delete(nodeId)
      setButtonProcessing(nodeEl, false)
    }
  }

  /** 白底 800x800：把节点图片（通常是透明图）转成白底大图 */
  async function performWhiteBg(nodeEl) {
    const nodeId = nodeEl.getAttribute('data-node-id')
    if (!nodeId) { showToast('无法获取节点 ID', 'error'); return }
    if (processingNodes.has(nodeId)) { showToast('该节点正在处理中', 'info'); return }

    processingNodes.add(nodeId)
    setButtonProcessing(nodeEl, true)
    showOverlay('白底图处理中...')

    try {
      // 1. 读取图片
      const imgData = getImageFromNode(nodeEl)
      if (!imgData) { showToast('未找到图片，请确保节点中有图片', 'error'); return }

      // 2. canvas 生成大图（白底 / 透明底）
      const currentConfig = await new Promise(resolve => chrome.runtime.sendMessage({ type: 'GET_CONFIG' }, r => resolve((r && r.success && r.config) || config)))
      const size = currentConfig.bgSize || config.bgSize || 800
      const ratio = currentConfig.bgRatio != null ? currentConfig.bgRatio : (config.bgRatio || 0.85)
      const mode = currentConfig.bgMode || config.bgMode || 'white'
      const outBase64 = await makeWhiteBgImage(imgData, size, ratio, mode)
      const sourceName = getNodeImageName(nodeEl) || 'image'
      const outName = sourceName.replace(/\.[^.]+$/, '') + `_${size}x${size}.png`
      const label = mode === 'transparent' ? '透明底' : '白底'

      // 3. 注入结果
      if (currentConfig.replaceMode != null ? currentConfig.replaceMode : config.replaceMode) {
        await injectReplaceImage(nodeEl, outBase64, outName)
      } else {
        await injectNewNode(outBase64, outName)
      }

      showToast((currentConfig.replaceMode != null ? currentConfig.replaceMode : config.replaceMode) ? `${label}图已替换原图` : `${label}图节点已创建`, 'success')
    } catch (err) {
      console.error('[IWB抠图] 大图处理失败:', err)
      showToast(`处理失败: ${err.message}`, 'error')
    } finally {
      hideOverlay()
      processingNodes.delete(nodeId)
      setButtonProcessing(nodeEl, false)
    }
  }

  /** 打开图片编辑器（裁剪+标注） */
  async function performEditor(nodeEl) {
    if (processingNodes.has(nodeEl.getAttribute('data-node-id') || '')) {
      showToast('该节点正在处理中', 'info'); return
    }

    try {
      // 读取图片 → 转 base64
      const imgData = getImageFromNode(nodeEl)
      if (!imgData) { showToast('未找到图片', 'error'); return }

      let imageBase64 = imgData.base64
      if (!imageBase64 && imgData.blobUrl) {
        imageBase64 = await blobUrlToBase64(imgData.blobUrl)
      }
      if (!imageBase64 && imgData.url) {
        // 跨域 URL：尝试加载转 base64
        try {
          const img = await loadImageSafe(imgData.url)
          const c = document.createElement('canvas')
          c.width = img.naturalWidth || img.width
          c.height = img.naturalHeight || img.height
          c.getContext('2d').drawImage(img, 0, 0)
          imageBase64 = c.toDataURL('image/png')
        } catch (err) {
          showToast('无法读取图片（跨域限制），请先下载到本地', 'error'); return
        }
      }
      if (!imageBase64) { showToast('无法读取图片数据', 'error'); return }

      const sourceName = getNodeImageName(nodeEl) || 'image'

      if (!window.__iwbEditor) {
        showToast('编辑器未加载，请刷新页面', 'error'); return
      }

      window.__iwbEditor.open({
        imageBase64,
        imageName: sourceName,
        onResult: async (dataUrl, mode) => {
          const outName = sourceName.replace(/\.[^.]+$/, '') + '_edited.png'
          try {
            if (mode === 'replace') {
              await injectReplaceImage(nodeEl, dataUrl, outName)
              showToast('编辑结果已覆盖原图', 'success')
            } else {
              await injectNewNode(dataUrl, outName)
              showToast('编辑结果已创建为新节点', 'success')
            }
          } catch (err) {
            console.error('[IWB编辑器] 注入失败:', err)
            showToast(`注入失败: ${err.message}`, 'error')
          }
        },
        onError: (msg) => showToast(msg, 'error')
      })
    } catch (err) {
      console.error('[IWB编辑器] 打开失败:', err)
      showToast(`编辑器打开失败: ${err.message}`, 'error')
    }
  }

  /** 获取节点中的图片文件名 */
  function getNodeImageName(nodeEl) {
    // 从 localStorage 读取节点数据获取文件名
    try {
      const wsData = JSON.parse(localStorage.getItem('iwb_web_workspaces') || '{}')
      const ws = (wsData.workspaces || []).find(w => w.id === (wsData.activeId || wsData.workspaces?.[0]?.id))
      const nodeId = nodeEl.getAttribute('data-node-id')
      const node = (ws?.nodes || []).find(n => n.id === nodeId)
      return node?.data?.name || 'image'
    } catch (e) {
      return 'image'
    }
  }

  /** 替换模式：通过节点头部的 file input 注入抠图结果 */
  async function injectReplaceImage(nodeEl, cutoutBase64, filename) {
    // 方案 A: 使用节点头部的「替换图片」file input
    const headFileInput = nodeEl.querySelector('.iwb-node-headbtns input[type="file"]')
    if (headFileInput) {
      const file = base64ToFile(cutoutBase64, filename)
      const dt = new DataTransfer()
      dt.items.add(file)
      headFileInput.files = dt.files
      headFileInput.dispatchEvent(new Event('change', { bubbles: true }))
      return
    }

    // 方案 B: 使用节点 body 的 file input（空节点的上传标签）
    const bodyFileInput = nodeEl.querySelector('.iwb-ref-upload input[type="file"]')
    if (bodyFileInput) {
      const file = base64ToFile(cutoutBase64, filename)
      const dt = new DataTransfer()
      dt.items.add(file)
      bodyFileInput.files = dt.files
      bodyFileInput.dispatchEvent(new Event('change', { bubbles: true }))
      return
    }

    // 方案 C: 模拟粘贴（选中该节点后触发 paste 事件）
    await injectViaPasteEvent(cutoutBase64, filename, true)
  }

  /** 新建节点模式：点击工具栏添加 ref 节点，再注入图片 */
  async function injectNewNode(cutoutBase64, filename) {
    // 方案 A: 点击工具栏「添加参考图」按钮，然后用 file input 注入
    const addRefBtn = document.querySelector('[data-tip*="参考图节点"]') ||
                      document.querySelector('[data-tip*="参考图"]')
    if (addRefBtn) {
      addRefBtn.click()
      // 等待 React 渲染新节点
      const newNode = await waitForNewRefNode()
      if (newNode) {
        const fileInput = newNode.querySelector('input[type="file"]')
        if (fileInput) {
          const file = base64ToFile(cutoutBase64, filename)
          const dt = new DataTransfer()
          dt.items.add(file)
          fileInput.files = dt.files
          fileInput.dispatchEvent(new Event('change', { bubbles: true }))
          return
        }
      }
    }

    // 方案 B: 取消选中所有节点，模拟 paste 事件创建新节点
    await injectViaPasteEvent(cutoutBase64, filename, false)
  }

  /** 等待新创建的空 ref 节点出现在 DOM 中 */
  function waitForNewRefNode(timeout = 2000) {
    return new Promise((resolve) => {
      const startTime = Date.now()
      // 记录当前已有的节点数
      const existingNodes = document.querySelectorAll('.iwb-node[data-node-id]')

      function check() {
        const currentNodes = document.querySelectorAll('.iwb-node[data-node-id]')
        // 找到新出现的空 ref 节点（有上传标签但没有图片）
        for (const node of currentNodes) {
          if (!node.querySelector('.iwb-ref-single, .iwb-ref-show img')) {
            // 没有图片的节点 = 空 ref 节点
            if (!Array.from(existingNodes).includes(node)) {
              resolve(node)
              return
            }
          }
        }
        if (Date.now() - startTime > timeout) {
          resolve(null)
        } else {
          requestAnimationFrame(check)
        }
      }
      check()
    })
  }

  /** 通过模拟 paste 事件注入图片 */
  async function injectViaPasteEvent(cutoutBase64, filename, replaceMode) {
    // 尝试构造 synthetic paste event
    const file = base64ToFile(cutoutBase64, filename)
    const dt = new DataTransfer()
    dt.items.add(file)

    try {
      // 尝试用 ClipboardEvent 构造器
      const event = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt
      })
      window.dispatchEvent(event)
      // 等待一下看是否生效
      await new Promise(r => setTimeout(r, 500))
      showToast('已通过粘贴方式注入，如未显示请检查', 'info')
    } catch (e) {
      // ClipboardEvent 构造器不支持 clipboardData 的情况
      // 降级：提示用户手动粘贴
      try {
        // 尝试写入剪贴板
        await navigator.clipboard.write([
          new ClipboardItem({ [file.type]: file })
        ])
        showToast('抠图结果已复制到剪贴板，请按 Ctrl+V 粘贴到画布', 'info')
      } catch (clipErr) {
        showToast('无法自动注入，请手动粘贴', 'error')
      }
    }
  }

  // ============ 自定义 Tooltip ============
  // 不用 data-tip（会被应用自身 tooltip 的层级挡住），自建一个挂 body 的高层级提示

  let tipEl = null
  let tipTimer = null

  function ensureTip() {
    if (tipEl) return tipEl
    tipEl = document.createElement('div')
    tipEl.id = 'iwb-cutout-tip'
    document.body.appendChild(tipEl)
    return tipEl
  }

  function moveTip(e) {
    if (!tipEl || tipEl.style.display === 'none') return
    const pad = 14
    let x = e.clientX + pad
    let y = e.clientY + pad
    const r = tipEl.getBoundingClientRect()
    if (x + r.width > window.innerWidth - 6) x = e.clientX - r.width - pad
    if (y + r.height > window.innerHeight - 6) y = e.clientY - r.height - pad
    tipEl.style.left = x + 'px'
    tipEl.style.top = y + 'px'
  }

  function showTip(text, e) {
    const tip = ensureTip()
    tip.textContent = text
    tip.style.display = 'block'
    moveTip(e)
  }

  function hideTip() {
    if (tipEl) tipEl.style.display = 'none'
  }

  /** 给按钮绑定自定义提示：悬停 200ms 后显示，跟随鼠标，移出即隐藏 */
  function bindTip(btn, text) {
    btn.addEventListener('mouseenter', (e) => {
      clearTimeout(tipTimer)
      tipTimer = setTimeout(() => showTip(text, e), 200)
    })
    btn.addEventListener('mousemove', moveTip)
    btn.addEventListener('mouseleave', () => {
      clearTimeout(tipTimer)
      hideTip()
    })
    btn.addEventListener('click', () => {
      clearTimeout(tipTimer)
      hideTip()
    })
  }

  // ============ UI 辅助 ============

  function setButtonProcessing(nodeEl, processing) {
    const id = nodeEl.getAttribute('data-node-id')
    const mark = (btn) => {
      btn.classList.toggle('processing', processing)
      btn.style.pointerEvents = processing ? 'none' : ''
    }
    nodeEl.querySelectorAll('.iwb-cutout-btn, .iwb-whitebg-btn, .iwb-compress-btn, .iwb-editor-btn-icon').forEach(mark)
    // 新版：按钮位于浮动气泡栏，随选中节点渲染在节点外部
    document.querySelectorAll('.iwb-node-floatbar').forEach((bar) => {
      const n = findFloatbarNode(bar)
      if (n && n.getAttribute('data-node-id') === id) {
        bar.querySelectorAll('.iwb-cutout-btn, .iwb-whitebg-btn, .iwb-compress-btn, .iwb-editor-btn-icon').forEach(mark)
      }
    })
  }

  function showOverlay(text) {
    if (text) overlay.querySelector('.iwb-cutout-text').textContent = text
    overlay.style.display = 'flex'
  }
  function hideOverlay() { overlay.style.display = 'none' }

  function showToast(msg, type = 'info') {
    if (!toastEl) {
      toastEl = document.createElement('div')
      toastEl.id = 'iwb-cutout-toast'
      document.body.appendChild(toastEl)
    }
    toastEl.textContent = msg
    toastEl.className = `iwb-cutout-toast iwb-cutout-toast-${type}`
    toastEl.style.display = 'block'
    toastEl.style.opacity = '1'
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => {
      toastEl.style.opacity = '0'
      setTimeout(() => { if (toastEl) toastEl.style.display = 'none' }, 300)
    }, 3500)
  }

  async function performCompress(nodeEl) {
    const nodeId = nodeEl.getAttribute('data-node-id')
    if (!nodeId || processingNodes.has(nodeId)) return
    processingNodes.add(nodeId); setButtonProcessing(nodeEl, true)
    try {
      const currentConfig = await new Promise(resolve => chrome.runtime.sendMessage({ type: 'GET_CONFIG' }, r => resolve((r && r.success && r.config) || config)))
      const data = getImageFromNode(nodeEl)
      const src = data.base64 || (data.blobUrl ? await blobUrlToBase64(data.blobUrl) : data.url)
      if (!src) throw new Error('无法读取图片数据')
      const img = await loadImageSafe(src)
      const width = Math.min(currentConfig.compressWidth || 1024, 16384)
      const height = Math.max(1, Math.round(img.height * width / img.width))
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
      canvas.getContext('2d').drawImage(img, 0, 0, width, height)
      const out = canvas.toDataURL('image/jpeg', Math.min(1, Math.max(.1, (currentConfig.compressQuality || 80) / 100)))
      await injectReplaceImage(nodeEl, out, (getNodeImageName(nodeEl) || 'image') + '-compressed.jpg')
      showToast('图片压缩完成', 'success')
    } catch (e) { console.error('[IWB压缩]', e); showToast('压缩失败：' + e.message, 'error') }
    finally { processingNodes.delete(nodeId); setButtonProcessing(nodeEl, false) }
  }

  // ============ 按钮注入 ============

  /** 判断节点是否带图片（ref 有图 / out 输出图） */
  function nodeHasImage(nodeEl) {
    // 只处理真实图片节点：参考图(ref)与输出(out)；不含 prompt/llm 等缩略图
    return !!(nodeEl.querySelector('.iwb-ref-single, .iwb-ref-body .iwb-ref-show img') || nodeEl.querySelector('.iwb-out-cell-img, .iwb-result-thumb'))
  }

  /** 在 host 内创建全部工具按钮（抠图/白底/压缩/编辑）。重复调用安全（已有则跳过）。 */
  function addToolButtons(host, nodeEl, beforeEl) {
    if (!host || host.querySelector('.iwb-cutout-btn')) return
    const nodeId = nodeEl.getAttribute('data-node-id')
    // React 重建节点时旧 DOM 引用失效：点击时优先取画布上仍然存活的最新节点，
    // 避免读取到已被替换掉的旧图（修复“编辑器打开的是上一次的图”）
    const liveNode = () => (nodeEl && nodeEl.isConnected)
      ? nodeEl
      : (document.querySelector('.iwb-node[data-node-id="' + nodeId + '"]') || nodeEl)
    const make = (cls, content, color, tip, run) => {
      const b = document.createElement('button')
      b.className = 'iwb-node-del ' + cls
      if (typeof content === 'string' && content.indexOf('<svg') === 0) b.innerHTML = content
      else b.textContent = content
      b.style.color = color
      bindTip(b, tip)
      b.addEventListener('pointerdown', (e) => e.stopPropagation())
      b.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); run(liveNode()) })
      return b
    }
    const compress = make('iwb-compress-btn', '压', '#16a34a',
      '图片压缩（宽度 ' + (config.compressWidth || 1024) + 'px，质量 ' + (config.compressQuality || 80) + '%）', performCompress)
    const cutout = make('iwb-cutout-btn', SCISSORS_SVG, '#e8a735', '鲜艺AI抠图（去背景）', performCutout)
    const bgLabel = (config.bgMode === 'transparent') ? '透明底' : '白底'
    const white = make('iwb-whitebg-btn', WHITE_BG_SVG, '#3b82f6',
      bgLabel + ' ' + (config.bgSize || 800) + '×' + (config.bgSize || 800) + '（内容占 ' + Math.round((config.bgRatio || 0.85) * 100) + '%）', performWhiteBg)
    const edit = make('iwb-editor-btn-icon', EDITOR_SVG, '#a855f7', '图片编辑（图层、画笔、裁剪、标注）', performEditor)
    const anchor = beforeEl || host.lastElementChild
    ;[compress, cutout, white, edit].forEach((b) => { host.insertBefore(b, anchor ? anchor.nextSibling : null) })
  }

  /** 旧版：注入到节点标题栏 .iwb-node-headbtns（仅当标题栏可见时使用） */
  function injectCutoutButtons() {
    const nodes = document.querySelectorAll('.iwb-node[data-node-id]')
    nodes.forEach(nodeEl => {
      const head = nodeEl.querySelector('.iwb-node-head')
      if (!head) return
      const headStyle = window.getComputedStyle ? window.getComputedStyle(head) : null
      if (headStyle && headStyle.display === 'none') return
      if (!nodeHasImage(nodeEl)) return
      const headBtns = nodeEl.querySelector('.iwb-node-headbtns')
      if (!headBtns) return
      const copyBtn = headBtns.querySelector('[title*="复制节点"]')
      addToolButtons(headBtns, nodeEl, copyBtn || null)
    })
  }

  /** 新版：把工具按钮注入到选中节点的浮动气泡栏 .iwb-node-floatbar */
  function findFloatbarNode(bar) {
    const br = bar.getBoundingClientRect()
    if (!br.width || !br.height) return null
    const bx = br.left + br.width / 2
    let best = null, bestScore = Infinity
    document.querySelectorAll('.iwb-node[data-node-id]').forEach((n) => {
      const r = n.getBoundingClientRect()
      if (!r.width || !r.height) return
      const cx = r.left + r.width / 2
      const dx = Math.abs(cx - bx)
      const dy = br.bottom - r.top
      if (dx < 40 && dy > -30 && dy < 90) {
        const score = dx * 2 + Math.abs(dy)
        if (score < bestScore) { bestScore = score; best = n }
      }
    })
    return best
  }

  function injectFloatbarButtons() {
    document.querySelectorAll('.iwb-node-floatbar').forEach((bar) => {
      if (bar.querySelector('.iwb-cutout-btn')) return
      const nodeEl = findFloatbarNode(bar)
      if (!nodeEl || !nodeHasImage(nodeEl)) return
      const danger = bar.querySelector('.iwb-node-floatbar-danger, [title="删除节点"]')
      addToolButtons(bar, nodeEl, danger || null)
    })
  }

  // ============ 初始化 ============

  // React 更新节点时可能在同一帧内产生大量 mutation；合并扫描，避免重复遍历整棵树。
  let injectFrame = 0
  function scheduleButtonInjection() {
    if (injectFrame) return
    injectFrame = requestAnimationFrame(() => {
      injectFrame = 0
      injectCutoutButtons()
      injectFloatbarButtons()
    })
  }

  const observer = new MutationObserver(scheduleButtonInjection)

  function init() {
    document.body.appendChild(overlay)
    const root = document.getElementById('root')
    if (root) {
      observer.observe(root, { childList: true, subtree: true })
    } else {
      setTimeout(init, 500)
      return
    }
    setTimeout(injectCutoutButtons, 1500)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }

  // 调试接口
  window.__iwbCutout = {
    config: () => config,
    cutout: (nodeId) => {
      const el = document.querySelector(`[data-node-id="${nodeId}"]`)
      if (el) performCutout(el)
    },
    whiteBg: (nodeId) => {
      const el = document.querySelector(`[data-node-id="${nodeId}"]`)
      if (el) performWhiteBg(el)
    },
    edit: (nodeId) => {
      const el = document.querySelector(`[data-node-id="${nodeId}"]`)
      if (el) performEditor(el)
    },
    inject: injectCutoutButtons
  }
})()
