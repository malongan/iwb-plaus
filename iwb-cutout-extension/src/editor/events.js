/* events.js - 事件绑定与 UI 更新
 * 节：鼠标事件、缩放、UI 更新、事件绑定。
 * bindEvents 绑定工具栏/面板，bindCanvasEvents 绑定画布；
 * 所有交互最终改写 state.js 的 S，再由 updateAllUI 刷新界面。
 */

'use strict'

import { S, ZOOM_STEP, runtime } from './state.js'
import { ROT_CURSOR, clamp, getPos, isOverRotationHandle, setView, setZoomFit, zoomStep } from './viewport.js'
import { addBitmapLayer, addBlankLayer, applyBitmapDrag, beginBitmapDrag, clearSelection, getActiveCtx, hitBitmapHandle, hitBitmapLayer, removeVecCanvas, renderLayerPanel } from './layers.js'
import { applyColorChange, beginStroke, drawToolRing, endStroke, eraseSegment, exitPicker, hidePickerTip, sampleColor, setTool, showPickerTip, strokeSegment } from './tools.js'
import { applyConstraintDrag, cancelCrop, clearOverlay, confirmCrop, drawCropPreview, hideCropBar, hitCropHandle, insideRect, resizeCropRect, setConstraint, showCropBar, updateCropInfo } from './crop.js'
import { applyShapeHandle, beginPenEdit, beginShapeHandleDrag, beginTextRotate, beginTextScaleDrag, commitTextInput, deleteSelectedShape, deleteSelectedText, exitPenEdit, getPenEditingShape, getSelectedShape, getSelectedText, hideTextInput, hitAnyObject, hitPenEdgeInsert, hitPenPoint, hitShapeHandle, hitShapeLayer, hitTextHandle, hitTextLayer, moveLayer, renderObjects, shapeBounds, showTextInput } from './objects.js'
import { cancelImagePlacement, confirmImagePlacement, drawPlacementPreview, hitPlacementHandle, insidePlacementRect, resizePlacement } from './placement.js'
import { exportResult } from './index.js'
import { loadImage } from './dom.js'
import { pushHistory, redo, resetDraw, restoreOriginal, saveSnapshot, snapshotState, undo } from './history.js'
import { hexToRgb, parseRatio, rgbToHex } from '../shared/image-math.js'


  // ============ 鼠标事件 ============
  /** 工具按下分发表：公共前置逻辑（放置/平移/按钮/钢笔编辑）走完后按 S.tool 派发到对应处理器 */
  const MOUSE_DOWN_HANDLERS = {
    select: onSelectMouseDown,
    crop: onCropMouseDown,
    text: onTextMouseDown,
    picker: onPickerMouseDown,
    brush: onBrushMouseDown,
    eraser: onEraserMouseDown,
    pen: onPenMouseDown,
    rect: onShapeMouseDown,
    arrow: onShapeMouseDown,
    circle: onShapeMouseDown
  }

  function onMouseDown(e) {
    // 图片放置模式优先处理
    if (S.placingImage) { onPlacementMouseDown(e); return }

    if (S.spaceDown || S.tool === 'hand' || e.button === 1) { onPanMouseDown(e); return }
    if (e.button !== 0) return
    e.preventDefault()

    const pos = getPos(e)
    S.startX = pos.x
    S.startY = pos.y

    // 钢笔节点编辑优先：点节点/点边直接接管；点空白退出编辑后继续走下方工具逻辑
    if ((S.tool === 'select' || S.tool === 'pen')) {
      const penShape = getPenEditingShape()
      if (penShape && onPenEditMouseDown(e, pos, penShape)) return
    }

    const handler = Object.prototype.hasOwnProperty.call(MOUSE_DOWN_HANDLERS, S.tool) ? MOUSE_DOWN_HANDLERS[S.tool] : null
    if (handler) handler(pos)
  }

  /** 图片放置模式的按下：命中手柄/图内开始拖拽，点外部确认放置 */
  function onPlacementMouseDown(e) {
    e.preventDefault()
    const pos = getPos(e)
    const handle = hitPlacementHandle(pos)
    if (handle) {
      S.placingHandle = handle
      S.placingStart = { mx: pos.x, my: pos.y, x: S.placingImage.x, y: S.placingImage.y, w: S.placingImage.w, h: S.placingImage.h, rotation: S.placingImage.rotation || 0 }
      S.drawCanvasCursor(CROP_CURSORS[handle] || 'move')
      return
    }
    if (insidePlacementRect(pos)) {
      S.placingHandle = 'move'
      S.placingStart = { mx: pos.x, my: pos.y, x: S.placingImage.x, y: S.placingImage.y, rotation: S.placingImage.rotation || 0 }
      S.drawCanvasCursor('move')
      return
    }
    // 点击外部 = 确认放置
    confirmImagePlacement()
  }

  /** 空格/抓手工具/中键：提交文字输入并开始平移画布 */
  function onPanMouseDown(e) {
    e.preventDefault()
    commitTextInput()
    S.panning = true
    S.panStart = { x: e.clientX, y: e.clientY, vx: S.viewX || 0, vy: S.viewY || 0 }
    updateCursor()
  }

  /** 钢笔节点编辑中的按下：点节点拖动/点边插点返回 true（已接管）；点空白退出编辑返回 false 继续走工具逻辑 */
  function onPenEditMouseDown(e, pos, penShape) {
    const pi = hitPenPoint(pos, penShape, Math.max(16 / S.zoom, 9))
    if (pi >= 0) {
      S.penDragPt = pi
      S.penDragBase = JSON.parse(JSON.stringify(penShape.pts))
      S.penDragPending = snapshotState()
      return true
    }
    const ei = hitPenEdgeInsert(pos, penShape)
    if (ei >= 0) {
      saveSnapshot()
      penShape.pts.splice(ei + 1, 0, { x: pos.x, y: pos.y })
      renderObjects()
      renderLayerPanel()
      return true
    }
    // 点击空白：退出编辑（继续走工具原有新建/选择逻辑）
    S.penEditId = null
    S.penDragPt = -1
    S.penDragPending = null
    renderObjects()
    return false
  }

  /** 选择工具的按下：手柄 > 对象 > 位图 > 清空选择，逐级命中 */
  function onSelectMouseDown(pos) {
      if (commitTextInput()) return
      const bitmapHandle = hitBitmapHandle(pos)
      if (bitmapHandle) { beginBitmapDrag(bitmapHandle, pos); return }
      const th = hitTextHandle(pos)
      if (th) { if (th === 'rotate') beginTextRotate(pos); else beginTextScaleDrag(th, pos); return }
      const shH = hitShapeHandle(pos)
      if (shH) { beginShapeHandleDrag(shH, pos); return }
      const hit = hitAnyObject(pos)
      if (hit) {
        S.selectedLayerId = null
        if (hit.kind === 'text') {
          S.selectedShapeId = null
          S.selectedTextId = hit.obj.id
          if (hit.obj.locked) { renderObjects(); renderLayerPanel(); return }
          S.textDrag = { mode: 'move', start: pos, layer: { x: hit.obj.x, y: hit.obj.y }, pending: snapshotState() }
        } else {
          S.selectedTextId = null
          S.selectedShapeId = hit.obj.id
          if (hit.obj.locked) { renderObjects(); renderLayerPanel(); return }
          S.shapeDrag = { mode: 'move', start: pos, shape: { ...hit.obj }, pending: snapshotState() }
        }
        renderObjects()
        renderLayerPanel()
      } else {
        const bitmap = hitBitmapLayer(pos)
        if (bitmap) {
          S.selectedLayerId = bitmap.id
          S.activeLayerId = bitmap.id
          S.selectedTextId = null
          S.selectedShapeId = null
          beginBitmapDrag(null, pos)
          renderObjects()
          renderLayerPanel()
        } else if (S.selectedLayerId || S.selectedTextId || S.selectedShapeId) {
          clearSelection()
          renderObjects()
          renderLayerPanel()
        }
      }
      return
  }

  /** 裁剪工具的按下：已有选区则拖手柄/整框移动，否则开始拉新选框 */
  function onCropMouseDown(pos) {
      if (S.cropRect) {
        const handle = hitCropHandle(pos)
        if (handle) { S.cropHandle = handle; S.isDrawing = true; return }
        if (insideRect(pos, S.cropRect)) {
          S.cropMoving = true
          S.moveStart = { x: pos.x, y: pos.y, rect: { ...S.cropRect } }
          S.isDrawing = true
        }
        return
      }
      S.isDrawing = true
  }

  /** 文字工具的按下：手柄 > 命中已有文字 > 在点击处新建文字 */
  function onTextMouseDown(pos) {
      if (commitTextInput()) return
      const handle = hitTextHandle(pos)
      if (handle) { if (handle === 'rotate') beginTextRotate(pos); else beginTextScaleDrag(handle, pos); return }
      const hit = hitTextLayer(pos)
      if (hit) {
        S.selectedTextId = hit.id
        if (hit.locked) { renderObjects(); renderLayerPanel(); return }
        S.textDrag = {
          mode: 'move',
          start: pos,
          layer: { x: hit.x, y: hit.y },
          pending: snapshotState()
        }
        renderObjects()
        renderLayerPanel()
      } else {
        if (S.selectedTextId) { S.selectedTextId = null; renderObjects(); renderLayerPanel() }
        showTextInput(pos.x, pos.y)
      }
  }

  /** 吸管工具的按下：取样并应用颜色后退出吸管模式 */
  function onPickerMouseDown(pos) {
      const s = sampleColor(pos)
      if (s && s.a > 0) {
        applyColorChange(rgbToHex(s.r, s.g, s.b))
      }
      exitPicker()
      return
  }

  /** 画笔工具的按下：无可写图层则忽略，否则存快照并落下第一点 */
  function onBrushMouseDown(pos) {
      if (!getActiveCtx()) return
      S.isDrawing = true
      saveSnapshot()
      beginStroke()
      strokeSegment(pos.x, pos.y, pos.x, pos.y)
  }

  /** 橡皮工具的按下：与画笔同构，存快照并擦除第一段 */
  function onEraserMouseDown(pos) {
      if (!getActiveCtx()) return
      S.isDrawing = true
      saveSnapshot()
      beginStroke()
      eraseSegment(pos.x, pos.y, pos.x, pos.y)
  }

  /** 钢笔工具的按下：回到起点则闭合路径，否则追加一个路径点 */
  function onPenMouseDown(pos) {
      if (!S.penPath) S.penPath = { pts: [], preview: null, closed: false }
      const point = { x: clamp(pos.x, 0, S.imgW), y: clamp(pos.y, 0, S.imgH) }
      const first = S.penPath.pts[0]
      if (first && S.penPath.pts.length >= 3 && Math.hypot(point.x - first.x, point.y - first.y) <= Math.max(12 / S.zoom, S.brushSize * 1.5)) {
        S.penPath.closed = true
        S.penPath.nearStart = true
        S.penPath.preview = null
        commitPenPath()
      } else {
        S.penPath.pts.push(point)
        renderObjects({ id: 'pen-preview', type: 'pen', pts: S.penPath.pts.concat(S.penPath.preview ? [S.penPath.preview] : []), closed: false, color: S.color, lw: Math.max(2, S.brushSize), fill: false, opacity: 1, visible: true })
      }
      return
  }

  /** 矩形/圆形/箭头的按下：命中同类型形状则拖动，否则开始拉新形状 */
  function onShapeMouseDown(pos) {
      const handle = hitShapeHandle(pos)
      if (handle) { beginShapeHandleDrag(handle, pos); return }
      const hitShape = hitShapeLayer(pos, true)
      if (hitShape && hitShape.type === S.tool) {
        S.selectedShapeId = hitShape.id
        if (hitShape.locked) { renderObjects(); renderLayerPanel(); return }
        S.shapeDrag = { mode: 'move', start: pos, shape: { ...hitShape }, pending: snapshotState() }
        renderObjects()
        renderLayerPanel()
        return
      }
      if (S.selectedShapeId) { S.selectedShapeId = null; renderObjects(); renderLayerPanel() }
      S.isDrawing = true
  }

  /** 绘制中移动分发表：公共前置（放置/平移/各拖拽态/isDrawing）走完后按 S.tool 派发到对应处理器 */
  const DRAW_MOVE_HANDLERS = {
    brush: onBrushDrawMove,
    eraser: onEraserDrawMove,
    pen: onPenDrawMove,
    rect: onShapeDrawMove,
    arrow: onShapeDrawMove,
    circle: onShapeDrawMove,
    crop: onCropDrawMove
  }

  function onMouseMove(e) {
    // 图片放置拖拽
    if (S.placingImage && S.placingHandle && S.placingStart) {
      onPlacementDragMove(e); return
    }
    // 图片放置 hover 光标
    if (S.placingImage) {
      onPlacementHoverMove(e); return
    }

    if (S.panning && S.panStart) {
      onPanMouseMove(e); return
    }
    const pos0 = getPos(e)
    if (S.bitmapDrag) {
      onBitmapDragMouseMove(pos0); return
    }
    if (S.textDrag) {
      onTextDragMouseMove(pos0); return
    }
    if (S.penDragPt >= 0) {
      onPenEditDragMove(pos0); return
    }
    if (S.shapeDrag) {
      onShapeDragMouseMove(pos0); return
    }
    if (!S.isDrawing) return
    const pos = pos0

    const handler = Object.prototype.hasOwnProperty.call(DRAW_MOVE_HANDLERS, S.tool) ? DRAW_MOVE_HANDLERS[S.tool] : null
    if (handler) handler(pos)
  }

  /** 图片放置拖拽：按手柄/整体拖拽调整放置框并刷新预览 */
  function onPlacementDragMove(e) {
    const pos = getPos(e)
    resizePlacement(pos)
    drawPlacementPreview()
    return
  }

  /** 图片放置 hover：按命中手柄/区域切换画布光标 */
  function onPlacementHoverMove(e) {
    const pos = getPos(e)
    const h = hitPlacementHandle(pos)
    if (h) S.drawCanvasCursor(h === 'rotate' ? ROT_CURSOR : (CROP_CURSORS[h] || 'move'))
    else S.drawCanvasCursor(insidePlacementRect(pos) ? 'move' : 'default')
    return
  }

  /** 平移：按鼠标位移更新画布视口 */
  function onPanMouseMove(e) {
    setView(S.panStart.vx + (e.clientX - S.panStart.x),
            S.panStart.vy + (e.clientY - S.panStart.y))
    return
  }

  /** 位图层拖拽：应用位移/缩放并重绘对象层 */
  function onBitmapDragMouseMove(pos0) {
    applyBitmapDrag(pos0)
    renderObjects()
    return
  }

  /** 文字拖拽：按模式移动/旋转/缩放选中文字后重绘 */
  function onTextDragMouseMove(pos0) {
    const t = getSelectedText()
    if (t) {
      if (S.textDrag.mode === 'move') {
        const dx = pos0.x - S.textDrag.start.x
        const dy = pos0.y - S.textDrag.start.y
        t.x = clamp(S.textDrag.layer.x + dx, 0, Math.max(0, S.imgW - 4))
        t.y = clamp(S.textDrag.layer.y + dy, 0, Math.max(0, S.imgH - 4))
      } else if (S.textDrag.mode === 'rotate') {
        const st = S.textDrag
        const a1 = Math.atan2(pos0.y - st.cy, pos0.x - st.cx)
        const a0 = Math.atan2(st.startY0 - st.cy, st.startX0 - st.cx)
        let deg = st.rotation
        if (st.startX0 !== undefined) deg = st.rotation + (a1 - a0) * 180 / Math.PI
        if (S._shiftDown) deg = Math.round(deg / 15) * 15
        t.rotation = deg
      } else if (S.textDrag.mode === 'scale') {
        const dx = pos0.x - S.textDrag.anchor.x
        const dy = pos0.y - S.textDrag.anchor.y
        const d = Math.sqrt(dx * dx + dy * dy)
        const f = d / Math.max(S.textDrag.d0, 1)
        t.fontSize = clamp(Math.round(S.textDrag.fontSize * f), 8, 2000)
      }
      renderObjects()
    }
    return
  }

  /** 钢笔节点拖拽：更新当前顶点坐标并重绘 */
  function onPenEditDragMove(pos0) {
    const penShape = getPenEditingShape()
    if (penShape && penShape.pts[S.penDragPt]) {
      penShape.pts[S.penDragPt].x = clamp(pos0.x, 0, S.imgW)
      penShape.pts[S.penDragPt].y = clamp(pos0.y, 0, S.imgH)
      renderObjects()
    }
    return
  }

  /** 形状拖拽：整体移动按画布边界夹取，或走手柄变形，再重绘对象层 */
  function onShapeDragMouseMove(pos0) {
    const sh = getSelectedShape()
    if (sh) {
      if (S.shapeDrag.mode === 'move') {
        const dx = pos0.x - S.shapeDrag.start.x
        const dy = pos0.y - S.shapeDrag.start.y
        const b = shapeBounds(S.shapeDrag.shape)
        const cdx = clamp(dx, -b.x, Math.max(-b.x, S.imgW - (b.x + b.w)))
        const cdy = clamp(dy, -b.y, Math.max(-b.y, S.imgH - (b.y + b.h)))
        if (sh.type === 'pen') {
          sh.pts = (S.shapeDrag.shape.pts || []).map(p => ({ x: p.x + cdx, y: p.y + cdy }))
        } else {
          sh.x1 = S.shapeDrag.shape.x1 + cdx
          sh.y1 = S.shapeDrag.shape.y1 + cdy
          sh.x2 = S.shapeDrag.shape.x2 + cdx
          sh.y2 = S.shapeDrag.shape.y2 + cdy
        }
      } else {
        applyShapeHandle(sh, S.shapeDrag.handle, pos0)
      }
      renderObjects()
    }
    return
  }

  /** 画笔绘制：延伸笔段、更新起点并刷新笔刷环 */
  function onBrushDrawMove(pos) {
    strokeSegment(S.startX, S.startY, pos.x, pos.y)
    S.startX = pos.x
    S.startY = pos.y
    drawToolRing(pos)
  }

  /** 橡皮绘制：擦除延伸段、更新起点并刷新笔刷环 */
  function onEraserDrawMove(pos) {
    eraseSegment(S.startX, S.startY, pos.x, pos.y)
    S.startX = pos.x
    S.startY = pos.y
    drawToolRing(pos)
  }

  /** 钢笔路径预览：更新悬停点与起点闭合提示 */
  function onPenDrawMove(pos) {
    if (S.penPath) { S.penPath.preview = pos; const first = S.penPath.pts[0]
      const nearStart = first && S.penPath.pts.length >= 3 && Math.hypot(pos.x - first.x, pos.y - first.y) <= Math.max(12 / S.zoom, S.brushSize * 1.5)
      S.penPath.nearStart = !!nearStart
      renderObjects() }
  }

  /** 矩形/圆/箭头拉框：渲染临时形状预览 */
  function onShapeDrawMove(pos) {
    const temp = {
      id: 'temp',
      type: S.tool,
      x1: S.startX, y1: S.startY,
      x2: pos.x, y2: pos.y,
      color: S.color,
      lw: Math.max(2, S.brushSize),
      lineWidth: Math.max(2, S.brushSize),
      fill: S.tool === 'rect' || S.tool === 'circle' ? !!S.rectFill : false,
      opacity: 1,
      visible: true
    }
    renderObjects(temp)
  }

  /** 裁剪拉框/手柄拖拽/整框移动：刷新选区预览与裁剪信息 */
  function onCropDrawMove(pos) {
    if (S.cropHandle) {
      resizeCropRect(pos)
      drawCropPreview()
      updateCropInfo()
    } else if (S.cropMoving && S.moveStart) {
      const dx = pos.x - S.moveStart.x
      const dy = pos.y - S.moveStart.y
      const r = S.moveStart.rect
      const nx = r.x + dx
      const ny = r.y + dy
      S.cropRect = { x: nx, y: ny, w: r.w, h: r.h }
      drawCropPreview()
      updateCropInfo()
    } else {
      drawCropPreview(S.startX, S.startY, pos.x, pos.y)
      updateCropInfo()
    }
  }

  /** 绘制结束分发表：isDrawing 收尾与状态复位后按 S.tool 派发到对应收尾处理器 */
  const DRAW_UP_HANDLERS = {
    brush: onStrokeDrawUp,
    eraser: onStrokeDrawUp,
    crop: onCropDrawUp,
    rect: onShapeDrawUp,
    arrow: onShapeDrawUp,
    circle: onShapeDrawUp
  }

  function onMouseUp(e) {
    if (S.penDragPt >= 0) {
      onPenEditMouseUp(); return
    }
    // 图片放置拖拽结束
    if (S.placingImage && S.placingHandle) {
      onPlacementMouseUp(); return
    }
    if (S.panning) {
      onPanMouseUp(); return
    }
    if (S.textDrag) {
      onTextDragMouseUp(); return
    }
    if (S.bitmapDrag) {
      onBitmapDragMouseUp(); return
    }
    if (S.shapeDrag) {
      onShapeDragMouseUp(); return
    }
    if (!S.isDrawing) return
    S.isDrawing = false
    const pos = getPos(e)

    const handler = Object.prototype.hasOwnProperty.call(DRAW_UP_HANDLERS, S.tool) ? DRAW_UP_HANDLERS[S.tool] : null
    if (handler) handler(pos)
  }

  /** 钢笔节点拖拽收尾：复位拖拽态并按差异入栈历史 */
  function onPenEditMouseUp() {
    const penShape = getPenEditingShape()
    const pending = S.penDragPending
    S.penDragPt = -1
    S.penDragPending = null
    S.penDragBase = null
    if (pending && penShape) {
      const cur = snapshotState({ metaOnly: true })
      if (JSON.stringify(cur.shapes) !== JSON.stringify(pending.shapes)) {
        pushHistory(S.history, pending)
        S.redoStack = []
      }
    }
    return
  }

  /** 图片放置拖拽结束：清手柄与起点并刷新预览 */
  function onPlacementMouseUp() {
    S.placingHandle = null
    S.placingStart = null
    drawPlacementPreview()
    return
  }

  /** 平移结束：复位平移态并刷新光标 */
  function onPanMouseUp() {
    S.panning = false
    S.panStart = null
    updateCursor()
    return
  }

  /** 文字拖拽收尾：按差异入栈历史并刷新图层面板 */
  function onTextDragMouseUp() {
    const pending = S.textDrag.pending
    if (pending) {
      const cur = snapshotState({ metaOnly: true })
      if (JSON.stringify(cur.texts) !== JSON.stringify(pending.texts)) {
        pushHistory(S.history, pending)
        S.redoStack = []
      }
    }
    S.textDrag = null
    renderLayerPanel()
    return
  }

  /** 位图层拖拽收尾：按位图差异入栈历史并重绘 */
  function onBitmapDragMouseUp() {
    const pending = S.bitmapDrag.pending
    if (pending) {
      const cur = snapshotState({ metaOnly: true })
      const before = pending.bitmaps.find(b => b.id === S.selectedLayerId)
      const after = cur.bitmaps.find(b => b.id === S.selectedLayerId)
      if (before && after && JSON.stringify([before.x, before.y, before.w, before.h]) !== JSON.stringify([after.x, after.y, after.w, after.h])) {
        pushHistory(S.history, pending)
        S.redoStack = []
      }
    }
    S.bitmapDrag = null
    renderObjects()
    renderLayerPanel()
    return
  }

  /** 形状拖拽收尾：按差异入栈历史并刷新图层面板 */
  function onShapeDragMouseUp() {
    const pending = S.shapeDrag.pending
    if (pending) {
      const cur = snapshotState({ metaOnly: true })
      if (JSON.stringify(cur.shapes) !== JSON.stringify(pending.shapes) ||
          JSON.stringify(cur.texts) !== JSON.stringify(pending.texts)) {
        pushHistory(S.history, pending)
        S.redoStack = []
      }
    }
    S.shapeDrag = null
    renderLayerPanel()
    return
  }

  /** 画笔/橡皮一笔结束：收笔 */
  function onStrokeDrawUp() {
    endStroke()
    return
  }

  /** 裁剪收尾：手柄/整框拖拽复位，否则按拉框结果确认或清除选区 */
  function onCropDrawUp(pos) {
    if (S.cropHandle) {
      S.cropHandle = null
      drawCropPreview()
      updateCropInfo()
      return
    }
    if (S.cropMoving) {
      S.cropMoving = false
      S.moveStart = null
      drawCropPreview()
      updateCropInfo()
      return
    }
    const r = applyConstraintDrag(S.startX, S.startY, pos.x, pos.y)
    if (r.w > 2 && r.h > 2) {
      S.cropRect = { x: r.x, y: r.y, w: r.w, h: r.h }
      showCropBar()
      drawCropPreview()
      updateCropInfo()
    } else {
      clearOverlay()
    }
  }

  /** 矩形/圆/箭头拉框结束：尺寸达标则落成新形状并选中 */
  function onShapeDrawUp(pos) {
    const len = Math.hypot(pos.x - S.startX, pos.y - S.startY)
    const ok = S.tool === 'rect' || S.tool === 'circle'
      ? (Math.abs(pos.x - S.startX) > 2 && Math.abs(pos.y - S.startY) > 2)
      : len > 3
    if (ok) {
      saveSnapshot()
      const shape = {
        id: 's' + Date.now() + Math.floor(Math.random() * 1000),
        type: S.tool,
        x1: S.startX, y1: S.startY,
        x2: pos.x, y2: pos.y,
        color: S.color,
        lw: Math.max(2, S.brushSize),
        fill: S.tool === 'rect' || S.tool === 'circle' ? !!S.rectFill : false,
        opacity: 1,
        visible: true,
     locked: false,
        z: ++S.zCounter
      }
      S.shapeLayers.push(shape)
      S.selectedShapeId = shape.id
    }
    renderObjects()
    renderLayerPanel()
  }

  // ============ 缩放 ============
  function onWheel(e) {
    if (!S.open) return
    e.preventDefault()
    const rect = S.canvasWrap.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP
    zoomStep(factor, mx, my)
  }

  // ============ UI 更新 ============
  export function updateAllUI() {
    updateToolUI()
    updateColorUI()
    updateBrushUI()
    updateBrushParamUI()
    updateFillUI()
    updateLayerUI()
    updateZoomUI()
    hidePickerTip()
    runtime.el.querySelectorAll('.iwb-editor-constraint-btn[data-ratio]').forEach(b => b.classList.remove('active'))
    const freeBtn = runtime.el.querySelector('.iwb-editor-constraint-btn[data-ratio="free"]')
    if (freeBtn) freeBtn.classList.add('active')
    hideCropBar()
    updateCropInfo()
    hideTextInput()
    S.selectedTextId = null
    S.textDrag = null
    S.selectedShapeId = null
    S.shapeDrag = null
    renderLayerPanel()
  }

  export function updateZoomUI() {
    const val = runtime.el.querySelector('.iwb-editor-zoom-val')
    if (val) val.textContent = Math.round(S.zoom * 100) + '%'
  }

  export function updateToolUI() {
    runtime.el.querySelectorAll('.iwb-editor-tool').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tool === S.tool)
    })
    updateCursor()
  }

  export function updateCursor() {
    if (S.panning) { S.drawCanvasCursor('grabbing'); return }
    if (S.spaceDown) { S.drawCanvasCursor('grab'); return }
    if (S.tool === 'hand') { S.drawCanvasCursor('grab'); return }
    if (S.tool === 'brush' || S.tool === 'eraser') {
      S.drawCanvasCursor('none')
      return
    }
    if (S.tool === 'crop' && S.cropRect) {
      S.drawCanvasCursor('crosshair')
      return
    }
    S.drawCanvasCursor(S.tool === 'text' ? 'text' : (S.tool === 'select' ? 'default' : 'crosshair'))
  }

  /** 在所有位图图层 canvas 上设置 cursor（因为事件可能落在任意一个上） */
  S.drawCanvasCursor = function(cur) {
    for (const layer of S.layers) {
      layer.canvas.style.cursor = cur
    }
  }

  export function updateColorUI() {
    let matchPreset = false
    runtime.el.querySelectorAll('.iwb-editor-color[data-color]').forEach(s => {
      const on = (s.dataset.color || '').toLowerCase() === S.color.toLowerCase()
      if (on) matchPreset = true
      s.classList.toggle('active', on)
    })
    const panelHex = runtime.el.querySelector('.iwb-editor-color-hex')
    const hexInput = runtime.el.querySelector('.iwb-editor-color-hex-input')
    if (hexInput && document.activeElement !== hexInput) hexInput.value = S.color.toUpperCase()
    runtime.el.querySelectorAll('.iwb-editor-color-panel-swatch').forEach(sw => sw.classList.toggle('active', (sw.dataset.panelColor || '').toLowerCase() === S.color.toLowerCase()))
    if (panelHex) panelHex.textContent = S.color.toUpperCase()
    const rgb = hexToRgb(S.color)
    const max = Math.max(rgb.r, rgb.g, rgb.b) / 255, min = Math.min(rgb.r, rgb.g, rgb.b) / 255
    const d = max - min
    let h = 0
    if (d) { if (max === rgb.r / 255) h = 60 * (((rgb.g - rgb.b) / 255 / d) % 6); else if (max === rgb.g / 255) h = 60 * ((rgb.b - rgb.r) / 255 / d + 2); else h = 60 * ((rgb.r - rgb.g) / 255 / d + 4) }
    if (h < 0) h += 360
    const sv = runtime.el.querySelector('.iwb-color-sv'), hue = runtime.el.querySelector('.iwb-color-hue')
    if (sv) sv.style.backgroundColor = `hsl(${h} 100% 50%)`
    if (hue) hue.dataset.hue = h
    const hueMarker = hue && hue.querySelector('span'); if (hueMarker) hueMarker.style.top = (h / 360 * 100) + '%'
    const svMarker = sv && sv.querySelector('span'); if (svMarker) { const sat = max ? d / max : 0; svMarker.style.left = (sat * 100) + '%'; svMarker.style.top = ((1 - max) * 100) + '%' }
    const custom = runtime.el.querySelector('.iwb-editor-color-custom')
    if (custom) {
      custom.classList.toggle('active', !matchPreset)
      const inp = custom.querySelector('input')
      if (inp) inp.value = S.color
    }
  }

  function updateBrushUI() {
    const slider = runtime.el.querySelector('.iwb-editor-brush-size')
    if (!slider) return
    slider.value = S.brushSize
    const num = runtime.el.querySelector('.iwb-editor-brush-num')
    if (num && document.activeElement !== num) num.value = S.brushSize
  }

  /** 画笔参数组（硬度/透明度）：画笔与橡皮工具共用 */
  export function updateBrushParamUI() {
    const g = runtime.el.querySelector('.iwb-editor-brush-group')
    if (!g) return
    g.style.display = (S.tool === 'brush' || S.tool === 'eraser') ? 'flex' : 'none'
    const oLabel = g.querySelector('.iwb-editor-opacity-label')
    if (oLabel) oLabel.style.display = (S.tool === 'brush' || S.tool === 'eraser') ? '' : 'none'
    const h = g.querySelector('.iwb-editor-brush-hardness')
    if (h) {
      h.value = S.brushHardness
      g.querySelector('.iwb-editor-brush-hardness-val').textContent = S.brushHardness
    }
    const o = g.querySelector('.iwb-editor-brush-opacity')
    if (o) {
      o.value = Math.round(S.brushOpacity * 100)
      g.querySelector('.iwb-editor-brush-opacity-val').textContent = Math.round(S.brushOpacity * 100) + '%'
    }
  }

  function updateFillUI() {
    const b = runtime.el.querySelector('[data-action="toggleFill"]')
    if (b) b.classList.toggle('active', !!S.rectFill)
  }

  /** 图层按钮可用态：有选中元素才可用 */
  export function updateLayerUI() {
    const hasSel = !!(S.selectedTextId || S.selectedShapeId || S.layers.some(l => l.id === S.selectedLayerId && l.id !== 'base' && !l.locked))
    runtime.el.querySelectorAll('.iwb-editor-layer-btn').forEach(b => {
      b.disabled = !hasSel
    })
  }

  // ============ 事件绑定 ============
  /**
   * 安全绑定：选择器找不到元素时只告警一次、不抛异常。
   * 原实现是 querySelector(...).addEventListener 直接连写 —— DOM 里少一个元素
   * 就会抛 TypeError 并中断**之后的所有绑定**，表现为"某个按钮突然全都不响应"。
   */
  const warnedMissing = new Set()
  function bindIf(selector, type, handler, root) {
    const el = (root || runtime.el).querySelector(selector)
    if (!el) {
      if (!warnedMissing.has(selector)) {
        warnedMissing.add(selector)
        console.warn('[IWB编辑器] 未找到元素，跳过绑定：' + selector)
      }
      return null
    }
    el.addEventListener(type, handler)
    return el
  }

  export function bindEvents() {
    bindToolButtons()
    bindColorPanel()
    bindCropConstraintControls()
    bindColorPalette()
    bindFillToggle()
    bindLayerOrderButtons()
    bindBrushSizeControls()
    bindBrushParams()
    bindZoomButtons()
    bindHistoryActions()
    bindCropActions()
    bindLayerAddActions()
    bindExportActions()
    bindWheelZoom()
    bindTextInput()
    bindGlobalListeners()
  }

  /** 工具条按钮：点击切换当前工具 */
  function bindToolButtons() {
    // 工具
    runtime.el.querySelectorAll('.iwb-editor-tool').forEach(btn => {
      btn.addEventListener('mousedown', (e) => e.stopPropagation())
      btn.addEventListener('click', () => setTool(btn.dataset.tool))
    })
  }

  /** 独立颜色面板：hex 输入、面板色块、吸管入口与 SV/HUE 取色区 */
  function bindColorPanel() {
    // 独立颜色面板：颜色选择后同步当前工具颜色。
    const setPanelColor = (color) => applyColorChange(color)
    const panelHexInput = runtime.el.querySelector('.iwb-editor-color-hex-input')
    if (panelHexInput) panelHexInput.addEventListener('change', () => { if (/^#[0-9a-f]{6}$/i.test(panelHexInput.value)) setPanelColor(panelHexInput.value) })
    runtime.el.querySelectorAll('.iwb-editor-color-panel-swatch').forEach(btn => btn.addEventListener('click', (e) => { e.stopPropagation(); setPanelColor(btn.dataset.panelColor) }))
    const palettePick = runtime.el.querySelector('[data-action="palettePick"]')
    if (palettePick) { palettePick.addEventListener('mousedown', (e) => e.stopPropagation()); palettePick.addEventListener('click', () => setTool('picker')) }
    const sv = runtime.el.querySelector('.iwb-color-sv')
    const hue = runtime.el.querySelector('.iwb-color-hue')
    const initHsv = (() => {
      const { r, g, b } = hexToRgb(S.color)
      const rr = r / 255, gg = g / 255, bb = b / 255
      const max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb), d = max - min
      let h = 0
      if (d) { if (max === rr) h = 60 * (((gg - bb) / d) % 6); else if (max === gg) h = 60 * ((bb - rr) / d + 2); else h = 60 * ((rr - gg) / d + 4) }
      if (h < 0) h += 360
      return { h, sat: max ? d / max : 0, val: max }
    })()
    let hueValue = initHsv.h
    let satValue = initHsv.sat
    let valValue = initHsv.val
    const hsvToHex = (h, sat, val) => {
      const c = val * sat, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = val - c
      let r = 0, g = 0, b = 0
      if (h < 60) { r = c; g = x } else if (h < 120) { r = x; g = c } else if (h < 180) { g = c; b = x } else if (h < 240) { g = x; b = c } else if (h < 300) { r = x; b = c } else { r = c; b = x }
      return rgbToHex(Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255))
    }
    const pick = (target, e) => {
      const r = target.getBoundingClientRect()
      const x = clamp((e.clientX - r.left) / r.width, 0, 1)
      const y = clamp((e.clientY - r.top) / r.height, 0, 1)
      if (target === hue) hueValue = y * 360
      else { satValue = x; valValue = 1 - y }
      setPanelColor(hsvToHex(hueValue, satValue, valValue))
    }
    if (sv) { sv.addEventListener('pointerdown', e => { sv.setPointerCapture(e.pointerId); pick(sv, e) }); sv.addEventListener('pointermove', e => { if (e.buttons) pick(sv, e) }) }
    if (hue) { hue.addEventListener('pointerdown', e => { pick(hue, e) }); hue.addEventListener('pointermove', e => { if (e.buttons) pick(hue, e) }) }
  }

  /** 裁剪约束控件：比例按钮、尺寸约束开关、应用尺寸按钮 */
  function bindCropConstraintControls() {
    // 比例约束按钮
    runtime.el.querySelectorAll('.iwb-editor-constraint-btn[data-ratio]').forEach(btn => {
      btn.addEventListener('mousedown', (e) => e.stopPropagation())
      btn.addEventListener('click', () => {
        const r = btn.dataset.ratio
        runtime.el.querySelectorAll('.iwb-editor-constraint-btn[data-ratio]').forEach(b => b.classList.remove('active'))
        btn.classList.add('active')
        const ratio = parseRatio(r)
        if (ratio > 0) {
          setConstraint('ratio', ratio, 0, 0)
        } else {
          setConstraint('free', 0, 0, 0)
        }
      })
    })

    // 尺寸约束开关
    const sizeToggle = runtime.el.querySelector('[data-action="toggleSizeConstraint"]')
    if (sizeToggle) sizeToggle.addEventListener('click', () => { if (S.cropConstraint.type === 'size') setConstraint('free', 0, 0, 0); else { const w = parseInt(runtime.el.querySelector('.iwb-editor-size-w').value, 10), h = parseInt(runtime.el.querySelector('.iwb-editor-size-h').value, 10); if (w > 0 && h > 0) setConstraint('size', w / h, w, h) } })

    // 应用尺寸按钮
    bindIf('[data-action="applySize"]', 'mousedown', (e) => e.stopPropagation())
    bindIf('[data-action="applySize"]', 'click', () => {
      const w = parseInt(runtime.el.querySelector('.iwb-editor-size-w').value, 10)
      const h = parseInt(runtime.el.querySelector('.iwb-editor-size-h').value, 10)
      if (w > 0 && h > 0) {
        runtime.el.querySelectorAll('.iwb-editor-constraint-btn[data-ratio]').forEach(b => b.classList.remove('active'))
        setConstraint('size', w / h, w, h)
      }
    })
  }

  /** 调色板色块与自定义取色 input */
  function bindColorPalette() {
    // 颜色
    runtime.el.querySelectorAll('.iwb-editor-color[data-color]').forEach(s => {
      s.addEventListener('mousedown', (e) => e.stopPropagation())
      s.addEventListener('click', () => applyColorChange(s.dataset.color))
    })

    const colorInput = runtime.el.querySelector('.iwb-editor-color-picker-input')
    if (colorInput) {
      colorInput.addEventListener('mousedown', (e) => e.stopPropagation())
      colorInput.addEventListener('input', () => applyColorChange(colorInput.value))
    }
  }

  /** 实心矩形/圆形开关 */
  function bindFillToggle() {
    // 实心矩形开关
    const fillBtn = runtime.el.querySelector('[data-action="toggleFill"]')
    if (fillBtn) fillBtn.addEventListener('mousedown', (e) => e.stopPropagation())
    fillBtn && fillBtn.addEventListener('click', () => {
      S.rectFill = !S.rectFill
      updateFillUI()
      const sh = getSelectedShape()
      if (sh && (sh.type === 'rect' || sh.type === 'circle') && (S.tool === 'rect' || S.tool === 'circle' || S.tool === 'select')) {
        saveSnapshot()
        sh.fill = S.rectFill
        renderObjects()
      }
    })
  }

  /** 图层顺序调节按钮（上移/下移/置顶/置底） */
  function bindLayerOrderButtons() {
    // 图层顺序调节
    runtime.el.querySelectorAll('.iwb-editor-layer-btn').forEach(btn => {
      btn.addEventListener('mousedown', (e) => e.stopPropagation())
      btn.addEventListener('click', () => moveLayer(btn.dataset.layer))
    })
  }

  /** 笔触粗细：预设按钮 + 滑杆 + 数值输入框双向同步 */
  function bindBrushSizeControls() {
    // 笔触（滑杆 + 数值输入框双向同步）
    const slider = runtime.el.querySelector('.iwb-editor-brush-size')
    const brushNum = runtime.el.querySelector('.iwb-editor-brush-num')
    let lwHistoryPushed = false
    const syncBrushSize = (value, continuous) => {
      const v = clamp(parseInt(value, 10) || 1, 1, 300)
      S.brushSize = v
      slider.value = v
      if (brushNum && document.activeElement !== brushNum) brushNum.value = v
      // 选中形状（矩形/圆形/箭头/钢笔）时同步更新描边粗细
      const sh = getSelectedShape()
      if (sh && !sh.locked && sh.lw !== v) {
        if (!continuous || !lwHistoryPushed) { saveSnapshot(); lwHistoryPushed = true }
        sh.lw = v
        renderObjects()
        renderLayerPanel()
      }
      if (!continuous) lwHistoryPushed = false
    }
    runtime.el.querySelectorAll('.iwb-editor-brush-preset').forEach(btn => {
      btn.addEventListener('mousedown', (e) => e.stopPropagation())
      btn.addEventListener('click', () => syncBrushSize(btn.dataset.brushSize, false))
    })
    slider && slider.addEventListener('input', () => syncBrushSize(slider.value, true))
    slider && slider.addEventListener('change', () => syncBrushSize(slider.value, false))
    if (brushNum) {
      brushNum.addEventListener('mousedown', (e) => e.stopPropagation())
      brushNum.addEventListener('input', () => {
        const v = clamp(parseInt(brushNum.value, 10) || 1, 1, 300)
        syncBrushSize(v, true)
      })
      brushNum.addEventListener('blur', () => { brushNum.value = S.brushSize; lwHistoryPushed = false })
    }
  }

  /** 画笔硬度与透明度滑杆 */
  function bindBrushParams() {
    // 画笔硬度
    const hardnessSlider = runtime.el.querySelector('.iwb-editor-brush-hardness')
    hardnessSlider && hardnessSlider.addEventListener('input', () => {
      S.brushHardness = parseInt(hardnessSlider.value, 10)
      runtime.el.querySelector('.iwb-editor-brush-hardness-val').textContent = S.brushHardness
    })

    // 画笔透明度
    const opacitySlider = runtime.el.querySelector('.iwb-editor-brush-opacity')
    opacitySlider && opacitySlider.addEventListener('input', () => {
      S.brushOpacity = parseInt(opacitySlider.value, 10) / 100
      runtime.el.querySelector('.iwb-editor-brush-opacity-val').textContent = opacitySlider.value + '%'
      if (S.strokeCanvas) S.strokeCanvas.style.opacity = S.brushOpacity
    })
  }

  /** 缩放按钮：缩小 / 放大 / 适应窗口 */
  function bindZoomButtons() {
    // 缩放按钮
    bindIf('[data-action="zoomOut"]', 'click', (e) => {
      e.stopPropagation()
      zoomStep(1 / ZOOM_STEP, S.canvasWrap.clientWidth / 2, S.canvasWrap.clientHeight / 2)
    })
    bindIf('[data-action="zoomIn"]', 'click', (e) => {
      e.stopPropagation()
      zoomStep(ZOOM_STEP, S.canvasWrap.clientWidth / 2, S.canvasWrap.clientHeight / 2)
    })
    bindIf('[data-action="zoomFit"]', 'click', (e) => {
      e.stopPropagation()
      setZoomFit()
    })
  }

  /** 撤销 / 重做 / 重置 / 复原 */
  function bindHistoryActions() {
    // 撤销/重做/重置/复原
    const undoBtn = runtime.el.querySelector('[data-action="undo"]')
    const redoBtn = runtime.el.querySelector('[data-action="redo"]')
    const resetBtn = runtime.el.querySelector('[data-action="reset"]')
    const restoreBtn = runtime.el.querySelector('[data-action="restore"]')
    undoBtn && undoBtn.addEventListener('mousedown', (e) => e.stopPropagation())
    redoBtn && redoBtn.addEventListener('mousedown', (e) => e.stopPropagation())
    resetBtn && resetBtn.addEventListener('mousedown', (e) => e.stopPropagation())
    restoreBtn && restoreBtn.addEventListener('mousedown', (e) => e.stopPropagation())
    undoBtn && undoBtn.addEventListener('click', undo)
    redoBtn && redoBtn.addEventListener('click', redo)
    resetBtn && resetBtn.addEventListener('click', resetDraw)
    restoreBtn && restoreBtn.addEventListener('click', restoreOriginal)
  }

  /** 裁剪确认 / 取消按钮 */
  function bindCropActions() {
    // 裁剪
    bindIf('[data-action="confirmCrop"]', 'click', confirmCrop)
    bindIf('[data-action="cancelCrop"]', 'click', cancelCrop)
  }

  /** 添加位图图层（导入图片）与新建空白图层 */
  function bindLayerAddActions() {
    // 添加位图图层（导入图片）
    bindIf('[data-action="addBitmapLayer"]', 'mousedown', (e) => e.stopPropagation())
    bindIf('[data-action="addBitmapLayer"]', 'click', () => {
      const fileInput = document.createElement('input')
      fileInput.type = 'file'
      fileInput.accept = 'image/*'
      fileInput.addEventListener('change', async () => {
        const file = fileInput.files[0]
        if (!file) return
        const reader = new FileReader()
        reader.onload = async () => {
          try {
            const img = await loadImage(reader.result)
            addBitmapLayer(img)
          } catch (err) {
            console.error('[IWB编辑器] 导入图层失败:', err)
          }
        }
        reader.readAsDataURL(file)
      })
      fileInput.click()
    })

    // 新建空白图层
    bindIf('[data-action="addBlankLayer"]', 'mousedown', (e) => e.stopPropagation())
    bindIf('[data-action="addBlankLayer"]', 'click', () => {
      addBlankLayer()
    })
  }

  /** 底部动作：关闭 / 作为新节点 / 替换（导出入口） */
  function bindExportActions() {
    // 底部
    bindIf('[data-action="cancel"]', 'click', close)
    bindIf('[data-action="newNode"]', 'click', () => exportResult('newNode'))
    bindIf('[data-action="replace"]', 'click', () => exportResult('replace'))
  }

  /** 滚轮缩放：绑定在画布容器上（非 passive，需要 preventDefault） */
  function bindWheelZoom() {
    // canvas 事件绑定到第一个位图图层（初始时还没有图层，延迟绑定）
    // 实际在 setupCanvas 后调用 bindCanvasEvents
    // 滚轮缩放
    S.canvasWrap.addEventListener('wheel', onWheel, { passive: false })
  }

  /** 文字输入框：Enter 提交、Esc 取消 */
  function bindTextInput() {
    // 文字输入
    const textInput = runtime.el.querySelector('.iwb-editor-text-input')
    textInput && textInput.addEventListener('mousedown', (e) => e.stopPropagation())
    textInput && textInput.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') { e.preventDefault(); commitTextInput() }
      else if (e.key === 'Escape') { e.preventDefault(); hideTextInput() }
    })
  }

  /** 全局监听：键盘快捷键、窗口失焦、modal 内阻止冒泡 */
  function bindGlobalListeners() {
    // 键盘快捷键
    document.addEventListener('keydown', onKeydown, true)
    document.addEventListener('keyup', onKeyup, true)

    // 窗口失焦
    window.addEventListener('blur', () => {
      if (S.spaceDown) { S.spaceDown = false; updateCursor() }
      if (S.panning) { S.panning = false; S.panStart = null; updateCursor() }
      S._shiftDown = false
    })

    // 阻止 modal 内部点击冒泡
    bindIf('.iwb-editor-modal', 'mousedown', (e) => e.stopPropagation())
  }

  function commitPenPath() {
    if (!S.penPath || S.penPath.pts.length < 2) { S.penPath = null; renderObjects(); return }
    saveSnapshot()
    const shape = { id: 's' + Date.now() + Math.floor(Math.random() * 1000), type: 'pen', pts: S.penPath.pts.slice(), closed: !!S.penPath.closed, color: S.color, lw: Math.max(2, S.brushSize), fill: !!S.penPath.closed, opacity: 1, visible: true, locked: false, z: ++S.zCounter }
    S.shapeLayers.push(shape); S.selectedShapeId = shape.id; S.penPath = null; renderObjects(); renderLayerPanel()
  }

  /** 将 canvas 鼠标事件绑定到活跃图层 canvas（在 setupCanvas 后调用，仅绑定一次） */
  export function bindCanvasEvents() {
    if (S._canvasEventsBound) return
    S._canvasEventsBound = true
    // 所有位图图层 canvas 共享同一组事件处理器
    // 使用事件委托：在 canvasStack 上监听
    S.canvasStack.addEventListener('mousedown', onMouseDown)
    S.canvasStack.addEventListener('mousemove', onMouseMove)
    S.canvasStack.addEventListener('mousemove', onCanvasHover)
    window.addEventListener('mouseup', onMouseUp)
    S.canvasStack.addEventListener('contextmenu', (e) => e.preventDefault())
    S.canvasStack.addEventListener('mouseleave', () => {
      if (S.placingImage) return
      if ((S.tool === 'brush' || S.tool === 'eraser') && !S.isDrawing) clearOverlay()
      if (S.tool === 'picker') hidePickerTip()
    })

    // 双击文字 → 重新编辑内容；双击钢笔形状 → 进入节点编辑
    S.canvasStack.addEventListener('dblclick', (e) => {
      if (S.placingImage) return
      const pos = getPos(e)
      if (S.tool === 'pen' && S.penPath) { commitPenPath(); return }
      if (S.tool === 'select' || S.tool === 'pen') {
        const penShape = getPenEditingShape()
        if (penShape) {
          // 双击节点 → 删除节点
          const pi = hitPenPoint(pos, penShape, Math.max(14 / S.zoom, 8))
          if (pi >= 0) {
            e.preventDefault()
            saveSnapshot()
            const pts = penShape.pts
            const minPts = penShape.closed ? 3 : 2
            if (pts.length <= minPts) {
              removeVecCanvas(penShape)
              S.shapeLayers = S.shapeLayers.filter(x => x.id !== penShape.id)
              S.penEditId = null
              S.selectedShapeId = null
            } else {
              pts.splice(pi, 1)
              if (penShape.closed && pts.length < 3) penShape.closed = false
            }
            renderObjects()
            renderLayerPanel()
            return
          }
          return // 正在编辑：避免误触发新建文字
        }
        // 未在编辑：双击命中钢笔形状进入编辑
        const hitPen = hitShapeLayer(pos, true)
        if (hitPen && hitPen.type === 'pen') { e.preventDefault(); beginPenEdit(hitPen); return }
      }
       if (S.tool !== 'text' && S.tool !== 'select') return
      const hit = hitTextLayer(pos)
      if (hit) {
        S.selectedTextId = hit.id
        if (hit.locked) return
        renderObjects()
        showTextInput(hit.x, hit.y, hit)
      }
    })
  }

  // 裁剪手柄 hover 光标
  const CROP_CURSORS = {
    nw: 'nwse-resize', se: 'nwse-resize',
    ne: 'nesw-resize', sw: 'nesw-resize',
    n: 'ns-resize', s: 'ns-resize',
    e: 'ew-resize', w: 'ew-resize'
  }

  function onCanvasHover(e) {
    if (S.placingImage) return
    if (S.panning || S.spaceDown) return
    if (S.isDrawing || S.textDrag || S.shapeDrag) return
    const p = getPos(e)
    if (isOverRotationHandle(p)) { S.drawCanvasCursor(ROT_CURSOR); return }
    if (S.tool === 'select') {
      const th = hitTextHandle(p)
      if (th) { S.drawCanvasCursor((th === 'nw' || th === 'se') ? 'nwse-resize' : 'nesw-resize'); return }
      const shh = hitShapeHandle(p)
      if (shh) {
        const sh = getSelectedShape()
        if (sh && sh.type === 'rect' && CROP_CURSORS[shh]) S.drawCanvasCursor(CROP_CURSORS[shh])
        else S.drawCanvasCursor('move')
        return
      }
      S.drawCanvasCursor(hitAnyObject(p) ? 'move' : 'default')
      return
    }
    if (S.tool === 'picker') {
      S.drawCanvasCursor('crosshair')
      showPickerTip(e, sampleColor(p))
      return
    }
    if (S.tool === 'hand') { S.drawCanvasCursor('grab'); return }
    if (S.tool === 'brush' || S.tool === 'eraser') {
      S.drawCanvasCursor('none')
      drawToolRing(p)
      return
    }
    if (S.tool === 'crop') {
      if (S.cropRect) {
        const h = hitCropHandle(p)
        if (h && CROP_CURSORS[h]) { S.drawCanvasCursor(CROP_CURSORS[h]); return }
        if (insideRect(p, S.cropRect)) { S.drawCanvasCursor('move'); return }
      }
      S.drawCanvasCursor('crosshair')
      return
    }
    if (S.tool === 'text') {
      const h = hitTextHandle(p)
      if (h) { S.drawCanvasCursor((h === 'nw' || h === 'se') ? 'nwse-resize' : 'nesw-resize'); return }
      S.drawCanvasCursor(hitTextLayer(p) ? 'move' : 'text')
      return
    }
    if (S.tool === 'pen') { S.drawCanvasCursor('crosshair'); return }
    if (S.tool === 'rect' || S.tool === 'arrow' || S.tool === 'circle') {
      const h = hitShapeHandle(p)
      if (h) {
        const sh = getSelectedShape()
        if (sh && sh.type === 'rect' && CROP_CURSORS[h]) S.drawCanvasCursor(CROP_CURSORS[h])
        else S.drawCanvasCursor('move')
        return
      }
      S.drawCanvasCursor('crosshair')
      return
    }
    S.drawCanvasCursor('crosshair')
  }

  function isTyping(e) {
    const t = e.target
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')
  }

  function onKeydown(e) {
    if (!S.open) return
    // 图片放置模式
    if (S.placingImage) {
      if (e.key === 'Enter') { e.preventDefault(); confirmImagePlacement(); return }
      if (e.key === 'Escape') { e.preventDefault(); cancelImagePlacement(); return }
    }
    if (e.key === 'Shift') S._shiftDown = true
    if (e.key === 'Enter' && S.tool === 'pen' && S.penPath) { e.preventDefault(); commitPenPath(); return }
    if (e.key === 'Escape') {
      if (isTyping(e)) { hideTextInput(); return }
      if (S.penPath) { e.preventDefault(); S.penPath = null; renderObjects(); return }
      if (getPenEditingShape()) { e.preventDefault(); exitPenEdit(); return }
      if (S.selectedLayerId || S.selectedTextId || S.selectedShapeId || S.bitmapDrag || S.textDrag || S.shapeDrag) {
        e.preventDefault()
        clearSelection()
        renderObjects()
        renderLayerPanel()
      }
      return
    }
    if (isTyping(e)) return
    const toolByKey = { '1': 'select', '2': 'brush', '3': 'eraser', '4': 'pen', '5': 'text', '6': 'rect', '7': 'circle', '8': 'arrow', '9': 'picker', '0': 'crop' }
    if (!e.ctrlKey && !e.metaKey && !e.altKey && Object.prototype.hasOwnProperty.call(toolByKey, e.key)) {
      e.preventDefault()
      setTool(toolByKey[e.key])
      return
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (S.selectedTextId) { e.preventDefault(); deleteSelectedText(); renderLayerPanel(); return }
      if (S.selectedShapeId) { e.preventDefault(); deleteSelectedShape(); renderLayerPanel(); return }
    }
    if (e.code === 'Space') {
      e.preventDefault()
      if (!S.spaceDown) { S.spaceDown = true; updateCursor() }
      return
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === ']' || e.key === '[')) {
      e.preventDefault()
      const up = e.key === ']'
      moveLayer(e.shiftKey ? (up ? 'top' : 'bottom') : (up ? 'up' : 'down'))
      return
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
      e.preventDefault()
      if (e.shiftKey) redo(); else undo()
    }
  }

  function onKeyup(e) {
    if (e.key === 'Shift') S._shiftDown = false
    if (e.code === 'Space' && S.spaceDown) {
      S.spaceDown = false
      updateCursor()
    }
  }
