/* IWB 图片编辑器 - 图层化裁剪与标注
 * 独立模块，通过 window.__iwbEditor.open() 调用
 * 接收 imageBase64，返回编辑后的 dataURL
 *
 * v2.0.0 特性：
 * - 图层系统：位图图层动态管理（原图、画笔、导入图片），可调透明度、显隐、排序
 * - 矢量对象（文字/形状）在图层面板中统一展示，z 序可调
 * - 统一橡皮：一个橡皮擦除当前活跃位图图层，与画笔共用大小/透明度/软硬
 * - 添加位图图层：支持导入新图片作为独立图层
 * - 工具：选择 / 画笔 / 矩形 / 箭头 / 文字 / 橡皮 / 吸管 / 抓手 / 裁剪
 *
 * 分层架构：
 * - bitmap layers: 每个位图图层一个 canvas（动态创建/排序），CSS opacity 控制透明度
 * - textCanvas: 矢量对象层（文字+形状），共享一个 canvas
 * - strokeCanvas: 笔划预览层（一笔结束后合成进活跃图层）
 * - overlayCanvas: 选中框/裁剪遮罩/笔刷预览
 */

/* index.js - 模块组装与对外接口
 * 汇总各子模块，承载「打开编辑器 / 关闭 / 复原 / 输出」生命周期，
 * 并把 window.__iwbEditor = { open, close, __stats } 挂到全局（对外唯一接口）。
 * 注意：entries/content.js 必须先 import 本文件再 import content.js。
 * 顶层只允许声明与这次 window 赋值，不调用其它模块的函数（避免循环 TDZ）。
 */

'use strict'

import { S, runtime } from './state.js'
import { HISTORY_MAX_BYTES, HISTORY_MAX_ENTRIES, historyBudgetBytes, snapshotStats } from './history.js'
import { cancelImagePlacement } from './placement.js'
import { clearSelection, purgeVectorCanvases } from './layers.js'
import { createEl, loadImage } from './dom.js'
import { getCompositeCanvas } from './tools.js'
import { hideTextInput } from './objects.js'
import { setupCanvas } from './viewport.js'
import { updateAllUI } from './events.js'

  // ============ 打开编辑器 ============
  export async function open(options) {
    if (!options || !options.imageBase64) return
    createEl()
    S.callbacks = options

    try {
      const img = await loadImage(options.imageBase64)
      S.imgW = img.naturalWidth || img.width
      S.imgH = img.naturalHeight || img.height
      S.originalImage = img
      runtime.el.style.display = 'flex'
      S.open = true
      S.zoom = 1
      setupCanvas(img)
      resetState()
      updateAllUI()
    } catch (e) {
      console.error('[IWB编辑器] 打开失败:', e)
      if (runtime.el) runtime.el.style.display = 'none'
      if (options.onError) options.onError(e.message)
    } finally {
      // 源图字符串只在解码这一刻有用（loadImage 内已转 blob URL）。
      // 不丢的话 S.callbacks 会在整个编辑会话持有整份 dataURL（4K ≈44MB），
      // 打开失败路径更是会一直挂到下次打开才被覆盖。
      options.imageBase64 = null
    }
  }

  function resetState() {
    purgeVectorCanvases()
    S.history = []
    S.redoStack = []
    S.cropRect = null
    S.cropHandle = null
    S.cropMoving = false
    S.moveStart = null
    S.isDrawing = false
    S.panning = false
    S.tool = 'brush'
    S.color = '#ff4444'
    S.brushSize = 3
    S.brushHardness = 100
    S.brushOpacity = 1
    S.prevTool = null
    S.pickerComposite = null
    S.rectFill = false
    S.cropConstraint = { type: 'free', ratio: 0, sizeW: 0, sizeH: 0 }
    S.textLayers = []
    S.selectedTextId = null
    S.textDrag = null
    S.textEditingId = null
    S.shapeLayers = []
    S.selectedShapeId = null
    S.shapeDrag = null
    S.penPath = null
    S.penEditId = null
    S.penDragPt = -1
    S.penDragBase = null
    S.penDragPending = null
    S.zCounter = Math.max(S.layers.length - 1, 0)
    S.placingImage = null
    S.placingHandle = null
    S.placingStart = null
     const sizeToggle = runtime.el && runtime.el.querySelector('.iwb-editor-size-toggle')
     if (sizeToggle) { sizeToggle.classList.remove('active'); sizeToggle.setAttribute('aria-pressed', 'false'); sizeToggle.textContent = '启用尺寸' }
  }

  export function close() {
    if (runtime.el) {
      hideTextInput()
      runtime.el.style.display = 'none'
    }
    releaseEditorMemory()
    S.open = false
    S.callbacks = null
    S.placingImage = null
    S.placingHandle = null
    S.placingStart = null
    S.penPath = null
    S.textEditingId = null
    clearSelection()
  }

  /**
   * 关闭即释放（对齐宿主「内存里不放大图」的模型）：
   * 此前 close() 只把遮罩 display:none，历史快照（≤128MB 的全幅 ImageData）、
   * 各全幅图层/overlay canvas 的像素缓冲、原图 Image 与 base64 全部继续驻留 ——
   * 编辑一张 4K 图后即使退出，堆里仍挂着 ~100MB，直到下次打开编辑器才被重建顶掉。
   * 释放后下次 open() 由 setupCanvas + resetState 全量重建，无状态残留依赖。
   */
  function releaseEditorMemory() {
    // 1) 撤销/重做栈：像素快照是最大头
    S.history = []
    S.redoStack = []
    // 2) 原图引用与吸管合成缓存（各为一张全幅位图）
    S.originalImage = null
    S.pickerComposite = null
    // 3) 交互态复位：关闭后 window mouseup 等全局监听仍活着，靠标志位保证不落到绘制路径
    S.isDrawing = false
    S.panning = false
    S.penDragPt = -1
    S.penDragPending = null
    S.placingImage = null
    S.placingHandle = null
    S.placingStart = null
    // 4) 位图图层（含 sourceCanvas）：置 0 释放像素缓冲并从 DOM 摘除；
    //    setupCanvas 依赖 S.layers 做清理，这里必须同步清空，避免下次打开残留旧 canvas
    for (const layer of S.layers) {
      try {
        if (layer.sourceCanvas) { layer.sourceCanvas.width = 0; layer.sourceCanvas.height = 0 }
        if (layer.canvas) {
          if (layer.canvas.parentNode) layer.canvas.parentNode.removeChild(layer.canvas)
          layer.canvas.width = 0
          layer.canvas.height = 0
        }
      } catch (e) { /* 单个图层释放失败不阻断其余 */ }
    }
    S.layers = []
    // 5) 工作 canvas：text / stroke / overlay（overlay 含 18% 交互边距，4K 图约 74MB）
    for (const c of [S.textCanvas, S.strokeCanvas, S.overlayCanvas]) {
      try { if (c) { c.width = 0; c.height = 0 } } catch (e) { /* ignore */ }
    }
    // 6) 矢量对象的画布缓存
    purgeVectorCanvases()
  }

  // ============ 输出 ============
  /**
   * 导出：合成 → PNG 字节 → onResult(out, mode) → close()。
   * 用 toBlob 而非 toDataURL —— 编码结果落在浏览器 Blob 存储（堆外），
   * 省掉全幅 base64 字符串（4K 图约 44MB JS 堆驻留）；onResult 收到 Blob 或 dataURL 均可。
   */
  export function exportResult(mode) {
    if (S.placingImage) cancelImagePlacement()
    const tmp = getCompositeCanvas()
    let done = false
    const finish = (out) => {
      if (done) return
      done = true
      tmp.width = 0 // 合成画布用完即弃（33MB@4K）
      tmp.height = 0
      if (S.callbacks && S.callbacks.onResult) {
        S.callbacks.onResult(out, mode)
      }
      close()
    }
    const fail = (e) => {
      if (done) return
      done = true
      tmp.width = 0
      tmp.height = 0
      console.error('[IWB编辑器] 导出失败:', e)
      if (S.callbacks && S.callbacks.onError) S.callbacks.onError('图片跨域无法导出')
    }
    try {
      if (typeof tmp.toBlob === 'function') {
        tmp.toBlob((blob) => {
          if (blob) { finish(blob); return }
          // toBlob 对非 origin-clean 画布返回 null → 退回 toDataURL 让它抛出明确的 SecurityError
          try { finish(tmp.toDataURL('image/png')) } catch (e) { fail(e) }
        }, 'image/png')
        return
      }
      finish(tmp.toDataURL('image/png'))
    } catch (e) {
      fail(e)
    }
  }

  // ============ 暴露接口 ============
  /**
   * 快照/历史开销观测口（性能回归与手测用）：
   *   history / redo           当前栈深度与占用字节
   *   snapshots                快照次数
   *   getImageDataCalls        累计全幅像素读取次数（优化前后最直观的对比指标）
   *   bytesWritten             累计拍摄的像素字节数
   */
  export const __stats = () => ({
    history: S.history.length,
    historyBytes: S.history.reduce((n, s) => n + (s.__bytes || 0), 0),
    redo: S.redoStack.length,
    redoBytes: S.redoStack.reduce((n, s) => n + (s.__bytes || 0), 0),
    maxEntries: HISTORY_MAX_ENTRIES,
    maxBytes: HISTORY_MAX_BYTES,
    historyBudget: historyBudgetBytes(),
    ...snapshotStats
  })

  window.__iwbEditor = {
    open,
    close,
    __stats
  }
