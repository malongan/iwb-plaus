/* layers.js - 位图图层管理、矢量对象画布与图层面板
 * 节：图层管理、矢量对象独立画布（位图/矢量统一排序）、图层面板 UI，
 * 外加原属「图片放置」节末尾的 deleteLayer。
 * 约定：位图图层一个 canvas，矢量对象（文字/形状）各自独立 canvas，
 * reorderLayerCanvas 按 z 统一排序插入 S.canvasStack。
 */

'use strict'

import { S, runtime } from './state.js'
import { TEXT_FONT, allObjects, deleteSelectedShape, deleteSelectedText, renderObjects, sortLayersByZ, textBounds } from './objects.js'
import { boxCorners, clamp, drawRotationHandles, hitRotationHandle, rotPt, unrotPt } from './viewport.js'
import { drawShape } from './tools.js'
import { saveSnapshot, snapshotState } from './history.js'
import { startImagePlacement } from './placement.js'
import { updateBrushParamUI, updateColorUI } from './events.js'
import { isDrawableLayer } from '../shared/layer-logic.js'


  // ============ 图层管理 ============

  /** 创建位图图层 canvas 元素并插入 DOM 栈 */
  export function createLayerCanvas() {
    const c = document.createElement('canvas')
    c.className = 'iwb-editor-layer-canvas'
    c.width = S.imgW
    c.height = S.imgH
    c.style.position = 'absolute'
    c.style.top = '0'
    c.style.left = '0'
    c.style.display = 'block'
    // 插入到 strokeCanvas 之前（位图图层在矢量层之下）
    S.canvasStack.insertBefore(c, S.strokeCanvas)
    return c
  }

  /** 按图层 z 序重排 DOM 中的 canvas 元素。
   * 所有 canvas 必须共享 canvas-stack 的坐标系；隐藏图层只用 CSS 隐藏，
   * 不从 DOM 移除，避免 canvas-stack 在 flex/inline 布局下重新计算位置。 */
  export function reorderLayerCanvas() {
    const units = []
    for (const l of S.layers) units.push({ z: l.z, el: l.canvas, vis: l.visible })
    for (const { obj } of allObjects()) if (obj._canvas) units.push({ z: obj.z || 0, el: obj._canvas, vis: obj.visible !== false })
    units.sort((a, b) => a.z - b.z)
    for (const u of units) {
      if (!u.el) continue
      S.canvasStack.insertBefore(u.el, S.strokeCanvas)
      u.el.style.display = u.vis ? 'block' : 'none'
    }
  }

  /** 获取活跃位图图层 */
  export function getActiveLayer() {
    return S.layers.find(l => l.id === S.activeLayerId) || null
  }

  /** 获取活跃位图图层的 2d context（画笔/橡皮操作目标） */
  export function getActiveCtx() {
    const layer = getActiveLayer()
    return layer && !layer.locked ? layer.ctx : null
  }

  /** 清理所有画布/图层选择态，保证不同工具和图层之间互斥 */
  export function clearSelection({ keepBitmap = false } = {}) {
    if (!keepBitmap) S.selectedLayerId = null
    S.selectedTextId = null
    S.selectedShapeId = null
    S.textDrag = null
    S.shapeDrag = null
    S.bitmapDrag = null
  }

  /** 设置活跃图层 */
  export function redrawBitmapLayer(layer) {
     if (!layer || !layer.ctx) return
     layer.ctx.clearRect(0, 0, S.imgW, S.imgH)
     const rot = layer.rotation || 0
     const cx = layer.x + layer.w / 2, cy = layer.y + layer.h / 2
     layer.ctx.save()
     if (rot) {
       layer.ctx.translate(cx, cy)
       layer.ctx.rotate(rot * Math.PI / 180)
       layer.ctx.translate(-cx, -cy)
     }
     if (layer._srcBox && layer.sourceCanvas) {
       const b = layer._srcBox
       layer.ctx.drawImage(layer.sourceCanvas, b.x, b.y, b.w, b.h, layer.x, layer.y, layer.w, layer.h)
     } else if (layer.image && layer.w > 0 && layer.h > 0) {
       layer.ctx.drawImage(layer.image, layer.x, layer.y, layer.w, layer.h)
     } else if (layer.sourceCanvas && layer.w > 0 && layer.h > 0) {
       layer.ctx.drawImage(layer.sourceCanvas, layer.x, layer.y, layer.w, layer.h)
     }
     layer.ctx.restore()
   }

   function bitmapHandlePoints(layer) {
     const rot = layer.rotation || 0
     const cx = layer.x + layer.w / 2, cy = layer.y + layer.h / 2
     const local = {
       nw: [layer.x, layer.y], ne: [layer.x + layer.w, layer.y],
       sw: [layer.x, layer.y + layer.h], se: [layer.x + layer.w, layer.y + layer.h],
       n: [layer.x + layer.w / 2, layer.y], s: [layer.x + layer.w / 2, layer.y + layer.h],
       e: [layer.x + layer.w, layer.y + layer.h / 2], w: [layer.x, layer.y + layer.h / 2]
     }
     const out = {}
     for (const k in local) out[k] = rotPt(local[k][0], local[k][1], cx, cy, rot)
     return out
   }

   export function hitBitmapHandle(pos) {
     const layer = S.layers.find(l => l.id === S.selectedLayerId && (l.transformable || isDrawableLayer(l)))
     if (!layer || layer.visible === false) return null
     const drawable = isDrawableLayer(layer)
     const box = layerFrame(layer)
     if (!(box.w > 0 && box.h > 0)) return null
     const rot = layer.rotation || 0
     const cx = box.x + box.w / 2, cy = box.y + box.h / 2
     const lp = unrotPt(pos.x, pos.y, cx, cy, rot)
     const R = 14 / S.zoom
     if (hitRotationHandle(lp, box)) return 'rotate'
     const points = {
       nw: [box.x, box.y], ne: [box.x + box.w, box.y],
       sw: [box.x, box.y + box.h], se: [box.x + box.w, box.y + box.h],
       n: [box.x + box.w / 2, box.y], s: [box.x + box.w / 2, box.y + box.h],
       e: [box.x + box.w, box.y + box.h / 2], w: [box.x, box.y + box.h / 2]
     }
     let hit = null, best = Infinity
     for (const name in points) {
       const distance = Math.hypot(lp[0] - points[name][0], lp[1] - points[name][1])
       if (distance < R && distance < best) { best = distance; hit = name }
     }
     return hit
   }

   // isDrawableLayer / restorePath / needsPixelSnapshot 统一由 shared/layer-logic.js 提供
   // （快照端与恢复端必须共用同一判定，可单测守护）
   /** 内容包围盒（非透明像素范围），带缓存；step=2 降低扫描开销 */
   function layerBounds(layer) {
     if (!layer || !layer.ctx || !layer.canvas) return null
     if (layer._bounds !== undefined) return layer._bounds
     let b = null
     try {
       const w = layer.canvas.width, h = layer.canvas.height
       const data = layer.ctx.getImageData(0, 0, w, h).data
       let minX = w, minY = h, maxX = -1, maxY = -1
       for (let y = 0; y < h; y += 2) {
         for (let x = 0; x < w; x += 2) {
           if (data[(y * w + x) * 4 + 3] > 8) {
             if (x < minX) minX = x
             if (x > maxX) maxX = x
             if (y < minY) minY = y
             if (y > maxY) maxY = y
           }
         }
       }
       if (maxX >= 0) b = { x: minX, y: minY, w: maxX - minX + 2, h: maxY - minY + 2 }
     } catch (e) { b = null }
     layer._bounds = b
     return b
   }
   /** 控制框使用的范围：绘制类图层用内容盒，其余用图层矩形 */
   function layerFrame(layer) {
     if (isDrawableLayer(layer) && !layer._srcBox) {
       const b = layerBounds(layer)
       if (b) return b
     }
     return { x: layer.x, y: layer.y, w: layer.w, h: layer.h }
   }

   export function hitBitmapLayer(pos) {
     const layers = [...S.layers].sort((a, b) => (a.z || 0) - (b.z || 0))
     const hitRect = (layer) => {
       if (!(layer.w > 0 && layer.h > 0)) return false
       const rot = layer.rotation || 0
       const lp = rot ? unrotPt(pos.x, pos.y, layer.x + layer.w / 2, layer.y + layer.h / 2, rot) : [pos.x, pos.y]
       return lp[0] >= layer.x && lp[0] <= layer.x + layer.w && lp[1] >= layer.y && lp[1] <= layer.y + layer.h
     }
     const usable = (layer) => layer && layer.visible !== false && !layer.locked
     // 第一轮：绘制类图层按像素命中（点内容才算，避免被上层图片层拦截）
     for (let i = layers.length - 1; i >= 0; i--) {
       const layer = layers[i]
       if (!usable(layer)) continue
       if (!isDrawableLayer(layer)) continue
       if (!hitRect(layer)) continue
       const rot = layer.rotation || 0
       const lp = rot ? unrotPt(pos.x, pos.y, layer.x + layer.w / 2, layer.y + layer.h / 2, rot) : [pos.x, pos.y]
       const px = Math.round(lp[0]), py = Math.round(lp[1])
       if (px < 0 || py < 0 || px >= layer.canvas.width || py >= layer.canvas.height) continue
       try {
         const d = layer.ctx.getImageData(px, py, 1, 1).data
         if (d[3] > 8) return layer
       } catch (e) { return layer }
     }
     // 第二轮：图片类图层按矩形命中
     for (let i = layers.length - 1; i >= 0; i--) {
       const layer = layers[i]
       if (!usable(layer) || !layer.transformable) continue
       if (hitRect(layer)) return layer
     }
     return null
   }

   export function drawBitmapSelection(layer) {
     if (!layer) return
     const drawable = isDrawableLayer(layer)
     if (!layer.transformable && !drawable) return
     const box = layerFrame(layer)
     if (!(box.w > 0 && box.h > 0)) return
     const ctx = S.overlayCtx
     const rot = layer.rotation || 0
     const hs = 7 / S.zoom
     ctx.save()
     ctx.strokeStyle = '#e8a735'
     ctx.lineWidth = 1.5 / S.zoom
     ctx.setLineDash([6 / S.zoom, 3 / S.zoom])
     const corners = boxCorners(box.x, box.y, box.w, box.h, rot)
     ctx.beginPath()
     ctx.moveTo(corners[0][0], corners[0][1])
     for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i][0], corners[i][1])
     ctx.closePath()
     ctx.stroke()
     ctx.setLineDash([])
     ctx.fillStyle = '#fff'
     ctx.strokeStyle = '#e8a735'
     const pts = frameHandlePoints(box, rot)
     for (const name in pts) {
       ctx.beginPath()
       ctx.rect(pts[name][0] - hs, pts[name][1] - hs, hs * 2, hs * 2)
       ctx.fill(); ctx.stroke()
     }
     ctx.restore()
     drawRotationHandles(ctx, box, rot)
   }

   /** 任意矩形的 8 个控制点（含旋转）*/
   function frameHandlePoints(box, rot) {
     const cx = box.x + box.w / 2, cy = box.y + box.h / 2
     const local = {
       nw: [box.x, box.y], ne: [box.x + box.w, box.y],
       sw: [box.x, box.y + box.h], se: [box.x + box.w, box.y + box.h],
       n: [box.x + box.w / 2, box.y], s: [box.x + box.w / 2, box.y + box.h],
       e: [box.x + box.w, box.y + box.h / 2], w: [box.x, box.y + box.h / 2]
     }
     const out = {}
     for (const k in local) out[k] = rotPt(local[k][0], local[k][1], cx, cy, rot || 0)
     return out
   }

   export function beginBitmapDrag(handle, pos) {
     const layer = S.layers.find(l => l.id === S.selectedLayerId)
     if (!layer || layer.locked) return
     const drawable = isDrawableLayer(layer)
     if (!layer.transformable && !drawable) return
     if (drawable) {
       if (!layer.sourceCanvas) {
         const sc = document.createElement('canvas')
         sc.width = S.imgW; sc.height = S.imgH
         sc.getContext('2d').drawImage(layer.canvas, 0, 0)
         layer.sourceCanvas = sc
       }
       // 首次变换：记录内容盒作为源，并把图层矩形设为目标框
       if (!layer._srcBox) {
         const b = layerBounds(layer) || { x: layer.x, y: layer.y, w: layer.w, h: layer.h }
         layer._srcBox = { x: b.x, y: b.y, w: b.w, h: b.h }
         layer.x = b.x; layer.y = b.y; layer.w = b.w; layer.h = b.h
         layer.rotation = layer.rotation || 0
       }
     }
      const frame = layerFrame(layer)
      S.bitmapDrag = {
       mode: handle === 'rotate' ? 'rotate' : (handle ? 'scale' : 'move'), handle, start: pos,
       drawable: isDrawableLayer(layer),
       layer: { x: layer.x, y: layer.y, w: layer.w, h: layer.h, rotation: layer.rotation || 0 },
       frame: { x: frame.x, y: frame.y, w: frame.w, h: frame.h },
       pending: snapshotState()
     }
   }

   export function applyBitmapDrag(pos) {
     const drag = S.bitmapDrag
     const layer = S.layers.find(l => l.id === S.selectedLayerId)
     if (!drag || !layer) return
     const base = drag.layer
     if (drag.mode === 'move') {
       layer.x = base.x + pos.x - drag.start.x
       layer.y = base.y + pos.y - drag.start.y
       if (isDrawableLayer(layer)) layer._bounds = undefined
     } else if (drag.mode === 'rotate') {
       const rcx = base.x + base.w / 2, rcy = base.y + base.h / 2
       const a0 = Math.atan2(drag.start.y - rcy, drag.start.x - rcx)
       const a1 = Math.atan2(pos.y - rcy, pos.x - rcx)
       let deg = (base.rotation || 0) + (a1 - a0) * 180 / Math.PI
       if (S._shiftDown) deg = Math.round(deg / 15) * 15
       layer.rotation = deg
     } else {
       const lpos = unrotPt(pos.x, pos.y, base.x + base.w / 2, base.y + base.h / 2, base.rotation || 0)
       let x = base.x, y = base.y, w = base.w, h = base.h
       const min = 4
       if (drag.handle.includes('e')) w = Math.max(min, lpos[0] - base.x)
       if (drag.handle.includes('s')) h = Math.max(min, lpos[1] - base.y)
       if (drag.handle.includes('w')) { x = Math.min(lpos[0], base.x + base.w - min); w = base.x + base.w - x }
       if (drag.handle.includes('n')) { y = Math.min(lpos[1], base.y + base.h - min); h = base.y + base.h - y }
       if (S._shiftDown && layer.image) {
         const iw = layer.image.naturalWidth || layer.image.width
         const ih = layer.image.naturalHeight || layer.image.height
         const aspect = iw / Math.max(1, ih)
         if (w / h > aspect) h = w / aspect; else w = h * aspect
         if (drag.handle.includes('w')) x = base.x + base.w - w
         if (drag.handle.includes('n')) y = base.y + base.h - h
       }
       layer.x = x; layer.y = y; layer.w = w; layer.h = h
     }
     if (isDrawableLayer(layer)) layer._bounds = undefined
     redrawBitmapLayer(layer)
   }

export function setActiveLayer(id) {
    S.activeLayerId = id
    S.selectedLayerId = id
    S.selectedTextId = null
    S.selectedShapeId = null
    S.textDrag = null
    S.shapeDrag = null
    renderLayerPanel()
    renderObjects()
  }

  /** 添加位图图层（导入图片） — 启动放置流程，先调整大小/位置再确认 */
  export function addBitmapLayer(img) {
    startImagePlacement(img)
  }

  /** 新建空白图层 */
  export function addBlankLayer() { // 创建可独立编辑的位图图层

    const id = 'L' + Date.now() + Math.floor(Math.random() * 1000)
    const canvas = createLayerCanvas()
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    ctx.clearRect(0, 0, S.imgW, S.imgH)
    const layer = {
      id,
      name: '空白图层 ' + (S.layers.length + 1),
      canvas,
      ctx,
      opacity: 1,
      visible: true,
       locked: false,
      x: 0, y: 0, w: S.imgW, h: S.imgH,
      rotation: 0,
      z: ++S.zCounter
    }
    saveSnapshot()
    S.layers.push(layer)
    reorderLayerCanvas()
    setActiveLayer(id)
    updateLayerCanvasStyles()
    renderLayerPanel()
  }

  /** 删除图层 */
  function deleteLayer(id) {
    const idx = S.layers.findIndex(l => l.id === id)
    if (idx < 0) return
    // 不允许删除最后一个图层
    if (S.layers.length <= 1) return
    const layer = S.layers[idx]
    if (layer.locked) return
    saveSnapshot()
    if (layer.canvas.parentNode) layer.canvas.parentNode.removeChild(layer.canvas)
    S.layers.splice(idx, 1)
    // 重排 z 序
    S.layers.forEach((l, i) => { l.z = i })
    // 如果删除的是活跃图层，切到最后一个
    if (S.activeLayerId === id) {
      S.activeLayerId = S.layers[S.layers.length - 1].id
    }
    reorderLayerCanvas()
    renderLayerPanel()
  }

  // ============ 矢量对象独立画布（位图/矢量统一排序） ============
  function vecCanvasFor(obj) {
    if (!obj._canvas || !obj._canvas.parentNode) {
      const c = document.createElement('canvas')
      c.className = 'iwb-editor-vec-canvas'
      c.width = S.imgW
      c.height = S.imgH
      c.style.position = 'absolute'
      c.style.top = '0'
      c.style.left = '0'
      c.style.display = 'block'
      S.canvasStack.insertBefore(c, S.strokeCanvas)
      if (S.imgW && S.fitW) {
        const vw = Math.round(S.fitW * S.zoom)
        const vh = Math.round(S.fitH * S.zoom)
        const vs = S.imgW ? (S.fitW * S.zoom) / S.imgW : 1
        const vo = Math.round((S.overlayPad || 0) * vs)
        c.style.width = vw + 'px'; c.style.height = vh + 'px'
        c.style.left = vo + 'px'; c.style.top = vo + 'px'
      }
      obj._canvas = c
      obj._ctx = c.getContext('2d')
    }
    return obj
  }
  export function removeVecCanvas(obj) {
    if (obj && obj._canvas) {
      if (obj._canvas.parentNode) obj._canvas.parentNode.removeChild(obj._canvas)
      obj._canvas = null
      obj._ctx = null
    }
  }
  export function purgeVectorCanvases() {
    for (const t of S.textLayers) removeVecCanvas(t)
    for (const sh of S.shapeLayers) removeVecCanvas(sh)
  }
  export function drawVectorToCanvas(kind, obj) {
    vecCanvasFor(obj)
    const ctx = obj._ctx
    ctx.clearRect(0, 0, S.imgW, S.imgH)
    if (kind === 'shape') {
      drawShape(ctx, obj)
    } else {
      ctx.save()
      ctx.textBaseline = 'top'
      ctx.globalAlpha = obj.opacity != null ? obj.opacity : 1
      const rot = obj.rotation || 0
      if (rot) {
        const b = textBounds(obj)
        const cx = b.x + b.w / 2, cy = b.y + b.h / 2
        ctx.translate(cx, cy)
        ctx.rotate(rot * Math.PI / 180)
        ctx.translate(-cx, -cy)
      }
      ctx.font = TEXT_FONT(obj.fontSize)
      ctx.fillStyle = obj.color
      ctx.fillText(obj.text, obj.x, obj.y)
      ctx.restore()
    }
  }

  /** 切换图层可见性 */
  function toggleLayerVisibility(id) {
    const layer = S.layers.find(l => l.id === id)
    if (!layer) return
    layer.visible = !layer.visible
    reorderLayerCanvas()
    renderLayerPanel()
    S.pickerComposite = null
  }

  /** 设置图层透明度 */
  function setLayerOpacity(id, val) {
    const layer = S.layers.find(l => l.id === id)
    if (!layer) return
    layer.opacity = val
    layer.canvas.style.opacity = val
    S.pickerComposite = null
  }

  /** 更新位图图层尺寸；位置始终由 canvas-stack 统一管理。 */
  export function updateLayerCanvasStyles() {
    const w = Math.round(S.fitW * S.zoom)
    const h = Math.round(S.fitH * S.zoom)
    const scale = S.imgW ? (S.fitW * S.zoom) / S.imgW : 1
    const offset = Math.round((S.overlayPad || 0) * scale)
    for (const layer of S.layers) {
      layer.canvas.style.width = w + 'px'
      layer.canvas.style.height = h + 'px'
      layer.canvas.style.left = offset + 'px'
      layer.canvas.style.top = offset + 'px'
    }
    styleVectorViewport(w, h, offset)
  }

  export function styleVectorViewport(w, h, offset) {
    for (const { obj } of allObjects()) {
      if (!obj._canvas) continue
      obj._canvas.style.width = w + 'px'
      obj._canvas.style.height = h + 'px'
      obj._canvas.style.left = offset + 'px'
      obj._canvas.style.top = offset + 'px'
    }
  }

  // ============ 图层面板 UI ============

  export function renderLayerPanel() {
    const list = runtime.el.querySelector('.iwb-editor-layer-list')
    if (!list) return

    // 收集所有图层项（位图 + 矢量对象），按 z 序倒序（最上层在最前）
    const items = []

    // 位图图层
    for (const layer of S.layers) {
      items.push({
        id: layer.id,
        type: 'bitmap',
        name: layer.name,
        opacity: layer.opacity,
        visible: layer.visible,
        z: layer.z,
        color: layer.color || S.color,
        lineWidth: layer.lineWidth || S.brushSize,
        active: layer.id === (S.selectedLayerId || S.activeLayerId),
        locked: !!layer.locked,
        canDelete: S.layers.length > 1
      })
    }

    // 矢量对象（文字 + 形状），按 z 序排序
    const vectorObjs = allObjects()
    for (const { kind, obj } of vectorObjs) {
      items.push({
        id: obj.id,
        type: kind,
        name: kind === 'text' ? '"' + (obj.text || '').slice(0, 12) + '"' : (obj.type === 'rect' ? '矩形' : obj.type === 'circle' ? '圆形' : obj.type === 'pen' ? '钢笔形状' : '箭头'),
        opacity: obj.opacity != null ? obj.opacity : 1,
        visible: obj.visible !== false,
        z: obj.z || 0,
         color: obj.color || S.color,
         lineWidth: obj.lw || S.brushSize,
        active: (kind === 'text' && obj.id === S.selectedTextId) || (kind === 'shape' && obj.id === S.selectedShapeId),
        locked: !!obj.locked,
        canDelete: true
      })
    }

    // 按 z 序倒序排列（最上层在最前）
    items.sort((a, b) => b.z - a.z)

    let html = ''
    for (const item of items) {
      const activeClass = item.active ? ' active' : ''
      const visClass = item.visible ? '' : ' hidden'
      // SVG 图标
      let typeIconSvg = ''
      if (item.type === 'bitmap') {
        typeIconSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>'
      } else if (item.type === 'text') {
        typeIconSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 3 20 3 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="3" x2="12" y2="20"/></svg>'
      } else if (item.type === 'rect') {
        typeIconSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>'
      } else {
        typeIconSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>'
      }
      const visSvg = item.visible
        ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>'
        : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/></svg>'
      const lockSvg = item.locked
        ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>'
        : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 7-2"/></svg>'
      const delSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
      html += `<div class="iwb-layer-item${activeClass}${visClass}" draggable="${item.id !== 'base'}" data-layer-id="${item.id}" data-layer-type="${item.type}">
        <button class="iwb-layer-vis" data-vis-id="${item.id}" data-vis-type="${item.type}" title="${item.visible ? '隐藏' : '显示'}">${visSvg}</button>
        <span class="iwb-layer-icon">${typeIconSvg}</span>
        <span class="iwb-layer-name">${item.name}</span>
        ${(item.type === 'bitmap' || item.type === 'shape') ? `<input class="iwb-layer-color" type="color" value="${item.color}" data-color-id="${item.id}" data-color-type="${item.type}" title="调整颜色">` : ''}
        ${(item.type === 'bitmap' || item.type === 'shape') ? `<input class="iwb-layer-width" type="number" min="1" max="300" value="${Math.round(item.lineWidth)}" data-width-id="${item.id}" data-width-type="${item.type}" title="调整边框粗细">` : ''}
        <button class="iwb-layer-lock${item.locked ? ' active' : ''}" data-lock-id="${item.id}" data-lock-type="${item.type}" title="${item.locked ? '解锁图层' : '锁定图层'}">${lockSvg}</button>
         ${item.canDelete ? `<button class="iwb-layer-del" data-del-id="${item.id}" data-del-type="${item.type}" title="删除图层">${delSvg}</button>` : ''}
      </div>`
    }
    list.innerHTML = html

    // 绑定图层面板事件
    bindLayerPanelEvents()
  }

  function reorderPanelItem(dragId, targetId) {
    if (!dragId || !targetId || dragId === targetId || dragId === 'base' || targetId === 'base') return
    const all = [...S.layers.map(obj => ({ kind: 'bitmap', obj })), ...allObjects()]
      .sort((a, b) => (a.obj.z || 0) - (b.obj.z || 0))
    const from = all.findIndex(item => item.obj.id === dragId)
    let to = all.findIndex(item => item.obj.id === targetId)
    if (from < 0 || to < 0) return
    const [moved] = all.splice(from, 1)
    to = all.findIndex(item => item.obj.id === targetId)
    all.splice(to, 0, moved)
    saveSnapshot()
    all.forEach((item, index) => { item.obj.z = index })
    S.zCounter = Math.max(S.zCounter, all.length - 1)
    reorderLayerCanvas()
    sortLayersByZ()
    renderObjects()
    renderLayerPanel()
  }

  function bindLayerPanelEvents() {
    const list = runtime.el.querySelector('.iwb-editor-layer-list')
    if (!list) return

    // 点击图层项 → 设为活跃
    list.querySelectorAll('.iwb-layer-item').forEach(item => {
      item.addEventListener('mousedown', (e) => e.stopPropagation())
       item.addEventListener('dragstart', (e) => { if (item.draggable) { e.dataTransfer.setData('text/plain', item.dataset.layerId); item.classList.add('dragging') } })
       item.addEventListener('dragend', () => item.classList.remove('dragging'))
       item.addEventListener('dragover', (e) => { if (item.draggable) e.preventDefault() })
       item.addEventListener('drop', (e) => { e.preventDefault(); reorderPanelItem(e.dataTransfer.getData('text/plain'), item.dataset.layerId) })
      item.addEventListener('click', (e) => {
        if (e.target.closest('.iwb-layer-vis') || e.target.closest('.iwb-layer-lock') || e.target.closest('.iwb-layer-del')) return
        const id = item.dataset.layerId
        const type = item.dataset.layerType
        if (type === 'bitmap') {
          setActiveLayer(id)
        } else if (type === 'text') {
          S.selectedLayerId = null
          S.selectedShapeId = null
          S.selectedTextId = id
          S.textDrag = null
          S.shapeDrag = null
          S.bitmapDrag = null
          renderObjects()
          renderLayerPanel()
        } else if (type === 'shape') {
          S.selectedLayerId = null
          S.selectedTextId = null
          S.selectedShapeId = id
          S.textDrag = null
          S.shapeDrag = null
          S.bitmapDrag = null
          renderObjects()
          renderLayerPanel()
        }
      })
    })

    // 图层颜色与边框粗细：修改后立即刷新画布和面板。
    list.querySelectorAll('.iwb-layer-color').forEach(input => {
      input.addEventListener('mousedown', (e) => e.stopPropagation())
      input.addEventListener('input', (e) => {
        e.stopPropagation()
        const id = input.dataset.colorId
        const type = input.dataset.colorType
        const obj = type === 'bitmap' ? S.layers.find(l => l.id === id) : S.shapeLayers.find(s => s.id === id)
        if (obj) { obj.color = input.value; S.color = input.value; updateColorUI(); renderObjects(); renderLayerPanel(); S.pickerComposite = null }
      })
    })
    list.querySelectorAll('.iwb-layer-width').forEach(input => {
      input.addEventListener('mousedown', (e) => e.stopPropagation())
      input.addEventListener('input', (e) => {
        e.stopPropagation()
        const id = input.dataset.widthId
        const type = input.dataset.widthType
        const value = clamp(parseInt(input.value, 10) || 1, 1, 300)
        const obj = type === 'bitmap' ? S.layers.find(l => l.id === id) : S.shapeLayers.find(s => s.id === id)
        if (obj) { obj.lineWidth = value; if (type === 'shape') obj.lw = value; else S.brushSize = value; renderObjects(); updateBrushParamUI(); renderLayerPanel() }
      })
    })

    // 显隐切换
    list.querySelectorAll('.iwb-layer-vis').forEach(btn => {
      btn.addEventListener('mousedown', (e) => e.stopPropagation())
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        const id = btn.dataset.visId
        const type = btn.dataset.visType
        if (type === 'bitmap') {
          toggleLayerVisibility(id)
        } else if (type === 'text') {
          const obj = S.textLayers.find(t => t.id === id)
          if (obj) { obj.visible = obj.visible === false; renderObjects(); renderLayerPanel(); S.pickerComposite = null }
        } else if (type === 'shape') {
          const obj = S.shapeLayers.find(s => s.id === id)
          if (obj) { obj.visible = obj.visible === false; renderObjects(); renderLayerPanel(); S.pickerComposite = null }
        }
      })
    })

    // 锁定/解锁
    list.querySelectorAll('.iwb-layer-lock').forEach(btn => {
      btn.addEventListener('mousedown', (e) => e.stopPropagation())
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        const id = btn.dataset.lockId
        const type = btn.dataset.lockType
        const obj = type === 'bitmap' ? S.layers.find(l => l.id === id) : type === 'text' ? S.textLayers.find(t => t.id === id) : S.shapeLayers.find(s => s.id === id)
        if (!obj) return
        saveSnapshot()
        obj.locked = !obj.locked
        renderObjects()
        renderLayerPanel()
      })
    })

    // 删除图层
    list.querySelectorAll('.iwb-layer-del').forEach(btn => {
      btn.addEventListener('mousedown', (e) => e.stopPropagation())
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        const id = btn.dataset.delId
        const type = btn.dataset.delType
        if (type === 'bitmap') {
          deleteLayer(id)
        } else if (type === 'text') {
          S.selectedTextId = id
          deleteSelectedText()
          renderLayerPanel()
        } else if (type === 'shape') {
          S.selectedShapeId = id
          deleteSelectedShape()
          renderLayerPanel()
        }
      })
    })
  }
