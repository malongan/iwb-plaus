/* IWB 图片编辑器 - 图层化裁剪与标注
 * 独立模块，通过 window.__iwbEditor.open() 调用
 * 接收 imageBase64，返回编辑后的 dataURL
 *
 * v2.0.0 特性：
 * - 图层系统：位图图层动态管理（原图、画笔、导入图片），可调透明度、显隐、排序
 * - 矢量对象（文字/形状）在图层面板中统一展示，z 序可调
 * - 统一橡皮：一个橡皮擦除当前活跃位图图层，与画笔共用大小/透明度/软硬
 * - 添加位图图层：支持导入新图片作为独立图层
 * - 工具：选择 / 画笔 / 矩形 / 箭头 / 文字 / 橡皮 / 吸管 / 抓手 / 裁剪
 *
 * 分层架构：
 * - bitmap layers: 每个位图图层一个 canvas（动态创建/排序），CSS opacity 控制透明度
 * - textCanvas: 矢量对象层（文字+形状），共享一个 canvas
 * - strokeCanvas: 笔划预览层（一笔结束后合成进活跃图层）
 * - overlayCanvas: 选中框/裁剪遮罩/笔刷预览
 */
(function () {
  'use strict'

  const ZOOM_MIN = 0.1
  const ZOOM_MAX = 10
  const ZOOM_STEP = 1.15

  // ============ 状态 ============
  const S = {
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

  let el = null

  // ============ DOM 创建 ============
  function createEl() {
    if (el) return
    el = document.createElement('div')
    el.id = 'iwb-editor-overlay'
    el.className = 'iwb-editor-overlay'
    el.innerHTML = `
      <div class="iwb-editor-modal">
        <div class="iwb-editor-header">
          <span class="iwb-editor-title">图片编辑</span>
          <div class="iwb-editor-tools">
            <button class="iwb-editor-tool" data-tool="select" title="选择/移动：点击元素选中，拖拽移动，手柄调整大小，双击文字改内容"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/></svg></button>

            <button class="iwb-editor-tool active" data-tool="brush" title="画笔"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg></button>

            <button class="iwb-editor-tool" data-tool="eraser" title="橡皮：擦除当前活跃图层的内容（画笔标注或原图），与画笔共用大小/硬度/透明度"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/></svg></button>

            <button class="iwb-editor-tool" data-tool="pen" title="钢笔：点击添加节点，双击或 Enter 完成自定义形状"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 4 10l10 10 8-8L12 2Z"/><path d="m4 10 10 10"/><path d="m14 6 4 4"/><path d="M12 2v4"/><path d="M8 6h8"/></svg></button>

            <button class="iwb-editor-tool" data-tool="text" title="文字"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 3 20 3 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="3" x2="12" y2="20"/></svg></button>

            <button class="iwb-editor-tool" data-tool="rect" title="矩形框"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/></svg></button>

            <button class="iwb-editor-tool" data-tool="circle" title="圆形"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/></svg></button>

            <button class="iwb-editor-tool" data-tool="arrow" title="箭头"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg></button>

            <button class="iwb-editor-tool" data-tool="picker" title="吸管：点击画布取色（悬停预览），取色后自动切回上一工具"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3Z"/></svg></button>

            <button class="iwb-editor-tool" data-tool="hand" title="抓手：拖拽自由移动画布（任意工具下按住空格或鼠标中键也可平移）"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0"/><path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8"/><path d="M18 10a2 2 0 1 1 4 0v3a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg></button>

            <span class="iwb-editor-divider"></span>

            <button class="iwb-editor-tool" data-tool="crop" title="裁剪"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6.13 1L6 16a2 2 0 0 0 2 2h15"/><path d="M1 6.13L16 6a2 2 0 0 1 2 2v15"/></svg></button>
          </div>
          <span class="iwb-editor-divider"></span>
          <div class="iwb-editor-history">
            <button class="iwb-editor-action" data-action="undo" title="撤销 (Ctrl+Z)"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg></button>
            <button class="iwb-editor-action" data-action="redo" title="重做 (Ctrl+Shift+Z)"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button>
            <button class="iwb-editor-action" data-action="reset" title="清空标注"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
            <button class="iwb-editor-action iwb-editor-action-restore" data-action="restore" title="复原原始图（撤销所有编辑）"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg></button>
          </div>




        </div>
        <div class="iwb-editor-main">
          <aside class="iwb-editor-left">
          <div class="iwb-editor-color-panel"><div class="iwb-editor-color-panel-title">调色板</div><div class="iwb-editor-color-picker2"><div class="iwb-color-sv"><span></span></div><div class="iwb-color-hue"><span></span></div></div><div class="iwb-editor-color-fields"><button type="button" class="iwb-editor-color-eye" data-action="palettePick" title="吸色：点击后在画布取样"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3Z"/></svg></button><input class="iwb-editor-color-hex-input" value="#ff4444" maxlength="7"></div><div class="iwb-editor-color-swatches"><button type="button" class="iwb-editor-color-panel-swatch" data-panel-color="#ff4444" style="background:#ff4444" title="#ff4444"></button><button type="button" class="iwb-editor-color-panel-swatch" data-panel-color="#ff8800" style="background:#ff8800" title="#ff8800"></button><button type="button" class="iwb-editor-color-panel-swatch" data-panel-color="#ffd400" style="background:#ffd400" title="#ffd400"></button><button type="button" class="iwb-editor-color-panel-swatch" data-panel-color="#44dd44" style="background:#44dd44" title="#44dd44"></button><button type="button" class="iwb-editor-color-panel-swatch" data-panel-color="#00bfa5" style="background:#00bfa5" title="#00bfa5"></button><button type="button" class="iwb-editor-color-panel-swatch" data-panel-color="#4488ff" style="background:#4488ff" title="#4488ff"></button><button type="button" class="iwb-editor-color-panel-swatch" data-panel-color="#aa44ff" style="background:#aa44ff" title="#aa44ff"></button><button type="button" class="iwb-editor-color-panel-swatch" data-panel-color="#ff66aa" style="background:#ff66aa" title="#ff66aa"></button><button type="button" class="iwb-editor-color-panel-swatch" data-panel-color="#ffffff" style="background:#ffffff" title="#ffffff"></button><button type="button" class="iwb-editor-color-panel-swatch" data-panel-color="#b8b8b8" style="background:#b8b8b8" title="#b8b8b8"></button><button type="button" class="iwb-editor-color-panel-swatch" data-panel-color="#555555" style="background:#555555" title="#555555"></button><button type="button" class="iwb-editor-color-panel-swatch" data-panel-color="#000000" style="background:#000000" title="#000000"></button></div></div>
          <div class="iwb-editor-params">
            <div class="iwb-editor-zoom">
              <button class="iwb-editor-zoom-btn" data-action="zoomOut" title="缩小 (滚轮向下)">−</button>
              <span class="iwb-editor-zoom-val" title="滚轮缩放">100%</span>
              <button class="iwb-editor-zoom-btn" data-action="zoomIn" title="放大 (滚轮向上)">＋</button>
              <button class="iwb-editor-zoom-btn iwb-editor-zoom-fit" data-action="zoomFit" title="适应窗口">适应</button>
            </div>
            <span class="iwb-editor-divider"></span>

            <span class="iwb-editor-divider"></span>
            <div class="iwb-editor-layer-group" title="调整选中元素的图层顺序">
              <span class="iwb-editor-constraint-label">图层</span>
              <button class="iwb-editor-layer-btn" data-layer="top" title="置顶：选中元素移到最上层 (Ctrl+Shift+])"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="5" x2="20" y2="5"/><line x1="12" y1="19" x2="12" y2="5"/><polyline points="6 11 12 5 18 11"/></svg></button>
              <button class="iwb-editor-layer-btn" data-layer="up" title="上移一层 (Ctrl+])"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="6 11 12 5 18 11"/></svg></button>
              <button class="iwb-editor-layer-btn" data-layer="down" title="下移一层 (Ctrl+[)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="6 13 12 19 18 13"/></svg></button>
              <button class="iwb-editor-layer-btn" data-layer="bottom" title="置底：选中元素移到最下层 (Ctrl+Shift+[)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="6 13 12 19 18 13"/><line x1="4" y1="19" x2="20" y2="19"/></svg></button>
            </div>
            <label class="iwb-editor-brush-label">描边
              <input type="range" class="iwb-editor-brush-size" min="1" max="300" value="3">
              <input type="number" class="iwb-editor-brush-num" min="1" max="300" step="1" value="3" title="输入精确笔刷大小（1~300）">
            </label>
            <div class="iwb-editor-brush-presets" aria-label="描边快捷值">
              <button type="button" class="iwb-editor-brush-preset" data-brush-size="4" title="描边 4"><i></i></button>
              <button type="button" class="iwb-editor-brush-preset" data-brush-size="8" title="描边 8"><i></i></button>
              <button type="button" class="iwb-editor-brush-preset" data-brush-size="16" title="描边 16"><i></i></button>
              <button type="button" class="iwb-editor-brush-preset" data-brush-size="24" title="描边 24"><i></i></button>
            </div>
            <div class="iwb-editor-brush-group">
              <label class="iwb-editor-brush-label">硬度
                <input type="range" class="iwb-editor-brush-hardness" min="0" max="100" value="100">
                <span class="iwb-editor-brush-hardness-val">100</span>
              </label>
              <label class="iwb-editor-brush-label iwb-editor-opacity-label">透明
                <input type="range" class="iwb-editor-brush-opacity" min="5" max="100" step="5" value="100">
                <span class="iwb-editor-brush-opacity-val">100%</span>
              </label>
            </div>
          </div>
          <div class="iwb-editor-export-actions">
          <button class="iwb-editor-btn iwb-editor-btn-cancel" data-action="cancel">退出编辑</button>
          <button class="iwb-editor-btn iwb-editor-btn-new" data-action="newNode">新建节点</button>
          <button class="iwb-editor-btn iwb-editor-btn-replace" data-action="replace">覆盖原图</button>
           </div>
        </aside>


          <div class="iwb-editor-canvas-wrap">
            <div class="iwb-editor-canvas-stack">
              <div class="iwb-editor-transparency-grid"></div>
               <!-- 位图图层 canvas 动态插入此处 -->
              <canvas class="iwb-editor-stroke"></canvas>
              <canvas class="iwb-editor-text"></canvas>
              <canvas class="iwb-editor-crop-overlay"></canvas>
            </div>
            <input class="iwb-editor-text-input" type="text" placeholder="输入文字，Enter确认，Esc取消">
            <div class="iwb-editor-picker-tip"><span class="iwb-editor-picker-chip"></span><span class="iwb-editor-picker-hex">#ffffff</span></div>
            <div class="iwb-editor-crop-bar">
              <div class="iwb-editor-constraint-group">
                <span class="iwb-editor-constraint-label">比例</span>
                <button class="iwb-editor-constraint-btn active" data-ratio="free">自由</button>
                <button class="iwb-editor-constraint-btn" data-ratio="1:1">1:1</button>
                <button class="iwb-editor-constraint-btn" data-ratio="4:3">4:3</button>
                <button class="iwb-editor-constraint-btn" data-ratio="3:4">3:4</button>
                <button class="iwb-editor-constraint-btn" data-ratio="16:9">16:9</button>
                <button class="iwb-editor-constraint-btn" data-ratio="9:16">9:16</button>
              </div>
              <span class="iwb-editor-constraint-sep"></span>
              <div class="iwb-editor-constraint-group">
                <span class="iwb-editor-constraint-label">尺寸</span>
                <input class="iwb-editor-size-input iwb-editor-size-w" type="number" min="1" placeholder="宽" value="800">
                <span class="iwb-editor-size-x">×</span>
                <input class="iwb-editor-size-input iwb-editor-size-h" type="number" min="1" placeholder="高" value="800">
                <button class="iwb-editor-constraint-btn iwb-editor-size-toggle" data-action="toggleSizeConstraint" aria-pressed="false">启用尺寸</button>
                 <button class="iwb-editor-constraint-btn iwb-editor-size-apply" data-action="applySize">应用</button>
              </div>
              <span class="iwb-editor-constraint-sep"></span>
              <span class="iwb-editor-crop-info">--</span>
              <button class="iwb-editor-crop-confirm" data-action="confirmCrop">✓ 确认</button>
              <button class="iwb-editor-crop-cancel" data-action="cancelCrop">✗ 取消</button>
            </div>
            <div class="iwb-editor-zoom-hint">滚轮缩放 · 抓手/空格/中键拖拽自由移动画布</div>
          </div>
          <div class="iwb-editor-layer-panel">
            <div class="iwb-editor-layer-panel-header">
              <span class="iwb-editor-layer-panel-title">图层</span>
              <div class="iwb-editor-layer-add-group">
                <button class="iwb-editor-layer-add-btn" data-action="addBitmapLayer" title="导入图片为新图层"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg></button>
                <button class="iwb-editor-layer-add-btn" data-action="addBlankLayer" title="新建空白图层"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg></button>
              </div>
            </div>
            <div class="iwb-editor-color-panel"><div class="iwb-editor-color-panel-title">调色板</div><div class="iwb-editor-color-picker2"><div class="iwb-color-sv"><span></span></div><div class="iwb-color-hue"><span></span></div></div><div class="iwb-editor-color-fields"><button type="button" class="iwb-editor-color-eye" data-action="palettePick" title="吸色：点击后在画布取样"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3Z"/></svg></button><input class="iwb-editor-color-hex-input" value="#ff4444" maxlength="7"><div class="iwb-editor-fill-pair"><button class="iwb-editor-fill-btn" data-action="toggleFill" title="矩形实心填充开关（选中矩形时切换即时生效）">实心</button></div></div><div class="iwb-editor-color-swatches"><button type="button" class="iwb-editor-color-panel-swatch" data-panel-color="#ff4444" style="background:#ff4444" title="#ff4444"></button><button type="button" class="iwb-editor-color-panel-swatch" data-panel-color="#ff8800" style="background:#ff8800" title="#ff8800"></button><button type="button" class="iwb-editor-color-panel-swatch" data-panel-color="#ffd400" style="background:#ffd400" title="#ffd400"></button><button type="button" class="iwb-editor-color-panel-swatch" data-panel-color="#44dd44" style="background:#44dd44" title="#44dd44"></button><button type="button" class="iwb-editor-color-panel-swatch" data-panel-color="#00bfa5" style="background:#00bfa5" title="#00bfa5"></button><button type="button" class="iwb-editor-color-panel-swatch" data-panel-color="#4488ff" style="background:#4488ff" title="#4488ff"></button><button type="button" class="iwb-editor-color-panel-swatch" data-panel-color="#aa44ff" style="background:#aa44ff" title="#aa44ff"></button><button type="button" class="iwb-editor-color-panel-swatch" data-panel-color="#ff66aa" style="background:#ff66aa" title="#ff66aa"></button><button type="button" class="iwb-editor-color-panel-swatch" data-panel-color="#ffffff" style="background:#ffffff" title="#ffffff"></button><button type="button" class="iwb-editor-color-panel-swatch" data-panel-color="#b8b8b8" style="background:#b8b8b8" title="#b8b8b8"></button><button type="button" class="iwb-editor-color-panel-swatch" data-panel-color="#555555" style="background:#555555" title="#555555"></button><button type="button" class="iwb-editor-color-panel-swatch" data-panel-color="#000000" style="background:#000000" title="#000000"></button></div></div>
<div class="iwb-editor-layer-list"></div>
          </div>
        </div>
        <div class="iwb-editor-footer">

        </div>
      </div>
    `
    document.body.appendChild(el)

    S.canvasWrap = el.querySelector('.iwb-editor-canvas-wrap')
    S.canvasStack = el.querySelector('.iwb-editor-canvas-stack')
    S.transparencyGrid = el.querySelector('.iwb-editor-transparency-grid')
    S.textCanvas = el.querySelector('.iwb-editor-text')
    S.strokeCanvas = el.querySelector('.iwb-editor-stroke')
    S.overlayCanvas = el.querySelector('.iwb-editor-crop-overlay')
    S.textCtx = S.textCanvas.getContext('2d')
    S.strokeCtx = S.strokeCanvas.getContext('2d')
    S.overlayCtx = S.overlayCanvas.getContext('2d')

    bindEvents()
  }

  // ============ 图片加载 ============
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error('图片加载失败'))
      img.src = src
    })
  }

  // ============ 打开编辑器 ============
  async function open(options) {
    if (!options || !options.imageBase64) return
    createEl()
    S.callbacks = options

    try {
      const img = await loadImage(options.imageBase64)
      S.imgW = img.naturalWidth || img.width
      S.imgH = img.naturalHeight || img.height
      S.originalImage = img
      el.style.display = 'flex'
      S.open = true
      S.zoom = 1
      setupCanvas(img)
      resetState()
      updateAllUI()
    } catch (e) {
      console.error('[IWB编辑器] 打开失败:', e)
      if (el) el.style.display = 'none'
      if (options.onError) options.onError(e.message)
    }
  }

  // ============ 图层管理 ============

  /** 创建位图图层 canvas 元素并插入 DOM 栈 */
  function createLayerCanvas() {
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
  function reorderLayerCanvas() {
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
  function getActiveLayer() {
    return S.layers.find(l => l.id === S.activeLayerId) || null
  }

  /** 获取活跃位图图层的 2d context（画笔/橡皮操作目标） */
  function getActiveCtx() {
    const layer = getActiveLayer()
    return layer && !layer.locked ? layer.ctx : null
  }

  /** 清理所有画布/图层选择态，保证不同工具和图层之间互斥 */
  function clearSelection({ keepBitmap = false } = {}) {
    if (!keepBitmap) S.selectedLayerId = null
    S.selectedTextId = null
    S.selectedShapeId = null
    S.textDrag = null
    S.shapeDrag = null
    S.bitmapDrag = null
  }

  /** 设置活跃图层 */
  function redrawBitmapLayer(layer) {
     if (!layer || !layer.ctx) return
     layer.ctx.clearRect(0, 0, S.imgW, S.imgH)
     if (layer.image && layer.w > 0 && layer.h > 0) layer.ctx.drawImage(layer.image, layer.x, layer.y, layer.w, layer.h)
      else if (layer.sourceCanvas && layer.w > 0 && layer.h > 0) {
        layer.ctx.drawImage(layer.sourceCanvas, layer.x, layer.y, layer.w, layer.h)
      }
   }

   function bitmapHandlePoints(layer) {
     return {
       nw: [layer.x, layer.y], ne: [layer.x + layer.w, layer.y],
       sw: [layer.x, layer.y + layer.h], se: [layer.x + layer.w, layer.y + layer.h],
       n: [layer.x + layer.w / 2, layer.y], s: [layer.x + layer.w / 2, layer.y + layer.h],
       e: [layer.x + layer.w, layer.y + layer.h / 2], w: [layer.x, layer.y + layer.h / 2]
     }
   }

   function hitBitmapHandle(pos) {
     const layer = S.layers.find(l => l.id === S.selectedLayerId && l.transformable)
     if (!layer || layer.visible === false) return null
     const points = bitmapHandlePoints(layer)
     const radius = 12 / S.zoom
     let hit = null, best = Infinity
     for (const name in points) {
       const distance = Math.hypot(pos.x - points[name][0], pos.y - points[name][1])
       if (distance < radius && distance < best) { best = distance; hit = name }
     }
     return hit
   }

   function hitBitmapLayer(pos) {
     const layers = [...S.layers].sort((a, b) => (a.z || 0) - (b.z || 0))
     for (let i = layers.length - 1; i >= 0; i--) {
       const layer = layers[i]
       if (!layer.transformable || layer.visible === false) continue
       if (pos.x >= layer.x && pos.x <= layer.x + layer.w && pos.y >= layer.y && pos.y <= layer.y + layer.h) return layer
     }
     return null
   }

   function drawBitmapSelection(layer) {
     if (!layer || !layer.transformable) return
     const ctx = S.overlayCtx
     const hs = 4 / S.zoom
     ctx.save()
     ctx.strokeStyle = '#e8a735'
     ctx.lineWidth = 1.5 / S.zoom
     ctx.setLineDash([6 / S.zoom, 3 / S.zoom])
     ctx.strokeRect(layer.x, layer.y, layer.w, layer.h)
     ctx.setLineDash([])
     ctx.fillStyle = '#fff'
     ctx.strokeStyle = '#e8a735'
     for (const point of Object.values(bitmapHandlePoints(layer))) {
       ctx.beginPath()
       ctx.rect(point[0] - hs, point[1] - hs, hs * 2, hs * 2)
       ctx.fill()
       ctx.stroke()
     }
     ctx.restore()
   }

   function beginBitmapDrag(handle, pos) {
     const layer = S.layers.find(l => l.id === S.selectedLayerId)
     if (!layer || !layer.transformable || layer.locked) return
     if (!layer.image && layer.id === 'draw' && !layer.sourceCanvas) {
        layer.sourceCanvas = document.createElement('canvas')
        layer.sourceCanvas.width = S.imgW
        layer.sourceCanvas.height = S.imgH
        layer.sourceCanvas.getContext('2d').drawImage(layer.canvas, 0, 0)
      }
      S.bitmapDrag = {
       mode: handle ? 'scale' : 'move', handle, start: pos,
       layer: { x: layer.x, y: layer.y, w: layer.w, h: layer.h }, pending: snapshotState()
     }
   }

   function applyBitmapDrag(pos) {
     const drag = S.bitmapDrag
     const layer = S.layers.find(l => l.id === S.selectedLayerId)
     if (!drag || !layer) return
     const base = drag.layer
     if (drag.mode === 'move') {
       layer.x = base.x + pos.x - drag.start.x
       layer.y = base.y + pos.y - drag.start.y
     } else {
       let x = base.x, y = base.y, w = base.w, h = base.h
       const min = 4
       if (drag.handle.includes('e')) w = Math.max(min, pos.x - base.x)
       if (drag.handle.includes('s')) h = Math.max(min, pos.y - base.y)
       if (drag.handle.includes('w')) { x = Math.min(pos.x, base.x + base.w - min); w = base.x + base.w - x }
       if (drag.handle.includes('n')) { y = Math.min(pos.y, base.y + base.h - min); h = base.y + base.h - y }
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
     redrawBitmapLayer(layer)
   }

function setActiveLayer(id) {
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
  function addBitmapLayer(img) {
    startImagePlacement(img)
  }

  /** 新建空白图层 */
  function addBlankLayer() { // 创建可独立编辑的位图图层

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
      z: ++S.zCounter
    }
    saveSnapshot()
    S.layers.push(layer)
    setActiveLayer(id)
    updateLayerCanvasStyles()
    renderLayerPanel()
  }

  // ============ 图片放置（导入图片时先调整大小/位置） ============

  /** 启动图片放置：默认尺寸为图片原大但不超过画布 50%，居中 */
  function startImagePlacement(img) {
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
    S.placingImage = { img, x, y, w, h }
    S.placingHandle = null
    S.placingStart = null
    S.drawCanvasCursor('move')
    drawPlacementPreview()
  }

  /** 确认图片放置：创建新位图图层并绘制图片 */
  function confirmImagePlacement() {
    if (!S.placingImage) return
    const { img, x, y, w, h } = S.placingImage
    S.placingImage = null
    S.placingHandle = null
    S.placingStart = null
    clearOverlay()
    // 创建图层
    const id = 'L' + Date.now() + Math.floor(Math.random() * 1000)
    const canvas = createLayerCanvas()
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    ctx.clearRect(0, 0, S.imgW, S.imgH)
    ctx.drawImage(img, x, y, w, h) // image placement
    const layer = {
      id,
      name: '图层 ' + (S.layers.length + 1), image: img, x, y, w, h, transformable: true,
      canvas,
      ctx,
      opacity: 1,
      visible: true,
       locked: false,
      z: S.layers.length
    }
    saveSnapshot()
    S.layers.push(layer)
    setActiveLayer(id)
    updateLayerCanvasStyles()
    renderLayerPanel()
    updateCursor()
  }

  /** 取消图片放置 */
  function cancelImagePlacement() {
    S.placingImage = null
    S.placingHandle = null
    S.placingStart = null
    clearOverlay()
    updateCursor()
  }

  /** 放置预览：在 overlay 上画图片 + 手柄 */
  function drawPlacementPreview() {
    if (!S.placingImage) return
    const ctx = S.overlayCtx
    const { img, x, y, w, h } = S.placingImage
    clearOverlay()
    // 半透明遮罩
    ctx.save()
    ctx.fillStyle = 'rgba(0,0,0,0.35)'
    ctx.fillRect(0, 0, S.imgW, S.imgH)
    ctx.restore()
    // 画图片
    ctx.drawImage(img, x, y, w, h) // image placement
    // 选区边框
    ctx.save()
    ctx.strokeStyle = '#4488ff'
    ctx.lineWidth = 2 / S.zoom
    ctx.setLineDash([8 / S.zoom, 4 / S.zoom])
    ctx.strokeRect(x, y, w, h)
    ctx.setLineDash([])
    // 手柄
    const hs = 5 / S.zoom
    ctx.fillStyle = '#fff'
    ctx.strokeStyle = '#4488ff'
    ctx.lineWidth = 1.5 / S.zoom
    const pts = {
      nw: [x, y], ne: [x + w, y],
      sw: [x, y + h], se: [x + w, y + h],
      n: [x + w / 2, y], s: [x + w / 2, y + h],
      e: [x + w, y + h / 2], w: [x, y + h / 2]
    }
    for (const name in pts) {
      ctx.beginPath()
      ctx.rect(pts[name][0] - hs, pts[name][1] - hs, hs * 2, hs * 2)
      ctx.fill()
      ctx.stroke()
    }
    ctx.restore()
    // 提示文字
    ctx.save()
    ctx.font = 'bold ' + Math.round(14 / S.zoom) + 'px sans-serif'
    ctx.fillStyle = 'rgba(255,255,255,0.9)'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    const hintText = '拖拽手柄调整大小 · Shift=等比 · Enter=确认 · Esc=取消'
    const hintY = S.placingImage.y + S.placingImage.h + 10 / S.zoom
    // 提示文字背景
    const tw = ctx.measureText(hintText).width
    ctx.fillStyle = 'rgba(0,0,0,0.6)'
    ctx.fillRect(S.placingImage.x + S.placingImage.w / 2 - tw / 2 - 6 / S.zoom, hintY, tw + 12 / S.zoom, 22 / S.zoom)
    ctx.fillStyle = 'rgba(255,255,255,0.95)'
    ctx.fillText(hintText, S.placingImage.x + S.placingImage.w / 2, hintY + 4 / S.zoom)
    ctx.restore()
  }
  function hitPlacementHandle(pos) {
    if (!S.placingImage) return null
    const { x, y, w, h } = S.placingImage
    const pts = {
      nw: [x, y], ne: [x + w, y],
      sw: [x, y + h], se: [x + w, y + h],
      n: [x + w / 2, y], s: [x + w / 2, y + h],
      e: [x + w, y + h / 2], w: [x, y + h / 2]
    }
    const R = 12 / S.zoom
    let best = null, bestDist = 1e9
    for (const name in pts) {
      const dx = pos.x - pts[name][0], dy = pos.y - pts[name][1]
      const d = dx * dx + dy * dy
      if (d < R * R && d < bestDist) { bestDist = d; best = name }
    }
    return best
  }

  /** 检查是否在放置矩形内 */
  function insidePlacementRect(pos) {
    if (!S.placingImage) return false
    const { x, y, w, h } = S.placingImage
    return pos.x >= x && pos.x <= x + w && pos.y >= y && pos.y <= y + h
  }

  /** 放置手柄拖拽：根据手柄调整图片大小 */
  function resizePlacement(pos) {
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
  function removeVecCanvas(obj) {
    if (obj && obj._canvas) {
      if (obj._canvas.parentNode) obj._canvas.parentNode.removeChild(obj._canvas)
      obj._canvas = null
      obj._ctx = null
    }
  }
  function purgeVectorCanvases() {
    for (const t of S.textLayers) removeVecCanvas(t)
    for (const sh of S.shapeLayers) removeVecCanvas(sh)
  }
  function drawVectorToCanvas(kind, obj) {
    vecCanvasFor(obj)
    const ctx = obj._ctx
    ctx.clearRect(0, 0, S.imgW, S.imgH)
    if (kind === 'shape') {
      drawShape(ctx, obj)
    } else {
      ctx.save()
      ctx.textBaseline = 'top'
      ctx.globalAlpha = obj.opacity != null ? obj.opacity : 1
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
  function updateLayerCanvasStyles() {
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

  function styleVectorViewport(w, h, offset) {
    for (const { obj } of allObjects()) {
      if (!obj._canvas) continue
      obj._canvas.style.width = w + 'px'
      obj._canvas.style.height = h + 'px'
      obj._canvas.style.left = offset + 'px'
      obj._canvas.style.top = offset + 'px'
    }
  }

  // ============ 图层面板 UI ============

  function renderLayerPanel() {
    const list = el.querySelector('.iwb-editor-layer-list')
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
        ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>'
        : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/></svg>'
      const lockSvg = item.locked
        ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>'
        : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 7-2"/></svg>'
      const delSvg = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
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
    const list = el.querySelector('.iwb-editor-layer-list')
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

  // ============ 画布设置 ============

  function syncOverlayCanvas() {
    const pad = S.overlayPad || 0
    const scale = S.imgW ? (S.fitW * S.zoom) / S.imgW : 1
    S.overlayCanvas.style.left = '0px'
    S.overlayCanvas.style.top = '0px'
    S.overlayCanvas.style.width = Math.round((S.imgW + pad * 2) * scale) + 'px'
    S.overlayCanvas.style.height = Math.round((S.imgH + pad * 2) * scale) + 'px'
  }

  function setupCanvas(img) {
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
  function setView(x, y) {
    S.viewX = x
    S.viewY = y
    const stack = S.canvasStack
    const scale = S.imgW ? (S.fitW * S.zoom) / S.imgW : 1
    const pad = S.overlayPad || 0
    // 让原图左上角仍对应 viewX/viewY，外围 padding 不参与画布平移坐标。
    stack.style.transform = `translate3d(${Math.round(x - pad * scale)}px, ${Math.round(y - pad * scale)}px, 0)`
  }

  /** 以指定屏幕坐标（wrap 内）为中心缩放 */
  function zoomStep(factor, mx, my) {
    const nz = clamp(S.zoom * factor, ZOOM_MIN, ZOOM_MAX)
    if (nz === S.zoom) return
    const px = (mx - (S.viewX || 0)) / S.zoom
    const py = (my - (S.viewY || 0)) / S.zoom
    S.zoom = nz
    applyView({ mx, my, px, py })
  }

  function setZoomFit() {
    S.zoom = 1
    S.viewX = null
    applyView()
  }

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)) }

  function resetState() {
    purgeVectorCanvases()
    S.history = []
    S.redoStack = []
    S.cropRect = null
    S.cropHandle = null
    S.cropMoving = false
    S.moveStart = null
    S.isDrawing = false
    S.panning = false
    S.tool = 'brush'
    S.color = '#ff4444'
    S.brushSize = 3
    S.brushHardness = 100
    S.brushOpacity = 1
    S.prevTool = null
    S.pickerComposite = null
    S.rectFill = false
    S.cropConstraint = { type: 'free', ratio: 0, sizeW: 0, sizeH: 0 }
    S.textLayers = []
    S.selectedTextId = null
    S.textDrag = null
    S.textEditingId = null
    S.shapeLayers = []
    S.selectedShapeId = null
    S.shapeDrag = null
    S.penPath = null
    S.penEditId = null
    S.penDragPt = -1
    S.penDragBase = null
    S.penDragPending = null
    S.zCounter = Math.max(S.layers.length - 1, 0)
    S.placingImage = null
    S.placingHandle = null
    S.placingStart = null
     const sizeToggle = el && el.querySelector('.iwb-editor-size-toggle')
     if (sizeToggle) { sizeToggle.classList.remove('active'); sizeToggle.setAttribute('aria-pressed', 'false'); sizeToggle.textContent = '启用尺寸' }
  }

  function close() {
    if (el) {
      hideTextInput()
      el.style.display = 'none'
    }
    S.open = false
    S.callbacks = null
    S.placingImage = null
    S.placingHandle = null
    S.placingStart = null
    S.penPath = null
    S.textEditingId = null
    clearSelection()
  }

  // ============ 坐标 ============
  function getPos(e) {
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

  // ============ 历史快照（所有位图图层 + 矢量对象） ============

  /** 捕获当前完整状态 */
  function snapshotState() {
    const bitmaps = S.layers.map(layer => {
      let data = null
      try { data = layer.ctx.getImageData(0, 0, S.imgW, S.imgH) } catch (e) { /* ignore */ }
      return {
         id: layer.id,
         data,
         x: layer.x, y: layer.y, w: layer.w, h: layer.h,
         transformable: !!layer.transformable,
         locked: !!layer.locked
       }
    })
    return {
      bitmaps,
      texts: JSON.parse(JSON.stringify(S.textLayers)),
      shapes: JSON.parse(JSON.stringify(S.shapeLayers)),
      layerOrder: S.layers.map(l => ({ id: l.id, name: l.name, z: l.z, opacity: l.opacity, visible: l.visible, locked: !!l.locked, x: l.x, y: l.y, w: l.w, h: l.h }))
    }
  }

  /** 操作前调用：压入历史，清空重做栈 */
  function saveSnapshot() {
    S.history.push(snapshotState())
    if (S.history.length > 50) S.history.shift()
    S.redoStack = []
  }

  /** 恢复到指定状态 */
  function restoreState(state) {
    purgeVectorCanvases()
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
          if (layer.transformable && (layer.image || layer.sourceCanvas)) {
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

  function undo() {
    if (S.placingImage) return
    if (S.isDrawing || S.textDrag || S.shapeDrag) return
    if (S.history.length === 0) return
    S.redoStack.push(snapshotState())
    restoreState(S.history.pop())
  }

  function redo() {
    if (S.placingImage) return
    if (S.isDrawing || S.textDrag || S.shapeDrag) return
    if (S.redoStack.length === 0) return
    S.history.push(snapshotState())
    restoreState(S.redoStack.pop())
  }

  function resetDraw() {
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
  function restoreOriginal() {
    if (!S.originalImage) return
    if (!window.confirm('复原将丢弃所有标注和裁剪，回到原始图片。确定继续吗？')) return
    S.imgW = S.originalImage.naturalWidth || S.originalImage.width
    S.imgH = S.originalImage.naturalHeight || S.originalImage.height
    S.zoom = 1
    setupCanvas(S.originalImage)
    resetDraw()
    updateAllUI()
  }

  // ============ 绘制工具 ============

  function hexToRgb(hex) {
    const h = hex.replace('#', '')
    const v = h.length === 3 ? h.split('').map(c => c + c).join('') : h
    return {
      r: parseInt(v.slice(0, 2), 16) || 0,
      g: parseInt(v.slice(2, 4), 16) || 0,
      b: parseInt(v.slice(4, 6), 16) || 0
    }
  }

  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')
  }

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
  function strokeSegment(x1, y1, x2, y2) {
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

  function eraseSegment(x1, y1, x2, y2) {
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
  function beginStroke() {
    S.strokeCanvas.width = S.imgW
    S.strokeCanvas.height = S.imgH
    S.strokeCtx.clearRect(0, 0, S.imgW, S.imgH)
    // 橡皮擦直接修改活跃图层，不显示独立轨迹层。
    S.strokeCanvas.style.display = S.tool === 'eraser' ? 'none' : 'block'
    S.strokeCanvas.style.opacity = S.brushOpacity
  }

  /** 结束一笔：按透明度一次性合成进活跃图层（画笔=正常合成，橡皮=destination-out） */
  function endStroke() {
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
  function drawShape(ctx, s) {
    ctx.save()
    ctx.globalAlpha = s.opacity != null ? s.opacity : 1
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
  function drawToolRing(pos) {
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
  function getCompositeCanvas() {
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
  function sampleColor(pos) {
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
  function showPickerTip(e, s) {
    const tip = el.querySelector('.iwb-editor-picker-tip')
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

  function hidePickerTip() {
    const tip = el.querySelector('.iwb-editor-picker-tip')
    if (tip) tip.style.display = 'none'
  }

  /** 取色完成：切回吸管激活前的工具 */
  function exitPicker() {
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
  function applyColorChange(color) {
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
  function setTool(tool) {
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

  // ============ 裁剪 ============

  /** 解析比例字符串为数值 (w/h) */
  function parseRatio(str) {
    if (str === 'free' || !str) return 0
    const parts = str.split(':')
    if (parts.length === 2) {
      const w = parseFloat(parts[0])
      const h = parseFloat(parts[1])
      if (w > 0 && h > 0) return w / h
    }
    return 0
  }

  /** 设置裁剪约束 */
  function setConstraint(type, ratio, sizeW, sizeH) {
    S.cropConstraint = { type, ratio: ratio || 0, sizeW: sizeW || 0, sizeH: sizeH || 0 }
    const toggle = el && el.querySelector('.iwb-editor-size-toggle')
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

  function applyConstraintDrag(x1, y1, x2, y2) {
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

  function updateCropInfo() {
    const info = el.querySelector('.iwb-editor-crop-info')
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

  function clearOverlay() {
    const ctx = S.overlayCtx
     const pad = S.overlayPad || 0
     ctx.save()
     ctx.setTransform(1, 0, 0, 1, 0, 0)
     ctx.clearRect(0, 0, S.imgW + pad * 2, S.imgH + pad * 2)
     ctx.restore()
     ctx.setTransform(1, 0, 0, 1, pad, pad)
  }

  function drawCropPreview(x1, y1, x2, y2) {
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

  function insideRect(pos, rect) {
    return pos.x >= rect.x && pos.x <= rect.x + rect.w &&
           pos.y >= rect.y && pos.y <= rect.y + rect.h
  }

  function hitCropHandle(pos) {
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

  function resizeCropRect(pos) {
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

  function confirmCrop() {
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

  function cancelCrop() {
    S.cropRect = null
    S.cropHandle = null
    S.cropMoving = false
    S.moveStart = null
    clearOverlay()
    updateCropInfo()
  }

  // ============ 文字图层 ============

  const TEXT_FONT = (size) => 'bold ' + size + 'px sans-serif'

  function textBounds(t) {
    const ctx = S.textCtx
    ctx.font = TEXT_FONT(t.fontSize)
    const w = ctx.measureText(t.text).width
    const h = t.fontSize * 1.25
    return { x: t.x, y: t.y, w, h }
  }

  function getSelectedText() {
    return S.textLayers.find(t => t.id === S.selectedTextId) || null
  }

  function hitTextLayer(pos) {
    for (let i = S.textLayers.length - 1; i >= 0; i--) {
      if (S.textLayers[i].visible === false) continue
      const b = textBounds(S.textLayers[i])
      if (pos.x >= b.x - 2 && pos.x <= b.x + b.w + 2 &&
          pos.y >= b.y - 2 && pos.y <= b.y + b.h + 2) {
        return S.textLayers[i]
      }
    }
    return null
  }

  function textHandlePoints(t) {
    const b = textBounds(t)
    return {
      nw: [b.x, b.y], ne: [b.x + b.w, b.y],
      sw: [b.x, b.y + b.h], se: [b.x + b.w, b.y + b.h]
    }
  }

  function hitTextHandle(pos) {
    const t = getSelectedText()
    if (!t) return null
    const pts = textHandlePoints(t)
    const R = 12 / S.zoom
    let best = null, bestDist = 1e9
    for (const name in pts) {
      const dx = pos.x - pts[name][0], dy = pos.y - pts[name][1]
      const d = dx * dx + dy * dy
      if (d < R * R && d < bestDist) { bestDist = d; best = name }
    }
    return best
  }

  // ============ 形状图层 ============

  function shapeBounds(s) {
    if (s.type === 'pen' && s.pts && s.pts.length) { const xs = s.pts.map(p => p.x), ys = s.pts.map(p => p.y), x = Math.min(...xs), y = Math.min(...ys); return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y } }
    return { x: Math.min(s.x1, s.x2), y: Math.min(s.y1, s.y2), w: Math.abs(s.x2 - s.x1), h: Math.abs(s.y2 - s.y1) }
  }

  function getSelectedShape() {
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

  function hitShapeLayer(pos, includeInterior) {
    for (let i = S.shapeLayers.length - 1; i >= 0; i--) {
      if (hitShapeObj(pos, S.shapeLayers[i], includeInterior)) return S.shapeLayers[i]
    }
    return null
  }

  /** 所有对象（文字 + 形状）按 z 升序排列 */
  function allObjects() {
    const arr = S.textLayers.map(o => ({ kind: 'text', obj: o }))
      .concat(S.shapeLayers.map(o => ({ kind: 'shape', obj: o })))
    arr.sort((a, b) => (a.obj.z || 0) - (b.obj.z || 0))
    return arr
  }

  function sortLayersByZ() {
    const cmp = (a, b) => (a.z || 0) - (b.z || 0)
    S.textLayers.sort(cmp)
    S.shapeLayers.sort(cmp)
  }

  function hitAnyObject(pos) {
    const list = allObjects()
    for (let i = list.length - 1; i >= 0; i--) {
      const { kind, obj } = list[i]
      if (obj.visible === false) continue
      if (kind === 'text') {
        const b = textBounds(obj)
        if (pos.x >= b.x - 2 && pos.x <= b.x + b.w + 2 &&
            pos.y >= b.y - 2 && pos.y <= b.y + b.h + 2) {
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
  function moveLayer(dir) {
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
    if (s.type === 'circle') {
      const b = shapeBounds(s)
      return {
        nw: [b.x, b.y], ne: [b.x + b.w, b.y],
        sw: [b.x, b.y + b.h], se: [b.x + b.w, b.y + b.h],
        n: [b.x + b.w / 2, b.y], s: [b.x + b.w / 2, b.y + b.h],
        e: [b.x + b.w, b.y + b.h / 2], w: [b.x, b.y + b.h / 2]
      }
    }
    if (s.type === 'rect') {
      const b = shapeBounds(s)
      return {
        nw: [b.x, b.y], ne: [b.x + b.w, b.y],
        sw: [b.x, b.y + b.h], se: [b.x + b.w, b.y + b.h],
        n: [b.x + b.w / 2, b.y], s: [b.x + b.w / 2, b.y + b.h],
        e: [b.x + b.w, b.y + b.h / 2], w: [b.x, b.y + b.h / 2]
      }
    }
    if (s.type === 'pen') return Object.fromEntries((s.pts || []).map((p, i) => ['p' + i, [p.x, p.y]]))
    return { start: [s.x1, s.y1], end: [s.x2, s.y2] }
  }

  function hitShapeHandle(pos) {
    const s = getSelectedShape()
    if (!s) return null
    const pts = shapeHandlePoints(s)
    const offset = 8 / S.zoom
    const R = Math.max(16 / S.zoom, 10)
    let best = null, bestDist = 1e9
    for (const name in pts) {
      const px = pts[name][0] + (name.includes('w') ? -offset : name.includes('e') ? offset : 0)
      const py = pts[name][1] + (name.includes('n') ? -offset : name.includes('s') ? offset : 0)
      const dx = pos.x - px, dy = pos.y - py
      const d = dx * dx + dy * dy
      if (d < R * R && d < bestDist) { bestDist = d; best = name }
    }
    return best
  }

  function applyShapeHandle(s, handle, pos) {
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
    const offset = 8 / S.zoom
    octx.save()
    octx.strokeStyle = '#e8a735'
    octx.lineWidth = 1.5 / S.zoom
    octx.setLineDash([6 / S.zoom, 3 / S.zoom])
    octx.strokeRect(b.x - offset, b.y - offset, b.w + offset * 2, b.h + offset * 2)
    octx.setLineDash([])
    const hs = 6 / S.zoom
    octx.fillStyle = '#ffffff'
    octx.strokeStyle = '#e8a735'
    const pts = shapeHandlePoints(s)
    for (const name in pts) {
      const px = pts[name][0] + (name.includes('w') ? -offset : name.includes('e') ? offset : 0)
      const py = pts[name][1] + (name.includes('n') ? -offset : name.includes('s') ? offset : 0)
      octx.beginPath(); octx.rect(px - hs, py - hs, hs * 2, hs * 2); octx.fill(); octx.stroke()
    }
    octx.restore()
  }

  function deleteSelectedShape() {
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
  function renderObjects(tempShape) {
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
    const bitmapSelection = S.layers.find(l => l.id === S.selectedLayerId && l.transformable)
     if (bitmapSelection) drawBitmapSelection(bitmapSelection)
     const sel = getSelectedText()
    if (sel) {
      const b = textBounds(sel)
      const octx = S.overlayCtx
      octx.save()
      octx.strokeStyle = '#e8a735'
      octx.lineWidth = 1.5 / S.zoom
      octx.setLineDash([6 / S.zoom, 3 / S.zoom])
      octx.strokeRect(b.x - 2 / S.zoom, b.y - 2 / S.zoom, b.w + 4 / S.zoom, b.h + 4 / S.zoom)
      octx.setLineDash([])
      const hs = 4 / S.zoom
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
  function getPenEditingShape() {
    if (!S.penEditId) return null
    return S.shapeLayers.find(sh => sh.id === S.penEditId && sh.type === 'pen') || null
  }
  function beginPenEdit(shape) {
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
  function exitPenEdit() {
    S.penEditId = null
    S.penDragPt = -1
    S.penDragBase = null
    S.penDragPending = null
    renderObjects()
    renderLayerPanel()
  }
  function hitPenPoint(pos, shape, r) {
    const pts = shape.pts || []
    for (let i = 0; i < pts.length; i++) {
      if (Math.hypot(pos.x - pts[i].x, pos.y - pts[i].y) <= r) return i
    }
    return -1
  }
  function hitPenEdgeInsert(pos, shape) {
    const pts = shape.pts || []
    const r = Math.max(12 / S.zoom, 6)
    for (let i = 0; i < pts.length - 1; i++) {
      if (distToSeg(pos.x, pos.y, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y) <= r) return i
    }
    if (shape.closed && pts.length >= 3) {
      if (distToSeg(pos.x, pos.y, pts[pts.length - 1].x, pts[pts.length - 1].y, pts[0].x, pts[0].y) <= r) return pts.length - 1
    }
    return -1
  }
  function drawPenEditOverlay(shape) {
    const ctx = S.overlayCtx
    const pts = shape.pts || []
    const R = Math.max(7 / S.zoom, 5)
    ctx.save()
    ctx.lineWidth = 1.5 / S.zoom
    // 线段中点“+”插入点（仅开放线段；闭合额外补最后一段）
    const segments = []
    for (let i = 0; i < pts.length - 1; i++) segments.push([pts[i], pts[i + 1]])
    if (shape.closed && pts.length >= 3) segments.push([pts[pts.length - 1], pts[0]])
    ctx.strokeStyle = '#e8a735'
    for (const [a, b] of segments) {
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
      ctx.beginPath()
      ctx.arc(mx, my, Math.max(3 / S.zoom, 2), 0, Math.PI * 2)
      ctx.stroke()
    }
    // 节点
    for (let i = 0; i < pts.length; i++) {
      ctx.beginPath()
      ctx.rect(pts[i].x - R / 2, pts[i].y - R / 2, R, R)
      ctx.fillStyle = '#ffffff'
      ctx.strokeStyle = i === S.penDragPt ? '#ff8c00' : '#e8a735'
      ctx.fill()
      ctx.stroke()
    }
    ctx.restore()
  }

  // ============ 文字输入框 ============
  function showTextInput(x, y, layer) {
    const input = el.querySelector('.iwb-editor-text-input')
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

  function hideTextInput() {
    const input = el.querySelector('.iwb-editor-text-input')
    if (input) {
      input.style.display = 'none'
      input.value = ''
    }
    S.textEditingId = null
  }

  function commitTextInput() {
    const input = el.querySelector('.iwb-editor-text-input')
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

  function deleteSelectedText() {
    if (!S.selectedTextId) return
    const selected = getSelectedText()
    if (selected && selected.locked) return
    saveSnapshot()
    removeVecCanvas(selected)
    S.textLayers = S.textLayers.filter(t => t.id !== S.selectedTextId)
    S.selectedTextId = null
    renderObjects()
  }

  function beginTextScaleDrag(handle, pos) {
    const t = getSelectedText()
    if (!t || t.locked) return
    const b = textBounds(t)
    const anchors = {
      se: { x: b.x, y: b.y },
      ne: { x: b.x, y: b.y + b.h },
      sw: { x: b.x + b.w, y: b.y },
      nw: { x: b.x + b.w, y: b.y + b.h }
    }
    const anchor = anchors[handle]
    const dx = pos.x - anchor.x, dy = pos.y - anchor.y
    S.textDrag = {
      mode: 'scale',
      anchor,
      d0: Math.sqrt(dx * dx + dy * dy),
      fontSize: t.fontSize,
      pending: snapshotState()
    }
  }

  function beginShapeHandleDrag(handle, pos) {
    const sh = getSelectedShape()
    if (!sh || sh.locked) return
    S.shapeDrag = {
      mode: 'handle', handle,
      start: pos,
      shape: { ...sh },
      pending: snapshotState()
    }
  }

  // ============ 裁剪栏 ============
  function showCropBar() { el.querySelector('.iwb-editor-crop-bar').style.display = 'flex' }
  function hideCropBar() { el.querySelector('.iwb-editor-crop-bar').style.display = 'none' }

  // ============ 输出 ============
  function exportResult(mode) {
    if (S.placingImage) cancelImagePlacement()
    const tmp = getCompositeCanvas()
    let dataUrl
    try {
      dataUrl = tmp.toDataURL('image/png')
    } catch (e) {
      console.error('[IWB编辑器] 导出失败:', e)
      if (S.callbacks && S.callbacks.onError) S.callbacks.onError('图片跨域无法导出')
      return
    }
    if (S.callbacks && S.callbacks.onResult) {
      S.callbacks.onResult(dataUrl, mode)
    }
    close()
  }

  // ============ 鼠标事件 ============
  function onMouseDown(e) {
    // 图片放置模式优先处理
    if (S.placingImage) {
      e.preventDefault()
      const pos = getPos(e)
      const handle = hitPlacementHandle(pos)
      if (handle) {
        S.placingHandle = handle
        S.placingStart = { mx: pos.x, my: pos.y, x: S.placingImage.x, y: S.placingImage.y, w: S.placingImage.w, h: S.placingImage.h }
        S.drawCanvasCursor(CROP_CURSORS[handle] || 'move')
        return
      }
      if (insidePlacementRect(pos)) {
        S.placingHandle = 'move'
        S.placingStart = { mx: pos.x, my: pos.y, x: S.placingImage.x, y: S.placingImage.y }
        S.drawCanvasCursor('move')
        return
      }
      // 点击外部 = 确认放置
      confirmImagePlacement()
      return
    }

    if (S.spaceDown || S.tool === 'hand' || e.button === 1) {
      e.preventDefault()
      commitTextInput()
      S.panning = true
      S.panStart = { x: e.clientX, y: e.clientY, vx: S.viewX || 0, vy: S.viewY || 0 }
      updateCursor()
      return
    }
    if (e.button !== 0) return
    e.preventDefault()

    const pos = getPos(e)
    S.startX = pos.x
    S.startY = pos.y

    if ((S.tool === 'select' || S.tool === 'pen') && getPenEditingShape()) {
      const penShape = getPenEditingShape()
      const pi = hitPenPoint(pos, penShape, Math.max(16 / S.zoom, 9))
      if (pi >= 0) {
        e.preventDefault()
        S.penDragPt = pi
        S.penDragBase = JSON.parse(JSON.stringify(penShape.pts))
        S.penDragPending = snapshotState()
        return
      }
      const ei = hitPenEdgeInsert(pos, penShape)
      if (ei >= 0) {
        e.preventDefault()
        saveSnapshot()
        penShape.pts.splice(ei + 1, 0, { x: pos.x, y: pos.y })
        renderObjects()
        renderLayerPanel()
        return
      }
      // 点击空白：退出编辑（继续走工具原有新建/选择逻辑）
      S.penEditId = null
      S.penDragPt = -1
      S.penDragPending = null
      renderObjects()
    }

    if (S.tool === 'select') {
      if (commitTextInput()) return
      const bitmapHandle = hitBitmapHandle(pos)
      if (bitmapHandle) { beginBitmapDrag(bitmapHandle, pos); return }
      const th = hitTextHandle(pos)
      if (th) { beginTextScaleDrag(th, pos); return }
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

    if (S.tool === 'crop') {
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
    } else if (S.tool === 'text') {
      if (commitTextInput()) return
      const handle = hitTextHandle(pos)
      if (handle) { beginTextScaleDrag(handle, pos); return }
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
    } else if (S.tool === 'picker') {
      const s = sampleColor(pos)
      if (s && s.a > 0) {
        applyColorChange(rgbToHex(s.r, s.g, s.b))
      }
      exitPicker()
      return
    } else if (S.tool === 'brush') {
      if (!getActiveCtx()) return
      S.isDrawing = true
      saveSnapshot()
      beginStroke()
      strokeSegment(pos.x, pos.y, pos.x, pos.y)
    } else if (S.tool === 'eraser') {
      if (!getActiveCtx()) return
      S.isDrawing = true
      saveSnapshot()
      beginStroke()
      eraseSegment(pos.x, pos.y, pos.x, pos.y)
    } else if (S.tool === 'pen') {
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
    } else if (S.tool === 'rect' || S.tool === 'arrow' || S.tool === 'circle') {
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
  }

  function onMouseMove(e) {
    // 图片放置拖拽
    if (S.placingImage && S.placingHandle && S.placingStart) {
      const pos = getPos(e)
      resizePlacement(pos)
      drawPlacementPreview()
      return
    }
    // 图片放置 hover 光标
    if (S.placingImage) {
      const pos = getPos(e)
      const h = hitPlacementHandle(pos)
      if (h) S.drawCanvasCursor(CROP_CURSORS[h] || 'move')
      else S.drawCanvasCursor(insidePlacementRect(pos) ? 'move' : 'default')
      return
    }

    if (S.panning && S.panStart) {
      setView(S.panStart.vx + (e.clientX - S.panStart.x),
              S.panStart.vy + (e.clientY - S.panStart.y))
      return
    }
    const pos0 = getPos(e)
    if (S.bitmapDrag) {
      applyBitmapDrag(pos0)
      renderObjects()
      return
    }
    if (S.textDrag) {
      const t = getSelectedText()
      if (t) {
        if (S.textDrag.mode === 'move') {
          const dx = pos0.x - S.textDrag.start.x
          const dy = pos0.y - S.textDrag.start.y
          t.x = clamp(S.textDrag.layer.x + dx, 0, Math.max(0, S.imgW - 4))
          t.y = clamp(S.textDrag.layer.y + dy, 0, Math.max(0, S.imgH - 4))
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
    if (S.penDragPt >= 0) {
      const penShape = getPenEditingShape()
      if (penShape && penShape.pts[S.penDragPt]) {
        penShape.pts[S.penDragPt].x = clamp(pos0.x, 0, S.imgW)
        penShape.pts[S.penDragPt].y = clamp(pos0.y, 0, S.imgH)
        renderObjects()
      }
      return
    }
    if (S.shapeDrag) {
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
    if (!S.isDrawing) return
    const pos = pos0

    if (S.tool === 'brush') {
      strokeSegment(S.startX, S.startY, pos.x, pos.y)
      S.startX = pos.x
      S.startY = pos.y
      drawToolRing(pos)
    } else if (S.tool === 'eraser') {
      eraseSegment(S.startX, S.startY, pos.x, pos.y)
      S.startX = pos.x
      S.startY = pos.y
      drawToolRing(pos)
    } else if (S.tool === 'pen') {
      if (S.penPath) { S.penPath.preview = pos; const first = S.penPath.pts[0]
        const nearStart = first && S.penPath.pts.length >= 3 && Math.hypot(pos.x - first.x, pos.y - first.y) <= Math.max(12 / S.zoom, S.brushSize * 1.5)
        S.penPath.nearStart = !!nearStart
        renderObjects() }
    } else if (S.tool === 'rect' || S.tool === 'arrow' || S.tool === 'circle') {
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
    } else if (S.tool === 'crop') {
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
  }

  function onMouseUp(e) {
    if (S.penDragPt >= 0) {
      const penShape = getPenEditingShape()
      const pending = S.penDragPending
      S.penDragPt = -1
      S.penDragPending = null
      S.penDragBase = null
      if (pending && penShape) {
        const cur = snapshotState()
        if (JSON.stringify(cur.shapes) !== JSON.stringify(pending.shapes)) {
          S.history.push(pending)
          if (S.history.length > 50) S.history.shift()
          S.redoStack = []
        }
      }
      return
    }
    // 图片放置拖拽结束
    if (S.placingImage && S.placingHandle) {
      S.placingHandle = null
      S.placingStart = null
      drawPlacementPreview()
      return
    }
    if (S.panning) {
      S.panning = false
      S.panStart = null
      updateCursor()
      return
    }
    if (S.textDrag) {
      const pending = S.textDrag.pending
      if (pending) {
        const cur = snapshotState()
        if (JSON.stringify(cur.texts) !== JSON.stringify(pending.texts)) {
          S.history.push(pending)
          if (S.history.length > 50) S.history.shift()
          S.redoStack = []
        }
      }
      S.textDrag = null
      renderLayerPanel()
      return
    }
    if (S.bitmapDrag) {
      const pending = S.bitmapDrag.pending
      if (pending) {
        const cur = snapshotState()
        const before = pending.bitmaps.find(b => b.id === S.selectedLayerId)
        const after = cur.bitmaps.find(b => b.id === S.selectedLayerId)
        if (before && after && JSON.stringify([before.x, before.y, before.w, before.h]) !== JSON.stringify([after.x, after.y, after.w, after.h])) {
          S.history.push(pending)
          if (S.history.length > 50) S.history.shift()
          S.redoStack = []
        }
      }
      S.bitmapDrag = null
      renderObjects()
      renderLayerPanel()
      return
    }
    if (S.shapeDrag) {
      const pending = S.shapeDrag.pending
      if (pending) {
        const cur = snapshotState()
        if (JSON.stringify(cur.shapes) !== JSON.stringify(pending.shapes) ||
            JSON.stringify(cur.texts) !== JSON.stringify(pending.texts)) {
          S.history.push(pending)
          if (S.history.length > 50) S.history.shift()
          S.redoStack = []
        }
      }
      S.shapeDrag = null
      renderLayerPanel()
      return
    }
    if (!S.isDrawing) return
    S.isDrawing = false
    const pos = getPos(e)

    if (S.tool === 'brush' || S.tool === 'eraser') {
      endStroke()
      return
    }

    if (S.tool === 'crop') {
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
    } else if (S.tool === 'rect' || S.tool === 'arrow' || S.tool === 'circle') {
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
  function updateAllUI() {
    updateToolUI()
    updateColorUI()
    updateBrushUI()
    updateBrushParamUI()
    updateFillUI()
    updateLayerUI()
    updateZoomUI()
    hidePickerTip()
    el.querySelectorAll('.iwb-editor-constraint-btn[data-ratio]').forEach(b => b.classList.remove('active'))
    const freeBtn = el.querySelector('.iwb-editor-constraint-btn[data-ratio="free"]')
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

  function updateZoomUI() {
    const val = el.querySelector('.iwb-editor-zoom-val')
    if (val) val.textContent = Math.round(S.zoom * 100) + '%'
  }

  function updateToolUI() {
    el.querySelectorAll('.iwb-editor-tool').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tool === S.tool)
    })
    updateCursor()
  }

  function updateCursor() {
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

  function updateColorUI() {
    let matchPreset = false
    el.querySelectorAll('.iwb-editor-color[data-color]').forEach(s => {
      const on = (s.dataset.color || '').toLowerCase() === S.color.toLowerCase()
      if (on) matchPreset = true
      s.classList.toggle('active', on)
    })
    const panelHex = el.querySelector('.iwb-editor-color-hex')
    const hexInput = el.querySelector('.iwb-editor-color-hex-input')
    if (hexInput && document.activeElement !== hexInput) hexInput.value = S.color.toUpperCase()
    el.querySelectorAll('.iwb-editor-color-panel-swatch').forEach(sw => sw.classList.toggle('active', (sw.dataset.panelColor || '').toLowerCase() === S.color.toLowerCase()))
    if (panelHex) panelHex.textContent = S.color.toUpperCase()
    const rgb = hexToRgb(S.color)
    const max = Math.max(rgb.r, rgb.g, rgb.b) / 255, min = Math.min(rgb.r, rgb.g, rgb.b) / 255
    const d = max - min
    let h = 0
    if (d) { if (max === rgb.r / 255) h = 60 * (((rgb.g - rgb.b) / 255 / d) % 6); else if (max === rgb.g / 255) h = 60 * ((rgb.b - rgb.r) / 255 / d + 2); else h = 60 * ((rgb.r - rgb.g) / 255 / d + 4) }
    if (h < 0) h += 360
    const sv = el.querySelector('.iwb-color-sv'), hue = el.querySelector('.iwb-color-hue')
    if (sv) sv.style.backgroundColor = `hsl(${h} 100% 50%)`
    if (hue) hue.dataset.hue = h
    const hueMarker = hue && hue.querySelector('span'); if (hueMarker) hueMarker.style.top = (h / 360 * 100) + '%'
    const svMarker = sv && sv.querySelector('span'); if (svMarker) { const sat = max ? d / max : 0; svMarker.style.left = (sat * 100) + '%'; svMarker.style.top = ((1 - max) * 100) + '%' }
    const custom = el.querySelector('.iwb-editor-color-custom')
    if (custom) {
      custom.classList.toggle('active', !matchPreset)
      const inp = custom.querySelector('input')
      if (inp) inp.value = S.color
    }
  }

  function updateBrushUI() {
    const slider = el.querySelector('.iwb-editor-brush-size')
    if (!slider) return
    slider.value = S.brushSize
    const num = el.querySelector('.iwb-editor-brush-num')
    if (num && document.activeElement !== num) num.value = S.brushSize
  }

  /** 画笔参数组（硬度/透明度）：画笔与橡皮工具共用 */
  function updateBrushParamUI() {
    const g = el.querySelector('.iwb-editor-brush-group')
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
    const b = el.querySelector('[data-action="toggleFill"]')
    if (b) b.classList.toggle('active', !!S.rectFill)
  }

  /** 图层按钮可用态：有选中元素才可用 */
  function updateLayerUI() {
    const hasSel = !!(S.selectedTextId || S.selectedShapeId || S.layers.some(l => l.id === S.selectedLayerId && l.id !== 'base' && !l.locked))
    el.querySelectorAll('.iwb-editor-layer-btn').forEach(b => {
      b.disabled = !hasSel
    })
  }

  // ============ 事件绑定 ============
  function bindEvents() {
    // 工具
    el.querySelectorAll('.iwb-editor-tool').forEach(btn => {
      btn.addEventListener('mousedown', (e) => e.stopPropagation())
      btn.addEventListener('click', () => setTool(btn.dataset.tool))
    })

    // 独立颜色面板：颜色选择后同步当前工具颜色。
    const setPanelColor = (color) => applyColorChange(color)
    const panelHexInput = el.querySelector('.iwb-editor-color-hex-input')
    if (panelHexInput) panelHexInput.addEventListener('change', () => { if (/^#[0-9a-f]{6}$/i.test(panelHexInput.value)) setPanelColor(panelHexInput.value) })
    el.querySelectorAll('.iwb-editor-color-panel-swatch').forEach(btn => btn.addEventListener('click', (e) => { e.stopPropagation(); setPanelColor(btn.dataset.panelColor) }))
    const palettePick = el.querySelector('[data-action="palettePick"]')
    if (palettePick) { palettePick.addEventListener('mousedown', (e) => e.stopPropagation()); palettePick.addEventListener('click', () => setTool('picker')) }
    const sv = el.querySelector('.iwb-color-sv')
    const hue = el.querySelector('.iwb-color-hue')
    let hueValue = 0
    const hsvToHex = (h, sat, val) => {
      const c = val * sat, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = val - c
      let r = 0, g = 0, b = 0
      if (h < 60) { r = c; g = x } else if (h < 120) { r = x; g = c } else if (h < 180) { g = c; b = x } else if (h < 240) { g = x; b = c } else if (h < 300) { r = x; b = c } else { r = c; b = x }
      return rgbToHex(Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255))
    }
    const pick = (target, e) => { const r = target.getBoundingClientRect(); const x = clamp((e.clientX-r.left)/r.width,0,1); const y = clamp((e.clientY-r.top)/r.height,0,1); setPanelColor(target === hue ? hsvToHex(hueValue,1,1) : hsvToHex(hueValue,x,1-y)) }
    if (sv) { sv.addEventListener('pointerdown', e => { sv.setPointerCapture(e.pointerId); pick(sv,e) }); sv.addEventListener('pointermove', e => { if (e.buttons) pick(sv,e) }) }
    if (hue) { hue.addEventListener('pointerdown', e => { const r=hue.getBoundingClientRect(); hueValue=clamp((e.clientY-r.top)/r.height,0,1)*360; setPanelColor(hsvToHex(hueValue,1,1)) }) }
    // 比例约束按钮
    el.querySelectorAll('.iwb-editor-constraint-btn[data-ratio]').forEach(btn => {
      btn.addEventListener('mousedown', (e) => e.stopPropagation())
      btn.addEventListener('click', () => {
        const r = btn.dataset.ratio
        el.querySelectorAll('.iwb-editor-constraint-btn[data-ratio]').forEach(b => b.classList.remove('active'))
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
    const sizeToggle = el.querySelector('[data-action="toggleSizeConstraint"]')
    if (sizeToggle) sizeToggle.addEventListener('click', () => { if (S.cropConstraint.type === 'size') setConstraint('free', 0, 0, 0); else { const w = parseInt(el.querySelector('.iwb-editor-size-w').value, 10), h = parseInt(el.querySelector('.iwb-editor-size-h').value, 10); if (w > 0 && h > 0) setConstraint('size', w / h, w, h) } })

    // 应用尺寸按钮
    el.querySelector('[data-action="applySize"]').addEventListener('mousedown', (e) => e.stopPropagation())
    el.querySelector('[data-action="applySize"]').addEventListener('click', () => {
      const w = parseInt(el.querySelector('.iwb-editor-size-w').value, 10)
      const h = parseInt(el.querySelector('.iwb-editor-size-h').value, 10)
      if (w > 0 && h > 0) {
        el.querySelectorAll('.iwb-editor-constraint-btn[data-ratio]').forEach(b => b.classList.remove('active'))
        setConstraint('size', w / h, w, h)
      }
    })

    // 颜色
    el.querySelectorAll('.iwb-editor-color[data-color]').forEach(s => {
      s.addEventListener('mousedown', (e) => e.stopPropagation())
      s.addEventListener('click', () => applyColorChange(s.dataset.color))
    })

    const colorInput = el.querySelector('.iwb-editor-color-picker-input')
    colorInput.addEventListener('mousedown', (e) => e.stopPropagation())
    colorInput.addEventListener('input', () => applyColorChange(colorInput.value))

    // 实心矩形开关
    const fillBtn = el.querySelector('[data-action="toggleFill"]')
    fillBtn.addEventListener('mousedown', (e) => e.stopPropagation())
    fillBtn.addEventListener('click', () => {
      S.rectFill = !S.rectFill
      updateFillUI()
      const sh = getSelectedShape()
      if (sh && (sh.type === 'rect' || sh.type === 'circle') && (S.tool === 'rect' || S.tool === 'circle' || S.tool === 'select')) {
        saveSnapshot()
        sh.fill = S.rectFill
        renderObjects()
      }
    })

    // 图层顺序调节
    el.querySelectorAll('.iwb-editor-layer-btn').forEach(btn => {
      btn.addEventListener('mousedown', (e) => e.stopPropagation())
      btn.addEventListener('click', () => moveLayer(btn.dataset.layer))
    })

    // 笔触（滑杆 + 数值输入框双向同步）
    const slider = el.querySelector('.iwb-editor-brush-size')
    const brushNum = el.querySelector('.iwb-editor-brush-num')
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
    el.querySelectorAll('.iwb-editor-brush-preset').forEach(btn => {
      btn.addEventListener('mousedown', (e) => e.stopPropagation())
      btn.addEventListener('click', () => syncBrushSize(btn.dataset.brushSize, false))
    })
    slider.addEventListener('input', () => syncBrushSize(slider.value, true))
    slider.addEventListener('change', () => syncBrushSize(slider.value, false))
    if (brushNum) {
      brushNum.addEventListener('mousedown', (e) => e.stopPropagation())
      brushNum.addEventListener('input', () => {
        const v = clamp(parseInt(brushNum.value, 10) || 1, 1, 300)
        syncBrushSize(v, true)
      })
      brushNum.addEventListener('blur', () => { brushNum.value = S.brushSize; lwHistoryPushed = false })
    }

    // 画笔硬度
    const hardnessSlider = el.querySelector('.iwb-editor-brush-hardness')
    hardnessSlider.addEventListener('input', () => {
      S.brushHardness = parseInt(hardnessSlider.value, 10)
      el.querySelector('.iwb-editor-brush-hardness-val').textContent = S.brushHardness
    })

    // 画笔透明度
    const opacitySlider = el.querySelector('.iwb-editor-brush-opacity')
    opacitySlider.addEventListener('input', () => {
      S.brushOpacity = parseInt(opacitySlider.value, 10) / 100
      el.querySelector('.iwb-editor-brush-opacity-val').textContent = opacitySlider.value + '%'
      if (S.strokeCanvas) S.strokeCanvas.style.opacity = S.brushOpacity
    })

    // 缩放按钮
    el.querySelector('[data-action="zoomOut"]').addEventListener('click', (e) => {
      e.stopPropagation()
      zoomStep(1 / ZOOM_STEP, S.canvasWrap.clientWidth / 2, S.canvasWrap.clientHeight / 2)
    })
    el.querySelector('[data-action="zoomIn"]').addEventListener('click', (e) => {
      e.stopPropagation()
      zoomStep(ZOOM_STEP, S.canvasWrap.clientWidth / 2, S.canvasWrap.clientHeight / 2)
    })
    el.querySelector('[data-action="zoomFit"]').addEventListener('click', (e) => {
      e.stopPropagation()
      setZoomFit()
    })

    // 撤销/重做/重置/复原
    const undoBtn = el.querySelector('[data-action="undo"]')
    const redoBtn = el.querySelector('[data-action="redo"]')
    const resetBtn = el.querySelector('[data-action="reset"]')
    const restoreBtn = el.querySelector('[data-action="restore"]')
    undoBtn.addEventListener('mousedown', (e) => e.stopPropagation())
    redoBtn.addEventListener('mousedown', (e) => e.stopPropagation())
    resetBtn.addEventListener('mousedown', (e) => e.stopPropagation())
    restoreBtn.addEventListener('mousedown', (e) => e.stopPropagation())
    undoBtn.addEventListener('click', undo)
    redoBtn.addEventListener('click', redo)
    resetBtn.addEventListener('click', resetDraw)
    restoreBtn.addEventListener('click', restoreOriginal)

    // 裁剪
    el.querySelector('[data-action="confirmCrop"]').addEventListener('click', confirmCrop)
    el.querySelector('[data-action="cancelCrop"]').addEventListener('click', cancelCrop)

    // 添加位图图层（导入图片）
    el.querySelector('[data-action="addBitmapLayer"]').addEventListener('mousedown', (e) => e.stopPropagation())
    el.querySelector('[data-action="addBitmapLayer"]').addEventListener('click', () => {
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
    el.querySelector('[data-action="addBlankLayer"]').addEventListener('mousedown', (e) => e.stopPropagation())
    el.querySelector('[data-action="addBlankLayer"]').addEventListener('click', () => {
      addBlankLayer()
    })

    // 底部
    el.querySelector('[data-action="cancel"]').addEventListener('click', close)
    el.querySelector('[data-action="newNode"]').addEventListener('click', () => exportResult('newNode'))
    el.querySelector('[data-action="replace"]').addEventListener('click', () => exportResult('replace'))

    // canvas 事件绑定到第一个位图图层（初始时还没有图层，延迟绑定）
    // 实际在 setupCanvas 后调用 bindCanvasEvents
    // 滚轮缩放
    S.canvasWrap.addEventListener('wheel', onWheel, { passive: false })

    // 文字输入
    const textInput = el.querySelector('.iwb-editor-text-input')
    textInput.addEventListener('mousedown', (e) => e.stopPropagation())
    textInput.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') { e.preventDefault(); commitTextInput() }
      else if (e.key === 'Escape') { e.preventDefault(); hideTextInput() }
    })

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
    el.querySelector('.iwb-editor-modal').addEventListener('mousedown', (e) => e.stopPropagation())
  }

  function commitPenPath() {
    if (!S.penPath || S.penPath.pts.length < 2) { S.penPath = null; renderObjects(); return }
    saveSnapshot()
    const shape = { id: 's' + Date.now() + Math.floor(Math.random() * 1000), type: 'pen', pts: S.penPath.pts.slice(), closed: !!S.penPath.closed, color: S.color, lw: Math.max(2, S.brushSize), fill: !!S.penPath.closed, opacity: 1, visible: true, locked: false, z: ++S.zCounter }
    S.shapeLayers.push(shape); S.selectedShapeId = shape.id; S.penPath = null; renderObjects(); renderLayerPanel()
  }

  /** 将 canvas 鼠标事件绑定到活跃图层 canvas（在 setupCanvas 后调用，仅绑定一次） */
  function bindCanvasEvents() {
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

  // ============ 暴露接口 ============
  window.__iwbEditor = { open, close }
})()
