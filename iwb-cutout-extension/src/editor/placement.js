/* placement.js - 导入图片的放置（先调大小/位置再确认）
 * 节：图片放置（导入图片时先调整大小/位置）。
 * 状态挂在 S.placingImage / placingHandle / placingStart 上，
 * 确认后由 confirmImagePlacement 把图片落成新的位图图层（调 layers.js）。
 */

'use strict'

import { S } from './state.js'
import { boxCorners, drawRotationHandles, hitRotationHandle, rotPt, unrotPt } from './viewport.js'
import { clearOverlay } from './crop.js'
import { createLayerCanvas, redrawBitmapLayer, renderLayerPanel, reorderLayerCanvas, setActiveLayer, updateLayerCanvasStyles } from './layers.js'
import { saveSnapshot } from './history.js'
import { updateCursor } from './events.js'


  // ============ 图片放置（导入图片时先调整大小/位置） ============

  /** 启动图片放置：默认尺寸为图片原大但不超过画布 50%，居中 */
  export function startImagePlacement(img) {
    const iw = img.naturalWidth || img.width
    const ih = img.naturalHeight || img.height
    // 默认大小：不超过画布宽高的 50%
    const maxW = S.imgW * 0.5
    const maxH = S.imgH * 0.5
    const ratio = Math.min(maxW / iw, maxH / ih, 1)
    let w = Math.round(iw * ratio)
    let h = Math.round(ih * ratio)
    if (w < 10) w = 10
    if (h < 10) h = 10
    // 居中
    const x = Math.round((S.imgW - w) / 2)
    const y = Math.round((S.imgH - h) / 2)
    S.placingImage = { img, x, y, w, h, rotation: 0 }
    S.placingHandle = null
    S.placingStart = null
    S.drawCanvasCursor('move')
    drawPlacementPreview()
  }

  /** 确认图片放置：创建新位图图层并绘制图片 */
  export function confirmImagePlacement() {
    if (!S.placingImage) return
    const { img, x, y, w, h } = S.placingImage
    const placementRotation = S.placingImage.rotation || 0
    S.placingImage = null
    S.placingHandle = null
    S.placingStart = null
    clearOverlay()
    // 创建图层
    const id = 'L' + Date.now() + Math.floor(Math.random() * 1000)
    const canvas = createLayerCanvas()
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    ctx.clearRect(0, 0, S.imgW, S.imgH)
    const layer = {
      id,
      name: '图层 ' + (S.layers.length + 1), image: img, x, y, w, h, rotation: placementRotation, transformable: true,
      canvas,
      ctx,
      opacity: 1,
      visible: true,
       locked: false,
      z: S.layers.length
    }
    redrawBitmapLayer(layer)
    saveSnapshot()
    S.layers.push(layer)
    reorderLayerCanvas()
    setActiveLayer(id)
    updateLayerCanvasStyles()
    renderLayerPanel()
    updateCursor()
  }

  /** 取消图片放置 */
  export function cancelImagePlacement() {
    S.placingImage = null
    S.placingHandle = null
    S.placingStart = null
    clearOverlay()
    updateCursor()
  }

  /** 放置预览：在 overlay 上画图片 + 手柄 */
  export function drawPlacementPreview() {
    if (!S.placingImage) return
    const ctx = S.overlayCtx
    const { img, x, y, w, h } = S.placingImage
    const rot = S.placingImage.rotation || 0
    const cx = x + w / 2, cy = y + h / 2
    clearOverlay()
    // 半透明遮罩
    ctx.save()
    ctx.fillStyle = 'rgba(0,0,0,0.35)'
    ctx.fillRect(0, 0, S.imgW, S.imgH)
    ctx.restore()
    // 画图片（带旋转）
    ctx.save()
    ctx.translate(cx, cy)
    if (rot) ctx.rotate(rot * Math.PI / 180)
    ctx.translate(-cx, -cy)
    ctx.drawImage(img, x, y, w, h)
    ctx.restore()
    // 选区边框（旋转后）
    const corners = boxCorners(x, y, w, h, rot)
    ctx.save()
    ctx.strokeStyle = '#4488ff'
    ctx.lineWidth = 2 / S.zoom
    ctx.setLineDash([8 / S.zoom, 4 / S.zoom])
    ctx.beginPath()
    ctx.moveTo(corners[0][0], corners[0][1])
    for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i][0], corners[i][1])
    ctx.closePath()
    ctx.stroke()
    ctx.setLineDash([])
    // 8 个缩放手柄（旋转后位置）
    const hs = 8 / S.zoom
    ctx.fillStyle = '#fff'
    ctx.strokeStyle = '#4488ff'
    ctx.lineWidth = 1.5 / S.zoom
    const localPts = {
      nw: [x, y], ne: [x + w, y],
      sw: [x, y + h], se: [x + w, y + h],
      n: [x + w / 2, y], s: [x + w / 2, y + h],
      e: [x + w, y + h / 2], w: [x, y + h / 2]
    }
    for (const name in localPts) {
      const ptp = rotPt(localPts[name][0], localPts[name][1], cx, cy, rot)
      ctx.beginPath()
      ctx.rect(ptp[0] - hs, ptp[1] - hs, hs * 2, hs * 2)
      ctx.fill()
      ctx.stroke()
    }
    ctx.restore()
    // 四角外侧圆弧 = 旋转手柄
    drawRotationHandles(ctx, { x, y, w, h }, rot)
    // 提示文字
    ctx.save()
    ctx.font = 'bold ' + Math.round(14 / S.zoom) + 'px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    const hintText = '拖拽手柄调整大小 · 圆点=旋转 · Shift=等比/15°吸附 · Enter=确认 · Esc=取消'
    const br = boxCorners(x, y, w, h, rot).reduce((acc, pt) => Math.max(acc, pt[1]), -Infinity)
    const hintY = br + 10 / S.zoom
    const tw = ctx.measureText(hintText).width
    ctx.fillStyle = 'rgba(0,0,0,0.6)'
    ctx.fillRect(cx - tw / 2 - 6 / S.zoom, hintY, tw + 12 / S.zoom, 22 / S.zoom)
    ctx.fillStyle = 'rgba(255,255,255,0.95)'
    ctx.fillText(hintText, cx, hintY + 4 / S.zoom)
    ctx.restore()
  }

  export function hitPlacementHandle(pos) {
    if (!S.placingImage) return null
    const { x, y, w, h } = S.placingImage
    const rot = S.placingImage.rotation || 0
    const cx = x + w / 2, cy = y + h / 2
    const lp = unrotPt(pos.x, pos.y, cx, cy, rot)
    const R = 12 / S.zoom
    // 四角外侧圆弧 = 旋转手柄
    if (hitRotationHandle(lp, { x, y, w, h })) return 'rotate'
    const pts = {
      nw: [x, y], ne: [x + w, y],
      sw: [x, y + h], se: [x + w, y + h],
      n: [x + w / 2, y], s: [x + w / 2, y + h],
      e: [x + w, y + h / 2], w: [x, y + h / 2]
    }
    let best = null, bestDist = 1e9
    for (const name in pts) {
      const dx = lp[0] - pts[name][0], dy = lp[1] - pts[name][1]
      const d = dx * dx + dy * dy
      if (d < R * R && d < bestDist) { bestDist = d; best = name }
    }
    return best
  }

  /** 检查是否在放置矩形内 */
  export function insidePlacementRect(pos) {
    if (!S.placingImage) return false
    const { x, y, w, h } = S.placingImage
    const rot = S.placingImage.rotation || 0
    const cx = x + w / 2, cy = y + h / 2
    const lp = unrotPt(pos.x, pos.y, cx, cy, rot)
    return lp[0] >= x && lp[0] <= x + w && lp[1] >= y && lp[1] <= y + h
  }

  /** 放置手柄拖拽：根据手柄调整图片大小 */
  export function resizePlacement(pos) {
    if (!S.placingImage || !S.placingHandle || !S.placingStart) return
    const { img } = S.placingImage
    const s = S.placingStart
    const iw = img.naturalWidth || img.width
    const ih = img.naturalHeight || img.height
    const aspect = iw / ih
    const hh = S.placingHandle

    if (hh === 'move') {
      const dx = pos.x - s.mx
      const dy = pos.y - s.my
      S.placingImage.x = s.x + dx
      S.placingImage.y = s.y + dy
      return
    }

    if (hh === 'rotate') {
      const rcx = s.x + s.w / 2, rcy = s.y + s.h / 2
      const a0 = Math.atan2(s.my - rcy, s.mx - rcx)
      const a1 = Math.atan2(pos.y - rcy, pos.x - rcx)
      let deg = (s.rotation || 0) + (a1 - a0) * 180 / Math.PI
      if (S._shiftDown) deg = Math.round(deg / 15) * 15
      S.placingImage.rotation = deg
      return
    }

    // 缩放：先反旋转到图片局部坐标系再计算
    const loc = unrotPt(pos.x, pos.y, s.x + s.w / 2, s.y + s.h / 2, s.rotation || 0)
    pos = { x: loc[0], y: loc[1] }

    // 计算新矩形
    let nx = s.x, ny = s.y, nw = s.w, nh = s.h
    if (hh.includes('e')) nw = Math.max(10, pos.x - s.x)
    if (hh.includes('s')) nh = Math.max(10, pos.y - s.y)
    if (hh.includes('w')) { const r = s.x + s.w; nx = Math.min(pos.x, r - 10); nw = r - nx }
    if (hh.includes('n')) { const b = s.y + s.h; ny = Math.min(pos.y, b - 10); nh = b - ny }

    // Shift 键 = 等比缩放
    if (S._shiftDown) {
      if (nw / nh > aspect) {
        if (hh.includes('n') || hh.includes('s')) {
          nw = nh * aspect
          if (hh.includes('w')) nx = s.x + s.w - nw
        } else {
          nh = nw / aspect
          if (hh.includes('n')) ny = s.y + s.h - nh
        }
      } else {
        if (hh.includes('e') || hh.includes('w')) {
          nh = nw / aspect
          if (hh.includes('n')) ny = s.y + s.h - nh
        } else {
          nw = nh * aspect
          if (hh.includes('w')) nx = s.x + s.w - nw
        }
      }
    }

    S.placingImage.x = nx
    S.placingImage.y = ny
    S.placingImage.w = nw
    S.placingImage.h = nh
  }
