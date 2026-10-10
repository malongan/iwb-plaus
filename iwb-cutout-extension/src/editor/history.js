/* history.js - 历史快照与撤销/重做
 * 节：历史快照（所有位图图层 + 矢量对象）。
 * 约定：快照序列化依赖 shared/layer-logic.js 的 restorePath/needsPixelSnapshot，
 * 与 layers.js 各自独立实现「恢复图层」路径，互不 import。
 * 暴露 snapshotStats、HISTORY_MAX_ENTRIES、HISTORY_MAX_BYTES 供 __stats 观测。
 */

'use strict'

import { S } from './state.js'
import { clearOverlay, updateCropInfo } from './crop.js'
import { hideTextInput, renderObjects } from './objects.js'
import { purgeVectorCanvases, redrawBitmapLayer, renderLayerPanel, reorderLayerCanvas } from './layers.js'
import { setupCanvas } from './viewport.js'
import { updateAllUI } from './events.js'
import { isDrawableLayer, needsPixelSnapshot, restorePath } from '../shared/layer-logic.js'


  // ============ 历史快照（所有位图图层 + 矢量对象） ============

  // 快照开销统计：控制台 window.__iwbEditor.__stats() 可读
  export const snapshotStats = { snapshots: 0, getImageDataCalls: 0, bytesWritten: 0 }

  // restorePath()（快照端"要不要拍"与恢复端"要不要读"的共同判定）
  // 由 shared/layer-logic.js 提供，并有单元测试守护两边一致这条不变量。

  /**
   * 捕获当前状态
   * @param {{metaOnly?: boolean}} [opts]
   *   metaOnly=true：只取几何/矢量/图层元数据。拖拽结束时仅用于"有没有变化"的比对，
   *                  比对从不读像素，此前却照样做全量 getImageData —— 纯浪费。
   *   默认：只为 needsPixelSnapshot() 为 true 的图层拍像素，可重绘图层只存几何。
   */
  export function snapshotState(opts) {
    const metaOnly = !!(opts && opts.metaOnly)
    const bitmaps = S.layers.map(layer => {
      let data = null
      if (!metaOnly && needsPixelSnapshot(layer)) {
        try { data = layer.ctx.getImageData(0, 0, S.imgW, S.imgH) } catch (e) { /* ignore */ }
        if (data) {
          snapshotStats.getImageDataCalls++
          snapshotStats.bytesWritten += data.data.byteLength
        }
      }
      return {
         id: layer.id,
         data,
         x: layer.x, y: layer.y, w: layer.w, h: layer.h,
         rotation: layer.rotation || 0,
         transformable: !!layer.transformable,
         locked: !!layer.locked
       }
    })
    snapshotStats.snapshots++
    return {
      bitmaps,
      texts: JSON.parse(JSON.stringify(S.textLayers)),
      shapes: JSON.parse(JSON.stringify(S.shapeLayers)),
      layerOrder: S.layers.map(l => ({ id: l.id, name: l.name, z: l.z, opacity: l.opacity, visible: l.visible, locked: !!l.locked, x: l.x, y: l.y, w: l.w, h: l.h }))
    }
  }

  // 历史既限条数也限字节：大图下"固定 50 条全量像素"峰值可超过 1GB
  export const HISTORY_MAX_ENTRIES = 50
  export const HISTORY_MAX_BYTES = 128 * 1024 * 1024

  /** 一条历史快照的大致内存占用（像素为主，矢量用序列化长度估算） */
  function stateBytes(state) {
    let n = 0
    if (state && state.bitmaps) {
      for (const b of state.bitmaps) {
        if (b.data && b.data.data) n += b.data.data.byteLength
      }
    }
    if (state) {
      n += state.texts ? JSON.stringify(state.texts).length * 2 : 0
      n += state.shapes ? JSON.stringify(state.shapes).length * 2 : 0
    }
    return n
  }

  /** 压入栈并执行"条数 + 字节"双预算，超出丢最旧 */
  export function pushHistory(stack, state) {
    state.__bytes = stateBytes(state)
    stack.push(state)
    let total = stack.reduce((sum, s) => sum + (s.__bytes || 0), 0)
    while (stack.length > 1 && (stack.length > HISTORY_MAX_ENTRIES || total > HISTORY_MAX_BYTES)) {
      total -= stack.shift().__bytes || 0
    }
    return state
  }

  /** 操作前调用：压入历史，清空重做栈 */
  export function saveSnapshot() {
    pushHistory(S.history, snapshotState())
    S.redoStack = []
  }

  /** 恢复到指定状态 */
  function restoreState(state) {
    purgeVectorCanvases()
    for (const l of S.layers) l._bounds = undefined
    if (state.bitmaps) {
      for (let i = 0; i < state.bitmaps.length; i++) {
        const bm = state.bitmaps[i]
        const layer = S.layers.find(l => l.id === bm.id)
        if (layer) {
          layer.x = bm.x
          layer.y = bm.y
          layer.w = bm.w
          layer.h = bm.h
          layer.locked = !!bm.locked
          layer.rotation = bm.rotation || 0
          if (isDrawableLayer(layer)) {
            layer._srcBox = null
            layer.sourceCanvas = null
            layer.rotation = 0
            layer.x = 0
            layer.y = 0
            layer.w = S.imgW
            layer.h = S.imgH
            layer._bounds = undefined
          }
          // 快照端用 restorePath() 决定是否拍像素，这里用同一判定决定是否读像素
          if (restorePath(layer) === 'redraw') {
            redrawBitmapLayer(layer)
          } else if (bm.data) {
            try {
              layer.ctx.clearRect(0, 0, S.imgW, S.imgH)
              layer.ctx.putImageData(bm.data, 0, 0)
            } catch (e) { /* ignore */ }
          }
        }
      }
    }
    if (state.layerOrder) {
       for (const meta of state.layerOrder) {
         const layer = S.layers.find(l => l.id === meta.id)
         if (layer) { layer.name = meta.name; layer.z = meta.z; layer.opacity = meta.opacity == null ? 1 : meta.opacity; layer.visible = meta.visible !== false; layer.locked = !!meta.locked }
       }
       reorderLayerCanvas()
     }
     S.textLayers = state.texts ? JSON.parse(JSON.stringify(state.texts)) : []
    S.shapeLayers = state.shapes ? JSON.parse(JSON.stringify(state.shapes)) : []
    S.selectedTextId = null
    S.textDrag = null
    S.selectedShapeId = null
    S.shapeDrag = null
    renderObjects()
    renderLayerPanel()
  }

  export function undo() {
    if (S.placingImage) return
    if (S.isDrawing || S.textDrag || S.shapeDrag) return
    if (S.history.length === 0) return
    pushHistory(S.redoStack, snapshotState())
    restoreState(S.history.pop())
  }

  export function redo() {
    if (S.placingImage) return
    if (S.isDrawing || S.textDrag || S.shapeDrag) return
    if (S.redoStack.length === 0) return
    pushHistory(S.history, snapshotState())
    restoreState(S.redoStack.pop())
  }

  export function resetDraw() {
    purgeVectorCanvases()
    // 清空所有位图图层（保留原图层的内容不变，只清画笔层和后续图层）
    for (const layer of S.layers) {
      if (layer.id !== 'base') {
        layer.ctx.clearRect(0, 0, S.imgW, S.imgH)
        if (layer.sourceCanvas) layer.sourceCanvas.getContext('2d').clearRect(0, 0, layer.sourceCanvas.width, layer.sourceCanvas.height)
      }
    }
    S.history = []
    S.redoStack = []
    S.cropRect = null
    S.cropHandle = null
    S.cropMoving = false
    S.moveStart = null
    S.textLayers = []
    S.selectedTextId = null
    S.textDrag = null
    S.textEditingId = null
    S.shapeLayers = []
    S.selectedShapeId = null
    S.shapeDrag = null
    renderObjects()
    renderLayerPanel()
    clearOverlay()
    updateCropInfo()
    hideTextInput()
  }

  /** 复原：一键回到打开编辑器时的原始图片（撤销所有标注与裁剪） */
  export function restoreOriginal() {
    if (!S.originalImage) return
    if (!window.confirm('复原将丢弃所有标注和裁剪，回到原始图片。确定继续吗？')) return
    S.imgW = S.originalImage.naturalWidth || S.originalImage.width
    S.imgH = S.originalImage.naturalHeight || S.originalImage.height
    S.zoom = 1
    setupCanvas(S.originalImage)
    resetDraw()
    updateAllUI()
  }
