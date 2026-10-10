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
import { HISTORY_MAX_BYTES, HISTORY_MAX_ENTRIES, snapshotStats } from './history.js'
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
    S.open = false
    S.callbacks = null
    S.placingImage = null
    S.placingHandle = null
    S.placingStart = null
    S.penPath = null
    S.textEditingId = null
    clearSelection()
  }

  // ============ 输出 ============
  export function exportResult(mode) {
    if (S.placingImage) cancelImagePlacement()
    const tmp = getCompositeCanvas()
    let dataUrl
    try {
      dataUrl = tmp.toDataURL('image/png')
    } catch (e) {
      console.error('[IWB编辑器] 导出失败:', e)
      if (S.callbacks && S.callbacks.onError) S.callbacks.onError('图片跨域无法导出')
      return
    }
    if (S.callbacks && S.callbacks.onResult) {
      S.callbacks.onResult(dataUrl, mode)
    }
    close()
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
    ...snapshotStats
  })

  window.__iwbEditor = {
    open,
    close,
    __stats
  }
