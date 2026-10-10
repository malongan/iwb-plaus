/* crop.js - 裁剪工具
 * 节：裁剪、裁剪栏。
 * 遮罩绘制写 S.overlayCanvas，确认裁剪后重绘位图图层。
 */

'use strict'

import { S, runtime } from './state.js'
import { getCompositeCanvas } from './tools.js'
import { setupCanvas } from './viewport.js'


  // ============ 裁剪 ============
  // parseRatio 由 shared/image-math.js 提供（可单测）

  /** 设置裁剪约束 */
  export function setConstraint(type, ratio, sizeW, sizeH) {
    S.cropConstraint = { type, ratio: ratio || 0, sizeW: sizeW || 0, sizeH: sizeH || 0 }
    const toggle = runtime.el && runtime.el.querySelector('.iwb-editor-size-toggle')
    if (toggle) {
      const active = type === 'size'
      toggle.classList.toggle('active', active)
      toggle.setAttribute('aria-pressed', String(active))
      toggle.textContent = active ? '已启用' : '启用尺寸'
    }
    if (S.cropRect) {
      S.cropRect = applyConstraint(S.cropRect.x, S.cropRect.y, S.cropRect.w, S.cropRect.h)
      drawCropPreview()
      updateCropInfo()
    }
  }

  function applyConstraint(x, y, w, h) {
    const c = S.cropConstraint
    if (c.type === 'free' || !c.ratio || c.ratio <= 0) return { x, y, w, h }
    const ratio = c.ratio
    if (w / h > ratio) {
      const nw = h * ratio
      const dx = (w - nw) / 2
      return { x: x + dx, y, w: nw, h }
    } else {
      const nh = w / ratio
      const dy = (h - nh) / 2
      return { x, y: y + dy, w, h: nh }
    }
  }

  export function applyConstraintDrag(x1, y1, x2, y2) {
    const c = S.cropConstraint
    let rx = Math.min(x1, x2), ry = Math.min(y1, y2)
    let rw = Math.abs(x2 - x1), rh = Math.abs(y2 - y1)
    if (rw < 1) rw = 1
    if (rh < 1) rh = 1
    if (c.type === 'free' || !c.ratio || c.ratio <= 0) return { x: rx, y: ry, w: rw, h: rh }
    const ratio = c.ratio
    if (rw / rh > ratio) {
      rh = rw / ratio
    } else {
      rw = rh * ratio
    }
    return { x: rx, y: ry, w: rw, h: rh }
  }

  export function updateCropInfo() {
    const info = runtime.el.querySelector('.iwb-editor-crop-info')
    if (!info) return
    if (S.cropRect) {
      const w = Math.round(S.cropRect.w)
      const h = Math.round(S.cropRect.h)
      const c = S.cropConstraint
      if (c.type === 'size' && c.sizeW > 0 && c.sizeH > 0) {
        info.textContent = `${w}x${h} -> ${c.sizeW}x${c.sizeH}`
      } else {
        info.textContent = `${w}x${h}`
      }
    } else {
      info.textContent = '--'
    }
  }

  export function clearOverlay() {
    const ctx = S.overlayCtx
     const pad = S.overlayPad || 0
     ctx.save()
     ctx.setTransform(1, 0, 0, 1, 0, 0)
     ctx.clearRect(0, 0, S.imgW + pad * 2, S.imgH + pad * 2)
     ctx.restore()
     ctx.setTransform(1, 0, 0, 1, pad, pad)
  }

  export function drawCropPreview(x1, y1, x2, y2) {
    const ctx = S.overlayCtx
    clearOverlay()
    let rx, ry, rw, rh
    if (x2 !== undefined) {
      const r = applyConstraintDrag(x1, y1, x2, y2)
      rx = r.x; ry = r.y; rw = r.w; rh = r.h
    } else if (S.cropRect) {
      rx = S.cropRect.x; ry = S.cropRect.y
      rw = S.cropRect.w; rh = S.cropRect.h
    } else {
      return
    }
    ctx.save()
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    const cropPad = Math.max(S.imgW, S.imgH) * 2
     ctx.fillRect(-cropPad, -cropPad, S.imgW + cropPad * 2, S.imgH + cropPad * 2)
    ctx.globalCompositeOperation = 'destination-out'
    ctx.fillRect(rx, ry, rw, rh)
    ctx.restore()
    ctx.save()
    ctx.strokeStyle = '#4488ff'
    ctx.lineWidth = 2 / S.zoom
    ctx.setLineDash([8 / S.zoom, 4 / S.zoom])
    ctx.strokeRect(rx, ry, rw, rh)
    ctx.restore()
    if (S.cropRect && !S.cropHandle) drawCropHandles(rx, ry, rw, rh)
  }

  function cropHandlePoints(rx, ry, rw, rh) {
    return {
      nw: [rx, ry], ne: [rx + rw, ry],
      sw: [rx, ry + rh], se: [rx + rw, ry + rh],
      n: [rx + rw / 2, ry], s: [rx + rw / 2, ry + rh],
      e: [rx + rw, ry + rh / 2], w: [rx, ry + rh / 2]
    }
  }

  function drawCropHandles(rx, ry, rw, rh) {
    const ctx = S.overlayCtx
    const pts = cropHandlePoints(rx, ry, rw, rh)
    const hs = 4 / S.zoom
    ctx.save()
    ctx.fillStyle = '#ffffff'
    ctx.strokeStyle = '#4488ff'
    ctx.lineWidth = 1.5 / S.zoom
    for (const name in pts) {
      ctx.beginPath()
      ctx.rect(pts[name][0] - hs, pts[name][1] - hs, hs * 2, hs * 2)
      ctx.fill()
      ctx.stroke()
    }
    ctx.restore()
  }

  export function insideRect(pos, rect) {
    return pos.x >= rect.x && pos.x <= rect.x + rect.w &&
           pos.y >= rect.y && pos.y <= rect.y + rect.h
  }

  export function hitCropHandle(pos) {
    if (!S.cropRect) return null
    const pts = cropHandlePoints(S.cropRect.x, S.cropRect.y, S.cropRect.w, S.cropRect.h)
    const R = 12 / S.zoom
    let best = null, bestDist = 1e9
    for (const name in pts) {
      const dx = pos.x - pts[name][0], dy = pos.y - pts[name][1]
      const d = dx * dx + dy * dy
      if (d < R * R && d < bestDist) { bestDist = d; best = name }
    }
    return best
  }

  export function resizeCropRect(pos) {
    if (!S.cropRect) return
    const { x, y, w, h } = S.cropRect
    const c = S.cropConstraint
    let nx = x, ny = y, nw = w, nh = h
    const hh = S.cropHandle

    // 自由比例：允许超出画布边界（负值/超出值都合法），只限制最小尺寸
    if (c.type === 'free' || !c.ratio || c.ratio <= 0) {
      if (hh.includes('e')) nw = Math.max(4, pos.x - x)
      if (hh.includes('s')) nh = Math.max(4, pos.y - y)
      if (hh.includes('w')) { const right = x + w; nx = Math.min(pos.x, right - 4); nw = right - nx }
      if (hh.includes('n')) { const bottom = y + h; ny = Math.min(pos.y, bottom - 4); nh = bottom - ny }
      S.cropRect = { x: nx, y: ny, w: nw, h: nh }
      return
    }

    // 等比约束：同样允许超出画布边界
    const ratio = c.ratio

    if (hh === 'e' || hh === 'w') {
      if (hh === 'e') {
        nw = Math.max(4, pos.x - x)
      } else {
        const right = x + w
        nx = Math.min(pos.x, right - 4)
        nw = right - nx
      }
      nh = nw / ratio
    } else if (hh === 'n' || hh === 's') {
      if (hh === 's') {
        nh = Math.max(4, pos.y - y)
      } else {
        const bottom = y + h
        ny = Math.min(pos.y, bottom - 4)
        nh = bottom - ny
      }
      nw = nh * ratio
    } else {
      if (hh === 'se') {
        nw = Math.max(4, pos.x - x)
        nh = Math.max(4, pos.y - y)
      } else if (hh === 'ne') {
        nw = Math.max(4, pos.x - x)
        const bottom = y + h
        ny = Math.min(pos.y, bottom - 4)
        nh = bottom - ny
      } else if (hh === 'sw') {
        const right = x + w
        nx = Math.min(pos.x, right - 4)
        nw = right - nx
        nh = Math.max(4, pos.y - y)
      } else if (hh === 'nw') {
        const right = x + w
        nx = Math.min(pos.x, right - 4)
        nw = right - nx
        const bottom = y + h
        ny = Math.min(pos.y, bottom - 4)
        nh = bottom - ny
      }
      // 等比修正
      if (nw / nh > ratio) {
        nh = nw / ratio
        if (hh === 'ne' || hh === 'nw') ny = y + h - nh
      } else {
        nw = nh * ratio
        if (hh === 'nw' || hh === 'sw') nx = x + w - nw
      }
    }

    S.cropRect = { x: nx, y: ny, w: nw, h: nh }
  }

  export function confirmCrop() {
    if (!S.cropRect) return
    const { x, y, w, h } = S.cropRect
    if (w < 2 || h < 2) { cancelCrop(); return }
    // 合成所有可见图层
    const tmp = getCompositeCanvas()
    const sx = Math.round(x), sy = Math.round(y)
    const sw = Math.round(w), sh = Math.round(h)
    const cropC = document.createElement('canvas')
    const c = S.cropConstraint

    // 计算实际在原图范围内的源区域（裁剪框可超出原图边界，超出部分为透明）
    const srcX = Math.max(0, sx)
    const srcY = Math.max(0, sy)
    const srcRight = Math.min(S.imgW, sx + sw)
    const srcBottom = Math.min(S.imgH, sy + sh)
    const srcW = Math.max(0, srcRight - srcX)
    const srcH = Math.max(0, srcBottom - srcY)
    // 在裁剪画布中的偏移
    const dstX = srcX - sx
    const dstY = srcY - sy

    if (c.type === 'size' && c.sizeW > 0 && c.sizeH > 0) {
      // 尺寸约束：先画到 sw×sh 画布再缩放到目标尺寸
      cropC.width = c.sizeW
      cropC.height = c.sizeH
      const cctx = cropC.getContext('2d')
      const scaleX = c.sizeW / sw
      const scaleY = c.sizeH / sh
      if (srcW > 0 && srcH > 0) {
        cctx.drawImage(tmp, srcX, srcY, srcW, srcH,
          dstX * scaleX, dstY * scaleY, srcW * scaleX, srcH * scaleY)
      }
      S.imgW = c.sizeW
      S.imgH = c.sizeH
    } else {
      cropC.width = sw
      cropC.height = sh
      const cctx = cropC.getContext('2d')
      if (srcW > 0 && srcH > 0) {
        cctx.drawImage(tmp, srcX, srcY, srcW, srcH, dstX, dstY, srcW, srcH)
      }
      S.imgW = sw
      S.imgH = sh
    }
    // 文字/形状图层坐标随裁剪区域变换
    const isSize = c.type === 'size' && c.sizeW > 0 && c.sizeH > 0
    const scaleX = isSize ? c.sizeW / sw : 1
    const scaleY = isSize ? c.sizeH / sh : 1
    S.textLayers = S.textLayers.map(t => ({
      ...t,
      x: (t.x - sx) * scaleX,
      y: (t.y - sy) * scaleY,
      fontSize: t.fontSize * scaleX
    }))
    S.shapeLayers = S.shapeLayers.map(s => ({
       ...s,
       ...(s.type === 'pen' ? { pts: (s.pts || []).map(p => ({ x: (p.x - sx) * scaleX, y: (p.y - sy) * scaleY })) } : {
         x1: (s.x1 - sx) * scaleX, y1: (s.y1 - sy) * scaleY,
         x2: (s.x2 - sx) * scaleX, y2: (s.y2 - sy) * scaleY
       }),
       lw: Math.max(1, s.lw * (scaleX + scaleY) / 2)
     }))
    S.selectedTextId = null
    S.textDrag = null
    S.selectedShapeId = null
    S.shapeDrag = null
    S.zoom = 1
    setupCanvas(cropC)
    S.history = []
    S.redoStack = []
    S.cropRect = null
    S.cropMoving = false
    S.moveStart = null
    clearOverlay()
    updateCropInfo()
  }

  export function cancelCrop() {
    S.cropRect = null
    S.cropHandle = null
    S.cropMoving = false
    S.moveStart = null
    clearOverlay()
    updateCropInfo()
  }

  // ============ 裁剪栏 ============
  export function showCropBar() { runtime.el.querySelector('.iwb-editor-crop-bar').style.display = 'flex' }
  export function hideCropBar() { runtime.el.querySelector('.iwb-editor-crop-bar').style.display = 'none' }
