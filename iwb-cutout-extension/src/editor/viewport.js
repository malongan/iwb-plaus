/* viewport.js - 画布尺寸、缩放平移、旋转辅助与坐标换算
 * 节：画布设置、旋转辅助、坐标。
 * 约定：所有屏幕坐标 <-> 图片坐标的换算都过 getPos/rotPt/unrotPt，
 * 缩放状态只写 S.zoom / S.viewX / S.viewY。
 */

'use strict'

import { S, ZOOM_MAX, ZOOM_MIN } from './state.js'
import { bindCanvasEvents, updateZoomUI } from './events.js'
import { clearOverlay } from './crop.js'
import { createLayerCanvas, purgeVectorCanvases, renderLayerPanel, styleVectorViewport } from './layers.js'
import { getSelectedShape, getSelectedText, renderObjects, shapeBounds, textBounds } from './objects.js'


  // ============ 画布设置 ============

  function syncOverlayCanvas() {
    const pad = S.overlayPad || 0
    const scale = S.imgW ? (S.fitW * S.zoom) / S.imgW : 1
    S.overlayCanvas.style.left = '0px'
    S.overlayCanvas.style.top = '0px'
    S.overlayCanvas.style.width = Math.round((S.imgW + pad * 2) * scale) + 'px'
    S.overlayCanvas.style.height = Math.round((S.imgH + pad * 2) * scale) + 'px'
  }

  export function setupCanvas(img) {
    purgeVectorCanvases()
    // 清除旧的动态图层 canvas
    for (const layer of S.layers) {
      if (layer.canvas.parentNode) layer.canvas.parentNode.removeChild(layer.canvas)
    }
    S.layers = []

    // 设置工具 canvas 尺寸
    S.textCanvas.width = S.imgW
    S.textCanvas.height = S.imgH
    S.strokeCanvas.width = S.imgW
    S.strokeCanvas.height = S.imgH
    S.strokeCanvas.style.display = 'none'
    // 裁剪越界区域属于交互工作区，不改变图片本身的画布尺寸。
    S.overlayPad = Math.max(96, Math.ceil(Math.max(S.imgW, S.imgH) * 0.18))
    S.overlayCanvas.width = S.imgW + S.overlayPad * 2
    S.overlayCanvas.height = S.imgH + S.overlayPad * 2
    S.overlayCtx.setTransform(1, 0, 0, 1, S.overlayPad, S.overlayPad)

    // 创建图层 1: 原图
    const baseCanvas = createLayerCanvas()
    const baseCtx = baseCanvas.getContext('2d', { willReadFrequently: true })
    baseCtx.clearRect(0, 0, S.imgW, S.imgH)
    baseCtx.drawImage(img, 0, 0)
    S.layers.push({
      id: 'base',
      name: '原图',
      canvas: baseCanvas,
      ctx: baseCtx,
      opacity: 1,
      visible: true,
      locked: true,
      z: 0
    })

    // 创建图层 2: 画笔标注（空透明层）
    const drawCanvas = createLayerCanvas()
    const drawCtx = drawCanvas.getContext('2d', { willReadFrequently: true })
    drawCtx.clearRect(0, 0, S.imgW, S.imgH)
    S.layers.push({
      id: 'draw',
      name: '画笔标注',
      canvas: drawCanvas,
      ctx: drawCtx,
      opacity: 1,
      visible: true,
       locked: false,
      transformable: true,
      x: 0, y: 0, w: S.imgW, h: S.imgH,
      color: S.color,
      lineWidth: S.brushSize,
      z: 1
    })

    S.activeLayerId = 'draw' // 默认活跃图层为画笔层
    S.zCounter = Math.max(S.layers.length - 1, 0)

    S.textCtx.clearRect(0, 0, S.imgW, S.imgH)
    S.strokeCtx.clearRect(0, 0, S.imgW, S.imgH)
    clearOverlay()
    S.pickerComposite = null

    renderObjects()

    computeFit()
    S.viewX = null
    applyView()
    renderLayerPanel()
    bindCanvasEvents()
  }

  /** 计算「适应容器」的基准显示尺寸（不限制放大，小图也铺满） */
  function computeFit() {
    const availW = Math.max(50, S.canvasWrap.clientWidth - 48)
    const availH = Math.max(50, S.canvasWrap.clientHeight - 48)
    const ratio = Math.min(availW / S.imgW, availH / S.imgH)
    S.fitW = Math.max(1, S.imgW * ratio)
    S.fitH = Math.max(1, S.imgH * ratio)
  }

  /**
   * 应用当前 zoom 与平移位置到画布显示尺寸与位置（自由平移，无边界限制）。
   * @param {object} anchor 可选 { mx, my, px, py }：缩放锚点
   */
  function applyView(anchor) {
    const w = Math.round(S.fitW * S.zoom)
    const h = Math.round(S.fitH * S.zoom)

    // 更新所有 canvas 的显示尺寸（位图图层 + 工具层）
    for (const layer of S.layers) {
      layer.canvas.style.width = w + 'px'
      layer.canvas.style.height = h + 'px'
    }
    S.textCanvas.style.width = S.strokeCanvas.style.width = w + 'px'
    S.textCanvas.style.height = S.strokeCanvas.style.height = h + 'px'
    syncOverlayCanvas()
    const scale = S.imgW ? (S.fitW * S.zoom) / S.imgW : 1
    if (S.transparencyGrid) {
      S.transparencyGrid.style.left = Math.round((S.overlayPad || 0) * scale) + 'px'
      S.transparencyGrid.style.top = Math.round((S.overlayPad || 0) * scale) + 'px'
      S.transparencyGrid.style.width = w + 'px'
      S.transparencyGrid.style.height = h + 'px'
    }
    // 显式固定 stack 尺寸，保证统一坐标基准始终可测量，新增/隐藏图层不会触发布局偏移。
    const pad = S.overlayPad || 0
    S.canvasStack.style.width = Math.round((S.imgW + pad * 2) * scale) + 'px'
    S.canvasStack.style.height = Math.round((S.imgH + pad * 2) * scale) + 'px'
    const layerOffset = Math.round(pad * scale)
    for (const layer of S.layers) {
      layer.canvas.style.left = layerOffset + 'px'
      layer.canvas.style.top = layerOffset + 'px'
    }
    S.textCanvas.style.left = layerOffset + 'px'
    S.textCanvas.style.top = layerOffset + 'px'
    S.strokeCanvas.style.left = layerOffset + 'px'
    S.strokeCanvas.style.top = layerOffset + 'px'
    styleVectorViewport(w, h, layerOffset)

    let left, top
    if (anchor && anchor.mx !== undefined) {
      left = anchor.mx - anchor.px * S.zoom
      top = anchor.my - anchor.py * S.zoom
    } else if (S.viewX !== null) {
      left = S.viewX
      top = S.viewY
    } else {
      left = (S.canvasWrap.clientWidth - w) / 2
      top = (S.canvasWrap.clientHeight - h) / 2
    }
    setView(left, top)
    updateZoomUI()
  }

  /** 设置画布平移位置（自由坐标，无边界限制） */
  export function setView(x, y) {
    S.viewX = x
    S.viewY = y
    const stack = S.canvasStack
    const scale = S.imgW ? (S.fitW * S.zoom) / S.imgW : 1
    const pad = S.overlayPad || 0
    // 让原图左上角仍对应 viewX/viewY，外围 padding 不参与画布平移坐标。
    stack.style.transform = `translate3d(${Math.round(x - pad * scale)}px, ${Math.round(y - pad * scale)}px, 0)`
  }

  /** 以指定屏幕坐标（wrap 内）为中心缩放 */
  export function zoomStep(factor, mx, my) {
    const nz = clamp(S.zoom * factor, ZOOM_MIN, ZOOM_MAX)
    if (nz === S.zoom) return
    const px = (mx - (S.viewX || 0)) / S.zoom
    const py = (my - (S.viewY || 0)) / S.zoom
    S.zoom = nz
    applyView({ mx, my, px, py })
  }

  export function setZoomFit() {
    S.zoom = 1
    S.viewX = null
    applyView()
  }

  export function clamp(v, min, max) { return Math.max(min, Math.min(max, v)) }

  // ============ 旋转辅助 ============
  const ROT_HANDLE_OFFSET = 28 // 旋转手柄相对上边中点的距离（图片坐标）
  export function rotPt(px, py, cx, cy, deg) {
    if (!deg) return [px, py]
    const a = deg * Math.PI / 180, sn = Math.sin(a), cs = Math.cos(a)
    const dx = px - cx, dy = py - cy
    return [cx + dx * cs - dy * sn, cy + dx * sn + dy * cs]
  }
  export function unrotPt(px, py, cx, cy, deg) {
    return rotPt(px, py, cx, cy, -(deg || 0))
  }
  /** 旋转手柄：四个角沿对角线向外偏移（局部坐标） */
  function rotationHandlesLocal(b) {
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2
    const d = 26 / Math.max(S.zoom, 0.0001)
    return [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]].map(c => {
      const dx = c[0] - cx, dy = c[1] - cy, len = Math.hypot(dx, dy) || 1
      return [c[0] + dx / len * d, c[1] + dy / len * d]
    })
  }
  /** 命中旋转手柄（传局部坐标点） */
  export function hitRotationHandle(lp, b) {
    const pts = rotationHandlesLocal(b)
    const R = Math.max(13 / Math.max(S.zoom, 0.0001), 9)
    for (const pt of pts) {
      if (Math.hypot(lp[0] - pt[0], lp[1] - pt[1]) < R) return true
    }
    return false
  }
  /** 绘制四个角外侧的圆弧旋转手柄 */
  export function drawRotationHandles(ctx, b, rot) {
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2
    const pts = rotationHandlesLocal(b)
    const r = Math.max(8 / Math.max(S.zoom, 0.0001), 6)
    ctx.save()
    ctx.strokeStyle = '#e8a735'
    ctx.lineWidth = 2 / Math.max(S.zoom, 0.0001)
    for (const pt of pts) {
      const w = rotPt(pt[0], pt[1], cx, cy, rot || 0)
      ctx.beginPath()
      ctx.arc(w[0], w[1], r, Math.PI * 0.15, Math.PI * 1.85)
      ctx.stroke()
    }
    ctx.restore()
  }
  export const ROT_CURSOR = 'url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'24\' height=\'24\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'black\' stroke-width=\'2\' stroke-linecap=\'round\'><path d=\'M21 12a9 9 0 1 1-3-6.7\'/><polyline points=\'21 3 21 9 15 9\'/></svg>") 12 12, crosshair'

  /** 指针是否悬停在当前选中对象（或放置中图片）的旋转手柄上 */
  export function isOverRotationHandle(p) {
    if (S.placingImage) {
      const b = { x: S.placingImage.x, y: S.placingImage.y, w: S.placingImage.w, h: S.placingImage.h }
      const lp = unrotPt(p.x, p.y, b.x + b.w / 2, b.y + b.h / 2, S.placingImage.rotation || 0)
      return hitRotationHandle(lp, b)
    }
    const t = getSelectedText()
    if (t) {
      const b = textBounds(t)
      const lp = unrotPt(p.x, p.y, b.x + b.w / 2, b.y + b.h / 2, t.rotation || 0)
      return hitRotationHandle(lp, b)
    }
    const sh = getSelectedShape()
    if (sh) {
      const b = shapeBounds(sh)
      const lp = unrotPt(p.x, p.y, b.x + b.w / 2, b.y + b.h / 2, sh.rotation || 0)
      return hitRotationHandle(lp, b)
    }
    const layer = S.layers.find(l => l.id === S.selectedLayerId && l.transformable)
    if (layer) {
      const lp = unrotPt(p.x, p.y, layer.x + layer.w / 2, layer.y + layer.h / 2, layer.rotation || 0)
      return hitRotationHandle(lp, layer)
    }
    return false
  }

  export function boxCorners(x, y, w, h, rot) {
    const cx = x + w / 2, cy = y + h / 2
    return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(pt => rotPt(pt[0], pt[1], cx, cy, rot))
  }

  // ============ 坐标 ============
  export function getPos(e) {
    // 统一使用 stack 的边界作为坐标基准。图层 canvas 可能被隐藏，或在
    // 插入/重排时暂时不参与布局；以具体图层 boundingRect 计算会造成左移。
    const rect = S.canvasStack.getBoundingClientRect()
    const pad = S.overlayPad || 0
    const scale = S.imgW ? (S.fitW * S.zoom) / S.imgW : 1
    return {
      x: (e.clientX - rect.left) / Math.max(scale, 0.0001) - pad,
      y: (e.clientY - rect.top) / Math.max(scale, 0.0001) - pad
    }
  }
