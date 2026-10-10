/* tools.js - 画笔、橡皮、吸管与合成画布
 * 节：绘制工具、合成画布（吸管取样 / 导出 / 裁剪共用）。
 * 约定：brushStampCache 是模块级缓存，只在本模块内重建；
 * getCompositeCanvas 把所有可见图层+矢量对象合成到一张画布，
 * 吸管/导出/裁剪共用它。
 */

'use strict'

import { S, runtime } from './state.js'
import { allObjects, commitTextInput, getSelectedShape, getSelectedText, renderObjects, shapeBounds } from './objects.js'
import { cancelCrop, clearOverlay, hideCropBar, showCropBar, updateCropInfo } from './crop.js'
import { cancelImagePlacement } from './placement.js'
import { clamp } from './viewport.js'
import { getActiveCtx, getActiveLayer, renderLayerPanel } from './layers.js'
import { saveSnapshot } from './history.js'
import { updateBrushParamUI, updateColorUI, updateToolUI } from './events.js'
import { isDrawableLayer } from '../shared/layer-logic.js'
import { hexToRgb, rgbToHex } from '../shared/image-math.js'


  // ============ 绘制工具 ============
  // hexToRgb / rgbToHex / parseRatio 统一由 shared/image-math.js 提供（可单测）

  let brushStampCache = { key: '', canvas: null }

  /** 软边笔刷章：径向渐变离屏 canvas */
  function getBrushStamp(size, color, hardness) {
    const key = size + '|' + color + '|' + hardness
    if (brushStampCache.key === key && brushStampCache.canvas) return brushStampCache.canvas
    const c = document.createElement('canvas')
    c.width = size
    c.height = size
    const cx = c.getContext('2d')
    const half = size / 2
    const { r, g, b } = hexToRgb(color)
    const grad = cx.createRadialGradient(half, half, half * hardness / 100, half, half, half)
    grad.addColorStop(0, `rgba(${r},${g},${b},1)`)
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`)
    cx.fillStyle = grad
    cx.fillRect(0, 0, size, size)
    brushStampCache = { key, canvas: c }
    return c
  }

  /** 画笔/橡皮一笔的一段：画在 strokeCanvas（全不透明），透明度由 endStroke 合成时承担
   *  橡皮用白色（destination-out 合成时只取 alpha 通道） */
  export function strokeSegment(x1, y1, x2, y2) {
    const ctx = S.strokeCtx
    const size = Math.max(1, S.brushSize)
    const color = S.tool === 'eraser' ? '#ffffff' : S.color
    ctx.save()
    if (S.brushHardness >= 100) {
      ctx.strokeStyle = color
      ctx.lineWidth = size
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.beginPath()
      ctx.moveTo(x1, y1)
      ctx.lineTo(x2, y2)
      ctx.stroke()
    } else {
      const stamp = getBrushStamp(size, color, S.brushHardness)
      const dist = Math.hypot(x2 - x1, y2 - y1)
      const step = Math.max(1, size / 6)
      const n = Math.max(0, Math.ceil(dist / step))
      for (let i = 0; i <= n; i++) {
        const t = n === 0 ? 0 : i / n
        ctx.drawImage(stamp, x1 + (x2 - x1) * t - size / 2, y1 + (y2 - y1) * t - size / 2)
      }
    }
    ctx.restore()
    S.strokeCanvas.style.opacity = S.brushOpacity
  }

  export function eraseSegment(x1, y1, x2, y2) {
    const ctx = getActiveCtx()
    if (!ctx) return
    ctx.save()
    ctx.globalCompositeOperation = 'destination-out'
    ctx.globalAlpha = S.brushOpacity
    ctx.lineWidth = Math.max(1, S.brushSize)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y2)
    ctx.stroke()
    ctx.restore()
    const active = getActiveLayer()
    if (active && active.id === 'draw' && active.sourceCanvas) {
      const sourceCtx = active.sourceCanvas.getContext('2d', { willReadFrequently: true })
      sourceCtx.save()
      sourceCtx.globalCompositeOperation = 'destination-out'
      sourceCtx.globalAlpha = S.brushOpacity
      sourceCtx.lineWidth = Math.max(1, S.brushSize) * active.w / Math.max(S.imgW, 1)
      sourceCtx.lineCap = 'round'
      sourceCtx.beginPath()
      sourceCtx.moveTo((x1 - active.x) * S.imgW / active.w, (y1 - active.y) * S.imgW / active.w)
      sourceCtx.lineTo((x2 - active.x) * S.imgW / active.w, (y2 - active.y) * S.imgW / active.w)
      sourceCtx.stroke()
      sourceCtx.restore()
    }
    S.pickerComposite = null
    renderObjects()
  }

  /** 开始一笔 */
  /** 若绘制层已被变换（移动/缩放/旋转），先把结果固化并重置变换参数，保证继续绘制的坐标正确 */
  function bakeDrawableLayer(layer) {
    if (!layer || !isDrawableLayer(layer) || !layer._srcBox) return
    layer._srcBox = null
    layer.sourceCanvas = null
    layer.rotation = 0
    layer.x = 0
    layer.y = 0
    layer.w = S.imgW
    layer.h = S.imgH
    layer._bounds = undefined
  }

  export function beginStroke() {
    bakeDrawableLayer(getActiveLayer())
    S.strokeCanvas.width = S.imgW
    S.strokeCanvas.height = S.imgH
    S.strokeCtx.clearRect(0, 0, S.imgW, S.imgH)
    // 橡皮擦直接修改活跃图层，不显示独立轨迹层。
    S.strokeCanvas.style.display = S.tool === 'eraser' ? 'none' : 'block'
    S.strokeCanvas.style.opacity = S.brushOpacity
  }

  /** 结束一笔：按透明度一次性合成进活跃图层（画笔=正常合成，橡皮=destination-out） */
  export function endStroke() {
    for (const l of S.layers) l._bounds = undefined
    const ctx = getActiveCtx()
    if (!ctx) return
    ctx.save()
    if (S.tool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out'
    }
    ctx.globalAlpha = S.brushOpacity
    ctx.drawImage(S.strokeCanvas, 0, 0)
    ctx.restore()
    S.strokeCanvas.style.display = 'none'
    const active = getActiveLayer()
    if (active && active.id === 'draw' && active.sourceCanvas && active.w > 0 && active.h > 0) {
      const sourceCtx = active.sourceCanvas.getContext('2d', { willReadFrequently: true })
      sourceCtx.save()
      sourceCtx.globalCompositeOperation = S.tool === 'eraser' ? 'destination-out' : 'source-over'
      sourceCtx.globalAlpha = S.brushOpacity
      sourceCtx.translate(-active.x * S.imgW / active.w, -active.y * S.imgH / active.h)
      sourceCtx.scale(S.imgW / active.w, S.imgH / active.h)
      sourceCtx.drawImage(S.strokeCanvas, 0, 0)
      sourceCtx.restore()
    }
    S.strokeCtx.clearRect(0, 0, S.imgW, S.imgH)
    S.pickerComposite = null
  }

  /** 按形状对象绘制（矩形/箭头），预览与最终渲染共用 */
  export function drawShape(ctx, s) {
    ctx.save()
    ctx.globalAlpha = s.opacity != null ? s.opacity : 1
    const rot = s.rotation || 0
    if (rot) {
      const b = shapeBounds(s)
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2
      ctx.translate(cx, cy)
      ctx.rotate(rot * Math.PI / 180)
      ctx.translate(-cx, -cy)
    }
    ctx.strokeStyle = s.color
    ctx.lineWidth = s.lw
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    if (s.type === 'pen') {
      const pts = Array.isArray(s.pts) ? s.pts : []
      if (pts.length > 1) { ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y); if (s.closed) ctx.closePath(); if (s.closed && s.fill) { ctx.fillStyle = s.color; ctx.fill() } ctx.stroke() }
    } else if (s.type === 'rect') {
      const rx = Math.min(s.x1, s.x2), ry = Math.min(s.y1, s.y2), rw = Math.abs(s.x2 - s.x1), rh = Math.abs(s.y2 - s.y1)
      if (s.fill) { ctx.fillStyle = s.color; ctx.fillRect(rx, ry, rw, rh) }
      ctx.strokeRect(rx, ry, rw, rh)
    } else if (s.type === 'circle') {
      const rx = Math.min(s.x1, s.x2), ry = Math.min(s.y1, s.y2)
      const rw = Math.abs(s.x2 - s.x1), rh = Math.abs(s.y2 - s.y1)
      ctx.beginPath()
      ctx.ellipse(rx + rw / 2, ry + rh / 2, Math.max(1, rw / 2), Math.max(1, rh / 2), 0, 0, Math.PI * 2)
      if (s.fill) { ctx.fillStyle = s.color; ctx.fill() }
      ctx.stroke()
    } else {
      ctx.fillStyle = s.color
      ctx.beginPath()
      ctx.moveTo(s.x1, s.y1)
      ctx.lineTo(s.x2, s.y2)
      ctx.stroke()
      const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1)
      const headLen = Math.max(12, s.lw * 4)
      ctx.beginPath()
      ctx.moveTo(s.x2, s.y2)
      ctx.lineTo(s.x2 - headLen * Math.cos(angle - Math.PI / 6), s.y2 - headLen * Math.sin(angle - Math.PI / 6))
      ctx.moveTo(s.x2, s.y2)
      ctx.lineTo(s.x2 - headLen * Math.cos(angle + Math.PI / 6), s.y2 - headLen * Math.sin(angle + Math.PI / 6))
      ctx.stroke()
    }
    ctx.restore()
  }

  /** 当前工具笔刷半径（图片像素） */
  function getToolBrushRadius() {
    return Math.max(1, S.brushSize) / 2
  }

  /** 图片像素 → 屏幕像素 的换算系数 */
  function screenScale() {
    const rect = S.canvasStack.getBoundingClientRect()
    return rect.width ? rect.width / S.imgW : S.zoom
  }

  /** 圆形笔刷光标 */
  export function drawToolRing(pos) {
    clearOverlay()
    const ctx = S.overlayCtx
    const r = getToolBrushRadius()
    const k = 1 / screenScale()
    const rMin = 2 * k
    const rr = Math.max(r, rMin)
    ctx.save()
    ctx.lineWidth = k
    ctx.strokeStyle = 'rgba(0,0,0,0.8)'
    ctx.beginPath()
    ctx.arc(pos.x, pos.y, rr, 0, Math.PI * 2)
    ctx.stroke()
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'
    ctx.lineWidth = k
    ctx.beginPath()
    ctx.arc(pos.x, pos.y, Math.max(rr - k, 0), 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
  }

  // ============ 合成画布（吸管取样 / 导出 / 裁剪共用） ============

  /** 合成所有可见图层到一个临时 canvas */
  export function getCompositeCanvas() {
    const c = document.createElement('canvas')
    c.width = S.imgW
    c.height = S.imgH
    const cx = c.getContext('2d', { willReadFrequently: true })
    const units = []
    for (const l of S.layers) units.push({ z: l.z, el: l.canvas, vis: l.visible, op: l.opacity })
    for (const { obj } of allObjects()) if (obj._canvas) units.push({ z: obj.z || 0, el: obj._canvas, vis: obj.visible !== false, op: obj.opacity != null ? obj.opacity : 1 })
    units.sort((a, b) => a.z - b.z)
    cx.globalAlpha = 1
    for (const u of units) {
      if (!u.vis) continue
      cx.globalAlpha = u.op == null ? 1 : u.op
      cx.drawImage(u.el, 0, 0)
    }
    cx.globalAlpha = 1
    return c
  }

  /** 吸管取样用的合成画布缓存 */
  function getPickerComposite() {
    if (!S.pickerComposite) {
      S.pickerComposite = getCompositeCanvas().getContext('2d', { willReadFrequently: true })
    }
    return S.pickerComposite
  }

  /** 取画布坐标处的合成像素颜色 */
  export function sampleColor(pos) {
    const x = clamp(Math.floor(pos.x), 0, Math.max(0, S.imgW - 1))
    const y = clamp(Math.floor(pos.y), 0, Math.max(0, S.imgH - 1))
    try {
      const d = getPickerComposite().getImageData(x, y, 1, 1).data
      return { r: d[0], g: d[1], b: d[2], a: d[3] }
    } catch (e) {
      return null
    }
  }

  /** 吸管悬停预览浮窗 */
  export function showPickerTip(e, s) {
    const tip = runtime.el.querySelector('.iwb-editor-picker-tip')
    if (!tip) return
    const chip = tip.querySelector('.iwb-editor-picker-chip')
    const hex = tip.querySelector('.iwb-editor-picker-hex')
    if (s && s.a > 0) {
      const h = rgbToHex(s.r, s.g, s.b)
      chip.style.background = h
      chip.style.border = '1px solid rgba(255,255,255,0.3)'
      hex.textContent = h
    } else {
      chip.style.background = 'transparent'
      chip.style.border = '1px dashed rgba(255,255,255,0.4)'
      hex.textContent = '透明'
    }
    tip.style.display = 'flex'
    tip.style.left = (e.clientX + 16) + 'px'
    tip.style.top = (e.clientY + 16) + 'px'
  }

  export function hidePickerTip() {
    const tip = runtime.el.querySelector('.iwb-editor-picker-tip')
    if (tip) tip.style.display = 'none'
  }

  /** 取色完成：切回吸管激活前的工具 */
  export function exitPicker() {
    S.tool = (S.prevTool && S.prevTool !== 'picker') ? S.prevTool : 'brush'
    S.prevTool = null
    S.pickerComposite = null
    hidePickerTip()
    updateToolUI()
    updateBrushParamUI()
    if (S.tool === 'crop') {
      showCropBar()
      updateCropInfo()
    } else {
      cancelCrop()
      hideCropBar()
    }
    renderObjects()
  }

  /** 统一颜色应用：设置当前色 + 同步选中文字/形状颜色 */
  export function applyColorChange(color) {
    S.color = color
    updateColorUI()
    const t = getSelectedText()
    if (t && !t.locked && t.color !== S.color) {
      saveSnapshot()
      t.color = S.color
      renderObjects()
    }
    const sh = getSelectedShape()
    if (sh && !sh.locked && S.tool !== 'text' && sh.color !== S.color) {
      saveSnapshot()
      sh.color = S.color
      renderObjects()
    }
  }

  /** 切换工具（工具栏按钮、快捷键、调色板吸色共用）。保留同类形状选中以便继续编辑。 */
  export function setTool(tool) {
    if (S.placingImage) cancelImagePlacement()
    commitTextInput()
    if (tool !== 'select' && tool !== 'pen') { S.penEditId = null; S.penDragPt = -1; S.penDragPending = null }
    if (tool === 'picker' && S.tool !== 'picker') S.prevTool = S.tool
    if (tool !== 'pen') S.penPath = null
    S.tool = tool
    if (tool !== 'select') S.selectedLayerId = null
    if (tool !== 'text' && tool !== 'select') S.selectedTextId = null
    if (tool !== 'rect' && tool !== 'circle' && tool !== 'arrow' && tool !== 'pen' && tool !== 'select') S.selectedShapeId = null
    S.bitmapDrag = null
    S.textDrag = null
    S.shapeDrag = null
    S.pickerComposite = null
    hidePickerTip()
    updateToolUI()
    updateBrushParamUI()
    if (tool === 'crop') {
      showCropBar()
      updateCropInfo()
    } else {
      cancelCrop()
      hideCropBar()
    }
    renderObjects()
    renderLayerPanel()
  }
