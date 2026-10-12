(() => {
  // iwb-cutout-extension/src/editor/state.js
  var ZOOM_MIN = 0.1;
  var ZOOM_MAX = 10;
  var ZOOM_STEP = 1.15;
  var S = {
    open: false,
    tool: "brush",
    color: "#ff4444",
    brushSize: 3,
    brushHardness: 100,
    // 画笔硬度 0~100：100=硬边描边，<100=径向渐变软边章
    brushOpacity: 1,
    // 画笔透明度 0.05~1（一笔整体透明度，笔划内不叠加）
    prevTool: null,
    // 吸管工具激活前的工具（取色后切回）
    pickerComposite: null,
    // 吸管取样用的合成画布缓存（切工具/画布变化时失效）
    rectFill: false,
    // 矩形是否实心填充
    // 图层系统
    layers: [],
    // 位图图层数组 [{ id, name, canvas, ctx, opacity, visible, z }]
    activeLayerId: null,
    // 当前活跃位图图层 ID（画笔/橡皮操作目标）
    // 画布引用（动态创建的 canvas 元素）
    canvasWrap: null,
    canvasStack: null,
    textCanvas: null,
    strokeCanvas: null,
    overlayCanvas: null,
    textCtx: null,
    strokeCtx: null,
    overlayCtx: null,
    isDrawing: false,
    panning: false,
    panStart: null,
    startX: 0,
    startY: 0,
    history: [],
    redoStack: [],
    cropRect: null,
    cropHandle: null,
    cropMoving: false,
    moveStart: null,
    cropConstraint: { type: "free", ratio: 0, sizeW: 0, sizeH: 0 },
    // 文字图层（独立对象，可选中/移动/缩放/再编辑）
    textLayers: [],
    // [{ id, x, y, text, color, fontSize, opacity, visible, z }]
    selectedTextId: null,
    textDrag: null,
    // { mode:'move'|'scale', start:{x,y}, layer:{x,y}, fontSize, baseX }
    textEditingId: null,
    selectedLayerId: null,
    // 选择工具当前选中的可编辑位图图层
    bitmapDrag: null,
    // { mode:'move'|'scale', handle, start, layer, pending }
    // 形状图层（矩形/箭头，独立对象，可选中/移动/调手柄）
    shapeLayers: [],
    // [{ id, type:'rect'|'arrow', x1,y1,x2,y2, color, lw, fill, opacity, visible, z }]
    selectedShapeId: null,
    shapeDrag: null,
    // { mode:'move'|'handle', handle, start:{x,y}, shape:{...}, pending }
    penPath: null,
    // 钢笔绘制中的点序列与预览点
    penEditId: null,
    // 钢笔二次编辑中的形状 id
    penDragPt: -1,
    // 正在拖动的节点下标（-1=无）
    penDragBase: null,
    penDragPending: null,
    zCounter: 0,
    // 全局 z 序计数器（文字与形状统一排序）
    // 图片放置中状态（导入图片时先调整大小/位置再确认）
    placingImage: null,
    // { img, x, y, w, h } 图片坐标
    placingHandle: null,
    // 'move' | 'nw'|'ne'|'sw'|'se'|'n'|'s'|'e'|'w'
    placingStart: null,
    // { mx, my, x, y, w, h }
    imgW: 0,
    imgH: 0,
    overlayPad: 0,
    originalImage: null,
    // 打开时的原始图片，用于「复原」
    fitW: 0,
    fitH: 0,
    // 适应容器时的基准显示尺寸
    zoom: 1,
    // 缩放倍率（基于 fit）
    viewX: null,
    // 画布平移位置（wrap 内 left；null = 居中显示）
    viewY: null,
    callbacks: null,
    spaceDown: false,
    _shiftDown: false,
    _canvasEventsBound: false
  };
  var runtime = { el: null };

  // iwb-cutout-extension/src/editor/placement.js
  function startImagePlacement(img) {
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    const maxW = S.imgW * 0.5;
    const maxH = S.imgH * 0.5;
    const ratio = Math.min(maxW / iw, maxH / ih, 1);
    let w = Math.round(iw * ratio);
    let h = Math.round(ih * ratio);
    if (w < 10) w = 10;
    if (h < 10) h = 10;
    const x = Math.round((S.imgW - w) / 2);
    const y = Math.round((S.imgH - h) / 2);
    S.placingImage = { img, x, y, w, h, rotation: 0 };
    S.placingHandle = null;
    S.placingStart = null;
    S.drawCanvasCursor("move");
    drawPlacementPreview();
  }
  function confirmImagePlacement() {
    if (!S.placingImage) return;
    const { img, x, y, w, h } = S.placingImage;
    const placementRotation = S.placingImage.rotation || 0;
    S.placingImage = null;
    S.placingHandle = null;
    S.placingStart = null;
    clearOverlay();
    const id = "L" + Date.now() + Math.floor(Math.random() * 1e3);
    const canvas = createLayerCanvas();
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.clearRect(0, 0, S.imgW, S.imgH);
    const layer = {
      id,
      name: "\u56FE\u5C42 " + (S.layers.length + 1),
      image: img,
      x,
      y,
      w,
      h,
      rotation: placementRotation,
      transformable: true,
      canvas,
      ctx,
      opacity: 1,
      visible: true,
      locked: false,
      z: S.layers.length
    };
    redrawBitmapLayer(layer);
    saveSnapshot();
    S.layers.push(layer);
    reorderLayerCanvas();
    setActiveLayer(id);
    updateLayerCanvasStyles();
    renderLayerPanel();
    updateCursor();
  }
  function cancelImagePlacement() {
    S.placingImage = null;
    S.placingHandle = null;
    S.placingStart = null;
    clearOverlay();
    updateCursor();
  }
  function drawPlacementPreview() {
    if (!S.placingImage) return;
    const ctx = S.overlayCtx;
    const { img, x, y, w, h } = S.placingImage;
    const rot = S.placingImage.rotation || 0;
    const cx = x + w / 2, cy = y + h / 2;
    clearOverlay();
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(0, 0, S.imgW, S.imgH);
    ctx.restore();
    ctx.save();
    ctx.translate(cx, cy);
    if (rot) ctx.rotate(rot * Math.PI / 180);
    ctx.translate(-cx, -cy);
    ctx.drawImage(img, x, y, w, h);
    ctx.restore();
    const corners = boxCorners(x, y, w, h, rot);
    ctx.save();
    ctx.strokeStyle = "#4488ff";
    ctx.lineWidth = 2 / S.zoom;
    ctx.setLineDash([8 / S.zoom, 4 / S.zoom]);
    ctx.beginPath();
    ctx.moveTo(corners[0][0], corners[0][1]);
    for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i][0], corners[i][1]);
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    const hs = 8 / S.zoom;
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "#4488ff";
    ctx.lineWidth = 1.5 / S.zoom;
    const localPts = {
      nw: [x, y],
      ne: [x + w, y],
      sw: [x, y + h],
      se: [x + w, y + h],
      n: [x + w / 2, y],
      s: [x + w / 2, y + h],
      e: [x + w, y + h / 2],
      w: [x, y + h / 2]
    };
    for (const name in localPts) {
      const ptp = rotPt(localPts[name][0], localPts[name][1], cx, cy, rot);
      ctx.beginPath();
      ctx.rect(ptp[0] - hs, ptp[1] - hs, hs * 2, hs * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
    drawRotationHandles(ctx, { x, y, w, h }, rot);
    ctx.save();
    ctx.font = "bold " + Math.round(14 / S.zoom) + "px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const hintText = "\u62D6\u62FD\u624B\u67C4\u8C03\u6574\u5927\u5C0F \xB7 \u5706\u70B9=\u65CB\u8F6C \xB7 Shift=\u7B49\u6BD4/15\xB0\u5438\u9644 \xB7 Enter=\u786E\u8BA4 \xB7 Esc=\u53D6\u6D88";
    const br = boxCorners(x, y, w, h, rot).reduce((acc, pt) => Math.max(acc, pt[1]), -Infinity);
    const hintY = br + 10 / S.zoom;
    const tw = ctx.measureText(hintText).width;
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(cx - tw / 2 - 6 / S.zoom, hintY, tw + 12 / S.zoom, 22 / S.zoom);
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.fillText(hintText, cx, hintY + 4 / S.zoom);
    ctx.restore();
  }
  function hitPlacementHandle(pos) {
    if (!S.placingImage) return null;
    const { x, y, w, h } = S.placingImage;
    const rot = S.placingImage.rotation || 0;
    const cx = x + w / 2, cy = y + h / 2;
    const lp = unrotPt(pos.x, pos.y, cx, cy, rot);
    const R = 12 / S.zoom;
    if (hitRotationHandle(lp, { x, y, w, h })) return "rotate";
    const pts = {
      nw: [x, y],
      ne: [x + w, y],
      sw: [x, y + h],
      se: [x + w, y + h],
      n: [x + w / 2, y],
      s: [x + w / 2, y + h],
      e: [x + w, y + h / 2],
      w: [x, y + h / 2]
    };
    let best = null, bestDist = 1e9;
    for (const name in pts) {
      const dx = lp[0] - pts[name][0], dy = lp[1] - pts[name][1];
      const d = dx * dx + dy * dy;
      if (d < R * R && d < bestDist) {
        bestDist = d;
        best = name;
      }
    }
    return best;
  }
  function insidePlacementRect(pos) {
    if (!S.placingImage) return false;
    const { x, y, w, h } = S.placingImage;
    const rot = S.placingImage.rotation || 0;
    const cx = x + w / 2, cy = y + h / 2;
    const lp = unrotPt(pos.x, pos.y, cx, cy, rot);
    return lp[0] >= x && lp[0] <= x + w && lp[1] >= y && lp[1] <= y + h;
  }
  function resizePlacement(pos) {
    if (!S.placingImage || !S.placingHandle || !S.placingStart) return;
    const { img } = S.placingImage;
    const s = S.placingStart;
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    const aspect = iw / ih;
    const hh = S.placingHandle;
    if (hh === "move") {
      const dx = pos.x - s.mx;
      const dy = pos.y - s.my;
      S.placingImage.x = s.x + dx;
      S.placingImage.y = s.y + dy;
      return;
    }
    if (hh === "rotate") {
      const rcx = s.x + s.w / 2, rcy = s.y + s.h / 2;
      const a0 = Math.atan2(s.my - rcy, s.mx - rcx);
      const a1 = Math.atan2(pos.y - rcy, pos.x - rcx);
      let deg = (s.rotation || 0) + (a1 - a0) * 180 / Math.PI;
      if (S._shiftDown) deg = Math.round(deg / 15) * 15;
      S.placingImage.rotation = deg;
      return;
    }
    const loc = unrotPt(pos.x, pos.y, s.x + s.w / 2, s.y + s.h / 2, s.rotation || 0);
    pos = { x: loc[0], y: loc[1] };
    let nx = s.x, ny = s.y, nw = s.w, nh = s.h;
    if (hh.includes("e")) nw = Math.max(10, pos.x - s.x);
    if (hh.includes("s")) nh = Math.max(10, pos.y - s.y);
    if (hh.includes("w")) {
      const r = s.x + s.w;
      nx = Math.min(pos.x, r - 10);
      nw = r - nx;
    }
    if (hh.includes("n")) {
      const b = s.y + s.h;
      ny = Math.min(pos.y, b - 10);
      nh = b - ny;
    }
    if (S._shiftDown) {
      if (nw / nh > aspect) {
        if (hh.includes("n") || hh.includes("s")) {
          nw = nh * aspect;
          if (hh.includes("w")) nx = s.x + s.w - nw;
        } else {
          nh = nw / aspect;
          if (hh.includes("n")) ny = s.y + s.h - nh;
        }
      } else {
        if (hh.includes("e") || hh.includes("w")) {
          nh = nw / aspect;
          if (hh.includes("n")) ny = s.y + s.h - nh;
        } else {
          nw = nh * aspect;
          if (hh.includes("w")) nx = s.x + s.w - nw;
        }
      }
    }
    S.placingImage.x = nx;
    S.placingImage.y = ny;
    S.placingImage.w = nw;
    S.placingImage.h = nh;
  }

  // iwb-cutout-extension/src/shared/layer-logic.js
  function isDrawableLayer(layer) {
    return !!layer && layer.id !== "base" && !layer.image;
  }
  function restorePath(layer) {
    if (!layer) return "pixels";
    const sourceCanvas = isDrawableLayer(layer) ? null : layer.sourceCanvas;
    if (layer.transformable && (layer.image || sourceCanvas)) return "redraw";
    return "pixels";
  }
  function needsPixelSnapshot(layer) {
    return restorePath(layer) === "pixels";
  }

  // iwb-cutout-extension/src/editor/layers.js
  function createLayerCanvas() {
    const c = document.createElement("canvas");
    c.className = "iwb-editor-layer-canvas";
    c.width = S.imgW;
    c.height = S.imgH;
    c.style.position = "absolute";
    c.style.top = "0";
    c.style.left = "0";
    c.style.display = "block";
    S.canvasStack.insertBefore(c, S.strokeCanvas);
    return c;
  }
  function reorderLayerCanvas() {
    const units = [];
    for (const l of S.layers) units.push({ z: l.z, el: l.canvas, vis: l.visible });
    for (const { obj } of allObjects()) if (obj._canvas) units.push({ z: obj.z || 0, el: obj._canvas, vis: obj.visible !== false });
    units.sort((a, b) => a.z - b.z);
    for (const u of units) {
      if (!u.el) continue;
      S.canvasStack.insertBefore(u.el, S.strokeCanvas);
      u.el.style.display = u.vis ? "block" : "none";
    }
  }
  function getActiveLayer() {
    return S.layers.find((l) => l.id === S.activeLayerId) || null;
  }
  function getActiveCtx() {
    const layer = getActiveLayer();
    return layer && !layer.locked ? layer.ctx : null;
  }
  function clearSelection({ keepBitmap = false } = {}) {
    if (!keepBitmap) S.selectedLayerId = null;
    S.selectedTextId = null;
    S.selectedShapeId = null;
    S.textDrag = null;
    S.shapeDrag = null;
    S.bitmapDrag = null;
  }
  function resolveSourceBox(layer) {
    if (layer._srcBox && layer.sourceCanvas) {
      const b = layer._srcBox;
      return { src: layer.sourceCanvas, box: b };
    }
    if (layer.image && layer.w > 0 && layer.h > 0) return { src: layer.image, box: null };
    if (layer.sourceCanvas && layer.w > 0 && layer.h > 0) return { src: layer.sourceCanvas, box: null };
    return null;
  }
  function paintTransformed(layer, source) {
    const rot = layer.rotation || 0;
    const cx = layer.x + layer.w / 2, cy = layer.y + layer.h / 2;
    layer.ctx.save();
    if (rot) {
      layer.ctx.translate(cx, cy);
      layer.ctx.rotate(rot * Math.PI / 180);
      layer.ctx.translate(-cx, -cy);
    }
    if (source) {
      if (source.box) {
        const b = source.box;
        layer.ctx.drawImage(source.src, b.x, b.y, b.w, b.h, layer.x, layer.y, layer.w, layer.h);
      } else {
        layer.ctx.drawImage(source.src, layer.x, layer.y, layer.w, layer.h);
      }
    }
    layer.ctx.restore();
  }
  function redrawBitmapLayer(layer) {
    if (!layer || !layer.ctx) return;
    layer.ctx.clearRect(0, 0, S.imgW, S.imgH);
    paintTransformed(layer, resolveSourceBox(layer));
  }
  function hitBitmapHandle(pos) {
    const layer = S.layers.find((l) => l.id === S.selectedLayerId && (l.transformable || isDrawableLayer(l)));
    if (!layer || layer.visible === false) return null;
    const box = layerFrame(layer);
    if (!(box.w > 0 && box.h > 0)) return null;
    const rot = layer.rotation || 0;
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    const lp = unrotPt(pos.x, pos.y, cx, cy, rot);
    const R = 14 / S.zoom;
    if (hitRotationHandle(lp, box)) return "rotate";
    const points = {
      nw: [box.x, box.y],
      ne: [box.x + box.w, box.y],
      sw: [box.x, box.y + box.h],
      se: [box.x + box.w, box.y + box.h],
      n: [box.x + box.w / 2, box.y],
      s: [box.x + box.w / 2, box.y + box.h],
      e: [box.x + box.w, box.y + box.h / 2],
      w: [box.x, box.y + box.h / 2]
    };
    let hit = null, best = Infinity;
    for (const name in points) {
      const distance = Math.hypot(lp[0] - points[name][0], lp[1] - points[name][1]);
      if (distance < R && distance < best) {
        best = distance;
        hit = name;
      }
    }
    return hit;
  }
  function layerBounds(layer) {
    if (!layer || !layer.ctx || !layer.canvas) return null;
    if (layer._bounds !== void 0) return layer._bounds;
    let b = null;
    try {
      const w = layer.canvas.width, h = layer.canvas.height;
      const data = layer.ctx.getImageData(0, 0, w, h).data;
      let minX = w, minY = h, maxX = -1, maxY = -1;
      for (let y = 0; y < h; y += 2) {
        for (let x = 0; x < w; x += 2) {
          if (data[(y * w + x) * 4 + 3] > 8) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX >= 0) b = { x: minX, y: minY, w: maxX - minX + 2, h: maxY - minY + 2 };
    } catch (e) {
      b = null;
    }
    layer._bounds = b;
    return b;
  }
  function layerFrame(layer) {
    if (isDrawableLayer(layer) && !layer._srcBox) {
      const b = layerBounds(layer);
      if (b) return b;
    }
    return { x: layer.x, y: layer.y, w: layer.w, h: layer.h };
  }
  function hitBitmapLayer(pos) {
    const layers = [...S.layers].sort((a, b) => (a.z || 0) - (b.z || 0));
    const hitRect = (layer) => {
      if (!(layer.w > 0 && layer.h > 0)) return false;
      const rot = layer.rotation || 0;
      const lp = rot ? unrotPt(pos.x, pos.y, layer.x + layer.w / 2, layer.y + layer.h / 2, rot) : [pos.x, pos.y];
      return lp[0] >= layer.x && lp[0] <= layer.x + layer.w && lp[1] >= layer.y && lp[1] <= layer.y + layer.h;
    };
    const usable = (layer) => layer && layer.visible !== false && !layer.locked;
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i];
      if (!usable(layer)) continue;
      if (!isDrawableLayer(layer)) continue;
      if (!hitRect(layer)) continue;
      const rot = layer.rotation || 0;
      const lp = rot ? unrotPt(pos.x, pos.y, layer.x + layer.w / 2, layer.y + layer.h / 2, rot) : [pos.x, pos.y];
      const px = Math.round(lp[0]), py = Math.round(lp[1]);
      if (px < 0 || py < 0 || px >= layer.canvas.width || py >= layer.canvas.height) continue;
      try {
        const d = layer.ctx.getImageData(px, py, 1, 1).data;
        if (d[3] > 8) return layer;
      } catch (e) {
        return layer;
      }
    }
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i];
      if (!usable(layer) || !layer.transformable) continue;
      if (hitRect(layer)) return layer;
    }
    return null;
  }
  function drawBitmapSelection(layer) {
    if (!layer) return;
    const drawable = isDrawableLayer(layer);
    if (!layer.transformable && !drawable) return;
    const box = layerFrame(layer);
    if (!(box.w > 0 && box.h > 0)) return;
    const ctx = S.overlayCtx;
    const rot = layer.rotation || 0;
    const hs = 7 / S.zoom;
    ctx.save();
    ctx.strokeStyle = "#e8a735";
    ctx.lineWidth = 1.5 / S.zoom;
    ctx.setLineDash([6 / S.zoom, 3 / S.zoom]);
    const corners = boxCorners(box.x, box.y, box.w, box.h, rot);
    ctx.beginPath();
    ctx.moveTo(corners[0][0], corners[0][1]);
    for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i][0], corners[i][1]);
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "#e8a735";
    const pts = frameHandlePoints(box, rot);
    for (const name in pts) {
      ctx.beginPath();
      ctx.rect(pts[name][0] - hs, pts[name][1] - hs, hs * 2, hs * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
    drawRotationHandles(ctx, box, rot);
  }
  function frameHandlePoints(box, rot) {
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    const local = {
      nw: [box.x, box.y],
      ne: [box.x + box.w, box.y],
      sw: [box.x, box.y + box.h],
      se: [box.x + box.w, box.y + box.h],
      n: [box.x + box.w / 2, box.y],
      s: [box.x + box.w / 2, box.y + box.h],
      e: [box.x + box.w, box.y + box.h / 2],
      w: [box.x, box.y + box.h / 2]
    };
    const out = {};
    for (const k in local) out[k] = rotPt(local[k][0], local[k][1], cx, cy, rot || 0);
    return out;
  }
  function beginBitmapDrag(handle, pos) {
    const layer = S.layers.find((l) => l.id === S.selectedLayerId);
    if (!layer || layer.locked) return;
    const drawable = isDrawableLayer(layer);
    if (!layer.transformable && !drawable) return;
    if (drawable) {
      if (!layer.sourceCanvas) {
        const sc = document.createElement("canvas");
        sc.width = S.imgW;
        sc.height = S.imgH;
        sc.getContext("2d").drawImage(layer.canvas, 0, 0);
        layer.sourceCanvas = sc;
      }
      if (!layer._srcBox) {
        const b = layerBounds(layer) || { x: layer.x, y: layer.y, w: layer.w, h: layer.h };
        layer._srcBox = { x: b.x, y: b.y, w: b.w, h: b.h };
        layer.x = b.x;
        layer.y = b.y;
        layer.w = b.w;
        layer.h = b.h;
        layer.rotation = layer.rotation || 0;
      }
    }
    const frame = layerFrame(layer);
    S.bitmapDrag = {
      mode: handle === "rotate" ? "rotate" : handle ? "scale" : "move",
      handle,
      start: pos,
      drawable: isDrawableLayer(layer),
      layer: { x: layer.x, y: layer.y, w: layer.w, h: layer.h, rotation: layer.rotation || 0 },
      frame: { x: frame.x, y: frame.y, w: frame.w, h: frame.h },
      pending: snapshotState()
    };
  }
  function applyBitmapDrag(pos) {
    const drag = S.bitmapDrag;
    const layer = S.layers.find((l) => l.id === S.selectedLayerId);
    if (!drag || !layer) return;
    const base = drag.layer;
    if (drag.mode === "move") {
      layer.x = base.x + pos.x - drag.start.x;
      layer.y = base.y + pos.y - drag.start.y;
      if (isDrawableLayer(layer)) layer._bounds = void 0;
    } else if (drag.mode === "rotate") {
      const rcx = base.x + base.w / 2, rcy = base.y + base.h / 2;
      const a0 = Math.atan2(drag.start.y - rcy, drag.start.x - rcx);
      const a1 = Math.atan2(pos.y - rcy, pos.x - rcx);
      let deg = (base.rotation || 0) + (a1 - a0) * 180 / Math.PI;
      if (S._shiftDown) deg = Math.round(deg / 15) * 15;
      layer.rotation = deg;
    } else {
      const lpos = unrotPt(pos.x, pos.y, base.x + base.w / 2, base.y + base.h / 2, base.rotation || 0);
      let x = base.x, y = base.y, w = base.w, h = base.h;
      const min = 4;
      if (drag.handle.includes("e")) w = Math.max(min, lpos[0] - base.x);
      if (drag.handle.includes("s")) h = Math.max(min, lpos[1] - base.y);
      if (drag.handle.includes("w")) {
        x = Math.min(lpos[0], base.x + base.w - min);
        w = base.x + base.w - x;
      }
      if (drag.handle.includes("n")) {
        y = Math.min(lpos[1], base.y + base.h - min);
        h = base.y + base.h - y;
      }
      if (S._shiftDown && layer.image) {
        const iw = layer.image.naturalWidth || layer.image.width;
        const ih = layer.image.naturalHeight || layer.image.height;
        const aspect = iw / Math.max(1, ih);
        if (w / h > aspect) h = w / aspect;
        else w = h * aspect;
        if (drag.handle.includes("w")) x = base.x + base.w - w;
        if (drag.handle.includes("n")) y = base.y + base.h - h;
      }
      layer.x = x;
      layer.y = y;
      layer.w = w;
      layer.h = h;
    }
    if (isDrawableLayer(layer)) layer._bounds = void 0;
    redrawBitmapLayer(layer);
  }
  function setActiveLayer(id) {
    S.activeLayerId = id;
    S.selectedLayerId = id;
    S.selectedTextId = null;
    S.selectedShapeId = null;
    S.textDrag = null;
    S.shapeDrag = null;
    renderLayerPanel();
    renderObjects();
  }
  function addBitmapLayer(img) {
    startImagePlacement(img);
  }
  function addBlankLayer() {
    const id = "L" + Date.now() + Math.floor(Math.random() * 1e3);
    const canvas = createLayerCanvas();
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.clearRect(0, 0, S.imgW, S.imgH);
    const layer = {
      id,
      name: "\u7A7A\u767D\u56FE\u5C42 " + (S.layers.length + 1),
      canvas,
      ctx,
      opacity: 1,
      visible: true,
      locked: false,
      x: 0,
      y: 0,
      w: S.imgW,
      h: S.imgH,
      rotation: 0,
      z: ++S.zCounter
    };
    saveSnapshot();
    S.layers.push(layer);
    reorderLayerCanvas();
    setActiveLayer(id);
    updateLayerCanvasStyles();
    renderLayerPanel();
  }
  function deleteLayer(id) {
    const idx = S.layers.findIndex((l) => l.id === id);
    if (idx < 0) return;
    if (S.layers.length <= 1) return;
    const layer = S.layers[idx];
    if (layer.locked) return;
    saveSnapshot();
    if (layer.canvas.parentNode) layer.canvas.parentNode.removeChild(layer.canvas);
    S.layers.splice(idx, 1);
    S.layers.forEach((l, i) => {
      l.z = i;
    });
    if (S.activeLayerId === id) {
      S.activeLayerId = S.layers[S.layers.length - 1].id;
    }
    reorderLayerCanvas();
    renderLayerPanel();
  }
  function vecCanvasFor(obj) {
    if (!obj._canvas || !obj._canvas.parentNode) {
      const c = document.createElement("canvas");
      c.className = "iwb-editor-vec-canvas";
      c.width = S.imgW;
      c.height = S.imgH;
      c.style.position = "absolute";
      c.style.top = "0";
      c.style.left = "0";
      c.style.display = "block";
      S.canvasStack.insertBefore(c, S.strokeCanvas);
      if (S.imgW && S.fitW) {
        const vw = Math.round(S.fitW * S.zoom);
        const vh = Math.round(S.fitH * S.zoom);
        const vs = S.imgW ? S.fitW * S.zoom / S.imgW : 1;
        const vo = Math.round((S.overlayPad || 0) * vs);
        c.style.width = vw + "px";
        c.style.height = vh + "px";
        c.style.left = vo + "px";
        c.style.top = vo + "px";
      }
      obj._canvas = c;
      obj._ctx = c.getContext("2d");
    }
    return obj;
  }
  function removeVecCanvas(obj) {
    if (obj && obj._canvas) {
      if (obj._canvas.parentNode) obj._canvas.parentNode.removeChild(obj._canvas);
      obj._canvas = null;
      obj._ctx = null;
    }
  }
  function purgeVectorCanvases() {
    for (const t of S.textLayers) removeVecCanvas(t);
    for (const sh of S.shapeLayers) removeVecCanvas(sh);
  }
  function drawVectorToCanvas(kind, obj) {
    vecCanvasFor(obj);
    const ctx = obj._ctx;
    ctx.clearRect(0, 0, S.imgW, S.imgH);
    if (kind === "shape") {
      drawShape(ctx, obj);
    } else {
      ctx.save();
      ctx.textBaseline = "top";
      ctx.globalAlpha = obj.opacity != null ? obj.opacity : 1;
      const rot = obj.rotation || 0;
      if (rot) {
        const b = textBounds(obj);
        const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
        ctx.translate(cx, cy);
        ctx.rotate(rot * Math.PI / 180);
        ctx.translate(-cx, -cy);
      }
      ctx.font = TEXT_FONT(obj.fontSize);
      ctx.fillStyle = obj.color;
      ctx.fillText(obj.text, obj.x, obj.y);
      ctx.restore();
    }
  }
  function toggleLayerVisibility(id) {
    const layer = S.layers.find((l) => l.id === id);
    if (!layer) return;
    layer.visible = !layer.visible;
    reorderLayerCanvas();
    renderLayerPanel();
    S.pickerComposite = null;
  }
  function updateLayerCanvasStyles() {
    const w = Math.round(S.fitW * S.zoom);
    const h = Math.round(S.fitH * S.zoom);
    const scale = S.imgW ? S.fitW * S.zoom / S.imgW : 1;
    const offset = Math.round((S.overlayPad || 0) * scale);
    for (const layer of S.layers) {
      layer.canvas.style.width = w + "px";
      layer.canvas.style.height = h + "px";
      layer.canvas.style.left = offset + "px";
      layer.canvas.style.top = offset + "px";
    }
    styleVectorViewport(w, h, offset);
  }
  function styleVectorViewport(w, h, offset) {
    for (const { obj } of allObjects()) {
      if (!obj._canvas) continue;
      obj._canvas.style.width = w + "px";
      obj._canvas.style.height = h + "px";
      obj._canvas.style.left = offset + "px";
      obj._canvas.style.top = offset + "px";
    }
  }
  function renderLayerPanel() {
    const list = runtime.el.querySelector(".iwb-editor-layer-list");
    if (!list) return;
    const items = [];
    for (const layer of S.layers) {
      items.push({
        id: layer.id,
        type: "bitmap",
        name: layer.name,
        opacity: layer.opacity,
        visible: layer.visible,
        z: layer.z,
        color: layer.color || S.color,
        lineWidth: layer.lineWidth || S.brushSize,
        active: layer.id === (S.selectedLayerId || S.activeLayerId),
        locked: !!layer.locked,
        canDelete: S.layers.length > 1
      });
    }
    const vectorObjs = allObjects();
    for (const { kind, obj } of vectorObjs) {
      items.push({
        id: obj.id,
        type: kind,
        name: kind === "text" ? '"' + (obj.text || "").slice(0, 12) + '"' : obj.type === "rect" ? "\u77E9\u5F62" : obj.type === "circle" ? "\u5706\u5F62" : obj.type === "pen" ? "\u94A2\u7B14\u5F62\u72B6" : "\u7BAD\u5934",
        opacity: obj.opacity != null ? obj.opacity : 1,
        visible: obj.visible !== false,
        z: obj.z || 0,
        color: obj.color || S.color,
        lineWidth: obj.lw || S.brushSize,
        active: kind === "text" && obj.id === S.selectedTextId || kind === "shape" && obj.id === S.selectedShapeId,
        locked: !!obj.locked,
        canDelete: true
      });
    }
    items.sort((a, b) => b.z - a.z);
    let html = "";
    for (const item of items) {
      const activeClass = item.active ? " active" : "";
      const visClass = item.visible ? "" : " hidden";
      let typeIconSvg = "";
      if (item.type === "bitmap") {
        typeIconSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>';
      } else if (item.type === "text") {
        typeIconSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 3 20 3 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="3" x2="12" y2="20"/></svg>';
      } else if (item.type === "rect") {
        typeIconSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>';
      } else {
        typeIconSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>';
      }
      const visSvg = item.visible ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>' : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/></svg>';
      const lockSvg = item.locked ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>' : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 7-2"/></svg>';
      const delSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
      html += `<div class="iwb-layer-item${activeClass}${visClass}" draggable="${item.id !== "base"}" data-layer-id="${item.id}" data-layer-type="${item.type}">
        <button class="iwb-layer-vis" data-vis-id="${item.id}" data-vis-type="${item.type}" title="${item.visible ? "\u9690\u85CF" : "\u663E\u793A"}">${visSvg}</button>
        <span class="iwb-layer-icon">${typeIconSvg}</span>
        <span class="iwb-layer-name">${item.name}</span>
        ${item.type === "bitmap" || item.type === "shape" ? `<input class="iwb-layer-color" type="color" value="${item.color}" data-color-id="${item.id}" data-color-type="${item.type}" title="\u8C03\u6574\u989C\u8272">` : ""}
        ${item.type === "bitmap" || item.type === "shape" ? `<input class="iwb-layer-width" type="number" min="1" max="300" value="${Math.round(item.lineWidth)}" data-width-id="${item.id}" data-width-type="${item.type}" title="\u8C03\u6574\u8FB9\u6846\u7C97\u7EC6">` : ""}
        <button class="iwb-layer-lock${item.locked ? " active" : ""}" data-lock-id="${item.id}" data-lock-type="${item.type}" title="${item.locked ? "\u89E3\u9501\u56FE\u5C42" : "\u9501\u5B9A\u56FE\u5C42"}">${lockSvg}</button>
         ${item.canDelete ? `<button class="iwb-layer-del" data-del-id="${item.id}" data-del-type="${item.type}" title="\u5220\u9664\u56FE\u5C42">${delSvg}</button>` : ""}
      </div>`;
    }
    list.innerHTML = html;
    bindLayerPanelEvents();
  }
  function reorderPanelItem(dragId, targetId) {
    if (!dragId || !targetId || dragId === targetId || dragId === "base" || targetId === "base") return;
    const all = [...S.layers.map((obj) => ({ kind: "bitmap", obj })), ...allObjects()].sort((a, b) => (a.obj.z || 0) - (b.obj.z || 0));
    const from = all.findIndex((item) => item.obj.id === dragId);
    let to = all.findIndex((item) => item.obj.id === targetId);
    if (from < 0 || to < 0) return;
    const [moved] = all.splice(from, 1);
    to = all.findIndex((item) => item.obj.id === targetId);
    all.splice(to, 0, moved);
    saveSnapshot();
    all.forEach((item, index) => {
      item.obj.z = index;
    });
    S.zCounter = Math.max(S.zCounter, all.length - 1);
    reorderLayerCanvas();
    sortLayersByZ();
    renderObjects();
    renderLayerPanel();
  }
  function bindLayerPanelEvents() {
    const list = runtime.el.querySelector(".iwb-editor-layer-list");
    if (!list) return;
    bindLayerItemEvents(list);
    bindLayerStyleInputs(list);
    bindLayerVisButtons(list);
    bindLayerLockButtons(list);
    bindLayerDelButtons(list);
  }
  function bindLayerItemEvents(list) {
    list.querySelectorAll(".iwb-layer-item").forEach((item) => {
      item.addEventListener("mousedown", (e) => e.stopPropagation());
      item.addEventListener("dragstart", (e) => {
        if (item.draggable) {
          e.dataTransfer.setData("text/plain", item.dataset.layerId);
          item.classList.add("dragging");
        }
      });
      item.addEventListener("dragend", () => item.classList.remove("dragging"));
      item.addEventListener("dragover", (e) => {
        if (item.draggable) e.preventDefault();
      });
      item.addEventListener("drop", (e) => {
        e.preventDefault();
        reorderPanelItem(e.dataTransfer.getData("text/plain"), item.dataset.layerId);
      });
      item.addEventListener("click", (e) => {
        if (e.target.closest(".iwb-layer-vis") || e.target.closest(".iwb-layer-lock") || e.target.closest(".iwb-layer-del")) return;
        const id = item.dataset.layerId;
        const type = item.dataset.layerType;
        if (type === "bitmap") {
          setActiveLayer(id);
        } else if (type === "text") {
          S.selectedLayerId = null;
          S.selectedShapeId = null;
          S.selectedTextId = id;
          S.textDrag = null;
          S.shapeDrag = null;
          S.bitmapDrag = null;
          renderObjects();
          renderLayerPanel();
        } else if (type === "shape") {
          S.selectedLayerId = null;
          S.selectedTextId = null;
          S.selectedShapeId = id;
          S.textDrag = null;
          S.shapeDrag = null;
          S.bitmapDrag = null;
          renderObjects();
          renderLayerPanel();
        }
      });
    });
  }
  function bindLayerStyleInputs(list) {
    list.querySelectorAll(".iwb-layer-color").forEach((input) => {
      input.addEventListener("mousedown", (e) => e.stopPropagation());
      input.addEventListener("input", (e) => {
        e.stopPropagation();
        const id = input.dataset.colorId;
        const type = input.dataset.colorType;
        const obj = type === "bitmap" ? S.layers.find((l) => l.id === id) : S.shapeLayers.find((s) => s.id === id);
        if (obj) {
          obj.color = input.value;
          S.color = input.value;
          updateColorUI();
          renderObjects();
          renderLayerPanel();
          S.pickerComposite = null;
        }
      });
    });
    list.querySelectorAll(".iwb-layer-width").forEach((input) => {
      input.addEventListener("mousedown", (e) => e.stopPropagation());
      input.addEventListener("input", (e) => {
        e.stopPropagation();
        const id = input.dataset.widthId;
        const type = input.dataset.widthType;
        const value = clamp(parseInt(input.value, 10) || 1, 1, 300);
        const obj = type === "bitmap" ? S.layers.find((l) => l.id === id) : S.shapeLayers.find((s) => s.id === id);
        if (obj) {
          obj.lineWidth = value;
          if (type === "shape") obj.lw = value;
          else S.brushSize = value;
          renderObjects();
          updateBrushParamUI();
          renderLayerPanel();
        }
      });
    });
  }
  function bindLayerVisButtons(list) {
    list.querySelectorAll(".iwb-layer-vis").forEach((btn) => {
      btn.addEventListener("mousedown", (e) => e.stopPropagation());
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.dataset.visId;
        const type = btn.dataset.visType;
        if (type === "bitmap") {
          toggleLayerVisibility(id);
        } else if (type === "text") {
          const obj = S.textLayers.find((t) => t.id === id);
          if (obj) {
            obj.visible = obj.visible === false;
            renderObjects();
            renderLayerPanel();
            S.pickerComposite = null;
          }
        } else if (type === "shape") {
          const obj = S.shapeLayers.find((s) => s.id === id);
          if (obj) {
            obj.visible = obj.visible === false;
            renderObjects();
            renderLayerPanel();
            S.pickerComposite = null;
          }
        }
      });
    });
  }
  function bindLayerLockButtons(list) {
    list.querySelectorAll(".iwb-layer-lock").forEach((btn) => {
      btn.addEventListener("mousedown", (e) => e.stopPropagation());
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.dataset.lockId;
        const type = btn.dataset.lockType;
        const obj = type === "bitmap" ? S.layers.find((l) => l.id === id) : type === "text" ? S.textLayers.find((t) => t.id === id) : S.shapeLayers.find((s) => s.id === id);
        if (!obj) return;
        saveSnapshot();
        obj.locked = !obj.locked;
        renderObjects();
        renderLayerPanel();
      });
    });
  }
  function bindLayerDelButtons(list) {
    list.querySelectorAll(".iwb-layer-del").forEach((btn) => {
      btn.addEventListener("mousedown", (e) => e.stopPropagation());
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.dataset.delId;
        const type = btn.dataset.delType;
        if (type === "bitmap") {
          deleteLayer(id);
        } else if (type === "text") {
          S.selectedTextId = id;
          deleteSelectedText();
          renderLayerPanel();
        } else if (type === "shape") {
          S.selectedShapeId = id;
          deleteSelectedShape();
          renderLayerPanel();
        }
      });
    });
  }

  // iwb-cutout-extension/src/editor/dom.js
  function createEl() {
    if (runtime.el) return;
    runtime.el = document.createElement("div");
    runtime.el.id = "iwb-editor-overlay";
    runtime.el.className = "iwb-editor-overlay";
    runtime.el.innerHTML = `
      <div class="iwb-editor-modal">
        <div class="iwb-editor-header">
          <span class="iwb-editor-title">\u56FE\u7247\u7F16\u8F91</span>
          <div class="iwb-editor-history">
            <button class="iwb-editor-action" data-action="undo" title="\u64A4\u9500 (Ctrl+Z)"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg></button>
            <button class="iwb-editor-action" data-action="redo" title="\u91CD\u505A (Ctrl+Shift+Z)"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button>
            <button class="iwb-editor-action" data-action="reset" title="\u6E05\u7A7A\u6807\u6CE8"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
            <button class="iwb-editor-action iwb-editor-action-restore" data-action="restore" title="\u590D\u539F\u539F\u59CB\u56FE\uFF08\u64A4\u9500\u6240\u6709\u7F16\u8F91\uFF09"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg></button>
          </div>
          <div class="iwb-editor-tools">
            <button class="iwb-editor-tool" data-tool="select" title="\u9009\u62E9/\u79FB\u52A8\uFF1A\u70B9\u51FB\u5143\u7D20\u9009\u4E2D\uFF0C\u62D6\u62FD\u79FB\u52A8\uFF0C\u624B\u67C4\u8C03\u6574\u5927\u5C0F\uFF0C\u53CC\u51FB\u6587\u5B57\u6539\u5185\u5BB9"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/></svg></button>

            <button class="iwb-editor-tool active" data-tool="brush" title="\u753B\u7B14"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg></button>

            <button class="iwb-editor-tool" data-tool="eraser" title="\u6A61\u76AE\uFF1A\u64E6\u9664\u5F53\u524D\u6D3B\u8DC3\u56FE\u5C42\u7684\u5185\u5BB9\uFF08\u753B\u7B14\u6807\u6CE8\u6216\u539F\u56FE\uFF09\uFF0C\u4E0E\u753B\u7B14\u5171\u7528\u5927\u5C0F/\u786C\u5EA6/\u900F\u660E\u5EA6"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/></svg></button>

            <button class="iwb-editor-tool" data-tool="pen" title="\u94A2\u7B14\uFF1A\u70B9\u51FB\u6DFB\u52A0\u8282\u70B9\uFF0C\u53CC\u51FB\u6216 Enter \u5B8C\u6210\u81EA\u5B9A\u4E49\u5F62\u72B6"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 19 7-7 3 3-7 7-3-3z"/><path d="m18 13-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="m2 2 7.586 7.586"/><circle cx="11" cy="11" r="2"/></svg></button>

            <button class="iwb-editor-tool" data-tool="text" title="\u6587\u5B57"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 3 20 3 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="3" x2="12" y2="20"/></svg></button>

            <button class="iwb-editor-tool" data-tool="rect" title="\u77E9\u5F62\u6846"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/></svg></button>

            <button class="iwb-editor-tool" data-tool="circle" title="\u5706\u5F62"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/></svg></button>

            <button class="iwb-editor-tool" data-tool="arrow" title="\u7BAD\u5934"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg></button>

            <button class="iwb-editor-tool" data-tool="picker" title="\u5438\u7BA1\uFF1A\u70B9\u51FB\u753B\u5E03\u53D6\u8272\uFF08\u60AC\u505C\u9884\u89C8\uFF09\uFF0C\u53D6\u8272\u540E\u81EA\u52A8\u5207\u56DE\u4E0A\u4E00\u5DE5\u5177"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3Z"/></svg></button>

            <button class="iwb-editor-tool" data-tool="hand" title="\u6293\u624B\uFF1A\u62D6\u62FD\u81EA\u7531\u79FB\u52A8\u753B\u5E03\uFF08\u4EFB\u610F\u5DE5\u5177\u4E0B\u6309\u4F4F\u7A7A\u683C\u6216\u9F20\u6807\u4E2D\u952E\u4E5F\u53EF\u5E73\u79FB\uFF09"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0"/><path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8"/><path d="M18 10a2 2 0 1 1 4 0v3a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg></button>

            <span class="iwb-editor-divider"></span>

            <button class="iwb-editor-tool" data-tool="crop" title="\u88C1\u526A"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6.13 1L6 16a2 2 0 0 0 2 2h15"/><path d="M1 6.13L16 6a2 2 0 0 1 2 2v15"/></svg></button>

            <span class="iwb-editor-divider"></span>

            <button class="iwb-editor-fill-btn" data-action="toggleFill" title="\u77E9\u5F62\u5B9E\u5FC3\u586B\u5145\u5F00\u5173\uFF08\u9009\u4E2D\u77E9\u5F62\u65F6\u5207\u6362\u5373\u65F6\u751F\u6548\uFF09">\u5B9E\u5FC3</button>
          </div>
          <span class="iwb-editor-divider"></span>

          <div class="iwb-editor-export-actions">
            <button class="iwb-editor-btn iwb-editor-btn-new" data-action="newNode">\u65B0\u5EFA</button>
            <button class="iwb-editor-btn iwb-editor-btn-replace" data-action="replace">\u8986\u76D6</button>
            <button class="iwb-editor-btn iwb-editor-btn-cancel" data-action="cancel">\u9000\u51FA</button>
          </div>
        </div>
        <div class="iwb-editor-main">

          <div class="iwb-editor-layer-panel">
            <div class="iwb-editor-layer-panel-header">
              <span class="iwb-editor-layer-panel-title">\u56FE\u5C42</span>
              <div class="iwb-editor-layer-add-group">
                <button class="iwb-editor-layer-add-btn" data-action="addBitmapLayer" title="\u5BFC\u5165\u56FE\u7247\u4E3A\u65B0\u56FE\u5C42"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg></button>
                <button class="iwb-editor-layer-add-btn" data-action="addBlankLayer" title="\u65B0\u5EFA\u7A7A\u767D\u56FE\u5C42"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg></button>
              </div>
            </div>

          <div class="iwb-editor-layer-group" title="\u8C03\u6574\u9009\u4E2D\u5143\u7D20\u7684\u56FE\u5C42\u987A\u5E8F">
              <span class="iwb-editor-constraint-label">\u56FE\u5C42</span>
              <button class="iwb-editor-layer-btn" data-layer="top" title="\u7F6E\u9876\uFF1A\u9009\u4E2D\u5143\u7D20\u79FB\u5230\u6700\u4E0A\u5C42 (Ctrl+Shift+])"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="5" x2="20" y2="5"/><line x1="12" y1="19" x2="12" y2="5"/><polyline points="6 11 12 5 18 11"/></svg></button>
              <button class="iwb-editor-layer-btn" data-layer="up" title="\u4E0A\u79FB\u4E00\u5C42 (Ctrl+])"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="6 11 12 5 18 11"/></svg></button>
              <button class="iwb-editor-layer-btn" data-layer="down" title="\u4E0B\u79FB\u4E00\u5C42 (Ctrl+[)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="6 13 12 19 18 13"/></svg></button>
              <button class="iwb-editor-layer-btn" data-layer="bottom" title="\u7F6E\u5E95\uFF1A\u9009\u4E2D\u5143\u7D20\u79FB\u5230\u6700\u4E0B\u5C42 (Ctrl+Shift+[)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="6 13 12 19 18 13"/><line x1="4" y1="19" x2="20" y2="19"/></svg></button>
            </div>
          <div class="iwb-editor-layer-list"></div>
          </div>
          <div class="iwb-editor-canvas-wrap">
            <div class="iwb-editor-canvas-stack">
              <div class="iwb-editor-transparency-grid"></div>
               <!-- \u4F4D\u56FE\u56FE\u5C42 canvas \u52A8\u6001\u63D2\u5165\u6B64\u5904 -->
              <canvas class="iwb-editor-stroke"></canvas>
              <canvas class="iwb-editor-text"></canvas>
              <canvas class="iwb-editor-crop-overlay"></canvas>
            </div>
            <input class="iwb-editor-text-input" type="text" placeholder="\u8F93\u5165\u6587\u5B57\uFF0CEnter\u786E\u8BA4\uFF0CEsc\u53D6\u6D88">
            <div class="iwb-editor-picker-tip"><span class="iwb-editor-picker-chip"></span><span class="iwb-editor-picker-hex">#ffffff</span></div>
            <div class="iwb-editor-crop-bar">
              <div class="iwb-editor-crop-row"><div class="iwb-editor-constraint-group">
                <span class="iwb-editor-constraint-label">\u6BD4\u4F8B</span>
                <button class="iwb-editor-constraint-btn active" data-ratio="free">\u81EA\u7531</button>
                <button class="iwb-editor-constraint-btn" data-ratio="1:1">1:1</button>
                <button class="iwb-editor-constraint-btn" data-ratio="4:3">4:3</button>
                <button class="iwb-editor-constraint-btn" data-ratio="3:4">3:4</button>
                <button class="iwb-editor-constraint-btn" data-ratio="16:9">16:9</button>
                <button class="iwb-editor-constraint-btn" data-ratio="9:16">9:16</button>
              </div></div>
              <div class="iwb-editor-crop-row"><div class="iwb-editor-constraint-group">
                <span class="iwb-editor-constraint-label">\u5C3A\u5BF8</span>
                <input class="iwb-editor-size-input iwb-editor-size-w" type="number" min="1" placeholder="\u5BBD" value="800">
                <span class="iwb-editor-size-x">\xD7</span>
                <input class="iwb-editor-size-input iwb-editor-size-h" type="number" min="1" placeholder="\u9AD8" value="800">
                <button class="iwb-editor-constraint-btn iwb-editor-size-toggle" data-action="toggleSizeConstraint" aria-pressed="false">\u542F\u7528\u5C3A\u5BF8</button>
                 <button class="iwb-editor-constraint-btn iwb-editor-size-apply" data-action="applySize">\u5E94\u7528</button>
              </div></div>
              <div class="iwb-editor-crop-row iwb-editor-crop-actions"><span class="iwb-editor-crop-info">--</span>
              <button class="iwb-editor-crop-confirm" data-action="confirmCrop">\u2713 \u786E\u8BA4</button>
              <button class="iwb-editor-crop-cancel" data-action="cancelCrop">\u2717 \u53D6\u6D88</button>
            </div>
                </div>
            </div>
            <div class="iwb-editor-zoom-hint">\u6EDA\u8F6E\u7F29\u653E \xB7 \u6293\u624B/\u7A7A\u683C/\u4E2D\u952E\u62D6\u62FD\u81EA\u7531\u79FB\u52A8\u753B\u5E03</div>

        <aside class="iwb-editor-left">
          <div class="iwb-editor-color-panel"><div class="iwb-editor-color-panel-title">\u8C03\u8272\u677F</div><div class="iwb-editor-color-picker2"><div class="iwb-color-sv"><span></span></div><div class="iwb-color-hue"><span></span></div></div><div class="iwb-editor-color-fields"><button type="button" class="iwb-editor-color-eye" data-action="palettePick" title="\u5438\u8272\uFF1A\u70B9\u51FB\u540E\u5728\u753B\u5E03\u53D6\u6837"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3Z"/></svg></button><input class="iwb-editor-color-hex-input" value="#ff4444" maxlength="7"></div><div class="iwb-editor-color-swatches"><button type="button" class="iwb-editor-color-panel-swatch" data-panel-color="#ff4444" style="background:#ff4444" title="#ff4444"></button><button type="button" class="iwb-editor-color-panel-swatch" data-panel-color="#ff8800" style="background:#ff8800" title="#ff8800"></button><button type="button" class="iwb-editor-color-panel-swatch" data-panel-color="#ffd400" style="background:#ffd400" title="#ffd400"></button><button type="button" class="iwb-editor-color-panel-swatch" data-panel-color="#44dd44" style="background:#44dd44" title="#44dd44"></button><button type="button" class="iwb-editor-color-panel-swatch" data-panel-color="#00bfa5" style="background:#00bfa5" title="#00bfa5"></button><button type="button" class="iwb-editor-color-panel-swatch" data-panel-color="#4488ff" style="background:#4488ff" title="#4488ff"></button><button type="button" class="iwb-editor-color-panel-swatch" data-panel-color="#aa44ff" style="background:#aa44ff" title="#aa44ff"></button><button type="button" class="iwb-editor-color-panel-swatch" data-panel-color="#ff66aa" style="background:#ff66aa" title="#ff66aa"></button><button type="button" class="iwb-editor-color-panel-swatch" data-panel-color="#ffffff" style="background:#ffffff" title="#ffffff"></button><button type="button" class="iwb-editor-color-panel-swatch" data-panel-color="#b8b8b8" style="background:#b8b8b8" title="#b8b8b8"></button><button type="button" class="iwb-editor-color-panel-swatch" data-panel-color="#555555" style="background:#555555" title="#555555"></button><button type="button" class="iwb-editor-color-panel-swatch" data-panel-color="#000000" style="background:#000000" title="#000000"></button></div></div>
          <div class="iwb-editor-params">
          <label class="iwb-editor-brush-label">\u63CF\u8FB9
              <input type="range" class="iwb-editor-brush-size" min="1" max="300" value="3">
              <input type="number" class="iwb-editor-brush-num" min="1" max="300" step="1" value="3" title="\u8F93\u5165\u7CBE\u786E\u7B14\u5237\u5927\u5C0F\uFF081~300\uFF09">
            </label>
            <div class="iwb-editor-brush-presets" aria-label="\u63CF\u8FB9\u5FEB\u6377\u503C">
              <button type="button" class="iwb-editor-brush-preset" data-brush-size="2" title="\u63CF\u8FB9 2"><i></i></button>
              <button type="button" class="iwb-editor-brush-preset" data-brush-size="4" title="\u63CF\u8FB9 4"><i></i></button>
              <button type="button" class="iwb-editor-brush-preset" data-brush-size="8" title="\u63CF\u8FB9 8"><i></i></button>
              <button type="button" class="iwb-editor-brush-preset" data-brush-size="12" title="\u63CF\u8FB9 12"><i></i></button>
              <button type="button" class="iwb-editor-brush-preset" data-brush-size="16" title="\u63CF\u8FB9 16"><i></i></button>
              <button type="button" class="iwb-editor-brush-preset" data-brush-size="24" title="\u63CF\u8FB9 24"><i></i></button>
              <button type="button" class="iwb-editor-brush-preset" data-brush-size="32" title="\u63CF\u8FB9 32"><i></i></button>
            </div>
            <div class="iwb-editor-brush-group">
              <label class="iwb-editor-brush-label">\u786C\u5EA6
                <input type="range" class="iwb-editor-brush-hardness" min="0" max="100" value="100">
                <span class="iwb-editor-brush-hardness-val">100</span>
              </label>
              <label class="iwb-editor-brush-label iwb-editor-opacity-label">\u900F\u660E
                <input type="range" class="iwb-editor-brush-opacity" min="5" max="100" step="5" value="100">
                <span class="iwb-editor-brush-opacity-val">100%</span>
              </label>
            </div>

          </div>

          <div class="iwb-editor-zoom">
              <button class="iwb-editor-zoom-btn" data-action="zoomOut" title="\u7F29\u5C0F (\u6EDA\u8F6E\u5411\u4E0B)">\u2212</button>
              <span class="iwb-editor-zoom-val" title="\u6EDA\u8F6E\u7F29\u653E">100%</span>
              <button class="iwb-editor-zoom-btn" data-action="zoomIn" title="\u653E\u5927 (\u6EDA\u8F6E\u5411\u4E0A)">\uFF0B</button>
              <button class="iwb-editor-zoom-btn iwb-editor-zoom-fit" data-action="zoomFit" title="\u9002\u5E94\u7A97\u53E3">\u9002\u5E94</button>
            </div>
        </aside>
        </div>

        </div>
        <div class="iwb-editor-footer">

        </div>
      </div>
    `;
    document.body.appendChild(runtime.el);
    S.canvasWrap = runtime.el.querySelector(".iwb-editor-canvas-wrap");
    S.canvasStack = runtime.el.querySelector(".iwb-editor-canvas-stack");
    S.transparencyGrid = runtime.el.querySelector(".iwb-editor-transparency-grid");
    S.textCanvas = runtime.el.querySelector(".iwb-editor-text");
    S.strokeCanvas = runtime.el.querySelector(".iwb-editor-stroke");
    S.overlayCanvas = runtime.el.querySelector(".iwb-editor-crop-overlay");
    S.textCtx = S.textCanvas.getContext("2d");
    S.strokeCtx = S.strokeCanvas.getContext("2d");
    S.overlayCtx = S.overlayCanvas.getContext("2d");
    bindEvents();
  }
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("\u56FE\u7247\u52A0\u8F7D\u5931\u8D25"));
      img.src = src;
    });
  }

  // iwb-cutout-extension/src/shared/image-math.js
  function hexToRgb(hex) {
    const h = String(hex || "").replace("#", "");
    const v = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    return {
      r: parseInt(v.slice(0, 2), 16) || 0,
      g: parseInt(v.slice(2, 4), 16) || 0,
      b: parseInt(v.slice(4, 6), 16) || 0
    };
  }
  function rgbToHex(r, g, b) {
    const to = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
    return `#${to(r)}${to(g)}${to(b)}`;
  }
  function parseRatio(str) {
    if (str === "free" || !str) return 0;
    const parts = String(str).split(":");
    if (parts.length === 2) {
      const w = parseFloat(parts[0]);
      const h = parseFloat(parts[1]);
      if (w > 0 && h > 0) return w / h;
    }
    return 0;
  }
  function fitRect(srcW, srcH, boxW, boxH, ratio = 1) {
    if (!(srcW > 0) || !(srcH > 0) || !(boxW > 0) || !(boxH > 0)) {
      return { x: 0, y: 0, w: 0, h: 0, scale: 0 };
    }
    const r = Math.max(0.01, Math.min(1, ratio));
    const maxLen = Math.min(boxW, boxH) * r;
    const scale = Math.min(maxLen / srcW, maxLen / srcH);
    const w = srcW * scale;
    const h = srcH * scale;
    return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h, scale };
  }

  // iwb-cutout-extension/src/editor/events.js
  var MOUSE_DOWN_HANDLERS = {
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
  };
  function onMouseDown(e) {
    if (S.placingImage) {
      onPlacementMouseDown(e);
      return;
    }
    if (S.spaceDown || S.tool === "hand" || e.button === 1) {
      onPanMouseDown(e);
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault();
    const pos = getPos(e);
    S.startX = pos.x;
    S.startY = pos.y;
    if (S.tool === "select" || S.tool === "pen") {
      const penShape = getPenEditingShape();
      if (penShape && onPenEditMouseDown(e, pos, penShape)) return;
    }
    const handler = Object.prototype.hasOwnProperty.call(MOUSE_DOWN_HANDLERS, S.tool) ? MOUSE_DOWN_HANDLERS[S.tool] : null;
    if (handler) handler(pos);
  }
  function onPlacementMouseDown(e) {
    e.preventDefault();
    const pos = getPos(e);
    const handle = hitPlacementHandle(pos);
    if (handle) {
      S.placingHandle = handle;
      S.placingStart = { mx: pos.x, my: pos.y, x: S.placingImage.x, y: S.placingImage.y, w: S.placingImage.w, h: S.placingImage.h, rotation: S.placingImage.rotation || 0 };
      S.drawCanvasCursor(CROP_CURSORS[handle] || "move");
      return;
    }
    if (insidePlacementRect(pos)) {
      S.placingHandle = "move";
      S.placingStart = { mx: pos.x, my: pos.y, x: S.placingImage.x, y: S.placingImage.y, rotation: S.placingImage.rotation || 0 };
      S.drawCanvasCursor("move");
      return;
    }
    confirmImagePlacement();
  }
  function onPanMouseDown(e) {
    e.preventDefault();
    commitTextInput();
    S.panning = true;
    S.panStart = { x: e.clientX, y: e.clientY, vx: S.viewX || 0, vy: S.viewY || 0 };
    updateCursor();
  }
  function onPenEditMouseDown(e, pos, penShape) {
    const pi = hitPenPoint(pos, penShape, Math.max(16 / S.zoom, 9));
    if (pi >= 0) {
      S.penDragPt = pi;
      S.penDragBase = JSON.parse(JSON.stringify(penShape.pts));
      S.penDragPending = snapshotState();
      return true;
    }
    const ei = hitPenEdgeInsert(pos, penShape);
    if (ei >= 0) {
      saveSnapshot();
      penShape.pts.splice(ei + 1, 0, { x: pos.x, y: pos.y });
      renderObjects();
      renderLayerPanel();
      return true;
    }
    S.penEditId = null;
    S.penDragPt = -1;
    S.penDragPending = null;
    renderObjects();
    return false;
  }
  function onSelectMouseDown(pos) {
    if (commitTextInput()) return;
    const bitmapHandle = hitBitmapHandle(pos);
    if (bitmapHandle) {
      beginBitmapDrag(bitmapHandle, pos);
      return;
    }
    const th = hitTextHandle(pos);
    if (th) {
      if (th === "rotate") beginTextRotate(pos);
      else beginTextScaleDrag(th, pos);
      return;
    }
    const shH = hitShapeHandle(pos);
    if (shH) {
      beginShapeHandleDrag(shH, pos);
      return;
    }
    const hit = hitAnyObject(pos);
    if (hit) {
      S.selectedLayerId = null;
      if (hit.kind === "text") {
        S.selectedShapeId = null;
        S.selectedTextId = hit.obj.id;
        if (hit.obj.locked) {
          renderObjects();
          renderLayerPanel();
          return;
        }
        S.textDrag = { mode: "move", start: pos, layer: { x: hit.obj.x, y: hit.obj.y }, pending: snapshotState() };
      } else {
        S.selectedTextId = null;
        S.selectedShapeId = hit.obj.id;
        if (hit.obj.locked) {
          renderObjects();
          renderLayerPanel();
          return;
        }
        S.shapeDrag = { mode: "move", start: pos, shape: { ...hit.obj }, pending: snapshotState() };
      }
      renderObjects();
      renderLayerPanel();
    } else {
      const bitmap = hitBitmapLayer(pos);
      if (bitmap) {
        S.selectedLayerId = bitmap.id;
        S.activeLayerId = bitmap.id;
        S.selectedTextId = null;
        S.selectedShapeId = null;
        beginBitmapDrag(null, pos);
        renderObjects();
        renderLayerPanel();
      } else if (S.selectedLayerId || S.selectedTextId || S.selectedShapeId) {
        clearSelection();
        renderObjects();
        renderLayerPanel();
      }
    }
    return;
  }
  function onCropMouseDown(pos) {
    if (S.cropRect) {
      const handle = hitCropHandle(pos);
      if (handle) {
        S.cropHandle = handle;
        S.isDrawing = true;
        return;
      }
      if (insideRect(pos, S.cropRect)) {
        S.cropMoving = true;
        S.moveStart = { x: pos.x, y: pos.y, rect: { ...S.cropRect } };
        S.isDrawing = true;
      }
      return;
    }
    S.isDrawing = true;
  }
  function onTextMouseDown(pos) {
    if (commitTextInput()) return;
    const handle = hitTextHandle(pos);
    if (handle) {
      if (handle === "rotate") beginTextRotate(pos);
      else beginTextScaleDrag(handle, pos);
      return;
    }
    const hit = hitTextLayer(pos);
    if (hit) {
      S.selectedTextId = hit.id;
      if (hit.locked) {
        renderObjects();
        renderLayerPanel();
        return;
      }
      S.textDrag = {
        mode: "move",
        start: pos,
        layer: { x: hit.x, y: hit.y },
        pending: snapshotState()
      };
      renderObjects();
      renderLayerPanel();
    } else {
      if (S.selectedTextId) {
        S.selectedTextId = null;
        renderObjects();
        renderLayerPanel();
      }
      showTextInput(pos.x, pos.y);
    }
  }
  function onPickerMouseDown(pos) {
    const s = sampleColor(pos);
    if (s && s.a > 0) {
      applyColorChange(rgbToHex(s.r, s.g, s.b));
    }
    exitPicker();
    return;
  }
  function onBrushMouseDown(pos) {
    if (!getActiveCtx()) return;
    S.isDrawing = true;
    saveSnapshot();
    beginStroke();
    strokeSegment(pos.x, pos.y, pos.x, pos.y);
  }
  function onEraserMouseDown(pos) {
    if (!getActiveCtx()) return;
    S.isDrawing = true;
    saveSnapshot();
    beginStroke();
    eraseSegment(pos.x, pos.y, pos.x, pos.y);
  }
  function onPenMouseDown(pos) {
    if (!S.penPath) S.penPath = { pts: [], preview: null, closed: false };
    const point = { x: clamp(pos.x, 0, S.imgW), y: clamp(pos.y, 0, S.imgH) };
    const first = S.penPath.pts[0];
    if (first && S.penPath.pts.length >= 3 && Math.hypot(point.x - first.x, point.y - first.y) <= Math.max(12 / S.zoom, S.brushSize * 1.5)) {
      S.penPath.closed = true;
      S.penPath.nearStart = true;
      S.penPath.preview = null;
      commitPenPath();
    } else {
      S.penPath.pts.push(point);
      renderObjects({ id: "pen-preview", type: "pen", pts: S.penPath.pts.concat(S.penPath.preview ? [S.penPath.preview] : []), closed: false, color: S.color, lw: Math.max(2, S.brushSize), fill: false, opacity: 1, visible: true });
    }
    return;
  }
  function onShapeMouseDown(pos) {
    const handle = hitShapeHandle(pos);
    if (handle) {
      beginShapeHandleDrag(handle, pos);
      return;
    }
    const hitShape = hitShapeLayer(pos, true);
    if (hitShape && hitShape.type === S.tool) {
      S.selectedShapeId = hitShape.id;
      if (hitShape.locked) {
        renderObjects();
        renderLayerPanel();
        return;
      }
      S.shapeDrag = { mode: "move", start: pos, shape: { ...hitShape }, pending: snapshotState() };
      renderObjects();
      renderLayerPanel();
      return;
    }
    if (S.selectedShapeId) {
      S.selectedShapeId = null;
      renderObjects();
      renderLayerPanel();
    }
    S.isDrawing = true;
  }
  var DRAW_MOVE_HANDLERS = {
    brush: onBrushDrawMove,
    eraser: onEraserDrawMove,
    pen: onPenDrawMove,
    rect: onShapeDrawMove,
    arrow: onShapeDrawMove,
    circle: onShapeDrawMove,
    crop: onCropDrawMove
  };
  function onMouseMove(e) {
    if (S.placingImage && S.placingHandle && S.placingStart) {
      onPlacementDragMove(e);
      return;
    }
    if (S.placingImage) {
      onPlacementHoverMove(e);
      return;
    }
    if (S.panning && S.panStart) {
      onPanMouseMove(e);
      return;
    }
    const pos0 = getPos(e);
    if (S.bitmapDrag) {
      onBitmapDragMouseMove(pos0);
      return;
    }
    if (S.textDrag) {
      onTextDragMouseMove(pos0);
      return;
    }
    if (S.penDragPt >= 0) {
      onPenEditDragMove(pos0);
      return;
    }
    if (S.shapeDrag) {
      onShapeDragMouseMove(pos0);
      return;
    }
    if (!S.isDrawing) return;
    const pos = pos0;
    const handler = Object.prototype.hasOwnProperty.call(DRAW_MOVE_HANDLERS, S.tool) ? DRAW_MOVE_HANDLERS[S.tool] : null;
    if (handler) handler(pos);
  }
  function onPlacementDragMove(e) {
    const pos = getPos(e);
    resizePlacement(pos);
    drawPlacementPreview();
    return;
  }
  function onPlacementHoverMove(e) {
    const pos = getPos(e);
    const h = hitPlacementHandle(pos);
    if (h) S.drawCanvasCursor(h === "rotate" ? ROT_CURSOR : CROP_CURSORS[h] || "move");
    else S.drawCanvasCursor(insidePlacementRect(pos) ? "move" : "default");
    return;
  }
  function onPanMouseMove(e) {
    setView(
      S.panStart.vx + (e.clientX - S.panStart.x),
      S.panStart.vy + (e.clientY - S.panStart.y)
    );
    return;
  }
  function onBitmapDragMouseMove(pos0) {
    applyBitmapDrag(pos0);
    renderObjects();
    return;
  }
  function onTextDragMouseMove(pos0) {
    const t = getSelectedText();
    if (t) {
      if (S.textDrag.mode === "move") {
        const dx = pos0.x - S.textDrag.start.x;
        const dy = pos0.y - S.textDrag.start.y;
        t.x = clamp(S.textDrag.layer.x + dx, 0, Math.max(0, S.imgW - 4));
        t.y = clamp(S.textDrag.layer.y + dy, 0, Math.max(0, S.imgH - 4));
      } else if (S.textDrag.mode === "rotate") {
        const st = S.textDrag;
        const a1 = Math.atan2(pos0.y - st.cy, pos0.x - st.cx);
        const a0 = Math.atan2(st.startY0 - st.cy, st.startX0 - st.cx);
        let deg = st.rotation;
        if (st.startX0 !== void 0) deg = st.rotation + (a1 - a0) * 180 / Math.PI;
        if (S._shiftDown) deg = Math.round(deg / 15) * 15;
        t.rotation = deg;
      } else if (S.textDrag.mode === "scale") {
        const dx = pos0.x - S.textDrag.anchor.x;
        const dy = pos0.y - S.textDrag.anchor.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        const f = d / Math.max(S.textDrag.d0, 1);
        t.fontSize = clamp(Math.round(S.textDrag.fontSize * f), 8, 2e3);
      }
      renderObjects();
    }
    return;
  }
  function onPenEditDragMove(pos0) {
    const penShape = getPenEditingShape();
    if (penShape && penShape.pts[S.penDragPt]) {
      penShape.pts[S.penDragPt].x = clamp(pos0.x, 0, S.imgW);
      penShape.pts[S.penDragPt].y = clamp(pos0.y, 0, S.imgH);
      renderObjects();
    }
    return;
  }
  function onShapeDragMouseMove(pos0) {
    const sh = getSelectedShape();
    if (sh) {
      if (S.shapeDrag.mode === "move") {
        const dx = pos0.x - S.shapeDrag.start.x;
        const dy = pos0.y - S.shapeDrag.start.y;
        const b = shapeBounds(S.shapeDrag.shape);
        const cdx = clamp(dx, -b.x, Math.max(-b.x, S.imgW - (b.x + b.w)));
        const cdy = clamp(dy, -b.y, Math.max(-b.y, S.imgH - (b.y + b.h)));
        if (sh.type === "pen") {
          sh.pts = (S.shapeDrag.shape.pts || []).map((p) => ({ x: p.x + cdx, y: p.y + cdy }));
        } else {
          sh.x1 = S.shapeDrag.shape.x1 + cdx;
          sh.y1 = S.shapeDrag.shape.y1 + cdy;
          sh.x2 = S.shapeDrag.shape.x2 + cdx;
          sh.y2 = S.shapeDrag.shape.y2 + cdy;
        }
      } else {
        applyShapeHandle(sh, S.shapeDrag.handle, pos0);
      }
      renderObjects();
    }
    return;
  }
  function onBrushDrawMove(pos) {
    strokeSegment(S.startX, S.startY, pos.x, pos.y);
    S.startX = pos.x;
    S.startY = pos.y;
    drawToolRing(pos);
  }
  function onEraserDrawMove(pos) {
    eraseSegment(S.startX, S.startY, pos.x, pos.y);
    S.startX = pos.x;
    S.startY = pos.y;
    drawToolRing(pos);
  }
  function onPenDrawMove(pos) {
    if (S.penPath) {
      S.penPath.preview = pos;
      const first = S.penPath.pts[0];
      const nearStart = first && S.penPath.pts.length >= 3 && Math.hypot(pos.x - first.x, pos.y - first.y) <= Math.max(12 / S.zoom, S.brushSize * 1.5);
      S.penPath.nearStart = !!nearStart;
      renderObjects();
    }
  }
  function onShapeDrawMove(pos) {
    const temp = {
      id: "temp",
      type: S.tool,
      x1: S.startX,
      y1: S.startY,
      x2: pos.x,
      y2: pos.y,
      color: S.color,
      lw: Math.max(2, S.brushSize),
      lineWidth: Math.max(2, S.brushSize),
      fill: S.tool === "rect" || S.tool === "circle" ? !!S.rectFill : false,
      opacity: 1,
      visible: true
    };
    renderObjects(temp);
  }
  function onCropDrawMove(pos) {
    if (S.cropHandle) {
      resizeCropRect(pos);
      drawCropPreview();
      updateCropInfo();
    } else if (S.cropMoving && S.moveStart) {
      const dx = pos.x - S.moveStart.x;
      const dy = pos.y - S.moveStart.y;
      const r = S.moveStart.rect;
      const nx = r.x + dx;
      const ny = r.y + dy;
      S.cropRect = { x: nx, y: ny, w: r.w, h: r.h };
      drawCropPreview();
      updateCropInfo();
    } else {
      drawCropPreview(S.startX, S.startY, pos.x, pos.y);
      updateCropInfo();
    }
  }
  var DRAW_UP_HANDLERS = {
    brush: onStrokeDrawUp,
    eraser: onStrokeDrawUp,
    crop: onCropDrawUp,
    rect: onShapeDrawUp,
    arrow: onShapeDrawUp,
    circle: onShapeDrawUp
  };
  function onMouseUp(e) {
    if (S.penDragPt >= 0) {
      onPenEditMouseUp();
      return;
    }
    if (S.placingImage && S.placingHandle) {
      onPlacementMouseUp();
      return;
    }
    if (S.panning) {
      onPanMouseUp();
      return;
    }
    if (S.textDrag) {
      onTextDragMouseUp();
      return;
    }
    if (S.bitmapDrag) {
      onBitmapDragMouseUp();
      return;
    }
    if (S.shapeDrag) {
      onShapeDragMouseUp();
      return;
    }
    if (!S.isDrawing) return;
    S.isDrawing = false;
    const pos = getPos(e);
    const handler = Object.prototype.hasOwnProperty.call(DRAW_UP_HANDLERS, S.tool) ? DRAW_UP_HANDLERS[S.tool] : null;
    if (handler) handler(pos);
  }
  function onPenEditMouseUp() {
    const penShape = getPenEditingShape();
    const pending = S.penDragPending;
    S.penDragPt = -1;
    S.penDragPending = null;
    S.penDragBase = null;
    if (pending && penShape) {
      const cur = snapshotState({ metaOnly: true });
      if (JSON.stringify(cur.shapes) !== JSON.stringify(pending.shapes)) {
        pushHistory(S.history, pending);
        S.redoStack = [];
      }
    }
    return;
  }
  function onPlacementMouseUp() {
    S.placingHandle = null;
    S.placingStart = null;
    drawPlacementPreview();
    return;
  }
  function onPanMouseUp() {
    S.panning = false;
    S.panStart = null;
    updateCursor();
    return;
  }
  function onTextDragMouseUp() {
    const pending = S.textDrag.pending;
    if (pending) {
      const cur = snapshotState({ metaOnly: true });
      if (JSON.stringify(cur.texts) !== JSON.stringify(pending.texts)) {
        pushHistory(S.history, pending);
        S.redoStack = [];
      }
    }
    S.textDrag = null;
    renderLayerPanel();
    return;
  }
  function onBitmapDragMouseUp() {
    const pending = S.bitmapDrag.pending;
    if (pending) {
      const cur = snapshotState({ metaOnly: true });
      const before = pending.bitmaps.find((b) => b.id === S.selectedLayerId);
      const after = cur.bitmaps.find((b) => b.id === S.selectedLayerId);
      if (before && after && JSON.stringify([before.x, before.y, before.w, before.h]) !== JSON.stringify([after.x, after.y, after.w, after.h])) {
        pushHistory(S.history, pending);
        S.redoStack = [];
      }
    }
    S.bitmapDrag = null;
    renderObjects();
    renderLayerPanel();
    return;
  }
  function onShapeDragMouseUp() {
    const pending = S.shapeDrag.pending;
    if (pending) {
      const cur = snapshotState({ metaOnly: true });
      if (JSON.stringify(cur.shapes) !== JSON.stringify(pending.shapes) || JSON.stringify(cur.texts) !== JSON.stringify(pending.texts)) {
        pushHistory(S.history, pending);
        S.redoStack = [];
      }
    }
    S.shapeDrag = null;
    renderLayerPanel();
    return;
  }
  function onStrokeDrawUp() {
    endStroke();
    return;
  }
  function onCropDrawUp(pos) {
    if (S.cropHandle) {
      S.cropHandle = null;
      drawCropPreview();
      updateCropInfo();
      return;
    }
    if (S.cropMoving) {
      S.cropMoving = false;
      S.moveStart = null;
      drawCropPreview();
      updateCropInfo();
      return;
    }
    const r = applyConstraintDrag(S.startX, S.startY, pos.x, pos.y);
    if (r.w > 2 && r.h > 2) {
      S.cropRect = { x: r.x, y: r.y, w: r.w, h: r.h };
      showCropBar();
      drawCropPreview();
      updateCropInfo();
    } else {
      clearOverlay();
    }
  }
  function onShapeDrawUp(pos) {
    const len = Math.hypot(pos.x - S.startX, pos.y - S.startY);
    const ok = S.tool === "rect" || S.tool === "circle" ? Math.abs(pos.x - S.startX) > 2 && Math.abs(pos.y - S.startY) > 2 : len > 3;
    if (ok) {
      saveSnapshot();
      const shape = {
        id: "s" + Date.now() + Math.floor(Math.random() * 1e3),
        type: S.tool,
        x1: S.startX,
        y1: S.startY,
        x2: pos.x,
        y2: pos.y,
        color: S.color,
        lw: Math.max(2, S.brushSize),
        fill: S.tool === "rect" || S.tool === "circle" ? !!S.rectFill : false,
        opacity: 1,
        visible: true,
        locked: false,
        z: ++S.zCounter
      };
      S.shapeLayers.push(shape);
      S.selectedShapeId = shape.id;
    }
    renderObjects();
    renderLayerPanel();
  }
  function onWheel(e) {
    if (!S.open) return;
    e.preventDefault();
    const rect = S.canvasWrap.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    zoomStep(factor, mx, my);
  }
  function updateAllUI() {
    updateToolUI();
    updateColorUI();
    updateBrushUI();
    updateBrushParamUI();
    updateFillUI();
    updateLayerUI();
    updateZoomUI();
    hidePickerTip();
    runtime.el.querySelectorAll(".iwb-editor-constraint-btn[data-ratio]").forEach((b) => b.classList.remove("active"));
    const freeBtn = runtime.el.querySelector('.iwb-editor-constraint-btn[data-ratio="free"]');
    if (freeBtn) freeBtn.classList.add("active");
    hideCropBar();
    updateCropInfo();
    hideTextInput();
    S.selectedTextId = null;
    S.textDrag = null;
    S.selectedShapeId = null;
    S.shapeDrag = null;
    renderLayerPanel();
  }
  function updateZoomUI() {
    const val = runtime.el.querySelector(".iwb-editor-zoom-val");
    if (val) val.textContent = Math.round(S.zoom * 100) + "%";
  }
  function updateToolUI() {
    runtime.el.querySelectorAll(".iwb-editor-tool").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tool === S.tool);
    });
    updateCursor();
  }
  function updateCursor() {
    if (S.panning) {
      S.drawCanvasCursor("grabbing");
      return;
    }
    if (S.spaceDown) {
      S.drawCanvasCursor("grab");
      return;
    }
    if (S.tool === "hand") {
      S.drawCanvasCursor("grab");
      return;
    }
    if (S.tool === "brush" || S.tool === "eraser") {
      S.drawCanvasCursor("none");
      return;
    }
    if (S.tool === "crop" && S.cropRect) {
      S.drawCanvasCursor("crosshair");
      return;
    }
    S.drawCanvasCursor(S.tool === "text" ? "text" : S.tool === "select" ? "default" : "crosshair");
  }
  S.drawCanvasCursor = function(cur) {
    for (const layer of S.layers) {
      layer.canvas.style.cursor = cur;
    }
  };
  function updateColorUI() {
    let matchPreset = false;
    runtime.el.querySelectorAll(".iwb-editor-color[data-color]").forEach((s) => {
      const on = (s.dataset.color || "").toLowerCase() === S.color.toLowerCase();
      if (on) matchPreset = true;
      s.classList.toggle("active", on);
    });
    const panelHex = runtime.el.querySelector(".iwb-editor-color-hex");
    const hexInput = runtime.el.querySelector(".iwb-editor-color-hex-input");
    if (hexInput && document.activeElement !== hexInput) hexInput.value = S.color.toUpperCase();
    runtime.el.querySelectorAll(".iwb-editor-color-panel-swatch").forEach((sw) => sw.classList.toggle("active", (sw.dataset.panelColor || "").toLowerCase() === S.color.toLowerCase()));
    if (panelHex) panelHex.textContent = S.color.toUpperCase();
    const rgb = hexToRgb(S.color);
    const max = Math.max(rgb.r, rgb.g, rgb.b) / 255, min = Math.min(rgb.r, rgb.g, rgb.b) / 255;
    const d = max - min;
    let h = 0;
    if (d) {
      if (max === rgb.r / 255) h = 60 * ((rgb.g - rgb.b) / 255 / d % 6);
      else if (max === rgb.g / 255) h = 60 * ((rgb.b - rgb.r) / 255 / d + 2);
      else h = 60 * ((rgb.r - rgb.g) / 255 / d + 4);
    }
    if (h < 0) h += 360;
    const sv = runtime.el.querySelector(".iwb-color-sv"), hue = runtime.el.querySelector(".iwb-color-hue");
    if (sv) sv.style.backgroundColor = `hsl(${h} 100% 50%)`;
    if (hue) hue.dataset.hue = h;
    const hueMarker = hue && hue.querySelector("span");
    if (hueMarker) hueMarker.style.top = h / 360 * 100 + "%";
    const svMarker = sv && sv.querySelector("span");
    if (svMarker) {
      const sat = max ? d / max : 0;
      svMarker.style.left = sat * 100 + "%";
      svMarker.style.top = (1 - max) * 100 + "%";
    }
    const custom = runtime.el.querySelector(".iwb-editor-color-custom");
    if (custom) {
      custom.classList.toggle("active", !matchPreset);
      const inp = custom.querySelector("input");
      if (inp) inp.value = S.color;
    }
  }
  function updateBrushUI() {
    const slider = runtime.el.querySelector(".iwb-editor-brush-size");
    if (!slider) return;
    slider.value = S.brushSize;
    const num2 = runtime.el.querySelector(".iwb-editor-brush-num");
    if (num2 && document.activeElement !== num2) num2.value = S.brushSize;
  }
  function updateBrushParamUI() {
    const g = runtime.el.querySelector(".iwb-editor-brush-group");
    if (!g) return;
    g.style.display = S.tool === "brush" || S.tool === "eraser" ? "flex" : "none";
    const oLabel = g.querySelector(".iwb-editor-opacity-label");
    if (oLabel) oLabel.style.display = S.tool === "brush" || S.tool === "eraser" ? "" : "none";
    const h = g.querySelector(".iwb-editor-brush-hardness");
    if (h) {
      h.value = S.brushHardness;
      g.querySelector(".iwb-editor-brush-hardness-val").textContent = S.brushHardness;
    }
    const o = g.querySelector(".iwb-editor-brush-opacity");
    if (o) {
      o.value = Math.round(S.brushOpacity * 100);
      g.querySelector(".iwb-editor-brush-opacity-val").textContent = Math.round(S.brushOpacity * 100) + "%";
    }
  }
  function updateFillUI() {
    const b = runtime.el.querySelector('[data-action="toggleFill"]');
    if (b) b.classList.toggle("active", !!S.rectFill);
  }
  function updateLayerUI() {
    const hasSel = !!(S.selectedTextId || S.selectedShapeId || S.layers.some((l) => l.id === S.selectedLayerId && l.id !== "base" && !l.locked));
    runtime.el.querySelectorAll(".iwb-editor-layer-btn").forEach((b) => {
      b.disabled = !hasSel;
    });
  }
  var warnedMissing = /* @__PURE__ */ new Set();
  function bindIf(selector, type, handler, root) {
    const el = (root || runtime.el).querySelector(selector);
    if (!el) {
      if (!warnedMissing.has(selector)) {
        warnedMissing.add(selector);
        console.warn("[IWB\u7F16\u8F91\u5668] \u672A\u627E\u5230\u5143\u7D20\uFF0C\u8DF3\u8FC7\u7ED1\u5B9A\uFF1A" + selector);
      }
      return null;
    }
    el.addEventListener(type, handler);
    return el;
  }
  function bindEvents() {
    bindToolButtons();
    bindColorPanel();
    bindCropConstraintControls();
    bindColorPalette();
    bindFillToggle();
    bindLayerOrderButtons();
    bindBrushSizeControls();
    bindBrushParams();
    bindZoomButtons();
    bindHistoryActions();
    bindCropActions();
    bindLayerAddActions();
    bindExportActions();
    bindWheelZoom();
    bindTextInput();
    bindGlobalListeners();
  }
  function bindToolButtons() {
    runtime.el.querySelectorAll(".iwb-editor-tool").forEach((btn) => {
      btn.addEventListener("mousedown", (e) => e.stopPropagation());
      btn.addEventListener("click", () => setTool(btn.dataset.tool));
    });
  }
  function bindColorPanel() {
    const setPanelColor = (color) => applyColorChange(color);
    const panelHexInput = runtime.el.querySelector(".iwb-editor-color-hex-input");
    if (panelHexInput) panelHexInput.addEventListener("change", () => {
      if (/^#[0-9a-f]{6}$/i.test(panelHexInput.value)) setPanelColor(panelHexInput.value);
    });
    runtime.el.querySelectorAll(".iwb-editor-color-panel-swatch").forEach((btn) => btn.addEventListener("click", (e) => {
      e.stopPropagation();
      setPanelColor(btn.dataset.panelColor);
    }));
    const palettePick = runtime.el.querySelector('[data-action="palettePick"]');
    if (palettePick) {
      palettePick.addEventListener("mousedown", (e) => e.stopPropagation());
      palettePick.addEventListener("click", () => setTool("picker"));
    }
    const sv = runtime.el.querySelector(".iwb-color-sv");
    const hue = runtime.el.querySelector(".iwb-color-hue");
    const initHsv = (() => {
      const { r, g, b } = hexToRgb(S.color);
      const rr = r / 255, gg = g / 255, bb = b / 255;
      const max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb), d = max - min;
      let h = 0;
      if (d) {
        if (max === rr) h = 60 * ((gg - bb) / d % 6);
        else if (max === gg) h = 60 * ((bb - rr) / d + 2);
        else h = 60 * ((rr - gg) / d + 4);
      }
      if (h < 0) h += 360;
      return { h, sat: max ? d / max : 0, val: max };
    })();
    let hueValue = initHsv.h;
    let satValue = initHsv.sat;
    let valValue = initHsv.val;
    const hsvToHex = (h, sat, val) => {
      const c = val * sat, x = c * (1 - Math.abs(h / 60 % 2 - 1)), m = val - c;
      let r = 0, g = 0, b = 0;
      if (h < 60) {
        r = c;
        g = x;
      } else if (h < 120) {
        r = x;
        g = c;
      } else if (h < 180) {
        g = c;
        b = x;
      } else if (h < 240) {
        g = x;
        b = c;
      } else if (h < 300) {
        r = x;
        b = c;
      } else {
        r = c;
        b = x;
      }
      return rgbToHex(Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255));
    };
    const pick = (target, e) => {
      const r = target.getBoundingClientRect();
      const x = clamp((e.clientX - r.left) / r.width, 0, 1);
      const y = clamp((e.clientY - r.top) / r.height, 0, 1);
      if (target === hue) hueValue = y * 360;
      else {
        satValue = x;
        valValue = 1 - y;
      }
      setPanelColor(hsvToHex(hueValue, satValue, valValue));
    };
    if (sv) {
      sv.addEventListener("pointerdown", (e) => {
        sv.setPointerCapture(e.pointerId);
        pick(sv, e);
      });
      sv.addEventListener("pointermove", (e) => {
        if (e.buttons) pick(sv, e);
      });
    }
    if (hue) {
      hue.addEventListener("pointerdown", (e) => {
        pick(hue, e);
      });
      hue.addEventListener("pointermove", (e) => {
        if (e.buttons) pick(hue, e);
      });
    }
  }
  function bindCropConstraintControls() {
    runtime.el.querySelectorAll(".iwb-editor-constraint-btn[data-ratio]").forEach((btn) => {
      btn.addEventListener("mousedown", (e) => e.stopPropagation());
      btn.addEventListener("click", () => {
        const r = btn.dataset.ratio;
        runtime.el.querySelectorAll(".iwb-editor-constraint-btn[data-ratio]").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        const ratio = parseRatio(r);
        if (ratio > 0) {
          setConstraint("ratio", ratio, 0, 0);
        } else {
          setConstraint("free", 0, 0, 0);
        }
      });
    });
    const sizeToggle = runtime.el.querySelector('[data-action="toggleSizeConstraint"]');
    if (sizeToggle) sizeToggle.addEventListener("click", () => {
      if (S.cropConstraint.type === "size") setConstraint("free", 0, 0, 0);
      else {
        const w = parseInt(runtime.el.querySelector(".iwb-editor-size-w").value, 10), h = parseInt(runtime.el.querySelector(".iwb-editor-size-h").value, 10);
        if (w > 0 && h > 0) setConstraint("size", w / h, w, h);
      }
    });
    bindIf('[data-action="applySize"]', "mousedown", (e) => e.stopPropagation());
    bindIf('[data-action="applySize"]', "click", () => {
      const w = parseInt(runtime.el.querySelector(".iwb-editor-size-w").value, 10);
      const h = parseInt(runtime.el.querySelector(".iwb-editor-size-h").value, 10);
      if (w > 0 && h > 0) {
        runtime.el.querySelectorAll(".iwb-editor-constraint-btn[data-ratio]").forEach((b) => b.classList.remove("active"));
        setConstraint("size", w / h, w, h);
      }
    });
  }
  function bindColorPalette() {
    runtime.el.querySelectorAll(".iwb-editor-color[data-color]").forEach((s) => {
      s.addEventListener("mousedown", (e) => e.stopPropagation());
      s.addEventListener("click", () => applyColorChange(s.dataset.color));
    });
    const colorInput = runtime.el.querySelector(".iwb-editor-color-picker-input");
    if (colorInput) {
      colorInput.addEventListener("mousedown", (e) => e.stopPropagation());
      colorInput.addEventListener("input", () => applyColorChange(colorInput.value));
    }
  }
  function bindFillToggle() {
    const fillBtn = runtime.el.querySelector('[data-action="toggleFill"]');
    if (fillBtn) fillBtn.addEventListener("mousedown", (e) => e.stopPropagation());
    fillBtn && fillBtn.addEventListener("click", () => {
      S.rectFill = !S.rectFill;
      updateFillUI();
      const sh = getSelectedShape();
      if (sh && (sh.type === "rect" || sh.type === "circle") && (S.tool === "rect" || S.tool === "circle" || S.tool === "select")) {
        saveSnapshot();
        sh.fill = S.rectFill;
        renderObjects();
      }
    });
  }
  function bindLayerOrderButtons() {
    runtime.el.querySelectorAll(".iwb-editor-layer-btn").forEach((btn) => {
      btn.addEventListener("mousedown", (e) => e.stopPropagation());
      btn.addEventListener("click", () => moveLayer(btn.dataset.layer));
    });
  }
  function bindBrushSizeControls() {
    const slider = runtime.el.querySelector(".iwb-editor-brush-size");
    const brushNum = runtime.el.querySelector(".iwb-editor-brush-num");
    let lwHistoryPushed = false;
    const syncBrushSize = (value, continuous) => {
      const v = clamp(parseInt(value, 10) || 1, 1, 300);
      S.brushSize = v;
      slider.value = v;
      if (brushNum && document.activeElement !== brushNum) brushNum.value = v;
      const sh = getSelectedShape();
      if (sh && !sh.locked && sh.lw !== v) {
        if (!continuous || !lwHistoryPushed) {
          saveSnapshot();
          lwHistoryPushed = true;
        }
        sh.lw = v;
        renderObjects();
        renderLayerPanel();
      }
      if (!continuous) lwHistoryPushed = false;
    };
    runtime.el.querySelectorAll(".iwb-editor-brush-preset").forEach((btn) => {
      btn.addEventListener("mousedown", (e) => e.stopPropagation());
      btn.addEventListener("click", () => syncBrushSize(btn.dataset.brushSize, false));
    });
    slider && slider.addEventListener("input", () => syncBrushSize(slider.value, true));
    slider && slider.addEventListener("change", () => syncBrushSize(slider.value, false));
    if (brushNum) {
      brushNum.addEventListener("mousedown", (e) => e.stopPropagation());
      brushNum.addEventListener("input", () => {
        const v = clamp(parseInt(brushNum.value, 10) || 1, 1, 300);
        syncBrushSize(v, true);
      });
      brushNum.addEventListener("blur", () => {
        brushNum.value = S.brushSize;
        lwHistoryPushed = false;
      });
    }
  }
  function bindBrushParams() {
    const hardnessSlider = runtime.el.querySelector(".iwb-editor-brush-hardness");
    hardnessSlider && hardnessSlider.addEventListener("input", () => {
      S.brushHardness = parseInt(hardnessSlider.value, 10);
      runtime.el.querySelector(".iwb-editor-brush-hardness-val").textContent = S.brushHardness;
    });
    const opacitySlider = runtime.el.querySelector(".iwb-editor-brush-opacity");
    opacitySlider && opacitySlider.addEventListener("input", () => {
      S.brushOpacity = parseInt(opacitySlider.value, 10) / 100;
      runtime.el.querySelector(".iwb-editor-brush-opacity-val").textContent = opacitySlider.value + "%";
      if (S.strokeCanvas) S.strokeCanvas.style.opacity = S.brushOpacity;
    });
  }
  function bindZoomButtons() {
    bindIf('[data-action="zoomOut"]', "click", (e) => {
      e.stopPropagation();
      zoomStep(1 / ZOOM_STEP, S.canvasWrap.clientWidth / 2, S.canvasWrap.clientHeight / 2);
    });
    bindIf('[data-action="zoomIn"]', "click", (e) => {
      e.stopPropagation();
      zoomStep(ZOOM_STEP, S.canvasWrap.clientWidth / 2, S.canvasWrap.clientHeight / 2);
    });
    bindIf('[data-action="zoomFit"]', "click", (e) => {
      e.stopPropagation();
      setZoomFit();
    });
  }
  function bindHistoryActions() {
    const undoBtn = runtime.el.querySelector('[data-action="undo"]');
    const redoBtn = runtime.el.querySelector('[data-action="redo"]');
    const resetBtn = runtime.el.querySelector('[data-action="reset"]');
    const restoreBtn = runtime.el.querySelector('[data-action="restore"]');
    undoBtn && undoBtn.addEventListener("mousedown", (e) => e.stopPropagation());
    redoBtn && redoBtn.addEventListener("mousedown", (e) => e.stopPropagation());
    resetBtn && resetBtn.addEventListener("mousedown", (e) => e.stopPropagation());
    restoreBtn && restoreBtn.addEventListener("mousedown", (e) => e.stopPropagation());
    undoBtn && undoBtn.addEventListener("click", undo);
    redoBtn && redoBtn.addEventListener("click", redo);
    resetBtn && resetBtn.addEventListener("click", resetDraw);
    restoreBtn && restoreBtn.addEventListener("click", restoreOriginal);
  }
  function bindCropActions() {
    bindIf('[data-action="confirmCrop"]', "click", confirmCrop);
    bindIf('[data-action="cancelCrop"]', "click", cancelCrop);
  }
  function bindLayerAddActions() {
    bindIf('[data-action="addBitmapLayer"]', "mousedown", (e) => e.stopPropagation());
    bindIf('[data-action="addBitmapLayer"]', "click", () => {
      const fileInput = document.createElement("input");
      fileInput.type = "file";
      fileInput.accept = "image/*";
      fileInput.addEventListener("change", async () => {
        const file = fileInput.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async () => {
          try {
            const img = await loadImage(reader.result);
            addBitmapLayer(img);
          } catch (err) {
            console.error("[IWB\u7F16\u8F91\u5668] \u5BFC\u5165\u56FE\u5C42\u5931\u8D25:", err);
          }
        };
        reader.readAsDataURL(file);
      });
      fileInput.click();
    });
    bindIf('[data-action="addBlankLayer"]', "mousedown", (e) => e.stopPropagation());
    bindIf('[data-action="addBlankLayer"]', "click", () => {
      addBlankLayer();
    });
  }
  function bindExportActions() {
    bindIf('[data-action="cancel"]', "click", close);
    bindIf('[data-action="newNode"]', "click", () => exportResult("newNode"));
    bindIf('[data-action="replace"]', "click", () => exportResult("replace"));
  }
  function bindWheelZoom() {
    S.canvasWrap.addEventListener("wheel", onWheel, { passive: false });
  }
  function bindTextInput() {
    const textInput = runtime.el.querySelector(".iwb-editor-text-input");
    textInput && textInput.addEventListener("mousedown", (e) => e.stopPropagation());
    textInput && textInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        commitTextInput();
      } else if (e.key === "Escape") {
        e.preventDefault();
        hideTextInput();
      }
    });
  }
  function bindGlobalListeners() {
    document.addEventListener("keydown", onKeydown, true);
    document.addEventListener("keyup", onKeyup, true);
    window.addEventListener("blur", () => {
      if (S.spaceDown) {
        S.spaceDown = false;
        updateCursor();
      }
      if (S.panning) {
        S.panning = false;
        S.panStart = null;
        updateCursor();
      }
      S._shiftDown = false;
    });
    bindIf(".iwb-editor-modal", "mousedown", (e) => e.stopPropagation());
  }
  function commitPenPath() {
    if (!S.penPath || S.penPath.pts.length < 2) {
      S.penPath = null;
      renderObjects();
      return;
    }
    saveSnapshot();
    const shape = { id: "s" + Date.now() + Math.floor(Math.random() * 1e3), type: "pen", pts: S.penPath.pts.slice(), closed: !!S.penPath.closed, color: S.color, lw: Math.max(2, S.brushSize), fill: !!S.penPath.closed, opacity: 1, visible: true, locked: false, z: ++S.zCounter };
    S.shapeLayers.push(shape);
    S.selectedShapeId = shape.id;
    S.penPath = null;
    renderObjects();
    renderLayerPanel();
  }
  function bindCanvasEvents() {
    if (S._canvasEventsBound) return;
    S._canvasEventsBound = true;
    S.canvasStack.addEventListener("mousedown", onMouseDown);
    S.canvasStack.addEventListener("mousemove", onMouseMove);
    S.canvasStack.addEventListener("mousemove", onCanvasHover);
    window.addEventListener("mouseup", onMouseUp);
    S.canvasStack.addEventListener("contextmenu", (e) => e.preventDefault());
    S.canvasStack.addEventListener("mouseleave", () => {
      if (S.placingImage) return;
      if ((S.tool === "brush" || S.tool === "eraser") && !S.isDrawing) clearOverlay();
      if (S.tool === "picker") hidePickerTip();
    });
    S.canvasStack.addEventListener("dblclick", (e) => {
      if (S.placingImage) return;
      const pos = getPos(e);
      if (S.tool === "pen" && S.penPath) {
        commitPenPath();
        return;
      }
      if (S.tool === "select" || S.tool === "pen") {
        const penShape = getPenEditingShape();
        if (penShape) {
          const pi = hitPenPoint(pos, penShape, Math.max(14 / S.zoom, 8));
          if (pi >= 0) {
            e.preventDefault();
            saveSnapshot();
            const pts = penShape.pts;
            const minPts = penShape.closed ? 3 : 2;
            if (pts.length <= minPts) {
              removeVecCanvas(penShape);
              S.shapeLayers = S.shapeLayers.filter((x) => x.id !== penShape.id);
              S.penEditId = null;
              S.selectedShapeId = null;
            } else {
              pts.splice(pi, 1);
              if (penShape.closed && pts.length < 3) penShape.closed = false;
            }
            renderObjects();
            renderLayerPanel();
            return;
          }
          return;
        }
        const hitPen = hitShapeLayer(pos, true);
        if (hitPen && hitPen.type === "pen") {
          e.preventDefault();
          beginPenEdit(hitPen);
          return;
        }
      }
      if (S.tool !== "text" && S.tool !== "select") return;
      const hit = hitTextLayer(pos);
      if (hit) {
        S.selectedTextId = hit.id;
        if (hit.locked) return;
        renderObjects();
        showTextInput(hit.x, hit.y, hit);
      }
    });
  }
  var CROP_CURSORS = {
    nw: "nwse-resize",
    se: "nwse-resize",
    ne: "nesw-resize",
    sw: "nesw-resize",
    n: "ns-resize",
    s: "ns-resize",
    e: "ew-resize",
    w: "ew-resize"
  };
  var HOVER_HANDLERS = {
    select: onHoverSelect,
    picker: onHoverPicker,
    hand: onHoverHand,
    brush: onHoverBrushRing,
    eraser: onHoverBrushRing,
    crop: onHoverCrop,
    text: onHoverText,
    pen: onHoverCrosshair,
    rect: onHoverShape,
    arrow: onHoverShape,
    circle: onHoverShape
  };
  function onCanvasHover(e) {
    if (S.placingImage) return;
    if (S.panning || S.spaceDown) return;
    if (S.isDrawing || S.textDrag || S.shapeDrag) return;
    const p = getPos(e);
    if (isOverRotationHandle(p)) {
      S.drawCanvasCursor(ROT_CURSOR);
      return;
    }
    const handler = Object.prototype.hasOwnProperty.call(HOVER_HANDLERS, S.tool) ? HOVER_HANDLERS[S.tool] : null;
    if (handler) handler(p, e);
    else S.drawCanvasCursor("crosshair");
  }
  function onHoverSelect(p) {
    const th = hitTextHandle(p);
    if (th) {
      S.drawCanvasCursor(th === "nw" || th === "se" ? "nwse-resize" : "nesw-resize");
      return;
    }
    const shh = hitShapeHandle(p);
    if (shh) {
      const sh = getSelectedShape();
      if (sh && sh.type === "rect" && CROP_CURSORS[shh]) S.drawCanvasCursor(CROP_CURSORS[shh]);
      else S.drawCanvasCursor("move");
      return;
    }
    S.drawCanvasCursor(hitAnyObject(p) ? "move" : "default");
  }
  function onHoverPicker(p, e) {
    S.drawCanvasCursor("crosshair");
    showPickerTip(e, sampleColor(p));
  }
  function onHoverHand() {
    S.drawCanvasCursor("grab");
  }
  function onHoverBrushRing(p) {
    S.drawCanvasCursor("none");
    drawToolRing(p);
  }
  function onHoverCrop(p) {
    if (S.cropRect) {
      const h = hitCropHandle(p);
      if (h && CROP_CURSORS[h]) {
        S.drawCanvasCursor(CROP_CURSORS[h]);
        return;
      }
      if (insideRect(p, S.cropRect)) {
        S.drawCanvasCursor("move");
        return;
      }
    }
    S.drawCanvasCursor("crosshair");
  }
  function onHoverText(p) {
    const h = hitTextHandle(p);
    if (h) {
      S.drawCanvasCursor(h === "nw" || h === "se" ? "nwse-resize" : "nesw-resize");
      return;
    }
    S.drawCanvasCursor(hitTextLayer(p) ? "move" : "text");
  }
  function onHoverCrosshair() {
    S.drawCanvasCursor("crosshair");
  }
  function onHoverShape(p) {
    const h = hitShapeHandle(p);
    if (h) {
      const sh = getSelectedShape();
      if (sh && sh.type === "rect" && CROP_CURSORS[h]) S.drawCanvasCursor(CROP_CURSORS[h]);
      else S.drawCanvasCursor("move");
      return;
    }
    S.drawCanvasCursor("crosshair");
  }
  function isTyping(e) {
    const t = e.target;
    return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA");
  }
  function onKeydown(e) {
    if (!S.open) return;
    if (S.placingImage) {
      if (e.key === "Enter") {
        e.preventDefault();
        confirmImagePlacement();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        cancelImagePlacement();
        return;
      }
    }
    if (e.key === "Shift") S._shiftDown = true;
    if (e.key === "Enter" && S.tool === "pen" && S.penPath) {
      e.preventDefault();
      commitPenPath();
      return;
    }
    if (e.key === "Escape") {
      if (isTyping(e)) {
        hideTextInput();
        return;
      }
      if (S.penPath) {
        e.preventDefault();
        S.penPath = null;
        renderObjects();
        return;
      }
      if (getPenEditingShape()) {
        e.preventDefault();
        exitPenEdit();
        return;
      }
      if (S.selectedLayerId || S.selectedTextId || S.selectedShapeId || S.bitmapDrag || S.textDrag || S.shapeDrag) {
        e.preventDefault();
        clearSelection();
        renderObjects();
        renderLayerPanel();
      }
      return;
    }
    if (isTyping(e)) return;
    const toolByKey = { "1": "select", "2": "brush", "3": "eraser", "4": "pen", "5": "text", "6": "rect", "7": "circle", "8": "arrow", "9": "picker", "0": "crop" };
    if (!e.ctrlKey && !e.metaKey && !e.altKey && Object.prototype.hasOwnProperty.call(toolByKey, e.key)) {
      e.preventDefault();
      setTool(toolByKey[e.key]);
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      if (S.selectedTextId) {
        e.preventDefault();
        deleteSelectedText();
        renderLayerPanel();
        return;
      }
      if (S.selectedShapeId) {
        e.preventDefault();
        deleteSelectedShape();
        renderLayerPanel();
        return;
      }
    }
    if (e.code === "Space") {
      e.preventDefault();
      if (!S.spaceDown) {
        S.spaceDown = true;
        updateCursor();
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === "]" || e.key === "[")) {
      e.preventDefault();
      const up = e.key === "]";
      moveLayer(e.shiftKey ? up ? "top" : "bottom" : up ? "up" : "down");
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "z") {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    }
  }
  function onKeyup(e) {
    if (e.key === "Shift") S._shiftDown = false;
    if (e.code === "Space" && S.spaceDown) {
      S.spaceDown = false;
      updateCursor();
    }
  }

  // iwb-cutout-extension/src/editor/viewport.js
  function syncOverlayCanvas() {
    const pad = S.overlayPad || 0;
    const scale = S.imgW ? S.fitW * S.zoom / S.imgW : 1;
    S.overlayCanvas.style.left = "0px";
    S.overlayCanvas.style.top = "0px";
    S.overlayCanvas.style.width = Math.round((S.imgW + pad * 2) * scale) + "px";
    S.overlayCanvas.style.height = Math.round((S.imgH + pad * 2) * scale) + "px";
  }
  function setupCanvas(img) {
    purgeVectorCanvases();
    for (const layer of S.layers) {
      if (layer.canvas.parentNode) layer.canvas.parentNode.removeChild(layer.canvas);
    }
    S.layers = [];
    S.textCanvas.width = S.imgW;
    S.textCanvas.height = S.imgH;
    S.strokeCanvas.width = S.imgW;
    S.strokeCanvas.height = S.imgH;
    S.strokeCanvas.style.display = "none";
    S.overlayPad = Math.max(96, Math.ceil(Math.max(S.imgW, S.imgH) * 0.18));
    S.overlayCanvas.width = S.imgW + S.overlayPad * 2;
    S.overlayCanvas.height = S.imgH + S.overlayPad * 2;
    S.overlayCtx.setTransform(1, 0, 0, 1, S.overlayPad, S.overlayPad);
    const baseCanvas = createLayerCanvas();
    const baseCtx = baseCanvas.getContext("2d", { willReadFrequently: true });
    baseCtx.clearRect(0, 0, S.imgW, S.imgH);
    baseCtx.drawImage(img, 0, 0);
    S.layers.push({
      id: "base",
      name: "\u539F\u56FE",
      canvas: baseCanvas,
      ctx: baseCtx,
      opacity: 1,
      visible: true,
      locked: true,
      z: 0
    });
    const drawCanvas = createLayerCanvas();
    const drawCtx = drawCanvas.getContext("2d", { willReadFrequently: true });
    drawCtx.clearRect(0, 0, S.imgW, S.imgH);
    S.layers.push({
      id: "draw",
      name: "\u753B\u7B14\u6807\u6CE8",
      canvas: drawCanvas,
      ctx: drawCtx,
      opacity: 1,
      visible: true,
      locked: false,
      transformable: true,
      x: 0,
      y: 0,
      w: S.imgW,
      h: S.imgH,
      color: S.color,
      lineWidth: S.brushSize,
      z: 1
    });
    S.activeLayerId = "draw";
    S.zCounter = Math.max(S.layers.length - 1, 0);
    S.textCtx.clearRect(0, 0, S.imgW, S.imgH);
    S.strokeCtx.clearRect(0, 0, S.imgW, S.imgH);
    clearOverlay();
    S.pickerComposite = null;
    renderObjects();
    computeFit();
    S.viewX = null;
    applyView();
    renderLayerPanel();
    bindCanvasEvents();
  }
  function computeFit() {
    const availW = Math.max(50, S.canvasWrap.clientWidth - 48);
    const availH = Math.max(50, S.canvasWrap.clientHeight - 48);
    const ratio = Math.min(availW / S.imgW, availH / S.imgH);
    S.fitW = Math.max(1, S.imgW * ratio);
    S.fitH = Math.max(1, S.imgH * ratio);
  }
  function applyView(anchor) {
    const w = Math.round(S.fitW * S.zoom);
    const h = Math.round(S.fitH * S.zoom);
    for (const layer of S.layers) {
      layer.canvas.style.width = w + "px";
      layer.canvas.style.height = h + "px";
    }
    S.textCanvas.style.width = S.strokeCanvas.style.width = w + "px";
    S.textCanvas.style.height = S.strokeCanvas.style.height = h + "px";
    syncOverlayCanvas();
    const scale = S.imgW ? S.fitW * S.zoom / S.imgW : 1;
    if (S.transparencyGrid) {
      S.transparencyGrid.style.left = Math.round((S.overlayPad || 0) * scale) + "px";
      S.transparencyGrid.style.top = Math.round((S.overlayPad || 0) * scale) + "px";
      S.transparencyGrid.style.width = w + "px";
      S.transparencyGrid.style.height = h + "px";
    }
    const pad = S.overlayPad || 0;
    S.canvasStack.style.width = Math.round((S.imgW + pad * 2) * scale) + "px";
    S.canvasStack.style.height = Math.round((S.imgH + pad * 2) * scale) + "px";
    const layerOffset = Math.round(pad * scale);
    for (const layer of S.layers) {
      layer.canvas.style.left = layerOffset + "px";
      layer.canvas.style.top = layerOffset + "px";
    }
    S.textCanvas.style.left = layerOffset + "px";
    S.textCanvas.style.top = layerOffset + "px";
    S.strokeCanvas.style.left = layerOffset + "px";
    S.strokeCanvas.style.top = layerOffset + "px";
    styleVectorViewport(w, h, layerOffset);
    let left, top;
    if (anchor && anchor.mx !== void 0) {
      left = anchor.mx - anchor.px * S.zoom;
      top = anchor.my - anchor.py * S.zoom;
    } else if (S.viewX !== null) {
      left = S.viewX;
      top = S.viewY;
    } else {
      left = (S.canvasWrap.clientWidth - w) / 2;
      top = (S.canvasWrap.clientHeight - h) / 2;
    }
    setView(left, top);
    updateZoomUI();
  }
  function setView(x, y) {
    S.viewX = x;
    S.viewY = y;
    const stack = S.canvasStack;
    const scale = S.imgW ? S.fitW * S.zoom / S.imgW : 1;
    const pad = S.overlayPad || 0;
    stack.style.transform = `translate3d(${Math.round(x - pad * scale)}px, ${Math.round(y - pad * scale)}px, 0)`;
  }
  function zoomStep(factor, mx, my) {
    const nz = clamp(S.zoom * factor, ZOOM_MIN, ZOOM_MAX);
    if (nz === S.zoom) return;
    const px = (mx - (S.viewX || 0)) / S.zoom;
    const py = (my - (S.viewY || 0)) / S.zoom;
    S.zoom = nz;
    applyView({ mx, my, px, py });
  }
  function setZoomFit() {
    S.zoom = 1;
    S.viewX = null;
    applyView();
  }
  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }
  function rotPt(px, py, cx, cy, deg) {
    if (!deg) return [px, py];
    const a = deg * Math.PI / 180, sn = Math.sin(a), cs = Math.cos(a);
    const dx = px - cx, dy = py - cy;
    return [cx + dx * cs - dy * sn, cy + dx * sn + dy * cs];
  }
  function unrotPt(px, py, cx, cy, deg) {
    return rotPt(px, py, cx, cy, -(deg || 0));
  }
  function rotationHandlesLocal(b) {
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const d = 26 / Math.max(S.zoom, 1e-4);
    return [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]].map((c) => {
      const dx = c[0] - cx, dy = c[1] - cy, len = Math.hypot(dx, dy) || 1;
      return [c[0] + dx / len * d, c[1] + dy / len * d];
    });
  }
  function hitRotationHandle(lp, b) {
    const pts = rotationHandlesLocal(b);
    const R = Math.max(13 / Math.max(S.zoom, 1e-4), 9);
    for (const pt of pts) {
      if (Math.hypot(lp[0] - pt[0], lp[1] - pt[1]) < R) return true;
    }
    return false;
  }
  function drawRotationHandles(ctx, b, rot) {
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const pts = rotationHandlesLocal(b);
    const r = Math.max(8 / Math.max(S.zoom, 1e-4), 6);
    ctx.save();
    ctx.strokeStyle = "#e8a735";
    ctx.lineWidth = 2 / Math.max(S.zoom, 1e-4);
    for (const pt of pts) {
      const w = rotPt(pt[0], pt[1], cx, cy, rot || 0);
      ctx.beginPath();
      ctx.arc(w[0], w[1], r, Math.PI * 0.15, Math.PI * 1.85);
      ctx.stroke();
    }
    ctx.restore();
  }
  var ROT_CURSOR = `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round'><path d='M21 12a9 9 0 1 1-3-6.7'/><polyline points='21 3 21 9 15 9'/></svg>") 12 12, crosshair`;
  function isOverRotationHandle(p) {
    if (S.placingImage) {
      const b = { x: S.placingImage.x, y: S.placingImage.y, w: S.placingImage.w, h: S.placingImage.h };
      const lp = unrotPt(p.x, p.y, b.x + b.w / 2, b.y + b.h / 2, S.placingImage.rotation || 0);
      return hitRotationHandle(lp, b);
    }
    const t = getSelectedText();
    if (t) {
      const b = textBounds(t);
      const lp = unrotPt(p.x, p.y, b.x + b.w / 2, b.y + b.h / 2, t.rotation || 0);
      return hitRotationHandle(lp, b);
    }
    const sh = getSelectedShape();
    if (sh) {
      const b = shapeBounds(sh);
      const lp = unrotPt(p.x, p.y, b.x + b.w / 2, b.y + b.h / 2, sh.rotation || 0);
      return hitRotationHandle(lp, b);
    }
    const layer = S.layers.find((l) => l.id === S.selectedLayerId && l.transformable);
    if (layer) {
      const lp = unrotPt(p.x, p.y, layer.x + layer.w / 2, layer.y + layer.h / 2, layer.rotation || 0);
      return hitRotationHandle(lp, layer);
    }
    return false;
  }
  function boxCorners(x, y, w, h, rot) {
    const cx = x + w / 2, cy = y + h / 2;
    return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map((pt) => rotPt(pt[0], pt[1], cx, cy, rot));
  }
  function getPos(e) {
    const rect = S.canvasStack.getBoundingClientRect();
    const pad = S.overlayPad || 0;
    const scale = S.imgW ? S.fitW * S.zoom / S.imgW : 1;
    return {
      x: (e.clientX - rect.left) / Math.max(scale, 1e-4) - pad,
      y: (e.clientY - rect.top) / Math.max(scale, 1e-4) - pad
    };
  }

  // iwb-cutout-extension/src/editor/objects.js
  var TEXT_FONT = (size) => "bold " + size + "px sans-serif";
  function textBounds(t) {
    const ctx = S.textCtx;
    ctx.font = TEXT_FONT(t.fontSize);
    const w = ctx.measureText(t.text).width;
    const h = t.fontSize * 1.25;
    return { x: t.x, y: t.y, w, h };
  }
  function getSelectedText() {
    return S.textLayers.find((t) => t.id === S.selectedTextId) || null;
  }
  function hitTextLayer(pos) {
    for (let i = S.textLayers.length - 1; i >= 0; i--) {
      const t = S.textLayers[i];
      if (t.visible === false) continue;
      const b = textBounds(t);
      const rot = t.rotation || 0;
      const lp = rot ? unrotPt(pos.x, pos.y, b.x + b.w / 2, b.y + b.h / 2, rot) : [pos.x, pos.y];
      if (lp[0] >= b.x - 2 && lp[0] <= b.x + b.w + 2 && lp[1] >= b.y - 2 && lp[1] <= b.y + b.h + 2) {
        return t;
      }
    }
    return null;
  }
  function textHandlePoints(t) {
    const b = textBounds(t);
    const rot = t.rotation || 0;
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const local = { nw: [b.x, b.y], ne: [b.x + b.w, b.y], sw: [b.x, b.y + b.h], se: [b.x + b.w, b.y + b.h] };
    const out = {};
    for (const k in local) out[k] = rotPt(local[k][0], local[k][1], cx, cy, rot);
    return out;
  }
  function hitTextHandle(pos) {
    const t = getSelectedText();
    if (!t) return null;
    const b = textBounds(t);
    const rot = t.rotation || 0;
    const lp = rot ? unrotPt(pos.x, pos.y, b.x + b.w / 2, b.y + b.h / 2, rot) : [pos.x, pos.y];
    if (hitRotationHandle(lp, b)) return "rotate";
    const local = { nw: [b.x, b.y], ne: [b.x + b.w, b.y], sw: [b.x, b.y + b.h], se: [b.x + b.w, b.y + b.h] };
    const R = 12 / S.zoom;
    let best = null, bestDist = 1e9;
    for (const name in local) {
      const dx = lp[0] - local[name][0], dy = lp[1] - local[name][1];
      const d = dx * dx + dy * dy;
      if (d < R * R && d < bestDist) {
        bestDist = d;
        best = name;
      }
    }
    return best;
  }
  function shapeBounds(s) {
    if (s.type === "pen" && s.pts && s.pts.length) {
      const xs = s.pts.map((p) => p.x), ys = s.pts.map((p) => p.y), x = Math.min(...xs), y = Math.min(...ys);
      return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
    }
    return { x: Math.min(s.x1, s.x2), y: Math.min(s.y1, s.y2), w: Math.abs(s.x2 - s.x1), h: Math.abs(s.y2 - s.y1) };
  }
  function getSelectedShape() {
    return S.shapeLayers.find((s) => s.id === S.selectedShapeId) || null;
  }
  function distToSeg(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
    t = clamp(t, 0, 1);
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }
  function hitShapeObj(pos, s, includeInterior) {
    if (s.visible === false) return false;
    if (s.rotation) {
      const b = shapeBounds(s);
      const lp = unrotPt(pos.x, pos.y, b.x + b.w / 2, b.y + b.h / 2, s.rotation);
      pos = { x: lp[0], y: lp[1] };
    }
    if (s.type === "pen") {
      const pts = s.pts || [];
      for (let i = 1; i < pts.length; i++) if (distToSeg(pos.x, pos.y, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y) <= Math.max(8 / S.zoom, s.lw)) return true;
      if (s.closed && pts.length > 2 && distToSeg(pos.x, pos.y, pts[pts.length - 1].x, pts[pts.length - 1].y, pts[0].x, pts[0].y) <= Math.max(8 / S.zoom, s.lw)) return true;
      if (!includeInterior) return false;
      const b = shapeBounds(s);
      return pos.x >= b.x && pos.x <= b.x + b.w && pos.y >= b.y && pos.y <= b.y + b.h;
    }
    if (s.type === "circle") {
      const b = shapeBounds(s);
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      const rx = Math.max(0.5, b.w / 2), ry = Math.max(0.5, b.h / 2);
      const nx = (pos.x - cx) / rx, ny = (pos.y - cy) / ry;
      const value = nx * nx + ny * ny;
      if (includeInterior || s.fill) return value <= 1;
      const edgeTolerance = Math.max(4 / S.zoom, s.lw / Math.min(rx, ry));
      const outer = (1 + edgeTolerance) * (1 + edgeTolerance);
      const inner = Math.max(0, 1 - edgeTolerance) * Math.max(0, 1 - edgeTolerance);
      return value >= inner && value <= outer;
    }
    if (s.type === "rect") {
      const b = shapeBounds(s);
      const pad = Math.max(4, s.lw * 1.5);
      const inOuter = pos.x >= b.x - pad && pos.x <= b.x + b.w + pad && pos.y >= b.y - pad && pos.y <= b.y + b.h + pad;
      if (!inOuter) return false;
      if (includeInterior || s.fill) return true;
      const inInner = pos.x >= b.x + pad && pos.x <= b.x + b.w - pad && pos.y >= b.y + pad && pos.y <= b.y + b.h - pad;
      return !inInner;
    }
    return distToSeg(pos.x, pos.y, s.x1, s.y1, s.x2, s.y2) <= Math.max(8 / S.zoom, s.lw);
  }
  function hitShapeLayer(pos, includeInterior) {
    for (let i = S.shapeLayers.length - 1; i >= 0; i--) {
      if (hitShapeObj(pos, S.shapeLayers[i], includeInterior)) return S.shapeLayers[i];
    }
    return null;
  }
  function allObjects() {
    const arr = S.textLayers.map((o) => ({ kind: "text", obj: o })).concat(S.shapeLayers.map((o) => ({ kind: "shape", obj: o })));
    arr.sort((a, b) => (a.obj.z || 0) - (b.obj.z || 0));
    return arr;
  }
  function sortLayersByZ() {
    const cmp = (a, b) => (a.z || 0) - (b.z || 0);
    S.textLayers.sort(cmp);
    S.shapeLayers.sort(cmp);
  }
  function hitAnyObject(pos) {
    const list = allObjects();
    for (let i = list.length - 1; i >= 0; i--) {
      const { kind, obj } = list[i];
      if (obj.visible === false) continue;
      if (kind === "text") {
        const b = textBounds(obj);
        const rot = obj.rotation || 0;
        const lp = rot ? unrotPt(pos.x, pos.y, b.x + b.w / 2, b.y + b.h / 2, rot) : [pos.x, pos.y];
        if (lp[0] >= b.x - 2 && lp[0] <= b.x + b.w + 2 && lp[1] >= b.y - 2 && lp[1] <= b.y + b.h + 2) {
          return { kind, obj };
        }
      } else if (hitShapeObj(pos, obj, true)) {
        return { kind, obj };
      }
    }
    return null;
  }
  function getSelectedObject() {
    const t = getSelectedText();
    if (t) return { kind: "text", obj: t };
    const s = getSelectedShape();
    if (s) return { kind: "shape", obj: s };
    return null;
  }
  function moveLayer(dir) {
    let sel = getSelectedObject();
    if (sel) {
      if (sel.obj.locked) return;
    } else {
      const layer = S.layers.find((l) => l.id === S.selectedLayerId && l.id !== "base" && !l.locked);
      if (layer) sel = { kind: "bitmap", obj: layer };
    }
    if (!sel) return;
    if (sel.obj.locked) return;
    const all = [...S.layers.map((o) => ({ kind: "bitmap", obj: o })), ...allObjects()].sort((a, b) => (a.obj.z || 0) - (b.obj.z || 0));
    const idx = all.findIndex((o) => o.obj === sel.obj);
    if (idx < 0) return;
    if ((dir === "up" || dir === "top") && idx === all.length - 1) return;
    if ((dir === "down" || dir === "bottom") && idx === 0) return;
    saveSnapshot();
    if (dir === "up") {
      const t = all[idx + 1].obj;
      const tz = t.z;
      t.z = sel.obj.z;
      sel.obj.z = tz;
    } else if (dir === "down") {
      const t = all[idx - 1].obj;
      const tz = t.z;
      t.z = sel.obj.z;
      sel.obj.z = tz;
    } else if (dir === "top") {
      sel.obj.z = all[all.length - 1].obj.z + 1;
    } else {
      sel.obj.z = all[0].obj.z - 1;
    }
    sortLayersByZ();
    reorderLayerCanvas();
    renderObjects();
    renderLayerPanel();
  }
  function shapeHandlePoints(s) {
    const b = shapeBounds(s);
    if (s.type === "pen") {
      return Object.fromEntries((s.pts || []).map((p, i) => ["p" + i, [p.x, p.y]]));
    }
    if (s.type === "arrow") {
      return { start: [s.x1, s.y1], end: [s.x2, s.y2] };
    }
    return {
      nw: [b.x, b.y],
      ne: [b.x + b.w, b.y],
      sw: [b.x, b.y + b.h],
      se: [b.x + b.w, b.y + b.h],
      n: [b.x + b.w / 2, b.y],
      s: [b.x + b.w / 2, b.y + b.h],
      e: [b.x + b.w, b.y + b.h / 2],
      w: [b.x, b.y + b.h / 2]
    };
  }
  function shapeHandleWorld(s) {
    const b = shapeBounds(s);
    const rot = s.rotation || 0;
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const local = shapeHandlePoints(s);
    const out = {};
    for (const k in local) out[k] = rotPt(local[k][0], local[k][1], cx, cy, rot);
    return out;
  }
  function hitShapeHandle(pos) {
    const s = getSelectedShape();
    if (!s) return null;
    const b = shapeBounds(s);
    const rot = s.rotation || 0;
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const lp = rot ? unrotPt(pos.x, pos.y, cx, cy, rot) : [pos.x, pos.y];
    if (hitRotationHandle(lp, b)) return "rotate";
    const pts = shapeHandlePoints(s);
    const offset = 8 / S.zoom;
    const R = Math.max(18 / S.zoom, 11);
    let best = null, bestDist = 1e9;
    for (const name in pts) {
      const px = pts[name][0] + (name.includes("w") ? -offset : name.includes("e") ? offset : 0);
      const py = pts[name][1] + (name.includes("n") ? -offset : name.includes("s") ? offset : 0);
      const dx = lp[0] - px, dy = lp[1] - py;
      const d = dx * dx + dy * dy;
      if (d < R * R && d < bestDist) {
        bestDist = d;
        best = name;
      }
    }
    return best;
  }
  function applyShapeHandle(s, handle, pos) {
    const b0 = shapeBounds(s);
    const rot0 = s.rotation || 0;
    const c0x = b0.x + b0.w / 2, c0y = b0.y + b0.h / 2;
    if (handle === "rotate") {
      const st = S.shapeDrag && S.shapeDrag.start;
      const baseRot = S.shapeDrag && S.shapeDrag.shape && (S.shapeDrag.shape.rotation || 0) || 0;
      if (st) {
        const a0 = Math.atan2(st.y - c0y, st.x - c0x);
        const a1 = Math.atan2(pos.y - c0y, pos.x - c0x);
        let deg = baseRot + (a1 - a0) * 180 / Math.PI;
        if (S._shiftDown) deg = Math.round(deg / 15) * 15;
        s.rotation = deg;
      }
      return;
    }
    const lp = rot0 ? unrotPt(pos.x, pos.y, c0x, c0y, rot0) : [pos.x, pos.y];
    pos = { x: lp[0], y: lp[1] };
    if (s.type === "pen" && handle && handle[0] === "p") {
      const i = parseInt(handle.slice(1), 10);
      if (s.pts && s.pts[i]) {
        s.pts[i].x = clamp(pos.x, 0, S.imgW);
        s.pts[i].y = clamp(pos.y, 0, S.imgH);
      }
      return;
    }
    if (s.type === "arrow") {
      if (handle === "start") {
        s.x1 = clamp(pos.x, 0, S.imgW);
        s.y1 = clamp(pos.y, 0, S.imgH);
      } else {
        s.x2 = clamp(pos.x, 0, S.imgW);
        s.y2 = clamp(pos.y, 0, S.imgH);
      }
      return;
    }
    const b = shapeBounds(s);
    const offset = 8 / S.zoom;
    const adjusted = { x: pos.x - (handle.includes("w") ? -offset : handle.includes("e") ? offset : 0), y: pos.y - (handle.includes("n") ? -offset : handle.includes("s") ? offset : 0) };
    let x1 = b.x, y1 = b.y, x2 = b.x + b.w, y2 = b.y + b.h;
    if (handle.includes("e")) x2 = Math.max(x1 + 2, adjusted.x);
    if (handle.includes("s")) y2 = Math.max(y1 + 2, adjusted.y);
    if (handle.includes("w")) x1 = Math.min(x2 - 2, adjusted.x);
    if (handle.includes("n")) y1 = Math.min(y2 - 2, adjusted.y);
    s.x1 = x1;
    s.y1 = y1;
    s.x2 = x2;
    s.y2 = y2;
  }
  function drawPenPathPreview() {
    const path = S.penPath;
    if (!path || !path.pts || !path.pts.length) return;
    const ctx = S.overlayCtx;
    const pts = path.pts.slice();
    const first = pts[0];
    const nearStart = path.preview && pts.length >= 3 && Math.hypot(path.preview.x - first.x, path.preview.y - first.y) <= Math.max(12 / S.zoom, S.brushSize * 1.5);
    if (path.preview) pts.push(nearStart ? first : path.preview);
    ctx.save();
    ctx.strokeStyle = S.color;
    ctx.fillStyle = nearStart ? "rgba(232, 167, 53, 0.18)" : "transparent";
    ctx.lineWidth = Math.max(2, S.brushSize) / S.zoom;
    ctx.setLineDash([8 / S.zoom, 5 / S.zoom]);
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    if (nearStart) {
      ctx.closePath();
      ctx.fill();
    }
    ctx.stroke();
    ctx.setLineDash([]);
    for (let i = 0; i < path.pts.length; i++) {
      const point = path.pts[i];
      ctx.beginPath();
      ctx.fillStyle = i === 0 && nearStart ? "#e8a735" : "#ffffff";
      ctx.strokeStyle = S.color;
      ctx.arc(point.x, point.y, Math.max(4, 6 / S.zoom), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }
  function drawShapeSelection(s) {
    const octx = S.overlayCtx;
    const b = shapeBounds(s);
    const rot = s.rotation || 0;
    octx.save();
    octx.strokeStyle = "#e8a735";
    octx.lineWidth = 1.5 / S.zoom;
    octx.setLineDash([6 / S.zoom, 3 / S.zoom]);
    const corners = boxCorners(b.x, b.y, b.w, b.h, rot);
    octx.beginPath();
    octx.moveTo(corners[0][0], corners[0][1]);
    for (let i = 1; i < corners.length; i++) octx.lineTo(corners[i][0], corners[i][1]);
    octx.closePath();
    octx.stroke();
    octx.setLineDash([]);
    const hs = 8.5 / S.zoom;
    octx.fillStyle = "#ffffff";
    octx.strokeStyle = "#e8a735";
    const pts = shapeHandleWorld(s);
    for (const name in pts) {
      octx.beginPath();
      octx.rect(pts[name][0] - hs, pts[name][1] - hs, hs * 2, hs * 2);
      octx.fill();
      octx.stroke();
    }
    octx.restore();
    drawRotationHandles(octx, b, rot);
  }
  function deleteSelectedShape() {
    if (!S.selectedShapeId) return;
    const selected = getSelectedShape();
    if (selected && selected.locked) return;
    saveSnapshot();
    removeVecCanvas(selected);
    S.shapeLayers = S.shapeLayers.filter((s) => s.id !== S.selectedShapeId);
    S.selectedShapeId = null;
    renderObjects();
  }
  function renderObjects(tempShape) {
    for (const { kind, obj } of allObjects()) drawVectorToCanvas(kind, obj);
    reorderLayerCanvas();
    clearOverlay();
    if (tempShape) drawShape(S.overlayCtx, tempShape);
    if (S.tool === "pen" && S.penPath && S.penPath.pts.length) drawPenPathPreview();
    if (S.placingImage) {
      drawPlacementPreview();
      return;
    }
    const bitmapSelection = S.layers.find((l) => l.id === S.selectedLayerId && (l.transformable || isDrawableLayer(l)));
    if (bitmapSelection) drawBitmapSelection(bitmapSelection);
    const sel = getSelectedText();
    if (sel) {
      const b = textBounds(sel);
      const rot = sel.rotation || 0;
      const octx = S.overlayCtx;
      octx.save();
      octx.strokeStyle = "#e8a735";
      octx.lineWidth = 1.5 / S.zoom;
      octx.setLineDash([6 / S.zoom, 3 / S.zoom]);
      const corners = boxCorners(b.x - 2 / S.zoom, b.y - 2 / S.zoom, b.w + 4 / S.zoom, b.h + 4 / S.zoom, rot);
      octx.beginPath();
      octx.moveTo(corners[0][0], corners[0][1]);
      for (let i = 1; i < corners.length; i++) octx.lineTo(corners[i][0], corners[i][1]);
      octx.closePath();
      octx.stroke();
      octx.setLineDash([]);
      const hs = 7 / S.zoom;
      octx.fillStyle = "#ffffff";
      octx.strokeStyle = "#e8a735";
      const pts = textHandlePoints(sel);
      for (const name in pts) {
        octx.beginPath();
        octx.rect(pts[name][0] - hs, pts[name][1] - hs, hs * 2, hs * 2);
        octx.fill();
        octx.stroke();
      }
      octx.restore();
    } else {
      const sh = getSelectedShape();
      if (sh) drawShapeSelection(sh);
    }
    const penShape = getPenEditingShape();
    if (penShape) drawPenEditOverlay(penShape);
    if (S.cropRect) drawCropPreview();
    updateLayerUI();
  }
  function getPenEditingShape() {
    if (!S.penEditId) return null;
    return S.shapeLayers.find((sh) => sh.id === S.penEditId && sh.type === "pen") || null;
  }
  function beginPenEdit(shape) {
    S.penEditId = shape.id;
    S.selectedShapeId = shape.id;
    S.selectedTextId = null;
    S.selectedLayerId = null;
    S.shapeDrag = null;
    S.penDragPt = -1;
    S.penDragBase = null;
    S.penDragPending = null;
    renderObjects();
    renderLayerPanel();
  }
  function exitPenEdit() {
    S.penEditId = null;
    S.penDragPt = -1;
    S.penDragBase = null;
    S.penDragPending = null;
    renderObjects();
    renderLayerPanel();
  }
  function hitPenPoint(pos, shape, r) {
    const pts = shape.pts || [];
    const b = shapeBounds(shape);
    const lp = shape.rotation ? unrotPt(pos.x, pos.y, b.x + b.w / 2, b.y + b.h / 2, shape.rotation) : [pos.x, pos.y];
    for (let i = 0; i < pts.length; i++) {
      if (Math.hypot(lp[0] - pts[i].x, lp[1] - pts[i].y) <= r) return i;
    }
    return -1;
  }
  function hitPenEdgeInsert(pos, shape) {
    const pts = shape.pts || [];
    const b = shapeBounds(shape);
    const lp = shape.rotation ? unrotPt(pos.x, pos.y, b.x + b.w / 2, b.y + b.h / 2, shape.rotation) : [pos.x, pos.y];
    const r = Math.max(12 / S.zoom, 6);
    for (let i = 0; i < pts.length - 1; i++) {
      if (distToSeg(lp[0], lp[1], pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y) <= r) return i;
    }
    if (shape.closed && pts.length >= 3) {
      if (distToSeg(lp[0], lp[1], pts[pts.length - 1].x, pts[pts.length - 1].y, pts[0].x, pts[0].y) <= r) return pts.length - 1;
    }
    return -1;
  }
  function drawPenEditOverlay(shape) {
    const ctx = S.overlayCtx;
    const pts = shape.pts || [];
    const b = shapeBounds(shape);
    const rot = shape.rotation || 0;
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const W = (p) => rotPt(p.x, p.y, cx, cy, rot);
    const R = Math.max(7 / S.zoom, 5);
    ctx.save();
    ctx.lineWidth = 1.5 / S.zoom;
    const segments = [];
    for (let i = 0; i < pts.length - 1; i++) segments.push([pts[i], pts[i + 1]]);
    if (shape.closed && pts.length >= 3) segments.push([pts[pts.length - 1], pts[0]]);
    ctx.strokeStyle = "#e8a735";
    for (const [a, bb] of segments) {
      const wa = W(a), wb = W(bb);
      const mx = (wa[0] + wb[0]) / 2, my = (wa[1] + wb[1]) / 2;
      ctx.beginPath();
      ctx.arc(mx, my, Math.max(3 / S.zoom, 2), 0, Math.PI * 2);
      ctx.stroke();
    }
    for (let i = 0; i < pts.length; i++) {
      const wp = W(pts[i]);
      ctx.beginPath();
      ctx.rect(wp[0] - R / 2, wp[1] - R / 2, R, R);
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = i === S.penDragPt ? "#ff8c00" : "#e8a735";
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }
  function showTextInput(x, y, layer) {
    const input = runtime.el.querySelector(".iwb-editor-text-input");
    const rect = S.canvasStack.getBoundingClientRect();
    const wrapRect = S.canvasWrap.getBoundingClientRect();
    const sx = rect.width / S.imgW;
    const sy = rect.height / S.imgH;
    input.style.left = rect.left - wrapRect.left + x * sx + "px";
    input.style.top = rect.top - wrapRect.top + y * sy + "px";
    input.style.display = "block";
    if (layer) {
      input.value = layer.text;
      S.textEditingId = layer.id;
    } else {
      input.value = "";
      S.textEditingId = null;
    }
    input.focus();
    input.select();
    input.dataset.x = x;
    input.dataset.y = y;
  }
  function hideTextInput() {
    const input = runtime.el.querySelector(".iwb-editor-text-input");
    if (input) {
      if (document.activeElement === input) input.blur();
      input.style.display = "none";
      input.value = "";
    }
    S.textEditingId = null;
  }
  function commitTextInput() {
    const input = runtime.el.querySelector(".iwb-editor-text-input");
    if (!input || input.style.display === "none") return false;
    const text = input.value.trim();
    const x = parseFloat(input.dataset.x);
    const y = parseFloat(input.dataset.y);
    let committed = false;
    if (S.textEditingId) {
      const t = S.textLayers.find((l) => l.id === S.textEditingId);
      if (t && t.locked) {
        hideTextInput();
        return true;
      }
      if (t && text !== t.text) {
        saveSnapshot();
        if (text) {
          t.text = text;
        } else {
          removeVecCanvas(t);
          S.textLayers = S.textLayers.filter((l) => l.id !== t.id);
          S.selectedTextId = null;
        }
        renderObjects();
      }
      committed = true;
    } else if (text) {
      saveSnapshot();
      const layer = {
        id: "t" + Date.now() + Math.floor(Math.random() * 1e3),
        x,
        y,
        text,
        color: S.color,
        fontSize: Math.max(16, S.brushSize * 6),
        opacity: 1,
        visible: true,
        locked: false,
        z: ++S.zCounter
      };
      S.textLayers.push(layer);
      S.selectedTextId = layer.id;
      renderObjects();
      committed = true;
    }
    hideTextInput();
    return committed;
  }
  function deleteSelectedText() {
    if (!S.selectedTextId) return;
    const selected = getSelectedText();
    if (selected && selected.locked) return;
    saveSnapshot();
    removeVecCanvas(selected);
    S.textLayers = S.textLayers.filter((t) => t.id !== S.selectedTextId);
    S.selectedTextId = null;
    renderObjects();
  }
  function beginTextRotate(pos) {
    const t = getSelectedText();
    if (!t || t.locked) return;
    const b = textBounds(t);
    S.textDrag = {
      mode: "rotate",
      rotation: t.rotation || 0,
      cx: b.x + b.w / 2,
      cy: b.y + b.h / 2,
      startX0: pos.x,
      startY0: pos.y,
      pending: snapshotState()
    };
  }
  function beginTextScaleDrag(handle, pos) {
    const t = getSelectedText();
    if (!t || t.locked) return;
    const b = textBounds(t);
    const rot = t.rotation || 0;
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const anchors = {
      se: [b.x, b.y],
      ne: [b.x, b.y + b.h],
      sw: [b.x + b.w, b.y],
      nw: [b.x + b.w, b.y + b.h]
    };
    const a = rotPt(anchors[handle][0], anchors[handle][1], cx, cy, rot);
    const anchor = { x: a[0], y: a[1] };
    const dx = pos.x - anchor.x, dy = pos.y - anchor.y;
    S.textDrag = {
      mode: "scale",
      anchor,
      d0: Math.sqrt(dx * dx + dy * dy),
      fontSize: t.fontSize,
      pending: snapshotState()
    };
  }
  function beginShapeHandleDrag(handle, pos) {
    const sh = getSelectedShape();
    if (!sh || sh.locked) return;
    S.shapeDrag = {
      mode: "handle",
      handle,
      start: pos,
      shape: { ...sh },
      pending: snapshotState()
    };
  }

  // iwb-cutout-extension/src/editor/tools.js
  var brushStampCache = { key: "", canvas: null };
  function getBrushStamp(size, color, hardness) {
    const key = size + "|" + color + "|" + hardness;
    if (brushStampCache.key === key && brushStampCache.canvas) return brushStampCache.canvas;
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    const cx = c.getContext("2d");
    const half = size / 2;
    const { r, g, b } = hexToRgb(color);
    const grad = cx.createRadialGradient(half, half, half * hardness / 100, half, half, half);
    grad.addColorStop(0, `rgba(${r},${g},${b},1)`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    cx.fillStyle = grad;
    cx.fillRect(0, 0, size, size);
    brushStampCache = { key, canvas: c };
    return c;
  }
  function strokeSegment(x1, y1, x2, y2) {
    const ctx = S.strokeCtx;
    const size = Math.max(1, S.brushSize);
    const color = S.tool === "eraser" ? "#ffffff" : S.color;
    ctx.save();
    if (S.brushHardness >= 100) {
      ctx.strokeStyle = color;
      ctx.lineWidth = size;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    } else {
      const stamp = getBrushStamp(size, color, S.brushHardness);
      const dist = Math.hypot(x2 - x1, y2 - y1);
      const step = Math.max(1, size / 6);
      const n = Math.max(0, Math.ceil(dist / step));
      for (let i = 0; i <= n; i++) {
        const t = n === 0 ? 0 : i / n;
        ctx.drawImage(stamp, x1 + (x2 - x1) * t - size / 2, y1 + (y2 - y1) * t - size / 2);
      }
    }
    ctx.restore();
    S.strokeCanvas.style.opacity = S.brushOpacity;
  }
  function eraseSegment(x1, y1, x2, y2) {
    const ctx = getActiveCtx();
    if (!ctx) return;
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.globalAlpha = S.brushOpacity;
    ctx.lineWidth = Math.max(1, S.brushSize);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.restore();
    const active = getActiveLayer();
    if (active && active.id === "draw" && active.sourceCanvas) {
      const sourceCtx = active.sourceCanvas.getContext("2d", { willReadFrequently: true });
      sourceCtx.save();
      sourceCtx.globalCompositeOperation = "destination-out";
      sourceCtx.globalAlpha = S.brushOpacity;
      sourceCtx.lineWidth = Math.max(1, S.brushSize) * active.w / Math.max(S.imgW, 1);
      sourceCtx.lineCap = "round";
      sourceCtx.beginPath();
      sourceCtx.moveTo((x1 - active.x) * S.imgW / active.w, (y1 - active.y) * S.imgW / active.w);
      sourceCtx.lineTo((x2 - active.x) * S.imgW / active.w, (y2 - active.y) * S.imgW / active.w);
      sourceCtx.stroke();
      sourceCtx.restore();
    }
    S.pickerComposite = null;
    renderObjects();
  }
  function bakeDrawableLayer(layer) {
    if (!layer || !isDrawableLayer(layer) || !layer._srcBox) return;
    layer._srcBox = null;
    layer.sourceCanvas = null;
    layer.rotation = 0;
    layer.x = 0;
    layer.y = 0;
    layer.w = S.imgW;
    layer.h = S.imgH;
    layer._bounds = void 0;
  }
  function beginStroke() {
    bakeDrawableLayer(getActiveLayer());
    S.strokeCanvas.width = S.imgW;
    S.strokeCanvas.height = S.imgH;
    S.strokeCtx.clearRect(0, 0, S.imgW, S.imgH);
    S.strokeCanvas.style.display = S.tool === "eraser" ? "none" : "block";
    S.strokeCanvas.style.opacity = S.brushOpacity;
  }
  function endStroke() {
    for (const l of S.layers) l._bounds = void 0;
    const ctx = getActiveCtx();
    if (!ctx) return;
    ctx.save();
    if (S.tool === "eraser") {
      ctx.globalCompositeOperation = "destination-out";
    }
    ctx.globalAlpha = S.brushOpacity;
    ctx.drawImage(S.strokeCanvas, 0, 0);
    ctx.restore();
    S.strokeCanvas.style.display = "none";
    const active = getActiveLayer();
    if (active && active.id === "draw" && active.sourceCanvas && active.w > 0 && active.h > 0) {
      const sourceCtx = active.sourceCanvas.getContext("2d", { willReadFrequently: true });
      sourceCtx.save();
      sourceCtx.globalCompositeOperation = S.tool === "eraser" ? "destination-out" : "source-over";
      sourceCtx.globalAlpha = S.brushOpacity;
      sourceCtx.translate(-active.x * S.imgW / active.w, -active.y * S.imgH / active.h);
      sourceCtx.scale(S.imgW / active.w, S.imgH / active.h);
      sourceCtx.drawImage(S.strokeCanvas, 0, 0);
      sourceCtx.restore();
    }
    S.strokeCtx.clearRect(0, 0, S.imgW, S.imgH);
    S.pickerComposite = null;
  }
  function drawShape(ctx, s) {
    ctx.save();
    ctx.globalAlpha = s.opacity != null ? s.opacity : 1;
    const rot = s.rotation || 0;
    if (rot) {
      const b = shapeBounds(s);
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      ctx.translate(cx, cy);
      ctx.rotate(rot * Math.PI / 180);
      ctx.translate(-cx, -cy);
    }
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.lw;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (s.type === "pen") {
      const pts = Array.isArray(s.pts) ? s.pts : [];
      if (pts.length > 1) {
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        if (s.closed) ctx.closePath();
        if (s.closed && s.fill) {
          ctx.fillStyle = s.color;
          ctx.fill();
        }
        ctx.stroke();
      }
    } else if (s.type === "rect") {
      const rx = Math.min(s.x1, s.x2), ry = Math.min(s.y1, s.y2), rw = Math.abs(s.x2 - s.x1), rh = Math.abs(s.y2 - s.y1);
      if (s.fill) {
        ctx.fillStyle = s.color;
        ctx.fillRect(rx, ry, rw, rh);
      }
      ctx.strokeRect(rx, ry, rw, rh);
    } else if (s.type === "circle") {
      const rx = Math.min(s.x1, s.x2), ry = Math.min(s.y1, s.y2);
      const rw = Math.abs(s.x2 - s.x1), rh = Math.abs(s.y2 - s.y1);
      ctx.beginPath();
      ctx.ellipse(rx + rw / 2, ry + rh / 2, Math.max(1, rw / 2), Math.max(1, rh / 2), 0, 0, Math.PI * 2);
      if (s.fill) {
        ctx.fillStyle = s.color;
        ctx.fill();
      }
      ctx.stroke();
    } else {
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.moveTo(s.x1, s.y1);
      ctx.lineTo(s.x2, s.y2);
      ctx.stroke();
      const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
      const headLen = Math.max(12, s.lw * 4);
      ctx.beginPath();
      ctx.moveTo(s.x2, s.y2);
      ctx.lineTo(s.x2 - headLen * Math.cos(angle - Math.PI / 6), s.y2 - headLen * Math.sin(angle - Math.PI / 6));
      ctx.moveTo(s.x2, s.y2);
      ctx.lineTo(s.x2 - headLen * Math.cos(angle + Math.PI / 6), s.y2 - headLen * Math.sin(angle + Math.PI / 6));
      ctx.stroke();
    }
    ctx.restore();
  }
  function getToolBrushRadius() {
    return Math.max(1, S.brushSize) / 2;
  }
  function screenScale() {
    const rect = S.canvasStack.getBoundingClientRect();
    return rect.width ? rect.width / S.imgW : S.zoom;
  }
  function drawToolRing(pos) {
    clearOverlay();
    const ctx = S.overlayCtx;
    const r = getToolBrushRadius();
    const k = 1 / screenScale();
    const rMin = 2 * k;
    const rr = Math.max(r, rMin);
    ctx.save();
    ctx.lineWidth = k;
    ctx.strokeStyle = "rgba(0,0,0,0.8)";
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, rr, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = k;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, Math.max(rr - k, 0), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  function getCompositeCanvas() {
    const c = document.createElement("canvas");
    c.width = S.imgW;
    c.height = S.imgH;
    const cx = c.getContext("2d", { willReadFrequently: true });
    const units = [];
    for (const l of S.layers) units.push({ z: l.z, el: l.canvas, vis: l.visible, op: l.opacity });
    for (const { obj } of allObjects()) if (obj._canvas) units.push({ z: obj.z || 0, el: obj._canvas, vis: obj.visible !== false, op: obj.opacity != null ? obj.opacity : 1 });
    units.sort((a, b) => a.z - b.z);
    cx.globalAlpha = 1;
    for (const u of units) {
      if (!u.vis) continue;
      cx.globalAlpha = u.op == null ? 1 : u.op;
      cx.drawImage(u.el, 0, 0);
    }
    cx.globalAlpha = 1;
    return c;
  }
  function getPickerComposite() {
    if (!S.pickerComposite) {
      S.pickerComposite = getCompositeCanvas().getContext("2d", { willReadFrequently: true });
    }
    return S.pickerComposite;
  }
  function sampleColor(pos) {
    const x = clamp(Math.floor(pos.x), 0, Math.max(0, S.imgW - 1));
    const y = clamp(Math.floor(pos.y), 0, Math.max(0, S.imgH - 1));
    try {
      const d = getPickerComposite().getImageData(x, y, 1, 1).data;
      return { r: d[0], g: d[1], b: d[2], a: d[3] };
    } catch (e) {
      return null;
    }
  }
  function showPickerTip(e, s) {
    const tip = runtime.el.querySelector(".iwb-editor-picker-tip");
    if (!tip) return;
    const chip = tip.querySelector(".iwb-editor-picker-chip");
    const hex = tip.querySelector(".iwb-editor-picker-hex");
    if (s && s.a > 0) {
      const h = rgbToHex(s.r, s.g, s.b);
      chip.style.background = h;
      chip.style.border = "1px solid rgba(255,255,255,0.3)";
      hex.textContent = h;
    } else {
      chip.style.background = "transparent";
      chip.style.border = "1px dashed rgba(255,255,255,0.4)";
      hex.textContent = "\u900F\u660E";
    }
    tip.style.display = "flex";
    tip.style.left = e.clientX + 16 + "px";
    tip.style.top = e.clientY + 16 + "px";
  }
  function hidePickerTip() {
    const tip = runtime.el.querySelector(".iwb-editor-picker-tip");
    if (tip) tip.style.display = "none";
  }
  function exitPicker() {
    S.tool = S.prevTool && S.prevTool !== "picker" ? S.prevTool : "brush";
    S.prevTool = null;
    S.pickerComposite = null;
    hidePickerTip();
    updateToolUI();
    updateBrushParamUI();
    if (S.tool === "crop") {
      showCropBar();
      updateCropInfo();
    } else {
      cancelCrop();
      hideCropBar();
    }
    renderObjects();
  }
  function applyColorChange(color) {
    S.color = color;
    updateColorUI();
    const t = getSelectedText();
    if (t && !t.locked && t.color !== S.color) {
      saveSnapshot();
      t.color = S.color;
      renderObjects();
    }
    const sh = getSelectedShape();
    if (sh && !sh.locked && S.tool !== "text" && sh.color !== S.color) {
      saveSnapshot();
      sh.color = S.color;
      renderObjects();
    }
  }
  function setTool(tool) {
    if (S.placingImage) cancelImagePlacement();
    commitTextInput();
    if (tool !== "select" && tool !== "pen") {
      S.penEditId = null;
      S.penDragPt = -1;
      S.penDragPending = null;
    }
    if (tool === "picker" && S.tool !== "picker") S.prevTool = S.tool;
    if (tool !== "pen") S.penPath = null;
    S.tool = tool;
    if (tool !== "select") S.selectedLayerId = null;
    if (tool !== "text" && tool !== "select") S.selectedTextId = null;
    if (tool !== "rect" && tool !== "circle" && tool !== "arrow" && tool !== "pen" && tool !== "select") S.selectedShapeId = null;
    S.bitmapDrag = null;
    S.textDrag = null;
    S.shapeDrag = null;
    S.pickerComposite = null;
    hidePickerTip();
    updateToolUI();
    updateBrushParamUI();
    if (tool === "crop") {
      showCropBar();
      updateCropInfo();
    } else {
      cancelCrop();
      hideCropBar();
    }
    renderObjects();
    renderLayerPanel();
  }

  // iwb-cutout-extension/src/editor/crop.js
  function setConstraint(type, ratio, sizeW, sizeH) {
    S.cropConstraint = { type, ratio: ratio || 0, sizeW: sizeW || 0, sizeH: sizeH || 0 };
    const toggle = runtime.el && runtime.el.querySelector(".iwb-editor-size-toggle");
    if (toggle) {
      const active = type === "size";
      toggle.classList.toggle("active", active);
      toggle.setAttribute("aria-pressed", String(active));
      toggle.textContent = active ? "\u5DF2\u542F\u7528" : "\u542F\u7528\u5C3A\u5BF8";
    }
    if (S.cropRect) {
      S.cropRect = applyConstraint(S.cropRect.x, S.cropRect.y, S.cropRect.w, S.cropRect.h);
      drawCropPreview();
      updateCropInfo();
    }
  }
  function applyConstraint(x, y, w, h) {
    const c = S.cropConstraint;
    if (c.type === "free" || !c.ratio || c.ratio <= 0) return { x, y, w, h };
    const ratio = c.ratio;
    if (w / h > ratio) {
      const nw = h * ratio;
      const dx = (w - nw) / 2;
      return { x: x + dx, y, w: nw, h };
    } else {
      const nh = w / ratio;
      const dy = (h - nh) / 2;
      return { x, y: y + dy, w, h: nh };
    }
  }
  function applyConstraintDrag(x1, y1, x2, y2) {
    const c = S.cropConstraint;
    let rx = Math.min(x1, x2), ry = Math.min(y1, y2);
    let rw = Math.abs(x2 - x1), rh = Math.abs(y2 - y1);
    if (rw < 1) rw = 1;
    if (rh < 1) rh = 1;
    if (c.type === "free" || !c.ratio || c.ratio <= 0) return { x: rx, y: ry, w: rw, h: rh };
    const ratio = c.ratio;
    if (rw / rh > ratio) {
      rh = rw / ratio;
    } else {
      rw = rh * ratio;
    }
    return { x: rx, y: ry, w: rw, h: rh };
  }
  function updateCropInfo() {
    const info = runtime.el.querySelector(".iwb-editor-crop-info");
    if (!info) return;
    if (S.cropRect) {
      const w = Math.round(S.cropRect.w);
      const h = Math.round(S.cropRect.h);
      const c = S.cropConstraint;
      if (c.type === "size" && c.sizeW > 0 && c.sizeH > 0) {
        info.textContent = `${w}x${h} -> ${c.sizeW}x${c.sizeH}`;
      } else {
        info.textContent = `${w}x${h}`;
      }
    } else {
      info.textContent = "--";
    }
  }
  function clearOverlay() {
    const ctx = S.overlayCtx;
    const pad = S.overlayPad || 0;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, S.imgW + pad * 2, S.imgH + pad * 2);
    ctx.restore();
    ctx.setTransform(1, 0, 0, 1, pad, pad);
  }
  function drawCropPreview(x1, y1, x2, y2) {
    const ctx = S.overlayCtx;
    clearOverlay();
    let rx, ry, rw, rh;
    if (x2 !== void 0) {
      const r = applyConstraintDrag(x1, y1, x2, y2);
      rx = r.x;
      ry = r.y;
      rw = r.w;
      rh = r.h;
    } else if (S.cropRect) {
      rx = S.cropRect.x;
      ry = S.cropRect.y;
      rw = S.cropRect.w;
      rh = S.cropRect.h;
    } else {
      return;
    }
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    const cropPad = Math.max(S.imgW, S.imgH) * 2;
    ctx.fillRect(-cropPad, -cropPad, S.imgW + cropPad * 2, S.imgH + cropPad * 2);
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillRect(rx, ry, rw, rh);
    ctx.restore();
    ctx.save();
    ctx.strokeStyle = "#4488ff";
    ctx.lineWidth = 2 / S.zoom;
    ctx.setLineDash([8 / S.zoom, 4 / S.zoom]);
    ctx.strokeRect(rx, ry, rw, rh);
    ctx.restore();
    if (S.cropRect && !S.cropHandle) drawCropHandles(rx, ry, rw, rh);
  }
  function cropHandlePoints(rx, ry, rw, rh) {
    return {
      nw: [rx, ry],
      ne: [rx + rw, ry],
      sw: [rx, ry + rh],
      se: [rx + rw, ry + rh],
      n: [rx + rw / 2, ry],
      s: [rx + rw / 2, ry + rh],
      e: [rx + rw, ry + rh / 2],
      w: [rx, ry + rh / 2]
    };
  }
  function drawCropHandles(rx, ry, rw, rh) {
    const ctx = S.overlayCtx;
    const pts = cropHandlePoints(rx, ry, rw, rh);
    const hs = 4 / S.zoom;
    ctx.save();
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#4488ff";
    ctx.lineWidth = 1.5 / S.zoom;
    for (const name in pts) {
      ctx.beginPath();
      ctx.rect(pts[name][0] - hs, pts[name][1] - hs, hs * 2, hs * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }
  function insideRect(pos, rect) {
    return pos.x >= rect.x && pos.x <= rect.x + rect.w && pos.y >= rect.y && pos.y <= rect.y + rect.h;
  }
  function hitCropHandle(pos) {
    if (!S.cropRect) return null;
    const pts = cropHandlePoints(S.cropRect.x, S.cropRect.y, S.cropRect.w, S.cropRect.h);
    const R = 12 / S.zoom;
    let best = null, bestDist = 1e9;
    for (const name in pts) {
      const dx = pos.x - pts[name][0], dy = pos.y - pts[name][1];
      const d = dx * dx + dy * dy;
      if (d < R * R && d < bestDist) {
        bestDist = d;
        best = name;
      }
    }
    return best;
  }
  function resizeCropRect(pos) {
    if (!S.cropRect) return;
    const { x, y, w, h } = S.cropRect;
    const c = S.cropConstraint;
    let nx = x, ny = y, nw = w, nh = h;
    const hh = S.cropHandle;
    if (c.type === "free" || !c.ratio || c.ratio <= 0) {
      if (hh.includes("e")) nw = Math.max(4, pos.x - x);
      if (hh.includes("s")) nh = Math.max(4, pos.y - y);
      if (hh.includes("w")) {
        const right = x + w;
        nx = Math.min(pos.x, right - 4);
        nw = right - nx;
      }
      if (hh.includes("n")) {
        const bottom = y + h;
        ny = Math.min(pos.y, bottom - 4);
        nh = bottom - ny;
      }
      S.cropRect = { x: nx, y: ny, w: nw, h: nh };
      return;
    }
    const ratio = c.ratio;
    if (hh === "e" || hh === "w") {
      if (hh === "e") {
        nw = Math.max(4, pos.x - x);
      } else {
        const right = x + w;
        nx = Math.min(pos.x, right - 4);
        nw = right - nx;
      }
      nh = nw / ratio;
    } else if (hh === "n" || hh === "s") {
      if (hh === "s") {
        nh = Math.max(4, pos.y - y);
      } else {
        const bottom = y + h;
        ny = Math.min(pos.y, bottom - 4);
        nh = bottom - ny;
      }
      nw = nh * ratio;
    } else {
      if (hh === "se") {
        nw = Math.max(4, pos.x - x);
        nh = Math.max(4, pos.y - y);
      } else if (hh === "ne") {
        nw = Math.max(4, pos.x - x);
        const bottom = y + h;
        ny = Math.min(pos.y, bottom - 4);
        nh = bottom - ny;
      } else if (hh === "sw") {
        const right = x + w;
        nx = Math.min(pos.x, right - 4);
        nw = right - nx;
        nh = Math.max(4, pos.y - y);
      } else if (hh === "nw") {
        const right = x + w;
        nx = Math.min(pos.x, right - 4);
        nw = right - nx;
        const bottom = y + h;
        ny = Math.min(pos.y, bottom - 4);
        nh = bottom - ny;
      }
      if (nw / nh > ratio) {
        nh = nw / ratio;
        if (hh === "ne" || hh === "nw") ny = y + h - nh;
      } else {
        nw = nh * ratio;
        if (hh === "nw" || hh === "sw") nx = x + w - nw;
      }
    }
    S.cropRect = { x: nx, y: ny, w: nw, h: nh };
  }
  function confirmCrop() {
    if (!S.cropRect) return;
    const { x, y, w, h } = S.cropRect;
    if (w < 2 || h < 2) {
      cancelCrop();
      return;
    }
    const tmp = getCompositeCanvas();
    const sx = Math.round(x), sy = Math.round(y);
    const sw = Math.round(w), sh = Math.round(h);
    const cropC = document.createElement("canvas");
    const c = S.cropConstraint;
    const srcX = Math.max(0, sx);
    const srcY = Math.max(0, sy);
    const srcRight = Math.min(S.imgW, sx + sw);
    const srcBottom = Math.min(S.imgH, sy + sh);
    const srcW = Math.max(0, srcRight - srcX);
    const srcH = Math.max(0, srcBottom - srcY);
    const dstX = srcX - sx;
    const dstY = srcY - sy;
    if (c.type === "size" && c.sizeW > 0 && c.sizeH > 0) {
      cropC.width = c.sizeW;
      cropC.height = c.sizeH;
      const cctx = cropC.getContext("2d");
      const scaleX2 = c.sizeW / sw;
      const scaleY2 = c.sizeH / sh;
      if (srcW > 0 && srcH > 0) {
        cctx.drawImage(
          tmp,
          srcX,
          srcY,
          srcW,
          srcH,
          dstX * scaleX2,
          dstY * scaleY2,
          srcW * scaleX2,
          srcH * scaleY2
        );
      }
      S.imgW = c.sizeW;
      S.imgH = c.sizeH;
    } else {
      cropC.width = sw;
      cropC.height = sh;
      const cctx = cropC.getContext("2d");
      if (srcW > 0 && srcH > 0) {
        cctx.drawImage(tmp, srcX, srcY, srcW, srcH, dstX, dstY, srcW, srcH);
      }
      S.imgW = sw;
      S.imgH = sh;
    }
    const isSize = c.type === "size" && c.sizeW > 0 && c.sizeH > 0;
    const scaleX = isSize ? c.sizeW / sw : 1;
    const scaleY = isSize ? c.sizeH / sh : 1;
    S.textLayers = S.textLayers.map((t) => ({
      ...t,
      x: (t.x - sx) * scaleX,
      y: (t.y - sy) * scaleY,
      fontSize: t.fontSize * scaleX
    }));
    S.shapeLayers = S.shapeLayers.map((s) => ({
      ...s,
      ...s.type === "pen" ? { pts: (s.pts || []).map((p) => ({ x: (p.x - sx) * scaleX, y: (p.y - sy) * scaleY })) } : {
        x1: (s.x1 - sx) * scaleX,
        y1: (s.y1 - sy) * scaleY,
        x2: (s.x2 - sx) * scaleX,
        y2: (s.y2 - sy) * scaleY
      },
      lw: Math.max(1, s.lw * (scaleX + scaleY) / 2)
    }));
    S.selectedTextId = null;
    S.textDrag = null;
    S.selectedShapeId = null;
    S.shapeDrag = null;
    S.zoom = 1;
    setupCanvas(cropC);
    S.history = [];
    S.redoStack = [];
    S.cropRect = null;
    S.cropMoving = false;
    S.moveStart = null;
    clearOverlay();
    updateCropInfo();
  }
  function cancelCrop() {
    S.cropRect = null;
    S.cropHandle = null;
    S.cropMoving = false;
    S.moveStart = null;
    clearOverlay();
    updateCropInfo();
  }
  function showCropBar() {
    runtime.el.querySelector(".iwb-editor-crop-bar").style.display = "flex";
  }
  function hideCropBar() {
    runtime.el.querySelector(".iwb-editor-crop-bar").style.display = "none";
  }

  // iwb-cutout-extension/src/editor/history.js
  var snapshotStats = { snapshots: 0, getImageDataCalls: 0, bytesWritten: 0 };
  function snapshotState(opts) {
    const metaOnly = !!(opts && opts.metaOnly);
    const bitmaps = S.layers.map((layer) => {
      let data = null;
      if (!metaOnly && needsPixelSnapshot(layer)) {
        try {
          data = layer.ctx.getImageData(0, 0, S.imgW, S.imgH);
        } catch (e) {
        }
        if (data) {
          snapshotStats.getImageDataCalls++;
          snapshotStats.bytesWritten += data.data.byteLength;
        }
      }
      return {
        id: layer.id,
        data,
        x: layer.x,
        y: layer.y,
        w: layer.w,
        h: layer.h,
        rotation: layer.rotation || 0,
        transformable: !!layer.transformable,
        locked: !!layer.locked
      };
    });
    snapshotStats.snapshots++;
    return {
      bitmaps,
      texts: JSON.parse(JSON.stringify(S.textLayers)),
      shapes: JSON.parse(JSON.stringify(S.shapeLayers)),
      layerOrder: S.layers.map((l) => ({ id: l.id, name: l.name, z: l.z, opacity: l.opacity, visible: l.visible, locked: !!l.locked, x: l.x, y: l.y, w: l.w, h: l.h }))
    };
  }
  var HISTORY_MAX_ENTRIES = 50;
  var HISTORY_MAX_BYTES = 128 * 1024 * 1024;
  function stateBytes(state) {
    let n = 0;
    if (state && state.bitmaps) {
      for (const b of state.bitmaps) {
        if (b.data && b.data.data) n += b.data.data.byteLength;
      }
    }
    if (state) {
      n += state.texts ? JSON.stringify(state.texts).length * 2 : 0;
      n += state.shapes ? JSON.stringify(state.shapes).length * 2 : 0;
    }
    return n;
  }
  function pushHistory(stack, state) {
    state.__bytes = stateBytes(state);
    stack.push(state);
    let total = stack.reduce((sum, s) => sum + (s.__bytes || 0), 0);
    while (stack.length > 1 && (stack.length > HISTORY_MAX_ENTRIES || total > HISTORY_MAX_BYTES)) {
      total -= stack.shift().__bytes || 0;
    }
    return state;
  }
  function saveSnapshot() {
    pushHistory(S.history, snapshotState());
    S.redoStack = [];
  }
  function restoreState(state) {
    purgeVectorCanvases();
    for (const l of S.layers) l._bounds = void 0;
    if (state.bitmaps) {
      for (let i = 0; i < state.bitmaps.length; i++) {
        const bm = state.bitmaps[i];
        const layer = S.layers.find((l) => l.id === bm.id);
        if (layer) {
          layer.x = bm.x;
          layer.y = bm.y;
          layer.w = bm.w;
          layer.h = bm.h;
          layer.locked = !!bm.locked;
          layer.rotation = bm.rotation || 0;
          if (isDrawableLayer(layer)) {
            layer._srcBox = null;
            layer.sourceCanvas = null;
            layer.rotation = 0;
            layer.x = 0;
            layer.y = 0;
            layer.w = S.imgW;
            layer.h = S.imgH;
            layer._bounds = void 0;
          }
          if (restorePath(layer) === "redraw") {
            redrawBitmapLayer(layer);
          } else if (bm.data) {
            try {
              layer.ctx.clearRect(0, 0, S.imgW, S.imgH);
              layer.ctx.putImageData(bm.data, 0, 0);
            } catch (e) {
            }
          }
        }
      }
    }
    if (state.layerOrder) {
      for (const meta of state.layerOrder) {
        const layer = S.layers.find((l) => l.id === meta.id);
        if (layer) {
          layer.name = meta.name;
          layer.z = meta.z;
          layer.opacity = meta.opacity == null ? 1 : meta.opacity;
          layer.visible = meta.visible !== false;
          layer.locked = !!meta.locked;
        }
      }
      reorderLayerCanvas();
    }
    S.textLayers = state.texts ? JSON.parse(JSON.stringify(state.texts)) : [];
    S.shapeLayers = state.shapes ? JSON.parse(JSON.stringify(state.shapes)) : [];
    S.selectedTextId = null;
    S.textDrag = null;
    S.selectedShapeId = null;
    S.shapeDrag = null;
    renderObjects();
    renderLayerPanel();
  }
  function undo() {
    if (S.placingImage) return;
    if (S.isDrawing || S.textDrag || S.shapeDrag || S.bitmapDrag) return;
    if (S.history.length === 0) return;
    pushHistory(S.redoStack, snapshotState());
    restoreState(S.history.pop());
  }
  function redo() {
    if (S.placingImage) return;
    if (S.isDrawing || S.textDrag || S.shapeDrag || S.bitmapDrag) return;
    if (S.redoStack.length === 0) return;
    pushHistory(S.history, snapshotState());
    restoreState(S.redoStack.pop());
  }
  function resetDraw() {
    purgeVectorCanvases();
    for (const layer of S.layers) {
      if (layer.id !== "base") {
        layer.ctx.clearRect(0, 0, S.imgW, S.imgH);
        if (layer.sourceCanvas) layer.sourceCanvas.getContext("2d").clearRect(0, 0, layer.sourceCanvas.width, layer.sourceCanvas.height);
      }
    }
    S.history = [];
    S.redoStack = [];
    S.cropRect = null;
    S.cropHandle = null;
    S.cropMoving = false;
    S.moveStart = null;
    S.textLayers = [];
    S.selectedTextId = null;
    S.textDrag = null;
    S.textEditingId = null;
    S.shapeLayers = [];
    S.selectedShapeId = null;
    S.shapeDrag = null;
    renderObjects();
    renderLayerPanel();
    clearOverlay();
    updateCropInfo();
    hideTextInput();
  }
  function restoreOriginal() {
    if (!S.originalImage) return;
    if (!window.confirm("\u590D\u539F\u5C06\u4E22\u5F03\u6240\u6709\u6807\u6CE8\u548C\u88C1\u526A\uFF0C\u56DE\u5230\u539F\u59CB\u56FE\u7247\u3002\u786E\u5B9A\u7EE7\u7EED\u5417\uFF1F")) return;
    S.imgW = S.originalImage.naturalWidth || S.originalImage.width;
    S.imgH = S.originalImage.naturalHeight || S.originalImage.height;
    S.zoom = 1;
    setupCanvas(S.originalImage);
    resetDraw();
    updateAllUI();
  }

  // iwb-cutout-extension/src/editor/index.js
  async function open(options) {
    if (!options || !options.imageBase64) return;
    createEl();
    S.callbacks = options;
    try {
      const img = await loadImage(options.imageBase64);
      S.imgW = img.naturalWidth || img.width;
      S.imgH = img.naturalHeight || img.height;
      S.originalImage = img;
      runtime.el.style.display = "flex";
      S.open = true;
      S.zoom = 1;
      setupCanvas(img);
      resetState();
      updateAllUI();
    } catch (e) {
      console.error("[IWB\u7F16\u8F91\u5668] \u6253\u5F00\u5931\u8D25:", e);
      if (runtime.el) runtime.el.style.display = "none";
      if (options.onError) options.onError(e.message);
    }
  }
  function resetState() {
    purgeVectorCanvases();
    S.history = [];
    S.redoStack = [];
    S.cropRect = null;
    S.cropHandle = null;
    S.cropMoving = false;
    S.moveStart = null;
    S.isDrawing = false;
    S.panning = false;
    S.tool = "brush";
    S.color = "#ff4444";
    S.brushSize = 3;
    S.brushHardness = 100;
    S.brushOpacity = 1;
    S.prevTool = null;
    S.pickerComposite = null;
    S.rectFill = false;
    S.cropConstraint = { type: "free", ratio: 0, sizeW: 0, sizeH: 0 };
    S.textLayers = [];
    S.selectedTextId = null;
    S.textDrag = null;
    S.textEditingId = null;
    S.shapeLayers = [];
    S.selectedShapeId = null;
    S.shapeDrag = null;
    S.penPath = null;
    S.penEditId = null;
    S.penDragPt = -1;
    S.penDragBase = null;
    S.penDragPending = null;
    S.zCounter = Math.max(S.layers.length - 1, 0);
    S.placingImage = null;
    S.placingHandle = null;
    S.placingStart = null;
    const sizeToggle = runtime.el && runtime.el.querySelector(".iwb-editor-size-toggle");
    if (sizeToggle) {
      sizeToggle.classList.remove("active");
      sizeToggle.setAttribute("aria-pressed", "false");
      sizeToggle.textContent = "\u542F\u7528\u5C3A\u5BF8";
    }
  }
  function close() {
    if (runtime.el) {
      hideTextInput();
      runtime.el.style.display = "none";
    }
    S.open = false;
    S.callbacks = null;
    S.placingImage = null;
    S.placingHandle = null;
    S.placingStart = null;
    S.penPath = null;
    S.textEditingId = null;
    clearSelection();
  }
  function exportResult(mode) {
    if (S.placingImage) cancelImagePlacement();
    const tmp = getCompositeCanvas();
    let dataUrl;
    try {
      dataUrl = tmp.toDataURL("image/png");
    } catch (e) {
      console.error("[IWB\u7F16\u8F91\u5668] \u5BFC\u51FA\u5931\u8D25:", e);
      if (S.callbacks && S.callbacks.onError) S.callbacks.onError("\u56FE\u7247\u8DE8\u57DF\u65E0\u6CD5\u5BFC\u51FA");
      return;
    }
    if (S.callbacks && S.callbacks.onResult) {
      S.callbacks.onResult(dataUrl, mode);
    }
    close();
  }
  var __stats = () => ({
    history: S.history.length,
    historyBytes: S.history.reduce((n, s) => n + (s.__bytes || 0), 0),
    redo: S.redoStack.length,
    redoBytes: S.redoStack.reduce((n, s) => n + (s.__bytes || 0), 0),
    maxEntries: HISTORY_MAX_ENTRIES,
    maxBytes: HISTORY_MAX_BYTES,
    ...snapshotStats
  });
  window.__iwbEditor = {
    open,
    close,
    __stats
  };

  // iwb-cutout-extension/src/shared/config.js
  var CONFIG_KEY = "iwb_cutout_config";
  var DEFAULT_CONFIG = Object.freeze({
    apiUrl: "http://localhost:30092",
    crop: true,
    // 抠图后裁掉多余透明像素
    autoConnect: true,
    // 新节点模式下自动连线
    replaceMode: false,
    // false=创建新节点，true=替换原图
    autoWhiteBg: false,
    // 抠图后直接生成白底大图
    bgSize: 800,
    // 白底画布边长
    bgRatio: 0.85,
    // 内容占画布比例 0~1
    bgMode: "white",
    // white=白底 / transparent=透明底
    compressWidth: 1024,
    // 压缩目标宽度
    compressQuality: 80,
    // 压缩质量 10~100
    // 编辑/抠图/白底/压缩读图时优先取宿主存的原图（IndexedDB/Cache 引用），
    // 失败回落画布上的 ≤1024px 预览图。关闭后行为与旧版一致（只用预览图）。
    useOriginalImage: true
  });
  var clamp2 = (n, min, max) => Math.min(max, Math.max(min, n));
  function num(v, fallback, min, max) {
    const n = typeof v === "number" ? v : parseFloat(v);
    if (!Number.isFinite(n)) return fallback;
    return clamp2(n, min, max);
  }
  function normalizeApiUrl(v) {
    const raw = String(v == null ? "" : v).trim();
    if (!raw) return DEFAULT_CONFIG.apiUrl;
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
    const candidate = hasScheme ? raw : `http://${raw}`;
    try {
      const u = new URL(candidate);
      if (u.protocol !== "http:" && u.protocol !== "https:") return DEFAULT_CONFIG.apiUrl;
      if (!u.hostname) return DEFAULT_CONFIG.apiUrl;
      return u.origin;
    } catch {
      return DEFAULT_CONFIG.apiUrl;
    }
  }
  function mergeConfig(raw) {
    const r = raw && typeof raw === "object" ? raw : {};
    const d = DEFAULT_CONFIG;
    return {
      apiUrl: normalizeApiUrl(r.apiUrl != null ? r.apiUrl : d.apiUrl),
      crop: r.crop != null ? !!r.crop : d.crop,
      autoConnect: r.autoConnect != null ? !!r.autoConnect : d.autoConnect,
      replaceMode: r.replaceMode != null ? !!r.replaceMode : d.replaceMode,
      autoWhiteBg: r.autoWhiteBg != null ? !!r.autoWhiteBg : d.autoWhiteBg,
      bgSize: Math.round(num(r.bgSize != null ? r.bgSize : d.bgSize, d.bgSize, 64, 4096)),
      // 旧实现允许输入 500 存成 5.0，这里 clamp 到 0.1~1
      bgRatio: num(r.bgRatio != null ? r.bgRatio : d.bgRatio, d.bgRatio, 0.1, 1),
      bgMode: r.bgMode === "transparent" ? "transparent" : "white",
      compressWidth: Math.round(num(r.compressWidth != null ? r.compressWidth : d.compressWidth, d.compressWidth, 64, 8192)),
      compressQuality: Math.round(num(r.compressQuality != null ? r.compressQuality : d.compressQuality, d.compressQuality, 10, 100)),
      useOriginalImage: r.useOriginalImage != null ? !!r.useOriginalImage : d.useOriginalImage
    };
  }

  // iwb-cutout-extension/src/shared/bytes.js
  function splitDataUrl(dataUrl) {
    const s = String(dataUrl || "");
    const m = /^data:([^;,]+)?(;base64)?,/i.exec(s);
    if (!m) return { mime: null, base64: s };
    return { mime: m[1] || null, base64: s.slice(m[0].length) };
  }
  function base64ToBytes(input) {
    const { base64 } = splitDataUrl(input);
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  function toFile(data, filename = "image.png", fallbackMime = "image/png") {
    const { mime, base64 } = splitDataUrl(data);
    const bytes = base64ToBytes(base64);
    return new File([bytes], filename, { type: mime || fallbackMime });
  }

  // iwb-cutout-extension/src/shared/selectors.js
  var SEL = {
    /** 画布节点 */
    node: ".iwb-node[data-node-id]",
    /** 当前选中的节点 */
    nodeSelected: ".iwb-node.iwb-node-selected[data-node-id]",
    /** 应用自绘的浮动气泡栏（本扩展按钮的定位参照物） */
    floatbar: ".iwb-node-floatbar",
    /** 参考图节点里的图片 */
    refImage: "img.iwb-ref-single, .iwb-ref-single img, .iwb-ref-show img",
    /** 输出/结果节点里的图片 */
    outImage: "img.iwb-out-cell-img, .iwb-out-cell-img img, img.iwb-result-thumb, .iwb-result-thumb img",
    /** 任意节点里"有图片"的判定 */
    anyImage: ".iwb-ref-single, .iwb-ref-body .iwb-ref-show img, .iwb-out-cell-img, .iwb-result-thumb",
    /** 空参考图节点 */
    emptyBox: ".iwb-ref-emptybox",
    refBody: ".iwb-ref-body",
    /** 注入结果的三类 file input */
    headFileInput: '.iwb-node-headbtns input[type="file"]',
    bodyFileInput: '.iwb-ref-emptybox input[type="file"], .iwb-ref-upload input[type="file"]',
    /** 工具栏"添加参考图节点"按钮（新建节点模式依赖它） */
    addRefBtn: '[data-tip*="\u53C2\u8003\u56FE\u8282\u70B9"], [data-tip*="\u53C2\u8003\u56FE"]',
    /** 本扩展注入的按钮类名（用于清理/打处理中标记） */
    extButtons: ".iwb-cutout-btn, .iwb-whitebg-btn, .iwb-compress-btn, .iwb-editor-btn-icon",
    /** 宿主存工作区数据的 localStorage 键（读取节点文件名用） */
    workspacesKey: "iwb_web_workspaces"
  };
  function byNodeId(nodeId, doc = document) {
    if (!nodeId) return null;
    return doc.querySelector(`[data-node-id="${String(nodeId).replace(/"/g, '\\"')}"]`);
  }
  var EXT_SEL = {
    editorOverlay: "#iwb-editor-overlay",
    toolbar: "#iwb-cutout-toolbar",
    overlay: "#iwb-cutout-overlay"
  };
  function probeHost(doc = document) {
    const out = [];
    const push = (name, ok, level, detail) => out.push({ name, ok, level, detail });
    const nodes = doc.querySelectorAll(SEL.node);
    push(
      "\u753B\u5E03\u8282\u70B9",
      nodes.length > 0,
      nodes.length > 0 ? "info" : "warn",
      nodes.length ? `\u627E\u5230 ${nodes.length} \u4E2A\u8282\u70B9` : "\u9875\u9762\u4E0A\u6CA1\u6709 .iwb-node\uFF08\u53EF\u80FD\u672A\u8FDB\u5165\u753B\u5E03\u9875\uFF09"
    );
    const selected = doc.querySelectorAll(SEL.nodeSelected);
    push("\u9009\u4E2D\u8282\u70B9", true, "info", selected.length ? "\u5B58\u5728\u9009\u4E2D\u8282\u70B9" : "\u5F53\u524D\u65E0\u9009\u4E2D\u8282\u70B9");
    push(
      "\u6D6E\u52A8\u6C14\u6CE1\u680F",
      !!doc.querySelector(SEL.floatbar),
      "info",
      doc.querySelector(SEL.floatbar) ? "\u5B58\u5728 .iwb-node-floatbar" : "\u5F53\u524D\u65E0\u6C14\u6CE1\u680F\uFF08\u672A\u9009\u4E2D\u8282\u70B9\u65F6\u6B63\u5E38\uFF09"
    );
    const anyImgCount = nodes.length ? Array.from(nodes).filter((n) => n.querySelector("img")).length : 0;
    const refMatchCount = nodes.length ? Array.from(nodes).filter((n) => n.querySelector(SEL.refImage) || n.querySelector(SEL.outImage)).length : 0;
    if (anyImgCount === 0) {
      push("\u56FE\u7247\u9009\u62E9\u5668", true, "info", "\u5F53\u524D\u6CA1\u6709\u542B\u56FE\u8282\u70B9\uFF0C\u8DF3\u8FC7\u6821\u9A8C");
    } else {
      push(
        "\u56FE\u7247\u9009\u62E9\u5668",
        refMatchCount > 0,
        refMatchCount > 0 ? "ok" : "error",
        refMatchCount > 0 ? `${refMatchCount}/${anyImgCount} \u4E2A\u542B\u56FE\u8282\u70B9\u53EF\u88AB\u8BC6\u522B` : `\u53D1\u73B0 ${anyImgCount} \u4E2A\u542B\u56FE\u8282\u70B9\u4F46\u9009\u62E9\u5668\u4E00\u4E2A\u90FD\u6CA1\u5339\u914D \u2014\u2014 \u5BBF\u4E3B\u53EF\u80FD\u6539\u7248`
      );
    }
    push(
      "\u65B0\u5EFA\u8282\u70B9\u6309\u94AE",
      !!doc.querySelector(SEL.addRefBtn),
      "info",
      doc.querySelector(SEL.addRefBtn) ? "\u627E\u5230\u6DFB\u52A0\u53C2\u8003\u56FE\u6309\u94AE" : "\u672A\u627E\u5230\u6DFB\u52A0\u53C2\u8003\u56FE\u6309\u94AE\uFF08\u65B0\u5EFA\u8282\u70B9\u6A21\u5F0F\u5C06\u56DE\u9000\u4E3A\u7C98\u8D34\uFF09"
    );
    let lsOk = false;
    try {
      lsOk = !!window.localStorage.getItem(SEL.workspacesKey);
    } catch {
      lsOk = false;
    }
    push(
      "\u5DE5\u4F5C\u533A\u6570\u636E",
      lsOk,
      lsOk ? "info" : "warn",
      lsOk ? "localStorage \u952E\u5B58\u5728\uFF08\u6587\u4EF6\u540D\u53EF\u8BFB\u53D6\uFF09" : `\u672A\u627E\u5230 ${SEL.workspacesKey}\uFF0C\u8282\u70B9\u6587\u4EF6\u540D\u5C06\u56DE\u843D\u4E3A image`
    );
    return out;
  }
  function probeProblems(results) {
    return results.filter((r) => !r.ok && (r.level === "error" || r.level === "warn"));
  }

  // iwb-cutout-extension/src/shared/error-report.js
  var LAST_ERROR_KEY = "iwb_last_error";
  var TOAST_THROTTLE_MS = 1e4;
  function toEntry(err, source) {
    const message = err && err.message ? String(err.message) : String(err);
    return {
      message,
      source: source || "unknown",
      stack: err && err.stack ? String(err.stack).split("\n").slice(0, 5).join("\n") : "",
      at: Date.now()
    };
  }
  async function recordError(err, source, chromeRef = globalThis.chrome) {
    const entry = toEntry(err, source);
    try {
      if (chromeRef && chromeRef.storage && chromeRef.storage.local) {
        await chromeRef.storage.local.set({ [LAST_ERROR_KEY]: entry });
      }
    } catch {
    }
    return entry;
  }
  function installErrorBoundary(opts = {}) {
    const w = opts.windowRef || globalThis;
    const chromeRef = opts.chromeRef;
    const onFatal = typeof opts.onFatal === "function" ? opts.onFatal : null;
    const lastToastAt = /* @__PURE__ */ new Map();
    const handle = async (err, source) => {
      const entry = await recordError(err, source, chromeRef);
      if (!onFatal) return;
      const now = Date.now();
      const prev = lastToastAt.get(entry.source) || 0;
      if (now - prev >= TOAST_THROTTLE_MS) {
        lastToastAt.set(entry.source, now);
        try {
          onFatal(entry);
        } catch {
        }
      }
      return entry;
    };
    const onError = (event) => {
      if (event && event.target && event.target !== w && event.target.tagName) return;
      const err = event && (event.error || event.reason) || event && event.message || event;
      handle(err, "window.onerror");
    };
    const onRejection = (event) => handle(event && event.reason || event, "unhandledrejection");
    if (typeof w.addEventListener === "function") {
      w.addEventListener("error", onError);
      w.addEventListener("unhandledrejection", onRejection);
    }
    return {
      dispose() {
        if (typeof w.removeEventListener === "function") {
          w.removeEventListener("error", onError);
          w.removeEventListener("unhandledrejection", onRejection);
        }
      }
    };
  }
  function describeError(entry) {
    if (!entry) return "\u53D1\u751F\u672A\u77E5\u9519\u8BEF";
    const msg = entry.message || "\u672A\u77E5\u9519\u8BEF";
    return `\u6269\u5C55\u5185\u90E8\u9519\u8BEF\uFF08${entry.source}\uFF09\uFF1A${msg.slice(0, 120)} \u2014 \u8BE6\u89C1\u63D2\u4EF6\u5F39\u7A97\u300C\u6700\u8FD1\u4E00\u6B21\u9519\u8BEF\u300D`;
  }

  // iwb-cutout-extension/src/shared/host-adapter.js
  var WS_INDEX_KEY = "iwb_web_workspaces";
  var WS_KEY_PREFIX = "iwb_ws_";
  var WS_ACTIVE_KEY = "iwb_ws_active";
  function parseJson(raw) {
    try {
      return JSON.parse(raw || "null");
    } catch {
      return null;
    }
  }
  function nodeInBoard(board, nodeId) {
    const nodes = board && Array.isArray(board.nodes) ? board.nodes : null;
    return nodes ? nodes.find((n) => n && n.id === nodeId) || null : null;
  }
  function findNodeRecord(nodeId, storage = globalThis.localStorage) {
    if (!nodeId || !storage) return null;
    try {
      let activeId = "";
      try {
        activeId = storage.getItem(WS_ACTIVE_KEY) || "";
      } catch {
        activeId = "";
      }
      const idx = parseJson(storage.getItem(WS_INDEX_KEY));
      if (!activeId && idx && idx.activeId) activeId = String(idx.activeId);
      const viaKey = (id) => {
        if (!id) return null;
        return nodeInBoard(parseJson(storage.getItem(WS_KEY_PREFIX + id)), nodeId);
      };
      const hit = viaKey(activeId);
      if (hit) return hit;
      if (idx && Array.isArray(idx.workspaces)) {
        for (const w of idx.workspaces) {
          if (!w || !w.id || String(w.id) === activeId) continue;
          const n = viaKey(String(w.id));
          if (n) return n;
        }
        for (const w of idx.workspaces) {
          const n = nodeInBoard(w, nodeId);
          if (n) return n;
        }
      }
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (!k || k.indexOf(WS_KEY_PREFIX) !== 0 || k === WS_ACTIVE_KEY || k.indexOf("iwb_ws_bak_") === 0 || k.indexOf("iwb_ws_expanded") === 0) continue;
        const n = nodeInBoard(parseJson(storage.getItem(k)), nodeId);
        if (n) return n;
      }
    } catch {
    }
    return null;
  }
  function getSelectedNode(doc = document) {
    return doc.querySelector(SEL.nodeSelected);
  }
  function getNodeById(nodeId, doc = document) {
    return byNodeId(nodeId, doc);
  }
  function resolveLiveNode(nodeId, fallback, doc = document) {
    return getSelectedNode(doc) || getNodeById(nodeId, doc) || fallback || null;
  }
  function getNodeImage(nodeEl) {
    if (!nodeEl) return null;
    const img = nodeEl.querySelector(SEL.refImage) || nodeEl.querySelector(SEL.outImage);
    if (!img) return null;
    const src = img.currentSrc || img.src;
    if (!src) return null;
    if (src.startsWith("data:")) return { base64: src };
    if (src.startsWith("blob:")) return { blobUrl: src };
    return { url: src };
  }
  function hasImage(nodeEl) {
    return !!(nodeEl && nodeEl.querySelector(SEL.anyImage));
  }
  function isEmptyRefNode(nodeEl) {
    if (!nodeEl) return false;
    return !!(nodeEl.querySelector(SEL.emptyBox) || nodeEl.querySelector(SEL.refBody) && !nodeEl.querySelector(SEL.refImage));
  }
  function getNodeFileName(nodeEl, storage = globalThis.localStorage) {
    if (!nodeEl) return "image";
    try {
      const nodeId = nodeEl.getAttribute("data-node-id");
      const node = findNodeRecord(nodeId, storage);
      return node && node.data && node.data.name || "image";
    } catch {
      return "image";
    }
  }
  function getNodeImageDataRef(nodeEl, storage = globalThis.localStorage) {
    if (!nodeEl) return null;
    try {
      const nodeId = nodeEl.getAttribute("data-node-id");
      const node = findNodeRecord(nodeId, storage);
      const d = node && node.data;
      if (!d || typeof d !== "object") return null;
      if (d.data) return { kind: "data", value: d.data };
      if (d.url) return { kind: "url", value: String(d.url) };
      return null;
    } catch {
      return null;
    }
  }
  function getAddRefButton(doc = document) {
    return doc.querySelector(SEL.addRefBtn);
  }
  function findFileInput(nodeEl, opts = {}) {
    if (!nodeEl) return null;
    if (nodeEl.querySelector(SEL.headFileInput)) return "head";
    if (nodeEl.querySelector(SEL.bodyFileInput)) return "body";
    if (opts.allowAny && nodeEl.querySelector('input[type="file"]')) return "any";
    return null;
  }
  function getFileInput(nodeEl, kind) {
    if (!nodeEl || !kind) return null;
    if (kind === "head") return nodeEl.querySelector(SEL.headFileInput);
    if (kind === "body") return nodeEl.querySelector(SEL.bodyFileInput);
    if (kind === "any") return nodeEl.querySelector('input[type="file"]');
    return null;
  }
  function writeFileToInput(input, file) {
    if (!input || !file || typeof DataTransfer === "undefined") return false;
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    } catch {
      return false;
    }
  }
  function writeFileToNode(nodeEl, file, opts = {}) {
    const kind = findFileInput(nodeEl, opts);
    if (!kind) return false;
    return writeFileToInput(getFileInput(nodeEl, kind), file);
  }
  function waitForNewNode(existing, timeout = 2e3, doc = document) {
    const before = Array.isArray(existing) ? existing : Array.from(doc.querySelectorAll(SEL.node));
    return new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        for (const node of doc.querySelectorAll(SEL.node)) {
          if (!node.querySelector(SEL.refImage) && !before.includes(node)) {
            resolve(node);
            return;
          }
        }
        if (Date.now() - start > timeout) resolve(null);
        else setTimeout(check, 50);
      };
      check();
    });
  }
  function snapshotNodes(doc = document) {
    return Array.from(doc.querySelectorAll(SEL.node));
  }

  // iwb-cutout-extension/src/shared/original-image.js
  var HOST_IDB_NAME = "iwb_web";
  var HOST_IDB_VERSION = 3;
  var HOST_IDB_IMAGES_STORE = "images";
  var HOST_IMAGE_CACHE = "iwb-images-local";
  function blobToDataUrl(blob, FileReaderCtor = globalThis.FileReader) {
    if (!blob) return Promise.resolve(null);
    if (typeof FileReaderCtor === "function") {
      return new Promise((resolve) => {
        const reader = new FileReaderCtor();
        reader.onloadend = () => resolve(typeof reader.result === "string" ? reader.result : null);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
    }
    if (typeof blob.arrayBuffer === "function") {
      return blob.arrayBuffer().then((buf) => {
        const bytes = new Uint8Array(buf);
        let bin = "";
        const chunk = 32768;
        for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        const mime = blob.type || "image/png";
        return `data:${mime};base64,${btoa(bin)}`;
      }).catch(() => null);
    }
    return Promise.resolve(null);
  }
  function openHostIdb(indexedDB) {
    return new Promise((resolve) => {
      if (!indexedDB || typeof indexedDB.open !== "function") {
        resolve(null);
        return;
      }
      let req;
      try {
        req = indexedDB.open(HOST_IDB_NAME, HOST_IDB_VERSION);
      } catch {
        resolve(null);
        return;
      }
      req.onupgradeneeded = () => {
      };
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    });
  }
  async function idbGetBlob(indexedDB, key) {
    const db = await openHostIdb(indexedDB);
    if (!db) return null;
    try {
      if (!db.objectStoreNames.contains(HOST_IDB_IMAGES_STORE)) return null;
      const value = await new Promise((resolve) => {
        const tx = db.transaction(HOST_IDB_IMAGES_STORE, "readonly");
        const req = tx.objectStore(HOST_IDB_IMAGES_STORE).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      });
      if (value && typeof value === "object" && typeof value.slice === "function") return value;
      return null;
    } catch {
      return null;
    } finally {
      try {
        db.close();
      } catch {
      }
    }
  }
  async function cacheMatch(cachesRef, origin, path) {
    if (!cachesRef || typeof cachesRef.open !== "function" || !path) return null;
    try {
      const cache = await cachesRef.open(HOST_IMAGE_CACHE);
      if (!cache || typeof cache.match !== "function") return null;
      const url = /^https?:/i.test(path) ? path : String(origin || "") + path;
      const resp = await cache.match(new Request(url));
      return resp && typeof resp.blob === "function" ? await resp.blob() : null;
    } catch {
      return null;
    }
  }
  async function resolveImageDataRef(value, deps = {}) {
    if (value == null || value === "") return null;
    const FileReaderCtor = deps.FileReader || globalThis.FileReader;
    if (typeof value === "string") {
      if (value.startsWith("data:")) return { base64: value };
      if (value.startsWith("blob:")) return { blobUrl: value };
      if (/^https?:/i.test(value)) return { url: value };
      return null;
    }
    if (typeof value === "object") {
      if (typeof value.__blob === "string" && value.__blob) {
        const blob = await idbGetBlob(deps.indexedDB || globalThis.indexedDB, value.__blob);
        const base64 = await blobToDataUrl(blob, FileReaderCtor);
        return base64 ? { base64 } : null;
      }
      if (typeof value.__cache === "string" && value.__cache) {
        const blob = await cacheMatch(deps.caches || globalThis.caches, deps.origin || globalThis.location?.origin, value.__cache);
        const base64 = await blobToDataUrl(blob, FileReaderCtor);
        return base64 ? { base64 } : null;
      }
    }
    return null;
  }

  // iwb-cutout-extension/src/content.js
  (function() {
    "use strict";
    let config = { ...DEFAULT_CONFIG };
    function loadConfig() {
      chrome.runtime.sendMessage({ type: "GET_CONFIG" }, (resp) => {
        if (resp && resp.success && resp.config) {
          config = mergeConfig(resp.config);
        }
      });
    }
    loadConfig();
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[CONFIG_KEY]) {
        config = mergeConfig({ ...config, ...changes[CONFIG_KEY].newValue || {} });
      }
    });
    const SCISSORS_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><path d="M8.12 8.12 12 12"/><path d="M20 4 8.12 15.88"/><circle cx="6" cy="18" r="3"/><path d="M14.8 14.8 20 20"/></svg>`;
    const WHITE_BG_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><rect x="7.9" y="7.9" width="8.2" height="8.2" rx="1" fill="currentColor" stroke="none" opacity="0.4"/></svg>`;
    const EDITOR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`;
    const processingNodes = /* @__PURE__ */ new Set();
    const overlay = document.createElement("div");
    overlay.id = "iwb-cutout-overlay";
    overlay.className = "iwb-cutout-overlay";
    overlay.innerHTML = '<div class="iwb-cutout-spinner"></div><span class="iwb-cutout-text">\u9C9C\u827A\u62A0\u56FE\u5904\u7406\u4E2D...</span>';
    overlay.style.display = "none";
    let toastEl = null;
    let toastTimer = null;
    async function blobUrlToBase64(blobUrl) {
      try {
        const resp = await fetch(blobUrl);
        const blob = await resp.blob();
        return new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.readAsDataURL(blob);
        });
      } catch (e) {
        return null;
      }
    }
    async function readSourceImage(nodeEl) {
      const fallback = getNodeImage(nodeEl);
      if (!config.useOriginalImage) return fallback;
      try {
        const ref = getNodeImageDataRef(nodeEl);
        if (!ref) return fallback;
        const resolved = await resolveImageDataRef(ref.value);
        return resolved || fallback;
      } catch (e) {
        return fallback;
      }
    }
    async function loadImageSafe(src) {
      function loadVia(url) {
        return new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error("\u56FE\u7247\u52A0\u8F7D\u5931\u8D25"));
          img.src = url;
        });
      }
      if (/^https?:/i.test(src)) {
        try {
          const resp = await fetch(src, { mode: "cors" });
          if (resp.ok) {
            const blob = await resp.blob();
            const url = URL.createObjectURL(blob);
            try {
              return await loadVia(url);
            } finally {
              setTimeout(() => URL.revokeObjectURL(url), 5e3);
            }
          }
        } catch (e) {
        }
      }
      if (/^https?:/i.test(src)) {
        throw new Error("\u8FDC\u7A0B\u56FE\u7247\u7981\u6B62\u8DE8\u57DF\u8BFB\u53D6");
      }
      return loadVia(src);
    }
    async function makeWhiteBgImage(imageData, size, ratio, mode) {
      mode = mode === "transparent" ? "transparent" : "white";
      let src = imageData.base64;
      if (!src && imageData.blobUrl) src = await blobUrlToBase64(imageData.blobUrl);
      if (!src) src = imageData.url;
      if (!src) throw new Error("\u65E0\u6CD5\u83B7\u53D6\u56FE\u7247\u6570\u636E");
      const img = await loadImageSafe(src);
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (mode === "white") {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, size, size);
      }
      const { x, y, w, h } = fitRect(img.width, img.height, size, size, ratio);
      ctx.drawImage(img, x, y, w, h);
      return canvas.toDataURL("image/png");
    }
    function base64ToFile(base64Data, filename) {
      return toFile(base64Data, filename || "cutout.png");
    }
    async function performCutout(nodeEl) {
      const nodeId = nodeEl.getAttribute("data-node-id");
      if (!nodeId) {
        showToast("\u65E0\u6CD5\u83B7\u53D6\u8282\u70B9 ID", "error");
        return;
      }
      if (processingNodes.has(nodeId)) {
        showToast("\u8BE5\u8282\u70B9\u6B63\u5728\u5904\u7406\u4E2D", "info");
        return;
      }
      processingNodes.add(nodeId);
      setButtonProcessing(nodeEl, true);
      showOverlay();
      try {
        const imgData = await readSourceImage(nodeEl);
        if (!imgData) {
          showToast("\u672A\u627E\u5230\u56FE\u7247\uFF0C\u8BF7\u786E\u4FDD\u8282\u70B9\u4E2D\u6709\u56FE\u7247", "error");
          return;
        }
        let imageBase64 = imgData.base64;
        if (!imageBase64 && imgData.blobUrl) {
          imageBase64 = await blobUrlToBase64(imgData.blobUrl);
        }
        if (!imageBase64 && imgData.url) {
          try {
            const img = await loadImageSafe(imgData.url);
            const canvas = document.createElement("canvas");
            canvas.width = img.naturalWidth || img.width;
            canvas.height = img.naturalHeight || img.height;
            if (!canvas.width || !canvas.height) throw new Error("\u56FE\u7247\u5C3A\u5BF8\u65E0\u6548");
            canvas.getContext("2d").drawImage(img, 0, 0);
            imageBase64 = canvas.toDataURL("image/png");
          } catch (e) {
            if (!/^https?:/i.test(imgData.url)) throw new Error("\u65E0\u6CD5\u8BFB\u53D6\u56FE\u7247\u6570\u636E");
          }
        }
        if (!imageBase64 && !imgData.url) throw new Error("\u65E0\u6CD5\u8BFB\u53D6\u56FE\u7247\u6570\u636E");
        const resp = await chrome.runtime.sendMessage({
          type: "CUTOUT_IMAGE",
          imageBase64: imageBase64 || null,
          imageUrl: imageBase64 ? null : imgData.url
        });
        if (!resp || !resp.success) {
          throw new Error(resp?.error || "\u62A0\u56FE API \u8C03\u7528\u5931\u8D25");
        }
        let cutoutBase64 = resp.resultBase64;
        const sourceName = getNodeFileName(nodeEl) || "image";
        let cutoutName = sourceName.replace(/\.[^.]+$/, "") + "_cutout.png";
        if (config.autoWhiteBg) {
          showToast("\u62A0\u56FE\u5B8C\u6210\uFF0C\u6B63\u5728\u751F\u6210\u767D\u5E95\u56FE...", "info");
          const whiteBase64 = await makeWhiteBgImage({ base64: cutoutBase64 }, config.bgSize, config.bgRatio);
          cutoutBase64 = whiteBase64;
          cutoutName = sourceName.replace(/\.[^.]+$/, "") + "_800x800.png";
        }
        if (config.replaceMode) {
          await injectReplaceImage(nodeEl, cutoutBase64, cutoutName);
        } else {
          await injectNewNode(cutoutBase64, cutoutName);
        }
        showToast(config.replaceMode ? "\u62A0\u56FE\u5B8C\u6210\uFF0C\u5DF2\u66FF\u6362\u539F\u56FE" : "\u62A0\u56FE\u5B8C\u6210\uFF0C\u65B0\u8282\u70B9\u5DF2\u521B\u5EFA", "success");
      } catch (err) {
        console.error("[IWB\u62A0\u56FE] \u5931\u8D25:", err);
        showToast(`\u62A0\u56FE\u5931\u8D25: ${err.message}`, "error");
      } finally {
        hideOverlay();
        processingNodes.delete(nodeId);
        setButtonProcessing(nodeEl, false);
      }
    }
    async function performWhiteBg(nodeEl) {
      const nodeId = nodeEl.getAttribute("data-node-id");
      if (!nodeId) {
        showToast("\u65E0\u6CD5\u83B7\u53D6\u8282\u70B9 ID", "error");
        return;
      }
      if (processingNodes.has(nodeId)) {
        showToast("\u8BE5\u8282\u70B9\u6B63\u5728\u5904\u7406\u4E2D", "info");
        return;
      }
      processingNodes.add(nodeId);
      setButtonProcessing(nodeEl, true);
      showOverlay("\u767D\u5E95\u56FE\u5904\u7406\u4E2D...");
      try {
        const imgData = await readSourceImage(nodeEl);
        if (!imgData) {
          showToast("\u672A\u627E\u5230\u56FE\u7247\uFF0C\u8BF7\u786E\u4FDD\u8282\u70B9\u4E2D\u6709\u56FE\u7247", "error");
          return;
        }
        const currentConfig = await new Promise((resolve) => chrome.runtime.sendMessage({ type: "GET_CONFIG" }, (r) => resolve(r && r.success && r.config || config)));
        const size = currentConfig.bgSize || config.bgSize || 800;
        const ratio = currentConfig.bgRatio != null ? currentConfig.bgRatio : config.bgRatio || 0.85;
        const mode = currentConfig.bgMode || config.bgMode || "white";
        const outBase64 = await makeWhiteBgImage(imgData, size, ratio, mode);
        const sourceName = getNodeFileName(nodeEl) || "image";
        const outName = sourceName.replace(/\.[^.]+$/, "") + `_${size}x${size}.png`;
        const label = mode === "transparent" ? "\u900F\u660E\u5E95" : "\u767D\u5E95";
        if (currentConfig.replaceMode != null ? currentConfig.replaceMode : config.replaceMode) {
          await injectReplaceImage(nodeEl, outBase64, outName);
        } else {
          await injectNewNode(outBase64, outName);
        }
        showToast((currentConfig.replaceMode != null ? currentConfig.replaceMode : config.replaceMode) ? `${label}\u56FE\u5DF2\u66FF\u6362\u539F\u56FE` : `${label}\u56FE\u8282\u70B9\u5DF2\u521B\u5EFA`, "success");
      } catch (err) {
        console.error("[IWB\u62A0\u56FE] \u5927\u56FE\u5904\u7406\u5931\u8D25:", err);
        showToast(`\u5904\u7406\u5931\u8D25: ${err.message}`, "error");
      } finally {
        hideOverlay();
        processingNodes.delete(nodeId);
        setButtonProcessing(nodeEl, false);
      }
    }
    async function performEditor(nodeEl) {
      if (processingNodes.has(nodeEl.getAttribute("data-node-id") || "")) {
        showToast("\u8BE5\u8282\u70B9\u6B63\u5728\u5904\u7406\u4E2D", "info");
        return;
      }
      try {
        const imgData = await readSourceImage(nodeEl);
        if (!imgData) {
          showToast("\u672A\u627E\u5230\u56FE\u7247", "error");
          return;
        }
        let imageBase64 = imgData.base64;
        if (!imageBase64 && imgData.blobUrl) {
          imageBase64 = await blobUrlToBase64(imgData.blobUrl);
        }
        if (!imageBase64 && imgData.url) {
          try {
            const img = await loadImageSafe(imgData.url);
            const c = document.createElement("canvas");
            c.width = img.naturalWidth || img.width;
            c.height = img.naturalHeight || img.height;
            c.getContext("2d").drawImage(img, 0, 0);
            imageBase64 = c.toDataURL("image/png");
          } catch (err) {
            showToast("\u65E0\u6CD5\u8BFB\u53D6\u56FE\u7247\uFF08\u8DE8\u57DF\u9650\u5236\uFF09\uFF0C\u8BF7\u5148\u4E0B\u8F7D\u5230\u672C\u5730", "error");
            return;
          }
        }
        if (!imageBase64) {
          showToast("\u65E0\u6CD5\u8BFB\u53D6\u56FE\u7247\u6570\u636E", "error");
          return;
        }
        const sourceName = getNodeFileName(nodeEl) || "image";
        if (!window.__iwbEditor) {
          showToast("\u7F16\u8F91\u5668\u672A\u52A0\u8F7D\uFF0C\u8BF7\u5237\u65B0\u9875\u9762", "error");
          return;
        }
        window.__iwbEditor.open({
          imageBase64,
          imageName: sourceName,
          onResult: async (dataUrl, mode) => {
            const outName = sourceName.replace(/\.[^.]+$/, "") + "_edited.png";
            try {
              if (mode === "replace") {
                await injectReplaceImage(nodeEl, dataUrl, outName);
                showToast("\u7F16\u8F91\u7ED3\u679C\u5DF2\u8986\u76D6\u539F\u56FE", "success");
              } else {
                await injectNewNode(dataUrl, outName);
                showToast("\u7F16\u8F91\u7ED3\u679C\u5DF2\u521B\u5EFA\u4E3A\u65B0\u8282\u70B9", "success");
              }
            } catch (err) {
              console.error("[IWB\u7F16\u8F91\u5668] \u6CE8\u5165\u5931\u8D25:", err);
              showToast(`\u6CE8\u5165\u5931\u8D25: ${err.message}`, "error");
            }
          },
          onError: (msg) => showToast(msg, "error")
        });
      } catch (err) {
        console.error("[IWB\u7F16\u8F91\u5668] \u6253\u5F00\u5931\u8D25:", err);
        showToast(`\u7F16\u8F91\u5668\u6253\u5F00\u5931\u8D25: ${err.message}`, "error");
      }
    }
    async function injectReplaceImage(nodeEl, cutoutBase64, filename) {
      if (writeFileToNode(nodeEl, base64ToFile(cutoutBase64, filename))) return;
      await injectViaPasteEvent(cutoutBase64, filename, true);
    }
    async function injectNewNode(cutoutBase64, filename) {
      const addRefBtn = getAddRefButton();
      if (addRefBtn) {
        const before = snapshotNodes();
        addRefBtn.click();
        const newNode = await waitForNewNode(before);
        if (newNode && writeFileToNode(newNode, base64ToFile(cutoutBase64, filename), { allowAny: true })) return;
      }
      await injectViaPasteEvent(cutoutBase64, filename, false);
    }
    async function injectViaPasteEvent(cutoutBase64, filename, _replaceMode) {
      const file = base64ToFile(cutoutBase64, filename);
      const dt = new DataTransfer();
      dt.items.add(file);
      try {
        const event = new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: dt
        });
        window.dispatchEvent(event);
        await new Promise((r) => setTimeout(r, 500));
        showToast("\u5DF2\u901A\u8FC7\u7C98\u8D34\u65B9\u5F0F\u6CE8\u5165\uFF0C\u5982\u672A\u663E\u793A\u8BF7\u68C0\u67E5", "info");
      } catch (e) {
        try {
          await navigator.clipboard.write([
            new ClipboardItem({ [file.type]: file })
          ]);
          showToast("\u62A0\u56FE\u7ED3\u679C\u5DF2\u590D\u5236\u5230\u526A\u8D34\u677F\uFF0C\u8BF7\u6309 Ctrl+V \u7C98\u8D34\u5230\u753B\u5E03", "info");
        } catch (clipErr) {
          showToast("\u65E0\u6CD5\u81EA\u52A8\u6CE8\u5165\uFF0C\u8BF7\u624B\u52A8\u7C98\u8D34", "error");
        }
      }
    }
    let tipEl = null;
    let tipTimer = null;
    function ensureTip() {
      if (tipEl) return tipEl;
      tipEl = document.createElement("div");
      tipEl.id = "iwb-cutout-tip";
      document.body.appendChild(tipEl);
      return tipEl;
    }
    function moveTip(e) {
      if (!tipEl || tipEl.style.display === "none") return;
      const pad = 14;
      let x = e.clientX + pad;
      let y = e.clientY + pad;
      const r = tipEl.getBoundingClientRect();
      if (x + r.width > window.innerWidth - 6) x = e.clientX - r.width - pad;
      if (y + r.height > window.innerHeight - 6) y = e.clientY - r.height - pad;
      tipEl.style.left = x + "px";
      tipEl.style.top = y + "px";
    }
    function showTip(text, e) {
      const tip = ensureTip();
      tip.textContent = text;
      tip.style.display = "block";
      moveTip(e);
    }
    function hideTip() {
      if (tipEl) tipEl.style.display = "none";
    }
    function bindTip(btn, text) {
      btn.addEventListener("mouseenter", (e) => {
        clearTimeout(tipTimer);
        tipTimer = setTimeout(() => showTip(text, e), 200);
      });
      btn.addEventListener("mousemove", moveTip);
      btn.addEventListener("mouseleave", () => {
        clearTimeout(tipTimer);
        hideTip();
      });
      btn.addEventListener("click", () => {
        clearTimeout(tipTimer);
        hideTip();
      });
    }
    function setButtonProcessing(nodeEl, processing) {
      const id = nodeEl.getAttribute("data-node-id");
      const mark = (btn) => {
        btn.classList.toggle("processing", processing);
        btn.style.pointerEvents = processing ? "none" : "";
      };
      nodeEl.querySelectorAll(SEL.extButtons).forEach(mark);
      document.querySelectorAll(SEL.floatbar).forEach((bar) => {
        const n = findFloatbarNode(bar);
        if (n && n.getAttribute("data-node-id") === id) {
          bar.querySelectorAll(SEL.extButtons).forEach(mark);
        }
      });
    }
    function showOverlay(text) {
      if (text) overlay.querySelector(".iwb-cutout-text").textContent = text;
      overlay.style.display = "flex";
    }
    function hideOverlay() {
      overlay.style.display = "none";
    }
    function showToast(msg, type = "info") {
      if (!toastEl) {
        toastEl = document.createElement("div");
        toastEl.id = "iwb-cutout-toast";
        document.body.appendChild(toastEl);
      }
      toastEl.textContent = msg;
      toastEl.className = `iwb-cutout-toast iwb-cutout-toast-${type}`;
      toastEl.style.display = "block";
      toastEl.style.opacity = "1";
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        toastEl.style.opacity = "0";
        setTimeout(() => {
          if (toastEl) toastEl.style.display = "none";
        }, 300);
      }, 3500);
    }
    async function performCompress(nodeEl) {
      const nodeId = nodeEl.getAttribute("data-node-id");
      if (!nodeId || processingNodes.has(nodeId)) return;
      processingNodes.add(nodeId);
      setButtonProcessing(nodeEl, true);
      try {
        const currentConfig = await new Promise((resolve) => chrome.runtime.sendMessage({ type: "GET_CONFIG" }, (r) => resolve(r && r.success && r.config || config)));
        const data = await readSourceImage(nodeEl);
        const src = data.base64 || (data.blobUrl ? await blobUrlToBase64(data.blobUrl) : data.url);
        if (!src) throw new Error("\u65E0\u6CD5\u8BFB\u53D6\u56FE\u7247\u6570\u636E");
        const img = await loadImageSafe(src);
        const width = Math.min(currentConfig.compressWidth || 1024, 16384);
        const height = Math.max(1, Math.round(img.height * width / img.width));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        const out = canvas.toDataURL("image/jpeg", Math.min(1, Math.max(0.1, (currentConfig.compressQuality || 80) / 100)));
        await injectReplaceImage(nodeEl, out, (getNodeFileName(nodeEl) || "image") + "-compressed.jpg");
        showToast("\u56FE\u7247\u538B\u7F29\u5B8C\u6210", "success");
      } catch (e) {
        console.error("[IWB\u538B\u7F29]", e);
        showToast("\u538B\u7F29\u5931\u8D25\uFF1A" + e.message, "error");
      } finally {
        processingNodes.delete(nodeId);
        setButtonProcessing(nodeEl, false);
      }
    }
    const BLANK_RATIOS = [
      { value: "1:1", label: "1:1 \u65B9\u5F62", sizes: { "1K": "1024x1024", "2K": "2048x2048", "4K": "2864x2864" } },
      { value: "2:3", label: "2:3 \u7AD6\u7248", sizes: { "1K": "832x1248", "2K": "1536x2304", "4K": "2048x3072" } },
      { value: "3:2", label: "3:2 \u6A2A\u7248", sizes: { "1K": "1248x832", "2K": "2304x1536", "4K": "3072x2048" } },
      { value: "3:4", label: "3:4 \u7AD6\u7248", sizes: { "1K": "880x1168", "2K": "2016x2688", "4K": "2448x3264" } },
      { value: "4:3", label: "4:3 \u6A2A\u7248", sizes: { "1K": "1184x880", "2K": "2688x2016", "4K": "2688x2016" } },
      { value: "4:5", label: "4:5 \u7AD6\u7248", sizes: { "1K": "912x1136", "2K": "1632x2032", "4K": "2048x2560" } },
      { value: "5:4", label: "5:4 \u6A2A\u7248", sizes: { "1K": "1136x896", "2K": "2032x1632", "4K": "2560x2048" } },
      { value: "9:16", label: "9:16 \u7AD6\u7248", sizes: { "1K": "768x1360", "2K": "1440x2560", "4K": "2160x3840" } },
      { value: "16:9", label: "16:9 \u6A2A\u7248", sizes: { "1K": "1360x752", "2K": "2048x1152", "4K": "3840x2160" } },
      { value: "21:9", label: "21:9 \u8D85\u5BBD", sizes: { "1K": "1552x656", "2K": "2688x1152", "4K": "3840x1648" } },
      { value: "9:21", label: "9:21 \u8D85\u5BBD\u7AD6\u7248", sizes: { "1K": "656x1520", "2K": "1152x2688", "4K": "1648x3840" } }
    ];
    const BLANK_CANVAS_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 8v8M8 12h8"/></svg>';
    let blankMenuEl = null;
    let blankMenuOutsideHandler = null;
    function closeBlankMenu() {
      if (blankMenuEl) {
        blankMenuEl.remove();
        blankMenuEl = null;
      }
      if (blankMenuOutsideHandler) {
        document.removeEventListener("pointerdown", blankMenuOutsideHandler, true);
        blankMenuOutsideHandler = null;
      }
    }
    function parseSizeText(t) {
      const m = String(t).toLowerCase().match(/(\d+)\s*x\s*(\d+)/);
      return m ? { w: parseInt(m[1], 10), h: parseInt(m[2], 10) } : null;
    }
    function waitForNodeImage(nodeEl, timeout) {
      return new Promise((resolve) => {
        const t0 = Date.now();
        const iv = setInterval(() => {
          if (hasImage(nodeEl)) {
            clearInterval(iv);
            resolve(true);
            return;
          }
          if (Date.now() - t0 > timeout) {
            clearInterval(iv);
            resolve(false);
          }
        }, 120);
      });
    }
    async function performBlankCanvas(nodeEl, w, h, bg) {
      closeBlankMenu();
      bg = bg === "transparent" ? "transparent" : "white";
      const nodeId = nodeEl.getAttribute("data-node-id");
      if (!nodeId || processingNodes.has(nodeId)) return;
      processingNodes.add(nodeId);
      setButtonProcessing(nodeEl, true);
      try {
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const ctx = c.getContext("2d");
        if (bg === "white") {
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, w, h);
        }
        const url = c.toDataURL("image/png");
        const name = (getNodeFileName(nodeEl) || "\u63D2\u56FE") + "_blank_" + w + "x" + h + ".png";
        await injectReplaceImage(nodeEl, url, name);
        showToast("\u7A7A\u767D\u753B\u5E03\u5DF2\u521B\u5EFA\uFF0C\u6B63\u5728\u6253\u5F00\u7ED8\u5236\u2026", "success");
        const ok = await waitForNodeImage(nodeEl, 3e3);
        if (ok && window.__iwbEditor) {
          setTimeout(() => performEditor(nodeEl), 150);
        }
      } catch (err) {
        console.error("[IWB\u7A7A\u767D\u753B\u5E03] \u5931\u8D25:", err);
        showToast("\u521B\u5EFA\u7A7A\u767D\u753B\u5E03\u5931\u8D25: " + err.message, "error");
      } finally {
        processingNodes.delete(nodeId);
        setButtonProcessing(nodeEl, false);
      }
    }
    function showBlankMenu(btn, nodeEl) {
      closeBlankMenu();
      const menu = document.createElement("div");
      menu.className = "iwb-blank-menu";
      const r = btn.getBoundingClientRect();
      menu.style.left = Math.max(8, Math.min(window.innerWidth - 250, r.right - 230)) + "px";
      menu.style.top = Math.max(8, r.bottom + 6) + "px";
      let html = '<div class="iwb-blank-title">\u521B\u5EFA\u7A7A\u767D\u753B\u5E03</div><div class="iwb-blank-grid">';
      html += BLANK_RATIOS.map((rp) => {
        const dim = parseSizeText(rp.sizes && rp.sizes["1K"] || "1024x1024") || { w: 1024, h: 1024 };
        return '<button type="button" data-w="' + dim.w + '" data-h="' + dim.h + '"><b>' + rp.label + "</b><i>" + dim.w + "\xD7" + dim.h + "</i></button>";
      }).join("");
      html += "</div>";
      menu.innerHTML = html;
      menu.querySelectorAll("[data-w]").forEach((b) => b.addEventListener("click", (e) => {
        e.stopPropagation();
        const w = parseInt(b.dataset.w, 10), h = parseInt(b.dataset.h, 10);
        closeBlankMenu();
        performBlankCanvas(nodeEl, w, h, "white");
      }));
      blankMenuEl = menu;
      document.body.appendChild(menu);
      blankMenuOutsideHandler = (e) => {
        if (!blankMenuEl || !blankMenuEl.contains(e.target)) closeBlankMenu();
      };
      document.addEventListener("pointerdown", blankMenuOutsideHandler, true);
    }
    function addBlankToolButton(host, nodeEl, beforeEl) {
      if (!host) return;
      const nodeId = nodeEl.getAttribute("data-node-id");
      const existing = host.querySelector(".iwb-blank-canvas-btn");
      if (existing) {
        if (existing.dataset.nodeId === nodeId) return;
        existing.remove();
      }
      const liveNode = () => resolveLiveNode(nodeId, nodeEl);
      const b = document.createElement("button");
      b.className = "iwb-node-del iwb-blank-canvas-btn";
      b.innerHTML = BLANK_CANVAS_SVG;
      b.dataset.nodeId = nodeId || "";
      b.style.color = "#0ea5e9";
      bindTip(b, "\u7A7A\u767D\u753B\u5E03\uFF1A\u521B\u5EFA\u6307\u5B9A\u5C3A\u5BF8\u7A7A\u767D\u56FE\u5E76\u6253\u5F00\u7ED8\u5236\uFF08\u63D2\u56FE/\u6807\u6CE8\uFF09");
      b.addEventListener("pointerdown", (e) => e.stopPropagation());
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        showBlankMenu(b, liveNode());
      });
      const anchor = beforeEl || host.lastElementChild;
      host.insertBefore(b, anchor ? anchor.nextSibling : null);
    }
    function addToolButtons(host, nodeEl, beforeEl) {
      if (!host) return;
      const nodeId = nodeEl.getAttribute("data-node-id");
      const existing = host.querySelector(".iwb-cutout-btn");
      if (existing) {
        if (existing.dataset.nodeId === nodeId) return;
        host.querySelectorAll(SEL.extButtons).forEach((b) => b.remove());
      }
      const liveNode = () => resolveLiveNode(nodeId, nodeEl);
      const make = (cls, content, color, tip, run) => {
        const b = document.createElement("button");
        b.className = "iwb-node-del " + cls;
        if (typeof content === "string" && content.indexOf("<svg") === 0) b.innerHTML = content;
        else b.textContent = content;
        b.style.color = color;
        b.dataset.nodeId = nodeId || "";
        bindTip(b, tip);
        b.addEventListener("pointerdown", (e) => e.stopPropagation());
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          e.preventDefault();
          run(liveNode());
        });
        return b;
      };
      const compress = make(
        "iwb-compress-btn",
        "\u538B",
        "#16a34a",
        "\u56FE\u7247\u538B\u7F29\uFF08\u5BBD\u5EA6 " + (config.compressWidth || 1024) + "px\uFF0C\u8D28\u91CF " + (config.compressQuality || 80) + "%\uFF09",
        performCompress
      );
      const cutout = make("iwb-cutout-btn", SCISSORS_SVG, "#e8a735", "\u9C9C\u827AAI\u62A0\u56FE\uFF08\u53BB\u80CC\u666F\uFF09", performCutout);
      const bgLabel = config.bgMode === "transparent" ? "\u900F\u660E\u5E95" : "\u767D\u5E95";
      const white = make(
        "iwb-whitebg-btn",
        WHITE_BG_SVG,
        "#3b82f6",
        bgLabel + " " + (config.bgSize || 800) + "\xD7" + (config.bgSize || 800) + "\uFF08\u5185\u5BB9\u5360 " + Math.round((config.bgRatio || 0.85) * 100) + "%\uFF09",
        performWhiteBg
      );
      const edit = make("iwb-editor-btn-icon", EDITOR_SVG, "#a855f7", "\u56FE\u7247\u7F16\u8F91\uFF08\u56FE\u5C42\u3001\u753B\u7B14\u3001\u88C1\u526A\u3001\u6807\u6CE8\uFF09", performEditor);
      const anchor = beforeEl || host.lastElementChild;
      [compress, cutout, white, edit].forEach((b) => {
        host.insertBefore(b, anchor ? anchor.nextSibling : null);
      });
    }
    function findFloatbarNode(bar) {
      const br = bar.getBoundingClientRect();
      if (!br.width || !br.height) return null;
      const bx = br.left + br.width / 2;
      let best = null, bestScore = Infinity;
      document.querySelectorAll(SEL.node).forEach((n) => {
        const r = n.getBoundingClientRect();
        if (!r.width || !r.height) return;
        const cx = r.left + r.width / 2;
        const dx = Math.abs(cx - bx);
        const dy = br.bottom - r.top;
        if (dx < 40 && dy > -30 && dy < 90) {
          const score = dx * 2 + Math.abs(dy);
          if (score < bestScore) {
            bestScore = score;
            best = n;
          }
        }
      });
      if (!best) {
        const selNode = document.querySelector(SEL.nodeSelected);
        if (selNode) return selNode;
      }
      return best;
    }
    let toolbarEl = null;
    let toolbarNodeId = "";
    function ensureToolbar() {
      if (toolbarEl && toolbarEl.parentNode) return toolbarEl;
      toolbarEl = document.createElement("div");
      toolbarEl.id = "iwb-cutout-toolbar";
      toolbarEl.className = "iwb-cutout-toolbar";
      document.body.appendChild(toolbarEl);
      return toolbarEl;
    }
    function hideToolbar() {
      if (toolbarEl) {
        toolbarEl.style.display = "none";
        toolbarEl.innerHTML = "";
      }
      toolbarNodeId = "";
    }
    function updateToolbar() {
      const editorOverlay = document.getElementById(EXT_SEL.editorOverlay.slice(1));
      if (editorOverlay && editorOverlay.style.display && editorOverlay.style.display !== "none") {
        hideToolbar();
        return;
      }
      const bar = document.querySelector(SEL.floatbar);
      if (!bar) {
        hideToolbar();
        return;
      }
      let nodeEl = document.querySelector(SEL.nodeSelected);
      if (!nodeEl) nodeEl = findFloatbarNode(bar);
      if (!nodeEl) {
        hideToolbar();
        return;
      }
      ensureToolbar();
      const id = nodeEl.getAttribute("data-node-id") || "";
      if (id !== toolbarNodeId) {
        toolbarEl.innerHTML = "";
        if (hasImage(nodeEl)) addToolButtons(toolbarEl, nodeEl, null);
        else if (isEmptyRefNode(nodeEl)) addBlankToolButton(toolbarEl, nodeEl, null);
        toolbarNodeId = id;
      }
      if (!toolbarEl.childElementCount) {
        toolbarEl.style.display = "none";
        return;
      }
      const r = bar.getBoundingClientRect();
      if (!r.width && !r.height) {
        hideToolbar();
        return;
      }
      const h = toolbarEl.offsetHeight || 28;
      const cx = r.left + r.width / 2;
      let top = r.top - h - 6;
      if (top < 8) top = r.bottom + 6;
      toolbarEl.style.transform = "translateX(-50%)";
      toolbarEl.style.left = Math.round(cx) + "px";
      toolbarEl.style.top = Math.round(top) + "px";
      toolbarEl.style.display = "flex";
    }
    const TOOLBAR_INTERVAL = 100;
    let toolbarTimer = null;
    let toolbarLastRun = 0;
    function runToolbarUpdate() {
      toolbarLastRun = performance.now();
      try {
        updateToolbar();
      } catch (e) {
      }
    }
    function scheduleToolbarUpdate() {
      if (toolbarTimer) return;
      const wait = Math.max(0, TOOLBAR_INTERVAL - (performance.now() - toolbarLastRun));
      toolbarTimer = setTimeout(() => {
        toolbarTimer = null;
        runToolbarUpdate();
      }, wait);
    }
    function runHostProbeOnce() {
      try {
        const problems = probeProblems(probeHost());
        const fatal = problems.filter((p) => p.level === "error");
        if (fatal.length) {
          showToast(
            `\u5BBF\u4E3B\u9875\u9762\u7ED3\u6784\u53EF\u80FD\u5DF2\u53D8\u5316\uFF1A${fatal.map((p) => p.name).join("\u3001")}\uFF08\u70B9\u51FB\u63D2\u4EF6\u56FE\u6807\u53EF\u81EA\u68C0\uFF09`,
            "error"
          );
        }
      } catch (e) {
      }
    }
    function init() {
      if (!document.body.contains(overlay)) document.body.appendChild(overlay);
      installErrorBoundary({ chromeRef: chrome, onFatal: (entry) => showToast(describeError(entry), "error") });
      ensureToolbar();
      scheduleToolbarUpdate();
      setInterval(() => {
        if (!document.hidden) scheduleToolbarUpdate();
      }, TOOLBAR_INTERVAL);
      if (typeof MutationObserver !== "undefined" && document.body) {
        const observer = new MutationObserver(() => scheduleToolbarUpdate());
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["class", "style", "src"]
        });
      }
      setTimeout(runHostProbeOnce, 3e3);
    }
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg && msg.type === "RUN_PROBE") {
        try {
          sendResponse({ success: true, results: probeHost() });
        } catch (e) {
          sendResponse({ success: false, error: e.message });
        }
      }
      return false;
    });
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init);
    } else {
      init();
    }
    window.__iwbCutout = {
      config: () => config,
      cutout: (nodeId) => {
        const el = byNodeId(nodeId);
        if (el) performCutout(el);
      },
      whiteBg: (nodeId) => {
        const el = byNodeId(nodeId);
        if (el) performWhiteBg(el);
      },
      edit: (nodeId) => {
        const el = byNodeId(nodeId);
        if (el) performEditor(el);
      },
      inject: updateToolbar,
      probe: () => probeHost()
    };
  })();
})();
