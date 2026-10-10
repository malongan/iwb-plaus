/* state.js - 编辑器唯一状态所有者
 * 持有 S（全局状态对象）、ZOOM_* 常量，以及 runtime（可变持有对象）。
 * 约定：ES 模块 import 绑定不可重新赋值，所以编辑器根节点 el 不用
 * `export let el`，而是放在 runtime.el 里，各模块统一读写 runtime.el。
 * 本模块不 import 任何编辑器内部模块（保持叶子节点，避免循环 TDZ）。
 */

'use strict'

  export const ZOOM_MIN = 0.1
  export const ZOOM_MAX = 10
  export const ZOOM_STEP = 1.15

  // ============ 状态 ============
  export const S = {
    open: false,
    tool: 'brush',
    color: '#ff4444',
    brushSize: 3,
    brushHardness: 100,   // 画笔硬度 0~100：100=硬边描边，<100=径向渐变软边章
    brushOpacity: 1,      // 画笔透明度 0.05~1（一笔整体透明度，笔划内不叠加）
    prevTool: null,       // 吸管工具激活前的工具（取色后切回）
    pickerComposite: null, // 吸管取样用的合成画布缓存（切工具/画布变化时失效）
    rectFill: false,      // 矩形是否实心填充
    // 图层系统
    layers: [],           // 位图图层数组 [{ id, name, canvas, ctx, opacity, visible, z }]
    activeLayerId: null,  // 当前活跃位图图层 ID（画笔/橡皮操作目标）
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
    startX: 0, startY: 0,
    history: [],
    redoStack: [],
    cropRect: null,
    cropHandle: null,
    cropMoving: false,
    moveStart: null,
    cropConstraint: { type: 'free', ratio: 0, sizeW: 0, sizeH: 0 },
    // 文字图层（独立对象，可选中/移动/缩放/再编辑）
    textLayers: [],       // [{ id, x, y, text, color, fontSize, opacity, visible, z }]
    selectedTextId: null,
    textDrag: null,       // { mode:'move'|'scale', start:{x,y}, layer:{x,y}, fontSize, baseX }
    textEditingId: null,
     selectedLayerId: null, // 选择工具当前选中的可编辑位图图层
     bitmapDrag: null,     // { mode:'move'|'scale', handle, start, layer, pending }
    // 形状图层（矩形/箭头，独立对象，可选中/移动/调手柄）
    shapeLayers: [],      // [{ id, type:'rect'|'arrow', x1,y1,x2,y2, color, lw, fill, opacity, visible, z }]
    selectedShapeId: null,
    shapeDrag: null,      // { mode:'move'|'handle', handle, start:{x,y}, shape:{...}, pending }
    penPath: null,        // 钢笔绘制中的点序列与预览点
    penEditId: null,     // 钢笔二次编辑中的形状 id
    penDragPt: -1,       // 正在拖动的节点下标（-1=无）
    penDragBase: null,
    penDragPending: null,
    zCounter: 0,          // 全局 z 序计数器（文字与形状统一排序）
    // 图片放置中状态（导入图片时先调整大小/位置再确认）
    placingImage: null,    // { img, x, y, w, h } 图片坐标
    placingHandle: null,   // 'move' | 'nw'|'ne'|'sw'|'se'|'n'|'s'|'e'|'w'
    placingStart: null,    // { mx, my, x, y, w, h }
    imgW: 0, imgH: 0,
     overlayPad: 0,
    originalImage: null, // 打开时的原始图片，用于「复原」
    fitW: 0, fitH: 0,   // 适应容器时的基准显示尺寸
    zoom: 1,            // 缩放倍率（基于 fit）
    viewX: null,        // 画布平移位置（wrap 内 left；null = 居中显示）
    viewY: null,
    callbacks: null,
    spaceDown: false,
    _shiftDown: false,
    _canvasEventsBound: false
  }

  export const runtime = { el: null }
