/* objects.js - 文字、形状、钢笔与选择手柄
 * 节：文字图层、形状图层、钢笔二次编辑、文字输入框。
 * 矢量对象统一走 S.textLayers / S.shapeLayers 与 S.zCounter 排序，
 * 渲染到 S.textCanvas（layers.js 负责它在图层栈里的位置）。
 */

'use strict'

import { S, runtime } from './state.js'
import { boxCorners, clamp, drawRotationHandles, hitRotationHandle, rotPt, unrotPt } from './viewport.js'
import { clearOverlay, drawCropPreview } from './crop.js'
import { drawBitmapSelection, drawVectorToCanvas, removeVecCanvas, renderLayerPanel, reorderLayerCanvas } from './layers.js'
import { drawPlacementPreview } from './placement.js'
import { drawShape } from './tools.js'
import { saveSnapshot, snapshotState } from './history.js'
import { updateLayerUI } from './events.js'
import { isDrawableLayer } from '../shared/layer-logic.js'


  // ============ 文字图层 ============

  export const TEXT_FONT = (size) => 'bold ' + size + 'px sans-serif'

  export function textBounds(t) {
    const ctx = S.textCtx
    ctx.font = TEXT_FONT(t.fontSize)
    const w = ctx.measureText(t.text).width
    const h = t.fontSize * 1.25
    return { x: t.x, y: t.y, w, h }
  }

  export function getSelectedText() {
    return S.textLayers.find(t => t.id === S.selectedTextId) || null
  }

  export function hitTextLayer(pos) {
    for (let i = S.textLayers.length - 1; i >= 0; i--) {
      const t = S.textLayers[i]
      if (t.visible === false) continue
      const b = textBounds(t)
      const rot = t.rotation || 0
      const lp = rot ? unrotPt(pos.x, pos.y, b.x + b.w / 2, b.y + b.h / 2, rot) : [pos.x, pos.y]
      if (lp[0] >= b.x - 2 && lp[0] <= b.x + b.w + 2 &&
          lp[1] >= b.y - 2 && lp[1] <= b.y + b.h + 2) {
        return t
      }
    }
    return null
  }

  function textHandlePoints(t) {
    const b = textBounds(t)
    const rot = t.rotation || 0
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2
    const local = { nw: [b.x, b.y], ne: [b.x + b.w, b.y], sw: [b.x, b.y + b.h], se: [b.x + b.w, b.y + b.h] }
    const out = {}
    for (const k in local) out[k] = rotPt(local[k][0], local[k][1], cx, cy, rot)
    return out
  }

  export function hitTextHandle(pos) {
    const t = getSelectedText()
    if (!t) return null
    const b = textBounds(t)
    const rot = t.rotation || 0
    const lp = rot ? unrotPt(pos.x, pos.y, b.x + b.w / 2, b.y + b.h / 2, rot) : [pos.x, pos.y]
    if (hitRotationHandle(lp, b)) return 'rotate'
    const local = { nw: [b.x, b.y], ne: [b.x + b.w, b.y], sw: [b.x, b.y + b.h], se: [b.x + b.w, b.y + b.h] }
    const R = 12 / S.zoom
    let best = null, bestDist = 1e9
    for (const name in local) {
      const dx = lp[0] - local[name][0], dy = lp[1] - local[name][1]
      const d = dx * dx + dy * dy
      if (d < R * R && d < bestDist) { bestDist = d; best = name }
    }
    return best
  }

  // ============ 形状图层 ============

  export function shapeBounds(s) {
    if (s.type === 'pen' && s.pts && s.pts.length) { const xs = s.pts.map(p => p.x), ys = s.pts.map(p => p.y), x = Math.min(...xs), y = Math.min(...ys); return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y } }
    return { x: Math.min(s.x1, s.x2), y: Math.min(s.y1, s.y2), w: Math.abs(s.x2 - s.x1), h: Math.abs(s.y2 - s.y1) }
  }

  export function getSelectedShape() {
    return S.shapeLayers.find(s => s.id === S.selectedShapeId) || null
  }

  function distToSeg(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1
    const l2 = dx * dx + dy * dy
    let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0
    t = clamp(t, 0, 1)
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
  }

  function hitShapeObj(pos, s, includeInterior) {
    if (s.visible === false) return false
    if (s.rotation) {
      const b = shapeBounds(s)
      const lp = unrotPt(pos.x, pos.y, b.x + b.w / 2, b.y + b.h / 2, s.rotation)
      pos = { x: lp[0], y: lp[1] }
    }
    if (s.type === 'pen') { const pts = s.pts || []; for (let i = 1; i < pts.length; i++) if (distToSeg(pos.x, pos.y, pts[i-1].x, pts[i-1].y, pts[i].x, pts[i].y) <= Math.max(8 / S.zoom, s.lw)) return true; if (s.closed && pts.length > 2 && distToSeg(pos.x, pos.y, pts[pts.length-1].x, pts[pts.length-1].y, pts[0].x, pts[0].y) <= Math.max(8 / S.zoom, s.lw)) return true; if (!includeInterior) return false; const b = shapeBounds(s); return pos.x >= b.x && pos.x <= b.x + b.w && pos.y >= b.y && pos.y <= b.y + b.h }
    if (s.type === 'circle') {
      const b = shapeBounds(s)
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2
      const rx = Math.max(0.5, b.w / 2), ry = Math.max(0.5, b.h / 2)
      const nx = (pos.x - cx) / rx, ny = (pos.y - cy) / ry
      const value = nx * nx + ny * ny
      if (includeInterior || s.fill) return value <= 1
      const edgeTolerance = Math.max(4 / S.zoom, s.lw / Math.min(rx, ry))
      const outer = (1 + edgeTolerance) * (1 + edgeTolerance)
      const inner = Math.max(0, 1 - edgeTolerance) * Math.max(0, 1 - edgeTolerance)
      return value >= inner && value <= outer
    }
    if (s.type === 'rect') {
      const b = shapeBounds(s)
      const pad = Math.max(4, s.lw * 1.5)
      const inOuter = pos.x >= b.x - pad && pos.x <= b.x + b.w + pad &&
                      pos.y >= b.y - pad && pos.y <= b.y + b.h + pad
      if (!inOuter) return false
      if (includeInterior || s.fill) return true
      const inInner = pos.x >= b.x + pad && pos.x <= b.x + b.w - pad &&
                      pos.y >= b.y + pad && pos.y <= b.y + b.h - pad
      return !inInner
    }
    return distToSeg(pos.x, pos.y, s.x1, s.y1, s.x2, s.y2) <= Math.max(8 / S.zoom, s.lw)
  }

  export function hitShapeLayer(pos, includeInterior) {
    for (let i = S.shapeLayers.length - 1; i >= 0; i--) {
      if (hitShapeObj(pos, S.shapeLayers[i], includeInterior)) return S.shapeLayers[i]
    }
    return null
  }

  /** 所有对象（文字 + 形状）按 z 升序排列 */
  export function allObjects() {
    const arr = S.textLayers.map(o => ({ kind: 'text', obj: o }))
      .concat(S.shapeLayers.map(o => ({ kind: 'shape', obj: o })))
    arr.sort((a, b) => (a.obj.z || 0) - (b.obj.z || 0))
    return arr
  }

  export function sortLayersByZ() {
    const cmp = (a, b) => (a.z || 0) - (b.z || 0)
    S.textLayers.sort(cmp)
    S.shapeLayers.sort(cmp)
  }

  export function hitAnyObject(pos) {
    const list = allObjects()
    for (let i = list.length - 1; i >= 0; i--) {
      const { kind, obj } = list[i]
      if (obj.visible === false) continue
      if (kind === 'text') {
        const b = textBounds(obj)
        const rot = obj.rotation || 0
        const lp = rot ? unrotPt(pos.x, pos.y, b.x + b.w / 2, b.y + b.h / 2, rot) : [pos.x, pos.y]
        if (lp[0] >= b.x - 2 && lp[0] <= b.x + b.w + 2 &&
            lp[1] >= b.y - 2 && lp[1] <= b.y + b.h + 2) {
          return { kind, obj }
        }
      } else if (hitShapeObj(pos, obj, true)) {
        return { kind, obj }
      }
    }
    return null
  }

  function getSelectedObject() {
    const t = getSelectedText()
    if (t) return { kind: 'text', obj: t }
    const s = getSelectedShape()
    if (s) return { kind: 'shape', obj: s }
    return null
  }

  /** 图层顺序调整 */
  export function moveLayer(dir) {
    let sel = getSelectedObject()
    if (sel) { if (sel.obj.locked) return } else {
      const layer = S.layers.find(l => l.id === S.selectedLayerId && l.id !== 'base' && !l.locked)
      if (layer) sel = { kind: 'bitmap', obj: layer }
    }
    if (!sel) return
    if (sel.obj.locked) return
    const all = [...S.layers.map(o => ({ kind: 'bitmap', obj: o })), ...allObjects()].sort((a, b) => (a.obj.z || 0) - (b.obj.z || 0))
    const idx = all.findIndex(o => o.obj === sel.obj)
    if (idx < 0) return
    if ((dir === 'up' || dir === 'top') && idx === all.length - 1) return
    if ((dir === 'down' || dir === 'bottom') && idx === 0) return
    saveSnapshot()
    if (dir === 'up') {
      const t = all[idx + 1].obj
      const tz = t.z
      t.z = sel.obj.z
      sel.obj.z = tz
    } else if (dir === 'down') {
      const t = all[idx - 1].obj
      const tz = t.z
      t.z = sel.obj.z
      sel.obj.z = tz
    } else if (dir === 'top') {
      sel.obj.z = all[all.length - 1].obj.z + 1
    } else {
      sel.obj.z = all[0].obj.z - 1
    }
    sortLayersByZ()
    reorderLayerCanvas()
    renderObjects()
    renderLayerPanel()
  }

  function shapeHandlePoints(s) {
    const b = shapeBounds(s)
    if (s.type === 'pen') {
      return Object.fromEntries((s.pts || []).map((p, i) => ['p' + i, [p.x, p.y]]))
    }
    if (s.type === 'arrow') {
      return { start: [s.x1, s.y1], end: [s.x2, s.y2] }
    }
    return {
      nw: [b.x, b.y], ne: [b.x + b.w, b.y],
      sw: [b.x, b.y + b.h], se: [b.x + b.w, b.y + b.h],
      n: [b.x + b.w / 2, b.y], s: [b.x + b.w / 2, b.y + b.h],
      e: [b.x + b.w, b.y + b.h / 2], w: [b.x, b.y + b.h / 2]
    }
  }

  /** 形状控制点的世界坐标（应用旋转后） */
  function shapeHandleWorld(s) {
    const b = shapeBounds(s)
    const rot = s.rotation || 0
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2
    const local = shapeHandlePoints(s)
    const out = {}
    for (const k in local) out[k] = rotPt(local[k][0], local[k][1], cx, cy, rot)
    return out
  }

  export function hitShapeHandle(pos) {
    const s = getSelectedShape()
    if (!s) return null
    const b = shapeBounds(s)
    const rot = s.rotation || 0
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2
    const lp = rot ? unrotPt(pos.x, pos.y, cx, cy, rot) : [pos.x, pos.y]
    if (hitRotationHandle(lp, b)) return 'rotate'
    const pts = shapeHandlePoints(s)
    const offset = 8 / S.zoom
    const R = Math.max(18 / S.zoom, 11)
    let best = null, bestDist = 1e9
    for (const name in pts) {
      const px = pts[name][0] + (name.includes('w') ? -offset : name.includes('e') ? offset : 0)
      const py = pts[name][1] + (name.includes('n') ? -offset : name.includes('s') ? offset : 0)
      const dx = lp[0] - px, dy = lp[1] - py
      const d = dx * dx + dy * dy
      if (d < R * R && d < bestDist) { bestDist = d; best = name }
    }
    return best
  }

  export function applyShapeHandle(s, handle, pos) {
    const b0 = shapeBounds(s)
    const rot0 = s.rotation || 0
    const c0x = b0.x + b0.w / 2, c0y = b0.y + b0.h / 2
    if (handle === 'rotate') {
      const st = S.shapeDrag && S.shapeDrag.start
      const baseRot = (S.shapeDrag && S.shapeDrag.shape && (S.shapeDrag.shape.rotation || 0)) || 0
      if (st) {
        const a0 = Math.atan2(st.y - c0y, st.x - c0x)
        const a1 = Math.atan2(pos.y - c0y, pos.x - c0x)
        let deg = baseRot + (a1 - a0) * 180 / Math.PI
        if (S._shiftDown) deg = Math.round(deg / 15) * 15
        s.rotation = deg
      }
      return
    }
    const lp = rot0 ? unrotPt(pos.x, pos.y, c0x, c0y, rot0) : [pos.x, pos.y]
    pos = { x: lp[0], y: lp[1] }
    if (s.type === 'pen' && handle && handle[0] === 'p') {
      const i = parseInt(handle.slice(1), 10)
      if (s.pts && s.pts[i]) { s.pts[i].x = clamp(pos.x, 0, S.imgW); s.pts[i].y = clamp(pos.y, 0, S.imgH) }
      return
    }
    if (s.type === 'arrow') {
      if (handle === 'start') { s.x1 = clamp(pos.x, 0, S.imgW); s.y1 = clamp(pos.y, 0, S.imgH) }
      else { s.x2 = clamp(pos.x, 0, S.imgW); s.y2 = clamp(pos.y, 0, S.imgH) }
      return
    }
    const b = shapeBounds(s)
    const offset = 8 / S.zoom
    const adjusted = { x: pos.x - (handle.includes('w') ? -offset : handle.includes('e') ? offset : 0), y: pos.y - (handle.includes('n') ? -offset : handle.includes('s') ? offset : 0) }
    let x1 = b.x, y1 = b.y, x2 = b.x + b.w, y2 = b.y + b.h
    if (handle.includes('e')) x2 = Math.max(x1 + 2, adjusted.x)
    if (handle.includes('s')) y2 = Math.max(y1 + 2, adjusted.y)
    if (handle.includes('w')) x1 = Math.min(x2 - 2, adjusted.x)
    if (handle.includes('n')) y1 = Math.min(y2 - 2, adjusted.y)
    s.x1 = x1; s.y1 = y1; s.x2 = x2; s.y2 = y2
  }

  function drawPenPathPreview() {
    const path = S.penPath
    if (!path || !path.pts || !path.pts.length) return
    const ctx = S.overlayCtx
    const pts = path.pts.slice()
    const first = pts[0]
    const nearStart = path.preview && pts.length >= 3 && Math.hypot(path.preview.x - first.x, path.preview.y - first.y) <= Math.max(12 / S.zoom, S.brushSize * 1.5)
    if (path.preview) pts.push(nearStart ? first : path.preview)
    ctx.save()
    ctx.strokeStyle = S.color
    ctx.fillStyle = nearStart ? 'rgba(232, 167, 53, 0.18)' : 'transparent'
    ctx.lineWidth = Math.max(2, S.brushSize) / S.zoom
    ctx.setLineDash([8 / S.zoom, 5 / S.zoom])
    ctx.beginPath()
    ctx.moveTo(pts[0].x, pts[0].y)
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
    if (nearStart) { ctx.closePath(); ctx.fill() }
    ctx.stroke()
    ctx.setLineDash([])
    for (let i = 0; i < path.pts.length; i++) {
      const point = path.pts[i]
      ctx.beginPath()
      ctx.fillStyle = i === 0 && nearStart ? '#e8a735' : '#ffffff'
      ctx.strokeStyle = S.color
      ctx.arc(point.x, point.y, Math.max(4, 6 / S.zoom), 0, Math.PI * 2)
      ctx.fill(); ctx.stroke()
    }
    ctx.restore()
  }

  function drawShapeSelection(s) {
    const octx = S.overlayCtx
    const b = shapeBounds(s)
    const rot = s.rotation || 0
    octx.save()
    octx.strokeStyle = '#e8a735'
    octx.lineWidth = 1.5 / S.zoom
    octx.setLineDash([6 / S.zoom, 3 / S.zoom])
    const corners = boxCorners(b.x, b.y, b.w, b.h, rot)
    octx.beginPath()
    octx.moveTo(corners[0][0], corners[0][1])
    for (let i = 1; i < corners.length; i++) octx.lineTo(corners[i][0], corners[i][1])
    octx.closePath()
    octx.stroke()
    octx.setLineDash([])
    const hs = 8.5 / S.zoom
    octx.fillStyle = '#ffffff'
    octx.strokeStyle = '#e8a735'
    const pts = shapeHandleWorld(s)
    for (const name in pts) {
      octx.beginPath()
      octx.rect(pts[name][0] - hs, pts[name][1] - hs, hs * 2, hs * 2)
      octx.fill()
      octx.stroke()
    }
    octx.restore()
    drawRotationHandles(octx, b, rot)
  }

  export function deleteSelectedShape() {
    if (!S.selectedShapeId) return
    const selected = getSelectedShape()
    if (selected && selected.locked) return
    saveSnapshot()
    removeVecCanvas(selected)
    S.shapeLayers = S.shapeLayers.filter(s => s.id !== S.selectedShapeId)
    S.selectedShapeId = null
    renderObjects()
  }

  /** 重绘对象层 + 选中态 */
  export function renderObjects(tempShape) {
    for (const { kind, obj } of allObjects()) drawVectorToCanvas(kind, obj)
    reorderLayerCanvas()
    clearOverlay()
    if (tempShape) drawShape(S.overlayCtx, tempShape)
    if (S.tool === 'pen' && S.penPath && S.penPath.pts.length) drawPenPathPreview()
    // 图片放置模式优先显示放置预览
    if (S.placingImage) {
      drawPlacementPreview()
      return
    }
    const bitmapSelection = S.layers.find(l => l.id === S.selectedLayerId && (l.transformable || isDrawableLayer(l)))
     if (bitmapSelection) drawBitmapSelection(bitmapSelection)
     const sel = getSelectedText()
    if (sel) {
      const b = textBounds(sel)
      const rot = sel.rotation || 0
      const octx = S.overlayCtx
      octx.save()
      octx.strokeStyle = '#e8a735'
      octx.lineWidth = 1.5 / S.zoom
      octx.setLineDash([6 / S.zoom, 3 / S.zoom])
      const corners = boxCorners(b.x - 2 / S.zoom, b.y - 2 / S.zoom, b.w + 4 / S.zoom, b.h + 4 / S.zoom, rot)
      octx.beginPath()
      octx.moveTo(corners[0][0], corners[0][1])
      for (let i = 1; i < corners.length; i++) octx.lineTo(corners[i][0], corners[i][1])
      octx.closePath()
      octx.stroke()
      octx.setLineDash([])
      const hs = 7 / S.zoom
      octx.fillStyle = '#ffffff'
      octx.strokeStyle = '#e8a735'
      const pts = textHandlePoints(sel)
      for (const name in pts) {
        octx.beginPath()
        octx.rect(pts[name][0] - hs, pts[name][1] - hs, hs * 2, hs * 2)
        octx.fill()
        octx.stroke()
      }
      octx.restore()
    } else {
      const sh = getSelectedShape()
      if (sh) drawShapeSelection(sh)
    }
    const penShape = getPenEditingShape()
    if (penShape) drawPenEditOverlay(penShape)
    if (S.cropRect) drawCropPreview()
    updateLayerUI()
  }

  // ============ 钢笔二次编辑（移动/添加/删除节点） ============
  export function getPenEditingShape() {
    if (!S.penEditId) return null
    return S.shapeLayers.find(sh => sh.id === S.penEditId && sh.type === 'pen') || null
  }
  export function beginPenEdit(shape) {
    S.penEditId = shape.id
    S.selectedShapeId = shape.id
    S.selectedTextId = null
    S.selectedLayerId = null
    S.shapeDrag = null
    S.penDragPt = -1
    S.penDragBase = null
    S.penDragPending = null
    renderObjects()
    renderLayerPanel()
  }
  export function exitPenEdit() {
    S.penEditId = null
    S.penDragPt = -1
    S.penDragBase = null
    S.penDragPending = null
    renderObjects()
    renderLayerPanel()
  }
  export function hitPenPoint(pos, shape, r) {
    const pts = shape.pts || []
    const b = shapeBounds(shape)
    const lp = shape.rotation ? unrotPt(pos.x, pos.y, b.x + b.w / 2, b.y + b.h / 2, shape.rotation) : [pos.x, pos.y]
    for (let i = 0; i < pts.length; i++) {
      if (Math.hypot(lp[0] - pts[i].x, lp[1] - pts[i].y) <= r) return i
    }
    return -1
  }

  export function hitPenEdgeInsert(pos, shape) {
    const pts = shape.pts || []
    const b = shapeBounds(shape)
    const lp = shape.rotation ? unrotPt(pos.x, pos.y, b.x + b.w / 2, b.y + b.h / 2, shape.rotation) : [pos.x, pos.y]
    const r = Math.max(12 / S.zoom, 6)
    for (let i = 0; i < pts.length - 1; i++) {
      if (distToSeg(lp[0], lp[1], pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y) <= r) return i
    }
    if (shape.closed && pts.length >= 3) {
      if (distToSeg(lp[0], lp[1], pts[pts.length - 1].x, pts[pts.length - 1].y, pts[0].x, pts[0].y) <= r) return pts.length - 1
    }
    return -1
  }

  function drawPenEditOverlay(shape) {
    const ctx = S.overlayCtx
    const pts = shape.pts || []
    const b = shapeBounds(shape)
    const rot = shape.rotation || 0
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2
    const W = (p) => rotPt(p.x, p.y, cx, cy, rot)
    const R = Math.max(7 / S.zoom, 5)
    ctx.save()
    ctx.lineWidth = 1.5 / S.zoom
    const segments = []
    for (let i = 0; i < pts.length - 1; i++) segments.push([pts[i], pts[i + 1]])
    if (shape.closed && pts.length >= 3) segments.push([pts[pts.length - 1], pts[0]])
    ctx.strokeStyle = '#e8a735'
    for (const [a, bb] of segments) {
      const wa = W(a), wb = W(bb)
      const mx = (wa[0] + wb[0]) / 2, my = (wa[1] + wb[1]) / 2
      ctx.beginPath()
      ctx.arc(mx, my, Math.max(3 / S.zoom, 2), 0, Math.PI * 2)
      ctx.stroke()
    }
    for (let i = 0; i < pts.length; i++) {
      const wp = W(pts[i])
      ctx.beginPath()
      ctx.rect(wp[0] - R / 2, wp[1] - R / 2, R, R)
      ctx.fillStyle = '#ffffff'
      ctx.strokeStyle = i === S.penDragPt ? '#ff8c00' : '#e8a735'
      ctx.fill()
      ctx.stroke()
    }
    ctx.restore()
  }

  // ============ 文字输入框 ============
  export function showTextInput(x, y, layer) {
    const input = runtime.el.querySelector('.iwb-editor-text-input')
    const rect = S.canvasStack.getBoundingClientRect()
    const wrapRect = S.canvasWrap.getBoundingClientRect()
    const sx = rect.width / S.imgW
    const sy = rect.height / S.imgH
    input.style.left = (rect.left - wrapRect.left + x * sx) + 'px'
    input.style.top = (rect.top - wrapRect.top + y * sy) + 'px'
    input.style.display = 'block'
    if (layer) {
      input.value = layer.text
      S.textEditingId = layer.id
    } else {
      input.value = ''
      S.textEditingId = null
    }
    input.focus()
    input.select()
    input.dataset.x = x
    input.dataset.y = y
  }

  export function hideTextInput() {
    const input = runtime.el.querySelector('.iwb-editor-text-input')
    if (input) {
      input.style.display = 'none'
      input.value = ''
    }
    S.textEditingId = null
  }

  export function commitTextInput() {
    const input = runtime.el.querySelector('.iwb-editor-text-input')
    if (!input || input.style.display === 'none') return false
    const text = input.value.trim()
    const x = parseFloat(input.dataset.x)
    const y = parseFloat(input.dataset.y)
    let committed = false

    if (S.textEditingId) {
      const t = S.textLayers.find(l => l.id === S.textEditingId)
      if (t && t.locked) { hideTextInput(); return true }
      if (t && text !== t.text) {
        saveSnapshot()
        if (text) {
          t.text = text
        } else {
          removeVecCanvas(t)
          S.textLayers = S.textLayers.filter(l => l.id !== t.id)
          S.selectedTextId = null
        }
        renderObjects()
      }
      committed = true
    } else if (text) {
      saveSnapshot()
      const layer = {
        id: 't' + Date.now() + Math.floor(Math.random() * 1000),
        x, y, text,
        color: S.color,
        fontSize: Math.max(16, S.brushSize * 6),
        opacity: 1,
        visible: true,
       locked: false,
        z: ++S.zCounter
      }
      S.textLayers.push(layer)
      S.selectedTextId = layer.id
      renderObjects()
      committed = true
    }
    hideTextInput()
    return committed
  }

  export function deleteSelectedText() {
    if (!S.selectedTextId) return
    const selected = getSelectedText()
    if (selected && selected.locked) return
    saveSnapshot()
    removeVecCanvas(selected)
    S.textLayers = S.textLayers.filter(t => t.id !== S.selectedTextId)
    S.selectedTextId = null
    renderObjects()
  }

  export function beginTextRotate(pos) {
    const t = getSelectedText()
    if (!t || t.locked) return
    const b = textBounds(t)
    S.textDrag = {
      mode: 'rotate',
      rotation: t.rotation || 0,
      cx: b.x + b.w / 2,
      cy: b.y + b.h / 2,
      startX0: pos.x,
      startY0: pos.y,
      pending: snapshotState()
    }
  }

  export function beginTextScaleDrag(handle, pos) {
    const t = getSelectedText()
    if (!t || t.locked) return
    const b = textBounds(t)
    const rot = t.rotation || 0
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2
    const anchors = {
      se: [b.x, b.y],
      ne: [b.x, b.y + b.h],
      sw: [b.x + b.w, b.y],
      nw: [b.x + b.w, b.y + b.h]
    }
    const a = rotPt(anchors[handle][0], anchors[handle][1], cx, cy, rot)
    const anchor = { x: a[0], y: a[1] }
    const dx = pos.x - anchor.x, dy = pos.y - anchor.y
    S.textDrag = {
      mode: 'scale',
      anchor,
      d0: Math.sqrt(dx * dx + dy * dy),
      fontSize: t.fontSize,
      pending: snapshotState()
    }
  }

  export function beginShapeHandleDrag(handle, pos) {
    const sh = getSelectedShape()
    if (!sh || sh.locked) return
    S.shapeDrag = {
      mode: 'handle', handle,
      start: pos,
      shape: { ...sh },
      pending: snapshotState()
    }
  }
